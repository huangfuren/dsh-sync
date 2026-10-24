// lib/tools/undo.js — dshsync_undo：整体撤销最近一次 dshsync_apply 的导入。
//
// 场景（借鉴 dsh-workspace-migrate 的 scoped undo）：迁移跑完了才发现搞错了目标机、
// 映射给错了、或者单纯不想要 —— 之前唯一的办法是从备份目录手工猜着拷回，而新建的
// 文件（会话 / 插件源码 / state）备份里根本没有。apply 现在把每一笔变动记进账本
// （备份目录里的 journal.json），本工具倒序回放：
//   · 新建的删掉 · 覆盖的从备份还原 · 软链还原旧指向 · 分组目录名改回去
// 落地之后内容变过的文件（典型：已经开始用 dsh，会话追加了新帧）**自动跳过并逐条
// 报告** —— 撤销的边界是「本次 apply 写下的内容」，绝不拿旧快照盖掉用户新产生的数据。
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { findLatestJournalDir, undoBundle } from '../undo.js'

export function defineUndoTool(getConfig) {
  return defineTool({
    name: 'dshsync_undo',
    description:
      'On the TARGET machine: undo the most recent dshsync_apply as a whole — replays the apply journal ' +
      '(recorded in the backup directory) in reverse: files CREATED by the apply are deleted, files it ' +
      'OVERWROTE are restored from the backup copy, rebuilt symlinks are removed or retargeted back, ' +
      'renamed session group dirs are renamed back. Files whose content changed AFTER the apply (you ' +
      'already used dsh on them — e.g. a session got new frames) are deliberately LEFT ALONE and reported ' +
      'one by one, so undo can never destroy newer data with an older snapshot. Pass dryRun=true first. ' +
      'Without arguments it undoes the LATEST apply (located via the apply receipt); pass backupDir to ' +
      'target an older one — refused when the receipt shows a newer apply, undo one layer at a time. ' +
      'The backup directory is kept after undo; deleting it also gives up the ability to undo further. ' +
      'Run dshsync_verify afterwards and fully restart dsh.',
    parameters: {
      dshHome: { type: 'string', description: 'Target $DSH_HOME. Empty = $DSH_HOME env or ~/.dsh.' },
      backupDir: { type: 'string', description: 'Backup directory holding journal.json (the one an apply reported). Empty = the latest apply, found via the receipt.' },
      dryRun: { type: 'boolean', description: 'Report what would be undone without writing anything. Do this first.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          backupDir: { type: 'string', required: true },
          undone: { type: 'string', required: true },
          skipped: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          errorCount: { type: 'number', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          nextSteps: { type: 'array', required: true, items: { type: 'string' } },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 300_000,
    async execute(args) {
      const cfg = getConfig()
      const logs = []
      const log = (s) => logs.push(s)

      const dshHome = String(args.dshHome || cfg.dshHome || '').trim()
      if (!dshHome) throw new Error('cannot resolve $DSH_HOME: set DSH_HOME env or pass dshHome')
      const dryRun = Boolean(args.dryRun)

      const backupDir = String(args.backupDir || '').trim() || findLatestJournalDir(dshHome)
      if (!backupDir) {
        throw new Error('找不到可撤销的落地账本：没有最近的 apply（或备份目录里没有 journal.json）。'
          + '撤销能力从备份目录删除那一刻起就消失了')
      }

      log(dryRun ? '🧪 dsh-sync 撤销预演（不会写任何文件）' : '↩️ dsh-sync 撤销本次导入')
      log('')
      log('   $DSH_HOME: ' + dshHome)
      log('   备份目录（账本所在）: ' + backupDir)
      log('')

      const report = await undoBundle({ dshHome, backupDir, dryRun, onLog: log })

      log('')
      if (report.ok) log(dryRun ? '✅ 预演完成，未写入任何文件。' : '✅ 撤销完成。')
      else log('❌ 有 ' + report.errors.length + ' 个错误，详见下方。')
      if (report.errors.length > 0) {
        log('')
        log('错误:')
        for (const e of report.errors) log('  ✗ ' + e)
      }
      if (report.skipped.length > 0) {
        log('')
        log('跳过（落地之后内容已变，撤销刻意不碰）:')
        for (const s of report.skipped.slice(0, 20)) log('  · ' + s.rel + ' — ' + s.reason)
        if (report.skipped.length > 20) log('  · …另有 ' + (report.skipped.length - 20) + ' 项')
      }
      const nextSteps = Array.isArray(report.nextSteps) ? report.nextSteps : []
      log('')
      for (const s of nextSteps) log('   · ' + s)

      const u = report.undone || {}
      return {
        ok: Boolean(report.ok),
        dryRun,
        backupDir: report.backupDir || backupDir,
        undone: '新建删 ' + (u.created || 0) + ' / 覆盖还原 ' + (u.overwritten || 0)
          + ' / 软链 ' + (u.links || 0) + ' / 改名还原 ' + (u.renames || 0)
          + '；跳过 ' + (report.skipped || []).length,
        skipped: report.skipped || [],
        errorCount: report.errors.length,
        errors: report.errors,
        nextSteps,
        log: logs.join('\n'),
      }
    },
  })
}
