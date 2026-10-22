// lib/tools/lan-pull.js — dshsync_lan_pull：在新机器上一条命令拉完并落地。
//
// 刻意做成「起后台任务、立刻返回」：一次传输 + 落地 + 核验可能十几分钟，
// 而 DSH 的工具调用在执行期间没有流式通道。返回 jobId 与进度页地址，
// 之后用 dshsync_lan_status 查 —— 这比让对话卡十几分钟好得多。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolvePullTarget, startPull } from '../lan/pull-runner.js'
import { formatBytes } from '../lan/progress.js'

// 卡片上的「开始迁移」也用同一个解析函数，这里顺手再导出，测试可直接 import。
export { resolvePullTarget }

// 「从哪台机器拉」与「怎么拉」都在 lib/lan/pull-runner.js —— 卡片上的「开始迁移」走同一份实现。

export function defineLanPullTool(getConfig) {
  return defineTool({
    name: 'dshsync_lan_pull',
    description:
      'Pull a dsh-sync bundle straight off the source machine over the LAN, then land it — one command for ' +
      'the whole "copy it over" step. It connects, exchanges the 6-digit pairing code, waits until someone ' +
      'clicks accept on the source machine\'s page, streams the files (verifying sha256 per file), and then ' +
      'runs apply + verify automatically (autoApply / autoVerify, both default on). Re-running after an ' +
      'interruption resumes: already-received files whose hash matches are skipped. Returns immediately with ' +
      'a jobId and a local progress page URL — the transfer continues in the background; poll it with ' +
      'dshsync_lan_status. The source is chosen by host, or by deviceId (id / 1-based index / alias / IP) ' +
      'from a previous dshsync_lan_discover, or by clicking a machine in the settings card — with neither ' +
      'host nor deviceId the currently selected device is used. The job state lives in memory, so a plugin ' +
      'reload or DSH restart loses it (the files already received stay on disk and can be resumed).',
    parameters: {
      host: { type: 'string', description: 'Source machine IP (or a name found by dshsync_lan_discover). For "ip:port" both are parsed.' },
      deviceId: { type: 'string', description: 'Pick a machine found by dshsync_lan_discover or clicked in the settings card: its id ("ip:port"), its 1-based index ("1"), alias or IP. Omit BOTH host and deviceId to use the device currently selected in the settings card — when nothing is selected the tool says so instead of guessing.' },
      code: { type: 'string', description: 'The 6-digit pairing code from the source machine\'s page/tool output.' },
      destDir: { type: 'string', description: 'Where to put the bundle on THIS machine. Must NOT be inside $DSH_HOME.' },
      workspaceRoot: { type: 'string', description: 'Where to expand the packaged project directories (<workspaceRoot>/<name>). Required when the bundle contains workspaces, otherwise apply stops before writing anything.' },
      workspaceMap: { type: 'object', additionalProperties: true, description: 'Per-project override: {"dsh-chat": "E:/other/dsh-chat"}.' },
      dshHome: { type: 'string', description: 'Target $DSH_HOME. Empty = env or ~/.dsh.' },
      autoApply: { type: 'boolean', description: 'Run apply after the transfer (default true). It first runs a dry run and stops if that finds a fatal problem, so nothing is written on a bad bundle.' },
      autoVerify: { type: 'boolean', description: 'Run the invariant check after apply (default true).' },
      overwrite: { type: 'boolean', description: 'Write into destDir even if it already holds unrelated files (default false; a resumable bundle is always allowed).' },
      allowSameMachine: { type: 'boolean', description: 'Allow applying a bundle produced by this very machine (re-install recovery). Default false.' },
      progressPort: { type: 'number', description: 'Local progress page port (default 38474, bound to 127.0.0.1 only).' },
      wait: { type: 'boolean', description: 'Block until the transfer finishes instead of returning immediately. Only sensible for small bundles.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          jobId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          progressUrl: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 600_000,
    async execute(args) {
      const cfg = getConfig()
      const code = String(args.code || '').replace(/[\s\-_]/g, '')
      if (code === '') throw new Error('code is required（源机页面上的 6 位配对码）')
      const destDir = String(args.destDir || '').trim()
      if (destDir === '') throw new Error('destDir is required（新机器上放 bundle 的目录，不能是 $DSH_HOME 内部）')

      const target = await resolvePullTarget(args)
      const { job, pageUrl, runner } = await startPull({
        target,
        code,
        destDir,
        dshHome: String(args.dshHome || cfg.dshHome || ''),
        workspaceRoot: String(args.workspaceRoot || ''),
        workspaceMap: args.workspaceMap && typeof args.workspaceMap === 'object' ? args.workspaceMap : {},
        autoApply: args.autoApply !== false,
        autoVerify: args.autoVerify !== false,
        overwrite: args.overwrite === true,
        allowSameMachine: args.allowSameMachine === true,
        progressPort: Number(args.progressPort) || 0,
      })

      const wantWait = args.wait === true
      if (wantWait) {
        const report = await runner
        const snap = job.progress.snapshot()
        const log = [
          report && report.ok ? '✅ 迁移完成' : '❌ 迁移失败',
          '',
          '   目标     ' + target.address + ':' + target.port
            + (target.device ? '（' + target.device.alias + '）' : ''),
          '   收到     ' + (report && report.received ? report.received.files + ' 个文件 / ' + formatBytes(report.received.bytes) : '—'),
          '   落地     ' + (report && report.apply ? (report.apply.ok ? '成功' + (report.apply.backupDir ? '（备份 ' + report.apply.backupDir + '）' : '') : report.apply.errorCount + ' 个错误') : '未执行'),
          '   核验     ' + (report && report.verify ? (report.verify.ok ? '全部通过' : report.verify.failed + ' 项失败') : '未执行'),
          '',
          (report && report.errors.length > 0 ? '错误：\n' + report.errors.slice(0, 10).map((e) => '  · ' + e).join('\n') : ''),
          job.logs.slice(-12).join('\n'),
        ].filter((x) => x !== '').join('\n')
        return {
          ok: Boolean(report && report.ok),
          jobId: job.id,
          state: job.state,
          progressUrl: pageUrl,
          summary: report && report.ok ? '迁移完成' : '迁移失败' + (snap.errorCount ? '（' + snap.errorCount + ' 个文件出错）' : ''),
          log,
        }
      }

      const out = []
      out.push('📥 已在后台开始拉取')
      out.push('')
      out.push('   目标     ' + target.address + ':' + target.port
        + (target.device ? '（' + target.device.alias + (target.device.id ? ' · #' + target.device.id : '') + '）' : ''))
      out.push('   落下到   ' + destDir)
      out.push('   jobId    ' + job.id)
      if (pageUrl !== '') out.push('   进度页   ' + pageUrl + '    ← 实时进度、速率、剩余时间')
      out.push('')
      out.push('   ⚠️ 还差一步：在**源机**的进度页上点「接受并开始传输」——不点就不会传。')
      out.push('      源机页面：http://' + target.address + ':' + target.port + '/')
      out.push('')
      out.push('   然后查进度与结果：')
      out.push('     dshsync_lan_status(jobId="' + job.id + '")')
      out.push('')
      out.push('   传完会自动落地并核验（autoApply / autoVerify 默认开）。')
      out.push('   中断了重新跑同一条命令即可续传：已收到且哈希一致的文件会跳过。')
      if (target.notes.length > 0) {
        out.push('')
        for (const n of target.notes) out.push('   · ' + n)
      }

      return {
        ok: true,
        jobId: job.id,
        state: 'running',
        progressUrl: pageUrl,
        summary: '已开始拉取，等待源机确认',
        log: out.join('\n'),
      }
    },
  })
}

