// test/workspace.test.js — 工作区代码搬运：纯函数 + 软链重映射。
//
// 这里钉的都是「换机后不自洽」的具体形态，不是覆盖率：
//   · 会话 cwd 给到子目录时不能重复搬（否则同一批文件进 bundle 两次）；
//   · 同名的两个根不能互相覆盖（D:\a\util 与 D:\b\util）；
//   · 派生映射必须优先，否则会话指向的位置和代码实际落位不一致；
//   · 外部软链必须跟着映射走（否则 skills 在新机上是死链）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { rebuildLinks } from '../lib/apply-engine.js'
import {
  assignWorkspaceNames, detectGit, findMappingConflicts, measureDir,
  pickWorkspaceRoots, planWorkspaceTargets, scanWorkspaceCandidates, selectWorkspacePaths,
} from '../lib/workspace-pack.js'

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true })
}

// ── 去嵌套 ────────────────────────────────────────────────────────────────

test('pickWorkspaceRoots 把子目录折进根，只保留根', () => {
  const roots = pickWorkspaceRoots([
    'D:/deepseek/dsh-chat',
    'D:/deepseek/dsh-chat/jumpserver',
    'D:/deepseek/dsh-plugin',
    'D:/work/sre/sre-document',
    'D:/work/sre/sre-document/docs/2026',
  ])
  assert.deepEqual(roots, ['D:/deepseek/dsh-chat', 'D:/deepseek/dsh-plugin', 'D:/work/sre/sre-document'])
})

test('pickWorkspaceRoots 不把同名前缀当成父子关系', () => {
  // D:/deep 与 D:/deepseek 只共享字符串前缀，不是父子 —— 段边界判断必须生效
  const roots = pickWorkspaceRoots(['D:/deep', 'D:/deepseek/x'])
  assert.deepEqual(roots, ['D:/deep', 'D:/deepseek/x'])
})

test('pickWorkspaceRoots 统一反斜杠与盘符大小写后去重', () => {
  const roots = pickWorkspaceRoots(['D:/a/b', 'd:\\A\\b', 'D:/a/b/'])
  assert.equal(roots.length, 1)
})

test('pickWorkspaceRoots 忽略空值', () => {
  assert.deepEqual(pickWorkspaceRoots(['', null, undefined, 'D:/a']), ['D:/a'])
})

// ── 命名 ──────────────────────────────────────────────────────────────────

test('assignWorkspaceNames 同名的两个根加序号，不会互相覆盖', () => {
  const names = assignWorkspaceNames(['D:/a/util', 'D:/b/util', 'D:/c/util'])
  assert.deepEqual(names, ['util', 'util-2', 'util-3'])
})

test('assignWorkspaceNames 去掉会破坏路径的字符', () => {
  const names = assignWorkspaceNames(['D:/a/b:c*d?e'])
  assert.equal(names[0], 'b_c_d_e')
})

// ── 勾选解析 ──────────────────────────────────────────────────────────────

const CANDIDATES = [
  { path: 'D:/deepseek/dsh-plugin', exists: true },
  { path: 'D:/deepseek/dsh-chat', exists: true },
  { path: 'D:/Program Files (x86)/CodeBuddy/deepseek/dsh-work', exists: false },
]

test('selectWorkspacePaths 支持 "*" 全选（跳过源机已不存在的）', () => {
  const r = selectWorkspacePaths(CANDIDATES, '*')
  assert.equal(r.picked.length, 2)
  assert.ok(!r.picked.some((p) => p.endsWith('dsh-work')))
})

test('selectWorkspacePaths 支持按目录名勾选', () => {
  const r = selectWorkspacePaths(CANDIDATES, ['dsh-chat'])
  assert.deepEqual(r.picked, ['D:/deepseek/dsh-chat'])
})

