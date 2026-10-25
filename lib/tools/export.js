// lib/tools/export.js — dshsync_export:导出本机 dsh 配置为可移植 bundle。
import fs from 'node:fs'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { exportBundle, listProfiles, readProfileManifest } from '../bundle.js'
import { buildApplyPs1, buildApplySh, buildApplyBat } from '../apply-script.js'
import { scanAbsolutePaths } from '../bundle.js'
import { machineIdentity, probeRuntime, summarizeRuntime } from '../host-env.js'
import { readWorkspacePaths, scanSessions } from '../session-migrate.js'
import { scanLinks, linkWarnings } from '../link-scan.js'
import { scanWorkspaceCandidates, selectWorkspacePaths } from '../workspace-pack.js'
import { startHost } from '../lan/host.js'
import { closeHost, setHost } from '../lan/jobs.js'

function humanSize(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 规整 workspaces 参数。
 * ["*"] / ["*", "x"] 视为「全部候选」—— 星号是全局意图，压过同列表里的具体项；
 * 空数组与 undefined 一律回到 null（由 includeWorkspaces 决定是否全选）。
 * @param {unknown} raw
 * @returns {string[]|'*'|null}
 */
function normalizeWorkspacesArg(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return null
    return s === '*' ? '*' : [s]
  }
  if (!Array.isArray(raw)) return null
  const items = raw.map((x) => String(x).trim()).filter((x) => x !== '')
  if (items.length === 0) return null
  if (items.includes('*')) return '*'
  return items
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
    `- 源机运行时:${summarizeRuntime(manifest.source)}`,
    ...(Array.isArray(manifest.workspaces) && manifest.workspaces.length
      ? [`- 工作区代码:${manifest.workspaces.length} 个项目目录`, ...manifest.workspaces.map((w) => `    - ${w.name} ← ${w.sourcePath}（${(w.bytes / 1048576).toFixed(1)} MB${w.hasGit ? '，含 git' : ''}）`)]
      : []),
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
    ...(Array.isArray(manifest.workspaces) && manifest.workspaces.length
      ? [
        '## 工作区代码（这两个脚本不处理）',
        '',
        '这两个脚本负责声明层与状态层，**不解包工作区代码**：解包它必须同时改写会话 cwd、',
        'workspace.json 与软链，三者要保持一致，脚本做不到。用脚本落地时，会话能列出来，',
        '但点开是空目录。',
        '',
        '在目标机用工具路径落地，并给一个你在新机器上选好的根目录：',
        '',
        '```',
        `dshsync_apply(bundleDir="<本 bundle 目录>", workspaceRoot="E:/code", dryRun=true)`,
        '```',
        '',
        '`workspaceRoot` 下的目录名与源机一致；会话 cwd、工作区路径、skills 软链会自动跟到那里。',
        '若某个项目想单独放，用 `workspaceMap={"name":"E:/somewhere"}`。',
        '',
      ]
      : []),
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
      'Export this machine\'s dsh state into a portable bundle so another machine can keep using dsh ' +
      'as if nothing changed. Use profile="*" to move EVERY profile. The bundle carries settings.yaml, ' +
      'optional credentials, each profile\'s declaration files, the SOURCE of every link: plugin, and — ' +
      'with includeState (default true) — sessions / storages / skills. With includeWorkspaces it also ' +
      'packages the project directories those sessions point at, which is what makes a session open ' +
      'with its files instead of an empty folder. It EXCLUDES rebuildable artifacts (node_modules, ' +
      'dsh-runtimes, cache, logs, .anonymous-user-id, pnpm lockfile) — the target reinstalls those, so ' +
      'the target still needs one `pnpm install` (verify reports it as I9 instead of pretending it is done). ' +
      'Read-only on the source: it copies, never mutates. Secrets: pass credentialPassphrase to carry ' +
      'settings + credentials as AES-256-GCM ciphertext (recommended), otherwise credentials are excluded ' +
      'and settings literal keys stripped. Transfer the bundle with dsh-localsend.',
    parameters: {
      profile: { type: 'string', description: 'Profile to export. "*" (the default) exports every profile — right choice for a whole-machine move, and the only safe one when the target runs a different profile than the source (web vs desktop).' },
      outDir: { type: 'string', description: 'Bundle output directory (default from config).' },
      includeCredentials: { type: 'boolean', description: 'Include .credentials.yaml (real secrets). Default false — requires explicit user confirmation.' },
      credentialPassphrase: { type: 'string', description: 'At least 6 chars. Encrypts settings + credentials instead of shipping them in the clear. Required later on the target to apply.' },
      includePlugins: { type: 'boolean', description: 'Vendor link: plugin sources into the bundle (default true).' },
      includeState: { type: 'boolean', description: 'Carry sessions / storages / skills so the target becomes IDENTICAL, not just usable (default true). Set false only for a clean config-only transfer.' },
      includeWorkspaces: { type: 'boolean', description: 'Package the project directories that sessions point at (default false). Turn this on when switching computers: without them, sessions are listed but open empty, because the code lives outside $DSH_HOME.' },
      workspaces: { type: 'array', items: { type: 'string' }, description: 'Which project directories to package: ["*"] for every candidate, or a list of absolute paths / folder names. Default when omitted = every candidate. Nested paths collapse to their root automatically.' },
      includeGit: { type: 'boolean', description: 'Keep .git inside packaged workspaces so repositories stay complete on the target (default true). Set false to shrink the bundle at the cost of history.' },
      dshHome: { type: 'string', description: 'Source $DSH_HOME override. Empty = auto.' },
      preview: { type: 'boolean', description: 'Scan and report what would be exported WITHOUT writing any files, including the workspace candidates with their sizes so you can choose. Default false.' },
      autoHost: { type: 'boolean', description: 'After the bundle is written, immediately start the LAN sender on this machine (auto-accept mode: the new machine just needs the pairing code) and return the pairing code + progress-page URL in the same result. This is the one-shot migration path: preview → confirm → export with autoHost=true, and the old machine is done — no separate dshsync_lan_host call, no manual confirm click. Default false.' },
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
          lan: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pageUrl: { type: 'string', required: true },
              code: { type: 'string', required: true },
              port: { type: 'number', required: true },
              expiresAt: { type: 'number', required: true },
              autoAccept: { type: 'boolean', required: true },
              bundleFiles: { type: 'number', required: true },
              bundleBytes: { type: 'number', required: true },
            },
          },
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
      const profileArg = String(args.profile || cfg.profile || '*').trim()
      const outDir = String(args.outDir || cfg.outDir || '').trim()
      if (!outDir) throw new Error('outDir is required (pass it or set config.outDir)')
      const includeCredentials = Boolean(args.includeCredentials ?? cfg.includeCredentials ?? false)
      const includePlugins = Boolean(args.includePlugins ?? cfg.includePlugins ?? true)
      const includeState = Boolean(args.includeState ?? cfg.includeState ?? true)
      const includeWorkspaces = Boolean(args.includeWorkspaces ?? cfg.includeWorkspaces ?? false)
      const includeGit = args.includeGit !== false && cfg.includeGit !== false
      const workspaces = normalizeWorkspacesArg(args.workspaces)
      const passphrase = String(args.credentialPassphrase || '').trim()

      let profiles = profileArg === '*' ? await listProfiles(dshHome) : [profileArg]
      if (profiles.length === 0) throw new Error(`no profile found under ${path.join(dshHome, 'profiles')}`)

      // ── 预览模式:扫描并报告,不写任何文件 ──────────────────────────────────
      if (args.preview) {
        const previewResult = await previewExport({
          dshHome, profiles, includeCredentials, includePlugins, includeState,
          includeWorkspaces, workspaces, includeGit, passphrase, log,
        })
        return previewResult
      }

      const { bundleDir, manifest, warnings } = await exportBundle({
        dshHome, profiles, outDir, includeCredentials, includePlugins, includeState,
        includeWorkspaces, workspaces, includeGit, passphrase, onLog: log, writeScripts,
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
      const wsList = manifest.workspaces || []
      if (wsList.length) {
        const wsBytes = wsList.reduce((n, w) => n + (w.bytes || 0), 0)
        log(`   工作区代码: ${wsList.length} 个（${humanSize(wsBytes)}）`)
        for (const w of wsList) log(`   · ${w.name} ← ${w.sourcePath}（${humanSize(w.bytes)}${w.hasGit ? '，含 git' : ''}）`)
        log('     → 目标机落地时用 workspaceRoot 指定新根目录；会话与软链会自动跟着改')
      } else if (includeWorkspaces) {
        log('   工作区代码: 未打包（没选中任何存在的目录）')
      }
      log(`   告警: ${warnings.length} 条`)
      for (const w of warnings) log(`   ⚠️ ${w.where} — ${w.reason} [${w.preview}]`)
      if (manifest.notMigrated.length) {
        log('   以下内容故意不带走(不是遗漏):')
        for (const n of manifest.notMigrated) log(`   · ${n.summary}`)
      }
      log('')

      // ── autoHost：打包完立刻就地起发送端（一条龙路径）────────────────────────
      // 用户视角的旧机流程到此为止：预览 → 确认 → 这一次调用。发送端以 autoAccept
      // 模式起（配对码即通行证，不再等人在页面上点接受），新机「开始迁移」后两端
      // 都不需要再有人守着。失败不推翻导出结果：bundle 已经在盘上了，降级为提示
      // 「手动跑 dshsync_lan_host」。
      let lan = null
      if (args.autoHost === true) {
        log('━━ 局域网发送端 ━━')
        try {
          if (getHost() !== null) await closeHost()
          const hostLogs = []
          const host = await startHost({
            bundleDir,
            autoAccept: true,
            onLog: (line) => { hostLogs.push(line); log('   ' + line) },
          })
          setHost(host)
          lan = {
            pageUrl: host.pageUrl,
            code: host.code,
            port: host.port,
            expiresAt: host.expiresAt,
            autoAccept: true,
            bundleFiles: host.bundle.files,
            bundleBytes: host.bundle.bytes,
          }
        } catch (err) {
          const message = err && err.message ? err.message : String(err)
          log('   ⚠️ 发送端启动失败（' + message + '）')
          log('   bundle 已导出完好，不影响手动路径：稍后单独跑 dshsync_lan_host 再试。')
          log('')
        }
      }

      const lanNext = lan === null
        ? [
          `传 bundle 到目标机:${bundleDir}`,
          '或在本机跑 dshsync_lan_host 起局域网直传',
        ]
        : [
          '新机器（装好 dsh-sync 后）：设置 → 内置插件 → dsh-sync 迁移 → 局域网设备里选中本机',
          `填配对码 ${lan.code} → 点「开始迁移」→ 之后自动落地与核验，两端都不需要再操作`,
          `配对码 ${Math.round((lan.expiresAt - Date.now()) / 60000) || 5} 分钟内有效、只能用一次；过期了在本机重跑 dshsync_lan_host(action="renew")`,
        ]
      const nextSteps = [
        ...lanNext,
        '落地后目标机重启 dsh（桌面版从托盘退出再重开）',
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
        ...(lan === null ? {} : { lan }),
        log: logs.join('\n'),
      }
    },
  })
}

