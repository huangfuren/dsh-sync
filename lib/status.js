// lib/status.js — 设置卡片读的只读快照,以及把它送到浏览器的唯一一条路由。
//
// 为什么单独一个模块:工具输出是给模型读的多行文本,卡片要的是结构化数字。
// 三者共用同一批底层读取函数(probeRuntime / machineIdentity / jobs 的运行时表),
// 但形态不同,混在一起会把工具的输出格式和卡片的渲染契约焊死。
//
// 两条硬约束:
//   ① **绝不抛**。设置页每次展开卡片都会拉一遍,一个坏掉的工作区文件不该让整张卡片空白。
//      所有读取失败都退化成哨兵值(UNKNOWN = -1 / null),由界面显示「—」。
//   ② **不启子进程**。probeRuntime 显式关掉 CLI 探测(allowCli:false) ——
//      为了显示一个版本号去起一次 `dsh --version` 是不划算的,拿不到就显示未知。
import fs from 'node:fs'
import path from 'node:path'

import { machineIdentity, probeRuntime } from './host-env.js'
import { discoverDevices } from './lan/discovery.js'
import { clearSelection, deviceSnapshot, selectDevice, setDevices } from './lan/devices.js'
import { getHost, listJobs } from './lan/jobs.js'

/**
 * 卡片拉状态的端点。
 * ⚠️ 客户端半(client.js)有一份**同值字面量**:浏览器半不能 import 宿主半的任何值
 * (构建纯净门),所以两处各写一份,靠这条注释互指。改这里就必须改那里。
 */
export const OVERVIEW_ROUTE = '/api/dsh-sync/overview'

/**
 * 设备端点：扫描 / 取快照 / 选中 / 取消选中。
 * ⚠️ 与 OVERVIEW_ROUTE 同样，客户端半有一份**同值字面量**（见 client.js 的 DEVICES_ROUTE）。
 */
export const DEVICES_ROUTE = '/api/dsh-sync/devices'

/** 计数失败时的哨兵。0 是合法值(新机器确实没有会话),不能用 0 表示失败。 */
export const UNKNOWN = -1

/** manifest.json 的读取上限。正常 bundle 的清单只有几十 KB,超过就是别的东西。 */
const MANIFEST_LIMIT = 8 * 1024 * 1024

/**
 * 汇总卡片要显示的全部状态。
 * @param {{ dshHome?: string, outDir?: string }} [options]
 */
export async function collectOverview({ dshHome, outDir } = {}) {
  const home = typeof dshHome === 'string' ? dshHome : ''
  const dir = typeof outDir === 'string' ? outDir : ''
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    machine: readIdentity(home),
    runtime: await readRuntime(home),
    counts: await readCounts(home),
    bundle: await readBundleInfo(dir),
    lan: readLan(),
  }
}

// ── 本机身份与运行时 ────────────────────────────────────────────────────────

function readIdentity(home) {
  try {
    const id = machineIdentity(home)
    return {
      hostname: String(id.hostname || ''),
      user: String(id.user || ''),
      dshHome: String(id.dshHome || ''),
    }
  } catch {
    return { hostname: '', user: '', dshHome: home }
  }
}

async function readRuntime(home) {
  if (home === '') return null
  try {
    const rt = await probeRuntime(home, { allowCli: false })
    return {
      version: rt.dshVersion === null || rt.dshVersion === undefined ? '' : String(rt.dshVersion),
      source: String(rt.source || ''),
      node: rt.runtimeNode === null || rt.runtimeNode === undefined ? '' : String(rt.runtimeNode),
      pnpm: rt.pnpm === null || rt.pnpm === undefined ? '' : String(rt.pnpm),
      platform: String(rt.platform || ''),
      arch: String(rt.arch || ''),
    }
  } catch {
    return null
  }
}

// ── 状态层计数 ──────────────────────────────────────────────────────────────
// 全部只数目录层级,不递归统计文件 —— 卡片要的是「多少」,不是「多大」,
// 而 <dshHome> 在真实机器上有 600MB+,递归一遍会让展开卡片卡住几秒。