test('selectWorkspacePaths 对源机不存在的候选明确报告，不静默丢', () => {
  const r = selectWorkspacePaths(CANDIDATES, ['dsh-work'])
  assert.deepEqual(r.picked, [])
  assert.equal(r.missing.length, 1)
  assert.match(r.missing[0], /源机不存在/)
})

test('selectWorkspacePaths 接受候选之外的绝对路径', () => {
  const r = selectWorkspacePaths(CANDIDATES, ['E:/somewhere/else'])
  assert.deepEqual(r.picked, ['E:/somewhere/else'])
})

test('selectWorkspacePaths 拒绝既非路径也非候选名的写法', () => {
  const r = selectWorkspacePaths(CANDIDATES, ['记不清了'])
  assert.deepEqual(r.picked, [])
  assert.equal(r.missing.length, 1)
})

// ── 落位与派生映射 ────────────────────────────────────────────────────────

const ENTRIES = [
  { name: 'dsh-chat', sourcePath: 'D:/deepseek/dsh-chat' },
  { name: 'sre-document', sourcePath: 'D:/work/sre-document' },
]

test('planWorkspaceTargets 用一个根目录展开，并派生同源映射', () => {
  const p = planWorkspaceTargets(ENTRIES, { workspaceRoot: 'E:/code' })
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.targets.map((t) => t.destPath), ['E:/code/dsh-chat', 'E:/code/sre-document'])
  // 派生映射的 from 必须是源路径、to 必须等于落位 —— 会话与代码靠这条保持一致
  assert.deepEqual(p.mappings, [
    { from: 'D:/deepseek/dsh-chat', to: 'E:/code/dsh-chat', derived: true },
    { from: 'D:/work/sre-document', to: 'E:/code/sre-document', derived: true },
  ])
})

test('planWorkspaceTargets 支持逐个指定，覆盖根目录', () => {
  const p = planWorkspaceTargets(ENTRIES, { workspaceRoot: 'E:/code', overrides: { 'dsh-chat': 'F:/projects/chat' } })
  assert.equal(p.targets[0].destPath, 'F:/projects/chat')
  assert.equal(p.targets[1].destPath, 'E:/code/sre-document')
})

test('planWorkspaceTargets 未给落位时报错而不是默默跳过', () => {
  const p = planWorkspaceTargets(ENTRIES, {})
  assert.equal(p.targets.length, 0)
  assert.equal(p.errors.length, 2)
  assert.match(p.errors[0], /workspaceRoot/)
})

test('findMappingConflicts 指出手写规则会被派生规则盖过', () => {
  const p = planWorkspaceTargets(ENTRIES, { workspaceRoot: 'E:/code' })
  const issues = findMappingConflicts(p.mappings, [{ from: 'D:/deepseek', to: 'E:/other' }])
  assert.equal(issues.length, 1)
  assert.match(issues[0], /不生效/)
})

test('findMappingConflicts 对互不重叠的规则不出声', () => {
  const p = planWorkspaceTargets(ENTRIES, { workspaceRoot: 'E:/code' })
  assert.deepEqual(findMappingConflicts(p.mappings, [{ from: 'D:/elsewhere', to: 'E:/x' }]), [])
})

// ── 目录扫描 ──────────────────────────────────────────────────────────────

test('measureDir 跳过 node_modules，并认出「容器目录里的子仓库」', async () => {
  const root = tmp('ws-measure-')
  mkdirp(path.join(root, 'repo-a', '.git'))
  fs.writeFileSync(path.join(root, 'repo-a', 'a.txt'), 'x')
  mkdirp(path.join(root, 'node_modules', 'junk'))
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'big.bin'), 'y'.repeat(100))

  const m = await measureDir(root)
  assert.equal(m.files, 1) // node_modules 里的文件不计
  assert.equal(m.gitMode, 'multi') // 自己是容器，子目录是仓库
  assert.equal(m.hasGit, true)
})

