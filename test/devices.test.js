// test/devices.test.js — 「先选中设备，再迁移」这条链路。
//
// 这一类测的重点不是界面像素，而是三件会静默错事的地方：
//   ① 同一批机器两次扫描必须得到**同样的序号**（按序号选错机器 = 把 bundle 传给错误的一方）；
//   ② 解析设备标识时**多命中必须报错并列出候选**，绝不猜；
//   ③ 选中项过期（对方关了发送端）要报 stale，而不是当作「没选过」继续往下走。
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  annotateDevices, clearSelection, deviceSnapshot, getDevices, getSelection,
  resetDevices, resolveDevice, selectDevice, setDevices,
} from '../lib/lan/devices.js'
import { resetJobs } from '../lib/lan/jobs.js'
import { DEVICES_ROUTE, registerDevicesRoute } from '../lib/status.js'
import { resolvePullTarget } from '../lib/tools/lan-pull.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLIENT = path.join(ROOT, 'client.js')

// ── 规范化 ──────────────────────────────────────────────────────────────────

test('annotateDevices：补 id 与 1 基序号，按地址排序', () => {
  const list = annotateDevices([
    { address: '192.168.1.9', port: 38473, alias: 'b' },
    { address: '192.168.1.5', port: 38473, alias: 'a' },
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].alias, 'a', '按地址升序')
  assert.equal(list[0].index, 1)
  assert.equal(list[1].index, 2)
  assert.equal(list[0].id, '192.168.1.5:38473')
})

test('annotateDevices：同一台被广播与扫描各命中一次时去重', () => {
  const list = annotateDevices([
    { address: '192.168.1.5', port: 38473, alias: 'a', via: 'udp' },
    { address: '192.168.1.5', port: 38473, alias: 'a', via: 'scan' },
  ])
  assert.equal(list.length, 1)
})

test('annotateDevices：脏输入不进表（无地址 / 非对象）', () => {
  assert.equal(annotateDevices([{ port: 1 }, null, 'x', undefined]).length, 0)
  assert.equal(annotateDevices(null).length, 0)
})

// ── 登记表与解析 ────────────────────────────────────────────────────────────

function seed() {
  resetDevices()
  setDevices([
    { address: '192.168.1.5', port: 38473, alias: 'OLD-PC', hostname: 'old-pc', state: 'pairing', bundle: { files: 12, bytes: 2048 } },
    { address: '192.168.1.9', port: 38473, alias: 'NAS', state: 'unknown' },
  ])
}

test('解析：id / 序号 / 别名 / IP / 主机名 都认', () => {
  seed()
  assert.equal(resolveDevice('192.168.1.5:38473').alias, 'OLD-PC')
  assert.equal(resolveDevice('1').alias, 'OLD-PC')
  assert.equal(resolveDevice('2').alias, 'NAS')
  assert.equal(resolveDevice('OLD-PC').address, '192.168.1.5')
  assert.equal(resolveDevice('old-pc').address, '192.168.1.5')
  assert.equal(resolveDevice('192.168.1.9').alias, 'NAS')
})

test('解析：多命中报错并列候选，绝不猜', () => {
  resetDevices()
  setDevices([
    { address: '192.168.1.5', alias: 'PC' },
    { address: '192.168.1.6', alias: 'PC' },
  ])
  assert.throws(() => resolveDevice('PC'), /匹配到多台/)
})

test('解析：序号越界与空列表都给得出下一步', () => {
  seed()
  assert.throws(() => resolveDevice('9'), /超出范围/)
  resetDevices()
  assert.throws(() => resolveDevice('1'), /当前没有已发现的设备/)
  assert.throws(() => resolveDevice(''), /缺少设备标识/)
})

test('选中：写入快照，换一批扫描结果后报 stale 而不是静默改选', () => {
  seed()
  const picked = selectDevice('OLD-PC')
  assert.equal(picked.id, '192.168.1.5:38473')
  assert.equal(getSelection().device.alias, 'OLD-PC')
  assert.equal(deviceSnapshot().selection.stale, false)

  // 对方关了发送端：新一次扫描里没有它
  setDevices([{ address: '192.168.1.9', alias: 'NAS' }])
  const after = getSelection()
  assert.equal(after.device, null)
  assert.equal(after.stale, true, 'stale 必须为真，调用方据此报错')

  clearSelection()
  assert.equal(getSelection().id, '')
})

