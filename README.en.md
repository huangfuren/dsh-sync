# dsh-sync

English | [中文](README.md)

Move **an entire machine's dsh state** to another machine. After switching, the new machine is not merely "working" —
it is **the same as the old one**: same settings, same plugins, same conversation history, same workspace list, same skills links.

- **Three layers travel together**: declaration (settings / credentials / plugin sources) → state (sessions / workspace records / skills / attachments) → optionally the project directories themselves.
- **Sessions cannot be corrupted**: only the `cwd` in the first frame of each zstd multi-frame log is rewritten; every event frame is left byte for byte.
- **It checks as it lands**: 15 checks report PASS / FAIL / WARN individually — never "should be fine".
- **It can migrate twice**: `merge=true` lists the disagreements first and stops before writing anything.
- **It can be undone**: `dshsync_undo` rolls back one import from the landing ledger, skipping files changed since.

Two ways to move it: carry the bundle by hand (export → copy → land → verify), or go **straight over the LAN** (pair, then one command pulls, lands and verifies).

> **Direction**: the machine that runs `dshsync_export` is the **source (old)**; the one that runs
> `dshsync_apply` / `dshsync_lan_pull` is the **target (new)**. Which tool you run decides it — nothing is guessed.

## Install

```sh
dsh plugin --profile web add github:huangfuren/dsh-sync
```

Use `desktop` instead of `web` on the desktop app. **Install on both machines** — the sender and the landing side live in
the same package — and **restart dsh** (9 tools and 3 same-origin routes register at startup). Also on the market as `dsh-sync`.

Requires node ≥ 22.19 (per `engines`); session rewriting needs the built-in zstd (22.15+ or 24). LAN transfer needs both machines on the same subnet.

## Quick start

Three steps: export on the old machine → carry it over → land on the new one.

### 1. Export (old machine)

```
dshsync_export(profile="*", includeWorkspaces=true, credentialPassphrase="<passphrase>", preview=true)
```

`preview=true` only scans and writes nothing; drop it to run for real. Pick workspaces by name
(`workspaces=["dsh-chat"]`); omit it to take all. On the real run add `autoHost=true` — the bundle is followed by a
LAN sender started **in place**, with the pairing code and progress URL in the same output.

### 2. Carry it over

**A. Over the LAN (recommended)** — the sender is already up (`autoHost`, or `dshsync_lan_host()` on its own). On the new machine:

- in the card: Settings → Built-in plugins → **dsh-sync migrate** → scan → pick a machine → enter the code → start;
- or in the conversation: `dshsync_lan_discover()`, then
  `dshsync_lan_pull(deviceId="1", code="123456", destDir="...")`.

Each file is checked by sha256 → `apply` runs automatically (including dependency reinstall) → `verify` runs automatically.
**Interrupted? Run the same command again** — files already received with a matching hash are skipped.

**B. By hand** — copy the directory (USB drive, shared folder). The bundle ships `apply.ps1` / `apply.sh`, so a machine
without the plugin can still land the declaration and state layers — but it will **not** unpack workspace code or rewrite sessions.

### 3. Land (new machine)

```
dshsync_apply(bundleDir="D:/incoming/dsh-sync-bundle",
              workspaceRoot="E:/code",     # your project root on the new machine
              dryRun=true)                 # dry run first
```

When the bundle carries workspace code, **one `workspaceRoot` is enough**: session cwds, workspace paths and skills
symlinks all move under it. Moving `.dsh` alone? Pass `mappings=[{"from":"D:/deepseek","to":"E:/code"}]`.

**After landing**: quit dsh completely (tray on desktop) and reopen so the host rebuilds dependencies from the new
`package.json`; if the plugin list is empty, use "reinstall / repair" once and restart; **do not touch settings in the UI yet** —
the host may flush what it holds in memory over the files just landed.

### Verify

```
dshsync_verify(bundleDir="D:/incoming/dsh-sync-bundle")
```

15 checks, one verdict each. `FAIL` means **dsh cannot see this state** — not "might be a bit off".

## Migrating a second time

Once the target has been in use, the plugins it installed, the workspaces it registered and the settings it changed are
**not in the source snapshot** — a plain overwrite destroys them. So from the second migration on, add `merge=true`: it
diffs the bundle against the machine as it is now and **stops before writing while any item is undecided**.

