// lib/bundle.js — 把本机 dsh 配置导出成"可移植 bundle"。
// 默认导出两层：① 声明层（装什么 + 怎么配）；② 状态层（sessions / storages / skills，
// 让目标机与本机**一致**而不只是"能用"）。
// 仍然不导出可重建的产物（node_modules / dsh-runtimes / cache / logs / .anonymous-user-id）。
// link: 依赖的源码随 bundle 带走并在 apply 时改成本地路径，这样目标机不需要相同的目录布局。
// 软链不复制实体，只记清单（见 collectState 头注释）。零第三方依赖：只用 node: 内置模块。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CREDENTIAL_REF_PATTERN, EXCLUDE_DIRS, EXCLUDE_FILES, EXCLUDE_SUFFIX,
  FORMAT, FORMAT_VERSION, HOME_STATE_FILES, PORTABLE_PROFILE_FILES, SECRET_KEY_HINT,
  SECRET_VALUE_PATTERNS, STATE_PARTS, WINDOWS_PATH_RE, POSIX_PATH_RE,
} from './constants.js'
import { buildChecksums, sha256File } from './checksum.js'
import { encryptBuffer } from './crypto.js'
import { isSameOrChild } from './path-map.js'
import { scanSessions } from './session-migrate.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 目标机没有 dsh-sync,bundle 必须自带工具脚本(见该文件头注释)。
const HELPER_SOURCE = path.join(HERE, 'target', 'dsync-helper.mjs')

/** 是否为 dsh 自带的内置组合包(由 dsh 安装目录解析,不需要也不能由 profile 安装)。 */
export function isBuiltinBundle(name) {
  return String(name || '').startsWith('@deepseek-ai/')
}

/**
 * 把 package.json 的一条依赖分类成 link / git / registry。
 * @returns {{name:string, kind:'link'|'git'|'registry', spec:string, sourcePath?:string}}
 */
export function classifyDep(name, spec) {
  const s = String(spec || '')
  if (s.startsWith('link:')) return { name, kind: 'link', spec: s, sourcePath: s.slice('link:'.length) }
  if (/^(github:|git\+:|git:|bitbucket:|gitlab:)/.test(s)) return { name, kind: 'git', spec: s }
  return { name, kind: 'registry', spec: s }
}

/** 脱敏预览:只暴露前缀与长度,永不回显完整密钥。 */
export function maskSecret(value) {
  const v = String(value || '')
  if (v.length <= 8) return `*** (len ${v.length})`
  return `${v.slice(0, 4)}…*** (len ${v.length})`
}

/**
 * 判断一行 `key: value` 是否携带明文密钥(而非合法引用名)。
 * 以 env 结尾的字段(如 apiKeyEnv)必须填凭据引用名 = POSIX 标识符,不匹配即明文密钥;
 * 其余含 key/token/secret 的字段,值长度可观即视为明文密钥。
 * 注意:有些插件(如 dsh-outline-auto)本就把 token 明文存进 settings,所以这不是假设,是常态。
 *
 * 值侧补充:即使字段名不含 key/token 等关键词,值匹配已知密钥格式(GitHub PAT / OpenAI sk- /
 * AWS AKIA / Google AIza / Slack xox / JWT / PEM 私钥)也判为明文密钥。
 * 这是对字段名判断的补充,参考社区凭据筛查的通用工程实践,不含任何第三方源码。
 */
