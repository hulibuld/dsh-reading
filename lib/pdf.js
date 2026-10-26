/**
 * pdf.js —— 零依赖 PDF 解析：只为了把字读出来重排，不还原版面。
 *
 * 与 EPUB / MOBI / TXT 三条路径的关系：它们最终都交给 `textbook.js` 生成
 * 「spine + 章节 XHTML + toc」，PDF 也走同一条路——把第 1 页到第 N 页的文字
 * 按阅读顺序抠出来，再按「章标题」或「页段」切成章节。好处是 store / routes /
 * 客户端一行都不用为 PDF 分叉，坏处是表格、分栏、图片、公式会退化成流水文字。
 * 这个取舍写在 docs/11-格式支持-PDF.md，导入时也会在书架上标「PDF · 重排」。
 *
 * 做对了的几件麻烦事：
 *   - **交叉引用表**：优先走 `startxref`；表坏了、偏移不对（大量下载站的 PDF 都这样）
 *     就退回全文件扫 `N G obj` 重建索引，而不是直接报「文件损坏」。
 *   - **对象流**：现代 PDF（1.5+）会把普通对象压进 `/ObjStm` 里，不展开它就只能
 *     看到半个文档。
 *   - **过滤器**：FlateDecode（含 PNG 预测器）、LZW、ASCIIHex、ASCII85、RunLength。
 *   - **加密**：明确拒绝并说人话，不吐乱码。
 */

import zlib from 'node:zlib'
import { fail } from './errors.js'
import { buildReflowedBook } from './textbook.js'
import { isHeadingLine } from './txt.js'
import { buildFont, extractPageText, linesToParagraphs } from './pdftext.js'

/** 页数上限：再多的 PDF 也不是拿来读书的，兜住内存。 */
const MAX_PAGES = 4000
/** 单个流解码后的上限。 */
const MAX_STREAM_BYTES = 96 * 1024 * 1024
/** 页面树 / 对象递归深度上限。 */
const MAX_DEPTH = 64
/** 没有章标题时，几页合成一章。 */
const PAGES_PER_CHAPTER = 8

const WS_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM_BYTES = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

/* ------------------------------------------------------------------ *
 * 词法
 * ------------------------------------------------------------------ */

function isWhiteByte(byte) {
  return WS_BYTES.has(byte)
}

function isDelimByte(byte) {
  return DELIM_BYTES.has(byte)
}

/** 跳空白与 `%` 注释。 */
function skipSpace(buf, pos) {
  let i = pos
  while (i < buf.length) {
    const byte = buf[i]
    if (isWhiteByte(byte)) {
      i += 1
      continue
    }
    if (byte === 0x25) {
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1
      continue
    }
    break
  }
  return i
}

function readName(buf, pos) {
  let i = pos + 1
  let raw = ''
  while (i < buf.length) {
    const byte = buf[i]
    if (isWhiteByte(byte) || isDelimByte(byte)) break
    if (byte === 0x23 && i + 2 < buf.length) {
      const code = Number.parseInt(buf.subarray(i + 1, i + 3).toString('latin1'), 16)
      raw += Number.isFinite(code) ? String.fromCharCode(code) : '#'
      i += 3
      continue
    }
    raw += String.fromCharCode(byte)
    i += 1
  }
  return { value: raw, next: i }
}

function readLiteralString(buf, pos) {
  let i = pos + 1
  let depth = 1
  const out = []
  while (i < buf.length) {
    const byte = buf[i]
    if (byte === 0x5c) {
      const next = buf[i + 1]
      if (next === undefined) break
      if (next >= 0x30 && next <= 0x37) {
        let value = 0
        let count = 0
        i += 1
        while (count < 3 && buf[i] >= 0x30 && buf[i] <= 0x37) {
          value = value * 8 + (buf[i] - 0x30)
          i += 1
          count += 1
        }
        out.push(value & 0xff)
        continue
      }
      const escapes = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c }
      if (Object.prototype.hasOwnProperty.call(escapes, next)) {
        out.push(escapes[next])
        i += 2
        continue
      }
      if (next === 0x0d) {
        i += buf[i + 2] === 0x0a ? 3 : 2
        continue
      }
      if (next === 0x0a) {
        i += 2
        continue
      }
      out.push(next)
      i += 2
      continue
    }
    if (byte === 0x28) {
      depth += 1
      out.push(byte)
      i += 1
      continue
    }
    if (byte === 0x29) {
      depth -= 1
      if (depth === 0) return { value: Buffer.from(out), next: i + 1 }
      out.push(byte)
      i += 1
      continue
    }
    out.push(byte)
    i += 1
  }
  return { value: Buffer.from(out), next: i }
}

function readHexString(buf, pos) {
  let i = pos + 1
  let hex = ''
  while (i < buf.length) {
    const byte = buf[i]
    if (byte === 0x3e) {
      i += 1
      break
    }
    const char = String.fromCharCode(byte)
    if (/[0-9A-Fa-f]/.test(char)) hex += char
    i += 1
  }
  if (hex.length % 2 === 1) hex += '0'
  return { value: Buffer.from(hex, 'hex'), next: i }
}

