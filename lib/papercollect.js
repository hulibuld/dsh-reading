/**
 * 文献集造书：把知网检索出来的题录数组包成一本 EPUB（0.12.0）。
 *
 * 为什么走「造一本真 EPUB」而不是自造格式：阅读器下游（store / routes / CFI /
 * 标注 / 进度 / 问 AI）全都只认 EPUB 解析结果那一套形状。造一本合规的 EPUB，
 * 上面这些一层都不用改，检索结果就同时拿到了「能读」和「能问」。
 *
 * 诚实原则（这个文件里最重要的一条）：
 *   知网免费检索页给的摘要恒定截断在 128 字，我们拿不到完整摘要。所以章节里
 *   只能写「摘要片段」，并且每章必须带上那句话说明它**不是**完整摘要。
 *   把片段排版成像完整摘要的样子，等于让用户以为读到了全文——这是不能做的。
 *
 * 字节稳定性：同一份题录两次造出来的书必须字节相同，否则书架里会留下两本
 * 看起来一样、哈希却不同的书。所以这里不读系统时钟、不写随机标识，ZIP 的
 * 时间戳也交给 writeZip 的固定值。
 *
 * 什么时候会失败、失败给谁看：
 *   - 题录为空、或所有条目都没有题名 → `E_PAPER_COLLECT`，界面显示
 *     「没有可收集的文献」这类话；不会生成一个空包。
 */

import { createHash } from 'node:crypto'
import { MAX_SNIPPET_CHARS } from './cnki.js'
import { fail } from './errors.js'
import { writeZip } from './zip.js'

/** 默认书名。路由层会用带日期的版本，这里只是兜底。 */
export const DEFAULT_PAPER_TITLE = '文献集'

/** 单本文献集最多收多少篇：再多就不是「一本文献集」，而是一次导入事故。 */
export const MAX_PAPER_ITEMS = 200

/** 章节正文里那段免责说明。措辞不要改——测试按这句断言。 */
export const SNIPPET_NOTICE =
  '（以上为知网免费页面提供的前 128 字以内片段，不是完整摘要。完整摘要与全文需登录知网获取。）'

/** 题录里缺摘要时的占位文字。 */
export const SNIPPET_MISSING = '知网未提供摘要片段'

/**
 * 造书时真正取用的字段。多传的键一律忽略——路由直接把客户端 JSON 传进来，
 * 不设白名单的话，客户端多带一个字段就会悄悄改变书的内容。
 */
const PAPER_FIELDS = [
  'title',
  'authors',
  'journal',
  'issue',
  'type',
  'keywords',
  'snippet',
  'url',
  'citations',
  'downloads',
]

/**
 * 转义要插进 XHTML 的文字。
 *
 * 比 `textbook.js` 的 `escapeXmlText` 多转义引号：这里的内容会进属性值
 * （`<title>` 之外还有 nav 的锚文本），属性值里一个裸 `"` 就能把整个文档拆坏。
 * 知网标题里真的会出现 `&`、`<`、`"`。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XHTML 不允许裸控制字符，它们会让整份文档解析失败，表现是「这一章空白」。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** 把「可能是字符串、可能是数字」的计数读成一个非负整数。 */
function countOf(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.floor(num)
}

/** 作者可能是数组，也可能（旧数据）是逗号/顿号分隔的字符串。 */
function authorsOf(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
  }
  const text = typeof value === 'string' ? value : ''
  return text
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 摘要片段：只做一件事——夹到 `MAX_SNIPPET_CHARS`。
 *
 * 结构层的上限管不住这里：`buildPaperEpub` 是导出的，任何入口都能调。喂一段
 * 2000 字的文本进来，章节里就写 2000 字，而紧接着的免责句仍然说「前 128 字以内
 * 片段」——那句话就变成谎话。入口越杂，越要在最后一道关嘴上。
 */
function snippetOf(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  // 按码点切而不是按 UTF-16 单元：切在代理对中间会留下一个坏字符。
  return Array.from(text).slice(0, MAX_SNIPPET_CHARS).join('')
}

