// lib/apply-engine.js — 在目标机上执行 bundle 落地（接收端唯一实现）。
//
// 与旧版 apply.ps1 的分工：
//   · apply.ps1 / apply.sh —— 零依赖兜底：目标机没装 dsh-sync 也能把声明层落地。
//   · 本模块 —— 工具式落地：能做的两件脚本做不了的事，是「路径重映射」与「会话 header 改写」
//     （后者需要 zstd 帧级读写，PowerShell 里没有现成能力）。
// 两者共用同一套映射口径（lib/path-map.js），所以不会出现「脚本改一种、工具改另一种」的分歧。
//
// 安全策略：
//   ① 先整包校验 sha256，任何一个文件对不上就停手（传输损坏是最常见的失败）；
//   ② 覆盖任何目标文件前先备份到 <dshHome>/.dsh-sync-backup-<ts>/（保留相对路径，可手工还原）；
//   ③ 会话改写是原地原子替换（tmp + rename），事件区字节不动，改坏不了历史；
//   ④ 任何一步失败都不回滚已完成的步骤，而是把「哪些已改、备份在哪」说清楚 ——
//      部分成功 + 准确报告，比假装全成功或粗暴回滚更好排查。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { CHECKSUM_FILE, sha256File } from './checksum.js'
import { APPLY_RECEIPT_FILE, HOME_STATE_FILES, STATE_PARTS } from './constants.js'
import { compareRuntime, machineIdentity, probeRuntime } from './host-env.js'
import { decryptBuffer } from './crypto.js'
import {
  scanSessions, planSessionMigration, applySessionPlan, remapWorkspacePaths, isSessionGroupDir,
  isSessionLogName,
} from './session-migrate.js'
import { readSessionHeader } from './zstd-frame.js'
import { applyMappings, validateMappings, guessPrefixes, isSameOrChild, normalizePath } from './path-map.js'
import { findMappingConflicts, planWorkspaceTargets } from './workspace-pack.js'

/** 备份目录名前缀（与 apply.ps1 保持一致，便于用户按同一个规则找） */
const BACKUP_PREFIX = '.dsh-sync-backup-'

/**
 * 读取并校验 bundle。
 * @param {string} bundleDir
 * @returns {{ok:boolean, manifest?:object, problems:string[]}}
 */
export function inspectBundle(bundleDir) {
  const problems = []
  const manifestPath = path.join(bundleDir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return { ok: false, problems: ['读不到 manifest.json：' + (err && err.message ? err.message : String(err))] }
  }
  const sumsPath = path.join(bundleDir, CHECKSUM_FILE)
  if (!fs.existsSync(sumsPath)) {
    problems.push('缺少 ' + CHECKSUM_FILE + '，无法验证完整性（bundle 可能不完整）')
  }
  return { ok: problems.length === 0, manifest, problems }
}

/**
 * 校验 bundle 完整性。
 * @param {string} bundleDir
 * @returns {Promise<{ok:boolean, checked:number, failures:object[]}>}
 */
export async function verifyBundleIntegrity(bundleDir) {
  const sumsPath = path.join(bundleDir, CHECKSUM_FILE)
  let sums
  try {
    sums = JSON.parse(fs.readFileSync(sumsPath, 'utf8'))
  } catch {
    return { ok: false, checked: 0, failures: [{ file: CHECKSUM_FILE, reason: '读不出校验清单' }] }
  }
  const failures = []
  let checked = 0
  for (const [rel, expected] of Object.entries(sums.entries || {})) {
    const abs = path.join(bundleDir, rel.split('/').join(path.sep))
    // manifest.json 自己也记在清单里，但它包含了清单的摘要 —— 循环校验没有意义。
    // 单独跳过并如实标注（manifest 的结构校验在 inspectBundle 里做）。
    if (rel === 'manifest.json') continue
    try {
      // sha256File 是异步的：漏掉 await 会拿 Promise 与字符串比较，恒不相等，
      // 结果是「所有文件都被判为损坏」—— 这个坑踩过一次，别再去掉 await。
      const actual = await sha256File(abs)
      checked += 1
      if (actual !== expected) failures.push({ file: rel, reason: 'sha256 不符（传输损坏或文件被替换）' })
    } catch (err) {
      failures.push({ file: rel, reason: (err && err.code) === 'ENOENT' ? '文件缺失' : '读取失败：' + (err && err.message) })
    }
  }
  return { ok: failures.length === 0, checked, failures }
}

/**
 * 建立一个带相对路径的备份目录。
 * @param {string} dshHome
 * @returns {string} 备份目录绝对路径
 */
export function createBackupDir(dshHome) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const dir = path.join(dshHome, BACKUP_PREFIX + ts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 把现有文件复制进备份目录（保留相对路径）。
 * @param {string} abs
 * @param {string} dshHome
 * @param {string} backupDir
 */
function backupIfExists(abs, dshHome, backupDir) {
  if (!fs.existsSync(abs)) return null
  const rel = path.relative(dshHome, abs)
  const dest = path.join(backupDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(abs, dest)
  return rel
}

/**
 * 递归复制目录（目标机落地用；保留文件内容，不处理软链 —— 软链由 links.json 单独重建）。
 * @param {string} src
 * @param {string} dest
 * @param {object} [opts]
 * @param {(abs:string)=>void} [opts.beforeOverwrite] 覆盖前回调（用于备份）
 * @returns {{files:number, bytes:number}}
 */
function copyInto(src, dest, { beforeOverwrite } = {}) {
  let files = 0
  let bytes = 0
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      const r = copyInto(s, d, { beforeOverwrite })
      files += r.files
      bytes += r.bytes
    } else if (ent.isFile()) {
      if (beforeOverwrite) beforeOverwrite(d)
      fs.copyFileSync(s, d)
      files += 1
      bytes += fs.statSync(s).size
    }
  }
  return { files, bytes }
}

/**
 * 按 links.json 重建软链。
 *
 * 目标机可以自定义 `$DSH_HOME` 的位置（例如源机在 `C:\Users\x\.dsh`、目标机放在 `D:\tools\dsh`）。
 * 这时**指向 $DSH_HOME 内部的链接必须跟着重定位** —— 源机记录的绝对目标是源机的路径，
 * 照搬过去必然断链。所以先按 sourceHome → targetHome 做一次前缀替换，再判断可用性。
 *
 * 两条策略，取决于链接目标在不在目标机的 $DSH_HOME 内：
 *   · internal —— 重定位后重建（两边相对结构一致，天然可用）；
 *   · external —— 目标机若不存该路径则必然断链，如实报告交给用户决定，
 *                 **不擅自改写链接指向**（那等于替你改了目录归属关系）。
 *
 * @param {string} bundleDir
 * @param {string} dshHome 目标机 $DSH_HOME
 * @param {object} [opts]
 * @param {string} [opts.sourceHome] 源机 $DSH_HOME（用于 internal 链接重定位）
 * @param {boolean} [opts.dryRun]
 * @returns {{created:number, relocated:number, skipped:object[], failed:object[]}}
 */
