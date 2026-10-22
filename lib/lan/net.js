// lib/lan/net.js — 本机网卡枚举、子网推导、HTTP 小工具。零依赖。
//
// 只做 IPv4。IPv6 的链路本地地址需要 scope id（`fe80::1%以太网`），在 Windows 上
// 拼 URL 极易出错，而局域网直传没有理由为了 IPv6 引入这类坑。
import http from 'node:http'
import os from 'node:os'

/** 点分十进制 ↔ 32 位整数。 */
export function ipToInt(ip) {
  return String(ip).split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0)
}
export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/**
 * 由地址与掩码推导子网。
 * `broadcast` 是给 UDP 发现用的定向广播地址 —— 它比 255.255.255.255 更可靠，
 * 后者在部分 Windows 网卡配置与交换机 ACL 下会被直接丢掉。
 */
export function subnetOf(address, netmask) {
  const addrInt = ipToInt(address)
  const maskInt = ipToInt(netmask)
  const baseInt = (addrInt & maskInt) >>> 0
  const broadcastInt = (baseInt | (~maskInt)) >>> 0
  // 前缀长度：数掩码高位的连续 1，用来判断这个网段值不值得整段扫描。
  let m = maskInt >>> 0
  let prefix = 0
  while ((m & 0x80000000) !== 0) { prefix += 1; m = (m << 1) >>> 0 }
  return {
    address,
    netmask,
    prefix,
    baseInt,
    broadcastInt,
    network: intToIp(baseInt),
    broadcast: intToIp(broadcastInt),
    cidr: intToIp(baseInt) + '/' + prefix,
    /** 可用主机数（去掉网络地址与广播地址）。 */
    hostCount: Math.max(0, broadcastInt - baseInt - 1),
  }
}

/**
 * 本机所有可用的局域网 IPv4 网卡。
 *
 * 跳过三类，理由各不相同：
 *   · internal —— 回环，局域网直传没有意义；
 *   · 169.254.0.0/16 —— 自动私有地址（DHCP 失败），对端不可能在这个段上；
 *   · 127.0.0.1 —— 同上。
 * 不跳过 172.17/172.18 这类 Docker 网段：WSL 与 Docker Desktop 也会用它们，
 * 但**用户真在两台机器间传输时用的网卡一定在其中之一**，多列几个让用户自己挑，
 * 比替他判断掉了正确选项要好。
 */
export function listLanAddresses() {
  const out = []
  let ifaces = {}
  try {
    ifaces = os.networkInterfaces()
  } catch {
    return out
  }
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal) continue
      if (String(a.address).startsWith('169.254.')) continue
      if (String(a.address) === '127.0.0.1') continue
      try {
        out.push({ iface: name, ...subnetOf(a.address, a.netmask) })
      } catch { /* 掩码解析失败就跳过这张网卡，不因一张网卡让整个发现失效 */ }
    }
  }
  return out
}

/** 本机地址集合，用于判断「这个请求是不是本机发起的」。 */
export function localAddressSet() {
  const set = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  for (const a of listLanAddresses()) set.add(a.address)
  return set
}

/**
 * 请求是否来自本机。
 *
 * 这是「接受按钮只有本机主人能点」这条边界的实现依据：页面绑定在局域网 IP 上，
 * 别的机器打开同一个 URL 也能看到页面，但**只有源地址属于本机网卡时才允许决定**。
 * 少这一层，同网段任何人都能替你点「接受」，配对码就形同虚设。
 */
export function isLocalRemote(remoteAddress, localSet) {
  const raw = String(remoteAddress || '')
  const set = localSet || localAddressSet()
  if (set.has(raw)) return true
  // Node 在双栈监听下把 IPv4 映射成 ::ffff:a.b.c.d
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  return m !== null && set.has(m[1])
}

function baseOptions({ host, port, method, path, timeoutMs, headers, signal }) {
  return {
    host, port, method, path,
    headers: headers || {},
    // agent:false —— 发现阶段要并发探测上百个 IP，keep-alive 池只会积压挂起的连接。
    agent: false,
    timeout: Math.max(1, Number(timeoutMs) || 5000),
    signal,
  }
}

/**
 * 发一个请求并读完整响应体。
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export function requestOnce(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseOptions(options), (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout after ' + (options.timeoutMs || 5000) + 'ms'))
    })
    req.on('error', reject)
    if (options.body !== undefined && options.body !== null) req.write(options.body)
    req.end()
  })
}

/** POST/GET JSON，把「网络错误」和「HTTP 错误」分开报，方便定位是网不通还是接口不对。 */
export async function requestJson(options) {
  const body = options.json === undefined ? (options.body || undefined) : Buffer.from(JSON.stringify(options.json), 'utf8')
  const headers = Object.assign({ Accept: 'application/json' }, options.headers || {})
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = String(body.length)
  }
  const res = await requestOnce({ ...options, headers, body })
  let json = null
  let text = ''
  if (res.body.length > 0) {
    text = res.body.toString('utf8')
    try { json = JSON.parse(text) } catch { json = null }
  }
  return { status: res.status, json, text, headers: res.headers }
}

/**
 * 打开一个响应流（不读完），返回 Node 的 IncomingMessage 供 readFrames 消费。
 * 调用方负责 destroy。
 */
export function openStream(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseOptions(options), (res) => resolve({ res, req }))
    req.on('timeout', () => req.destroy(new Error('timeout after ' + (options.timeoutMs || 5000) + 'ms')))
    req.on('error', reject)
    if (options.body !== undefined && options.body !== null) req.write(options.body)
    req.end()
  })
}

/** 服务端：读完整请求体，带上限（避免被一个大 body 拖死）。 */
export function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(new Error('request body exceeds ' + maxBytes + ' B'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 服务端：读 JSON body，空 body 视为 {}。 */
export async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes)
  if (buf.length === 0) return {}
  const text = buf.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid JSON body: ' + text.slice(0, 200))
  }
}

/** 服务端：回一个 JSON。 */
export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 简单的并发池。发现阶段的整段扫描靠它限流。 */
export async function runPool(items, concurrency, worker) {
  const list = Array.from(items)
  const results = new Array(list.length)
  let next = 0
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= list.length) return
      try {
        results[i] = await worker(list[i], i)
      } catch {
        results[i] = null   // 单个目标失败不该影响整段扫描
      }
    }
  })
  await Promise.all(runners)
  return results
}
