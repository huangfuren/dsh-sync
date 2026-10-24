// test/merge.test.js — 多次交接：第二次迁移到一台**已经用过**的机器上。
//
// 第一次迁移的目标机是空的，怎么写都无所谓；第二次不是。这里钉死的是两件事：
//   ① 有分歧时必须停在写盘之前，一个字节都不许动（决议缺失没有默认值）；
//   ② 给了决议之后，目标机独有的东西按 keep-target / take-source 各自落到该落的地方。
// 全部使用合成数据（自建 zstd 多帧文件），不读取真实 $DSH_HOME，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { encodeSessionDir, readWorkspacePaths } from '../lib/session-migrate.js'
import { readSessionHeader, zstdAvailable } from '../lib/zstd-frame.js'
import { exportBundle } from '../lib/bundle.js'
import { applyBundle } from '../lib/apply-engine.js'
import {
  diffPluginDecls, mergePluginDecls, mergeWorkspaceRecords, unresolvedOf, planMerge, SESSION_POLICIES,
} from '../lib/merge-plan.js'

const nativeOf = (p) => (process.platform === 'win32' ? String(p).split('/').join(path.sep) : p)
const HAS_ZSTD = zstdAvailable()

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-merge-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writeSessionFile(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))]
  for (const e of events) frames.push(zlib.zstdCompressSync(Buffer.from(e + '\n', 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
}

function headerOf(cwd, id) {
  return { type: 'session', version: 0, id, createdAt: 1700000000000, cwd, delegationDepth: 0, agentPreset: 'standard' }
}

function mkSession(dshHome, cwd, id, events = ['{"seq":1}']) {
  const dir = path.join(dshHome, 'sessions', encodeSessionDir(cwd), id)
  writeSessionFile(path.join(dir, 'session.jsonl.zstd'), headerOf(cwd, id), events)
  return dir
}

function mkWorkspaceJson(dshHome, entries) {
  const table = {}
  for (const [id, p] of entries) table[id] = { path: p, title: path.basename(p), sessionIds: [] }
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: Object.keys(table) },
    tables: { workspaces: table },
  }
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2))
  return doc
}

function readWsIds(dshHome) {
  const p = path.join(dshHome, 'storages', 'workspace.json')
  if (!fs.existsSync(p)) return []
  return readWorkspacePaths(JSON.parse(fs.readFileSync(p, 'utf8'))).map((w) => w.id).sort()
}

function mkProfile(dshHome, name, deps, bundles) {
  const dir = path.join(dshHome, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'profile-' + name,
    version: '1.0.0',
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles } },
  }, null, 2))
}

function readProfile(dshHome, name) {
  return JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', name, 'package.json'), 'utf8'))
}

function depNames(dshHome, name) {
  return Object.keys(readProfile(dshHome, name).dependencies || {}).sort()
}

// ══ 纯函数：插件声明怎么比、怎么并 ══════════════════════════════════════════

test('diffPluginDecls 分出三类：目标机独有 / 源机独有 / 两边都有但不一样', () => {
  const bundle = { dependencies: { A: '^1.0.0', C: '^3.0.0', D: '^4.0.0' }, dsh: { profile: { bundles: ['A', 'C', 'D'] } } }
  const target = { dependencies: { A: '^1.0.0', B: '^2.0.0', D: '^4.5.0' }, dsh: { profile: { bundles: ['A', 'B', 'D'] } } }
  const d = diffPluginDecls(bundle, target)
  assert.deepEqual(d.onlyInTarget, ['B'], 'B 是目标机自己装的')
  assert.deepEqual(d.onlyInSource, ['C'], 'C 是源机新装的')
  assert.deepEqual(d.differ.map((x) => x.name), ['D'], 'D 两边版本不同')
  assert.equal(d.differ[0].target, '^4.5.0')
  assert.equal(d.differ[0].source, '^4.0.0')
})

