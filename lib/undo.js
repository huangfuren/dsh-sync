// lib/undo.js — apply 侧记账（落地账本）与导入级撤销（dshsync_undo）。
//
// 为什么需要：apply 覆盖任何文件前都先备份（.dsh-sync-backup-<ts>/），但「手工从备份
// 拷回」只对**覆盖类**有效 —— 新建的文件（会话 / 插件源码 / state）备份里根本没有，
// 分组目录被改名、软链被替换，备份更是完全不知道。用户「刚迁移完就后悔」时唯一的选择
// 是逐个目录猜。本模块把 apply 的每一笔变动按序记账，撤销时倒序回放：
//   · created     —— apply 前不存在 → 撤销 = 删掉（内容变过则跳过并报告）
//   · overwritten —— apply 前已存在 → 撤销 = 从备份拷回（备份即 pre-state）
//   · link        —— 软链/junction 新建（prevTarget=null）或替换（记旧指向）
//   · renamed     —— 会话分组目录改名 fromDir → toDir
//
// 安全网是**afterHash**：每个文件操作记下 apply 写完那一刻的内容 sha256（同一文件被
// 多次写时以最后一次为准）。撤销时当前内容 ≠ afterHash 说明「落地之后有人动过它」——
// 典型是用户已经开始用 dsh（会话追加了新帧）。这种文件**绝不碰**：删掉会丢用户的新
// 数据，恢复备份会丢 apply 之后的一切。跳过 + 逐条报告，由用户决定要不要手工处理。
// 这借鉴的是 dsh-workspace-migrate 的「只回滚本次导入创建的项」：撤销的边界是
// 「本次 apply 写下的内容」，而不是「备份目录里有什么」。
//
// 账本放在备份目录里（journal.json）而不是 $DSH_HOME 根：撤销与备份是同一个决定的
// 两面 —— 用户删掉备份目录，就等于宣布「这次迁移我认了」，账本跟着走是正确的语义。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { APPLY_RECEIPT_FILE, UNDO_JOURNAL_FILE } from './constants.js'

/** 账本格式版本：回放语义变化时递增，旧账本拒绝撤销而不是猜。 */
const JOURNAL_VERSION = 1

/**
 * 创建一本落地账本。
 * @param {string} dshHome 目标机 $DSH_HOME（rel 口径的基准）
 * @param {string} backupDir 本次 apply 的备份目录（账本落点）
 * @returns {object} journal
 */