function readNumberToken(buf, pos) {
  let i = pos
  let raw = ''
  while (i < buf.length) {
    const char = String.fromCharCode(buf[i])
    if (/[0-9+\-.]/.test(char)) {
      raw += char
      i += 1
      continue
    }
    break
  }
  if (raw === '' || raw === '-' || raw === '+' || raw === '.') return { value: null, next: pos }
  const value = Number(raw)
  return { value: Number.isFinite(value) ? value : null, next: i }
}

function readKeywordToken(buf, pos) {
  let i = pos
  let raw = ''
  while (i < buf.length) {
    const byte = buf[i]
    if (isWhiteByte(byte) || isDelimByte(byte)) break
    raw += String.fromCharCode(byte)
    i += 1
  }
  return { value: raw, next: i }
}

/* ------------------------------------------------------------------ *
 * 语法：PDF 对象
 * ------------------------------------------------------------------ */

function nameNode(value) {
  return { t: 'name', v: value }
}

function dictGet(dict, key) {
  if (!dict || typeof dict.get !== 'function') return undefined
  return dict.get(key)
}

function nameOf(value) {
  if (value && value.t === 'name') return value.v
  return ''
}

/**
 * 解析一个 PDF 对象值。
 *
 * 返回 `{ value, next }`。值的形式：
 *   - 数字 / 布尔 / null → 原生值
 *   - 名字 → `{ t:'name', v }`
 *   - 字符串 → `{ t:'str', v:Buffer }`
 *   - 引用 → `{ t:'ref', n, g }`
 *   - 数组 → JS 数组
 *   - 字典 → Map
 *   - 流 → `{ t:'stream', dict:Map, start, end }`
 */
function parseValue(buf, pos, depth = 0) {
  if (depth > MAX_DEPTH) return { value: null, next: pos }
  let i = skipSpace(buf, pos)
  if (i >= buf.length) return { value: null, next: i }
  const byte = buf[i]

  if (byte === 0x2f) {
    const read = readName(buf, i)
    return { value: nameNode(read.value), next: read.next }
  }
  if (byte === 0x28) {
    const read = readLiteralString(buf, i)
    return { value: { t: 'str', v: read.value }, next: read.next }
  }
  if (byte === 0x3c) {
    if (buf[i + 1] === 0x3c) {
      const dict = new Map()
      let cursor = i + 2
      for (;;) {
        cursor = skipSpace(buf, cursor)
        if (cursor >= buf.length) break
        if (buf[cursor] === 0x3e && buf[cursor + 1] === 0x3e) {
          cursor += 2
          break
        }
        if (buf[cursor] !== 0x2f) {
          // 畸形容器：跳过一个 token 继续，不整份失败
          const skipped = parseValue(buf, cursor, depth + 1)
          if (skipped.next === cursor) break
          cursor = skipped.next
          continue
        }
        const keyRead = readName(buf, cursor)
        cursor = keyRead.next
        const valueRead = parseValue(buf, cursor, depth + 1)
        dict.set(keyRead.value, valueRead.value)
        cursor = valueRead.next
      }
      return { value: dict, next: cursor }
    }
    const read = readHexString(buf, i)
    return { value: { t: 'str', v: read.value }, next: read.next }
  }
  if (byte === 0x5b) {
    const items = []
    let cursor = i + 1
    for (;;) {
      cursor = skipSpace(buf, cursor)
      if (cursor >= buf.length) break
      if (buf[cursor] === 0x5d) {
        cursor += 1
        break
      }
      const read = parseValue(buf, cursor, depth + 1)
      if (read.next === cursor) break
      items.push(read.value)
      cursor = read.next
    }
    return { value: items, next: cursor }
  }

  if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
    const first = readNumberToken(buf, i)
    if (first.value === null) {
      const keyword = readKeywordToken(buf, i)
      return { value: keyword.value, next: keyword.next }
    }
    // 有可能是「间接引用」`12 0 R`
    let cursor = skipSpace(buf, first.next)
    if (cursor > first.next && buf[cursor] >= 0x30 && buf[cursor] <= 0x39) {
      const second = readNumberToken(buf, cursor)
      if (second.value !== null) {
        const afterSecond = skipSpace(buf, second.next)
        if (afterSecond > second.next && buf[afterSecond] === 0x52) {
          const afterR = afterSecond + 1
          const boundary = afterR >= buf.length || isWhiteByte(buf[afterR]) || isDelimByte(buf[afterR])
          if (boundary) {
            return { value: { t: 'ref', n: Math.trunc(first.value), g: Math.trunc(second.value) }, next: afterR }
          }
        }
      }
    }
    return { value: first.value, next: first.next }
  }

  const keyword = readKeywordToken(buf, i)
  if (keyword.value === 'true') return { value: true, next: keyword.next }
  if (keyword.value === 'false') return { value: false, next: keyword.next }
  if (keyword.value === 'null') return { value: null, next: keyword.next }
  if (keyword.value === '') {
    // 不认识的字节：前进一格，避免死循环
    return { value: null, next: i + 1 }
  }
  return { value: { t: 'op', v: keyword.value }, next: keyword.next }
}

