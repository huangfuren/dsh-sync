// lib/tools/apply.js — dshsync_apply：在目标机上执行 bundle 落地。
//
// 这是接收端的主入口。与 apply.ps1 的分工见 lib/apply-engine.js 头注释：
// 脚本负责零依赖兜底，本工具负责脚本做不了的两件事 —— 路径重映射与会话 header 改写。
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { applyBundle, inspectBundle, verifyBundleIntegrity } from '../apply-engine.js'

function humanSize(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 把工具参数里的 mappings 规整成 [{from,to}]。
 * 同时接受数组与 "A=>B,C=>D" 文本两种形式 —— 后者在只改一两处时更好手工输入。
 * dshsync_remap 复用同一份规整（两条命令的 mappings 语义必须一致）。
 * @param {unknown} raw
 * @returns {Array<{from:string,to:string}>}
 */
export function normalizeMappings(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((m) => {
        if (typeof m === 'string') {
          const i = m.indexOf('=>')
          return i > 0 ? { from: m.slice(0, i).trim(), to: m.slice(i + 2).trim() } : null
        }
        if (m !== null && typeof m === 'object') {
          const from = typeof m.from === 'string' ? m.from : (typeof m.oldPrefix === 'string' ? m.oldPrefix : '')
          const to = typeof m.to === 'string' ? m.to : (typeof m.newPrefix === 'string' ? m.newPrefix : '')
          return from && to ? { from, to } : null
        }
        return null
      })
      .filter((x) => x !== null)
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.split(/[;,]/).map((seg) => {
      const i = seg.indexOf('=>')
      return i > 0 ? { from: seg.slice(0, i).trim(), to: seg.slice(i + 2).trim() } : null
    }).filter((x) => x !== null)
  }
  return []
}

