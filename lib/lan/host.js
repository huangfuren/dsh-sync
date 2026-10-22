// lib/lan/host.js — 发送端：起服务、等配对、等人点接受、然后流式发文件。
//
// 这一层的三个判断值得单独说明，因为改错了不会报错，只会变得不安全或不可用：
//
// ① **接受只能由本机发起。** 页面绑在局域网 IP 上，同网段任何人都能打开同一个 URL。
//    如果「接受」按钮对谁都有效，配对码就只是装饰。所以 /decide 检查请求源地址
//    是否属于本机网卡（isLocalRemote），SSE 也按 client 是本地还是远端分别生成快照
//    —— 远端连配对码都拿不到，只看到进度。
//
// ② **只接受私有网段来源。** 桌面机偶尔会直接挂在公网上（云主机、临时 DMZ）。
//    这条不是防谁，是防止「以为只在局域网、其实全世界都能连」这种配置事故。
//
// ③ **server.requestTimeout 必须置 0。** Node 18+ 默认 300 秒，而一个 2.9 GB 的
//    bundle 在百兆网络上要几分钟。不关它，传输会在第 5 分钟被服务器自己掐断，
//    表现是「传到 8x% 突然断」，且日志里只有一句 socket hang up。
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { CHECKSUM_FILE, sha256File } from '../checksum.js'
import {
  CHUNK_SIZE, DISCOVERY_PORT, DISCOVERY_REQUEST, FRAME, LAN_DEFAULT_PORT, LAN_PORT_SPAN,
  LAN_PROTOCOL_VERSION, LAN_SERVICE_ID, PAIR_LONGPOLL_MS, PAIR_WAIT_MS,
} from './constants.js'
import { encodeFrame, encodeFrameHeader } from './frame.js'
import {
  isLocalRemote, listLanAddresses, localAddressSet, readJson, sendJson,
} from './net.js'
import { renderPage } from './page.js'
import { createPairGate } from './pair.js'
import { createProgress, formatBytes, formatDuration } from './progress.js'

/** RFC1918 私有网段 + 链路本地。用来拒绝来自公网地址的连接。 */
export function isPrivateAddress(ip) {
  const raw = String(ip || '').replace(/^::ffff:/i, '')
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (!m) return raw === '::1' || raw === '127.0.0.1'
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** 读 bundle 的索引：checksums.json 给出权威清单，manifest.json 给出展示信息。 */
export async function loadBundleIndex(bundleDir) {
  const dir = path.resolve(String(bundleDir || ''))
  const checksumPath = path.join(dir, 'checksums.json')
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(dir)) throw new Error('bundle 目录不存在: ' + dir)
  if (!fs.existsSync(checksumPath)) {
    throw new Error('这个目录里没有 checksums.json，不是 dsh-sync bundle: ' + dir
      + '（发文件用 dsh-localsend，这里只负责把 bundle 搬到另一台机器并落地）')
  }
  let table
  try {
    table = JSON.parse(await fs.promises.readFile(checksumPath, 'utf8'))
  } catch (err) {
    throw new Error('checksums.json 解析失败: ' + (err && err.message ? err.message : String(err)))
  }
  const entries = table && table.entries && typeof table.entries === 'object' ? table.entries : {}
  const keys = Object.keys(entries)
  if (keys.length === 0) throw new Error('checksums.json 里没有任何文件条目，bundle 不完整')

  let manifest = null
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))
  } catch { /* manifest 缺失不致命：清单仍可传，落地时会报出来 */ }

  // 体积与条目数一次算好：/info 要用它回答发现请求，不能每次现扫（254 个 IP 的扫描会把它打爆）。
  const files = []
  let bytes = 0
  for (const rel of keys.sort()) {
    const abs = path.join(dir, ...rel.split('/'))
    let st = null
    try {
      st = await fs.promises.stat(abs)
    } catch { st = null }
    if (st === null || !st.isFile()) {
      throw new Error('checksums.json 里列了但磁盘上没有: ' + rel + '（bundle 被删过？重新导出一次）')
    }
    bytes += st.size
    files.push({ path: rel, size: st.size, sha256: String(entries[rel] || '') })
  }

  // **checksums.json 自己不在 entries 里**（清单不能自指），但它必须跟着一起传：
  //   · 目标机的 apply 用它做整包 sha256 校验，缺了就等于关掉所有完整性检查；
  //   · 接收端靠它判断「哪些文件已经有了」，缺了续传永远不生效。
  // 这条是实测发现的：第一版只发 entries 里列的文件，于是每台新机器落地后都没有清单，
  // 第二次拉取还会因为「目录非空且没有可续传的 bundle」被拒。
  const selfPath = path.join(dir, CHECKSUM_FILE)
  const selfStat = await fs.promises.stat(selfPath)
  bytes += selfStat.size
  files.push({ path: CHECKSUM_FILE, size: selfStat.size, sha256: await sha256File(selfPath) })

  return { dir, files, bytes, manifest, formatVersion: manifest ? manifest.formatVersion : null }
}

