/**
 * 纯文本（.txt）书的解析：解码 → 切章 → 重排成 XHTML。
 *
 * 三件难事，各自的做法：
 *
 * 1. **编码**。中文 TXT 的编码五花八门：网上抓的常是 GB18030，Windows 记事本存的
 *    可能是 UTF-16LE（带 BOM），手打的才是 UTF-8。策略是「先看 BOM，再严格试
 *    UTF-8，再严格试 GB18030」——严格解码（fatal）是这里的关键：宽松解码会把
 *    GB18030 的中文变成一堆 U+FFFD，而那种乱码看起来「像成功」。
 *
 * 2. **切章**。只看行首的「第 X 章 / 卷 / 回 / 节 / 篇 / 部」与「序言 / 楔子 /
 *    前言 / 后记 / 番外 / 附录」这类标题行，且要求整行短于 60 字——否则正文里
 *    随手一句「第三章里他提到」也会被切成一章。一刀都切不出来时按长度硬切，
 *    宁可多切几段，也不能让一本 40 万字的大部头变成单章（分页会卡死）。
 *
 * 3. **段落**。TXT 没有段落标记，只有换行。约定俗成是「一行一段」；空行只是
 *    排版留白，丢掉。
 *
 * 什么时候会失败、失败给谁看：
 *   - 三种编码都解不开 → `E_TXT_DECODE_FAILED`（「这个文件不是能识别的文本」）。
 *   - 解出来几乎全是乱码/控制字符 → `E_TXT_NOT_TEXT`（「这个文件看起来不是文本」）。
 *   - 没有正文 → 由 `buildReflowedBook` 抛 `E_BOOK_EMPTY`。
 */

import { fail } from './errors.js'
import { buildReflowedBook, mergeWrappedLines } from './textbook.js'

/** 单章目标字数：超过就硬切，避免一章几万字导致分页与 CFI 计算变慢。 */
const CHUNK_CHARS = 8000

/** 一章硬切后的上限：超过再切一刀（给「卷」这种超长章节兜底）。 */
const MAX_CHAPTER_CHARS = 20000

/** 标题行最长多少字。超过就当成正文，不当章节标题。 */
const MAX_HEADING_LENGTH = 60

/**
 * 行首章节标题的匹配式：只认「第 X 章 / 卷 / 回 / 节 / 篇 / 部」与常见卷首标题。
 *
 * 光有这一条不够——「第一章的正文。」同样以「第一章」开头。所以匹配到前缀后
 * 还要看**余下部分**（见 `isHeadingLine`），这一步是切章准确率的关键。
 */
const HEADING_PATTERN =
  /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节節回卷篇部集]|卷\s*[0-9０-９零〇一二三四五六七八九十百千万两]+|序章|序言|自序|前言|引子|引言|楔子|尾声|尾聲|终章|終章|后记|後記|结局|結局|番外|附录|附錄|目录|目錄|作者的话|作者的話|序)/u

/** 标题后允许紧跟的排版符号（「第一章：起风了」「第 1 章 · 开始」）。 */
const HEADING_SEPARATORS = /^[\s\u3000:：·・、\-—－()（）\[\]【】「」《》]+/

/**
 * 硬切出来的假章名：「第 12 部分」「第 3 部分（续 2）」。
 *
 * 这两个形状是 `hardSplit` / `chunkByLength` 自己造出来的，不是书里的标题；
 * 判定 tocSource 时必须把它们排除，否则一本没有目录的 TXT 会被当成
 * 「识别到真标题」而挂上「自动识别」角标。
 */
const SPLIT_LABEL_PATTERN = /^第\s*\d+\s*部分(?:[（(]续\s*\d+[)）])?$/u

/**
 * 余下部分以这些字开头时，几乎可以肯定是正文句子，不是标题：
 * 「第一章的正文」「第三章里他提到」「序言部分」。
 */
const CONTINUATION_START = /^[的里中上下内外前后末也还都就将是把被让给对从向在说了过着]/

/** 句中句末标点出现在标题余下部分时，同样当成正文。 */
const SENTENCE_PUNCTUATION = /[。！？；，、,.!?;]/

/**
 * 判断一行是不是章节标题。
 *
 * 三条同时满足才算：整行够短、前缀是「第 X 章」这类、余下部分不像半句话。
 *
 * @param {string} trimmed 已 trim 的行
 * @returns {boolean}
 */