export function defineApplyTool(getConfig) {
  return defineTool({
    name: 'dshsync_apply',
    description:
      'On the TARGET machine: apply a dsh-sync bundle so this machine\'s dsh becomes identical to the ' +
      'source machine. Run this AFTER copying the bundle over. It (1) verifies every file\'s sha256 and ' +
      'stops before touching anything if the bundle is damaged, (2) restores settings/credentials ' +
      '(decrypting with credentialPassphrase when they were encrypted), (3) restores profile declarations ' +
      'and vendored link: plugin sources, (4) restores sessions / storages / skills, (5) REWRITES each ' +
      'session header cwd and workspace.json paths according to `mappings`, then re-encodes the session ' +
      'folders, (6) rebuilds symlinks from the recorded link list. Pass dryRun=true first to see the ' +
      'plan without writing. Mappings are ordered prefix rules applied at path-segment boundaries; the ' +
      'same rule set is applied to both session cwd and workspace paths so they stay byte-identical. ' +
      'Session rewriting only touches the first zstd frame — all event frames stay byte-identical, so ' +
      'history cannot be corrupted. ' +
      'REPEAT MIGRATION: if this machine was already migrated once and has been used since, pass merge=true — ' +
      'it compares the bundle against what this machine has now and STOPS BEFORE WRITING while any conflict is ' +
      'unresolved, listing every plugin / workspace record / settings / session that would be replaced. Then run ' +
      'again with `resolutions` giving your choice for each. Plain overwriting (the default) is right for a fresh ' +
      'target and wrong for a used one. ' +
      'REGRET? Every apply leaves a journal in its backup directory — call dshsync_undo to undo this apply ' +
      'as a whole (files changed after the apply are skipped and reported, never clobbered). ' +
      'DIRECTION GUARD: this tool refuses to run when the bundle was exported from THIS machine and the ' +
      'same $DSH_HOME (i.e. you are applying a snapshot back onto the machine that produced it — almost ' +
      'always the two machines got swapped). Pass allowSameMachine=true only for a genuine in-place ' +
      'restore after a reinstall.',
    parameters: {
      bundleDir: { type: 'string', description: 'Path to the bundle directory produced by dshsync_export.' },
      dshHome: { type: 'string', description: 'Target $DSH_HOME. Empty = $DSH_HOME env or ~/.dsh.' },
      mappings: {
        type: 'array',
        description: 'Ordered path prefix mappings, e.g. [{"from":"D:/deepseek","to":"E:/code"}]. '
          + 'Applied in order, first match wins, matching requires a path-segment boundary. '
          + 'Also accepts a "D:/a=>E:/b;D:/c=>E:/d" string.',
      },
      dryRun: { type: 'boolean', description: 'Report what would change without writing anything. Do this first.' },
      credentialPassphrase: { type: 'string', description: 'Same passphrase used at export, when settings/credentials were encrypted.' },
      restoreState: { type: 'boolean', description: 'Restore sessions/storages/skills (default true).' },
      restoreSettings: { type: 'boolean', description: 'Restore settings.yaml (default true).' },
      restoreCredentials: { type: 'boolean', description: 'Restore .credentials.yaml (default true).' },
      rebuildSymlinks: { type: 'boolean', description: 'Rebuild symlinks/junctions from state/links.json (default true).' },
      workspaceRoot: { type: 'string', description: 'Where to place the packaged project directories on THIS machine, e.g. "E:/code". Each workspace lands as <workspaceRoot>/<name>; session cwds, workspace.json paths and external symlinks are then rewritten to match automatically. Omit only when the bundle carries no workspaces.' },
      workspaceMap: { type: 'object', additionalProperties: true, description: 'Per-workspace override of workspaceRoot: {"dsh-chat":"E:/projects/dsh-chat"}. Keys are the workspace names reported by export.' },
      overwriteWorkspaces: { type: 'boolean', description: 'Allow unpacking into an existing non-empty directory (default false — it refuses, because workspaces are too large to back up).' },
      installDeps: { type: 'boolean', description: 'After landing, try to reinstall missing profile dependencies automatically with the host bundled pnpm (default true). On failure (e.g. the running host locks files) a ready-to-run install script is generated and named in the action-required list.' },
      allowSameMachine: { type: 'boolean', description: 'Allow applying a bundle that was exported from this very machine and the same $DSH_HOME. Default false: that pattern almost always means the two machines were swapped. Set true only for an in-place restore after reinstall.' },
      merge: { type: 'boolean', description: 'Second (or later) migration onto a machine that is already in use. Instead of overwriting whatever the target has, compare bundle vs target first and STAY BEFORE WRITING ANYTHING while any conflict is unresolved. Use it when the target machine has been used since the last migration — otherwise overwriting silently drops plugins you installed, workspaces you added and settings you changed there.' },
      resolutions: {
        type: 'object',
        additionalProperties: true,
        description: 'Your decisions for the conflicts reported by merge=true. Shape: { plugins: {"<profile>/<plugin>": "keep-target"|"take-source"}, workspaces: {"<id>": "keep-target"|"take-source"}, settings: "target"|"source", sessions: "skip"|"append-missing"|"prefer-source"|"prefer-target" }. '
          + 'Anything left out stays unresolved and the run stops again — there is no default, because guessing here is how people lose work. '
          + 'sessions is one policy for all sessions (they can number in the hundreds): append-missing only copies log files the target lacks, never rewriting the ones it has.',
      },
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
          workspaceCode: { type: 'string', required: true },
          direction: { type: 'string', required: true },
          links: { type: 'string', required: true },
          errorCount: { type: 'number', required: true },
          warningCount: { type: 'number', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          actionRequired: { type: 'array', required: true, items: { type: 'string' } },
          projcache: { type: 'string', required: true },
          depsInstall: { type: 'string', required: true },
          undo: { type: 'string', required: true },
        nextSteps: { type: 'array', required: true, items: { type: 'string' } },
        mergeConflicts: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        mergePending: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
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

      const bundleDir = String(args.bundleDir || '').trim()
      if (!bundleDir) throw new Error('bundleDir is required')
      const dshHome = String(args.dshHome || cfg.dshHome || '').trim()
      if (!dshHome) throw new Error('cannot resolve target $DSH_HOME: set DSH_HOME env or pass dshHome')
      const mappings = normalizeMappings(args.mappings)
      const dryRun = Boolean(args.dryRun)

      const inspected = inspectBundle(bundleDir)
      if (inspected.manifest === undefined) {
        throw new Error('不是可用的 bundle：' + inspected.problems.join('；'))
      }
      const m = inspected.manifest
      const integrity = await verifyBundleIntegrity(bundleDir)

      log(dryRun ? '🧪 dsh-sync 落地预演（不会写任何文件）' : '🚚 dsh-sync 落地')
      log('')
      log('   bundle: ' + path.resolve(bundleDir))
      log('   目标 $DSH_HOME: ' + dshHome)
      const srcId = m.source && m.source.identity ? m.source.identity : null
      log('   来源机: ' + (m.sourceDshHome || '(未记录)')
        + (srcId ? '（' + (srcId.hostname || '未知主机') + (srcId.user ? '/' + srcId.user : '') + '）' : ''))
      log('   导出时间: ' + m.exportedAt)
      log('   完整性: ' + (integrity.ok ? '✓ sha256 × ' + integrity.checked + ' 全部通过' : '✗ ' + integrity.failures.length + ' 个文件不符'))
      if (m.state) {
        log('   状态层: ' + (m.state.parts || []).map((p) => p.name + '=' + p.files + '文件/' + p.links + '链接').join('  '))
        log('   会话: ' + ((m.state.sessions && m.state.sessions.total) || 0) + ' 个，涉及 '
          + (((m.state.sessions && m.state.sessions.cwdDistinct) || []).length) + ' 个工作区路径')
      } else {
        log('   状态层: ⚠️ bundle 不含（这只会得到「能用的空环境」）')
      }
      log('   路径映射: ' + (mappings.length ? mappings.map((x) => x.from + ' → ' + x.to).join('，') : '(无)'))
      const wsRootShown = String(args.workspaceRoot || cfg.workspaceRoot || '').trim()
      const wsCount = Array.isArray(m.workspaces) ? m.workspaces.length : 0
      if (wsCount > 0) {
        log('   工作区代码: ' + wsCount + ' 个，落位根目录 ' + (wsRootShown || '(未指定 —— 必须传 workspaceRoot)'))
      }
      log('')

      const report = await applyBundle({
        bundleDir,
        dshHome,
        mappings,
        dryRun,
        passphrase: String(args.credentialPassphrase || cfg.credentialPassphrase || '').trim(),
        restoreSettings: args.restoreSettings !== false,
        restoreCredentials: args.restoreCredentials !== false,
        restoreState: args.restoreState !== false,
        rebuildSymlinks: args.rebuildSymlinks !== false,
        workspaceRoot: String(args.workspaceRoot || cfg.workspaceRoot || '').trim(),
        workspaceMap: args.workspaceMap && typeof args.workspaceMap === 'object' ? args.workspaceMap : {},
        overwriteWorkspaces: args.overwriteWorkspaces === true,
        allowSameMachine: args.allowSameMachine === true,
        installDeps: args.installDeps !== false,
        merge: args.merge === true,
        resolutions: args.resolutions && typeof args.resolutions === 'object' ? args.resolutions : null,
        onLog: log,
      })

      // 冲突清单单列一节：混在告警里会看不清「这些是要你拍板的，那些只是告诉你一声」。
      if (report.merge) {
        log('')
        log('── 多次交接：与本机现状的分歧 ──')
        if (report.merge.conflicts.length === 0) {
          log('   没有需要你决定的分歧（' + report.merge.auto.length + ' 项会照常带过来）。')
        } else {
          for (const c of report.merge.conflicts) {
            const mark = c.resolution === null ? '待定' : '已定 ' + c.resolution
            log('   [' + c.kind + '] ' + c.key + '（' + mark + '）')
            log('       本机: ' + c.targetValue)
            log('       bundle: ' + c.sourceValue)
            log('       可选: ' + c.options.join(' / '))
          }
        }
        if (report.merge.sessions && report.merge.sessions.reason) {
          log('   会话: ' + report.merge.sessions.reason
            + (report.merge.sessions.onlyInSource > 0 ? '；源机新增 ' + report.merge.sessions.onlyInSource + ' 个' : '')
            + (report.merge.sessions.onlyInTarget > 0 ? '；本机独有 ' + report.merge.sessions.onlyInTarget + ' 个' : ''))
        }
        if (report.merge.settings && report.merge.settings.reason) {
          log('   设置: ' + report.merge.settings.reason)
        }
      }

      log('')
      if (report.ok) log(dryRun ? '✅ 预演完成，未写入任何文件。确认无误后去掉 dryRun 再跑一次。' : '✅ 落地完成。')
      else log('❌ 有 ' + report.errors.length + ' 个错误，详见下方。')

      // 必办项单列一节、放在错误之前：落地本身成功了，但不做这些 dsh 等于白迁
      //（实测 P1：依赖没重装 → 全部插件「包不可用」；P2：凭据没落地 → 挨个重新登录）。
      if ((report.actionRequired || []).length > 0) {
        log('')
        log('必办（不做 dsh 等于白迁）:')
        for (const a of report.actionRequired) log('  ❗ ' + a)
      }
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
        log('备份: ' + report.backupDir + '（覆盖前的原文件都在这里，需要还原时按相同相对路径拷回）')
      }

      // 「下一步」由 apply-engine 算进 report.nextSteps：卡片上的迁移结果也读同一份，
      // 不在这里另写一套（两套迟早说不一样的话）。
      const nextSteps = Array.isArray(report.nextSteps) ? report.nextSteps : []
      for (const s of nextSteps) log('   · ' + s)

      return {
        ok: Boolean(report.ok),
        dryRun,
        backupDir: report.backupDir || '',
        sessions: report.sessions
          ? `${report.sessions.total} 个会话 / 改写 ${report.sessions.rewritten} / 改名 ${report.sessions.renamed} / 失败 ${report.sessions.failed}`
            + (report.sessions.alreadyMigrated ? ` / 已是迁移后状态跳过 ${report.sessions.alreadyMigrated}` : '')
          : '未处理',
        workspaces: report.workspaces ? `改写 ${report.workspaces.changed} 个工作区路径` : '未处理',
        projcache: report.projcache
          ? `dump ${report.projcache.dump.present ? report.projcache.dump.strings + ' 处' : '不存在'} / `
            + `逐会话记录 ${report.projcache.records.present
              ? report.projcache.records.changed + '/' + report.projcache.records.files + ' 个文件'
              : '不存在'}`
          : '未处理',
        workspaceCode: (report.workspaceTargets || []).length
          ? `${(report.workspaceTargets || []).length} 个工作区 → ${(report.workspaceTargets || []).map((t) => t.destPath).join(', ')}`
          : (report.steps.find((x) => x.step === 'workspaces')
            ? 'bundle 含工作区但未落地（见 errors）'
            : 'bundle 不含工作区代码'),
        links: report.links ? `重建 ${report.links.created} / 跳过 ${report.links.skipped.length} / 失败 ${report.links.failed.length}` : '未处理',
        direction: (() => {
          const d = report.direction
          if (!d || !d.source) return 'bundle 未记录源机身份（0.6.0 之前导出的），无法核对方向'
          const src = `${d.source.hostname}${d.source.user ? '/' + d.source.user : ''}`
          const dst = `${d.target.hostname}${d.target.user ? '/' + d.target.user : ''}`
          return d.sameMachine ? `⚠️ 同机同 DSH_HOME（${src}），按 allowSameMachine=true 继续` : `${src} → ${dst}`
        })(),
        errorCount: report.errors.length,
        warningCount: report.warnings.length,
        errors: report.errors,
        warnings: report.warnings,
        actionRequired: report.actionRequired || [],
        depsInstall: report.depsInstall
          ? (report.depsInstall.attempted
            ? '已尝试自动重装：' + (report.depsInstall.results || []).map((r) => r.profile + '=' + (r.ok ? '成功' : '失败')).join(', ')
              + (report.depsInstall.script ? '；兜底脚本 ' + report.depsInstall.script : '')
            : '未尝试（' + (report.depsInstall.tools && report.depsInstall.tools.pnpmFile ? 'installDeps 关闭' : '未找到宿主 pnpm' ) + '）'
              + (report.depsInstall.script ? '；一键脚本 ' + report.depsInstall.script : ''))
          : '未涉及（无缺失依赖）',
        undo: (() => {
          const u = report.undo
          if (!u) return '无账本（预演不记账）'
          return '账本：' + u.created + ' 新建 / ' + u.overwritten + ' 覆盖 / '
            + u.links + ' 软链 / ' + u.renames + ' 改名'
            + (u.journalPath ? '（已写入备份目录）' : '') + ' —— 反悔用 dshsync_undo'
        })(),
        // merge 的结构化清单：给 AI 一份可以直接照着填 resolutions 的数据，
        // 光靠 log 文本它得重新解析一遍。
        mergeConflicts: (report.merge && report.merge.conflicts ? report.merge.conflicts : []).map((c) => ({
          kind: c.kind,
          key: c.key,
          where: c.where,
          targetValue: c.targetValue,
          sourceValue: c.sourceValue,
          options: c.options,
          resolved: c.resolution !== null ? c.resolution : '',
        })),
        mergePending: (report.merge && report.merge.conflicts ? report.merge.conflicts : [])
          .filter((c) => c.resolution === null)
          .map((c) => ({ kind: c.kind, key: c.key, options: c.options })),
        log: logs.join('\n'),
      }
    },
  })
}