/** 解析 `N G obj … endobj`，返回 `{ num, value, next }`。 */
function parseIndirectObjectAt(buf, offset) {
  let cursor = skipSpace(buf, offset)
  const numRead = readNumberToken(buf, cursor)
  if (numRead.value === null) return null
  cursor = skipSpace(buf, numRead.next)
  const genRead = readNumberToken(buf, cursor)
  if (genRead.value === null) return null
  cursor = skipSpace(buf, genRead.next)
  const keyword = readKeywordToken(buf, cursor)
  if (keyword.value !== 'obj') return null
  cursor = keyword.next

  const valueRead = parseValue(buf, cursor)
  let value = valueRead.value
  cursor = skipSpace(buf, valueRead.next)
  const after = readKeywordToken(buf, cursor)
  if (after.value === 'stream' && value instanceof Map) {
    let dataStart = after.next
    if (buf[dataStart] === 0x0d) dataStart += buf[dataStart + 1] === 0x0a ? 2 : 1
    else if (buf[dataStart] === 0x0a) dataStart += 1
    const bounds = findStreamEnd(buf, dataStart, dictGet(value, 'Length'))
    value = { t: 'stream', dict: value, start: dataStart, end: bounds.end }
    cursor = bounds.next
  }
  return { num: Math.trunc(numRead.value), gen: Math.trunc(genRead.value), value, next: cursor }
}

/**
 * 找流数据结束位置。
 *
 * `/Length` 可能是错的（大量真实文件如此），也可能是间接引用（这里拿不到解析器）。
 * 两个办法：先按 Length 试，验证后面确实紧跟 `endstream`；不像就全文件找 `endstream`。
 */
function findStreamEnd(buf, dataStart, lengthValue) {
  const length = typeof lengthValue === 'number' ? lengthValue : null
  if (length !== null && length >= 0 && dataStart + length <= buf.length) {
    let probe = skipSpace(buf, dataStart + length)
    const keyword = buf.subarray(probe, Math.min(probe + 9, buf.length)).toString('latin1')
    if (keyword === 'endstream') {
      return { end: dataStart + length, next: probe + 9 }
    }
  }
  const marker = Buffer.from('endstream', 'latin1')
  const found = buf.indexOf(marker, dataStart)
  if (found === -1) return { end: buf.length, next: buf.length }
  let end = found
  // endstream 前面那个 EOL 不算数据
  if (end > dataStart && buf[end - 1] === 0x0a) end -= 1
  if (end > dataStart && buf[end - 1] === 0x0d) end -= 1
  return { end, next: found + marker.length }
}

/* ------------------------------------------------------------------ *
 * 过滤器
 * ------------------------------------------------------------------ */

/** PNG 预测器（xref 流几乎都带它，不还原会读到一堆错位的数字）。 */
function applyPngPredictor(data, columns, colors, bitsPerComponent) {
  const bpp = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8))
  const rowLength = Math.max(1, Math.ceil((columns * colors * bitsPerComponent) / 8))
  const rows = Math.floor(data.length / (rowLength + 1))
  const out = Buffer.alloc(rows * rowLength)
  let previous = Buffer.alloc(rowLength)
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * (rowLength + 1)]
    const line = data.subarray(row * (rowLength + 1) + 1, (row + 1) * (rowLength + 1))
    const current = Buffer.from(line)
    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= bpp ? current[i - bpp] : 0
      const up = previous[i] ?? 0
      const upLeft = i >= bpp ? previous[i - bpp] ?? 0 : 0
      switch (filter) {
        case 1:
          current[i] = (current[i] + left) & 0xff
          break
        case 2:
          current[i] = (current[i] + up) & 0xff
          break
        case 3:
          current[i] = (current[i] + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          current[i] = (current[i] + predictor) & 0xff
          break
        }
        default:
          break
      }
    }
    current.copy(out, row * rowLength)
    previous = current
  }
  return out
}

function applyTiffPredictor(data, columns, colors, bitsPerComponent) {
  const bpp = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8))
  const rowLength = Math.max(1, Math.ceil((columns * colors * bitsPerComponent) / 8))
  const rows = Math.floor(data.length / rowLength)
  const out = Buffer.from(data)
  for (let row = 1; row < rows; row += 1) {
    for (let i = 0; i < rowLength; i += 1) {
      const index = row * rowLength + i
      const left = i >= bpp ? out[index - bpp] : 0
      out[index] = (out[index] + left) & 0xff
    }
  }
  return out
}

function applyDecodeParams(data, params) {
  if (!params || typeof params.get !== 'function') return data
  const predictorValue = params.get('Predictor')
  const predictor = typeof predictorValue === 'number' ? predictorValue : 1
  if (predictor <= 1) return data
  const columns = typeof params.get('Columns') === 'number' ? params.get('Columns') : 1
  const colors = typeof params.get('Colors') === 'number' ? params.get('Colors') : 1
  const bits = typeof params.get('BitsPerComponent') === 'number' ? params.get('BitsPerComponent') : 8
  if (predictor >= 10) return applyPngPredictor(data, columns, colors, bits)
  if (predictor === 2) return applyTiffPredictor(data, columns, colors, bits)
  return data
}