export function isSecretLine(key, rawValue) {
  const value = String(rawValue || '').replace(/^["']|["']$/g, '')
  if (!value || /^(true|false|null|~|0)$/i.test(value)) return false
  if (key.toLowerCase().endsWith('env')) return !CREDENTIAL_REF_PATTERN.test(value)
  if (SECRET_KEY_HINT.test(key) && value.length >= 12) return true
  // 值模式筛查:字段名不含关键词但值是已知密钥格式
  for (const re of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) return true
  }
  return false
}

function splitSecretLines(text) {
  const flagged = []
  const kept = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(\S.*?)\s*$/.exec(line)
    if (m && isSecretLine(m[1], m[2])) {
      flagged.push({ key: m[1], preview: maskSecret(m[2].replace(/^["']|["']$/g, '')) })
      continue
    }
    kept.push(line)
  }
  return { flagged, kept }
}

/**
 * 扫描 settings.yaml 文本,找出携带明文密钥的行(逐行判断,不解析整份 YAML)。
 * @returns {{warnings:{key:string, preview:string, reason:string}[], secretsFound:boolean}}
 */
export function scanSettingsSecrets(text) {
  const { flagged } = splitSecretLines(text)
  const warnings = flagged.map((f) => ({
    key: f.key,
    preview: f.preview,
    reason: f.key.toLowerCase().endsWith('env')
      ? '该字段应填凭据引用名(大写下划线),却填了明文密钥'
      : 'settings 内疑似明文密钥',
  }))
  return { warnings, secretsFound: warnings.length > 0 }
}

/**
 * 从 settings.yaml 中**删除**明文密钥行。
 * 删除而非置空:字段消失后插件会回退到环境变量 / 未配置提示,比留下空值或非法值更安全。
 * @returns {{text:string, removed:string[]}}
 */
export function redactSettingsSecrets(text) {
  const { flagged, kept } = splitSecretLines(text)
  return { text: kept.join('\n'), removed: flagged.map((f) => f.key) }
}

function shouldSkipName(name) {
  return EXCLUDE_DIRS.has(name) || EXCLUDE_FILES.has(name) || EXCLUDE_SUFFIX.has(path.extname(name).toLowerCase())
}

/** 递归复制目录,跳过产物/缓存。返回 {files, bytes}。 */
export async function copyTreeFiltered(src, dest) {
  let files = 0
  let bytes = 0
  async function walk(from, to) {
    const dirents = await fs.promises.readdir(from, { withFileTypes: true })
    dirents.sort((a, b) => (a.name < b.name ? -1 : 1))
    await fs.promises.mkdir(to, { recursive: true })
    for (const d of dirents) {
      if (shouldSkipName(d.name)) continue
      const a = path.join(from, d.name)
      const b = path.join(to, d.name)
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) await walk(a, b)
      else if (d.isFile()) {
        await fs.promises.copyFile(a, b)
        files += 1
        bytes += (await fs.promises.stat(b)).size
      }
    }
  }
  await walk(src, dest)
  return { files, bytes }
}

/**
 * 扫描文本中的绝对路径(Windows 盘符路径 + POSIX 绝对路径)。
 * 用于导出时记录 settings.yaml / cordis.patch.yml 中的机器绑定路径,
 * apply 时在目标机上检测哪些路径不存在并提示用户重映射。
 * @returns {string[]} 去重后的绝对路径列表
 */
export function scanAbsolutePaths(text) {
  const found = new Set()
  const text2 = String(text || '')
  // 重置正则的 lastIndex(因为用了 /g 标志)
  const winRe = new RegExp(WINDOWS_PATH_RE.source, 'g')
  const posixRe = new RegExp(POSIX_PATH_RE.source, 'g')
  let m
  while ((m = winRe.exec(text2)) !== null) found.add(m[0].replace(/\\/g, '/'))
  while ((m = posixRe.exec(text2)) !== null) found.add(m[0])
  return [...found].sort()
}

/** 读取并解析 profile 的 package.json(声明文件)。 */
export async function readProfileManifest(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json')
  const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'))
  const deps = pkg.dependencies || {}
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  return { pkgPath, pkg, bundles, depList: Object.entries(deps).map(([name, spec]) => classifyDep(name, spec)) }
}

// profiles/ 下除了真正的 profile,还会有依赖产物目录:profile 之间共享的依赖被 pnpm 提升到
// profiles/node_modules,它不是 profile,没有 package.json,扫进去只会让导出当场崩掉。
const NON_PROFILE_DIRS = new Set(['node_modules', '.cache', '.pnpm-store', '.store'])

/** 列出 dshHome 下所有 profile 目录(用于"整台机器搬家")。 */
export async function listProfiles(dshHome) {
  const root = path.join(dshHome, 'profiles')
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])
  const names = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NON_PROFILE_DIRS.has(d.name))
    .map((d) => d.name)
  // 真正的 profile 一定有 package.json —— 用它做最终判据,顺便把升级残留的半成品挡在外面。
  const ok = []
  for (const name of names) {
    if (await existsFile(path.join(root, name, 'package.json'))) ok.push(name)
  }
  return ok.sort()
}

async function existsFile(p) {
  return fs.promises.stat(p).then((x) => x.isFile()).catch(() => false)
}

/**
 * 记录源机环境,供目标机做兼容性比对。
 * 迁移最忌讳"装完了才发现版本对不上、起来就崩":这里把能拿到的版本号都记下来,
 * dsh 版本取不到时不猜,如实写 null,目标机侧会提示人工确认。
 */
async function captureEnvironment() {
  let dshVersion = null
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('dsh', ['--version'], { timeout: 15_000, windowsHide: true })
    const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout))
    if (m) dshVersion = m[1]
  } catch {
    dshVersion = null
  }
  return {
    dshVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }
}

