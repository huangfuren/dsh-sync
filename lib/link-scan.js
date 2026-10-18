// lib/link-scan.js — 软链 / junction 扫描与分级。
//
// 为什么必须单独处理：
//   ① 打包器与 tar 默认行为不同：有的跟随（内容进去、结构丢了）、有的跳过（静默丢一整块）。
//      本地实测：dsh-localsend 的 collectDirectory 遇 isSymbolicLink() 直接 continue，
//      对真实 ~/.dsh/skills 跑出「0 个文件 / 10 条 skipped symlink」，整个 skills 全丢。
//   ② 迁移的目标是**结构一致**（不同于备份的「内容齐全」）：B 上的 skills/xxx 应当仍是链接，
//      而不是被摊平成实体目录 —— 否则用户的目录归属关系就被改写了。
//
// 因此本模块只**扫描与分级**，不做决定：
//   · internal —— 目标落在 $DSH_HOME 内。复制链接本身即可，两边结构自然一致。
//   · external —— 目标在 $DSH_HOME 外。复制链接后 B 上是否可用取决于目标是否存在，
//                 必须显式报告（skills 软链到工作区仓库就是这种）。
//   · broken   —— 当前就解析不到目标（断链）。原样搬过去仍是断链，提前说清。
//   · loop     —— 指向祖先目录造成的环，或 realpath 解析失败。

import fs from 'node:fs'
import path from 'node:path'

/** 扫描时默认跳过的重目录（可重建，且体量大到会拖垮扫描） */
const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dsh-runtimes', 'cache', 'logs'])

/**
 * 判断 child 是否等于 parent 或位于其子路径（大小写按平台）。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isSameOrChild(child, parent) {
  const norm = (p) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const c = norm(child)
  const p = norm(parent)
  if (p === '') return false
  return c === p || c.startsWith(p + '/')
}

/**
 * 扫描目录树下的全部软链（不跟随目录链接，避免扫穿到整块外部目录）。
 *
 * @param {string} rootDir 扫描根（通常是 $DSH_HOME）
 * @param {object} [opts]
 * @param {string[]} [opts.skipDirs] 额外跳过的顶层目录名
 * @param {number} [opts.maxDepth] 深度上限（默认 12；.dsh 的实际结构远浅于此）
 * @returns {{links:object[], summary:object}}
 */
export function scanLinks(rootDir, { skipDirs = [], maxDepth = 12 } = {}) {
  const root = path.resolve(rootDir)
  let rootReal = root
  try { rootReal = fs.realpathSync(root) } catch { /* 根不存在时退回原拼写 */ }

  const links = []
  const unreadable = []
  const skip = new Set([...DEFAULT_SKIP_DIRS, ...skipDirs])
  const visited = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth) {
      unreadable.push({ path: path.relative(root, dir), reason: 'too-deep' })
      return
    }
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      unreadable.push({
        path: path.relative(root, dir).replace(/\\/g, '/'),
        reason: 'readdir-failed: ' + (err && err.code ? err.code : 'unknown'),
      })
      return
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      if (ent.isSymbolicLink()) {
        let targetRaw = null
        try { targetRaw = fs.readlinkSync(abs) } catch { /* 读不到链接文本 */ }
        let targetAbs = null
        let resolves = false
        try {
          targetAbs = fs.realpathSync(abs)
          resolves = true
        } catch {
          // realpath 失败 = 断链（目标不存在）或环
          targetAbs = null
        }
        let kind
        if (!resolves) kind = 'broken'
        else if (isSameOrChild(targetAbs, rootReal)) kind = 'internal'
        else kind = 'external'
        links.push({
          rel,
          abs,
          linkText: targetRaw,
          target: targetAbs,
          targetNormalized: targetAbs === null ? null : targetAbs.replace(/\\/g, '/'),
          kind,
          // 目录链接与文件链接在还原时的处理不同（前者要目录，后者要文件）
          targetIsDir: resolves ? safeIsDir(targetAbs) : null,
        })
        continue
      }
      if (ent.isDirectory()) {
        if (depth === 0 && skip.has(ent.name)) continue
        if (skip.has(ent.name)) continue
        let real = null
        try { real = fs.realpathSync(abs) } catch { real = null }
        if (real !== null) {
          if (visited.has(real)) continue
          visited.add(real)
        }
        walk(abs, depth + 1)
      }
    }
  }

  function safeIsDir(p) {
    try { return fs.statSync(p).isDirectory() } catch { return null }
  }

  walk(root, 0)

  const byKind = { internal: 0, external: 0, broken: 0 }
  for (const l of links) byKind[l.kind] += 1

  // 外部目标按目录聚合：用户往往是一整批仓库软链进来，需要按「源目录」决策
  const externalTargets = new Map()
  for (const l of links) {
    if (l.kind !== 'external' || l.targetNormalized === null) continue
    const parent = path.posix.dirname(l.targetNormalized)
    const cur = externalTargets.get(parent) || { dir: parent, count: 0, samples: [] }
    cur.count += 1
    if (cur.samples.length < 3) cur.samples.push(l.targetNormalized)
    externalTargets.set(parent, cur)
  }

  return {
    links,
    summary: {
      total: links.length,
      ...byKind,
      externalDirs: [...externalTargets.values()].sort((a, b) => b.count - a.count),
      unreadable,
    },
  }
}

/**
 * 生成给用户看的告警行（无链接时返回空数组，不制造噪音）。
 * 措辞遵循一条原则：**没搬进去的东西必须可见**，绝不静默跳过。
 * @param {object} summary scanLinks 的 summary
 * @returns {string[]}
 */
export function linkWarnings(summary) {
  const out = []
  if (!summary || summary.total === 0) return out
  if (summary.internal > 0) {
    out.push(summary.internal + ' 个链接指向 $DSH_HOME 内部：复制链接本身即可保持结构一致')
  }
  if (summary.external > 0) {
    const dirs = (summary.externalDirs || []).map((d) => d.dir + ' (×' + d.count + ')')
    out.push(
      summary.external + ' 个链接指向 $DSH_HOME 外部，目标机需存在相同路径否则为断链：'
      + dirs.slice(0, 5).join('、') + (dirs.length > 5 ? ' 等 ' + dirs.length + ' 处' : ''),
    )
  }
  if (summary.broken > 0) {
    out.push(summary.broken + ' 个链接当前即断链，原样迁移后仍为断链')
  }
  if (summary.unreadable && summary.unreadable.length > 0) {
    out.push(summary.unreadable.length + ' 个目录无法读取（内容未扫描）：'
      + summary.unreadable.slice(0, 3).map((u) => u.path + ' (' + u.reason + ')').join('、'))
  }
  return out
}

/**
 * 生成目标机上的「重建链接」指令清单（供 apply 侧逐条执行）。
 * 只对 internal 链接自动重建；external 交给用户确认，因为目标路径可能根本不存在。
 * @param {object[]} links
 * @returns {{auto:object[], manual:object[]}}
 */
export function planLinkRebuild(links) {
  const auto = []
  const manual = []
  for (const l of links) {
    if (l.kind === 'internal') auto.push(l)
    else manual.push(l)
  }
  return { auto, manual }
}