export function isHeadingLine(trimmed) {
  if (trimmed === '' || trimmed.length > MAX_HEADING_LENGTH) return false
  const match = HEADING_PATTERN.exec(trimmed)
  if (match === null) return false
  const rest = trimmed.slice(match[0].length).replace(HEADING_SEPARATORS, '')
  if (rest.length > 30) return false
  if (rest !== '' && CONTINUATION_START.test(rest)) return false
  if (SENTENCE_PUNCTUATION.test(rest)) return false
  return true
}

/**
 * 从字节里解码出文本。
 *
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: string }}
 * @throws {import('./errors.js').AppError} `E_TXT_DECODE_FAILED`
 */
export function decodePlainText(bytes) {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length === 0) {
    throw fail('E_TXT_DECODE_FAILED', '这个文件是空的。', { detail: 'empty buffer' })
  }

  const bom = detectBom(buf)
  if (bom) {
    try {
      return { text: new TextDecoder(bom.encoding, { fatal: true }).decode(buf.subarray(bom.skip)), encoding: bom.encoding }
    } catch (error) {
      throw fail('E_TXT_DECODE_FAILED', '这个文件不是能识别的文本，读不出来。', {
        detail: `${bom.encoding} with BOM failed: ${String(error && error.message)}`,
        cause: error,
      })
    }
  }

  // 顺序有讲究：UTF-8 严格失败才轮到 GB18030。反过来会把 UTF-8 的中文
  // 当成 GB18030 解出一堆生僻字（两种编码都「合法」，但只有一种是对的）。
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buf)
      return { text, encoding }
    } catch {
      // 这个编码解不开是预期结果，继续试下一个；两个都失败才报错。
    }
  }

  throw fail('E_TXT_DECODE_FAILED', '这个文件不是能识别的文本，读不出来。', {
    detail: 'neither utf-8 nor gb18030 decoded strictly',
  })
}

/**
 * 判断解码出来的文本像不像「真的文字」。
 *
 * 用途：拦住把 .mobi、.docx 这类二进制文件改名成 .txt 的误操作——它们常常能
 * 被某种编码「解」出来，但内容是大段控制字符与替换符。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeText(text) {
  if (text.length === 0) return false
  const sample = text.length > 20000 ? text.slice(0, 20000) : text
  let bad = 0
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0xfffd) bad += 2 // 替换符两份权重：出现就说明解码猜错了
    else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) bad += 1
  }
  return bad / sample.length < 0.02
}

/**
 * 把整段文字切成章节。
 *
 * @param {string} text
 * @returns {Array<{ label: string, paragraphs: string[] }>}
 */
export function splitChapters(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  /** @type {Array<{ label: string, paragraphs: string[] }>} */
  const chapters = []
  let current = null

  const flush = () => {
    if (current === null) return
    chapters.push(current)
    current = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '') {
      // 空行留一个空段落当「硬分段」信号：文本里没有标点断句的段落靠它分家。
      // 下游 mergeWrappedLines 见到空串会 flush，不会把空串渲染成 <p></p>。
      if (current !== null) current.paragraphs.push('')
      continue
    }

    if (isHeadingLine(trimmed)) {
      flush()
      current = { label: trimmed, paragraphs: [] }
      continue
    }

    if (current === null) current = { label: '', paragraphs: [] }
    current.paragraphs.push(trimmed)
  }
  flush()

  // 首章无标题但前面还有内容时，把「无标题的正文」与「第一个真标题」分开：
  // 上面的循环已经天然做到（遇到标题就 flush），这里只处理「整本没有标题」。
  const cleaned = chapters
    .filter((chapter) => chapter.paragraphs.length > 0 || chapter.label !== '')
    // 硬折行在这里就地合回去：空行留下的空串是「硬分段」信号，合完就不存在了。
    .map((chapter) => ({ label: chapter.label, paragraphs: mergeWrappedLines(chapter.paragraphs) }))
  return cleaned.map((chapter, index) => hardSplit(chapter, index)).flat()
}

/**
 * 超长章节再切几刀，保证单章不超过 `MAX_CHAPTER_CHARS`。
 *
 * @param {{ label: string, paragraphs: string[] }} chapter
 * @param {number} index 章序号（用来给无标题章起名）
 * @returns {Array<{ label: string, paragraphs: string[] }>}
 */
