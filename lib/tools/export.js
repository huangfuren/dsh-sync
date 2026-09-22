// lib/tools/export.js — dshsync_export:导出本机 dsh 配置为可移植 bundle。
import fs from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { exportBundle, listProfiles } from '../bundle.js'
import { buildApplyPs1, buildApplySh, buildApplyBat } from '../apply-script.js'

function humanSize(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 生成 bundle 内的自安装脚本与说明。checksums 在写完之后计算,故此处不要写无关文件。 */
function writeScripts(bundleDir, manifest) {
  fs.writeFileSync(path.join(bundleDir, 'apply.ps1'), buildApplyPs1(manifest), 'utf8')
  fs.writeFileSync(path.join(bundleDir, 'apply.sh'), buildApplySh(manifest), 'utf8')
  // 傻瓜入口:新机双击它即可,不要求用户懂 apply.ps1 的参数。
  const bat = buildApplyBat(manifest)
  fs.writeFileSync(path.join(bundleDir, '一键恢复.bat'), bat, 'utf8')
  // ASCII 备用名:某些传输工具会改掉中文文件名,届时双击 RESTORE.bat 同样可用。
  fs.writeFileSync(path.join(bundleDir, 'RESTORE.bat'), bat, 'utf8')
  const names = manifest.profiles.map((p) => p.name)
  const secretLine = manifest.settingsEncrypted || manifest.credentialsEncrypted
    ? '⚠️ 凭据为**加密**搬运:apply 时需要口令(也可预先 `export DSH_SYNC_PASSPHRASE=...`)。'
    : manifest.includesCredentials
      ? '⚠️ 本 bundle 含**明文**凭据,传输与存放期间等同密钥暴露,用后即删。'
      : '本 bundle 不含凭据。'
  fs.writeFileSync(path.join(bundleDir, 'APPLY.md'), [
    `# dsh-sync bundle`,
    '',
    `- 导出时间:${manifest.exportedAt}`,
    `- 格式:${manifest.format} v${manifest.formatVersion}`,
    `- profile:${names.join(', ')}`,
    `- 来源机:${manifest.sourceDshHome}`,
    '',
    '## 在目标机执行',
    '',
    'Windows(PowerShell 5.1+):',
    '',
    '```powershell',
    'Set-ExecutionPolicy -Scope Process Bypass -Force',
    '.\\apply.ps1 -WhatIf     # 先看一眼将要做什么,不动任何文件',
    '.\\apply.ps1             # 确认无误后真跑',
    '```',
    '',
    'macOS / Linux:',
    '',
    '```bash',
    'chmod +x ./apply.sh',
    './apply.sh --dry-run',
    './apply.sh',
    '```',
    '',
    '常用开关:`--skip-settings` / `--skip-plugins` / `--only dsh-foo,dsh-bar` / `--home <目标 DSH_HOME>`。',
    '',
    '## 脚本做什么',
    '',
    '1. **整包 sha256 校验** —— 传输出问题就在这里停手,不会把你现在的配置改坏。',
    '2. 落地 home 级声明(settings.yaml,以及可选的 .credentials.yaml),覆盖前逐个备份。',
    '3. 落地每个 profile 的声明文件(cordis.patch.yml / .npmrc / **pnpm-workspace.yaml**)。',
    '4. 按 bundles 顺序逐个 `dsh plugin add`(跳过 `@deepseek-ai/*` 内置组合包)。',
    '5. 任一步失败 → **自动回滚**到 `$DSH_HOME/.dsh-sync-backup-<时间戳>`。',
    '',
    secretLine,
    manifest.settingsRedacted.length
      ? `已从 settings.yaml 移除以下明文密钥字段,apply 后需在目标机「设置 → 插件配置」重新填写:${manifest.settingsRedacted.join(', ')}`
      : '',
    (manifest.notMigrated || []).length
      ? [
        '',
        '## 以下内容故意不带走',
        '',
        ...(manifest.notMigrated || []).map((n) => `- ${n.summary}`),
      ].join('\n')
      : '',
    warningsHint(manifest),
    '',
  ].filter((x) => x !== null).join('\n'), 'utf8')
}

function warningsHint(manifest) {
  return manifest.warnings.length ? `\n⚠️ ${manifest.warnings.length} 条告警见 manifest.json 的 warnings 字段。` : ''
}

export function defineExportTool(getConfig) {
  return defineTool({
    name: 'dshsync_export',
    description:
      'Export this machine\'s dsh configuration into a portable bundle so another machine can keep ' +
      'using dsh with the same settings and plugins. Use profile="*" to move EVERY profile (the right ' +
      'choice when switching computers). The bundle carries settings.yaml, optional credentials, each ' +
      'profile\'s declaration files (cordis.patch.yml / .npmrc / pnpm-workspace.yaml), and the SOURCE of ' +
      'every link: plugin (so the target needs no identical absolute paths), plus self-contained ' +
      'apply.ps1 / apply.sh and tools/dsync-helper.mjs. It EXCLUDES machine-bound artifacts ' +
      '(node_modules, sessions, storages, background, .anonymous-user-id, pnpm lockfile) — the target ' +
      'rebuilds those by running the apply script, which calls `dsh plugin add` and needs dsh + node + ' +
      'pnpm + network. The apply script verifies sha256 integrity first, supports --dry-run, backs up ' +
      'before overwriting and ROLLS BACK automatically on any failure. Read-only on the source: it ' +
      'copies, never mutates. Secrets: pass credentialPassphrase to carry settings + credentials as ' +
      'AES-256-GCM ciphertext (recommended), otherwise credentials are excluded and settings literal ' +
      'keys stripped. Transfer the bundle with dsh-localsend (localsend_smb_push / localsend_share).',
    parameters: {
      profile: { type: 'string', description: 'Profile to export. Use "*" for every profile. Default from config, usually "web".' },
      outDir: { type: 'string', description: 'Bundle output directory (default from config).' },
      includeCredentials: { type: 'boolean', description: 'Include .credentials.yaml (real secrets). Default false — requires explicit user confirmation.' },
      credentialPassphrase: { type: 'string', description: 'At least 6 chars. Encrypts settings + credentials instead of shipping them in the clear. Required later on the target to apply.' },
      includePlugins: { type: 'boolean', description: 'Vendor link: plugin sources into the bundle (default true).' },
      dshHome: { type: 'string', description: 'Source $DSH_HOME override. Empty = auto.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bundleDir: { type: 'string', required: true },
          profiles: { type: 'array', required: true, items: { type: 'string' } },
          includesCredentials: { type: 'boolean', required: true },
          encrypted: { type: 'boolean', required: true },
          pluginCount: { type: 'number', required: true },
          totalBytes: { type: 'number', required: true },
          warningCount: { type: 'number', required: true },
          warnings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                where: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
          nextSteps: { type: 'array', required: true, items: { type: 'string' } },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.log }],
    },
    timeoutMs: 300_000,
    async execute(args) {
      const cfg = getConfig()
      const logs = []
      const log = (s) => logs.push(s)

      const dshHome = String(args.dshHome || cfg.dshHome || '').trim()
      if (!dshHome) throw new Error('cannot resolve $DSH_HOME: set the DSH_HOME env var or pass dshHome')
      const profileArg = String(args.profile || cfg.profile || 'web').trim()
      const outDir = String(args.outDir || cfg.outDir || '').trim()
      if (!outDir) throw new Error('outDir is required (pass it or set config.outDir)')
      const includeCredentials = Boolean(args.includeCredentials ?? cfg.includeCredentials ?? false)
      const includePlugins = Boolean(args.includePlugins ?? cfg.includePlugins ?? true)
      const passphrase = String(args.credentialPassphrase || '').trim()

      let profiles = profileArg === '*' ? await listProfiles(dshHome) : [profileArg]
      if (profiles.length === 0) throw new Error(`no profile found under ${path.join(dshHome, 'profiles')}`)

      const { bundleDir, manifest, warnings } = await exportBundle({
        dshHome, profiles, outDir, includeCredentials, includePlugins, passphrase, onLog: log, writeScripts,
      })

      const linkDeps = manifest.profiles.flatMap((p) => p.deps.filter((d) => d.kind === 'link'))
      const pluginCount = linkDeps.filter((d) => d.inBundle).length
      const totalBytes = (manifest.plugins || []).reduce((s, p) => s + p.bytes, 0)
      const encrypted = Boolean(manifest.settingsEncrypted || manifest.credentialsEncrypted)

      log('')
      log(`✅ bundle: ${bundleDir}`)
      log(`   profile: ${profiles.join(', ')}`)
      log(`   link 插件已打包: ${pluginCount}/${linkDeps.length}  体积: ${humanSize(totalBytes)}`)
      log(`   完整性: sha256 × ${manifest.integrity.files} 个文件`)
      log(`   凭据: ${encrypted ? '🔒 加密搬运(apply 需口令)' : manifest.includesCredentials ? '⚠️ 明文包含(用后即删)' : '未包含'}`)
      log(`   告警: ${warnings.length} 条`)
      for (const w of warnings) log(`   ⚠️ ${w.where} — ${w.reason} [${w.preview}]`)
      if (manifest.notMigrated.length) {
        log('   以下内容故意不带走(不是遗漏):')
        for (const n of manifest.notMigrated) log(`   · ${n.summary}`)
      }
      log('')
      log('下一步:')
      log(`   1. 传 bundle 到目标机(例:localsend_smb_push target=<IP> share=<共享> destDir=dsh-sync files=["${bundleDir}"])`)
      log('   2. 目标机先预演:apply.ps1 -WhatIf  或  ./apply.sh --dry-run')
      log('   3. 确认无误后执行 apply(ps1/sh 会自动校验、备份、失败回滚)')
      log('   4. 重启 dsh')

      const nextSteps = [
        `传 bundle 到目标机:${bundleDir}`,
        '目标机预演:apply.ps1 -WhatIf 或 ./apply.sh --dry-run',
        '确认后执行 apply(需目标机有 dsh + node + pnpm + 网络)',
        '重启 dsh profile',
      ]
      if (encrypted) nextSteps.push('apply 时提供口令(DSH_SYNC_PASSPHRASE 或交互输入),完成后删除各处 bundle 副本')
      else if (manifest.includesCredentials) nextSteps.push('apply 成功后立即删除传输路径上的 bundle(含明文凭据)')

      return {
        bundleDir,
        profiles: manifest.profiles.map((p) => p.name),
        includesCredentials: manifest.includesCredentials,
        encrypted,
        pluginCount,
        totalBytes,
        warningCount: warnings.length,
        warnings: warnings.map((w) => ({ where: w.where, reason: w.reason, preview: w.preview })),
        nextSteps,
        log: logs.join('\n'),
      }
    },
  })
}
