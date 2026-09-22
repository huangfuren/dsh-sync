// lib/crypto.js — 凭据加密搬运(AES-256-GCM + scrypt 派生密钥)。
// 动机:换机时凭据必须过一趟"不可控介质"(U 盘 / 局域网 / 网盘)。明文搬运等于泄露,
// 完全不搬又要在目标机挨个重填几十个插件的 key。加密搬运是唯一两头都不妥协的解:
// bundle 里躺的是密文,目标机 apply 时凭口令解密后立即写入 `$DSH_HOME`,绝不明文落盘。
// 零第三方依赖:只用 node:crypto 内置模块。
import crypto from 'node:crypto'

const MAGIC = 'dshsync1'
const ALG = 'aes-256-gcm'
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

// scrypt 参数:N=2^14 时约需 16MiB 内存,低于 node 默认 maxmem(32MiB),
// 既保证口令较弱时也有足够爆破成本,又不会在低配机器上因内存上限失败。
const SCRYPT = { N: 2 ** 14, r: 8, p: 1 }

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, KEY_BYTES, SCRYPT)
}

/**
 * AEAD 加密。输出布局:MAGIC | salt | iv | tag | ciphertext。
 * tag 参与校验:口令错 / 文件被篡改都会在中途抛错,绝不会解出一份错的明文。
 * @param {Buffer|string} plain
 * @param {string} passphrase
 * @returns {Buffer}
 */
export function encryptBuffer(plain, passphrase) {
  if (!passphrase || String(passphrase).length < 6) {
    throw new Error('passphrase must be at least 6 characters')
  }
  const body = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALG, deriveKey(passphrase, salt), iv)
  const payload = Buffer.concat([cipher.update(body), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from(MAGIC, 'utf8'), salt, iv, tag, payload])
}

/**
 * 解密。口令错误时 node 会抛 "Unsupported state or unable to authenticate data"。
 * @param {Buffer} packed
 * @param {string} passphrase
 * @returns {Buffer}
 */
export function decryptBuffer(packed, passphrase) {
  if (!Buffer.isBuffer(packed)) throw new Error('encrypted payload must be a Buffer')
  const head = Buffer.byteLength(MAGIC)
  if (packed.length < head + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted payload is truncated')
  }
  if (packed.subarray(0, head).toString('utf8') !== MAGIC) {
    throw new Error('not a dsh-sync encrypted payload')
  }
  let off = head
  const salt = packed.subarray(off, off + SALT_BYTES)
  off += SALT_BYTES
  const iv = packed.subarray(off, off + IV_BYTES)
  off += IV_BYTES
  const tag = packed.subarray(off, off + TAG_BYTES)
  off += TAG_BYTES
  const body = packed.subarray(off)
  const decipher = crypto.createDecipheriv(ALG, deriveKey(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/**
 * 把一段明文密钥加密成可安全写进 JSON 的 base64 包。
 * 用于 settings.yaml 内的明文密钥:既不丢弃(省得用户重填),也不明文走。
 */
export function encryptToBase64(text, passphrase) {
  return encryptBuffer(Buffer.from(String(text), 'utf8'), passphrase).toString('base64')
}

export function decryptFromBase64(b64, passphrase) {
  return decryptBuffer(Buffer.from(String(b64), 'base64'), passphrase).toString('utf8')
}
