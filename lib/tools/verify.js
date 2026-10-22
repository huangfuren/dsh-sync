// lib/tools/verify.js — dshsync_verify：一致性核对的工具层封装。
// 核对逻辑在 lib/verify-engine.js（无 UI 依赖，可独立测试）；本文件只负责参数与呈现。
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { runVerify } from '../verify-engine.js'

export { runVerify }

export function defineVerifyTool(getConfig) {
  return defineTool({
    name: 'dshsync_verify',
    description:
      'Check whether this machine actually matches the exported bundle — i.e. prove the migration ' +
      'really worked instead of assuming it did. Verifies: bundle sha256 integrity, session count, ' +
      'that every session folder name equals the encoding of its header cwd (DSH looks sessions up ' +
      'by that name), that session containers are structurally intact, that workspace.json paths line ' +
      'up byte-for-byte with session cwds, that symlinks were rebuilt, that vendored plugin sources ' +
      'are present, that profile link: dependencies resolve, that all state parts landed, that the ' +
      'host runtime matches the source (a cross-generation dsh version gap makes the host deny every ' +
      'plugin at startup while all file checks still pass), and that packaged project directories ' +
      'actually landed where sessions now point (pass workspaceRoot to check that one). Each invariant ' +
      'reports PASS / FAIL / WARN with a concrete detail line. Run this after dshsync_apply; a FAIL ' +
      'means dsh would not see that part of the state.',
    parameters: {
      bundleDir: { type: 'string', description: 'Path to the bundle that was applied.' },
      dshHome: { type: 'string', description: 'Target $DSH_HOME. Empty = env or ~/.dsh.' },
      workspaceRoot: { type: 'string', description: 'The workspaceRoot used at apply time. Needed to verify that project directories landed; without it that check reports WARN instead of guessing.' },
      workspaceMap: { type: 'object', additionalProperties: true, description: 'The workspaceMap used at apply time, if any.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          failed: { type: 'number', required: true },
          warned: { type: 'number', required: true },
          summary: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 120_000,
    async execute(args) {
      const cfg = getConfig()
      const bundleDir = String(args.bundleDir || '').trim()
      if (!bundleDir) throw new Error('bundleDir is required')
      const dshHome = String(args.dshHome || cfg.dshHome || '').trim()
      if (!dshHome) throw new Error('cannot resolve $DSH_HOME: set DSH_HOME env or pass dshHome')

      const result = await runVerify(bundleDir, dshHome, {
        workspaceRoot: String(args.workspaceRoot || cfg.workspaceRoot || '').trim(),
        workspaceMap: args.workspaceMap && typeof args.workspaceMap === 'object' ? args.workspaceMap : {},
      })
      const logs = []
      logs.push('🔍 dsh-sync 一致性核对')
      logs.push('   bundle: ' + path.resolve(bundleDir))
      logs.push('   $DSH_HOME: ' + dshHome)
      logs.push('')
      for (const c of result.checks) {
        const mark = c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠️' : '✗'
        logs.push('  ' + mark + ' [' + c.id + '] ' + c.title + ' — ' + c.detail)
      }
      logs.push('')
      const summary = result.ok
        ? (result.warned === 0 ? '全部通过：目标机与源机一致' : '通过，但有 ' + result.warned + ' 项告警需人工确认')
        : result.failed + ' 项失败：这些部分的 dsh 状态与源机不一致'
      logs.push((result.ok ? '✅ ' : '❌ ') + summary)

      return {
        ok: result.ok,
        failed: result.failed,
        warned: result.warned,
        summary,
        log: logs.join('\n'),
      }
    },
  })
}
