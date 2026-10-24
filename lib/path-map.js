// lib/path-map.js — 跨机路径重映射（导出口径的唯一实现）。
//
// 为什么不能「随手 replace」：
//   ① 映射规则是**有序**的。多条规则前缀重叠时（D:\a → E:\b、D:\a\c → E:\d），
//      自创「最长前缀优先」会算出与规则顺序不同的结果 —— 用户写的顺序就是他的意图；
//   ② 命中必须落在**路径段边界**。否则 D:\deep 会把 D:\deepseek\dsh-chat 改成 E:\xseek\dsh-chat；
//   ③ 同一处路径会被写进**两个地方**：storages/workspace.json 的 workspaces[*].path 和
//      会话 header 的 cwd。DSH 加载时会校验 realpath(cwd) 与 workspace.path 一致，
//      两者必须逐字一致 —— 所以必须走同一个函数，绝不能一边用 A 口径一边用 B 口径。
//
// 本模块只做纯字符串运算，不碰文件系统，便于单测与在 apply 侧复用。

/** 盘符统一识别（Windows）。POSIX 侧不参与，只用于规范化时的判断。 */
const DRIVE_RE = /^[A-Za-z]:/

/**
 * 规范化：反斜杠→斜杠、折叠重复分隔符、去掉尾分隔符（根除外）。
 * 只做「表示形式」统一，不动大小写、不解析 `..`（解析交给 OS，避免与真实语义漂移）。
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (typeof p !== 'string' || p === '') return ''
  let s = p.replace(/\\/g, '/')
  // 折叠重复的 /，但保留 UNC 前缀（//server/share）
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  // 盘符统一大写，避免 d:/x 与 D:/x 被当成两条不同路径
  if (DRIVE_RE.test(s)) s = s[0].toUpperCase() + s.slice(1)
  return s
}

/**
 * 比较用的键：Windows 路径大小写不敏感，POSIX 敏感。
 * @param {string} p
 * @returns {string}
 */
