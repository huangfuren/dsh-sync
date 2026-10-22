// test/card.test.js — 设置卡片与状态通道。
//
// 这一类测的重点不是「界面长得对不对」（那只有真机能验），而是三件会静默失效的事：
//   ① 客户端半到底有没有把 settings.plugins.tab 注册出去（槽名写错 = 页签永不出现，不报错）；
//   ② 客户端与宿主写的路由常量是否一致（两处各写一份，靠人记就会漂）；
//   ③ 状态汇总在任何坏输入下是否都退化成哨兵值，而不是把卡片整张打空。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { collectOverview, OVERVIEW_ROUTE, registerOverviewRoute, UNKNOWN } from '../lib/status.js'
import { resetJobs } from '../lib/lan/jobs.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLIENT = path.join(ROOT, 'client.js')

/** 最小 React 替身：只要能让 factory 里的 require("react") 拿到函数就够。 */
const FAKE_REACT = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  Fragment: Symbol('fragment'),
}

/**
 * 载入 client.js（IIFE 形式，靠 window.__ModuleLoader__.load 把自己交出来）。
 * 用 query 打破 ESM 缓存，保证每个用例拿到干净的一份。
 */
async function loadClient() {
  let captured = null
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod } } }
  try {
    await import(pathToFileURL(CLIENT).href + '?t=' + Math.random().toString(36).slice(2))
  } finally {
    globalThis.window = previous
  }
  assert.ok(captured !== null, 'client.js 没有通过 window.__ModuleLoader__.load 注册自己')
  assert.equal(captured.id, 'dsh-sync', 'ModuleLoader id 必须等于包名，否则宿主静默不加载')
  return captured.factory((name) => {
    if (name === 'react') return FAKE_REACT
    throw new Error('client.js 只允许 require("react")，实际: ' + name)
  })
}

/** 假 configForms 表单：记录写入，快照形如 0.2.x 的 { value, user }。 */
function fakeForm() {
  const value = { outDir: '', profile: '*', includeState: true, includePlugins: true }
  const user = {}
  const writes = []
  return {
    writes,
    form: {
      getSnapshot: () => ({ value: { ...value }, user: { ...user }, writable: true, status: 'ready' }),
      set: async (key, next) => { writes.push([key, next]); value[key] = next; user[key] = next },
      subscribe: () => () => {},
    },
  }
}

/** 假客户端 ctx：slots.inject 同步执行，locale.bind 返回恒等翻译。 */
function fakeCtx(form) {
  const registered = []
  const styles = []
  return {
    registered,
    styles,
    ctx: {
      slots: {
        inject: (_slot, callback) => { callback() },
        register: (options, component) => { registered.push({ options, component }); return () => {} },
      },
      locale: {
        register: () => () => {},
        bind: () => (key) => key,
      },
      configForms: { get: () => form },
      effect: (fn) => fn(),
      on: () => {},
    },
  }
}

test('客户端半：注册一个 settings.plugins.tab，id 与 order 正确', async () => {
  const mod = await loadClient()
  const { form } = fakeForm()
  const { ctx, registered } = fakeCtx(form)

  mod.apply(ctx)

  assert.equal(registered.length, 1, '应当恰好注册一张卡片')
  const options = registered[0].options
  assert.equal(options.name, 'settings.plugins.tab')
  assert.equal(options.id, 'sync', 'settings 命名空间必须等于 cordis entry id')
  assert.equal(options.order, 104)
  assert.equal(options.locale, 'settings.sync', '缺 locale 就不会注入 props.t，卡片会整张抛错')
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(mod.inject.join(','), 'slots,locale,configForms')
})

