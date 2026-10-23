// lib/merge-plan.js — 第二次（及以后）迁移的冲突盘点。
//
// 为什么要有这个文件：第一次迁移时目标机是空的，覆盖写怎么写都无所谓；**第二次不是**。
// 目标机已经用了一段时间，它自己装过插件、加过工作区、改过设置、建过会话。此时再拿
// 源机那份快照去覆盖，盖掉的是目标机真实产生的内容 —— 而源机快照里没有的东西，
// 覆盖之后就消失了，备份里有但没人会去翻。
//
// 所以第二次迁移的正确姿势不是「照抄」，而是**先把分歧摊开**：
//   · 源机有、目标机没有 → 这正是迁移的本意，直接带过来，无需决议；
//   · 两边都有且一样 → 无事发生；
//   · 目标机有、源机没有 → **会被覆盖掉**，必须让用户决定留不留；
//   · 两边都有但不一样 → 必须让用户决定要哪边。
//
// 这里只做「算」，不碰任何文件。所有判断都是纯读。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { scanSessions, readWorkspacePaths } from './session-migrate.js'

/** 冲突种类。渲染与决议都按这四个 key 分组。 */
export const MERGE_KINDS = ['plugins', 'workspaces', 'settings', 'sessions']

/**
 * 会话的合并策略。
 * `append-missing` 是文件级补缺（目标机缺哪份日志就补哪份），**不拆帧** ——
 * 帧链一旦被拆开重组就谈不上「历史不可能被破坏」了，所以宁可粗一点。
 */
export const SESSION_POLICIES = ['skip', 'append-missing', 'prefer-source', 'prefer-target']

/** 单条决议的取值。 */
export const KEEP_TARGET = 'keep-target'
export const TAKE_SOURCE = 'take-source'

function sha256File(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

function readJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch {
    return null
  }
}

/** 有 package.json 的目录才算 profile（与 lib/bundle.js 的 listProfiles 同一判据）。 */
function profileNamesOf(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')
        && !['node_modules', '.cache', '.pnpm-store', '.store'].includes(d.name))
      .filter((d) => fs.existsSync(path.join(root, d.name, 'package.json')))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 取出一份 package.json 里的插件声明。
 * `dependencies` 决定装什么，`dsh.profile.bundles` 决定实际加载什么 —— 两处都要看，
 * 只合并一处会得到「声明里有、但不加载」或反过来（注释见 lib/bundle.js 同款说明）。
 */
export function pluginDeclsOf(pkg) {
  const deps = (pkg && pkg.dependencies && typeof pkg.dependencies === 'object') ? pkg.dependencies : {}
  const bundles = (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))
    ? pkg.dsh.profile.bundles.slice()
    : []
  return { deps, bundles }
}

/**
 * 比两边的插件声明。
 * @returns {{onlyInTarget:string[], onlyInSource:string[], differ:Array<{name:string,target:string,source:string}>}}
 */
export function diffPluginDecls(bundlePkg, targetPkg) {
  const b = pluginDeclsOf(bundlePkg)
  const t = pluginDeclsOf(targetPkg)
  const bNames = new Set([...Object.keys(b.deps), ...b.bundles])
  const tNames = new Set([...Object.keys(t.deps), ...t.bundles])
  const onlyInTarget = [...tNames].filter((n) => !bNames.has(n)).sort()
  const onlyInSource = [...bNames].filter((n) => !tNames.has(n)).sort()
  const differ = []
  for (const n of [...bNames].filter((n) => tNames.has(n)).sort()) {
    const bs = b.deps[n] === undefined ? '(bundles only)' : String(b.deps[n])
    const ts = t.deps[n] === undefined ? '(bundles only)' : String(t.deps[n])
    if (bs !== ts) differ.push({ name: n, target: ts, source: bs })
  }
  return { onlyInTarget, onlyInSource, differ }
}

/**
 * 算冲突清单。纯读，不写任何文件。
 *
 * @param {object} o
 * @param {string} o.bundleDir
 * @param {string} o.dshHome - 目标机 $DSH_HOME
 * @returns {Promise<{conflicts:object[], auto:object[], sessions:object, settings:object}>}
 *   conflicts —— 需要用户决议的项；auto —— 无分歧、会照常带过来的项（只用于报告）
 */
