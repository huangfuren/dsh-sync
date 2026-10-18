// lib/session-migrate.js — 会话历史跨机迁移。
//
// 三层结构：sessions/<编码后的cwd>/<session-id>/session.jsonl.zstd
//
// 原先 dsh-sync 把 sessions 整个排除，理由写的是「目录名编码了工作区绝对路径，搬到新机也读不出来」。
// 这个判断可以推翻：目录名只是**派生**，权威 cwd 在会话首帧 header 里，改得动。
//
// 但改写必须同时满足两个硬约束（缺一个 DSH 就打不开会话）：
//   ① header.cwd 要等于目标机的真实工作区路径；
//   ② 目录名要等于 encode(header.cwd) —— DSH 按 cwd 编码出目录名去查找，两者不一致就找不到。
//   ③ 还要与 storages/workspace.json 的 workspaces[*].path 逐字一致（宿主会校验 realpath(cwd)）。
//
// 编码规则（实测 3/3 命中 workspace.json 的全部工作区）：
//   `:` 丢弃；`\` `/` → `-`；[A-Za-z0-9_.-] 保留；其余字符 → `~XXXX`（UTF-16 码元大写 hex）；
//   整体再包一层 `--`。
// ⚠️ 该编码是**有损**的（`:` `\` `/` `-` 都折叠成 `-`），因此只能正向计算，
//    绝不能从目录名反推 cwd —— 反推必错。权威 cwd 只从 header 读。

import fs from 'node:fs'
import path from 'node:path'

import { applyMappings, normalizePath } from './path-map.js'
import { readSessionHeader, rewriteSessionHeader, zstdAvailable } from './zstd-frame.js'

/**
 * 会话日志文件名。**不止一个**：
 *
 *   session.jsonl.zstd       header 无 version 字段（最早形态）
 *   session.v3.jsonl.zstd    header.version = 3
 *   session.v4.jsonl.zstd    header.version = 4
 *
 * 实测本机 82 个会话目录：v3 45 个、无版本 33 个、v4 25 个，其中 18 个同时存在多份
 * （同一次会话在不同宿主版本下各留下一份，header.cwd 完全一致，仅 version 不同）。
 * 只认 `session.jsonl.zstd` 会让 49 个会话（60%）**照原样搬过去但 cwd 没改** ——
 * 目录名与 header 一起保留源机路径，目标机上等于全部孤立。故按正则收全部变体。
 */
export const SESSION_LOG = 'session.jsonl.zstd'
const SESSION_LOG_RE = /^session(?:\.v\d+)?\.jsonl\.zstd$/

/**
 * 是否是会话日志文件。
 * @param {string} name
 * @returns {boolean}
 */
export function isSessionLogName(name) {
  return typeof name === 'string' && SESSION_LOG_RE.test(name)
}

/**
 * 列出一个会话目录下的全部日志文件（可能 0 个，也可能多个版本并存）。
 * @param {string} sessionDir
 * @returns {string[]} 文件基名，按名称排序保证顺序稳定
 */
export function listSessionLogs(sessionDir) {
  try {
    return fs.readdirSync(sessionDir).filter(isSessionLogName).sort()
  } catch {
    return []
  }
}

/**
 * 把工作区绝对路径编码成会话目录名。
 * @param {string} cwd
 * @returns {string} 形如 --D-deepseek-dsh-chat--
 */
export function encodeSessionDir(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  let out = ''
  for (const ch of cwd) {
    if (ch === ':') continue
    if (ch === '\\' || ch === '/') { out += '-'; continue }
    if (/[A-Za-z0-9_.-]/.test(ch)) { out += ch; continue }
    out += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
  }
  return '--' + out + '--'
}

/**
 * 判断一个目录名是否是 DSH 的会话分组目录（--...-- 形态）。
 * @param {string} name
 * @returns {boolean}
 */
export function isSessionGroupDir(name) {
  return typeof name === 'string' && name.length > 4 && name.startsWith('--') && name.endsWith('--')
}

/**
 * 扫描源机的全部会话。
 *
 * 不信任目录名：每个会话的 cwd 都以 header 为准，并把「目录名与 header 不一致」作为告警报出来
 * —— 这种不一致本身就是宿主曾经异常退出的痕迹，迁移时更不该默默沿用。
 *
 * @param {string} dshHome
 * @param {(line:string)=>void} [onLog]
 * @returns {Promise<{sessions:object[], problems:object[], totalBytes:number}>}
 */