export function rebuildLinks(bundleDir, dshHome, { sourceHome = '', dryRun = false, mappings = [] } = {}) {
  const linksPath = path.join(bundleDir, 'state', 'links.json')
  const out = { created: 0, relocated: 0, remapped: 0, skipped: [], failed: [] }
  if (!fs.existsSync(linksPath)) return out
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
  } catch {
    out.failed.push({ rel: 'state/links.json', reason: '读不出链接清单' })
    return out
  }
  const srcHome = typeof sourceHome === 'string' ? sourceHome.trim() : ''
  const dstHome = path.resolve(dshHome)

  // 与导出侧同一口径：判定「目标是否在源机 $DSH_HOME 内」以及取相对路径，都必须用 realpath。
  // 否则在 macOS（/var → /private/var）、Windows 短名、或把 $DSH_HOME 放在软链/junction 下时，
  // 内部链接会被判成「不在源机 $DSH_HOME 内」而被跳过，目标机上留一条指向源机路径的死链。
  const realOr = (p) => {
    try { return fs.realpathSync(p) } catch { return p }
  }
  const srcHomeReal = srcHome === '' ? '' : realOr(path.resolve(srcHome))
  const dstHomeReal = realOr(dstHome)
  const needRelocate = srcHome !== '' && srcHomeReal !== dstHomeReal

  for (const l of doc.links || []) {
    const abs = path.join(dshHome, l.scope, l.rel.split('/').join(path.sep))
    if (l.target === null || l.kind === 'broken') {
      out.skipped.push({ rel: l.rel, reason: '源机即断链，未重建' })
      continue
    }

    // internal 链接：换成目标机 $DSH_HOME 下的同一相对位置。
    // 首选 links.json 里的 homeRel（导出侧算好、与绝对路径无关），
    // 只有旧 bundle 没有该字段时才退回「目标是否在源机 home 内 + 取相对路径」这套比较。
    // 理由：绝对路径比较在 Windows 短名 / junction 存储拼写 / macOS /var 下会出现
    // 「一侧已展开、一侧未展开」，怎么比较都可能判错；记相对位置就没有这个问题。
    let target = l.target
    if (l.kind === 'internal') {
      let relFromHome = null
      if (typeof l.homeRel === 'string' && l.homeRel !== '') {
        relFromHome = l.homeRel
      } else if (needRelocate && isSameOrChild(target, srcHomeReal)) {
        relFromHome = path.relative(srcHomeReal, target).replace(/\\/g, '/')
      } else if (needRelocate) {
        out.skipped.push({ rel: l.rel, target: l.target, reason: '标记为内部链接但目标不在源机 $DSH_HOME 内，未重定位' })
        continue
      }
      if (relFromHome !== null) {
        const next = path.join(dstHome, relFromHome.split('/').join(path.sep))
        if (next !== target) {
          target = next
          out.relocated += 1
        }
      }
    } else if (l.kind === 'external') {
      // 外部链接的目标在 $DSH_HOME 之外（skills 指向自己的项目目录是最常见的一种）。
      // 目标机换了存放位置后，源机路径必然不存在；不理会映射的结果只有两种坏法：
      // 目标机没这个路径 → 链接被跳过（skills 全丢）；恰有同盘符同名路径 →
      // 链接建成了但指向源机的位置，指错内容且检查全绿。
      // 所以这里必须走与工作区、会话 cwd 完全同一套映射。
      const hit = applyMappings(target, Array.isArray(mappings) ? mappings : [])
      if (hit !== null) {
        target = hit.path
        out.remapped += 1
      }
    }

    const targetExists = fs.existsSync(target)
    if (!targetExists) {
      out.skipped.push({
        rel: l.rel,
        target,
        reason: l.kind === 'internal'
          ? '目标机 $DSH_HOME 下不存在该相对路径（bundle 的 state 是否完整落地？）'
          : '目标机上不存在该路径，重建后仍为断链'
            + (target !== l.target ? '（已按映射改为 ' + target + '，源机原为 ' + l.target + '）' : '（映射未覆盖该路径）'),
      })
      continue
    }
    if (dryRun) { out.created += 1; continue }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (fs.existsSync(abs) || isDanglingLink(abs)) fs.unlinkSync(abs)
      // 'junction' 只在 Windows 上有意义；POSIX 上目录链接的类型应当显式给 'dir'
      fs.symlinkSync(target, abs, process.platform === 'win32' ? 'junction' : 'dir')
      out.created += 1
    } catch (err) {
      // Windows 上建 junction 可能因权限失败，退回目录链接再试一次
      try {
        fs.symlinkSync(target, abs, 'dir')
        out.created += 1
      } catch (err2) {
        out.failed.push({ rel: l.rel, target, reason: (err2 && err2.message) || String(err2) })
      }
    }
  }
  return out
}

