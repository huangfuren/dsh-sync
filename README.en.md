# dsh-sync

English | [中文](README.md)

Move **an entire machine's dsh state** to another machine. After switching, the new machine is not merely "working" — it is **the same as the old one**: same settings, same plugins, same conversation history, same workspace list, same skills links.

Two layers, and missing either one is not "identical":

| Layer | Contents | What breaks without it |
|---|---|---|
| **Declaration layer** | `settings.yaml`, credentials (optional), home-level `cordis.patch.yml`, `AGENTS.md`, each profile's `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / `.dsh-market/state.json` (disabled plugins, custom groups, market region), the source of every `link:` plugin | dsh will not start / **all plugins lost** / disabled-state and grouping reset / agent behaves differently |
| **State layer** | `sessions/`, `storages/`, `skills/`, `attachments/`, `background/`, `dsh-market/`, `llm-deepseek/` | dsh runs, but **every conversation is gone, workspace list empty, skills empty, attachments and backgrounds gone** |

A profile's `package.json` is the truth about "the plugin situation": it decides both what gets installed (`dependencies`) and what actually loads (`dsh.profile.bundles`). It **must** travel — otherwise the plugin sources sit in `plugins/` with nothing to load them. And it cannot be copied verbatim: its `link:` entries are source-machine absolute paths, so export rewrites them to `link:../../plugins/<name>` pointing at the vendored copy, which holds wherever the target puts `$DSH_HOME`.

Rebuildable artifacts are **not** moved (moving them is actively wrong): `node_modules` (reinstalled from `package.json`), `dsh-runtimes` (rebuilt with the host installer), `cache`, `logs`, `.anonymous-user-id`.

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

Copy the whole folder to the new machine (USB drive / cloud / LAN all work).
Through `dsh-localsend`, send the directory tree with `localsend_smb_push`; note that its packer **skips symlinks** — this plugin's `links.json` mechanism exists precisely for that, so nothing is lost.

### New machine: land it

When paths differ (different drive letter or user name) you must supply mappings, otherwise sessions will point at directories that do not exist:

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              mappings=[{"from":"D:/deepseek","to":"E:/code"}],
              dryRun=true)      # preview first
```

Once the preview looks right, run again with `dryRun=false`. When both machines have an identical layout, `mappings` can be omitted.

Mapping rules: **applied in order, first match wins, and a match must fall on a path-segment boundary** (`D:/deep` does not touch `D:/deepseek/...`). Do not invent "longest prefix wins" — with overlapping rules it resolves differently from the order you wrote.

**The target's `$DSH_HOME` may live wherever you like.** If it differs from the source machine's, internal symlinks (those pointing inside `$DSH_HOME`) are relocated from the source prefix to the target prefix, preserving their relative path, and the count is reported. Set it with `DSH_HOME`, or pass `dshHome` in the plugin config.

### New machine: verify

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

Ten invariants, each reported PASS / FAIL / WARN:

| ID | Check |
|---|---|
| I1 | Every sha256 in the bundle matches |
| I2 | Both the session-folder count and the **log-file count** match the source (the latter catches "folder present, one log version lost") |
| I3 | Every session folder name equals the encoding of its header `cwd` |
| I4 | Session container structure intact (header decodes, frame chain complete); files already damaged on the source are copied verbatim and only WARN |
| I5 | `workspace.json` paths align verbatim with session cwds (orphans that already existed on the source are only WARN; orphans introduced by the migration are FAIL) |
| I6 | Symlinks rebuilt from the list (internal must succeed *and* resolve; external may be missing but must be visible) |
| I7 | Vendored plugin sources are intact in the bundle |
| I8 | The **workspace directories** behind each session cwd actually exist on the target (workspace code is not inside `$DSH_HOME`; without it sessions list but will not open) |
| I9 | The profile's `link:` dependencies resolve on the target; whether `node_modules` is installed |
| I10 | All 7 state parts landed, with file counts matching the source |

`FAIL` means: **dsh cannot see this state.** Not "might be a bit off" — it is definitely out of sync.

## Tools

| Tool | Runs on | Description |
|---|---|---|
| `dshsync_export` | Source | Export the bundle. The source is **read-only** (copy only, never modifies config) |
| `dshsync_apply` | Target | Land it + path remapping + session rewrite + symlink rebuild. Supports `dryRun` |
| `dshsync_verify` | Target | Verify consistency, item by item |

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

## Known limitations

- **The target must rebuild dependencies**: `node_modules` does not travel. After landing, run `pnpm install` (or `dsh plugin add`) once on the target, otherwise dsh will not start — verify reports this as a WARN on I9, so you are never left thinking it is done.
- **The target needs node ≥22.15** for built-in zstd; otherwise sessions are not migrated (and it says so loudly, never silently).
- **Workspace code is not inside `$DSH_HOME`**: session cwds point at project directories (separate repos). If the target lacks them, sessions list but will not open — I8 names every missing directory. To reuse the same history, copy those repos too, or point `mappings` at equivalent directories on the target.
- **`link:` dependencies are rewritten automatically**: they point at `$DSH_HOME/plugins/<name>` relatively, so a different location still works. Only **unvendored** ones (missing source, or `includePlugins=false`) keep the source path, and the report calls them out.
- **External symlinks need matching paths on the target**: `skills/` links pointing outside `$DSH_HOME` fail to rebuild when that directory does not exist, and are **reported honestly** rather than silently repointed.
- **Git dependencies need build approval**: a `github:` dependency added for the first time on the target may be rejected by pnpm ≥10's build gate.
- **`pnpm-lock.yaml` is not moved**: it contains the source machine's absolute `link:` paths.
- **A missing `settings.yaml` passes silently**: this machine simply has no such file (only historical `.bak`s), and export will not invent one. To confirm settings travelled, check the `homeFiles` list in the export report.

## Development and testing

```bash
npm run check   # node --check on every source file
npm test        # 68 tests: pure functions + zstd frames + session migration + full export→apply→verify
npm run verify
```

All tests use **synthetic data** (self-built zstd multi-frame files, temp dshHomes); they never read a real `$DSH_HOME` and never touch the network.
Negative cases prove the checks actually fail (tamper with the bundle → apply refuses and writes nothing; corrupt a cwd → verify reports FAIL).

## License

MIT.

An original JavaScript implementation with zero third-party runtime dependencies (Node built-ins only).
A few public MIT-licensed projects were consulted during design; what was referenced are **design conclusions**, not source code. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
