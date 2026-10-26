# dsh-sync

English | [中文](README.md)

Move **an entire machine's dsh state** to another machine. After switching, the new machine is not merely "working" —
it is **the same as the old one**: same settings, same plugins, same conversation history, same workspace list, same skills links.

- **Three layers travel together**: declaration (settings / credentials / plugin sources) → state (sessions / workspace records / skills / attachments) → optionally the project directories themselves.
- **Sessions cannot be corrupted**: only the `cwd` in the first frame of each zstd multi-frame log is rewritten; every event frame is left byte for byte.
- **It checks as it lands**: 15 checks report PASS / FAIL / WARN individually — never "should be fine".
- **It can migrate twice**: from the second time on it lists the disagreements first and stops before writing anything.
- **It can be undone**: `dshsync_undo` rolls back one import from the landing ledger, skipping files changed since.

## Install

```sh
dsh plugin --profile web add github:huangfuren/dsh-sync
```

Use `desktop` instead of `web` on the desktop app. **Install on both machines** — the sender and the landing side live in
the same package — and **restart dsh** (9 tools and 3 same-origin routes register at startup). Also on the market as `dsh-sync`.

Requires node ≥ 22.19 (per `engines`); session rewriting needs the built-in zstd (22.15+ or 24). Both machines must be on the same subnet.

## Migration steps

**Both machines run the same plugin, but they do different jobs**:

| | Old machine (source) | New machine (target) |
|---|---|---|
| You say | "migrate this machine's dsh to another one" | "pull the old machine's bundle over" |
| It does | packages and starts the sender, **touching nothing on this machine** | receives, writes, self-checks |
| Configuration needed | **none** | **none** |

The old machine **needs no configuration at all**: install the plugin, restart dsh, then say one sentence in the conversation.

```
old machine   ① one sentence: package + start the sender
                  ↓ same LAN
new machine   ② one sentence: pull with the pairing code, lands and verifies itself
                  ↓
              ③ quit dsh completely and reopen   →   ④ verify the result
```

### ① Old machine: one sentence

> Migrate this machine's dsh to another machine: take the project code too, put the bundle in `D:/sync`,
> use `abc123` as the passphrase, and leave it open for the new machine to pull.

That sentence actually decides four things — **leave one out and you get the default**:

| Better to say | Argument | If you don't |
|---|---|---|
| take the project code too | `includeWorkspaces=true` | **only settings and sessions travel; sessions open as empty folders** |
| put the bundle in `D:/sync` | `outDir` | it lands in the system temp dir (`%TEMP%\dsh-sync-bundle`), which may get cleared |
| leave it open for the new machine | `autoHost=true` | it only packages; no sender, so the new machine cannot connect until you ask again |
| use `abc123` as the passphrase | `credentialPassphrase` | **plaintext keys are stripped and credentials are left out**, so the new machine re-enters API keys |

Without a passphrase, plaintext key lines in `settings.yaml` are removed with one warning each — intentional, not lost data.

dsh first reports what it would do (plugins, session count, workspace candidates with sizes) and asks whether to continue —
that step is a preview and **writes nothing**. Once confirmed it packages, then prints a **6-digit pairing code** and a progress URL.

The resulting `D:/sync` looks like this:

```
manifest.json        inventory, checked item by item before landing
state/               sessions / workspace records / skills / attachments
plugins/             sources of your link: plugins
apply.ps1 一键恢复.bat   scripts that land it even without the plugin
```

### ② New machine: one sentence

Install the plugin, restart dsh, then:

> Pull the old machine's bundle over the LAN — the pairing code is `123456`, put the project code in `E:/code`.

Prefer clicking? **Settings → Built-in plugins → dsh-sync 迁移** → "scan" → pick the old machine → enter the 6-digit
code → "start migration". Same thing.

It verifies every file by sha256 → lands → verifies, all in one go. **Interrupted? Just say "continue"** — files already
received with a matching hash are skipped.

> **`E:/code` must be where you really keep projects on the new machine** — session paths are rewritten under it, and
> the wrong location means sessions cannot open their files. Omit it and it stops before writing rather than guessing.
>
> If the two machines are not on the same subnet: copy the whole `D:/sync` directory to the new machine and say
> "land this directory into `E:/code`" — everything else is identical.

### ③ New machine: quit dsh completely, then reopen

On desktop, **quit from the tray icon** (closing the window only hides it) and make sure the process is gone before
reopening — only then does the host rebuild dependencies from the new configuration and register plugins and tools.

After it reopens, check three things:

1. **Plugin list**: are your plugins there? If empty, click "reinstall / repair" once in the plugin manager and restart.
2. **Session list**: they open, and the files inside really exist (not an empty folder).
3. **Do not change any setting yet** — the host may flush the config it holds in memory over what was just landed.

### ④ Verify

> Verify this migration.