/** 判断一个路径是否是悬空软链（existsSync 对悬空链接返回 false，需要 lstat） */
function isDanglingLink(abs) {
  try {
    return fs.lstatSync(abs).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 只有「文件读不了」这类 I/O 错误可以被当成空结果吞掉。
 *
 * 宽 catch 在这个文件里是有前科的：幂等判定曾经因为漏 import 一个符号而抛 ReferenceError，
 * 被 `catch {}` 静默吞掉，结果是「重跑保护看起来在跑、实际一次都没生效」——比直接崩掉难查
 * 得多。所以凡是要吞异常的地方都先过这个函数，代码 bug 一律炸出来。
 */
function isFsIoError(err) {
  const code = err && err.code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR'
}

/** 小文件的 sha256（回写指纹用；读不出返回 null，绝不编一个哈希出来）。 */
function sha256Sync(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

/** 把一个会话目录（或任意子目录）复制到目标位置，覆盖前逐文件走 before 回调。 */
function copyDirInto(srcDir, destDir, before) {
  let files = 0
  let bytes = 0
  fs.mkdirSync(destDir, { recursive: true })
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name)
    const d = path.join(destDir, ent.name)
    if (ent.isDirectory()) {
      const r = copyDirInto(s, d, before)
      files += r.files
      bytes += r.bytes
    } else if (ent.isFile()) {
      if (before) before(d)
      fs.copyFileSync(s, d)
      files += 1
      bytes += fs.statSync(s).size
    }
  }
  return { files, bytes }
}

/**
 * 读出一个会话目录里任意一份日志的 header.cwd（多版本并存时 cwd 一致；全读不出返回 null）。
 */
function sessionDirCwd(dir) {
  let names
  try { names = fs.readdirSync(dir).sort() } catch (err) {
    if (!isFsIoError(err)) throw err
    return null
  }
  for (const name of names) {
    if (!isSessionLogName(name)) continue
    const read = readSessionHeader(path.join(dir, name))
    if (read.ok && read.header && typeof read.header.cwd === 'string') return read.header.cwd
  }
  return null
}

/**
 * 会话的幂等复制（重跑安全）。
 *
 * 重跑 apply（上次因错误中断后按 nextSteps 重跑、或 LAN 续传后的自动 apply）时，
 * 第一次落地已把会话分组目录改名到新编码、header 已改写。若再把 bundle 里的旧目录名
 * 原样复制进来，改写+改名会因目标已存在而失败，留下「旧目录名 + 新 cwd」的孤儿分组
 * —— 目录名与编码不符，verify 的 I3 判 FAIL，且要手工清理。所以复制前先按映射算好
 * 每个分组的落点，分三种情形：
 *   · 目标机已有迁移后分组（同编码目录、header cwd 指向新路径）且该会话已在 → **跳过**。
 *     这同时保住会话在目标机上的新增事件：迁移后用户若继续聊过这个会话，宿主会往里
 *     追加帧——照 bundle 覆盖等于丢历史；
 *   · 目标机已有迁移后分组但缺个别会话（上次中断）→ 直接补进新目录，改写随后在原位完成；
 *   · 其余照旧复制到旧目录名（改写后再改名，与首跑同一管线）。
 *
 * 识别不了 bundle 里的会话（无会话 / zstd 不可用）时退回整目录复制，行为与旧版一致。
 *
 * 第一个参数是 **bundle 的 state 根**（`scanSessions` 收的是 $DSH_HOME，内部自己拼
 * `sessions`），不是 sessions 目录本身——传错一层会静默扫出 0 个会话，幂等判定随之
 * 全盘失效（测试 `重跑 apply 不翻倍` 钉住这一点）。
 * @returns {{files:number, bytes:number, copied:number, skipped:number}}
 */
async function copySessionsIdempotent(bundleStateDir, targetSessionsDir, mappings, { before, onLog } = {}) {
  const log = onLog || (() => {})
  const bundleSessionsDir = path.join(bundleStateDir, 'sessions')
  let scan = null
  try { scan = await scanSessions(bundleStateDir) } catch (err) {
    if (!isFsIoError(err)) throw err
    scan = null
  }
  if (!fs.existsSync(bundleSessionsDir)) {
    return { files: 0, bytes: 0, copied: 0, skipped: 0 }
  }
  if (scan === null || scan.sessions.length === 0) {
    const r = copyInto(bundleSessionsDir, targetSessionsDir, { beforeOverwrite: before })
    return { files: r.files, bytes: r.bytes, copied: r.files, skipped: 0 }
  }
  const plan = planSessionMigration(scan, mappings)
  const byGroup = new Map(plan.groups.map((g) => [g.fromDir, g]))

  let files = 0
  let bytes = 0
  let copied = 0
  let skipped = 0
  for (const s of scan.sessions) {
    const g = byGroup.get(s.groupDir)
    const newCwd = g ? g.newCwd : null
    const toDirName = g ? g.toDir : s.groupDir
    const newGroupAbs = path.join(targetSessionsDir, toDirName.split('/').join(path.sep))

    // 目标机是否已有「迁移后」的分组：同编码目录里存在 header.cwd 指向 newCwd 的会话。
    // 只看目录名不够——目标机可能恰好有个同编码目录装着别的工作区的会话（编码有损）。
    let newGroupActive = false
    if (newCwd !== null && fs.existsSync(newGroupAbs)) {
      try {
        for (const id of fs.readdirSync(newGroupAbs)) {
          const sidDir = path.join(newGroupAbs, id)
          if (!fs.statSync(sidDir).isDirectory()) continue
          const cwd = sessionDirCwd(sidDir)
          if (cwd !== null && normalizePath(cwd) === normalizePath(newCwd)) { newGroupActive = true; break }
        }
      } catch (err) {
        // 读不了就当没有；但代码 bug 不许吞（见 isFsIoError 的说明）
        if (!isFsIoError(err)) throw err
      }
    }

    if (newGroupActive) {
      const sidDir = path.join(newGroupAbs, s.dirName)
      const cwd = fs.existsSync(sidDir) ? sessionDirCwd(sidDir) : null
      if (cwd !== null && normalizePath(cwd) === normalizePath(newCwd)) {
        skipped += 1
        continue
      }
      const r = copyDirInto(s.dirPath, sidDir, before)
      files += r.files
      bytes += r.bytes
      copied += 1
      log('  · 补进已迁移分组 ' + toDirName + '/' + s.dirName + '（' + r.files + ' 个文件）')
      continue
    }
    const r = copyDirInto(s.dirPath, path.join(targetSessionsDir, s.groupDir, s.dirName), before)
    files += r.files
    bytes += r.bytes
    copied += 1
  }

  // bundle sessions 根下的零散文件 / 非 `--...--` 形态的目录：维持整目录复制的语义
  for (const ent of fs.readdirSync(bundleSessionsDir, { withFileTypes: true })) {
    if (ent.isDirectory() && isSessionGroupDir(ent.name)) continue
    const s = path.join(bundleSessionsDir, ent.name)
    const d = path.join(targetSessionsDir, ent.name)
    if (ent.isDirectory()) {
      const r = copyDirInto(s, d, before)
      files += r.files
      bytes += r.bytes
    } else if (ent.isFile()) {
      if (before) before(d)
      fs.copyFileSync(s, d)
      files += 1
      bytes += fs.statSync(s).size
    }
  }
  return { files, bytes, copied, skipped }
}

/**
 * 执行落地。
 * @param {object} o
 * @param {string} o.bundleDir
 * @param {string} o.dshHome
 * @param {Array<{from:string,to:string}>} [o.mappings]
 * @param {boolean} [o.dryRun]
 * @param {string} [o.passphrase]
 * @param {boolean} [o.restoreSettings]
 * @param {boolean} [o.restoreCredentials]
 * @param {boolean} [o.restoreState]
 * @param {boolean} [o.rebuildSymlinks]
 * @param {(line:string)=>void} [o.onLog]
 * @returns {Promise<object>}
 */
/**
 * 把同类问题合并成一条报告。
 *
 * 理由:同一类问题在真实机器上可能成批出现(实测 50 个会话目录缺 session.jsonl.zstd),
 * 逐条列出会把真正需要人看的那两三条埋进噪声里。合并后保留「数量 + 种类 + 一个实例」,
 * 信息不丢,可读性大幅提升。
 *
 * @param {Array<{message:string}>} problems
 * @param {string} prefix
 * @returns {string[]}
 */
/** 目录存在且里面至少有一项。用于「拒绝覆盖已有工作区」的判断。 */
function isNonEmptyDir(p) {
  try {
    return fs.readdirSync(p).length > 0
  } catch {
    return false
  }
}

function groupProblems(problems, prefix) {
  const buckets = new Map()
  for (const p of problems || []) {
    // 「：」之后通常是具体目录名 / 会话 id,归并时去掉,只保留问题种类
    const key = String(p.message || '').replace(/[：:].*$/, '')
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(p)
  }
  const out = []
  for (const [key, list] of buckets) {
    if (list.length === 1) out.push(prefix + list[0].message)
    else out.push(prefix + list.length + ' 处同类：' + key + '（例：' + list[0].message + '）')
  }
  return out
}

export async function applyBundle({
  bundleDir, dshHome, mappings = [], dryRun = false, passphrase = '',
  restoreSettings = true, restoreCredentials = true, restoreState = true, rebuildSymlinks = true,
  workspaceRoot = '', workspaceMap = {}, overwriteWorkspaces = false,
  allowSameMachine = false,
  onLog,
} = {}) {
  const log = (s) => onLog && onLog(s)
  // ok 必须在构造时就给 false：本函数有多处提前 return（完整性失败、映射非法、建备份失败），
  // 若只在末尾赋值，那些路径返回的对象就没有 ok 字段，调用方拿到 undefined 而不是「失败」。
  const report = {
    bundleDir, dshHome, dryRun, ok: false,
    steps: [], warnings: [], errors: [], backupDir: null, nextSteps: [],
    sessions: null, workspaces: null, links: null, runtime: null,
    workspaceTargets: null, direction: null,
  }

  const inspected = inspectBundle(bundleDir)
  if (!inspected.ok && inspected.manifest === undefined) {
    report.errors.push(...inspected.problems)
    return report
  }
  const manifest = inspected.manifest
  for (const p of inspected.problems) report.warnings.push(p)

  // ── ① 完整性 ────────────────────────────────────────────────────────────
  const integrity = await verifyBundleIntegrity(bundleDir)
  if (!integrity.ok) {
    report.errors.push('bundle 完整性校验失败（' + integrity.failures.length + ' 个文件）')
    for (const f of integrity.failures.slice(0, 20)) report.errors.push('  · ' + f.file + ' — ' + f.reason)
    log('✗ 完整性校验失败，已停止（没有改动目标机的任何文件）')
    return report
  }
  report.steps.push({ step: 'integrity', ok: true, detail: 'sha256 × ' + integrity.checked + ' 全部通过' })
  log('✓ 完整性校验通过（' + integrity.checked + ' 个文件）')

  // ── ①b 方向：这个 bundle 是不是就从这儿出发的？ ───────────────────────────
  // 「哪台是新机」这件事插件判断不了,方向只由「在哪儿调哪个工具」决定。唯一能自动发现的是
  // 把方向搞反里最坏的一种:**搬回它自己出生的地方** —— 在旧机上跑 apply,用一份旧快照
  // 覆盖自己当前的会话 cwd / 工作区路径 / profile bundle 列表。会话首帧被改写是不可逆的
  // (虽有备份,但得先知道要恢复、且分得清哪些文件是本次改的)。所以这里默认拦下来。
  //
  // 判据取「同主机名 **且** 同 DSH_HOME」而不是只看主机名:
  //   · 同机器上 apply 到别的目录(临时目录预演、多套 DSH_HOME)= 合法,不该拦;
  //   · 两台机器恰好都叫 DESKTOP-XXXX 的概率不为零,加上 DSH_HOME 相同就几乎不可能误判。
  // 老 bundle 没有 source.identity(0.6.0 之前导出的)→ 判不了,如实说判不了,不假装通过。
  const srcId = manifest.source && manifest.source.identity ? manifest.source.identity : null
  const selfId = machineIdentity(dshHome)
  const sameHome = srcId !== null && String(srcId.dshHome || '') !== ''
    && normalizePath(String(srcId.dshHome)) === normalizePath(selfId.dshHome)
  const sameHost = srcId !== null && String(srcId.hostname || '') !== ''
    && String(srcId.hostname).toLowerCase() === String(selfId.hostname).toLowerCase()
  report.direction = { source: srcId, target: selfId, sameHost, sameHome, sameMachine: sameHost && sameHome }
  if (srcId === null) {
    log('⚠️ bundle 未记录源机身份（0.6.0 之前导出的），无法核对方向 —— 请自行确认这不是在旧机上跑的')
  } else if (sameHost && sameHome) {
    const who = '源机 ' + srcId.hostname + (srcId.user ? '(' + srcId.user + ')' : '')
      + ' / 本机 ' + selfId.hostname + (selfId.user ? '(' + selfId.user + ')' : '')
      + '，且 DSH_HOME 相同（' + selfId.dshHome + '）'
    if (!allowSameMachine) {
      report.errors.push('[方向] 这个 bundle 就是在本机导出的（' + who + '）。默认按「搬回自己」处理并停止：'
        + '你是不是把导出/落地两台机器搞反了？若确实是重装后原地恢复、或就想用这份快照覆盖当前状态，'
        + '显式传 allowSameMachine=true')
      log('✗ 检测到 bundle 来自本机同一个 DSH_HOME，已停止（没有改动任何文件）')
      return report
    }
    report.warnings.push('[方向] 本 bundle 来自本机同一个 DSH_HOME（' + who + '），按 allowSameMachine=true 继续')
    log('⚠️ 本 bundle 来自本机同一个 DSH_HOME，按 allowSameMachine=true 继续')
  } else {
    const src = (srcId.hostname || '未知') + (srcId.user ? '(' + srcId.user + ')' : '')
    const dst = selfId.hostname + (selfId.user ? '(' + selfId.user + ')' : '')
    // 同机不同 DSH_HOME 是合法场景（就地预演、一台机器上两套环境），但说清楚，
    // 免得用户看到「源机 A → 本机 A」以为检测失灵。
    log(sameHost
      ? '✓ 方向：本机 ' + dst + '，但 DSH_HOME 不同（' + (srcId.dshHome || '未记录') + ' → ' + selfId.dshHome
        + '）——按就地预演/多环境处理'
      : '✓ 方向：源机 ' + src + ' → 本机 ' + dst)
  }


  // ── ①' 运行时兼容性 ─────────────────────────────────────────────────────
  // 与 apply.ps1 / apply.sh 同一件事、同一套口径:两条落地路径不能一个查一个不查。
  // 放在 dryRun 里最有用 —— 那时还没动目标机,用户可以直接决定要不要先对齐版本。
  const runtimeCmp = compareRuntime(manifest.source || null, await probeRuntime(dshHome))
  report.runtime = runtimeCmp
  if (runtimeCmp.status === 'WARN') {
    report.warnings.push('[运行时] ' + runtimeCmp.detail)
    log('⚠️ ' + runtimeCmp.detail)
  } else {
    log('✓ ' + runtimeCmp.detail)
  }

  // ── ② 映射校验 ──────────────────────────────────────────────────────────
  const mapIssues = validateMappings(mappings)
  for (const i of mapIssues) {
    if (i.level === 'error') report.errors.push('[映射] ' + i.message)
    else report.warnings.push('[映射] ' + i.message)
  }
  if (mapIssues.some((i) => i.level === 'error')) {
    log('✗ 路径映射参数非法，已停止')
    return report
  }
  // ── ②b 工作区代码：先定落位，再让一切跟着它走 ────────────────────────────
  // 顺序上的硬要求：派生映射必须在使用 mappings 之前算出来。
  // 工作区代码落在哪，会话 cwd 与 workspace.json 就必须指向哪 —— 否则会话能列出、
  // 点开是空目录，而 verify 只会报「缺工作区目录」，看不出根因。
  const wsEntries = Array.isArray(manifest.workspaces) ? manifest.workspaces : []
  let effectiveMappings = mappings
  if (wsEntries.length > 0) {
    const plan = planWorkspaceTargets(wsEntries, { workspaceRoot, overrides: workspaceMap })
    for (const e of plan.errors) report.errors.push('[工作区] ' + e)
    // 落位定不下来就停，绝不往下走：此时继续会把会话 cwd 改到某个路径，而代码没落地，
    // 得到「历史在、点开是空目录」的半成品 —— 这种状态没有任何检查能一眼看出来。
    // 什么都不想要就先在源机用 includeWorkspaces=false 重导，而不是在这里硬闯。
    if (plan.errors.length > 0) {
      log('✗ 工作区落位未确定，已停止（没有改动目标机的任何文件）')
      return report
    }
    // 派生规则排在用户规则之前：代码的实际落位优先于手写前缀。
    // 反过来的话，用户一条 D:/a → E:/b 会把会话指到 E:/b/xxx，而代码在 workspaceRoot 下，
    // 结果就是「会话在、内容是空的」，且一切检查都显示成功。
    effectiveMappings = [...plan.mappings, ...mappings]
    for (const c of findMappingConflicts(plan.mappings, mappings)) report.warnings.push('[映射] ' + c)
    report.workspaceTargets = plan.targets
    log('工作区代码：' + plan.targets.length + ' 个待落地')

    const srcRoot = path.join(bundleDir, 'workspaces')
    let landed = 0
    for (const t of plan.targets) {
      const from = path.join(srcRoot, t.name)
      if (!fs.existsSync(from)) {
        report.warnings.push('[工作区] bundle 里没有 workspaces/' + t.name + '（清单与内容不一致），该工作区未落地')
        continue
      }
      // 覆盖已有目录是破坏性操作，而工作区体积大、通常也放不进备份。
      // 因此默认拒绝：让用户自己决定是换落位还是先挪走。
      if (isNonEmptyDir(t.destPath) && !overwriteWorkspaces) {
        report.errors.push('[工作区] ' + t.destPath + ' 已存在且非空，拒绝覆盖。'
          + '换一个 workspaceRoot、或先把它挪走；确认要覆盖时显式传 overwriteWorkspaces=true')
        continue
      }
      if (dryRun) {
        landed += 1
        log('  · [预演] ' + t.name + ' → ' + t.destPath)
        continue
      }
      try {
        const r = copyInto(from, t.destPath, {})
        landed += 1
        log('  ✓ ' + t.name + ' → ' + t.destPath + '（' + r.files + ' 个文件，'
          + (r.bytes / 1024 / 1024).toFixed(1) + ' MB）')
      } catch (err) {
        report.errors.push('[工作区] ' + t.name + ' 解包失败：' + (err && err.message ? err.message : String(err)))
      }
    }
    if (plan.targets.length > 0) {
      report.steps.push({ step: 'workspaces', ok: landed === plan.targets.length, landed, total: plan.targets.length })
    }
  }

  // 映射交代清楚：派生了几条、用户给了几条、还剩多少没覆盖。
  // 这段必须在 ②b 之后 —— 派生映射是在那里生成的，放前面会误报「未提供映射」。
  if (effectiveMappings.length === 0) {
    report.warnings.push('未提供路径映射：会话 cwd 与工作区路径将保持源机原值（仅当两台机器目录结构完全相同时才合适）')
    const candidates = guessPrefixes((manifest.state && manifest.state.sessions ? manifest.state.sessions.cwdDistinct : []) || [])
    if (candidates.length > 0) {
      report.warnings.push('源机会话涉及以下根前缀，可据此构造 mappings：'
        + candidates.map((c) => c.prefix + '（' + c.count + ' 个会话）').join('、'))
    }
  } else if (wsEntries.length > 0) {
    log('路径映射：自动派生 ' + (effectiveMappings.length - mappings.length) + ' 条（工作区落位优先）+ 手写 '
      + mappings.length + ' 条')
  }

  // ── ③ 备份目录 ──────────────────────────────────────────────────────────
  if (!dryRun) {
    try {
      report.backupDir = createBackupDir(dshHome)
      log('备份目录：' + report.backupDir)
    } catch (err) {
      report.errors.push('无法创建备份目录，已停止：' + (err && err.message))
      return report
    }
  }
  const before = (abs) => {
    if (dryRun || report.backupDir === null) return
    try { backupIfExists(abs, dshHome, report.backupDir) } catch { /* 备份失败不阻断，但要能看出来 */ }
  }

  // ── 回写检测的账本 ────────────────────────────────────────────────────────
  // apply 跑在活着的宿主进程里，宿主内存中持有 settings 与 workspace.json，随时可能
  // 把内存里的旧配置写回、盖掉刚落地的文件——用户看到的是「迁移成功，重启后设置全变旧」。
  // 每次写入关键文件后立刻记下内容 sha256，落地结束时复核（抓落地期间的并发回写），
  // 并把指纹写成落地回执（$DSH_HOME/.dsh-sync-apply-receipt.json），verify 的 I13
  // 随时复核（覆盖「落地之后、重启之前」这段更长的窗口）。
  const writtenFingerprints = new Map()
  const recordWrite = (rel) => {
    const h = sha256Sync(path.join(dshHome, rel))
    if (h !== null) writtenFingerprints.set(rel, h)
  }

  // ── ④ settings / credentials ────────────────────────────────────────────
  if (restoreSettings) {
    const encPath = path.join(bundleDir, 'settings.enc')
    const plainPath = path.join(bundleDir, 'settings.yaml')
    if (fs.existsSync(encPath)) {
      if (!passphrase) {
        report.errors.push('settings 是加密的，但未提供口令；跳过 settings（会话与链接仍可继续）')
      } else {
        try {
          const dec = decryptBuffer(fs.readFileSync(encPath), passphrase)
          const dest = path.join(dshHome, 'settings.yaml')
          if (!dryRun) { before(dest); fs.writeFileSync(dest, dec); recordWrite('settings.yaml') }
          report.steps.push({ step: 'settings', ok: true, encrypted: true })
          log('✓ settings.yaml 已解密落地')
        } catch (err) {
          report.errors.push('settings 解密失败（口令错误或文件损坏）：' + (err && err.message))
        }
      }
    } else if (fs.existsSync(plainPath)) {
      const dest = path.join(dshHome, 'settings.yaml')
      if (!dryRun) { before(dest); fs.copyFileSync(plainPath, dest); recordWrite('settings.yaml') }
      report.steps.push({ step: 'settings', ok: true, encrypted: false, redacted: (manifest.settingsRedacted || []).length })
      log('✓ settings.yaml 已落地' + ((manifest.settingsRedacted || []).length ? '（含 ' + manifest.settingsRedacted.length + ' 个被移除的密钥字段，需重新配置）' : ''))
    }
  }
  if (restoreCredentials) {
    const encPath = path.join(bundleDir, '.credentials.enc')
    const plainPath = path.join(bundleDir, '.credentials.yaml')
    if (fs.existsSync(encPath)) {
      if (!passphrase) {
        report.warnings.push('凭据是加密的，但未提供口令；跳过凭据')
      } else {
        try {
          const dec = decryptBuffer(fs.readFileSync(encPath), passphrase)
          const dest = path.join(dshHome, '.credentials.yaml')
          if (!dryRun) { before(dest); fs.writeFileSync(dest, dec); recordWrite('.credentials.yaml') }
          report.steps.push({ step: 'credentials', ok: true, encrypted: true })
          log('✓ .credentials.yaml 已解密落地')
        } catch (err) {
          report.errors.push('凭据解密失败：' + (err && err.message))
        }
      }
    } else if (fs.existsSync(plainPath)) {
      const dest = path.join(dshHome, '.credentials.yaml')
      if (!dryRun) { before(dest); fs.copyFileSync(plainPath, dest); recordWrite('.credentials.yaml') }
      report.steps.push({ step: 'credentials', ok: true, encrypted: false })
      log('✓ .credentials.yaml 已落地（明文，落地后请删除传输副本）')
    }
  }

  // ── ④b $DSH_HOME 根下的用户内容（cordis.patch.yml / AGENTS.md）──────────
  // 这一段以前是缺的:导出把 home 级 cordis.patch.yml 与 AGENTS.md 打进了 bundle,
  // 但 apply 从没落地过 —— 目标机的全局补丁与全局指令静默丢失,而报告一切正常。
  // 现在按 manifest.homeFiles 逐项落地;settings / 凭据 已在上一步单独处理,这里跳过。
  const handledHome = new Set(['settings.yaml', 'settings.enc', '.credentials.yaml', '.credentials.enc'])
  for (const f of manifest.homeFiles || []) {
    if (handledHome.has(f)) continue
    const from = path.join(bundleDir, f)
    if (!fs.existsSync(from)) {
      report.warnings.push(`manifest 声明了 ${f}，但 bundle 里没有该文件`)
      continue
    }
    const dest = path.join(dshHome, f)
    if (!dryRun) { before(dest); fs.copyFileSync(from, dest) }
    report.steps.push({ step: 'home:' + f, ok: true })
    log('✓ ' + f + ' 已落地')
  }

  // ── ⑤ profile 声明文件 + 插件源码 ───────────────────────────────────────
  // 递归复制：声明文件里可能带子目录（如 .dsh-market/state.json），
  // 只处理顶层条目会把它当成目录去 copyFile 而报错。
  const profileSrc = path.join(bundleDir, 'profiles')
  if (fs.existsSync(profileSrc)) {
    const copyTree = (from, to) => {
      for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, ent.name)
        const dest = path.join(to, ent.name)
        if (ent.isDirectory()) {
          if (!dryRun) fs.mkdirSync(dest, { recursive: true })
          copyTree(src, dest)
        } else if (!dryRun) {
          before(dest)
          fs.copyFileSync(src, dest)
        }
      }
    }
    for (const name of fs.readdirSync(profileSrc)) {
      const from = path.join(profileSrc, name)
      if (!fs.statSync(from).isDirectory()) continue
      const to = path.join(dshHome, 'profiles', name)
      if (!dryRun) fs.mkdirSync(to, { recursive: true })
      copyTree(from, to)
      report.steps.push({ step: 'profile:' + name, ok: true })
      log('✓ profile ' + name + ' 声明文件已落地')
    }
  }
  const pluginsSrc = path.join(bundleDir, 'plugins')
  const pluginPathMap = new Map()
  if (fs.existsSync(pluginsSrc)) {
    for (const name of fs.readdirSync(pluginsSrc)) {
      const from = path.join(pluginsSrc, name)
      if (!fs.statSync(from).isDirectory()) continue
      const to = path.join(dshHome, 'plugins', name)
      if (!dryRun) {
        fs.mkdirSync(to, { recursive: true })
        const r = copyInto(from, to, { beforeOverwrite: before })
        log('✓ 插件源码 ' + name + ' → ' + to + '（' + r.files + ' 个文件）')
      }
      pluginPathMap.set(name, to)
      report.steps.push({ step: 'plugin:' + name, ok: true, dest: to })
    }
  }

  // ── ⑥ 状态层落地 ────────────────────────────────────────────────────────
  if (restoreState && fs.existsSync(path.join(bundleDir, 'state'))) {
    // 与 constants.STATE_PARTS 保持同一份清单:导出侧写了什么,这里就必须落地什么。
    let sessionsCopy = null
    for (const { name } of STATE_PARTS) {
      const from = path.join(bundleDir, 'state', name)
      if (!fs.existsSync(from)) continue
      const to = path.join(dshHome, name)
      if (dryRun) {
        report.steps.push({ step: 'state:' + name, ok: true, dryRun: true })
        continue
      }
      fs.mkdirSync(to, { recursive: true })
      // sessions 走幂等复制：重跑时跳过目标机已是迁移后状态的会话（见函数头注释）。
      // 其余部分照旧整目录覆盖——文件内容相同，覆盖是幂等的。
      // 注意传的是 state 根而不是 state/sessions：scanSessions 的契约是 $DSH_HOME
      const r = name === 'sessions'
        ? await copySessionsIdempotent(path.join(bundleDir, 'state'), to, effectiveMappings, { before, onLog: log })
        : copyInto(from, to, { beforeOverwrite: before })
      if (name === 'sessions') sessionsCopy = r
      report.steps.push({ step: 'state:' + name, ok: true, files: r.files, bytes: r.bytes })
      log('✓ state/' + name + ' → ' + to + '（' + r.files + ' 个文件，' + (r.bytes / 1024 / 1024).toFixed(1) + ' MB）'
        + (name === 'sessions' && r.skipped > 0 ? '，' + r.skipped + ' 个已是迁移后状态，跳过复制' : ''))
    }

    // ⑥a 会话 header 改写 + 分组目录重编码
    // dryRun 时 state 还没复制到目标机，直接扫目标目录只会得到「0 个会话」——
    // 而「我这 84 个会话会被改成什么」正是预演唯一值得看的东西。所以预演改为扫描
    // bundle 内的 state 快照（结构与 dshHome 一致），只算不写。
    const scanRoot = dryRun ? path.join(bundleDir, 'state') : dshHome
    const scan = await scanSessions(scanRoot)
    const plan = planSessionMigration(scan, effectiveMappings)
    const applied = await applySessionPlan(plan, { root: path.join(scanRoot, 'sessions'), dryRun, onLog: log })
    report.sessions = {
      total: scan.sessions.length,
      logFiles: scan.sessions.reduce((n, s) => n + (s.logs || []).length, 0),
      groups: plan.groups.length,
      rewritten: applied.groups.reduce((s, g) => s + g.rewritten, 0),
      rewrittenFiles: applied.groups.reduce((s, g) => s + g.files, 0),
      renamed: applied.renamed,
      failed: applied.failed,
      conflicts: plan.conflicts,
      alreadyMigrated: sessionsCopy ? sessionsCopy.skipped : 0,
    }
    for (const c of plan.conflicts) {
      if (c.level === 'error') report.errors.push('[会话] ' + c.message)
      else report.warnings.push('[会话] ' + c.message)
    }
    // 同类问题合并成一条。真实机器上「空会话目录」可以一次出现 50 个（目录还在、日志已没），
    // 逐条上报会把真正的告警埋掉 —— 报告的价值取决于信噪比，不取决于条数。
    for (const line of groupProblems(scan.problems, '[会话] ')) report.warnings.push(line)
    log('会话：' + report.sessions.total + ' 个 / ' + report.sessions.logFiles + ' 份日志 / 改写 '
      + report.sessions.rewritten + ' 个会话（' + report.sessions.rewrittenFiles + ' 份日志）'
      + ' / 改名 ' + report.sessions.renamed + ' / 失败 ' + report.sessions.failed)
    // 「84 个会话只改写了 2 个」需要一句解释，否则看起来像漏处理。
    if (report.sessions.total > report.sessions.rewritten) {
      log('   · 其余 ' + (report.sessions.total - report.sessions.rewritten)
        + ' 个会话的 cwd 未命中任何映射，保持原值（它们的项目目录在目标机上仍是源机路径）')
    }
    report.steps.push({ step: 'sessions', ok: applied.failed === 0, ...report.sessions })

    // ⑥b workspace.json 路径改写
    // 与 ⑥a 同理：预演读 bundle 里的那份，否则恒报「目标机没有 workspace.json」，
    // 用户就无法确认工作区路径会被改成什么。
    const wsPath = dryRun
      ? path.join(bundleDir, 'state', 'storages', 'workspace.json')
      : path.join(dshHome, 'storages', 'workspace.json')
    if (fs.existsSync(wsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
        const re = remapWorkspacePaths(raw, effectiveMappings)
        if (re.changes.length > 0 && !dryRun) {
          before(wsPath)
          fs.writeFileSync(wsPath, JSON.stringify(re.json, null, 2) + '\n', 'utf8')
          recordWrite('storages/workspace.json')
        }
        // 映射没改它也照记指纹：workspace.json 已随状态层覆盖落地，宿主对它的回写同样致命
        if (!dryRun && !writtenFingerprints.has('storages/workspace.json')) {
          recordWrite('storages/workspace.json')
        }
        report.workspaces = { changed: re.changes.length, changes: re.changes }
        log('workspace.json：改写 ' + re.changes.length + ' 个工作区路径')
        report.steps.push({ step: 'workspace', ok: true, changed: re.changes.length })
      } catch (err) {
        report.errors.push('workspace.json 处理失败：' + (err && err.message))
      }
    } else {
      report.warnings.push('目标机没有 storages/workspace.json（bundle 未包含或落地失败）')
    }
  } else if (restoreState) {
    report.warnings.push('bundle 不含 state/ 目录：这是「能用的空环境」而不是「与本机一致」')
  }

  // ── ⑦ 软链重建 ──────────────────────────────────────────────────────────
  if (rebuildSymlinks && restoreState) {
    // sourceDshHome 用于 internal 链接重定位：目标机的 $DSH_HOME 可以与源机不同
    const links = rebuildLinks(bundleDir, dshHome, {
      sourceHome: typeof manifest.sourceDshHome === 'string' ? manifest.sourceDshHome : '',
      dryRun,
      mappings: effectiveMappings,
    })
    report.links = links
    if (links.created > 0) {
      log('软链：重建 ' + links.created + ' 个'
        + (links.relocated > 0 ? '（其中 ' + links.relocated + ' 个因 $DSH_HOME 位置不同而重定位' : '')
        + (links.remapped > 0 ? '，' + links.remapped + ' 个按路径映射改指新位置' : '')
        + (links.relocated > 0 || links.remapped > 0 ? '）' : ''))
    }
    if (links.skipped.length > 0) {
      report.warnings.push(links.skipped.length + ' 个软链未重建（目标机缺对应路径或源机即断链）')
      for (const s of links.skipped.slice(0, 10)) log('  · 跳过 ' + s.rel + ' — ' + s.reason)
    }
    if (links.failed.length > 0) {
      report.errors.push(links.failed.length + ' 个软链重建失败')
      for (const f of links.failed.slice(0, 10)) log('  · 失败 ' + f.rel + ' — ' + f.reason)
    }
    report.steps.push({ step: 'links', ok: links.failed.length === 0, ...links })
  }

  // ── ⑧ 残留的 link: 断链（只报告，不改写）────────────────────────────────
  // 导出时已把可 vendoring 的 link: 改写成 ../../plugins/<name>，所以落地后**应当**能解析。
  // 这里检查的是目标机上真实的 package.json，解析基准必须是该 profile 目录本身 ——
  // 此前用 path.resolve(spec) 按进程工作目录解析，结果是永久误报（相对路径永远对不上）。
  if (pluginPathMap.size > 0) {
    const profRoot = path.join(dshHome, 'profiles')
    const profileDirs = fs.existsSync(profRoot)
      ? fs.readdirSync(profRoot).filter((n) => fs.existsSync(path.join(profRoot, n, 'package.json')))
      : []
    for (const p of profileDirs) {
      const pdir = path.join(profRoot, p)
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8'))
        const resolveLink = (spec) => {
          const raw = String(spec).slice('link:'.length).replace(/\\/g, path.sep)
          return path.isAbsolute(raw) ? raw : path.resolve(pdir, raw)
        }
        const broken = Object.entries(pkg.dependencies || {})
          .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('link:'))
          .filter(([, spec]) => !fs.existsSync(resolveLink(spec)))
        if (broken.length > 0) {
          report.warnings.push('profile ' + p + ' 有 ' + broken.length + ' 个 link: 依赖在目标机解析不到（'
            + broken.map(([n]) => n).join(', ') + '）；多为该插件源码未 vendoring，需自备源码后重建 link:')
        }
      } catch { /* 读不出就跳过，不影响其他结果 */ }
    }
  }

  // ── ⑨ 回写复核 + 落地回执 ────────────────────────────────────────────────
  // ① 期末复核：写入时记下的 sha256 与此刻磁盘上的内容比对，抓「落地期间被并发写回」
  //   （宿主进程跟 apply 同时在跑，这一步当场抓现行，报 error 让整个 apply 判失败）。
  // ② 落地回执：指纹落盘，dshsync_verify 的 I13 随时复核——覆盖「落地之后、重启 dsh
  //   之前」这段更长的窗口（nextSteps 只能叮嘱，回执能把叮嘱变成可检测的失败）。
  if (!dryRun && writtenFingerprints.size > 0) {
    const drifted = []
    for (const [rel, expected] of writtenFingerprints) {
      const actual = sha256Sync(path.join(dshHome, rel))
      if (actual !== null && actual !== expected) drifted.push(rel)
    }
    if (drifted.length > 0) {
      report.errors.push('[回写] 以下文件在落地期间又被修改（宿主进程可能正在把内存里的旧配置写回）：'
        + drifted.join('、') + '。请完全退出 dsh（桌面版从托盘退出）后重新执行 apply')
      log('✗ 落地期间检测到并发回写：' + drifted.join('、'))
    }
    try {
      fs.writeFileSync(
        path.join(dshHome, APPLY_RECEIPT_FILE),
        JSON.stringify({
          appliedAt: new Date().toISOString(),
          files: Object.fromEntries(writtenFingerprints),
        }, null, 2) + '\n',
        'utf8',
      )
    } catch { /* 回执写不出只影响 verify 的 I13，不影响落地本身 */ }
  }

  report.errorCount = report.errors.length
  report.warningCount = report.warnings.length
  report.ok = report.errorCount === 0
  // 「落地之后该干什么」放在报告里，而不是只写在工具输出里 ——
  // 卡片上的迁移结果同样要告诉用户去重启，否则「看起来完成了但界面没变」会被当成搬失败。
  report.nextSteps = buildNextSteps(report, dryRun)
  return report
}

