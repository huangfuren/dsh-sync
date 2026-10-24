// test/deps.test.js — 依赖重装（0.16.0）：运行时解析、一键脚本、自动安装（执行器可注入）。
// 全部合成路径，不真跑 pnpm：自动安装的成败语义用注入 runner 模拟。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installDepsNow, missingDepsOf, resolveRuntimeTools, writeInstallScript } from '../lib/deps-install.js'
import { applyBundle } from '../lib/apply-engine.js'
import { exportBundle } from '../lib/bundle.js'
import { encodeSessionDir } from '../lib/session-migrate.js'
import { zstdAvailable } from '../lib/zstd-frame.js'

const HAS_ZSTD = zstdAvailable()

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-deps-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

test('resolveRuntimeTools：从桌面版布局推导 node/pnpm；pnpm 缺失时不编造', () => {
  const root = tmpDir('tools')
  const nodePath = path.join(root, 'dependencies', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const pnpmFile = path.join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
  fs.mkdirSync(path.dirname(nodePath), { recursive: true })
  fs.writeFileSync(nodePath, '')
  fs.mkdirSync(path.dirname(pnpmFile), { recursive: true })
  fs.writeFileSync(pnpmFile, '')
  const r1 = resolveRuntimeTools({ execPath: nodePath })
  assert.equal(r1.nodePath, nodePath)
  assert.equal(r1.pnpmFile, pnpmFile)
  assert.equal(r1.source, 'host-runtime')

  // 只有 node 没有 pnpm：如实返回 null，不猜
  const emptyRoot = tmpDir('tools-empty')
  const nodeOnly = path.join(emptyRoot, 'dependencies', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  fs.mkdirSync(path.dirname(nodeOnly), { recursive: true })
  fs.writeFileSync(nodeOnly, '')
  const r2 = resolveRuntimeTools({ execPath: nodeOnly })
  assert.equal(r2.nodePath, nodeOnly)
  assert.equal(r2.pnpmFile, null)
  assert.equal(r2.source, 'pnpm-not-found')
})

test('missingDepsOf：只点名 node_modules 里真缺的包', () => {
  const prof = tmpDir('prof')
  fs.mkdirSync(path.join(prof, 'node_modules', '@scope', 'have'), { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ dependencies: { '@scope/have': '^1', 'not-installed': '^2', 'also-missing': '^3' } }))
  fs.writeFileSync(path.join(prof, 'node_modules', '@scope', 'have', 'package.json'), '{}')
  assert.deepEqual(missingDepsOf(prof).sort(), ['also-missing', 'not-installed'])
})

test('writeInstallScript：生成 ps1/sh，含 node、pnpm 与 profile 目录；无缺失返回 null', () => {
  const home = tmpDir('script-home')
  const prof = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(prof, { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ dependencies: { 'pkg-a': '^1' } }))
  const nodePath = '/runtime/node/node'
  const pnpmFile = '/runtime/pnpm/bin/pnpm.cjs'

  const r1 = writeInstallScript(home, { profiles: [{ name: 'desktop', dir: prof }], nodePath, pnpmFile })
  assert.ok(r1, '有缺失就该生成脚本')
  assert.ok(fs.existsSync(r1.ps1) && fs.existsSync(r1.sh))
  const ps1 = fs.readFileSync(r1.ps1, 'utf8')
  const sh = fs.readFileSync(r1.sh, 'utf8')
  // sh 里的路径按 JSON 字符串规则转义（反斜杠成对），ps1 原样
  assert.ok(ps1.includes(prof), 'ps1 要 cd 到 profile 目录')
  assert.ok(sh.includes(JSON.stringify(prof).slice(1, -1)), 'sh 要 cd 到 profile 目录（转义形态）')
  for (const text of [ps1, sh]) {
    assert.ok(text.includes(nodePath) && text.includes(pnpmFile), '脚本要写死 node 与 pnpm 的绝对路径')
    assert.ok(text.includes('install'), '要执行 pnpm install')
  }
  assert.deepEqual(r1.profiles, ['desktop'])

  // 依赖装齐后：不生成
  fs.mkdirSync(path.join(prof, 'node_modules', 'pkg-a'), { recursive: true })
  fs.writeFileSync(path.join(prof, 'node_modules', 'pkg-a', 'package.json'), '{}')
  const r2 = writeInstallScript(home, { profiles: [{ name: 'desktop', dir: prof }], nodePath, pnpmFile })
  assert.equal(r2, null, '没有缺失依赖就不该生成脚本')
})