test('只有一台且还没选过时自动选中；多于一台或已选过则不动', () => {
  resetDevices()
  setDevices([{ address: '192.168.1.5', alias: 'OLD-PC' }])
  const auto = getSelection()
  assert.equal(auto.id, '192.168.1.5:38473', '候选唯一时不必再让用户点一次')
  assert.equal(auto.auto, true, '自动选中要能被界面说清楚是谁选的')

  // 又找到一台：auto 归位，但已有的选择不被覆盖
  setDevices([
    { address: '192.168.1.5', alias: 'OLD-PC' },
    { address: '192.168.1.9', alias: 'NAS' },
  ])
  assert.equal(getSelection().auto, false)
  assert.equal(getSelection().id, '192.168.1.5:38473')

  // 用户自己点过 → 明确选择，不算 auto
  resetDevices()
  setDevices([
    { address: '192.168.1.5', alias: 'OLD-PC' },
    { address: '192.168.1.9', alias: 'NAS' },
  ])
  selectDevice('2')
  assert.equal(getSelection().id, '192.168.1.9:38473')
  assert.equal(getSelection().auto, false)
})

test('剩下一台也不替用户改选：stale 优先于自动选中', () => {
  resetDevices()
  setDevices([
    { address: '192.168.1.5', alias: 'OLD-PC' },
    { address: '192.168.1.9', alias: 'NAS' },
  ])
  selectDevice('OLD-PC')
  // 旧的那台关了发送端，新一次扫描里只剩 NAS
  setDevices([{ address: '192.168.1.9', alias: 'NAS' }])
  const sel = getSelection()
  assert.equal(sel.stale, true)
  assert.equal(sel.id, '192.168.1.5:38473', '自动选中只在用户没选过时发生，绝不顺手改选')
  assert.equal(sel.auto, false)
})

test('getDevices 返回副本，外部改动不污染登记表', () => {
  seed()
  const list = getDevices()
  list[0].alias = 'HACKED'
  assert.equal(getDevices()[0].alias, 'OLD-PC')
})

// ── 路由 ────────────────────────────────────────────────────────────────────

test('registerDevicesRoute：没有 connection 时返回 false 不抛', () => {
  assert.equal(registerDevicesRoute({ effect: (fn) => fn() }, undefined), false)
  assert.equal(registerDevicesRoute({ effect: (fn) => fn() }, {}), false)
})

test('registerDevicesRoute：注册被拒时 refuse-quietly', () => {
  const refusing = { fetch: { register: () => { throw new Error('denied') } } }
  assert.equal(registerDevicesRoute({ effect: (fn) => fn() }, refusing), false)
})

/** 挂一条路由并把 handler 取出来。 */
function mount() {
  const seen = []
  const connection = { fetch: { register(route) { seen.push(route); return () => {} } } }
  const ok = registerDevicesRoute({ effect: (fn) => { fn() } }, connection)
  assert.equal(ok, true)
  return seen[0]
}

