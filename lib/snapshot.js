// lib/snapshot.js — 防灾快照引擎：把「导出一个完整 bundle」变成可以随手做、常常做的事。
//
// 为什么要有这个文件：2026-10-29 的真实事故里，工作区根目录被宿主卸载器整棵删掉，
// 最后救回来的全部内容都来自一份 5 天前碰巧存在的 bundle。bundle 本来就是自包含、
// sha256 可校验、可 apply 的完整快照 —— 缺的不是能力，是「常态化」：
//   · export 面向换机，参数多、要人拿主意；snapshot 全部取安全默认，一句话可跑；
//   · bundle 通常落在临时目录或桌面，用完即删；snapshot 落在 $DSH_HOME/snapshots/，
//     按保留策略自动滚动，永远有最近几份可用；
//   · 含工作区的 bundle 轻松上 GB，连拍几份谁都心疼 —— 未变化的文件用**硬链接**
//     指回上一份快照（逐文件 sha256 比对后才替换），同卷近乎零额外空间，
//     产物仍是自包含的完整 bundle：apply、verify、checksums 全部零改动。
//
// 硬链接的正确性：内容相同（sha256 一致）才会替换成硬链接，所以新快照的
// checksums.json 依然逐字有效；NTFS 上删除基线快照只是减引用计数，数据随
// 最后一个链接存活。基线与新快照永远同在 $DSH_HOME 下（同卷），fs.link 不会
// EXDEV；万一跨卷（用户改过布局），降级为保留普通拷贝 —— 快照照常完整，
// 只是不省空间。结果里带 savedBytes，空间省了多少看得见。
import fs from 'node:fs'
import path from 'node:path'

import { exportBundle } from './bundle.js'
import { listProfiles } from './bundle.js'
import { CHECKSUM_FILE, sha256File } from './checksum.js'

/** 快照根目录名（在 $DSH_HOME 下）。 */
export const SNAPSHOTS_DIRNAME = 'snapshots'

/** 快照目录名形态：20260102-030405（本地时间），同秒重拍时追加 -2、-3。 */
const NAME_RE = /^\d{8}-\d{6}(-\d+)?$/

export function snapshotsDirOf(dshHome) {
  return path.join(dshHome, SNAPSHOTS_DIRNAME)
}

/** 本地时间的快照目录名。 */
function stampOf(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 校验值同步读：清单字段缺失/损坏的快照仍列出，但标 valid=false。 */
function readSnapshotMeta(dir) {
  const name = path.basename(dir)
  let exportedAt = null
  let files = 0
  let bytes = 0
  let valid = false
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    exportedAt = typeof manifest.exportedAt === 'string' ? manifest.exportedAt : null
    valid = fs.existsSync(path.join(dir, CHECKSUM_FILE))
  } catch { /* manifest 缺失：valid 保持 false */ }
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const abs = path.join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        files += 1
        try { bytes += fs.statSync(abs).size } catch { /* 读不到按 0 计 */ }
      }
    }
  }
  walk(dir)
  return { dir, name, exportedAt, files, bytes, valid }
}

/**
 * 列出已有的快照（新 → 旧）。
 * @param {string} dshHome
 * @param {string} [rootOverride] - 快照根目录覆盖（测试用；默认 $DSH_HOME/snapshots）。
 * @returns {Array<{dir:string,name:string,exportedAt:string|null,files:number,bytes:number,valid:boolean}>}
 */
export function listSnapshots(dshHome, rootOverride = '') {
  const root = rootOverride ? path.resolve(rootOverride) : snapshotsDirOf(dshHome)
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  return names
    .filter((n) => NAME_RE.test(n))
    .sort()
    .reverse()
    .map((n) => readSnapshotMeta(path.join(root, n)))
}

/** 读一份快照的 checksums 清单；读不出（旧版 bundle / 损坏）返回 null。 */
async function checksumsOf(dir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, CHECKSUM_FILE), 'utf8'))
    return doc && doc.entries && typeof doc.entries === 'object' ? doc.entries : null
  } catch { return null }
}