test('mergePluginDecls：keep-target 保住目标机独有的，take-source 让它消失', () => {
  const bundle = { dependencies: { A: '^1.0.0', C: '^3.0.0' }, dsh: { profile: { bundles: ['A', 'C'] } } }
  const target = { dependencies: { A: '^1.0.0', B: '^2.0.0' }, dsh: { profile: { bundles: ['A', 'B'] } } }

  const keep = mergePluginDecls({
    bundlePkg: bundle, targetPkg: target, profile: 'desktop',
    plugins: { 'desktop/B': 'keep-target' },
  })
  assert.deepEqual(Object.keys(keep.dependencies).sort(), ['A', 'B', 'C'], 'A 跟随、B 保留、C 带过来')
  assert.deepEqual(keep.dsh.profile.bundles, ['A', 'B', 'C'])

  const take = mergePluginDecls({
    bundlePkg: bundle, targetPkg: target, profile: 'desktop',
    plugins: { 'desktop/B': 'take-source' },
  })
  assert.deepEqual(Object.keys(take.dependencies).sort(), ['A', 'C'], 'B 从声明里消失')
  assert.deepEqual(take.dsh.profile.bundles, ['A', 'C'])

  // 版本不同的那一项：决议直接决定用哪边的 spec
  const t2 = { dependencies: { A: '^1.0.0', D: '^4.5.0' }, dsh: { profile: { bundles: ['A', 'D'] } } }
  const b2 = { dependencies: { A: '^1.0.0', D: '^4.0.0' }, dsh: { profile: { bundles: ['A', 'D'] } } }
  assert.equal(mergePluginDecls({ bundlePkg: b2, targetPkg: t2, profile: 'p', plugins: { 'p/D': 'keep-target' } }).dependencies.D, '^4.5.0')
  assert.equal(mergePluginDecls({ bundlePkg: b2, targetPkg: t2, profile: 'p', plugins: { 'p/D': 'take-source' } }).dependencies.D, '^4.0.0')
})

test('mergeWorkspaceRecords：目标机独有的记录按决议留或走', () => {
  const bundleWs = { tables: { workspaces: { w1: { path: 'E:/code/a', title: 'a' } } } }
  const targetWs = { tables: { workspaces: { w1: { path: 'E:/code/a', title: 'a' }, wNew: { path: 'E:/code/new', title: 'new' } } } }

  const keep = mergeWorkspaceRecords({ bundleWs, targetWs, workspaces: { wNew: 'keep-target' } })
  assert.deepEqual(Object.keys(keep.tables.workspaces).sort(), ['w1', 'wNew'])
  assert.equal(keep.tables.workspaces.wNew.path, 'E:/code/new')

  const take = mergeWorkspaceRecords({ bundleWs, targetWs, workspaces: { wNew: 'take-source' } })
  assert.deepEqual(Object.keys(take.tables.workspaces), ['w1'])

  // 源机那份不能被并集改坏：两边都有的记录以 bundle 为准
  assert.equal(keep.tables.workspaces.w1.path, 'E:/code/a')
})

test('unresolvedOf：没决议的一律算未决，没有默认值；非法取值同样未决', () => {
  const conflicts = [
    { kind: 'plugins', key: 'desktop/B', options: ['keep-target', 'take-source'], resolution: null },
    { kind: 'settings', key: 'settings.yaml', options: ['target', 'source'], resolution: null },
    { kind: 'sessions', key: 'sessions', options: SESSION_POLICIES, resolution: null },
  ]
  assert.equal(unresolvedOf(conflicts, null).length, 3, '什么都不给 → 三项全未决')
  assert.equal(unresolvedOf(conflicts, {}).length, 3)

  const partial = unresolvedOf(conflicts, { plugins: { 'desktop/B': 'keep-target' } })
  assert.equal(partial.length, 2, '只给了插件 → settings 与 sessions 仍未决')

  const all = unresolvedOf(conflicts, {
    plugins: { 'desktop/B': 'keep-target' },
    settings: 'target',
    sessions: 'append-missing',
  })
  assert.equal(all.length, 0)
  assert.equal(conflicts[0].resolution, 'keep-target')
  assert.equal(conflicts[1].resolution, 'target')
  assert.equal(conflicts[2].resolution, 'append-missing')

  // 瞎写一个策略不算决议（前面两项给了合法值，只剩 sessions 未决）
  assert.equal(unresolvedOf(conflicts, {
    plugins: { 'desktop/B': 'keep-target' },
    settings: 'target',
    sessions: 'merge-everything',
  }).length, 1)
})

// ══ 端到端：第二次迁移 ══════════════════════════════════════════════════════

/**
 * 搭一个「第一次已迁完、目标机又被用了一阵」的局面。
 * @returns {{root:string, dst:string, b2:string, mappings:object[], before:object}}
 */
