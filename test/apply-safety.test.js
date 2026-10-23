// test/apply-safety.test.js — 落地安全性的两条硬约束：
//   ① 重跑 apply 必须幂等（不留「旧目录名 + 新 cwd」的孤儿分组）
//   ② 宿主回写必须可检测（落地期间当场抓、落地之后靠回执抓）
// 全部使用合成数据（自建 zstd 多帧文件），不读取真实 $DSH_HOME，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

import { encodeSessionDir, readWorkspacePaths } from '../lib/session-migrate.js'
import { readSessionHeader, zstdAvailable } from '../lib/zstd-frame.js'
import { exportBundle } from '../lib/bundle.js'
import { applyBundle } from '../lib/apply-engine.js'
import { runVerify } from '../lib/verify-engine.js'
import { APPLY_RECEIPT_FILE } from '../lib/constants.js'

const HAS_ZSTD = zstdAvailable()

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-safety-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

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

/** 建一个「源机 → bundle → 目标机」的标准三件套。 */
function mkSource(dshHome, cwds, settings = 'theme: dark\n') {
  cwds.forEach((cwd, i) => mkSession(dshHome, cwd, 's' + (i + 1)))
  mkWorkspace(dshHome, cwds.map((cwd, i) => ['w' + (i + 1), cwd]))
  fs.mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), settings)
}

/** 目标机 sessions 下的分组目录名（只看目录，不递归）。 */
function groupDirs(dshHome) {
  const base = path.join(dshHome, 'sessions')
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory()).sort()
}

/** 目标机全部会话（分组/会话 id → header.cwd），用来判定翻倍与孤儿。 */
function allSessions(dshHome) {
  const base = path.join(dshHome, 'sessions')
  const out = []
  if (!fs.existsSync(base)) return out
  for (const g of fs.readdirSync(base)) {
    const gd = path.join(base, g)
    if (!fs.statSync(gd).isDirectory()) continue
    for (const id of fs.readdirSync(gd)) {
      const sd = path.join(gd, id)
      if (!fs.statSync(sd).isDirectory()) continue
      const f = path.join(sd, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const read = readSessionHeader(f)
      out.push({ group: g, id, cwd: read.ok ? read.header.cwd : null })
    }
  }
  return out
}

// ══ ① 重跑幂等 ═════════════════════════════════════════════════════════════

test('重跑 apply 不翻倍：第二次落地跳过已是迁移后状态的会话', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('idem')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\dsh-chat', 'D:\\deepseek\\dsh-plugin'])
  fs.mkdirSync(dst, { recursive: true })

  const mappings = [{ from: 'D:/deepseek', to: 'E:/moved' }]
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  const first = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings, onLog: () => {} })
  assert.equal(first.ok, true, JSON.stringify(first.errors))
  const afterFirst = allSessions(dst)
  assert.equal(afterFirst.length, 2)
  // 首次落地：两个分组都改名到新编码
  assert.deepEqual(groupDirs(dst), [encodeSessionDir('E:/moved/dsh-chat'), encodeSessionDir('E:/moved/dsh-plugin')].sort())

  // 官方恢复路径就是「按 nextSteps 修好后重跑」——这一步在 0.13.1 之前会翻倍
  const second = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings, onLog: () => {} })
  assert.equal(second.ok, true, JSON.stringify(second.errors))
  assert.ok(second.sessions.alreadyMigrated >= 1,
    `重跑必须报告跳过了已迁移的会话，实际 alreadyMigrated=${String(second.sessions && second.sessions.alreadyMigrated)}`)

  const afterSecond = allSessions(dst)
  assert.equal(afterSecond.length, 2, `会话不得翻倍：${JSON.stringify(afterSecond)}`)
  assert.deepEqual(groupDirs(dst), [encodeSessionDir('E:/moved/dsh-chat'), encodeSessionDir('E:/moved/dsh-plugin')].sort(),
    '不得留下旧编码的孤儿分组')

  // 目录名必须与 cwd 编码一致（verify 的 I3 判的就是这个）
  for (const s of afterSecond) assert.equal(s.group, encodeSessionDir(s.cwd), `孤儿分组：${JSON.stringify(s)}`)

  const v = await runVerify(bundle, dst)
  assert.equal(v.failed, 0, JSON.stringify(v.checks.filter((c) => c.status === 'FAIL')))

  fs.rmSync(root, { recursive: true, force: true })
})

