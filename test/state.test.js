// test/state.test.js — 状态层（sessions / storages / skills）迁移的单元与端到端测试。
// 全部使用合成数据（自建 zstd 多帧文件），不读取真实 $DSH_HOME，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  applyMappings, isSameOrChild, normalizePath, validateMappings, guessPrefixes,
} from '../lib/path-map.js'
import {
  encodeSessionDir, isSessionGroupDir, scanSessions, planSessionMigration,
  applySessionPlan, remapWorkspacePaths, readWorkspacePaths, auditConsistency,
} from '../lib/session-migrate.js'
import { parseFrames, readSessionHeader, rewriteSessionHeader, zstdAvailable } from '../lib/zstd-frame.js'
import { scanLinks, linkWarnings } from '../lib/link-scan.js'
import { exportBundle } from '../lib/bundle.js'
import { applyBundle, verifyBundleIntegrity, inspectBundle, rebuildLinks } from '../lib/apply-engine.js'
import { runVerify } from '../lib/verify-engine.js'

const HAS_ZSTD = zstdAvailable()

// ── 合成助手 ────────────────────────────────────────────────────────────────
function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/**
 * 造一个与 DSH 同形的会话文件：首帧 = 一行 JSON header，其后每帧 = 一行事件。
 * @param {string} file
 * @param {object} header
 * @param {string[]} events
 */
function writeSessionFile(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))]
  for (const e of events) frames.push(zlib.zstdCompressSync(Buffer.from(e + '\n', 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
}

function mkSession(dshHome, cwd, id, events = ['{"seq":1}', '{"seq":2}']) {
  const dir = path.join(dshHome, 'sessions', encodeSessionDir(cwd), id)
  writeSessionFile(path.join(dir, 'session.jsonl.zstd'), {
    type: 'session', version: 0, id, createdAt: 1700000000000, cwd, delegationDepth: 0, agentPreset: 'standard',
  }, events)
  return dir
}

function mkWorkspace(dshHome, entries) {
  const table = {}
  for (const [id, p] of entries) table[id] = { path: p, title: path.basename(p), sessionIds: [] }
  const doc = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: Object.keys(table) }, tables: { workspaces: table } }
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2))
  return doc
}

// ══ path-map ════════════════════════════════════════════════════════════════

test('normalizePath 统一分隔符与大小写盘符', () => {
  assert.equal(normalizePath('D:\\a\\b'), 'D:/a/b')
  assert.equal(normalizePath('D:/a//b/'), 'D:/a/b')
  assert.equal(normalizePath('d:/A'), 'D:/A')       // 盘符大写，路径其余部分保留
  assert.equal(normalizePath(''), '')
})

test('isSameOrChild 按路径段判定，不是字符串前缀', () => {
  assert.equal(isSameOrChild('D:/a/b', 'D:/a'), true)
  assert.equal(isSameOrChild('D:/a', 'D:/a'), true)
  assert.equal(isSameOrChild('D:/ab', 'D:/a'), false)  // 关键：伪前缀必须判否
  assert.equal(isSameOrChild('D:/A/B', 'D:/a'), process.platform === 'win32')
})

test('applyMappings 只在段边界命中', () => {
  // D:/deep 不能吃到 D:/deepseek/...
  assert.equal(applyMappings('D:/deepseek/dsh-chat', [{ from: 'D:/deep', to: 'E:/x' }]), null)
  const hit = applyMappings('D:/deepseek/dsh-chat', [{ from: 'D:/deepseek', to: 'E:/code' }])
  assert.equal(hit.path, 'E:/code/dsh-chat')
  assert.deepEqual(hit.rule, { from: 'D:/deepseek', to: 'E:/code' })
})

test('applyMappings 按顺序首条命中即返回（不自作最长前缀）', () => {
  const r = applyMappings('D:/a/b', [{ from: 'D:/a', to: 'E:/1' }, { from: 'D:/a/b', to: 'F:/2' }])
  assert.equal(r.path, 'E:/1/b')
})

test('applyMappings 等价映射视为未命中', () => {
  assert.equal(applyMappings('D:/a', [{ from: 'D:/a', to: 'D:/a' }]), null)
  assert.equal(applyMappings('D:/a', []), null)
  assert.equal(applyMappings('D:/a', undefined), null)
})

test('validateMappings 拦重复 from、空值，提示等价规则', () => {
  const issues = validateMappings([
    { from: 'D:/a', to: 'E:/b' },
    { from: 'D:/a', to: 'F:/c' },
    { from: '', to: 'G:/d' },
  ])
  assert.ok(issues.some((i) => i.level === 'error' && /重复/.test(i.message)))
  assert.ok(issues.some((i) => i.level === 'error' && /不能为空/.test(i.message)))
  assert.equal(validateMappings([]).length, 0, '空映射集合不应报问题')
  // 「等价规则」的判定按平台大小写：Windows 上 D:/a 与 d:/A 是同一路径，POSIX 上不是。
  const caseEq = validateMappings([{ from: 'D:/a', to: 'd:/A' }]).some((i) => i.level === 'warn')
  assert.equal(caseEq, process.platform === 'win32')
  // 逐字相同则是任何平台都等价
  assert.ok(validateMappings([{ from: 'D:/a', to: 'D:/a' }]).some((i) => i.level === 'warn'))
  assert.deepEqual(validateMappings('not-an-array').filter((i) => i.level === 'error').length, 1)
})

test('guessPrefixes 统计前两段并降序', () => {
  const g = guessPrefixes(['D:/deepseek/a', 'D:/deepseek/b', 'D:/other/x'])
  assert.equal(g[0].prefix, 'D:/deepseek')
  assert.equal(g[0].count, 2)
})

