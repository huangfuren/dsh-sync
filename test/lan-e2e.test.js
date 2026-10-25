// test/lan-e2e.test.js — 局域网直传的端到端：真起 HTTP 服务、真配对、真拉流、真落盘。
//
// 这里不 mock 网络，因为要钉住的正是「网络那一层」的行为：
//   · 未经本机确认的拉取必须被拒（配对码泄漏不等于授权）；
//   · 收到的字节必须与原文件逐字节一致、哈希对得上；
//   · 帧里的恶意路径不能写到目标目录之外；
//   · 中断后重跑要能续传，且跳过判断依据是哈希而不是大小。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { pullBundle, safeRelPath } from '../lib/lan/client.js'
import { encryptBuffer } from '../lib/crypto.js'
import { discoverDevices, toDevice } from '../lib/lan/discovery.js'
import { FRAME } from '../lib/lan/constants.js'
import { readFrames } from '../lib/lan/frame.js'
import { isPrivateAddress, loadBundleIndex, startHost } from '../lib/lan/host.js'
import { openStream, requestJson } from '../lib/lan/net.js'
import { createProgress } from '../lib/lan/progress.js'

function tmpDir(prefix) {
  const dir = path.join(os.tmpdir(), 'dshsync-lan-' + prefix + '-' + crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 造一个最小但结构真实的 bundle：有 manifest、有 checksums、有嵌套目录与二进制内容。 */
function makeBundle(dir, manifestExtra = {}) {
  const files = {
    'manifest.json': JSON.stringify({
      format: 'dsh-sync-bundle', formatVersion: 2, workspaces: [], profiles: [],
      // 计数类测试按需注入（plugins/workspaces/state...）；默认 manifest 刻意不带
      // workspaces —— 一旦带上，apply 就会要求 workspaceRoot，pull 全程会走不到头。
      ...manifestExtra,
    }),
    'settings.yaml': 'theme: dark\nlocale: zh-CN\n',
    'state/skills/alpha/SKILL.md': '# alpha\n',
    'state/sessions/abc/def/session.jsonl.zstd': Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5]),
    'state/storages/workspace.json': JSON.stringify({ tables: { workspaces: { w1: { path: 'D:/proj/a' } } } }),
  }
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const entries = {}
  for (const rel of Object.keys(files)) {
    entries[rel] = sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))))
  }
  fs.writeFileSync(path.join(dir, 'checksums.json'),
    JSON.stringify({ algorithm: 'sha256', generatedAt: new Date().toISOString(), entries }, null, 2))
  return { files, entries }
}

