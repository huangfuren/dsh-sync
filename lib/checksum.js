// lib/checksum.js — bundle 完整性清单。
// bundle 要过 U 盘 / 局域网 / 网盘,拷坏或被截断的概率不低;而 apply 是半破坏性操作
// (覆盖 settings、跑一堆 plugin add),装到一半才发现源文件坏了很被动。
// 因此在导出侧给每个文件算 sha256,apply 前先整包校验,坏了就直接停手。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CHECKSUM_FILE = 'checksums.json'

/** 相对路径统一用 posix 分隔符,保证 Windows 导出的 bundle 在 Linux 侧也能校验通过。 */
function toPortableKey(bundleDir, abs) {
  return path.relative(bundleDir, abs).split(path.sep).join('/')
}

async function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    const dirents = await fs.promises.readdir(cur, { withFileTypes: true })
    for (const d of dirents) {
      const abs = path.join(cur, d.name)
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) stack.push(abs)
      else if (d.isFile()) out.push(abs)
    }
  }
  return out
}

/** 单个文件的 sha256(流式读取,bundle 里的大文件也不会撑爆内存)。 */
export function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(abs)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
  })
}

const sha256 = sha256File

/**
 * 为 bundle 目录生成 sha256 清单。
 * 清单文件自身不参与散列(否则自指永远对不上);调用方可再排除其它需要延后写入的文件
 * —— manifest.json 就是这样:它要记录本清单的摘要,得先算出清单才能落盘。
 * @param {string} bundleDir
 * @param {Iterable<string>} [exclude] 额外排除的可移植相对路径
 * @returns {Promise<{file:string, entries:Record<string,string>, count:number}>}
 */
export async function buildChecksums(bundleDir, exclude) {
  const extra = new Set(exclude || [])
  const files = (await walk(bundleDir))
    .map((abs) => ({ abs, key: toPortableKey(bundleDir, abs) }))
    .filter((f) => f.key !== CHECKSUM_FILE && !extra.has(f.key))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
  const entries = {}
  for (const f of files) entries[f.key] = await sha256(f.abs)
  return { file: CHECKSUM_FILE, entries, count: files.length }
}

/**
 * 校验 bundle 是否完好。
 * @returns {Promise<{ok:boolean, missing:string[], mismatched:string[], checked:number}>}
 */
export async function verifyChecksums(bundleDir, entries) {
  const table = entries || {}
  const missing = []
  const mismatched = []
  let checked = 0
  for (const key of Object.keys(table).sort()) {
    const abs = path.join(bundleDir, ...key.split('/'))
    const st = await fs.promises.stat(abs).catch(() => null)
    if (!st || !st.isFile()) {
      missing.push(key)
      continue
    }
    checked += 1
    if ((await sha256(abs)) !== table[key]) mismatched.push(key)
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, checked }
}
