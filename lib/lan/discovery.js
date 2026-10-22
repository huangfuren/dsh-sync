// lib/lan/discovery.js — 局域网内找装有 dsh-sync 的机器。零依赖。
//
// 两条路，不是「二选一」而是「先快后稳」：
//   ① UDP 广播（默认）：一次广播，等了 1.2 秒就有结果，几乎无成本。
//      但广播会被 Windows 防火墙拦、会被交换机 ACL 丢、会被「公用网络」配置挡住 ——
//      成功率大概八成，所以必须有兜底。
//   ② 逐 IP 扫描：对着 /24 一个个打 /info。254 个地址、并发 32、单个超时 350ms，
//      整段约 3 秒。慢，但不需要广播权限，因此几乎总能给出答案。
// 用户看到的差异只是「等 1 秒」还是「等 3 秒」，而失败时能明确说出「广播没回音，
// 已改成逐个扫描」—— 这比一句「没找到设备」有用得多。
import dgram from 'node:dgram'

import {
  DISCOVERY_PORT, DISCOVERY_REQUEST, LAN_PROTOCOL_VERSION, LAN_SERVICE_ID,
} from './constants.js'
import { intToIp, listLanAddresses, requestJson, runPool } from './net.js'

/** 校验一个 /info 响应是不是我们的服务。 */
export function isOurInfo(json) {
  return Boolean(json) && typeof json === 'object'
    && json.service === LAN_SERVICE_ID
    && Number(json.proto) >= 1
}

/**
 * 把一条发现结果规范化。**不认识的服务一律返回 null** —— 端口 38473 可能被别的程序占着，
 * 那时对面会回一个 404 HTML，把它的响应当设备列出来只会让用户更难判断。
 */
export function toDevice(json, address) {
  if (!isOurInfo(json)) return null
  return {
    address: String(address || ''),
    port: Number(json.port) || 0,
    alias: String(json.alias || json.hostname || address || ''),
    hostname: String(json.hostname || ''),
    version: String(json.version || ''),
    proto: Number(json.proto) || 0,
    state: String(json.state || 'unknown'),
    bundle: json.bundle && typeof json.bundle === 'object'
      ? { files: Number(json.bundle.files) || 0, bytes: Number(json.bundle.bytes) || 0 }
      : null,
    via: '',
  }
}

/**
 * UDP 广播发现。
 * @param {object} [options]
 * @param {number} [options.port] 发现端口（默认 38472）
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{devices:object[], errors:string[], targets:string[]}>}
 */
export function discoverOverUdp(options = {}) {
  const port = Number(options.port) || DISCOVERY_PORT
  const timeoutMs = Number(options.timeoutMs) || 1200
  const targets = new Set(['255.255.255.255'])
  const errors = []
  for (const a of listLanAddresses()) {
    if (a.broadcast) targets.add(a.broadcast)
  }

  return new Promise((resolve) => {
    const devices = new Map()
    let sock
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try { sock && sock.close() } catch { /* 已经关了 */ }
      resolve({ devices: Array.from(devices.values()), errors, targets: Array.from(targets) })
    }

    try {
      sock = dgram.createSocket('udp4')
    } catch (err) {
      errors.push('创建 UDP socket 失败: ' + (err && err.message ? err.message : String(err)))
      resolve({ devices: [], errors, targets: Array.from(targets) })
      return
    }

    sock.on('error', (err) => {
      // 最常见的一条：EACCES（防火墙/权限）。记下来，让上层去走扫描兜底。
      errors.push('UDP: ' + (err && err.message ? err.message : String(err)))
      finish()
    })
    sock.on('message', (msg, rinfo) => {
      let json = null
      try { json = JSON.parse(msg.toString('utf8')) } catch { return }
      const dev = toDevice(json, rinfo.address)
      if (dev === null) return
      dev.via = 'udp'
      devices.set(dev.address, dev)
    })

    sock.bind(0, () => {
      try {
        sock.setBroadcast(true)
      } catch (err) {
        errors.push('开启广播失败: ' + (err && err.message ? err.message : String(err)))
      }
      const payload = Buffer.from(DISCOVERY_REQUEST, 'utf8')
      for (const t of targets) {
        // 逐个发，个别地址发不出去（比如网卡已断）不该让整轮失败。
        try {
          sock.send(payload, port, t, (err) => { if (err) errors.push(t + ': ' + err.message) })
        } catch (err) {
          errors.push(t + ': ' + (err && err.message ? err.message : String(err)))
        }
      }
      setTimeout(finish, timeoutMs)
    })
  })
}

/**
 * 逐 IP 扫描兜底。只扫 /24 及更紧的网段（`hostCount <= 254`），避免误扫一个 /16 扫出 6 万个地址。
 * @param {object} [options]
 * @param {object[]} [options.subnets] 默认取本机所有局域网网卡
 * @param {number} [options.servicePort] 目标服务端口，默认 38473
 */
