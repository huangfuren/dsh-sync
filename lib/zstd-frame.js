// lib/zstd-frame.js — dsh 会话文件的「帧级最小改写」。
//
// 背景：sessions/<编码cwd>/<session-id>/session.jsonl.zstd 不是普通压缩文件，
// 而是 **zstd 多帧串接**：首帧是一行 JSON header（含权威 cwd），其余每帧是一行事件。
// 实测本机样本 893 帧、518749 字节，帧边界精确走到文件末尾。
//
// 因此改写 header 的正确做法是「只换首帧、其余帧字节原样保留」：
//   · 整体解压再重压会改掉全部 892 个事件帧的字节 —— 体积、校验和、可复现性全变；
//   · 而 zstdDecompressSync 面对多帧只会吐出**首帧**解码结果（185 字节），
//     这说明「拿首帧 = 拿 header」，但也意味着必须自己算帧边界才能切分。
//
// 帧边界解析依据 RFC 8878：magic → Frame_Header_Descriptor → (Window_Descriptor)
//   → (Dictionary_ID) → (Frame_Content_Size) → 连续 block（每块 3 字节头）→ (Checksum)。
// 这套解析是**有界**的：任何越界/保留位/保留块类型都立即返回 -1，绝不猜。

import fs from 'node:fs'
import zlib from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528） */
const ZSTD_MAGIC = 0xfd2fb528

/** 单文件帧数上限：防病态输入把解析变成无限循环 */
const MAX_FRAMES = 5_000_000

/**
 * 探测当前 node 是否内建 zstd。node 22.15+/24 有；缺了就降级为「不改写会话」，
 * 而不是抛异常把整个插件拖垮。
 * @returns {boolean}
 */
export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function'
}

/**
 * 计算从 off 开始的一个完整 zstd 帧的字节长度（含 magic）。
 * @param {Buffer} buf 容器字节
 * @param {number} off 帧起始偏移
 * @returns {number} 帧长；不是合法帧 / 越界 → -1
 */
function frameLength(buf, off) {
  if (off + 4 > buf.length) return -1
  if (buf.readUInt32LE(off) !== ZSTD_MAGIC) return -1
  let p = off + 4
  if (p >= buf.length) return -1
  const fhd = buf[p++]
  // bit3 为 Reserved，按规范必须为 0；非 0 说明不是合法帧头（不要硬猜）
  if (fhd & 0x08) return -1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const hasChecksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!singleSegment) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag]
  p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]
  if (p > buf.length) return -1
  // block 链
  for (;;) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >> 3
    if (type === 3) return -1 // 保留块类型：容器已损坏
    p += type === 1 ? 1 : size // RLE 块只占 1 字节，其余按 size
    if (p > buf.length) return -1
    if (last) break
  }
  if (hasChecksum) p += 4
  if (p > buf.length) return -1
  return p - off
}

/**
 * 扫描容器的全部帧边界。
 * @param {Buffer} buf
 * @returns {{starts:number[], complete:boolean}} starts=各帧起始偏移；complete=是否正好走到文件末尾
 */
export function parseFrames(buf) {
  const starts = []
  let p = 0
  while (p < buf.length && starts.length < MAX_FRAMES) {
    const len = frameLength(buf, p)
    // 解析失败：保留已解析到的部分，complete=false 由调用方决定怎么处理
    if (len <= 0) return { starts, complete: false }
    starts.push(p)
    p += len
  }
  return { starts, complete: p === buf.length }
}

/**
 * 读取会话文件的首帧 header（只解压首帧，不碰事件区）。
 * @param {string} filePath session.jsonl.zstd 绝对路径
 * @returns {{ok:boolean, reason?:string, header?:object, headerText?:string, buf?:Buffer, frameStarts?:number[], frameCount?:number, clean?:boolean}}
 */
