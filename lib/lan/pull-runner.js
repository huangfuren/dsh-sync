// lib/lan/pull-runner.js — 「开始一次拉取」的**唯一实现**。
//
// 为什么单独一个模块：它现在有两个调用方 —— `dshsync_lan_pull` 工具，和设置卡片上的
// 「开始迁移」按钮。两处各写一份，差别一定会出现在错误处理上（进度页起不来怎么办、
// 中断后怎么续传、失败怎么记账），而这类差别只在真机上才暴露出来。
//
// 契约：调用方给「从哪台机器拉」和「落到哪里」，这里返回一个 **立刻可用** 的 job 句柄 ——
// 传输在后台跑，绝不阻塞调用方（工具要立刻返回 jobId，路由要立刻回 200）。
import { pullBundle } from './client.js'
import { LAN_PROGRESS_PORT } from './constants.js'
import { getSelection, selectDevice } from './devices.js'
import { resolveTarget } from './discovery.js'
import { createJob, finishJob, jobLog, jobSnapshot } from './jobs.js'
import { startProgressServer } from './progress-server.js'

/**
 * 决定「从哪台机器拉」，优先级：host > deviceId > 卡片里选中的那台。
 *
 * 三条刻意的设计：
 *   · **没有选中项时报错而不是猜**：给错机器 = 把 bundle 传给不该收到的一方，不可挽回。
 *   · `deviceId` 解析成功会**顺手把它记为选中**，卡片那边立刻高亮同一台 —— 两条选中路径共用一份状态。
 *   · 选中项已不在最新列表（对方关了发送端）时明确报 stale，不说「没选设备」。
 */
export async function resolvePullTarget(args) {
  const hostArg = String(args.host || '').trim()
  if (hostArg !== '') return resolveTarget(hostArg, { defaultPort: 38473 })

  const deviceArg = String(args.deviceId || '').trim()
  if (deviceArg !== '') {
    const device = selectDevice(deviceArg)
    return { address: device.address, port: device.port, device, notes: [] }
  }

  const picked = getSelection()
  if (picked.stale) {
    throw new Error('之前选中的设备（' + picked.id + '）已不在最新列表里：'
      + '重跑 dshsync_lan_discover，或在设置 → 内置插件 → dsh-sync 迁移 卡片里重新扫描')
  }
  if (picked.device === null) {
    throw new Error('没有指定目标机器：给 host，或先跑 dshsync_lan_discover 后用 deviceId，'
      + '或在设置 → 内置插件 → dsh-sync 迁移 卡片里点「扫描」并选中一台')
  }
  return { address: picked.device.address, port: picked.device.port, device: picked.device, notes: [] }
}

/**
 * 起一次拉取并立刻返回。
 *
 * @param {object} options
 * @param {{address:string, port:number, device?:object}} options.target
 * @param {string} options.code 6 位配对码
 * @param {string} options.destDir 本机接收目录
 * @returns {Promise<{job:object, pageUrl:string, runner:Promise<object|null>}>}
 */
export async function startPull(options = {}) {
  const target = options.target
  const job = createJob({ kind: 'pull' })
  job.peer = {
    alias: target.device ? target.device.alias : target.address,
    address: target.address,
    hostname: target.device ? target.device.hostname : '',
  }

  // 进度页失败不该拦住传输：它只是「看得见」的增强。
  let pageUrl = ''
  try {
    const page = await startProgressServer({
      port: Number(options.progressPort) || LAN_PROGRESS_PORT,
      getState: () => jobSnapshot(job),
    })
    job.pageServer = page
    pageUrl = page.url
  } catch (err) {
    jobLog(job, '⚠️ 进度页启动失败（传输照常进行）：' + (err && err.message ? err.message : String(err)))
  }

  const runner = pullBundle({
    host: target.address,
    port: target.port,
    code: String(options.code || ''),
    destDir: String(options.destDir || ''),
    dshHome: String(options.dshHome || ''),
    workspaceRoot: String(options.workspaceRoot || ''),
    workspaceMap: options.workspaceMap && typeof options.workspaceMap === 'object' ? options.workspaceMap : {},
    autoApply: options.autoApply !== false,
    autoVerify: options.autoVerify !== false,
    // 口令只在这条链路上内存传递：不进 job、不进日志、不落盘
    passphrase: String(options.passphrase || ''),
    installDeps: options.installDeps !== false,
    overwrite: options.overwrite === true,
    allowSameMachine: options.allowSameMachine === true,
    merge: options.merge === true,
    resolutions: options.resolutions && typeof options.resolutions === 'object' ? options.resolutions : null,
    progress: job.progress,
    onLog: (line) => jobLog(job, line),
    signal: job.abort.signal,
  }).then((report) => {
    finishJob(job, { ok: report.ok, result: report, error: report.ok ? '' : report.errors.join('；') })
    return report
  }).catch((err) => {
    finishJob(job, { ok: false, error: err && err.message ? err.message : String(err) })
    return null
  })
  runner.catch(() => {})   // 已经在 then/catch 里处理过，这里只防未捕获告警

  return { job, pageUrl, runner }
}
