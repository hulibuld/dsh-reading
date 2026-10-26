/**
 * MOBI / AZW3（KF8）纯文字解析。
 *
 * 这里只做一件事：把 MOBI 家族的文件字节变成「书名 + 作者 + 章节段落 + 封面」。
 * 除封面之外，图片、内嵌字体、原始版式全部丢弃，正文只保留文字和最小实体解码。
 *
 * 支持的压缩方式：
 *   - 1：不压缩
 *   - 2：PalmDOC LZ77
 *   - 17480：HUFF/CDIC（亚马逊 AZW 常用；个别工具会把 deflate 数据也标成 17480，
 *     所以先试 zlib inflate，失败再按 HUFF 解）
 *
 * 失败时一律抛 AppError，错误码只有三种：
 *   - E_MOBI_MALFORMED：不是 MOBI，或头结构、记录表、偏移越界
 *   - E_MOBI_ENCRYPTED：有 DRM
 *   - E_MOBI_UNSUPPORTED：压缩方式不认识，或 KF8 结构拿不到正文
 */

import { inflateSync } from 'node:zlib'

import { fail } from './errors.js'

/** @typedef {{ label: string, paragraphs: string[] }} Chapter */
/** @typedef {{ data: Uint8Array, mediaType: 'image/jpeg'|'image/png'|'image/gif' }} MobiCover */
/** @typedef {{ title: string, author: string, chapters: Chapter[], cover: MobiCover|null }} MobiText */

const E_MALFORMED = 'E_MOBI_MALFORMED'
const E_ENCRYPTED = 'E_MOBI_ENCRYPTED'
const E_UNSUPPORTED = 'E_MOBI_UNSUPPORTED'

const MSG_MALFORMED = '这个文件看起来不是一本 MOBI。'
const MSG_ENCRYPTED = '这本书有 DRM 保护，暂时读不了。'
const MSG_UNSUPPORTED = '这本书用的压缩方式暂时不支持，读不了。'
const MSG_KF8 = '这本书的排版结构暂时读不了。'
const MSG_TOO_BIG = '这本书展开后太大了，暂时读不了。'

/** 解压后的正文上限，防止压缩炸弹。 */
const MAX_OUTPUT = 512 * 1024 * 1024

/** 一章最多保留的段落数；超过就硬切成下一章。 */
const MAX_PARAGRAPHS_PER_CHAPTER = 300

/** HUFF 短语递归展开的最大深度。 */
const MAX_HUFF_DEPTH = 12

/**
 * 封面图上限。超过这个尺寸基本可以断定不是封面，而是被错误索引到的整本插图
 * 或者坏记录；把几百 MB 塞进 HTTP 响应只会拖垮书架。
 */
const MAX_COVER_BYTES = 8 * 1024 * 1024

/** CP1252 在 0x80–0x9F 区间与 Latin-1 不同，这里补上差异部分。 */
const CP1252_HIGH = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
])

/**
 * 造一个「不是 MOBI / 头结构坏了」的错误。
 * @param {string} detail 只进日志的技术细节
 * @returns {Error}
 */
function malformed(detail) {
  return fail(E_MALFORMED, MSG_MALFORMED, { detail })
}

/**
 * 造一个 DRM 错误。
 * @param {string} detail
 * @returns {Error}
 */
function encrypted(detail) {
  return fail(E_ENCRYPTED, MSG_ENCRYPTED, { detail })
}

/**
 * 造一个「暂不支持」的错误。
 * @param {string} message 给读者看的文案
 * @param {string} detail 技术细节
 * @returns {Error}
 */
function unsupported(message, detail) {
  return fail(E_UNSUPPORTED, message, { detail })
}

/**
 * 把调用方给的字节统一成 Buffer，并拒绝明显不是字节数组的输入。
 * @param {Uint8Array|Buffer} bytes
 * @returns {Buffer}
 */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  throw malformed(`输入不是 Uint8Array 或 Buffer：${typeof bytes}`)
}

/**
 * 读大端 u16，并做越界检查。
 * @param {Buffer} buf
 * @param {number} offset
 * @param {string} label
 * @returns {number}
 */
function readU16(buf, offset, label) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > buf.length) {
    throw malformed(`${label} 越界：offset=${offset}, length=${buf.length}`)
  }
  return buf.readUInt16BE(offset)
}

/**
 * 读大端 u32，并做越界检查。
 * @param {Buffer} buf
 * @param {number} offset
 * @param {string} label
 * @returns {number}
 */
function readU32(buf, offset, label) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > buf.length) {
    throw malformed(`${label} 越界：offset=${offset}, length=${buf.length}`)
  }
  return buf.readUInt32BE(offset)
}

/**
 * 读一段 Latin-1 字符串（fourcc 之类）。
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} length
 * @param {string} label
 * @returns {string}
 */
function readAscii(buf, offset, length, label) {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > buf.length) {
    throw malformed(`${label} 越界：offset=${offset}, length=${length}, total=${buf.length}`)
  }
  return buf.toString('latin1', offset, offset + length)
}

/**
 * 如果字段落在 MOBI 头范围内就读，否则返回默认值。
 * @param {Buffer} buf 记录 0
 * @param {number} absolute 相对记录 0 的绝对偏移
 * @param {number} headerEnd MOBI 头结束位置
 * @param {number} fallback
 * @returns {number}
 */
