// lib/lan/devices.js — 「发现到的机器」登记表，以及当前选中的那一台。
//
// 为什么要有它：discover 的结果原本只是一次性的工具输出，想迁移就得把 IP 手抄进 pull。
// 用户要的流程是「先选中设备，再迁移」，所以发现结果必须**留下来**，并能被三种东西引用：
//   ① 卡片上的一次点击（选中）；
//   ② 工具参数 `deviceId`（id / 序号 / 别名 / IP 都认）；
//   ③ 「就用刚才选中的那台」——host 与 deviceId 都不给时回退到选中项。
//
// 两条刻意的取舍：
//   · **全部在内存里**（与 jobs.js 同一条规矩）：插件重载 / DSH 重启后回到空态，不假装还记得。
//     扫描结果会过期，从磁盘恢复一个「上次看到的机器」比没有更误导。
//   · **不认识的选择一律报错并列出候选，绝不猜**。挑错机器 = 把 bundle 传给不该收到的那一台。
const DEFAULT_PORT = 38473

let devices = []
let selectedId = ''
let scannedAt = 0
/**
 * 最近一次登记是否**顺手**选中了唯一的那一台。
 * 界面据此说一句「只找到一台，已自动选中」—— 否则用户会怀疑这台是谁选的。
 * 用户自己点过之后立刻归 false：那时是明确选择，不需要解释。
 */
let autoPicked = false

/** 测试用：把登记表清回空态。 */
export function resetDevices() {
  devices = []
  selectedId = ''
  scannedAt = 0
  autoPicked = false
}

/**
 * 规范化一批发现结果：补 `id` 与 1 基 `index`，去重，按地址排序。
 *
 * **排序不是洁癖**：同批机器扫两次的顺序必须一致，否则卡片上「第 2 台」会变成第 3 台，
 * 用户按序号选中就选错了。去重按 `address:port`，因为扫描兜底与广播可能同时命中一台。
 */
export function annotateDevices(list) {
  const src = Array.isArray(list) ? list : []
  const seen = new Set()
  const out = []
  for (const raw of src) {
    if (raw === null || typeof raw !== 'object') continue
    const address = String(raw.address || '')
    if (address === '') continue
    const port = Number(raw.port) || DEFAULT_PORT
    const id = address + ':' + port
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      address,
      port,
      alias: String(raw.alias || raw.hostname || address),
      hostname: String(raw.hostname || ''),
      version: String(raw.version || ''),
      state: String(raw.state || 'unknown'),
      files: Number(raw.bundle && raw.bundle.files) || 0,
      bytes: Number(raw.bundle && raw.bundle.bytes) || 0,
      // 0.18 起发送端在 /info 里带内容计数与 autoAccept 标志；旧发送端没有这些字段时
      // 保持 undefined，卡片就不渲染那一行（而不是显示「0 个会话」误导人）。
      sessions: raw.bundle && raw.bundle.sessions != null ? Number(raw.bundle.sessions) || 0 : undefined,
      plugins: raw.bundle && raw.bundle.plugins != null ? Number(raw.bundle.plugins) || 0 : undefined,
      workspaces: raw.bundle && raw.bundle.workspaces != null ? Number(raw.bundle.workspaces) || 0 : undefined,
      encrypted: Boolean(raw.bundle && raw.bundle.encrypted),
      autoAccept: raw.autoAccept === true,
      via: String(raw.via || ''),
    })
  }
  out.sort((a, b) => (a.address === b.address ? a.port - b.port : (a.address < b.address ? -1 : 1)))
  out.forEach((d, i) => { d.index = i + 1 })
  return out
}

/**
 * 登记一次扫描结果。
 * **选中的那台若不在新列表里，不静默改选另一台** —— 保留 id 并标 stale，
 * 让界面明确说「选中的设备已不在最新列表（对方可能关了发送端）」。
 *
 * **只有一台且用户还没选过时顺手选中**：这时不存在「选错」的可能（候选唯一），
 * 让用户再点一次纯属多余。反过来，已经选过就不动 —— 换一批结果后旧选择变成 stale，
 * 由界面提示重新扫描，绝不替用户改选。
 *
 * @param {object[]} list
 * @param {object} [options]
 * @param {boolean} [options.autoSelectSingle=true] 关掉可拿到「纯登记」行为（测试用）
 * @returns {number} 登记后的设备数
 */
