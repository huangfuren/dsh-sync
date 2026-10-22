# dsh-sync

English | [中文](README.md)

Move **an entire machine's dsh state** to another machine. After switching, the new machine is not merely "working" — it is **the same as the old one**: same settings, same plugins, same conversation history, same workspace list, same skills links.

There are two ways to move it: carry the bundle by hand (export → copy → land → verify), or go **straight over the LAN** (`dshsync_lan_host` + `dshsync_lan_pull`: pair, then one command pulls it over, lands it and verifies it — no USB drive, no cloud drive).

Three layers, and missing any of them is not "identical":

| Layer | Contents | What breaks without it |
|---|---|---|
| **Declaration layer** | `settings.yaml`, credentials (optional), home-level `cordis.patch.yml`, `AGENTS.md`, each profile's `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / `.dsh-market/state.json` (disabled plugins, custom groups, market region), the source of every `link:` plugin | dsh will not start / **all plugins lost** / disabled-state and grouping reset / agent behaves differently |
| **State layer** | `sessions/`, `storages/`, `skills/`, `attachments/`, `background/`, `dsh-market/`, `llm-deepseek/` | dsh runs, but **every conversation is gone, workspace list empty, skills empty, attachments and backgrounds gone** |
| **Workspace layer** | The project directories those sessions actually open (`includeWorkspaces`, **off** by default) | Conversations are listed but open **empty** — the cwd points outside `$DSH_HOME` |

A profile's `package.json` is the truth about "the plugin situation": it decides both what gets installed (`dependencies`) and what actually loads (`dsh.profile.bundles`). It **must** travel — otherwise the plugin sources sit in `plugins/` with nothing to load them. And it cannot be copied verbatim: its `link:` entries are source-machine absolute paths, so export rewrites them to `link:../../plugins/<name>` pointing at the vendored copy, which holds wherever the target puts `$DSH_HOME`.

Rebuildable artifacts are **not** moved (moving them is actively wrong): `node_modules` (reinstalled from `package.json`), `dsh-runtimes` (rebuilt with the host installer), `cache`, `logs`, `.anonymous-user-id`.

## Moving the project directories too

A session's cwd points at a project directory **outside** `$DSH_HOME`. Move only `.dsh` and those
conversations show up on the target but open empty — not a successful machine switch.

With `includeWorkspaces` they are packaged by **root**:

| Fact | Measured on this machine |
|---|---|
| Session cwds | 8 |
| Roots after collapsing nesting | **5** (`D://a` and `D://a//b` are moved once) |
| Whole `D://deepseek` tree | 5.4 GB (mostly a DSH source checkout and scratch dirs, irrelevant here) |
| The 5 roots actually referenced | 1.18 GB net |

Three rules only:

1. **By root, not by drive** — candidates come from session cwds *and* `storages/workspace.json`; nesting collapses first.
2. **`.git` is kept by default**, `node_modules` is always excluded — repositories stay complete on the target
   (you can `git log` / `git pull`), and you reinstall dependencies once. Container directories holding several
   repos (`dsh-plugin/mine/` with 9 of them) are recognised as such.
3. **Landing takes one parameter** — `workspaceRoot` is the root you pick on the new machine; directory names are preserved:

```
dshsync_apply(bundleDir="<bundle>", workspaceRoot="E:/code", dryRun=true)
```

Session cwds, `workspace.json` paths and the `skills/` symlinks pointing into project directories are all
rewritten to land under `workspaceRoot`. Override a single project with
`workspaceMap={"dsh-chat":"E:/projects/dsh-chat"}`.

Why the landing rule has to win: if any one of those three disagrees, you get "session exists, content empty".
So derived mappings are placed **before** your hand-written `mappings`, and if a rule of yours overlaps a
packaged workspace the report says plainly that the rule does not apply to it.

If the landing directory already exists and is not empty, unpacking is **refused** (workspaces are too large
to back up); pass `overwriteWorkspaces=true` to force it.

## Two ways to land the bundle

| Route | Needs dsh-sync on the target | What it can do |
|---|---|---|
| `apply.ps1` / `apply.sh` (shipped in the bundle) | **No** | Declaration layer + whole-bundle verification + backup + rollback |
| `dshsync_apply` tool | Yes | All of the above **+ path remapping + session cwd rewrite + workspace path rewrite + symlink rebuild** |
| `dshsync_verify` tool | Yes | Checks, one by one, whether the target really matches the source |

