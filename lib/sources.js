/**
 * 「找书」的纯函数层：把用户填的搜索地址模板拼出来，再从搜索结果页的 HTML 里
 * 抽候选链接。这里**不联网**、不依赖任何库，所以可以单独测。
 *
 * 设计上刻意不内置任何具体站点：用户自己在面板里填模板，插件只按模板去抓。
 * 站点改版会让正则抽不到东西——这是已知代价，报错文案里要说清楚。
 */

/** 候选序列上限。搜索结果页动辄几百个链接，全给前端没有意义。 */
export const MAX_CANDIDATES = 60

/**
 * 把模板里的 `{query}` 换成关键词。
 *
 * @param {string} template 形如 `https://某站/search?q={query}`
 * @param {string} query 关键词（已由用户输入，函数负责编码）
 * @returns {string}
 */
export function buildSearchUrl(template, query) {
  const raw = typeof template === 'string' ? template.trim() : ''
  if (raw === '') {
    throw new Error('书源的搜索地址是空的')
  }
  let parsed
  try {
    parsed = new URL(raw.replace('{query}', encodeURIComponent('x')))
  } catch {
    throw new Error('书源的搜索地址不是合法网址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('书源的搜索地址必须以 http:// 或 https:// 开头')
  }
  if (!raw.includes('{query}')) {
    throw new Error('书源的搜索地址里要有一个 {query} 占位符')
  }
  const keyword = typeof query === 'string' ? query.trim() : ''
  if (keyword === '') {
    return raw.replace(/\{query\}/g, '')
  }
  return raw.replace(/\{query\}/g, encodeURIComponent(keyword))
}

/** HTML 实体解码。只处理会出现在链接文本里的那些。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function safeFromCode(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 去掉标签、压空白，得到链接的可见文字。 */
export function textOfHtml(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

const LINK_PATTERN = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi

/**
 * 从搜索结果页里抽「看起来像一本书」的链接。
 *
 * 判据很朴素：可解析成 http(s)、文字不是空的、文字不超过 120 字、URL 去重。
 * 不做「像不像书名」的猜测——猜错比多给几条更烦人。
 *
 * @param {string} html 页面源码
 * @param {string} baseUrl 页面的最终地址（用来解析相对链接）
 * @returns {{ title: string, url: string }[]}
 */
export function extractCandidates(html, baseUrl) {
  const source = String(html ?? '')
  /** @type {Map<string, string>} */
  const seen = new Map()
  let match
  while ((match = LINK_PATTERN.exec(source)) !== null) {
    if (seen.size >= MAX_CANDIDATES) break
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (href === '' || href.startsWith('#')) continue
    if (/^(?:javascript|mailto|tel|data):/i.test(href)) continue
    let resolved
    try {
      resolved = new URL(href, baseUrl || undefined)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    const title = textOfHtml(match[4])
    if (title === '' || title.length > 120) continue
    const key = resolved.toString()
    if (seen.has(key)) continue
    seen.set(key, title)
  }
  return Array.from(seen, ([url, title]) => ({ title, url }))
}

/**
 * 猜一个文件名：优先 Content-Disposition，其次 URL 路径，最后兜底 `book`。
 *
 * @param {string} url
 * @param {string|null} contentDisposition
 * @returns {string}
 */
export function guessFilename(url, contentDisposition) {
  const disposition = typeof contentDisposition === 'string' ? contentDisposition : ''
  const encoded = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition)
  if (encoded) {
    const value = safeDecode(encoded[2].trim().replace(/^"|"$/g, ''))
    const cleaned = sanitizeName(value)
    if (cleaned !== '') return cleaned
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)
  if (plain) {
    const cleaned = sanitizeName(safeDecode((plain[1] ?? plain[2] ?? '').trim()))
    if (cleaned !== '') return cleaned
  }
  let base = ''
  try {
    const parsed = new URL(String(url ?? ''))
    base = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
    base = safeDecode(base)
  } catch {
    base = ''
  }
  const cleaned = sanitizeName(base)
  return cleaned === '' ? 'book' : cleaned
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sanitizeName(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120)
}

/** 有名字但没扩展名时，按内容嗅探的结果补一个。 */
export function ensureExtension(filename, format) {
  const name = String(filename ?? '').trim() === '' ? 'book' : String(filename).trim()
  if (/\.[A-Za-z0-9]{2,5}$/.test(name)) return name
  const map = { epub: '.epub', mobi: '.mobi', pdf: '.pdf', txt: '.txt' }
  return `${name}${map[format] ?? '.txt'}`
}