test('installDepsNow：注入 runner 逐个执行，成败如实记账', async () => {
  const calls = []
  const okRunner = async ({ cwd }) => { calls.push(cwd); return { ok: true } }
  const targets = [
    { name: 'a', dir: '/tmp/a' },
    { name: 'b', dir: '/tmp/b' },
  ]
  const r1 = await installDepsNow({ targets, nodePath: 'node', pnpmFile: 'pnpm.cjs', runner: okRunner })
  assert.deepEqual(r1.map((x) => x.profile), ['a', 'b'])
  assert.ok(r1.every((x) => x.ok))
  assert.equal(calls.length, 2)

  const badRunner = async () => ({ ok: false, error: 'EBUSY' })
  const r2 = await installDepsNow({ targets, nodePath: 'node', pnpmFile: 'pnpm.cjs', runner: badRunner })
  assert.ok(r2.every((x) => !x.ok && /EBUSY/.test(x.error)), '失败要带上原因，不掩盖')
})

test('apply：缺依赖 → 默认尝试自动重装，成功则必办改写、脚本兜底生成', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('auto-install')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  fs.mkdirSync(path.join(src, 'sessions', encodeSessionDir('D:\\deepseek\\proj'), 's1'), { recursive: true })
  fs.writeFileSync(path.join(src, 'sessions', encodeSessionDir('D:\\deepseek\\proj'), 's1', 'session.jsonl.zstd'), 'x')
  const prof = path.join(src, 'profiles', 'desktop')
  fs.mkdirSync(prof, { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { '@deepseek-ai/schemastery': '^3' }, dsh: { profile: { bundles: [] } } }))
  fs.mkdirSync(dst, { recursive: true })
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  const installed = []
  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/code' }], onLog: () => {},
    installDeps: true,
    _depsTools: { nodePath: '/fake/node', pnpmFile: '/fake/pnpm.cjs', source: 'host-runtime' },
    _depsRunner: async ({ cwd }) => { installed.push(cwd); return { ok: true } },
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(applied.depsInstall.attempted, true, '默认应尝试自动重装')
  assert.equal(installed.length, 1, '注入 runner 应被调用一次')
  assert.ok(installed[0].endsWith(path.join('profiles', 'desktop')), '安装 cwd 必须是落地后的 profile 目录')
  const dep = applied.actionRequired.find((a) => a.startsWith('[依赖]'))
  assert.ok(dep, JSON.stringify(applied.actionRequired))
  assert.match(dep, /已自动重装/, '成功时必办要说清已经装好')
  assert.ok(applied.depsInstall.script && fs.existsSync(applied.depsInstall.script), '脚本兜底总是生成')
  fs.rmSync(root, { recursive: true, force: true })
})

test('apply：自动重装失败 → 必办保留脚本路径与原因', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('auto-fail')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  fs.mkdirSync(path.join(src, 'sessions', encodeSessionDir('D:\\x'), 's1'), { recursive: true })
  fs.writeFileSync(path.join(src, 'sessions', encodeSessionDir('D:\\x'), 's1', 'session.jsonl.zstd'), 'x')
  const prof = path.join(src, 'profiles', 'desktop')
  fs.mkdirSync(prof, { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { 'pkg-a': '^1' }, dsh: { profile: { bundles: [] } } }))
  fs.mkdirSync(dst, { recursive: true })
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/code' }], onLog: () => {},
    installDeps: true,
    _depsTools: { nodePath: '/fake/node', pnpmFile: '/fake/pnpm.cjs', source: 'host-runtime' },
    _depsRunner: async () => ({ ok: false, error: 'exit 1: EBUSY: resource busy' }),
  })
  const dep = applied.actionRequired.find((a) => a.startsWith('[依赖]'))
  assert.ok(dep, JSON.stringify(applied.actionRequired))
  assert.match(dep, /自动重装失败.*EBUSY/s, '失败原因必须出现在必办里')
  assert.match(dep, /install-deps\.ps1/, '兜底脚本路径必须在必办里')
  assert.ok(fs.existsSync(applied.depsInstall.script))
  fs.rmSync(root, { recursive: true, force: true })
})

test('apply：找不到宿主 pnpm → 不尝试自动重装，必办指向脚本（或手工）', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('no-pnpm')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  fs.mkdirSync(path.join(src, 'sessions', encodeSessionDir('D:\\x'), 's1'), { recursive: true })
  fs.writeFileSync(path.join(src, 'sessions', encodeSessionDir('D:\\x'), 's1', 'session.jsonl.zstd'), 'x')
  const prof = path.join(src, 'profiles', 'desktop')
  fs.mkdirSync(prof, { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { 'pkg-a': '^1' }, dsh: { profile: { bundles: [] } } }))
  fs.mkdirSync(dst, { recursive: true })
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/code' }], onLog: () => {},
    installDeps: true,
    _depsTools: { nodePath: '/fake/node', pnpmFile: null, source: 'pnpm-not-found' },
  })
  assert.equal(applied.depsInstall.attempted, false)
  const dep = applied.actionRequired.find((a) => a.startsWith('[依赖]'))
  assert.ok(dep && /没找到宿主自带 pnpm/.test(dep), JSON.stringify(applied.actionRequired))
  assert.equal(applied.depsInstall.script, null, '没有 pnpm 路径就写不出可用脚本')
  fs.rmSync(root, { recursive: true, force: true })
})