The scripts cannot do the last two: rewriting a session requires **zstd frame-level I/O**, and PowerShell has no such capability.
Both routes share the same mapping rules (`lib/path-map.js`), so the script can never rewrite paths one way while the tool rewrites them another.

## Why you cannot just copy `~/.dsh`

| Content | Copyable as-is? | Reason |
|---|---|---|
| `settings.yaml` | ⚠️ Copyable but may hold plaintext secrets | Config should carry **references**, not secrets; plaintext is stripped by default (or the whole file is encrypted) |
| `.credentials.yaml` | ⚠️ Copyable but holds **real secrets** | **Excluded** by default; when included it should travel encrypted |
| `profiles/*/package.json` | ✅ **Must travel, but needs rewriting** | Decides what is installed (`dependencies`) and what loads (`dsh.profile.bundles`); `link:` is an **absolute path**, rewritten at export to point at the vendored copy |
| `profiles/*/node_modules` | ❌ **Never copy** | Native binaries (`pty.node` / `conpty.node`) bound to OS/arch/Node ABI |
| `sessions/` | ✅ **Copyable, but must be rewritten** | Folder names encode the workspace path; the authoritative `cwd` lives in the session's first frame and can be rewritten |
| `storages/workspace.json` | ✅ **Copyable, but must be rewritten** | Workspace records are **not** rebuilt automatically; without rewriting, every historical session becomes orphaned |
| `skills/` | ✅ **Copyable, rebuilt from a list** | Mostly symlinks pointing outside `$DSH_HOME`; they are **not** recreated automatically |
| `attachments/` `background/` `dsh-market/` `llm-deepseek/` `AGENTS.md` | ✅ Copyable | The user's own material (attachment library / backgrounds / market state / global instructions); under 10 MB total |
| `.anonymous-user-id` | ❌ No | Machine identity: the target should have its own, not inherit the old one |

## How a session is rewritten

A session looks like this: `sessions/<encoded-cwd>/<session-id>/session.jsonl.zstd`

There is **more than one log filename** — the host left three forms behind as it evolved, and one session may hold several of them at once:

| Filename | Header trait | Measured on the author machine |
|---|---|---|
| `session.jsonl.zstd` | no `version` field | 33 files |
| `session.v3.jsonl.zstd` | `version: 3` | 45 files |
| `session.v4.jsonl.zstd` | `version: 4` | 25 files |

All three are structurally identical (concatenated zstd frames) and differ only in filename and the header `version`; copies of the same session agree on `cwd`. **Every variant is rewritten** — recognising only one of them silently leaves most sessions pointing at the old machine.

It is not an ordinary compressed file but a **concatenation of zstd frames**: the first frame is a one-line JSON header (holding the authoritative `cwd`), and every frame after it is one event. Rewriting therefore replaces **only the first frame**, leaving the remaining frames **byte-for-byte untouched** — history cannot be corrupted, and it cannot be silently recompressed.

Two invariants must both hold for dsh to find the session:

1. `header.cwd` equals a real workspace path on the target machine;
2. the folder name equals `encode(header.cwd)`.