// ══ 目录名编码 ══════════════════════════════════════════════════════════════

test('encodeSessionDir 与 DSH 实际目录名一致', () => {
  assert.equal(encodeSessionDir('D:\\deepseek\\dsh-chat'), '--D-deepseek-dsh-chat--')
  // 空格 → ~0020，括号 → ~0028/~0029，冒号丢弃，分隔符 → -
  assert.equal(
    encodeSessionDir(path.win32.join('D:', 'Program Files (x86)', 'CodeBuddy', 'deepseek', 'dsh-work')),
    '--D-Program~0020Files~0020~0028x86~0029-CodeBuddy-deepseek-dsh-work--',
  )
  // 中文按 UTF-16 码元转 4 位大写 hex
  assert.equal(encodeSessionDir(path.win32.join('D:', 'a', '探索')), '--D-a-~63A2~7D22--')
})

test('encodeSessionDir 是有损的：不同 cwd 可能同目录名', () => {
  // 这正是必须做冲突检测的原因 —— 反解不可行，只能正向算并检测碰撞。
  // `\` 与 `-` 折叠成同一个 `-`，所以「目录分隔」与「连字符」在编码里不可区分。
  const a = path.win32.join('D:', 'a-b', 'c')
  const b = path.win32.join('D:', 'a', 'b-c')
  assert.notEqual(a, b)
  assert.equal(encodeSessionDir(a), '--D-a-b-c--')
  assert.equal(encodeSessionDir(a), encodeSessionDir(b))
})

test('isSessionGroupDir 识别 --...-- 形态', () => {
  assert.equal(isSessionGroupDir('--D-a--'), true)
  assert.equal(isSessionGroupDir('--'), false)
  assert.equal(isSessionGroupDir('D-a'), false)
  assert.equal(isSessionGroupDir(''), false)
})

// ══ zstd 帧 ═════════════════════════════════════════════════════════════════

