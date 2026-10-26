/**
 * 纯 JS 同步 SHA-256。
 *
 * 为什么不用 crypto.subtle：它是异步的，而指纹比对发生在「构造记录」与「渲染前校验」
 * 这两个同步路径上；并且不是所有 webview 都暴露 crypto.subtle（非安全上下文没有）。
 * 为什么不用 node:crypto：浏览器半不许碰 node 内建模块。
 *
 * 失败行为：本模块不抛异常。非字符串输入按 UTF-8 字节处理，字符串输入先按 UTF-8 编码；
 * 参数类型完全不合法（null / undefined / 对象）时也按空字节序列处理，返回空串的哈希，
 * 绝不会静默返回一个「看起来像哈希」的错值——调用方从返回值拿不到任何错误信号，
 * 所以调用方必须在调用前就保证输入是 string 或 Uint8Array。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0

/**
 * 把字符串按 UTF-8 编码成字节。
 * 行为与 TextEncoder 完全一致：孤立代理项（未配对的 high/low surrogate）编码为 U+FFFD
 * 的字节序列 EF BF BD，而不是抛错或产出非法 UTF-8。这一点必须稳定：
 * 同一段文字在不同端算出的指纹要一致，不能让「半个 emoji」变成两种字节。
 *
 * @param {string} str
 * @returns {Uint8Array} UTF-8 字节
 */
export function utf8Bytes(str) {
  const text = typeof str === 'string' ? str : String(str ?? '')
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text)
  const out = []
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i)
    const high = text.charCodeAt(i)
    if (high >= 0xd800 && high <= 0xdbff) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) i++
      else cp = 0xfffd // 孤立 high surrogate
    } else if (high >= 0xdc00 && high <= 0xdfff) cp = 0xfffd // 孤立 low surrogate
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else out.push(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    )
  }
  return Uint8Array.from(out)
}

const toBytes = input => {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (typeof input === 'string') return utf8Bytes(input)
  return new Uint8Array(0)
}

/**
 * 同步计算 SHA-256，返回 64 位小写 hex。
 *
 * @param {string|Uint8Array|ArrayBuffer} bytesOrString 字符串按 UTF-8 编码
 * @returns {string} 64 位小写十六进制
 */
export function sha256Hex(bytesOrString) {
  const bytes = toBytes(bytesOrString)
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  // 填充：0x80 + 若干 0x00 + 8 字节大端位长。注意 JS 的位长要用「字节数 * 8」的双字表示。
  const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000)
  const bitLenLo = (bytes.length * 8) >>> 0
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6))
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLenHi, false)
  dv.setUint32(padded.length - 4, bitLenLo, false)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotl(w[i - 15], 25) ^ rotl(w[i - 15], 14) ^ (w[i - 15] >>> 3)
      const s1 = rotl(w[i - 2], 15) ^ rotl(w[i - 2], 13) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotl(e, 26) ^ rotl(e, 21) ^ rotl(e, 7)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotl(a, 30) ^ rotl(a, 19) ^ rotl(a, 10)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  let hex = ''
  for (const word of h) hex += word.toString(16).padStart(8, '0')
  return hex
}
