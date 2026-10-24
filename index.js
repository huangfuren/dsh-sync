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
import { defineRemapTool } from './lib/tools/remap.js'
import { registerMigrateRoute } from './lib/migrate.js'
import { registerDevicesRoute, registerOverviewRoute } from './lib/status.js'

export const name = 'sync'
export const inject = ['tools', 'systemPrompt']

export const SETTINGS_NAMESPACE = 'sync'

const GUIDANCE = `## Migrate an entire dsh installation between machines (dsh-sync)

Three tools form one pipeline: **export on the source → carry the bundle → apply + verify on the target.**
The carry step is optional; when both machines are on the same network, four more tools move the bundle
directly (see "Moving the bundle over the LAN").

### Terminology — "source" always means the OLD machine
The **source machine (源机) is the OLD machine**: the one that already has the history, plugins and
project code. It runs \`dshsync_export\` / \`dshsync_lan_host\` and stays read-only. The **target
machine (目标机) is the NEW machine**: the freshly installed one that should become identical. It runs
\`dshsync_apply\` / \`dshsync_lan_pull\` / \`dshsync_verify\`. When relaying reports to the user, say
旧机/新机 alongside 源机/目标机 — never let "source" be read as "the machine we're setting up now".

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

### Migrating a second time (onto a machine that is already in use)
The default landing is a plain overwrite. That is right for a fresh target and wrong for a used one:
whatever the target acquired since the last migration — plugins it installed, workspaces it registered,
settings it changed — is not in the source snapshot, so overwriting silently deletes it. The deleted
things are in the backup directory, but nobody reads those.
Pass \`merge=true\` to \`dshsync_apply\`. It compares the bundle against what the target has **before writing
anything** and stops while any conflict is unresolved:
- \`plugins\` — declared on the target but absent from the bundle (it would vanish from the declaration,
  leaving its source sitting in \`plugins/\` with nothing loading it), or present on both sides with
  different specs;
- \`workspaces\` — workspace records the target has and the bundle does not;
- \`settings\` — settings.yaml differs. Never three-way merged: anchors, comments and key order cannot be
  reconciled without knowing the schema, and a bad merge is worse than either side;
- \`sessions\` — one summary line, because there can be hundreds and their disagreement is uniform.

Then run again with \`resolutions\` giving a choice for each. **Nothing has a default** — an unresolved item
stays unresolved and the run stops again. \`sessions\` takes a single policy for all of them: \`skip\` (leave
the target's alone), \`append-missing\` (copy only the log files the target lacks, never rewriting the ones
it has), \`prefer-source\` (overwrite with the source's), \`prefer-target\` (same as \`skip\`). It is all
file-level: frames are never split apart and reassembled, because that is exactly what makes "history
cannot be corrupted" true in the first place.
A fresh target does not need \`merge\` — with nothing on the other side there is nothing to conflict about,
and a plain overwrite is simpler. Reach for it on the **second** migration, and say plainly which way each
conflict went when you report back; do not quietly pick a side for the user.

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
Same plugin, same eight tools (dshsync_remap included): this is a host-only plugin (no client half, no build step), so the loading
path is identical in both. Two things genuinely differ, and both have bitten:
- **The profile you actually run is not necessarily \`web\`.** The desktop app loads \`profiles/desktop\`;
  a plugin installed only into \`profiles/web\` is simply absent from the UI. That is why \`profile\` defaults
  to \`"*"\` here, and why you should install this plugin into the profile you really use.
- **There is no \`pnpm\` or \`dsh\` on PATH on a desktop machine.** The app ships its own pnpm internally.
  Reinstalling dependencies is YOUR job after apply: the host does NOT rebuild \`node_modules\` from the new
  \`package.json\` on restart — it just fails to load every plugin with no error (all show 包不可用). Use the
  pnpm shipped in the app runtime (在安装目录 resources/runtime/primary-runtime/dependencies/ 下) in the
  profile directory, or the plugin manager's 重新安装/修复. apply reports missing dependencies as 必办 items.

### After directories moved post-migration: dshsync_remap
If a migration completed but the directories moved afterwards (workspaces to another drive, projects into a
subfolder), \`dshsync_apply\` cannot help — it needs a bundle of the OLD paths. Use \`dshsync_remap\` on THIS
machine: it rewrites in place all FIVE identity sites with one mapping rule set — session header cwd, session
group dir names, workspace.json record paths, session_projcache (unit dump AND per-session records whose
embedded absolute log paths the host cross-checks against the logs), and symlink/junction targets. Always
\`dryRun=true\` first. It never copies data; it only rewrites paths of what already exists. Missing any one of
the five sites means the host's whole service tree refuses to activate (corrupt session log / duplicate
session id), so hand-fixing is what created the need for this tool.

### Session-identity invariants the host enforces (why the five sites above are all-or-nothing)
1. \`realpathNormalize(header.cwd)\` must equal the workspace.json \`record.path\` verbatim and the directory
   must exist — otherwise new sessions fail to attach (\`workspace-attach-failed\`).
2. The group dir name must equal \`encode(header.cwd)\`.
3. Per-session records (\`storages/session_projcache/sessions/<id>.json\`) embed the log's absolute path;
   any stale path there = \`corrupt session log\` and workspaceRegistry refuses to activate.
4. One session id must not appear in more than one group dir — duplicates crash workspaceRegistry and cascade
   (sessionController / schedule all pending). apply refuses a bundle containing duplicates BEFORE writing;
   the fix is on the SOURCE: move one side out of sessions/ and re-export.
5. Any violation is not "one broken session" — it cascades. Subagent sessions live in BARE-UUID dirs (no
   \`session-\` prefix) and have \`"origin":"subagent"\` headers; every traversal must treat any directory
   under a group as a session dir.

### Secrets
\`.credentials.yaml\` holds live keys and is excluded unless \`includeCredentials=true\`. Pass
\`credentialPassphrase\` (>= 6 chars) to carry settings + credentials as AES-256-GCM ciphertext; the same
passphrase is required by \`dshsync_apply\`, and can be carried by the LAN flow too (\`dshsync_lan_pull\`
takes \`credentialPassphrase\`; the settings card has a per-run passphrase field) — it lives in memory for
that run only: never saved, never logged. Without a passphrase, literal keys are stripped from settings and
must be re-entered on the target. Never echo secret values; only masked previews.

### Dependencies are your job — but the tooling now does the heavy lifting
The host does NOT rebuild \`node_modules\` from the new \`package.json\` on restart. apply detects missing
packages per landed profile and (by default, \`installDeps=true\`) runs \`pnpm install\` with the pnpm bundled
in the host runtime — the path users could never find is derived from the running process. If that fails
(the running host may lock native modules on Windows), a ready-to-run install script is generated at
\`$DSH_HOME/.dsh-sync-install-deps.ps1\` (+ \`.sh\`): fully exit dsh, run it, reopen. Either way the
action-required list names exactly what happened; a successful auto-install still says to restart dsh.

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
   a fresh code, \`action="stop"\` shuts it down. \`bundleDir\` defaults to the configured output directory
   (that is exactly where \`dshsync_export\` wrote it), so in the normal flow it needs no argument at all.
2. \`dshsync_lan_discover\` — on the **target**, when the source IP is unknown. UDP broadcast first (about a
   second), per-address scan as fallback (about three seconds) for when broadcast is blocked.
3. \`dshsync_lan_pull\` — on the **target**. Pairs, waits for the human click, streams the files, then runs
   apply + verify. Returns a jobId immediately; the transfer continues in the background.
4. \`dshsync_lan_status\` — either side. Progress, speed, ETA, and the final apply/verify report.

**Pick the machine before you move anything.** \`dshsync_lan_discover\` lists every machine currently
serving a bundle, and each entry carries a stable \`id\` plus a 1-based index. Select one of two ways:
click it in the settings card (设置 → 内置插件 → dsh-sync 迁移 → 局域网设备 → 扫描 → 点选), or pass
\`deviceId\` to \`dshsync_lan_pull\` — id, index, alias and IP are all accepted. With neither \`host\` nor
\`deviceId\`, the pull falls back to whatever is selected in the card. When nothing has been selected it
says so and lists what is available; it never picks a machine for you — sending a bundle to the wrong
host is not a recoverable mistake. The one exception is a list of exactly one machine that you have not
chosen from yet: that is auto-selected and marked as such on screen, because there is nothing to choose
between. An existing selection is never overwritten — if a later scan no longer contains it, it is
reported as stale and you scan again. The selection lives in memory only, so after a restart the list is
empty until you scan again. Opening the card already broadcasts once (about a second, no per-address
scan); press 扫描 only when that found nothing.

Starting the move takes the same two shapes: either press start **in that same card** (pairing code,
where to receive it, where the project code should land — the receive directory is prefilled), or call
\`dshsync_lan_pull\`. Both run the identical code path, so a transfer started from the card behaves exactly
like one started from the conversation; only the presentation differs (a progress bar and result rows
versus a block of text). Whichever way it starts, nothing moves until a human clicks accept on the source
machine's page.

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

/**
 * 空串回退到计算默认。实机验证过的坑：宿主把 Config 的 schema 默认值（''）一并传进 apply 的
 * config，`...config` 展开后会把 entryConfig 里算好的 dshHome/outDir 盖成空串 ——
 * 卡片上「状态层 / dsh / 输出目录」全部显示「—」，工具层则直接抛 cannot resolve $DSH_HOME。
 * 两个字段的描述本来就写着「Empty = auto」，所以空串回退不是猜语义，是兑现描述。
 */
function withAutoFallbacks(values) {
  const out = { ...values }
  if (!out.dshHome) out.dshHome = defaultDshHome()
  if (!out.outDir) out.outDir = defaultOutDir()
  return out
}

// Config 在这台宿主上有两个消费者,分工必须看清:
//   ① 工具默认值 —— getConfig() 每次工具调用时读一遍(所以这些字段全是「偏好字段」);
//   ② 设置卡片  —— client.js 经 configForms 读写,**只认标了 .volatile() 的字段**。
// ⚠️ volatile 字段递交到插件时是 Volatile<T> 包装,必须 .get() 取值(见下方 readValue)。
//
// 为什么宿主的 autoGenerate 靠不住:0.2.1-rc.2 的 dsh-settings README 明写
// 「autoGenerate 默认开,for clients that build pages from the schema; no shipped client does so yet」——
// 没有任何客户端实现自动页。只导出 Config 的插件在设置里**不会**出现任何卡片,
// 这就是本包必须自带 client.js 的原因。
//
// 两个字段**故意不标 volatile**:
//   · includeCredentials —— 一键把明文凭据打进 bundle,不该是界面上顺手一点的事;
//   · credentialPassphrase —— 口令一旦进表单就会明文落在 settings.yaml 里。
// 不标 volatile = 宿主不服务、任何表单都改不到;仍可用工具参数按次传入。
export const Config = Schema.object({
  dshHome: Schema.string().default('').volatile().description('Source $DSH_HOME. Empty = $DSH_HOME env or ~/.dsh.'),
  profile: Schema.string().default('*').volatile().description('Profile to export. "*" = every profile (default).'),
  outDir: Schema.string().default('').volatile().description('Default bundle output directory. Empty = temp/dsh-sync-bundle.'),
  includeCredentials: Schema.boolean().default(false).description('Include .credentials.yaml (real secrets). Off by default, tool argument only.'),
  includePlugins: Schema.boolean().default(true).volatile().description('Vendor link: plugin sources into the bundle.'),
  includeState: Schema.boolean().default(true).volatile().description('Carry sessions / storages / skills so the target becomes identical, not just usable.'),
  credentialPassphrase: Schema.string().default('').description('>= 6 chars: encrypt settings + credentials instead of shipping them in the clear. Tool argument only.'),
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
    return withAutoFallbacks(out)
  }

  // 设置卡片的只读状态通道。宿主把自己已经认证过的 /api 围栏开放给插件,
  // 卡片按需拉一次「本机状态 + 传输状态」—— 不把状态塞进任何投影,也不自己起 HTTP 服务。
  // 挂不上不是错误:卡片退化成「只有配置区」,配置照常可改。
  try {
    ctx.inject(['connection'], (c) => {
      let connection
      try {
        connection = typeof c.get === 'function' ? c.get('connection') : undefined
      } catch {
        connection = undefined
      }
      try {
        if (!registerOverviewRoute(c, connection, getConfig)) {
          report(ctx, 'connection.fetch.register unavailable; settings card shows configuration only')
        }
        // 设备端点（扫描 / 选中）挂不上时，卡片退化成「本机状态可用、设备列表不可用」，
        // 不连累上面那条：三条路由各自能挂就挂。
        if (!registerDevicesRoute(c, connection)) {
          report(ctx, 'settings card devices route not registered')
        }
        // 卡片上的「开始迁移」走这条。挂不上只是不能在界面上发起，
        // 对话里的 dshsync_lan_pull 完全不受影响。
        if (!registerMigrateRoute(c, connection, getConfig)) {
          report(ctx, 'settings card migrate route not registered')
        }
      } catch (err) {
        report(ctx, 'settings card routes not registered', err)
      }
    })
  } catch (err) {
    report(ctx, 'connection injection unavailable; settings card shows configuration only', err)
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
      // 八个工具各自独立 try/catch：某一支注册失败不应连累其它支
      // （导出端能跑、接收端不能跑，总比全都没了强）。
      for (const [label, factory] of [
        ['dshsync_export', defineExportTool],
        ['dshsync_apply', defineApplyTool],
        ['dshsync_verify', defineVerifyTool],
        ['dshsync_lan_host', defineLanHostTool],
        ['dshsync_lan_pull', defineLanPullTool],
        ['dshsync_lan_status', defineLanStatusTool],
        ['dshsync_lan_discover', defineLanDiscoverTool],
        ['dshsync_remap', defineRemapTool],
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
  withAutoFallbacks,
  SETTINGS_NAMESPACE,
})
