// test/host-env.test.js — 宿主运行时指纹（版本 / 平台 / node）的探测与比对。
// 全部合成数据：自己造 dsh-runtimes/**/runtime.json，不读真实 $DSH_HOME，不联网。
//
// 这组用例的由来是一个**真实的静默失效**：导出侧原先只问 `dsh --version`，
// 而桌面端根本没有这个命令，于是 manifest.source.dshVersion 恒为 null，
// 下游所有「版本不一致」预警都以「非 null」为前提 —— 整条兼容性检查等于不存在，
// 而报告里看着一切正常。用例 1 与用例 9 就是钉这两端的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readRuntimeManifests, pickRuntimeManifest, probeRuntime,
  compareRuntime, summarizeRuntime, semverOf, semverCore, semverMajor,
  readDesktopRelease, desktopRuntimeCandidates,
} from '../lib/host-env.js'
import { exportBundle } from '../lib/bundle.js'
import { buildApplyPs1, buildApplySh } from '../lib/apply-script.js'
import { runVerify } from '../lib/verify-engine.js'

// ── 合成助手 ────────────────────────────────────────────────────────────────
function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-env-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** 路径比较统一口径：解析 `..` 并压成 `/`，避免 Windows 反斜杠造成假失败。 */
function normalize(p) {
  return path.resolve(p).replace(/\\/g, '/')
}

/** 造一份运行时清单：`<home>/dsh-runtimes/<id>/runtime.json`。 */
function writeRuntime(home, id, json) {
  const dir = path.join(home, 'dsh-runtimes', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(json, null, 2) + '\n')
  return dir
}