function hostAlias() {
  try { return os.hostname() || 'dsh-sync' } catch { return 'dsh-sync' }
}

/** SSE 客户端集合。每个 client 记住「是否本机」，因为快照内容不同。 */
function createHub() {
  const clients = new Set()
  return {
    add(res, local) {
      const entry = { res, local }
      clients.add(entry)
      return () => clients.delete(entry)
    },
    forEach(fn) { for (const c of clients) fn(c) },
    get size() { return clients.size },
    closeAll() {
      for (const c of clients) {
        try { c.res.end() } catch { /* 已断 */ }
      }
      clients.clear()
    },
  }
}

/**
 * 启动发送端服务。
 * @param {object} options
 * @param {string} options.bundleDir
 * @param {string} [options.alias] 在对方页面上显示的名字
 * @param {number} [options.port] 起始端口，占用则顺延
 * @param {string} [options.bind] 监听地址，默认 0.0.0.0
 * @param {number} [options.codeTtlMs]
 * @param {boolean} [options.allowPublic] 允许非私有网段来源（默认 false）
 * @param {(line:string)=>void} [options.onLog]
 * @returns {Promise<object>}
 */
export async function startHost(options = {}) {
  const log = options.onLog || (() => {})
  const index = await loadBundleIndex(options.bundleDir)
  const alias = String(options.alias || hostAlias())
  const bind = String(options.bind || '0.0.0.0')
  const allowPublic = options.allowPublic === true
  const locals = localAddressSet()
  const gate = createPairGate({ ttlMs: options.codeTtlMs })
  const progress = createProgress({ totalBytes: index.bytes, totalFiles: index.files.length })
  const hub = createHub()

  /** 单会话：一台机器对一台机器。重复配对会顶掉上一个还没被接受的请求。 */
  let session = null
  let streamStarted = false
  const logs = []
  const pushLog = (line) => {
    const text = String(line || '')
    if (text === '') return
    logs.push(text)
    if (logs.length > 80) logs.shift()
    log(text)
  }

  let broadcastTimer = null
  function scheduleBroadcast() {
    if (broadcastTimer !== null) return
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      broadcastNow()
    }, 120)
    if (typeof broadcastTimer.unref === 'function') broadcastTimer.unref()
  }
  function broadcastNow() {
    hub.forEach((client) => {
      const payload = JSON.stringify(snapshot(client.local))
      try { client.res.write('data: ' + payload + '\n\n') } catch { /* 客户端已断，下一轮会清 */ }
    })
  }

  function currentPhase() {
    if (session === null) return 'pairing'
    if (session.state === 'pending') return 'waiting'
    if (session.state === 'denied') return 'failed'
    if (session.state === 'failed') return 'failed'
    if (session.state === 'accepted') return streamStarted ? 'transferring' : 'accepted'
    if (session.state === 'done') return 'done'
    return 'pairing'
  }

  function snapshot(local) {
    const phase = currentPhase()
    const snap = progress.snapshot()
    const state = {
      role: 'host',
      local,
      phase,
      self: { alias, hostname: hostAlias(), version: LAN_PROTOCOL_VERSION },
      peer: session && session.client ? session.client : null,
      pair: local
        ? { code: gate.code, expiresAt: gate.expiresAt, ...gate.status() }
        : null,
      pending: session && session.state === 'pending'
        ? { state: 'waiting', bundle: { files: index.files.length, bytes: index.bytes } }
        : null,
      canDecide: local,
      progress: snap,
      result: session && session.result ? session.result : null,
      logs: logs.slice(-40),
      bundle: { files: index.files.length, bytes: index.bytes, dir: index.dir },
    }
    return state
  }

  function remoteOf(req) {
    return String((req.socket && req.socket.remoteAddress) || '')
  }

  // ── HTTP 服务 ────────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const message = err && err.message ? err.message : String(err)
      pushLog('✗ 请求处理失败: ' + message)
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
        else res.end()
      } catch { /* 已经断了 */ }
    })
  })

  // 这两个数字是「传输到一半自己断掉」的唯一原因，见文件头注释 ③。
  server.requestTimeout = 0
  server.timeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 5000

  async function handle(req, res) {
    const remote = remoteOf(req)
    const local = isLocalRemote(remote, locals)
    if (!allowPublic && !isPrivateAddress(remote)) {
      // 这条挡的是「机器直接暴露在公网」的配置事故，不是防同网段的人。
      sendJson(res, 403, {
        ok: false,
        error: '拒绝来自公网地址的连接（' + remote + '）。局域网直传只接受私有网段；'
          + '确实要走公网请加 bind/allowPublic 参数，并先想清楚配对码会不会被看到。',
      })
      return
    }

    const url = new URL(req.url || '/', 'http://localhost')
    const route = url.pathname

    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const html = renderPage({ role: 'host', local, state: snapshot(local) })
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        // 页面自身不需要外部资源，收紧密码策略不会有副作用，但能挡住注入的脚本源。
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      })
      res.end(body)
      return
    }

    if (req.method === 'GET' && route === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      const drop = hub.add(res, local)
      try { res.write('data: ' + JSON.stringify(snapshot(local)) + '\n\n') } catch { /* 立刻断了 */ }
      res.on('close', drop)
      return
    }

    if (req.method === 'GET' && route === '/info') {
      // 发现请求会打到这个端点（254 个 IP 的扫描），所以这里必须只做 JSON 序列化，
      // 不读盘、不算哈希。
      sendJson(res, 200, {
        service: LAN_SERVICE_ID,
        proto: LAN_PROTOCOL_VERSION,
        alias,
        hostname: hostAlias(),
        port: server.address() ? server.address().port : 0,
        state: currentPhase(),
        pairing: session === null,
        bundle: { files: index.files.length, bytes: index.bytes },
      })
      return
    }

    if (req.method === 'GET' && route === '/entries') {
      // 续传判断要用的权威清单。**需要配对成功后的 token**：文件名本身就是信息
      // （项目名、会话数、有没有 .credentials.yaml），不能让没配对的人拉走。
      const sessionId = url.searchParams.get('sessionId') || ''
      const token = url.searchParams.get('token') || ''
      if (session === null || session.id !== sessionId || !gate.validateToken(token)) {
        sendJson(res, 403, { ok: false, error: '需要先完成配对' })
        return
      }
      const entries = {}
      for (const f of index.files) entries[f.path] = f.sha256
      sendJson(res, 200, { ok: true, entries, bytes: index.bytes })
      return
    }

    if (req.method === 'POST' && route === '/pair') {
      // 传输正在进行时不能接受新配对：新会话会顶掉当前会话对象，而正在跑的循环
      // 还在往旧对象上写状态 —— 结果是「传完了但页面显示等待配对」，且下一个人能接着拉。
      if (streamStarted) {
        sendJson(res, 409, { ok: false, error: '当前正在传输，等这次结束再配对' })
        return
      }
      const body = await readJson(req, 16 * 1024)
      const result = gate.attempt(body.code, { requester: remote })
      if (!result.ok) {
        const reasons = {
          empty: '配对码是空的',
          used: '这个配对码已经用过了（一次性的），请在本机看新码',
          expired: '配对码已过期（5 分钟有效），请在本机重新生成',
          locked: '配对码已锁定：试错次数用尽，请在本机重新生成',
          wrong: '配对码不对（还剩 ' + (result.remainingAttempts || 0) + ' 次机会）',
        }
        pushLog('⚠️ 配对失败：' + (reasons[result.reason] || result.reason) + '（来自 ' + remote + '）')
        sendJson(res, 401, { ok: false, reason: result.reason, error: reasons[result.reason] || '配对失败' })
        return
      }
      const client = body.client && typeof body.client === 'object' ? body.client : {}
      // 来自对端的字符串一律截断：它们是别人给的，长到几 MB 会把页面和日志撑爆。
      const clean = {
        alias: String(client.alias || '').slice(0, 120) || '未知机器',
        hostname: String(client.hostname || '').slice(0, 120),
        version: String(client.version || '').slice(0, 40),
        address: remote,
      }
      session = {
        id: crypto.randomUUID(),
        state: 'pending',
        token: result.token,
        client: clean,
        createdAt: Date.now(),
        decidedAt: 0,
        waiters: [],
        result: null,
      }
      streamStarted = false
      progress.reset()
      progress.setPhase('waiting', '等待本机确认')
      pushLog('📥 收到来自 ' + clean.alias + '（' + remote + '）的传输请求，等待本机确认')
      scheduleBroadcast()
      sendJson(res, 200, {
        ok: true,
        sessionId: session.id,
        status: 'pending',
        bundle: { files: index.files.length, bytes: index.bytes },
        host: { alias, hostname: hostAlias(), version: LAN_PROTOCOL_VERSION },
      })
      return
    }

    if (req.method === 'GET' && route === '/wait') {
      const sessionId = url.searchParams.get('sessionId') || ''
      // 长轮询要 await，期间 session 可能被新的配对顶掉 —— 捕获局部引用。
      const s = session
      if (s === null || s.id !== sessionId) {
        sendJson(res, 404, { ok: false, error: '没有这个配对会话（可能已过期或被新请求顶掉）' })
        return
      }
      const timeoutMs = Math.min(PAIR_WAIT_MS, Math.max(1000, Number(url.searchParams.get('timeout')) || PAIR_LONGPOLL_MS))
      const decided = await waitForDecision(s, timeoutMs)
      if (!decided) {
        sendJson(res, 200, { ok: true, status: 'pending' })
        return
      }
      if (s.state === 'accepted') {
        sendJson(res, 200, { ok: true, status: 'accepted', token: s.token })
      } else {
        sendJson(res, 200, { ok: true, status: 'denied', error: '对方拒绝了这次传输' })
      }
      return
    }

    if (req.method === 'POST' && route === '/decide') {
      // 关键安全点：只有本机能点「接受」。见文件头注释 ①。
      if (!local) {
        sendJson(res, 403, { ok: false, error: '只有发起这次传输请求的那台机器能决定是否接受' })
        return
      }
      const body = await readJson(req, 4096)
      if (session === null || session.state !== 'pending') {
        sendJson(res, 409, { ok: false, error: '当前没有待确认的传输请求' })
        return
      }
      const accept = body.accept === true
      session.state = accept ? 'accepted' : 'denied'
      session.decidedAt = Date.now()
      if (accept) {
        progress.setPhase('accepted', '已接受，等待对方开始拉取')
        pushLog('✓ 已接受 ' + session.client.alias + ' 的传输请求')
      } else {
        progress.setPhase('failed', '已拒绝传输')
        pushLog('✗ 已拒绝 ' + session.client.alias + ' 的传输请求')
        session.result = { ok: false, summary: '已拒绝这次传输', rows: [], errors: [] }
      }
      wakeWaiters(session)
      scheduleBroadcast()
      sendJson(res, 200, { ok: true, status: session.state })
      return
    }

    if (req.method === 'POST' && route === '/stream') {
      await handleStream(req, res, remote)
      return
    }

    sendJson(res, 404, { ok: false, error: '未知路径: ' + route })
  }

  function wakeWaiters(s) {
    const list = s.waiters.splice(0, s.waiters.length)
    for (const w of list) {
      try { w() } catch { /* 忽略 */ }
    }
  }

  /** 等会话被决定，或超时。返回是否已决定。用超时 Promise 与唤醒 Promise 赛跑，两条路径都简单可读。 */
  async function waitForDecision(s, timeoutMs) {
    if (s.state !== 'pending') return true
    let timer = null
    const timeout = new Promise((resolve) => {
      // 刻意不 unref：这个 timer 是「等人在另一台机器上点接受」的唯一兜底，
      // unref 掉之后如果进程里只剩它，事件循环会提前退出而请求永远挂着。
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const decided = new Promise((resolve) => {
      s.waiters.push(() => resolve(true))
    })
    const result = await Promise.race([timeout, decided])
    if (timer !== null) clearTimeout(timer)
    return result
  }

  async function handleStream(req, res, remote) {
    const body = await readJson(req, 64 * 1024 * 8)
    // 把会话捕到局部变量：后面的 await 里 `session` 仍可能被改写，
    // 用模块级的那个引用会把状态写到别人的会话上。
    const s = session
    if (s === null || s.id !== String(body.sessionId || '')) {
      sendJson(res, 404, { ok: false, error: '没有这个配对会话' })
      return
    }
    if (s.state !== 'accepted') {
      // 未确认就开流：这是「配对码泄漏后被直接拉走」的路径，必须明确拒绝并记账。
      pushLog('⚠️ 拒绝了一次未获确认的拉取请求（来自 ' + remote + '，会话状态 ' + s.state + '）')
      sendJson(res, 403, { ok: false, error: '这次传输还没在本机被接受' })
      return
    }
    if (!gate.validateToken(body.token)) {
      sendJson(res, 403, { ok: false, error: 'token 无效' })
      return
    }
    if (streamStarted) {
      sendJson(res, 409, { ok: false, error: '这条会话已经在传输中（同一会话只允许一次并发拉取）' })
      return
    }

    // 续传：对方说这些文件它已经有了且哈希一致，跳过不发。
    const skip = new Set(Array.isArray(body.skip) ? body.skip.map(String) : [])
    const todo = index.files.filter((f) => !skip.has(f.path))
    const totalBytes = todo.reduce((n, f) => n + f.size, 0)

    streamStarted = true
    progress.setTotals({ files: todo.length, bytes: totalBytes })
    progress.setPhase('transferring', '正在发送')
    pushLog('▶ 开始发送 ' + todo.length + ' 个文件 / ' + formatBytes(totalBytes)
      + (skip.size > 0 ? '（对方已有 ' + skip.size + ' 个，跳过）' : ''))
    scheduleBroadcast()

    res.writeHead(200, {
      'Content-Type': 'application/x-dshsync-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Dshsync-Proto': String(LAN_PROTOCOL_VERSION),
      'X-Dshsync-Files': String(todo.length),
      'X-Dshsync-Bytes': String(totalBytes),
    })

    let aborted = false
    res.on('close', () => { if (!res.writableEnded) aborted = true })

    try {
      for (const entry of todo) {
        if (aborted) throw new Error('对方断开了连接')
        await sendOneFile(res, entry, () => aborted)
      }
      if (aborted) throw new Error('对方断开了连接')
      res.write(encodeFrame(FRAME.DONE, {
        files: todo.length,
        bytes: progress.snapshot().bytes.done,
        durationMs: progress.snapshot().elapsedMs,
      }))
      res.end()
      progress.finalize()
      progress.setPhase('done', '传输完成')
      s.state = 'done'
      s.result = {
        ok: true,
        summary: '传输完成',
        rows: [
          ['文件', todo.length + ' 个' + (skip.size > 0 ? '（跳过 ' + skip.size + ' 个已有）' : '')],
          ['体积', formatBytes(progress.snapshot().bytes.done)],
          ['耗时', formatDuration(progress.snapshot().elapsedMs)],
        ],
        errors: [],
      }
      pushLog('✅ 传输完成：' + todo.length + ' 个文件 / ' + formatBytes(progress.snapshot().bytes.done)
        + ' / 用时 ' + formatDuration(progress.snapshot().elapsedMs))
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      progress.setPhase('failed', message)
      pushLog('✗ 传输中断：' + message)
      try {
        if (!res.writableEnded) {
          res.write(encodeFrame(FRAME.ERR, { message }))
          res.end()
        }
      } catch { /* 已断 */ }
      s.state = 'failed'
      s.result = { ok: false, summary: '传输中断', rows: [], errors: [message] }
      // 刻意**不**在这里换码：同一个码对同一台机器仍然有效（见 pair.js 的 attempt），
      // 所以「重跑一次接着传」可以直接成功。换码会让用户手里那个码突然失效，
      // 而他正打算用它重试。要换码请显式 action="renew"。
      pushLog('↻ 中断了。用同一个配对码重跑 pull 即可续传（已收到且哈希一致的文件会跳过）')
    } finally {
      streamStarted = false
      scheduleBroadcast()
    }
  }

  /** 等 socket 缓冲区腾出空间。连接在这期间断掉时必须抛错，否则传输会永久挂住。 */
  function waitDrain(res) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        res.off('drain', onDrain)
        res.off('close', onClose)
      }
      const onDrain = () => { cleanup(); resolve() }
      const onClose = () => { cleanup(); reject(new Error('对方断开了连接')) }
      res.on('drain', onDrain)
      res.on('close', onClose)
    })
  }

  /** 发一个文件：FILE 头 → DATA 块 → FEND。边读边算 sha256，与清单不符就中止。 */
  async function sendOneFile(res, entry, isAborted) {
    const abs = path.join(index.dir, ...entry.path.split('/'))
    progress.fileStart(entry.path, entry.size)
    scheduleBroadcast()

    res.write(encodeFrame(FRAME.FILE, { path: entry.path, size: entry.size, sha256: entry.sha256 }))

    const hash = crypto.createHash('sha256')
    let sent = 0
    for await (const chunk of fs.createReadStream(abs, { highWaterMark: CHUNK_SIZE })) {
      if (isAborted()) throw new Error('对方断开了连接')
      hash.update(chunk)
      sent += chunk.length
      // 帧头与载荷分两次写：Node 会自己把连续的小写入合并成一个包，
      // 省掉为每个 256 KB 块再拼一个大 Buffer 的拷贝。
      res.write(encodeFrameHeader(FRAME.DATA, chunk.length))
      if (!res.write(chunk)) await waitDrain(res)
      progress.addBytes(chunk.length)
      scheduleBroadcast()
    }

    const actual = hash.digest('hex')
    if (entry.sha256 && actual !== entry.sha256) {
      // 走到这里说明**发送端磁盘上的文件已和清单不符**（导出后被改过，或有坏道）。
      // 继续发出去只会让对方收到一批校验不过的文件，不如在这里停。
      throw new Error('文件内容与清单不符: ' + entry.path
        + '（期望 ' + entry.sha256.slice(0, 12) + '…，实际 ' + actual.slice(0, 12)
        + '…）—— bundle 在导出后被改动过，请重新导出')
    }
    res.write(encodeFrame(FRAME.FEND, { path: entry.path, sha256: actual, size: sent }))
    progress.fileDone()
    scheduleBroadcast()
  }

  // ── 端口占用顺延 ─────────────────────────────────────────────────────────
  // port=0 表示「随便挑一个空闲端口」（测试用）；其余情况从给定端口起顺延。
  const startPort = options.port === 0 ? 0 : (Number(options.port) || LAN_DEFAULT_PORT)
  let listening = false
  let lastError = null
  for (let i = 0; i <= LAN_PORT_SPAN; i++) {
    const candidate = startPort === 0 ? 0 : startPort + i
    try {
      server.listen(candidate, bind)
      // eslint-disable-next-line no-await-in-loop
      await once(server, 'listening')
      listening = true
      break
    } catch (err) {
      lastError = err
      try { server.close() } catch { /* 未开始监听 */ }
    }
    if (startPort === 0) break   // 0 只试一次：它要么成功要么系统没端口可用
  }
  if (!listening) {
    throw new Error('无法监听端口 ' + (startPort === 0 ? '（自动）' : startPort + '–' + (startPort + LAN_PORT_SPAN))
      + '：' + (lastError && lastError.message ? lastError.message : '全部被占用'))
  }
  // 用系统回报的实际端口：startPort=0 时 listen() 传进去的 0 不是真实端口。
  const bound = server.address().port

  // ── UDP 应答端（让 dshsync_lan_discover 找得到）────────────────────────────
  // 少了这一段，discover 发出去的广播永远没有回应，只能退化成逐地址扫描 ——
  // 功能上看似能用（扫描能兜住），但那 3 秒和「广播被拦了」的错误判断全是假的。
  // 刻意与 HTTP 的 bind 解耦：发现要听到所有网卡上的广播，所以绑 0.0.0.0。
  let discoverySocket = null
  try {
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    discoverySocket.on('error', (err) => {
      // 38472 被占或被防火墙拦：只影响「广播发现」，扫描仍然可用，不该让服务起不来。
      pushLog('⚠️ UDP 发现端口 ' + DISCOVERY_PORT + ' 不可用（' + (err && err.message ? err.message : String(err)) + '），'
        + '对方将改用逐地址扫描找到本机')
      try { discoverySocket.close() } catch { /* 已关 */ }
      discoverySocket = null
    })
    discoverySocket.on('message', (msg, rinfo) => {
      if (msg.toString('utf8').trim() !== DISCOVERY_REQUEST) return
      // 与 HTTP 侧同一条边界：不给公网地址回话，免得把「这里有台 dsh-sync」广播出去。
      if (!allowPublic && !isPrivateAddress(rinfo.address)) return
      const addr = server.address()
      const reply = Buffer.from(JSON.stringify({
        service: LAN_SERVICE_ID,
        proto: LAN_PROTOCOL_VERSION,
        alias,
        hostname: hostAlias(),
        port: addr ? addr.port : 0,
        state: currentPhase(),
        bundle: { files: index.files.length, bytes: index.bytes },
      }), 'utf8')
      try {
        discoverySocket.send(reply, rinfo.port, rinfo.address)
      } catch { /* 回不出去就算了，对方会走扫描 */ }
    })
    discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0')
  } catch (err) {
    pushLog('⚠️ UDP 发现未启动：' + (err && err.message ? err.message : String(err)))
    discoverySocket = null
  }

  const lanAddresses = listLanAddresses()
  const urls = lanAddresses.map((a) => 'http://' + a.address + ':' + bound + '/')
  const pageUrl = urls[0] || 'http://127.0.0.1:' + bound + '/'

  pushLog('🌐 发送端已启动，端口 ' + bound + '，bundle：' + index.files.length + ' 个文件 / ' + formatBytes(index.bytes))
  pushLog('   配对码 ' + gate.code + '，' + Math.round((options.codeTtlMs || 5 * 60_000) / 60000) + ' 分钟内有效')
  if (urls.length === 0) {
    pushLog('⚠️ 没有找到局域网 IPv4 地址：这台机器可能没连网络，或只有回环')
  }

  return {
    port: bound,
    urls,
    pageUrl,
    // 刻意用 getter：配对码会在「传输中断后自动换码」与 action="renew" 时变化，
    // 如果这里返回的是启动那一刻的字符串，工具输出与页面就会各说各话。
    get code() { return gate.code },
    get expiresAt() { return gate.expiresAt },
    alias,
    bundle: { dir: index.dir, files: index.files.length, bytes: index.bytes },
    progress,
    state: (local = true) => snapshot(local),
    logs: () => logs.slice(),
    /** 当前会话（给工具层看状态用，不含 token）。 */
    session: () => (session === null ? null : {
      id: session.id, state: session.state, client: session.client,
      createdAt: session.createdAt, decidedAt: session.decidedAt, result: session.result,
    }),
    regenerate: () => {
      const code = gate.regenerate()
      pushLog('🔄 配对码已更换：' + code)
      scheduleBroadcast()
      return code
    },
    close: () => new Promise((resolve) => {
      hub.closeAll()
      if (broadcastTimer !== null) clearTimeout(broadcastTimer)
      if (discoverySocket !== null) {
        try { discoverySocket.close() } catch { /* 已关 */ }
        discoverySocket = null
      }
      try { server.close(() => resolve()) } catch { resolve() }
      // closeAll 之后仍可能有挂起的长连接（SSE/stream），强制断开避免 close 永远不回调。
      setTimeout(() => {
        try { server.closeAllConnections && server.closeAllConnections() } catch { /* 老版本没有此方法 */ }
        resolve()
      }, 1500).unref?.()
    }),
  }
}

// 常量 PART_SUFFIX 由接收端使用；这里不再转出，避免 index.js 误以为发送端也在写临时文件。