export async function discoverByScan(options = {}) {
  const port = Number(options.servicePort) || 38473
  const timeoutMs = Number(options.timeoutMs) || 350
  const concurrency = Number(options.concurrency) || 32
  const subnets = (options.subnets || listLanAddresses()).filter((s) => s.hostCount <= 254)
  if (subnets.length === 0) return { devices: [], errors: ['没有可扫描的局域网网段（/24 及更小）'], scanned: 0 }

  const ips = []
  for (const s of subnets) {
    for (let i = 1; i <= Math.min(254, s.hostCount); i++) {
      ips.push(intToIp((s.baseInt + i) >>> 0))
    }
  }
  // 上限保护：多网卡 + 多网段的机器也不该一次打上千个地址。
  const capped = ips.slice(0, 512)
  const results = await runPool(capped, concurrency, async (ip) => {
    const r = await requestJson({ host: ip, port, method: 'GET', path: '/info', timeoutMs })
    const dev = r.status === 200 ? toDevice(r.json, ip) : null
    if (dev === null) return null
    dev.via = 'scan'
    return dev
  })
  const devices = results.filter(Boolean)
  const errors = ips.length > capped.length
    ? ['地址数超过 512，只扫描了前 512 个；如目标不在其中请直接给 IP']
    : []
  return { devices, errors, scanned: capped.length }
}

/**
 * 发现入口：先广播，没结果且允许扫描时再逐 IP 扫。
 * @param {object} [options]
 * @param {number} [options.servicePort]
 * @param {boolean} [options.scan] 广播失败时是否兜底扫描（默认 true）
 * @param {number} [options.udpTimeoutMs]
 * @param {(line:string)=>void} [options.onLog]
 */
export async function discoverDevices(options = {}) {
  const log = options.onLog || (() => {})
  const udp = await discoverOverUdp({ timeoutMs: options.udpTimeoutMs || 1200 })
  if (udp.devices.length > 0) {
    return { devices: udp.devices, via: 'udp', notes: udp.errors, scanned: 0 }
  }

  const notes = udp.errors.slice()
  if (udp.errors.length === 0) {
    notes.push('广播已发出但没有任何回应（常见原因：对方防火墙拦了入站 UDP，或两台机器不在同一子网）')
  }
  if (options.scan === false) {
    return { devices: [], via: 'udp', notes, scanned: 0 }
  }

  log('广播没有回应，改为逐个扫描局域网地址（约 3 秒）...')
  const scan = await discoverByScan({ servicePort: options.servicePort, timeoutMs: options.scanTimeoutMs })
  notes.push(...scan.errors)
  return {
    devices: scan.devices,
    via: 'scan',
    notes,
    scanned: scan.scanned,
  }
}

/**
 * 把用户给的「IP / IP:端口 / 机器名」解析成连接目标。
 *
 * 刻意不猜：机器名匹配到多个时抛错并列出候选，而不是随便挑一个 ——
 * 挑错了就是把 bundle 传给一台不该收到的机器。
 *
 * @param {string} input
 * @param {object} [options]
 * @returns {Promise<{address:string, port:number, device:object|null, notes:string[]}>}
 */
export async function resolveTarget(input, options = {}) {
  const raw = String(input === undefined || input === null ? '' : input).trim()
  if (raw === '') throw new Error('缺少目标地址：给对端 IP（例如 192.168.1.23），或先跑 dshsync_lan_discover 看有哪些机器')
  const notes = []
  const defaultPort = Number(options.defaultPort) || 38473

  const withPort = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/.exec(raw)
  if (withPort) return { address: withPort[1], port: Number(withPort[2]), device: null, notes }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw)) {
    // 正则只管形状，不管范围：'999.1.1.1' 也能过，所以逐段再校验一次。
    const parts = raw.split('.').map(Number)
    if (parts.some((n) => n > 255)) throw new Error('不是合法的 IPv4 地址: ' + raw)
    return { address: raw, port: defaultPort, device: null, notes }
  }

  // 走到这里说明给的是机器名 / 别名 —— 先去问一遍局域网。
  const found = await discoverDevices({ servicePort: defaultPort, onLog: options.onLog })
  const needle = raw.toLowerCase()
  const exact = found.devices.filter((d) => d.alias.toLowerCase() === needle || d.hostname.toLowerCase() === needle)
  if (exact.length === 1) return { address: exact[0].address, port: exact[0].port || defaultPort, device: exact[0], notes }
  if (exact.length > 1) {
    throw new Error('「' + raw + '」匹配到 ' + exact.length + ' 台机器，请直接用 IP：'
      + exact.map((d) => d.address).join(', '))
  }
  const fuzzy = found.devices.filter((d) => d.alias.toLowerCase().includes(needle) || d.hostname.toLowerCase().includes(needle))
  if (fuzzy.length === 1) {
    return { address: fuzzy[0].address, port: fuzzy[0].port || defaultPort, device: fuzzy[0], notes }
  }
  if (fuzzy.length > 1) {
    throw new Error('「' + raw + '」模糊匹配到多台机器，请直接用 IP：'
      + fuzzy.map((d) => d.alias + '@' + d.address).join(', '))
  }
  throw new Error('局域网里没找到「' + raw + '」。'
    + (found.devices.length > 0
      ? '看到的机器：' + found.devices.map((d) => d.alias + '@' + d.address).join(', ')
      : '先在对端跑 dshsync_lan_host 打开接收服务，或直接用对端 IP'))
}
