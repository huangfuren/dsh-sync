// lib/tools/remap.js — dshsync_remap：迁移完成后目录又动了，就地重映射本机 $DSH_HOME。
//
// 典型场景（实测 P8）：迁移成功后用户把工作区从 E 盘挪到 D 盘、或把项目挪进子目录 ——
// dsh 全挂，而 apply 需要 bundle（那是迁移前的旧路径）帮不上忙。本工具对**本机现状**
// 就地改写五个落点：会话首帧 cwd → 分组目录名 → workspace.json → session_projcache
// 两层 → 软链目标。五处共用同一套映射口径（lib/path-map.js）。
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { remapHome } from '../remap-engine.js'
import { normalizeMappings } from './apply.js'

export function defineRemapTool(getConfig) {
  return defineTool({
    name: 'dshsync_remap',
    description:
      'IN-PLACE path remap of an ALREADY-MIGRATED (or any) $DSH_HOME on THIS machine — for when the ' +
      'migration finished fine but the directories moved afterwards (workspaces moved to another drive, ' +
      'projects moved into a subfolder). Rewrites all five identity sites with ONE mapping rule set: ' +
      'session header cwd, session group dir names, workspace.json record paths, session_projcache ' +
      '(both the unit dump and the per-session records whose embedded absolute log paths the host ' +
      'cross-checks against the logs), and symlink/junction targets. Pass dryRun=true first. ' +
      'This is NOT a substitute for dshsync_apply (no bundle involved, nothing is copied — it only ' +
      'rewrites paths of what already exists). Mappings are required and explicit: ' +
      '[{"from":"E:/code","to":"D:/work"}]. Registry entries / shortcuts / the app install location ' +
      'are outside its scope and reported as manual steps.',
    parameters: {
      dshHome: { type: 'string', description: 'The $DSH_HOME to remap in place. Empty = $DSH_HOME env or ~/.dsh.' },
      mappings: {
        type: 'array',
        description: 'Ordered path prefix mappings describing WHERE THINGS WENT, e.g. [{"from":"E:/code","to":"D:/work"}]. '
          + 'Applied in order, first match wins, matching at path-segment boundaries; matching is slash/case-insensitive, '
          + 'output is written in the platform-native form (the host compares record paths verbatim). '
          + 'Also accepts a "E:/a=>D:/b;E:/c=>D:/d" string.',
      },
      dryRun: { type: 'boolean', description: 'Report what would change without writing anything. Do this first.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          backupDir: { type: 'string', required: true },
          sessions: { type: 'string', required: true },
          workspaces: { type: 'string', required: true },
          projcache: { type: 'string', required: true },
          links: { type: 'string', required: true },
          errorCount: { type: 'number', required: true },
          warningCount: { type: 'number', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
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
      const mappings = normalizeMappings(args.mappings)
      const dryRun = Boolean(args.dryRun)

      log(dryRun ? '🧪 dsh-sync 就地重映射预演（不会写任何文件）' : '🛠️ dsh-sync 就地重映射')
      log('')
      log('   $DSH_HOME: ' + dshHome)
      log('   映射: ' + (mappings.length ? mappings.map((x) => x.from + ' → ' + x.to).join('，') : '(无 —— 必须显式给出)'))
      log('')

      const report = await remapHome({ dshHome, mappings, dryRun, onLog: log })

      log('')
      if (report.ok) log(dryRun ? '✅ 预演完成，未写入任何文件。确认无误后去掉 dryRun 再跑一次。' : '✅ 重映射完成。')
      else log('❌ 有 ' + report.errors.length + ' 个错误，详见下方。')
      if (report.errors.length > 0) {
        log('')
        log('错误:')
        for (const e of report.errors) log('  ✗ ' + e)
      }
      if (report.warnings.length > 0) {
        log('')
        log('告警:')
        for (const w of report.warnings) log('  ⚠️ ' + w)
      }
      if (report.backupDir) {
        log('')
        log('备份: ' + report.backupDir + '（改写前的原文件按相同相对路径存放）')
      }
      const nextSteps = Array.isArray(report.nextSteps) ? report.nextSteps : []
      for (const s of nextSteps) log('   · ' + s)

      return {
        ok: Boolean(report.ok),
        dryRun,
        backupDir: report.backupDir || '',
        sessions: report.sessions
          ? `${report.sessions.total} 个会话 / 改写 ${report.sessions.rewritten} / 分组改名 ${report.sessions.renamed} / 失败 ${report.sessions.failed}`
          : '未处理',
        workspaces: report.workspaces ? `改写 ${report.workspaces.changed} 个工作区路径` : '未处理',
        projcache: report.projcache
          ? `dump ${report.projcache.dump.present ? report.projcache.dump.strings + ' 处' : '不存在'} / `
            + `逐会话记录 ${report.projcache.records.present
              ? report.projcache.records.changed + '/' + report.projcache.records.files + ' 个文件'
              : '不存在'}`
          : '未处理',
        links: report.links ? `改指 ${report.links.remapped} / 跳过 ${report.links.skipped.length} / 失败 ${report.links.failed.length}` : '未处理',
        errorCount: report.errors.length,
        warningCount: report.warnings.length,
        errors: report.errors,
        warnings: report.warnings,
        nextSteps,
        log: logs.join('\n'),
      }
    },
  })
}