/**
 * 对比两份快照的 checksums 清单。
 * @returns {Promise<{added:number, changed:number, removed:number, same:number, changedBytes:number}>}
 */
export async function diffSnapshots(newDir, baseDir) {
  const ne = await checksumsOf(newDir) || {}
  const be = await checksumsOf(baseDir) || {}
  let added = 0, changed = 0, removed = 0, same = 0, changedBytes = 0
  for (const [k, h] of Object.entries(ne)) {
    if (!(k in be)) { added += 1; changedBytes += await sizeOf(path.join(newDir, ...k.split('/'))); continue }
    if (be[k] !== h) { changed += 1; changedBytes += await sizeOf(path.join(newDir, ...k.split('/'))); continue }
    same += 1
  }
  for (const k of Object.keys(be)) if (!(k in ne)) removed += 1
  return { added, changed, removed, same, changedBytes }
}

async function sizeOf(abs) {
  try { return (await fs.promises.stat(abs)).size } catch { return 0 }
}

/**
 * 把新快照里「内容与基线完全一致」的文件替换成指向基线的硬链接。
 * 逐文件 sha256 比对在前，替换在后 —— checksums.json 的每个摘要依然成立。
 * @returns {Promise<{linked:number, savedBytes:number, scanned:number, failed:number}>}
 */
export async function hardlinkUnchanged(newDir, baseDir, { onLog } = {}) {
  const be = await checksumsOf(baseDir)
  if (be === null) return { linked: 0, savedBytes: 0, scanned: 0, failed: 0 }
  let linked = 0, savedBytes = 0, scanned = 0, failed = 0
  const walk = async (d) => {
    const ents = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      const abs = path.join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { await walk(abs); continue }
      if (!e.isFile()) continue
      const key = path.relative(newDir, abs).split(path.sep).join('/')
      const expect = be[key]
      if (typeof expect !== 'string') continue
      scanned += 1
      const abs2 = path.join(baseDir, ...key.split('/'))
      // 先比大小再比哈希：大小不同必不相同，省一次全量读取。
      const sn = await fs.promises.stat(abs).catch(() => null)
      const sb = await fs.promises.stat(abs2).catch(() => null)
      if (!sn || !sb || sn.size !== sb.size || sn.size === 0) continue
      const hn = await sha256File(abs).catch(() => null)
      if (hn !== expect) continue
      try {
        // 同一文件已被替换过（两份快照互为基线链）时 nlink>1，无需再动。
        fs.unlinkSync(abs)
        fs.linkSync(abs2, abs)
        linked += 1
        savedBytes += sn.size
      } catch {
        // EXDEV / 权限：留普通拷贝。快照完整性不受影响，只是不省空间。
        failed += 1
      }
    }
  }
  await walk(newDir)
  if (onLog && linked > 0) onLog(`硬链接复用 ${linked} 个未变化文件（省 ${(savedBytes / 1048576).toFixed(1)} MB）`)
  return { linked, savedBytes, scanned, failed }
}

/**
 * 按保留策略滚动清理旧快照。只删本引擎自己创建的目录名形态，绝不碰别的。
 * @returns {{pruned:string[], kept:string[]}}
 */
export function pruneSnapshots(dshHome, keep, { onLog, rootOverride = '' } = {}) {
  const all = listSnapshots(dshHome, rootOverride)
  const kept = []
  const pruned = []
  for (const s of all) {
    if (kept.length < keep && s.valid) kept.push(s.name)
    else pruned.push(s.name)
  }
  const root = rootOverride ? path.resolve(rootOverride) : snapshotsDirOf(dshHome)
  for (const name of pruned) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      if (onLog) onLog(`已清理旧快照 ${name}（保留最近 ${keep} 份）`)
    } catch (err) {
      if (onLog) onLog(`⚠️ 旧快照 ${name} 清理失败：${err && err.message}`)
    }
  }
  return { pruned, kept }
}

