// test/snapshot.test.js — 防灾快照：全量 → 硬链接增量 → 基线删除后数据存活 → 保留策略。
//
// 钉死四件事：
//   ① 每一份快照都是自包含、sha256 可校验的标准 bundle（恢复路径与普通 bundle 完全相同）；
//   ② 增量只对「内容确实一致」的文件做硬链接，做完之后新快照的 checksums 依然逐字成立；
//   ③ 删除基线快照不影响增量快照的任何数据（NTFS 引用计数语义，灾备场景的生命线）；
//   ④ 保留策略只清理本引擎创建的目录名形态，外来目录绝不碰。
// 全部使用合成数据（自建 zstd 多帧文件），不读取真实 $DSH_HOME，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { verifyChecksums } from '../lib/checksum.js'
import { listSnapshots, takeSnapshot } from '../lib/snapshot.js'
import { encodeSessionDir } from '../lib/session-migrate.js'
import { zstdAvailable } from '../lib/zstd-frame.js'

const HAS_ZSTD = zstdAvailable()

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-snap-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writeSessionFile(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))]
  for (const e of events) frames.push(zlib.zstdCompressSync(Buffer.from(e + '\n', 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
}

function headerOf(cwd, id) {
  return { type: 'session', version: 0, id, createdAt: 1700000000000, cwd, delegationDepth: 0, agentPreset: 'standard' }
}

/** 合成一台最小可导出的机器：1 profile + 1 会话 + 工作区注册 + 项目目录 + settings。 */
function mkHome(tag, { withPatch = false } = {}) {
  const dshHome = tmpDir(tag)
  fs.mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'desktop', version: '1.0.0',
    dsh: { profile: { bundles: ['test-bundle'] } },
  }, null, 2))
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), 'locale: zh-CN\n', 'utf8')

  const wsRoot = path.join(dshHome, 'ws')
  const project = path.join(wsRoot, 'proj-a')
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, 'a.txt'), 'alpha\n', 'utf8')
  fs.writeFileSync(path.join(project, 'b.txt'), 'bravo\n', 'utf8')

  const cwd = process.platform === 'win32' ? project : project
  const id = 'session-11111111-1111-4111-8111-111111111111'
  writeSessionFile(
    path.join(dshHome, 'sessions', encodeSessionDir(cwd), id, 'session.jsonl.zstd'),
    headerOf(cwd, id), ['{"seq":1}'],
  )
  const table = {}
  table['w-1'] = { path: cwd, title: 'proj-a', sessionIds: [id] }
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: Object.keys(table) },
    tables: { workspaces: table },
  }
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2))

  if (withPatch) {
    fs.writeFileSync(path.join(dshHome, 'cordis.patch.yml'), 'llm-deepseek-account:\n  models: []\n', 'utf8')
  }
  return { dshHome, project }
}

test('全量快照：自包含、可校验、自带恢复脚本', { skip: !HAS_ZSTD }, async () => {
  const { dshHome } = mkHome('full')
  const snapRoot = tmpDir('snaps-full')
  const r = await takeSnapshot({
    dshHome, snapshotsOverride: snapRoot, keep: 5,
    onLog: () => {}, writeScripts: () => {},
  })
  assert.equal(path.basename(r.snapshotDir), r.snapshotName)
  assert.ok(fs.existsSync(path.join(r.snapshotDir, 'manifest.json')))
  assert.ok(fs.existsSync(path.join(r.snapshotDir, 'checksums.json')))
  const integrity = await verifyChecksums(r.snapshotDir,
    JSON.parse(fs.readFileSync(path.join(r.snapshotDir, 'checksums.json'), 'utf8')).entries)
  assert.equal(integrity.ok, true, '首份快照 sha256 必须全过')
  assert.equal(r.baseSnapshot, null, '第一份没有基线')
  assert.ok(r.totals.files > 0)
  assert.deepEqual(listSnapshots(dshHome, snapRoot).map((s) => s.name), [r.snapshotName])
})

