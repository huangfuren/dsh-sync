# dsh-sync

English | [中文](README.md)

Move **your local dsh configuration** to another machine — switch computers without stopping work.
The receiving machine **does not need dsh-sync installed first**: the bundle ships a self-installing script and a zero-dependency helper, so one run is enough to keep using dsh.

## Switching machines in three steps (no commands to remember)

**Old computer** — double-click `一键导出.bat` in the plugin directory, answer two questions (where to save, and a passphrase), and you get a folder.

**Carry it over** — copy the whole folder to the new computer (USB drive / cloud / LAN all work).

**New computer** — double-click `一键恢复.bat` inside the folder (if it will not open, use `RESTORE.bat` — same content), follow the prompts, and restart dsh.

Wizard order: check node / pnpm / dsh → **confirm the restore target directory** (default `~/.dsh`, editable) → verify the bundle was copied intact →
**show you what it is about to do first** → ask for the passphrase → execute. Any failing step rolls back automatically; you can cancel at any point and never end up half-done.

### Three safety rails

| Rail | Effect |
|---|---|
| **Read-only export** | Export only copies; it never modifies the source machine's config (proven by a test that byte-compares the entire `DSH_HOME`) |
| **Ask before overwriting** | If the target directory already holds config, you must type `yes` to continue; old files are first backed up to `.dsh-sync-backup-<timestamp>` |
| **Version warning** | Records the source machine's dsh version and warns explicitly if it differs from the target (no guessing, no silent pass) |

Also: whole-bundle sha256 verification (a broken transfer is refused), bad arguments or a wrong passphrase **never** corrupt the target, and failures roll back automatically.
For non-interactive runs, add `-Force` (ps1) / `--force` (sh) to skip the overwrite prompt.

> The new computer must first have the `dsh` command available (`node -v`, `pnpm -v`, and `dsh --version` must all output something).
> If dsh is not installed yet, that is fine: the wizard asks whether to **restore only settings and credentials first**, and you can run it again later to add the plugins.

Zero third-party runtime dependencies (Node built-ins plus the `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` peers only).

## Why you cannot just copy `~/.dsh`

| `$DSH_HOME` content | Copyable as-is? | Reason |
|---|---|---|
| `settings.yaml` | ⚠️ Copyable but may hold plaintext secrets | Config should carry **references**, not secrets; when plaintext is found it is stripped by default (or the whole file is encrypted — see below) |
| `.credentials.yaml` | ⚠️ Copyable but holds **real secrets** | **Excluded** by default; when included it should travel encrypted |
| `profiles/*/package.json` | ⚠️ Needs rewriting | `link:` entries are **absolute paths** and break when the layout differs |
| `profiles/*/node_modules` | ❌ **Never copy** | Contains native binaries (`pty.node` / `conpty.node`) bound to OS/arch/Node ABI; junctions are bound to absolute paths |
| `sessions/` | ❌ Not recommended | Directory names encode the workspace's absolute path |
| `storages/` `background/` `.anonymous-user-id` | ❌ No | Machine runtime state / machine identity |

| `skills/` | ⚠️ Usually not needed | Mostly junctions pointing into workspace directories; dsh rebuilds them when you open that workspace |

**Conclusion: sync the "declarations" and let the target machine "rebuild".**

Each of these is inventoried during export, with counts and reasons written into the manifest / `APPLY.md`, and shown again when apply finishes — a migration tool's worst sin is silent loss: the user thinks everything moved, with no way to notice what did not.

## Usage

To switch machines, move all profiles:

```
dshsync_export(profile="*", includeCredentials=true, credentialPassphrase="<a passphrase you will remember>")
```

A single profile: `profile="web"`.

The resulting bundle:

```
dsh-sync-bundle/
  manifest.json          # format version 2, profile list, dependency classification, warnings
  checksums.json         # sha256 of every file (including the manifest itself)
  settings.yaml          # or settings.enc (when moving encrypted)
  .credentials.yaml      # or .credentials.enc; requires includeCredentials
  profiles/<name>/       # cordis.patch.yml / .npmrc / pnpm-workspace.yaml
  plugins/<name>/        # the **source** of every link: plugin (node_modules/.git excluded)
  tools/dsync-helper.mjs # zero-dependency helper for verification and decryption on the target
  apply.ps1  apply.sh    # Windows / macOS·Linux self-install scripts
  APPLY.md
```

Transfer (the bundle is a directory; handing it to dsh-localsend packs it automatically):