function headerU32(buf, absolute, headerEnd, fallback) {
  if (absolute + 4 > headerEnd) return fallback
  return readU32(buf, absolute, 'MOBI 头字段')
}

/**
 * 把字节按声明的编码解成字符串。
 * @param {Buffer} buf
 * @param {number} encoding 1252 或 65001
 * @returns {string}
 */
function decodeText(buf, encoding) {
  let text
  if (encoding === 1252) {
    let out = ''
    for (const byte of buf) out += String.fromCharCode(CP1252_HIGH.get(byte) ?? byte)
    text = out
  } else {
    // 65001 是 UTF-8；遇到未知编码也按 UTF-8 兜底，避免整本书变成乱码。
    text = buf.toString('utf8')
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 解析 PalmDB 头与记录表。
 * @param {Buffer} buf
 * @returns {{ records: Buffer[], numRecords: number }}
 */
function readPalmDb(buf) {
  if (buf.length < 78) throw malformed(`文件只有 ${buf.length} 字节，不够 PalmDB 头`)

  const type = readAscii(buf, 60, 4, 'PalmDB type')
  const creator = readAscii(buf, 64, 4, 'PalmDB creator')
  const isBook = type === 'BOOK' || creator === 'MOBI' || (type === 'TEXt' && creator === 'REAd')
  if (!isBook) throw malformed(`PalmDB 类型不是电子书：type=${type}, creator=${creator}`)

  const numRecords = readU16(buf, 76, 'PalmDB 记录数')
  if (numRecords === 0) throw malformed('PalmDB 记录数为 0')

  const tableEnd = 78 + numRecords * 8
  if (tableEnd > buf.length) throw malformed(`记录表越界：需要 ${tableEnd} 字节，文件只有 ${buf.length} 字节`)

  const offsets = new Array(numRecords)
  for (let i = 0; i < numRecords; i += 1) {
    const offset = readU32(buf, 78 + i * 8, `第 ${i} 条记录偏移`)
    if (offset < tableEnd || offset > buf.length) {
      throw malformed(`第 ${i} 条记录偏移不合理：${offset}`)
    }
    if (i > 0 && offset < offsets[i - 1]) {
      throw malformed(`记录偏移不是递增的：第 ${i - 1} 条 ${offsets[i - 1]}，第 ${i} 条 ${offset}`)
    }
    offsets[i] = offset
  }

  const records = new Array(numRecords)
  for (let i = 0; i < numRecords; i += 1) {
    // 末尾常有对齐填充，按「下一条记录的 offset」截断。
    const end = i + 1 < numRecords ? offsets[i + 1] : buf.length
    if (end < offsets[i]) throw malformed(`第 ${i} 条记录长度为负`)
    records[i] = buf.subarray(offsets[i], end)
  }

  return { records, numRecords }
}

/**
 * 解析 EXTH 头。
 * @param {Buffer} rec 记录 0
 * @param {number} offset EXTH 起始位置
 * @param {number} end 记录 0 的长度
 * @returns {Map<number, Buffer[]>}
 */
function parseExth(rec, offset, end) {
  if (offset + 12 > end) throw malformed(`EXTH 头越界：offset=${offset}, end=${end}`)
  if (readAscii(rec, offset, 4, 'EXTH magic') !== 'EXTH') throw malformed('EXTH magic 不是 EXTH')

  const length = readU32(rec, offset + 4, 'EXTH 长度')
  const count = readU32(rec, offset + 8, 'EXTH 记录数')
  if (length < 12 || offset + length > end) {
    throw malformed(`EXTH 长度不合理：${length}`)
  }
  if (count > Math.floor((length - 12) / 8)) {
    throw malformed(`EXTH 记录数不合理：${count}`)
  }

  const map = new Map()
  let pos = offset + 12
  const stop = offset + length
  for (let i = 0; i < count; i += 1) {
    if (pos + 8 > stop) throw malformed(`第 ${i} 条 EXTH 记录越界`)
    const type = readU32(rec, pos, 'EXTH 类型')
    const size = readU32(rec, pos + 4, 'EXTH 记录长度')
    if (size < 8 || pos + size > stop) {
      throw malformed(`第 ${i} 条 EXTH 记录长度不合理：${size}`)
    }
    const data = rec.subarray(pos + 8, pos + size)
    if (!map.has(type)) map.set(type, [])
    map.get(type).push(data)
    pos += size
  }
  return map
}

/**
 * 取第一条非空的 EXTH 文本。
 * @param {Map<number, Buffer[]>} exth
 * @param {number} type
 * @param {number} encoding
 * @returns {string}
 */
function exthText(exth, type, encoding) {
  const values = exth.get(type)
  if (!values) return ''
  for (const value of values) {
    const text = decodeText(value, encoding).replace(/\u0000/g, '').trim()
    if (text) return text
  }
  return ''
}

/**
 * 取某个 EXTH 类型的全部非空文本（用于多作者）。
 * @param {Map<number, Buffer[]>} exth
 * @param {number} type
 * @param {number} encoding
 * @returns {string[]}
 */
function exthTexts(exth, type, encoding) {
  const values = exth.get(type)
  if (!values) return []
  const out = []
  for (const value of values) {
    const text = decodeText(value, encoding).replace(/\u0000/g, '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * 解析一条 MOBI 头记录（MOBI6 或 KF8 的头部记录）。
 * @param {Buffer[]} records
 * @param {number} index 头部记录号
 * @param {number} numRecords
 * @returns {object}
 */
function parseMobiSection(records, index, numRecords) {
  if (index < 0 || index >= numRecords) {
    throw malformed(`头部记录号越界：${index}/${numRecords}`)
  }
  const rec = records[index]
  if (!rec || rec.length < 0x84) {
    throw malformed(`第 ${index} 条记录太短，放不下 MOBI 头：${rec ? rec.length : 0} 字节`)
  }

  const compression = readU16(rec, 0, '压缩方式')
  const textLength = readU32(rec, 4, '正文长度')
  const recordCount = readU16(rec, 8, '正文记录数')
  const recordSize = readU16(rec, 10, '正文记录大小')
  const encryptionType = readU16(rec, 12, '加密类型')

  if (readAscii(rec, 16, 4, 'MOBI magic') !== 'MOBI') throw malformed('MOBI 头 magic 不是 MOBI')

  const headerLength = readU32(rec, 20, 'MOBI 头长度')
  if (headerLength < 0x18) throw malformed(`MOBI 头长度太小：${headerLength}`)
  const headerEnd = 16 + headerLength
  if (headerEnd > rec.length) {
    throw malformed(`MOBI 头长度超出记录 0：${headerLength}，记录只有 ${rec.length} 字节`)
  }

  const mobiType = readU32(rec, 24, 'MOBI 类型')
  const textEncoding = readU32(rec, 28, '文字编码')
  const version = readU32(rec, 36, 'MOBI 版本')

  const fullNameOffset = headerU32(rec, 0x54, headerEnd, 0)
  const fullNameLength = headerU32(rec, 0x58, headerEnd, 0)
  let fullName = ''
  if (fullNameLength > 0) {
    if (fullNameOffset < 16 || fullNameOffset + fullNameLength > rec.length) {
      throw malformed(`书名偏移越界：offset=${fullNameOffset}, length=${fullNameLength}`)
    }
    fullName = decodeText(rec.subarray(fullNameOffset, fullNameOffset + fullNameLength), textEncoding)
      .replace(/\u0000/g, '')
      .trim()
  }

  const exthFlags = headerU32(rec, 0x80, headerEnd, 0)
  let exth = new Map()
  if ((exthFlags & 0x40) !== 0) {
    exth = parseExth(rec, headerEnd, rec.length)
  }

  const minVersion = headerU32(rec, 0x68, headerEnd, 0)
  const firstImageIndex = headerU32(rec, 0x6c, headerEnd, 0xffffffff)
  const huffOffset = headerU32(rec, 0x70, headerEnd, 0)
  const huffCount = headerU32(rec, 0x74, headerEnd, 0)
  const drmOffset = headerU32(rec, 0xa8, headerEnd, 0xffffffff)
  const drmCount = headerU32(rec, 0xac, headerEnd, 0xffffffff)
  const drmSize = headerU32(rec, 0xb0, headerEnd, 0)
  const trailingFlags = headerEnd >= 0xf4 ? readU16(rec, 0xf2, '尾部数据标志') : 0

  return {
    index,
    rec,
    compression,
    textLength,
    recordCount,
    recordSize,
    encryptionType,
    headerLength,
    headerEnd,
    mobiType,
    textEncoding,
    version,
    minVersion,
    firstImageIndex,
    fullName,
    exth,
    huffOffset,
    huffCount,
    drmOffset,
    drmCount,
    drmSize,
    trailingFlags,
  }
}

/**
 * 检查一条头部记录是否声明了 DRM。
 * @param {object} header
 * @param {string} label
 */
function checkEncrypted(header, label) {
  if (header.encryptionType !== 0) {
    throw encrypted(`${label} 的 encryptionType=${header.encryptionType}`)
  }

  // DRM 偏移不是 0xFFFFFFFF，且确实带了 DRM 条目，就认为加密。
  if (
    header.drmOffset !== 0xffffffff &&
    header.drmOffset !== 0 &&
    ((header.drmCount > 0 && header.drmCount !== 0xffffffff) || header.drmSize > 0)
  ) {
    throw encrypted(
      `${label} 带 DRM 信息：offset=${header.drmOffset}, count=${header.drmCount}, size=${header.drmSize}`,
    )
  }

  // EXTH 405 是租借标记，406 是租借到期时间。带这两项的书按受保护内容处理。
  if (header.exth.has(405)) {
    const flag = header.exth.get(405)[0]
    if (flag && flag.length > 0 && flag[0] === 1) {
      throw encrypted(`${label} 的 EXTH 405 声明为租借书`)
    }
  }
  if (header.exth.has(406)) {
    throw encrypted(`${label} 的 EXTH 406 带租借到期时间，按受保护内容处理`)
  }
}

/**
 * 读 EXTH 121（KF8 边界记录号）；没有就返回 null。
 * @param {Map<number, Buffer[]>} exth
 * @returns {number|null}
 */
function kf8Boundary(exth) {
  const values = exth.get(121)
  if (!values || values.length === 0) return null
  const value = values[0]
  if (value.length < 4) throw malformed(`EXTH 121 长度不足：${value.length}`)
  return readU32(value, 0, 'EXTH 121')
}

/**
 * 读一个 EXTH 整数字段（4 字节大端）；缺字段或长度不足返回 null。
 * @param {Map<number, Buffer[]>} exth
 * @param {number} type
 * @returns {number|null}
 */
function exthU32(exth, type) {
  const values = exth.get(type)
  if (!values || values.length === 0) return null
  const value = values[0]
  if (!value || value.length < 4) return null
  return readU32(value, 0, `EXTH ${type}`)
}

/**
 * 按文件头魔数判断一条记录是不是图片。
 *
 * 只看起始几个字节：有些 MOBI 会把 FLIS/FCIS 之类的尾部数据拼在 JPEG 记录后面，
 * 那不是我们要处理的异常，整条返回即可，不做裁剪。
 *
 * @param {Buffer} record
 * @returns {'image/jpeg'|'image/png'|'image/gif'|null}
 */
function sniffImageType(record) {
  if (!record || record.length < 4) return null

  if (record[0] === 0xff && record[1] === 0xd8 && record[2] === 0xff) return 'image/jpeg'

  if (
    record.length >= 8 &&
    record[0] === 0x89 &&
    record[1] === 0x50 &&
    record[2] === 0x4e &&
    record[3] === 0x47 &&
    record[4] === 0x0d &&
    record[5] === 0x0a &&
    record[6] === 0x1a &&
    record[7] === 0x0a
  ) {
    return 'image/png'
  }

  if (record[0] === 0x47 && record[1] === 0x49 && record[2] === 0x46 && record[3] === 0x38) {
    return 'image/gif'
  }

  return null
}

/**
 * 把一条记录变成封面候选；不是图片、空记录或超过上限都返回 null。
 * @param {Buffer} record
 * @returns {MobiCover|null}
 */
function coverFromRecord(record) {
  const mediaType = sniffImageType(record)
  if (!mediaType) return null
  if (record.length > MAX_COVER_BYTES) return null
  return { data: record, mediaType }
}

/**
 * 在一条 MOBI 头（MOBI6 或 KF8）对应的那一半里找封面。
 *
 * 先认 EXTH 201（coverOffset）：封面记录下标 = firstImageIndex + coverOffset。
 * 201 缺失、越界或指到的不是图片时，从 firstImageIndex 起逐条扫魔数。
 *
 * @param {Buffer[]} records
 * @param {number} numRecords
 * @param {object} header parseMobiSection() 的结果
 * @returns {MobiCover|null}
 */
function coverForSection(records, numRecords, header) {
  const firstImageIndex = header.firstImageIndex
  // 1 以下视为「没有图片」：0 是未写字段的默认值，0xFFFFFFFF 是明确的空标记。
  if (!Number.isInteger(firstImageIndex) || firstImageIndex < 1 || firstImageIndex >= numRecords) {
    return null
  }

  const coverOffset = exthU32(header.exth, 201)
  if (coverOffset !== null && coverOffset !== 0xffffffff) {
    const index = firstImageIndex + coverOffset
    if (index >= 0 && index < numRecords) {
      const cover = coverFromRecord(records[index])
      if (cover) return cover
    }
  }

  // 201 不可用时按魔数扫。跳过空的与不是图片的记录；第一条像图片的就是封面。
  for (let i = firstImageIndex; i < numRecords; i += 1) {
    const record = records[i]
    const mediaType = sniffImageType(record)
    if (!mediaType) continue
    // 大图保护：宁可没有封面，也不把异常大的内存数据带进响应。
    if (record.length > MAX_COVER_BYTES) return null
    return { data: record, mediaType }
  }

  return null
}

/**
 * 从 MOBI / AZW3 文件里抽封面图。
 *
 * 双格式（MOBI6 + KF8）文件以 **EXTH 121 边界之前那一半**（MOBI6 头）为主：
 * 实测样本里它的 firstImageIndex 才指向共享的图片记录区，KF8 头的同名字段
 * 常指到文本记录。主半区找不到时再回退到 KF8 半区，两边都找不到才返回 null。
 *
 * 封面不是书的必要部分：任何结构问题（不是 MOBI、偏移越界、魔数不符）
 * 都按「没有封面」处理，绝不抛错——正文解析该报的错照旧。
 *
 * @param {Uint8Array|Buffer} bytes 文件字节
 * @returns {MobiCover|null}
 */
export function extractCover(bytes) {
  try {
    const buf = toBuffer(bytes)
    const { records, numRecords } = readPalmDb(buf)
    const base = parseMobiSection(records, 0, numRecords)

    /** @type {object[]} */
    const sections = [base]

    let boundary = null
    try {
      boundary = kf8Boundary(base.exth)
    } catch {
      // EXTH 121 本身坏了也不影响从 MOBI6 头找封面。
      boundary = null
    }
    if (boundary !== null && boundary > 0 && boundary < numRecords) {
      try {
        const kf8 = parseMobiSection(records, boundary, numRecords)
        if (kf8 !== base) sections.push(kf8)
      } catch {
        // KF8 头坏了就只看 MOBI6 那一半。
      }
    }

    for (const section of sections) {
      const cover = coverForSection(records, numRecords, section)
      if (cover) return cover
    }
    return null
  } catch {
    return null
  }
}

/**
 * 简单可增长的字节写入器，带输出上限。
 */
class ByteWriter {
  /**
   * @param {number} limit 允许写入的最大字节数
   */
  constructor(limit) {
    this.limit = Math.max(0, limit)
    this.buf = Buffer.alloc(Math.min(this.limit || 0, 4096))
    this.length = 0
  }

  /** @param {number} extra */
  grow(extra) {
    const need = this.length + extra
    if (need > this.limit) throw unsupported(MSG_TOO_BIG, `解压输出超过 ${MAX_OUTPUT} 字节`)
    let size = this.buf.length || 1
    while (size < need) size *= 2
    const next = Buffer.alloc(Math.min(size, this.limit))
    this.buf.copy(next, 0, 0, this.length)
    this.buf = next
  }

  /** @param {number} byte */
  push(byte) {
    if (this.length + 1 > this.limit) throw unsupported(MSG_TOO_BIG, `解压输出超过 ${MAX_OUTPUT} 字节`)
    if (this.length === this.buf.length) this.grow(1)
    this.buf[this.length] = byte
    this.length += 1
  }

  /**
   * @param {Buffer} src
   * @param {number} offset
   * @param {number} length
   */
  pushBytes(src, offset, length) {
    if (this.length + length > this.limit) {
      throw unsupported(MSG_TOO_BIG, `解压输出超过 ${MAX_OUTPUT} 字节`)
    }
    if (this.length + length > this.buf.length) this.grow(length)
    src.copy(this.buf, this.length, offset, offset + length)
    this.length += length
  }

  /** @param {number} index */
  at(index) {
    return this.buf[index]
  }

  /** @returns {Buffer} */
  result() {
    return this.buf.subarray(0, this.length)
  }
}

/**
 * PalmDOC LZ77 解压。
 * @param {Buffer} input
 * @param {number} limit
 * @returns {Buffer}
 */
function inflatePalmDoc(input, limit) {
  const out = new ByteWriter(limit)
  let pos = 0

  while (pos < input.length) {
    const code = input[pos]
    pos += 1

    if (code === 0) {
      out.push(0)
    } else if (code <= 8) {
      if (pos + code > input.length) throw malformed(`PalmDOC 字面量越界：需要 ${code} 字节`)
      out.pushBytes(input, pos, code)
      pos += code
    } else if (code <= 0x7f) {
      out.push(code)
    } else if (code >= 0xc0) {
      out.push(0x20)
      out.push(code ^ 0x80)
    } else {
      if (pos >= input.length) throw malformed('PalmDOC 回溯引用缺第二个字节')
      const pair = (code << 8) | input[pos]
      pos += 1
      const distance = (pair >>> 3) & 0x7ff
      const length = (pair & 7) + 3
      if (distance === 0 || distance > out.length) {
        throw malformed(`PalmDOC 回溯距离越界：${distance}，已输出 ${out.length} 字节`)
      }
      for (let i = 0; i < length; i += 1) {
        out.push(out.at(out.length - distance))
      }
    }
  }

  return out.result()
}

/**
 * HUFF/CDIC 的位读取器。
 */
class BitReader {
  /**
   * @param {Buffer} data
   */
  constructor(data) {
    this.data = data
    this.bitPos = 0
    this.remaining = data.length * 8
  }

  /**
   * 偷看接下来的 32 位；不足 32 位时补 0。
   * @returns {number} 0..2^32-1
   */
  peek32() {
    let value = 0
    for (let i = 0; i < 32; i += 1) {
      const bit = this.bitPos + i
      const byte = bit >>> 3
      const digit = byte < this.data.length ? (this.data[byte] >>> (7 - (bit & 7))) & 1 : 0
      value = value * 2 + digit
    }
    return value
  }

  /** @param {number} count */
  skip(count) {
    this.bitPos += count
    this.remaining -= count
  }
}

/**
 * HUFF/CDIC 解压器。
 *
 * 结构参考 MOBI 规范：HUFF 记录里是 256 项一级码表和 32 组 mincode/maxcode，
 * 后续 CDIC 记录里是短语字典；短语条目可以再压缩（flag=0），这里递归展开。
 */
class HuffReader {
  constructor() {
    /** @type {{ codelen: number, term: boolean, maxcode: number }[]} */
    this.dict1 = []
    /** @type {number[]} */
    this.mincode = []
    /** @type {number[]} */
    this.maxcode = []
    /** @type {{ slice: Buffer, flag: boolean, expanded?: Buffer }[]} */
    this.dictionary = []
  }

  /**
   * 读 HUFF 记录。
   * @param {Buffer} buf
   */
  loadHuff(buf) {
    if (buf.length < 12) throw malformed(`HUFF 记录太短：${buf.length}`)
    if (readAscii(buf, 0, 4, 'HUFF magic') !== 'HUFF') throw malformed('HUFF magic 不是 HUFF')

    const off1 = readU32(buf, 4, 'HUFF 一级表偏移')
    const off2 = readU32(buf, 8, 'HUFF 二级表偏移')
    if (off1 + 1024 > buf.length) throw malformed(`HUFF 一级表越界：${off1}`)
    if (off2 + 256 > buf.length) throw malformed(`HUFF 二级表越界：${off2}`)

    this.dict1 = new Array(256)
    for (let i = 0; i < 256; i += 1) {
      const value = readU32(buf, off1 + i * 4, `HUFF 一级表第 ${i} 项`)
      const codelen = value & 0x1f
      const term = (value & 0x80) !== 0
      const rawMax = value >>> 8
      if (codelen === 0 || codelen > 32) throw malformed(`HUFF 码长不合理：${codelen}`)
      if (codelen <= 8 && !term) throw malformed(`HUFF 短码（${codelen} 位）必须是终结项`)
      const maxcode = (rawMax + 1) * 2 ** (32 - codelen) - 1
      if (maxcode > 0xffffffff) throw malformed(`HUFF 一级表码值越界：${maxcode}`)
      this.dict1[i] = { codelen, term, maxcode }
    }

    this.mincode = new Array(33).fill(0)
    this.maxcode = new Array(33).fill(0)
    for (let codelen = 1; codelen <= 32; codelen += 1) {
      const base = off2 + (codelen - 1) * 8
      const minRaw = readU32(buf, base, `HUFF 第 ${codelen} 位 mincode`)
      const maxRaw = readU32(buf, base + 4, `HUFF 第 ${codelen} 位 maxcode`)
      if (minRaw >= 2 ** codelen || maxRaw >= 2 ** codelen) {
        throw malformed(`HUFF 第 ${codelen} 位码值不合理：min=${minRaw}, max=${maxRaw}`)
      }
      this.mincode[codelen] = minRaw * 2 ** (32 - codelen)
      this.maxcode[codelen] = (maxRaw + 1) * 2 ** (32 - codelen) - 1
    }
  }

  /**
   * 读一条 CDIC 记录，把短语追加进字典。
   * @param {Buffer} buf
   */
  loadCdic(buf) {
    if (buf.length < 16) throw malformed(`CDIC 记录太短：${buf.length}`)
    if (readAscii(buf, 0, 4, 'CDIC magic') !== 'CDIC') throw malformed('CDIC magic 不是 CDIC')

    const phrases = readU32(buf, 8, 'CDIC 短语数')
    const bits = readU32(buf, 12, 'CDIC 索引位数')
    if (bits > 22) throw malformed(`CDIC 索引位数不合理：${bits}`)

    const available = phrases - this.dictionary.length
    if (available < 0) throw malformed('CDIC 短语数比已有字典还小')
    const count = Math.min(2 ** bits, available)
    if (this.dictionary.length + count > 1 << 22) {
      throw malformed(`CDIC 字典项过多：${this.dictionary.length + count}`)
    }
    if (16 + count * 2 > buf.length) throw malformed(`CDIC 偏移表越界：需要 ${16 + count * 2} 字节`)

    for (let i = 0; i < count; i += 1) {
      const offset = readU16(buf, 16 + i * 2, `CDIC 第 ${i} 项偏移`)
      const pos = 16 + offset
      if (pos + 2 > buf.length) throw malformed(`CDIC 第 ${i} 项越界：${pos}`)
      const lengthField = readU16(buf, pos, `CDIC 第 ${i} 项长度`)
      const length = lengthField & 0x7fff
      if (pos + 2 + length > buf.length) {
        throw malformed(`CDIC 第 ${i} 项内容越界：offset=${pos}, length=${length}`)
      }
      this.dictionary.push({
        slice: buf.subarray(pos + 2, pos + 2 + length),
        flag: (lengthField & 0x8000) !== 0,
      })
    }
  }

  /**
   * 解压一段 HUFF 数据。
   * @param {Buffer} data
   * @param {number} budget 本次允许输出的最大字节数
   * @param {number} [depth]
   * @returns {Buffer}
   */
  unpack(data, budget, depth = 0) {
    if (depth > MAX_HUFF_DEPTH) throw malformed(`HUFF 短语递归超过 ${MAX_HUFF_DEPTH} 层`)
    if (this.dict1.length === 0) throw malformed('HUFF 码表尚未加载')

    const reader = new BitReader(data)
    const parts = []
    let total = 0

    while (reader.remaining > 0) {
      const code = reader.peek32()
      const entry = this.dict1[code >>> 24]
      if (!entry) throw malformed('HUFF 一级表缺少对应项')

      let codelen = entry.codelen
      let maxcode = entry.maxcode
      if (!entry.term) {
        while (codelen <= 32 && code < this.mincode[codelen]) codelen += 1
        if (codelen > 32) throw malformed('HUFF 找不到合适的码长')
        maxcode = this.maxcode[codelen]
      }

      if (codelen > reader.remaining) break
      reader.skip(codelen)

      const diff = maxcode - code
      if (diff < 0) throw malformed(`HUFF 码值超出表范围：code=${code}, maxcode=${maxcode}`)
      const index = diff >>> (32 - codelen)
      const phrase = this.dictionary[index]
      if (!phrase) throw malformed(`HUFF 字典下标越界：${index}/${this.dictionary.length}`)

      let bytes = phrase.slice
      if (!phrase.flag) {
        if (!phrase.expanded) {
          phrase.expanded = this.unpack(phrase.slice, budget, depth + 1)
          phrase.flag = true
        }
        bytes = phrase.expanded
      }

      total += bytes.length
      if (total > budget) throw unsupported(MSG_TOO_BIG, `HUFF 输出超过 ${MAX_OUTPUT} 字节`)
      parts.push(bytes)
    }

    return Buffer.concat(parts, total)
  }
}

/**
 * 按尾部数据标志裁掉每条正文记录末尾的附加数据。
 * @param {Buffer} record
 * @param {boolean} multibyte
 * @param {number} trailers
 * @returns {Buffer}
 */
function trimTrailingData(record, multibyte, trailers) {
  let data = record

  for (let i = 0; i < trailers; i += 1) {
    if (data.length < 4) throw malformed('正文记录太短，放不下尾部数据长度')
    let size = 0
    for (let j = data.length - 4; j < data.length; j += 1) {
      if ((data[j] & 0x80) !== 0) size = 0
      size = (size << 7) | (data[j] & 0x7f)
    }
    if (size <= 0 || size > data.length) {
      throw malformed(`尾部数据长度不合理：${size}`)
    }
    data = data.subarray(0, data.length - size)
  }

  if (multibyte && data.length > 0) {
    const size = (data[data.length - 1] & 3) + 1
    if (size > data.length) throw malformed(`多字节重叠长度不合理：${size}`)
    data = data.subarray(0, data.length - size)
  }

  return data
}

/**
 * 解压整个正文区，返回原始 HTML 字节。
 * @param {Buffer[]} records
 * @param {object} header
 * @returns {Buffer}
 */
function decompressSection(records, header) {
  const { compression, recordCount } = header
  if (compression !== 1 && compression !== 2 && compression !== 17480) {
    throw unsupported(MSG_UNSUPPORTED, `未知压缩方式：${compression}`)
  }
  if (recordCount === 0) {
    throw unsupported(MSG_KF8, '正文记录数为 0')
  }
  if (header.textLength > MAX_OUTPUT) {
    throw unsupported(MSG_TOO_BIG, `声明的正文长度超过上限：${header.textLength}`)
  }

  const start = header.index + 1
  if (start + recordCount > records.length) {
    throw malformed(`正文记录越界：需要 ${start + recordCount} 条，文件只有 ${records.length} 条`)
  }

  let huff = null
  const huffReader = () => {
    if (huff) return huff
    if (header.huffOffset <= 0 || header.huffCount <= 0) {
      throw malformed(`HUFF 记录偏移无效：offset=${header.huffOffset}, count=${header.huffCount}`)
    }
    const huffStart = header.index + header.huffOffset
    if (huffStart + header.huffCount > records.length) {
      throw malformed(`HUFF 记录越界：${huffStart}+${header.huffCount}/${records.length}`)
    }
    huff = new HuffReader()
    huff.loadHuff(records[huffStart])
    for (let i = 1; i < header.huffCount; i += 1) {
      huff.loadCdic(records[huffStart + i])
    }
    return huff
  }

  let multibyte = false
  let trailers = 0
  if (header.trailingFlags !== 0 && header.minVersion >= 5) {
    multibyte = (header.trailingFlags & 1) !== 0
    let flags = header.trailingFlags >>> 1
    while (flags > 0) {
      if ((flags & 1) !== 0) trailers += 1
      flags >>>= 1
    }
  }

  const chunks = []
  let total = 0
  for (let i = 0; i < recordCount; i += 1) {
    const raw = trimTrailingData(records[start + i], multibyte, trailers)
    const remaining = MAX_OUTPUT - total
    let out

    if (compression === 1) {
      out = raw
    } else if (compression === 2) {
      out = inflatePalmDoc(raw, remaining)
    } else {
      try {
        out = inflateSync(raw, { maxOutputLength: Math.max(1, remaining) })
      } catch {
        // 17480 有时候装的其实是 deflate（第三方工具生成），解不开就按 HUFF 再试。
        out = huffReader().unpack(raw, remaining)
      }
    }

    total += out.length
    if (total > MAX_OUTPUT) throw unsupported(MSG_TOO_BIG, `解压输出超过 ${MAX_OUTPUT} 字节`)
    chunks.push(out)
  }

  const text = Buffer.concat(chunks, total)
  if (header.textLength > 0 && header.textLength <= text.length) {
    return text.subarray(0, header.textLength)
  }
  return text
}

/**
 * 解最小 HTML 实体。
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match
      if (code >= 0xd800 && code <= 0xdfff) return match
      return String.fromCodePoint(code)
    }

    switch (body.toLowerCase()) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return '\u00a0'
      default:
        return match
    }
  })
}

/**
 * 把一小段 HTML 压成纯文本。
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
}

/**
 * 取一个章节块里的第一个标题文字。
 * @param {string} chunk
 * @returns {string}
 */
function firstHeading(chunk) {
  const match = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i.exec(chunk)
  return match ? htmlToText(match[1]) : ''
}

/**
 * 从一个章节块里抽段落。
 * @param {string} chunk
 * @returns {string[]}
 */
function extractParagraphs(chunk) {
  let html = chunk
  html = html.replace(/<!--[\s\S]*?-->/g, ' ')
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  html = html.replace(/<br\b[^>]*\/?>/gi, '\n')
  html = html.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)\s*>/gi, '\n')
  html = html.replace(/<(hr|mbp:pagebreak)\b[^>]*\/?>/gi, '\n')

  const paragraphs = []
  for (const part of html.split('\n')) {
    const text = htmlToText(part)
    if (text) paragraphs.push(text)
  }
  return paragraphs
}

/**
 * 在一个模式出现的位置之前切开，保留分隔符本身。
 * @param {string} text
 * @param {RegExp} pattern 必须带 g
 * @returns {string[]}
 */
function splitBefore(text, pattern) {
  const starts = []
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    starts.push(match.index)
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1
  }
  if (starts.length === 0) return [text]

  const parts = []
  if (starts[0] > 0) parts.push(text.slice(0, starts[0]))
  for (let i = 0; i < starts.length; i += 1) {
    parts.push(text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length))
  }
  return parts
}

/**
 * 按优先级把正文切成章节块。
 * @param {string} html
 * @returns {string[]}
 */
function splitChapterChunks(html) {
  if (/<mbp:pagebreak\b/i.test(html)) {
    return html.split(/<mbp:pagebreak\b[^>]*\/?>/gi)
  }

  if (/<h[1-3]\b/i.test(html)) {
    return splitBefore(html, /<h[1-3]\b[^>]*>/gi)
  }

  const anchorPattern = /<a\b[^>]*\bfilepos\s*=/gi
  const anchorCount = (html.match(anchorPattern) ?? []).length
  if (anchorCount >= 2 && anchorCount <= MAX_PARAGRAPHS_PER_CHAPTER) {
    return splitBefore(html, anchorPattern)
  }

  return [html]
}

/**
 * 把正文 HTML 切成章节。
 * @param {string} html
 * @returns {Chapter[]}
 */
function buildChapters(html) {
  const chapters = []
  const chunks = splitChapterChunks(html)

  for (const chunk of chunks) {
    const heading = firstHeading(chunk)
    const paragraphs = extractParagraphs(chunk)
    if (paragraphs.length === 0) continue

    for (let start = 0; start < paragraphs.length; start += MAX_PARAGRAPHS_PER_CHAPTER) {
      const group = paragraphs.slice(start, start + MAX_PARAGRAPHS_PER_CHAPTER)
      // 有 <h1> 就用它；没有就留空串，交给 textbook.deriveChapterLabel 按文字形状
      // 再试一次（Gutenberg 这类书的章名是 `<p><b>CHAPTER I.</b></p>`，抽成纯文本后
      // 只剩普通段落）。两条都落空时由 buildReflowedBook 用「第 N 章」兜底。
      // 这里**不要**先填「第 N 章」：那会让下游误以为已经有标题，不再尝试推导。
      const label = start === 0 ? heading : ''
      chapters.push({ label, paragraphs: group })
    }
  }

  return chapters
}

/**
 * 解析 MOBI / AZW3（KF8）文件，抽出纯文字章节。
 *
 * 只处理文字：图片、字体、原始版式都会被丢弃，唯一保留的图片是封面
 * （见 `extractCover`，失败时 `cover` 为 null，不影响正文）。正文按
 * `<mbp:pagebreak>`、`<h1>`/`<h2>`/`<h3>`、`filepos=` 锚点的优先级切章，
 * 每 300 段硬切一次。
 *
 * 什么时候会失败：
 *   - 不是 MOBI，或 PalmDB 头、记录表、MOBI 头、EXTH 结构损坏、偏移越界
 *     → 抛 `AppError`，code 为 `E_MOBI_MALFORMED`
 *   - encryptionType 非 0，或带 DRM / 租借标记
 *     → 抛 `AppError`，code 为 `E_MOBI_ENCRYPTED`
 *   - 压缩方式不是 1 / 2 / 17480，或 KF8 结构拿不到正文，或解压超过 512 MB
 *     → 抛 `AppError`，code 为 `E_MOBI_UNSUPPORTED`
 *
 * @param {Uint8Array|Buffer} bytes 文件字节
 * @returns {MobiText} 书名、作者、文字章节与封面（没有封面时 cover 为 null）
 * @throws {Error} 由 fail() 抛出的 AppError，code 见上
 */
export function extractMobiText(bytes) {
  const buf = toBuffer(bytes)
  const { records, numRecords } = readPalmDb(buf)

  const base = parseMobiSection(records, 0, numRecords)
  checkEncrypted(base, 'MOBI6')

  const boundary = kf8Boundary(base.exth)
  let section = base

  if (boundary !== null) {
    if (boundary < 1 || boundary >= numRecords) {
      throw unsupported(MSG_KF8, `EXTH 121 指向的记录号越界：${boundary}/${numRecords}`)
    }
    const candidate = records[boundary]
    if (!candidate || candidate.length < 0x30 || readAscii(candidate, 16, 4, 'KF8 magic') !== 'MOBI') {
      throw unsupported(MSG_KF8, `第 ${boundary} 条记录不是 KF8 的 MOBI 头`)
    }
    section = parseMobiSection(records, boundary, numRecords)
    checkEncrypted(section, 'KF8')
  }

  const title =
    exthText(section.exth, 503, section.textEncoding) ||
    section.fullName ||
    exthText(base.exth, 503, base.textEncoding) ||
    base.fullName
  const author =
    exthTexts(section.exth, 100, section.textEncoding).join('、') ||
    exthTexts(base.exth, 100, base.textEncoding).join('、')

  const textBytes = decompressSection(records, section)
  const html = decodeText(textBytes, section.textEncoding)
  const chapters = buildChapters(html)

  return {
    title,
    author,
    chapters,
    // 封面是锦上添花：extractCover 内部吞掉所有结构错误，绝不会让一本能读的书失败。
    cover: extractCover(buf),
  }
}