That encoding is **lossy** (`:`, `\`, `/` and `-` all collapse into `-`), so it may only ever be computed forward from the header — **never** parsed backwards from a folder name. `storages/workspace.json` also stores a `path` per workspace, and it must match the session `cwd` verbatim — which is why one mapping set drives both.

## First, which machine is the NEW one?

The plugin **cannot** work this out for you. dsh-sync does not know which machine is new; the direction
comes entirely from *where you run which tool* — whichever machine runs `dshsync_export` is the source
(the old one), whichever runs `dshsync_apply` is the target (the new one). Get it backwards and there are
two outcomes, neither of which fails on its own:

| Getting it backwards | What happens | How it is caught now |
| --- | --- | --- |
| Exporting on the **new** machine | The bundle is nearly empty; applying it onto the old machine overwrites settings and plugins with defaults, while the old sessions survive (the new bundle has none) → "all history, no config" | Export and preview both report "this machine has no sessions and no workspace records — it looks like a fresh shell" |
| Applying on the **old** machine | Your real data gets rewritten against an old snapshot — session header cwd and folder names, irreversible | apply refuses when it sees "same host + same `$DSH_HOME`"; it takes `allowSameMachine=true` to proceed |

Three signals for telling them apart, most reliable first:

1. **Is the project code there?** Hardest to fake. The old machine has those directories
   (`D:\deepseek\dsh-plugin\mine\` here); a fresh install does not.
2. **The `dshsync_export(preview=true)` listing** — session count, distinct workspace paths, self-installed
   plugins. **The one with history is the old machine.** Baseline measured here: 84 sessions /
   8 workspace paths / 11 vendored plugins.
3. **`$DSH_HOME` size** — around 630 MB on the old machine, usually well under 100 MB on a fresh install.

The bundle records the source's `hostname + user + DSH_HOME`, and apply checks the direction against them,
printing one line:

```
✓ direction: source DESKTOP-OLD/jichen.huang → this machine DESKTOP-NEW/jichen.huang
```

Same host with a different `DSH_HOME` (an in-place rehearsal, two environments on one box) is allowed and
labelled as such; same host and same `DSH_HOME` is refused. Bundles exported before 0.6.0 have no such
field, and apply says the direction cannot be checked instead of pretending it passed.

Those three fields are **all** that is recorded — no MAC address, no machine GUID, no disk serial. Those are
hardware fingerprints and a config-migration tool has no business collecting them.

## Usage

### Old machine: export

```
dshsync_export(profile="*", includeCredentials=true, credentialPassphrase="<a passphrase you will remember>", preview=true)
```

Run it once with `preview=true` (scan only, writes nothing); drop the flag to actually run once the plan looks right.

The resulting bundle:

```
dsh-sync-bundle/
  manifest.json          # format version, profile list, state-layer stats, warnings
  checksums.json         # sha256 of every file
  settings.yaml          # or settings.enc
  .credentials.yaml      # or .credentials.enc; requires includeCredentials
  AGENTS.md              # global instructions at the $DSH_HOME root
  profiles/<name>/       # package.json (link: already rewritten) / cordis.patch.yml /
                         #   cordis.yml / .npmrc / pnpm-workspace.yaml
                         #   .dsh-market/state.json (disabled plugins, groups, market region)
  plugins/<name>/        # source of every link: plugin (node_modules/.git excluded)
  state/
    sessions/            # session files (real files only; symlinks are not here)
    storages/            # workspace.json etc.
    skills/              # real files only; symlinks are not here
    attachments/         # attachment library
    background/          # custom backgrounds
    dsh-market/          # local market state
    llm-deepseek/        # model file index
    links.json           # symlink list: rel -> target (rebuilt on the target)
    sessions.json        # session index summary
  tools/dsync-helper.mjs
  apply.ps1  apply.sh    # zero-dependency fallback scripts
  APPLY.md
```

**Symlinks are recorded, not copied.** Once a bundle travels through zip / cloud drive / chat apps, symlinks get flattened or dropped outright; recording a list and rebuilding it survives even the crudest transport.

### Carry it over

Two ways, pick one.

**A. Straight over the LAN (recommended)** — no USB drive, no cloud drive, one command each side.

On the source, after exporting, serve the bundle:

```
dshsync_lan_host(bundleDir="D:/dsh-bundle")
```

It prints a 6-digit pairing code and a live progress page (`http://<source-ip>:38473/`), then **returns
immediately** — the service keeps running in the background, so the conversation is not blocked for minutes.

On the new machine:

```
dshsync_lan_pull(host="192.168.1.23", code="123456",
                 destDir="D:/incoming/dsh-sync-bundle",
                 workspaceRoot="E:/code")
```

That one call pairs, waits for you to click **accept** on the source machine's page, streams every file while
checking sha256, then runs `apply` and `verify` automatically. It all happens in the background: the local
progress page is at `http://127.0.0.1:38474/`, and `dshsync_lan_status(jobId="...")` reports where it stands.

**The pairing code is not authorization.** Knowing the code is not enough: the transfer starts only after
someone clicks accept on the source machine, and that button only works from the source machine itself —
anyone else opening the same address over the LAN gets a read-only page and never sees the code. Codes expire
in five minutes and cannot be used from a different machine (the same machine may reuse one, which is what
makes resuming work).

**Interrupted? Just run the same command again** — files already received with a matching hash are skipped.
Measured on loopback: 2516 files / 172 MB in 11 s (15.6 MB/s); the resume pass transferred 0 bytes.

Don't know the source IP? Run `dshsync_lan_discover()` on the new machine first: UDP broadcast (about a
second), falling back to a per-address scan (about three seconds) when broadcast is blocked, and it tells you
which layer blocked it.