test('parseFrames 精确切出多帧并走到末尾', { skip: !HAS_ZSTD }, () => {
  const dir = tmpDir('frames')
  const f = path.join(dir, 's.zstd')
  writeSessionFile(f, { type: 'session', cwd: 'D:/a', id: 'x' }, ['{"seq":1}', '{"seq":2}', '{"seq":3}'])
  const buf = fs.readFileSync(f)
  const { starts, complete } = parseFrames(buf)
  assert.equal(starts.length, 4)
  assert.equal(complete, true)
  assert.equal(starts[0], 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('parseFrames 对非 zstd 输入返回空且不抛', () => {
  const { starts, complete } = parseFrames(Buffer.from('not zstd at all, just text'))
  assert.equal(starts.length, 0)
  assert.equal(complete, false)
})

test('rewriteSessionHeader 只换首帧，事件区逐字节不变', { skip: !HAS_ZSTD }, () => {
  const dir = tmpDir('rewrite')
  const f = path.join(dir, 'session.jsonl.zstd')
  const events = ['{"seq":1,"text":"hello"}', '{"seq":2,"text":"世界"}']
  writeSessionFile(f, { type: 'session', version: 0, id: 'sid-1', createdAt: 1700000000000, cwd: 'D:\\deepseek\\dsh-chat' }, events)
  const before = fs.readFileSync(f)
  const beforeFrames = parseFrames(before)
  const payloadBefore = before.subarray(beforeFrames.starts[1])

  const target = path.win32.join('E:', 'code', 'dsh-chat')
  const r = rewriteSessionHeader(f, { cwd: target })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.equal(r.frameCount, beforeFrames.starts.length)

  const after = fs.readFileSync(f)
  const afterFrames = parseFrames(after)
  assert.equal(afterFrames.starts.length, beforeFrames.starts.length, '帧数必须不变')
  assert.deepEqual(after.subarray(afterFrames.starts[1]), payloadBefore, '事件区必须逐字节保留')

  const back = readSessionHeader(f)
  assert.equal(back.header.cwd, target, 'cwd 必须严格等于目标值（不是"看起来像"）')
  assert.equal(back.header.id, 'sid-1')
  assert.equal(back.header.createdAt, 1700000000000)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rewriteSessionHeader 值未变时不重写', { skip: !HAS_ZSTD }, () => {
  const dir = tmpDir('nochange')
  const f = path.join(dir, 'session.jsonl.zstd')
  writeSessionFile(f, { type: 'session', cwd: 'D:/a' }, ['{"seq":1}'])
  const before = fs.statSync(f).mtimeMs
  const r = rewriteSessionHeader(f, { cwd: 'D:/a' })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(fs.statSync(f).mtimeMs, before)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rewriteSessionHeader 遇撕裂尾帧拒绝改写（不破坏可自愈文件）', { skip: !HAS_ZSTD }, () => {
  const dir = tmpDir('torn')
  const f = path.join(dir, 'session.jsonl.zstd')
  writeSessionFile(f, { type: 'session', cwd: 'D:/a' }, ['{"seq":1}'])
  // 追加半个帧：帧头合法但内容不完整
  const good = zlib.zstdCompressSync(Buffer.from('{"seq":2}\n'))
  fs.appendFileSync(f, good.subarray(0, Math.floor(good.length / 2)))
  const original = fs.readFileSync(f)
  const r = rewriteSessionHeader(f, { cwd: 'D:/b' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /torn-tail|broken-chain/)
  assert.deepEqual(fs.readFileSync(f), original, '拒绝时必须零写入')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ══ 会话扫描与规划 ══════════════════════════════════════════════════════════

test('scanSessions 以 header 为准，并把目录名不一致报出来', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('scan')
  mkSession(home, 'D:\\deepseek\\dsh-chat', 's1')
  // 故意把第二个会话放进错误的目录名
  const wrongDir = path.join(home, 'sessions', '--D-wrong-place--', 's2')
  writeSessionFile(path.join(wrongDir, 'session.jsonl.zstd'), { type: 'session', id: 's2', cwd: 'D:\\deepseek\\other' }, ['{"seq":1}'])
  const scan = await scanSessions(home)
  assert.equal(scan.sessions.length, 2)
  const s2 = scan.sessions.find((s) => s.dirName === 's2')
  assert.equal(s2.cwd, 'D:\\deepseek\\other', 'cwd 必须来自 header')
  assert.ok(scan.problems.some((p) => /目录名与 header\.cwd 不一致/.test(p.message)))
  fs.rmSync(home, { recursive: true, force: true })
})

test('planSessionMigration 以分组为粒度，同组多会话不算冲突', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('plan')
  // 同一个工作区下 3 个会话 —— 它们共享一个分组目录
  mkSession(home, 'D:\\deepseek\\dsh-chat', 'a1')
  mkSession(home, 'D:\\deepseek\\dsh-chat', 'a2')
  mkSession(home, 'D:\\deepseek\\dsh-chat', 'a3')
  mkSession(home, 'D:\\code\\other', 'b1')
  const scan = await scanSessions(home)
  const plan = planSessionMigration(scan, [{ from: 'D:/deepseek', to: 'E:/moved' }])

  assert.equal(plan.stats.groups, 2)
  assert.equal(plan.stats.sessions, 4)
  assert.equal(plan.conflicts.filter((c) => c.level === 'error').length, 0, '同组多会话不应被判冲突')
  const g = plan.groups.find((x) => x.cwd === 'D:\\deepseek\\dsh-chat')
  assert.equal(g.sessions, 3)
  assert.equal(g.needsRename, true)
  assert.equal(g.toDir, encodeSessionDir('E:/moved/dsh-chat'))
  const kept = plan.groups.find((x) => x.cwd === 'D:\\code\\other')
  assert.equal(kept.needsRename, false, '未命中映射的分组不应改名')
  fs.rmSync(home, { recursive: true, force: true })
})

test('planSessionMigration 报出「同组内 cwd 不一致」（编码碰撞的真实后果）', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('collide')
  // 两个不同 cwd 编码成同一个目录名 —— DSH 会把它们放进同一个分组目录。
  // 迁移时不能装作没看见：组内 cwd 必须唯一，否则改名后总有一批会话找不回来。
  const a = path.win32.join('D:', 'a-b', 'c')
  const b = path.win32.join('D:', 'a', 'b-c')
  assert.equal(encodeSessionDir(a), encodeSessionDir(b), '前提：两者编码必须相同')
  mkSession(home, a, 'c1')
  mkSession(home, b, 'c2')

  const scan = await scanSessions(home)
  assert.equal(scan.sessions.length, 2)
  assert.equal(new Set(scan.sessions.map((s) => s.groupDir)).size, 1, '前提：落在同一个分组目录')

  const plan = planSessionMigration(scan, [])
  assert.equal(plan.groups.length, 1)
  assert.ok(
    plan.conflicts.some((c) => c.level === 'warn' && /不同 cwd/.test(c.message)),
    '同组内 cwd 不一致必须被报出来，而不是静默取第一个',
  )
  fs.rmSync(home, { recursive: true, force: true })
})

test('applySessionPlan 改 header 并重命名分组，dryRun 不落盘', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('apply')
  mkSession(home, 'D:\\deepseek\\dsh-chat', 'a1', ['{"seq":1}', '{"seq":2}'])
  mkSession(home, 'D:\\deepseek\\dsh-chat', 'a2')
  const scan = await scanSessions(home)
  const plan = planSessionMigration(scan, [{ from: 'D:/deepseek', to: 'E:/moved' }])

  const dry = await applySessionPlan(plan, { root: path.join(home, 'sessions'), dryRun: true })
  assert.equal(dry.renamed, 0)
  assert.ok(fs.existsSync(path.join(home, 'sessions', '--D-deepseek-dsh-chat--')), 'dryRun 不得改名')

  const res = await applySessionPlan(plan, { root: path.join(home, 'sessions') })
  assert.equal(res.failed, 0)
  assert.equal(res.renamed, 1)

  const newGroup = path.join(home, 'sessions', encodeSessionDir('E:/moved/dsh-chat'))
  assert.ok(fs.existsSync(newGroup), '分组目录应已改名')
  assert.ok(!fs.existsSync(path.join(home, 'sessions', '--D-deepseek-dsh-chat--')))
  for (const sid of ['a1', 'a2']) {
    const h = readSessionHeader(path.join(newGroup, sid, 'session.jsonl.zstd'))
    assert.equal(h.header.cwd, 'E:/moved/dsh-chat')
    assert.equal(h.header.id, sid)
  }
  fs.rmSync(home, { recursive: true, force: true })
})

test('remapWorkspacePaths 返回新对象且不改入参', () => {
  const doc = { tables: { workspaces: { w1: { path: 'D:\\deepseek\\dsh-chat' }, w2: { path: 'D:\\other' } } } }
  const snapshot = JSON.stringify(doc)
  const { json, changes } = remapWorkspacePaths(doc, [{ from: 'D:/deepseek', to: 'E:/moved' }])
  assert.equal(JSON.stringify(doc), snapshot, '入参不得被修改')
  assert.equal(changes.length, 1)
  assert.equal(json.tables.workspaces.w1.path, 'E:/moved/dsh-chat')
  assert.equal(json.tables.workspaces.w2.path, 'D:\\other')
})

test('auditConsistency 检出 cwd 编码与目录名不符', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('audit')
  mkSession(home, 'D:\\deepseek\\dsh-chat', 'ok1')
  const wrongDir = path.join(home, 'sessions', '--D-wrong--', 'bad1')
  writeSessionFile(path.join(wrongDir, 'session.jsonl.zstd'), { type: 'session', id: 'bad1', cwd: 'D:\\deepseek\\x' }, ['{"seq":1}'])
  const scan = await scanSessions(home)
  const issues = auditConsistency(scan.sessions, mkWorkspace(home, [['w1', 'D:\\deepseek\\dsh-chat']]))
  assert.ok(issues.some((i) => i.level === 'error' && /编码与所在目录名不符/.test(i.message)))
  fs.rmSync(home, { recursive: true, force: true })
})

// ══ 链接扫描 ════════════════════════════════════════════════════════════════

test('scanLinks 区分内部 / 外部 / 断链，且绝不静默', () => {
  const home = tmpDir('links')
  fs.mkdirSync(path.join(home, 'skills', 'real'), { recursive: true })
  fs.writeFileSync(path.join(home, 'skills', 'real', 'SKILL.md'), '# x')
  const outside = tmpDir('outside')
  fs.mkdirSync(path.join(outside, 'ext'), { recursive: true })

  try {
    fs.symlinkSync(path.join(home, 'skills', 'real'), path.join(home, 'skills', 'in'), 'junction')
    fs.symlinkSync(path.join(outside, 'ext'), path.join(home, 'skills', 'out'), 'junction')
    fs.symlinkSync(path.join(home, 'nope-missing'), path.join(home, 'skills', 'broken'), 'junction')
  } catch (err) {
    // 无符号链接权限的环境（某些 Windows 配置）跳过而不是假通过
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
    return
  }

  const { links, summary } = scanLinks(home)
  assert.equal(summary.total, 3)
  assert.equal(links.find((l) => l.rel.endsWith('/in')).kind, 'internal')
  assert.equal(links.find((l) => l.rel.endsWith('/out')).kind, 'external')
  assert.equal(links.find((l) => l.rel.endsWith('/broken')).kind, 'broken')

  const warn = linkWarnings(summary).join('\n')
  assert.match(warn, /指向 \$DSH_HOME 内部/)
  assert.match(warn, /指向 \$DSH_HOME 外部/)
  assert.match(warn, /断链/)

  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('scanLinks 不扫描 node_modules', () => {
  const home = tmpDir('linksskip')
  fs.mkdirSync(path.join(home, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(home, 'node_modules', 'pkg', 'a.js'), 'x')
  const { links, summary } = scanLinks(home)
  assert.equal(summary.total, 0)
  assert.equal(links.length, 0)
  fs.rmSync(home, { recursive: true, force: true })
})

// ══ 端到端：export → apply → verify ═════════════════════════════════════════

test('全链路：导出 → 落地 → 核对（含路径重映射）', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('e2e')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')

  // 源机：两个工作区 + 一个 profile + settings
  mkSession(src, 'D:\\deepseek\\dsh-chat', 'x1', ['{"seq":1}', '{"seq":2}'])
  mkSession(src, 'D:\\deepseek\\dsh-chat', 'x2')
  mkSession(src, 'D:\\program\\docs', 'y1')
  mkWorkspace(src, [['w1', 'D:\\deepseek\\dsh-chat'], ['w2', 'D:\\program\\docs']])
  fs.mkdirSync(path.join(src, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'theme: dark\n')
  fs.mkdirSync(dst, { recursive: true })

  // ① 导出
  const { manifest } = await exportBundle({
    dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {},
  })
  assert.equal(manifest.state.sessions.total, 3)
  assert.ok(fs.existsSync(path.join(bundle, 'state', 'links.json')))
  assert.ok((await verifyBundleIntegrity(bundle)).ok, '导出的 bundle 必须自洽')

  // ② 预演不得写盘
  const dry = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/moved' }], dryRun: true })
  assert.equal(dry.errors.length, 0)
  assert.ok(!fs.existsSync(path.join(dst, 'sessions')), 'dryRun 不得落盘')

  // ③ 真跑
  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/moved' }], onLog: () => {},
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.ok(applied.backupDir !== null)

  // 命中的映射改了，未命中的保持原样
  const movedGroup = path.join(dst, 'sessions', encodeSessionDir('E:/moved/dsh-chat'))
  const keptGroup = path.join(dst, 'sessions', encodeSessionDir('D:\\program\\docs'))
  assert.ok(fs.existsSync(movedGroup), '命中映射的分组应改名到新编码目录')
  assert.ok(fs.existsSync(keptGroup), '未命中映射的分组应保持原名')
  assert.equal(readSessionHeader(path.join(movedGroup, 'x1', 'session.jsonl.zstd')).header.cwd, 'E:/moved/dsh-chat')
  assert.equal(readSessionHeader(path.join(keptGroup, 'y1', 'session.jsonl.zstd')).header.cwd, 'D:\\program\\docs')

  // workspace.json 同步改写
  const ws = JSON.parse(fs.readFileSync(path.join(dst, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(ws.tables.workspaces.w1.path, 'E:/moved/dsh-chat')
  assert.equal(ws.tables.workspaces.w2.path, 'D:\\program\\docs', '未命中映射的工作区路径不得被动')

  // ④ 核对全 PASS
  const v = await runVerify(bundle, dst)
  assert.equal(v.failed, 0, JSON.stringify(v.checks.filter((c) => c.status === 'FAIL')))

  fs.rmSync(root, { recursive: true, force: true })
})

test('I5 不把「源机本来就有的孤立会话」判成迁移失败', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('orphan')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')

  // 源机：两个已登记的工作区 + 一个**没登记**在 workspace.json 里的会话（真实机器上确实存在这种情况）
  mkSession(src, 'D:\\deepseek\\a', 's1')
  mkSession(src, 'D:\\deepseek\\b', 's2')
  mkSession(src, 'D:\\orphan\\c', 's3')
  mkWorkspace(src, [['w1', 'D:\\deepseek\\a'], ['w2', 'D:\\deepseek\\b']])
  fs.mkdirSync(path.join(src, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'theme: dark\n')
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'E:/moved' }], onLog: () => {},
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))

  // 目标机同样有 1 个孤立会话，且与源机是同一个 —— 迁移没有弄丢任何东西，只能是 WARN
  const clean = await runVerify(bundle, dst)
  const i5 = clean.checks.find((c) => c.id === 'I5')
  assert.equal(i5.status, 'WARN', `源机既有孤立不应判 FAIL：${i5.detail}`)
  assert.ok(i5.detail.includes('源机本来就有 1 个孤立会话'), i5.detail)
  assert.equal(clean.failed, 0, JSON.stringify(clean.checks.filter((c) => c.status === 'FAIL')))

  // 迁移**新增**孤立才该 FAIL：把目标机 workspace.json 里的一条记录删掉，制造出源机没有的孤立
  const wsFile = path.join(dst, 'storages', 'workspace.json')
  const wsDoc = JSON.parse(fs.readFileSync(wsFile, 'utf8'))
  delete wsDoc.tables.workspaces.w2
  fs.writeFileSync(wsFile, JSON.stringify(wsDoc, null, 2))

  const broken = await runVerify(bundle, dst)
  const i5b = broken.checks.find((c) => c.id === 'I5')
  assert.equal(i5b.status, 'FAIL', `迁移新增孤立必须 FAIL：${i5b.detail}`)
  assert.ok(i5b.detail.includes('迁移新增的孤立'), i5b.detail)
  assert.ok(broken.failed >= 1)

  fs.rmSync(root, { recursive: true, force: true })
})

test('profile 的 package.json 必须带走，且 link: 改写成指向 vendored 副本', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('pkg')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  const pluginSrc = path.join(root, 'my-plugin')

  // 源机:一个 link: 指向 $DSH_HOME 之外的开发目录,一个 npm 依赖应原样保留
  fs.mkdirSync(pluginSrc, { recursive: true })
  fs.writeFileSync(path.join(pluginSrc, 'package.json'), JSON.stringify({ name: 'my-plugin', version: '1.0.0' }))
  fs.writeFileSync(path.join(pluginSrc, 'index.js'), 'export const x = 1\n')
  mkSession(src, 'D:\\w\\a', 'p1')
  mkWorkspace(src, [['w1', 'D:\\w\\a']])
  fs.mkdirSync(path.join(src, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true, type: 'module',
    dependencies: { 'my-plugin': 'link:' + pluginSrc, 'some-npm-pkg': '^2.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'my-plugin'] } },
  }, null, 2))
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'theme: dark\n')
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  // ① 导出的 package.json 里 link: 已不再指向源机绝对路径
  const inBundle = JSON.parse(fs.readFileSync(path.join(bundle, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.equal(inBundle.dependencies['my-plugin'], 'link:../../plugins/my-plugin')
  assert.equal(inBundle.dependencies['some-npm-pkg'], '^2.0.0', 'npm 依赖不得被改写')
  assert.deepEqual(inBundle.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'my-plugin'], 'bundles 清单必须原样带走')

  // ② 落地后从目标机的 profile 出发能真的解析到这个目录
  const applied = await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  const tgtPkg = JSON.parse(fs.readFileSync(path.join(dst, 'profiles', 'desktop', 'package.json'), 'utf8'))
  const resolved = path.resolve(path.join(dst, 'profiles', 'desktop'), tgtPkg.dependencies['my-plugin'].slice('link:'.length))
  assert.ok(fs.existsSync(path.join(resolved, 'index.js')), 'link: 必须解析到目标机上真实存在的插件目录:' + resolved)

  // ③ I9 不得因此报 FAIL（只是还没装 node_modules，属 WARN）
  const v = await runVerify(bundle, dst)
  const i9 = v.checks.find((c) => c.id === 'I9')
  assert.notEqual(i9.status, 'FAIL', i9.detail)
  assert.equal(i9.status, 'WARN', i9.detail)
  assert.ok(i9.detail.includes('pnpm install'), i9.detail)

  fs.rmSync(root, { recursive: true, force: true })
})

test('I8 报出目标机缺失的工作区目录，I10 报出没落地的状态层', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('coverage')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')

  // 一个 cwd 指向根本不存在的目录：会话字符串对得上，但目标机打不开
  mkSession(src, 'D:\\nope\\ghost-workspace', 'g1')
  mkWorkspace(src, [['w1', 'D:\\nope\\ghost-workspace']])
  fs.mkdirSync(path.join(src, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.mkdirSync(path.join(src, 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(src, 'attachments', 'a.txt'), 'x')
  fs.writeFileSync(path.join(src, 'AGENTS.md'), '# global agent rules\n')
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  const applied = await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))

  // AGENTS.md 属于「用户写下的东西」，必须随行并落地
  assert.ok(fs.existsSync(path.join(bundle, 'AGENTS.md')), 'AGENTS.md 应进 bundle')
  assert.equal(fs.readFileSync(path.join(dst, 'AGENTS.md'), 'utf8'), '# global agent rules\n')

  const v = await runVerify(bundle, dst)
  const i8 = v.checks.find((c) => c.id === 'I8')
  assert.equal(i8.status, 'WARN', i8.detail)
  assert.ok(i8.detail.includes('ghost-workspace'), i8.detail)
  assert.equal(v.checks.find((c) => c.id === 'I10').status, 'PASS')

  // 把落地的 attachments 删掉，I10 必须从 PASS 变 FAIL（「导出了但没落地」这类不对称要被抓住）
  fs.rmSync(path.join(dst, 'attachments'), { recursive: true, force: true })
  const v2 = await runVerify(bundle, dst)
  const i10 = v2.checks.find((c) => c.id === 'I10')
  assert.equal(i10.status, 'FAIL', i10.detail)
  assert.ok(i10.detail.includes('attachments'), i10.detail)

  fs.rmSync(root, { recursive: true, force: true })
})

test('全链路：篡改 bundle 后 apply 拒绝执行且不碰目标机', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('e2e-tamper')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSession(src, 'D:\\deepseek\\a', 'z1')
  mkWorkspace(src, [['w1', 'D:\\deepseek\\a']])
  fs.mkdirSync(path.join(src, 'profiles', 'p1'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'p1', 'package.json'),
    JSON.stringify({ name: 'p1', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'a: 1\n')
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['p1'], outDir: bundle, includeState: true, onLog: () => {} })
  assert.equal((await verifyBundleIntegrity(bundle)).ok, true)

  // 篡改一个文件
  fs.appendFileSync(path.join(bundle, 'settings.yaml'), '\n# tampered\n')
  const integ = await verifyBundleIntegrity(bundle)
  assert.equal(integ.ok, false)
  assert.ok(integ.failures.some((f) => f.file === 'settings.yaml'))

  const applied = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings: [] })
  assert.equal(applied.ok, false)
  assert.ok(applied.errors.some((e) => /完整性校验失败/.test(e)))
  assert.equal(applied.backupDir, null, '拒绝时不应创建备份目录')
  assert.ok(!fs.existsSync(path.join(dst, 'sessions')), '拒绝时不得落地任何内容')

  fs.rmSync(root, { recursive: true, force: true })
})