function inflate(data) {
  if (data.length === 0) return Buffer.alloc(0)
  try {
    return zlib.inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES })
  } catch {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_STREAM_BYTES })
    } catch {
      // 有些流前面带垃圾字节，从下一个 zlib 头重试一次
      for (let skip = 1; skip < Math.min(8, data.length); skip += 1) {
        if (data[skip] !== 0x78) continue
        try {
          return zlib.inflateSync(data.subarray(skip), { maxOutputLength: MAX_STREAM_BYTES })
        } catch {
          // 继续试
        }
      }
      return null
    }
  }
}

function decodeLzw(data, earlyChange = 1) {
  const out = []
  let dict = []
  const resetDict = () => {
    dict = []
    for (let i = 0; i < 256; i += 1) dict.push(Buffer.from([i]))
    dict.push(Buffer.alloc(0), Buffer.alloc(0))
  }
  resetDict()
  let codeLength = 9
  let bitBuffer = 0
  let bitCount = 0
  let previous = null
  for (let i = 0; i < data.length; i += 1) {
    bitBuffer = (bitBuffer << 8) | data[i]
    bitCount += 8
    while (bitCount >= codeLength) {
      const code = (bitBuffer >> (bitCount - codeLength)) & ((1 << codeLength) - 1)
      bitCount -= codeLength
      if (code === 256) {
        resetDict()
        codeLength = 9
        previous = null
        continue
      }
      if (code === 257) return Buffer.concat(out)
      let entry
      if (code < dict.length) entry = dict[code]
      else if (previous) entry = Buffer.concat([previous, Buffer.from([previous[0]])])
      else return Buffer.concat(out)
      out.push(entry)
      if (previous) dict.push(Buffer.concat([previous, Buffer.from([entry[0]])]))
      previous = entry
      const limit = dict.length + earlyChange
      if (limit >= 1 << codeLength && codeLength < 12) codeLength += 1
      if (out.length > 200000) return Buffer.concat(out)
    }
  }
  return Buffer.concat(out)
}

function decodeAsciiHex(data) {
  const text = data.toString('latin1')
  const end = text.indexOf('>')
  const body = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, '')
  return Buffer.from(body.length % 2 === 1 ? `${body}0` : body, 'hex')
}

function decodeAscii85(data) {
  const text = data.toString('latin1').replace(/[\x00\t\n\r ]/g, '')
  const body = text.startsWith('<~') ? text.slice(2) : text
  const stripped = body.endsWith('~>') ? body.slice(0, -2) : body
  const out = []
  let chunk = []
  for (const char of stripped) {
    if (char === 'z' && chunk.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    const code = char.charCodeAt(0) - 33
    if (code < 0 || code > 84) continue
    chunk.push(code)
    if (chunk.length === 5) {
      let value = 0
      for (const digit of chunk) value = value * 85 + digit
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      chunk = []
    }
  }
  if (chunk.length > 0) {
    const missing = 5 - chunk.length
    for (let i = 0; i < missing; i += 1) chunk.push(84)
    let value = 0
    for (const digit of chunk) value = value * 85 + digit
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...bytes.slice(0, bytes.length - missing))
  }
  return Buffer.from(out)
}

function decodeRunLength(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    const length = data[i]
    i += 1
    if (length === 128) break
    if (length < 128) {
      out.push(...data.subarray(i, i + length + 1))
      i += length + 1
    } else {
      const byte = data[i]
      i += 1
      for (let count = 0; count < 257 - length; count += 1) out.push(byte)
    }
  }
  return Buffer.from(out)
}

/** 图像编码：我们要的是文字，这类流直接跳过。 */
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode'])

function normalizeFilters(dict, resolver) {
  const filterValue = resolver ? resolver(dictGet(dict, 'Filter')) : dictGet(dict, 'Filter')
  const paramsValue = resolver ? resolver(dictGet(dict, 'DecodeParms')) : dictGet(dict, 'DecodeParms')
  const filters = []
  if (filterValue && filterValue.t === 'name') filters.push(filterValue.v)
  else if (Array.isArray(filterValue)) {
    for (const item of filterValue) {
      const resolved = resolver ? resolver(item) : item
      if (resolved && resolved.t === 'name') filters.push(resolved.v)
    }
  }
  let params = paramsValue
  if (Array.isArray(params)) params = params[0]
  const parms = []
  if (Array.isArray(paramsValue)) {
    for (const item of paramsValue) parms.push(resolver ? resolver(item) : item)
  } else {
    parms.push(params)
  }
  return { filters, parms }
}

function applyFilters(data, dict, resolver) {
  const { filters, parms } = normalizeFilters(dict, resolver)
  let current = data
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index]
    const params = parms[index] ?? parms[0]
    switch (filter) {
      case 'FlateDecode':
      case 'Fl': {
        const inflated = inflate(current)
        if (inflated === null) return null
        current = applyDecodeParams(inflated, params)
        break
      }
      case 'LZWDecode':
      case 'LZW': {
        const early = params && typeof params.get === 'function' && typeof params.get('EarlyChange') === 'number'
          ? params.get('EarlyChange')
          : 1
        current = applyDecodeParams(decodeLzw(current, early), params)
        break
      }
      case 'ASCIIHexDecode':
      case 'AHx':
        current = decodeAsciiHex(current)
        break
      case 'ASCII85Decode':
      case 'A85':
        current = decodeAscii85(current)
        break
      case 'RunLengthDecode':
      case 'RL':
        current = decodeRunLength(current)
        break
      default:
        if (IMAGE_FILTERS.has(filter)) return null
        // 不认识的过滤器：宁可这一页没字，也不要吐乱码
        return null
    }
  }
  return current
}