test('客户端半：没有 configForms 时仍注册（降级为只读），不抛', async () => {
  const mod = await loadClient()
  const registered = []
  const ctx = {
    slots: {
      inject: (_s, cb) => cb(),
      register: (options) => { registered.push(options); return () => {} },
    },
    locale: { register: () => () => {}, bind: () => (k) => k },
    effect: (fn) => fn(),
    on: () => {},
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(registered.length, 1, '没有共享表单也要留下状态卡片')
})

test('客户端半：没有 slots 时不注册也不抛（旧宿主）', async () => {
  const mod = await loadClient()
  assert.equal(mod.apply({}), undefined)
})

test('路由常量两处一致：客户端 ROUTE == 宿主 OVERVIEW_ROUTE', async () => {
  const mod = await loadClient()
  assert.equal(mod.internals.ROUTE, OVERVIEW_ROUTE)
  const source = fs.readFileSync(CLIENT, 'utf8')
  assert.ok(source.includes('"/api/dsh-sync/overview"'), '客户端要自带一份字面量常量')
})

test('控制器：编辑 → 保存写回 form.set，脏标记归零', async () => {
  const mod = await loadClient()
  const { form, writes } = fakeForm()
  const controller = mod.internals.createController(form)

  assert.equal(controller.store.getSnapshot().dirty, false)
  assert.equal(controller.store.getSnapshot().configured, false, 'user 为空 = 未定制，显示默认值')

  controller.actions.edit('outDir', 'D:/bundle')
  controller.actions.edit('includeState', false)
  assert.equal(controller.store.getSnapshot().dirty, true)
  assert.equal(controller.store.getSnapshot().outDir, 'D:/bundle')

  controller.actions.save()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(writes, [['outDir', 'D:/bundle'], ['includeState', false]])
  const after = controller.store.getSnapshot()
  assert.equal(after.dirty, false)
  assert.equal(after.saved, true)
  assert.equal(after.configured, true, '写过一次 user 之后就是「已配置」')
})

test('控制器：写入失败置 failed，不假装成功', async () => {
  const mod = await loadClient()
  const broken = {
    getSnapshot: () => ({ value: {}, user: {}, writable: true }),
    set: () => Promise.reject(new Error('nope')),
    subscribe: () => () => {},
  }
  const controller = mod.internals.createController(broken)
  controller.actions.edit('profile', 'desktop')
  controller.actions.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const state = controller.store.getSnapshot()
  assert.equal(state.failed, true)
  assert.equal(state.saved, false)
  assert.equal(state.dirty, true, '失败后草稿必须留着，否则用户改动凭空消失')
})

test('控制器：不可写的表单不尝试写入', async () => {
  const mod = await loadClient()
  const controller = mod.internals.createController(null)
  const state = controller.store.getSnapshot()
  assert.equal(state.available, false)
  assert.equal(state.writable, false)
  assert.doesNotThrow(() => controller.actions.save())
})

// ── 状态汇总 ────────────────────────────────────────────────────────────────

function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-card-'))
  const mk = (rel) => { fs.mkdirSync(path.join(root, rel), { recursive: true }) }
  mk('profiles/desktop')
  mk('profiles/web')
  mk('sessions/enc-one/s1')
  mk('sessions/enc-one/s2')
  mk('sessions/enc-two/s3')
  mk('skills/a')
  mk('skills/b')
  fs.mkdirSync(path.join(root, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(root, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    tables: {
      workspaces: {
        w1: { path: 'D:/deepseek/a' },
        w2: { path: 'D:/deepseek/b' },
        w3: { path: 'D:/deepseek/c' },
      },
    },
  }), 'utf8')
  return root
}

test('collectOverview：数出 profile / 会话 / 工作区 / skills', async (t) => {
  const home = makeHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  resetJobs()

  const overview = await collectOverview({ dshHome: home, outDir: path.join(home, 'no-bundle') })

  assert.equal(overview.ok, true)
  assert.equal(overview.counts.profiles, 2)
  assert.equal(overview.counts.sessions, 3)
  assert.equal(overview.counts.sessionGroups, 2)
  assert.equal(overview.counts.workspaces, 3)
  assert.equal(overview.counts.skills, 2)
  assert.equal(overview.bundle.valid, false, '目录里没有 manifest.json')
  assert.equal(overview.lan.host, null, '没有发送端')
  assert.equal(overview.lan.total, 0)
  assert.equal(overview.machine.dshHome, home)
})