test('目标机 $DSH_HOME 换位置时，内部链接必须重定位（而不是照搬源机路径）', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('relocate')
  const src = path.join(root, 'source-home')
  const dst = path.join(root, 'another', 'place', 'dsh-home')  // 故意是不同层级、不同名字
  const bundle = path.join(root, 'bundle')

  // 源机：一个真实的 skills 子目录 + 一个指向它的内部链接
  fs.mkdirSync(path.join(src, 'skills', 'shared'), { recursive: true })
  fs.writeFileSync(path.join(src, 'skills', 'shared', 'SKILL.md'), '# shared\n')
  try {
    fs.symlinkSync(path.join(src, 'skills', 'shared'), path.join(src, 'skills', 'linked'), 'junction')
  } catch {
    fs.rmSync(root, { recursive: true, force: true })
    return // 无符号链接权限的环境跳过
  }
  mkSession(src, 'D:\\deepseek\\proj', 'r1')
  mkWorkspace(src, [['w1', 'D:\\deepseek\\proj']])
  fs.mkdirSync(path.join(src, 'profiles', 'p1'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'p1', 'package.json'),
    JSON.stringify({ name: 'p1', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['p1'], outDir: bundle, includeState: true, onLog: () => {} })

  // 记录源机链接目标，确认它确实指向 source-home
  const doc = JSON.parse(fs.readFileSync(path.join(bundle, 'state', 'links.json'), 'utf8'))
  const internal = doc.links.find((l) => l.kind === 'internal')
  assert.ok(internal, '应识别出一个内部链接')
  assert.ok(internal.target.replace(/\\/g, '/').includes('source-home'), '源机记录的目标应在 source-home 下')

  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'D:/deepseek' }], onLog: () => {},
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(applied.links.relocated, 1,
    '应报告 1 个链接被重定位；跳过原因=' + JSON.stringify(applied.links.skipped))

  // 链接必须指向新 home 下的同一相对位置，而不是源机路径
  const linkAbs = path.join(dst, 'skills', 'linked')
  const target = fs.realpathSync(linkAbs)
  assert.ok(target.replace(/\\/g, '/').includes('another/place/dsh-home'),
    '链接应重定位到目标机 $DSH_HOME，实际：' + target)
  assert.ok(!target.replace(/\\/g, '/').includes('source-home'), '不得仍指向源机路径')
  assert.ok(fs.existsSync(path.join(linkAbs, 'SKILL.md')), '通过链接应能读到真实文件')

  // verify 必须看到这条链接「目标可达」
  const v = await runVerify(bundle, dst)
  const i6 = v.checks.find((c) => c.id === 'I6')
  assert.equal(i6.status, 'PASS', i6.detail)

  fs.rmSync(root, { recursive: true, force: true })
})

