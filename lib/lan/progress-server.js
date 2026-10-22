// lib/lan/progress-server.js — 接收端的本地进度页（只监听回环）。
//
// 与发送端（host.js）的页面共用 renderPage，差别只有三点：
//   · 只绑 127.0.0.1 —— 接收端没有什么需要别人看的，暴露到局域网只是多一个攻击面；
//   · 没有 /pair、/decide —— 确认动作在发送端完成，接收端只负责看进度；
//   · 用固定间隔推送而不是事件驱动 —— 接收端状态变化极频繁（每 256 KB 一次），
//     事件驱动会让去抖动逻辑比定时器更复杂，而 500ms 的延迟对肉眼没有区别。
import http from 'node:http'

import { LAN_PROGRESS_PORT, LAN_PROGRESS_PORT_SPAN } from './constants.js'
import { renderPage } from './page.js'

/** 定时推送的间隔。太快会让浏览器忙于重排，太慢会让进度条看起来卡顿。 */
const PUSH_MS = 500

/**
 * @param {object} options
 * @param {(local:boolean)=>object} options.getState 返回当前快照
 * @param {number} [options.port]
 * @param {string} [options.bind]
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
export async function startProgressServer(options = {}) {
  const getState = options.getState || (() => ({}))
  const bind = String(options.bind || '127.0.0.1')
  const clients = new Set()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let state = {}
      try { state = getState(true) } catch { state = {} }
      const html = renderPage({ role: 'client', local: true, state })
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      })
      res.end(body)
      return
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      res.on('close', () => clients.delete(res))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  // 传输可能持续几分钟，默认 300s 的 requestTimeout 会把 SSE 掐断。
  server.requestTimeout = 0
  server.timeout = 0
  server.headersTimeout = 60_000

  const startPort = Number(options.port) || LAN_PROGRESS_PORT
  let bound = 0
  let lastError = null
  for (let i = 0; i <= LAN_PROGRESS_PORT_SPAN; i++) {
    const candidate = startPort + i
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      const onError = (err) => { lastError = err; resolve(false) }
      server.once('error', onError)
      server.listen(candidate, bind, () => {
        server.off('error', onError)
        resolve(true)
      })
    })
    if (ok) { bound = candidate; break }
    try { server.close() } catch { /* 未监听 */ }
  }
  if (bound === 0) {
    throw new Error('进度页端口 ' + startPort + '–' + (startPort + LAN_PROGRESS_PORT_SPAN)
      + ' 全部被占用：' + (lastError && lastError.message ? lastError.message : '未知原因'))
  }

  let timer = null
  const push = () => {
    // 进度页是「锦上添花」，它出任何问题都不该影响传输本身 —— 所以整体吞异常。
    let state = null
    try { state = getState(true) } catch { return }
    const payload = 'data: ' + JSON.stringify(state) + '\n\n'
    for (const res of clients) {
      try { res.write(payload) } catch { clients.delete(res) }
    }
  }
  timer = setInterval(push, PUSH_MS)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    port: bound,
    url: 'http://127.0.0.1:' + bound + '/',
    close: () => new Promise((resolve) => {
      if (timer !== null) clearInterval(timer)
      for (const res of clients) {
        try { res.end() } catch { /* 已断 */ }
      }
      clients.clear()
      try {
        server.close(() => resolve())
      } catch { resolve() }
      setTimeout(() => {
        try { if (server.closeAllConnections) server.closeAllConnections() } catch { /* 老 Node */ }
        resolve()
      }, 800).unref?.()
    }),
  }
}
