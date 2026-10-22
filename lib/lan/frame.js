// lib/lan/frame.js — 传输流的帧编解码。零依赖，纯逻辑。
//
// 帧格式见 constants.js 的 FRAME 说明。这里只做「字节 ↔ 帧」的转换，不碰网络也不碰文件，
// 因此可以脱离 socket 单测：把一个 Buffer 拆成任意大小的块喂进 readFrames，
// 结果必须与一次喂完整 Buffer 完全一致（含 1 字节一块的极端情形）。
import { FRAME, FRAME_HEADER_BYTES, FRAME_MAGIC, MAX_FRAME_PAYLOAD } from './constants.js'

const MAGIC_BYTES = Buffer.from(FRAME_MAGIC, 'ascii')
const EMPTY = Buffer.alloc(0)

/** DATA 是裸字节，其余帧载荷是 JSON —— 这一处判断决定了解析后要不要 JSON.parse。 */
export function isJsonFrame(type) {
  return type !== FRAME.DATA
}

function asBuffer(payload) {
  if (payload === undefined || payload === null) return EMPTY
  if (Buffer.isBuffer(payload)) return payload
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  return Buffer.from(String(payload), 'utf8')
}

/**
 * 编一个帧。payload 是 Buffer 时原样作为载荷，否则序列化成 JSON。
 * @param {number} type FRAME 里的类型
 * @param {Buffer|Uint8Array|object|string|null} [payload]
 * @returns {Buffer}
 */
export function encodeFrame(type, payload) {
  const body = Buffer.isBuffer(payload) || payload instanceof Uint8Array
    ? asBuffer(payload)
    : (payload === undefined || payload === null ? EMPTY : Buffer.from(JSON.stringify(payload), 'utf8'))
  const head = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  MAGIC_BYTES.copy(head, 0)
  head[4] = type & 0xff
  head.writeUInt32BE(body.length, 5)
  return body.length === 0 ? head : Buffer.concat([head, body], FRAME_HEADER_BYTES + body.length)
}

/** 只编帧头，用于「先写头、再流式写体」的场合（大文件分块时省一次大 Buffer 拼接）。 */
export function encodeFrameHeader(type, length) {
  if (!Number.isInteger(length) || length < 0) throw new Error('frame: invalid payload length ' + length)
  if (length > MAX_FRAME_PAYLOAD) throw new Error('frame: payload ' + length + ' B exceeds cap')
  const head = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  MAGIC_BYTES.copy(head, 0)
  head[4] = type & 0xff
  head.writeUInt32BE(length, 5)
  return head
}

function decodeJson(payload, type) {
  const text = payload.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    // 明确报出是哪种帧坏了：真实故障里「对端不是 dsh-sync」与「协议版本不一致」
    // 都会走到这里，错误信息里带上帧类型能省掉一轮猜测。
    throw new Error('frame: type ' + type + ' payload is not valid JSON: ' + text.slice(0, 120))
  }
}

/**
 * 从可读流里逐帧读出，异步生成器 —— 背压天然正确：消费者不取下一帧，
 * 生成器就停在原处，socket 自然停止读取。
 *
 * @param {AsyncIterable<Buffer|Uint8Array|string>} stream
 * @param {{maxPayload?: number}} [options]
 * @returns {AsyncGenerator<{type:number, payload:Buffer, json:object|null}>}
 */
export async function* readFrames(stream, options = {}) {
  const maxPayload = options.maxPayload || MAX_FRAME_PAYLOAD
  let buf = EMPTY
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk) ? chunk : asBuffer(chunk)
    if (piece.length === 0) continue
    buf = buf.length === 0 ? piece : Buffer.concat([buf, piece])

    while (buf.length >= FRAME_HEADER_BYTES) {
      if (buf[0] !== MAGIC_BYTES[0] || buf[1] !== MAGIC_BYTES[1]
        || buf[2] !== MAGIC_BYTES[2] || buf[3] !== MAGIC_BYTES[3]) {
        // 最常见的真实原因：对面是浏览器 / 反代 / 另一个服务，而不是 dsh-sync。
        throw new Error('frame: bad magic "' + buf.subarray(0, 4).toString('latin1')
          + '" — 对端不是 dsh-sync，或这个端口被别的服务占了')
      }
      const type = buf[4]
      const length = buf.readUInt32BE(5)
      if (length > maxPayload) {
        throw new Error('frame: payload ' + length + ' B exceeds cap ' + maxPayload + ' B — 流异常或对端协议不兼容')
      }
      if (buf.length < FRAME_HEADER_BYTES + length) break   // 本帧还没收全，等下一块

      // subarray 是视图不复制：大文件分块接收时避免每块都 memcpy。
      // 视图持有原 ArrayBuffer 的引用，所以即使在后续 concat 之后仍然有效。
      const payload = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
      buf = buf.subarray(FRAME_HEADER_BYTES + length)
      yield { type, payload, json: isJsonFrame(type) ? decodeJson(payload, type) : null }
    }
  }
  if (buf.length !== 0) {
    // 半帧：传输在帧中间被切断（对端崩溃、网线拔掉、代理超时）。
    throw new Error('frame: stream ended mid-frame (' + buf.length + ' B left) — 传输被中断，已落地的文件可用续传补齐')
  }
}

/** 一次性解析整个 Buffer，返回帧数组。测试与调试用。 */
export function decodeFrames(buffer, options = {}) {
  const maxPayload = options.maxPayload || MAX_FRAME_PAYLOAD
  const out = []
  let buf = asBuffer(buffer)
  while (buf.length >= FRAME_HEADER_BYTES) {
    if (buf[0] !== MAGIC_BYTES[0] || buf[1] !== MAGIC_BYTES[1]
      || buf[2] !== MAGIC_BYTES[2] || buf[3] !== MAGIC_BYTES[3]) {
      throw new Error('frame: bad magic')
    }
    const type = buf[4]
    const length = buf.readUInt32BE(5)
    if (length > maxPayload) throw new Error('frame: payload exceeds cap')
    if (buf.length < FRAME_HEADER_BYTES + length) throw new Error('frame: truncated')
    const payload = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
    buf = buf.subarray(FRAME_HEADER_BYTES + length)
    out.push({ type, payload, json: isJsonFrame(type) ? decodeJson(payload, type) : null })
  }
  if (buf.length !== 0) throw new Error('frame: trailing bytes')
  return out
}