/** 关键词同上。 */
function keywordsOf(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
  }
  const text = typeof value === 'string' ? value : ''
  return text
    .split('/')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 只取白名单字段并做一次规整；题名为空的条目返回 null（由调用方跳过）。
 *
 * 为什么「跳过」而不是「整批失败」：一次检索里混进一两条残缺数据很常见，
 * 为此让用户白搜一次比少一章糟糕得多。
 *
 * @param {any} item
 */
function sanitizePaper(item) {
  if (!item || typeof item !== 'object') return null
  const title = String(item.title ?? '').trim()
  if (title === '') return null
  const paper = { title }
  for (const key of PAPER_FIELDS) {
    if (key === 'title') continue
    const value = item[key]
    if (key === 'authors') paper.authors = authorsOf(value)
    else if (key === 'keywords') paper.keywords = keywordsOf(value)
    else if (key === 'citations' || key === 'downloads') paper[key] = countOf(value)
    else if (key === 'snippet') paper.snippet = snippetOf(value)
    else paper[key] = typeof value === 'string' ? value.trim() : ''
  }
  return paper
}

/**
 * 规整整份题录。导出它，是因为路由层也要在造书前判断「到底有没有可收的条目」，
 * 两处用同一套规则才不会出现「路由说有空、造书说没有」。
 *
 * @param {any} items
 * @returns {Array<object>}
 */
export function sanitizePaperItems(items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const item of items) {
    const paper = sanitizePaper(item)
    if (paper) out.push(paper)
    if (out.length >= MAX_PAPER_ITEMS) break
  }
  return out
}

/** 书名：trim 后为空就退回默认名。 */
export function normalizePaperTitle(raw) {
  const title = typeof raw === 'string' ? raw.trim() : ''
  return title === '' ? DEFAULT_PAPER_TITLE : title
}

/** 章节文件名：1 起、三位补零。固定形态才能让同一份题录每次得到同样的地址。 */
function chapterFileName(index) {
  return `text/ch${String(index + 1).padStart(3, '0')}.xhtml`
}

/**
 * 造一章的 XHTML。
 *
 * 模板是固定的；字段缺失时**省略整行**，不留「· · 」这种空悬挂。
 */
function buildChapterXhtml(paper) {
  const authors = paper.authors.length > 0 ? paper.authors.join('、') : '作者未标注'
  const source = [paper.journal, paper.issue].map((part) => String(part ?? '').trim()).filter((part) => part !== '')
  const metaParts = [authors]
  if (source.length > 0) metaParts.push(source.join(' '))
  metaParts.push(`被引 ${paper.citations}`)
  metaParts.push(`下载 ${paper.downloads}`)

  const body = []
  body.push(`<h1>${escapeHtml(paper.title)}</h1>`)
  body.push(`<p>${escapeHtml(metaParts.join(' · '))}</p>`)
  if (paper.type !== '') body.push(`<p>文献类型：${escapeHtml(paper.type)}</p>`)
  if (paper.keywords.length > 0) {
    body.push(`<p>关键词：${escapeHtml(paper.keywords.join(' / '))}</p>`)
  }
  if (paper.url !== '') body.push(`<p>原文：${escapeHtml(paper.url)}</p>`)
  body.push('<h2>摘要片段</h2>')
  body.push(`<p>${escapeHtml(paper.snippet !== '' ? paper.snippet : SNIPPET_MISSING)}</p>`)
  body.push(`<p>${escapeHtml(SNIPPET_NOTICE)}</p>`)

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml"><head>' +
    `<title>${escapeHtml(paper.title)}</title></head>\n` +
    `<body>\n${body.join('\n')}\n</body></html>`
  )
}