/**
 * 盘一遍"故意不带走"的东西,写进 manifest。
 * 迁移工具最忌讳静默丢失:用户以为全搬了,结果少了什么也无从察觉。
 * 这里把没搬的东西连同原因一起记账,导出和 apply 时都会念一遍。
 *
 * ⚠️ 历史上这里曾把 sessions / storages / skills 列为不迁移,给的理由是
 * 「目录名编码了绝对路径读不出来」「运行态会自行重建」「junction 会自动重建」。
 * 三条理由都经不起实测:
 *   · 会话的权威 cwd 在首帧 header 里,可改写（zstd 帧级最小写,事件区逐字节不动）；
 *   · workspace.json 的工作区记录**不会**自行重建,不搬则历史会话全变孤立；
 *   · .dsh/skills 下是指向 .dsh 外部的软链,不会自动重建,不搬则 skills 列表全空。
 * 现在它们归入 includeState 正常迁移，只有真正可重建/机器绑定项保留在此清单。
 */
async function inspectNotMigrated(dshHome, { includeState = true } = {}) {
  async function measure(name) {
    const root = path.join(dshHome, name)
    const st = await fs.promises.stat(root).catch(() => null)
    if (!st) return null
    let files = 0
    let bytes = 0
    let links = 0
    const walk = async (dir) => {
      const ents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of ents) {
        if (e.isSymbolicLink()) { links += 1; continue }
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile()) {
          files += 1
          bytes += (await fs.promises.stat(abs).catch(() => ({ size: 0 }))).size
        }
      }
    }
    if (st.isDirectory()) await walk(root)
    return { files, bytes, links }
  }

  const out = []
  const plan = []
  // includeState=false 时才把状态层列为"不迁移";开了就由 collectState 正常处理
  if (!includeState) {
    plan.push(['sessions', '本次未开 includeState:会话历史不迁移'])
    plan.push(['storages', '本次未开 includeState:工作区记录不迁移,历史会话将显示为孤立'])
    plan.push(['skills', '本次未开 includeState:skills 链接不迁移'])
  }
  plan.push(['background', '背景图等运行时资源:需的话在新机重新设置'])
  plan.push(['node_modules', '依赖树:目标机按 package.json 用 pnpm install 重建,搬了反而是错的'])
  plan.push(['dsh-runtimes', '宿主自带运行时:随 dsh 安装包重建,跨版本搬会冲突'])
  plan.push(['cache', '缓存:重建即可'])
  plan.push(['logs', '日志:不属于状态'])
  for (const [name, reason] of plan) {
    const m = await measure(name)
    if (!m || (m.files === 0 && m.links === 0)) continue
    const size = m.bytes > 0 ? ` ${(m.bytes / 1024 / 1024).toFixed(1)} MB` : ''
    out.push({
      item: name,
      files: m.files,
      bytes: m.bytes,
      links: m.links,
      reason,
      summary: `未迁移 ${name}:${m.files} 个文件${m.links ? ` / ${m.links} 个联接` : ''}${size} —— ${reason}`,
    })
  }
  return out
}

