// lib/deps-install.js — profile 依赖的重装：自动尝试 + 一键安装脚本兜底。
//
// 实测教训（P1）：宿主重启**不会**自动按新 package.json 重装 node_modules——apply 覆写
// 声明后重启，全部插件「异常 / 包不可用」，宿主不报任何错。而手工重装最痛的一步是
// 「找到宿主自带的 pnpm」：桌面机 PATH 上没有 pnpm，它藏在应用安装目录的
// resources/runtime/primary-runtime/dependencies/ 下，用户得自己去翻。
//
// 本模块做两件事：
//   ① 解析宿主自带 runtime 的 node 与 pnpm 的可执行路径（从当前进程 execPath 推导——
//      插件就跑在宿主的 node 子进程里，execPath 即运行时 node）；
//   ② 两条重装通路：
//      · installDepsNow —— 进程内 spawn pnpm install（宿主还活着，Windows 上可能因
//        运行中的宿主锁文件而失败，失败如实上报，不掩盖）；
//      · writeInstallScript —— 生成一键脚本（退出 dsh 后运行，无文件锁，必定干净）。
//      两条通路共用同一套缺失依赖判定。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 读一个 profile 声明的依赖，返回 node_modules 里缺失的包名清单。
 * link: 依赖也按目录存在性判（pnpm 会把它装成 node_modules 下的链接）。
 */
export function missingDepsOf(profileDir) {
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const deps = Object.keys(pkg.dependencies || {})
  return deps.filter((d) => !fs.existsSync(path.join(profileDir, 'node_modules', ...d.split('/'))))
}

/** 在 pnpm 目录浅层（≤3 层）找 pnpm 的 CJS 入口。 */
function findPnpmFile(dir, depth = 3) {
  if (depth < 0) return null
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of ents) {
    if (e.isFile() && (e.name === 'pnpm.cjs' || e.name === 'pnpm.js')) return path.join(dir, e.name)
  }
  for (const e of ents) {
    if (e.isDirectory() && e.name !== 'node_modules') {
      const hit = findPnpmFile(path.join(dir, e.name), depth - 1)
      if (hit !== null) return hit
    }
  }
  return null
}

/**
 * 解析宿主自带运行时的 node 与 pnpm 可执行路径。
 *
 * 插件跑在宿主的 node 子进程里，`process.execPath` 就是运行时 node。桌面版布局是
 * `.../dependencies/{node,pnpm}`（实测），所以从 node 向上两级找 pnpm 兄弟目录。
 * 找不到 pnpm 不编造：返回 null，让调用方退回「用户手工装」并如实说明。
 *
 * @param {{execPath?:string}} [opts] execPath 可注入（测试用）
 * @returns {{nodePath:string|null, pnpmFile:string|null, source:string}}
 */
export function resolveRuntimeTools({ execPath = process.execPath } = {}) {
  if (typeof execPath !== 'string' || execPath === '') {
    return { nodePath: null, pnpmFile: null, source: 'none' }
  }
  const nodeDir = path.dirname(execPath)
  // execPath = <...>/dependencies/node/node(.exe) → nodeDir = dependencies/node
  const depsDir = path.basename(nodeDir).toLowerCase() === 'node' ? path.dirname(nodeDir) : nodeDir
  const pnpmFile = findPnpmFile(path.join(depsDir, 'pnpm'))
  return {
    nodePath: execPath,
    pnpmFile,
    source: pnpmFile !== null ? 'host-runtime' : 'pnpm-not-found',
  }
}

/**
 * 生成一键重装脚本（ps1 + sh，行为一致）。
 * @param {string} dshHome 脚本写到 $DSH_HOME 根下
 * @param {object} o
 * @param {Array<{name:string, dir:string}>} o.profiles 缺依赖的 profile（name + 目录）
 * @param {string} o.nodePath
 * @param {string} o.pnpmFile
 * @returns {{ps1:string, sh:string, profiles:string[]}|null} 没有 node/pnpm 或没有缺依赖的 profile 时返回 null
 */