function call(route, body) {
  return route.fetch(new Request('http://127.0.0.1' + DEVICES_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('路由：默认动作是 snapshot（零网络 I/O），不是 scan', async () => {
  resetDevices()
  const route = mount()
  const response = await route.fetch(new Request('http://127.0.0.1' + DEVICES_ROUTE, { method: 'POST' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.action, 'snapshot', '写错/缺省 action 不许悄悄发起一轮网络扫描')
  assert.deepEqual(body.devices, [])
})

test('路由：未知 action 落到 snapshot，绝不发起网络扫描', async () => {
  resetDevices()
  const route = mount()
  const body = await (await call(route, { action: 'scan-everything-now' })).json()
  assert.equal(body.ok, true)
  assert.equal(body.action, 'snapshot', '一个拼错的 action 不该让机器扫一轮局域网')
})

test('路由：quick 只发广播，不走逐 IP 扫描', async () => {
  resetDevices()
  const route = mount()
  const body = await (await call(route, { action: 'quick' })).json()
  assert.equal(body.ok, true)
  assert.equal(body.action, 'quick')
  assert.equal(body.scanned, 0, 'quick 不许打 254 个地址')
  assert.ok(Array.isArray(body.devices))
})

test('路由：选中一台 → 快照带出选中项；选中不存在的 → ok:false 且给消息', async () => {
  resetJobs()
  seed()
  const route = mount()

  const picked = await call(route, { action: 'select', id: '2' })
  const okBody = await picked.json()
  assert.equal(okBody.ok, true)
  assert.equal(okBody.selection.device.alias, 'NAS')
  assert.equal(getSelection().id, '192.168.1.9:38473', '卡片与工具共用一份选中状态')

  const bad = await call(route, { action: 'select', id: '999' })
  const badBody = await bad.json()
  assert.equal(badBody.ok, false)
  assert.equal(badBody.error.code, 'dsh-sync/devices-failed')
  assert.match(badBody.error.message, /超出范围/)
})

test('路由：clear 取消选中', async () => {
  seed()
  const route = mount()
  await call(route, { action: 'select', id: '1' })
  const cleared = await (await call(route, { action: 'clear' })).json()
  assert.equal(cleared.ok, true)
  assert.equal(cleared.selection.id, '')
})

// ── 客户端半 ────────────────────────────────────────────────────────────────

const FAKE_REACT = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
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

test('路由常量两处一致：客户端 DEVICES_ROUTE == 宿主 DEVICES_ROUTE', async () => {
  const mod = await loadClient()
  assert.equal(mod.internals.DEVICES_ROUTE, DEVICES_ROUTE)
  const source = (await import('node:fs')).readFileSync(CLIENT, 'utf8')
  assert.ok(source.includes('"/api/dsh-sync/devices"'), '客户端要自带一份字面量常量')
})

test('设备区块：未扫描 / 空列表 / 有列表 / 选中过期 四态都不抛', async () => {
  const mod = await loadClient()
  const DevicesBlock = mod.internals.DevicesBlock
  const t = (key) => key
  const base = { t, onScan: () => {}, onSelect: () => {} }

  assert.doesNotThrow(() => DevicesBlock({ ...base, dev: { status: 'idle', data: null, error: '' } }))
  assert.doesNotThrow(() => DevicesBlock({ ...base, dev: { status: 'loading', data: null, error: '' } }))
  assert.doesNotThrow(() => DevicesBlock({ ...base, dev: { status: 'error', data: null, error: '' } }))
  assert.doesNotThrow(() => DevicesBlock({
    ...base,
    dev: { status: 'ready', data: { devices: [], selection: { id: '', stale: false, device: null } }, error: '' },
  }))

  const withList = {
    status: 'ready',
    data: deviceSnapshot(),
    error: '',
  }
  seed()
  assert.doesNotThrow(() => DevicesBlock({ ...base, dev: { ...withList, data: deviceSnapshot() } }))

  selectDevice('1')
  setDevices([{ address: '192.168.1.9', alias: 'NAS' }])   // 让选中项过期
  assert.doesNotThrow(() => DevicesBlock({ ...base, dev: { ...withList, data: deviceSnapshot() } }))
})

test('设备区块：自动选中态（selection.auto）也能画出来', async () => {
  const mod = await loadClient()
  const DevicesBlock = mod.internals.DevicesBlock
  const t = (key) => key
  resetDevices()
  setDevices([{ address: '192.168.1.5', alias: 'OLD-PC' }])
  const snap = deviceSnapshot()
  assert.equal(snap.selection.auto, true, '快照要带出 auto，界面才说得清是谁选的')
  assert.doesNotThrow(() => DevicesBlock({
    t, onScan: () => {}, onSelect: () => {},
    dev: { status: 'ready', data: snap, error: '' },
  }))
})

// ── 工具层：pull 怎么挑机器 ─────────────────────────────────────────────────

test('resolvePullTarget：host 优先，且不改动选中状态', async () => {
  seed()
  const target = await resolvePullTarget({ host: '10.0.0.7' })
  assert.equal(target.address, '10.0.0.7')
  assert.equal(getSelection().id, '', '给了 host 就不该顺手改选中项')
})

test('resolvePullTarget：deviceId 解析成功时顺手记为选中（两条路径共用一份状态）', async () => {
  seed()
  const target = await resolvePullTarget({ deviceId: 'NAS' })
  assert.equal(target.address, '192.168.1.9')
  assert.equal(getSelection().device.alias, 'NAS')
  assert.equal(target.device.id, '192.168.1.9:38473')
})

test('resolvePullTarget：什么都不给 → 用选中项；没选过 → 明确报错', async () => {
  seed()
  selectDevice('OLD-PC')
  const target = await resolvePullTarget({})
  assert.equal(target.address, '192.168.1.5')

  resetDevices()
  await assert.rejects(() => resolvePullTarget({}), /没有指定目标机器/)
})

test('resolvePullTarget：选中项过期时报 stale，不说「没选设备」', async () => {
  seed()
  selectDevice('OLD-PC')
  setDevices([{ address: '192.168.1.9', alias: 'NAS' }])
  await assert.rejects(() => resolvePullTarget({}), /不在最新列表/)
})

test('deviceMeta：没体积时走「未报告体积」，有体积时显示文件数，状态跟随字典', async () => {
  const mod = await loadClient()
  // t 是恒等函数，所以这里断言的是**用哪个字典键**，而不是最终文案
  const empty = mod.internals.deviceMeta((k) => k, {
    address: '192.168.1.5', port: 38473, files: 0, bytes: 0, state: 'pairing',
  })
  assert.ok(empty.includes('192.168.1.5:38473'))
  assert.ok(empty.includes('devicesNoBundle'), '0 个文件不能显示成「0 个文件」')
  assert.ok(empty.includes('devStatePairing'), 'pairing 要翻译成「等待配对」而不是原样显示')

  const withSize = mod.internals.deviceMeta((k) => k, {
    address: '192.168.1.5', port: 38473, files: 12, bytes: 2048, state: 'unknown',
  })
  assert.ok(withSize.includes('devicesFiles'), '有体积时走带数量的那条文案')
  assert.ok(!withSize.includes('devicesNoBundle'))
})