**B. Copy it manually**

Copy the whole folder to the new machine (USB drive / cloud / LAN share all work).
Through `dsh-localsend`, send the directory tree with `localsend_smb_push`; note that its packer **skips symlinks** — this plugin's `links.json` mechanism exists precisely for that, so nothing is lost.

### New machine: land it

**When the bundle carries project directories, one `workspaceRoot` is all you need** — the recommended path when switching machines:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              workspaceRoot="E:/code",     # the project root you pick on this machine
              dryRun=true)                 # preview first
```

Session cwds, workspace paths and `skills` symlinks all move to `workspaceRoot/<name>`; no mappings needed.
The preview prints, item by item, which workspace lands where and which session cwds change — then run with
`dryRun=false`.

Without packaged workspaces (state only), supply mappings when paths differ, otherwise sessions point at
directories that do not exist:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              mappings=[{"from":"D:/deepseek","to":"E:/code"}],
              dryRun=true)
```

Mapping rules: **applied in order, first match wins, and a match must fall on a path-segment boundary** (`D:/deep` does not touch `D:/deepseek/...`). Do not invent "longest prefix wins" — with overlapping rules it resolves differently from the order you wrote.

**The target's `$DSH_HOME` may live wherever you like.** If it differs from the source machine's, internal symlinks (those pointing inside `$DSH_HOME`) are relocated from the source prefix to the target prefix, preserving their relative path, and the count is reported. Set it with `DSH_HOME`, or pass `dshHome` in the plugin config.

### New machine: verify

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

Eleven invariants, each reported PASS / FAIL / WARN:

| ID | Check |
|---|---|
| I1 | Every sha256 in the bundle matches |
| I2 | Both the session-folder count and the **log-file count** match the source (the latter catches "folder present, one log version lost") |
| I3 | Every session folder name equals the encoding of its header `cwd` |
| I4 | Session container structure intact (header decodes, frame chain complete); files already damaged on the source are copied verbatim and only WARN |
| I5 | `workspace.json` paths align verbatim with session cwds (orphans that already existed on the source are only WARN; orphans introduced by the migration are FAIL) |
| I6 | Symlinks rebuilt from the list (internal must succeed *and* resolve; external may be missing but must be visible) |
| I7 | Vendored plugin sources are intact in the bundle |
| I8 | The **workspace directories** behind each session cwd actually exist on the target (all green once `includeWorkspaces` is used; otherwise each missing one is listed — sessions show up but do not open) |
| I9 | The profile's `link:` dependencies resolve on the target; whether `node_modules` is installed |
| I10 | All 7 state parts landed, with file counts matching the source |
| I11 | Host runtime agreement (dsh version / platform / arch / node major); across `major.minor` the host denies plugins at startup |
| I12 | Packaged workspaces actually landed (checked only when you pass `workspaceRoot`; otherwise WARN, never a guess) |
| I11 | Host runtime matches (dsh version / platform / arch / node major). A cross-generation version gap makes plugins **denied at startup** |

`FAIL` means: **dsh cannot see this state.** Not "might be a bit off" — it is definitely out of sync.

I11 is a WARN rather than a FAIL: upgrading dsh while migrating is legitimate and must not be blocked.
But it guards the nastiest failure of all — the host runs a peer-compatibility ruling at startup, and a
version mismatch leaves plugins `stays installed but startup denies it`: every file present, every sha256
correct, I1–I12 green, **and the plugin list empty**. Without this line you would blame dsh-sync for
losing your plugins.

Versions are never guessed: if either side is unavailable the check says "needs manual confirmation"
instead of quietly passing.

## Tools