export function createJournal(dshHome, backupDir) {
  const ops = [] // 文件与软链操作，按写入顺序
  const renames = [] // 分组改名（撤销要先于文件操作还原——见 undoBundle 的顺序说明）
  const dirs = [] // apply 顺手 mkdir 出来的目录（bundle 侧空目录没有文件可记，撤销时按空目录清理）
  const byRel = new Map() // rel → ops 下标（同一文件多次写只留最新一条）

  const journal = {
    dshHome,
    backupDir,
    appliedAt: new Date().toISOString(),
    ops,
    renames,
    /** 记一笔文件写入。existed=true 表示覆盖（调用方应已备份），false 表示新建。 */
    recordFile(abs, existed) {
      const rel = toRel(dshHome, abs)
      if (rel === null) return
      const prev = byRel.get(rel)
      // apply 在本次运行里已经把这个文件**新建**过（典型：state/storages 复制建出
      // workspace.json，随后 ⑥b 重映射又改写它）——第二次写入虽是"覆盖"，但覆盖的是
      // apply 自己刚写的内容，撤销口径仍是「删掉」。否则备份里存的是 apply 的输出，
      // 撤销会把它"还原"回来，文件永远删不干净。
      const kind = prev !== undefined && ops[prev].kind === 'created' ? 'created' : (existed ? 'overwritten' : 'created')
      const op = { kind, rel, afterHash: null }
      if (prev !== undefined) ops[prev] = op
      else { byRel.set(rel, ops.length); ops.push(op) }
    },
    /** 文件内容又变了（原地改写：会话 header / projcache / workspace.json）。刷新该文件最新一笔的 afterHash。 */
    noteWritten(abs) {
      const rel = toRel(dshHome, abs)
      if (rel === null) return
      const idx = byRel.get(rel)
      if (idx === undefined) return // 不是本次 apply 经手的文件（如宿主自己写的），不入账
      const h = sha256Sync(path.join(dshHome, rel))
      if (h !== null) ops[idx].afterHash = h
    },
    /** 记一笔软链。prevTarget=null 表示新建，否则是被替换的旧指向。 */
    recordLink(abs, prevTarget, newTarget) {
      const rel = toRel(dshHome, abs)
      if (rel === null) return
      ops.push({ kind: 'link', rel, prevTarget: prevTarget === null ? null : String(prevTarget), newTarget: String(newTarget) })
    },
    /** 记一笔目录改名（会话分组）。 */
    recordRename(fromRel, toRel) {
      renames.push({ fromDir: fromRel, toDir: toRel })
    },
    /** 记一笔「为落地而建的目录」（工作区落位 / 插件源码 / state 分区顶层）。 */
    recordDir(abs) {
      const rel = toRel(dshHome, abs)
      if (rel === null) return
      if (!dirs.includes(rel)) dirs.push(rel)
    },
    summary() {
      let created = 0
      let overwritten = 0
      let links = 0
      for (const op of ops) {
        if (op.kind === 'created') created += 1
        else if (op.kind === 'overwritten') overwritten += 1
        else if (op.kind === 'link') links += 1
      }
      return { created, overwritten, links, renames: renames.length, dirs: dirs.length, total: ops.length + renames.length }
    },
    /** 把账本写进备份目录。apply 的多个步骤各调一次：中途崩掉也留有已发生部分的账。 */
    save() {
      try {
        fs.mkdirSync(backupDir, { recursive: true })
        fs.writeFileSync(
          path.join(backupDir, UNDO_JOURNAL_FILE),
          JSON.stringify({ format: 'dsh-sync-journal', version: JOURNAL_VERSION, ...journal.summary(),
            appliedAt: journal.appliedAt, dshHome, ops, renames, dirs }, null, 1) + '\n',
          'utf8',
        )
      } catch { /* 账本写不出 = 没有撤销能力，但不能连累落地本身 */ }
    },
  }
  return journal
}

/** abs → 相对 dshHome 的 POSIX 斜杠 rel；不在 dshHome 之下返回 null（不入账）。 */
function toRel(dshHome, abs) {
  try {
    const rel = path.relative(dshHome, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
  } catch {
    return null
  }
}

/** 小文件 sha256；读不出返回 null（绝不编一个哈希出来，调用方把 null 当「无法核对」。 */
function sha256Sync(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 从落地回执里找最近一次 apply 的账本路径。
 * @returns {string|null} backupDir 绝对路径；回执缺失/没记账本时返回 null
 */
export function findLatestJournalDir(dshHome) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(dshHome, APPLY_RECEIPT_FILE), 'utf8'))
    const p = receipt && receipt.journal && typeof receipt.journal.path === 'string' ? receipt.journal.path : ''
    if (p !== '' && fs.existsSync(p)) return p
  } catch { /* 回执缺失走目录扫描 */ }
  // 兜底：扫 $DSH_HOME 下带账本的备份目录，取最新。老版本 apply 没写 journal 字段时的路径。
  let best = null
  let bestMtime = 0
  let names = []
  try { names = fs.readdirSync(dshHome) } catch { return null }
  for (const name of names) {
    if (!name.startsWith(backupPrefix())) continue
    const dir = path.join(dshHome, name)
    if (!fs.existsSync(path.join(dir, UNDO_JOURNAL_FILE))) continue
    try {
      const m = fs.statSync(path.join(dir, UNDO_JOURNAL_FILE)).mtimeMs
      if (m > bestMtime) { bestMtime = m; best = dir }
    } catch { /* 单个目录读不出不拦整体 */ }
  }
  return best
}

function backupPrefix() {
  // 与 apply-engine 的 BACKUP_PREFIX 同源；这里不 import 是为了保持 undo.js 不依赖 apply-engine
  //（apply-engine 反过来要 import 本模块，循环依赖会让两个模块的初始化顺序变成隐式契约）。
  return '.dsh-sync-backup-'
}