15 checks, each `PASS` / `FAIL` / `WARN`. `FAIL` means **dsh cannot see this state** — not "might be a bit off". A
`WARN` on `I9 profile 依赖` means dependencies are not installed yet; a restart usually settles it.

Do not delete `D:/sync` (old machine) or the received bundle (new machine) before verification passes — both verify and
undo still read it.

### When something goes wrong

| Symptom | Cause | What to do |
|---|---|---|
| The new machine says the bundle came from itself | the machines are swapped, or you ran it twice on one | say it on the other machine. Add `allowSameMachine=true` only for an in-place restore after reinstall |
| Landing says the workspace directory exists and is not empty | a previous landing stopped halfway | confirm nothing there is worth keeping, then say "overwrite the existing directory" (`overwriteWorkspaces=true`) |
| Sessions are listed but open empty | project code was not packaged | re-package on the old machine with `includeWorkspaces`, or accept it and clone the code |
| Decryption fails | wrong passphrase, or the bundle was modified | the passphrase cannot be guessed — re-package, and write it down this time |
| Plugin list is empty | dependencies were not rebuilt | plugin manager "reinstall / repair" → restart |
| You want this landing undone | — | say "undo this migration" — it previews first, and files used after the landing are skipped and listed, never overwritten with the older snapshot |
| No card in the UI at all | the plugin is not installed or dsh never restarted | `dsh plugin list` first, then quit dsh fully and reopen |

## Migrating a second time

Once the new machine has been in use, the plugins it installed, the workspaces it added and the settings it changed are
**not in the old snapshot** — a plain overwrite destroys them. So from the second time on, say "don't overwrite what I
added on this machine": it **compares first and stops**, listing every disagreement.

Then answer against that list, for example:

> Keep this machine's `dsh-outline` plugin, use the old machine's settings, and only add the sessions I'm missing.

| Kind | Values |
|---|---|
| Plugins | keep this machine's (`keep-target`) / take the old one's (`take-source`) |
| Workspaces | keep this machine's / take the old one's |
| Settings | this machine's (`target`) / the old one's (`source`) |
| Sessions | leave alone (`skip`) / only add missing ones (`append-missing`) / take the old / take this one's |

**Anything you don't mention is not decided for you** — better one extra look than a silent guess. On a first migration
the target is empty, so this sentence is unnecessary.

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

**What travels**: `settings.yaml`, credentials (see below), each profile's plugin declarations and the sources of your
`link:` plugins, every past session (paths rewritten only), workspace records, `skills`, attachments, and optionally the
project code. **What does not**: `node_modules`, `dsh-runtimes`, `cache`, `logs` — the target regenerates those on
restart. That is why a bundle is usually a hundred-odd MB and only reaches GBs with project code.

## Configuration

**It runs without any configuration.** To change the defaults go to **Settings → Built-in plugins → dsh-sync migrate**;
four fields are editable: `profile` (`*` = all), `outDir`, `includePlugins`, `includeState`. Everything else is per-call:

| Argument | Default | Meaning |
|---|---|---|
| `includeCredentials` | `false` | Carry `.credentials.yaml` (real keys) |
| `credentialPassphrase` | empty | ≥6 chars: settings and credentials travel **encrypted** (AES-256-GCM) |
| `includeWorkspaces` | `false` | Package the project directories sessions open |
| `includeGit` | `true` | Keep `.git` when packaging workspaces |
| `workspaceRoot` | empty | Project root on the target machine |
| `dshHome` | `$DSH_HOME` / `~/.dsh` | Harness home |

The first two are **deliberately not in the form**: one would put plaintext credentials into the bundle with a single
click, the other would write the passphrase in clear text into `settings.yaml`.

**Key policy**: prefer a passphrase (a wrong passphrase or a modified file fails to decrypt); by default credentials are
left out and plaintext key lines are stripped with a warning; plaintext carrying is only for a trusted channel, and delete
the bundle afterwards.

## Limitations

- **`node_modules` does not travel**: the target rebuilds dependencies (desktop: quit and reopen; web: `pnpm install` or `dsh plugin add`).
- **A recent node on the target**: the package requires ≥ 22.19, and session rewriting needs the built-in zstd (22.15+ / 24). Without it sessions are not migrated and the report says so — never a silent skip.
- **Workspace code is not packaged by default**: without `includeWorkspaces` sessions list but do not open; with it the
  size goes from hundreds of MB to GBs. An existing non-empty target directory is **refused** unless you allow overwriting.
- **External symlinks need a matching path**: links under `skills/` pointing outside `$DSH_HOME` are reported as WARN (I6b)
  when the target lacks that directory — the target is never silently changed.
- **Across host `major.minor`** the host may deny plugins at startup; grant the exact-version waiver per plugin.
- **Transfer job state lives in memory**: reloading the plugin or restarting dsh loses the job; rerun the pull and it resumes by hash.
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