| Tool | Runs on | Description |
|---|---|---|
| `dshsync_export` | Source | Export the bundle. The source is **read-only** (copy only, never modifies config) |
| `dshsync_apply` | Target | Land it + workspace unpack + path remapping + session rewrite + symlink rebuild. Supports `dryRun` |
| `dshsync_verify` | Target | Verify consistency, item by item |
| `dshsync_lan_host` | Source | Serve the bundle over the LAN; prints the pairing code and progress page. `action="renew"` reissues a code, `action="stop"` shuts it down |
| `dshsync_lan_discover` | Target | Find machines serving a bundle. UDP broadcast first, per-address scan as fallback |
| `dshsync_lan_pull` | Target | Pair → wait for the click → receive → apply → verify, one command. Runs in the background, returns a jobId |
| `dshsync_lan_status` | Both | Progress, speed, ETA, and the final apply/verify report |

## Configuration (settings namespace `sync`)

| Key | Default | Description |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home (on the target too, so you can place it anywhere) |
| `profile` | `web` | Profile to export by default; `"*"` = all |
| `outDir` | temp dir `dsh-sync-bundle` | Bundle output directory |
| `includeCredentials` | `false` | Whether to include `.credentials.yaml` (real secrets) |
| `credentialPassphrase` | empty | ≥6 chars: move settings + credentials **encrypted** (recommended) |
| `includePlugins` | `true` | Whether to vendor the source of `link:` plugins |
| `includeState` | `true` | Whether to carry sessions / storages / skills (turn it off and you get a usable-but-empty environment) |
| `includeWorkspaces` | `false` | Package the project directories sessions point at. Turn it on for a machine switch |
| `includeGit` | `true` | Keep `.git` inside packaged workspaces (complete repositories); off only to save size |
| `workspaceRoot` | empty | On the **target**: the project root that decides where everything lands |

## Credential strategy (important)

Three routes, in order of preference:

1. **Encrypted transfer (recommended)**: supply `credentialPassphrase`. Settings and credentials enter the bundle as AES-256-GCM ciphertext (scrypt-derived key, per-bundle random salt/iv, authenticated tag). A wrong passphrase or a tampered file fails at decryption rather than yielding wrong plaintext. Plaintext secrets are thus **neither lost nor exposed**, and you need not re-enter every plugin key after switching machines.
2. **No credentials (default)**: `.credentials.yaml` is not exported; plaintext secret lines in settings are stripped with a warning.
3. **Plaintext carry (not recommended)**: `includeCredentials=true` with no passphrase — the bundle holds naked secrets; use only over a trusted channel and delete it immediately after.

Additional rules:
- Plaintext detection: a `*Env` field must be a valid reference name (`^[A-Za-z_][A-Za-z0-9_]*$`), otherwise it counts as plaintext; long values in `key/token/secret/password`-like fields also raise a warning.
- Tools **only ever output redacted previews** (prefix + length), never the full secret.

## Safety design

| Mechanism | Effect |
|---|---|
| **Read-only export** | Export only copies; it never modifies the source machine's config |
| **Whole-bundle sha256** | Verified before apply; a broken transfer stops before the first byte is written |
| **Backup before overwrite** | Each item backed up to `$DSH_HOME/.dsh-sync-backup-<timestamp>/`, preserving relative paths |
| **Atomic swap** | Session rewrites go through tmp + rename; an interrupted run never leaves half a file |
| **Lossy operations need explicit consent** | Sessions with a torn frame chain are **refused** (a torn tail may be self-healing; forcing a write would break it) |

The LAN layer adds five more, all because "someone on the same subnet" is not a trusted party by default:

| Mechanism | Effect |
|---|---|
| **Accept can only be clicked on the source machine** | `/decide` checks whether the request's source address belongs to a local interface; anyone else opening the page over the LAN gets a read-only view |
| **The pairing code never leaves the local machine** | The page renders in two shapes; the remote snapshot does not contain `pair.code` at all |
| **Single use + 5 minutes + lock after 5 wrong tries** | Six digits, five attempts, so the guessing odds are 5e-6; after locking even the correct code is refused until a new one is issued |
| **Private source addresses only** | Anything outside 10/8, 172.16/12, 192.168/16, 169.254/16 and loopback gets a 403 — this catches the configuration accident of a desktop machine sitting directly on the public internet |
| **Nothing lands until it is verified** | Files are written as `*.dshsync-part` and renamed only after both sha256 and length match; every path in the stream is resolved and confirmed to stay inside the destination |

