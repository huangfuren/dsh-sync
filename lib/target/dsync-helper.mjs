#!/usr/bin/env node
// This file is COPIED VERBATIM into the exported bundle as tools/dsync-helper.mjs.
// It must stay SELF-CONTAINED: the target machine has no dsh-sync installed (that is the
// whole point of the bootstrap-free design), so it may only use Node built-in modules and
// must never import anything from the plugin. Keep it dependency-free.
//
// Commands:
//   verify                                  check every file against checksums.json
//   decrypt --kind settings|credentials --out <file>
//                                           decrypt a secret payload into <file>
//   prepare-settings --out <file>           decrypt (if needed) + remap absolute paths → <file>
//   info                                    print a short bundle summary
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Keep in sync with lib/crypto.js — duplicated on purpose (self-containment requirement).
const MAGIC = 'dshsync1'
const ALG = 'aes-256-gcm'
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT = { N: 2 ** 14, r: 8, p: 1 }

// Key codes, spelled numerically so this file stays free of literal control characters.
const CR = 13
const LF = 10
const ETX = 3
const DEL = 127
const BS = 8

function fail(msg, code = 1) {
  process.stderr.write(`dsync-helper: ${msg}\n`)
  process.exit(code)
}

function arg(flag, rest) {
  const i = rest.indexOf(flag)
  return i === -1 ? undefined : rest[i + 1]
}

function sha256(abs) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(abs))
  return h.digest('hex')
}

async function verify() {
  const table = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'checksums.json'), 'utf8'))
  const entries = table.entries || table
  const missing = []
  const mismatched = []
  let checked = 0
  for (const key of Object.keys(entries).sort()) {
    const abs = path.join(BUNDLE, ...key.split('/'))
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push(key)
      continue
    }
    checked += 1
    if (sha256(abs) !== entries[key]) mismatched.push(key)
  }
  if (missing.length || mismatched.length) {
    const detail = [
      ...missing.map((k) => `  missing:    ${k}`),
      ...mismatched.map((k) => `  mismatched: ${k}`),
    ].join('\n')
    fail(`integrity check FAILED (checked ${checked}; missing ${missing.length}, mismatched ${mismatched.length})\n`
      + `${detail}\nThe bundle was corrupted in transit - re-transfer it before applying.`)
  }
  process.stdout.write(`integrity OK (${checked} file(s))\n`)
}

function derive(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, KEY_BYTES, SCRYPT)
}

function decrypt(packed, passphrase) {
  const head = Buffer.byteLength(MAGIC)
  if (packed.length < head + SALT_BYTES + IV_BYTES + TAG_BYTES) fail('payload truncated')
  if (packed.subarray(0, head).toString('utf8') !== MAGIC) fail('not a dsh-sync payload')
  let off = head
  const salt = packed.subarray(off, off + SALT_BYTES)
  off += SALT_BYTES
  const iv = packed.subarray(off, off + IV_BYTES)
  off += IV_BYTES
  const tag = packed.subarray(off, off + TAG_BYTES)
  off += TAG_BYTES
  const d = crypto.createDecipheriv(ALG, derive(passphrase, salt), iv)
  d.setAuthTag(tag)
  try {
    return Buffer.concat([d.update(packed.subarray(off)), d.final()])
  } catch {
    return fail('wrong passphrase, or the payload was tampered with')
  }
}

/** 口令优先取自环境变量(便于 CI / 管道),否则回落到交互式输入(尽量静默)。 */
async function passphrase() {
  if (process.env.DSH_SYNC_PASSPHRASE) return process.env.DSH_SYNC_PASSPHRASE
  const question = 'Bundle passphrase: '
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
  }
  return new Promise((resolve) => {
    let buf = ''
    process.stderr.write(question)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const done = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      process.stderr.write('\n')
      resolve(buf)
    }
    function onData(chunk) {
      for (const byte of chunk) {
        if (byte === CR || byte === LF) return done()
        if (byte === ETX) process.exit(1)
        if (byte === DEL || byte === BS) buf = buf.slice(0, -1)
        else buf += String.fromCharCode(byte)
      }
    }
    process.stdin.on('data', onData)
  })
}