```
localsend_smb_push(target="10.0.0.30", share="SharedFolder", destDir="dsh-sync", files=["<bundleDir>"])
# or, with nothing to install on the receiver:
localsend_share(files=["<bundleDir>"])
```

Run on the target machine (dsh + node + pnpm + network required):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\apply.ps1 -WhatIf     # preview the plan, touching no files
.\apply.ps1             # actually run after confirming
```

macOS / Linux:

```bash
chmod +x ./apply.sh
./apply.sh --dry-run
./apply.sh
```

`apply` does, in order:

1. **Whole-bundle sha256 verification** — a broken transfer stops right here; it never overwrites your config with bad data.
2. Land the home-level declarations (settings / optional credentials), backing each one up to `$DSH_HOME/.dsh-sync-backup-<timestamp>` before overwriting.
3. Land each profile's declaration files (cordis.patch.yml / .npmrc / **pnpm-workspace.yaml**).
4. Run `dsh plugin add` for each bundle in order (skipping the genuine built-in bundles; `link:` dependencies point at source inside the bundle).
5. Any failing step → **automatic rollback**, telling you where the backup is.

It does **not** hand-write the profile's `package.json` / `dsh.profile.bundles` — the official `dsh plugin add` maintains those, removing a whole class of error.

Switches: `-SkipSettings` / `-SkipPlugins` / `-Only a,b` / `-TargetHome <dir>` (sh side: `--skip-settings` / `--skip-plugins` / `--only` / `--home`).

## Tools

| Tool | Description |
|---|---|
| `dshsync_export` | Export this machine's dsh config as a portable bundle and generate the apply scripts. The source is **read-only** (copy only, never modifies config) |

## Configuration (settings namespace `sync`)

| Key | Default | Description |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Source harness home |
| `profile` | `web` | Profile to export by default; `"*"` = all profiles |
| `outDir` | temp dir `dsh-sync-bundle` | Bundle output directory |
| `includeCredentials` | `false` | Whether to include `.credentials.yaml` (real secrets) |
| `credentialPassphrase` | empty | ≥6 chars: move settings + credentials **encrypted** (recommended) |
| `includePlugins` | `true` | Whether to vendor the source of `link:` plugins |

## Credential strategy (important)

Three routes, in order of preference:

1. **Encrypted transfer (recommended)**: supply `credentialPassphrase`. Settings and credentials enter the bundle as AES-256-GCM ciphertext (scrypt-derived key, per-bundle random salt/iv, authenticated tag). A wrong passphrase or a tampered file fails at decryption rather than yielding wrong plaintext. Plaintext secrets are thus **neither lost nor exposed**, and you need not re-enter every plugin key after switching machines.
2. **No credentials (default)**: `.credentials.yaml` is not exported; plaintext secret lines in settings are stripped with a warning, and are re-entered on the target.
3. **Plaintext carry (not recommended)**: `includeCredentials=true` with no passphrase — the bundle holds naked secrets; use only over a trusted channel and delete it immediately after.

Additional rules:
- Plaintext detection: a `*Env` field must be a valid reference name (`^[A-Za-z_][A-Za-z0-9_]*$`, no hyphens), otherwise it counts as plaintext; long values in `key/token/secret/password`-like fields also raise a warning.
- Tools **only ever output redacted previews** (prefix + length), never the full secret.
- The target can also `export DSH_SYNC_PASSPHRASE=...` before running apply to avoid the prompt.

## Known limitations

- **The target must rebuild dependencies**: `node_modules` does not travel; pnpm installs them over the network.
- **Git dependencies need build approval**: a `github:` dependency added for the first time on the target may be rejected by pnpm ≥10's build gate; the bundle carries the profile's `pnpm-workspace.yaml`, and if `allowBuilds` is already configured there it passes directly, otherwise add the entry as prompted and retry.
- **`pnpm-lock.yaml` is not moved**: it contains the source machine's absolute `link:` paths; the target re-resolves.
- **Fully offline targets are not supported**: offline needs a bundled pnpm store or a full `npm pack` of dependencies.
- If a source `link:` path is already dead (plugin deleted/moved), the export warns and skips it — fix it on the source first if the target needs that source.

## Development and testing

```bash
npm run check   # node --check on every entry point (including the helper inside the bundle)
npm test        # pure functions + end-to-end export/encrypt/verify/script-generation tests (fake dshHome, no network)
npm run verify
```

## License

MIT.

This is an original implementation using Node built-ins only; the script generation and safe-rollback design draw on the **public usage patterns and general engineering practice** of comparable community plugins, and contain no third-party source.
