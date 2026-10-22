// lib/host-env.js — 宿主运行时指纹:两台机器的 dsh 是不是同一个版本、同一个平台、同一个 node 大版本。
//
// 为什么单独成模块:"版本对不上"不是「有点差异」,而是**插件在启动时被 peer 裁决拒掉** ——
// 表现为 `stays installed but startup denies it`:装是装上了,启动时被拒,界面上什么都没有,
// 而 dsh-sync 自己的报告里全是绿的(文件都在、sha256 全对)。这个失败模式从状态层看不出来,
// 必须拿运行时指纹单独比一次。
//
// 取版本的顺序,全部不依赖 PATH 上有 dsh 命令:
//   1. 桌面版安装包里的 `resources/app.asar/dsh/desktop-runtime.json` —— 正在跑的宿主自己声明的版本,
//      唯一不会陈旧的一份(只在 Electron 里存在)。
//   2. `$DSH_HOME/dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion` —— 安装时的快照。
//      **不可靠**:桌面版升级不会刷新它,本机实测就落后了一整个 patch 版本。仅作 web/CLI 环境的来源。
//   3. `profiles/*/node_modules/@deepseek-ai/dsh/package.json` 的 `version` —— 宿主包被装进 profile 的情形。
//   4. 兜底 `dsh --version` —— 留个口子,取不到就写 null。
//
// 取不到一律写 null,**绝不猜**:宁可报「需人工确认」,也不能让一个编出来的版本号骗过比对。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SEMVER = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/

/** 从任意字符串里抠出第一个 semver,抠不到返回 null。 */
export function semverOf(value) {
  if (typeof value !== 'string') return null
  const m = SEMVER.exec(value)
  return m === null ? null : m[1]
}

/** 只取 semver 的 `major.minor.patch`,忽略预发布/构建后缀 —— 判「同一代」用它。 */
export function semverCore(version) {
  const full = semverOf(version)
  return full === null ? null : full.split('-')[0]
}

/**
 * 取 `major.minor`,判「是否还在同一条 peer 区间里」用它。
 * 判据来自 peer 区间的常见写法(`^0.2.x`):`0.2.0` 与 `0.2.1` 都满足,`0.2` 与 `0.3` 不满足。
 * 所以 patch 级差异不该和跨代差异同等报,否则这条提示会因为运行时清单的一个 patch 落后而变成噪音。
 */
export function semverSpan(version) {
  const core = semverCore(version)
  return core === null ? null : core.split('.').slice(0, 2).join('.')
}

/** 取 semver 的 major 段,判断 node 代际用。 */
export function semverMajor(version) {
  const core = semverCore(version)
  return core === null ? null : Number(core.split('.')[0])
}

/**
 * 读出 `$DSH_HOME/dsh-runtimes/*\/runtime.json` 的全部运行时清单。
 * 读不出来就返回空数组 —— 缺这个目录的机器(纯 web 部署)本来就该走别的来源。
 * @param {string} dshHome
 * @returns {Array<{id:string, desktopVersion:string|null, platform:string|null, arch:string|null, node:string|null, pnpm:string|null}>}
 */
export function readRuntimeManifests(dshHome) {
  const root = path.join(dshHome, 'dsh-runtimes')
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    let json
    try {
      json = JSON.parse(fs.readFileSync(path.join(root, e.name, 'runtime.json'), 'utf8'))
    } catch {
      continue
    }
    if (json === null || typeof json !== 'object') continue
    out.push({
      id: e.name,
      desktopVersion: semverOf(json.desktopVersion),
      platform: typeof json.platform === 'string' ? json.platform : null,
      arch: typeof json.arch === 'string' ? json.arch : null,
      node: semverOf(json.node),
      pnpm: semverOf(json.pnpm),
    })
  }
  // 目录名排序只为让「同一批清单」每次都挑出同一个,避免报告随 readdir 顺序抖动。
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 从多份运行时清单里挑出「宿主那一个」。
 * 桌面端把宿主运行时固定放在 `dsh-primary-runtime`;装了插件运行时后目录会变多,
 * 所以不能简单取第一个 —— 取到插件运行时会把它的 node 版本当成宿主的。
 * @param {ReturnType<typeof readRuntimeManifests>} manifests
 */