export async function planMerge({ bundleDir, dshHome }) {
  const conflicts = []
  const auto = []

  // ── ① 插件声明（每个 profile 单独比）────────────────────────────────────
  const bundleProfRoot = path.join(bundleDir, 'profiles')
  const targetProfRoot = path.join(dshHome, 'profiles')
  const names = [...new Set([
    ...profileNamesOf(bundleProfRoot),
    ...profileNamesOf(targetProfRoot),
  ])].sort()

  for (const profile of names) {
    const bPkg = readJson(path.join(bundleProfRoot, profile, 'package.json'))
    const tPkg = readJson(path.join(targetProfRoot, profile, 'package.json'))
    if (bPkg === null && tPkg === null) continue
    // 只有一边有这个 profile：不是冲突，是「整个 profile 带过来/原样保留」
    if (bPkg === null || tPkg === null) {
      auto.push({ kind: 'plugins', key: profile + '/*', note: bPkg === null ? '目标机独有 profile，保留' : '新增 profile，带过来' })
      continue
    }
    const d = diffPluginDecls(bPkg, tPkg)
    for (const n of d.onlyInSource) {
      auto.push({ kind: 'plugins', key: profile + '/' + n, note: '源机新增，带过来' })
    }
    for (const n of d.onlyInTarget) {
      conflicts.push({
        kind: 'plugins',
        key: profile + '/' + n,
        label: n,
        where: 'profile ' + profile,
        targetValue: '目标机已安装',
        sourceValue: '源机没有（落地后将从声明中消失）',
        options: [KEEP_TARGET, TAKE_SOURCE],
        resolution: null,
      })
    }
    for (const x of d.differ) {
      conflicts.push({
        kind: 'plugins',
        key: profile + '/' + x.name,
        label: x.name,
        where: 'profile ' + profile,
        targetValue: x.target,
        sourceValue: x.source,
        options: [KEEP_TARGET, TAKE_SOURCE],
        resolution: null,
      })
    }
  }

  // ── ② 工作区记录（按 id 比；path 不比）──────────────────────────────────
  // path 不参与比较是刻意的：源机路径会被映射改写到目标机的落位，两边原始值必然不同，
  // 拿 path 比会把每一条都误报成冲突。真正会丢的是「目标机有、源机没有」的 id。
  const bWs = readJson(path.join(bundleDir, 'state', 'storages', 'workspace.json'))
  const tWs = readJson(path.join(dshHome, 'storages', 'workspace.json'))
  const bIds = new Set(readWorkspacePaths(bWs || {}).map((w) => w.id))
  const tIds = new Set(readWorkspacePaths(tWs || {}).map((w) => w.id))
  for (const id of [...tIds].sort()) {
    if (bIds.has(id)) continue
    const rec = (tWs && tWs.tables && tWs.tables.workspaces && tWs.tables.workspaces[id]) || null
    conflicts.push({
      kind: 'workspaces',
      key: id,
      label: (rec && typeof rec.title === 'string' && rec.title) || id,
      where: 'storages/workspace.json',
      targetValue: (rec && typeof rec.path === 'string') ? rec.path : '(无路径)',
      sourceValue: '源机没有（落地后该工作区记录消失）',
      options: [KEEP_TARGET, TAKE_SOURCE],
      resolution: null,
    })
  }
  for (const id of [...bIds].sort()) {
    if (!tIds.has(id)) auto.push({ kind: 'workspaces', key: id, note: '源机新增，带过来' })
  }

  // ── ③ settings.yaml ──────────────────────────────────────────────────────
  // 不做三方合并：YAML 的语义（锚点、注释、键序）不可能在不知 schema 的情况下并对，
  // 硬并出来的东西比整份覆盖更危险。所以这里只判「一不一样」，让用户二选一。
  const bPlain = path.join(bundleDir, 'settings.yaml')
  const bEnc = path.join(bundleDir, 'settings.enc')
  const tSettings = path.join(dshHome, 'settings.yaml')
  const settings = { comparable: false, same: false, reason: '' }
  if (fs.existsSync(bEnc) && !fs.existsSync(bPlain)) {
    settings.reason = 'bundle 里的 settings 是加密的，无法与目标机明文比对'
  } else if (!fs.existsSync(bPlain)) {
    settings.reason = 'bundle 不含 settings.yaml，目标机的不会被改动'
  } else if (!fs.existsSync(tSettings)) {
    // 目标机还没有 settings.yaml —— 谈不上「盖掉什么」，直接落地即可。
    // 这里必须留在外面：comparable=true 而又没东西可比，会被当成「两边不同」而误报成冲突，
    // 于是**第一次**迁移开着 merge 也会被拦下来（实测踩到）。
    settings.comparable = false
    settings.reason = '目标机还没有 settings.yaml，直接落地'
  } else {
    const hb = sha256File(bPlain)
    const ht = sha256File(tSettings)
    settings.comparable = true
    settings.same = hb !== null && hb === ht
    settings.reason = settings.same ? '两边一致' : '两边内容不同'
  }
  if (settings.comparable && !settings.same) {
    conflicts.push({
      kind: 'settings',
      key: 'settings.yaml',
      label: 'settings.yaml',
      where: '$DSH_HOME',
      targetValue: '目标机当前设置',
      sourceValue: '源机设置（落地后目标机的被取代）',
      options: ['target', 'source'],
      resolution: null,
    })
  }

  // ── ④ 会话：只给一条汇总 ────────────────────────────────────────────────
  // 会话可以有几百个，逐条列等于没列。而它们的分歧性质高度同构（同一个会话两边
  // 日志份数不同），所以汇总成一条、让用户给一个统一策略。
  // 匹配用会话 id（目录名）而不是分组目录名 —— 分组名是 cwd 的编码，迁完就变了。
  const sessions = { comparable: false, count: 0, onlyInSource: 0, onlyInTarget: 0, reason: '' }
  const bState = path.join(bundleDir, 'state')
  if (!fs.existsSync(path.join(bundleDir, 'state', 'sessions'))) {
    sessions.reason = 'bundle 不含会话'
  } else {
    const bs = await scanSessions(bState).catch(() => null)
    const ts = await scanSessions(dshHome).catch(() => null)
    if (bs === null || ts === null) {
      sessions.reason = '会话扫描失败，按 skip 处理'
    } else {
      const bById = new Map(bs.sessions.map((s) => [s.dirName, s]))
      const tById = new Map(ts.sessions.map((s) => [s.dirName, s]))
      let diff = 0
      let onlySource = 0
      for (const [id, b] of bById) {
        const t = tById.get(id)
        if (t === undefined) { onlySource += 1; continue }
        const bLogs = new Set(b.logs.map((l) => l.name))
        const tLogs = new Set(t.logs.map((l) => l.name))
        const same = bLogs.size === tLogs.size && [...bLogs].every((n) => tLogs.has(n))
        if (!same) diff += 1
      }
      sessions.comparable = true
      sessions.count = diff
      sessions.onlyInSource = onlySource
      sessions.onlyInTarget = [...tById.keys()].filter((id) => !bById.has(id)).length
      sessions.reason = diff === 0
        ? '两边会话内容一致（或目标机还没有会话）'
        : diff + ' 个会话两边都有但日志份数不同'
    }
  }
  if (sessions.comparable && sessions.count > 0) {
    conflicts.push({
      kind: 'sessions',
      key: 'sessions',
      label: '会话（' + sessions.count + ' 个两边不一致）',
      where: 'state/sessions',
      targetValue: '目标机现有 ' + sessions.count + ' 个会话的日志',
      sourceValue: '源机版本的日志',
      options: SESSION_POLICIES,
      resolution: null,
      count: sessions.count,
    })
  }

  return { conflicts, auto, sessions, settings, profiles: names }
}

