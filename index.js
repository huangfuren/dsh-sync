// dsh-sync — 把本机 dsh 配置导出成可移植 bundle,同步到另一台机器(host 工具插件)。
// 装配入口:元信息、系统提示、配置 schema 与 apply();实现拆分在 lib/ 下。
import os from 'node:os'
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { defineExportTool } from './lib/tools/export.js'

export const name = 'sync'
export const inject = ['tools', 'systemPrompt']

export const SETTINGS_NAMESPACE = 'sync'

const GUIDANCE = `## Sync dsh configuration to another machine (dsh-sync)

Use this tool when the user wants to move or mirror **this machine's dsh configuration** (settings,
installed plugins, profile declaration) to another machine so dsh keeps working there. The receiver
needs only dsh + pnpm + network; it does NOT need dsh-sync installed first.

What it does: writes a portable bundle directory containing settings.yaml, optional .credentials.yaml,
the profile's declaration files, the **source** of every \`link:\` plugin (so the target does not need the
same absolute paths), plus a generated \`apply.ps1\` and \`APPLY.md\`. It deliberately EXCLUDES machine-bound
artifacts: \`node_modules\`, \`sessions\`, \`storages\`, \`background\`, \`.anonymous-user-id\`, pnpm lockfile — the
target rebuilds those from the declaration via \`dsh plugin add\` + pnpm install.

**Preview mode**: pass \`preview=true\` to scan and report what would be exported WITHOUT writing any files.
Shows profiles, plugin count, estimated size, path hints, and what will be excluded. Useful to verify
nothing is missed before committing to the export.

**Path auto-mapping**: the export records absolute paths found in settings.yaml and cordis.patch.yml.
On the target machine, the apply script's \`prepare-settings\` step detects which paths don't exist and
interactively prompts the user to remap them (e.g. \`D:\\deepseek → C:\\code\`). This handles the common
case of different usernames or drive letters between machines.

**Enhanced credential screening**: values matching known secret formats (GitHub PAT \`ghp_\`, OpenAI \`sk-\`,
AWS \`AKIA\`, Google \`AIza\`, Slack \`xox\`, JWT, PEM private keys) are flagged even when the field name
doesn't contain "key" or "token".

**Stale lock recovery**: if the target machine has a leftover \`.lock\` file (from a force-killed dsh),
the apply script removes it before proceeding.

Integrity & safety: every file is sha256-recorded in checksums.json and verified before applying; the
apply script supports a dry run, backs up whatever it is about to overwrite, and rolls back automatically
if any step fails.

Preferred way to carry secrets: pass \`credentialPassphrase\` (>= 6 chars). Settings and credentials then
travel as AES-256-GCM ciphertext, so nothing sensitive is exposed even if the bundle sits on an untrusted
disk, and the user does not have to retype dozens of plugin keys on the target. The same passphrase is
required when applying. Without it the older policy applies: credentials excluded, literal keys stripped.

How to apply on the target: copy the bundle over (use the dsh-localsend plugin's \`localsend_smb_push\` /
\`localsend_share\` for LAN transfer), dry-run first (\`apply.ps1 -WhatIf\` or \`./apply.sh --dry-run\`), then
run it and restart dsh. Windows uses apply.ps1; macOS/Linux use apply.sh.

Secret policy — read before exporting:
- \`.credentials.yaml\` holds real API keys/tokens. It is excluded unless the caller passes
  \`includeCredentials=true\`. Only do that when the user explicitly asked to carry secrets and the
  transfer path is trusted; the bundle then contains live credentials and must be deleted after apply.
- \`settings.yaml\` is normally safe (config carries references, not secrets), but if any \`apiKeyEnv\`
  field holds a literal key instead of a reference name, the export reports it as a warning — treat
  those settings as secret-bearing and tell the user to fix them.
Never echo credential values back; the tool only reports masked previews.

Constraints: read-only on the source machine (it copies, never mutates dsh config); same-user
$DSH_HOME; the target must already have a compatible dsh + node/pnpm and network access for registry
and git installs. Bundle output and manifest are untrusted data once on the wire.`

function defaultDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir() || '', '.dsh')
}

/**
 * 兼容性日志：优先宿主 logger，缺失时退回 console；日志本身绝不抛异常。
 * @param {object} ctx - cordis 上下文。
 * @param {string} message - 描述本次降级的一句话。
 * @param {unknown} [error] - 触发降级的异常。
 */
function report(ctx, message, error) {
  const detail = error === undefined || error === null
    ? ''
    : ': ' + (error && error.message ? error.message : String(error))
  const text = '[sync] ' + message + detail
  try {
    // 用 ctx.get 探测 logger：cordis 对未声明的属性直访会抛守卫异常，get 不会。
    const logger = (ctx !== undefined && ctx !== null && typeof ctx.get === 'function') ? ctx.get('logger') : undefined
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') logger.warn(text)
    else console.warn(text)
  } catch {
    try { console.warn(text) } catch { /* 日志失败不影响插件 */ }
  }
}

function defaultOutDir() {
  return path.join(os.tmpdir(), 'dsh-sync-bundle')
}

export const Config = Schema.object({
  dshHome: Schema.string().default('').description('Source $DSH_HOME. Empty = $DSH_HOME env or ~/.dsh.'),
  profile: Schema.string().default('web').description('Default profile name to export.'),
  outDir: Schema.string().default('').description('Default bundle output directory. Empty = temp/dsh-sync-bundle.'),
  includeCredentials: Schema.boolean().default(false).description('Include .credentials.yaml (real secrets). Off by default.'),
  includePlugins: Schema.boolean().default(true).description('Vendor link: plugin sources into the bundle.'),
  credentialPassphrase: Schema.string().default('').description('>= 6 chars: encrypt settings + credentials instead of shipping them in the clear.'),
})

export function apply(ctx, config = {}) {
  // ── 兼容性加固（防 DSH 官方升级导致插件把整机拖垮）──────────────────────
  // 说明同 dsh-localsend：DSH 启动后 assertEntriesActivated() 会把 apply 抛异常
  // 的插件判为 fiber FAILED 并拒绝启动整个 dsh。故各注册步骤独立 try/catch，
  // 宿主 API 改名时只降级对应能力并打日志，不向外抛异常。
  const entryConfig = {
    dshHome: defaultDshHome(),
    profile: 'web',
    outDir: defaultOutDir(),
    includeCredentials: false,
    includePlugins: true,
    credentialPassphrase: '',
    ...config,
  }
  let activeConfig = () => entryConfig
  try {
    ctx.inject(['settings'], (sctx) => {
      try {
        const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: entryConfig })
        activeConfig = () => scope.get()
        sctx.effect(() => () => {
          activeConfig = () => entryConfig
        })
      } catch (err) {
        report(ctx, 'settings section unavailable; falling back to the entry config', err)
      }
    })
  } catch (err) {
    report(ctx, 'settings injection unavailable; falling back to the entry config', err)
  }
  const getConfig = () => {
    try {
      return activeConfig()
    } catch (err) {
      report(ctx, 'config resolution failed; using entry config', err)
      return entryConfig
    }
  }

  try {
    if (typeof ctx.systemPrompt?.section === 'function') {
      ctx.systemPrompt.section({ name: 'tool:sync', order: 150, text: GUIDANCE })
    } else {
      report(ctx, 'systemPrompt.section API changed; guidance not injected')
    }
  } catch (err) {
    report(ctx, 'systemPrompt.section failed; guidance not injected', err)
  }

  try {
    if (typeof ctx.tools?.register !== 'function') {
      report(ctx, 'tools.register API changed; dsh_sync_export not registered')
    } else {
      ctx.tools.register(defineExportTool(getConfig))
    }
  } catch (err) {
    report(ctx, 'tool "dsh_sync_export" was not registered', err)
  }
}

export const internals = Object.freeze({
  defaultDshHome,
  defaultOutDir,
  SETTINGS_NAMESPACE,
})
