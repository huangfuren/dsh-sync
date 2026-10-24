// lib/verify-engine.js — 一致性核对引擎（不含任何 UI/工具层依赖，可独立测试）。
//
// 「一致」是个可以被证伪的主张，必须能逐条核对 —— 否则迁移完成与否只能靠感觉。
// 本模块把不变量列成清单，每条给 PASS / FAIL / WARN，由调用方决定怎么呈现。
//
// 核对的不变量（按重要性）：
//   I1 bundle 自身完整（sha256 全部对得上）
//   I2 会话数量一致
//   I3 每个会话 header 的 cwd 与它所在分组目录名一致（DSH 靠这个查找，错一个就打不开）
//   I4 每个会话的容器结构完好（header 可解、帧链完整）
//   I5 workspace.json 的工作区路径与会话 cwd 逐字一致（宿主会校验 realpath）
//   I6 软链按清单重建（内部链接必须成功；外部链接允许「目标机缺路径」但必须可见）
//   I7 声明的插件源码在 bundle 中完好
//   I8 会话 cwd 指向的工作区目录在目标机真的存在（工作区代码不在 $DSH_HOME 内）
//   I9 profile 的 link: 依赖可解析、node_modules 是否已装
//   I10 状态层 7 个部分全部落地，文件数与源机一致
//   I11 宿主运行时一致（dsh 版本 / 平台 / 架构 / node 大版本）——版本不同会让插件被启动时拒装，
//       而那种失败在 I1–I10 里全是绿的，所以必须单独一条
//   I12 工作区代码在目标机真的落地（传 workspaceRoot/workspaceMap 才核对）
//   I13 落地后回写：apply 写入的关键文件（settings / 凭据 / workspace.json）自落地起
//       未被宿主进程写回盖掉（依据 apply 写下的落地回执）
//   I14 projcache 身份残留：session_projcache 两层（dump + 逐会话记录）里不再有指向
//       源机 home 的日志路径 —— 残留即宿主报 corrupt session log 并整棵拒绝激活
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { inspectBundle, verifyBundleIntegrity } from './apply-engine.js'
import { compareRuntime, probeRuntime, summarizeRuntime } from './host-env.js'
import { APPLY_RECEIPT_FILE } from './constants.js'
import { countStaleHomeRefs } from './projcache.js'
import { scanSessions, encodeSessionDir, readWorkspacePaths } from './session-migrate.js'
import { planWorkspaceTargets } from './workspace-pack.js'
import { normalizePath, toNativeForm } from './path-map.js'

/**
 * 算出「源机本来就有多少个孤立会话」作为基线。
 *
 * 关键点：bundle 里的 `state/storages/workspace.json` 与 `state/sessions/` 都还是**源机原值**，
 * 两者处在同一个路径空间里，所以可以直接比对 —— 不需要、也不能与目标机的（已重映射的）路径混算。
 * bundle 缺这两样时返回 null，调用方退回保守判定。
 *
 * @param {string} bundleDir
 * @returns {Promise<number|null>}
 */
async function countSourceOrphans(bundleDir) {
  const stateRoot = path.join(bundleDir, 'state')
  const wsFile = path.join(stateRoot, 'storages', 'workspace.json')
  if (!fs.existsSync(wsFile) || !fs.existsSync(path.join(stateRoot, 'sessions'))) return null
  let json = null
  try {
    json = JSON.parse(fs.readFileSync(wsFile, 'utf8'))
  } catch {
    return null
  }
  const registered = new Set(readWorkspacePaths(json).map((w) => normalizePath(w.path)))
  const scan = await scanSessions(stateRoot)
  const cwds = new Set(scan.sessions.filter((s) => s.cwd !== null).map((s) => normalizePath(s.cwd)))
  return [...cwds].filter((c) => !registered.has(c)).length
}

/**
 * 统计一个目录下的真实文件数（不跟随软链、跳过 node_modules）。
 * 口径必须与导出侧 collectState 一致：那边也是「真实文件计入、软链只记清单」。
 * @param {string} dir
 * @returns {number}
 */
