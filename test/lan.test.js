// test/lan.test.js — 局域网直传的纯逻辑层：帧、进度、配对码。
//
// 钉的都是「真实会出问题」的形态，不是覆盖率：
//   · 帧在任意分块下都必须解析成同一串结果（对端 socket 的分块大小不受我们控制）；
//   · 半帧必须报错而不是静默丢（否则接收端会写出一批截断文件还显示成功）；
//   · 速率窗口不能被冷启动污染（配对等待期不该计入传输速率，否则 ETA 一开头就乱跳）；
//   · 配对码只能用一次、5 次试错锁定（否则被投屏看到的码可以反复用）。
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { FRAME } from '../lib/lan/constants.js'
import { decodeFrames, encodeFrame, encodeFrameHeader, readFrames } from '../lib/lan/frame.js'
import { createPairGate, generateCode, normalizeCode, safeEqual } from '../lib/lan/pair.js'
import { createProgress, formatBytes, formatDuration, summarizeProgress } from '../lib/lan/progress.js'

// ── 帧 ──────────────────────────────────────────────────────────────────────

test('帧：编解码往返，JSON 帧与裸字节帧都还原', () => {
  const buf = Buffer.concat([
    encodeFrame(FRAME.FILE, { path: 'a/b.txt', size: 3, sha256: 'x' }),
    encodeFrame(FRAME.DATA, Buffer.from('abc')),
    encodeFrame(FRAME.FEND, { path: 'a/b.txt' }),
    encodeFrame(FRAME.DONE, { files: 1, bytes: 3 }),
  ])
  const frames = decodeFrames(buf)
  assert.equal(frames.length, 4)
  assert.equal(frames[0].type, FRAME.FILE)
  assert.equal(frames[0].json.path, 'a/b.txt')
  assert.equal(frames[1].type, FRAME.DATA)
  assert.equal(frames[1].json, null, 'DATA 帧不做 JSON 解析')
  assert.equal(frames[1].payload.toString(), 'abc')
  assert.equal(frames[3].json.files, 1)
})

test('帧：空载荷与中文路径都能过', () => {
  const frames = decodeFrames(Buffer.concat([
    encodeFrame(FRAME.DATA, Buffer.alloc(0)),
    encodeFrame(FRAME.FILE, { path: '状态/会话.jsonl.zstd' }),
  ]))
  assert.equal(frames[0].payload.length, 0)
  assert.equal(frames[1].json.path, '状态/会话.jsonl.zstd')
})

test('帧：任意分块大小的解析结果与整块一致（socket 分块不由我们决定）', async () => {
  const parts = [
    encodeFrame(FRAME.FILE, { path: 'x', size: 5 }),
    encodeFrame(FRAME.DATA, Buffer.from('hello')),
    encodeFrame(FRAME.FEND, { path: 'x' }),
    encodeFrame(FRAME.DONE, { files: 1 }),
  ]
  const whole = Buffer.concat(parts)
  const expected = decodeFrames(whole).map((f) => ({ type: f.type, payload: f.payload.toString('base64') }))

  for (const size of [1, 2, 3, 7, 9, 13, 64, 1000]) {
    const chunks = []
    for (let i = 0; i < whole.length; i += size) chunks.push(whole.subarray(i, i + size))
    const got = []
    for await (const f of readFrames(Readable.from(chunks))) {
      got.push({ type: f.type, payload: f.payload.toString('base64') })
    }
    assert.deepEqual(got, expected, '分块 ' + size + ' 字节时结果必须一致')
  }
})

test('帧：半帧必须报错，不能静默丢（否则接收端写出一批截断文件还显示成功）', async () => {
  const whole = Buffer.concat([
    encodeFrame(FRAME.FILE, { path: 'x', size: 10 }),
    encodeFrame(FRAME.DATA, Buffer.from('0123456789')),
  ])
  const cut = whole.subarray(0, whole.length - 4)
  await assert.rejects(async () => {
    for await (const _ of readFrames(Readable.from([cut]))) { /* 消费掉 */ }
  }, /mid-frame/)
})

test('帧：magic 不对时给出可读原因（端口被别的服务占了是最常见的情形）', async () => {
  await assert.rejects(async () => {
    for await (const _ of readFrames(Readable.from([Buffer.from('HTTP/1.1 200 OK\r\n\r\n')]))) { /* 消费掉 */ }
  }, /对端不是 dsh-sync|bad magic/)
})

