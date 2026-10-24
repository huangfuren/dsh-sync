// test/undo.test.js — 导入级撤销（dshsync_undo）的两条硬约束：
//   ① 撤销 = 精确回到 apply 之前：新建的删、覆盖的还原、软链还原旧指向、分组名改回去
//   ② afterHash 安全网：落地之后内容变过的文件（用户开始用 dsh）绝不碰，逐条报告
// 全部使用合成数据，不读取真实 $DSH_HOME，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { encodeSessionDir } from '../lib/session-migrate.js'
import { zstdAvailable } from '../lib/zstd-frame.js'
import { exportBundle } from '../lib/bundle.js'
import { applyBundle } from '../lib/apply-engine.js'
import { undoBundle, loadJournal, findLatestJournalDir } from '../lib/undo.js'
import { APPLY_RECEIPT_FILE, UNDO_JOURNAL_FILE } from '../lib/constants.js'

const HAS_ZSTD = zstdAvailable()

function tmpDir(tag) {
  const d = path.join(os.tmpdir(), `dshsync-undo-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writeSessionFile(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))]
  for (const e of events) frames.push(zlib.zstdCompressSync(Buffer.from(e + '\n', 'utf8')))
  fs.writeFileSync(file, Buffer.concat(frames))
}

function mkSession(dshHome, cwd, id, events = ['{"seq":1}', '{"seq":2}']) {
  const dir = path.join(dshHome, 'sessions', encodeSessionDir(cwd), id)
  writeSessionFile(path.join(dir, 'session.jsonl.zstd'), {
    type: 'session', version: 0, id, createdAt: 1700000000000, cwd, delegationDepth: 0, agentPreset: 'standard',
  }, events)
  return dir
}

function mkWorkspace(dshHome, entries) {
  const table = {}
  for (const [id, p] of entries) table[id] = { path: p, title: path.basename(p), sessionIds: [] }
  const doc = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: Object.keys(table) }, tables: { workspaces: table } }
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2))
  return doc
}

/** 建一个「源机 → bundle」的最小套件：一个会话 + 一个工作区 + settings + profile 声明。 */
function mkSource(dshHome, cwd, settings = 'theme: dark\n') {
  mkSession(dshHome, cwd, 's1')
  mkWorkspace(dshHome, [['w1', cwd]])
  fs.mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', version: '1.0.0', dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), settings)
}

async function exportTo(bundleDir, srcHome, opts = {}) {
  return exportBundle({ dshHome: srcHome, profiles: ['desktop'], outDir: bundleDir, includeState: true, ...opts })
}

/** 空目标机：只有 settings.yaml 一个旧文件（用于覆盖还原路径）。 */
function mkTarget(dshHome, settings) {
  fs.mkdirSync(dshHome, { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), settings)
}

test('undo：全新目标机 apply 后整体撤销，回到 apply 之前（created 全删 / overwritten 还原 / settings 回旧值）', { skip: !HAS_ZSTD }, async () => {
  const src = tmpDir('src')
  const target = tmpDir('target')
  const bundleDir = tmpDir('bundle')
  const cwd = path.join(src, 'proj-a')
  fs.mkdirSync(cwd, { recursive: true })
  mkSource(src, cwd)
  await exportTo(bundleDir, src, { includeWorkspaces: true, workspaces: [cwd] })

  const oldSettings = 'theme: light\n'
  mkTarget(target, oldSettings)
  const rep = await applyBundle({
    bundleDir, dshHome: target, dryRun: false, allowSameMachine: true,
    workspaceRoot: path.join(target, 'ws'), onLog: () => {},
  })
  assert.equal(rep.ok, true, 'apply 应成功: ' + rep.errors.join('; '))
  const wsDest = rep.workspaceTargets && rep.workspaceTargets[0] ? rep.workspaceTargets[0].destPath : null
  assert.ok(wsDest, '应有工作区落位计划')
  assert.ok(rep.backupDir, 'apply 应产出备份目录')
  assert.ok(fs.existsSync(path.join(rep.backupDir, UNDO_JOURNAL_FILE)), '备份目录里应有账本')
  assert.ok(rep.undo.created > 0, '应有新建文件入账')

  // 回执应带账本指针
  const receipt = JSON.parse(fs.readFileSync(path.join(target, APPLY_RECEIPT_FILE), 'utf8'))
  assert.equal(receipt.journal.path, rep.backupDir)
  assert.equal(findLatestJournalDir(target), rep.backupDir)

  // undo 预演：不写任何文件
  const pre = await undoBundle({ dshHome: target, backupDir: rep.backupDir, dryRun: true, onLog: () => {} })
  assert.equal(pre.ok, true, '预演应无错误: ' + pre.errors.join('; '))
  assert.equal(fs.readFileSync(path.join(target, 'settings.yaml'), 'utf8'), 'theme: dark\n', '预演后 settings 仍是新值')

  // 真撤销
  const undo = await undoBundle({ dshHome: target, backupDir: rep.backupDir, dryRun: false, onLog: () => {} })
  assert.equal(undo.ok, true, '撤销应无错误: ' + undo.errors.join('; '))
  assert.ok(undo.undone.created > 0, '新建文件应被删除')
  assert.equal(undo.undone.overwritten, 1, 'settings.yaml 应作为覆盖被还原')

  // settings 回到旧值
  assert.equal(fs.readFileSync(path.join(target, 'settings.yaml'), 'utf8'), oldSettings)
  // 新建的 sessions / storages / profiles / plugins 应消失
  assert.equal(fs.existsSync(path.join(target, 'sessions')), false, 'sessions 应被整体撤掉')
  assert.equal(fs.existsSync(path.join(target, 'storages')), false, 'storages 应被整体撤掉')
  assert.equal(fs.existsSync(path.join(target, 'profiles')), false, 'profiles 应被整体撤掉')
  // 落地的工作区代码也应被撤掉
  assert.equal(fs.existsSync(wsDest), false, '工作区代码应被删掉')
})

test('undo：afterHash 安全网 —— 落地后继续用过的会话不被删，且分组改名仍被还原、报告说明混合状态', { skip: !HAS_ZSTD }, async () => {
  const src = tmpDir('src')
  const target = tmpDir('target')
  const bundleDir = tmpDir('bundle')
  const cwd = path.join(src, 'proj-b')
  fs.mkdirSync(cwd, { recursive: true })
  mkSource(src, cwd)
  await exportTo(bundleDir, src, { includeWorkspaces: true, workspaces: [cwd] })

  mkTarget(target, 'theme: light\n')
  const rep = await applyBundle({
    bundleDir, dshHome: target, dryRun: false, allowSameMachine: true,
    workspaceRoot: path.join(target, 'ws'), onLog: () => {},
  })
  assert.equal(rep.ok, true)

  // 模拟「落地后用户继续聊」：往迁移后的会话日志追加一帧（内容变了 → afterHash 失配）
  const wsDest = rep.workspaceTargets && rep.workspaceTargets[0] ? rep.workspaceTargets[0].destPath : null
  assert.ok(wsDest, '应有工作区落位计划')
  const migratedCwd = wsDest
  const groupDir = encodeSessionDir(migratedCwd)
  const logFile = path.join(target, 'sessions', groupDir, 's1', 'session.jsonl.zstd')
  assert.ok(fs.existsSync(logFile), '迁移后的会话日志应存在')
  const appended = Buffer.concat([fs.readFileSync(logFile), zlib.zstdCompressSync(Buffer.from('{"seq":99}\n', 'utf8'))])
  fs.writeFileSync(logFile, appended)

  const undo = await undoBundle({ dshHome: target, backupDir: rep.backupDir, dryRun: false, onLog: () => {} })
  assert.equal(undo.ok, true, '撤销本身应成功（跳过不算错误）: ' + undo.errors.join('; '))
  assert.ok(undo.skipped.some((s) => s.rel.includes('s1')), '被用过的会话应出现在跳过清单')

  // 其余该撤的照样撤
  assert.equal(fs.readFileSync(path.join(target, 'settings.yaml'), 'utf8'), 'theme: light\n')
  // 改名分组在「混合」状态下也改回旧名（报告 tainted 提示），verify 才能精确指出差在哪。
  // 被跳过的日志随之回到旧编码目录下 —— 它还在，但已是混合状态（新 header + 追加帧）。
  const oldGroup = path.join(target, 'sessions', encodeSessionDir(cwd))
  assert.ok(fs.existsSync(oldGroup), '分组目录名应还原为旧编码')
  assert.ok(fs.existsSync(path.join(oldGroup, 's1', 'session.jsonl.zstd')), '被用过的会话日志必须还在（随分组回到旧编码目录）')
})

test('undo：覆盖类还原走备份 —— 目标机已有的会话日志被 prefer-source 覆盖后能恢复原内容', { skip: !HAS_ZSTD }, async () => {
  const src = tmpDir('src')
  const target = tmpDir('target')
  const bundleDir = tmpDir('bundle')
  const cwd = path.join(src, 'proj-c')
  mkSource(src, cwd)
  await exportTo(bundleDir, src, { includeWorkspaces: false })

  // 目标机已有同名会话（同一 cwd 同一 id），内容不同（事件区不同）
  const targetGroup = path.join(target, 'sessions', encodeSessionDir(cwd), 's1')
  const targetLogFile = path.join(targetGroup, 'session.jsonl.zstd')
  writeSessionFile(targetLogFile, {
    type: 'session', version: 0, id: 's1', createdAt: 1234567890, cwd, delegationDepth: 0, agentPreset: 'standard',
  }, ['{"seq":1,"local":true}'])
  const originalBytes = fs.readFileSync(targetLogFile)
  fs.mkdirSync(path.join(target, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(target, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { path: cwd, title: 'proj-c', sessionIds: [] } } },
  }))

  const rep = await applyBundle({
    bundleDir, dshHome: target, dryRun: false, allowSameMachine: true,
    resolutions: { sessions: 'prefer-source' }, onLog: () => {},
  })
  assert.equal(rep.ok, true, 'apply 应成功: ' + rep.errors.join('; '))

  const undo = await undoBundle({ dshHome: target, backupDir: rep.backupDir, dryRun: false, onLog: () => {} })
  assert.equal(undo.ok, true, '撤销应无错误: ' + undo.errors.join('; '))
  assert.ok(undo.undone.overwritten >= 1, '覆盖类应有还原')

  // 会话日志应**字节级**回到目标机本地版（apply 先用源机版覆盖、撤销再从备份还原）
  const restored = fs.readFileSync(targetLogFile)
  assert.equal(restored.equals(originalBytes), true, '还原后应与目标机本地版逐字节一致')
  const afterApply = fs.readFileSync(path.join(bundleDir, 'state', 'sessions', encodeSessionDir(cwd), 's1', 'session.jsonl.zstd'))
  assert.notEqual(restored.equals(afterApply), true, '还原后应与 bundle 里的源机版不同')
})

test('undo：账本守卫 —— 没有 journal 的目录拒绝撤销；回执显示更新 apply 时拒绝撤销旧账', { skip: !HAS_ZSTD }, async () => {
  const src = tmpDir('src')
  const target = tmpDir('target')
  const bundleDir = tmpDir('bundle')
  const cwd = path.join(src, 'proj-d')
  fs.mkdirSync(cwd, { recursive: true })
  mkSource(src, cwd)
  await exportTo(bundleDir, src)

  mkTarget(target, 'theme: light\n')
  const rep1 = await applyBundle({ bundleDir, dshHome: target, dryRun: false, allowSameMachine: true, onLog: () => {} })
  assert.equal(rep1.ok, true)

  // ① 空目录拒绝
  const empty = tmpDir('empty')
  const r0 = await undoBundle({ dshHome: target, backupDir: empty, dryRun: false, onLog: () => {} })
  assert.equal(r0.ok, false)
  assert.ok(r0.errors[0].includes('账本'))

  // ② 紧接着再 apply 一次（第二次），撤销第一次应被拒绝（只能一层层撤）
  //    给源机补一个新会话再导出，制造第二份 bundle
  mkSession(src, path.join(src, 'proj-e'), 's2')
  const bundleDir2 = tmpDir('bundle2')
  await exportTo(bundleDir2, src)
  const rep2 = await applyBundle({ bundleDir: bundleDir2, dshHome: target, dryRun: false, allowSameMachine: true,
    workspaceRoot: path.join(target, 'ws'), onLog: () => {} })
  assert.equal(rep2.ok, true, '第二次 apply 应成功: ' + rep2.errors.join('; '))

  const r1 = await undoBundle({ dshHome: target, backupDir: rep1.backupDir, dryRun: false, onLog: () => {} })
  assert.equal(r1.ok, false, '撤销较旧的一次应被拒绝')
  assert.ok(r1.errors[0].includes('最新一次'), '拒绝理由应指向「只能撤最新一次」')

  // ③ 撤最新的一次应放行
  const r2 = await undoBundle({ dshHome: target, backupDir: rep2.backupDir, dryRun: true, onLog: () => {} })
  assert.equal(r2.ok, true, '撤销最新一次应放行: ' + r2.errors.join('; '))
})

test('undo：账本格式守卫 —— version 不认识就拒绝，宁可撤不了也不猜', async () => {
  const dir = tmpDir('badjournal')
  fs.writeFileSync(path.join(dir, UNDO_JOURNAL_FILE), JSON.stringify({ format: 'dsh-sync-journal', version: 999, ops: [], renames: [] }))
  const r = loadJournal(dir)
  assert.equal(r.ok, false)
  assert.ok(r.problems[0].includes('格式不认识'))
})