export async function scanSessions(dshHome, onLog) {
  const log = (s) => onLog && onLog(s)
  const root = path.join(dshHome, 'sessions')
  const out = { sessions: [], problems: [], totalBytes: 0 }
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => null)
  if (entries === null) {
    log('没有 sessions 目录，跳过会话迁移')
    return out
  }
  if (!zstdAvailable()) {
    out.problems.push({
      level: 'error',
      item: 'sessions',
      message: '当前 node 不含内建 zstd（需 22.15+ / 24+），无法安全改写会话 header；会话将不迁移',
    })
    return out
  }

  for (const group of entries) {
    if (!group.isDirectory() || !isSessionGroupDir(group.name)) continue
    const groupDir = path.join(root, group.name)
    const ids = await fs.promises.readdir(groupDir, { withFileTypes: true }).catch(() => [])
    for (const idEnt of ids) {
      if (!idEnt.isDirectory()) continue
      const sessionDir = path.join(groupDir, idEnt.name)
      const logNames = (await fs.promises.readdir(sessionDir).catch(() => []))
        .filter(isSessionLogName)
        .sort()
      const logs = []
      for (const name of logNames) {
        const file = path.join(sessionDir, name)
        const stat = await fs.promises.stat(file).catch(() => null)
        if (stat === null || !stat.isFile()) continue
        const read = readSessionHeader(file)
        if (!read.ok) {
          out.problems.push({
            level: 'warn',
            item: 'sessions',
            message: '读不出会话 header（' + read.reason + '），该文件原样复制但无法改写：'
              + path.join(group.name, idEnt.name, name),
          })
        } else if (!read.clean) {
          out.problems.push({
            level: 'warn',
            item: 'sessions',
            message: '帧链未走到文件末尾（可能是撕裂尾帧），拒绝改写以免破坏可自愈文件：'
              + path.join(group.name, idEnt.name, name),
          })
        }
        logs.push({
          name,
          file,
          bytes: stat.size,
          cwd: read.ok && typeof read.header.cwd === 'string' ? read.header.cwd : null,
          frameCount: read.ok ? read.frameCount : null,
          clean: Boolean(read.ok && read.clean),
          header: read.ok ? read.header : null,
          unreadable: read.ok ? null : read.reason,
        })
      }

      if (logs.length === 0) {
        // 目录存在但没有任何版本的日志：可能是建了一半的会话。留痕，不猜。
        out.problems.push({
          level: 'warn',
          item: 'sessions',
          message: '会话目录没有任何会话日志（session[.vN].jsonl.zstd）：' + path.join(group.name, idEnt.name),
        })
        out.sessions.push({
          groupDir: group.name, dirName: idEnt.name, dirPath: sessionDir,
          logs: [], bytes: 0, cwd: null, frameCount: null, clean: false, unreadable: 'no-log',
        })
        continue
      }

      // 多版本并存的会话：header.cwd 必须一致，否则不知道该往哪改 —— 如实报告并按第一份处理
      const cwds = [...new Set(logs.map((l) => l.cwd).filter((c) => c !== null))]
      if (cwds.length > 1) {
        out.problems.push({
          level: 'warn',
          item: 'sessions',
          message: '同一会话的多份日志 cwd 不一致（' + cwds.join(' | ') + '），以第一份为准：'
            + path.join(group.name, idEnt.name),
        })
      }
      const cwd = cwds.length > 0 ? cwds[0] : null
      const expectedDir = cwd === null ? null : encodeSessionDir(cwd)
      if (cwd !== null && expectedDir !== group.name) {
        out.problems.push({
          level: 'warn',
          item: 'sessions',
          message: '目录名与 header.cwd 不一致（' + group.name + ' vs ' + expectedDir + '），以 header 为准',
        })
      }
      const bytes = logs.reduce((sum, l) => sum + l.bytes, 0)
      out.sessions.push({
        groupDir: group.name,
        dirName: idEnt.name,
        dirPath: sessionDir,
        logs,
        bytes,
        cwd,
        frameCount: Math.max(...logs.map((l) => l.frameCount || 0)),
        clean: logs.every((l) => l.clean),
        header: logs[0].header,
      })
      out.totalBytes += bytes
    }
  }
  log('扫描到 ' + out.sessions.length + ' 个会话')
  return out
}