"Single use" has one deliberate exemption: **the same machine may reuse a code** (a different source is still
refused). This came out of measurement — the code is marked used on the first pairing, but "the transfer broke
halfway, run it again" needs to pair once more. Without the same-source exemption, resuming is simply
unusable from the user's point of view. A leaked code always arrives from a different address, so it stays
blocked.

## Known limitations

- **The target must rebuild dependencies**: `node_modules` does not travel. After landing, run `pnpm install` (or `dsh plugin add`) once on the target, otherwise dsh will not start — verify reports this as a WARN on I9, so you are never left thinking it is done.
- **The target needs node ≥22.15** for built-in zstd; otherwise sessions are not migrated (and it says so loudly, never silently).
- **Project directories are not packaged by default**: a session's cwd points outside `$DSH_HOME`. Without
  `includeWorkspaces` those directories do not travel and the target lists the conversations but opens them
  empty (I8 names each missing directory). With it, they are packaged by root (`.git` kept, `node_modules`
  excluded) and land under one `workspaceRoot`; an existing non-empty landing directory is **refused** unless
  you pass `overwriteWorkspaces=true`. Expect the bundle to grow from hundreds of MB to GBs — run
  `preview=true` first to see the candidates and their sizes.
- **The host version is read from `dsh-runtimes/<runtime>/runtime.json` (`desktopVersion`)**, which is not the
  installer version — after an app upgrade without reinstalling the runtime it can lag by a patch, so a
  difference within the same `major.minor` is only a soft warning. Across `major.minor`, plugins may be denied
  at startup and need an exact-version waiver in the plugin manager. If no version can be resolved at all
  (neither `dsh-runtimes` nor a `dsh` command), it reports "needs manual confirmation" rather than guessing.
- **Workspace code is not inside `$DSH_HOME`**: session cwds point at project directories (separate repos). If the target lacks them, sessions list but will not open — I8 names every missing directory. To reuse the same history, copy those repos too, or point `mappings` at equivalent directories on the target.
- **`link:` dependencies are rewritten automatically**: they point at `$DSH_HOME/plugins/<name>` relatively, so a different location still works. Only **unvendored** ones (missing source, or `includePlugins=false`) keep the source path, and the report calls them out.
- **External symlinks need matching paths on the target**: `skills/` links pointing outside `$DSH_HOME` fail to rebuild when that directory does not exist, and are **reported honestly** rather than silently repointed.
- **Git dependencies need build approval**: a `github:` dependency added for the first time on the target may be rejected by pnpm ≥10's build gate.
- **`pnpm-lock.yaml` is not moved**: it contains the source machine's absolute `link:` paths.
- **A missing `settings.yaml` passes silently**: this machine simply has no such file (only historical `.bak`s), and export will not invent one. To confirm settings travelled, check the `homeFiles` list in the export report.
- **LAN progress is a browser page, not a panel inside DSH**: the host tool interface has no streaming channel
  (`execute()` returns once, at the end), so real-time progress in the conversation is impossible by design.
  Progress therefore goes over local HTTP + SSE.
- **Transfer job state lives in memory**: after a plugin reload (config change, upgrade, DSH restart) old
  jobIds are gone. Files already received stay on disk and the next `dshsync_lan_pull` resumes by hash rather
  than starting over. Do not quit DSH while a transfer runs.
- **Windows shows a firewall prompt on first listen**; allow it on the "private network" profile. Choosing
  "public" or cancelling means the other machine cannot connect (the error message points here). When UDP
  38472 is blocked, `dshsync_lan_discover` falls back to a per-address scan — a couple of seconds slower.

## Development and testing

```bash
npm run check   # node --check on every source file
npm test        # 149 tests: pure functions + zstd frames + session migration + workspace packing + host runtime fingerprint + LAN transfer + full export→apply→verify
npm run verify
```

All tests use **synthetic data** (self-built zstd multi-frame files, temp dshHomes); they never read a real
`$DSH_HOME` and never touch an external network. The LAN group does start a real HTTP server, but only on
`127.0.0.1`.
Negative cases prove the checks actually fail (tamper with the bundle → apply refuses and writes nothing;
corrupt a cwd → verify reports FAIL; open a stream before confirmation → 403; a frame carrying
`../../.ssh/...` → rejected).

## License

MIT.

An original JavaScript implementation with zero third-party runtime dependencies (Node built-ins only).
A few public MIT-licensed projects were consulted during design; what was referenced are **design conclusions**, not source code. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
