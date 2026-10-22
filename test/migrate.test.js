// test/migrate.test.js — 卡片上「开始迁移」这条通道。
//
// 刻意**不测** start 的成功路径：那会真的去连一台机器（建 socket、起进度页服务），
// 测试里既连不上又会把挂起的句柄留给 node --test。这里只钉住两件会静默错事的地方：
//   ① 参数校验必须在**发起任何连接之前**拦住（缺配对码 / 没选设备）；
//   ② 任务视图的形状（状态 / 结果行）要能被卡片直接画出来。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { resetDevices, setDevices } from '../lib/lan/devices.js'
import { createJob, finishJob, resetJobs } from '../lib/lan/jobs.js'
import { MIGRATE_ROUTE, defaultIncomingDir, registerMigrateRoute } from '../lib/migrate.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLIENT = path.join(ROOT, 'client.js')

async function call(route, body) {
  return route.fetch(new Request('http://127.0.0.1' + MIGRATE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function mount() {
  const seen = []
  const connection = { fetch: { register(route) { seen.push(route); return () => {} } } }
  const ok = registerMigrateRoute({ effect: (fn) => { fn() } }, connection, () => ({ dshHome: '' }))
  assert.equal(ok, true)
  return seen[0]
}

test('defaultIncomingDir：与导出侧 outDir 分开，名字一眼能认出是「收到的」', () => {
  const dir = defaultIncomingDir()
  assert.ok(dir.includes('dsh-sync-incoming'))
  assert.ok(!dir.includes('bundle'), '不能和导出目录混用同一个默认名')
})

test('registerMigrateRoute：没有 connection 时返回 false 不抛', () => {
  assert.equal(registerMigrateRoute({ effect: (fn) => fn() }, undefined, () => ({})), false)
  assert.equal(registerMigrateRoute({ effect: (fn) => fn() }, {}, () => ({})), false)
})

test('registerMigrateRoute：注册被拒时 refuse-quietly', () => {
  const refusing = { fetch: { register: () => { throw new Error('denied') } } }
  assert.equal(registerMigrateRoute({ effect: (fn) => fn() }, refusing, () => ({})), false)
})

test('路由：缺省动作是 status（零副作用），并给出默认目录', async () => {
  resetJobs()
  resetDevices()
  const route = mount()
  const response = await route.fetch(new Request('http://127.0.0.1' + MIGRATE_ROUTE, { method: 'POST' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.action, 'status')
  assert.equal(body.job, null)
  assert.equal(body.defaults.destDir, defaultIncomingDir(), '卡片要用它预填表单')
})

test('路由：缺配对码在发起连接之前就被拦下', async () => {
  resetDevices()
  setDevices([{ address: '192.168.1.5', alias: 'OLD-PC' }])
  const route = mount()
  const body = await (await call(route, { action: 'start', code: '' })).json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'dsh-sync/migrate-failed')
  assert.match(body.error.message, /配对码/)
})

test('路由：没选设备时报错，绝不替用户挑一台', async () => {
  resetJobs()
  resetDevices()
  const route = mount()
  const body = await (await call(route, { action: 'start', code: '123456' })).json()
  assert.equal(body.ok, false)
  assert.match(body.error.message, /没有指定目标机器/)
})

test('路由：任务视图带状态与结果行，卡片能直接画', async () => {
  resetJobs()
  const route = mount()
  const job = createJob({ kind: 'pull' })
  finishJob(job, {
    ok: true,
    result: { received: { files: 3, bytes: 1024, skipped: 0, durationMs: 2000 }, apply: { ok: true }, verify: { ok: true } },
    error: '',
  })
  const body = await (await call(route, { action: 'status', jobId: job.id })).json()
  assert.equal(body.ok, true)
  assert.equal(body.job.id, job.id)
  assert.equal(body.job.state, 'done')
  assert.equal(body.job.result.ok, true)
  assert.ok(Array.isArray(body.job.result.rows))
  assert.ok(body.job.result.rows.some((row) => row[0] === '收到'), '结果行要含「收到」')
})

test('任务视图：落地后的「下一步」随结果一起送到卡片（含重启提示）', async () => {
  resetJobs()
  const route = mount()

  const nested = createJob({ kind: 'pull' })
  finishJob(nested, {
    ok: true,
    // pull 报告里 apply 是嵌套的：这是真实形状
    result: { received: { files: 1, bytes: 1, durationMs: 10 }, apply: { ok: true, nextSteps: ['重启 dsh', '删掉 bundle 副本'] } },
    error: '',
  })
  const one = await (await call(route, { action: 'status', jobId: nested.id })).json()
  assert.deepEqual(one.job.result.nextSteps, ['重启 dsh', '删掉 bundle 副本'])

  // 平铺形状也认（引擎直接写在 report 上时）
  const flat = createJob({ kind: 'pull' })
  finishJob(flat, { ok: true, result: { nextSteps: ['重启 dsh'] }, error: '' })
  const two = await (await call(route, { action: 'status', jobId: flat.id })).json()
  assert.deepEqual(two.job.result.nextSteps, ['重启 dsh'])

  // 没有就不给空壳数组以外的东西
  const bare = createJob({ kind: 'pull' })
  finishJob(bare, { ok: true, result: { received: { files: 1 } }, error: '' })
  const three = await (await call(route, { action: 'status', jobId: bare.id })).json()
  assert.deepEqual(three.job.result.nextSteps, [])
})

// ── 客户端半 ────────────────────────────────────────────────────────────────

const FAKE_REACT = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  Fragment: Symbol('fragment'),
}

async function loadClient() {
  let captured = null
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  try {
    await import(pathToFileURL(CLIENT).href + '?t=' + Math.random().toString(36).slice(2))
  } finally {
    globalThis.window = previous
  }
  return captured.factory((name) => {
    if (name === 'react') return FAKE_REACT
    throw new Error('client.js 只允许 require("react")，实际: ' + name)
  })
}

test('路由常量两处一致：客户端 MIGRATE_ROUTE == 宿主 MIGRATE_ROUTE', async () => {
  const mod = await loadClient()
  assert.equal(mod.internals.MIGRATE_ROUTE, MIGRATE_ROUTE)
  assert.ok(fs.readFileSync(CLIENT, 'utf8').includes('"/api/dsh-sync/migrate"'))
})

test('迁移区块：无任务 / 运行中 / 已完成 三态都不抛', async () => {
  const mod = await loadClient()
  const block = mod.internals.MigrateBlock
  const t = (key) => key
  const base = { t, onEdit: () => {}, onStart: () => {} }
  const form = { code: '123456', destDir: 'D:/incoming', workspaceRoot: 'E:/code' }

  assert.doesNotThrow(() => block({
    ...base, form, selected: null,
    mig: { job: null, defaults: null, error: '', busy: false, progressUrl: '' },
  }))

  assert.doesNotThrow(() => block({
    ...base, form, selected: { id: 'a:1', alias: 'OLD-PC' },
    mig: {
      job: { id: 'j1', state: 'running', progress: { percent: 42, files: { done: 4, total: 10, skipped: 1 }, bytes: {}, bps: 1024, etaMs: 5000 } },
      defaults: null, error: '', busy: false, progressUrl: 'http://127.0.0.1:38474/',
    },
  }))

  assert.doesNotThrow(() => block({
    ...base, form, selected: { id: 'a:1', alias: 'OLD-PC' },
    mig: {
      job: { id: 'j1', state: 'done', result: { ok: true, summary: 'ok', rows: [['收到', '3 个文件']] }, logs: ['a', 'b'] },
      defaults: null, error: '', busy: false, progressUrl: '',
    },
  }))
})

test('迁移区块：完成态带「下一步」也能画；没有就不显示这一段', async () => {
  const mod = await loadClient()
  const block = mod.internals.MigrateBlock
  const t = (key) => key
  const base = { t, onEdit: () => {}, onStart: () => {} }
  const form = { code: '123456', destDir: 'D:/incoming', workspaceRoot: '' }

  assert.doesNotThrow(() => block({
    ...base, form, selected: { id: 'a:1', alias: 'OLD-PC' },
    mig: {
      job: {
        id: 'j1', state: 'done',
        result: { ok: true, rows: [['收到', '3 个文件']], nextSteps: ['重启 dsh', '删掉 bundle 副本'] },
        logs: ['a'],
      },
      defaults: null, error: '', busy: false, progressUrl: '',
    },
  }))

  // nextSteps 缺失 / 不是数组 → 退化成不显示，不抛
  assert.doesNotThrow(() => block({
    ...base, form, selected: { id: 'a:1', alias: 'OLD-PC' },
    mig: {
      job: { id: 'j2', state: 'failed', result: { ok: false, rows: [], errors: ['x'] } },
      defaults: null, error: '', busy: false, progressUrl: '',
    },
  }))
})

test('progressText：缺哪段就少哪段，不补占位符', async () => {
  const mod = await loadClient()
  const text = mod.internals.progressText((k) => k, {
    progress: { percent: 50, files: { done: 5, total: 10, skipped: 0 }, bytes: {}, bps: 2048, etaMs: 30000 },
  })
  // t 是恒等函数，所以断言的是**用哪几个字典键**，而不是最终文案
  assert.ok(text.includes('migratePercent'))
  assert.ok(text.includes('migrateFiles'))
  assert.ok(text.includes('migrateEta'))

  const bare = mod.internals.progressText((k) => k, { progress: { percent: 0, files: {}, bytes: {} } })
  assert.ok(bare.includes('migratePercent'))
  assert.ok(!bare.includes('migrateFiles'), '没有 total 就不显示文件数')
  assert.ok(!bare.includes('migrateEta'), '没有 ETA 就不显示剩余')
  assert.ok(!bare.includes('undefined'), '缺失字段不许渲染成 undefined')
  assert.ok(!bare.includes('NaN'))
})