/* ------------------------------------------------------------------ *
 * 文档
 * ------------------------------------------------------------------ */

/** PDFDocEncoding 与 latin1 在 ASCII 段一致；`FE FF` 开头是 UTF-16BE。 */
export function decodeDocString(value) {
  if (!value || value.t !== 'str') return ''
  const bytes = value.v
  if (!bytes || bytes.length === 0) return ''
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = tmp
    }
    return swapped.toString('utf16le')
  }
  // UTF-8 BOM（少数导出器会写）
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8')
  }
  // 规范说这里是 PDFDocEncoding，但很多中文生成器直接塞 UTF-8 字节（没 BOM）。
  // 先按 UTF-8 试一次：解得干净就用它，解出替换符（U+FFFD）说明不是 UTF-8，退回 latin1。
  if (bytes.some((byte) => byte >= 0x80)) {
    const utf8 = bytes.toString('utf8')
    if (!utf8.includes('\uFFFD')) return utf8
  }
  return bytes.toString('latin1')
}

class PdfDocument {
  constructor(buf) {
    this.buf = buf
    this.entries = new Map()
    this.trailers = []
    this.cache = new Map()
    this.objectStreams = new Map()
    this.xrefOk = false
  }

  load() {
    try {
      this.readXref()
    } catch {
      this.xrefOk = false
    }
    if (!this.xrefOk || this.entries.size === 0) this.scanObjects()
    if (this.entries.size === 0) {
      throw fail('E_PDF_INVALID', '这个 PDF 里找不到任何可以读的内容，文件可能已经损坏。', {
        detail: 'no objects found by xref or scan',
      })
    }
    if (this.trailer().get('Encrypt') !== undefined) {
      throw fail('E_PDF_ENCRYPTED', '这本 PDF 有密码保护（加密），暂时打不开。请换一本没加密的。', {
        detail: 'trailer has /Encrypt',
      })
    }
    return this
  }

  trailer() {
    const merged = new Map()
    // 越靠前的 trailer 越新（增量更新在后面，这里 trailers[0] 是最后一节）
    for (let index = this.trailers.length - 1; index >= 0; index -= 1) {
      const dict = this.trailers[index]
      if (!dict || typeof dict.get !== 'function') continue
      for (const [key, value] of dict) if (!merged.has(key)) merged.set(key, value)
    }
    return merged
  }

  readXref() {
    const buf = this.buf
    const marker = Buffer.from('startxref', 'latin1')
    const markerAt = buf.lastIndexOf(marker)
    let offset = null
    if (markerAt >= 0) {
      const text = buf.subarray(markerAt, Math.min(markerAt + 64, buf.length)).toString('latin1')
      const match = /startxref\s+(\d+)/.exec(text)
      if (match) offset = Number(match[1])
    }
    const seen = new Set()
    let guard = 0
    while (offset !== null && offset >= 0 && offset < buf.length && !seen.has(offset) && guard < 256) {
      guard += 1
      seen.add(offset)
      const head = buf.subarray(offset, Math.min(offset + 32, buf.length)).toString('latin1').trimStart()
      if (head.startsWith('xref')) {
        const parsed = this.readClassicXref(offset)
        if (!parsed) break
        for (const [num, entry] of parsed.entries) if (!this.entries.has(num)) this.entries.set(num, entry)
        this.trailers.push(parsed.trailer)
        const hybrid = parsed.trailer.get('XRefStm')
        if (typeof hybrid === 'number') this.readXrefStream(hybrid)
        const prev = parsed.trailer.get('Prev')
        offset = typeof prev === 'number' ? prev : null
        continue
      }
      const parsedStream = this.readXrefStream(offset)
      if (!parsedStream) break
      const prev = parsedStream.get('Prev')
      offset = typeof prev === 'number' ? prev : null
    }
    this.xrefOk = this.entries.size > 0
  }

  readClassicXref(offset) {
    const buf = this.buf
    const entries = new Map()
    let cursor = skipSpace(buf, offset + 4)
    for (;;) {
      cursor = skipSpace(buf, cursor)
      const startRead = readNumberToken(buf, cursor)
      if (startRead.value === null) break
      cursor = skipSpace(buf, startRead.next)
      const countRead = readNumberToken(buf, cursor)
      if (countRead.value === null) break
      cursor = skipSpace(buf, countRead.next)
      const start = Math.trunc(startRead.value)
      const count = Math.trunc(countRead.value)
      if (count < 0 || count > 1000000) break
      for (let index = 0; index < count; index += 1) {
        cursor = skipSpace(buf, cursor)
        const offsetRead = readNumberToken(buf, cursor)
        if (offsetRead.value === null) return null
        cursor = skipSpace(buf, offsetRead.next)
        const genRead = readNumberToken(buf, cursor)
        if (genRead.value === null) return null
        cursor = skipSpace(buf, genRead.next)
        const typeRead = readKeywordToken(buf, cursor)
        cursor = typeRead.next
        const num = start + index
        if (!this.entries.has(num) && !entries.has(num)) {
          entries.set(
            num,
            typeRead.value.startsWith('n') ? { type: 1, offset: Math.trunc(offsetRead.value) } : { type: 0 },
          )
        }
      }
    }
    // trailer
    const trailerMarker = Buffer.from('trailer', 'latin1')
    const found = buf.indexOf(trailerMarker, cursor)
    if (found === -1) return null
    const valueRead = parseValue(buf, found + trailerMarker.length)
    if (!(valueRead.value instanceof Map)) return null
    return { entries, trailer: valueRead.value }
  }