async function readCounts(home) {
  const empty = { profiles: UNKNOWN, sessionGroups: UNKNOWN, sessions: UNKNOWN, workspaces: UNKNOWN, skills: UNKNOWN }
  if (home === '') return empty
  const [profiles, sessions, workspaces, skills] = await Promise.all([
    countDirectories(path.join(home, 'profiles')),
    countSessions(path.join(home, 'sessions')),
    countWorkspaces(path.join(home, 'storages', 'workspace.json')),
    countEntries(path.join(home, 'skills')),
  ])
  return {
    profiles,
    sessionGroups: sessions.groups,
    sessions: sessions.sessions,
    workspaces,
    skills,
  }
}

async function listDir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
}

async function countDirectories(dir) {
  const entries = await listDir(dir)
  if (entries === null) return UNKNOWN
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).length
}

async function countEntries(dir) {
  const entries = await listDir(dir)
  if (entries === null) return UNKNOWN
  return entries.length
}

/**
 * `sessions/<encode(cwd)>/<session-id>/` 两层。
 * 外层目录数 = 出现过的工作区目录数,内层 = 会话数。
 */
async function countSessions(dir) {
  const groups = await listDir(dir)
  if (groups === null) return { groups: UNKNOWN, sessions: UNKNOWN }
  const outer = groups.filter((e) => e.isDirectory() || e.isSymbolicLink())
  let sessions = 0
  for (const group of outer) {
    const inner = await listDir(path.join(dir, group.name))
    if (inner === null) continue
    sessions += inner.filter((e) => e.isDirectory() || e.isSymbolicLink()).length
  }
  return { groups: outer.length, sessions }
}

/**
 * 工作区记录在 storages/workspace.json 的 `tables.workspaces`(**对象** map,不是数组)。
 * 结构由宿主定义,读不出来就如实报未知,不要按「没有工作区」显示 0。
 */
async function countWorkspaces(file) {
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    const table = raw && raw.tables && raw.tables.workspaces
    if (table === null || table === undefined || typeof table !== 'object') return UNKNOWN
    return Array.isArray(table) ? table.length : Object.keys(table).length
  } catch {
    return UNKNOWN
  }
}

// ── 默认输出目录里的 bundle ─────────────────────────────────────────────────

/**
 * 读 `<outDir>/manifest.json`。
 * outDir 本身就是 bundle 目录(exportBundle 里 `bundleDir = path.resolve(outDir)`),
 * 不是「每次导出建一个子目录」—— 所以这里没有「找最新一个」的逻辑。
 */
async function readBundleInfo(dir) {
  if (dir === '') return null
  try {
    const file = path.join(dir, 'manifest.json')
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) return { dir, valid: false }
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    const integrity = raw && raw.integrity ? raw.integrity : {}
    const source = raw && raw.source ? raw.source : {}
    const identity = source && source.identity ? source.identity : {}
    return {
      dir,
      valid: true,
      format: text(raw.format),
      exportedAt: text(raw.exportedAt),
      files: safeCount(integrity.files),
      profiles: Array.isArray(raw.profiles)
        ? raw.profiles.map((p) => text(p && p.name)).filter((name) => name !== '')
        : [],
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.length : 0,
      dshVersion: text(source.dshVersion),
      sourceHost: text(identity.hostname),
      sourceDshHome: text(raw.sourceDshHome),
      encrypted: Boolean(raw.settingsEncrypted || raw.credentialsEncrypted),
      includesCredentials: Boolean(raw.includesCredentials),
    }
  } catch {
    // 目录不存在是最常见的情况(还没导出过),与「manifest 损坏」在界面上同义:
    // 都表示「这个目录里没有可用的 bundle」。
    return { dir, valid: false }
  }
}

// ── 局域网 ──────────────────────────────────────────────────────────────────
// 状态只在内存里(jobs.js 的模块级变量):插件重载 / DSH 重启后这里会回到空态。
// 卡片照实显示「未运行」,不要试图从磁盘恢复 —— 那是另一件事,而且会误导。

