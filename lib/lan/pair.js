// lib/lan/pair.js — 配对门禁。纯逻辑，可注入时钟与随机源，因此完全可测。
//
// 威胁模型（局域网直传的真实风险，不是理论风险）：
//   · 同一个 Wi-Fi 下的其他人扫到端口，想直接拉走整个 bundle（里面含会话历史、settings，
//     开 includeCredentials 时还有 .credentials.yaml）。
//   · 配对码被投屏 / 截图 / 念出来时被旁人看到，事后再用一次。
//   · 有人对着端口暴力猜配对码。
// 对应的三道闸：① 配对码必须由**接收方页面上点「接受」**这一步放行（本文件只管码本身，
// 放行判断在 host.js，且只允许本机来源调用）；② 6 位码 5 分钟过期且**只能用一次**；
// ③ 5 次试错即锁定，锁死后要换码（换码是本机操作，别人做不到）。
import crypto from 'node:crypto'

import { PAIR_CODE_TTL_MS, PAIR_MAX_ATTEMPTS } from './constants.js'

/** 等长常量时间比较，避免按字节比较泄漏配对码前缀。 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  // 长度先比：两边的码长都是固定的，长度本身不构成泄漏。
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** 6 位纯数字，补前导零。刻意不用字母：手机键盘输数字最快，也不会因为大小写/形近字出错。 */
export function generateCode(randomInt) {
  const pick = randomInt || ((max) => crypto.randomInt(max))
  return String(pick(1_000_000)).padStart(6, '0')
}

/** 用户可能输成 "123 456" 或 "123-456"。归一化后才是比较对象。 */
export function normalizeCode(input) {
  return String(input === undefined || input === null ? '' : input).replace(/[\s\-_]/g, '')
}

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxAttempts]
 * @param {() => number} [options.now]
 * @param {(max:number) => number} [options.randomInt]
 * @param {() => string} [options.randomToken]
 */
export function createPairGate(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : PAIR_CODE_TTL_MS
  const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : PAIR_MAX_ATTEMPTS
  const now = options.now || (() => Date.now())
  const randomToken = options.randomToken || (() => crypto.randomBytes(32).toString('hex'))

  let code = generateCode(options.randomInt)
  let createdAt = now()
  let expiresAt = createdAt + ttlMs
  let attempts = 0
  let locked = false
  let token = ''
  let usedAt = 0
  /** 第一次配对成功用的来源地址。只有它能复用这个码（续传 / 重试）。 */
  let usedBy = ''

  function reset() {
    code = generateCode(options.randomInt)
    createdAt = now()
    expiresAt = createdAt + ttlMs
    attempts = 0
    locked = false
    token = ''
    usedAt = 0
    usedBy = ''
  }

  const api = {
    get code() { return code },
    get expiresAt() { return expiresAt },

    /** 当前还剩多少毫秒有效（已锁定返回 0；已使用仍报剩余，因为同一台机器还能续传）。 */
    remainingMs() {
      if (locked) return 0
      return Math.max(0, expiresAt - now())
    },

    /**
     * 试一次配对码。
     * @param {string} input 用户输入的码（可以是 "123 456"）
     * @param {{requester?: string}} [opts] requester = 请求来源地址
     * @returns {{ok:true, token:string, reused?:boolean} | {ok:false, reason:'empty'|'used'|'gone'|'expired'|'wrong'|'locked', remainingAttempts?:number}}
     */
    attempt(input, opts = {}) {
      const given = normalizeCode(input)
      const who = String(opts.requester === undefined || opts.requester === null ? '' : opts.requester)
      if (given === '') return { ok: false, reason: 'empty' }
      if (usedAt !== 0) {
        // 已经用过的码，**只有当初那台机器**能再用一次。
        //
        // 为什么必须有这条豁免：配对码在第一次配对成功后就标记 used（防泄漏后二次利用），
        // 而「传到一半断了、重跑一次接着传」恰恰要再配一次对。不给同源豁免，
        // 续传在用户视角就是走不通的 —— 屏幕上那个码看起来还能用，实际一定失败。
        // 为什么豁免只给同源：旁人拿到码（投屏、截图）一定来自另一个地址，仍然被拒。
        if (who !== '' && who === usedBy) return { ok: true, token, reused: true }
        return { ok: false, reason: 'used' }
      }
      // 锁死与过期分开报：前者说明有人在试，后者只是慢了一步 —— 对用户是两种不同的提示。
      if (locked) return { ok: false, reason: 'locked' }
      if (now() > expiresAt) return { ok: false, reason: 'expired' }

      if (!safeEqual(given, code)) {
        attempts += 1
        const remainingAttempts = Math.max(0, maxAttempts - attempts)
        if (remainingAttempts === 0) locked = true
        return { ok: false, reason: locked ? 'locked' : 'wrong', remainingAttempts }
      }

      usedAt = now()
      usedBy = who
      token = randomToken()
      return { ok: true, token }
    },

    /** 校验后续请求携带的 token。 */
    validateToken(candidate) {
      if (token === '') return false
      if (usedAt !== 0 && now() > expiresAt + 60 * 60_000) return false   // 传输有上限，别让 token 永久有效
      return safeEqual(candidate, token)
    },

    /** 换一个新码（本机操作）。旧的 token 一并作废，防止换码后旧会话继续可用。 */
    regenerate() {
      reset()
      return code
    },

    /** 给页面/工具看的状态。**刻意不含 token** —— 页面是给眼睛看的，token 不该出现在屏幕上。 */
    status() {
      return {
        expiresAt,
        remainingMs: api.remainingMs(),
        attempts,
        remainingAttempts: Math.max(0, maxAttempts - attempts),
        locked,
        used: usedAt !== 0,
        createdAt,
      }
    },

    get locked() { return locked },
    get used() { return usedAt !== 0 },
  }
  return api
}
