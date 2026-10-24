// lib/projcache.js — session_projcache 的双层身份重映射。
//
// 实测教训（P3 / P10）：宿主的会话身份索引有**两层**，dsh-sync 0.14.x 一层都没碰——
//   ① 单元 dump：storages/session_projcache.json（存储单元 v3，tables.sessions[*].identity.cwd
//      存工作区路径）。宿主侧栏靠它把会话挂到工作区——不改则「会话列表空白」。
//   ② 逐会话记录：storages/session_projcache/sessions/<id>.json（命名两种形态并存：
//      session-<uuid>.json 与裸 <uuid>.json——subagent 会话目录是裸 UUID，记录文件名跟着
//      目录名走）。记录里嵌着该会话日志的**绝对路径**身份，宿主 readGenerationHeader →
//      assertStoredIdentity 拿它与日志首帧互校，任何一层带旧路径就是
//      `corrupt session log`，且 workspaceRegistry 整棵拒绝激活（不是单条会话异常）。
//
// 因此迁移的落点清单必须是五处同一套口径：会话首帧 cwd → 分组目录名 → workspace.json →
// **projcache 两层** → skills 软链。本模块负责最后缺的那两处。
//
// 路径形态杂讯（P11 实测）：记录里有 22 处小写盘符 `e:\...`、正反斜杠混存——宿主不同版本
// 写入习惯不同。所以匹配一律先 normalize（盘符大小写不敏感、斜杠等价、段边界），输出一律
// 走 toNativeForm（宿主逐字比较，record.path 必须是 Win32 原生反斜杠）。
import fs from 'node:fs'
import path from 'node:path'

import { applyMappings, normalizePath, toNativeForm } from './path-map.js'

/** 本模块只认 JSON 文件；逐会话记录目录里可能出现别的产物，跳过不猜。 */
const DUMP_REL = path.join('storages', 'session_projcache.json')
const RECORDS_REL = path.join('storages', 'session_projcache', 'sessions')

/**
 * 构造「会话日志位置」替换对。逐会话记录里嵌的是日志绝对路径
 * `<home>/sessions/<分组名>/<会话id>/<日志文件>`，迁移后 home 前缀与分组名都可能变：
 * home 变（跨机迁移）由 sourceSessionsHome → targetSessionsHome 承担，
 * 分组名变（路径重映射导致重编码）由 sessionMoves 承担。
 * @param {Array<{fromDir:string,toDir:string}>} sessionMoves 分组改名清单（home 变而分组名没变的也要给，fromDir === toDir）
 * @param {string} sourceSessionsHome 记录里嵌的日志路径所属的 $DSH_HOME
 * @param {string} targetSessionsHome 迁移后的 $DSH_HOME
 * @returns {Array<{fromNorm:string, toNative:string}>}
 */
function buildSessionMovePairs(sessionMoves, sourceSessionsHome, targetSessionsHome) {
  const pairs = []
  for (const m of sessionMoves || []) {
    if (!m || typeof m.fromDir !== 'string' || typeof m.toDir !== 'string') continue
    pairs.push({
      fromNorm: normalizePath(path.join(sourceSessionsHome, 'sessions', m.fromDir)),
      toNative: toNativeForm(path.join(targetSessionsHome, 'sessions', m.toDir)),
    })
  }
  return pairs
}

/**
 * 对一个字符串值尝试重映射。只处理**整体就是绝对路径**的字符串值——applyMappings 的
 * 段边界判定要求整串命中，不会误伤「路径里夹着别的内容」的文本。
 * 会话日志位置（长前缀）先于通用映射：万一有人把 $DSH_HOME 放在被映射的工作区前缀下，
 * 日志路径必须走 sessions 专用口径，不能被工作区映射错误地带走。
 */
function remapString(str, movePairs, mappings) {
  if (typeof str !== 'string' || str === '') return null
  if (!/^[A-Za-z]:[\\/]/.test(str) && !str.startsWith('/')) return null
  const n = normalizePath(str)
  for (const p of movePairs) {
    if (n === p.fromNorm) return p.toNative
    if (n.startsWith(p.fromNorm + '/')) {
      return toNativeForm(p.toNative + n.slice(p.fromNorm.length))
    }
  }
  const hit = applyMappings(str, mappings)
  return hit === null ? null : hit.path
}

/** 递归改写一个 JSON 值里的路径字符串（原对象上原地修改）。返回改写的字符串数。 */
function remapValue(node, movePairs, mappings) {
  let changed = 0
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i]
      if (v !== null && typeof v === 'object') changed += remapValue(v, movePairs, mappings)
      else {
        const r = remapString(v, movePairs, mappings)
        if (r !== null) { node[i] = r; changed += 1 }
      }
    }
    return changed
  }
  if (node !== null && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (v !== null && typeof v === 'object') changed += remapValue(v, movePairs, mappings)
      else {
        const r = remapString(v, movePairs, mappings)
        if (r !== null) { node[k] = r; changed += 1 }
      }
    }
    return changed
  }
  return changed
}