/** 最小可用 dshHome：一个 profile（带 package.json）+ 一份 settings。 */
function miniHome(tag) {
  const home = tmpDir(tag)
  const prof = path.join(home, 'profiles', 'web')
  fs.mkdirSync(prof, { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
  return home
}

// ── semver 小工具 ───────────────────────────────────────────────────────────

test('semverOf / semverCore / semverMajor 只认 semver，不猜', () => {
  assert.equal(semverOf('dsh 0.2.1-rc.2 (build 7)'), '0.2.1-rc.2')
  assert.equal(semverOf('no version here'), null)
  assert.equal(semverOf(null), null)
  assert.equal(semverCore('0.2.1-rc.2'), '0.2.1')
  assert.equal(semverMajor('0.2.1-rc.2'), 0)
  assert.equal(semverMajor('24.21.0'), 24)
})

// ── 清单读取与挑选 ──────────────────────────────────────────────────────────

test('readRuntimeManifests 在没有 dsh-runtimes 的机器上返回空数组，不抛', () => {
  const home = tmpDir('nort')
  try {
    assert.deepEqual(readRuntimeManifests(home), [])
    assert.deepEqual(readRuntimeManifests(path.join(home, 'does-not-exist')), [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('readRuntimeManifests 跳过坏 JSON，不因一份坏清单丢掉全部', () => {
  const home = tmpDir('badrt')
  try {
    writeRuntime(home, 'dsh-primary-runtime', { desktopVersion: '0.2.1-rc.2', platform: 'win32' })
    fs.mkdirSync(path.join(home, 'dsh-runtimes', 'broken'), { recursive: true })
    fs.writeFileSync(path.join(home, 'dsh-runtimes', 'broken', 'runtime.json'), '{ not json')
    const got = readRuntimeManifests(home)
    assert.equal(got.length, 1)
    assert.equal(got[0].id, 'dsh-primary-runtime')
    assert.equal(got[0].desktopVersion, '0.2.1-rc.2')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('pickRuntimeManifest 优先取 dsh-primary-runtime，不被插件运行时顶掉', () => {
  // 回归：装了插件运行时后 dsh-runtimes 下会有多个目录，按名排序取第一个会拿到插件那份，
  // 于是把插件的 node 当成宿主 node 报出去 —— 平台/代际全跟着错。
  const manifests = [
    { id: 'aaa-plugin-runtime', desktopVersion: null, platform: 'linux', arch: 'x64', node: '20.0.0', pnpm: null },
    { id: 'dsh-primary-runtime', desktopVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', node: '24.21.0', pnpm: '11.28.5' },
  ]
  assert.equal(pickRuntimeManifest(manifests).id, 'dsh-primary-runtime')
  assert.equal(pickRuntimeManifest([]), null)
})

// ── probeRuntime ────────────────────────────────────────────────────────────

test('probeRuntime 从 runtime.json 取到宿主版本（CLI 不在 PATH 也能取到）', async () => {
  const home = miniHome('probe')
  try {
    writeRuntime(home, 'dsh-primary-runtime', {
      desktopVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', node: '24.21.0', pnpm: '11.28.5',
    })
    // allowCli:false —— 证明这条路完全不依赖 dsh 命令，正是原先失效的那一环
    const env = await probeRuntime(home, { allowCli: false })
    assert.equal(env.dshVersion, '0.2.1-rc.2')
    assert.equal(env.platform, 'win32')
    assert.equal(env.arch, 'x64')
    assert.equal(env.runtimeNode, '24.21.0')
    assert.equal(env.runtime, 'dsh-primary-runtime')
    assert.equal(env.source, 'dsh-runtimes')
    // 契约字段：nodeVersion 始终是「跑探测的那个 node」，语义不能变
    assert.equal(env.nodeVersion, process.version)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('probeRuntime 没有 runtime.json 时退到 profile 里的宿主包', async () => {
  const home = miniHome('probe-mods')
  try {
    const dir = path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7' }))
    const env = await probeRuntime(home, { allowCli: false })
    assert.equal(env.dshVersion, '0.1.7')
    assert.equal(env.source, 'profile-node-modules')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('probeRuntime 什么都取不到时如实写 null，不编版本号', async () => {
  const home = miniHome('probe-none')
  try {
    const env = await probeRuntime(home, { allowCli: false })
    assert.equal(env.dshVersion, null)
    assert.equal(env.source, 'unknown')
    assert.equal(env.nodeVersion, process.version)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── compareRuntime ──────────────────────────────────────────────────────────

test('compareRuntime 两端一致时 PASS', () => {
  const env = { dshVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0', runtimeNode: '24.21.0' }
  const r = compareRuntime(env, { ...env })
  assert.equal(r.status, 'PASS')
  assert.deepEqual(r.mismatches, [])
  assert.match(r.detail, /0\.2\.1-rc\.2/)
})

test('compareRuntime 跨代差异时报 WARN 并点明「插件会被启动时拒装」', () => {
  // 跨 major.minor 才是 peer 区间真的可能拒装的场景（^0.2.x 覆盖不到 0.3.x）
  const r = compareRuntime(
    { dshVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0' },
    { dshVersion: '0.3.0-rc.1', platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0' },
  )
  assert.equal(r.status, 'WARN')
  // 这条提示是本功能存在的理由：状态层全绿也可能界面里插件全空
  assert.match(r.detail, /denies it|豁免/)
  assert.deepEqual(r.mismatches, ['dshVersion'])
})

test('compareRuntime 同一 peer 区间内（patch / 预发布）只给弱提示，不吓唬人', () => {
  // 运行时清单落后一个 patch 是常态（宿主升级了、运行时没重装），不该因此把提示做成噪音
  const weak = [
    ['0.2.1-rc.1', '0.2.1-rc.2'],
    ['0.2.0-rc.2', '0.2.1-rc.2'],
    ['0.2.1', '0.2.5'],
  ]
  for (const [from, to] of weak) {
    const r = compareRuntime(
      { dshVersion: from, platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0' },
      { dshVersion: to, platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0' },
    )
    assert.equal(r.status, 'WARN', from + ' → ' + to)
    assert.match(r.detail, /peer 区间内/, from + ' → ' + to)
    assert.doesNotMatch(r.detail, /denies it/, from + ' → ' + to)
  }
})

test('compareRuntime 任一端版本未知时不假判 PASS', () => {
  const a = compareRuntime(null, { dshVersion: '0.2.1-rc.2', platform: 'win32', nodeVersion: 'v24.21.0' })
  assert.equal(a.status, 'WARN')
  assert.match(a.detail, /人工确认/)
  const b = compareRuntime({ dshVersion: '0.2.1-rc.2', platform: 'win32' }, { dshVersion: null, platform: 'win32' })
  assert.equal(b.status, 'WARN')
  assert.match(b.detail, /目标机取不到/)
})

test('compareRuntime 版本相同但平台/架构不同也要报', () => {
  const base = { dshVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0' }
  const r = compareRuntime(base, { ...base, platform: 'darwin', arch: 'arm64' })
  assert.equal(r.status, 'WARN')
  assert.deepEqual(r.mismatches.sort(), ['arch', 'platform'])
  assert.match(r.detail, /原生二进制/)
})

test('compareRuntime 比的是宿主自带 node 的代际，不是探测进程的', () => {
  const r = compareRuntime(
    { dshVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', nodeVersion: 'v22.12.0', runtimeNode: '22.12.0' },
    { dshVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', nodeVersion: 'v24.21.0', runtimeNode: '24.21.0' },
  )
  assert.equal(r.status, 'WARN')
  assert.deepEqual(r.mismatches, ['node'])
  assert.match(r.detail, /22\.15/)
})

test('summarizeRuntime 压成一行，缺字段不崩', () => {
  assert.equal(summarizeRuntime(null), '未知')
  const s = summarizeRuntime({ dshVersion: '0.2.1-rc.2', platform: 'win32', arch: 'x64', runtimeNode: '24.21.0' })
  assert.match(s, /dsh 0\.2\.1-rc\.2 \/ win32-x64 \/ node 24\.21\.0/)
  assert.match(summarizeRuntime({ dshVersion: null, platform: null, arch: null }), /dsh 版本未知/)
})

// ── 脚本路径：零依赖兜底脚本必须与工具路径同一口径 ───────

test('生成的 apply.ps1 / apply.sh 都从 dsh-runtimes 取版本，不只靠 dsh --version', () => {
  const manifest = { format: 'dsh-sync-bundle', formatVersion: 2, source: { dshVersion: '0.2.0-rc.2' }, profiles: [{ name: 'web' }] }
  const ps1 = buildApplyPs1(manifest)
  const sh = buildApplySh(manifest)
  for (const [name, text] of [['apply.ps1', ps1], ['apply.sh', sh]]) {
    assert.ok(text.includes('dsh-runtimes'), name + ' 必须从 dsh-runtimes 读宿主版本')
    assert.ok(text.includes('desktopVersion'), name + ' 必须认 desktopVersion 字段')
  }
  // 修复回归：旧版把 $BUNDLE 拼进了 JS 字符串，Git Bash 下是 /d/xxx 形式，
  // node 认不出 → src_ver 恒为空 → 整段静默跳过（正是本功能要消灭的失效）。
  assert.ok(!/require\('\$BUNDLE/.test(sh), 'sh 不得把 $BUNDLE 内嵌进 JS 字符串，必须走 argv')
  assert.ok(sh.includes('"$BUNDLE/manifest.json"'), 'sh 必须把 manifest 路径作为参数传给 node')
  // 修复回归：set -u 下未引号的 heredoc 会展开 $DSH_HOME → --help 直接崩。
  assert.ok(sh.includes("cat <<'EOF'"), "usage 的 heredoc 定界符必须带引号")
  // 两个脚本都不得因为取不到版本而静默
  assert.ok(ps1.includes('无法确定本机 dsh 版本'), 'ps1 取不到版本时必须出声')
  assert.ok(sh.includes('无法确定本机 dsh 版本'), 'sh 取不到版本时必须出声')
})

// ── 端到端：导出与核对都必须带上这条 ────────────────────────────────────────
test('导出把 runtime.json 里的宿主版本写进 manifest.source（原先恒为 null）', async () => {
  const home = miniHome('e2e-export')
  const out = tmpDir('e2e-export-out')
  try {
    writeRuntime(home, 'dsh-primary-runtime', {
      desktopVersion: '0.2.1-rc.2', platform: process.platform, arch: process.arch, node: '24.21.0',
    })
    const { manifest } = await exportBundle({
      dshHome: home, profiles: ['web'], outDir: out, includeCredentials: false, includePlugins: false,
    })
    assert.equal(manifest.source.dshVersion, '0.2.1-rc.2',
      '把版本交给 dsh --version 会让桌面端恒为 null —— 必须从 dsh-runtimes 取')
    assert.equal(manifest.source.source, 'dsh-runtimes')
    assert.equal(manifest.source.runtimeNode, '24.21.0')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('verify 输出 I11，并在目标机版本不同时报 WARN', async () => {
  const src = miniHome('e2e-src')
  const dst = miniHome('e2e-dst')
  const out = tmpDir('e2e-verify-out')
  try {
    writeRuntime(src, 'dsh-primary-runtime', {
      desktopVersion: '0.2.0-rc.2', platform: process.platform, arch: process.arch, node: '22.12.0',
    })
    writeRuntime(dst, 'dsh-primary-runtime', {
      desktopVersion: '0.2.1-rc.2', platform: process.platform, arch: process.arch, node: '24.21.0',
    })
    const { bundleDir } = await exportBundle({
      dshHome: src, profiles: ['web'], outDir: out, includeCredentials: false, includePlugins: false,
    })
    const result = await runVerify(bundleDir, dst)
    const i11 = result.checks.find((c) => c.id === 'I11')
    assert.ok(i11 !== undefined, 'I11（宿主运行时一致性）必须出现在核对清单里')
    assert.equal(i11.status, 'WARN')
    assert.match(i11.detail, /0\.2\.0-rc\.2/)
    assert.match(i11.detail, /0\.2\.1-rc\.2/)
  } finally {
    fs.rmSync(src, { recursive: true, force: true })
    fs.rmSync(dst, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

// ── 桌面版：版本要从安装包自己拿，不能信 dsh-runtimes 的陈旧快照 ─────────────
// 本机真实事故：应用已是 0.2.1-rc.2（内置 node 24.21.0 / pnpm 11.28.5），而
// `$DSH_HOME/dsh-runtimes/dsh-primary-runtime/runtime.json` 还停在 0.2.0-rc.2 / pnpm 11.7.0 ——
// 那份清单位于**安装时**写入，升级不会刷新它。用它比对的后果不是「少一条提示」，而是
// 换到刚装好的新机（快照新鲜）时两台版本明明相同却报不一致；两边都陈旧时又会把真跨代抹平。
function writeFakeDesktop(root, release) {
  const dir = path.join(root, 'resources', 'app.asar', 'dsh')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'desktop-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    release,
    platform: 'win32',
    arch: 'x64',
    sharedPackages: [],
  }, null, 2) + '\n')
  return { versions: { electron: '44.7.0' }, resourcesPath: path.join(root, 'resources'), execPath: path.join(root, 'DeepSeek Harness.exe') }
}

test('desktopRuntimeCandidates 只在 Electron 里给出路径，且优先 resourcesPath', () => {
  assert.deepEqual(desktopRuntimeCandidates({ versions: { node: '24.0.0' } }), [],
    'web 宿主 / CLI 没有安装包可读，必须返回空数组而不是瞎猜路径')

  const env = { versions: { electron: '44.7.0' }, resourcesPath: 'C:/app/resources', execPath: 'C:/app/App.exe' }
  const c = desktopRuntimeCandidates(env)
  assert.equal(c.length, 2)
  assert.equal(normalize(c[0]), normalize('C:/app/resources/app.asar/dsh/desktop-runtime.json'))
  assert.equal(normalize(c[1]), normalize('C:/app/App.exe/../resources/app.asar/dsh/desktop-runtime.json'),
    'resourcesPath 缺失时的兜底是「可执行文件同级的 resources」')
})

test('readDesktopRelease 取到安装包声明的版本与 node/pnpm，缺字段写 null 不编', () => {
  const root = tmpDir('desktop-ok')
  const env = writeFakeDesktop(root, {
    version: '0.2.1-rc.2', hostProtocolVersion: 4, nodeVersion: '24.21.0', pnpmVersion: '11.28.5',
  })
  const rel = readDesktopRelease(env)
  assert.equal(rel.version, '0.2.1-rc.2')
  assert.equal(rel.node, '24.21.0')
  assert.equal(rel.pnpm, '11.28.5')
  assert.equal(rel.hostProtocolVersion, 4)
  assert.equal(rel.platform, 'win32')

  const bare = path.join(root, 'bare')
  fs.mkdirSync(path.join(bare, 'resources', 'app.asar', 'dsh'), { recursive: true })
  fs.writeFileSync(path.join(bare, 'resources', 'app.asar', 'dsh', 'desktop-runtime.json'),
    JSON.stringify({ release: { version: '0.2.1-rc.2' } }))
  const slim = readDesktopRelease({ versions: { electron: '1' }, resourcesPath: path.join(bare, 'resources'), execPath: '' })
  assert.equal(slim.version, '0.2.1-rc.2')
  assert.equal(slim.node, null, '没写 nodeVersion 就是 null，不许拿 process 的版本冒充宿主内置 node')
  assert.equal(slim.pnpm, null)
  assert.equal(slim.hostProtocolVersion, null)

  const none = readDesktopRelease({ versions: { electron: '1' }, resourcesPath: path.join(root, 'nope'), execPath: '' })
  assert.equal(none, null, '读不到必须是 null，让调用方继续走后面的来源')
  fs.rmSync(root, { recursive: true, force: true })
})

test('probeRuntime 在桌面版里优先用安装包的版本，压过陈旧的 dsh-runtimes 快照', async () => {
  const root = tmpDir('desktop-stale')
  const home = path.join(root, 'home')
  // 陈旧快照：升级前写下的 0.2.0-rc.2
  writeRuntime(home, 'dsh-primary-runtime', {
    desktopVersion: '0.2.0-rc.2', platform: 'win32', arch: 'x64', node: '24.21.0', pnpm: '11.7.0',
  })
  const env = writeFakeDesktop(path.join(root, 'app'), {
    version: '0.2.1-rc.2', hostProtocolVersion: 4, nodeVersion: '24.21.0', pnpmVersion: '11.28.5',
  })

  const fromDesktop = await probeRuntime(home, { env })
  assert.equal(fromDesktop.dshVersion, '0.2.1-rc.2', '正在跑的宿主才是权威，快照过期不能反过来盖住它')
  assert.equal(fromDesktop.source, 'desktop-app')
  assert.equal(fromDesktop.pnpm, '11.28.5')
  assert.equal(fromDesktop.runtimeNode, '24.21.0')

  // 同一台机器上用 web 宿主（无 Electron）时，仍走快照那条路，行为不变
  const fromSnapshot = await probeRuntime(home, { env: { versions: { node: '24.21.0' } } })
  assert.equal(fromSnapshot.dshVersion, '0.2.0-rc.2')
  assert.equal(fromSnapshot.source, 'dsh-runtimes')
  fs.rmSync(root, { recursive: true, force: true })
})