export function pickRuntimeManifest(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) return null
  const primary = manifests.find((m) => m.id === 'dsh-primary-runtime')
  if (primary !== undefined) return primary
  const withVersion = manifests.find((m) => m.desktopVersion !== null)
  return withVersion === undefined ? manifests[0] : withVersion
}

/** 从 profiles/*\/node_modules/@deepseek-ai/dsh/package.json 取宿主包版本。 */
function versionFromProfileModules(dshHome) {
  const root = path.join(dshHome, 'profiles')
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isDirectory() || e.name === 'node_modules') continue
    const pkgFile = path.join(root, e.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      const v = semverOf(pkg.version)
      if (v !== null) return v
    } catch {
      // 没装就是没装,继续看下一个 profile
    }
  }
  return null
}

/**
 * 「正在运行的桌面版」会在安装包里带一份自己的运行时清单,从中推出候选路径。
 *
 * 单独拆成纯函数是为了能测:真正的读取要走 asar,只有 Electron 的 fs 认得那种路径,
 * 而这里只关心「会去哪些地方找、先找哪个」。
 *
 * @param {{versions?:object, resourcesPath?:string, execPath?:string}} env 默认 process
 * @returns {string[]} 按优先级排列的候选路径(非 Electron 环境返回空数组)
 */
export function desktopRuntimeCandidates(env = process) {
  const versions = env === null || env === undefined ? null : env.versions
  if (versions === null || versions === undefined || !versions.electron) return []
  const out = []
  const res = env.resourcesPath
  if (typeof res === 'string' && res !== '') {
    out.push(path.join(res, 'app.asar', 'dsh', 'desktop-runtime.json'))
  }
  // 兜底:`resourcesPath` 偶尔为空(某些打包方式 / 以 node 方式启动 Electron 时)。
  if (typeof env.execPath === 'string' && env.execPath !== '') {
    out.push(path.join(path.dirname(env.execPath), 'resources', 'app.asar', 'dsh', 'desktop-runtime.json'))
  }
  return out
}

/**
 * 读桌面版安装包里那份 `desktop-runtime.json`。
 *
 * 它必须排在 `$DSH_HOME/dsh-runtimes/*\/runtime.json` **前面**,因为那个目录是**安装时**
 * 写下的快照,桌面版升级并不会刷新它。本机实测就撞上了:应用已是 0.2.1-rc.2(内置 node 24.21.0 /
 * pnpm 11.28.5),而 `dsh-runtimes/dsh-primary-runtime/runtime.json` 还停在 0.2.0-rc.2 / pnpm 11.7.0,
 * 目录时间停在十天前。拿这份陈旧快照去比对的后果很具体:
 *   · 换到一台刚装好的机器(它的快照是新鲜的)时,两台版本其实完全相同,却报「版本不一致」;
 *   · 反过来两边快照都陈旧时,真跨代也会被抹平成一致 —— 而这正是 peer 裁决拒装的前兆。
 *
 * 非 Electron 环境(web 宿主 / CLI)返回 null,继续走后面的来源。
 *
 * @param {{versions?:object, resourcesPath?:string, execPath?:string}} env 默认 process
 * @returns {{version:string, node:string|null, pnpm:string|null, platform:string|null, arch:string|null,
 *            hostProtocolVersion:number|null, file:string} | null}
 */
export function readDesktopRelease(env = process) {
  for (const file of desktopRuntimeCandidates(env)) {
    let json
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (json === null || typeof json !== 'object') continue
    const release = json.release
    if (release === null || typeof release !== 'object') continue
    const version = semverOf(release.version)
    if (version === null) continue
    return {
      version,
      node: semverOf(release.nodeVersion),
      pnpm: semverOf(release.pnpmVersion),
      platform: typeof json.platform === 'string' ? json.platform : null,
      arch: typeof json.arch === 'string' ? json.arch : null,
      hostProtocolVersion: typeof release.hostProtocolVersion === 'number' ? release.hostProtocolVersion : null,
      file,
    }
  }
  return null
}

/**
 * 探测一台机器的宿主运行时指纹。
 *
 * 返回对象的字段口径:
 *   - `dshVersion`  宿主 dsh 版本(取不到为 null)
 *   - `nodeVersion` 执行本次探测的 node(`process.version`),沿用既有 manifest 契约,不要改语义
 *   - `runtimeNode` 宿主自带的 node(随安装包发布),判断 zstd 内建能力看的是它
 *   - `platform` / `arch` 宿主运行平台,优先取运行时清单(它描述的是 host 而非探测进程)
 *   - `source` 版本号到底从哪来的,报告里要如实写出来
 *
 * @param {string} dshHome
 * @param {{ allowCli?: boolean, env?: object }} [opts]
 */