export function readSessionHeader(filePath) {
  if (!zstdAvailable()) return { ok: false, reason: 'zstd-unavailable' }
  let buf
  try {
    buf = fs.readFileSync(filePath)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (buf.length < 8) return { ok: false, reason: 'too-small' }
  const { starts, complete } = parseFrames(buf)
  if (starts.length === 0) return { ok: false, reason: 'no-frame' }
  const ends = starts.length > 1 ? starts[1] : buf.length
  let headerText
  try {
    headerText = zlib.zstdDecompressSync(buf.subarray(0, ends)).toString('utf8')
  } catch {
    return { ok: false, reason: 'first-frame-undecodable' }
  }
  let header
  try {
    header = JSON.parse(headerText.trim())
  } catch {
    return { ok: false, reason: 'header-not-json' }
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return { ok: false, reason: 'header-not-object' }
  }
  return {
    ok: true,
    header,
    headerText,
    buf,
    frameStarts: starts,
    frameCount: starts.length,
    // clean=false 表示帧链没能走到文件末尾 —— 可能是撕裂尾帧（DSH 会自愈），
    // 此时**拒绝改写**：硬写会把可自愈的文件弄坏。
    clean: complete,
  }
}

/**
 * 只替换首帧、其余帧字节原样保留地改写 header，并写回同一文件。
 *
 * 安全序列（与生态共识一致）：先写临时文件 → rename 原子换入。
 * 绝不「读出来改完直接覆盖」——中途失败会留下半个文件。
 *
 * @param {string} filePath 目标会话文件
 * @param {object} newHeader 新的 header 对象（调用方负责只改该改的字段）
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] 只计算不落盘
 * @returns {{ok:boolean, reason?:string, bytesBefore?:number, bytesAfter?:number, frameCount?:number, changed?:boolean}}
 */
export function rewriteSessionHeader(filePath, newHeader, { dryRun = false } = {}) {
  const read = readSessionHeader(filePath)
  if (!read.ok) return { ok: false, reason: read.reason }
  if (!read.clean) return { ok: false, reason: 'torn-tail-or-broken-chain' }

  const { buf, frameStarts, header } = read
  const firstLen = frameStarts.length > 1 ? frameStarts[1] : buf.length

  // 序列化必须与宿主同风格：单行 JSON + 结尾换行。键顺序沿用原 header。
  const nextText = JSON.stringify({ ...header, ...newHeader }) + '\n'
  const prevText = read.headerText
  if (nextText === prevText) {
    return { ok: true, changed: false, bytesBefore: buf.length, bytesAfter: buf.length, frameCount: read.frameCount }
  }

  let newFirst
  try {
    newFirst = zlib.zstdCompressSync(Buffer.from(nextText, 'utf8'))
  } catch {
    return { ok: false, reason: 'compress-failed' }
  }
  const out = Buffer.concat([newFirst, buf.subarray(firstLen)])

  // 写前自检：新容器必须帧链完整、帧数不变、首帧能解回我们写进去的值。
  const check = parseFrames(out)
  if (!check.complete || check.starts.length !== frameStarts.length) {
    return { ok: false, reason: 'post-build-frame-mismatch' }
  }
  try {
    const back = JSON.parse(zlib.zstdDecompressSync(out.subarray(0, check.starts[1])).toString('utf8').trim())
    if (JSON.stringify(back) !== JSON.stringify({ ...header, ...newHeader })) {
      return { ok: false, reason: 'post-build-header-mismatch' }
    }
  } catch {
    return { ok: false, reason: 'post-build-undecodable' }
  }

  if (dryRun) {
    return { ok: true, changed: true, dryRun: true, bytesBefore: buf.length, bytesAfter: out.length, frameCount: check.starts.length }
  }

  const tmp = filePath + '.dshsync-tmp'
  try {
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* 清不掉也不影响原文件 */ }
    return { ok: false, reason: 'write-failed: ' + (err && err.message ? err.message : String(err)) }
  }
  return { ok: true, changed: true, bytesBefore: buf.length, bytesAfter: out.length, frameCount: check.starts.length }
}
