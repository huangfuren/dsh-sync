#!/usr/bin/env node
// scripts/export-cli.mjs — 独立命令行导出器(不依赖 dsh-tools,也不需要 dsh 在跑)。
// 存在的理由:换机的起点往往是"旧机还能开",但用户不想为了导出配置去背工具参数 /
// 记 profile 名字。双击一下,跟着提示走完,拿到的就是一个可以直接拷走的目录。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { exportBundle, listProfiles } = await import(pathToFileURL(path.join(HERE, 'lib', 'bundle.js')).href)
const { buildApplyPs1, buildApplySh, buildApplyBat } = await import(pathToFileURL(path.join(HERE, 'lib', 'apply-script.js')).href)
const { execFileSync } = await import('node:child_process')

function writeScripts(dir, m) {
  fs.writeFileSync(path.join(dir, 'apply.ps1'), buildApplyPs1(m), 'utf8')
  fs.writeFileSync(path.join(dir, 'apply.sh'), buildApplySh(m), 'utf8')
  const bat = buildApplyBat(m)
  fs.writeFileSync(path.join(dir, '一键恢复.bat'), bat, 'utf8')
  fs.writeFileSync(path.join(dir, 'RESTORE.bat'), bat, 'utf8') // ASCII 备用名
}

const WORDS = ['tulip', 'orbit', 'cinder', 'harbor', 'quartz', 'ember', 'lagoon', 'violet']
function genPass() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)]
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`
}

function ask(question, fallback = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(String(a).trim() || fallback) }))
}

// 支持命令行参数,方便脚本化调用;不给参数时才走问答式交互(双击场景)。
function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? '' : String(process.argv[i + 1] || '')
}
const presetOut = arg('--out')
const presetPass = arg('--passphrase')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
console.log('')
console.log('================ dsh 配置导出 ================')
console.log('把这台机器的 dsh 配置打包成可以直接拷走的文件夹。')
console.log('本机配置目录:', dshHome)
console.log('')

const profiles = await listProfiles(dshHome)
if (profiles.length === 0) {
  console.error('没有找到任何 profile,检查一下配置目录是不是对的:', path.join(dshHome, 'profiles'))
  process.exit(1)
}
console.log('发现以下 profile:', profiles.join(', '))
console.log('')

let picked = String(arg('--profiles') || '').split(',').map((s) => s.trim()).filter(Boolean)
if (picked.length === 0) {
  const answer = await ask(`要导出哪些?\n  直接回车 = 全部(${profiles.length} 个)\n  也可以只写其中一个,例如: web\n> `, '')
  picked = answer ? answer.split(',').map((s) => s.trim()).filter(Boolean) : profiles
}
const unknown = picked.filter((p) => !profiles.includes(p))
if (unknown.length) {
  console.error('没有这些 profile:', unknown.join(', '), '。可选:', profiles.join(', '))
  process.exit(1)
}
console.log('本次导出:', picked.join(', '))

const defaultOut = path.join(path.dirname(dshHome), `dsh-migrate-${new Date().toISOString().slice(0, 10)}`)
let outDir = presetOut
if (!outDir) {
  outDir = await ask(`导出到哪个文件夹?\n  (直接回车用默认: ${defaultOut})\n> `, defaultOut)
}

let pass = presetPass
if (!pass) {
  console.log('')
  console.log('密钥会用 AES-256-GCM 加密后再放进包里,所以需要一把口令。')
  console.log('  - 想自己设:直接输入(至少 6 位,纯字母数字和 - 都行)')
  console.log('  - 懒得想:直接回车,我帮你生成一个')
  pass = await ask('> ')
}
if (pass && pass.length < 6) {
  console.error('口令太短了,至少要 6 位。重来一次。')
  process.exit(1)
}
if (!pass) pass = genPass()

console.log('')
fs.rmSync(outDir, { recursive: true, force: true })
const { bundleDir, manifest } = await exportBundle({
  dshHome,
  profiles: picked,
  outDir,
  includeCredentials: true,
  includePlugins: true,
  passphrase: pass,
  writeScripts,
  onLog: (l) => console.log('   ', l),
})

console.log('')
console.log('================ 导出完成 ================')
console.log('')
console.log('  文件夹:', bundleDir)
console.log('  口令  :', pass, presetPass ? '(你自己设的)' : '(自动生成的)')
console.log('  内容  :', manifest.profiles.map((p) => p.name).join(', '), '/', manifest.plugins.length, '个插件源码')
if (manifest.notMigrated.length) {
  console.log('')
  console.log('  以下内容故意不带走(不是遗漏):')
  for (const n of manifest.notMigrated) console.log('   ·', n.summary)
}
console.log('')
// 口令落在 bundle 外面:放进包里等于把钥匙挂在锁上,传包时又会一起拷走。
const notePath = path.join(path.dirname(bundleDir), '【重要】迁移口令.txt')
fs.writeFileSync(notePath, [
  'dsh 迁移口令:',
  '',
  `  ${pass}`,
  '',
  `对应文件夹: ${bundleDir}`,
  '',
  '在新机上双击「一键恢复.bat」,按提示输入这串口令即可。',
  '恢复完成后请把本文件和整个迁移文件夹一起删除(里面含加密密钥)。',
  '',
].join('\n'), 'utf8')
console.log('口令已另外保存到(不在包里面,免得传包时一起泄露):')
console.log('  ', notePath)
console.log('')
console.log('接下来:')
console.log('  1. 把整个文件夹拷到新电脑(U盘 / 网盘 / 局域网都行)')
console.log('  2. 新电脑上先确认 node / pnpm / dsh 三个命令都能用')
console.log('  3. 双击文件夹里的「一键恢复.bat」')
console.log('')
console.log(execFileSync(process.execPath, [path.join(bundleDir, 'tools', 'dsync-helper.mjs'), 'verify'], { encoding: 'utf8' }).trim())
console.log('')
