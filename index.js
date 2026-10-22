// dsh-sync — 把本机 dsh 配置导出成可移植 bundle,同步到另一台机器(host 工具插件)。
// 装配入口:元信息、系统提示、配置 schema 与 apply();实现拆分在 lib/ 下。
import os from 'node:os'
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import { defineExportTool } from './lib/tools/export.js'
import { defineApplyTool } from './lib/tools/apply.js'
import { defineVerifyTool } from './lib/tools/verify.js'
import { defineLanHostTool } from './lib/tools/lan-host.js'
import { defineLanPullTool } from './lib/tools/lan-pull.js'
import { defineLanStatusTool } from './lib/tools/lan-status.js'
import { defineLanDiscoverTool } from './lib/tools/lan-discover.js'

export const name = 'sync'
export const inject = ['tools', 'systemPrompt']

export const SETTINGS_NAMESPACE = 'sync'

const GUIDANCE = `## Migrate an entire dsh installation between machines (dsh-sync)

Three tools form one pipeline: **export on the source → carry the bundle → apply + verify on the target.**
The carry step is optional; when both machines are on the same network, four more tools move the bundle
directly (see "Moving the bundle over the LAN").

### What "migrated" means here
Three layers. The first two are on by default; the third is opt-in and you usually need it too:
- **Declaration layer** — settings.yaml, optional credentials, each profile's declaration files, and the
  SOURCE of every \`link:\` plugin. This is what makes the target machine *work*.
- **State layer** — \`sessions/\`, \`storages/\`, \`skills/\`. This is what makes the target machine
  *identical*: same history, same workspace list, same skill links. Without it you get a working but
  empty environment.
- **Workspace layer** — the project directories the sessions point at. Opt in with
  \`includeWorkspaces=true\`. Without it every session opens onto a path that does not exist.

"State copied but projects missing" is the classic half-migration: history, workspace list and skill
links all verify green, then clicking any session opens an empty editor.

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

### Project directories
Pick roots, not drives. The candidate list comes from two places — the \`cwd\` of every session and
\`storages/workspace.json\` — and nested paths are deduplicated up to the shallowest root, so 8 references
can collapse to 5 roots. Never "copy drive D:".

Landing is decided by ONE argument, \`workspaceRoot\`: each project is expanded under it by its own name,
giving \`<workspaceRoot>/<name>\`. Pass \`workspaceMap={"<name>":"<abs path>"}\` to override an individual
project. The destination paths are then **derived** into the mapping set, ahead of any hand-written
\`mappings\` — the sessions, the workspace list and the external symlinks all have to point at wherever
the code actually landed. Get that order backwards and you get the same half-migration as above.
\`gitMode\` is reported per project (\`repo\` = itself a repo, \`multi\` = a container of repos such as
\`mine/\` holding 9, \`none\`), and \`includeGit\` decides whether \`.git\` travels.

### Link handling
Symlinks are **not** copied as entities. They are recorded in \`state/links.json\` and rebuilt on the
target, because bundling links into an archive loses them (zip/tar/chat apps flatten or drop them).
Links pointing outside \`$DSH_HOME\` go through the same mapping set, so a skill linked at the project
source follows the project to its new location; if no rule matches and the original target does not
exist, the link is reported as broken rather than silently retargeted.

### Which machine is which (settle this before anything else)
The direction is not inferred, it is chosen: the machine running \`dshsync_export\` is the source, the one
running \`dshsync_apply\` is the target. Two ways to get it backwards, neither of which fails on its own:
exporting on the new machine yields a near-empty bundle that later clobbers the old machine's settings and
plugin list while its sessions survive ("all history, no config"); applying on the old machine rewrites
real session headers against a stale snapshot. Both are now guarded — export/preview warns when this
machine has no sessions and no workspace records (it looks like a fresh install), and apply refuses when the
bundle was produced by the same host with the same \`$DSH_HOME\` unless \`allowSameMachine=true\`.
When the user asks which machine is the new one, give them verifiable signals, not a guess: is the project
code present, what does \`preview=true\` list, how large is \`$DSH_HOME\`. The bundle records
\`hostname + user + $DSH_HOME\` only — no hardware fingerprints.

### The three migration tools
1. \`dshsync_export\` — on the source. \`preview=true\` first (scans, writes nothing). Use \`profile="*"\`.
2. \`dshsync_apply\` — on the target, after getting the bundle there (locally via the LAN tools, or by any
   other copy). **Always \`dryRun=true\` first.** Verifies every sha256 and stops before touching anything
   if the bundle is damaged; backs up whatever it overwrites to \`$DSH_HOME/.dsh-sync-backup-<ts>/\`.
3. \`dshsync_verify\` — proves the result, one invariant at a time: bundle integrity, session count,
   folder-name/cwd agreement, container integrity, workspace-path agreement (orphans the source already
   had are only WARN), link rebuild (internal links must resolve, not merely exist), vendored plugin
   presence, workspace directories actually existing on the target, profile \`link:\` resolvability and
   \`node_modules\` state, state-part coverage, **host runtime agreement**, and **packaged project
   directories having landed** (pass \`workspaceRoot\` to check that last one).
   Treat a FAIL as "dsh will not see that part of the state".

### Host version (the failure that hides from every file check)
A bundle can be perfect and the target still show an empty plugin list: the host runs a peer-compatibility
ruling at startup, and a version mismatch leaves every plugin \`stays installed but startup denies it\`.
Files present, sha256 correct, every state invariant green — nothing loads. So the host version is
recorded on export (\`manifest.source\`) and compared on both landing paths.
It is read from the running desktop app's own \`resources/app.asar/dsh/desktop-runtime.json\` first, and only
falling back to \`$DSH_HOME/dsh-runtimes/<runtime>/runtime.json\` — never from \`dsh --version\`, which desktop
builds do not have at all (that is why this check used to run and always find nothing). The fallback matters
because the runtime manifest is written **at install time** and is not refreshed when the app updates: one
machine here reported 0.2.0-rc.2 while the app running was 0.2.1-rc.2, which would flag a false mismatch
against a freshly installed machine and, worse, mask a real one when both snapshots are stale.
A gap within the same \`major.minor\` is a soft warning (patch-level lag is normal); across \`major.minor\` it
names the waiver you will need. Unknown on either side is "needs manual confirmation", never silently passed.

### Desktop app vs web host
Same plugin, same seven tools: this is a host-only plugin (no client half, no build step), so the loading
path is identical in both. Two things genuinely differ, and both have bitten:
- **The profile you actually run is not necessarily \`web\`.** The desktop app loads \`profiles/desktop\`;
  a plugin installed only into \`profiles/web\` is simply absent from the UI. That is why \`profile\` defaults
  to \`"*"\` here, and why you should install this plugin into the profile you really use.
- **There is no \`pnpm\` or \`dsh\` on PATH on a desktop machine.** The app ships its own pnpm internally.
  Never tell a desktop user to run \`pnpm install\`: land the profile files and let the app reconcile them on
  the next start; if the plugin list comes up empty, reinstall/repair once from the plugin manager.

### Secrets
\`.credentials.yaml\` holds live keys and is excluded unless \`includeCredentials=true\`. Pass
\`credentialPassphrase\` (>= 6 chars) to carry settings + credentials as AES-256-GCM ciphertext; the same
passphrase is required by \`dshsync_apply\`. Without it, literal keys are stripped from settings and must be
re-entered on the target. Never echo secret values; only masked previews.

### Carrying the bundle
Any transport works, but the bundle contains file trees: prefer a real copy over anything that flattens
structure. For a machine-to-machine move on the same network, use the LAN tools below — they keep the tree
intact, hash every file in flight and need no third-party software. \`dsh-localsend\`'s SMB channel is fine
for the archive form. Verify after transfer — \`dshsync_apply\` checks sha256 before writing, so a damaged
transfer is caught, never applied.

### Moving the bundle over the LAN (no USB drive, no cloud)
Four tools cover the transfer itself:
1. \`dshsync_lan_host\` — on the **source**, after export. Prints a 6-digit pairing code and the URL of a
   live progress page, then returns; the service keeps running in the background. \`action="renew"\` issues
   a fresh code, \`action="stop"\` shuts it down.
2. \`dshsync_lan_discover\` — on the **target**, when the source IP is unknown. UDP broadcast first (about a
   second), per-address scan as fallback (about three seconds) for when broadcast is blocked.
3. \`dshsync_lan_pull\` — on the **target**. Pairs, waits for the human click, streams the files, then runs
   apply + verify. Returns a jobId immediately; the transfer continues in the background.
4. \`dshsync_lan_status\` — either side. Progress, speed, ETA, and the final apply/verify report.

Two properties are deliberate and must not be relaxed:
- **The pairing code is not authorization.** Knowing the code is not enough: the transfer starts only when
  the human clicks accept on the source machine's page, and \`/decide\` rejects requests that do not
  originate from the source machine itself. Remote viewers get a read-only page and never receive the code
  at all. Codes are single-use, expire in five minutes, and lock after five wrong attempts.
- **Nothing lands until its hash matches.** Each file is written as \`*.dshsync-part\` and renamed only after
  sha256 agrees. Paths in the stream are untrusted — absolute paths and anything escaping the destination
  are rejected. Re-running a pull resumes: files already present with a matching hash are skipped.

Progress is shown on a browser page rather than in the conversation for a concrete reason: tool calls have
no streaming channel (\`execute()\` returns once, at the end), so a long transfer would look like a hang.
Do not poll with sleeps; call \`dshsync_lan_status\` when the user asks how it is going.
The page binds to the LAN address on the source and to loopback on the target; the source refuses
connections from public addresses unless \`allowPublic\` is set.

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
  profile: Schema.string().default('*').volatile().description('Profile to export. "*" = every profile (default).'),
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
    // 默认导全部 profile。原先写死 'web' 的后果在桌面版上很具体：不传 profile 时会去导
    // `profiles/web`，而桌面版真正在用的是 `profiles/desktop` —— 搬完一台「看起来成功」的空机。
    profile: '*',
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
      // 七个工具各自独立 try/catch：某一支注册失败不应连累其它支
      // （导出端能跑、接收端不能跑，总比全都没了强）。
      for (const [label, factory] of [
        ['dshsync_export', defineExportTool],
        ['dshsync_apply', defineApplyTool],
        ['dshsync_verify', defineVerifyTool],
        ['dshsync_lan_host', defineLanHostTool],
        ['dshsync_lan_pull', defineLanPullTool],
        ['dshsync_lan_status', defineLanStatusTool],
        ['dshsync_lan_discover', defineLanDiscoverTool],
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