/**
 * 预览模式:扫描源机配置,报告将要导出什么,但不写任何文件。
 * 灵感来自社区插件的导出前预览功能(通用工程模式,不含第三方代码)。
 */
async function previewExport({ dshHome, profiles, includeCredentials, includePlugins, includeState, includeWorkspaces, workspaces, includeGit, passphrase, log }) {
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

  // ── 状态层预估（sessions / storages / skills）────────────────────────────
  let statePreview = null
  if (includeState) {
    try {
      const scan = await scanSessions(dshHome)
      const links = scanLinks(dshHome)
      let stateBytes = 0
      for (const name of ['sessions', 'storages', 'skills']) {
        const d = path.join(dshHome, name)
        if (fs.existsSync(d)) {
          const r = await quickSize(d)
          stateBytes += r.bytes
        }
      }
      statePreview = {
        sessions: scan.sessions.length,
        sessionBytes: scan.totalBytes,
        cwds: [...new Set(scan.sessions.map((s) => s.cwd).filter((c) => c !== null))],
        links: links.summary,
        bytes: stateBytes,
        problems: scan.problems,
      }
    } catch (err) {
      statePreview = { error: err && err.message ? err.message : String(err) }
    }
  }

  // ── 工作区候选（换机时用户要在这里勾选）──────────────────────────────────
  // 必须给出体积：1.1G 的目录和 23M 的目录要能一眼分开，否则「全选」会带来惊喜。
  let workspaceCandidates = []
  let workspaceSelection = { picked: [], missing: [] }
  let workspaceBytes = 0
  if (includeWorkspaces) {
    let wsPaths = []
    try {
      const wsFile = path.join(dshHome, 'storages', 'workspace.json')
      if (fs.existsSync(wsFile)) {
        wsPaths = readWorkspacePaths(JSON.parse(fs.readFileSync(wsFile, 'utf8'))).map((w) => w.path)
      }
    } catch { /* 读不出就只靠会话 cwd */ }
    try {
      workspaceCandidates = await scanWorkspaceCandidates(dshHome, {
        cwdDistinct: (statePreview && statePreview.cwds) || [],
        workspacePaths: wsPaths,
      })
      workspaceSelection = selectWorkspacePaths(workspaceCandidates, workspaces === null ? '*' : workspaces)
    } catch { /* 拿不到候选不影响其余预览 */ }
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
  const srcEnv = await probeRuntime(dshHome)
  const selfId = machineIdentity(dshHome)
  log(`   本机: ${selfId.hostname}${selfId.user ? '/' + selfId.user : ''} —— 导出后会写进 bundle，目标机 apply 时用它核对方向`)
  log(`   宿主运行时: ${summarizeRuntime(srcEnv)}（来源 ${srcEnv.source}）`)
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
  if (includeState && statePreview !== null && statePreview.error === undefined) {
    log('   ┌─ 状态层（决定「一致」而不只是「能用」）')
    log(`   │  会话: ${statePreview.sessions} 个（${humanSize(statePreview.sessionBytes)}）`)
    if (statePreview.cwds.length) {
      log(`   │  涉及工作区路径 ${statePreview.cwds.length} 个:`)
      for (const c of statePreview.cwds.slice(0, 6)) log(`   │    · ${c}`)
      if (statePreview.cwds.length > 6) log(`   │    · ...还有 ${statePreview.cwds.length - 6} 个`)
      log('   │    → apply 时这些路径会按 mappings 改写;两台机器路径不同就必须给映射')
    }
    const s = statePreview.links
    log(`   │  软链: ${s.total} 个（内部 ${s.internal} / 外部 ${s.external} / 断链 ${s.broken}）`)
    for (const w of linkWarnings(s)) log(`   │    · ${w}`)
    log(`   │  状态层合计: ${humanSize(statePreview.bytes)}`)
    log('   └─')
    for (const p of statePreview.problems || []) log(`   ⚠️ [会话] ${p.message}`)
  } else if (!includeState) {
    log('   状态层: 不导出(includeState=false) —— 目标机将是「能用的空环境」,没有历史会话、没有工作区、skills 为空')
  } else if (statePreview && statePreview.error !== undefined) {
    log(`   状态层: ⚠️ 扫描失败(${statePreview.error})`)
  }
  log('')
  if (includeWorkspaces) {
    log('   ┌─ 工作区代码（会话点开时看到的那些项目目录）')
    if (workspaceCandidates.length === 0) {
      log('   │  没有候选：会话与工作区记录里都没取到路径（includeState=false 时必然如此）')
    } else {
      let pickedBytes = 0
      let pickedCount = 0
      for (const c of workspaceCandidates) {
        const chosen = workspaceSelection.picked.includes(c.path)
        if (chosen) { pickedBytes += c.bytes; pickedCount += 1 }
        const mark = c.exists ? (chosen ? '[✓]' : '[ ]') : '[缺]'
        const extra = [
          c.exists ? humanSize(c.bytes) : '源机已不存在',
          c.gitMode === 'repo' ? 'git' : c.gitMode === 'multi' ? '含子仓库' : '',
          c.covers.length ? '覆盖 ' + c.covers.length + ' 个子目录' : '',
        ].filter(Boolean).join('  ')
        log(`   │  ${mark} ${c.path}`)
        log(`   │       ${extra}`)
      }
      workspaceBytes = pickedBytes
      log(`   │  选中 ${pickedCount} 个根，合计 ${humanSize(pickedBytes)}${includeGit ? '' : '（不含 .git）'}`)
      log('   │  → 落地时用 workspaceRoot 指定新机器上的根目录，目录名保持不变')
      for (const m of workspaceSelection.missing) log(`   │  ⚠️ ${m}`)
    }
    log('   └─')
    log('')
  }

  log('   不迁移(可重建,搬了反而是错的): node_modules / dsh-runtimes / cache / logs / .anonymous-user-id')
  log('')
  // 空壳判据与 bundle.js 里那一处相同：预览是最容易发现自己站错机器的地方——
  // 在新机上导出，bundle 几乎没有内容，拿回旧机 apply 会把配置覆盖成默认值。
  // 只用「会话 0 且工作区记录 0」两条实测值，且必须在扫过状态层之后才谈空不空。
  const shellSessions = includeState && statePreview !== null && statePreview.error === undefined
    ? statePreview.sessions : null
  if (shellSessions === 0 && (statePreview.cwds || []).length === 0) {
    log('⚠️ 这台机器没有任何会话、也没有工作区记录，看起来像刚装好的空壳。')
    log('   迁移要在**旧机**上导出：在空壳机上导出只会得到一份几乎没有内容的 bundle。')
    log('   若你确实想要一份「全新初始状态」的模板，可以忽略这条。')
    log('')
  }
  log('   确认无误后,去掉 preview 参数执行导出。')

  return {
    bundleDir: '(preview — no files written)',
    profiles: profiles,
    includesCredentials: includeCredentials && hasCredentials,
    encrypted: Boolean(passphrase),
    pluginCount: totalVendoredPlugins,
    totalBytes: estimatedBytes + ((statePreview && statePreview.bytes) || 0) + workspaceBytes,
    warningCount: 0,
    warnings: [],
    nextSteps: [
      '去掉 preview 参数执行导出',
      '传 bundle 到目标机',
      '目标机先 dshsync_apply（dryRun=true 预演，再真跑）；搬了工作区就给 workspaceRoot 指定新根目录',
      'dshsync_verify 核对一致性',
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