test('detectGit 区分 repo / multi / none', async () => {
  const a = tmp('ws-git-repo-')
  mkdirp(path.join(a, '.git'))
  assert.equal(await detectGit(a), 'repo')

  const b = tmp('ws-git-none-')
  mkdirp(path.join(b, 'plain'))
  assert.equal(await detectGit(b), 'none')
})

test('scanWorkspaceCandidates 合两会话与 workspace.json 两处来源', async () => {
  const home = tmp('ws-home-')
  const proj = path.join(home, 'proj')
  mkdirp(proj)
  fs.writeFileSync(path.join(proj, 'f.txt'), 'x')

  const cands = await scanWorkspaceCandidates(home, {
    cwdDistinct: [proj],
    workspacePaths: [], // 只建过没聊过的工作区也该出现在候选里，这里故意留空验证不报错
  })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].exists, true)
  assert.equal(cands[0].files, 1)
})

test('scanWorkspaceCandidates 把根覆盖的子目录记在 covers 里', async () => {
  const home = tmp('ws-covers-')
  const root = path.join(home, 'root')
  const sub = path.join(root, 'sub')
  mkdirp(sub)
  const cands = await scanWorkspaceCandidates(home, { cwdDistinct: [root, sub] })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].covers.length, 1)
})

// ── 软链跟随映射 ──────────────────────────────────────────────────────────

test('rebuildLinks 把外部软链按映射改指新位置（这是 skills 不丢的关键）', () => {
  const base = tmp('ws-links-')
  const bundleDir = path.join(base, 'bundle')
  const dshHome = path.join(base, 'dsh')
  const srcProj = path.join(base, 'oldplace', 'proj')
  const dstProj = path.join(base, 'newplace', 'proj')

  mkdirp(path.join(bundleDir, 'state'))
  mkdirp(path.join(dshHome, 'skills'))
  mkdirp(path.join(srcProj, 'skills', 'alpha'))
  mkdirp(path.join(dstProj, 'skills', 'alpha')) // 已随工作区落地

  fs.writeFileSync(path.join(bundleDir, 'state', 'links.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: 1,
    links: [{
      scope: 'skills',
      rel: 'alpha',
      target: srcProj.replace(/\\/g, '/') + '/skills/alpha',
      linkText: srcProj,
      kind: 'external',
      homeRel: null,
    }],
  }), 'utf8')

  const r = rebuildLinks(bundleDir, dshHome, {
    sourceHome: path.join(base, 'oldhome'),
    mappings: [{ from: srcProj.replace(/\\/g, '/'), to: dstProj.replace(/\\/g, '/') }],
  })

  assert.equal(r.created, 1)
  assert.equal(r.remapped, 1)
  assert.equal(r.skipped.length, 0)
  // 链接实际指向新位置，而且可达 —— 不是只把数字改对
  const link = path.join(dshHome, 'skills', 'alpha')
  assert.equal(fs.existsSync(link), true)
  assert.equal(fs.realpathSync(link).toLowerCase(), fs.realpathSync(path.join(dstProj, 'skills', 'alpha')).toLowerCase())
})

test('rebuildLinks 对映射后仍不存在的目标如实跳过并说明期望路径', () => {
  const base = tmp('ws-links-miss-')
  const bundleDir = path.join(base, 'bundle')
  const dshHome = path.join(base, 'dsh')
  mkdirp(path.join(bundleDir, 'state'))
  mkdirp(dshHome)
  fs.writeFileSync(path.join(bundleDir, 'state', 'links.json'), JSON.stringify({
    total: 1,
    links: [{
      scope: 'skills', rel: 'beta',
      target: 'D:/nope/proj/skills/beta', linkText: 'D:/nope', kind: 'external', homeRel: null,
    }],
  }), 'utf8')

  const r = rebuildLinks(bundleDir, dshHome, {
    mappings: [{ from: 'D:/nope/proj', to: 'E:/moved/proj' }],
  })
  assert.equal(r.created, 0)
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].reason, /E:\/moved\/proj/)
})
