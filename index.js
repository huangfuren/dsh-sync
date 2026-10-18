// dsh-sync — 把本机 dsh 配置导出成可移植 bundle,同步到另一台机器(host 工具插件)。
// 装配入口:元信息、系统提示、配置 schema 与 apply();实现拆分在 lib/ 下。
import os from 'node:os'
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { defineExportTool } from './lib/tools/export.js'
import { defineApplyTool } from './lib/tools/apply.js'
import { defineVerifyTool } from './lib/tools/verify.js'

export const name = 'sync'
export const inject = ['tools', 'systemPrompt']

export const SETTINGS_NAMESPACE = 'sync'

const GUIDANCE = `## Migrate an entire dsh installation between machines (dsh-sync)

Three tools form one pipeline: **export on the source → carry the bundle → apply + verify on the target.**

### What "migrated" means here
Two layers, and you need both:
- **Declaration layer** — settings.yaml, optional credentials, each profile's declaration files, and the
  SOURCE of every \`link:\` plugin. This is what makes the target machine *work*.
- **State layer** — \`sessions/\`, \`storages/\`, \`skills/\`. This is what makes the target machine
  *identical*: same history, same workspace list, same skill links. Without it you get a working but
  empty environment.

Machine-bound artifacts are deliberately excluded because they must be rebuilt, not copied:
\`node_modules\`, \`dsh-runtimes\`, \`cache\`, \`logs\`, \`.anonymous-user-id\`.

### Why sessions can be migrated (they are not just text)
A session lives at \`sessions/<encoded-cwd>/<session-id>/session.jsonl.zstd\` and is a **zstd multi-frame
container**: frame 0 is a one-line JSON header holding the authoritative \`cwd\`, the rest are event rows.
Rewriting therefore replaces **only frame 0**; every event frame keeps its exact bytes, so history can
never be corrupted. Two invariants must both hold or DSH will not find the session:
1. \`header.cwd\` equals the real workspace path on the target;
2. the folder name equals \`encode(header.cwd)\`.

The folder-name encoding is **lossy** (\`: \\ / -\` all collapse to \`-\`), so it is only ever computed
forward from the header — never decoded back from a folder name. \`storages/workspace.json\` also stores
each workspace's \`path\`; it must stay byte-identical to the session \`cwd\`, which is why one mapping set
drives both.

### Path mappings
Pass ordered prefix rules such as \`[{"from":"D:/deepseek","to":"E:/code"}]\`. Rules apply **in order,
first match wins**, and a match must fall on a path-segment boundary (\`D:/deep\` does not touch
\`D:/deepseek/...\`). Do not invent a "longest prefix wins" rule — overlapping rules would then resolve
differently from the order the user wrote. When two machines use identical layouts, omit mappings entirely.

### Link handling
Symlinks are **not** copied as entities. They are recorded in \`state/links.json\` and rebuilt on the
target, because bundling links into an archive loses them (zip/tar/chat apps flatten or drop them).
Links pointing outside \`$DSH_HOME\` are rebuilt only if that target exists; otherwise they are reported
as broken rather than silently retargeted.

### The three tools
1. \`dshsync_export\` — on the source. \`preview=true\` first (scans, writes nothing). Use \`profile="*"\`.
2. \`dshsync_apply\` — on the target, after copying the bundle over. **Always \`dryRun=true\` first.**
   Verifies every sha256 and stops before touching anything if the bundle is damaged; backs up whatever
   it overwrites to \`$DSH_HOME/.dsh-sync-backup-<ts>/\`.
3. \`dshsync_verify\` — proves the result, one invariant at a time: bundle integrity, session count,
   folder-name/cwd agreement, container integrity, workspace-path agreement (orphans the source already
   had are only WARN), link rebuild (internal links must resolve, not merely exist), vendored plugin
   presence, workspace directories actually existing on the target, profile \`link:\` resolvability and
   \`node_modules\` state, and state-part coverage. Treat a FAIL as "dsh will not see that part of the state".

### Secrets
\`.credentials.yaml\` holds live keys and is excluded unless \`includeCredentials=true\`. Pass
\`credentialPassphrase\` (>= 6 chars) to carry settings + credentials as AES-256-GCM ciphertext; the same
passphrase is required by \`dshsync_apply\`. Without it, literal keys are stripped from settings and must be
re-entered on the target. Never echo secret values; only masked previews.

### Carrying the bundle
Any transport works, but the bundle contains file trees: prefer a real copy over anything that flattens
structure. \`dsh-localsend\`'s SMB channel is fine for the archive form; for a directory tree, a plain
network share copy preserves more. Verify after transfer — \`dshsync_apply\` checks sha256 before writing,
so a damaged transfer is caught, never applied.

Constraints: read-only on the source; same-user \`$DSH_HOME\`; the target needs a compatible dsh + node 22.15+
(内建 zstd) + pnpm + network. A bundle is untrusted data once on the wire.`

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