  readXrefStream(offset) {
    const parsed = parseIndirectObjectAt(this.buf, offset)
    if (!parsed || !parsed.value || parsed.value.t !== 'stream') return null
    const dict = parsed.value.dict
    if (nameOf(dictGet(dict, 'Type')) !== 'XRef') return null
    const raw = this.rawStreamBytes(parsed.value)
    const data = applyFilters(raw, dict, (value) => this.resolve(value))
    if (!data) return null
    const widths = Array.isArray(dictGet(dict, 'W')) ? dictGet(dict, 'W').map((item) => (typeof item === 'number' ? item : 0)) : []
    if (widths.length < 3) return null
    const size = typeof dictGet(dict, 'Size') === 'number' ? dictGet(dict, 'Size') : 0
    let indexPairs = Array.isArray(dictGet(dict, 'Index')) ? dictGet(dict, 'Index').map((item) => (typeof item === 'number' ? item : 0)) : null
    if (!indexPairs) indexPairs = [0, size]
    const rowLength = widths.reduce((sum, width) => sum + width, 0)
    if (rowLength <= 0) return null

    let cursor = 0
    for (let pairIndex = 0; pairIndex + 1 < indexPairs.length; pairIndex += 2) {
      const start = indexPairs[pairIndex]
      const count = indexPairs[pairIndex + 1]
      for (let index = 0; index < count; index += 1) {
        if (cursor + rowLength > data.length) break
        const fields = []
        for (const width of widths) {
          let value = 0
          for (let byteIndex = 0; byteIndex < width; byteIndex += 1) {
            value = value * 256 + data[cursor]
            cursor += 1
          }
          fields.push(value)
        }
        const type = widths[0] === 0 ? 1 : fields[0]
        const num = start + index
        if (this.entries.has(num)) continue
        if (type === 1) this.entries.set(num, { type: 1, offset: fields[1] })
        else if (type === 2) this.entries.set(num, { type: 2, stream: fields[1], index: fields[2] })
      }
    }
    this.trailers.push(dict)
    return dict
  }

