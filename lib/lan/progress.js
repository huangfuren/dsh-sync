// lib/lan/progress.js — 传输进度模型。纯逻辑，不碰网络与文件。
//
// 为什么单独抽出来：两端（发送端与接收端）都要展示同一套指标，而进度页、SSE、
// 工具返回值三处消费同一份快照。如果各自算各自的，最容易出现的 bug 是
// 「页面显示 98% 但工具说失败」或者「速率在两处算得不一样」。

/**
 * 滑动窗口速率。用窗口而不是「总量 / 总耗时」，是因为后者的 ETA 会被开头的
 * 冷启动拖偏：前 2 秒在等配对确认、在算已有文件哈希，这段时间不该计入传输速率。
 */
function createRateMeter(windowMs, now) {
  let samples = []   // [{t, bytes}] 单调递增
  return {
    add(bytes) {
      const t = now()
      samples.push({ t, bytes })
      // 丢掉窗口外与「同一毫秒内重复」的采样点，窗口最长保留 64 个点。
      const cutoff = t - windowMs
      samples = samples.filter((s) => s.t >= cutoff)
      if (samples.length > 64) samples = samples.slice(-64)
    },
    bps() {
      if (samples.length < 2) return 0
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = (last.t - first.t) / 1000
      if (dt <= 0) return 0
      let sum = 0
      for (let i = 1; i < samples.length; i++) sum += samples[i].bytes
      return Math.round(sum / dt)
    },
    reset() { samples = [] },
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.totalFiles]
 * @param {number} [options.totalBytes]
 * @param {number} [options.windowMs] 速率采样窗口
 * @param {() => number} [options.now] 注入时钟，便于测试 ETA
 */
export function createProgress(options = {}) {
  const windowMs = options.windowMs || 3000
  const now = options.now || (() => Date.now())
  const meter = createRateMeter(windowMs, now)

  const state = {
    phase: 'idle',
    files: { done: 0, total: Math.max(0, Number(options.totalFiles) || 0) },
    bytes: { done: 0, total: Math.max(0, Number(options.totalBytes) || 0) },
    current: '',
    skipped: 0,
    errors: [],
    startedAt: 0,
    finishedAt: 0,
    note: '',
  }

  function elapsedMs() {
    if (state.startedAt === 0) return 0
    const end = state.finishedAt === 0 ? now() : state.finishedAt
    return Math.max(0, end - state.startedAt)
  }

  const api = {
    /** 切换阶段：idle / pairing / waiting / transferring / verifying / applying / done / failed */
    setPhase(phase, note) {
      state.phase = String(phase)
      if (note !== undefined) state.note = String(note)
      if (state.startedAt === 0 && phase !== 'idle') state.startedAt = now()
      if ((phase === 'done' || phase === 'failed') && state.finishedAt === 0) state.finishedAt = now()
      return api
    },
    /**
     * 总量信息在配对之后才知道（对方 /info 给全量、/stream 响应头给「扣掉续传后」的量）。
     * 所以必须允许**改小**：先按全量显示，续传扫描后改成实际要传的量。
     * 唯一的约束是不能小于已完成的量，否则进度条会倒着走。
     */
    setTotals({ files, bytes } = {}) {
      if (Number.isFinite(files) && files >= state.files.done) state.files.total = files
      if (Number.isFinite(bytes) && bytes >= state.bytes.done) state.bytes.total = bytes
      return api
    },
    fileStart(path, size) {
      state.current = String(path || '')
      // 单文件大小未知时不能污染总量，只在已知时累加。总量以 checksums 汇总为准。
      if (Number.isFinite(size) && state.bytes.total === 0) state.bytes.total += size
      return api
    },
    addBytes(n) {
      const v = Number(n)
      if (!Number.isFinite(v) || v <= 0) return api
      state.bytes.done += v
      meter.add(v)
      return api
    },
    fileDone() {
      state.files.done += 1
      return api
    },
    /** 续传时命中已有且哈希一致的文件：计入完成，不计入字节（那部分字节本来就没传）。 */
    fileSkipped(bytes) {
      state.files.done += 1
      state.skipped += 1
      const v = Number(bytes)
      if (Number.isFinite(v) && v > 0) {
        state.bytes.done += v
        state.bytes.total = Math.max(state.bytes.total, state.bytes.done)
      }
      return api
    },
    fail(path, reason) {
      state.errors.push({ path: String(path || ''), reason: String(reason || '') })
      if (state.errors.length > 200) state.errors = state.errors.slice(0, 200)
      return api
    },
    /** 完成后回填实测总量，避免「分母是估算值」导致进度停在 99%。 */
    finalize() {
      state.bytes.total = Math.max(state.bytes.total, state.bytes.done)
      state.files.total = Math.max(state.files.total, state.files.done)
      return api
    },
    /**
     * 归零后重新开始一轮。发送端的 progress 是长生命周期的（一个进程只跑一个服务），
     * 而一次中断后的续传是一个全新会话 —— 不归零的话进度会从上一轮的终点往上加，
     * 表现为「刚开始就 60%」，比不显示更糟。
     */
    reset() {
      state.phase = 'idle'
      state.files = { done: 0, total: state.files.total }
      state.bytes = { done: 0, total: state.bytes.total }
      state.current = ''
      state.skipped = 0
      state.errors = []
      state.startedAt = 0
      state.finishedAt = 0
      state.note = ''
      meter.reset()
      return api
    },
    snapshot() {
      const bps = state.phase === 'transferring' ? meter.bps() : 0
      const remaining = Math.max(0, state.bytes.total - state.bytes.done)
      // 剩余量按字节算；总量为 0（还没拿到清单）时按文件数估，避免除零。
      let etaMs = 0
      if (bps > 0 && remaining > 0) etaMs = Math.round((remaining / bps) * 1000)
      else if (bps > 0 && state.files.total > state.files.done) {
        const perFile = state.bytes.done > 0 ? state.bytes.done / Math.max(1, state.files.done) : 0
        const left = (state.files.total - state.files.done) * perFile
        etaMs = left > 0 ? Math.round((left / bps) * 1000) : 0
      }
      const totalForPct = state.bytes.total > 0 ? state.bytes.total : 0
      const percent = totalForPct > 0
        ? Math.min(100, Math.round((state.bytes.done / totalForPct) * 1000) / 10)
        : (state.files.total > 0 ? Math.min(100, Math.round((state.files.done / state.files.total) * 1000) / 10) : 0)
      return {
        phase: state.phase,
        note: state.note,
        percent,
        files: { done: state.files.done, total: state.files.total, skipped: state.skipped },
        bytes: { done: state.bytes.done, total: state.bytes.total },
        bps,
        etaMs,
        elapsedMs: elapsedMs(),
        current: state.current,
        errorCount: state.errors.length,
        errors: state.errors.slice(-8),
      }
    },
    /** 只读视图，供测试断言内部状态。 */
    get raw() { return state },
  }
  return api
}

/** 人类可读的字节数。进度页与工具输出共用，保证两处写法一致。 */
export function formatBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1 }
  return (i === 0 ? String(Math.round(x)) : x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)) + ' ' + units[i]
}

/** 人类可读的时长。刻意不显示「1 天 2 小时」—— 传输不会那么久，>1h 就说明该报错了。 */
export function formatDuration(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '0s'
  const s = Math.round(v / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return m + 'm' + (rest > 0 ? ' ' + rest + 's' : '')
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

/** 一行摘要，工具输出与日志共用。 */
export function summarizeProgress(snap) {
  const parts = []
  parts.push(snap.percent.toFixed(1) + '%')
  parts.push(formatBytes(snap.bytes.done) + ' / ' + formatBytes(snap.bytes.total))
  parts.push(snap.files.done + '/' + snap.files.total + ' 个文件')
  if (snap.files.skipped > 0) parts.push('续传跳过 ' + snap.files.skipped)
  if (snap.bps > 0) parts.push(formatBytes(snap.bps) + '/s')
  if (snap.etaMs > 0) parts.push('剩余 ' + formatDuration(snap.etaMs))
  if (snap.errorCount > 0) parts.push('失败 ' + snap.errorCount)
  return parts.join(' · ')
}