function readLan() {
  const host = readHost()
  const jobs = readJobs()
  return {
    host,
    jobs: jobs.slice(0, 5),
    total: jobs.length,
    running: jobs.filter((j) => j.state === 'running').length,
    devices: readDevices(),
  }
}

/** 登记表坏了也不该让整张卡片空白：返回同形态的空值。 */
function readDevices() {
  try {
    return deviceSnapshot()
  } catch {
    return { devices: [], scannedAt: 0, selection: { id: '', stale: false, auto: false, device: null } }
  }
}

function readHost() {
  try {
    const instance = getHost()
    if (instance === null || instance === undefined) return null
    const state = instance.state(true)
    return {
      port: safeCount(instance.port),
      pageUrl: text(instance.pageUrl),
      phase: text(state.phase),
      pair: state.pair
        ? {
          code: text(state.pair.code),
          remainingMs: safeCount(state.pair.remainingMs),
          used: Boolean(state.pair.used),
          locked: Boolean(state.pair.locked),
        }
        : null,
      peer: state.peer
        ? { alias: text(state.peer.alias), address: text(state.peer.address) }
        : null,
      progress: compactProgress(state.progress),
      bundle: state.bundle
        ? { files: safeCount(state.bundle.files), bytes: safeCount(state.bundle.bytes) }
        : null,
    }
  } catch {
    return null
  }
}

function readJobs() {
  let list = []
  try {
    list = listJobs()
  } catch {
    return []
  }
  return list.map((job) => {
    let progress = null
    try {
      progress = compactProgress(job.progress.snapshot())
    } catch {
      progress = null
    }
    return {
      id: text(job.id),
      kind: text(job.kind),
      state: text(job.state),
      startedAt: safeCount(job.startedAt),
      finishedAt: safeCount(job.finishedAt),
      peer: job.peer ? { alias: text(job.peer.alias), address: text(job.peer.address) } : null,
      error: text(job.error),
      progress,
    }
  })
}

/** 进度快照只留下卡片会显示的那几个数,顺带砍掉 errors 数组(可能上百条)。 */
function compactProgress(progress) {
  if (progress === null || typeof progress !== 'object') return null
  const files = progress.files && typeof progress.files === 'object' ? progress.files : {}
  const bytes = progress.bytes && typeof progress.bytes === 'object' ? progress.bytes : {}
  return {
    phase: text(progress.phase),
    percent: safeCount(progress.percent),
    files: { done: safeCount(files.done), total: safeCount(files.total), skipped: safeCount(files.skipped) },
    bytes: { done: safeCount(bytes.done), total: safeCount(bytes.total) },
    bps: safeCount(progress.bps),
    etaMs: safeCount(progress.etaMs),
    errorCount: safeCount(progress.errorCount),
  }
}

// ── 路由注册 ────────────────────────────────────────────────────────────────

/**
 * 把 `/api/dsh-sync/overview` 挂到宿主的已认证围栏上。
 *
 * 三条铁律(每条都对应一次线上事故,详见 dsh-plugin-fetch-route):
 *   · bind-at-extraction —— 取到 register 立刻 bind,否则 this 丢失、路由静默失效;
 *   · c.effect 管 disposer —— 服务卸载后不留悬空路由;
 *   · refuse-quietly —— 注册被拒不得把整个插件拖下水:卡片退化成「只显示配置」即可。
 *
 * @param {{ effect: Function }} c 迟注入作用域(必须能提供 effect)
 * @param {object|undefined} connection 宿主的 connection 服务
 * @param {() => object} getConfig 取当前生效配置
 * @returns {boolean} 路由是否真的挂上了
 */
export function registerOverviewRoute(c, connection, getConfig) {
  const register = connection
    && connection.fetch
    && typeof connection.fetch.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
  if (register === undefined) return false
  if (c === null || c === undefined || typeof c.effect !== 'function') return false
  try {
    c.effect(() => register({
      path: OVERVIEW_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        let body
        try {
          const cfg = typeof getConfig === 'function' ? getConfig() : {}
          body = await collectOverview({ dshHome: cfg.dshHome, outDir: cfg.outDir })
        } catch (err) {
          // 走到这里说明 collectOverview 自己崩了(它内部已逐段兜底)。
          // 仍然返回 200 + ok:false:客户端只需处理一种失败形态。
          body = {
            ok: false,
            error: { code: 'dsh-sync/overview-failed', message: err && err.message ? err.message : String(err) },
          }
        }
        return reply(body)
      },
    }), 'dsh-sync: settings card overview route')
  } catch {
    return false
  }
  return true
}

