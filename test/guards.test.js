// test/guards.test.js — 守卫类纯函数：P7 补丁字段扫描 + 版本比较 + I15 版本漂移审计。
// 全部为纯读判定，无文件写入之外的副作用（auditPluginVersions 只读合成目录）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { patchGuardWarnings, scanHostRejectedFields } from '../lib/patch-guard.js'
import { auditPluginVersions, compareVersions } from '../lib/verify-engine.js'

// ── P7：scanHostRejectedFields ────────────────────────────────────────────────

test('P7：识别 models 字段（顶层与嵌套），跳过注释与无关键', () => {
  const text = [
    'llm-deepseek-account:',
    '  models: []',
    '  endpoint: https://api.example.com',
    '# models: 这是注释，不算',
    'models : 5',
    'xmodels: 1',
    'models-x: 1',
  ].join('\n')
  const hits = scanHostRejectedFields(text)
  assert.deepEqual(hits.map((h) => h.line), [2, 5])
  assert.ok(hits.every((h) => h.field === 'models'))
  assert.match(hits[0].reason, /no longer configurable/)
})

test('P7：空文本与无命中返回空数组', () => {
  assert.deepEqual(scanHostRejectedFields(''), [])
  assert.deepEqual(scanHostRejectedFields('a:\n  b: 1\n'), [])
  assert.deepEqual(scanHostRejectedFields(null), [])
})

test('P7：patchGuardWarnings 输出带定位与处置建议', () => {
  const ws = patchGuardWarnings('models: []', 'cordis.patch.yml')
  assert.equal(ws.length, 1)
  assert.equal(ws[0].where, 'cordis.patch.yml')
  assert.match(ws[0].preview, /第 1 行/)
  assert.match(ws[0].reason, /删除该字段/)
})

// ── compareVersions ──────────────────────────────────────────────────────────

test('版本比较：主次补丁按数值、预发布比正式版旧、rc 按序号', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('1.3.0', '1.2.9') > 0)
  assert.ok(compareVersions('0.2.1-rc.2', '0.2.1') < 0, '正式版 > 同版本预发布')
  assert.ok(compareVersions('0.2.1-rc.3', '0.2.1-rc.2') > 0)
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0, '按数值比，不是字符串比')
})

test('版本比较：解析失败一律视为相当（不告警）', () => {
  assert.equal(compareVersions('abc', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0', ''), 0)
  assert.equal(compareVersions(null, null), 0)
})

// ── I15：auditPluginVersions ─────────────────────────────────────────────────

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-guard-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writePluginVersion(root, name, version) {
  // 口径对齐 auditPluginVersions：安装副本与 vendored 副本都住在 plugins/<name>（scoped 名带层级）。
  const dir = path.join(root, 'plugins', ...name.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2))
  return dir
}

/** 开发仓库的 package.json 在仓库根（sourcePath 即仓库根），与 plugins 布局不同。 */
function writeRepoVersion(repo, version) {
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'dsh-sync', version }, null, 2))
}

function linkDep({ name, version, sourcePath }) {
  return { name, kind: 'link', spec: 'link:' + name, inBundle: true, bundlePath: 'plugins/' + name, sourcePath }
}

test('I15：安装副本落后于 bundle 与开发仓库 → WARN 两项', async () => {
  const bundleDir = tmpDir('b')
  const dshHome = tmpDir('h')
  const repo = tmpDir('repo')
  writePluginVersion(bundleDir, 'dsh-sync', '0.18.0')
  writePluginVersion(dshHome, 'dsh-sync', '0.14.2')
  writeRepoVersion(repo, '0.18.1')
  const manifest = { profiles: [{ name: 'desktop', deps: [linkDep({ name: 'dsh-sync', sourcePath: repo })] }] }
  const r = await auditPluginVersions(manifest, bundleDir, dshHome)
  assert.equal(r.status, 'WARN')
  assert.equal(r.items.length, 2)
  assert.ok(r.items.some((x) => x.kind === 'bundle-vs-installed'))
  assert.ok(r.items.some((x) => x.kind === 'repo-vs-installed'))
})

test('I15：三方一致 → PASS；仓库不存在时只比 bundle 侧', async () => {
  const bundleDir = tmpDir('b')
  const dshHome = tmpDir('h')
  const repo = tmpDir('repo')
  writePluginVersion(bundleDir, 'dsh-sync', '0.18.1')
  writePluginVersion(dshHome, 'dsh-sync', '0.18.1')
  writeRepoVersion(repo, '0.18.1')
  const ok = await auditPluginVersions(
    { profiles: [{ name: 'desktop', deps: [linkDep({ name: 'dsh-sync', sourcePath: repo })] }] },
    bundleDir, dshHome)
  assert.equal(ok.status, 'PASS')

  // 开发仓库不在本机（跨机 verify 的常态）：只比 bundle 侧，一致即 PASS。
  const noRepo = await auditPluginVersions(
    { profiles: [{ name: 'desktop', deps: [linkDep({ name: 'dsh-sync', sourcePath: path.join(repo, '不存在') })] }] },
    bundleDir, dshHome)
  assert.equal(noRepo.status, 'PASS')

  // 仓库不在但 bundle 更新：仍要报（重跑 apply 可对齐）。
  fs.writeFileSync(path.join(bundleDir, 'plugins', 'dsh-sync', 'package.json'),
    JSON.stringify({ name: 'dsh-sync', version: '0.19.0' }))
  const newer = await auditPluginVersions(
    { profiles: [{ name: 'desktop', deps: [linkDep({ name: 'dsh-sync', sourcePath: path.join(repo, '不存在') })] }] },
    bundleDir, dshHome)
  assert.equal(newer.status, 'WARN')
  assert.equal(newer.items.length, 1)
})

test('I15：安装副本不存在时让位给 I7/I9，不越权报告', async () => {
  const bundleDir = tmpDir('b')
  const dshHome = tmpDir('h')
  const repo = tmpDir('repo')
  writePluginVersion(bundleDir, 'dsh-sync', '0.18.0')
  writeRepoVersion(repo, '0.18.1')
  const r = await auditPluginVersions(
    { profiles: [{ name: 'desktop', deps: [linkDep({ name: 'dsh-sync', sourcePath: repo })] }] },
    bundleDir, dshHome)
  assert.equal(r.status, 'PASS')
})

test('I15：bundle 无 link 插件 → PASS', async () => {
  const r = await auditPluginVersions({ profiles: [{ name: 'desktop', deps: [] }] }, tmpDir('b'), tmpDir('h'))
  assert.equal(r.status, 'PASS')
})