/**
 * 生成迁移计划（纯计算，不落盘）。
 *
 * 粒度是**分组目录**而不是单个会话：DSH 的结构是
 *   sessions/<编码cwd>/<session-id>/session.jsonl.zstd
 * 同一个工作区下的所有会话共享同一个分组目录，因此：
 *   · 一个 workspace 迁移后只需要**一次**目录改名（不是每个会话各改一次）；
 *   · 同一分组内的会话共享同一个 cwd，把它们判成「目标目录名冲突」是错的
 *     （第一版就栽在这里：33 个会话被误报 17 个冲突，实际冲突为 0）。
 *
 * @param {{sessions:object[]}} scan scanSessions 的结果
 * @param {Array<{from:string,to:string}>} mappings 有序路径映射
 * @returns {{groups:object[], sessions:object[], stats:object, conflicts:object[]}}
 */
export function planSessionMigration(scan, mappings) {
  const byGroup = new Map()
  for (const s of scan.sessions) {
    if (!byGroup.has(s.groupDir)) byGroup.set(s.groupDir, [])
    byGroup.get(s.groupDir).push(s)
  }

  const groups = []
  const conflicts = []
  const sessionSteps = []
  const stats = { groups: 0, sessions: 0, logFiles: 0, rewrite: 0, rewriteFiles: 0, rename: 0, keep: 0, blocked: 0 }

  for (const [groupDir, sessions] of byGroup) {
    stats.groups += 1
    stats.sessions += sessions.length
    // 组内 cwd 应当唯一；出现多个说明该目录下混了不同工作区的会话（异常数据，如实报告）
    const distinct = [...new Set(sessions.map((s) => s.cwd).filter((c) => c !== null))]
    const cwd = distinct.length > 0 ? distinct[0] : null
    const groupNote = distinct.length > 1
      ? '同一分组目录下存在 ' + distinct.length + ' 个不同 cwd，以第一个为准：' + distinct.join(' | ')
      : null
    if (groupNote !== null) {
      conflicts.push({ level: 'warn', groupDir, message: groupNote })
    }

    // 先算这一组的映射结果，再逐个会话判定动作 —— 同一组内所有可读日志共用同一个新 cwd
    const hit = cwd === null ? null : applyMappings(cwd, mappings)
    const newCwd = hit === null ? cwd : hit.path
    const toDir = newCwd === null ? groupDir : encodeSessionDir(newCwd)
    const needsRename = newCwd !== null && hit !== null && toDir !== groupDir

    let rewriteSessions = 0
    for (const s of sessions) {
      const logs = s.logs || []
      stats.logFiles += logs.length
      const good = logs.filter((l) => l.cwd !== null && l.clean)
      const bad = logs.filter((l) => l.cwd === null || !l.clean)
      const skipped = bad.map((l) => ({
        name: l.name,
        reason: (l.cwd === null ? 'header 读不出' : '帧链不完整，拒绝改写') + '，原样复制',
      }))

      if (logs.length === 0) {
        stats.blocked += 1
        sessionSteps.push({
          groupDir, dirName: s.dirName, action: 'no-log', cwd: null, newCwd: null,
          logs: [], skipped: [], reason: '会话目录内没有任何会话日志，未处理',
        })
        continue
      }
      if (good.length === 0) {
        stats.blocked += 1
        sessionSteps.push({
          groupDir, dirName: s.dirName, action: 'copy-only', cwd: s.cwd, newCwd: null,
          logs: [], skipped, reason: '没有可改写的日志，整会话原样复制',
        })
        continue
      }
      if (hit === null) {
        stats.keep += 1
        sessionSteps.push({
          groupDir, dirName: s.dirName, action: 'keep', cwd, newCwd: cwd,
          logs: [], skipped,
        })
        continue
      }

      rewriteSessions += 1
      stats.rewrite += 1
      stats.rewriteFiles += good.length
      sessionSteps.push({
        groupDir,
        dirName: s.dirName,
        // partial：同一会话里有部分日志不可改写（只能是多版本并存时出现）
        action: skipped.length === 0 ? 'rewrite' : 'partial',
        cwd,
        newCwd,
        logs: good.map((l) => ({ file: l.file, name: l.name })),
        skipped,
      })
    }

    if (rewriteSessions > 0 && needsRename) stats.rename += 1
    groups.push({
      fromDir: groupDir,
      toDir,
      cwd,
      newCwd,
      needsRename: rewriteSessions > 0 && needsRename,
      sessions: sessions.length,
      rewriteSessions,
      action: cwd === null || hit === null ? 'keep' : (toDir !== groupDir ? 'rewrite-and-rename' : 'rewrite'),
      rule: hit === null ? undefined : hit.rule,
    })
  }

  // 真正的冲突：**两个不同的源分组**映射到同一个目标分组（编码有损，可能发生）
  const targetOwner = new Map()
  for (const g of groups) {
    if (g.cwd === null || g.action === 'keep') continue
    if (targetOwner.has(g.toDir)) {
      const other = targetOwner.get(g.toDir)
      conflicts.push({
        level: 'error',
        groupDir: g.fromDir,
        message: '与 ' + other + ' 映射到同一目标目录 ' + g.toDir + '（编码有损），两者无法共存，需人工决定',
      })
      g.action = 'blocked'
      g.needsRename = false
    } else {
      targetOwner.set(g.toDir, g.fromDir)
    }
  }

  return { groups, sessions: sessionSteps, stats, conflicts }
}