Four kinds of disagreement, each resolved through `resolutions`:

| Kind | Values |
|---|---|
| `plugins` | `keep-target` (keep what this machine installed) / `take-source` |
| `workspaces` | `keep-target` / `take-source` |
| `settings` | `target` / `source` |
| `sessions` | `skip` / `append-missing` (only the logs this machine lacks) / `prefer-source` / `prefer-target` |

**Undecided items have no default** — better one extra look than a silent guess. For a first migration the target is
empty, so skip merge and just overwrite.

## Tools

| Tool | Runs on | What it does |
|---|---|---|
| `dshsync_export` | source | Writes the bundle (source stays read-only). `autoHost=true` starts the sender right after |
| `dshsync_apply` | target | Land + unpack workspaces + path mapping + session rewrite + symlink rebuild + dependency reinstall. Supports `dryRun`, `merge` |
| `dshsync_undo` | target | Rolls back the last apply from the ledger: deletes what it created, restores what it overwrote. Changed files are skipped |
| `dshsync_verify` | target | Item-by-item consistency check |
| `dshsync_lan_host` | source | Starts the sender, prints the pairing code and progress URL. `action="renew"` re-codes, `"stop"` stops |
| `dshsync_lan_discover` | target | Finds senders on the LAN (UDP broadcast, address scan as fallback) |
| `dshsync_lan_pull` | target | Pair → receive → land → verify in one command; runs in the background, returns a jobId |
| `dshsync_lan_status` | both | Progress, rate and the final result |
| `dshsync_remap` | either | For when directories moved *after* a migration: remaps five landing points in place, copies nothing |

## Configuration

**Settings → Built-in plugins → dsh-sync migrate.** Four fields are editable there: `profile` (`*` = all), `outDir`,
`includePlugins`, `includeState`. The rest are per-call arguments:

| Argument | Default | Meaning |
|---|---|---|
| `includeCredentials` | `false` | Carry `.credentials.yaml` (real keys) |
| `credentialPassphrase` | empty | ≥6 chars: settings and credentials travel **encrypted** (AES-256-GCM) |
| `includeWorkspaces` | `false` | Package the project directories sessions open |
| `includeGit` | `true` | Keep `.git` when packaging workspaces |
| `workspaceRoot` | empty | Project root on the target machine |
| `dshHome` | `$DSH_HOME` / `~/.dsh` | Harness home |

The first two are **deliberately not in the form**: one would put plaintext keys into the bundle with a single click, the
other would write the passphrase in clear text into `settings.yaml`.

**Key policy**: prefer `credentialPassphrase` (a wrong passphrase or a modified file fails to decrypt); by default
credentials are left out and plaintext key lines are stripped with a warning; plaintext carrying is only for a trusted
channel, and delete the bundle afterwards.

## Limitations

- **`node_modules` does not travel**: the target rebuilds dependencies (desktop: quit and reopen; web: `pnpm install` or `dsh plugin add`).
- **A recent node on the target**: the package requires ≥ 22.19, and session rewriting needs the built-in zstd (22.15+ / 24). Without it sessions are not migrated and the report says so — never a silent skip.
- **Workspace code is not packaged by default**: without `includeWorkspaces` sessions list but do not open; with it the
  size goes from hundreds of MB to GBs. An existing non-empty target directory is **refused** unless `overwriteWorkspaces=true`.
- **External symlinks need a matching path**: links under `skills/` pointing outside `$DSH_HOME` are reported as WARN (I6b)
  when the target lacks that directory — the target is never silently changed.
- **Across host `major.minor`** the host may deny plugins at startup; grant the exact-version waiver per plugin.
- **Transfer job state lives in memory**: reloading the plugin or restarting dsh loses the `jobId`; rerun
  `dshsync_lan_pull` and it resumes by hash.
- **Windows asks about the firewall on first listen** — allow "private networks". The progress page is a browser page, not a DSH panel.

## Development

```bash
npm run check   # node --check on every source file
npm test        # 261 tests
```

Tests use synthetic data (self-built zstd multi-frame files, a temporary dshHome); they never read your real `$DSH_HOME`
or reach the network, and the LAN cases stay on `127.0.0.1`.

## License

MIT. Original JavaScript, zero third-party runtime dependencies (Node built-ins only). Several public MIT projects informed
the design — their conclusions, not their code; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
