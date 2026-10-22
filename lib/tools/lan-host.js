// lib/tools/lan-host.js — dshsync_lan_host：在源机起一个局域网发送端。
// 工具层依赖 @deepseek-ai/dsh-tools；lib/lan/* 则刻意保持零依赖，方便单测与脚本复用。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { LAN_DEFAULT_PORT } from '../lan/constants.js'
import { startHost } from '../lan/host.js'
import { closeHost, getHost, setHost } from '../lan/jobs.js'
import { listLanAddresses } from '../lan/net.js'
import { formatBytes } from '../lan/progress.js'

/**
 * 发送端只吃一个配置项：bundle 目录缺省时回退到 `config.outDir`。
 *
 * 为什么值得省这一个参数：`outDir` **本身就是 bundle 目录**（exportBundle 里
 * `bundleDir = path.resolve(outDir)`），导出的落点就是要发送的目录，让用户把同一个
 * 路径再手抄一遍纯属折磨。其余（端口、别名、绑定地址）仍然只由本次调用决定。
 */
export function defineLanHostTool(getConfig) {
  return defineTool({
    name: 'dshsync_lan_host',
    description:
      'Serve a dsh-sync bundle over the local network so the new machine can pull it directly — no USB ' +
      'drive, no cloud drive, no re-copying. Starts an HTTP service, prints a 6-digit pairing code and the ' +
      'URL of a live progress page. The transfer only begins after YOU click "accept" on that page, on ' +
      'this machine; someone who merely learns the code still cannot pull the bundle. Pairing codes are ' +
      'single-use and expire after 5 minutes. Returns immediately — the service keeps running in the ' +
      'background so the conversation is not blocked. Use action="renew" to issue a fresh code after the ' +
      'old one expires, and action="stop" to shut the service down.',
    parameters: {
      bundleDir: { type: 'string', description: 'The bundle produced by dshsync_export. Defaults to the configured output directory (config.outDir), which is exactly where dshsync_export wrote it.' },
      action: { type: 'string', description: 'start (default) | renew (new pairing code) | stop (shut down the service).' },
      alias: { type: 'string', description: 'Name shown on the other machine. Defaults to the hostname.' },
      port: { type: 'number', description: 'Preferred port (default 38473). If busy, the next 10 are tried.' },
      bind: { type: 'string', description: 'Interface to bind. Default 0.0.0.0 (all).' },
      ttlMinutes: { type: 'number', description: 'Pairing-code lifetime in minutes (default 5).' },
      allowPublic: { type: 'boolean', description: 'Allow connections from non-private (public) addresses. Default false — a bundle on a public port is a real leak.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          code: { type: 'string', required: true },
          port: { type: 'number', required: true },
          urls: { type: 'array', items: { type: 'string' }, required: true },
          pageUrl: { type: 'string', required: true },
          expiresAt: { type: 'number', required: true },
          summary: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 120_000,
    async execute(args) {
      const action = String(args.action || 'start').toLowerCase()

      if (action === 'stop') {
        const had = await closeHost()
        const log = had ? '⏹ 发送端已停止（配对码与服务一并失效）' : '当前没有运行中的发送端'
        return { ok: true, action, code: '', port: 0, urls: [], pageUrl: '', expiresAt: 0, summary: '已停止', log }
      }

      if (action === 'renew') {
        const host = getHost()
        if (host === null) throw new Error('当前没有运行中的发送端，先跑 action="start"（bundleDir 缺省取配置里的输出目录）')
        const code = host.regenerate()
        const log = [
          '🔄 配对码已更换',
          '   新码 ' + formatCode(code),
          '   进度页 ' + host.pageUrl,
          '   旧码与旧 token 已失效（已完成的传输不受影响）。',
        ].join('\n')
        return {
          ok: true, action, code, port: host.port, urls: host.urls, pageUrl: host.pageUrl,
          expiresAt: host.expiresAt, summary: '配对码已更换为 ' + formatCode(code), log,
        }
      }

      const cfg = (typeof getConfig === 'function' ? getConfig() : null) || {}
      const bundleDir = String(args.bundleDir || cfg.outDir || '').trim()
      if (bundleDir === '') {
        throw new Error('bundleDir is required（先跑 dshsync_export 生成 bundle，或在设置卡片里填「输出目录」）')
      }

      // 已经在跑就先关掉：端口固定，重开必然冲突，而且两台发送端会让「点哪个页面」变得含糊。
      if (getHost() !== null) await closeHost()

      const logs = []
      const host = await startHost({
        bundleDir,
        alias: String(args.alias || ''),
        port: Number(args.port) || LAN_DEFAULT_PORT,
        bind: String(args.bind || '0.0.0.0'),
        codeTtlMs: Number(args.ttlMinutes) > 0 ? Math.round(Number(args.ttlMinutes) * 60_000) : undefined,
        allowPublic: args.allowPublic === true,
        onLog: (line) => logs.push(line),
      })
      setHost(host)

      const lan = listLanAddresses()
      const out = []
      out.push('🌐 发送端已启动')
      out.push('')
      out.push('   配对码   ' + formatCode(host.code) + '    （' + Math.round((host.expiresAt - Date.now()) / 60000) + ' 分钟内有效，只能用一次）')
      out.push('   进度页   ' + host.pageUrl + '    ← 浏览器打开，确认请求和进度都在这里')
      out.push('   bundle   ' + host.bundle.files + ' 个文件 / ' + formatBytes(host.bundle.bytes))
      out.push('   目录     ' + host.bundle.dir)
      out.push('')
      if (host.urls.length === 0) {
        out.push('⚠️ 没有找到局域网 IPv4 地址：这台机器可能没连网络。也可以试试直连回环（仅同机测试）。')
      } else {
        out.push('   在新机器上跑：')
        out.push('     dshsync_lan_pull(host="' + lanIp(lan) + '", code="' + host.code + '",')
        out.push('                       destDir="<新机器上的一个空目录>", workspaceRoot="<项目落位根>")')
        out.push('')
        if (host.urls.length > 1) {
          out.push('   本机其它网卡地址（如果上面那个连不上，换一个试）：')
          for (const u of host.urls.slice(1)) out.push('     ' + u)
        }
      }
      out.push('')
      out.push('   然后回到本机的进度页点「接受并开始传输」—— 不点就不会传，配对码对了也不传。')
      out.push('')
      out.push('   ⚠️ Windows 首次监听会弹防火墙提示，选「专用网络」允许；否则对方连不上。')
      out.push('   ⚠️ 传输期间别退出 DSH，也别关这台机器的网络。')

      return {
        ok: true,
        action: 'start',
        code: host.code,
        port: host.port,
        urls: host.urls,
        pageUrl: host.pageUrl,
        expiresAt: host.expiresAt,
        summary: '发送端已启动，配对码 ' + formatCode(host.code) + '，等待对方在新机器上输入',
        log: out.join('\n'),
      }
    },
  })
}

/** 配对码显示成 "123 456"，对着屏幕输入时不容易串行。 */
function formatCode(code) {
  const s = String(code || '')
  return s.length === 6 ? s.slice(0, 3) + ' ' + s.slice(3) : s
}

function lanIp(lan) {
  const first = Array.isArray(lan) && lan.length > 0 ? lan[0].address : '<本机局域网 IP>'
  return first
}
