/**
 * 入库前的纯函数层：把链接 / 响应头变成能落盘的文件名。这里**不联网**、不依赖任何库，
 * 所以可以单独测。
 *
 * 0.13.1：老「网页模板书源」退役，`buildSearchUrl` / `extractCandidates` / `textOfHtml`
 * 一并删掉——找书只剩 Legado 一条路（规则树在源头，不需要我们再抽链接）。
 * 剩下的 `decodeEntities` 还被 legado.js 与 cnki.js 用着，不能跟着走。
 */

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