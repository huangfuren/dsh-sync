// lib/migrate.js — 卡片上「开始迁移」那条通道。
//
// 与对话里 `dshsync_lan_pull` 的关系：**同一个 runner，不同的呈现**。
// 工具给模型看多行文本；这里给浏览器看结构化状态（进度 / 速率 / 结果行），
// 所以执行逻辑必须共用 —— 否则「卡片上点开始」和「对话里说迁移」迟早行为不一致。
//
// 三条与 lib/status.js 相同的铁律：bind-at-extraction、`c.effect` 管 disposer、refuse-quietly。
import os from 'node:os'
import path from 'node:path'

import { getJob, jobSnapshot, listJobs } from './lan/jobs.js'
import { resolvePullTarget, startPull } from './lan/pull-runner.js'

/** ⚠️ 客户端半有一份同值字面量（client.js 的 MIGRATE_ROUTE），改这里必须改那里。 */
export const MIGRATE_ROUTE = '/api/dsh-sync/migrate'

/**
 * 接收目录的默认值。与导出侧的 `outDir` **刻意分开**：
 * 两台机器都可能配了同一个 outDir，把「收到的」倒进「要导出的」目录会互相污染。
 */
export function defaultIncomingDir() {
  return path.join(os.tmpdir(), 'dsh-sync-incoming')
}

/** 把 job 渲染成卡片能直接画的样子：状态 + 进度 + 结果行。 */
function jobView(job) {
  if (job === null || job === undefined) return null
  const snap = jobSnapshot(job)
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    peer: snap.peer,
    phase: snap.phase,
    progress: snap.progress,
    result: snap.result,
    logs: snap.logs,
  }
}

/**
 * 注册迁移通道。
 *
 * 动作：
 *   · `status`（默认）—— 返回最近一个任务 + 默认目录。零副作用，卡片展开时就调。
 *   · `start` —— 起一次拉取并**立刻**返回 jobId。传输在后台跑，卡片轮询 `status` 看进度。
 *
 * 为什么 `start` 不等待传输完成：一次迁移可能十几分钟，挂着一个 HTTP 请求等它，
 * 宿主的请求超时与卡片的加载态都会先崩。
 */
export function registerMigrateRoute(c, connection, getConfig) {
  const register = connection
    && connection.fetch
    && typeof connection.fetch.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
  if (register === undefined) return false
  if (c === null || c === undefined || typeof c.effect !== 'function') return false
  try {
    c.effect(() => register({
      path: MIGRATE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request)
        const action = String(body.action || 'status')
        try {
          if (action !== 'start') {
            const job = body.jobId ? getJob(body.jobId) : (listJobs()[0] || null)
            return reply({
              ok: true,
              action: 'status',
              defaults: { destDir: defaultIncomingDir() },
              job: jobView(job),
            })
          }

          const cfg = typeof getConfig === 'function' ? getConfig() : {}
          const code = String(body.code || '').replace(/[\s\-_]/g, '')
          if (code === '') throw new Error('缺少配对码：源机页面上那 6 位数字')
          const destDir = String(body.destDir || '').trim() || defaultIncomingDir()

          const target = await resolvePullTarget({ host: body.host, deviceId: body.deviceId })
          const { job, pageUrl } = await startPull({
            target,
            code,
            destDir,
            dshHome: String(body.dshHome || cfg.dshHome || ''),
            workspaceRoot: String(body.workspaceRoot || ''),
            autoApply: body.autoApply !== false,
            autoVerify: body.autoVerify !== false,
            overwrite: body.overwrite === true,
            allowSameMachine: body.allowSameMachine === true,
            merge: body.merge === true,
            resolutions: body.resolutions && typeof body.resolutions === 'object' ? body.resolutions : null,
          })

          return reply({
            ok: true,
            action: 'start',
            jobId: job.id,
            state: job.state,
            destDir,
            progressUrl: pageUrl,
            target: { alias: job.peer ? job.peer.alias : target.address, address: target.address, port: target.port },
            defaults: { destDir: defaultIncomingDir() },
          })
        } catch (err) {
          return reply({
            ok: false,
            action,
            error: {
              code: 'dsh-sync/migrate-failed',
              message: err && err.message ? err.message : String(err),
            },
          })
        }
      },
    }), 'dsh-sync: settings card migrate route')
  } catch {
    return false
  }
  return true
}

/** body 解析失败当作 `{}`：一个坏请求不该把路由拖成 500。 */
async function readJsonBody(request) {
  try {
    if (request === null || request === undefined || typeof request.json !== 'function') return {}
    const parsed = await request.json()
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function reply(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
}
