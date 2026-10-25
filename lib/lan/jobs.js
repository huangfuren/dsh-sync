// lib/lan/jobs.js — 后台任务的登记表。
//
// 为什么需要它：DSH 的工具调用是阻塞的（`DefineToolOptions.execute` 返回一个 Promise，
// 期间没有流式通道）。而一次迁移传输可能持续十几分钟到几十分钟。如果 `dshsync_lan_pull`
// 阻塞到传完才返回，会出现两个问题：对话在这一轮卡住，且工具自身的 timeoutMs 会把传输掐断。
//
// 所以 pull 是「起任务 → 立刻返回 jobId 与进度页地址 → 之后用 dshsync_lan_status 查」。
// 代价是状态存在模块级变量里：**插件被重载（改配置、升级、重启 DSH）就会丢**。
// 这条限制写在工具描述里，因为丢失的表现是「查不到那个 jobId」，不解释会让人以为传输失败了。
import crypto from 'node:crypto'

import { createProgress } from './progress.js'

/** 当前发送端（一台机器同时只跑一个，端口固定）。 */
let currentHost = null

const jobs = new Map()
const MAX_JOBS = 20

export function setHost(host) {
  currentHost = host
  return host
}
export function getHost() {
  return currentHost
}
export async function closeHost() {
  const h = currentHost
  currentHost = null
  if (h !== null) {
    try { await h.close() } catch { /* 已经关了 */ }
  }
  return h !== null
}

/**
 * 新建一个后台任务。
 * @param {object} [options]
 * @param {string} [options.kind]
 * @param {{files:number,bytes:number}} [options.totals]
 */
export function createJob(options = {}) {
  const id = crypto.randomBytes(6).toString('hex')
  const job = {
    id,
    kind: String(options.kind || 'pull'),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    progress: createProgress({ totalFiles: options.totals && options.totals.files, totalBytes: options.totals && options.totals.bytes }),
    logs: [],
    peer: null,
    result: null,
    error: '',
    pageServer: null,
    abort: new AbortController(),
  }
  jobs.set(id, job)
  // 只保留最近 MAX_JOBS 个，避免长会话里无限堆积（每个 job 还挂着进度页）。
  if (jobs.size > MAX_JOBS) {
    const oldest = Array.from(jobs.values())
      .filter((j) => j.state !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)[0]
    if (oldest) {
      try { oldest.pageServer && oldest.pageServer.close() } catch { /* 已关 */ }
      jobs.delete(oldest.id)
    }
  }
  return job
}

export function getJob(id) {
  return jobs.get(String(id || '')) || null
}

export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt)
}

export function jobLog(job, line) {
  const text = String(line === undefined || line === null ? '' : line)
  if (text === '') return
  job.logs.push(text)
  if (job.logs.length > 120) job.logs.shift()
}

export function finishJob(job, { ok, result, error }) {
  job.state = ok ? 'done' : 'failed'
  job.finishedAt = Date.now()
  job.result = result || null
  job.error = String(error || '')
  return job
}

/**
 * 把一个 job 渲染成进度页/工具输出共用的快照。
 * `result` 只在结束时有值，且刻意压缩成「人要看的那几行」——
 * 完整的 apply/verify 报告留在 report 里由工具输出展开。
 */
export function jobSnapshot(job) {
  const snap = job.progress.snapshot()
  const result = job.state === 'running' || job.result === null
    ? null
    : {
      ok: job.state === 'done',
      summary: job.state === 'done'
        ? ('迁移完成' + (job.result.received ? '：' + job.result.received.files + ' 个文件' : ''))
        : (job.error || '迁移失败'),
      rows: summariseResult(job.result),
      // 「插件正常 / 配置正常 / 可以使用」的判定：卡片与 lan_status 都读这一份。
      verdict: verdictOf(job.result),
      // 落地后的「下一步」来自 apply 报告（重启 dsh 等）：卡片要显示同一份，
      // 不能让「卡片上显示完成」而用户不知道还得重启。
      nextSteps: nextStepsOf(job.result),
      errors: job.error ? [job.error] : [],
    }
  return {
    role: 'client',
    local: true,
    phase: job.state === 'running' ? snap.phase : (job.state === 'done' ? 'done' : 'failed'),
    peer: job.peer,
    pending: null,
    canDecide: false,
    progress: snap,
    result,
    logs: job.logs.slice(-40),
  }
}