/**
 * 执行迁移计划（分组粒度）。
 *
 * 每组内的写入顺序：**先把该组所有会话的 header 改完，再改名分组目录**。
 * 反过来（先改名再改 header）一旦改 header 失败，磁盘上就留下一个「目录名说新路径、
 * header 说旧路径」的会话 —— 宿主会按新目录名去找、读到旧 cwd，比不改更难排查。
 * 本顺序失败时最坏情况是「header 已改、目录未改名」，两者都能从报告里读出来并重跑修复。
 *
 * 组内有任何一个会话改写失败，就**放弃改名**：留着旧目录名，至少还能被旧 cwd 找到。
 *
 * @param {object} plan planSessionMigration 的结果
 * @param {object} [opts]
 * @param {string} opts.root 会话根目录（即 <dshHome>/sessions），改名时用
 * @param {boolean} [opts.dryRun]
 * @param {(line:string)=>void} [opts.onLog]
 * @returns {Promise<{groups:object[], ok:number, failed:number, renamed:number}>}
 */
export async function applySessionPlan(plan, { root, dryRun = false, onLog } = {}) {
  const log = (s) => onLog && onLog(s)
  const out = []

  for (const g of plan.groups) {
    const record = {
      fromDir: g.fromDir,
      toDir: g.toDir,
      cwd: g.cwd,
      newCwd: g.newCwd,
      sessions: g.sessions,
      action: g.action,
      rewritten: 0,
      files: 0,
      failed: 0,
      renamed: false,
      ok: true,
      reason: null,
    }

    if (g.action === 'keep' && g.cwd === null) {
      record.ok = false
      record.reason = '无可读 header，原样复制'
      out.push(record)
      continue
    }
    if (g.action === 'blocked') {
      record.ok = false
      record.reason = '目标目录名冲突，未处理'
      out.push(record)
      continue
    }
    if (g.action === 'keep') {
      out.push(record)
      continue
    }

    const steps = plan.sessions.filter(
      (s) => s.groupDir === g.fromDir && (s.action === 'rewrite' || s.action === 'partial'),
    )
    const fileCount = steps.reduce((n, s) => n + (s.logs || []).length, 0)
    if (dryRun) {
      log('[dry-run] ' + g.fromDir + ' → ' + g.toDir + '（' + steps.length + ' 个会话 / '
        + fileCount + ' 个日志文件，cwd ' + g.cwd + ' → ' + g.newCwd + '）')
      record.rewritten = steps.length
      record.files = fileCount
      record.dryRun = true
      out.push(record)
      continue
    }

    for (const s of steps) {
      let sessionChanged = false
      for (const lg of s.logs || []) {
        const wr = rewriteSessionHeader(lg.file, { cwd: g.newCwd })
        if (!wr.ok) {
          record.failed += 1
          record.ok = false
          record.reason = '会话 header 改写失败：' + s.dirName + '/' + lg.name + '（' + wr.reason + '）'
          log('失败 ' + record.reason)
          continue
        }
        if (wr.changed) {
          sessionChanged = true
          record.files += 1
        }
      }
      if (sessionChanged) record.rewritten += 1
      if ((s.skipped || []).length > 0) {
        log('未改写 ' + s.dirName + ' 的 ' + s.skipped.length + ' 份日志：' + s.skipped.map((x) => x.name + '（' + x.reason + '）').join('、'))
      }
    }

    if (!g.needsRename) {
      out.push(record)
      continue
    }
    if (record.failed > 0) {
      // 有失败就不改名：宁可整组待在旧目录名下，也不要留下半新半旧的组
      record.reason = (record.reason ? record.reason + '；' : '') + '本组有会话改写失败，已跳过目录改名'
      out.push(record)
      continue
    }

    const fromAbs = root ? path.join(root, g.fromDir) : g.fromDir
    const toAbs = root ? path.join(root, g.toDir) : g.toDir
    const occupied = await fs.promises.stat(toAbs).catch(() => null)
    if (occupied !== null) {
      record.ok = false
      record.reason = '目标分组目录已存在，未覆盖：' + g.toDir
      out.push(record)
      continue
    }
    try {
      await fs.promises.rename(fromAbs, toAbs)
      record.renamed = true
      log('已改名 ' + g.fromDir + ' → ' + g.toDir)
    } catch (err) {
      record.ok = false
      record.reason = 'header 已改写但目录改名失败：' + (err && err.message ? err.message : String(err))
      log('失败 ' + record.reason)
    }
    out.push(record)
  }

  const ok = out.filter((r) => r.ok).length
  const renamed = out.filter((r) => r.renamed).length
  return { groups: out, ok, failed: out.length - ok, renamed }
}

