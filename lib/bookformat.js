/**
 * 格式分诊层：一份文件字节 → 一种能读的书。
 *
 * 阅读器其余部分只需要「spine + 章节 XHTML + toc」这一套接口，因此这里把
 * EPUB / MOBI(AZW3) / TXT / PDF 四种输入都归一到同一形状（见 docs/05 §2 与 `textbook.js`）。
 * 好处是新增格式只动本文件与一个解析器，store / routes / 客户端一行都不用改。
 *
 * 判定顺序讲究：**先看魔数，再看扩展名**。
 * 扩展名是最不可靠的信息（.txt 改成 .epub 的大有人在），而 ZIP 的 `PK` 与
 * PalmDB 的 `BOOK`+`MOBI` 都在固定偏移上，改不了名。
 *
 * 什么时候会失败、失败给谁看：
 *   - 空的 / 太小的文件 → `E_IMPORT_EMPTY`。
 *   - 认不出格式 → `E_IMPORT_UNKNOWN_FORMAT`（「这个文件不是支持的格式」）。
 *   - 具体解析错误由各解析器抛（`E_EPUB_*` / `E_MOBI_*` / `E_TXT_*`）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fail } from './errors.js'
import { parseEpub } from './epub.js'
import { parseTxt } from './txt.js'

/** 支持的源格式（meta.sourceFormat 的取值）。 */
export const SUPPORTED_FORMATS = Object.freeze(['epub', 'mobi', 'azw3', 'txt'])

/**
 * 按字节判断格式。
 *
 * @param {Uint8Array} bytes
 * @returns {'epub'|'mobi'|'txt'}
 */
export function detectFormat(bytes) {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // ZIP：`PK\x03\x04`（空包是 `PK\x05\x06`，也交给 EPUB 解析器去报更具体的错）。
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return 'epub'
  }

  // PalmDB：偏移 60 是 type（`BOOK` / `TEXt`），64 是 creator（`MOBI` / `READ`）。
  if (buf.length >= 68) {
    const type = buf.subarray(60, 64).toString('latin1')
    const creator = buf.subarray(64, 68).toString('latin1')
    if ((type === 'BOOK' || type === 'TEXt') && (creator === 'MOBI' || creator === 'READ')) {
      return 'mobi'
    }
  }

  // PDF：规范允许文件头前面有杂物，所以在前 1KB 里找 `%PDF-`，不硬卡第 0 字节。
  if (buf.length >= 5) {
    const head = buf.subarray(0, Math.min(1024, buf.length)).toString('latin1')
    if (head.includes('%PDF-')) return 'pdf'
  }

  return 'txt'
}

/**
 * 由文件名推断源格式（只用来区分 mobi / azw3 这种同一解析器下的子类型）。
 *
 * @param {string} filename
 * @param {'epub'|'mobi'|'txt'|'pdf'} detected
 * @returns {'epub'|'mobi'|'azw3'|'txt'|'pdf'}
 */
export function sourceFormatOf(filename, detected) {
  if (detected !== 'mobi') return detected
  const ext = path.extname(String(filename ?? '')).toLowerCase()
  return ext === '.azw3' || ext === '.azw' ? 'azw3' : 'mobi'
}

/**
 * 书 → 落盘扩展名。
 *
 * 用 `sourceFormat` 而不是 `format`：重排书也存回**原扩展名**（`book.txt` /
 * `book.mobi` / `book.azw3`），这样用户去书库目录里翻的时候能一眼看出这是哪来的文件。
 *
 * @param {{ format?: string, sourceFormat?: string }} meta
 * @returns {string}
 */
export function extensionOf(meta) {
  const source = String(meta?.sourceFormat ?? '')
  if (source === 'epub' || source === 'mobi' || source === 'azw3' || source === 'txt' || source === 'pdf') {
    return source
  }
  switch (meta?.format) {
    case 'epub':
      return 'epub'
    case 'mobi-converted':
      return 'mobi'
    case 'txt-converted':
      return 'txt'
    case 'pdf-converted':
      return 'pdf'
    default:
      return 'bin'
  }
}

/** 读 source（路径或字节）成 Buffer。 */
async function loadBytes(source, options) {
  if (typeof source === 'string') {
    try {
      return await fs.readFile(source)
    } catch (error) {
      throw fail('E_BOOK_NO_FILE', '这本书的文件不在了，重新导入试试。', {
        status: 404,
        detail: `read failed: ${String(error && error.message)}`,
        cause: error,
      })
    }
  }
  if (source instanceof Uint8Array) {
    return Buffer.isBuffer(source)
      ? source
      : Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  }
  throw fail('E_IMPORT_UNKNOWN_FORMAT', '没有读到书籍文件，请重新选择一次。', {
    detail: 'unsupported source type',
  })
}

/**
 * 解析任意支持的格式。
 *
 * @param {string|Uint8Array} source 文件路径或文件字节
 * @param {{ filename?: string, deviceId?: string, now?: string }} [options]
 * @returns {Promise<any>} 与 `parseEpub` 同形的书对象
 */
export async function parseBook(source, options = {}) {
  const bytes = await loadBytes(source, options)
  if (bytes.length === 0) {
    throw fail('E_IMPORT_EMPTY', '没有收到书籍文件，请重新选择一次。')
  }

  const format = detectFormat(bytes)
  const filename = options.filename ?? (typeof source === 'string' ? path.basename(source) : '')

  if (format === 'epub') {
    return parseEpub(bytes, { ...options, filename })
  }

  if (format === 'mobi') {
    // 懒加载：MOBI 解析器只在真的导入 MOBI 时才被求值，
    // 这样它内部的 bug 不会连累 EPUB / TXT 的导入路径。
    const { extractMobiText } = await import('./mobi.js')
    const { buildReflowedBook } = await import('./textbook.js')
    const extracted = extractMobiText(bytes)
    return buildReflowedBook({
      chapters: extracted.chapters,
      title: extracted.title,
      author: extracted.author,
      format: 'mobi-converted',
      sourceFormat: sourceFormatOf(filename, 'mobi'),
      converterVersion: 'mobi/1',
      bytes,
      filename,
      deviceId: options.deviceId,
      now: options.now,
      language: extracted.language,
      // 封面可以为 null（没有封面、或抽不出来），重排书自己会再兜一层。
      cover: extracted.cover,
    })
  }

  if (format === 'pdf') {
    // 同样是懒加载：PDF 解析器只在真导入 PDF 时才被求值。
    const { parsePdf } = await import('./pdf.js')
    return parsePdf(bytes, { filename, deviceId: options.deviceId, now: options.now })
  }

  return parseTxt(bytes, { filename, deviceId: options.deviceId, now: options.now })
}
