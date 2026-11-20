/**
 * 知网老版检索站（search.cnki.com.cn）的解析与请求层。
 *
 * 为什么单独一个文件：知网没有公开 API，能白拿题录的只有一个老检索站，
 * 它返回的是一段 HTML 片段而不是 JSON。把「HTML → 结构化题录」写成纯函数，
 * 才能不联网测解析；把「发请求」单独隔开，测试才能注入假 fetch。
 *
 * 能拿到：标题、作者、期刊、年期、文献类型、关键词、被引、下载、题录网址、
 * 正文开头约 160 字（注意：不是完整摘要，知网免费页面恒定截断）。
 * 拿不到：完整摘要、PDF 全文——那两样都要登录，本插件不碰登录态。
 *
 * 站点结构是二十年前的老页面，靠 class 名定位；改版会让它抽不到东西，
 * 这时 parseCnkiResults 返回空列表而不是抛错，由上层给「没搜到」的提示。
 */

import { decodeEntities } from './sources.js'
import { fail } from './errors.js'

/** 检索接口。只用这一个入口，/api/ 那个变体实测恒定 504。 */
export const CNKI_SEARCH_URL = 'https://search.cnki.com.cn/search/listresult'

/** 来源页地址。知网会看 referer，缺了偶尔给空壳。 */
export const CNKI_REFERER = 'https://search.cnki.com.cn/Search/Result'

/** 单页固定 20 条，解析上限也按这个数。 */
export const PAGE_SIZE = 20

/**
 * 翻页上限。站点自身能翻到 500 页，但对「找文献」这个用途来说 20 页（400 条）
 * 已经远超人的判断能力；不设上限只会让用户一路点下去、把对方站点打疼。
 */
export const MAX_PAGE = 20

/** 关键词长度上限。再长的输入不是检索词，是误粘贴。 */
export const MAX_QUERY_CHARS = 100

/** 摘要片段长度上限（按字符算，不是字节）。 */
export const MAX_SNIPPET_CHARS = 160

/** 与浏览器一致的 UA。用库名/版本会被当成爬虫拦。 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * 规整用户输入：去首尾空白、压内部连续空白、按字符截断到 100。
 *
 * 为什么按「字符」不按 length：一个汉字在 JS 里 length 是 1，但表情是 2，
 * 用 Array.from 才能保证截出来的字不会被劈成半个代理对。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeCnkiQuery(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return ''
  return Array.from(trimmed).slice(0, MAX_QUERY_CHARS).join('')
}

/** 把 page 夹到 [1, MAX_PAGE]；非数字一律当 1。 */
function clampPage(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(number)))
}

/** 把 order 夹到 [1, 4]；非数字一律当 4（被引降序，最常用）。 */
function clampOrder(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 4
  return Math.min(4, Math.max(1, Math.floor(number)))
}

/**
 * 参数 → 表单请求体。
 *
 * 字段名是站点自己的约定：title 对应 `Title`，content 对应小写 `content`
 * （两者大小写不同不是笔误，是站点就这么接收的）。`Year` 只认四位数年份，
 * 传 `2024-01-01` 会得到 0 条，所以这里只放行四位数字。
 *
 * @param {{ query?: unknown, field?: unknown, order?: unknown, year?: unknown, page?: unknown }} params
 * @returns {string} URLSearchParams 序列化后的字符串
 */
export function buildSearchBody(params = {}) {
  const query = normalizeCnkiQuery(params.query)
  if (query === '') {
    throw fail('E_PAPER_QUERY', '请输入要检索的关键词。', {
      detail: 'normalizeCnkiQuery returned empty',
    })
  }
  const field = params.field === 'content' ? 'content' : 'Title'
  const order = clampOrder(params.order)
  const page = clampPage(params.page)
  const year = String(params.year ?? '').trim()

  const body = new URLSearchParams()
  body.set(field, query)
  body.set('Order', String(order))
  if (/^\d{4}$/.test(year)) body.set('Year', year)
  body.set('page', String(page))
  return body.toString()
}