test('重跑不覆盖目标机在迁移后新增的聊天帧', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('idem-append')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\dsh-chat'])
  fs.mkdirSync(dst, { recursive: true })

  const mappings = [{ from: 'D:/deepseek', to: 'E:/moved' }]
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  await applyBundle({ bundleDir: bundle, dshHome: dst, mappings, onLog: () => {} })

  // 迁移完成后用户在新机上继续聊了这个会话 —— 宿主往同一个文件里追加了帧
  const target = path.join(dst, 'sessions', encodeSessionDir('E:/moved/dsh-chat'), 's1', 'session.jsonl.zstd')
  assert.ok(fs.existsSync(target))
  const grown = fs.readFileSync(target)
  const extra = zlib.zstdCompressSync(Buffer.from('{"seq":99,"note":"新机上聊的"}\n', 'utf8'))
  fs.writeFileSync(target, Buffer.concat([grown, extra]))

  const second = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings, onLog: () => {} })
  assert.equal(second.ok, true, JSON.stringify(second.errors))

  // 跳过复制意味着新帧还在：这一帧丢了就是丢历史
  const after = fs.readFileSync(target, 'utf8')
  assert.ok(after.includes('新机上聊的'), '重跑不得抹掉目标机新增的事件帧')

  fs.rmSync(root, { recursive: true, force: true })
})

test('上次中断留下的「已迁移分组但缺个别会话」会被补齐，而不是整组重来', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('idem-partial')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  // 同组两个会话：s1 已落地、s2 还没（上次跑到一半中断）
  mkSource(src, ['D:\\deepseek\\dsh-chat'])
  mkSession(src, 'D:\\deepseek\\dsh-chat', 's2')
  fs.mkdirSync(dst, { recursive: true })

  const mappings = [{ from: 'D:/deepseek', to: 'E:/moved' }]
  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  // 手工造一个「上次已经建好新分组并改写了一个会话、第二个会话还没搬过来」的中间态
  const newGroup = path.join(dst, 'sessions', encodeSessionDir('E:/moved/dsh-chat'))
  writeSessionFile(path.join(newGroup, 's1', 'session.jsonl.zstd'), {
    type: 'session', version: 0, id: 's1', createdAt: 1700000000000, cwd: 'E:/moved/dsh-chat', delegationDepth: 0, agentPreset: 'standard',
  }, ['{"seq":1}'])

  const applied = await applyBundle({ bundleDir: bundle, dshHome: dst, mappings, onLog: () => {} })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  const got = allSessions(dst)
  assert.equal(got.length, 2, `缺的那个会话要被补进新分组，实际 ${JSON.stringify(got)}`)
  assert.deepEqual(groupDirs(dst), [encodeSessionDir('E:/moved/dsh-chat')],
    '补齐必须落进新分组，不能另起旧编码目录')
  assert.equal(applied.sessions.alreadyMigrated, 1, '已落地的那个应被判为跳过，不是重复制一遍')

  fs.rmSync(root, { recursive: true, force: true })
})

// ══ ② 宿主回写检测 ═════════════════════════════════════════════════════════

test('apply 写落地回执，且回执里的指纹等于落地后的磁盘内容', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('receipt')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\a'])
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })

  const receiptPath = path.join(dst, APPLY_RECEIPT_FILE)
  assert.ok(fs.existsSync(receiptPath), '落地必须留下回执，否则 I13 无从判断')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  assert.ok(receipt.appliedAt, '回执要带落地时间')
  assert.ok(receipt.files && typeof receipt.files === 'object')

  // 关键文件都在回执里：settings 与 workspace.json 是宿主回写的主要目标
  assert.ok(receipt.files['settings.yaml'], 'settings.yaml 必须在回执里')
  assert.ok(receipt.files['storages/workspace.json'], 'workspace.json 必须在回执里')

  for (const [rel, expected] of Object.entries(receipt.files)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dst, rel))).digest('hex')
    assert.equal(actual, expected, `回执指纹与磁盘不符：${rel}`)
  }

  fs.rmSync(root, { recursive: true, force: true })
})

test('I13：落地后宿主把 settings 写回旧值 → FAIL 且指名文件', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('i13-fail')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\a'])
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })

  const clean = await runVerify(bundle, dst)
  assert.equal(clean.checks.find((c) => c.id === 'I13').status, 'PASS')

  // 模拟宿主把内存里的旧配置写回（这是「迁移成功、重启后设置全变旧」的成因）
  fs.writeFileSync(path.join(dst, 'settings.yaml'), 'theme: light  # 宿主写回的旧值\n')
  const dirty = await runVerify(bundle, dst)
  const i13 = dirty.checks.find((c) => c.id === 'I13')
  assert.equal(i13.status, 'FAIL', i13.detail)
  assert.ok(i13.detail.includes('settings.yaml'), `必须指名是哪个文件：${i13.detail}`)
  assert.ok(i13.detail.includes('托盘'), `要告诉用户怎么救：${i13.detail}`)

  fs.rmSync(root, { recursive: true, force: true })
})