/**
 * 读并校验一本账本。
 * @returns {{ok:boolean, journal?:object, problems:string[]}}
 */
export function loadJournal(backupDir) {
  const problems = []
  const p = path.join(backupDir, UNDO_JOURNAL_FILE)
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    return { ok: false, problems: ['读不到账本 ' + UNDO_JOURNAL_FILE + '（老版本 apply 没有记账，或备份目录已被改动）：'
      + (err && err.message ? err.message : String(err))] }
  }
  if (doc.format !== 'dsh-sync-journal' || doc.version !== JOURNAL_VERSION) {
    return { ok: false, problems: ['账本格式不认识（format=' + doc.format + ' version=' + doc.version + '），拒绝撤销——宁可不撤，不可猜'] }
  }
  if (typeof doc.dshHome !== 'string' || doc.dshHome === '') {
    problems.push('账本没记 dshHome，按本次传入的 $DSH_HOME 继续（老账本）')
  }
  return { ok: true, journal: doc, problems }
}

/**
 * 导入级撤销：倒序回放一本账本，把目标机恢复到本次 apply 之前。
 *
 * 执行顺序是有讲究的：
 *   ① 文件操作（新建删 / 覆盖还原）——账本里的 rel 是**改名前**的口径（复制发生在改名前），
 *      但文件现在住在改名后的目录里。所以先按记录的 rel 找，找不到且 rel 落在某个
 *      fromDir 前缀下时，换 toDir 前缀再找一次。
 *   ② 目录改名还原 —— 把 toDir 改回 fromDir。若该分组下有任何文件被跳过（落地后
 *      内容变过 = 用户用过这个会话），**仍然改名**：留下的大多是已还原的旧内容，
 *      而「改回来」让 verify 的目录名/header 互查能精确指出哪几个会话被混合过；
 *      不改回来则所有还原了的文件全都错位。混合状态如实上报，不假装干净。
 *   ③ 软链 —— 新建的摘掉，被替换的还原旧指向。
 *
 * @param {object} o
 * @param {string} o.dshHome
 * @param {string} o.backupDir 含 journal.json 的备份目录
 * @param {boolean} [o.dryRun]
 * @param {(line:string)=>void} [o.onLog]
 * @returns {Promise<object>} 报告 {ok, undone, skipped, errors, nextSteps, ...}
 */