/**
 * 取 html 里第一个带某 class 的元素的内部 HTML。
 *
 * 为什么不用「非贪婪到第一个 </xx>」：`<p class="tit">` 里套着 `<a>`，
 * 非贪婪会在第一个 `</a>` 就截断，拿到的只是半个标题块。这里按标签名做
 * 深度配平：同名的开始/结束标签计数，数到 0 才是这个元素的结尾，
 * 也顺手支持同名标签嵌套（比如列表里套列表）。
 *
 * @param {string} html
 * @param {string} className 单个 class 名
 * @returns {string} 内部 HTML；找不到元素时返回空串
 */
function innerByClass(html, className) {
  const tagPattern = /<([a-z]+)\b([^>]*)>/gi
  const wanted = new RegExp(`(^|\\s)${className}(\\s|$)`)
  let match
  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1].toLowerCase()
    const attrs = match[2]
    if (!/\bclass\s*=/i.test(attrs)) continue
    if (!wanted.test(attrOf(attrs, 'class'))) continue

    const innerStart = tagPattern.lastIndex
    const scan = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi')
    scan.lastIndex = innerStart
    let depth = 1
    let step
    while ((step = scan.exec(html)) !== null) {
      if (step[0][1] === '/') {
        depth -= 1
        if (depth === 0) return html.slice(innerStart, step.index)
      } else {
        depth += 1
      }
    }
    // 没有收尾标签：当成到文件末尾，返回能拿到的部分。
    return html.slice(innerStart)
  }
  return ''
}

/** 剥标签 + 解实体 + 压空白。 */
function plainText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从属性串里取一个属性值。 */
function attrOf(attrs, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  const match = pattern.exec(attrs)
  if (!match) return ''
  return match[1] ?? match[2] ?? ''
}

/**
 * 标题：`p.tit` 里那个 class 含 left 且带 title 的 a。
 *
 * 为什么不用「第一个 a」：下载按钮也是 a、也带 left，它的 title 是「下载」，
 * 直接取第一个 a 会把「下载」当标题。标题里命中词被红 span 包着，
 * 属性值里也可能带这层标签，所以取到后还要剥一遍。
 */
function pickTitle(block) {
  const tit = innerByClass(block, 'tit') || block
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(tit)) !== null) {
    const attrs = match[1]
    const classValue = attrOf(attrs, 'class')
    if (!/\bleft\b/i.test(classValue)) continue
    const rawTitle = attrOf(attrs, 'title')
    // 下载按钮：class 同样含 left，靠这个排除。
    if (rawTitle === '下载') continue
    const href = attrOf(attrs, 'href')
    const title = normalizeCnkiTitle(rawTitle || match[2])
    if (title === '') continue
    return { title, url: normalizeCnkiUrl(href) }
  }
  return { title: '', url: '' }
}

/**
 * 标题清洗：剥标签（不补空格，命中词的红 span 可能切在词中间）、解实体、
 * 压空白，再去掉尾巴上的 `CNKI文献` 与 `&nbsp;&nbsp;`。
 */
function normalizeCnkiTitle(value) {
  const text = decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.replace(/\s*CNKI\s*文献\s*$/i, '').trim()
}

/**
 * 详情页地址归一：协议相对地址补 https:，其余只放行 http(s)。
 *
 * 为什么要有白名单：这个 url 会被客户端直接 `window.open`。解析层是「照抄 HTML
 * 属性」的，只要响应里出现 `javascript:...` 这类 href，原样透出就等于给页面
 * 塞了一个可点的脚本地址。不认识的协议返回空串，客户端那边 url 为空时按钮本来就是
 * 禁用的，所以不用改前端。
 */
function normalizeCnkiUrl(href) {
  const value = String(href ?? '').trim()
  if (value === '') return ''
  const absolute = value.startsWith('//') ? `https:${value}` : value
  return /^https?:/i.test(absolute) ? absolute : ''
}

