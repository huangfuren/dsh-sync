// lib/remap-engine.js — 对**已经迁移过/正在使用**的 $DSH_HOME 就地重映射。
//
// 为什么需要这个工具（实测教训 P8）：迁移完成后用户把应用挪进子目录、把工作区从 E 盘
// 挪到 D 盘 —— dsh 全挂，而 dsh-sync 没有任何工具能收拾这个局面（apply 要 bundle，
// bundle 是迁移前的旧路径）。手工修要碰五个落点，漏一处就是宿主整棵服务树拒绝激活。
//
// 落点清单（五处同一套映射口径，缺一不可，全部实测自宿主校验行为）：
//   ① 会话首帧 header.cwd（zstd 帧级改写，事件区字节不动）
//   ② 会话分组目录名 = encodeSessionDir(首帧 cwd)
//   ③ storages/workspace.json 的 record.path（宿主 attach 逐字比较，必须原生形态）
//   ④ session_projcache 两层：单元 dump（identity.cwd）+ 逐会话记录（内嵌日志绝对路径，
//      宿主 assertStoredIdentity 互校，漏了就是 corrupt session log）
//   ⑤ $DSH_HOME 里的软链/junction 目标（skills 指向工作区的那些）
//
// 注册表 / 快捷方式 / 应用安装目录超出本工具范围 —— 那些不属于 dsh 状态，
// nextSteps 里明确提示。
//
// 与 apply 的关系：apply 是「源机快照 → 目标机」（有 bundle、有方向守卫、有回执）；
// remap 是「本机现状 → 新路径」（无 bundle、就地改写、需要显式 mappings）。共享
// session-migrate / projcache / path-map 的全部引擎，映射口径完全一致。
import fs from 'node:fs'
import path from 'node:path'

import { createBackupDir } from './apply-engine.js'
import { remapProjCache } from './projcache.js'
import { scanLinks } from './link-scan.js'
import { scanSessions, planSessionMigration, applySessionPlan, remapWorkspacePaths } from './session-migrate.js'
import { validateMappings, applyMappings } from './path-map.js'
import { zstdAvailable } from './zstd-frame.js'

/**
 * 把现有文件复制进备份目录（保留相对路径）。与 apply-engine 内部那份同口径 ——
 * 那份不导出（它依赖同文件的私有上下文），这里保留一份最小实现。
 */
