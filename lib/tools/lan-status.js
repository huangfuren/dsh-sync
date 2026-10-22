// lib/tools/lan-status.js — dshsync_lan_status：查后台任务与发送端的实时状态。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { getHost, getJob, listJobs } from '../lan/jobs.js'
import { formatBytes, formatDuration, summarizeProgress } from '../lan/progress.js'

export function defineLanStatusTool(getConfig) {
  return defineTool({
    name: 'dshsync_lan_status',
    description:
      'Report where the LAN transfer stands, on either side. Pass a jobId to inspect one pull (state, ' +
      'byte/file progress, speed, remaining time, and once finished: what apply changed and which ' +
      'invariants verify found). Omit jobId to see every known job plus the local host service (pairing ' +
      'code and remaining validity, whether a peer is waiting for confirmation, and the live transfer ' +
      'figures). Call this repeatedly while a transfer runs — the transfer itself happens in the ' +
      'background, so this is how you follow it. Job state is in memory: after a plugin reload or DSH ' +
      'restart, old jobIds are gone (any files already received are on disk and resume on the next pull).',
    parameters: {
      jobId: { type: 'string', description: 'The id returned by dshsync_lan_pull. Omit to list everything.' },
      verbose: { type: 'boolean', description: 'Include the recent log lines (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          running: { type: 'number', required: true },
          summary: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 30_000,
    async execute(args) {
      const verbose = args.verbose !== false
      const out = []
      const jobId = String(args.jobId || '').trim()

      if (jobId !== '') {
        const job = getJob(jobId)
        if (job === null) {
          const known = listJobs().map((j) => j.id)
          throw new Error('没有这个 jobId: ' + jobId
            + (known.length > 0
              ? '。已知的任务：' + known.join(', ')
              : '。当前没有任何任务 —— 插件重载或 DSH 重启后内存里的任务会丢，重新跑一次 dshsync_lan_pull 即可续传'))
        }
        out.push(...renderJob(job, verbose))
        return {
          ok: job.state !== 'failed',
          state: job.state,
          running: job.state === 'running' ? 1 : 0,
          summary: jobSummaryLine(job),
          log: out.join('\n'),
        }
      }

      // 无参数：发送端 + 全部任务
      const host = getHost()
      out.push('📊 dsh-sync 局域网状态')
      out.push('')
      if (host === null) {
        out.push('   发送端  未运行')
      } else {
        const s = host.state(true)
        const left = Math.max(0, (s.pair ? s.pair.remainingMs : 0))
        out.push('   发送端  运行中 · 端口 ' + host.port)
        out.push('   页面    ' + host.pageUrl)
        if (s.pair) {
          const code = String(s.pair.code || '')
          out.push('   配对码  ' + (code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code)
            + '   ' + (s.pair.used ? '（已使用）' : s.pair.locked ? '（已锁定，需换码）'
              : left > 0 ? '（还剩 ' + formatDuration(left) + '）' : '（已过期，用 action="renew" 换一个）'))
        }
        out.push('   会话    ' + (s.peer ? (s.peer.alias + ' @ ' + s.peer.address + ' · ' + sessionStateText(s.phase)) : '还没有人配对'))
        out.push('   传输    ' + summarizeProgress(s.progress))
      }

      const jobs = listJobs()
      out.push('')
      if (jobs.length === 0) {
        out.push('   任务    还没有任务。在新机器上跑 dshsync_lan_pull 开始。')
      } else {
        out.push('   任务    ' + jobs.length + ' 个'
          + (jobs.some((j) => j.state === 'running') ? '（' + jobs.filter((j) => j.state === 'running').length + ' 个进行中）' : ''))
        for (const j of jobs) {
          out.push('')
          out.push(...renderJob(j, false))
        }
      }

      const running = jobs.filter((j) => j.state === 'running').length
      return {
        ok: true,
        state: host === null && jobs.length === 0 ? 'idle' : (running > 0 ? 'running' : 'settled'),
        running,
        summary: host === null && jobs.length === 0
          ? '没有任何局域网活动'
          : (running > 0 ? running + ' 个任务进行中' : '没有进行中的任务'),
        log: out.join('\n'),
      }
    },
  })
}

function sessionStateText(phase) {
  const map = {
    pairing: '等待配对',
    waiting: '等待本机点「接受」',
    accepted: '已接受，等对方开始拉取',
    transferring: '正在传输',
    done: '已完成',
    failed: '失败或已拒绝',
  }
  return map[phase] || phase
}

function jobSummaryLine(job) {
  const snap = job.progress.snapshot()
  if (job.state === 'running') return '运行中：' + summarizeProgress(snap)
  if (job.state === 'done') return '已完成'
  return '失败：' + (job.error || '未知原因')
}

function renderJob(job, verbose) {
  const out = []
  const snap = job.progress.snapshot()
  const stateText = job.state === 'running' ? '进行中' : job.state === 'done' ? '已完成' : '失败'
  const icon = job.state === 'running' ? '⏳' : job.state === 'done' ? '✅' : '❌'
  out.push(icon + ' 任务 ' + job.id + '  ' + stateText
    + (job.peer ? '（← ' + job.peer.alias + ' ' + job.peer.address + '）' : ''))
  out.push('   ' + summarizeProgress(snap))
  if (snap.current) out.push('   当前   ' + snap.current)
  if (job.pageServer) out.push('   进度页 ' + job.pageServer.url)

  if (job.state !== 'running' && job.result) {
    const r = job.result
    if (r.received) {
      out.push('   收到   ' + r.received.files + ' 个文件 / ' + formatBytes(r.received.bytes)
        + (r.received.skipped > 0 ? '（续传跳过 ' + r.received.skipped + ' 个）' : ''))
    }
    if (r.apply) {
      out.push('   落地   ' + (r.apply.ok ? '成功' : r.apply.errorCount + ' 个错误')
        + (r.apply.backupDir ? '，改动前的文件备份在 ' + r.apply.backupDir : ''))
      for (const w of (r.apply.warnings || []).slice(0, 5)) out.push('     ⚠️ ' + w)
      for (const e of (r.apply.errors || []).slice(0, 8)) out.push('     ✗ ' + e)
    }
    if (r.verify) {
      out.push('   核验   ' + (r.verify.ok
        ? '全部通过' + (r.verify.warned > 0 ? '（' + r.verify.warned + ' 项告警）' : '')
        : r.verify.failed + ' 项失败'))
      const bad = (r.verify.checks || []).filter((c) => c.status !== 'PASS')
      for (const c of bad.slice(0, 8)) {
        out.push('     ' + (c.status === 'WARN' ? '⚠️' : '✗') + ' [' + c.id + '] ' + c.title + ' — ' + c.detail)
      }
    }
    if (r.bundleDir) out.push('   bundle ' + r.bundleDir)
  } else if (job.state === 'failed' && job.error) {
    out.push('   原因   ' + job.error)
  }
  if (snap.errorCount > 0) {
    for (const e of snap.errors.slice(-5)) out.push('   失败文件 ' + e.path + ' — ' + e.reason)
  }

  if (verbose && job.logs.length > 0) {
    out.push('   最近日志：')
    for (const line of job.logs.slice(-10)) out.push('     ' + line)
  }
  return out
}