  /** xref 坏了就全文件扫 `N G obj`：下载站弄坏的 PDF 十有八九能靠这一步救回来。 */
  scanObjects() {
    const text = this.buf.toString('latin1')
    const pattern = /(?:^|[\s>\]])(\d{1,10})\s+(\d{1,5})\s+obj\b/g
    let match = pattern.exec(text)
    while (match !== null) {
      const num = Number(match[1])
      const offset = match.index + (match[0].length - `${match[1]} ${match[2]} obj`.length)
      // 增量更新会让同一 num 出现多次，后面的定义更新，直接覆盖
      this.entries.set(num, { type: 1, offset })
      match = pattern.exec(text)
    }
    // trailer 也可能是坏的：从文件尾部捞 /Root
    const tailText = text.slice(Math.max(0, text.length - 8192))
    const rootMatch = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(tailText)
    if (rootMatch) {
      const dict = new Map([['Root', { t: 'ref', n: Number(rootMatch[1]), g: Number(rootMatch[2]) }]])
      this.trailers.unshift(dict)
    }
    if (this.trailers.length === 0) this.trailers.push(new Map())
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num)
    // 先占位：环引用时不能无限递归
    this.cache.set(num, null)
    const entry = this.entries.get(num)
    let value = null
    if (entry) {
      if (entry.type === 1) {
        const parsed = parseIndirectObjectAt(this.buf, entry.offset)
        value = parsed ? parsed.value : null
      } else if (entry.type === 2) {
        value = this.readCompressedObject(entry.stream, entry.index, num)
      }
    }
    this.cache.set(num, value)
    return value
  }

  readCompressedObject(streamNum, index, wantedNum) {
    let table = this.objectStreams.get(streamNum)
    if (!table) {
      const streamValue = this.get(streamNum)
      if (!streamValue || streamValue.t !== 'stream') {
        this.objectStreams.set(streamNum, null)
        return null
      }
      const data = this.stream(streamValue)
      if (!data) {
        this.objectStreams.set(streamNum, null)
        return null
      }
      const dict = streamValue.dict
      const count = typeof dictGet(dict, 'N') === 'number' ? dictGet(dict, 'N') : 0
      const first = typeof dictGet(dict, 'First') === 'number' ? dictGet(dict, 'First') : 0
      const pairs = []
      let cursor = 0
      for (let i = 0; i < count; i += 1) {
        const numRead = readNumberToken(data, skipSpace(data, cursor))
        if (numRead.value === null) break
        const offsetRead = readNumberToken(data, skipSpace(data, numRead.next))
        if (offsetRead.value === null) break
        pairs.push({ num: Math.trunc(numRead.value), offset: Math.trunc(offsetRead.value) })
        cursor = offsetRead.next
      }
      table = { data, first, pairs }
      this.objectStreams.set(streamNum, table)
    }
    if (!table) return null
    const target = table.pairs.find((pair) => pair.num === wantedNum) ?? table.pairs[index]
    if (!target) return null
    const parsed = parseValue(table.data, table.first + target.offset)
    return parsed.value
  }

  resolve(value, depth = 0) {
    let current = value
    let guard = 0
    while (current && current.t === 'ref' && guard < 32) {
      current = this.get(current.n)
      guard += 1
    }
    if (depth > MAX_DEPTH) return null
    return current ?? null
  }

  rawStreamBytes(streamValue) {
    return this.buf.subarray(streamValue.start, streamValue.end)
  }

  stream(value) {
    const resolved = this.resolve(value)
    if (!resolved || resolved.t !== 'stream') return null
    if (resolved.decoded !== undefined) return resolved.decoded
    const raw = this.rawStreamBytes(resolved)
    const data = applyFilters(raw, resolved.dict, (item) => this.resolve(item))
    resolved.decoded = data
    return data
  }

  /** 取文档信息字典里的书名 / 作者。 */
  info() {
    const infoValue = this.resolve(this.trailer().get('Info'))
    if (!infoValue || typeof infoValue.get !== 'function') return { title: '', author: '' }
    const title = decodeDocString(this.resolve(dictGet(infoValue, 'Title'))).replace(/\0/g, '').trim()
    const author = decodeDocString(this.resolve(dictGet(infoValue, 'Author'))).replace(/\0/g, '').trim()
    return { title, author }
  }

  /** 目录树 → 页面数组（含继承来的 /Resources）。 */
  pages() {
    if (this.pageList) return this.pageList
    const root = this.resolve(this.trailer().get('Root'))
    let pagesRef = root && typeof root.get === 'function' ? dictGet(root, 'Pages') : null
    if (!pagesRef) {
      // 有些文件的 trailer /Root 丢了：找一个 /Type /Catalog 的对象顶上
      for (const num of this.entries.keys()) {
        const candidate = this.get(num)
        if (candidate && typeof candidate.get === 'function' && nameOf(dictGet(candidate, 'Type')) === 'Catalog') {
          pagesRef = dictGet(candidate, 'Pages')
          if (pagesRef) break
        }
      }
    }
    const pages = []
    const visit = (nodeRef, inherited, depth) => {
      if (depth > MAX_DEPTH || pages.length >= MAX_PAGES) return
      const node = this.resolve(nodeRef)
      if (!node || typeof node.get !== 'function') return
      const type = nameOf(dictGet(node, 'Type'))
      const resources = dictGet(node, 'Resources') ?? inherited
      if (type === 'Page') {
        pages.push({ dict: node, resources })
        return
      }
      const kids = this.resolve(dictGet(node, 'Kids'))
      if (Array.isArray(kids)) {
        for (const kid of kids) visit(kid, resources, depth + 1)
      } else if (type !== 'Pages') {
        // 没有 /Type 但结构像页面：直接当页面收下，比丢页好
        if (dictGet(node, 'Contents') !== undefined) pages.push({ dict: node, resources })
      }
    }
    visit(pagesRef, null, 0)
    this.pageList = pages
    return pages
  }

  /** 一页的所有内容流拼起来（可能是数组，也可能是一个）。 */
  pageContent(page) {
    const contents = this.resolve(dictGet(page.dict, 'Contents'))
    const chunks = []
    const pushOne = (value) => {
      const streamValue = this.resolve(value)
      if (!streamValue || streamValue.t !== 'stream') return
      const data = this.stream(streamValue)
      if (data) chunks.push(data)
    }
    if (Array.isArray(contents)) {
      for (const item of contents) pushOne(item)
    } else if (contents) {
      pushOne(contents)
    }
    if (chunks.length === 0) return null
    if (chunks.length === 1) return chunks[0]
    return Buffer.concat(chunks.flatMap((chunk, index) => (index === 0 ? [chunk] : [Buffer.from('\n'), chunk])))
  }
}

/* ------------------------------------------------------------------ *
 * 文字 → 章节
 * ------------------------------------------------------------------ */

/**
 * 抽出一本 PDF 的文字。
 *
 * @param {Buffer} buf
 * @returns {{ info: { title: string, author: string }, pages: Array<{ page: number, paragraphs: string[] }>, chars: number, unmapped: number, failedPages: number }}
 */
