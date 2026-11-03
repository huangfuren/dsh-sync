// lib/tools/snapshot.js — dshsync_snapshot：给本机 dsh 拍防灾快照。
// 引擎在 lib/snapshot.js；本文件只负责参数与呈现。
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { listSnapshots, takeSnapshot } from '../snapshot.js'
import { writeScripts } from './export.js'

function humanSize(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function defineSnapshotTool(getConfig) {
  return defineTool({
    name: 'dshsync_snapshot',
    description:
      'Take a disaster-recovery snapshot of THIS machine\'s dsh into $DSH_HOME/snapshots/<timestamp>. '
      + 'The snapshot IS a standard dsh-sync bundle (manifest + checksums + apply.ps1 / 一键恢复.bat '
      + 'inside), so it can be restored with dshsync_apply on this machine after a reinstall — or on '
      + 'any machine — without needing dsh-sync to be present. Unlike dshsync_export (which is tuned '
      + 'for machine-to-machine moves and asks the user many questions), a snapshot takes safe '
      + 'defaults: every profile, full state (sessions/storages/skills) AND the workspace project '
      + 'directories included by default, because a snapshot that cannot restore "open a session and '
      + 'see the code" did not do its job. Unchanged files are hardlinked against the newest existing '
      + 'snapshot (per-file sha256 verified before linking), so repeated snapshots cost only the '
      + 'delta in disk space while every snapshot stays self-contained. Old snapshots are pruned '
      + 'automatically (keep, default 5). Run it BEFORE risky operations: updating or uninstalling the '
      + 'desktop app (its uninstaller deletes the whole workspace root), mass plugin changes, or just '
      + 'on a schedule. list=true only enumerates existing snapshots.',
    parameters: {
      dshHome: { type: 'string', description: 'Source $DSH_HOME. Empty = env or ~/.dsh.' },
      list: { type: 'boolean', description: 'Only list existing snapshots (name, time, size) without taking one.' },
      keep: { type: 'number', description: 'How many valid snapshots to keep (default 5). Oldest beyond that are deleted — only directories this tool created are ever touched.' },
      incremental: { type: 'boolean', description: 'Hardlink unchanged files against the newest snapshot (default true). Set false to force a fully independent copy.' },
      includeWorkspaces: { type: 'boolean', description: 'Package the project directories sessions point at (default true — the part a disaster snapshot must not skip).' },
      includeState: { type: 'boolean', description: 'Carry sessions / storages / skills (default true).' },
      includeGit: { type: 'boolean', description: 'Keep .git inside packaged workspaces (default true).' },
      includeCredentials: { type: 'boolean', description: 'Include .credentials.yaml (default false — same rule as export).' },
      credentialPassphrase: { type: 'string', description: '>= 6 chars: encrypt settings + credentials (recommended when credentials are included).' },
      profile: { type: 'string', description: 'Profile to snapshot. "*" (default) = every profile.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          snapshotDir: { type: 'string', required: true },
          baseSnapshot: { type: 'string', required: true },
          files: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
          hardlinked: { type: 'number', required: true },
          savedBytes: { type: 'number', required: true },
          deltaAdded: { type: 'number', required: true },
          deltaChanged: { type: 'number', required: true },
          deltaRemoved: { type: 'number', required: true },
          pruned: { type: 'array', required: true, items: { type: 'string' } },
          warningCount: { type: 'number', required: true },
          nextSteps: { type: 'array', required: true, items: { type: 'string' } },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 600_000,
    async execute(args) {
      const cfg = getConfig()
      const logs = []
      const log = (s) => logs.push(s)

      const dshHome = String(args.dshHome || cfg.dshHome || '').trim()
      if (!dshHome) throw new Error('cannot resolve $DSH_HOME: set DSH_HOME env or pass dshHome')

      if (args.list === true) {
        const all = listSnapshots(dshHome)
        log('🗂 dsh-sync 快照列表（' + dshHome + '）')
        if (all.length === 0) log('   （还没有快照 —— 去掉 list 参数拍第一份）')
        for (const s of all) {
          log('   ' + (s.valid ? '✓' : '⚠️') + ' ' + s.name
            + '  ' + humanSize(s.bytes) + '  ' + s.files + ' 文件'
            + (s.exportedAt ? '  ' + s.exportedAt : '')
            + (s.valid ? '' : '（manifest 或 checksums 缺失，不可作为恢复基线）'))
        }
        return {
          ok: true, snapshotDir: '', baseSnapshot: '', files: 0, bytes: 0,
          hardlinked: 0, savedBytes: 0, deltaAdded: 0, deltaChanged: 0, deltaRemoved: 0,
          pruned: [], warningCount: 0,
          nextSteps: all.length === 0 ? ['去掉 list 参数拍第一份快照'] : [],
          log: logs.join('\n'),
        }
      }

      const keep = Number.isFinite(args.keep) && args.keep >= 1 ? Math.floor(args.keep) : 5
      log('📸 dsh-sync 防灾快照')
      log('')

      const r = await takeSnapshot({
        dshHome,
        incremental: args.incremental !== false,
        keep,
        includeWorkspaces: args.includeWorkspaces !== false,
        includeState: args.includeState !== false,
        includeGit: args.includeGit !== false,
        includeCredentials: args.includeCredentials === true,
        passphrase: String(args.credentialPassphrase || cfg.credentialPassphrase || '').trim(),
        profile: String(args.profile || cfg.profile || '*').trim(),
        onLog: log,
        writeScripts,
      })

      log('')
      log('✅ 快照完成：' + r.snapshotDir)
      log('   规模: ' + humanSize(r.totals.bytes) + ' / ' + r.totals.files + ' 文件'
        + (r.baseSnapshot ? '（其中硬链接复用 ' + r.hardlink.linked + ' 个文件，省 ' + humanSize(r.hardlink.savedBytes) + '）' : '（全量）'))
      if (r.delta) {
        log('   与基线 ' + r.baseSnapshot + ' 相比: 新增 ' + r.delta.added + ' / 变化 ' + r.delta.changed
          + ' / 相同 ' + r.delta.same + ' / 移除 ' + r.delta.removed)
      }
      if (r.pruned.length > 0) log('   已滚动清理: ' + r.pruned.join('、'))
      if (r.warnings.length > 0) {
        log('   告警: ' + r.warnings.length + ' 条')
        for (const w of r.warnings.slice(0, 5)) log('   ⚠️ ' + w.where + ' — ' + w.reason)
      }
      log('')
      log('   快照自带 apply.ps1 / 一键恢复.bat：本机出事时，把它当普通 bundle 恢复即可。')

      return {
        ok: true,
        snapshotDir: r.snapshotDir,
        baseSnapshot: r.baseSnapshot || '',
        files: r.totals.files,
        bytes: r.totals.bytes,
        hardlinked: r.hardlink.linked,
        savedBytes: r.hardlink.savedBytes,
        deltaAdded: r.delta ? r.delta.added : 0,
        deltaChanged: r.delta ? r.delta.changed : 0,
        deltaRemoved: r.delta ? r.delta.removed : 0,
        pruned: r.pruned,
        warningCount: r.warnings.length,
        nextSteps: [
          '重启 dsh / 大改插件 / 卸载宿主之前，先拍一份快照（就是本工具存在的意义）',
          '快照占用见 $DSH_HOME/snapshots/；keep 参数控制保留份数',
        ],
        log: logs.join('\n'),
      }
    },
  })
}
