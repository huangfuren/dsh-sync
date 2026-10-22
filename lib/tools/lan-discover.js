// lib/tools/lan-discover.js — dshsync_lan_discover：看局域网里哪些机器开着发送端。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DISCOVERY_PORT } from '../lan/constants.js'
import { discoverDevices } from '../lan/discovery.js'
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
      'is found, the notes explain which layer blocked it.',
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

      const out = []
      out.push('📡 局域网发现')
      const lan = listLanAddresses()
      out.push('   本机网卡 ' + (lan.length === 0 ? '（无）'
        : lan.map((a) => a.iface + ' ' + a.address + ' (' + a.cidr + ')').join('；')))
      out.push('   方式     ' + (found.via === 'udp' ? 'UDP 广播' : '逐地址扫描' + (found.scanned ? '（' + found.scanned + ' 个地址）' : '')))
      out.push('')

      if (found.devices.length === 0) {
        out.push('   没有找到开着的发送端。')
        out.push('')
        out.push('   按可能性排查：')
        out.push('     1. 源机上还没跑 dshsync_lan_host（要先把 bundle 导出，再起发送端）')
        out.push('     2. 两台机器不在同一个子网（一个连 Wi-Fi、一个连有线，或一个走了 VPN）')
        out.push('     3. 源机防火墙拦了入站 UDP ' + DISCOVERY_PORT + ' 与 TCP 38473')
        out.push('     4. 路由器开了「AP 隔离 / 客户端隔离」，同网段也不互通')
        out.push('')
        out.push('   兜底：直接从源机的 dshsync_lan_host 输出里抄 IP，用 dshsync_lan_pull(host="<那个 IP>") 连。')
      } else {
        found.devices.forEach((d, i) => {
          const state = d.state === 'pairing' ? '等待配对' : d.state === 'waiting' ? '有请求待确认' : d.state
          const bundle = d.bundle && d.bundle.files > 0
            ? d.bundle.files + ' 个文件 / ' + formatBytes(d.bundle.bytes)
            : '未报告体积'
          out.push('   ' + (i + 1) + '. ' + d.alias)
          out.push('      地址 ' + d.address + ':' + (d.port || 38473) + '   ' + bundle + '   ' + state)
          if (d.hostname && d.hostname !== d.alias) out.push('      主机 ' + d.hostname)
        })
        out.push('')
        out.push('   下一步：')
        const first = found.devices[0]
        out.push('     dshsync_lan_pull(host="' + first.address + '", code="<源机页面上的 6 位码>",')
        out.push('                      destDir="<新机器上的空目录>", workspaceRoot="<项目落位根>")')
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
        count: found.devices.length,
        devices: found.devices.map((d) => ({
          alias: d.alias,
          address: d.address,
          port: d.port,
          state: d.state,
          files: d.bundle ? d.bundle.files : 0,
          bytes: d.bundle ? d.bundle.bytes : 0,
          via: d.via,
        })),
        summary: found.devices.length === 0
          ? '没有找到开着的发送端'
          : '找到 ' + found.devices.length + ' 台：' + found.devices.map((d) => d.alias + '@' + d.address).join('，'),
        log: out.join('\n'),
      }
    },
  })
}