/** 用真实协议把流收完并落盘，返回收到的文件清单。 */
async function receiveStream(host, port, sessionId, token, destDir, skip = []) {
  const body = Buffer.from(JSON.stringify({ sessionId, token, skip }), 'utf8')
  const { res, req } = await openStream({
    host, port, method: 'POST', path: '/stream',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    body, timeoutMs: 20_000,
  })
  assert.equal(res.statusCode, 200, '开流应当成功')
  res.on('error', () => {})
  const got = []
  let current = null
  for await (const frame of readFrames(res)) {
    if (frame.type === FRAME.FILE) {
      const meta = frame.json
      const abs = safeRelPath(destDir, meta.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      current = { rel: meta.path, abs, hash: crypto.createHash('sha256'), chunks: [], expected: meta.sha256 }
    } else if (frame.type === FRAME.DATA) {
      current.hash.update(frame.payload)
      current.chunks.push(frame.payload)
    } else if (frame.type === FRAME.FEND) {
      const actual = current.hash.digest('hex')
      assert.equal(actual, current.expected, '每个文件的哈希都应与清单一致：' + current.rel)
      fs.writeFileSync(current.abs, Buffer.concat(current.chunks))
      got.push(current.rel)
      current = null
    } else if (frame.type === FRAME.DONE) {
      assert.ok(frame.json.files >= 0)
    } else if (frame.type === FRAME.ERR) {
      throw new Error('服务端报错：' + (frame.json && frame.json.message))
    }
  }
  req.destroy()
  return got
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

test('safeRelPath：合法相对路径正常映射', () => {
  const root = tmpDir('safe')
  assert.ok(safeRelPath(root, 'a/b.txt').endsWith(path.join('a', 'b.txt')))
  assert.ok(safeRelPath(root, 'state/sessions/x/y.zstd').includes('sessions'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('safeRelPath：绝对路径、盘符、UNC、.. 绕路全部拒绝', () => {
  const root = tmpDir('safe-bad')
  const bad = [
    '/etc/passwd',
    'C:/Windows/System32/drivers/etc/hosts',
    'c:\\windows\\win.ini',
    '//server/share/file',
    '../../.ssh/authorized_keys',
    'a/../../b',
    'a/./b',
    '',
    'a//b',
  ]
  for (const p of bad) {
    assert.throws(() => safeRelPath(root, p), /拒绝|路径越出|路径是空/, '应拒绝: ' + JSON.stringify(p))
  }
  fs.rmSync(root, { recursive: true, force: true })
})

// ── bundle 索引 ─────────────────────────────────────────────────────────────

test('loadBundleIndex：不是 bundle 的目录要明确拒绝，而不是当成空 bundle 暴露出去', async () => {
  const dir = tmpDir('notbundle')
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi\n')
  await assert.rejects(() => loadBundleIndex(dir), /不是 dsh-sync bundle/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadBundleIndex：清单列了但磁盘上缺文件时要报错（否则会发出一份残包）', async () => {
  const dir = tmpDir('missing')
  const { files } = makeBundle(dir)
  fs.rmSync(path.join(dir, ...Object.keys(files)[1].split('/')))
  await assert.rejects(() => loadBundleIndex(dir), /列了但磁盘上没有/)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── 私网判定 ────────────────────────────────────────────────────────────────

test('isPrivateAddress：私有网段与回环放行，公网拒绝', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.5', '169.254.1.1']) {
    assert.equal(isPrivateAddress(ip), true, ip + ' 应放行')
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '203.0.113.7']) {
    assert.equal(isPrivateAddress(ip), false, ip + ' 应拒绝')
  }
})

// ── 端到端 ──────────────────────────────────────────────────────────────────

test('端到端：配对→本机接受→拉流，文件逐字节一致', async () => {
  const root = tmpDir('e2e')
  const bundleDir = path.join(root, 'bundle')
  const destDir = path.join(root, 'dest')
  const { files } = makeBundle(bundleDir)

  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0, alias: 'test-source' })
  try {
    const base = { host: '127.0.0.1', port: host.port }
    const info = await requestJson({ ...base, method: 'GET', path: '/info' })
    assert.equal(info.status, 200)
    assert.equal(info.json.service, 'dsh-sync-lan')
    // 清单文件 checksums.json 自己不在 entries 里，但必须跟着传：
    // 目标机的 apply 靠它做整包校验，接收端靠它判断续传。少这一项就是实测踩过的坑。
    assert.equal(info.json.bundle.files, Object.keys(files).length + 1)

    const pair = await requestJson({
      ...base, method: 'POST', path: '/pair',
      json: { code: host.code, client: { alias: 'test-target', hostname: 'target-pc', version: '1' } },
    })
    assert.equal(pair.status, 200, JSON.stringify(pair.json))
    assert.equal(pair.json.status, 'pending')
    const sessionId = pair.json.sessionId

    // 还没点「接受」就开流：必须被拒。这是配对码泄漏场景的最后一道闸。
    const blocked = await requestJson({
      ...base, method: 'POST', path: '/stream',
      json: { sessionId, token: 'guessed', skip: [] },
    })
    assert.equal(blocked.status, 403)

    const decided = await requestJson({ ...base, method: 'POST', path: '/decide', json: { accept: true } })
    assert.equal(decided.status, 200)
    assert.equal(decided.json.status, 'accepted')

    const wait = await requestJson({
      ...base, method: 'GET', path: '/wait?sessionId=' + encodeURIComponent(sessionId) + '&timeout=2000',
    })
    assert.equal(wait.json.status, 'accepted')
    const token = wait.json.token
    assert.ok(token && token.length >= 32, 'token 应是足够长的随机串')

    const entries = await requestJson({
      ...base, method: 'GET',
      path: '/entries?sessionId=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token),
    })
    assert.equal(entries.status, 200)
    assert.deepEqual(Object.keys(entries.json.entries).sort(), [...Object.keys(files), 'checksums.json'].sort())

    const got = await receiveStream('127.0.0.1', host.port, sessionId, token, destDir)
    assert.deepEqual(got.sort(), [...Object.keys(files), 'checksums.json'].sort(), '应收齐清单里的全部文件')

    for (const [rel, content] of Object.entries(files)) {
      const expected = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const actual = fs.readFileSync(path.join(destDir, ...rel.split('/')))
      assert.deepEqual(actual, expected, '内容必须逐字节一致：' + rel)
    }
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：错误配对码不放行，并报出还剩几次机会', async () => {
  const root = tmpDir('e2e-bad')
  const bundleDir = path.join(root, 'bundle')
  makeBundle(bundleDir)

  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  try {
    const base = { host: '127.0.0.1', port: host.port }
    // 造一个与真实码不同的错码（有 1/100 万概率正好撞对，撞对说明实现没问题，跳过断言）
    const wrongCode = host.code === '000000' ? '111111' : '000000'
    const wrong = await requestJson({
      ...base, method: 'POST', path: '/pair', json: { code: wrongCode, client: { alias: 'x' } },
    })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.json.reason, 'wrong')
    assert.match(wrong.json.error, /还剩/, '要告诉用户还剩几次，否则他不知道还能不能再试')

    // 正确的码仍然可用（错的尝试不该把好码用掉）
    const ok = await requestJson({
      ...base, method: 'POST', path: '/pair', json: { code: host.code, client: { alias: 'y' } },
    })
    assert.equal(ok.status, 200)

    // 同一台机器重配一次是允许的（续传前提），但不会凭空造出新 token
    const again = await requestJson({
      ...base, method: 'POST', path: '/pair', json: { code: host.code, client: { alias: 'y' } },
    })
    assert.equal(again.status, 200, '同源重试要放行，否则续传不可用')
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：拒绝后会话变为 denied，拉流一律失败', async () => {
  const root = tmpDir('e2e-deny')
  const bundleDir = path.join(root, 'bundle')
  makeBundle(bundleDir)
  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  try {
    const base = { host: '127.0.0.1', port: host.port }
    const pair = await requestJson({
      ...base, method: 'POST', path: '/pair', json: { code: host.code, client: { alias: 'x' } },
    })
    const sessionId = pair.json.sessionId
    const denied = await requestJson({ ...base, method: 'POST', path: '/decide', json: { accept: false } })
    assert.equal(denied.json.status, 'denied')
    const wait = await requestJson({
      ...base, method: 'GET', path: '/wait?sessionId=' + encodeURIComponent(sessionId) + '&timeout=1000',
    })
    assert.equal(wait.json.status, 'denied')
    const stream = await requestJson({
      ...base, method: 'POST', path: '/stream', json: { sessionId, token: 'whatever', skip: [] },
    })
    assert.equal(stream.status, 403)
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('端到端：续传跳过已有且哈希一致的文件，只传剩下的', async () => {
  const root = tmpDir('e2e-resume')
  const bundleDir = path.join(root, 'bundle')
  const destDir = path.join(root, 'dest')
  const { files } = makeBundle(bundleDir)

  // 预先放好一个「已经传完」的文件
  const preRel = 'state/skills/alpha/SKILL.md'
  fs.mkdirSync(path.dirname(path.join(destDir, ...preRel.split('/'))), { recursive: true })
  fs.writeFileSync(path.join(destDir, ...preRel.split('/')), files[preRel])

  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  try {
    const base = { host: '127.0.0.1', port: host.port }
    const pair = await requestJson({
      ...base, method: 'POST', path: '/pair', json: { code: host.code, client: { alias: 'x' } },
    })
    const sessionId = pair.json.sessionId
    await requestJson({ ...base, method: 'POST', path: '/decide', json: { accept: true } })
    const wait = await requestJson({
      ...base, method: 'GET', path: '/wait?sessionId=' + encodeURIComponent(sessionId) + '&timeout=1000',
    })
    const token = wait.json.token

    const got = await receiveStream('127.0.0.1', host.port, sessionId, token, destDir, [preRel])
    assert.ok(!got.includes(preRel), '已有且一致的文件不该重传')
    assert.equal(got.length, Object.keys(files).length, '总数 = 清单内文件数 + 清单本身 - 跳过的 1 个')
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pullBundle：只用一条命令走完配对→等确认→接收，且不落地（autoApply=false）', async () => {
  const root = tmpDir('pull')
  const bundleDir = path.join(root, 'bundle')
  const destDir = path.join(root, 'dest')
  const dshHome = path.join(root, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  const { files } = makeBundle(bundleDir)

  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  // 模拟「另一端的人点了接受」：pullBundle 会在后台等这个动作，
  // 所以这里用一个短延时模拟人工点击。
  const clicker = (async () => {
    await new Promise((r) => setTimeout(r, 200))
    await requestJson({ host: '127.0.0.1', port: host.port, method: 'POST', path: '/decide', json: { accept: true } })
  })()

  try {
    const progress = createProgress()
    const report = await pullBundle({
      host: '127.0.0.1', port: host.port, code: host.code,
      destDir, dshHome, autoApply: false, autoVerify: false,
      progress, onLog: () => {},
    })
    await clicker
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.received.files, Object.keys(files).length + 1)
    for (const [rel, content] of Object.entries(files)) {
      const expected = Buffer.isBuffer(content) ? content : Buffer.from(content)
      assert.deepEqual(fs.readFileSync(path.join(destDir, ...rel.split('/'))), expected, rel)
    }
    assert.equal(progress.snapshot().phase, 'done')
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pullBundle：destDir 落在 $DSH_HOME 内要拒绝（否则会混进下次导出的状态层）', async () => {
  const root = tmpDir('pull-home')
  const dshHome = path.join(root, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  const report = await pullBundle({
    host: '127.0.0.1', port: 1, code: '123456',
    destDir: path.join(dshHome, 'bundle'), dshHome,
    autoApply: false, onLog: () => {},
  })
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((e) => /\$DSH_HOME/.test(e)), JSON.stringify(report.errors))
  fs.rmSync(root, { recursive: true, force: true })
})

test('pullBundle：连不上时给出可操作的排查清单，而不是一句 ECONNREFUSED', async () => {
  const root = tmpDir('pull-down')
  const report = await pullBundle({
    host: '127.0.0.1', port: 1, code: '123456',
    destDir: path.join(root, 'dest'), dshHome: path.join(root, 'home'),
    autoApply: false, onLog: () => {},
  })
  assert.equal(report.ok, false)
  const text = report.errors.join('\n')
  assert.match(text, /连不上/)
  assert.match(text, /防火墙|局域网/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('端到端：UDP 广播能把本机起的发送端找回来（环境拦了广播就跳过）', async (t) => {
  const root = tmpDir('e2e-udp')
  const bundleDir = path.join(root, 'bundle')
  const { files } = makeBundle(bundleDir)

  // 广播要能真的发出去并被自己收到 —— 容器 / 关闭了回环广播的 CI 里做不到，
  // 那种情况下这条用例没有意义，跳过而不是判失败。
  const host = await startHost({ bundleDir, port: 0, alias: 'udp-target' })
  try {
    const found = await discoverDevices({ scan: false, udpTimeoutMs: 1500 })
    if (found.devices.length === 0) {
      t.skip('这个环境没有把 UDP 广播回环回来（CI 容器常见），跳过')
      return
    }
    const me = found.devices.find((d) => d.port === host.port)
    assert.ok(me, '应当发现端口对得上的那一台，实际：' + JSON.stringify(found.devices))
    assert.equal(me.alias, 'udp-target')
    assert.equal(me.bundle.files, Object.keys(files).length + 1, '广播应答里的文件数要含清单本身')
    assert.equal(me.via, 'udp')
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pullBundle：加密凭据带口令自动落地，不带则进必办（LAN 链路口令透传）', async () => {
  const root = tmpDir('pull-pass')
  const bundleDir = path.join(root, 'bundle')
  const destDir = path.join(root, 'dest')
  const dshHome = path.join(root, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  makeBundle(bundleDir)
  // 加密凭据进包（并同步进 checksums 清单）
  const enc = encryptBuffer(Buffer.from('deepseek: apiKeyEnv: DS_KEY\n', 'utf8'), '88888888')
  fs.writeFileSync(path.join(bundleDir, '.credentials.enc'), enc)
  const sumsPath = path.join(bundleDir, 'checksums.json')
  const sums = JSON.parse(fs.readFileSync(sumsPath, 'utf8'))
  sums.entries['.credentials.enc'] = sha256(enc)
  fs.writeFileSync(sumsPath, JSON.stringify(sums, null, 2))

  // ① 带口令：凭据应解密落地到 $DSH_HOME
  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  const clicker = (async () => {
    await new Promise((r) => setTimeout(r, 200))
    await requestJson({ host: '127.0.0.1', port: host.port, method: 'POST', path: '/decide', json: { accept: true } })
  })()
  try {
    const report = await pullBundle({
      host: '127.0.0.1', port: host.port, code: host.code,
      destDir, dshHome, passphrase: '88888888', onLog: () => {},
    })
    await clicker
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.ok(fs.existsSync(path.join(dshHome, '.credentials.yaml')), '带口令凭据应落地')
    assert.equal(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'), 'deepseek: apiKeyEnv: DS_KEY\n')
    assert.ok(!report.apply.actionRequired.some((a) => a.startsWith('[凭据]')), '落地成功不应再报凭据必办')
  } finally {
    await host.close()
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.rmSync(dshHome, { recursive: true, force: true })
  }

  // ② 不带口令：凭据不落地，必办点名（整包其余照常）
  const dshHome2 = path.join(root, 'home2')
  fs.mkdirSync(dshHome2, { recursive: true })
  const host2 = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  const clicker2 = (async () => {
    await new Promise((r) => setTimeout(r, 200))
    await requestJson({ host: '127.0.0.1', port: host2.port, method: 'POST', path: '/decide', json: { accept: true } })
  })()
  try {
    const report2 = await pullBundle({
      host: '127.0.0.1', port: host2.port, code: host2.code,
      destDir, dshHome: dshHome2, onLog: () => {},
    })
    await clicker2
    assert.equal(report2.ok, true, '凭据跳过不判整体失败：' + JSON.stringify(report2.errors))
    assert.ok(!fs.existsSync(path.join(dshHome2, '.credentials.yaml')), '没口令凭据不得落地')
    assert.ok(report2.apply.actionRequired.some((a) => a.startsWith('[凭据]')),
      '必办要点名凭据：' + JSON.stringify(report2.apply.actionRequired))
    assert.ok(report2.apply.nextSteps.some((x) => x.startsWith('必办 [凭据]')), 'nextSteps 第一屏要看到必办')
  } finally {
    await host2.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 0.18：一条龙（autoAccept）与内容摘要 ────────────────────────────────────

test('/info 广播带内容计数与 autoAccept 标志（不带名字）', async () => {
  const root = tmpDir('info')
  const bundleDir = path.join(root, 'bundle')
  makeBundle(bundleDir, {
    plugins: [{ name: 'dsh-foo', files: 3, bytes: 456 }],
    workspaces: [{ name: 'proj-a', sourcePath: 'D:/proj/a', bytes: 123, hasGit: true }],
    state: { sessions: { total: 2, logFiles: 3 } },
  })
  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0, autoAccept: true })
  try {
    const info = await requestJson({ host: '127.0.0.1', port: host.port, method: 'GET', path: '/info' })
    assert.equal(info.json.autoAccept, true)
    assert.equal(info.json.bundle.files > 0, true)
    assert.equal(info.json.bundle.sessions, 2)
    assert.equal(info.json.bundle.plugins, 1)
    assert.equal(info.json.bundle.workspaces, 1)
    assert.equal(info.json.bundle.encrypted, false)
    // 名字不在 /info 里：计数可以公开，使用画像不行
    assert.ok(!JSON.stringify(info.json).includes('proj-a'), '工作区名字不得出现在 /info')
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('autoAccept：配对即接受，无需本机点「接受」，传输全程跑通', async () => {
  const root = tmpDir('auto')
  const bundleDir = path.join(root, 'bundle')
  const destDir = path.join(root, 'dest')
  const dshHome = path.join(root, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  makeBundle(bundleDir)
  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0, autoAccept: true })
  try {
    // /pair 直接返回 accepted + token，不等 /decide
    const pair = await requestJson({
      host: '127.0.0.1', port: host.port, method: 'POST', path: '/pair',
      json: { code: host.code, client: { alias: '新机器', hostname: 'NEW-PC' } },
    })
    assert.equal(pair.json.ok, true)
    assert.equal(pair.json.status, 'accepted', 'autoAccept 下配对即接受')
    assert.ok(pair.json.token, '配对响应直接带 token')

    const got = await receiveStream('127.0.0.1', host.port, pair.json.sessionId, pair.json.token, destDir)
    assert.ok(got.includes('settings.yaml'), 'settings 应收到')
    assert.ok(fs.existsSync(path.join(destDir, 'settings.yaml')))
  } finally {
    await host.close()
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.rmSync(dshHome, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('/summary：没配对拿不到；配对后带名字的完整摘要', async () => {
  const root = tmpDir('summary')
  const bundleDir = path.join(root, 'bundle')
  makeBundle(bundleDir, {
    plugins: [{ name: 'dsh-foo', files: 3, bytes: 456 }],
    workspaces: [{ name: 'proj-a', sourcePath: 'D:/proj/a', bytes: 123, hasGit: true }],
    state: { sessions: { total: 2, logFiles: 3 } },
  })
  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0 })
  try {
    const denied = await requestJson({ host: '127.0.0.1', port: host.port, method: 'GET', path: '/summary' })
    assert.equal(denied.status, 403, '未配对必须 403')

    const pair = await requestJson({
      host: '127.0.0.1', port: host.port, method: 'POST', path: '/pair',
      json: { code: host.code, client: { alias: '新机器' } },
    })
    // 手动模式：/pair 之后仍是 pending，需本机接受；token 只在接受后经 /wait 发放
    assert.equal(pair.json.status, 'pending')
    const summary0 = await requestJson({
      host: '127.0.0.1', port: host.port, method: 'GET',
      path: '/summary?sessionId=' + pair.json.sessionId,
    })
    assert.equal(summary0.status, 403, '没拿到 token 就没有摘要')

    await requestJson({ host: '127.0.0.1', port: host.port, method: 'POST', path: '/decide', json: { accept: true } })
    const wait = await requestJson({
      host: '127.0.0.1', port: host.port, method: 'GET', path: '/wait?sessionId=' + pair.json.sessionId,
    })
    const summary = await requestJson({
      host: '127.0.0.1', port: host.port, method: 'GET',
      path: '/summary?sessionId=' + pair.json.sessionId + '&token=' + encodeURIComponent(wait.json.token),
    })
    assert.equal(summary.json.ok, true)
    assert.equal(summary.json.summary.workspaces[0].name, 'proj-a', '配对后有名字')
    assert.equal(summary.json.summary.plugins[0].name, 'dsh-foo')
    assert.equal(summary.json.summary.sessions, 2)
  } finally {
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pullBundle 全程：autoAccept 源机 + 一条命令，无 /decide、无人工介入', async () => {
  const root = tmpDir('oneshot')
  const bundleDir = path.join(root, 'bundle')
  const destDir = path.join(root, 'dest')
  const dshHome = path.join(root, 'home')
  fs.mkdirSync(dshHome, { recursive: true })
  makeBundle(bundleDir)
  const host = await startHost({ bundleDir, bind: '127.0.0.1', port: 0, autoAccept: true })
  try {
    const report = await pullBundle({
      host: '127.0.0.1', port: host.port, code: host.code,
      destDir, dshHome, onLog: () => {},
    })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.ok(fs.existsSync(path.join(destDir, 'manifest.json')))
    assert.ok(fs.existsSync(path.join(dshHome, 'settings.yaml')), 'settings 应落地')
  } finally {
    await host.close()
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.rmSync(dshHome, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('toDevice：解析 0.18 广播里的内容计数与 autoAccept；旧发送端（无字段）解析为 undefined', () => {
  const fresh = toDevice({
    service: 'dsh-sync-lan', proto: 1, port: 38473, alias: '旧机', bundle: { files: 10, bytes: 1000, sessions: 84, plugins: 11, workspaces: 5, encrypted: true },
    autoAccept: true,
  }, '192.168.1.9')
  assert.equal(fresh.bundle.sessions, 84)
  assert.equal(fresh.bundle.plugins, 11)
  assert.equal(fresh.bundle.workspaces, 5)
  assert.equal(fresh.bundle.encrypted, true)
  assert.equal(fresh.autoAccept, true)

  const legacy = toDevice({ service: 'dsh-sync-lan', proto: 1, port: 38473, alias: '旧机', bundle: { files: 10, bytes: 1000 } }, '192.168.1.9')
  assert.equal(legacy.bundle.sessions, null, "旧发送端没有计数字段，解析成 null 而不是 0")
  assert.equal(legacy.bundle.encrypted, false)
  assert.equal(legacy.autoAccept, false)
})