/**
 * 把用户给的 resolutions 套到冲突清单上，返回**仍未决**的项。
 *
 * 决议缺失不算「默认通过」：这条是 merge 模式的全部意义所在 ——
 * 宁可停下来让人看一眼，也不替他猜。
 *
 * @param {object[]} conflicts
 * @param {object} resolutions - { plugins:{key:choice}, workspaces:{key:choice}, settings:choice, sessions:choice }
 * @returns {object[]} 未决项（空数组 = 全部已决）
 */
export function unresolvedOf(conflicts, resolutions) {
  const res = resolutions && typeof resolutions === 'object' ? resolutions : {}
  const pending = []
  for (const c of conflicts) {
    if (c.kind === 'settings') {
      const v = typeof res.settings === 'string' ? res.settings : ''
      if (v !== 'target' && v !== 'source') { pending.push(c); continue }
      c.resolution = v
      continue
    }
    if (c.kind === 'sessions') {
      const v = typeof res.sessions === 'string' ? res.sessions : ''
      if (!SESSION_POLICIES.includes(v)) { pending.push(c); continue }
      c.resolution = v
      continue
    }
    const table = c.kind === 'plugins' ? res.plugins : res.workspaces
    const v = table && typeof table === 'object' ? table[c.key] : ''
    if (v !== KEEP_TARGET && v !== TAKE_SOURCE) { pending.push(c); continue }
    c.resolution = v
  }
  return pending
}