export async function probeRuntime(dshHome, { allowCli = true, env = process } = {}) {
  // ① 跑在桌面版里:安装包自己声明的版本,唯一不会陈旧的一份。
  const desktop = readDesktopRelease(env)
  if (desktop !== null) {
    return {
      dshVersion: desktop.version,
      platform: desktop.platform === null ? process.platform : desktop.platform,
      arch: desktop.arch === null ? process.arch : desktop.arch,
      nodeVersion: process.version,
      runtimeNode: desktop.node,
      pnpm: desktop.pnpm,
      runtime: 'desktop-app',
      source: 'desktop-app',
    }
  }

  const picked = pickRuntimeManifest(readRuntimeManifests(dshHome))
  if (picked !== null && picked.desktopVersion !== null) {
    return {
      dshVersion: picked.desktopVersion,
      platform: picked.platform === null ? process.platform : picked.platform,
      arch: picked.arch === null ? process.arch : picked.arch,
      nodeVersion: process.version,
      runtimeNode: picked.node,
      pnpm: picked.pnpm,
      runtime: picked.id,
      source: 'dsh-runtimes',
    }
  }

  const fromModules = versionFromProfileModules(dshHome)
  if (fromModules !== null) {
    return {
      dshVersion: fromModules,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      runtimeNode: null,
      pnpm: null,
      runtime: null,
      source: 'profile-node-modules',
    }
  }

  if (allowCli) {
    const fromCli = await versionFromCli()
    if (fromCli !== null) {
      return {
        dshVersion: fromCli,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        runtimeNode: null,
        pnpm: null,
        runtime: null,
        source: 'dsh-cli',
      }
    }
  }

  return {
    dshVersion: null,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    runtimeNode: null,
    pnpm: null,
    runtime: null,
    source: 'unknown',
  }
}

/** 兜底:问 CLI。多数机器(尤其 Windows 桌面端)没有这个命令,失败是常态,不写日志不抛。 */
async function versionFromCli() {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('dsh', ['--version'], { timeout: 15_000, windowsHide: true })
    return semverOf(String(stdout))
  } catch {
    return null
  }
}

/** 比对用的 node 版本:优先宿主自带的那份,没有才退到探测进程。 */
function hostNode(env) {
  if (env === null || env === undefined) return null
  return semverOf(env.runtimeNode) === null ? semverOf(env.nodeVersion) : semverOf(env.runtimeNode)
}

/** 把指纹压成一行,给报告抬头用。 */
export function summarizeRuntime(env) {
  if (env === null || env === undefined) return '未知'
  const parts = []
  parts.push(env.dshVersion === null ? 'dsh 版本未知' : 'dsh ' + env.dshVersion)
  const plat = env.platform === null || env.platform === undefined ? null : env.platform
  const arch = env.arch === null || env.arch === undefined ? null : env.arch
  if (plat !== null) parts.push(arch === null ? plat : plat + '-' + arch)
  const node = hostNode(env)
  if (node !== null) parts.push('node ' + node)
  return parts.join(' / ')
}

/**
 * 比对源机与目标机的运行时指纹。
 *
 * 判 WARN 而不是 FAIL:换机顺带升级 dsh 是完全正当的操作,不该被工具拦下来。
 * 但后果必须说清 —— peer 裁决拒装的表现是「界面全空」,而状态层全是绿的,
 * 不给这条提示,用户会以为是 dsh-sync 搬丢了东西。
 *
 * @param {object|null} source 源机指纹(manifest.source)
 * @param {object|null} target 目标机指纹(probeRuntime 结果)
 * @returns {{status:'PASS'|'WARN', detail:string, mismatches:string[]}}
 */