/** 作者：p.source 里带非空 data-key 的 a 的标签内文字（data-key="" 是占位空 a）。 */
function pickAuthors(source) {
  const authors = []
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = pattern.exec(source)) !== null) {
    const key = attrOf(match[1], 'data-key')
    if (key === '') continue
    const name = plainText(match[2])
    if (name !== '') authors.push(name)
  }
  return authors
}

/** 期刊名：p.source 里第一个《...》。学位论文没有，返回空串。 */
function pickJournal(source) {
  const match = /《([^》]+)》/.exec(source)
  return match ? plainText(match[1]) : ''
}

/**
 * 年期或日期：p.source 里 `<span>` 包住的 `2007年03期` 或 `2021-03-13`。
 * 只认这两种形态；别把期刊名里的数字当成年期。
 */
function pickIssue(source) {
  const patterns = [
    /<span\b[^>]*>\s*(\d{4}\s*年\s*\d+\s*期)\s*<\/span>/i,
    /<span\b[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (match) return plainText(match[1])
  }
  return ''
}

/**
 * 文献类型：p.source 里最后一个 span 的文字（期刊 / 硕士论文 / 博士论文 / 中国会议）。
 * 为什么取最后一个：前面几个 span 分别是作者块、刊名、年期，类型固定收尾。
 */
function pickType(source) {
  const spans = []
  const pattern = /<span\b[^>]*>([\s\S]*?)<\/span>/gi
  let match
  while ((match = pattern.exec(source)) !== null) spans.push(plainText(match[1]))
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (spans[index] !== '') return spans[index]
  }
  return ''
}

/**
 * 关键词：p.info_left 里第一个 data-key 的全串，按 `/` 拆。
 * 为什么取属性不取文字：每个词一个 a，文字只有单个词；属性才是完整关键词串。
 */
function pickKeywords(block) {
  const info = innerByClass(block, 'info_left')
  if (info === '') return []
  const match = /\bdata-key\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(info)
  const raw = match ? match[1] ?? match[2] ?? '' : ''
  if (raw === '') return []
  return raw
    .split('/')
    .map((keyword) => plainText(keyword))
    .filter((keyword) => keyword !== '')
}

/** 数字统计：span.time1（下载）/ span.time2（被引）里的第一个数字。 */
function pickCount(block, className) {
  const pattern = new RegExp(
    `<span\\b[^>]*class\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`,
    'i',
  )
  const match = pattern.exec(block)
  if (!match) return 0
  const digits = /\d+/.exec(match[1])
  return digits ? Number(digits[0]) : 0
}

/**
 * 正文开头片段：p.nr 的文字，压空白后截前 160 字。
 *
 * 这里剥标签用空串而不是空格：命中词的红色 span 常常切在一个词中间
 * （`大型<span>滑坡</span>`），补空格会把「大型滑坡」拆成「大型 滑坡」。
 * 段落之间的换行本来就有空白，压一次就够。
 */
function pickSnippet(block) {
  const raw = innerByClass(block, 'nr')
  if (raw === '') return ''
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(text).slice(0, MAX_SNIPPET_CHARS).join('')
}

/** 知网文件名：块尾 div.checkbox1 上的 data-fn。 */
function pickFn(block) {
  const pattern = /<div\b[^>]*class\s*=\s*"[^"]*\bcheckbox1\b[^"]*"[^>]*>/i
  const match = pattern.exec(block)
  if (!match) return ''
  return attrOf(match[0], 'data-fn').trim()
}

/** 按 `<div class="list-item">` 切块。不能用 checkbox1 收尾——它是块内最后一个 div。 */
function splitBlocks(html) {
  const opening = /<div\b[^>]*class\s*=\s*"[^"]*\blist-item\b[^"]*"[^>]*>/gi
  const blocks = []
  let match
  let start = -1
  while ((match = opening.exec(html)) !== null) {
    if (start >= 0) blocks.push(html.slice(start, match.index))
    start = match.index + match[0].length
  }
  if (start >= 0) blocks.push(html.slice(start))
  return blocks
}