function hardSplit(chapter, index) {
  const label = chapter.label !== '' ? chapter.label : `第 ${index + 1} 部分`
  const chunks = []
  let current = { label, paragraphs: [] }
  let size = 0
  for (const paragraph of chapter.paragraphs) {
    if (size > 0 && size + paragraph.length > MAX_CHAPTER_CHARS) {
      chunks.push(current)
      current = { label: `${label}（续 ${chunks.length + 1}）`, paragraphs: [] }
      size = 0
    }
    current.paragraphs.push(paragraph)
    size += paragraph.length
  }
  if (current.paragraphs.length > 0) chunks.push(current)
  else if (chunks.length === 0) chunks.push({ label, paragraphs: [] })
  return chunks
}

/**
 * 没有任何标题的纯文本：按字数硬切成若干「部分」。
 *
 * @param {string[]} paragraphs
 * @returns {Array<{ label: string, paragraphs: string[] }>}
 */
export function chunkByLength(paragraphs) {
  const chunks = []
  let current = { label: '', paragraphs: [] }
  let size = 0
  for (const paragraph of paragraphs) {
    if (size > 0 && size + paragraph.length > CHUNK_CHARS) {
      chunks.push(current)
      current = { label: '', paragraphs: [] }
      size = 0
    }
    current.paragraphs.push(paragraph)
    size += paragraph.length
  }
  if (current.paragraphs.length > 0) chunks.push(current)
  return chunks.map((chunk, index) => ({ label: `第 ${index + 1} 部分`, paragraphs: chunk.paragraphs }))
}

/**
 * 解析一本 TXT。
 *
 * @param {Uint8Array} bytes
 * @param {{ filename?: string, deviceId?: string, now?: string }} [options]
 * @returns {ReturnType<typeof buildReflowedBook>}
 */
export function parseTxt(bytes, options = {}) {
  const { text, encoding } = decodePlainText(bytes)
  if (!looksLikeText(text)) {
    throw fail('E_TXT_NOT_TEXT', '这个文件看起来不是文本，可能是别改了扩展名的文件。', {
      detail: `decoded as ${encoding} but content looks binary`,
    })
  }

  // 目录来源（0.4.0，施工图 §6.2）：从正文认出 ≥2 条真标题才算「有目录」（auto）；
  // 只命中 1 条、或者全是按字数硬切出来的「第 N 部分」，都按 none 记 ——
  // 硬切不是目录，toc 必须返回空数组（阅读器靠翻页/进度走），否则用户会看到
  // 一串「第 12 部分」以为目录坏了（用户原话：纯文本不要自动加章节跳转）。
  const split = splitChapters(text)
  const headingCount = split.filter((chapter) => {
    const label = String(chapter.label ?? '').trim()
    return label !== '' && !SPLIT_LABEL_PATTERN.test(label) && isHeadingLine(label)
  }).length
  let tocSource = headingCount >= 2 ? 'auto' : 'none'

  let chapters = split
  // 一刀都没切出来（或只有一章）时退回按长度切：单章几十万字会让分页与 CFI 变慢。
  if (chapters.length === 1) {
    chapters = chunkByLength(chapters[0].paragraphs)
    tocSource = 'none'
  }
  if (chapters.length === 0) {
    const paragraphs = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    chapters = chunkByLength(paragraphs)
    tocSource = 'none'
  }

  const book = buildReflowedBook({
    chapters,
    title: '',
    author: '',
    format: 'txt-converted',
    sourceFormat: 'txt',
    bytes,
    filename: options.filename,
    deviceId: options.deviceId,
    now: options.now,
    tocSource,
  })
  // 没有目录就是真的没有：硬切出来的「第 N 部分」不进 toc，界面不用再兜一次底。
  if (tocSource === 'none') book.toc = []
  book.meta.encoding = encoding
  return book
}

/** 认 BOM（顺序不能反：UTF-32LE 的前两字节与 UTF-16LE 相同）。 */
function detectBom(buf) {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) {
      // UTF-32LE 不在支持范围（罕见且 TextDecoder 在部分平台不支持），
      // 按 UTF-16LE 解会得到夹空字符的乱码，看起来像坏文件——正好该报错。
      return { encoding: 'utf-16le', skip: 2 }
    }
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) {
      return { encoding: 'utf-16be', skip: 2 }
    }
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', skip: 3 }
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf-16le', skip: 2 }
    if (buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf-16be', skip: 2 }
  }
  return null
}