/**
 * 收集「状态载荷」—— 让目标机的 dsh 与本机**一致**而不只是「能用」。
 *
 * 与原版的核心差别（原版把这三样列为「故意不带走」）：
 *   · sessions —— 目录名编码了工作区绝对路径，但权威 cwd 在会话首帧 header 里，可改写；
 *   · storages —— workspace.json 记录工作区归属，不搬则历史会话全部显示为孤立；
 *   · skills   —— 绝大多数是跨目录软链，不搬则目标机 skills 列表全空。
 *
 * 软链的处理是这里最关键的设计：**不复制链接实体，只记清单**。
 * 理由：bundle 一旦被 zip / 网盘 / 聊天软件搬运，符号链接会被摊平成实体或直接丢弃，
 * 靠「复制链接」保结构必然失败。改成「记录 rel → target，apply 时按清单重建」，
 * 则传输方式再粗暴也不会丢信息。
 *
 * @param {string} dshHome
 * @param {string} bundleDir
 * @param {object} opts
 * @param {(line:string)=>void} [opts.onLog]
 * @returns {Promise<{report:object, links:object[], warnings:object[]}>}
 */
async function collectState(dshHome, bundleDir, { onLog } = {}) {
  const log = (s) => onLog && onLog(s)
  const warnings = []
  const links = []
  const parts = []
  const stateRoot = path.join(bundleDir, 'state')
  await fs.promises.mkdir(stateRoot, { recursive: true })

  // 状态层清单集中在 constants.STATE_PARTS —— 导出与落地必须用同一份,
  // 否则「导出了但没落地」会静默发生(这类不对称是本插件最该防的错)。
  const plan = STATE_PARTS

  // 链接的 internal / external 判定必须用**真实路径**比较。
  // 反例(都是实测出来的,不是设想):
  //   · macOS 上 /var 是 /private/var 的软链,os.tmpdir() 给的是 /var/... ;
  //   · Windows 上进程拿到的短名路径(如 RUNNER~1)与 realpath 展开后的长名不同;
  //   · 用户把 $DSH_HOME 放在符号链接 / junction 下面。
  // 上述情形下,链接的 realpath(已展开)与 dshHome 的字面拼写必然对不上,
  // 结果就是**内部链接被误判成外部**:目标机上不再重定位,迁移后变成断链。
  let homeReal = path.resolve(dshHome)
  try { homeReal = await fs.promises.realpath(homeReal) } catch { /* 根不存在时退回字面拼写 */ }

  for (const { name } of plan) {
    const srcRoot = path.join(dshHome, name)
    const st = await fs.promises.stat(srcRoot).catch(() => null)
    if (st === null || !st.isDirectory()) {
      parts.push({ name, files: 0, bytes: 0, links: 0, present: false })
      continue
    }
    const destRoot = path.join(stateRoot, name)
    await fs.promises.mkdir(destRoot, { recursive: true })
    let files = 0
    let bytes = 0
    let linkCount = 0

    const walk = async (dir, relBase) => {
      let entries
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch (err) {
        warnings.push({
          where: 'state/' + name + '/' + relBase,
          preview: dir,
          reason: '目录不可读，内容未进入 bundle：' + (err && err.code ? err.code : 'unknown'),
        })
        return
      }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name)
        const rel = relBase === '' ? ent.name : relBase + '/' + ent.name
        if (ent.isSymbolicLink()) {
          // 只记录，不复制实体（见函数头说明）
          let target = null
          try { target = await fs.promises.realpath(abs) } catch { target = null }
          const linkText = await fs.promises.readlink(abs).catch(() => null)
          let kind = 'external'
          if (target !== null) {
            // 两边都是 realpath,再用段边界 + 平台大小写规则比较(见 path-map.compareKey)
            kind = isSameOrChild(target, homeReal) ? 'internal' : 'external'
          } else {
            kind = 'broken'
          }
          links.push({ scope: name, rel, target: target === null ? null : target.replace(/\\/g, '/'), linkText, kind })
          linkCount += 1
          continue
        }
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules') continue
          await fs.promises.mkdir(path.join(destRoot, rel), { recursive: true })
          await walk(abs, rel)
          continue
        }
        if (ent.isFile()) {
          try {
            await fs.promises.copyFile(abs, path.join(destRoot, rel))
            bytes += (await fs.promises.stat(abs)).size
            files += 1
          } catch (err) {
            warnings.push({
              where: 'state/' + name + '/' + rel,
              preview: abs,
              reason: '复制失败：' + (err && err.code ? err.code : 'unknown'),
            })
          }
        }
      }
    }
    await walk(srcRoot, '')
    parts.push({ name, files, bytes, links: linkCount, present: true })
    log('state/' + name + ': ' + files + ' 个文件, ' + linkCount + ' 个软链, ' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
  }

  // 会话清单摘要：apply 侧据此报告「改写了多少个会话」，verify 侧据此核对
  const sessionSummary = { total: 0, logFiles: 0, byName: {}, cwdDistinct: [] }
  try {
    const scan = await scanSessions(dshHome)
    sessionSummary.total = scan.sessions.length
    sessionSummary.logFiles = scan.sessions.reduce((n, s) => n + (s.logs || []).length, 0)
    const byName = {}
    for (const s of scan.sessions) for (const l of s.logs || []) byName[l.name] = (byName[l.name] || 0) + 1
    sessionSummary.byName = byName
    sessionSummary.cwdDistinct = [...new Set(scan.sessions.map((s) => s.cwd).filter((c) => c !== null))]
    for (const p of scan.problems) warnings.push({ where: 'sessions', preview: '-', reason: p.message })
    if (sessionSummary.total === 0) {
      warnings.push({ where: 'sessions', preview: '-', reason: '未扫描到任何会话（可能本机确实没有历史，或 zstd 不可用）' })
    }
  } catch (err) {
    warnings.push({ where: 'sessions', preview: '-', reason: '会话扫描失败：' + (err && err.message ? err.message : String(err)) })
  }

  await fs.promises.writeFile(
    path.join(stateRoot, 'links.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total: links.length, links }, null, 2) + '\n',
    'utf8',
  )
  // 会话索引也落盘一份：apply 时即使目标机 zstd 不可用，也能靠它报告预期
  await fs.promises.writeFile(
    path.join(stateRoot, 'sessions.json'),
    JSON.stringify(sessionSummary, null, 2) + '\n',
    'utf8',
  )

  return {
    report: {
      parts,
      linksTotal: links.length,
      linksByKind: {
        internal: links.filter((l) => l.kind === 'internal').length,
        external: links.filter((l) => l.kind === 'external').length,
        broken: links.filter((l) => l.kind === 'broken').length,
      },
      sessions: sessionSummary,
    },
    links,
    warnings,
  }
}