/** nav 文档：目录项的文字必须是中文题名，否则书架上点目录只能看到 c1/c2。 */
function buildNavXhtml(title, papers) {
  const items = papers
    .map((paper, index) => `<li><a href="${chapterFileName(index)}">${escapeHtml(paper.title)}</a></li>`)
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
    `<head><title>${escapeHtml(title)}</title></head>\n` +
    '<body>\n<nav epub:type="toc" id="toc"><h1>目录</h1><ol>' +
    `${items}</ol></nav>\n</body></html>`
  )
}

/**
 * content.opf。
 *
 * `dc:identifier` 由书名 + 全部题名算出来，不含时间与随机数：同样的题录出版
 * 同一本书（同一哈希），重复导入就只是覆盖，不会在书架里堆两本一模一样的书。
 */
function buildOpf(title, papers, identifier) {
  const manifest = papers
    .map(
      (paper, index) =>
        `<item id="c${index + 1}" href="${chapterFileName(index)}" media-type="application/xhtml+xml"/>`,
    )
    .join('')
  const spine = papers.map((paper, index) => `<itemref idref="c${index + 1}"/>`).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeHtml(title)}</dc:title>` +
    '<dc:creator>知网检索</dc:creator>' +
    `<dc:identifier id="bookid">${escapeHtml(identifier)}</dc:identifier>` +
    '<dc:language>zh-CN</dc:language>' +
    '</metadata>' +
    '<manifest>' +
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    `${manifest}</manifest>` +
    `<spine>${spine}</spine>` +
    '</package>'
  )
}

const CONTAINER_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
  '</rootfiles></container>'

/**
 * 题录数组 → EPUB 字节。
 *
 * 纯函数：不读时钟、不碰文件系统、不联网。同一份 `{title, items}` 两次调用
 * 得到的 Buffer 逐字节相同（`Buffer.compare === 0`），这是书架哈希成立的前提。
 *
 * @param {{ title?: string, items?: any[] }} input
 * @returns {Buffer}
 */
export function buildPaperEpub(input = {}) {
  const title = normalizePaperTitle(input?.title)
  const papers = sanitizePaperItems(input?.items)
  if (papers.length === 0) {
    throw fail('E_PAPER_COLLECT', '没有可收集的文献：先勾选几条检索结果。', {
      detail: `items=${Array.isArray(input?.items) ? input.items.length : 'not-array'} usable=0`,
    })
  }

  const identifier =
    'urn:dsh-reading:papers:' +
    createHash('sha256')
      .update(`${title}\n${papers.map((paper) => paper.title).join('\n')}`, 'utf8')
      .digest('hex')
      .slice(0, 32)

  const entries = [
    // mimetype 必须是第一个条目、且不压缩 —— EPUB 规范里唯一硬性的结构要求。
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'OEBPS/nav.xhtml', data: buildNavXhtml(title, papers) },
    { name: 'OEBPS/content.opf', data: buildOpf(title, papers, identifier) },
  ]
  papers.forEach((paper, index) => {
    entries.push({ name: `OEBPS/${chapterFileName(index)}`, data: buildChapterXhtml(paper) })
  })

  // 时间戳固定：writeZip 默认就是 2020-01-01，显式传一遍是为了让「为什么不带当前时间」
  // 这件事在代码里看得见。
  return writeZip(entries, { mtime: new Date(Date.UTC(2020, 0, 1, 0, 0, 0)) })
}

/**
 * 造书并入库，返回 `{ bookHash, title }`。
 *
 * 入库走的是与手动导入完全相同的那条通道（`store.importBook`），因此新书立刻
 * 拥有封面兜底、进度、标注、CFI 这些能力，不需要为「文献集」单开一套。
 *
 * @param {{ importBook: Function }} store
 * @param {{ title?: string, items?: any[] }} input
 * @returns {Promise<{ bookHash: string, title: string }>}
 */
export async function collectPapers(store, input = {}) {
  const title = normalizePaperTitle(input?.title)
  const bytes = buildPaperEpub({ title, items: input?.items })
  const result = await store.importBook({ filename: '文献集.epub', dataBase64: bytes.toString('base64') })
  return { bookHash: String(result?.bookHash ?? ''), title }
}