test('帧：载荷超过上限立即拒绝，不先分配内存', async () => {
  const head = encodeFrameHeader(FRAME.DATA, 10)
  head.writeUInt32BE(999_999_999, 5)
  await assert.rejects(async () => {
    for await (const _ of readFrames(Readable.from([head]), { maxPayload: 1024 })) { /* 消费掉 */ }
  }, /exceeds cap/)
})

test('帧：非 JSON 载荷的 JSON 帧报错时带上帧类型', () => {
  const bad = Buffer.concat([encodeFrameHeader(FRAME.FILE, 3), Buffer.from('{{{')])
  assert.throws(() => decodeFrames(bad), /type 1 payload is not valid JSON/)
})

// ── 进度 ────────────────────────────────────────────────────────────────────

test('进度：字节与文件两条进度同时推进，百分数以字节为准', () => {
  const clock = { t: 1000 }
  const p = createProgress({ totalFiles: 4, totalBytes: 1000, now: () => clock.t })
  p.setPhase('transferring')
  p.fileStart('a', 400)
  p.addBytes(400)
  p.fileDone()
  p.fileStart('b', 600)
  p.addBytes(100)
  const snap = p.snapshot()
  assert.equal(snap.phase, 'transferring')
  assert.equal(snap.files.done, 1)
  assert.equal(snap.files.total, 4)
  assert.equal(snap.bytes.done, 500)
  assert.equal(snap.bytes.total, 1000)
  assert.equal(snap.percent, 50)
})

test('进度：速率用滑动窗口，配对等待期不计入（否则 ETA 一开头就乱跳）', () => {
  const clock = { t: 10_000 }
  // 总量 20 KB、只传 10 KB：留一半剩余，ETA 才有可断言的值。
  const p = createProgress({ totalBytes: 20_000, windowMs: 3000, now: () => clock.t })
  p.setPhase('waiting')
  // 等 20 秒没有任何字节
  clock.t += 20_000
  assert.equal(p.snapshot().bps, 0, '等待期不该算出速率')

  p.setPhase('transferring')
  for (let i = 0; i < 10; i++) {
    clock.t += 100
    p.addBytes(1000)   // 9 个间隔 1000 B / 900ms ≈ 10 KB/s
  }
  const snap = p.snapshot()
  assert.ok(snap.bps >= 9000 && snap.bps <= 11_000, '速率应在 10KB/s 附近，实际 ' + snap.bps)
  assert.ok(snap.etaMs >= 800 && snap.etaMs <= 1200, '剩余 10KB 按 10KB/s 约 1 秒，实际 ' + snap.etaMs)
})

test('进度：续传跳过的文件计入完成但不算传输量', () => {
  const p = createProgress({ totalFiles: 2, totalBytes: 1000 })
  p.fileSkipped(800)
  p.addBytes(200)
  p.fileDone()
  const snap = p.snapshot()
  assert.equal(snap.files.done, 2)
  assert.equal(snap.files.skipped, 1)
  assert.equal(snap.bytes.done, 1000)
  assert.equal(snap.percent, 100)
})

test('进度：总量未知时不除零，也不谎报 100%', () => {
  const p = createProgress({})
  p.setPhase('transferring')
  p.addBytes(500)
  const snap = p.snapshot()
  assert.equal(snap.percent, 0)
  assert.equal(snap.bytes.total, 0)
  // 结束时回填总量，避免停在 99%
  p.finalize()
  assert.equal(p.snapshot().percent, 100)
})

test('进度：formatBytes / formatDuration / summarizeProgress 稳定输出', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1536), '1.50 KB')
  assert.equal(formatBytes(23 * 1024 * 1024), '23.0 MB')
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(125_000), '2m 5s')
  const p = createProgress({ totalFiles: 2, totalBytes: 2048 })
  p.fileDone(); p.fileDone()
  const text = summarizeProgress(p.snapshot())
  assert.match(text, /2\/2 个文件/)
  assert.match(text, /2\.00 KB/)
})

// ── 配对 ────────────────────────────────────────────────────────────────────

test('配对码：6 位数字且补前导零', () => {
  assert.equal(generateCode(() => 7), '000007')
  assert.equal(generateCode(() => 999_999), '999999')
  assert.match(generateCode(), /^\d{6}$/)
})

test('配对码：用户输成 123 456 / 123-456 也能对上', () => {
  const gate = createPairGate({ randomInt: () => 123456, randomToken: () => 'tok' })
  assert.equal(gate.code, '123456')
  assert.equal(normalizeCode(' 123 456 '), '123456')
  assert.equal(gate.attempt('123 456').ok, true)
})

