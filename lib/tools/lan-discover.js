// lib/tools/lan-discover.js — dshsync_lan_discover：看局域网里哪些机器开着发送端。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DISCOVERY_PORT } from '../lan/constants.js'
import { discoverDevices } from '../lan/discovery.js'
import { getDevices, setDevices } from '../lan/devices.js'
import { listLanAddresses } from '../lan/net.js'
import { formatBytes } from '../lan/progress.js'

export function defineLanDiscoverTool(getConfig) {
  return defineTool({
    name: 'dshsync_lan_discover',
    description:
      'Find machines on the local network that are currently serving a dsh-sync bundle, so nobody has to ' +
      'read an IP off another screen. Broadcasts a UDP probe (fast, ~1s) and, if that gets no answer, falls ' +
      'back to probing every address in the local /24 (slower, ~3s, works even when broadcast is blocked). ' +
      'Reports every machine found with its name, address, pending bundle size and whether it is waiting ' +
      'for pairing. Use this before dshsync_lan_pull when the source machine\'s IP is not known; if nothing ' +
      'is found, the notes explain which layer blocked it. Every entry carries a stable id and a 1-based ' +
      'index: the result is remembered, so dshsync_lan_pull can then take deviceId (id, index, alias or IP) ' +
      'instead of a hand-copied host, and the same machine can be picked by clicking it in the settings card.',
    parameters: {
      scan: { type: 'boolean', description: 'Fall back to a per-address scan when the broadcast gets no reply (default true). Set false for a fast answer only.' },
      discoveryPort: { type: 'number', description: 'UDP discovery port (default 38472). Only change it if something else owns that port.' },
      timeoutMs: { type: 'number', description: 'How long to listen for broadcast replies, in ms (default 1200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'number', required: true },
          devices: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          summary: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 90_000,
    async execute(args) {
      const logs = []
      const found = await discoverDevices({
        servicePort: 38473,
        scan: args.scan !== false,
        udpTimeoutMs: Number(args.timeoutMs) || 1200,
        onLog: (line) => logs.push(line),
      })
      // 登记结果：这一步是「先选中设备，再迁移」的枢纽 ——
      // 之后 dshsync_lan_pull(deviceId=…) 才能引用到这里的某一台。
      const devices = (setDevices(found.devices), getDevices())

      const out = []
      out.push('📡 局域网发现')
      const lan = listLanAddresses()
      out.push('   本机网卡 ' + (lan.length === 0 ? '（无）'
        : lan.map((a) => a.iface + ' ' + a.address + ' (' + a.cidr + ')').join('；')))
      out.push('   方式     ' + (found.via === 'udp' ? 'UDP 广播' : '逐地址扫描' + (found.scanned ? '（' + found.scanned + ' 个地址）' : '')))
      out.push('')

      if (devices.length === 0) {
        out.push('   没有找到开着的发送端。')
        out.push('')
        out.push('   按可能性排查：')
        out.push('     1. 源机上还没跑 dshsync_lan_host（要先把 bundle 导出，再起发送端）')
        out.push('     2. 两台机器不在同一个子网（一个连 Wi-Fi、一个连有线，或一个走了 VPN）')
        out.push('     3. 源机防火墙拦了入站 UDP ' + DISCOVERY_PORT + ' 与 TCP 38473')
        out.push('     4. 路由器开了「AP 隔离 / 客户端隔离」，同网段也不互通')
        out.push('')
        out.push('   兜底：直接从源机的 dshsync_lan_host 输出里抄 IP，用 dshsync_lan_pull(host="<那个 IP>") 连。')
        out.push('   或在设置 → 内置插件 → dsh-sync 迁移 卡片里点「扫描」。')
      } else {
        devices.forEach((d) => {
          const state = d.state === 'pairing' ? '等待配对' : d.state === 'waiting' ? '有请求待确认' : d.state
          const bundle = d.files > 0
            ? d.files + ' 个文件 / ' + formatBytes(d.bytes)
            : '未报告体积'
          out.push('   ' + d.index + '. ' + d.alias + '   #' + d.id)
          out.push('      地址 ' + d.address + ':' + d.port + '   ' + bundle + '   ' + state)
          if (d.hostname && d.hostname !== d.alias) out.push('      主机 ' + d.hostname)
        })
        out.push('')
        out.push('   先选中一台，再迁移（两种方式）：')
        out.push('     · 在设置 → 内置插件 → dsh-sync 迁移 卡片里点「扫描」，然后点选其中一台')
        out.push('     · 或用序号直接拉（下面用第 1 台举例）：')
        const first = devices[0]
        out.push('       dshsync_lan_pull(deviceId="' + first.index + '", code="<源机页面上的 6 位码>",')
        out.push('                        destDir="<新机器上的空目录>", workspaceRoot="<项目落位根>")')
        out.push('')
        out.push('   选中之后，dshsync_lan_pull 不写 host / deviceId 也会用选中的那台。')
      }

      if (found.notes.length > 0) {
        out.push('')
        out.push('   注：')
        for (const n of found.notes.slice(0, 6)) out.push('     · ' + n)
      }
      if (logs.length > 0) {
        out.push('')
        for (const l of logs) out.push('   ' + l)
      }

      return {
        ok: true,
        count: devices.length,
        devices: devices.map((d) => ({
          id: d.id,
          index: d.index,
          alias: d.alias,
          address: d.address,
          port: d.port,
          state: d.state,
          files: d.files,
          bytes: d.bytes,
          via: d.via,
        })),
        summary: devices.length === 0
          ? '没有找到开着的发送端'
          : '找到 ' + devices.length + ' 台：' + devices.map((d) => '#' + d.index + ' ' + d.alias + '@' + d.address).join('，'),
        log: out.join('\n'),
      }
    },
  })
}
