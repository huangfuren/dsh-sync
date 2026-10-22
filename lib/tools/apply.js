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
 * @param {unknown} raw
 * @returns {Array<{from:string,to:string}>}
 */
function normalizeMappings(raw) {
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
      'history cannot be corrupted.',
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
      workspaceMap: { type: 'object', description: 'Per-workspace override of workspaceRoot: {"dsh-chat":"E:/projects/dsh-chat"}. Keys are the workspace names reported by export.' },
      overwriteWorkspaces: { type: 'boolean', description: 'Allow unpacking into an existing non-empty directory (default false — it refuses, because workspaces are too large to back up).' },
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
      log('   来源机: ' + (m.sourceDshHome || '(未记录)'))
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
        onLog: log,
      })

      log('')
      if (report.ok) log(dryRun ? '✅ 预演完成，未写入任何文件。确认无误后去掉 dryRun 再跑一次。' : '✅ 落地完成。')
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
        log('备份: ' + report.backupDir + '（覆盖前的原文件都在这里，需要还原时按相同相对路径拷回）')
      }

      const nextSteps = []
      if (dryRun) {
        nextSteps.push('确认预演结果后，用 dryRun=false 真正执行')
      } else if (report.ok) {
        nextSteps.push('重启 dsh（Desktop 端需完全退出后重开）让新配置与新会话生效')
        if (report.backupDir) nextSteps.push('确认一切正常后删除备份目录：' + report.backupDir)
        nextSteps.push('用 dshsync_verify 再核对一遍一致性')
      } else {
        nextSteps.push('按上方错误逐项处理后重跑（已完成的步骤不会重复破坏数据）')
        if (report.backupDir) nextSteps.push('如需还原，从备份目录按相对路径拷回：' + report.backupDir)
      }
      for (const s of nextSteps) log('   · ' + s)

      return {
        ok: Boolean(report.ok),
        dryRun,
        backupDir: report.backupDir || '',
        sessions: report.sessions
          ? `${report.sessions.total} 个会话 / 改写 ${report.sessions.rewritten} / 改名 ${report.sessions.renamed} / 失败 ${report.sessions.failed}`
          : '未处理',
        workspaces: report.workspaces ? `改写 ${report.workspaces.changed} 个工作区路径` : '未处理',
        workspaceCode: (report.workspaceTargets || []).length
          ? `${(report.workspaceTargets || []).length} 个工作区 → ${(report.workspaceTargets || []).map((t) => t.destPath).join(', ')}`
          : (report.steps.find((x) => x.step === 'workspaces')
            ? 'bundle 含工作区但未落地（见 errors）'
            : 'bundle 不含工作区代码'),
        links: report.links ? `重建 ${report.links.created} / 跳过 ${report.links.skipped.length} / 失败 ${report.links.failed.length}` : '未处理',
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