async function mkSecondMigration(tag) {
  const root = tmpDir(tag)
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const b1 = path.join(root, 'b1')
  const b2 = path.join(root, 'b2')
  fs.mkdirSync(dst, { recursive: true })
  const mappings = [{ from: 'D:/deepseek', to: 'E:/moved' }]

  // 源机初始状态：两个会话、两个工作区、插件 A
  mkSession(src, 'D:\\deepseek\\proj-a', 's1')
  mkSession(src, 'D:\\deepseek\\proj-b', 's2')
  mkWorkspaceJson(src, [['w1', 'D:/deepseek/proj-a'], ['w2', 'D:/deepseek/proj-b']])
  mkProfile(src, 'desktop', { A: '^1.0.0' }, ['A'])
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'theme: dark\nsource: first\n')

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: b1, includeState: true, onLog: () => {} })
  const first = await applyBundle({ bundleDir: b1, dshHome: dst, mappings, onLog: () => {} })
  assert.equal(first.ok, true, JSON.stringify(first.errors))

  // ── 目标机被用了一阵 ──
  // 新装插件 B、新开一个工作区、改了设置、给 s1 追加了一版日志
  const pkg = readProfile(dst, 'desktop')
  pkg.dependencies.B = '^2.0.0'
  pkg.dsh.profile.bundles = ['A', 'B']
  fs.writeFileSync(path.join(dst, 'profiles', 'desktop', 'package.json'), JSON.stringify(pkg, null, 2))

  const ws = JSON.parse(fs.readFileSync(path.join(dst, 'storages', 'workspace.json'), 'utf8'))
  ws.tables.workspaces.wNew = { path: 'E:/moved/proj-new', title: 'proj-new', sessionIds: [] }
  ws.global.workspaceIds.push('wNew')
  fs.writeFileSync(path.join(dst, 'storages', 'workspace.json'), JSON.stringify(ws, null, 2))

  fs.writeFileSync(path.join(dst, 'settings.yaml'), 'theme: light\ntarget: mine\n')

  const s1Dir = path.join(dst, 'sessions', encodeSessionDir('E:/moved/proj-a'), 's1')
  const v2 = path.join(s1Dir, 'session.v2.jsonl.zstd')
  writeSessionFile(v2, headerOf('E:/moved/proj-a', 's1'), ['{"seq":9}'])

  const before = {
    pkg: JSON.stringify(readProfile(dst, 'desktop')),
    ws: fs.readFileSync(path.join(dst, 'storages', 'workspace.json'), 'utf8'),
    settings: fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8'),
    v2Bytes: fs.readFileSync(v2).length,
  }

  // ── 源机也继续用了：新装插件 C、新开会话 s3、给 s1 加了另一版日志 ──
  const srcPkg = readProfile(src, 'desktop')
  srcPkg.dependencies.C = '^3.0.0'
  srcPkg.dsh.profile.bundles = ['A', 'C']
  fs.writeFileSync(path.join(src, 'profiles', 'desktop', 'package.json'), JSON.stringify(srcPkg, null, 2))
  mkSession(src, 'D:\\deepseek\\proj-c', 's3')
  const srcS1 = path.join(src, 'sessions', encodeSessionDir('D:\\deepseek\\proj-a'), 's1')
  writeSessionFile(path.join(srcS1, 'session.v3.jsonl.zstd'), headerOf('D:\\deepseek\\proj-a', 's1'), ['{"seq":7}'])

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: b2, includeState: true, onLog: () => {} })
  return { root, src, dst, b1, b2, mappings, before, s1Dir }
}