test('配对码：错了要报剩余次数，用完就锁死', () => {
  const gate = createPairGate({ randomInt: () => 111111, maxAttempts: 3 })
  const r1 = gate.attempt('000000')
  assert.equal(r1.ok, false)
  assert.equal(r1.reason, 'wrong')
  assert.equal(r1.remainingAttempts, 2)
  gate.attempt('000001')
  const r3 = gate.attempt('000002')
  assert.equal(r3.reason, 'locked')
  // 锁死之后连正确的码都不放行 —— 否则「锁定」就没有意义了
  assert.equal(gate.attempt('111111').reason, 'locked')
})

test('配对码：过期后不放行，且能报出「过期」而不是「错」', () => {
  const clock = { t: 0 }
  const gate = createPairGate({ randomInt: () => 424242, ttlMs: 60_000, now: () => clock.t })
  clock.t = 59_000
  assert.equal(gate.remainingMs(), 1000)
  clock.t = 60_001
  assert.equal(gate.attempt('424242').reason, 'expired')
})

test('配对码：换一台机器就不能再用同一个码（投屏泄漏后不能被二次利用）', () => {
  const gate = createPairGate({ randomInt: () => 202020, randomToken: () => 'token-a' })
  const first = gate.attempt('202020', { requester: '192.168.1.10' })
  assert.equal(first.ok, true)
  assert.equal(first.token, 'token-a')

  const fromElsewhere = gate.attempt('202020', { requester: '192.168.1.99' })
  assert.equal(fromElsewhere.ok, false)
  assert.equal(fromElsewhere.reason, 'used')

  // 没有来源信息时也不放行：宁可让用户 renew，也不要在信息不足时放宽
  const anonymous = gate.attempt('202020')
  assert.equal(anonymous.ok, false)
  assert.equal(anonymous.reason, 'used')
})

test('配对码：同一台机器可以复用同一个码续传（否则「传一半断了」永远接不上）', () => {
  const gate = createPairGate({ randomInt: () => 202020, randomToken: () => 'token-a' })
  const first = gate.attempt('202020', { requester: '192.168.1.10' })
  assert.equal(first.ok, true)

  const retry = gate.attempt('202020', { requester: '192.168.1.10' })
  assert.equal(retry.ok, true, '同一来源重试必须放行，这是续传的前提')
  assert.equal(retry.reused, true)
  assert.equal(retry.token, 'token-a', '复用应当沿用同一个 token，否则上一次刚发的流会被判无效')

  // 复用不等于无限期：码本身仍然 5 分钟到期
  const clock = { t: 0 }
  const g2 = createPairGate({ randomInt: () => 111222, ttlMs: 1000, now: () => clock.t })
  g2.attempt('111222', { requester: '10.0.0.5' })
  clock.t = 1001
  assert.equal(g2.attempt('111222', { requester: '10.0.0.5' }).reason, 'expired')
})

test('配对码：换码后旧 token 立刻失效', () => {
  const gate = createPairGate({ randomInt: () => 123123, randomToken: () => 'old' })
  gate.attempt('123123')
  assert.equal(gate.validateToken('old'), true)
  gate.regenerate()
  assert.equal(gate.validateToken('old'), false, '换码必须让旧会话一起作废')
  assert.equal(gate.status().used, false)
})

test('配对码：status 不泄漏 token', () => {
  const gate = createPairGate({ randomInt: () => 333333, randomToken: () => 'super-secret' })
  gate.attempt('333333')
  const s = gate.status()
  assert.equal(s.used, true)
  assert.ok(!JSON.stringify(s).includes('super-secret'), '状态对象里不能出现 token')
})

test('safeEqual：等长才比较，等值才为真', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', ''), true)
})

// ── 工具注册冒烟 ────────────────────────────────────────────────────────────
// defineTool 在**定义时**就校验参数与输出 schema，所以「能注册上」本身是一条有效断言：
// 参数类型写错、output 里漏了 required、additionalProperties 与字段不匹配，
// 都会在这里就炸，而不是等到用户在界面上点某个工具时才失败。
test('七个工具都能被宿主接受并注册（含 LAN 四个）', async () => {
  const registered = []
  const mod = await import('../index.js')
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {} },
    inject: () => {},
    effect: () => {},
    get: () => undefined,
  }
  mod.apply(ctx, {})
  const names = registered.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'dshsync_apply',
    'dshsync_export',
    'dshsync_lan_discover',
    'dshsync_lan_host',
    'dshsync_lan_pull',
    'dshsync_lan_status',
    'dshsync_verify',
  ])
  for (const t of registered) {
    assert.ok(t.description && t.description.length > 40, t.name + ' 的描述要够长，模型才选得对')
  }
})