// ── 设备：扫描与选中 ────────────────────────────────────────────────────────

/**
 * 跑一次局域网发现并登记结果。
 * 发现本身是网络 I/O（广播 1.2s + 兜底扫描可达 3s），所以只在用户点「扫描」时走，
 * 展开卡片时走的是 `snapshot`（读内存登记表，零 I/O）。
 */
export async function scanLanDevices(options = {}) {
  const found = await discoverDevices({
    servicePort: Number(options.servicePort) || 38473,
    scan: options.scan !== false,
    udpTimeoutMs: Number(options.udpTimeoutMs) || 1200,
  })
  setDevices(found.devices)
  return {
    via: String(found.via || ''),
    scanned: Number(found.scanned) || 0,
    notes: Array.isArray(found.notes) ? found.notes.slice(0, 6) : [],
  }
}

/**
 * 把 `/api/dsh-sync/devices` 挂到同一道围栏上。
 *
 * 四个动作：
 *   · `snapshot`（默认）—— 读内存登记表，零网络 I/O；
 *   · `quick` —— **只发广播**、等 1.2 秒，不打 254 个地址。卡片首次展开走这个：
 *     开销小到可以在「看一眼设置页」时顺手做掉，而全量扫描不行；
 *   · `scan` —— 广播 + 逐 IP 兜底，用户点「扫描」才走；
 *   · `select` / `clear` —— 改选中项。
 *
 * **写错 action 一律落到 snapshot，绝不发起网络 I/O**：一个拼写错误不该让机器
 * 悄悄扫一轮局域网。三条铁律同 overview：bind-at-extraction、`c.effect` 管
 * disposer、refuse-quietly。
 */
export function registerDevicesRoute(c, connection) {
  const register = connection
    && connection.fetch
    && typeof connection.fetch.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
  if (register === undefined) return false
  if (c === null || c === undefined || typeof c.effect !== 'function') return false
  try {
    c.effect(() => register({
      path: DEVICES_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request)
        const action = String(body.action || 'snapshot')
        try {
          if (action === 'clear') {
            clearSelection()
            return reply({ ok: true, action, ...deviceSnapshot() })
          }
          if (action === 'select') {
            const device = selectDevice(body.id)
            return reply({ ok: true, action, selected: device, ...deviceSnapshot() })
          }
          if (action === 'scan') {
            const scanned = await scanLanDevices({ scan: true })
            return reply({ ok: true, action, ...scanned, ...deviceSnapshot() })
          }
          if (action === 'quick') {
            const scanned = await scanLanDevices({ scan: false })
            return reply({ ok: true, action, ...scanned, ...deviceSnapshot() })
          }
          // 缺省与未知动作都是 snapshot：不认识的动作不许悄悄发起一轮网络扫描。
          return reply({ ok: true, action: 'snapshot', ...deviceSnapshot() })
        } catch (err) {
          // 选中失败（没匹配 / 多匹配 / 列表为空）是**预期内的用户输入错误**，
          // 仍然 200 + ok:false：客户端只需处理一种失败形态，消息直接显示给用户。
          return reply({
            ok: false,
            action,
            error: {
              code: 'dsh-sync/devices-failed',
              message: err && err.message ? err.message : String(err),
            },
          })
        }
      },
    }), 'dsh-sync: settings card devices route')
  } catch {
    return false
  }
  return true
}

/** body 解析失败当作 `{}`，绝不让一个坏请求把路由拖成 500。 */
async function readJsonBody(request) {
  try {
    if (request === null || request === undefined || typeof request.json !== 'function') return {}
    const parsed = await request.json()
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 统一响应形态：`no-store` 不是可选的 —— 设备列表随时会因对方关机而变。 */
function reply(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
}

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function safeCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