/**
 * 从 workspace.json 里取出全部工作区路径（用于与 session header 交叉核对）。
 * @param {object} workspaceJson
 * @returns {Array<{id:string, path:string, title:string}>}
 */
export function readWorkspacePaths(workspaceJson) {
  const table = workspaceJson && workspaceJson.tables && workspaceJson.tables.workspaces
  if (table === null || typeof table !== 'object') return []
  return Object.entries(table)
    .filter(([, v]) => v && typeof v.path === 'string')
    .map(([id, v]) => ({ id, path: v.path, title: typeof v.title === 'string' ? v.title : '' }))
}

/**
 * 改写 workspace.json 里的工作区路径（返回新对象，不改入参）。
 * @param {object} workspaceJson
 * @param {Array<{from:string,to:string}>} mappings
 * @returns {{json:object, changes:Array<{id:string,from:string,to:string}>}}
 */
export function remapWorkspacePaths(workspaceJson, mappings) {
  const changes = []
  const clone = JSON.parse(JSON.stringify(workspaceJson))
  const table = clone && clone.tables && clone.tables.workspaces
  if (table === null || typeof table !== 'object') return { json: clone, changes }
  for (const [id, v] of Object.entries(table)) {
    if (!v || typeof v.path !== 'string') continue
    const hit = applyMappings(v.path, mappings)
    if (hit === null) continue
    changes.push({ id, from: v.path, to: hit.path })
    v.path = hit.path
  }
  return { json: clone, changes }
}

/**
 * 一致性自检：每个会话 header 的 cwd 必须能编码出它所在的目录名，
 * 且（若该 cwd 出现在 workspace.json 里）必须逐字一致。
 * @param {object[]} sessions scanSessions 的 sessions
 * @param {object} workspaceJson
 * @returns {object[]} 问题清单
 */
export function auditConsistency(sessions, workspaceJson) {
  const issues = []
  const wsPaths = new Set(readWorkspacePaths(workspaceJson).map((w) => normalizePath(w.path)))
  for (const s of sessions) {
    if (s.cwd === null) continue
    const enc = encodeSessionDir(s.cwd)
    if (enc !== s.groupDir) {
      issues.push({ level: 'error', message: 'cwd 编码与所在目录名不符：' + s.dirName + '（应为 ' + enc + '）' })
    }
    if (!wsPaths.has(normalizePath(s.cwd))) {
      issues.push({ level: 'warn', message: 'cwd 未登记在 workspace.json，会话可能显示为孤立：' + s.cwd })
    }
  }
  return issues
}
