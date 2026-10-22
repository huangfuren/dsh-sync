// lib/workspace-pack.js — 工作区代码搬运。
//
// 为什么需要这一层：会话 cwd 指向的是**项目目录**，而项目目录在 $DSH_HOME 之外。
// 只搬 .dsh 时，换机后会话能列出来但点开是空的 —— verify 的 I8 报的就是这件事。
// 自用场景下「丝滑」的定义是：新机器上打开任意一个历史会话，文件都在、能直接干活，
// 所以项目目录必须一起走。
//
// 三条硬约束：
//   ① 按**根**搬，不按盘搬。会话 cwd 是具体项目目录（D:\deepseek\dsh-chat），
//      不是 D:\ 整个盘；按盘搬会把 5.4G 的无关内容（DSH 源码、临时目录）一并带走。
//   ② 嵌套根去重：D:\a 与 D:\a\b 同时出现在会话里时只搬 D:\a。
//      否则同一批文件搬两遍，apply 时两条映射还会互相打架。
//   ③ 目标位置由**一个根目录**决定（workspaceRoot），按原目录名展开 ——
//      派生出的映射与会话 cwd 天然一致，用户不必逐条写。
import fs from 'node:fs'
import path from 'node:path'

import { isSameOrChild, normalizePath } from './path-map.js'

/** 永远不进 bundle 的目录名：可重建产物，且体积通常是源码的数倍。 */
const NEVER_COPY = new Set(['node_modules'])

/**
 * 从一组路径里挑出「根」：去掉被其它路径包含的项。
 *
 * 输入是会话 cwd 与 workspace.json 里的 path，两者都可能给到子目录
 * （`…\sre-document\sre-docs-100-…\20260831-…`）。按根搬之后，
 * 子目录会自动跟着前缀映射落到新位置，不需要单独列一条规则。
 *
 * @param {string[]} paths
 * @returns {string[]} 规范化、去重、去嵌套后的根，按字母序
 */
export function pickWorkspaceRoots(paths) {
  const norm = [...new Set((Array.isArray(paths) ? paths : [])
    .map((p) => normalizePath(p))
    .filter((p) => p !== ''))]
  // 先按长度升序：父路径一定比子路径短，这样「已保留的根」总是先入列表，
  // 后面的子路径只需与已保留项比较一次。
  const sorted = norm.sort((a, b) => a.length - b.length || a.localeCompare(b))
  const roots = []
  for (const p of sorted) {
    if (roots.some((r) => isSameOrChild(p, r))) continue
    roots.push(p)
  }
  return roots.sort()
}

/**
 * 判断一个工作区根的 git 形态。
 *
 * 只看根目录会误判：`D:\deepseek\dsh-plugin` 自己不是仓库，它的 mine/ 下才是
 * 9 个独立仓库。这类「容器目录」在自用工作区里很常见，报成「没有 git」会让人
 * 以为历史没搬走，所以额外看一层子目录。
 *
 * @param {string} dir
 * @returns {Promise<'repo'|'multi'|'none'>} repo=自己是仓库；multi=子目录里是仓库；none=都没有
 */
export async function detectGit(dir) {
  try {
    if ((await fs.promises.stat(path.join(dir, '.git'))).isDirectory()) return 'repo'
  } catch { /* 不是仓库，继续看子目录 */ }
  let entries = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch { return 'none' }
  for (const e of entries) {
    if (!e.isDirectory() || NEVER_COPY.has(e.name) || e.name === '.git') continue
    try {
      if ((await fs.promises.stat(path.join(dir, e.name, '.git'))).isDirectory()) return 'multi'
    } catch { /* 这一层没有就继续 */ }
  }
  return 'none'
}

/**
 * 统计一个目录的文件数与字节数，同时看它是不是 git 仓库。
 * 与复制用同一套排除规则（跳过 node_modules），所以这里的数字就是最终会进 bundle 的量。
 * @param {string} dir
 * @returns {Promise<{files:number, bytes:number, hasGit:boolean, gitMode:string}>}
 */
