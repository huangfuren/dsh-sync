// lib/lan/client.js — 接收端：配对、等确认、拉流落地、可选接着 apply + verify。
//
// 这里最容易被做错的三件事，都写在代码旁边：
//   ① **路径穿越**。帧里的 path 是**对端给的**，`../../.ssh/authorized_keys` 这种完全合法地
//      出现在一个普通字符串里。所以每个路径都要 resolve 后确认仍在 destDir 之内（safeRelPath）。
//   ② **先写临时文件再改名**。直接在目标文件名上写，中断就留下一个大小对、内容错的文件，
//      而下次续传会因为它「大小合适」而误判成已完成。写 PART_SUFFIX 再 rename 才安全。
//   ③ **落地前逐文件核对哈希**。局域网传输出错的概率不高，但出错的后果是「bundle 看着完整、
//      apply 后状态诡异」。哈希不符就当场停下来，而不是交给 apply 的整包校验去发现。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyBundle } from '../apply-engine.js'
import { sha256File } from '../checksum.js'
import { runVerify } from '../verify-engine.js'
import {
  FRAME, LAN_PROTOCOL_VERSION, LAN_SERVICE_ID, PAIR_LONGPOLL_MS, PAIR_WAIT_MS,
  PART_SUFFIX, TRANSFER_IDLE_TIMEOUT_MS,
} from './constants.js'
import { readFrames } from './frame.js'
import { openStream, requestJson } from './net.js'
import { createProgress, formatBytes, formatDuration } from './progress.js'

/**
 * 把对端给的相对路径变成 destDir 内的绝对路径，越界一律抛错。
 *
 * 只靠 `!rel.startsWith('..')` 是不够的：Windows 上 `C:` 开头的路径、UNC（`//server/share`）、
 * 以及 `a/../../b` 这类绕路都要挡。做法是 resolve 之后用 path.relative 反向确认，
 * 这一步与平台相关语义（大小写、分隔符、盘符）天然一致，不会像字符串比较那样在别的平台上失效。
 */
export function safeRelPath(destDir, rel) {
  const raw = String(rel === undefined || rel === null ? '' : rel)
  if (raw === '') throw new Error('帧里的文件路径是空的')
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new Error('拒绝绝对路径：' + raw)
  }
  const parts = unified.split('/')
  if (parts.some((p) => p === '..' || p === '' || p === '.')) {
    throw new Error('拒绝含空段或 .. 的路径：' + raw)
  }
  const root = path.resolve(destDir)
  const abs = path.resolve(root, ...parts)
  const back = path.relative(root, abs)
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error('路径越出目标目录：' + raw)
  }
  return abs
}