/**
 * 解析一页检索结果。
 *
 * 纯函数：不联网、不读时钟、不加随机。坏输入（404 页面、JS 报错页、空串）
 * 一律返回空列表而不是抛错——上层拿到的是「这次没搜到」，可以照常渲染。
 *
 * @param {unknown} html 知网 listresult 返回的 HTML 片段
 * @returns {{ items: Array<object>, empty: boolean }}
 */
export function parseCnkiResults(html) {
  const source = typeof html === 'string' ? html : ''
  if (source === '') return { items: [], empty: false }
  // 空结果有自己的形态：no-result 块。它和「解析失败」必须区分开，
  // 否则界面没法说清「这个词没文献」和「站点改版了」。
  if (/class\s*=\s*"[^"]*\bno-result\b[^"]*"/i.test(source)) {
    return { items: [], empty: true }
  }

  const items = []
  for (const block of splitBlocks(source)) {
    const sourceBlock = innerByClass(block, 'source')
    const { title, url } = pickTitle(block)
    if (title === '' && url === '') continue
    items.push({
      title,
      url,
      fn: pickFn(block),
      authors: pickAuthors(sourceBlock),
      journal: pickJournal(sourceBlock),
      issue: pickIssue(sourceBlock),
      type: pickType(sourceBlock),
      keywords: pickKeywords(block),
      citations: pickCount(block, 'time2'),
      downloads: pickCount(block, 'time1'),
      snippet: pickSnippet(block),
    })
  }
  return { items, empty: false }
}

/**
 * 向知网发一次检索请求并解析。
 *
 * fetch 允许注入（`deps.fetch`），测试给假 fetch 就能脱网跑；
 * 生产环境走 globalThis.fetch，不引任何 HTTP 库。
 *
 * @param {{ query?: unknown, field?: unknown, order?: unknown, year?: unknown, page?: unknown }} params
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [deps]
 * @returns {Promise<{ items: Array<object>, empty: boolean, page: number, hasMore: boolean, source: string }>}
 */
export async function searchCnki(params = {}, deps = {}) {
  const body = buildSearchBody(params)
  const page = clampPage(params.page)
  const doFetch = deps.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw fail('E_PAPER_FETCH', '当前环境没有可用的网络请求能力，检索不了知网。', {
      detail: 'globalThis.fetch is not a function',
    })
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 20000
  let response
  try {
    response = await doFetch(CNKI_SEARCH_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': USER_AGENT,
        referer: CNKI_REFERER,
        accept: 'text/html, */*; q=0.01',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw fail('E_PAPER_FETCH', '连不上知网，可能是网络不通或对方站点暂时不可用。', {
      detail: `fetch failed: ${String(error?.message ?? error)}`,
    })
  }

  if (!response || typeof response.ok !== 'boolean') {
    throw fail('E_PAPER_FETCH', '知网返回了无法识别的内容。', {
      detail: 'response is not a fetch Response',
    })
  }
  if (!response.ok) {
    throw fail('E_PAPER_FETCH', `知网返回了 ${response.status}，稍后再试。`, {
      detail: `status ${response.status}`,
    })
  }

  let html = ''
  try {
    html = await response.text()
  } catch (error) {
    throw fail('E_PAPER_FETCH', '读取知网结果的时候断了，重试一次。', {
      detail: `read failed: ${String(error?.message ?? error)}`,
    })
  }

  const { items, empty } = parseCnkiResults(html)
  return {
    items,
    empty,
    page,
    // 满一页且没到上限，才认为后面还有；空结果和新版站点改版都不该给「下一页」。
    hasMore: !empty && items.length >= PAGE_SIZE && page < MAX_PAGE,
    source: 'cnki',
  }
}
