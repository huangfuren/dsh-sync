// test/bundle.test.js — dsh-sync 纯函数 + 端到端导出测试(构造假 dshHome,不联网)。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  classifyDep, isBuiltinBundle, scanSettingsSecrets, maskSecret, copyTreeFiltered,
  readProfileManifest, exportBundle, isSecretLine, redactSettingsSecrets, listProfiles,
} from '../lib/bundle.js'
import { buildApplyPs1, buildApplySh, buildApplyBat } from '../lib/apply-script.js'
import { buildChecksums, verifyChecksums } from '../lib/checksum.js'
import { decryptBuffer, encryptBuffer } from '../lib/crypto.js'
import { createHash } from 'node:crypto'

const PASSPHRASE = 'correct-horse-battery'

test('isBuiltinBundle detects scoped builtins', () => {
  assert.equal(isBuiltinBundle('@deepseek-ai/dsh-base'), true)
  assert.equal(isBuiltinBundle('dsh-localsend'), false)
})

test('classifyDep splits link / git / registry', () => {
  assert.deepEqual(classifyDep('a', 'link:D:/x/a'), { name: 'a', kind: 'link', spec: 'link:D:/x/a', sourcePath: 'D:/x/a' })
  assert.equal(classifyDep('b', 'github:u/b').kind, 'git')
  assert.equal(classifyDep('c', '^0.10.1').kind, 'registry')
})

test('maskSecret never echoes the whole value', () => {
  const m = maskSecret('sk-monk-32f5d8cf1c2a298d85ee1c31')
  assert.ok(!m.includes('32f5d8cf1c2a'))
  assert.match(m, /len 32/)
})

test('scanSettingsSecrets flags literal key in apiKeyEnv and clean refs', () => {
  const bad = scanSettingsSecrets('provider:\n  apiKeyEnv: sk-monk-32f5d8cf1c2a298d85ee1c31\n')
  assert.equal(bad.warnings.length, 1)
  assert.match(bad.warnings[0].reason, /明文密钥/)
  const good = scanSettingsSecrets('provider:\n  apiKeyEnv: MONK_API_KEY\n')
  assert.equal(good.warnings.length, 0)
})

test('scanSettingsSecrets flags long secret-ish values', () => {
  const r = scanSettingsSecrets('plugin:\n  apiToken: abcdefghijklmnop\n')
  assert.equal(r.warnings.length, 1)
})

test('readProfileManifest parses deps + bundles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-p-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'dsh-localsend': 'link:D:/p/dsh-localsend', 'dsh-mindmap': '^0.10.1' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-localsend', 'dsh-mindmap'] } },
  }))
  const m = await readProfileManifest(dir)
  assert.equal(m.bundles.length, 3)
  assert.equal(m.depList.length, 2)
  assert.equal(m.depList.find((d) => d.name === 'dsh-localsend').kind, 'link')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('copyTreeFiltered skips node_modules/.git and copies sources', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-s-'))
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-d-'))
  fs.mkdirSync(path.join(src, 'node_modules', 'junk'), { recursive: true })
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(src, 'lib', 'a.js'), 'x')
  fs.writeFileSync(path.join(src, 'node_modules', 'junk', 'b.js'), 'ignore')
  fs.writeFileSync(path.join(src, 'error.log'), 'ignore')
  const r = await copyTreeFiltered(src, path.join(dst, 'out'))
  assert.equal(r.files, 1)
  assert.ok(fs.existsSync(path.join(dst, 'out', 'lib', 'a.js')))
  assert.ok(!fs.existsSync(path.join(dst, 'out', 'node_modules')))
  fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true })
})

// ── fixtures ───────────────────────────────────────────────────────────────

function writeScripts(bundleDir, m) {
  fs.writeFileSync(path.join(bundleDir, 'apply.ps1'), buildApplyPs1(m), 'utf8')
  fs.writeFileSync(path.join(bundleDir, 'apply.sh'), buildApplySh(m), 'utf8')
  fs.writeFileSync(path.join(bundleDir, '一键恢复.bat'), buildApplyBat(m), 'utf8')
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-home-'))
  for (const name of ['web', 'desktop']) {
    const prof = path.join(home, 'profiles', name)
    fs.mkdirSync(prof, { recursive: true })
    fs.writeFileSync(path.join(prof, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
    fs.writeFileSync(path.join(prof, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
  }
  const plug = path.join(home, 'plugsrc', 'dsh-foo')
  fs.mkdirSync(path.join(plug, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(plug, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '1.0.0' }))
  fs.writeFileSync(path.join(plug, 'index.js'), 'export const name = "foo"')
  fs.writeFileSync(path.join(plug, 'node_modules', 'x.js'), 'ignore')
  const posix = plug.replace(/\\/g, '/')
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'dsh-foo': `link:${posix}`, 'dsh-mindmap': '^0.10.1', aegis: 'github:GanyuanRan/Aegis' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-foo', 'dsh-mindmap', 'aegis'] } },
  }))
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-foo': `link:${posix}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-foo'] } },
  }))
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\nfoo:\n  apiKeyEnv: sk-literal-secret-123\n')
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  FOO: bar\n')
  return home
}