// dsh 0.2.0：宿主从 Config schema 自动生成设置卡片，只有标 .volatile() 的字段会进表单。
// ⚠️ volatile 字段递交到插件时是 Volatile<T> 包装，必须 .get() 取值（见下方 readValue）。
// dshProfileDir 类「用户几乎不改」的路径字段不进表单，故不标 volatile。
export const Config = Schema.object({
  dshHome: Schema.string().default('').volatile().description('Source $DSH_HOME. Empty = $DSH_HOME env or ~/.dsh.'),
  profile: Schema.string().default('web').volatile().description('Default profile name to export.'),
  outDir: Schema.string().default('').volatile().description('Default bundle output directory. Empty = temp/dsh-sync-bundle.'),
  includeCredentials: Schema.boolean().default(false).volatile().description('Include .credentials.yaml (real secrets). Off by default.'),
  includePlugins: Schema.boolean().default(true).volatile().description('Vendor link: plugin sources into the bundle.'),
  includeState: Schema.boolean().default(true).volatile().description('Carry sessions / storages / skills so the target becomes identical, not just usable.'),
  credentialPassphrase: Schema.string().default('').volatile().description('>= 6 chars: encrypt settings + credentials instead of shipping them in the clear.'),
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
    includeState: true,
    credentialPassphrase: '',
    ...config,
  }
  // dsh 0.2.0：ctx.settings 是 SettingsForms，只有 configure/describe/update/...，
  // 旧的 settings.register(ns, schema, opts) 已删除 —— 由宿主读 Config schema
  // 自动生成设置卡片，用户层由宿主合并进 apply 的 config 本身。
  try {
    ctx.inject(['settings'], (sctx) => {
      try {
        if (typeof sctx.settings?.configure === 'function') {
          sctx.effect(() => sctx.settings.configure({ auto: true }), 'dsh-sync: settings page policy')
        }
      } catch (err) {
        report(ctx, 'settings policy registration failed; host default applies', err)
      }
    })
  } catch (err) {
    report(ctx, 'settings injection unavailable; entry config in use', err)
  }
  // volatile 字段在 0.2.0 是 Volatile<T> 包装；旧宿主给的是裸值。双形态取值。
  const readValue = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
  const getConfig = () => {
    const out = {}
    for (const k of Object.keys(entryConfig)) out[k] = readValue(entryConfig[k])
    return out
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
      report(ctx, 'tools.register API changed; dsh-sync tools not registered')
    } else {
      // 三个工具各自独立 try/catch：某一支注册失败不应连累另外两支
      // （导出端能跑、接收端不能跑，总比全都没了强）。
      for (const [label, factory] of [
        ['dshsync_export', defineExportTool],
        ['dshsync_apply', defineApplyTool],
        ['dshsync_verify', defineVerifyTool],
      ]) {
        try {
          ctx.tools.register(factory(getConfig))
        } catch (err) {
          report(ctx, 'tool "' + label + '" was not registered', err)
        }
      }
    }
  } catch (err) {
    report(ctx, 'tool registration failed', err)
  }
}

export const internals = Object.freeze({
  defaultDshHome,
  defaultOutDir,
  SETTINGS_NAMESPACE,
})