export function setDevices(list, options = {}) {
  devices = annotateDevices(list)
  scannedAt = Date.now()
  autoPicked = false
  if (options.autoSelectSingle !== false && selectedId === '' && devices.length === 1) {
    selectedId = devices[0].id
    autoPicked = true
  }
  return devices.length
}

export function getDevices() {
  return devices.map((d) => ({ ...d }))
}

export function getScannedAt() {
  return scannedAt
}

/**
 * 把一个用户给的设备标识解析成一台设备。
 * 支持：id（`192.168.1.5:38473`）、1 基序号（`"1"`）、IP、别名、主机名（后两者先精确后包含）。
 * @throws 空列表 / 没匹配 / 多匹配时抛错，消息里带上当前列表，便于直接改口。
 */
export function resolveDevice(input, options = {}) {
  const list = Array.isArray(options.devices) ? options.devices : devices
  const raw = String(input === undefined || input === null ? '' : input).trim()
  if (raw === '') throw new Error('缺少设备标识：给 id / 序号 / 别名 / IP，或先跑 dshsync_lan_discover')
  if (list.length === 0) {
    throw new Error('当前没有已发现的设备：先跑 dshsync_lan_discover，或在设置卡片里点「扫描」')
  }

  if (/^\d+$/.test(raw)) {
    const byIndex = list.find((d) => d.index === Number(raw))
    if (byIndex) return { ...byIndex }
    throw new Error('序号「' + raw + '」超出范围，当前只有 ' + list.length + ' 台设备')
  }

  const needle = raw.toLowerCase()
  const exact = list.filter((d) => d.id.toLowerCase() === needle
    || d.address.toLowerCase() === needle
    || d.alias.toLowerCase() === needle
    || (d.hostname !== '' && d.hostname.toLowerCase() === needle))
  if (exact.length === 1) return { ...exact[0] }
  if (exact.length > 1) {
    throw new Error('「' + raw + '」匹配到多台：' + exact.map((d) => d.alias + '@' + d.id).join('，'))
  }

  const fuzzy = list.filter((d) => d.alias.toLowerCase().includes(needle)
    || (d.hostname !== '' && d.hostname.toLowerCase().includes(needle)))
  if (fuzzy.length === 1) return { ...fuzzy[0] }
  if (fuzzy.length > 1) {
    throw new Error('「' + raw + '」模糊匹配到多台：' + fuzzy.map((d) => d.alias + '@' + d.id).join('，') + '；请用序号或 IP')
  }
  throw new Error('没有找到设备「' + raw + '」。当前列表：'
    + list.map((d) => d.index + '. ' + d.alias + '@' + d.id).join('，'))
}

/** 选中一台（顺带把解析结果固化成 canonical id），返回该设备。 */
export function selectDevice(input) {
  const device = resolveDevice(input)
  selectedId = device.id
  autoPicked = false
  return device
}

export function clearSelection() {
  selectedId = ''
  autoPicked = false
}

/**
 * 当前选中项。`stale` 表示「选过，但已不在最新列表里」——
 * 调用方必须据此报错，而不是拿着一个空设备继续往下走。
 * `auto` 表示这一台是「只找到一台」时顺手选的，不是用户点的。
 */
export function getSelection() {
  if (selectedId === '') return { id: '', device: null, stale: false, auto: false }
  const device = devices.find((d) => d.id === selectedId) || null
  return {
    id: selectedId,
    device: device === null ? null : { ...device },
    stale: device === null,
    auto: autoPicked && device !== null,
  }
}

/** 送给浏览器的完整快照：设备列表 + 扫描时间 + 选中项。 */
export function deviceSnapshot() {
  const selection = getSelection()
  return {
    devices: devices.map((d) => ({ ...d })),
    scannedAt,
    selection: {
      id: selection.id,
      stale: selection.stale,
      auto: selection.auto,
      device: selection.device,
    },
  }
}