/**
 * 导出 bundle。
 * @param {object} o
 * @param {string} o.dshHome                源机 $DSH_HOME
 * @param {string[]} o.profiles             要导出的 profile 名列表
 * @param {string} o.outDir                 bundle 输出目录
 * @param {boolean} [o.includeCredentials]  是否带走凭据(真实密钥,需显式确认)
 * @param {boolean} [o.includePlugins]      是否 vendoring link: 插件源码(默认 true)
 * @param {boolean} [o.includeState]        是否带走 sessions/storages/skills(默认 true)
 * @param {string} [o.passphrase]           提供则把凭据/settings 以 AES-256-GCM 加密搬运
 * @param {(line:string)=>void} [o.onLog]
 * @returns {Promise<{bundleDir:string, manifest:object, warnings:object[]}>}
 */
export async function exportBundle({
  dshHome, profiles, outDir, includeCredentials = false, includePlugins = true,
  includeState = true, passphrase = '', onLog, writeScripts,
} = {}) {
  const log = (s) => onLog && onLog(s)
  if (!dshHome) throw new Error('dshHome is required')
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error('profiles is required (non-empty array)')
  if (!outDir) throw new Error('outDir is required')
  if (passphrase && String(passphrase).length < 6) throw new Error('passphrase must be at least 6 characters')

  const bundleDir = path.resolve(outDir)
  await fs.promises.mkdir(bundleDir, { recursive: true })

  const warnings = []
  const profileReports = []
  const vendoredTotal = []
  const notMigrated = await inspectNotMigrated(dshHome, { includeState })
  // 同一份源码被多个 profile 引用时只打包一次。
  const vendored = new Map()

  for (const profile of profiles) {
    const profileDir = path.join(dshHome, 'profiles', profile)
    const st = await fs.promises.stat(profileDir).catch(() => null)
    if (!st || !st.isDirectory()) {
      warnings.push({ where: `profile ${profile}`, preview: profileDir, reason: 'profile 目录不存在,已跳过' })
      continue
    }
    if (!(await existsFile(path.join(profileDir, 'package.json')))) {
      warnings.push({ where: `profile ${profile}`, preview: profileDir, reason: '缺少 package.json,不是有效 profile,已跳过' })
      continue
    }
    const { pkg, bundles, depList } = await readProfileManifest(profileDir)
    log(`profile ${profile}: ${bundles.length} bundle(s), ${depList.length} dependency(ies)`)

    // profile 声明文件:cordis.patch.yml / .npmrc / pnpm-workspace.yaml
    const profOut = path.join(bundleDir, 'profiles', profile)
    await fs.promises.mkdir(profOut, { recursive: true })
    const profileFiles = []
    for (const f of PORTABLE_PROFILE_FILES) {
      const src = path.join(profileDir, f)
      if (!(await existsFile(src))) continue
      const dest = path.join(profOut, f)
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await fs.promises.copyFile(src, dest)
      profileFiles.push(f)
    }

    // link: 依赖 → vendoring 源码(多个 profile 共享同一份)
    const deps = []
    for (const d of depList) {
      const rec = { name: d.name, kind: d.kind, spec: d.spec }
      if (d.kind === 'link') {
        const srcAbs = path.resolve(d.sourcePath.replace(/\//g, path.sep))
        rec.sourcePath = srcAbs
        let hit = vendored.get(srcAbs)
        if (!hit && includePlugins) {
          const ok = await fs.promises.stat(srcAbs).then((x) => x.isDirectory()).catch(() => false)
          if (ok) {
            const dest = path.join(bundleDir, 'plugins', d.name)
            const r = await copyTreeFiltered(srcAbs, dest)
            hit = { bundlePath: `plugins/${d.name}`, files: r.files, bytes: r.bytes }
            vendored.set(srcAbs, hit)
            vendoredTotal.push({ name: d.name, files: r.files, bytes: r.bytes })
            log(`vendored ${d.name}: ${r.files} file(s), ${(r.bytes / 1024).toFixed(1)} KB`)
          }
        }
        if (hit) {
          rec.inBundle = true
          rec.bundlePath = hit.bundlePath
        } else {
          rec.inBundle = false
          warnings.push({
            where: `${profile}:${d.name}`,
            preview: srcAbs,
            reason: includePlugins
              ? 'link: 源目录不存在,已跳过;目标机装到该包时会失败'
              : 'link: 依赖未 vendoring(未开 includePlugins),目标机需自备同路径源码',
          })
        }
      } else {
        rec.inBundle = false
      }
      deps.push(rec)
    }

    // profile 的 package.json 才是「插件情况」的真相:它同时决定了装什么(dependencies)
    // 和实际加载什么(dsh.profile.bundles)。缺了它,目标机的 profile 就是个空壳 ——
    // 插件源码躺在 plugins/ 里也没有任何东西去加载。
    //
    // 但不能照抄:里面的 `link:` 是源机绝对路径,D:/... 在目标机上根本不存在。
    // 已在 bundle 里 vendoring 的,改写成指向 vendored 副本的相对路径
    // (从 profiles/<name>/ 出发 → ../../plugins/<name>),这样目标机换任何位置都成立;
    // 没 vendoring 的保留原样并在报告里标出来,不假装能用。
    const pkgOut = JSON.parse(JSON.stringify(pkg))
    const linkDeps = []
    if (pkgOut.dependencies) {
      for (const rec of deps) {
        if (rec.kind !== 'link') continue
        if (rec.inBundle) {
          const rel = '../../' + rec.bundlePath.split('/').join('/')
          pkgOut.dependencies[rec.name] = 'link:' + rel
          linkDeps.push({ name: rec.name, from: rec.spec, to: 'link:' + rel })
        } else {
          linkDeps.push({ name: rec.name, from: rec.spec, to: null, reason: '未 vendoring，保留源机路径' })
        }
      }
    }
    await fs.promises.writeFile(path.join(profOut, 'package.json'), JSON.stringify(pkgOut, null, 2) + '\n', 'utf8')
    profileFiles.push('package.json')
    if (linkDeps.some((x) => x.to === null)) {
      warnings.push({
        where: `${profile}:package.json`,
        preview: linkDeps.filter((x) => x.to === null).map((x) => x.name).join(', '),
        reason: 'link: 依赖未 vendoring,package.json 仍指向源机绝对路径,目标机上该插件装不上',
      })
    }

    profileReports.push({ name: profile, bundles, deps, profileFiles, linkDeps })
  }

  if (profileReports.length === 0) throw new Error('no exportable profile found')

  // ── home 级声明 ──────────────────────────────────────────────────────────
  // settings.yaml 的处理分三种情形:
  //   1) 给了口令 → 整份加密搬运(最省事也最安全:明文密钥既不丢也不裸奔)
  //   2) 没给口令 + 不带凭据 → 移除明文密钥行,只留可安全传播的配置
  //   3) 没给口令 + 带凭据 → 原样带走(用户已确认风险)
  const settingsPath = path.join(dshHome, 'settings.yaml')
  let settingsEncrypted = false
  let settingsRedacted = []
  const homeFiles = []
  if (await existsFile(settingsPath)) {
    const raw = await fs.promises.readFile(settingsPath, 'utf8')
    const scan = scanSettingsSecrets(raw)
    if (passphrase) {
      const enc = encryptBuffer(Buffer.from(raw, 'utf8'), passphrase)
      await fs.promises.writeFile(path.join(bundleDir, 'settings.enc'), enc)
      settingsEncrypted = true
      homeFiles.push('settings.enc')
      for (const w of scan.warnings) {
        warnings.push({ where: `settings.yaml: ${w.key}`, preview: w.preview, reason: '明文密钥随 settings 加密搬运,apply 时凭口令还原' })
      }
    } else if (includeCredentials) {
      await fs.promises.writeFile(path.join(bundleDir, 'settings.yaml'), raw, 'utf8')
      homeFiles.push('settings.yaml')
      for (const w of scan.warnings) {
        warnings.push({ where: `settings.yaml: ${w.key}`, preview: w.preview, reason: '明文密钥随 settings 原样同步(includeCredentials=true)' })
      }
    } else {
      const red = redactSettingsSecrets(raw)
      settingsRedacted = red.removed
      await fs.promises.writeFile(path.join(bundleDir, 'settings.yaml'), red.text, 'utf8')
      homeFiles.push('settings.yaml')
      for (const k of red.removed) {
        warnings.push({ where: `settings.yaml: ${k}`, preview: '(removed)', reason: '已从 bundle 移除明文密钥,需在目标机重新配置(或改用 credentialPassphrase 加密搬运)' })
      }
      for (const w of scan.warnings) {
        if (red.removed.includes(w.key)) continue
        warnings.push({ where: `settings.yaml: ${w.key}`, preview: w.preview, reason: w.reason })
      }
    }
  }
  const homePatch = path.join(dshHome, 'cordis.patch.yml')
  if (await existsFile(homePatch)) {
    await fs.promises.copyFile(homePatch, path.join(bundleDir, 'cordis.patch.yml'))
    homeFiles.push('cordis.patch.yml')
  }
  // $DSH_HOME 根下的用户内容(目前是 AGENTS.md:全局代理指令)。
  // 它不是"机器绑定产物",而是用户写下的东西 —— 漏了它,新机上 agent 的行为就跟旧机不一样。
  for (const f of HOME_STATE_FILES) {
    const src = path.join(dshHome, f)
    if (!(await existsFile(src))) continue
    await fs.promises.copyFile(src, path.join(bundleDir, f))
    homeFiles.push(f)
  }

  // ── 凭据 ────────────────────────────────────────────────────────────────
  let credentialsEncrypted = false
  let includesCredentials = false
  if (includeCredentials) {
    const credPath = path.join(dshHome, '.credentials.yaml')
    if (await existsFile(credPath)) {
      if (passphrase) {
        const enc = encryptBuffer(await fs.promises.readFile(credPath), passphrase)
        await fs.promises.writeFile(path.join(bundleDir, '.credentials.enc'), enc)
        credentialsEncrypted = true
        homeFiles.push('.credentials.enc')
        warnings.push({
          where: '.credentials.yaml',
          preview: '(encrypted)',
          reason: '凭据以 AES-256-GCM 加密搬运;牢记口令,目标机 apply 时需要它',
        })
      } else {
        await fs.promises.copyFile(credPath, path.join(bundleDir, '.credentials.yaml'))
        homeFiles.push('.credentials.yaml')
        warnings.push({
          where: '.credentials.yaml',
          preview: '(secret file, plaintext)',
          reason: 'bundle 内含真实凭据:传输与存放期间等同密钥暴露,只走可信通道,落地后请立即删除',
        })
      }
      includesCredentials = true
    } else {
      warnings.push({ where: '.credentials.yaml', preview: '-', reason: '要求同步凭据但源机不存在该文件,已跳过' })
    }
  }

  // ── 路径扫描:记录 settings 和 cordis.patch.yml 中的绝对路径 ──────────────
  // 换机后用户名/OS 不同,这些路径在新机上不存在。导出时记录下来,
  // apply 时 dsync-helper.mjs 会检测哪些路径失效并提示用户做前缀映射。
  const pathHints = []
  if (await existsFile(settingsPath)) {
    const rawSettings = await fs.promises.readFile(settingsPath, 'utf8')
    for (const p of scanAbsolutePaths(rawSettings)) {
      pathHints.push({ path: p, source: 'settings.yaml' })
    }
  }
  if (await existsFile(homePatch)) {
    const rawPatch = await fs.promises.readFile(homePatch, 'utf8')
    for (const p of scanAbsolutePaths(rawPatch)) {
      pathHints.push({ path: p, source: 'cordis.patch.yml' })
    }
  }

  // ── 状态层：sessions / storages / skills ─────────────────────────────────
  // 这是「B 与本机一致」与「B 能用」的分界。不搬这三样，目标机重启后看不到任何历史会话、
  // 工作区列表为空、skills 全空 —— 配置是对的，但用户会认为迁移失败。
  let stateReport = null
  if (includeState) {
    log('收集状态层（sessions / storages / skills）…')
    const collected = await collectState(dshHome, bundleDir, { onLog: log })
    stateReport = collected.report
    for (const w of collected.warnings) warnings.push(w)
  } else {
    warnings.push({
      where: 'state',
      preview: '-',
      reason: 'includeState=false：会话历史 / 工作区记录 / skills 链接不会迁移，目标机将是「能用的空环境」',
    })
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDshHome: dshHome,
    sourceProfile: profileReports[0].name,
    nodeVersion: process.version,
    source: await captureEnvironment(),
    profiles: profileReports,
    homeFiles,
    settingsEncrypted,
    credentialsEncrypted,
    includesCredentials,
    settingsRedacted,
    plugins: vendoredTotal,
    notMigrated,
    state: stateReport,
    pathHints,
    warnings,
  }
  // bundle 自带工具脚本 + 两种平台的 apply 脚本。
  if (typeof writeScripts === 'function') writeScripts(bundleDir, manifest)
  const toolsDir = path.join(bundleDir, 'tools')
  await fs.promises.mkdir(toolsDir, { recursive: true })
  await fs.promises.copyFile(HELPER_SOURCE, path.join(toolsDir, 'dsync-helper.mjs'))

  // 顺序很关键:manifest.json 要记录本清单的摘要,若先写 manifest 再算哈希,
  // 补写 integrity 字段就会让 manifest 自身的校验失败 —— 等于给目标机埋一颗假雷。
  // 因此:先给除 manifest 外的所有文件定摘要 → 写 manifest → 把 manifest 自己也散列进清单。
  const sums = await buildChecksums(bundleDir, ['manifest.json'])
  manifest.integrity = { algorithm: 'sha256', files: sums.count + 1 }
  await fs.promises.writeFile(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const entries = { ...sums.entries, 'manifest.json': await sha256File(path.join(bundleDir, 'manifest.json')) }
  await fs.promises.writeFile(
    path.join(bundleDir, 'checksums.json'),
    JSON.stringify({ algorithm: 'sha256', generatedAt: new Date().toISOString(), entries }, null, 2) + '\n',
    'utf8',
  )

  return { bundleDir, manifest, warnings }
}