test('增量快照：未变化文件硬链接复用，清单依然成立', { skip: !HAS_ZSTD }, async () => {
  const { dshHome, project } = mkHome('incr')
  const snapRoot = tmpDir('snaps-incr')
  const first = await takeSnapshot({ dshHome, snapshotsOverride: snapRoot, keep: 5, onLog: () => {}, writeScripts: () => {} })

  // 变化一个文件、新增一个文件；a.txt 保持不变 → 第二份里应是第一份的硬链接。
  fs.writeFileSync(path.join(project, 'b.txt'), 'bravo-2\n', 'utf8')
  fs.writeFileSync(path.join(project, 'c.txt'), 'charlie\n', 'utf8')
  const second = await takeSnapshot({ dshHome, snapshotsOverride: snapRoot, keep: 5, onLog: () => {}, writeScripts: () => {} })

  assert.equal(second.baseSnapshot, first.snapshotName)
  assert.ok(second.hardlink.linked > 0, '至少 a.txt/settings 等未变化文件应被硬链接复用')
  assert.ok(second.hardlink.savedBytes > 0)
  assert.ok(second.delta.added >= 1, '新增文件计入 delta')
  assert.ok(second.delta.changed >= 1, '变化文件计入 delta')
  assert.ok(second.delta.removed === 0)

  const linkedStat = fs.statSync(path.join(second.snapshotDir, 'workspaces', 'proj-a', 'a.txt'))
  assert.ok(linkedStat.nlink >= 2, '硬链接生效（nlink>=2），实际 nlink=' + linkedStat.nlink)
  // 增量之后清单必须逐字成立 —— 这是「快照仍是自包含 bundle」的机械证明。
  const integrity = await verifyChecksums(second.snapshotDir,
    JSON.parse(fs.readFileSync(path.join(second.snapshotDir, 'checksums.json'), 'utf8')).entries)
  assert.equal(integrity.ok, true, '增量快照的 sha256 必须全过')
})

test('删除基线快照后，增量快照的数据仍然完好', { skip: !HAS_ZSTD }, async () => {
  const { dshHome, project } = mkHome('survive')
  const snapRoot = tmpDir('snaps-survive')
  const first = await takeSnapshot({ dshHome, snapshotsOverride: snapRoot, keep: 5, onLog: () => {}, writeScripts: () => {} })
  const second = await takeSnapshot({ dshHome, snapshotsOverride: snapRoot, keep: 5, onLog: () => {}, writeScripts: () => {} })

  // 灾备场景的常规操作：删掉旧的，只留新的。硬链接的引用计数必须兜住数据。
  fs.rmSync(first.snapshotDir, { recursive: true, force: true })
  const integrity = await verifyChecksums(second.snapshotDir,
    JSON.parse(fs.readFileSync(path.join(second.snapshotDir, 'checksums.json'), 'utf8')).entries)
  assert.equal(integrity.ok, true)
  assert.equal(fs.readFileSync(path.join(second.snapshotDir, 'workspaces', 'proj-a', 'a.txt'), 'utf8'), 'alpha\n')
  assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'alpha\n', '源文件不受影响')
})

test('保留策略：keep=1 只留最新一份，外来目录不碰', { skip: !HAS_ZSTD }, async () => {
  const { dshHome } = mkHome('prune')
  const snapRoot = tmpDir('snaps-prune')
  fs.mkdirSync(snapRoot, { recursive: true })
  const foreign = path.join(snapRoot, 'not-a-snapshot')
  fs.mkdirSync(foreign)
  fs.writeFileSync(path.join(foreign, 'keep-me.txt'), '碰我试试\n', 'utf8')

  for (let i = 0; i < 3; i++) {
    await takeSnapshot({ dshHome, snapshotsOverride: snapRoot, keep: 1, onLog: () => {}, writeScripts: () => {} })
  }
  const left = listSnapshots(dshHome, snapRoot)
  assert.equal(left.length, 1, '只保留最新一份，实际剩 ' + left.length)
  assert.ok(fs.existsSync(path.join(foreign, 'keep-me.txt')), '外来目录绝不被清理')
})

test('P7：cordis.patch.yml 携带 models 字段时导出侧被告警', { skip: !HAS_ZSTD }, async () => {
  const { dshHome } = mkHome('p7', { withPatch: true })
  const snapRoot = tmpDir('snaps-p7')
  const r = await takeSnapshot({ dshHome, snapshotsOverride: snapRoot, keep: 5, onLog: () => {}, writeScripts: () => {} })
  const hit = r.warnings.find((w) => w.where === 'cordis.patch.yml' && /P7/.test(w.reason))
  assert.ok(hit, '应有 P7 告警，实际：' + JSON.stringify(r.warnings))
  assert.match(hit.preview, /models/)
})