test('第二次迁移：merge=true 且未决议 → 停在写盘之前，目标机一个字节都没动', { skip: !HAS_ZSTD }, async () => {
  const { dst, b2, mappings, before } = await mkSecondMigration('stop')

  const r = await applyBundle({ bundleDir: b2, dshHome: dst, mappings, merge: true, onLog: () => {} })
  assert.equal(r.ok, false, '有未决冲突时必须判失败')
  assert.ok(r.merge, '报告要带 merge 段')
  assert.ok(r.merge.pending.length >= 3, '插件 B / 工作区 wNew / settings 都该是待定，实际 ' + JSON.stringify(r.merge.pending))
  assert.ok(r.errors.some((e) => e.includes('未决议')), JSON.stringify(r.errors))

  // 这一条是这个测试的全部意义：停下来的时候目标机必须还是原样
  assert.equal(JSON.stringify(readProfile(dst, 'desktop')), before.pkg, 'package.json 不许被改')
  assert.equal(fs.readFileSync(path.join(dst, 'storages', 'workspace.json'), 'utf8'), before.ws, 'workspace.json 不许被改')
  assert.equal(fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8'), before.settings, 'settings.yaml 不许被改')
  assert.equal(fs.existsSync(path.join(dst, 'sessions', encodeSessionDir('E:/moved/proj-c'), 's3')), false, '源机新会话也不许提前落地')
  assert.ok(r.nextSteps.some((s) => s.includes('resolutions')), '停下就得说清怎么继续')
})

test('第二次迁移：全部 keep-target → 目标机独有的都在，源机新增的也来了', { skip: !HAS_ZSTD }, async () => {
  const { dst, b2, mappings, s1Dir } = await mkSecondMigration('keep')

  const r = await applyBundle({
    bundleDir: b2,
    dshHome: dst,
    mappings,
    merge: true,
    resolutions: {
      plugins: { 'desktop/B': 'keep-target' },
      workspaces: { wNew: 'keep-target' },
      settings: 'target',
      sessions: 'append-missing',
    },
    onLog: () => {},
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))

  assert.deepEqual(depNames(dst, 'desktop'), ['A', 'B', 'C'], 'A 跟随、B 保留、C 带过来')
  assert.deepEqual(readWsIds(dst), ['w1', 'w2', 'wNew'], '目标机新开的工作区保住了')
  assert.equal(fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8'), 'theme: light\ntarget: mine\n', 'settings 按决议保留目标机的')
  assert.equal(fs.existsSync(path.join(dst, 'sessions', encodeSessionDir('E:/moved/proj-c'), 's3')), true, '源机新会话补进来')
  // append-missing：源机的 v3 补进来，目标机自己的 v2 原样还在
  assert.equal(fs.existsSync(path.join(s1Dir, 'session.v3.jsonl.zstd')), true)
  assert.equal(fs.existsSync(path.join(s1Dir, 'session.v2.jsonl.zstd')), true)
})

test('第二次迁移：全部 take-source → 目标机独有的按源机快照走', { skip: !HAS_ZSTD }, async () => {
  const { dst, b2, mappings } = await mkSecondMigration('take')

  const r = await applyBundle({
    bundleDir: b2,
    dshHome: dst,
    mappings,
    merge: true,
    resolutions: {
      plugins: { 'desktop/B': 'take-source' },
      workspaces: { wNew: 'take-source' },
      settings: 'source',
      sessions: 'skip',
    },
    onLog: () => {},
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))

  assert.deepEqual(depNames(dst, 'desktop'), ['A', 'C'], 'B 从声明里消失')
  assert.deepEqual(readWsIds(dst), ['w1', 'w2'], 'wNew 记录消失')
  assert.equal(fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8').includes('source: first'), true, 'settings 用源机那份')
})

test('会话策略 prefer-source 会覆盖目标机的版本，skip 则一个不动', { skip: !HAS_ZSTD }, async () => {
  const a = await mkSecondMigration('pref-src')
  const skipR = await applyBundle({
    bundleDir: a.b2, dshHome: a.dst, mappings: a.mappings, merge: true,
    resolutions: {
      plugins: { 'desktop/B': 'keep-target' },
      workspaces: { wNew: 'keep-target' },
      settings: 'target',
      sessions: 'skip',
    },
    onLog: () => {},
  })
  assert.equal(skipR.ok, true, JSON.stringify(skipR.errors))
  assert.equal(fs.existsSync(path.join(a.s1Dir, 'session.v3.jsonl.zstd')), false, 'skip 不补')
  assert.equal(fs.existsSync(path.join(a.s1Dir, 'session.v2.jsonl.zstd')), true, '目标机自己的版本还在')

  // prefer-source 会连目标机那份一起换掉（这是它唯一的用途：就是要以源机为准）
  const b = await mkSecondMigration('pref-src2')
  const srcR = await applyBundle({
    bundleDir: b.b2, dshHome: b.dst, mappings: b.mappings, merge: true,
    resolutions: {
      plugins: { 'desktop/B': 'keep-target' },
      workspaces: { wNew: 'keep-target' },
      settings: 'target',
      sessions: 'prefer-source',
    },
    onLog: () => {},
  })
  assert.equal(srcR.ok, true, JSON.stringify(srcR.errors))
  assert.equal(fs.existsSync(path.join(b.s1Dir, 'session.v3.jsonl.zstd')), true)
  // 改写管线随后会把补进来 / 覆盖过来的日志 header 改成目标机路径
  const read = readSessionHeader(path.join(b.s1Dir, 'session.v3.jsonl.zstd'))
  assert.equal(read.ok && read.header.cwd, nativeOf('E:/moved/proj-a'))
})

test('merge=false 时行为与旧版一致：直接覆盖，不出冲突清单', { skip: !HAS_ZSTD }, async () => {
  const { dst, b2, mappings } = await mkSecondMigration('plain')

  const r = await applyBundle({ bundleDir: b2, dshHome: dst, mappings, onLog: () => {} })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.merge, undefined, '不开 merge 就不该有 merge 段')
  // 旧行为：B 消失、wNew 消失、settings 被源机那份取代
  assert.deepEqual(depNames(dst, 'desktop'), ['A', 'C'])
  assert.deepEqual(readWsIds(dst), ['w1', 'w2'])
  assert.equal(fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8').includes('source: first'), true)
})

test('planMerge 是纯读：算完之后目标机没有任何变化', { skip: !HAS_ZSTD }, async () => {
  const { dst, b2, before } = await mkSecondMigration('readonly')
  const snap = JSON.stringify({
    pkg: readProfile(dst, 'desktop'),
    ws: JSON.parse(fs.readFileSync(path.join(dst, 'storages', 'workspace.json'), 'utf8')),
    settings: fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8'),
  })
  const plan = await planMerge({ bundleDir: b2, dshHome: dst })
  assert.ok(Array.isArray(plan.conflicts))
  assert.ok(plan.conflicts.some((c) => c.kind === 'plugins' && c.key === 'desktop/B'))
  assert.ok(plan.conflicts.some((c) => c.kind === 'workspaces' && c.key === 'wNew'))
  assert.ok(plan.conflicts.some((c) => c.kind === 'settings'))
  assert.equal(JSON.stringify({
    pkg: readProfile(dst, 'desktop'),
    ws: JSON.parse(fs.readFileSync(path.join(dst, 'storages', 'workspace.json'), 'utf8')),
    settings: fs.readFileSync(path.join(dst, 'settings.yaml'), 'utf8'),
  }), snap, 'planMerge 不该写任何东西')
  assert.equal(before.pkg, before.pkg) // 夹具自检：before 是快照，不参与断言
})

test('LAN 直传也能带上 merge：两条发起路径的参数都通', async () => {
  // 卡片与 lan_pull 都走 lib/migrate.js → pull-runner → client → applyBundle。
  // 参数少传一层，第二次迁移走局域网就用不上 merge，所以在这里钉住两端都在。
  const { defineLanPullTool } = await import('../lib/tools/lan-pull.js')
  const pull = defineLanPullTool(() => ({}))
  assert.equal(pull.name, 'dshsync_lan_pull')
  assert.ok(pull.parameters.properties.merge, 'lan_pull 要有 merge')
  assert.equal(pull.parameters.properties.resolutions.additionalProperties, true,
    'resolutions 不声明 additionalProperties 会被宿主 schema 校验拒掉（实测 THROW）')

  const { defineApplyTool } = await import('../lib/tools/apply.js')
  const apply = defineApplyTool(() => ({}))
  assert.ok(apply.parameters.properties.merge, 'apply 要有 merge')
  assert.equal(apply.parameters.properties.resolutions.additionalProperties, true)
})

test('第一次迁移（目标机是空的）开 merge 也不会被拦', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('first')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  fs.mkdirSync(dst, { recursive: true })
  mkSession(src, 'D:\\deepseek\\proj-a', 's1')
  mkWorkspaceJson(src, [['w1', 'D:/deepseek/proj-a']])
  mkProfile(src, 'desktop', { A: '^1.0.0' }, ['A'])
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'theme: dark\n')
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  const r = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/moved' }], merge: true, onLog: () => {},
  })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(depNames(dst, 'desktop'), ['A'])
  assert.deepEqual(readWsIds(dst), ['w1'])
})