/**
 * 拍一份防灾快照。
 *
 * 与 dshsync_export 的分工：export 回答「带什么去新机」（参数多、要人拍板）；
 * snapshot 回答「本机此刻的完整状态存个档」（全默认、可连拍）。产物就是一份
 * 标准 bundle：apply.ps1 / 一键恢复.bat 全都在里面，恢复时不需要本插件在场。
 *
 * @param {object} o
 * @param {string} o.dshHome
 * @param {boolean} [o.incremental=true] - 与最近一份快照做硬链接增量
 * @param {number} [o.keep=5] - 保留几份（只算完好的快照）
 * @param {boolean} [o.includeWorkspaces=true] - 快照必须能恢复「点开会话有代码」的状态，
 *   所以默认 true；事故复盘里救回一切的正是工作区代码
 * @param {boolean} [o.includeState=true]
 * @param {boolean} [o.includeGit=true]
 * @param {boolean} [o.includeCredentials=false]
 * @param {string} [o.passphrase='']
 * @param {string} [o.profile='*']
 * @param {string} [o.snapshotsOverride=''] - 快照根目录覆盖（测试用；默认 $DSH_HOME/snapshots）
 * @param {Function} [o.onLog]
 * @param {Function} [o.writeScripts] - 与 export 相同的脚本写入回调
 */
export async function takeSnapshot({
  dshHome, incremental = true, keep = 5, includeWorkspaces = true, includeState = true,
  includeGit = true, includeCredentials = false, passphrase = '', profile = '*',
  snapshotsOverride = '', onLog, writeScripts,
} = {}) {
  const log = (s) => onLog && onLog(s)
  if (!dshHome) throw new Error('dshHome is required')

  const root = snapshotsOverride ? path.resolve(snapshotsOverride) : snapshotsDirOf(dshHome)
  fs.mkdirSync(root, { recursive: true })

  // 基线：目录名最新的一份**完好**快照（有 checksums.json 才可校验、才可硬链接）。
  // 自定义根（测试）与默认根共用同一条查找路径。
  const base = incremental === false
    ? null
    : (listSnapshots(dshHome, root).find((s) => s.valid) || null)

  // 目录名：本地时间戳 + 同秒重拍时顺延。
  let name = stampOf()
  for (let i = 2; fs.existsSync(path.join(root, name)); i++) name = `${stampOf()}-${i}`
  const dir = path.join(root, name)

  log(`快照位置：${dir}`)
  if (base) log(`增量基线：${base.name}（未变化的文件将硬链接复用）`)
  else log('基线：无（本次为全量快照）')

  const profiles = profile === '*' ? await listProfiles(dshHome) : [profile]
  if (profiles.length === 0) throw new Error(`no profile found under ${path.join(dshHome, 'profiles')}`)

  const { bundleDir, manifest, warnings } = await exportBundle({
    dshHome, profiles, outDir: dir,
    includeCredentials, includePlugins: true, includeState, includeWorkspaces,
    workspaces: null, includeGit, passphrase, onLog: log, writeScripts,
  })

  // 增量：与基线逐文件比对，内容一致才替换成硬链接。放在 checksums 之后做是刻意的：
  // 替换不改变任何字节，清单依然成立 —— 顺序反了（先硬链接后算哈希）其实也一样对，
  // 但放在后面能顺带用 export 刚算好的清单做 diff，不重复读盘。
  const hardlink = base ? await hardlinkUnchanged(bundleDir, base.dir, { onLog: log }) : { linked: 0, savedBytes: 0, scanned: 0, failed: 0 }
  const delta = base ? await diffSnapshots(bundleDir, base.dir) : null

  const { pruned } = pruneSnapshots(dshHome, keep, { onLog: log, rootOverride: root })

  const total = await (async () => {
    let files = 0, bytes = 0
    const walk = async (d) => {
      const ents = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])
      for (const e of ents) {
        const abs = path.join(d, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile()) { files += 1; bytes += await sizeOf(abs) }
      }
    }
    await walk(bundleDir)
    return { files, bytes }
  })()

  return {
    snapshotDir: bundleDir,
    snapshotName: name,
    baseSnapshot: base ? base.name : null,
    hardlink,
    delta,
    pruned,
    warnings,
    manifest,
    totals: { files: total.files, bytes: total.bytes },
  }
}