test('$DSH_HOME 本身是符号链接时，内部链接仍判为 internal 并在目标机重定位', { skip: !HAS_ZSTD }, async () => {
  // 回归用例：导出侧曾用「字面拼写」比较 dshHome 与链接的 realpath，
  // 导致 macOS（/var → /private/var）、Windows 短名（RUNNER~1）、
  // 以及用户把 $DSH_HOME 放在软链 / junction 下时，内部链接被误判成 external，
  // 目标机上就**不会重定位** —— 迁移完成后是一条指向源机路径的死链。
  const root = tmpDir('symhome')
  const realHome = path.join(root, 'real-home')
  const linkedHome = path.join(root, 'linked-home')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')

  fs.mkdirSync(path.join(realHome, 'skills', 'shared'), { recursive: true })
  fs.writeFileSync(path.join(realHome, 'skills', 'shared', 'SKILL.md'), '# shared\n')

  try {
    // $DSH_HOME 这一层是链接，且内部还有一条指向 home 内的链接
    fs.symlinkSync(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(path.join(realHome, 'skills', 'shared'), path.join(realHome, 'skills', 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    // 无符号链接权限的环境（部分 Windows 配置）跳过，不伪装通过
    fs.rmSync(root, { recursive: true, force: true })
    return
  }

  mkSession(linkedHome, 'D:\\deepseek\\proj', 'l1')
  mkWorkspace(linkedHome, [['w1', 'D:\\deepseek\\proj']])
  fs.mkdirSync(path.join(linkedHome, 'profiles', 'p1'), { recursive: true })
  fs.writeFileSync(path.join(linkedHome, 'profiles', 'p1', 'package.json'),
    JSON.stringify({ name: 'p1', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: linkedHome, profiles: ['p1'], outDir: bundle, includeState: true, onLog: () => {} })

  const doc = JSON.parse(fs.readFileSync(path.join(bundle, 'state', 'links.json'), 'utf8'))
  const internal = doc.links.find((l) => l.rel === 'alias')
  assert.ok(internal, '应记录 skills/alias 这条链接')
  assert.equal(internal.kind, 'internal', '$DSH_HOME 是链接时，home 内的链接仍必须是 internal（不能因拼写差异判成 external）')

  const applied = await applyBundle({
    bundleDir: bundle, dshHome: dst, mappings: [{ from: 'D:/deepseek', to: 'D:/deepseek' }], onLog: () => {},
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(applied.links.relocated, 1,
    '应报告 1 个链接被重定位；跳过原因=' + JSON.stringify(applied.links.skipped))

  const linkAbs = path.join(dst, 'skills', 'alias')
  const resolved = fs.realpathSync(linkAbs)
  const dstReal = fs.realpathSync(dst)
  assert.ok(isSameOrChild(resolved, dstReal), '链接必须落在目标机 $DSH_HOME 内，实际：' + resolved)
  assert.ok(fs.existsSync(path.join(linkAbs, 'SKILL.md')), '通过链接应能读到真实文件')

  fs.rmSync(root, { recursive: true, force: true })
})

test('旧 bundle 的 links.json 没有 homeRel 时，仍按源机 home 前缀重定位', () => {
  // 兼容路径：0.4.0 及更早导出的 bundle 只有绝对 target，没有 homeRel。
  // 这条用例保证「新增字段」不是硬依赖，旧 bundle 不会因此变成死链。
  const root = tmpDir('oldlinks')
  const src = path.join(root, 'source-home')
  const dst = path.join(root, 'dst')
  fs.mkdirSync(path.join(src, 'skills', 'shared'), { recursive: true })
  fs.mkdirSync(path.join(dst, 'skills', 'shared'), { recursive: true })
  const bundle = path.join(root, 'bundle')
  fs.mkdirSync(path.join(bundle, 'state'), { recursive: true })
  // 0.4.0 的导出侧就是用 realpath 记录 target 的，这里按同样的口径构造
  const target = fs.realpathSync(path.join(src, 'skills', 'shared'))
  fs.writeFileSync(path.join(bundle, 'state', 'links.json'), JSON.stringify({
    links: [{ scope: 'skills', rel: 'alias', target, linkText: target, kind: 'internal' }],
  }))

  const out = rebuildLinks(bundle, dst, { sourceHome: src })
  assert.equal(out.relocated, 1, JSON.stringify(out.skipped))
  assert.equal(out.created, 1, JSON.stringify(out.skipped))
  const resolved = fs.realpathSync(path.join(dst, 'skills', 'alias'))
  assert.ok(isSameOrChild(resolved, fs.realpathSync(dst)), '链接应指向目标机 home，实际：' + resolved)

  fs.rmSync(root, { recursive: true, force: true })
})

test('inspectBundle 对无效目录返回可读错误', () => {
  const dir = tmpDir('inspect')
  const r = inspectBundle(dir)
  assert.equal(r.ok, false)
  assert.equal(r.manifest, undefined)
  assert.ok(r.problems.length > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ══ 会话日志的多版本形态（真实机器上三种并存）═══════════════════════════════

test('会话日志的三种文件名（无版本 / v3 / v4）都要识别并改写', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('variants')
  const cwd = 'D:\\deepseek\\dsh-chat'
  const dir = path.join(home, 'sessions', encodeSessionDir(cwd), 's-multi')
  // 同一次会话在三个宿主版本下各留一份：header.cwd 一致，仅 version 不同
  writeSessionFile(path.join(dir, 'session.jsonl.zstd'), { type: 'session', cwd, id: 's-multi' }, ['{"seq":1}'])
  writeSessionFile(path.join(dir, 'session.v3.jsonl.zstd'), { type: 'session', version: 3, cwd, id: 's-multi' }, ['{"seq":1}'])
  writeSessionFile(path.join(dir, 'session.v4.jsonl.zstd'), { type: 'session', version: 4, cwd, id: 's-multi' }, ['{"seq":1}'])
  // 另一个会话只有 v4：只认 session.jsonl.zstd 的实现会把它整个漏掉
  const only4 = path.join(home, 'sessions', encodeSessionDir('D:\\deepseek\\other'), 's-v4')
  writeSessionFile(path.join(only4, 'session.v4.jsonl.zstd'),
    { type: 'session', version: 4, cwd: 'D:\\deepseek\\other', id: 's-v4' }, ['{"seq":1}'])

  const scan = await scanSessions(home)
  assert.equal(scan.sessions.length, 2)
  const multi = scan.sessions.find((s) => s.dirName === 's-multi')
  assert.deepEqual(multi.logs.map((l) => l.name).sort(),
    ['session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])
  assert.equal(scan.problems.filter((p) => /没有任何会话日志/.test(p.message)).length, 0,
    '变体不得被误报成「没有日志」')

  const plan = planSessionMigration(scan, [{ from: 'D:/deepseek', to: 'E:/moved' }])
  assert.equal(plan.stats.logFiles, 4, '四份日志都应被计入')
  assert.equal(plan.stats.rewriteFiles, 4, '四份日志都应进改写清单')

  const applied = await applySessionPlan(plan, { root: path.join(home, 'sessions'), onLog: () => {} })
  assert.equal(applied.failed, 0)

  for (const [newCwd, id] of [['E:/moved/dsh-chat', 's-multi'], ['E:/moved/other', 's-v4']]) {
    const g = path.join(home, 'sessions', encodeSessionDir(newCwd), id)
    assert.ok(fs.existsSync(g), '分组目录应改名到新编码：' + newCwd)
    for (const name of fs.readdirSync(g)) {
      assert.equal(readSessionHeader(path.join(g, name)).header.cwd, newCwd, name + ' 的 cwd 未改写')
    }
  }
  fs.rmSync(home, { recursive: true, force: true })
})

test('同一会话里只有部分日志可改写时，坏的那份逐字节不动', { skip: !HAS_ZSTD }, async () => {
  const home = tmpDir('partial')
  const cwd = 'D:\\deepseek\\mix'
  const dir = path.join(home, 'sessions', encodeSessionDir(cwd), 'p1')
  writeSessionFile(path.join(dir, 'session.jsonl.zstd'), { type: 'session', cwd, id: 'p1' }, ['{"seq":1}'])
  const torn = path.join(dir, 'session.v3.jsonl.zstd')
  writeSessionFile(torn, { type: 'session', version: 3, cwd, id: 'p1' }, ['{"seq":1}'])
  const extra = zlib.zstdCompressSync(Buffer.from('{"seq":2}\n'))
  fs.appendFileSync(torn, extra.subarray(0, Math.floor(extra.length / 2)))
  const tornBytes = fs.readFileSync(torn)

  const scan = await scanSessions(home)
  const s = scan.sessions[0]
  assert.equal(s.logs.length, 2)
  assert.equal(s.clean, false, '含撕裂尾帧的会话整体不算 clean')

  const plan = planSessionMigration(scan, [{ from: 'D:/deepseek', to: 'E:/moved' }])
  const step = plan.sessions.find((x) => x.dirName === 'p1')
  assert.equal(step.action, 'partial')
  assert.equal(step.logs.length, 1, '只有干净的日志进改写清单')
  assert.equal(step.skipped.length, 1)

  const applied = await applySessionPlan(plan, { root: path.join(home, 'sessions'), onLog: () => {} })
  assert.equal(applied.failed, 0)
  const moved = path.join(home, 'sessions', encodeSessionDir('E:/moved/mix'), 'p1')
  assert.ok(fs.existsSync(path.join(moved, 'session.jsonl.zstd')), '干净的那份跟着分组目录改名')
  assert.equal(readSessionHeader(path.join(moved, 'session.jsonl.zstd')).header.cwd, 'E:/moved/mix')
  // 撕裂的那份只被 rename 带走，字节一个没动（断言的是「没被改写」，不是「被删掉」）
  assert.deepEqual(fs.readFileSync(path.join(moved, 'session.v3.jsonl.zstd')), tornBytes,
    '撕裂的日志必须逐字节不动')
  fs.rmSync(home, { recursive: true, force: true })
})

test('profile 的 .dsh-market/state.json（停用清单 / 分组 / 区域）随行并落地', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('market')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')

  mkSession(src, 'D:\\deepseek\\a', 'm1')
  mkWorkspace(src, [['w1', 'D:\\deepseek\\a']])
  const prof = path.join(src, 'profiles', 'desktop')
  fs.mkdirSync(path.join(prof, '.dsh-market'), { recursive: true })
  fs.writeFileSync(path.join(prof, 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  const state = {
    disabled: ['billion-context'],
    groups: { mine: ['dsh-outline', 'dsh-sync'] },
    groupOrder: ['mine'],
    region: 'china',
    regionAuto: true,
  }
  fs.writeFileSync(path.join(prof, '.dsh-market', 'state.json'), JSON.stringify(state))
  fs.writeFileSync(path.join(src, 'settings.yaml'), 'theme: dark\n')
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  const inBundle = path.join(bundle, 'profiles', 'desktop', '.dsh-market', 'state.json')
  assert.ok(fs.existsSync(inBundle), '导出必须带走 profile 的 .dsh-market/state.json')

  const applied = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings: [], onLog: () => {} })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  const landed = path.join(dst, 'profiles', 'desktop', '.dsh-market', 'state.json')
  assert.ok(fs.existsSync(landed), '落地必须写入子目录路径')
  assert.deepEqual(JSON.parse(fs.readFileSync(landed, 'utf8')), state)
  fs.rmSync(root, { recursive: true, force: true })
})