export async function undoBundle({ dshHome, backupDir, dryRun = false, onLog } = {}) {
  const log = (s) => onLog && onLog(s)
  const report = {
    dshHome, backupDir, dryRun, ok: false,
    undone: { created: 0, overwritten: 0, links: 0, renames: 0 },
    skipped: [], errors: [], nextSteps: [],
  }

  const loaded = loadJournal(backupDir)
  for (const p of loaded.problems) report.errors.push(p)
  if (!loaded.ok) {
    log('✗ ' + report.errors[0])
    return report
  }
  const journal = loaded.journal

  // 只允许撤销「最近一次」apply：如果回执显示其后又跑过一次 apply（回执时间更新），
  // 旧账本回放会按当时的 rel 去删/盖**新一次 apply 写下的内容**——那是二次破坏。
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(dshHome, APPLY_RECEIPT_FILE), 'utf8'))
    const receiptAt = Date.parse(receipt.appliedAt || '')
    const journalAt = Date.parse(journal.appliedAt || '')
    if (!Number.isNaN(receiptAt) && !Number.isNaN(journalAt) && receiptAt > journalAt
      && receipt.journal && receipt.journal.path && path.resolve(receipt.journal.path) !== path.resolve(backupDir)) {
      report.errors.push('回执显示 ' + receipt.appliedAt + ' 又跑过一次 apply（其备份在 '
        + receipt.journal.path + '）。只能撤销最新一次，请改用它；层层回退请一次撤一层。')
      log('✗ ' + report.errors[0])
      return report
    }
  } catch { /* 回执读不出：没有更新的 apply 可言，放行 */ }

  const ops = Array.isArray(journal.ops) ? journal.ops : []
  const renames = Array.isArray(journal.renames) ? journal.renames : []
  if (ops.length === 0 && renames.length === 0) {
    report.ok = true
    report.errors.push('账本是空的（那次 apply 没有写入任何文件），无事可撤')
    log('· 账本是空的，无事可撤')
    return report
  }

  // 改名对（fromDir → toDir）：文件操作要把「改名前的 rel」换算到当前实际位置。
  const renamePairs = renames.map((r) => ({ from: String(r.fromDir), to: String(r.toDir) }))
  const remapRel = (rel) => {
    if (fs.existsSync(path.join(dshHome, rel.split('/').join(path.sep)))) return rel
    for (const p of renamePairs) {
      if (rel === p.from || rel.startsWith(p.from + '/')) {
        const candidate = p.to + rel.slice(p.from.length)
        if (fs.existsSync(path.join(dshHome, candidate.split('/').join(path.sep)))) return candidate
      }
    }
    return rel
  }
  // 每个被改名的分组是否「全组干净地撤销」——有跳过就不能假装全还原（见函数头 ② 的说明）。
  const groupTainted = new Map() // toDir → true

  // ── ① 文件操作 ───────────────────────────────────────────────────────────
  for (const op of ops) {
    try {
      if (op.kind === 'created' || op.kind === 'overwritten') {
        const curRel = remapRel(op.rel)
        const curAbs = path.join(dshHome, curRel.split('/').join(path.sep))
        if (op.kind === 'created') {
          if (!fs.existsSync(curAbs)) continue // 预演/中断留下的空账：本来就没写成
          const h = sha256Sync(curAbs)
          if (op.afterHash === null || h !== op.afterHash) {
            report.skipped.push({ rel: curRel, reason: '落地之后内容已变（可能是继续用 dsh 追加了会话），未删除' })
            taint(renamePairs, curRel, groupTainted)
            continue
          }
          if (!dryRun) fs.rmSync(curAbs, { force: true })
          report.undone.created += 1
        } else {
          const backupAbs = path.join(backupDir, op.rel.split('/').join(path.sep))
          if (!fs.existsSync(backupAbs)) {
            report.errors.push('备份缺文件，无法还原：' + op.rel)
            taint(renamePairs, curRel, groupTainted)
            continue
          }
          const h = fs.existsSync(curAbs) ? sha256Sync(curAbs) : null
          if (h !== null && op.afterHash !== null && h !== op.afterHash) {
            report.skipped.push({ rel: curRel, reason: '落地之后内容已变，拒绝用备份盖掉' })
            taint(renamePairs, curRel, groupTainted)
            continue
          }
          if (!dryRun) {
            fs.mkdirSync(path.dirname(curAbs), { recursive: true })
            fs.copyFileSync(backupAbs, curAbs)
          }
          report.undone.overwritten += 1
        }
      } else if (op.kind === 'link') {
        const abs = path.join(dshHome, op.rel.split('/').join(path.sep))
        const cur = readLinkTarget(abs)
        if (op.prevTarget === null) {
          // 新建的软链：指向还是 newTarget（或已成悬空）才摘；指到别处说明有人改过，不动
          if (cur === null || cur === op.newTarget) {
            if (!dryRun) { try { fs.unlinkSync(abs) } catch { /* 已不在，视为撤销完成 */ } }
            report.undone.links += 1
          } else {
            report.skipped.push({ rel: op.rel, reason: '软链指向已被改为 ' + cur + '，未摘除' })
          }
        } else {
          // 被替换的软链：还原旧指向
          if (cur === op.newTarget || cur === null) {
            if (!dryRun) {
              try { fs.unlinkSync(abs) } catch { /* 不在就直接重建 */ }
              fs.mkdirSync(path.dirname(abs), { recursive: true })
              fs.symlinkSync(op.prevTarget, abs, process.platform === 'win32' ? 'junction' : 'dir')
            }
            report.undone.links += 1
          } else {
            report.skipped.push({ rel: op.rel, reason: '软链指向已被改为 ' + cur + '，未还原' })
          }
        }
      }
    } catch (err) {
      report.errors.push(op.rel + '：' + (err && err.message ? err.message : String(err)))
    }
  }

  // ── ② 目录改名还原 ───────────────────────────────────────────────────────
  for (const p of renamePairs) {
    const toAbs = path.join(dshHome, p.to.split('/').join(path.sep))
    const fromAbs = path.join(dshHome, p.from.split('/').join(path.sep))
    if (!fs.existsSync(toAbs) || fs.existsSync(fromAbs)) continue
    try {
      if (!dryRun) fs.renameSync(toAbs, fromAbs)
      report.undone.renames += 1
      if (groupTainted.get(p.to) === true) {
        report.skipped.push({ rel: p.from, reason: '该分组下有文件未能撤销（落地后被使用过），目录名已还原但个别会话可能是混合状态——请跑 dshsync_verify 核对' })
      }
    } catch (err) {
      report.errors.push('目录改名还原失败 ' + p.to + ' → ' + p.from + '：' + (err && err.message ? err.message : String(err)))
    }
  }

  // ── ③ 清掉因删除而空掉的目录 ─────────────────────────────────────────────
  // 必须在改名还原**之后**：文件操作发生在改名后的位置，目录却随改名回到了旧编码路径。
  // 对「删过的文件」新旧两个位置的父目录链都清一遍（只删空目录，绝不碰别的目录）。
  if (!dryRun) {
    const dirsSet = new Set()
    const addChain = (rel) => {
      let d = path.dirname(path.join(dshHome, rel.split('/').join(path.sep)))
      while (d.startsWith(dshHome) && d !== dshHome) { dirsSet.add(d); d = path.dirname(d) }
    }
    for (const op of ops) {
      if (op.kind !== 'created') continue
      addChain(op.rel)
      addChain(remapRel(op.rel))
    }
    for (const rel of (Array.isArray(journal.dirs) ? journal.dirs : [])) {
      dirsSet.add(path.join(dshHome, rel.split('/').join(path.sep)))
      addChain(rel)
    }
    const list = [...dirsSet].sort((a, b) => b.length - a.length) // 先删最深的
    for (const d of list) {
      try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d) } catch { /* 非空/被占用就留着 */ }
    }
  }

  // ── ④ 汇总 ───────────────────────────────────────────────────────────────
  const total = report.undone.created + report.undone.overwritten + report.undone.links + report.undone.renames
  report.errorCount = report.errors.length
  report.ok = report.errorCount === 0
  log((dryRun ? '[预演] ' : '') + '撤销完成：新建删 ' + report.undone.created
    + ' / 覆盖还原 ' + report.undone.overwritten + ' / 软链 ' + report.undone.links
    + ' / 改名还原 ' + report.undone.renames
    + (report.skipped.length ? '；跳过 ' + report.skipped.length + ' 项（落地后内容变过）' : ''))
  report.nextSteps = []
  if (dryRun) {
    report.nextSteps.push('这是预演：确认无误后用 dryRun=false 真正执行')
  } else {
    report.nextSteps.push('完全退出 dsh（桌面版从托盘退出）后重开，让恢复后的旧配置生效')
    report.nextSteps.push('跑 dshsync_verify 核对一致性' + (report.skipped.length ? '（有跳过项，重点看会话相关检查）' : ''))
    if (report.skipped.length > 0) {
      report.nextSteps.push('被跳过的文件是落地之后被改动过的（典型：你已经开始用 dsh）——撤销刻意不碰它们；'
        + '若确认不要这些改动，先手工移出会话目录再跑一次 dshsync_undo')
    }
    report.nextSteps.push('备份目录保留未动（' + backupDir + '）：确认一切正常后再删；撤销能力随它一起消失')
  }
  return report
}

/** 一笔跳过污染了哪个改名分组（文件在 toDir 下 → 该组 tainted）。 */
function taint(renamePairs, rel, groupTainted) {
  for (const p of renamePairs) {
    if (rel === p.to || rel.startsWith(p.to + '/')) groupTainted.set(p.to, true)
  }
}

/** 读软链指向；不是软链返回 null。悬空链接 lstat 能认出来，readlink 也读得出。 */
function readLinkTarget(abs) {
  try {
    if (!fs.lstatSync(abs).isSymbolicLink()) return null
    return fs.readlinkSync(abs)
  } catch {
    return null
  }
}