function countFiles(dir) {
  let n = 0
  const walk = (d) => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.name === 'node_modules') continue
      const a = path.join(d, e.name)
      if (e.isDirectory()) walk(a)
      else if (e.isFile()) n += 1
    }
  }
  walk(dir)
  return n
}

/**
 * 逐条核对 bundle 与目标机的状态。
 * @param {string} bundleDir
 * @param {string} dshHome
 * @returns {Promise<{checks:object[], ok:boolean, failed:number, warned:number}>}
 */
export async function runVerify(bundleDir, dshHome, { workspaceRoot = '', workspaceMap = {} } = {}) {
  const checks = []
  const add = (id, title, status, detail) => checks.push({ id, title, status, detail })

  // ── I1 bundle 完整性 ────────────────────────────────────────────────────
  const inspected = inspectBundle(bundleDir)
  if (inspected.manifest === undefined) {
    add('I1', 'bundle 可读', 'FAIL', inspected.problems.join('；'))
    return { checks, ok: false, failed: 1, warned: 0 }
  }
  const integrity = await verifyBundleIntegrity(bundleDir)
  add('I1', 'bundle 完整性',
    integrity.ok ? 'PASS' : 'FAIL',
    integrity.ok ? 'sha256 × ' + integrity.checked + ' 全部通过' : integrity.failures.length + ' 个文件不符：'
      + integrity.failures.slice(0, 5).map((f) => f.file + '(' + f.reason + ')').join('、'))

  const manifest = inspected.manifest
  const stateMeta = manifest.state || null

  // ── I2 会话数量（目录数 + 日志文件数，后者能抓到「目录在、某一版日志丢了」）──
  const scan = await scanSessions(dshHome)
  const actualLogs = scan.sessions.reduce((n, s) => n + (s.logs || []).length, 0)
  const expectedSessions = stateMeta && stateMeta.sessions ? stateMeta.sessions.total : null
  const expectedLogs = stateMeta && stateMeta.sessions && typeof stateMeta.sessions.logFiles === 'number'
    ? stateMeta.sessions.logFiles
    : null
  if (expectedSessions === null) {
    add('I2', '会话数量', 'WARN', 'bundle 未记录会话清单（导出时未开 includeState 或 zstd 不可用），无法核对')
  } else if (scan.sessions.length !== expectedSessions) {
    add('I2', '会话数量', 'FAIL', '目标机 ' + scan.sessions.length + ' 个会话目录，源机 ' + expectedSessions + ' 个')
  } else if (expectedLogs !== null && actualLogs < expectedLogs) {
    add('I2', '会话数量', 'FAIL', '目标机 ' + actualLogs + ' 份会话日志，源机 ' + expectedLogs + ' 份（少了 '
      + (expectedLogs - actualLogs) + ' 份）')
  } else {
    add('I2', '会话数量', 'PASS', scan.sessions.length + ' 个会话 / ' + actualLogs + ' 份日志，与源机一致')
  }

  // ── I3 cwd 与分组目录名一致 ─────────────────────────────────────────────
  const withCwd = scan.sessions.filter((s) => s.cwd !== null)
  const mismatched = withCwd.filter((s) => encodeSessionDir(s.cwd) !== s.groupDir)
  add('I3', '会话目录名 = cwd 编码',
    mismatched.length === 0 ? 'PASS' : 'FAIL',
    mismatched.length === 0
      ? '全部 ' + withCwd.length + ' 个会话目录名与 header cwd 编码一致'
      : mismatched.length + ' 个不一致：' + mismatched.slice(0, 5).map((s) => s.dirName + '（应为 ' + encodeSessionDir(s.cwd) + '）').join('、'))

  // ── I4 会话容器结构 ─────────────────────────────────────────────────────
  // 这三种都是**源机就存在**的情况：没有日志 / header 读不出 / 帧链不完整。
  // 迁移对这些文件是逐字节复制（改写只在帧链完整时才做），所以目标机的状态必与源机一致，
  // 判 FAIL 等于把源机的既有状况报成迁移失败（I5 曾犯过同样的错）。
  // 真正的「落地丢东西」由 I2 的日志份数比较负责。
  const noLog = scan.sessions.filter((s) => (s.logs || []).length === 0)
  const unreadable = scan.sessions.filter((s) => (s.logs || []).length > 0 && s.cwd === null)
  const torn = scan.sessions.filter((s) => s.cwd !== null && !s.clean)
  const logFiles = scan.sessions.reduce((n, s) => n + (s.logs || []).length, 0)
  if (unreadable.length === 0 && torn.length === 0) {
    add('I4', '会话容器结构', 'PASS',
      '全部 ' + logFiles + ' 份日志 header 可解、帧链完整'
      + (noLog.length ? '（另有 ' + noLog.length + ' 个会话目录没有任何日志，源机即如此）' : ''))
  } else {
    add('I4', '会话容器结构', 'WARN',
      (unreadable.length ? unreadable.length + ' 个会话的日志全部读不出 header；' : '')
      + (torn.length ? torn.length + ' 个会话含帧链不完整的日志；' : '')
      + (noLog.length ? noLog.length + ' 个会话目录没有任何日志；' : '')
      + '这些文件均按原样复制，未做改写')
  }

  // ── I5 workspace.json 与会话 cwd 一致 ───────────────────────────────────
  const wsPath = path.join(dshHome, 'storages', 'workspace.json')
  if (!fs.existsSync(wsPath)) {
    add('I5', '工作区记录', 'WARN', '目标机没有 storages/workspace.json')
  } else {
    let wsJson = null
    try {
      wsJson = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
    } catch {
      add('I5', '工作区记录', 'FAIL', 'workspace.json 不是合法 JSON')
    }
    if (wsJson !== null) {
      const wsPaths = readWorkspacePaths(wsJson)
      const sessionCwds = new Set(withCwd.map((s) => normalizePath(s.cwd)))
      const orphanSessions = [...sessionCwds].filter((c) => !wsPaths.some((w) => normalizePath(w.path) === c))
      const emptyWorkspaces = wsPaths.filter((w) => !sessionCwds.has(normalizePath(w.path)))
      // 逐字形态检查（实测教训 P4）：宿主 attach 校验把 realpathNormalize(header.cwd) 与
      // record.path **逐字比较**——normalize 后相等还不够，record.path 必须是平台原生形态
      // （Win32 反斜杠）。record 是正斜杠时，工作区内新建会话必报
      // `session/workspace-attach-failed ... its cwd resolves to 'E:\...'`。
      const formMismatch = wsPaths.filter((w) => typeof w.path === 'string' && toNativeForm(w.path) !== w.path)
      const addI5 = (status, detail) => add('I5', '工作区记录', status, detail)
      if (orphanSessions.length === 0 && emptyWorkspaces.length === 0 && formMismatch.length === 0) {
        addI5('PASS', wsPaths.length + ' 个工作区，与会话 cwd 完全对齐且为原生形态')
      } else {
        // 孤立会话未必是迁移造成的：源机自己就可能有会话的工作区没进 workspace.json。
        // verify 的职责是判断「迁移有没有把状态弄丢」，不是责怪源机的既有状态。
        // 因此拿 bundle 里的源机副本（原始 workspace.json + 会话副本，同一路径空间）算出基线，
        // 不超过基线 → WARN；超过 → FAIL（说明映射漏了一条或落地丢了记录）。
        const baseline = await countSourceOrphans(bundleDir)
        const introduced = baseline === null ? orphanSessions.length : Math.max(0, orphanSessions.length - baseline)
        const detail = (orphanSessions.length
          ? orphanSessions.length + ' 个会话的 cwd 未登记在 workspace.json（会显示为孤立）：'
            + orphanSessions.slice(0, 3).join('、') + '；'
          : '')
          + (emptyWorkspaces.length ? emptyWorkspaces.length + ' 个工作区没有任何会话；' : '')
          + (formMismatch.length
            ? formMismatch.length + ' 个 record.path 不是平台原生形态（宿主 attach 逐字比较会失败，'
              + '工作区内新建会话报 workspace-attach-failed）：' + formMismatch.slice(0, 2).join('、') + '；'
            : '')
          + (baseline === null
            ? 'bundle 不含源机副本，无法判断是否迁移引入'
            : introduced > 0
              ? '其中 ' + introduced + ' 个是迁移新增的孤立（检查 mappings 是否漏了一条）'
              : '源机本来就有 ' + baseline + ' 个孤立会话，本次迁移没有新增')
        addI5(introduced > 0 ? 'FAIL' : 'WARN', detail)
      }
    }
  }

  // ── I6 软链 ─────────────────────────────────────────────────────────────
  const linksPath = path.join(bundleDir, 'state', 'links.json')
  if (!fs.existsSync(linksPath)) {
    add('I6', '软链重建', 'WARN', 'bundle 不含 state/links.json，无法核对')
  } else {
    let doc = null
    try {
      doc = JSON.parse(fs.readFileSync(linksPath, 'utf8'))
    } catch { /* 下面按 FAIL 处理 */ }
    if (doc === null) {
      add('I6', '软链重建', 'FAIL', 'state/links.json 读不出')
    } else {
      const all = doc.links || []
      const expectInternal = all.filter((l) => l.kind === 'internal')
      const expectExternal = all.filter((l) => l.kind === 'external')
      // 只判断「是链接」不够：目标机 $DSH_HOME 换过位置时，链接可能存在但指向源机路径 → 断链。
      // internal 链接必须「是链接 且 目标可达」，否则等于没还原。
      const linkAlive = (abs) => {
        try {
          return fs.lstatSync(abs).isSymbolicLink() && fs.existsSync(abs)
        } catch {
          return false
        }
      }
      const linkIsLink = (abs) => { try { return fs.lstatSync(abs).isSymbolicLink() } catch { return false } }
      const missingInternal = expectInternal
        .filter((l) => !linkAlive(path.join(dshHome, l.scope, l.rel.split('/').join(path.sep))))
        .map((l) => l.rel)
      const missingExternal = expectExternal
        .filter((l) => !linkIsLink(path.join(dshHome, l.scope, l.rel.split('/').join(path.sep))))
        .map((l) => l.rel)

      if (all.length === 0) {
        add('I6', '软链重建', 'PASS', 'bundle 未记录任何软链')
      } else if (missingInternal.length === 0) {
        add('I6', '软链重建', 'PASS',
          '内部链接 ' + expectInternal.length + '/' + expectInternal.length + ' 已重建且目标可达'
          + (expectExternal.length ? '；外部链接 ' + (expectExternal.length - missingExternal.length) + '/' + expectExternal.length + ' 已重建' : ''))
      } else {
        add('I6', '软链重建', 'FAIL',
          missingInternal.length + ' 个内部链接缺失或目标不可达（$DSH_HOME 位置是否变过？）：'
          + missingInternal.slice(0, 5).join('、'))
      }
      if (missingExternal.length > 0) {
        add('I6b', '外部链接可见性', 'WARN',
          missingExternal.length + ' 个指向 $DSH_HOME 外部的链接未重建（目标机缺对应路径）：'
          + missingExternal.slice(0, 5).join('、'))
      }
    }
  }

  // ── I7 插件源码 ─────────────────────────────────────────────────────────
  const plugins = manifest.plugins || []
  if (plugins.length === 0) {
    add('I7', '插件源码', 'PASS', '本 bundle 未 vendoring 插件源码')
  } else {
    const missing = plugins.filter((p) => {
      const rel = p.bundlePath || path.join('plugins', p.name)
      return !fs.existsSync(path.join(bundleDir, rel.split('/').join(path.sep)))
    })
    add('I7', '插件源码',
      missing.length === 0 ? 'PASS' : 'FAIL',
      missing.length === 0 ? plugins.length + ' 个插件源码在 bundle 中完好' : missing.length + ' 个缺失：' + missing.map((x) => x.name).join('、'))
  }

  // ── I8 工作区目录是否真的在目标机上 ─────────────────────────────────────
  // 会话 cwd 对得上只是「字符串对得上」。工作区的**内容**不在 $DSH_HOME 里(它们是独立仓库),
  // 目标机没有那个目录时,DSH 能列出会话却打不开 —— 只说 PASS 等于骗人。
  // P12 补强：workspace.json 里**注册了**但目录缺失的工作区也要点名 —— 会话可能一个都
  // 没聊过（不出现在会话 cwd 里），但宿主 attach 到它时照样报错。给出两条出路：
  // 建空占位目录（宿主激活不受缺失目录影响，attach 时该工作区为空）或移除该注册。
  const distinctCwds = [...new Set(withCwd.map((s) => s.cwd))]
  const missingCwds = distinctCwds.filter((c) => !fs.existsSync(c))
  let registeredMissing = []
  try {
    const wsJson8 = JSON.parse(fs.readFileSync(wsPath, 'utf8'))
    registeredMissing = readWorkspacePaths(wsJson8)
      .map((w) => w.path)
      .filter((p) => typeof p === 'string' && p !== '' && !fs.existsSync(p))
  } catch { /* 没有/workspace.json 坏：I5 已报，这里不重复 */ }
  const registeredOnlyMissing = registeredMissing.filter(
    (p) => !distinctCwds.some((c) => normalizePath(c) === normalizePath(p)),
  )
  add('I8', '工作区目录存在性',
    distinctCwds.length === 0 && registeredMissing.length === 0 ? 'WARN'
      : missingCwds.length === 0 && registeredMissing.length === 0 ? 'PASS' : 'WARN',
    distinctCwds.length === 0 && registeredMissing.length === 0
      ? '没有任何会话记录工作区，无需核对'
      : (missingCwds.length === 0
          ? '全部 ' + distinctCwds.length + ' 个会话工作区目录在目标机存在'
          : missingCwds.length + '/' + distinctCwds.length + ' 个会话工作区目录在目标机不存在，这些会话能列出但打不开'
            + '（工作区代码不在 $DSH_HOME 内，需单独拷贝或用 mappings 指向已有目录）：'
            + missingCwds.slice(0, 3).join('、'))
        + (registeredMissing.length === 0 ? ''
          : '；' + registeredMissing.length + ' 个已注册工作区目录不存在'
            + (registeredOnlyMissing.length > 0
              ? '（其中 ' + registeredOnlyMissing.length + ' 个没有任何会话指向）：'
                + registeredMissing.slice(0, 3).join('、')
              : '：' + registeredMissing.slice(0, 3).join('、'))
            + '。处置：建空占位目录可保证宿主正常挂载（该工作区内容为空），或移除该注册'))

  // ── I9 profile 依赖可解析 ───────────────────────────────────────────────
  // 「插件情况」最终由 profile 的 package.json 决定:装什么(dependencies)+ 加载什么
  // (dsh.profile.bundles)。link: 指向不存在的目录 = 该插件确定装不上,pnpm 会当场报错。
  const profRoot = path.join(dshHome, 'profiles')
  if (!fs.existsSync(profRoot)) {
    add('I9', 'profile 依赖', 'WARN', '目标机没有 profiles 目录')
  } else {
    const broken = []
    const noModules = []
    let linkTotal = 0
    let profileCount = 0
    for (const name of fs.readdirSync(profRoot)) {
      const pdir = path.join(profRoot, name)
      const pkgFile = path.join(pdir, 'package.json')
      if (!fs.existsSync(pkgFile) || !fs.statSync(pdir).isDirectory()) continue
      profileCount += 1
      let pkg = null
      try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      } catch {
        broken.push(name + ' 的 package.json 不是合法 JSON')
        continue
      }
      for (const [dep, spec] of Object.entries(pkg.dependencies || {})) {
        if (!String(spec).startsWith('link:')) continue
        linkTotal += 1
        const rel = String(spec).slice('link:'.length)
        const abs = path.isAbsolute(rel) ? rel : path.resolve(pdir, rel)
        if (!fs.existsSync(abs)) broken.push(name + ' → ' + dep + '（' + abs + ' 不存在）')
      }
      if (!fs.existsSync(path.join(pdir, 'node_modules'))) noModules.push(name)
    }
    if (profileCount === 0) {
      add('I9', 'profile 依赖', 'WARN', '没有可读的 profile（缺少 package.json）')
    } else if (broken.length > 0) {
      add('I9', 'profile 依赖', 'FAIL',
        broken.length + ' 个 link: 依赖指向不存在的目录，对应插件装不上：' + broken.slice(0, 3).join('、'))
    } else if (noModules.length > 0) {
      add('I9', 'profile 依赖', 'WARN',
        'link: 依赖 ' + linkTotal + '/' + linkTotal + ' 可解析；但 ' + noModules.join('、')
        + ' 还没有 node_modules —— 落地后需在目标机跑一次 pnpm install 或 dsh plugin add，否则 dsh 起不来')
    } else {
      add('I9', 'profile 依赖', 'PASS',
        profileCount + ' 个 profile，link: 依赖 ' + linkTotal + '/' + linkTotal + ' 可解析且已安装')
    }
  }

  // ── I10 状态层覆盖 ─────────────────────────────────────────────────────
  // 「导出了但没落地」是本插件最该防的错:两边清单必须一致,数量对不上就说明丢了东西。
  if (!stateMeta || !Array.isArray(stateMeta.parts)) {
    add('I10', '状态层覆盖', 'WARN', 'bundle 未记录状态层清单（导出时未开 includeState）')
  } else {
    const want = stateMeta.parts.filter((p) => p.present)
    const lacking = []
    for (const p of want) {
      const dir = path.join(dshHome, p.name)
      if (!fs.existsSync(dir)) { lacking.push(p.name + '（整目录缺失）'); continue }
      const got = countFiles(dir)
      if (got < p.files) lacking.push(p.name + '（源机 ' + p.files + ' 个文件，目标机 ' + got + ' 个）')
    }
    add('I10', '状态层覆盖',
      lacking.length === 0 ? 'PASS' : 'FAIL',
      lacking.length === 0
        ? want.map((p) => p.name).join(' / ') + ' 全部落地，文件数一致'
        : lacking.length + ' 项不完整：' + lacking.slice(0, 4).join('；'))
  }

  // ── I11 宿主运行时一致 ─────────────────────────────────────────────────
  // I1–I10 全绿仍然可能「界面里插件全空」:宿主启动时会做 peer 兼容性裁决,
  // 版本对不上时插件的下场是 stays installed but startup denies it —— 文件都在、状态全对,
  // 就是不加载。这条不变量专门抓这种「状态层之外」的失败。
  const targetEnv = await probeRuntime(dshHome)
  const runtimeCmp = compareRuntime(manifest.source || null, targetEnv)
  add('I11', '宿主运行时一致性', runtimeCmp.status,
    runtimeCmp.detail + '（目标机 ' + summarizeRuntime(targetEnv) + '，来源 ' + targetEnv.source + '）')

  // ── I12 工作区代码落地 ─────────────────────────────────────────────────
  // 会话 cwd 指向的是项目目录，而项目目录在 $DSH_HOME 之外。bundle 声明了工作区却没有落地时，
  // 会话能被列出、点开是空目录 —— I8 只会说「缺目录」，分不清是「没搬」还是「搬到了别处」。
  const wsEntries = Array.isArray(manifest.workspaces) ? manifest.workspaces : []
  if (wsEntries.length === 0) {
    add('I12', '工作区代码落地', 'PASS', 'bundle 不含工作区代码（只搬了 .dsh；会话的项目目录需另行准备）')
  } else {
    const plan = planWorkspaceTargets(wsEntries, { workspaceRoot, overrides: workspaceMap })
    if (plan.targets.length === 0) {
      // 不知道落在哪就无法核对。这不是失败，而是信息不足 —— 报 WARN 并说清怎么补。
      add('I12', '工作区代码落地', 'WARN',
        'bundle 含 ' + wsEntries.length + ' 个工作区，但未指定 workspaceRoot/workspaceMap，无法核对是否落地'
        + '（其余检查不受影响）')
    } else {
      const problems = [...plan.errors]
      const okTargets = []
      for (const t of plan.targets) {
        const st = fs.existsSync(t.destPath) ? fs.statSync(t.destPath) : null
        if (st === null || !st.isDirectory()) {
          problems.push('未落地 ' + t.name + ' → ' + t.destPath)
          continue
        }
        let topCount = 0
        try { topCount = fs.readdirSync(t.destPath).length } catch { topCount = 0 }
        if (topCount === 0) {
          problems.push('已落地但为空 ' + t.destPath)
          continue
        }
        okTargets.push(t.name)
      }
      add('I12', '工作区代码落地',
        problems.length === 0 ? 'PASS' : 'FAIL',
        problems.length === 0
          ? wsEntries.length + ' 个工作区已落地：' + okTargets.join('、')
          : problems.join('；') + '（用 dshsync_apply 传 workspaceRoot 落地，或先把目录准备到位）')
    }
  }

  // ── I13 落地后回写 ──────────────────────────────────────────────────────
  // apply 跑在活着的宿主进程里，settings / workspace.json 都被宿主持有：落地之后、
  // 重启 dsh 之前，宿主随时可能把内存里的旧配置写回、盖掉刚落地的文件——表现是
  // 「迁移成功，重启后设置全变旧」。apply 落地时把写入内容的 sha256 记成回执
  // （$DSH_HOME/.dsh-sync-apply-receipt.json），这里逐个复核。指纹按内容比较，
  // 宿主原样重写（内容没变）不会误报；只有内容真的变了才 FAIL。
  const receiptPath = path.join(dshHome, APPLY_RECEIPT_FILE)
  let receipt = null
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.files !== null && typeof parsed.files === 'object') {
      receipt = parsed
    }
  } catch { receipt = null }
  if (receipt === null) {
    add('I13', '落地后回写', 'WARN',
      '没有落地回执（本 bundle 不是由 dshsync_apply 落地，或由 0.13.1 之前的版本落地），无法检测宿主回写')
  } else {
    const drifted = []
    for (const [rel, expected] of Object.entries(receipt.files)) {
      let actual = null
      try {
        actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dshHome, rel))).digest('hex')
      } catch { actual = null }
      if (actual !== expected) drifted.push(rel)
    }
    if (drifted.length === 0) {
      add('I13', '落地后回写', 'PASS',
        'settings / 凭据 / workspace.json 自落地（' + String(receipt.appliedAt || '?') + '）起未被改写')
    } else {
      add('I13', '落地后回写', 'FAIL',
        drifted.join('、') + ' 在落地之后又被改写。若不是你本人改的，就是宿主进程把内存里的旧配置写回了'
        + '——这种覆盖重启也不会恢复：请完全退出 dsh（桌面版从托盘退出）后重新 apply，再跑本核验；'
        + '若确是你本人的改动，忽略本条')
    }
  }

  // ── I14 projcache 身份残留 ──────────────────────────────────────────────
  // 逐会话记录内嵌日志绝对路径，宿主 assertStoredIdentity 拿它与日志实际位置互校；
  // 任何一层还带着源机 home 前缀，就是 `corrupt session log` + workspaceRegistry
  // 整棵拒绝激活（P10 实测：93 个记录文件里 77 个带旧路径）。这不是提示性问题，
  // 是「工作区打不开、会话看不到、日程全 pending」的致命级失败。
  const srcHome14 = typeof manifest.sourceDshHome === 'string' ? manifest.sourceDshHome : ''
  if (srcHome14 === '' || normalizePath(srcHome14) === normalizePath(dshHome)) {
    add('I14', 'projcache 身份', 'PASS', '本机即源 home（或 bundle 未记录源 home），无跨机残留可查')
  } else {
    const stale = countStaleHomeRefs(dshHome, srcHome14)
    add('I14', 'projcache 身份', stale.total === 0 ? 'PASS' : 'FAIL',
      stale.total === 0
        ? 'session_projcache 两层（dump + 逐会话记录）无源机路径残留'
        : 'session_projcache 仍有 ' + stale.total + ' 处指向源机 ' + srcHome14
          + '（dump ' + stale.dump + ' / 逐会话记录 ' + stale.records + '）。宿主会报 corrupt session log'
          + ' 并拒绝激活 workspaceRegistry —— 重跑一次 dshsync_apply（幂等，会重映射 projcache 两层）：'
          + stale.examples.slice(0, 3).join('、'))
  }

  const failed = checks.filter((c) => c.status === 'FAIL').length
  const warned = checks.filter((c) => c.status === 'WARN').length
  return { checks, ok: failed === 0, failed, warned }
}