async function decryptCmd(rest) {
  const kind = arg('--kind', rest)
  const out = arg('--out', rest)
  if (!kind || !out) fail('usage: decrypt --kind settings|credentials --out <file>')
  const src = path.join(BUNDLE, kind === 'settings' ? 'settings.enc' : '.credentials.enc')
  if (!fs.existsSync(src)) fail(`nothing to decrypt: ${path.basename(src)} is absent`)
  const plain = decrypt(fs.readFileSync(src), await passphrase())
  fs.writeFileSync(out, plain, { mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(out, 0o600)
  process.stdout.write(`decrypted -> ${out}\n`)
}

// ── 路径重映射 ──────────────────────────────────────────────────────────────
// 换机后用户名/OS 不同,settings.yaml 里的绝对路径(如 D:\deepseek 或 /Users/old)
// 在新机上不存在。prepare-settings 会:
// 1) 读取 settings(加密则先解密)
// 2) 扫描其中的绝对路径
// 3) 逐个检查路径在目标机上是否存在
// 4) 不存在的路径,提示用户输入新前缀(支持批量前缀映射)
// 5) 将映射后的内容写到 --out

const WIN_PATH_RE = /[A-Za-z]:[\\/](?:[^\s"'`,;|<>{}[\]()]+[\\/])+[^\s"'`,;|<>{}[\]()]+/g
const POSIX_PATH_RE = /(?:\/(?:home|Users|tmp|opt|var|usr|mnt|media|root)\/[^\s"'`,;|<>{}[\]()]+)/g

function scanPaths(text) {
  const found = new Set()
  const t = String(text || '')
  const winRe = new RegExp(WIN_PATH_RE.source, 'g')
  const posixRe = new RegExp(POSIX_PATH_RE.source, 'g')
  let m
  while ((m = winRe.exec(t)) !== null) found.add(m[0])
  while ((m = posixRe.exec(t)) !== null) found.add(m[0])
  return [...found].sort()
}

function pathExists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

/** 对文本做前缀替换:把所有以 oldPrefix 开头的路径替换为 newPrefix。 */
function remapPaths(text, mappings) {
  let result = text
  for (const { from, to } of mappings) {
    // 统一用正斜杠比较,但替换时保留原始分隔符风格
    const fromNorm = from.replace(/\\/g, '/')
    const toNorm = to.replace(/\\/g, '/')
    // 同时匹配正斜杠和反斜杠版本
    const fromWin = fromNorm.replace(/\//g, '\\')
    const toWin = toNorm.replace(/\//g, '\\')
    result = result.split(fromNorm).join(toNorm)
    result = result.split(fromWin).join(toWin)
  }
  return result
}

async function askMapping(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(String(a).trim()) }))
}

async function prepareSettings(rest) {
  const out = arg('--out', rest)
  if (!out) fail('usage: prepare-settings --out <file>')

  // 读取 settings:加密则解密,否则直接读
  let content
  const encPath = path.join(BUNDLE, 'settings.enc')
  const plainPath = path.join(BUNDLE, 'settings.yaml')
  if (fs.existsSync(encPath)) {
    content = decrypt(fs.readFileSync(encPath), await passphrase()).toString('utf8')
  } else if (fs.existsSync(plainPath)) {
    content = fs.readFileSync(plainPath, 'utf8')
  } else {
    fail('no settings file in bundle (neither settings.enc nor settings.yaml)')
  }

  // 扫描绝对路径
  const paths = scanPaths(content)
  if (paths.length === 0) {
    // 没有绝对路径,直接写出
    fs.writeFileSync(out, content, 'utf8')
    process.stdout.write(`settings -> ${out} (no absolute paths found)\n`)
    return
  }

  // 检查哪些路径在目标机上不存在
  const missing = paths.filter((p) => !pathExists(p))
  if (missing.length === 0) {
    // 所有路径都存在,直接写出
    fs.writeFileSync(out, content, 'utf8')
    process.stdout.write(`settings -> ${out} (all ${paths.length} path(s) exist on this machine)\n`)
    return
  }

  // 有路径不存在,提示用户做前缀映射
  process.stdout.write(`\n${missing.length} absolute path(s) from the source machine do not exist here:\n`)
  for (const p of missing) process.stdout.write(`  ${p}\n`)
  process.stdout.write('\nYou can remap a path prefix so settings point to the right location.\n')
  process.stdout.write('Example: if the old path was D:\\deepseek and your new path is C:\\code,\n')
  process.stdout.write('enter: D:\\deepseek = C:\\code\n')
  process.stdout.write('Press Enter to skip a path, or type "skip-all" to skip remaining.\n\n')

  const mappings = []
  for (const p of missing) {
    if (!pathExists(p)) {
      const answer = await askMapping(`  ${p}\n  → remap to (or Enter to skip): `)
      if (!answer || answer.toLowerCase() === 'skip') {
        process.stdout.write('    skipped\n')
        continue
      }
      if (answer.toLowerCase() === 'skip-all') {
        process.stdout.write('    skipping all remaining paths\n')
        break
      }
      mappings.push({ from: p, to: answer })
      process.stdout.write(`    ${p} → ${answer}\n`)
    }
  }

  if (mappings.length > 0) {
    content = remapPaths(content, mappings)
    process.stdout.write(`\nRemapped ${mappings.length} path(s).\n`)
  } else {
    process.stdout.write('\nNo paths remapped — settings will keep original paths.\n')
  }

  fs.writeFileSync(out, content, 'utf8')
  if (process.platform !== 'win32') fs.chmodSync(out, 0o600)
  process.stdout.write(`settings -> ${out}\n`)
}

async function info() {
  const m = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'manifest.json'), 'utf8'))
  const sum = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'checksums.json'), 'utf8'))
  const names = (m.profiles || []).map((p) => p.name)
  process.stdout.write([
    `format:      ${m.format} v${m.formatVersion}`,
    `exported:    ${m.exportedAt}`,
    `source:      ${m.sourceDshHome}`,
    `profiles:    ${names.join(', ') || '-'}`,
    `secrets:     ${m.includesCredentials ? 'carried (encrypted)' : 'not included'}`,
    `integrity:   ${Object.keys(sum.entries || {}).length} file(s) under checksum`,
  ].join('\n') + '\n')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'verify') await verify()
  else if (cmd === 'decrypt') await decryptCmd(rest)
  else if (cmd === 'prepare-settings') await prepareSettings(rest)
  else if (cmd === 'info') await info()
  else fail('usage: dsync-helper.mjs verify | decrypt --kind <settings|credentials> --out <file> | prepare-settings --out <file> | info')
}

await main()