test('I13：宿主原样重写（内容没变）不误报', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('i13-noop')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\a'])
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })

  // 宿主每隔一段时间会重写一次配置；只要内容一样就不该报警，否则 I13 天天 FAIL
  for (const rel of ['settings.yaml', 'storages/workspace.json']) {
    const p = path.join(dst, rel)
    const body = fs.readFileSync(p)
    fs.writeFileSync(p, body)
  }
  const v = await runVerify(bundle, dst)
  assert.equal(v.checks.find((c) => c.id === 'I13').status, 'PASS', '内容未变的重写不得判 FAIL')

  fs.rmSync(root, { recursive: true, force: true })
})

test('I13：没有落地回执时 WARN 并说明原因，不假判 PASS', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('i13-missing')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\a'])
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })

  // 手工落地（U 盘拷贝 + 自己 apply 的旧版本）不会有回执
  fs.rmSync(path.join(dst, APPLY_RECEIPT_FILE))
  const v = await runVerify(bundle, dst)
  const i13 = v.checks.find((c) => c.id === 'I13')
  assert.equal(i13.status, 'WARN', i13.detail)
  assert.ok(i13.detail.includes('回执'), i13.detail)
  assert.equal(v.failed, 0, '缺回执只是无法检测，不等于迁移失败')

  fs.rmSync(root, { recursive: true, force: true })
})

test('落地期间的并发回写当场被抓：apply 判失败并报错', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('drift-live')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\a'])
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })

  // onLog 是 apply 内部的同步钩子：等它说「settings.yaml 已落地」之后再动手改，
  // 就等价于「宿主在 apply 跑到一半时把内存里的旧配置写回」。
  let tampered = false
  const applied = await applyBundle({
    bundleDir: bundle,
    dshHome: dst,
    onLog: (line) => {
      if (tampered || !String(line).includes('settings.yaml 已落地')) return
      tampered = true
      fs.writeFileSync(path.join(dst, 'settings.yaml'), 'theme: light  # 宿主抢在 apply 之后写回\n')
    },
  })
  assert.ok(tampered, '这一轮必须真的发生了并发回写，否则本测试什么也没测')
  assert.equal(applied.ok, false, '落地期间被回写必须判失败，不能装作成功')
  assert.ok(applied.errors.some((e) => String(e).includes('[回写]') && String(e).includes('settings.yaml')),
    JSON.stringify(applied.errors))
  assert.ok(applied.errors.some((e) => String(e).includes('托盘')), '错误里要说清怎么救')

  fs.rmSync(root, { recursive: true, force: true })
})

test('正常落地不误报回写（回写检测只在真的漂移时响）', { skip: !HAS_ZSTD }, async () => {
  const root = tmpDir('drift-clean')
  const src = path.join(root, 'src')
  const dst = path.join(root, 'dst')
  const bundle = path.join(root, 'bundle')
  mkSource(src, ['D:\\deepseek\\a', 'D:\\deepseek\\b'])
  fs.mkdirSync(dst, { recursive: true })

  await exportBundle({ dshHome: src, profiles: ['desktop'], outDir: bundle, includeState: true, onLog: () => {} })
  const applied = await applyBundle({ bundleDir: bundle, dshHome: dst, onLog: () => {} })
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.ok(!applied.errors.some((e) => String(e).includes('[回写]')), JSON.stringify(applied.errors))

  fs.rmSync(root, { recursive: true, force: true })
})

// ══ ③ 术语一致性（源机 = 旧机）══════════════════════════════════════════════

test('GUIDANCE 明确定义源机 = 旧机，不留二义', async () => {
  // GUIDANCE 是给 AI 看的系统提示，不导出——直接读源码文本断言，避免为测试改生产代码
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.js'), 'utf8')
  const start = src.indexOf('## Migrate an entire dsh installation between machines')
  assert.ok(start > -1, 'GUIDANCE 起始标记变了，本测试要跟着改')
  const end = src.indexOf('`;', start)   // GUIDANCE 是模板字面量，以 `;` 收尾
  assert.ok(end > start, '找不到 GUIDANCE 结束标记')
  const body = src.slice(start, end)
  assert.ok(/Terminology/i.test(body), 'GUIDANCE 应带术语段标题')
  assert.ok(/the source machine .* is the old machine/i.test(body)
    || /source machine \(源机\) is the OLD machine/i.test(body), '必须直说 source = 旧机')
  assert.ok(body.includes('旧机'), '中文侧也要出现旧机')
  assert.ok(/new machine/i.test(body), '目标机 = 新机也要说清')
})