/**
 * 按决议合并插件声明，返回**目标机那份**该写成什么。
 *
 * 基准是 bundle 那份（迁移的本意就是跟随源机），再按决议把目标机独有的加回来 /
 * 把有分歧的改回目标机的值。
 */
export function mergePluginDecls({ bundlePkg, targetPkg, profile, plugins }) {
  const b = pluginDeclsOf(bundlePkg)
  const t = pluginDeclsOf(targetPkg)
  const pick = (name) => {
    const v = plugins ? plugins[profile + '/' + name] : ''
    return v === KEEP_TARGET || v === TAKE_SOURCE ? v : null
  }
  const out = JSON.parse(JSON.stringify(bundlePkg || {}))
  const deps = {}
  // 先放源机的，再按决议覆盖/补回
  for (const [n, spec] of Object.entries(b.deps)) {
    const choice = pick(n)
    deps[n] = (choice === KEEP_TARGET && t.deps[n] !== undefined) ? t.deps[n] : spec
  }
  for (const [n, spec] of Object.entries(t.deps)) {
    if (deps[n] !== undefined) continue
    // 目标机独有：keep-target 才保留，take-source 就让它消失
    if (pick(n) === KEEP_TARGET) deps[n] = spec
  }
  // 键序稳定，免得每次落地都产生无意义的 diff
  const sorted = {}
  for (const n of Object.keys(deps).sort()) sorted[n] = deps[n]
  if (Object.keys(sorted).length > 0) out.dependencies = sorted

  const bSet = new Set(b.bundles)
  const tSet = new Set(t.bundles)
  const bundles = [...new Set([...b.bundles, ...t.bundles])]
    .filter((n) => {
      if (bSet.has(n)) return true
      return pick(n) === KEEP_TARGET
    })
    .sort()
  if (bundles.length > 0) {
    out.dsh = out.dsh || {}
    out.dsh.profile = out.dsh.profile || {}
    out.dsh.profile.bundles = bundles
  }
  return out
}

/**
 * 按决议合并工作区记录，返回目标机该写成什么（合并后再交给 remapWorkspacePaths 改写路径）。
 */
export function mergeWorkspaceRecords({ bundleWs, targetWs, workspaces }) {
  const out = JSON.parse(JSON.stringify(bundleWs || {}))
  const tTable = (targetWs && targetWs.tables && targetWs.tables.workspaces) || null
  if (tTable === null) return out
  out.tables = out.tables || {}
  out.tables.workspaces = out.tables.workspaces || {}
  for (const [id, rec] of Object.entries(tTable)) {
    if (out.tables.workspaces[id] !== undefined) continue
    const v = workspaces ? workspaces[id] : ''
    if (v === KEEP_TARGET) out.tables.workspaces[id] = JSON.parse(JSON.stringify(rec))
  }
  return out
}