function backupIfExists(abs, dshHome, backupDir) {
  if (!fs.existsSync(abs)) return null
  const rel = path.relative(dshHome, abs)
  const dest = path.join(backupDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(abs, dest)
  return rel
}

/** 判断一个路径是否是悬空软链（existsSync 对悬空链接返回 false，需要 lstat）。 */
function isDanglingLink(abs) {
  try {
    return fs.lstatSync(abs).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 就地重映射一个 $DSH_HOME。
 * @param {object} o
 * @param {string} o.dshHome 要重映射的 $DSH_HOME
 * @param {Array<{from:string,to:string}>} o.mappings 新的路径映射（必填，显式给出）
 * @param {boolean} [o.dryRun]
 * @param {(line:string)=>void} [o.onLog]
 */
export async function remapHome({ dshHome, mappings = [], dryRun = false, onLog } = {}) {
  const log = (s) => onLog && onLog(s)
  const report = {
    dshHome, dryRun, ok: false,
    errors: [], warnings: [], backupDir: null, nextSteps: [],
    sessions: null, workspaces: null, projcache: null, links: null,
  }

  // remap 的一切都由 mappings 驱动；空映射等于「什么都不改」，那不是预演是误会 ——
  // 显式拒绝并提示从 dshsync_verify 或导出预览里拿候选前缀。
  if (!Array.isArray(mappings) || mappings.length === 0) {
    report.errors.push('remap 需要显式 mappings（它是为「迁移后目录又动了」准备的，改哪里必须由你决定）')
    return report
  }
  for (const i of validateMappings(mappings)) {
    if (i.level === 'error') report.errors.push('[映射] ' + i.message)
    else report.warnings.push('[映射] ' + i.message)
  }
  if (report.errors.length > 0) return report
  if (!fs.existsSync(dshHome)) {
    report.errors.push('目录不存在：' + dshHome)
    return report
  }

  // 会话改写需要 zstd；没有就只做 workspace.json / projcache / 软链并如实说明
  if (!zstdAvailable()) {
    report.warnings.push('当前 node 不含内建 zstd（需 22.15+ / 24+）：会话首帧与分组目录名不会改写，'
      + '宿主将按旧身份找不到会话。请用宿主自带的 node 运行本工具')
  }

  if (!dryRun) {
    try {
      report.backupDir = createBackupDir(dshHome)
      log('备份目录：' + report.backupDir)
    } catch (err) {
      report.errors.push('无法创建备份目录，已停止：' + (err && err.message))
      return report
    }
  }
  const before = (abs) => {
    if (dryRun || report.backupDir === null) return
    try { backupIfExists(abs, dshHome, report.backupDir) } catch { /* 备份失败不阻断 */ }
  }

  // ── ①② 会话首帧 + 分组目录名 ────────────────────────────────────────────
  const scan = await scanSessions(dshHome)
  for (const p of scan.problems.filter((x) => x.level === 'error')) report.errors.push('[会话] ' + p.message)
  const plan = planSessionMigration(scan, mappings)
  for (const c of plan.conflicts) {
    if (c.level === 'error') report.errors.push('[会话] ' + c.message)
    else report.warnings.push('[会话] ' + c.message)
  }
  if (zstdAvailable()) {
    const applied = await applySessionPlan(plan, { root: path.join(dshHome, 'sessions'), dryRun, onLog: log })
    report.sessions = {
      total: scan.sessions.length,
      rewritten: applied.groups.reduce((s, g) => s + g.rewritten, 0),
      renamed: applied.renamed,
      failed: applied.failed,
    }
    report.okSessions = applied.failed === 0
    log('会话：' + report.sessions.total + ' 个 / 改写 ' + report.sessions.rewritten
      + ' / 分组改名 ' + report.sessions.renamed + ' / 失败 ' + report.sessions.failed)
    if (report.sessions.total > report.sessions.rewritten) {
      log('   · 其余 ' + (report.sessions.total - report.sessions.rewritten) + ' 个会话的 cwd 未命中映射，保持原值')
    }
  } else {
    report.sessions = { total: scan.sessions.length, rewritten: 0, renamed: 0, failed: 0 }
    report.okSessions = false
  }

  // ── ③ workspace.json ────────────────────────────────────────────────────
  const wsPath = path.join(dshHome, 'storages', 'workspace.json')
  if (fs.existsSync(wsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
      const re = remapWorkspacePaths(raw, mappings)
      if (re.changes.length > 0 && !dryRun) {
        before(wsPath)
        fs.writeFileSync(wsPath, JSON.stringify(re.json, null, 2) + '\n', 'utf8')
      }
      report.workspaces = { changed: re.changes.length, changes: re.changes }
      log('workspace.json：改写 ' + re.changes.length + ' 个工作区路径')
    } catch (err) {
      report.errors.push('workspace.json 处理失败：' + (err && err.message))
    }
  } else {
    report.warnings.push('没有 storages/workspace.json —— 没有工作区记录可改')
  }

  // ── ④ session_projcache 两层 ────────────────────────────────────────────
  // 就地 remap：记录里嵌的就是本机当前路径，source === target home；分组改名由 plan 提供。
  const proj = remapProjCache(dshHome, {
    mappings,
    sessionMoves: plan.groups.map((g) => ({ fromDir: g.fromDir, toDir: g.toDir })),
    sourceSessionsHome: dshHome,
    targetSessionsHome: dshHome,
    dryRun,
    before,
  })
  report.projcache = proj
  log('session_projcache：dump ' + (proj.dump.present ? proj.dump.strings + ' 处路径' : '不存在')
    + '，逐会话记录 ' + (proj.records.present
      ? proj.records.changed + '/' + proj.records.files + ' 个文件改写 ' + proj.records.strings + ' 处路径'
      : '不存在'))

  // ── ⑤ 软链 / junction 目标 ──────────────────────────────────────────────
  const links = { remapped: 0, skipped: [], failed: [] }
  if (dryRun) {
    // 预演也要给出结论：扫描当前链接，看哪些会被映射改写
    const scanned = scanLinks(dshHome)
    for (const l of scanned.links) {
      if (l.target === null) continue
      const hit = applyMappings(l.target, mappings)
      if (hit !== null) links.remapped += 1
    }
  } else {
    const scanned = scanLinks(dshHome)
    for (const l of scanned.links) {
      if (l.target === null) continue
      const hit = applyMappings(l.target, mappings)
      if (hit === null) continue
      if (!fs.existsSync(hit.path)) {
        links.skipped.push({ rel: l.rel, target: hit.path, reason: '映射后目标不存在，不动（改了就是断链）' })
        continue
      }
      try {
        if (fs.existsSync(l.abs) || isDanglingLinkErrSafe(l.abs)) fs.unlinkSync(l.abs)
        fs.symlinkSync(hit.path, l.abs, process.platform === 'win32' ? 'junction' : 'dir')
        links.remapped += 1
        log('  ✓ 链接 ' + l.rel + ' → ' + hit.path)
      } catch (err) {
        links.failed.push({ rel: l.rel, target: hit.path, reason: (err && err.message) || String(err) })
      }
    }
    if (links.failed.length > 0) report.errors.push(links.failed.length + ' 个链接重建失败')
  }
  report.links = links
  log('软链：改指 ' + links.remapped + ' 个'
    + (links.skipped.length ? '，跳过 ' + links.skipped.length + ' 个（映射后目标不存在）' : ''))

  report.errorCount = report.errors.length
  report.ok = report.errorCount === 0
  report.nextSteps = buildRemapNextSteps(report, dryRun)
  return report
}

function buildRemapNextSteps(report, dryRun) {
  const steps = []
  if (dryRun) {
    steps.push('确认预演结果后，用 dryRun=false 真正执行')
    return steps
  }
  if (!report.ok) {
    steps.push('按上方错误逐项处理后重跑（remap 是幂等的：已改到位的部分再跑一遍结果不变）')
    if (report.backupDir) steps.push('如需还原，从备份目录按相对路径拷回：' + report.backupDir)
    return steps
  }
  steps.push('重启 dsh（桌面版从托盘完全退出）—— 会话身份、工作区挂载都是启动时校验的')
  steps.push('若宿主应用本体也挪了位置：注册表 / 快捷方式 / 开机自启不在本工具范围内，需自行同步')
  steps.push('用 dshsync_verify 再核对一遍一致性（关注 I3 / I5 / I14）')
  if (report.backupDir) steps.push('确认一切正常后删除备份目录：' + report.backupDir)
  return steps
}