export function writeInstallScript(dshHome, { profiles, nodePath, pnpmFile }) {
  const targets = (profiles || []).filter((p) => missingDepsOf(p.dir).length > 0)
  if (!nodePath || !pnpmFile || targets.length === 0) return null
  const qPs1 = (s) => '"' + String(s) + '"'
  const ps1 = [
    '# dsh-sync 生成：重装 profile 缺失的依赖（宿主重启不会自动装，见 dsh-sync 的必办说明）',
    '# 用法：完全退出 dsh（桌面版从托盘退出）→ 右键"使用 PowerShell 运行"本文件 → 完成后重新打开 dsh。',
    '$ErrorActionPreference = "Continue"',
    'Write-Host "== dsh-sync 依赖重装 =="',
  ]
  const sh = [
    '#!/bin/sh',
    '# dsh-sync 生成：重装 profile 缺失的依赖。完全退出 dsh 后运行本文件。',
    'set +e',
    'echo "== dsh-sync 依赖重装 =="',
  ]
  for (const t of targets) {
    ps1.push('Write-Host "-- profile ' + t.name + ' --"')
    ps1.push('Set-Location ' + qPs1(t.dir))
    ps1.push('& ' + qPs1(nodePath) + ' ' + qPs1(pnpmFile) + ' install')
    sh.push('echo "-- profile ' + t.name + ' --"')
    sh.push('cd ' + JSON.stringify(t.dir))
    sh.push(JSON.stringify(nodePath) + ' ' + JSON.stringify(pnpmFile) + ' install')
  }
  ps1.push('Write-Host "== 完成：重新打开 dsh，再到插件管理器确认全部已激活 =="')
  sh.push('echo "== 完成：重新打开 dsh，再到插件管理器确认全部已激活 =="')
  const ps1Path = path.join(dshHome, '.dsh-sync-install-deps.ps1')
  const shPath = path.join(dshHome, '.dsh-sync-install-deps.sh')
  fs.writeFileSync(ps1Path, ps1.join('\r\n') + '\r\n', 'utf8')
  fs.writeFileSync(shPath, sh.join('\n') + '\n', { encoding: 'utf8', mode: 0o755 })
  return { ps1: ps1Path, sh: shPath, profiles: targets.map((t) => t.name) }
}

/** 默认执行器：spawn 宿主 node 跑 pnpm install，收集退出码与 stderr 尾部。 */
function defaultRunner({ cwd, nodePath, pnpmFile, timeoutMs }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(nodePath, [pnpmFile, 'install'], { cwd, env: process.env, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) })
      return
    }
    let errTail = ''
    child.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000) })
    child.stdout.on('data', () => {})
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 进程已退出就不必杀 */ }
      resolve({ ok: false, error: '超时（' + Math.round(timeoutMs / 60000) + ' 分钟）' })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: (err && err.message) || String(err) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        code,
        error: code === 0 ? null : 'pnpm install 退出码 ' + code + (errTail ? '：' + errTail.slice(-300) : ''),
      })
    })
  })
}

/**
 * 对缺依赖的 profile 逐个尝试自动重装。
 *
 * 宿主还活着时 Windows 可能锁住运行中的原生模块导致安装失败 —— 这不是掩盖的理由，
 * 失败结果原样返回，调用方保留一键脚本作为兜底并如实告知。
 *
 * @param {object} o
 * @param {Array<{name:string, dir:string}>} o.targets 缺依赖的 profile 清单
 * @param {string} o.nodePath
 * @param {string} o.pnpmFile
 * @param {({cwd:string,nodePath:string,pnpmFile:string,timeoutMs:number})=>Promise<{ok:boolean,code?:number,error?:string}>} [o.runner] 可注入（测试用）
 * @param {number} [o.timeoutMs] 单个 profile 的安装超时（默认 10 分钟）
 * @param {(line:string)=>void} [o.onLog]
 * @returns {Promise<Array<{profile:string, ok:boolean, error?:string}>>}
 */
export async function installDepsNow({ targets, nodePath, pnpmFile, runner, timeoutMs = 10 * 60_000, onLog } = {}) {
  const log = onLog || (() => {})
  const run = runner || defaultRunner
  const out = []
  for (const t of targets || []) {
    log('  · pnpm install @ profile ' + t.name + ' …')
    const r = await run({ cwd: t.dir, nodePath, pnpmFile, timeoutMs })
    out.push({ profile: t.name, ok: r.ok === true, error: r.ok === true ? null : (r.error || '未知失败') })
    log(r.ok ? '  ✓ ' + t.name + ' 依赖已重装' : '  ✗ ' + t.name + ' 自动重装失败：' + (r.error || '未知'))
  }
  return out
}