/**
 * 重映射 session_projcache 的两层身份索引。
 *
 * @param {string} root $DSH_HOME（或预演时的 bundle state 根——两者结构一致）
 * @param {object} opts
 * @param {Array<{from:string,to:string}>} [opts.mappings] 通用工作区路径映射（dump 的 cwd 用）
 * @param {Array<{fromDir:string,toDir:string}>} [opts.sessionMoves] 分组改名清单（记录的日志路径用）
 * @param {string} [opts.sourceSessionsHome] 记录里嵌的日志路径所属的 $DSH_HOME（默认 root；跨机迁移传源机 home）
 * @param {string} [opts.targetSessionsHome] 迁移后的 $DSH_HOME（默认 root）
 * @param {boolean} [opts.dryRun]
 * @param {(abs:string)=>void} [opts.before] 覆盖前回调（备份）
 * @returns {{dump:{present:boolean, strings:number}, records:{present:boolean, files:number, changed:number, strings:number}}}
 */
export function remapProjCache(root, opts = {}) {
  const mappings = Array.isArray(opts.mappings) ? opts.mappings : []
  const dryRun = opts.dryRun === true
  const sourceHome = opts.sourceSessionsHome !== undefined && opts.sourceSessionsHome !== null && opts.sourceSessionsHome !== ''
    ? opts.sourceSessionsHome
    : root
  const targetHome = opts.targetSessionsHome !== undefined && opts.targetSessionsHome !== null && opts.targetSessionsHome !== ''
    ? opts.targetSessionsHome
    : root
  const movePairs = buildSessionMovePairs(opts.sessionMoves, sourceHome, targetHome)
  const out = {
    dump: { present: false, strings: 0 },
    records: { present: false, files: 0, changed: 0, strings: 0 },
  }

  const dumpPath = path.join(root, DUMP_REL)
  if (fs.existsSync(dumpPath)) {
    out.dump.present = true
    try {
      const json = JSON.parse(fs.readFileSync(dumpPath, 'utf8'))
      const n = remapValue(json, movePairs, mappings)
      out.dump.strings = n
      if (n > 0 && !dryRun) {
        if (opts.before) opts.before(dumpPath)
        fs.writeFileSync(dumpPath, JSON.stringify(json, null, 2) + '\n', 'utf8')
      }
    } catch { /* 读不出/不是 JSON：不动它，也不在这里报错（verify 的 I14 会兜住） */ }
  }

  const recordsDir = path.join(root, RECORDS_REL)
  if (fs.existsSync(recordsDir)) {
    out.records.present = true
    let names = []
    try { names = fs.readdirSync(recordsDir).filter((n) => n.endsWith('.json')) } catch { names = [] }
    for (const name of names) {
      const file = path.join(recordsDir, name)
      let json = null
      try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
      out.records.files += 1
      const n = remapValue(json, movePairs, mappings)
      if (n > 0) {
        out.records.changed += 1
        out.records.strings += n
        if (!dryRun) {
          if (opts.before) opts.before(file)
          fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8')
        }
      }
    }
  }
  return out
}

/** 比较键：Windows 大小写不敏感。 */
function compareKey(s) {
  const n = normalizePath(s)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** 递归统计仍指向 sourceHome 的路径字符串。 */
function countStale(node, homeKey, examples) {
  let n = 0
  if (Array.isArray(node)) {
    for (const v of node) n += countStale(v, homeKey, examples)
    return n
  }
  if (node !== null && typeof node === 'object') {
    for (const k of Object.keys(node)) n += countStale(node[k], homeKey, examples)
    return n
  }
  if (typeof node === 'string' && /^[A-Za-z]:[\\/]/.test(node)) {
    const c = compareKey(node)
    if (c === homeKey || c.startsWith(homeKey + '/')) {
      n += 1
      if (examples.length < 5) examples.push(node)
    }
  }
  return n
}

/**
 * 统计 projcache 两层里仍指向 sourceHome 的身份引用（verify I14 用）。
 * 宿主 assertStoredIdentity 拿记录里的日志绝对路径与实际位置互校，残留即
 * `corrupt session log` + workspaceRegistry 拒绝激活 —— 这不是提示性问题，是致命级。
 * @param {string} root $DSH_HOME
 * @param {string} sourceHome 源机 $DSH_HOME
 * @returns {{dump:number, records:number, total:number, examples:string[]}}
 */
export function countStaleHomeRefs(root, sourceHome) {
  const homeKey = compareKey(sourceHome)
  if (homeKey === '') return { dump: 0, records: 0, total: 0, examples: [] }
  const examples = []
  let dump = 0
  let records = 0
  const dumpPath = path.join(root, DUMP_REL)
  try {
    dump = countStale(JSON.parse(fs.readFileSync(dumpPath, 'utf8')), homeKey, examples)
  } catch { dump = 0 }
  const recordsDir = path.join(root, RECORDS_REL)
  try {
    for (const name of fs.readdirSync(recordsDir)) {
      if (!name.endsWith('.json')) continue
      try {
        records += countStale(JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8')), homeKey, examples)
      } catch { /* 单个记录读不出不拦整体 */ }
    }
  } catch { records = 0 }
  return { dump, records, total: dump + records, examples }
}