export async function measureDir(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (NEVER_COPY.has(ent.name)) continue
      const abs = path.join(cur, ent.name)
      if (ent.isDirectory()) { stack.push(abs); continue }
      if (ent.isFile()) {
        try {
          bytes += (await fs.promises.stat(abs)).size
          files += 1
        } catch { /* 读不到就跳过，统计略少比失败好 */ }
      }
      // 软链不跟随也不计数：工作区里的软链多半指向本机其它位置，
      // 逐条重建的语义与 $DSH_HOME 内的链接不同，这里不假装能处理。
    }
  }
  const gitMode = await detectGit(dir)
  return { files, bytes, hasGit: gitMode !== 'none', gitMode }
}

/**
 * 从 dsh state 里收集工作区候选根。
 *
 * 来源有两处，缺一不可：
 *   · 会话 header 的 cwd —— 决定「哪些目录会被打开」；
 *   · storages/workspace.json 的 path —— 决定「工作区列表里显示什么」。
 * 只取前者会漏掉建过但没聊过的工作区；只取后者会漏掉历史遗留的 cwd。
 *
 * @param {string} dshHome
 * @param {{ cwdDistinct?: string[], workspacePaths?: string[] }} known
 * @returns {Promise<Array<{path:string, exists:boolean, files:number, bytes:number, hasGit:boolean, sources:string[]}>>}
 */
