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
  else if (cmd === 'info') await info()
  else fail('usage: dsync-helper.mjs verify | decrypt --kind <settings|credentials> --out <file> | info')
}

await main()