/** destDir 存在且非空（只看这一层，不递归 —— 递归在几万文件时很慢且没必要）。 */
export function isNonEmptyDir(dir) {
  try {
    const entries = fs.readdirSync(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

function defaultDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir() || '', '.dsh')
}

/**
 * 扫一遍 destDir，找出「已经有且哈希与清单一致」的文件，作为续传的跳过集。
 *
 * 为什么按哈希而不是按「大小一致」：大小一致但内容错的文件，跳过它等于把错误固化下来，
 * 而 apply 时整包校验会失败，用户看到的是「传完了但落地说 bundle 损坏」—— 最难查的一种。
 * 全量算一次 sha256 在 22 MB 上是几十毫秒，在 3 GB 上是十几秒，都比这个后果便宜。
 */
export async function scanExisting(destDir, entries, onLog) {
  const skip = new Set()
  let bytes = 0
  for (const [rel, expected] of Object.entries(entries || {})) {
    let abs
    try {
      abs = safeRelPath(destDir, rel)
    } catch {
      continue   // 清单里本来就有越界路径：不采信、也不因此中断（落地时会被 apply 拦下）
    }
    let st = null
    try {
      st = await fs.promises.stat(abs)
    } catch { st = null }
    if (st === null || !st.isFile()) continue
    if (!expected) continue
    // eslint-disable-next-line no-await-in-loop
    const actual = await sha256File(abs)
    if (actual === expected) {
      skip.add(rel)
      bytes += st.size
    }
  }
  if (skip.size > 0 && onLog) {
    onLog('↻ 目标目录已有 ' + skip.size + ' 个文件与清单一致（' + formatBytes(bytes) + '），将跳过')
  }
  return { skip, bytes }
}

/**
 * 从一个已经启动的发送端拉取 bundle 并落地。
 *
 * @param {object} options
 * @param {string} options.host 发送端地址
 * @param {number} [options.port]
 * @param {string} options.code 6 位配对码
 * @param {string} options.destDir bundle 落到哪个目录（会创建）
 * @param {string} [options.dshHome]
 * @param {string} [options.workspaceRoot]
 * @param {object} [options.workspaceMap]
 * @param {boolean} [options.autoApply] 传完是否自动落地（默认 true）
 * @param {boolean} [options.autoVerify] 落地后是否自动核验（默认 true）
 * @param {boolean} [options.overwrite] destDir 非空时是否继续（默认 false）
 * @param {boolean} [options.allowSameMachine] 传给 apply 的同机放行开关
 * @param {string} [options.passphrase] bundle 里 settings/凭据加密时的解密口令（只进内存，绝不落日志）
 * @param {boolean} [options.installDeps] 落地后尝试自动重装缺失依赖（默认 true；失败回落到安装脚本）
 * @param {boolean} [options.skipScan] 跳过续传扫描（默认 false）
 * @param {object} [options.progress]
 * @param {(line:string)=>void} [options.onLog]
 * @param {AbortSignal} [options.signal]
 */
export async function pullBundle(options = {}) {
  const log = options.onLog || (() => {})
  const progress = options.progress || createProgress()
  const errors = []
  const startedAt = Date.now()

  const host = String(options.host || '').trim()
  const port = Number(options.port) || 38473
  const code = String(options.code || '').trim()
  const destDir = path.resolve(String(options.destDir || ''))
  const dshHome = String(options.dshHome || defaultDshHome())
  const autoApply = options.autoApply !== false
  const autoVerify = options.autoVerify !== false
  const passphrase = String(options.passphrase || '')
  const installDeps = options.installDeps !== false
  const signal = options.signal

  const report = {
    ok: false,
    host, port, destDir, dshHome,
    received: null,
    apply: null,
    verify: null,
    errors,
    durationMs: 0,
  }

  const fail = (message) => {
    errors.push(message)
    progress.setPhase('failed', message)
    log('✗ ' + message)
    report.durationMs = Date.now() - startedAt
    return report
  }

  try {
    if (code === '') return fail('缺少配对码：在发送端的进度页上能看到 6 位数字')
    if (destDir === '' || destDir === path.parse(destDir).root) {
      return fail('destDir 不合法：要给一个具体的目录，不能是盘符根')
    }
    // bundle 落在 $DSH_HOME 里会污染状态目录（且下次导出会把它当成状态的一部分）。
    const relToHome = path.relative(path.resolve(dshHome), destDir)
    if (relToHome === '' || (!relToHome.startsWith('..') && !path.isAbsolute(relToHome))) {
      return fail('destDir 不能放在 $DSH_HOME 里面（' + dshHome + '）：bundle 是搬运用的中间产物，'
        + '放进去会混进下次导出的状态层。换一个普通目录，例如 D:/dsh-bundle')
    }

    // ── ① 连上并确认对面是 dsh-sync ──────────────────────────────────────
    progress.setPhase('pairing', '正在连接发送端')
    log('→ 连接 ' + host + ':' + port)
    let info
    try {
      info = await requestJson({ host, port, method: 'GET', path: '/info', timeoutMs: 4000, signal })
    } catch (err) {
      return fail('连不上 ' + host + ':' + port + '（' + (err && err.message ? err.message : String(err)) + '）。'
        + '检查：两台机器在同一局域网？发送端 dshsync_lan_host 还在跑？Windows 防火墙是否放行了 '
        + port + ' 端口入站？')
    }
    if (info.status !== 200 || !info.json || info.json.service !== LAN_SERVICE_ID) {
      return fail(host + ':' + port + ' 上不是 dsh-sync 发送端'
        + '（HTTP ' + info.status + (info.text ? '：' + info.text.slice(0, 120) : '') + '）')
    }
    if (Number(info.json.proto) > LAN_PROTOCOL_VERSION) {
      return fail('对端协议版本 ' + info.json.proto + ' 比本机 ' + LAN_PROTOCOL_VERSION
        + ' 新：两台机器的 dsh-sync 版本不一致，先把插件升到同一版本')
    }
    const bundleInfo = info.json.bundle || { files: 0, bytes: 0 }
    progress.setTotals({ files: bundleInfo.files, bytes: bundleInfo.bytes })
    log('✓ 找到发送端：' + (info.json.alias || info.json.hostname || host)
      + '（' + bundleInfo.files + ' 个文件 / ' + formatBytes(bundleInfo.bytes) + '）')

    // ── ② 目标目录 ────────────────────────────────────────────────────────
    if (fs.existsSync(destDir) && isNonEmptyDir(destDir) && options.overwrite !== true) {
      // 先算一遍能不能续传，再决定要不要拒绝 —— 中断后重跑是最常见的情形，
      // 如果一律拒绝覆盖，用户就得手动删目录，而删掉的是已经传好的几 GB。
      const existing = await probeResume(destDir)
      if (existing === 0) {
        return fail('目标目录已存在且非空，里面没有可续传的 bundle 文件：' + destDir
          + '。换一个目录，或传 overwrite=true 让它在现有内容上继续写')
      }
      log('↻ 目标目录非空但有 ' + existing + ' 个可续传文件，按续传处理')
    }
    await fs.promises.mkdir(destDir, { recursive: true })

    // ── ③ 配对 ────────────────────────────────────────────────────────────
    progress.setPhase('pairing', '正在配对')
    const pairRes = await requestJson({
      host, port, method: 'POST', path: '/pair', timeoutMs: 15_000, signal,
      json: {
        code,
        client: {
          alias: safeHostname(),
          hostname: safeHostname(),
          version: String(LAN_PROTOCOL_VERSION),
        },
      },
    })
    if (pairRes.status !== 200 || !pairRes.json || pairRes.json.ok !== true) {
      const reason = (pairRes.json && pairRes.json.error) || ('HTTP ' + pairRes.status)
      return fail('配对失败：' + reason)
    }
    const sessionId = pairRes.json.sessionId
    log('✓ 配对码通过，等待发送端确认（对方页面上点「接受」）')

    // ── ④ 等对方在本机点接受 ──────────────────────────────────────────────
    progress.setPhase('waiting', '等待对方在本机点「接受」')
    let token = ''
    const deadline = Date.now() + PAIR_WAIT_MS
    while (Date.now() < deadline) {
      if (signal && signal.aborted) return fail('已取消')
      // eslint-disable-next-line no-await-in-loop
      const wait = await requestJson({
        host, port, method: 'GET',
        path: '/wait?sessionId=' + encodeURIComponent(sessionId) + '&timeout=' + PAIR_LONGPOLL_MS,
        timeoutMs: PAIR_LONGPOLL_MS + 10_000,
        signal,
      })
      const status = wait.json && wait.json.status
      if (status === 'accepted') {
        token = String((wait.json && wait.json.token) || '')
        break
      }
      if (status === 'denied') return fail('发送端拒绝了这次传输')
      // pending：继续等，直到总体超时
    }
    if (token === '') return fail('等待对方确认超过 ' + Math.round(PAIR_WAIT_MS / 60000) + ' 分钟，已放弃')
    log('✓ 对方已接受，开始接收')

    // ── ⑤ 续传扫描 + 拉流 ─────────────────────────────────────────────────
    let skip = new Set()
    if (options.skipScan !== true && isNonEmptyDir(destDir)) {
      // 用**服务端的权威清单**判断哪些文件已经有了。用本地那份 checksums.json 不够：
      // 上次可能传到一半就断了，本地那份里列着一批根本没写全的文件，
      // 按它跳过会把「没传完」当成「已完成」。
      let entries = null
      try {
        const r = await requestJson({
          host, port, method: 'GET',
          path: '/entries?sessionId=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token),
          timeoutMs: 20_000, signal,
        })
        if (r.status === 200 && r.json && r.json.entries) entries = r.json.entries
      } catch { entries = null }
      if (entries === null) {
        log('⚠️ 拿不到发送端的文件清单，只能用本地那份判断续传（可能重复传一部分）')
        entries = await readLocalEntries(destDir)
      }
      const scanned = await scanExisting(destDir, entries, log)
      skip = scanned.skip
    }

    progress.setPhase('transferring', '正在接收')
    const body = Buffer.from(JSON.stringify({ sessionId, token, skip: Array.from(skip) }), 'utf8')
    const { res, req } = await openStream({
      host, port, method: 'POST', path: '/stream',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
      body,
      timeoutMs: TRANSFER_IDLE_TIMEOUT_MS,
      signal,
    })

    if (res.statusCode !== 200) {
      const chunks = []
      for await (const c of res) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8')
      req.destroy()
      let detail = text.slice(0, 240)
      try { detail = JSON.parse(text).error || detail } catch { /* 非 JSON */ }
      return fail('发送端拒绝了拉取（HTTP ' + res.statusCode + '）：' + detail)
    }
    // 流读完之前任何 error 都要有人接，否则 Node 会把它当成未捕获异常。
    res.on('error', () => {})
    const headerFiles = Number(res.headers['x-dshsync-files'])
    const headerBytes = Number(res.headers['x-dshsync-bytes'])
    if (Number.isFinite(headerFiles) && Number.isFinite(headerBytes)) {
      progress.setTotals({ files: headerFiles, bytes: headerBytes })
    }

    let current = null
    let doneFrame = null
    const receivedBytes = { value: 0 }

    try {
      for await (const frame of readFrames(res)) {
        if (frame.type === FRAME.FILE) {
          if (current !== null) throw new Error('上一个文件还没结束就收到了新的 FILE 帧')
          const meta = frame.json || {}
          const abs = safeRelPath(destDir, meta.path)
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.mkdir(path.dirname(abs), { recursive: true })
          const part = abs + PART_SUFFIX
          // eslint-disable-next-line no-await-in-loop
          const fd = await fs.promises.open(part, 'w')
          current = {
            rel: String(meta.path),
            abs,
            part,
            fd,
            hash: crypto.createHash('sha256'),
            expected: String(meta.sha256 || ''),
            size: Number(meta.size) || 0,
            written: 0,
          }
          progress.fileStart(current.rel, current.size)
        } else if (frame.type === FRAME.DATA) {
          if (current === null) throw new Error('没收到 FILE 帧就来了数据帧')
          current.hash.update(frame.payload)
          // eslint-disable-next-line no-await-in-loop
          await current.fd.write(frame.payload)
          current.written += frame.payload.length
          receivedBytes.value += frame.payload.length
          progress.addBytes(frame.payload.length)
        } else if (frame.type === FRAME.FEND) {
          if (current === null) throw new Error('没有进行中的文件却收到了结束帧')
          const actual = current.hash.digest('hex')
          // eslint-disable-next-line no-await-in-loop
          await current.fd.close()
          if (current.expected && actual !== current.expected) {
            // eslint-disable-next-line no-await-in-loop
            await fs.promises.rm(current.part, { force: true })
            throw new Error('文件校验失败：' + current.rel
              + '（期望 ' + current.expected.slice(0, 12) + '…，实收 ' + actual.slice(0, 12) + '…）')
          }
          if (current.size > 0 && current.written !== current.size) {
            // eslint-disable-next-line no-await-in-loop
            await fs.promises.rm(current.part, { force: true })
            throw new Error('文件长度不符：' + current.rel + '（应 ' + current.size + ' B，实收 ' + current.written + ' B）')
          }
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.rename(current.part, current.abs)
          progress.fileDone()
          current = null
        } else if (frame.type === FRAME.DONE) {
          doneFrame = frame.json || {}
        } else if (frame.type === FRAME.ERR) {
          throw new Error('发送端报告错误：' + ((frame.json && frame.json.message) || '未知'))
        }
      }
    } finally {
      // 任何路径退出都要把半成品清掉：留着 .dshsync-part 会让下次续传扫描看到
      // 一个「大小不对」的文件（无害），但堆在目录里会让人误以为落地成功。
      if (current !== null) {
        try { await current.fd.close() } catch { /* 已关 */ }
        try { await fs.promises.rm(current.part, { force: true }) } catch { /* 已删 */ }
      }
      req.destroy()
    }

    progress.finalize()
    report.received = {
      files: progress.snapshot().files.done,
      bytes: receivedBytes.value,
      skipped: skip.size,
      durationMs: Date.now() - startedAt,
      doneFrame,
    }
    log('✓ 接收完成：' + progress.snapshot().files.done + ' 个文件 / ' + formatBytes(receivedBytes.value)
      + ' / 用时 ' + formatDuration(Date.now() - startedAt))

    // ── ⑥ 落地 ────────────────────────────────────────────────────────────
    if (autoApply) {
      progress.setPhase('verifying', '预演落地（不改动任何文件）')
      log('')
      log('━━ 预演落地（dryRun）━━')
      const dry = await applyBundle({
        bundleDir: destDir,
        dshHome,
        dryRun: true,
        passphrase,
        installDeps,
        workspaceRoot: String(options.workspaceRoot || ''),
        workspaceMap: options.workspaceMap && typeof options.workspaceMap === 'object' ? options.workspaceMap : {},
        allowSameMachine: options.allowSameMachine === true,
        // merge 在预演阶段就跑：这样「还有冲突没决定」是在**落地之前**说出来的，
        // 而不是等文件都收完才发现要停下来。bundle 已完整收到，给决议后重跑即可秒过。
        merge: options.merge === true,
        resolutions: options.resolutions && typeof options.resolutions === 'object' ? options.resolutions : null,
        onLog: (line) => log(line),
      })
      report.applyDryRun = { ok: dry.ok, errors: dry.errors.slice(0, 20), merge: dry.merge || null }
      if (!dry.ok) {
        // 预演有错就不真跑：真跑的每一步都会覆写目标机文件，带着已知错误往下走
        // 只会把「能查的问题」变成「要恢复的问题」。
        for (const e of dry.errors) errors.push('[预演] ' + e)
        // merge 的「未决议」也走这条路停下来。此时 bundle 已经完整收到了，
        // 所以必须把冲突清单打出来 —— 否则用户只知道停了，不知道要决定什么。
        if (dry.merge && dry.merge.pending.length > 0) {
          log('')
          log('━━ 多次交接：需要先决定 ' + dry.merge.pending.length + ' 项 ━━')
          for (const c of dry.merge.conflicts) {
            const mark = c.resolution === null ? '待定' : '已定 ' + c.resolution
            log('  · [' + c.kind + '] ' + c.key + '（' + mark + '） 可选：' + c.options.join(' / '))
            log('      本机: ' + c.targetValue)
            log('      bundle: ' + c.sourceValue)
          }
          for (const s of dry.nextSteps || []) log('   → ' + s)
          log('')
          log('bundle 已完整收到（' + destDir + '）。给决议后重跑本命令即可，'
            + '已收到的文件全部跳过，不会重新传输。')
        }
        progress.setPhase('failed', dry.merge && dry.merge.pending.length > 0
          ? '还有冲突未决定，已停在落地之前（bundle 已收到）'
          : '预演发现致命问题，已停止（未改动任何文件）')
        log('✗ 已停止：' + (dry.merge && dry.merge.pending.length > 0
          ? dry.merge.pending.length + ' 项冲突未决定'
          : '预演发现致命问题') + '。bundle 在 ' + destDir)
        report.durationMs = Date.now() - startedAt
        return report
      }

      progress.setPhase('applying', '正在落地')
      log('')
      log('━━ 正式落地 ━━')
      const applied = await applyBundle({
        bundleDir: destDir,
        dshHome,
        dryRun: false,
        passphrase,
        installDeps,
        workspaceRoot: String(options.workspaceRoot || ''),
        workspaceMap: options.workspaceMap && typeof options.workspaceMap === 'object' ? options.workspaceMap : {},
        overwriteWorkspaces: options.overwriteWorkspaces === true,
        allowSameMachine: options.allowSameMachine === true,
        merge: options.merge === true,
        resolutions: options.resolutions && typeof options.resolutions === 'object' ? options.resolutions : null,
        onLog: (line) => log(line),
      })
      report.apply = {
        ok: applied.ok,
        backupDir: applied.backupDir,
        errorCount: applied.errors.length,
        warningCount: applied.warnings.length,
        errors: applied.errors.slice(0, 20),
        warnings: applied.warnings.slice(0, 20),
        sessions: applied.sessions,
        links: applied.links,
        // 必办（依赖 / 凭据）与「接下来」随行：卡片结果区、lan_status、nextStepsOf 读的都是这里
        actionRequired: applied.actionRequired || [],
        depsInstall: applied.depsInstall || null,
        nextSteps: applied.nextSteps || [],
        // 冲突清单要跟着报告走到卡片与 lan_status 上，否则用户看不到「该决定什么」
        merge: applied.merge || null,
      }
      if (!applied.ok) {
        for (const e of applied.errors) errors.push('[落地] ' + e)
      }
      if (applied.merge && applied.merge.conflicts.length > 0 && applied.ok) {
        log('')
        log('━━ 多次交接：与本机现状的分歧（已按决议处理）━━')
        for (const c of applied.merge.conflicts) {
          log('  · [' + c.kind + '] ' + c.key + ' → ' + c.resolution)
        }
      }
    }

    // ── ⑦ 核验 ────────────────────────────────────────────────────────────
    if (autoVerify && autoApply) {
      progress.setPhase('verifying', '正在核验一致性')
      log('')
      log('━━ 一致性核验 ━━')
      const verified = await runVerify(destDir, dshHome, {
        workspaceRoot: String(options.workspaceRoot || ''),
        workspaceMap: options.workspaceMap && typeof options.workspaceMap === 'object' ? options.workspaceMap : {},
      })
      report.verify = {
        ok: verified.ok,
        failed: verified.failed,
        warned: verified.warned,
        checks: verified.checks,
      }
      for (const c of verified.checks) {
        log((c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠️' : '✗') + ' [' + c.id + '] ' + c.title + ' — ' + c.detail)
      }
      if (!verified.ok) errors.push('[核验] ' + verified.failed + ' 项不变量失败')
    }

    report.ok = errors.length === 0
    progress.setPhase(report.ok ? 'done' : 'failed',
      report.ok ? '全部完成' : errors.length + ' 个问题需要处理')
    report.durationMs = Date.now() - startedAt
    log('')
    log((report.ok ? '✅ ' : '⚠️ ') + '完成，用时 ' + formatDuration(report.durationMs))
    return report
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    return fail('中断：' + message)
  }
}

function safeHostname() {
  try { return os.hostname() || 'dsh-sync-client' } catch { return 'dsh-sync-client' }
}

/** 目标目录里是否已经有一份 bundle（用于判断「非空」是续传还是别人的东西）。 */
async function probeResume(destDir) {
  try {
    const checksumPath = path.join(destDir, 'checksums.json')
    const st = await fs.promises.stat(checksumPath)
    return st.isFile() ? 1 : 0
  } catch {
    return 0
  }
}

/** 读目标目录里已有的 checksums.json（续传比对用）。读不到就当没有。 */
async function readLocalEntries(destDir) {
  try {
    const text = await fs.promises.readFile(path.join(destDir, 'checksums.json'), 'utf8')
    const json = JSON.parse(text)
    return json && json.entries && typeof json.entries === 'object' ? json.entries : {}
  } catch {
    return {}
  }
}