test('collectOverview：坏掉的 workspace.json 记未知，不当成 0', async (t) => {
  const home = makeHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), '{ not json', 'utf8')

  const overview = await collectOverview({ dshHome: home })
  assert.equal(overview.counts.workspaces, UNKNOWN)
  assert.equal(overview.counts.sessions, 3, '一处坏掉不影响其它计数')
})

test('collectOverview：空 dshHome 全部记未知，不抛', async () => {
  resetJobs()
  const overview = await collectOverview({})
  assert.equal(overview.counts.profiles, UNKNOWN)
  assert.equal(overview.counts.sessions, UNKNOWN)
  assert.equal(overview.bundle, null)
})

test('collectOverview：读得到 bundle 清单', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-bundle-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format: 'dsh-sync-bundle',
    exportedAt: '2026-10-22T10:00:00.000Z',
    sourceDshHome: 'C:/Users/x/.dsh',
    profiles: [{ name: 'desktop' }],
    integrity: { algorithm: 'sha256', files: 2305 },
    source: { dshVersion: '0.2.1-rc.2', identity: { hostname: 'OLD-PC' } },
    workspaces: [{ name: 'a' }, { name: 'b' }],
    settingsEncrypted: true,
  }), 'utf8')

  const overview = await collectOverview({ outDir: dir })
  assert.equal(overview.bundle.valid, true)
  assert.equal(overview.bundle.files, 2305)
  assert.equal(overview.bundle.exportedAt, '2026-10-22T10:00:00.000Z')
  assert.equal(overview.bundle.sourceHost, 'OLD-PC')
  assert.deepEqual(overview.bundle.profiles, ['desktop'])
  assert.equal(overview.bundle.workspaces, 2)
  assert.equal(overview.bundle.encrypted, true)
})

// ── 路由注册 ────────────────────────────────────────────────────────────────

test('registerOverviewRoute：没有 connection 服务时返回 false 不抛', () => {
  assert.equal(registerOverviewRoute({ effect: (fn) => fn() }, undefined, () => ({})), false)
  assert.equal(registerOverviewRoute({ effect: (fn) => fn() }, {}, () => ({})), false)
})

test('registerOverviewRoute：注册被拒时 refuse-quietly', () => {
  const refusing = { fetch: { register: () => { throw new Error('denied') } } }
  assert.equal(registerOverviewRoute({ effect: (fn) => fn() }, refusing, () => ({})), false)
})

test('registerOverviewRoute：挂上 /api 路由，响应是 200 + no-store', async (t) => {
  const home = makeHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  resetJobs()

  const seen = []
  const connection = {
    fetch: {
      register(route) {
        seen.push(route)
        return () => {}
      },
    },
  }
  const scope = { effect: (fn) => { fn() } }

  const ok = registerOverviewRoute(scope, connection, () => ({ dshHome: home, outDir: '' }))
  assert.equal(ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, OVERVIEW_ROUTE)
  assert.deepEqual(seen[0].methods, ['POST'])
  assert.equal(seen[0].requestBody, 'buffered')

  const response = await seen[0].fetch(new Request('http://127.0.0.1' + OVERVIEW_ROUTE, { method: 'POST' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.counts.sessions, 3)
})

// ── 空串回退（实机截图暴露的缺陷）───────────────────────────────────────────

test('withAutoFallbacks：schema 默认空串回退到计算默认，显式值原样保留', async () => {
  const entry = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
  const fallback = entry.internals.withAutoFallbacks

  const emptied = fallback({ dshHome: '', outDir: '', profile: 'desktop' })
  assert.ok(emptied.dshHome.length > 0, 'dshHome 空串必须回退，否则卡片全「—」、工具直接抛错')
  assert.ok(emptied.outDir.length > 0, 'outDir 空串必须回退')
  assert.equal(emptied.profile, 'desktop', '非空值不回退')

  const explicit = fallback({ dshHome: 'D:/custom-dsh', outDir: 'E:/bundle' })
  assert.equal(explicit.dshHome, 'D:/custom-dsh')
  assert.equal(explicit.outDir, 'E:/bundle')
})
