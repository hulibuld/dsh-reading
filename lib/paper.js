/**
 * 论文版式：把「一页页抽出来的文字」整理成学位论文/期刊论文的结构。
 *
 * 输入是 lib/pdftext.js 逐页抽出来的段落流（每段已经在抽取时按行距断好），
 * 输出是标题、作者、单位、摘要、关键词、正文各节、参考文献。
 *
 * 这里只做版式重排，不做任何内容判断：摘要里的句子是不是摘要、参考文献
 * 条目齐不齐，一概不管。认不准的地方宁可退回普通重排，也不要排出一个
 * 看着像论文、实际把正文塞进摘要框的东西。
 *
 * 版面约定（与知网/万方看到的中文论文一致）：
 * - 标题居中大字，作者下一行，单位再下一行（常带括号）
 * - 「摘要：」「关键词：」用中文冒号起头，后面接正文
 * - 正文一级标题「一、二、三、」，二级「（一）」，英文论文用 1 / 1.1
 * - 末尾「参考文献」，条目以 [1] 起头
 */

/** 一级标题：一、引言 / 二、xxx */
const CN_SECTION = /^[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S/

/** 二级标题：（一）xxx / (1) xxx */
const CN_SUBSECTION = /^[（(]\s*[一二三四五六七八九十\d]{1,3}\s*[）)]\s*\S/

/** 英文论文的数字标题：1 Introduction / 2.1 Method */
const EN_SECTION = /^\d{1,2}([.．]\d{1,2}){0,2}[.、．]?\s*[A-Z\u4e00-\u9fa5]/

/** 结构词标题（引言、结语、参考文献……），也允许带前导编号 */
const NAMED_SECTION = /^(?:[一二三四五六七八九十]{1,3}\s*[、.．]\s*)?(引\s*言|绪\s*论|导\s*论|结\s*语|结\s*论|余\s*论|附\s*录|注\s*释|参考文献|引用文献|致\s*谢|References|Bibliography|Acknowledg)/i

/** 摘要起头 */
const ABSTRACT_START = /^(摘\s*要|内容摘要|Abstract)\s*[:：]?\s*/i

/** 关键词起头 */
const KEYWORDS_START = /^(关\s*键\s*词|关键字|Key\s*words?|Keywords)\s*[:：]?\s*/i

/** 参考文献起头（作为一节的开头） */
const REFERENCES_START = /^(参考文献|引用文献|References|Bibliography)\s*[:：]?$/i

/** 一行里是不是几乎没有中文/英文正文的字（页码、装饰线、期刊页眉残留） */
const NOISE_LINE = /^[\s\d\-—_·•.、,，。:：()（）[\]【】/\\|]+$/

/** 单位行的特征：校名、院所、实验室，或六位邮编 */
const AFFILIATION_HINT = /(大学|学院|学系|研究生院|研究院|研究所|实验室|研究中心|出版社|医院|公司)|\b\d{6}\b/

const MAX_TITLE_CHARS = 80
const MAX_AFFILIATION_CHARS = 120
const MAX_ABSTRACT_CHARS = 4000
const MAX_KEYWORDS_CHARS = 200
const MAX_REFERENCE_ITEMS = 400

/**
 * 清理单段文字：去掉抽取时残留的软换行、连续空白。
 *
 * @param {string} text
 * @returns {string}
 */
function tidy(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 这一行像不像「一节的标题」。
 *
 * @param {string} text
 * @param {{ allowEn?: boolean }} [options]
 * @returns {boolean}
 */
export function looksLikeSectionHeading(text, options = {}) {
  const line = tidy(text)
  if (line === '' || line.length > 60) return false
  if (ABSTRACT_START.test(line) || KEYWORDS_START.test(line)) return false
  // 参考文献条目长得像「(14) : 3890-3901．」，也会被数字编号规则误认成小节。
  if (/^\(\d+\)\s*[:：]?\s*\(?\s*\d/.test(line) || /\d+\s*[-–]\s*\d+\s*[．.]?$/.test(line)) return false
  // 正文句子常以「(3) 热度指标……」开头，标题不会这么长。
  // 正文折行也常以「4 大生态要素。……」开头；标题里不会有句号/分号。
  if (/[。；]/.test(line)) return false
  if (CN_SUBSECTION.test(line)) return line.length <= 30
  if (options.allowEn !== false && EN_SECTION.test(line)) {
    if (line.length > 60) return false
    if (/[，,；;。]$/.test(line)) return false
    return true
  }
  if (CN_SECTION.test(line) || NAMED_SECTION.test(line)) return true
  return false
}

/**
 * 这本书看起来是不是一篇论文。
 *
 * 判据刻意保守：必须同时有「摘要」和（「关键词」或「参考文献」）。
 * 只有摘要没有关键词的，多半是书里某一章叫「摘要」，不是论文。
 *
 * @param {string[]} paragraphs
 * @returns {boolean}
 */
export function looksLikePaper(paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : []
  let hasAbstract = false
  let hasKeywords = false
  let hasReferences = false
  for (const raw of list) {
    const line = tidy(raw)
    if (line === '') continue
    if (!hasAbstract && ABSTRACT_START.test(line)) hasAbstract = true
    if (!hasKeywords && KEYWORDS_START.test(line)) hasKeywords = true
    if (!hasReferences && REFERENCES_START.test(line)) hasReferences = true
    if (hasAbstract && hasKeywords && hasReferences) return true
  }
  return hasAbstract && (hasKeywords || hasReferences)
}

/**
 * 只看开头几行，给一个「这像不像论文」的初判。
 *
 * 不做决定，只报告：导入时把它连同书名一起交给用户，让用户自己选按论文排
 * 还是按普通书排。判断只扫第一页的前几段（标题、作者、单位、摘要、关键词
 * 这几行），不读全文——一本书开头出现「摘要」可能只是某一章的标题，读到
 * 末尾也不会让判断更准，只会更慢。
 *
 * @param {Array<{ page: number, paragraphs: string[] }>} pages
 * @param {{ maxLines?: number }} [options]
 * @returns {{
 *   looksLikePaper: boolean,
 *   title: string,
 *   sample: string[],
 *   hasAbstract: boolean,
 *   hasKeywords: boolean,
 *   reason: string,
 * }}
 */
/** 中日韩文字：拼接折行时这两类之间不该插空格。 */
function isCjkChar(ch) {
  if (!ch) return false
  return /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef]/.test(ch)
}

/** 把一页的行拼成块（= 段落）。空行是硬分段信号。 */
function joinLines(lines) {
  let out = ''
  for (const line of lines) {
    if (out === '') { out = line; continue }
    out += isCjkChar(out.slice(-1)) && isCjkChar(line.slice(0, 1)) ? line : ` ${line}`
  }
  return out
}

/**
 * 一页 → 块列表。
 *
 * 优先用抽取层留下的整页文本（`page.text`）：段落合并之后行边界就没了，
 * 而「摘要」「关键词」「参考文献」这些标记是**整行**的，必须按行认。
 *
 * @param {{ page?: number, text?: string, paragraphs?: string[] }} page
 * @returns {Array<{ page: number, lines: string[], text: string }>}
 */
function pageBlocks(page) {
  const raw = typeof page?.text === 'string' && page.text !== ''
    ? page.text
    : (Array.isArray(page?.paragraphs) ? page.paragraphs.join('\n\n') : '')
  const blocks = []
  for (const chunk of raw.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    if (lines.length === 0) continue
    blocks.push({ page: Number(page?.page) || 0, lines, text: joinLines(lines) })
  }
  return blocks
}

/** 期刊页眉/页脚残留：纯数字、页码接刊名、「第 33 卷」这类。 */
function isNoiseBlock(text) {
  if (text === '') return true
  if (NOISE_LINE.test(text)) return true
  if (/^\d{3,}\s/.test(text) && text.length < 40) return true
  if (/^(第\s*\d+\s*卷|Vol\.?\s*\d+|ISSN)/i.test(text) && text.length < 40) return true
  return false
}

/** 块列表里的所有文字行，给「只要文字」的地方用。 */
function blocksOf(pages, limitPages = Infinity) {
  const list = Array.isArray(pages) ? pages : []
  const out = []
  for (const page of list.slice(0, limitPages)) {
    for (const block of pageBlocks(page)) {
      if (isNoiseBlock(block.text)) continue
      out.push(block)
    }
  }
  return out
}

/**
 * 只看开头几块，给一个「这像不像论文」的初判。
 *
 * 不做决定，只报告：导入时把它连同书名一起交给用户，让用户自己选按论文排
 * 还是按普通书排。判断只扫前几页的块（标题、作者、单位、摘要、关键词这几行），
 * 不读全文。
 *
 * @param {Array<{ page: number, text?: string, paragraphs?: string[] }>} pages
 * @param {{ maxPages?: number, maxLines?: number }} [options]
 * @returns {{
 *   looksLikePaper: boolean,
 *   title: string,
 *   sample: string[],
 *   hasAbstract: boolean,
 *   hasKeywords: boolean,
 *   hasReferences: boolean,
 *   reason: string,
 * }}
 */
export function detectPaperHint(pages, options = {}) {
  const maxPages = Math.max(1, Math.min(5, Number(options.maxPages) || 3))
  const maxSample = Math.max(1, Math.min(12, Number(options.maxLines) || 6))
  const blocks = blocksOf(pages, maxPages)
  const hasAbstract = blocks.some((block) => ABSTRACT_START.test(block.text))
  // 关键词和参考文献常常和上一段挤在同一个块里（只隔一个换行），必须块内搜索。
  const hasKeywords = blocks.some((block) => findKeywords(block.text) !== null)
  const hasReferences = blocks.some((block) => findReferencesMark(block.text) !== null)
  const looksLikePaper = hasAbstract && (hasKeywords || hasReferences)
  const reason = hasAbstract && hasKeywords
    ? '前几页里有「摘要」和「关键词」'
    : hasAbstract && hasReferences
      ? '前几页里有「摘要」，后面还有「参考文献」'
      : ''
  return {
    looksLikePaper,
    title: blocks[0]?.text ?? '',
    sample: blocks.slice(0, maxSample).map((block) => block.text.slice(0, 160)),
    hasAbstract,
    hasKeywords,
    hasReferences,
    reason,
  }
}

/**
 * 从一段文字里切出「摘要：」后面的内容；整段就是摘要正文时原样返回。
 *
 * @param {string} text
 * @returns {string | null} 不是摘要返回 null
 */
function takeAbstract(text) {
  const line = tidy(text)
  const match = ABSTRACT_START.exec(line)
  if (!match) return null
  return line.slice(match[0].length).trim()
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function takeKeywords(text) {
  const line = tidy(text)
  const match = KEYWORDS_START.exec(line)
  if (!match) return null
  return line.slice(match[0].length).trim()
}

/**
 * 在**块内**找「关键词：」——它常常和摘要挤在同一块里（中间只有一个换行）。
 *
 * @param {string} text
 * @returns {{ before: string, value: string } | null}
 */
function findKeywords(text) {
  const match = /(?:^|[\s|。！？；;，,）)])(关\s*键\s*词|关键字|Key\s*words?|Keywords)\s*[:：]\s*([\s\S]*)$/i.exec(text)
  if (!match) return null
  return { before: text.slice(0, match.index).trim(), value: match[2].trim() }
}

/**
 * 在块内找「参考文献」标记。
 *
 * @param {string} text
 * @returns {{ before: string, after: string } | null}
 */
function findReferencesMark(text) {
  const match = /(?:^|[\s|。！？；;，,）)])(参考文献|引用文献|References|Bibliography)\s*[:：]?\s*([\s\S]*)$/i.exec(text)
  if (!match) return null
  // 正文里偶尔出现「见参考文献」这类句子，要求标记前面的内容不是以「见/参见」结尾。
  if (/[见参]\s*$/.test(text.slice(0, match.index))) return null
  return { before: text.slice(0, match.index).trim(), after: match[2].trim() }
}

/** 标题候选：不要太长、不要是引用行（带 ． 和期刊名）、不要是单位。 */
function looksLikeTitle(text) {
  const value = tidy(text)
  if (value.length < 4 || value.length > MAX_TITLE_CHARS) return false
  if (AFFILIATION_HINT.test(value)) return false
  if (/[。；;，,]$/.test(value)) return false
  if (/生态学报|ACTA ECOLOGICA|http|www\.|DOI|收稿日期|基金项目|通讯作者/i.test(value)) return false
  return true
}

/**
 * 从文字流里认出论文结构。
 *
 * @param {Array<{ page: number, text?: string, paragraphs?: string[] }>} pages
 * @returns {{
 *   title: string, authors: string[], affiliations: string[],
 *   abstract: string, keywords: string[],
 *   sections: Array<{ heading: string, paragraphs: string[] }>,
 *   references: string[]
 * } | null} 认不出返回 null（调用方退回普通重排）
 */
export function parsePaper(pages) {
  const blocks = blocksOf(pages)
  if (blocks.length === 0) return null
  if (!detectPaperHint(pages).looksLikePaper) return null

  // 逐行扫，不按块。中文期刊 PDF 常把小节标题和正文挤在同一块里（中间只有一个
  // 换行），按块切会把「1 基本原理」永远埋进正文。行是唯一稳定的边界。
  /** @type {string[]} */
  const lines = []
  for (const page of Array.isArray(pages) ? pages : []) {
    // 老调用方（测试、或没有 text 字段的解析结果）只有 paragraphs：一段当一行，
    // 结构标记（摘要/关键词）本来就是整段的，照样认得出来。
    const raw = typeof page?.text === 'string' && page.text !== ''
      ? page.text
      : (Array.isArray(page?.paragraphs) ? page.paragraphs.join('\n\n') : '')
    for (const line of raw.split('\n')) {
      const text = tidy(line)
      if (text === '' || NOISE_LINE.test(text)) continue
      if (/^\d{3,}\s*[\u4e00-\u9fa5]{0,12}\s*第?\s*\d*\s*卷?$/.test(text)) continue
      lines.push(text)
    }
  }
  if (lines.length === 0) return null

  // 有没有整页文本，决定「一行」的含义：有 text 时一行是视觉行（要拼段落）；
  // 只有 paragraphs 时一段就是一行（测试夹具、老数据），直接一段一收。
  const hasRawText = (Array.isArray(pages) ? pages : []).some((page) => typeof page?.text === 'string' && page.text !== '')

  /** 中位行宽：判断「这一行是不是段落最后一行」用（末行通常短一截）。 */
  const widths = lines.filter((line) => line.length >= 10).map((line) => line.length).sort((a, b) => a - b)
  const median = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : 40

  const abstractAt = lines.findIndex((line) => ABSTRACT_START.test(line) || findKeywords(line) !== null)
  if (abstractAt < 0) return null

  const front = lines.slice(0, abstractAt)
  let title = ''
  for (const line of front) {
    if (!looksLikeTitle(line)) continue
    if (line.length > title.length) title = line
  }
  title = title.slice(0, MAX_TITLE_CHARS)
  /** @type {string[]} */
  const authors = []
  /** @type {string[]} */
  const affiliations = []
  // 页眉页脚（第 33 卷 / 2013 年 12 月 / 生态学报 / Vol．33）不能当作者。
  const looksLikeHeader = (text) => /(期|卷|学报|年\s*\d|月\b|Vol\.?|No\.?|ISSN|ACTA|SINICA|\.cn)/i.test(text)
  for (const line of front) {
    if (line === title) continue
    if (looksLikeHeader(line)) continue
    if (AFFILIATION_HINT.test(line) || /[（(]/.test(line) || line.length > 24) {
      if (affiliations.length < 3) affiliations.push(line.slice(0, MAX_AFFILIATION_CHARS))
      continue
    }
    // 作者行：2–4 个汉字的人名，或 2–3 个拉丁词；不许带数字、网址、脚注角标。
    const isCjkName = /^[\u4e00-\u9fa5]{2,4}([\s，,、]+[\u4e00-\u9fa5]{2,4})*$/.test(line)
    const isLatinName = /^[A-Z][A-Za-z.\-]+(\s+[A-Z][A-Za-z.\-]+){0,3}$/.test(line)
    if (authors.length < 6 && (isCjkName || isLatinName)) authors.push(line)
  }

  /** @type {string[]} */
  const abstractParts = []
  let keywords = []
  let index = abstractAt
  const firstValue = takeAbstract(lines[index])
  if (firstValue !== null) abstractParts.push(firstValue)
  else abstractParts.push(lines[index])
  index += 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const inline = findKeywords(line)
    if (inline !== null) {
      if (inline.before !== '') abstractParts.push(inline.before)
      keywords = splitKeywords(inline.value)
      index += 1
      break
    }
    if (looksLikeSectionHeading(line)) break
    abstractParts.push(line)
    if (abstractParts.join('').length > MAX_ABSTRACT_CHARS) break
  }
  if (keywords.length === 0 && index < lines.length) {
    const next = lines[index]
    if (/[；;，,、]/.test(next) && next.length <= MAX_KEYWORDS_CHARS && !looksLikeSectionHeading(next)) {
      keywords = splitKeywords(next)
      index += 1
    }
  }

  /** @type {Array<{ heading: string, paragraphs: string[] }>} */
  const sections = []
  /** @type {string[]} */
  const references = []
  let current = { heading: '', paragraphs: [] }
  let buffer = ''
  let inReferences = false

  const flush = () => {
    const text = buffer.trim()
    buffer = ''
    if (text === '') return
    if (inReferences) {
      if (references.length < MAX_REFERENCE_ITEMS) references.push(text)
      return
    }
    current.paragraphs.push(text)
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const refMark = findReferencesMark(line)
    if (refMark !== null) {
      if (refMark.before !== '') buffer = buffer === '' ? refMark.before : `${buffer} ${refMark.before}`
      flush()
      if (current.paragraphs.length > 0 || current.heading !== '') sections.push(current)
      current = { heading: '', paragraphs: [] }
      inReferences = true
      if (refMark.after !== '') buffer = refMark.after
      continue
    }
    if (inReferences) {
      // 参考文献一条一行：新条目以 [1] / 1. 开头，其余算上一条的折行。
      // 中文期刊常用全角方括号：［14］。
      const startsNew = /^[\[［]\s*\d+\s*[\]］]/.test(line) || /^\d{1,3}[.．]\s*\S/.test(line)
      if (startsNew && buffer !== '') flush()
      buffer = buffer === '' ? line : joinPieces(buffer, line)
      continue
    }
    if (looksLikeSectionHeading(line)) {
      flush()
      if (current.paragraphs.length > 0 || current.heading !== '') sections.push(current)
      current = { heading: line.replace(/[。；;：:]\s*$/, ''), paragraphs: [] }
      continue
    }
    buffer = buffer === '' ? line : joinPieces(buffer, line)
    if (!hasRawText) {
      flush()
      continue
    }
    // 两种分段信号：
    //  ① 末行比中位行宽短一截（段落最后一行常有留白）；
    //  ② 攒够两百来字且正好在句末（两栏排版里满行是常态，①很难触发，
    //     不补这条每一节都会变成一大坨）。
    // 中文句号，以及英文摘要里的句点（行末才算，避免 Vol.33 这种误判）。
    const ended = /[。！？]\s*$/.test(line) || /[.．]\s*$/.test(line)
    if (ended && (line.length < median * 0.9 || buffer.replace(/\s/g, '').length >= 220)) flush()
  }
  flush()
  if (current.paragraphs.length > 0 || current.heading !== '') sections.push(current)
  if (references.length > 0 && inReferences) {
    // 参考文献可能没有单独标题行：把最后一段当成参考文献收尾不合适，保持原样即可。
  }

  const abstract = abstractParts.join(' ').trim()
  const hasBody = sections.some((section) => section.paragraphs.length > 0)
  if (!hasBody && references.length === 0) return null

  return {
    title,
    authors,
    affiliations,
    abstract,
    keywords,
    sections,
    references,
  }
}

/** 拼接两行：中日韩之间直接连，其余留一个空格。 */
function joinPieces(left, right) {
  return isCjkChar(left.slice(-1)) && isCjkChar(right.slice(0, 1)) ? `${left}${right}` : `${left} ${right}`
}

/**
 * 「文学、历史；叙事学 空间」→ ['文学', '历史', '叙事学', '空间']
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitKeywords(text) {
  const raw = tidy(text).replace(/[。.]$/, '')
  if (raw === '') return []
  const parts = raw
    .split(/[；;，,、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '' && item.length <= 24)
  return parts.slice(0, 20)
}

/* ───────────────────────── 排版 ───────────────────────── */

const PAPER_CSS = `
  body { margin: 0; }
  .pp { font-family: inherit; color: inherit; }
  .pp-title { font-size: 1.55em; font-weight: 700; line-height: 1.45; text-align: center; margin: 0 0 0.7em; letter-spacing: 0.02em; }
  .pp-authors { font-size: 1.05em; text-align: center; margin: 0 0 0.45em; }
  .pp-affiliations { font-size: 0.85em; text-align: center; margin: 0 0 1.4em; opacity: 0.78; line-height: 1.6; }
  .pp-block { margin: 0 0 1.05em; padding: 0.7em 0.9em; border-left: 3px solid rgba(128,128,128,0.45); background: rgba(128,128,128,0.06); border-radius: 3px; }
  .pp-label { font-weight: 700; }
  .pp-abstract { font-size: 0.92em; line-height: 1.85; text-align: justify; }
  .pp-keywords { font-size: 0.92em; line-height: 1.8; }
  .pp-tag { display: inline-block; margin: 0 0.4em 0.3em 0; padding: 0.05em 0.5em; border-radius: 3px; background: rgba(128,128,128,0.16); }
  .pp-h1 { font-size: 1.18em; font-weight: 700; margin: 1.6em 0 0.7em; line-height: 1.5; }
  .pp-h2 { font-size: 1.05em; font-weight: 700; margin: 1.3em 0 0.55em; }
  .pp-p { font-size: 1em; line-height: 1.95; text-align: justify; text-indent: 2em; margin: 0 0 0.75em; }
  .pp-ref { font-size: 0.9em; line-height: 1.8; text-align: justify; text-indent: -1.6em; padding-left: 1.6em; margin: 0 0 0.45em; }
  .pp-note { font-size: 0.85em; opacity: 0.7; text-align: center; margin: 2em 0 0; }
`

/**
 * @param {string} text
 * @returns {string} 已转义的 XHTML 文本
 */
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function renderDocument(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)}</title>
  <style type="text/css">${PAPER_CSS}</style>
