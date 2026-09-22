// lib/tools/export.js — dshsync_export:导出本机 dsh 配置为可移植 bundle。
import fs from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { exportBundle, listProfiles, readProfileManifest } from '../bundle.js'
import { buildApplyPs1, buildApplySh, buildApplyBat } from '../apply-script.js'
import { scanAbsolutePaths } from '../bundle.js'

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
      preview: { type: 'boolean', description: 'Scan and report what would be exported WITHOUT writing any files. Useful to verify nothing is missed before committing. Default false.' },
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

      // ── 预览模式:扫描并报告,不写任何文件 ──────────────────────────────────
      if (args.preview) {
        const previewResult = await previewExport({ dshHome, profiles, includeCredentials, includePlugins, passphrase, log })
        return previewResult
      }

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

/**
 * 预览模式:扫描源机配置,报告将要导出什么,但不写任何文件。
 * 灵感来自社区插件的导出前预览功能(通用工程模式,不含第三方代码)。
 */
async function previewExport({ dshHome, profiles, includeCredentials, includePlugins, passphrase, log }) {
  const profilePreviews = []
  let totalLinkPlugins = 0
  let totalVendoredPlugins = 0
  let estimatedBytes = 0
  const allPathHints = []

  for (const profile of profiles) {
    const profileDir = path.join(dshHome, 'profiles', profile)
    const st = await fs.promises.stat(profileDir).catch(() => null)
    if (!st || !st.isDirectory()) {
      profilePreviews.push({ name: profile, status: 'missing', bundles: 0, linkPlugins: 0 })
      continue
    }
    const pkgPath = path.join(profileDir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      profilePreviews.push({ name: profile, status: 'no-package-json', bundles: 0, linkPlugins: 0 })
      continue
    }
    const { bundles, depList } = await readProfileManifest(profileDir)
    const linkDeps = depList.filter((d) => d.kind === 'link')
    const profileFiles = []
    for (const f of ['cordis.patch.yml', '.npmrc', 'pnpm-workspace.yaml']) {
      if (fs.existsSync(path.join(profileDir, f))) profileFiles.push(f)
    }
    // 估算 link 插件源码体积
    let pluginBytes = 0
    let pluginCount = 0
    for (const d of linkDeps) {
      const srcAbs = path.resolve(d.sourcePath.replace(/\//g, path.sep))
      if (fs.existsSync(srcAbs)) {
        pluginCount++
        // 快速估算:统计目录下文件数和总大小(不复制,只 stat)
        const { count, bytes } = await quickSize(srcAbs)
        pluginBytes += bytes
      }
    }
    totalLinkPlugins += linkDeps.length
    totalVendoredPlugins += pluginCount
    estimatedBytes += pluginBytes
    profilePreviews.push({
      name: profile,
      status: 'ok',
      bundles: bundles.length,
      linkPlugins: linkDeps.length,
      vendoredPlugins: pluginCount,
      profileFiles,
      pluginSize: humanSize(pluginBytes),
    })
  }

  // 检查 settings / credentials / cordis.patch.yml
  const settingsPath = path.join(dshHome, 'settings.yaml')
  const credPath = path.join(dshHome, '.credentials.yaml')
  const patchPath = path.join(dshHome, 'cordis.patch.yml')
  const hasSettings = fs.existsSync(settingsPath)
  const hasCredentials = fs.existsSync(credPath)
  const hasPatch = fs.existsSync(patchPath)

  // 扫描路径提示
  if (hasSettings) {
    const raw = await fs.promises.readFile(settingsPath, 'utf8')
    for (const p of scanAbsolutePaths(raw)) allPathHints.push({ path: p, source: 'settings.yaml' })
  }
  if (hasPatch) {
    const raw = await fs.promises.readFile(patchPath, 'utf8')
    for (const p of scanAbsolutePaths(raw)) allPathHints.push({ path: p, source: 'cordis.patch.yml' })
  }

  // 报告
  log('📋 导出预览(未写任何文件):')
  log('')
  log(`   DSH_HOME: ${dshHome}`)
  log(`   Profile: ${profiles.join(', ')}`)
  log('')
  log('   ┌─ Profile 清单')
  for (const p of profilePreviews) {
    if (p.status === 'ok') {
      log(`   │  ${p.name}: ${p.bundles} bundle(s), ${p.linkPlugins} link 插件(${p.vendoredPlugins} 可打包, ${p.pluginSize})`)
      if (p.profileFiles.length) log(`   │    声明文件: ${p.profileFiles.join(', ')}`)
    } else {
      log(`   │  ${p.name}: ⚠️ ${p.status}`)
    }
  }
  log('   └─')
  log('')
  log(`   settings.yaml: ${hasSettings ? '✅' : '❌'}`)
  log(`   .credentials.yaml: ${hasCredentials ? '✅' : '❌'} ${includeCredentials ? '(将包含)' : '(将排除)'}`)
  log(`   cordis.patch.yml: ${hasPatch ? '✅' : '❌'}`)
  log(`   加密: ${passphrase ? '🔒 AES-256-GCM' : includeCredentials ? '⚠️ 明文' : '无需(不含凭据)'}`)
  log(`   插件源码: ${includePlugins ? `${totalVendoredPlugins}/${totalLinkPlugins} 可打包, 估算 ${humanSize(estimatedBytes)}` : '不打包(includePlugins=false)'}`)
  if (allPathHints.length) {
    log(`   路径提示: ${allPathHints.length} 个绝对路径将被记录,apply 时在新机上检测并提示重映射`)
    for (const h of allPathHints.slice(0, 5)) log(`     · ${h.path} (${h.source})`)
    if (allPathHints.length > 5) log(`     · ...还有 ${allPathHints.length - 5} 个`)
  }
  log('')
  log('   不迁移(设计如此): sessions / storages / background / node_modules / lockfile')
  log('')
  log('   确认无误后,去掉 preview 参数执行导出。')

  return {
    bundleDir: '(preview — no files written)',
    profiles: profiles,
    includesCredentials: includeCredentials && hasCredentials,
    encrypted: Boolean(passphrase),
    pluginCount: totalVendoredPlugins,
    totalBytes: estimatedBytes,
    warningCount: 0,
    warnings: [],
    nextSteps: [
      '去掉 preview 参数执行导出',
      '传 bundle 到目标机',
      '目标机预演:apply.ps1 -WhatIf 或 ./apply.sh --dry-run',
      '确认后执行 apply',
      '重启 dsh',
    ],
    log: logs.join('\n'),
  }
}

/** 快速估算目录大小(不复制文件,只 stat)。 */
async function quickSize(dir) {
  let count = 0
  let bytes = 0
  const skip = new Set(['node_modules', '.git', 'dist', '.turbo'])
  async function walk(d) {
    const entries = await fs.promises.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(full)
          count++
          bytes += st.size
        } catch { /* ignore */ }
      }
    }
  }
  await walk(dir)
  return { count, bytes }
}
