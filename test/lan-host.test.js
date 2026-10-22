// test/lan-host.test.js — dshsync_lan_host 发起**之前**的那一段。
//
// 刻意不测真的 startHost：那会监听端口、读一整个 bundle、起进度页服务，
// 测试里既不该占端口也不该依赖磁盘上有一个真 bundle。这里只钉住两件会静默错事的地方：
//   ① bundleDir 缺省取 config.outDir —— 换机流程里「把导出的落点再手抄一遍」是最多余的一步；
//   ② 两个前置错误（没有可用目录 / renew 时没有发送端）要说得清下一步，而不是抛一句术语。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { defineLanHostTool } from '../lib/tools/lan-host.js'

/** 一个空目录：足以证明「目录被真的用上了」，又不会走到监听端口那一步。 */
function emptyDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-host-'))
}

test('bundleDir 缺省取 config.outDir：导出的落点就是要发送的目录', async () => {
  const dir = emptyDir()
  const tool = defineLanHostTool(() => ({ outDir: dir }))
  // 空目录里没有 checksums.json → 会走到「不是 bundle」这一步。
  // 这正好证明缺省值被真的用上了：若是继续要求传参，这里会是另一句报错。
  await assert.rejects(() => tool.execute({ action: 'start' }), /checksums\.json/)
})

test('显式 bundleDir 压过配置：同一个工具两种用法都成立', async () => {
  const dir = emptyDir()
  const other = emptyDir()
  const tool = defineLanHostTool(() => ({ outDir: dir }))
  await assert.rejects(() => tool.execute({ action: 'start', bundleDir: other }),
    new RegExp(other.replace(/\\/g, '\\\\')), '报错里要是显式给的那个目录，不是配置里的')
})

test('配置里也没有输出目录时，报错要能指回设置卡片', async () => {
  const tool = defineLanHostTool(() => ({ outDir: '' }))
  await assert.rejects(() => tool.execute({ action: 'start' }), /输出目录/)
})

test('renew 时没有运行中的发送端：说明要先 start，且不再要求手输 bundleDir', async () => {
  const tool = defineLanHostTool(() => ({ outDir: emptyDir() }))
  await assert.rejects(() => tool.execute({ action: 'renew' }), /action="start"/)
  await assert.rejects(() => tool.execute({ action: 'renew' }), /缺省取配置/)
})

test('stop 永远是成功的（没有发送端也只是「本来就没在跑」）', async () => {
  const tool = defineLanHostTool(() => ({ outDir: '' }))
  const out = await tool.execute({ action: 'stop' })
  assert.equal(out.ok, true)
  assert.equal(out.action, 'stop')
})