function compareKey(p) {
  const n = normalizePath(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/**
 * 把规范化（正斜杠）路径转回**平台原生形态**（Windows → 反斜杠，POSIX 原样）。
 *
 * 为什么映射的**输出**必须是原生形态（实测教训，宿主 workspace-controller 的 attach 校验）：
 * 宿主把 `realpathNormalize(header.cwd)` 与 `workspace.json` 的 `record.path` **逐字比较**。
 * 首帧 cwd 给正斜杠能被 realpathNormalize 容忍（比较发生在 normalize 之后），
 * 但 record.path 本身若是正斜杠，与解析出来的 `E:\...` 逐字比较必败 ——
 * 表现为工作区内新建会话报 `session/workspace-attach-failed ... its cwd resolves to 'E:\...'`。
 * 所以映射结果凡是要落盘的（workspace.json 的 path、会话首帧 cwd、projcache、软链目标），
 * 一律先过这里转成原生反斜杠。**匹配**不受影响：applyOne/compareKey 都先 normalize。
 * @param {string} p
 * @returns {string}
 */
export function toNativeForm(p) {
  const s = normalizePath(p)
  if (process.platform !== 'win32') return s
  return s.replace(/\//g, '\\')
}

/**
 * child 是否等于 parent 或位于其**子路径**（段边界判定，不是字符串前缀）。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isSameOrChild(child, parent) {
  const c = compareKey(child)
  const p = compareKey(parent)
  if (p === '') return false
  if (c === p) return true
  return c.startsWith(p.endsWith('/') ? p : p + '/')
}

/**
 * 应用一条映射：命中（段边界）则替换前缀，否则返回 null。
 * 输出统一转原生形态（见 toNativeForm：宿主逐字比较 record.path，正斜杠必败）。
 * @param {string} p 待映射路径
 * @param {{from:string,to:string}} rule
 * @returns {string|null}
 */
function applyOne(p, rule) {
  const from = normalizePath(rule.from)
  const to = normalizePath(rule.to)
  if (from === '') return null
  if (!isSameOrChild(p, from)) return null
  const n = normalizePath(p)
  const keyLen = from.length
  // 用规范化后的原路径切片，保留大小写与分隔符风格由调用方决定
  const rest = n.slice(keyLen)
  return toNativeForm(to + rest)
}

/**
 * 按**顺序**应用映射集合，返回第一个命中的结果。
 *
 * 语义选择说明：命中第一条即返回（而非「全部依次套用」）。
 * 理由：连续套用会让 A→B、B→C 两条规则叠加，用户在写映射时不会预期这种传递效果；
 * 而「先到先得」与用户书写顺序一致，也便于报告时说明是哪条规则生效。
 *
 * @param {string} p
 * @param {Array<{from:string,to:string}>} mappings
 * @returns {{path:string, rule:object}|null} 未命中或结果等价 → null
 */
export function applyMappings(p, mappings) {
  if (!Array.isArray(mappings) || mappings.length === 0) return null
  for (const rule of mappings) {
    const mapped = applyOne(p, rule)
    if (mapped === null) continue
    if (compareKey(mapped) === compareKey(p)) return null // 等价改写，视作未命中
    return { path: mapped, rule }
  }
  return null
}

/**
 * 校验用户给的映射集合，返回问题清单（error 级会让调用方拒绝执行）。
 * @param {unknown} mappings
 * @returns {Array<{level:'error'|'warn', message:string}>}
 */
export function validateMappings(mappings) {
  const issues = []
  if (!Array.isArray(mappings)) {
    issues.push({ level: 'error', message: 'mappings 必须是数组' })
    return issues
  }
  const seen = new Set()
  mappings.forEach((m, i) => {
    const at = 'mappings[' + i + ']'
    if (m === null || typeof m !== 'object') {
      issues.push({ level: 'error', message: at + ' 必须是 {from,to} 对象' })
      return
    }
    const from = typeof m.from === 'string' ? normalizePath(m.from) : ''
    const to = typeof m.to === 'string' ? normalizePath(m.to) : ''
    if (from === '') issues.push({ level: 'error', message: at + '.from 不能为空' })
    if (to === '') issues.push({ level: 'error', message: at + '.to 不能为空' })
    if (from !== '' && to !== '' && compareKey(from) === compareKey(to)) {
      issues.push({ level: 'warn', message: at + ' 的 from 与 to 等价，该规则不会产生任何改写' })
    }
    // 绝对路径映射必须是绝对路径：相对前缀会让整棵树的归属变得不可预测
    if (from !== '' && !/^[A-Za-z]:\//.test(from) && !from.startsWith('/')) {
      issues.push({ level: 'warn', message: at + '.from 不是绝对路径，跨机迁移通常不会命中' })
    }
    if (to !== '' && !/^[A-Za-z]:\//.test(to) && !to.startsWith('/')) {
      issues.push({ level: 'warn', message: at + '.to 不是绝对路径，目标会话可能无法打开' })
    }
    if (from !== '') {
      const k = compareKey(from)
      if (seen.has(k)) issues.push({ level: 'error', message: at + '.from 与前序规则重复，后者永远不会生效' })
      seen.add(k)
    }
  })
  return issues
}

/**
 * 从若干真实路径里推断「源机根前缀」候选，供 apply 侧生成映射初值。
 * 只做统计，不做决定 —— 最终映射由调用方显式传入。
 * @param {string[]} paths
 * @returns {Array<{prefix:string,count:number}>}
 */
export function guessPrefixes(paths) {
  const tally = new Map()
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue
    const n = normalizePath(p)
    // 取前两段（盘符 + 一级目录）作为候选前缀：D:/deepseek/xxx → D:/deepseek
    const parts = n.split('/')
    if (parts.length < 2) continue
    const prefix = parts.slice(0, 2).join('/')
    tally.set(prefix, (tally.get(prefix) || 0) + 1)
  }
  return [...tally.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
}