export async function scanWorkspaceCandidates(dshHome, known = {}) {
  const fromSessions = (known.cwdDistinct || []).map((p) => ({ p, source: 'sessions' }))
  const fromStore = (known.workspacePaths || []).map((p) => ({ p, source: 'workspace.json' }))

  const sourceOf = new Map()
  for (const { p, source } of [...fromSessions, ...fromStore]) {
    const n = normalizePath(p)
    if (n === '') continue
    if (!sourceOf.has(n)) sourceOf.set(n, new Set())
    sourceOf.get(n).add(source)
  }

  const roots = []
  for (const root of pickWorkspaceRoots([...sourceOf.keys()])) {
    const abs = root.replace(/\//g, path.sep)
    const st = await fs.promises.stat(abs).catch(() => null)
    const exists = st !== null && st.isDirectory()
    const measured = exists ? await measureDir(abs) : { files: 0, bytes: 0, hasGit: false, gitMode: 'none' }
    // 嵌套在这条根之下的 cwd 也记下来：报告里要说清「这个根覆盖了哪几个会话目录」，
    // 否则用户看到 8 个 cwd 只搬 5 个根会以为漏了。
    const covered = [...sourceOf.keys()].filter((p) => p !== root && isSameOrChild(p, root))
    roots.push({
      path: root,
      exists,
      files: measured.files,
      bytes: measured.bytes,
      hasGit: measured.hasGit,
      gitMode: measured.gitMode,
      sources: [...(sourceOf.get(root) || [])].sort(),
      covers: covered,
    })
  }
  return roots
}

/**
 * 给工作区取 bundle 内的目录名。
 * 同名的两个根（D:\a\util 与 D:\b\util）会撞车，加序号区分；
 * 一旦定名就写进 manifest，apply 侧只认这个名字，不再推导。
 * @param {string[]} paths
 * @returns {string[]}
 */
export function assignWorkspaceNames(paths) {
  const used = new Set()
  return paths.map((p) => {
    const base = normalizePath(p).split('/').filter(Boolean).pop() || 'workspace'
    // 目录名里不允许出现会破坏路径的字符（Windows 上 \ / : * ? " < > | 都不行）
    let name = base.replace(/[\\/:*?"<>|]/g, '_')
    if (name === '' || name === '.' || name === '..') name = 'workspace'
    let candidate = name
    let i = 2
    while (used.has(candidate.toLowerCase())) {
      candidate = name + '-' + i
      i += 1
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * 把「用户勾选的东西」解析成实际要搬的路径。
 *
 * 接受三种写法，因为自用场景下人是记不住完整路径的：
 *   · `'*'` / `true` —— 全部存在的候选；
 *   · 完整路径 `D:/deepseek/dsh-plugin`；
 *   · 目录名 `dsh-plugin` —— 与候选的末段比对，大小写不敏感。
 * 不在候选里的绝对路径也接受：用户可能想搬一个从没聊过、但自己知道要用的目录。
 *
 * @param {Array<{path:string, exists:boolean}>} candidates
 * @param {unknown} wanted
 * @returns {{picked:string[], missing:string[]}}
 */
export function selectWorkspacePaths(candidates, wanted) {
  const list = Array.isArray(candidates) ? candidates : []
  if (wanted === true || wanted === '*' || wanted === 'all') {
    return { picked: list.filter((c) => c.exists).map((c) => c.path), missing: [] }
  }
  if (!Array.isArray(wanted)) return { picked: [], missing: [] }

  const byPath = new Map(list.map((c) => [normalizePath(c.path), c]))
  const byName = new Map()
  for (const c of list) {
    const key = normalizePath(c.path).split('/').filter(Boolean).pop().toLowerCase()
    if (!byName.has(key)) byName.set(key, c)
  }

  const picked = []
  const missing = []
  for (const raw of wanted) {
    const key = normalizePath(String(raw === null || raw === undefined ? '' : raw))
    if (key === '') continue
    const hit = byPath.get(key) || byName.get(key.split('/').filter(Boolean).pop().toLowerCase())
    if (hit) {
      if (hit.exists) picked.push(hit.path)
      else missing.push(hit.path + '（源机不存在）')
      continue
    }
    if (/^[A-Za-z]:\//.test(key) || key.startsWith('/')) picked.push(key)
    else missing.push(key + '（既不是绝对路径，也不在候选里）')
  }
  return { picked, missing }
}

/**
 * 把选中的工作区复制进 bundle。
 * @param {string} bundleDir
 * @param {string} dshHome
 * @param {Array<{path:string}>} selected
 * @param {{ includeGit?: boolean, onLog?: (s:string)=>void }} [opts]
 * @returns {Promise<{entries:Array<{name:string,sourcePath:string,files:number,bytes:number,hasGit:boolean}>, warnings:Array<object>}>}
 */
export async function exportWorkspaces(bundleDir, dshHome, selected, { includeGit = true, onLog } = {}) {
  const log = (s) => onLog && onLog(s)
  const warnings = []
  const entries = []
  const outRoot = path.join(bundleDir, 'workspaces')
  const names = assignWorkspaceNames(selected.map((s) => s.path))

  for (let i = 0; i < selected.length; i += 1) {
    const src = normalizePath(selected[i].path).replace(/\//g, path.sep)
    const name = names[i]
    const dest = path.join(outRoot, name)
    let files = 0
    let bytes = 0

    const walk = async (from, to) => {
      let dirents
      try {
        dirents = await fs.promises.readdir(from, { withFileTypes: true })
      } catch (err) {
        warnings.push({
          where: 'workspaces/' + name,
          preview: from,
          reason: '目录不可读，内容未进入 bundle：' + (err && err.code ? err.code : 'unknown'),
        })
        return
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : 1))
      await fs.promises.mkdir(to, { recursive: true })
      for (const d of dirents) {
        if (NEVER_COPY.has(d.name)) continue
        if (!includeGit && d.name === '.git') continue
        const a = path.join(from, d.name)
        const b = path.join(to, d.name)
        if (d.isSymbolicLink()) {
          // 工作区里的软链不跟随：跟随会把本机别处的树整个复制进来，
          // 体积与语义都失控。如实记一条告警，让用户知道这份拷贝少了什么。
          let target = null
          try { target = await fs.promises.realpath(a) } catch { target = null }
          warnings.push({
            where: 'workspaces/' + name,
            preview: path.relative(src, a).split(path.sep).join('/'),
            reason: '工作区内软链未搬运（目标：' + (target || '已断链') + '），目标机会缺这一项',
          })
          continue
        }
        if (d.isDirectory()) { await walk(a, b); continue }
        if (d.isFile()) {
          try {
            await fs.promises.copyFile(a, b)
            bytes += (await fs.promises.stat(a)).size
            files += 1
          } catch (err) {
            warnings.push({
              where: 'workspaces/' + name,
              preview: path.relative(src, a).split(path.sep).join('/'),
              reason: '复制失败：' + (err && err.code ? err.code : 'unknown'),
            })
          }
        }
      }
    }

    await walk(src, dest)
    const gitMode = await detectGit(src)
    entries.push({
      name,
      sourcePath: normalizePath(src),
      files,
      bytes,
      hasGit: gitMode !== 'none' && includeGit,
      gitMode: includeGit ? gitMode : 'none',
    })
    log('workspaces/' + name + ': ' + files + ' 个文件, ' + (bytes / 1024 / 1024).toFixed(1) + ' MB'
      + (gitMode === 'repo' ? '（含 .git）' : gitMode === 'multi' ? '（含子仓库 .git）' : ''))
  }
  return { entries, warnings }
}

/**
 * 计算每个工作区在目标机上的落位，并**派生**出对应的路径映射。
 *
 * 为什么派生映射要排在用户手写映射**之前**：
 * 工作区代码已被解包到 destPath，会话 cwd 必须指向同一个地方。
 * 若用户手写的规则先命中（比如 D:/deepseek → E:/code），会话会指向 E:/code/dsh-chat，
 * 而代码实际在 E:/workspaces/dsh-chat —— 打开就是空目录，且 verify 也只会报 I8 缺目录，
 * 看不出根因。所以派生优先，重叠时显式告警。
 *
 * @param {Array<{name:string, sourcePath:string}>} entries manifest 里的 workspaces
 * @param {{ workspaceRoot?: string, overrides?: Record<string,string> }} opts
 * @returns {{ targets: Array<{name:string,sourcePath:string,destPath:string}>, mappings: Array<{from:string,to:string,derived:boolean}>, errors: string[] }}
 */
export function planWorkspaceTargets(entries, { workspaceRoot = '', overrides = {} } = {}) {
  const targets = []
  const mappings = []
  const errors = []
  const root = normalizePath(workspaceRoot)

  for (const e of Array.isArray(entries) ? entries : []) {
    const name = String(e.name || '')
    if (name === '') continue
    const override = overrides && typeof overrides[name] === 'string' ? normalizePath(overrides[name]) : ''
    const dest = override !== '' ? override : (root !== '' ? normalizePath(root + '/' + name) : '')
    if (dest === '') {
      errors.push('工作区 ' + name + ' 未指定落位：请给 workspaceRoot，或用 workspaceMap 指定该工作区的目标路径')
      continue
    }
    targets.push({ name, sourcePath: normalizePath(e.sourcePath), destPath: dest })
    mappings.push({ from: normalizePath(e.sourcePath), to: dest, derived: true })
  }
  return { targets, mappings, errors }
}

/**
 * 找出用户手写映射里「会与派生规则抢同一个源」的项。
 * 只报告，不修改用户的输入 —— 但要说清哪条实际生效，不能让人以为自己的规则被采纳了。
 * @param {Array<{from:string,to:string}>} derived
 * @param {Array<{from:string,to:string}>} userMappings
 * @returns {string[]}
 */
export function findMappingConflicts(derived, userMappings) {
  const issues = []
  for (const d of derived) {
    for (const u of userMappings || []) {
      const uf = normalizePath(u.from)
      if (uf === '') continue
      // 用户规则覆盖了工作区根，或落在工作区根之内 —— 两种都会让会话指向与代码不同的位置
      if (isSameOrChild(uf, d.from) || isSameOrChild(d.from, uf)) {
        issues.push('映射 ' + u.from + ' → ' + u.to + ' 与已搬运的工作区 ' + d.from + ' 重叠；'
          + '该工作区按 ' + d.to + ' 落位，此规则对它不生效（其余路径仍按该规则改写）')
      }
    }
  }
  return issues
}