/**
 * 迁移结果的**汇总判定**：用户要的是「插件正常、配置正常、可以使用」这一句话，
 * 不是 14 项明细。每一项从 verify 检查（I 编号）与 apply 报告里推出来；
 * 只有 FAIL 才算不过 —— WARN 如实写进 note，但不挡「可以使用」。
 * 某项检查没跑（比如 autoVerify 关了）时按通过处理，note 留空：判定只对
 * 实际跑过的流程负责，不假装知道没测的东西。
 */
export function verdictOf(r) {
  if (!r || typeof r !== 'object') return null
  const checks = r.verify && Array.isArray(r.verify.checks) ? r.verify.checks : []
  const statusOf = (id) => {
    const c = checks.find((x) => x && x.id === id)
    return c ? String(c.status) : null
  }
  const apply = r.apply || null
  const deps = apply && apply.depsInstall ? apply.depsInstall : null
  const item = (label, ok, note) => ({ label, ok: ok === true, note: note || '' })

  const items = []
  const failIn = (...ids) => ids.map(statusOf).find((s) => s === 'FAIL')
  items.push(item('会话历史', failIn('I2', 'I3', 'I4', 'I5') === undefined))
  items.push(item('dsh 配置', Boolean(apply && apply.ok) && failIn('I13') === undefined))
  items.push(item('插件', failIn('I7', 'I9') === undefined))
  const wsFail = failIn('I8', 'I12')
  items.push(item('工作区', wsFail === undefined, wsFail === undefined ? '' : '部分项目代码没落地'))
  let depNote = ''
  if (deps) {
    if (Array.isArray(deps.results) && deps.results.length > 0) {
      depNote = deps.results.every((x) => x && x.ok) ? '已自动重装' : '自动重装未全部成功，按必办里的脚本补装'
    } else if (deps.script) {
      depNote = '需运行一键安装脚本后重启 dsh'
    }
  }
  items.push(item('依赖', true, depNote))
  return { ok: r.ok === true && items.every((x) => x.ok), items }
}

/**
 * pull 报告里 apply 是嵌套的（`result.apply`），两种形状都认，取不到就给空数组。
 * 导出给工具侧复用：`dshsync_lan_status` 与卡片读的是同一份，不许各自再写一套。
 */
export function nextStepsOf(r) {
  if (!r || typeof r !== 'object') return []
  const list = Array.isArray(r.nextSteps) ? r.nextSteps
    : (r.apply && Array.isArray(r.apply.nextSteps) ? r.apply.nextSteps : [])
  return list.map((s) => String(s))
}

function summariseResult(r) {
  if (!r || typeof r !== 'object') return []
  const rows = []
  if (r.received) {
    rows.push(['收到', r.received.files + ' 个文件'
      + (r.received.skipped > 0 ? '（续传跳过 ' + r.received.skipped + '）' : '')])
    rows.push(['耗时', Math.round((r.received.durationMs || 0) / 1000) + ' 秒'])
  }
  if (r.apply) {
    rows.push(['落地', r.apply.ok ? '成功' : (r.apply.errorCount + ' 个错误')])
    if (r.apply.backupDir) rows.push(['备份', r.apply.backupDir])
    // 必办（依赖 / 凭据）单列：落地成功 ≠ 可以用 —— 卡片必须把「还差什么」说在结果里
    for (const a of r.apply.actionRequired || []) rows.push(['必办', String(a)])
  }
  if (r.verify) {
    rows.push(['核验', r.verify.ok ? '全部通过' : (r.verify.failed + ' 项失败')])
  }
  return rows
}

/** 测试用：清空全部状态。 */
export function resetJobs() {
  for (const j of jobs.values()) {
    try { j.pageServer && j.pageServer.close() } catch { /* 已关 */ }
  }
  jobs.clear()
  currentHost = null
}