export function compareRuntime(source, target) {
  const mismatches = []
  const srcVer = source === null || source === undefined ? null : semverOf(source.dshVersion)
  const dstVer = target === null || target === undefined ? null : semverOf(target.dshVersion)

  if (srcVer === null || dstVer === null) {
    const which = srcVer === null && dstVer === null
      ? '两台机器都取不到'
      : (srcVer === null ? '源机取不到' : '目标机取不到')
    return {
      status: 'WARN',
      detail: '宿主版本' + which + '(源机 ' + (srcVer === null ? '未知' : srcVer)
        + ' / 目标机 ' + (dstVer === null ? '未知' : dstVer) + '),无法自动判定兼容性,需人工确认',
      mismatches: ['dshVersion'],
    }
  }

  if (srcVer !== dstVer) {
    // 同一条 peer 区间(仅 patch/预发布不同)与跨代,后果不同,必须分开说 —— 否则会因为
    // 运行时清单恰好落后一个 patch 就让这条提示沦为噪音,真跨代时用户反而不看了。
    const sameSpan = semverSpan(srcVer) === semverSpan(dstVer)
    mismatches.push('dshVersion')
    const tail = sameSpan
      ? '仍在同一条 peer 区间内(仅 patch 或预发布标记不同),通常可继续;遇到插件加载异常先怀疑此处'
      : '插件 peer 区间可能被启动时拒绝(表现为 stays installed but startup denies it,界面里插件全空),'
        + '需在插件管理器里逐个授予精确版本豁免'
    return {
      status: 'WARN',
      detail: '宿主 dsh 版本不同(源机 ' + srcVer + ' → 目标机 ' + dstVer + '):' + tail,
      mismatches,
    }
  }

  const srcPlatform = source.platform === undefined ? null : source.platform
  const dstPlatform = target.platform === undefined ? null : target.platform
  if (srcPlatform !== null && dstPlatform !== null && srcPlatform !== dstPlatform) {
    mismatches.push('platform')
  }
  const srcArch = source.arch === undefined ? null : source.arch
  const dstArch = target.arch === undefined ? null : target.arch
  if (srcArch !== null && dstArch !== null && srcArch !== dstArch) {
    mismatches.push('arch')
  }
  const srcNode = hostNode(source)
  const dstNode = hostNode(target)
  if (srcNode !== null && dstNode !== null && semverMajor(srcNode) !== semverMajor(dstNode)) {
    mismatches.push('node')
  }

  if (mismatches.length === 0) {
    return {
      status: 'PASS',
      detail: '宿主 ' + summarizeRuntime(source) + ' 与源机一致',
      mismatches: [],
    }
  }

  const notes = []
  if (mismatches.includes('platform')) notes.push('平台不同(' + srcPlatform + ' → ' + dstPlatform + ')')
  if (mismatches.includes('arch')) notes.push('架构不同(' + srcArch + ' → ' + dstArch + ')')
  if (mismatches.includes('node')) notes.push('node 大版本不同(' + srcNode + ' → ' + dstNode + ')')
  return {
    status: 'WARN',
    detail: '宿主 dsh 版本相同(' + srcVer + '),但 ' + notes.join('、')
      + ':node_modules 含原生二进制(pty.node/conpty.node),绝不随行,必须在目标机重装'
      + (mismatches.includes('node') ? ';会话迁移还要求目标机 node ≥22.15(内建 zstd)' : ''),
    mismatches,
  }
}

/**
 * 本机身份 —— 只用来回答一个问题:「这个 bundle 是不是在这台机器、这个 DSH_HOME 上导出的」。
 *
 * 为什么需要:迁移工具**没有能力自己判断哪台是新机**,方向完全由「在哪儿调哪个工具」决定。
 * 于是有两种把方向搞反的方式,而且都不会报错:
 *   · 在新机(空壳)上跑 export → 得到一个几乎没有内容的 bundle,再拿到旧机 apply,
 *     设置与插件被覆盖成新机默认值。旧机上的 sessions 因为新 bundle 里没有而原样保留,
 *     于是「历史在、配置没了」,看起来像另一类故障。
 *   · 在旧机上跑 apply → 把真实数据按一份旧快照改写一遍。
 * 前者靠「空壳告警」拦(见 bundle.js),后者靠这里拦:同主机 + 同 DSH_HOME = 搬回它自己。
 *
 * ⚠️ 刻意**不**采集 MAC / 机器 GUID / 磁盘序列号。那些是硬件指纹,一个搬配置的工具没有理由
 * 收集它们;hostname + 用户名 + DSH_HOME 已经足够区分「同一台机器」与「另一台机器」。
 */
export function machineIdentity(dshHome) {
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    user = ''   // 极少数无 userinfo 的环境;取不到就空着,不编
  }
  return {
    hostname: os.hostname(),
    user,
    dshHome: dshHome === undefined || dshHome === null ? '' : String(dshHome),
  }
}