test('listProfiles enumerates profile directories', async () => {
  const home = fixture()
  try {
    assert.deepEqual(await listProfiles(home), ['desktop', 'web'])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('exportBundle vendors link sources, excludes junk, writes both apply scripts + checksums', async () => {
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    const { bundleDir, manifest, warnings } = await exportBundle({
      dshHome: home, profiles: ['web'], outDir: out, includeCredentials: false, includePlugins: true, writeScripts,
    })
    assert.equal(manifest.format, 'dsh-sync-bundle')
    assert.equal(manifest.formatVersion, 2)
    assert.equal(manifest.sourceProfile, 'web')
    assert.equal(manifest.includesCredentials, false)
    for (const f of ['manifest.json', 'settings.yaml', 'apply.ps1', 'apply.sh', '一键恢复.bat', 'checksums.json', 'tools/dsync-helper.mjs']) {
      assert.ok(fs.existsSync(path.join(bundleDir, f)), `missing ${f}`)
    }
    assert.ok(fs.existsSync(path.join(bundleDir, 'plugins', 'dsh-foo', 'index.js')))
    assert.ok(!fs.existsSync(path.join(bundleDir, 'plugins', 'dsh-foo', 'node_modules')))
    assert.ok(!fs.existsSync(path.join(bundleDir, '.credentials.yaml')))
    // profile 声明文件必须随行,否则目标机 pnpm 读不到 allowBuilds / registry
    assert.ok(fs.existsSync(path.join(bundleDir, 'profiles', 'web', 'pnpm-workspace.yaml')))
    assert.ok(fs.existsSync(path.join(bundleDir, 'profiles', 'web', '.npmrc')))

    assert.ok(warnings.some((w) => /apiKeyEnv/.test(w.where)))
    assert.deepEqual(manifest.settingsRedacted, ['apiKeyEnv'])
    const bundled = fs.readFileSync(path.join(bundleDir, 'settings.yaml'), 'utf8')
    assert.ok(!bundled.includes('sk-literal-secret-123'), 'literal secret must NOT reach the bundle')
    assert.ok(bundled.includes('preference: dark'), 'non-secret settings must survive redaction')

    const foo = manifest.profiles[0].deps.find((d) => d.name === 'dsh-foo')
    assert.equal(foo.kind, 'link')
    assert.equal(foo.inBundle, true)

    // apply 脚本:双平台 + 安全网
    const ps1 = fs.readFileSync(path.join(bundleDir, 'apply.ps1'), 'utf8')
    assert.ok(ps1.includes('--profile web add'))
    assert.ok(ps1.includes('$WhatIf'), 'ps1 must support dry run')
    assert.ok(ps1.includes('Restore-All'), 'ps1 must roll back')
    assert.ok(ps1.includes('dsync-helper.mjs'), 'ps1 must use the bundled self-contained helper')
    assert.ok(ps1.includes('$Helper verify'), 'ps1 must verify integrity before touching anything')
    assert.ok(ps1.includes('Get-Command dsh'), 'ps1 must fail fast when dsh is missing, not mid-apply')
    assert.ok(ps1.includes('$Force') && ps1.includes('Read-Host'), 'ps1 must ask before overwriting an existing config')
    assert.ok(ps1.includes('$manifest.source'), 'ps1 must run the version compatibility check')
    // 回归:PS 5.1 会用 ANSI 读 manifest.json,中文把 JSON 结构解坏导致 ConvertFrom-Json 抛错。
    assert.ok(ps1.includes('[System.Text.Encoding]::UTF8'), 'ps1 must read manifest.json as explicit UTF-8')
    assert.ok(ps1.includes('pnpm-workspace.yaml'), 'profile declaration files must land before plugin add')
    assert.ok(!ps1.includes('$Profile '), 'must not shadow the automatic $Profile variable')
    // 傻瓜入口向导:体检、验货、预演、收口令,四步都到位才开始改目标机。
    const bat = fs.readFileSync(path.join(bundleDir, '一键恢复.bat'), 'utf8')
    assert.ok(bat.includes('chcp 65001'), 'bat must switch to UTF-8 or Chinese turns to mojibake')
    assert.ok(bat.includes('node "%~dp0tools\\dsync-helper.mjs" verify'), 'bat must verify before applying')
    assert.ok(bat.includes('-WhatIf'), 'bat must show a plan before touching anything')
    assert.ok(bat.includes('set DSH_SYNC_PASSPHRASE='), 'bat must collect the passphrase')
    assert.ok(bat.includes('恢复到哪个目录'), 'bat must let the user confirm the target dsh home')
    assert.ok(bat.includes('-TargetHome "%DSYNC_HOME%"'), 'bat must pass the confirmed target home through')

    const sh = fs.readFileSync(path.join(bundleDir, 'apply.sh'), 'utf8')
    assert.ok(sh.includes('--dry-run'))
    assert.ok(sh.includes('restore_all'))
    assert.ok(sh.includes('command -v dsh'), 'apply.sh must preflight dsh too')
    assert.ok(sh.includes('--profile web add'))

    // 校验和必须覆盖实际产物,且能通过 verify
    const sums = JSON.parse(fs.readFileSync(path.join(bundleDir, 'checksums.json'), 'utf8'))
    assert.equal(sums.algorithm, 'sha256')
    assert.ok(Object.keys(sums.entries).length > 3)
    const v = await verifyChecksums(bundleDir, sums.entries)
    assert.equal(v.ok, true, JSON.stringify(v))
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('exportBundle with credentials copies the secret file and warns', async () => {
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    const { bundleDir, manifest } = await exportBundle({
      dshHome: home, profiles: ['web'], outDir: out, includeCredentials: true, includePlugins: true, writeScripts,
    })
    assert.ok(fs.existsSync(path.join(bundleDir, '.credentials.yaml')))
    assert.equal(manifest.includesCredentials, true)
    assert.ok(manifest.warnings.some((w) => w.where === '.credentials.yaml'))
    const bundled = fs.readFileSync(path.join(bundleDir, 'settings.yaml'), 'utf8')
    assert.ok(bundled.includes('sk-literal-secret-123'))
    assert.deepEqual(manifest.settingsRedacted, [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('exportBundle with passphrase encrypts secrets instead of stripping them', async () => {
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    const { bundleDir, manifest } = await exportBundle({
      dshHome: home, profiles: ['web'], outDir: out,
      includeCredentials: true, includePlugins: true, passphrase: PASSPHRASE, writeScripts,
    })
    assert.equal(manifest.settingsEncrypted, true)
    assert.equal(manifest.credentialsEncrypted, true)
    assert.deepEqual(manifest.settingsRedacted, [], 'encryption keeps secrets, so nothing is stripped')
    assert.ok(fs.existsSync(path.join(bundleDir, 'settings.enc')))
    assert.ok(fs.existsSync(path.join(bundleDir, '.credentials.enc')))
    assert.ok(!fs.existsSync(path.join(bundleDir, '.credentials.yaml')), 'credentials must never travel in the clear')

    // 明文不得出现在 bundle 任何地方
    for (const f of ['settings.enc', '.credentials.enc']) {
      const raw = fs.readFileSync(path.join(bundleDir, f))
      assert.ok(!raw.includes('sk-literal-secret-123'), `${f} must not contain plaintext`)
    }
    // 正确口令可还原,错误口令必须失败
    const settings = decryptBuffer(fs.readFileSync(path.join(bundleDir, 'settings.enc')), PASSPHRASE).toString('utf8')
    assert.ok(settings.includes('sk-literal-secret-123'))
    assert.throws(() => decryptBuffer(fs.readFileSync(path.join(bundleDir, 'settings.enc')), 'wrong-pass'))
    // apply 脚本必须走解密路径而不是直接拷贝
    const ps1 = fs.readFileSync(path.join(bundleDir, 'apply.ps1'), 'utf8')
    assert.ok(ps1.includes('decrypt --kind settings'))
    assert.ok(ps1.includes('decrypt --kind credentials'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('exportBundle never writes to the source dsh home (read-only guarantee)', async () => {
  // 迁移工具的第一条底线:导出不能改动源机任何一个字节。
  // 这里不是"看代码觉得没写",而是导出前后把整棵树的重算一遍哈希来证明。
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  const snapshot = (dir) => {
    const acc = {}
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const abs = path.join(d, e.name)
        if (e.isDirectory()) walk(abs)
        else if (e.isFile()) acc[path.relative(dir, abs)] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
      }
    }
    walk(dir)
    return acc
  }
  try {
    const before = snapshot(home)
    await exportBundle({ dshHome: home, profiles: ['web'], outDir: out, includeCredentials: true, passphrase: PASSPHRASE, writeScripts })
    assert.deepEqual(snapshot(home), before, 'source dsh home must be byte-for-byte identical after export')
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('exportBundle records the source environment for compatibility checks', async () => {
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    const { manifest } = await exportBundle({ dshHome: home, profiles: ['web'], outDir: out, writeScripts })
    assert.ok(manifest.source, 'manifest must carry source environment')
    assert.equal(manifest.source.nodeVersion, process.version)
    assert.equal(manifest.source.platform, process.platform)
    assert.ok('dshVersion' in manifest.source, 'dshVersion must be present (null when undetectable, never guessed)')
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('exportBundle rejects a too-short passphrase', async () => {
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    await assert.rejects(() => exportBundle({
      dshHome: home, profiles: ['web'], outDir: out, passphrase: 'abc', writeScripts,
    }), /at least 6/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('exportBundle exports every profile at once and vendors shared sources once', async () => {
  const home = fixture()
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    const { bundleDir, manifest } = await exportBundle({
      dshHome: home, profiles: ['web', 'desktop'], outDir: out, includePlugins: true, passphrase: PASSPHRASE, writeScripts,
    })
    assert.deepEqual(manifest.profiles.map((p) => p.name), ['web', 'desktop'])
    assert.equal(manifest.plugins.length, 1, 'the same link source is vendored once, not per profile')
    for (const name of ['web', 'desktop']) {
      assert.ok(fs.existsSync(path.join(bundleDir, 'profiles', name, 'pnpm-workspace.yaml')))
    }
    const sh = fs.readFileSync(path.join(bundleDir, 'apply.sh'), 'utf8')
    assert.ok(sh.includes('--profile web add'))
    assert.ok(sh.includes('--profile desktop add'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('checksums detect tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-sum-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  const sums = await buildChecksums(dir)
  assert.equal((await verifyChecksums(dir, sums.entries)).ok, true)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'tampered')
  const bad = await verifyChecksums(dir, sums.entries)
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.mismatched, ['a.txt'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('encryptBuffer round-trips and rejects tampering', () => {
  const packed = encryptBuffer(Buffer.from('top-secret'), PASSPHRASE)
  assert.equal(decryptBuffer(packed, PASSPHRASE).toString('utf8'), 'top-secret')
  packed[packed.length - 1] ^= 0xff
  assert.throws(() => decryptBuffer(packed, PASSPHRASE))
})

test('isSecretLine flags literal token in apiToken (outline-auto shape)', () => {
  // dsh-outline-auto 把 token 明文存进 settings,这是常态,不是异常
  assert.equal(isSecretLine('apiToken', 'ol_api_hH0OLljdchNjwQHL7BBg2fcLH040ACKqcPMi7q'), true)
})

test('isSecretLine keeps a valid credential ref', () => {
  assert.equal(isSecretLine('apiKeyEnv', 'MONK_API_KEY'), false)
})

test('isSecretLine flags invalid env ref (hyphen)', () => {
  assert.equal(isSecretLine('apiKeyEnv', 'sk-monk-32f5d8cf1c2a298d85ee1c31'), true)
})

test('a local plugin named @deepseek-ai/* is installed, not skipped as builtin', async () => {
  // 回归用例:自己开发的插件用了 @deepseek-ai/ 前缀 + link: 源码。
  // 曾经的判定顺序会把它当成官方内置组合包跳过 —— 源码进了 bundle 却没人装,换机后插件凭空消失。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-scoped-'))
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-out-'))
  try {
    const plug = path.join(home, 'src', 'mine-scoped')
    fs.mkdirSync(plug, { recursive: true })
    fs.writeFileSync(path.join(plug, 'package.json'), JSON.stringify({ name: '@deepseek-ai/mine-scoped' }))
    const prof = path.join(home, 'profiles', 'web')
    fs.mkdirSync(prof, { recursive: true })
    fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@deepseek-ai/mine-scoped': `link:${plug.replace(/\\/g, '/')}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/mine-scoped'] } },
    }))
    const { bundleDir, manifest } = await exportBundle({
      dshHome: home, profiles: ['web'], outDir: out, includePlugins: true, writeScripts,
    })
    assert.equal(manifest.profiles[0].deps[0].inBundle, true, 'local source must be vendored')
    const ps1 = fs.readFileSync(path.join(bundleDir, 'apply.ps1'), 'utf8')
    // 官方内置的 @deepseek-ai/dsh-base 不该装,本地同前缀的必须装。
    assert.ok(!ps1.includes('add "@deepseek-ai/dsh-base"'), 'genuine builtin must not be reinstalled')
    assert.ok(ps1.includes('--profile web add "$Bundle\\plugins\\@deepseek-ai/mine-scoped"'), ps1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true })
  }
})

test('redactSettingsSecrets drops literal secret lines, keeps the rest', () => {
  const inText = 'ui-theme:\n  preference: dark\nfoo:\n  apiToken: ol_secret_value_123\n'
  const { text, removed } = redactSettingsSecrets(inText)
  assert.deepEqual(removed, ['apiToken'])
  assert.ok(!text.includes('ol_secret_value_123'), 'literal secret must be gone')
  assert.ok(text.includes('preference: dark'), 'non-secret line must survive')
})