</head>
<body>
<div class="pp">
${body}
</div>
</body>
</html>
`
}

/**
 * 论文首页：标题 + 作者 + 单位 + 摘要 + 关键词。
 *
 * @param {ReturnType<typeof parsePaper>} paper
 * @returns {string}
 */
function renderFrontMatter(paper) {
  const parts = []
  if (paper.title !== '') parts.push(`<h1 class="pp-title">${esc(paper.title)}</h1>`)
  if (paper.authors.length > 0) {
    parts.push(`<p class="pp-authors">${paper.authors.map((item) => esc(item)).join('　')}</p>`)
  }
  if (paper.affiliations.length > 0) {
    const text = paper.affiliations.map((item) => esc(item)).join('<br/>')
    parts.push(`<p class="pp-affiliations">${text}</p>`)
  }
  if (paper.abstract !== '') {
    parts.push(
      `<div class="pp-block pp-abstract"><span class="pp-label">摘要：</span>${esc(paper.abstract)}</div>`,
    )
  }
  if (paper.keywords.length > 0) {
    const tags = paper.keywords.map((item) => `<span class="pp-tag">${esc(item)}</span>`).join('')
    parts.push(
      `<div class="pp-block pp-keywords"><span class="pp-label">关键词：</span>${tags}</div>`,
    )
  }
  return parts.join('\n')
}

/**
 * 正文一节。
 *
 * @param {{ heading: string, paragraphs: string[] }} section
 * @returns {string}
 */
function renderSection(section) {
  const parts = []
  if (section.heading !== '') {
    const cls = CN_SUBSECTION.test(section.heading) || /^\d+\.\d+/.test(section.heading) ? 'pp-h2' : 'pp-h1'
    parts.push(`<h2 class="${cls}">${esc(section.heading)}</h2>`)
  }
  for (const paragraph of section.paragraphs) {
    parts.push(`<p class="pp-p">${esc(paragraph)}</p>`)
  }
  return parts.join('\n')
}

/**
 * 参考文献。
 *
 * @param {string[]} references
 * @returns {string}
 */
function renderReferences(references) {
  const parts = [`<h2 class="pp-h1">参考文献</h2>`]
  for (const item of references) {
    parts.push(`<p class="pp-ref">${esc(item)}</p>`)
  }
  return parts.join('\n')
}

/**
 * 把论文结构转成 buildReflowedBook 能吃的章节数组（带现成 HTML）。
 *
 * 章节划分：首页（标题/作者/摘要/关键词）一章，正文按小节各一章，参考文献一章。
 * 这样目录面板里点「二、……」就能直接跳到那一节。
 *
 * @param {NonNullable<ReturnType<typeof parsePaper>>} paper
 * @param {{ fileNameTitle?: string }} [options]
 * @returns {Array<{ label: string, paragraphs: string[], html: string }>}
 */
export function paperChapters(paper, options = {}) {
  /** @type {Array<{ label: string, paragraphs: string[], html: string }>} */
  const chapters = []
  const frontLabel = paper.title !== '' ? paper.title.slice(0, 40) : options.fileNameTitle || '论文首页'
  chapters.push({
    label: frontLabel,
    paragraphs: [paper.abstract].filter((item) => item !== ''),
    html: renderDocument(frontLabel, renderFrontMatter(paper)),
  })

  for (const section of paper.sections) {
    if (section.paragraphs.length === 0) continue
    // 没有标题的正文段（英文摘要、引言前半截）用第一句话开头当标签，
    // 「第 2 节」这种编号对读者没有信息。
    const fallback = section.paragraphs[0].replace(/\s+/g, ' ').trim().slice(0, 24)
    const label = section.heading !== ''
      ? section.heading.slice(0, 40)
      : (fallback !== '' ? fallback : `第 ${chapters.length + 1} 节`)
    chapters.push({
      label,
      paragraphs: section.paragraphs,
      html: renderDocument(label, renderSection(section)),
    })
  }

  if (paper.references.length > 0) {
    chapters.push({
      label: '参考文献',
      paragraphs: paper.references,
      html: renderDocument('参考文献', renderReferences(paper.references)),
    })
  }
  return chapters
}