export function extractPdfText(buf) {
  const doc = new PdfDocument(buf)
  doc.load()
  const pages = doc.pages()
  if (pages.length === 0) {
    throw fail('E_PDF_NO_PAGES', '这本 PDF 里找不到可以读的页面。', { detail: 'page tree empty' })
  }

  const results = []
  let chars = 0
  let unmapped = 0
  let failedPages = 0

  for (let index = 0; index < pages.length && index < MAX_PAGES; index += 1) {
    const page = pages[index]
    let text = ''
    try {
      const content = doc.pageContent(page)
      if (content && content.length > 0) {
        const extracted = extractPageText(doc, content, doc.resolve(page.resources))
        text = extracted.text
        chars += extracted.chars
        unmapped += extracted.unmapped
      }
    } catch {
      failedPages += 1
    }
    // 排查用：设了 DSH_READING_PDF_TRACE 就把每页的原始文字打到 stderr，
    // 不设则一行开销都没有。
    if (process.env.DSH_READING_PDF_TRACE && text !== '') {
      console.error(`[pdf] page ${index + 1} raw: ${JSON.stringify(text.slice(0, 400))}`)
    }
    const lines = text.split('\n')
    results.push({ page: index + 1, paragraphs: linesToParagraphs(lines) })
  }

  const usablePages = results.filter((item) => item.paragraphs.length > 0).length
  if (chars === 0) {
    throw fail(
      'E_PDF_NO_TEXT',
      '这本 PDF 里读不到文字——多半是扫描件（整页是图片）。目前只能读文字版 PDF。',
      { detail: `pages=${results.length} chars=0 unmapped=${unmapped} failed=${failedPages}` },
    )
  }
  if (usablePages === 0) {
    throw fail('E_PDF_NO_TEXT', '这本 PDF 里有文字层，但一页也没能还原出来。换一本再试。', {
      detail: `chars=${chars} unmapped=${unmapped} failed=${failedPages}`,
    })
  }

  const info = doc.info()
  return { info, pages: results, chars, unmapped, failedPages }
}

/**
 * 把页按「章标题」或「页段」切成章节。
 *
 * 章标题认法与 TXT 共用 `isHeadingLine`：短、且以「第 X 章 / Chapter N / 卷一」这类形式开头。
 * 一页正文里认出 ≥2 条才算有目录；否则按 8 页一段合并，目录留空（不伪造章节跳转）。
 */
export function chaptersFromPages(pages) {
  /** @type {Array<{ label: string, paragraphs: string[], page: number }>} */
  const chapters = []
  let current = null

  for (const item of pages) {
    for (const paragraph of item.paragraphs) {
      const trimmed = paragraph.trim()
      const looksLikeHeading = trimmed.length > 0 && trimmed.length <= 60 && isHeadingLine(trimmed)
      if (looksLikeHeading) {
        current = { label: trimmed, paragraphs: [], page: item.page }
        chapters.push(current)
        continue
      }
      if (!current) {
        current = { label: '', paragraphs: [], page: item.page }
        chapters.push(current)
      }
      current.paragraphs.push(trimmed)
    }
  }

  const headingCount = chapters.filter((chapter) => chapter.label !== '').length
  if (headingCount >= 2) {
    return {
      tocSource: 'auto',
      chapters: chapters
        .filter((chapter) => chapter.paragraphs.length > 0 || chapter.label !== '')
        .map((chapter) => ({
          label: chapter.label === '' ? `第 ${chapter.page} 页` : chapter.label,
          paragraphs: chapter.paragraphs,
        })),
    }
  }

  // 没有真标题：按页段合并，标签写页码区间（对得上纸质页码，比「第 N 部分」有用得多）
  const grouped = []
  for (let index = 0; index < pages.length; index += PAGES_PER_CHAPTER) {
    const slice = pages.slice(index, index + PAGES_PER_CHAPTER)
    const paragraphs = slice.flatMap((item) => item.paragraphs)
    if (paragraphs.length === 0) continue
    const from = slice[0].page
    const to = slice[slice.length - 1].page
    grouped.push({
      label: from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`,
      paragraphs,
    })
  }
  return { tocSource: 'none', chapters: grouped }
}

/**
 * 解析一本 PDF（对外入口，与 `parseEpub` / `parseTxt` 同形）。
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{ filename?: string, deviceId?: string, now?: string }} [options]
 */
export function parsePdf(bytes, options = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw fail('E_PDF_INVALID', '这个文件不是完整的 PDF，可能下载时中断了。', {
      detail: `header=${JSON.stringify(buf.subarray(0, 8).toString('latin1'))}`,
    })
  }

  const extracted = extractPdfText(buf)
  const built = chaptersFromPages(extracted.pages)
  if (built.chapters.length === 0) {
    throw fail('E_BOOK_EMPTY', '这本 PDF 里没有读到可以排版的文字。', { detail: 'no chapters' })
  }

  const book = buildReflowedBook({
    chapters: built.chapters,
    title: extracted.info.title,
    author: extracted.info.author,
    format: 'pdf-converted',
    sourceFormat: 'pdf',
    converterVersion: 'pdf/1',
    bytes: buf,
    filename: options.filename,
    deviceId: options.deviceId,
    now: options.now,
    tocSource: built.tocSource,
  })

  // 页段合成的章节不是目录：清空 toc，界面显示「这本书没有目录」。
  if (built.tocSource === 'none') book.toc = []
  book.meta.pdfPages = extracted.pages.length
  if (extracted.unmapped > 0) book.meta.pdfUnmappedGlyphs = extracted.unmapped
  return book
}