/**
 * 落地后的下一步。
 *
 * 桌面版那两条不是凑数的：目标机上通常没有 PATH 上的 pnpm 与 dsh 命令，
 * 照 web 的老提示去命令行装依赖会直接卡住；而「落地后先别在界面里改设置」这条，
 * 是为了避免宿主把内存里的旧配置写回、盖掉刚落地的文件。
 */
function buildNextSteps(report, dryRun) {
  const steps = []
  if (dryRun) {
    steps.push('确认预演结果后，用 dryRun=false 真正执行')
    return steps
  }
  if (!report.ok) {
    steps.push('按上方错误逐项处理后重跑（已完成的步骤不会重复破坏数据）')
    if (report.backupDir) steps.push('如需还原，从备份目录按相对路径拷回：' + report.backupDir)
    return steps
  }
  steps.push('重启 dsh（桌面版要从托盘完全退出后重开）让新配置与新会话生效')
  steps.push('首次启动由宿主重建依赖：桌面版自带 pnpm，不需要你在命令行装；'
    + '重启后若插件列表是空的，去插件管理器点一次「重新安装/修复」再重启')
  steps.push('落地后先别在界面里改设置，直接完全退出重开 —— 避免宿主把内存里的旧配置写回，盖掉刚落地的文件')
  if (report.backupDir) steps.push('确认一切正常后删除备份目录：' + report.backupDir)
  steps.push('用 dshsync_verify 再核对一遍一致性')
  return steps
}
