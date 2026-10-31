/**
 * HTTP 路由：`/api/dsh-reading/**`。
 *
 * 两条硬约束（docs/05 §3.3 / §3.4，改动前先读原文）：
 *
 * 1. **只注册一条 prefix 路由** `/api/dsh-reading`，内部按 `method + path` 分派。
 *    不注册 `/plugins/*`——那是 client-modules 的地盘，会撞。
 * 2. 章节响应必须 `application/xhtml+xml` + `script-src 'none'`，且**原样输出**
 *    XHTML：唯一允许的改动是把相对 `src`/`href` 的属性值换成指向本站资源的地址，
 *    不重排属性、不美化缩进、不增删节点。原因写在 docs/05 §3.4：DOM 结构一变，
 *    CFI 立刻错位，而那是静默错位（看起来正常，高亮跑到别的段落）。
 * 3. 上面第 2 条有**两个记录在案的安全例外**（docs/07 §H3）：
 *      a. `<meta http-equiv="refresh">` 与 `<base>` 整条丢弃 —— 它们能让书里的内容
 *         把 iframe 导航到外部地址（帧内导航不受顶层导航限制），是恶意 EPUB 的外联口；
 *      b. `<a href>` 改成 `#dsh-reading:<原文>` —— 不改会让点击把 iframe 带去加载
 *         一份裸 XHTML 字节，阅读界面直接散架；改成不导航的锚，同时把原地址留在
 *         fragment 里（上层将来要接管跳转时还拿得到）。
 *    两者都不改变元素/文本节点的层级，因此不影响 CFI 索引；routes_test 里有
 *    「正文与节点序完全不变」的回归断言钉住这一点。
 * 4. 标签边界必须**按引号判断**（`findTagEnd`），不能用 `/<[A-Za-z][^>]*>/`：
 *    属性值里合法地能出现 `>`，正则会在那里截断，那条标签的 `src` 就改不到。
 *
 * 测试可跑性：路由分派被抽成纯函数 `createHandler({ store })`，不依赖真实端口，
 * 测试里给一个最小 req/res 就能断言。`registerRoutes` 只负责把 handler 挂到
 * `ctx.webServer` 上并返回 disposer。
 *
 * 什么时候会失败、失败给谁看：
 *   - 路径穿越（href 含 `..`、以 `/` 或 `\` 开头）→ 400 + 中文文案；
 *   - 书不存在 / 章节不存在 → 404；内部异常 → 500，且**不回显**内部字段名与路径；
 *   - 所有失败响应形状固定 `{ ok:false, error:{ code, message } }`，客户端只认这个。
 */

import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { fail, publicError } from './errors.js'
import { bookDirName } from './paths.js'
import { detectFormat } from './bookformat.js'
import { buildSearchUrl, ensureExtension, extractCandidates, guessFilename } from './sources.js'
import { parseSourceList, searchSource } from './legado.js'
import { probeAi } from './aistatus.js'
import { modelCatalogOf, pickSelection, effortLabel, EFFORT_ORDER, DEFAULT_EFFORT } from './aimodel.js'
import { resolveRoute } from './ask.js'
import {
  buildChapterPrompt,
  buildSkeletonPrompt,
  emptyState,
  mergeChapter,
  parseChapterReply,
  parseSkeletonReply,
  progressOf,
  toMarkdown,
  verifyChapterQuotes,
} from './distill.js'

/** 统一前缀。改这里必须同步改客户端 `api.js` 的 API_BASE。 */
/** 一次搜索最多同时打几个书源站点。 */
const LEGADO_SEARCH_CONCURRENCY = 6

export const API_PREFIX = '/api/dsh-reading'

/** 章节响应的固定头（docs/05 §3.4，逐字照抄）。 */
export const CHAPTER_HEADERS = Object.freeze({
  'content-type': 'application/xhtml+xml; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline' 'self'; font-src 'self' data:; script-src 'none'",
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, max-age=300',
})

/** 普通 JSON 响应的固定头：书库数据是本地私事，不许中间层缓存。 */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
})

// ── 响应工具 ──────────────────────────────────────────────────────

/**
 * 写 JSON。同时兼容真 res 与测试里的最小 mock（只要有 writeHead/end 或 setHeader/end）。
 * @param {any} res
 * @param {number} status
 * @param {unknown} value
 */
export function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  const headers = { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) }
  send(res, status, headers, body)
}

/** 写成功响应 `{ ok:true, value }`。 */
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** 写失败响应 `{ ok:false, error:{ code, message } }`。 */
function writeError(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** 把异常落成响应；内部异常的细节只进日志。 */
function writeFailure(res, error, logger) {
  const info = publicError(error)
  if (info.status >= 500) {
    // 5xx 一定是 bug 或环境问题，必须留痕；但 detail 不进响应。
    logger.warn('[dsh-reading] 请求处理失败：', String(error?.detail || error?.message || error))
  }
  writeError(res, info.status, info.code, info.message)
}

function send(res, status, headers, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, { ...headers, 'content-length': payload.length })
  } else {
    res.statusCode = status
    if (typeof res.setHeader === 'function') {
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
    }
  }
  res.end(payload)
}

// ── 入参解析 ──────────────────────────────────────────────────────

/**
 * 读请求体。上限由调用方给（导入接口要能装下一整本 base64 的书）。
 *
 * 支持三种 req：Node IncomingMessage（异步可迭代）、测试里带 `.body` 的对象、
 * 以及已经解析好的对象。这样同一份 handler 在真服务与单测里跑的是同一条代码路径。
 *
 * @param {any} req
 * @param {number} limit
 * @returns {Promise<any>}
 */
export async function readBody(req, limit = 1024 * 1024) {
  if (req && typeof req === 'object' && req.body !== undefined && typeof req[Symbol.asyncIterator] !== 'function') {
    return req.body
  }
  const stream = req && typeof req[Symbol.asyncIterator] === 'function' ? req : Readable.from([])
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) {
      throw fail('E_BODY_TOO_BIG', '提交的内容太大了，请缩小后再试。', { detail: `body=${size} limit=${limit}` })
    }
    chunks.push(buf)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    throw fail('E_BAD_BODY', '提交的内容格式不对，请重试一次。', {
      detail: `json parse failed: ${String(error?.message ?? error)}`,
      cause: error,
    })
  }
}

/** 取 `book` 查询参数（GET）或 body.bookHash（POST），统一成 16 位目录名。 */
function requireBook(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') {
    throw fail('E_BAD_BOOK_HASH', '这本书的标识不对，可能链接失效了。', { detail: 'empty book id' })
  }
  return bookDirName(value)
}

/**
 * 把请求体里的封面解成字节（0.4.0）。
 *
 * 认三种写法：
 *   - `dataUrl`：完整 `data:image/png;base64,...`（客户端 canvas.toDataURL 的主路径）
 *   - `dataBase64`：裸 base64（命令行、测试方便）
 *   - `data`：同裸 base64（个别客户端的历史写法）
 *
 * 这里**不校验图片类型**：类型由 store 按文件头魔数判（扩展名与 dataURL 里的
 * MIME 都是客户端自己写的，不可信）。只负责「把 base64 变成一个 Buffer」。
 */
function decodeCoverPayload(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  let base64 = ''
  if (typeof source.dataUrl === 'string' && source.dataUrl !== '') {
    const match = /^data:[^,]*;base64,(.*)$/s.exec(source.dataUrl)
    if (!match) {
      throw fail('E_ARGS', '封面数据不完整，请重新选择一次。', { status: 400 })
    }
    base64 = match[1]
  } else if (typeof source.dataBase64 === 'string' && source.dataBase64 !== '') {
    base64 = source.dataBase64
  } else if (typeof source.data === 'string' && source.data !== '') {
    base64 = source.data
  }
  const cleaned = base64.replace(/\s+/g, '')
  if (cleaned === '') {
    throw fail('E_ARGS', '没有收到封面图片，请重新选择一次。', { status: 400 })
  }
  const bytes = Buffer.from(cleaned, 'base64')
  if (bytes.length === 0) {
    throw fail('E_ARGS', '封面数据不完整，请重新选择一次。', { status: 400 })
  }
  return bytes
}

/**
 * 校验一个书内 href。
 *
 * 这是**唯一的路径穿越入口**，所以判据写成「白名单式」而不是「黑名单式」：
 * 拒绝绝对路径、盘符、反斜杠、以及任何 `..` 段；含 NUL 或控制字符也拒绝。
 * 拒绝后返回 400（不是 404）——请求本身不合法，不是资源不存在。
 *
 * @param {unknown} raw
 * @returns {string} 已 trim 的原始 href（解析留给 epub 层，那边还有一次越界检查）
 */
export function requireHref(raw) {
  const value = String(raw ?? '').trim()
  const reject = (detail) =>
    fail('E_BAD_PATH', '这个地址不合法，打不开。', { status: 400, detail })

  if (value === '') throw reject('empty href')
  if (value.includes('\u0000')) throw reject('NUL in href')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) throw reject('control char in href')
  if (value.startsWith('/') || value.startsWith('\\')) throw reject(`absolute href: ${value.slice(0, 80)}`)
  if (/^[A-Za-z]:[\\/]/.test(value)) throw reject(`drive path: ${value.slice(0, 80)}`)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw reject(`scheme in href: ${value.slice(0, 80)}`)

  // 逐段检查 `..`：既要挡 `../x`，也要挡 `a/../../x` 与百分号编码后的 `%2e%2e`。
  // 先做一次宽松解码（只处理 %2e/%2f/%5c），避免 `%2E%2E` 绕过。
  const decoded = value.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '\\')
  if (decoded.includes('\\')) throw reject(`backslash in href: ${value.slice(0, 80)}`)
  for (const segment of decoded.split('/')) {
    if (segment === '..' || segment === '.') throw reject(`dot segment in href: ${value.slice(0, 80)}`)
  }
  if (value.includes('..')) throw reject(`dotdot in href: ${value.slice(0, 80)}`)
  return value
}

/**
 * 把章节里的相对 `src`/`href` 属性值换成指向本站资源地址。
 *
 * 只改属性值，一个字节的其它内容都不动（docs/05 §3.4）。判据：
 *   - 空值 / `#frag` / `data:` / `mailto:` / 其它带 scheme 的绝对地址 → 不碰；
 *   - 以 `//` 开头的协议相对地址 → 不碰（它指向外部主机）；
 *   - 其余相对地址 → 解析成「相对 OPF 根」的路径后包进 asset URL。
 * 解析失败（越出 OPF 根）保持原样：这里不是安全边界，asset 路由才是。
 *
 * @param {string} html
 * @param {{ book: string, chapterHref: string, resolve: (chapterHref: string, raw: string) => string|null }} context
 * @returns {string}
 */
export function rewriteChapterAssets(html, context) {
  const attrPattern = /(\s)(src|href|xlink:href)(\s*=\s*)("([^"]*)"|'([^']*)')/gi
  // 逐标签改写：只在标签内部动手，正文里的 `href="..."` 字样（例如代码示例）不受影响。
  return mapTags(html, (tag) => {
    // 带命名空间前缀的标签（`xhtml:meta`、`svg:a`）按本地名判，否则前缀一写就绕过。
    const name = tagNameOf(tag).replace(/^[^:]*:/, '')
    // `<base>` 会改写整个文档的相对地址基准，`<meta http-equiv=refresh>` 会让
    // iframe 自己跳到外部地址——两者都能让书里的内容把阅读界面带出去（sandbox 没给
    // allow-top-navigation，但**帧内**导航是允许的）。这里直接整条丢掉，属 §3.4
    // 「原样输出」的**唯一例外**，理由见文件头第 3 条。
    if (name === 'base') return ''
    if (name === 'meta' && META_REFRESH.test(tag)) return ''
    // `<area>` 和 `<a>` 一样是可导航元素；SVG 里的 `<a>` 用 `xlink:href`，按本地名认。
    const isAnchor = name === 'a' || name === 'area'
    return tag.replace(attrPattern, (whole, space, attrName, eq, quoted, doubleValue, singleValue) => {
      const value = doubleValue !== undefined ? doubleValue : singleValue
      const quote = doubleValue !== undefined ? '"' : "'"
      const localName = attrName.toLowerCase().replace(/^[^:]*:/, '')
      // 书内链接（脚注、章间跳转）不能改成 /asset：点了会让 iframe 去加载一份
      // 裸 XHTML/CSS 字节，阅读界面当场变成一堆标签。改成「不导航的锚」并把原地址
      // 编进 fragment，既不丢信息也不许 iframe 跳出当前文档。
      if (isAnchor && localName === 'href') {
        if (value === '' || value.startsWith('#')) return whole
        return `${space}${attrName}${eq}${quote}#dsh-reading:${encodeURIComponent(value)}${quote}`
      }
      const replaced = rewriteOne(value, context)
      if (replaced === null) return whole
      return `${space}${attrName}${eq}${quote}${escapeAttr(replaced)}${quote}`
    })
  })
}

/** 标签名（小写）；拿不到就返回空串。 */
function tagNameOf(tag) {
  const match = /^<([A-Za-z][^\s/>]*)/.exec(tag)
  return match ? match[1].toLowerCase() : ''
}

/** `<meta http-equiv="refresh" …>` 的判据（属性顺序、引号风格都不定）。 */
const META_REFRESH = /http-equiv\s*=\s*["']?\s*refresh/i

/**
 * 找出标签的结束位置（`>` 之后的下标），**引号内的 `>` 不算**。
 *
 * 为什么不用 `/<[A-Za-z][^>]*>/g`：属性值里合法地能出现 `>`，例如
 * `<img alt="a > b" src="x.png">`。正则会在 `a >` 处截断，那条 `src` 就改不到，
 * 图片 404——而且只在带 `>` 的属性值上出现，属于最难复现的那类。
 *
 * @returns {number} 结束下标；没有闭合返回 -1
 */
function findTagEnd(html, from) {
  let quote = ''
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i + 1
  }
  return -1
}

/** 把每个标签交给 `visit` 处理；返回替换后的整篇文本。 */
function mapTags(html, visit) {
  let out = ''
  let cursor = 0
  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor)
    if (lt < 0) {
      out += html.slice(cursor)
      break
    }
    // `<!--`、`<!DOCTYPE`、`<` 后跟非字母：当成普通文本原样带走。
    if (!/[A-Za-z]/.test(html[lt + 1] ?? '')) {
      out += html.slice(cursor, lt + 1)
      cursor = lt + 1
      continue
    }
    const end = findTagEnd(html, lt + 1)
    if (end < 0) {
      // 没闭合的标签：剩下的全是正文，别再当标签解析。
      out += html.slice(cursor)
      break
    }
    out += html.slice(cursor, lt) + visit(html.slice(lt, end))
    cursor = end
  }
  return out
}

/** 单个属性值的改写；返回 null 表示保持原样。 */
function rewriteOne(value, context) {
  if (value === '') return null
  if (value.startsWith('#')) return null
  if (value.startsWith('//')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null
  // 已经指到本站的地址：幂等，不重复包一层。
  if (value.startsWith(API_PREFIX)) return null
  const resolved = context.resolve(context.chapterHref, value)
  if (resolved === null) return null
  const base = value.indexOf('#')
  const fragment = base >= 0 ? value.slice(base) : ''
  return `${API_PREFIX}/asset?book=${encodeURIComponent(context.book)}&href=${encodeURIComponent(resolved)}${fragment === '' ? '' : `#${fragment.slice(1)}`}`
}

/** 属性值里的 `&` 不转义会让浏览器把 `&href=` 当成实体；这里只处理最小必要集合。 */
function escapeAttr(value) {
  return value.replace(/&(?!(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);)/g, '&amp;')
}

/**
 * CSS 里的相对 `url(...)` 同样要改写，否则自定义字体与背景图会 404。
 * 只对 `text/css` 的响应做，不影响章节 XHTML 的「原样输出」约束。
 *
 * @param {string} css
 * @param {{ book: string, baseHref: string, resolve: (baseHref: string, raw: string) => string|null }} context
 * @returns {string}
 */
export function rewriteCssUrls(css, context) {
  return css.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi, (whole, _all, doubleValue, singleValue, bare) => {
    const value = doubleValue ?? singleValue ?? bare ?? ''
    if (value === '' || value.startsWith('#') || value.startsWith('data:') || value.startsWith('//')) return whole
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return whole
    const resolved = context.resolve(context.baseHref, value)
    if (resolved === null) return whole
    return `url("${`${API_PREFIX}/asset?book=${encodeURIComponent(context.book)}&href=${encodeURIComponent(resolved)}`}")`
  })
}

// ── 业务方法表（POST /api/dsh-reading/<method>） ──────────────────

/**
 * 建方法表。每个方法只做「取参数 → 调 store → 返回 value」，
 * 错误一律抛，由最外层统一落成响应。
 *
 * @param {import('./store.js').LibraryStore} store
 */
function buildMethods(store, config, ask, extras = {}, env = {}) {
  // `env.ctx` 是宿主上下文（只在真实运行时存在）。纯函数 handler 的测试里是 null，
  // 所以凡是碰宿主服务的路由都必须能降级——`ai.models` 就是第一个。
  const ctx = env.ctx ?? null
  return {
    'device.info': async () => ({ deviceId: await store.getDeviceId() }),

    'shelf.list': async () => store.listShelf(),

    'shelf.import': async (body) =>
      store.importBook({
        filename: typeof body?.filename === 'string' ? body.filename : '',
        dataBase64: typeof body?.dataBase64 === 'string' ? body.dataBase64 : '',
      }),

    // 「粘贴链接导入」（0.5.1）：下载 → 嗅探格式 → 补扩展名 → 交给同一个导入通道。
    // 返回值与 shelf.import 完全一致，客户端不需要分两套。
    'shelf.importUrl': async (body) => {
      const raw = typeof body?.url === 'string' ? body.url.trim() : ''
      if (!/^https?:\/\//i.test(raw)) {
        throw fail('E_IMPORT_URL_BAD', '这个链接打不开，请检查它是否以 http:// 或 https:// 开头。', {
          detail: `bad import url: ${raw.slice(0, 200)}`,
        })
      }
      let parsed
      try {
        parsed = new URL(raw)
      } catch (error) {
        throw fail('E_IMPORT_URL_BAD', '这个链接不合法，请重新复制一次。', {
          detail: `parse failed: ${String(error?.message ?? error)}`,
        })
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw fail('E_IMPORT_URL_BAD', '只支持 http:// 或 https:// 的链接。')
      }

      const limit = store.maxImportBytes ?? 200 * 1024 * 1024
      const response = await downloadBook(parsed.toString(), limit)
      const bytes = response.bytes
      if (bytes.length === 0) {
        throw fail('E_IMPORT_EMPTY', '下载回来的文件是空的，换个链接试试。')
      }
      const sniffed = detectFormat(bytes)
      const name = ensureExtension(
        typeof body?.filename === 'string' && body.filename.trim() !== ''
          ? body.filename
          : guessFilename(response.finalUrl, response.contentDisposition),
        sniffed,
      )
      return store.importBook({ filename: name, dataBase64: bytes.toString('base64') })
    },

    // 「找书」（0.5.1）：按用户自己填的搜索地址模板抓结果页，抽出候选链接。
    // 这里只做「读」，下载仍然走上面的 shelf.importUrl——同一套限制与错误码。
    'source.search': async (body) => {
      const query = typeof body?.query === 'string' ? body.query.trim() : ''
      if (query === '') {
        throw fail('E_SOURCE_QUERY', '先输入要搜的书名或作者。')
      }
      const settings = await store.getSettings()
      const sources = Array.isArray(settings?.bookSources) ? settings.bookSources : []
      if (sources.length === 0) {
        throw fail('E_SOURCE_NONE', '还没有配置书源：先在找书面板里填一个搜索地址模板。')
      }
      const wanted = typeof body?.sourceId === 'string' ? body.sourceId : ''
      const source = wanted === '' ? sources[0] : sources.find((item) => item?.id === wanted)
      if (!source) {
        throw fail('E_SOURCE_NONE', '找不到这个书源，可能已经被删掉了。')
      }
      let target
      try {
        target = buildSearchUrl(source.searchUrl, query)
      } catch (error) {
        throw fail('E_SOURCE_BAD', '这个书源的搜索地址写得不对，打开「找书」重新填一次。', {
          detail: String(error?.message ?? error),
        })
      }
      const page = await fetchPage(target, 2 * 1024 * 1024)
      const candidates = extractCandidates(page.text, page.finalUrl)
      return {
        source: { id: String(source.id ?? ''), name: String(source.name ?? '') },
        url: target,
        candidates,
      }
    },

    // ───────────────── Legado 书源（0.9.0） ─────────────────
    'source.legado.list': async () => {
      const sources = await store.listLegadoSources()
      return { sources }
    },

    'source.legado.import': async (body) => {
      const raw = typeof body?.json === 'string' ? body.json : body?.sources
      if (raw === undefined || raw === null || raw === '') {
        throw fail('E_LEGADO_EMPTY', '没有收到书源内容：把 Legado 导出的 JSON 复制进来，或者选一个 .json 文件。')
      }
      let parsed
      try {
        parsed = parseSourceList(raw)
      } catch (error) {
        throw fail('E_LEGADO_BAD_JSON', String(error?.message ?? error), { detail: String(error?.message ?? error) })
      }
      if (parsed.sources.length === 0 && parsed.rejected.length === 0) {
        throw fail('E_LEGADO_EMPTY', '这个 JSON 里没有书源。')
      }
      const existing = await store.listLegadoSources()
      const byUrl = new Map(existing.map((item) => [item.url, item]))
      let added = 0
      let updated = 0
      for (const source of parsed.sources) {
        if (byUrl.has(source.url)) updated += 1
        else added += 1
        byUrl.set(source.url, source)
      }
      const sources = [...byUrl.values()]
      await store.saveLegadoSources(sources)
      return { added, updated, rejected: parsed.rejected, total: sources.length }
    },

    'source.legado.remove': async (body) => {
      const url = String(body?.url ?? '').trim()
      if (url === '') throw fail('E_BAD_RECORD', '没有说要删哪个书源。')
      const existing = await store.listLegadoSources()
      const sources = existing.filter((item) => item.url !== url)
      await store.saveLegadoSources(sources)
      return { removed: existing.length - sources.length, total: sources.length }
    },

    'source.legado.toggle': async (body) => {
      const url = String(body?.url ?? '').trim()
      if (url === '') throw fail('E_BAD_RECORD', '没有说要改哪个书源。')
      const enabled = body?.enabled !== false
      const existing = await store.listLegadoSources()
      const sources = existing.map((item) => (item.url === url ? { ...item, enabled } : item))
      await store.saveLegadoSources(sources)
      return { total: sources.length }
    },

    // 一次最多并发搜几个源。再多就是在同时打十几个站点，容易被封，也拖时间。
    'source.legado.search': async (body) => {
      const keyword = String(body?.keyword ?? '').trim()
      if (keyword === '') throw fail('E_SOURCE_QUERY', '先输入要搜的书名或作者。')
      if (keyword.length > 60) throw fail('E_SOURCE_QUERY', '搜索词太长了，只输关键词就行（60 字以内）。')
      const page = Math.max(1, Math.min(20, Number(body?.page) || 1))
      const all = await store.listLegadoSources()
      const wanted = Array.isArray(body?.urls) && body.urls.length > 0
        ? all.filter((item) => body.urls.includes(item.url))
        : all.filter((item) => item.enabled !== false)
      if (wanted.length === 0) {
        throw fail('E_SOURCE_NONE', '还没有可用的书源：先在「书源」里导入 Legado 书源。')
      }
      const picked = wanted.slice(0, LEGADO_SEARCH_CONCURRENCY)
      const results = []
      const failures = []
      await Promise.all(picked.map(async (source) => {
        try {
          const found = await searchSource({
            source,
            keyword,
            page,
            fetchText: (url, init) => store.fetchLegado(url, init?.headers),
          })
          for (const item of found.items) results.push(item)
        } catch (error) {
          failures.push({ source: source.name, reason: String(error?.message ?? error) })
        }
      }))
      return { keyword, page, results, failures, searched: picked.length, total: wanted.length }
    },

    'book.addFromSource': async (body) => {
      const sourceUrl = String(body?.sourceUrl ?? '').trim()
      const all = await store.listLegadoSources()
      const source = all.find((item) => item.url === sourceUrl)
      if (!source) throw fail('E_SOURCE_NONE', '这个书源不在了，重新导入一次书源。')
      const added = await store.addFromSource({
        source,
        bookUrl: String(body?.bookUrl ?? ''),
        name: body?.name,
        author: body?.author,
        intro: body?.intro,
      })
      return { bookHash: added.bookHash, chapterCount: added.chapterCount, meta: added.meta }
    },

    'shelf.remove': async (body) => store.removeBook(requireBook(body?.bookHash)),

    'book.meta': async (body) => store.readMeta(requireBook(body?.bookHash)),

    // 改书名 / 作者（0.4.0）。只透传 body 里真正带了的字段：
    // 少传 author 不代表「把作者清空」，而是「这次不动作者」。
    'book.update': async (body) => {
      const patch = {}
      const fields = ['title', 'author', 'description', 'category', 'series', 'tags']
      for (const key of fields) {
        if (body !== null && typeof body === 'object' && Object.hasOwn(body, key)) patch[key] = body[key]
      }
      return store.updateMeta(requireBook(body?.bookHash), patch)
    },

    'book.cover.put': async (body) =>
      store.putCover(requireBook(body?.bookHash), decodeCoverPayload(body)),

    // 恢复默认封面。施工图上写作 book.cover.reset，接口契约里是 book.cover.remove，
    // 两个都注册、指向同一个实现：客户端是哪一版都能用，不用为此发两次版。
    'book.cover.remove': async (body) => store.resetCover(requireBook(body?.bookHash)),

    'book.cover.reset': async (body) => store.resetCover(requireBook(body?.bookHash)),

    'book.toc': async (body) => store.toc(requireBook(body?.bookHash)),

    // 书内搜索（0.6.0）。逐章在宿主侧扫，客户端只收命中列表。
    'book.search': async (body) =>
      store.searchBook(requireBook(body?.bookHash), body?.query, { limit: body?.limit }),

    'book.spine': async (body) => store.spine(requireBook(body?.bookHash)),

    'progress.get': async (body) => store.readProgress(requireBook(body?.bookHash)),

    // 返回 { saved: true }（docs/05 §3.3 的规定形状）。进度本体不值得回传：
    // 客户端刚提交的值它自己有，回传只会让「以谁为准」变得含糊。
    'progress.put': async (body) => {
      await store.putProgress({
        bookHash: requireBook(body?.bookHash),
        cfi: body?.cfi,
        cfiStart: body?.cfiStart,
        chapterHref: body?.chapterHref,
        percent: body?.percent,
      })
      return { saved: true }
    },

    'ann.list': async (body) => store.listAnnotations(requireBook(body?.bookHash)),

    'ann.put': async (body) => store.putAnnotation(requireBook(body?.bookHash), body?.record),

    'ann.delete': async (body) => store.deleteAnnotation(requireBook(body?.bookHash), body?.id),

    'settings.get': async () => store.getSettings(),

    'settings.put': async (body) => store.putSettings(body),

    'quarantine.list': async (body) => store.listQuarantine(requireBook(body?.bookHash)),

    // 圈住一段原文问 AI。答案必须挂在锚点上落盘（docs/01 铁律：没有锚点不落盘）。
    // ask 服务可能是 null（宿主没提供 subagents 或没有可用模型），这时抛 503，
    // 界面把中文说明显示在提问框下面 —— 不是白屏，也不是静默失败。
    // ── 读书蒸馏（0.8.0）──────────────────────────────────────────
    // 一章一次调用。为什么按章：整本塞进一次 prompt 又贵又容易超上下文，
    // 而且失败了整本重来；按章失败只丢一章，进度是可见的。
    'distill.get': async (body) => {
      const bookHash = requireBook(body?.bookHash)
      const meta = await store.readMeta(bookHash)
      const state = await store.readDistill(bookHash)
      const chapters = await store.chapterIndex(bookHash)
      return {
        bookHash,
        bookTitle: typeof meta.title === 'string' ? meta.title : '',
        author: typeof meta.author === 'string' ? meta.author : '',
        chapters,
        state: state ?? emptyState({ bookHash, title: meta.title, author: meta.author }),
        progress: progressOf(state ?? emptyState({})),
      }
    },

    'distill.chapter': async (body) => {
      if (!ask) {
        throw fail('E_AI_UNAVAILABLE', '这台机器暂时连不上模型，蒸不了。可以先去「AI 状态」看原因。', {
          status: 503,
        })
      }
      const bookHash = requireBook(body?.bookHash)
      const href = typeof body?.href === 'string' ? body.href : ''
      if (href === '') throw fail('E_BAD_CHAPTER', '没指定要蒸哪一章。', { status: 400 })

      const meta = await store.readMeta(bookHash)
      const chapter = await store.chapterText(bookHash, href)
      const state = (await store.readDistill(bookHash)) ?? emptyState({ bookHash, title: meta.title, author: meta.author })
      const index = await store.chapterIndex(bookHash)
      const hrefs = index.map((item) => item.href)

      const prompt = buildChapterPrompt({
        bookTitle: meta.title,
        author: meta.author,
        chapterLabel: chapter.label,
        chapterIndex: chapter.spineIndex,
        chapterTotal: chapter.total,
        chapterText: chapter.text,
      })

      let reply
      try {
        const result = await ask.complete({
          prompt,
          label: `蒸馏：${chapter.label}`,
          kind: 'distill',
          bookHash,
          bookTitle: meta.title,
          chapterLabel: chapter.label,
          // 一章可能很长，给足时间；模型慢时也别 90 秒就掐。
          timeoutMs: 240_000,
        })
        reply = typeof result === 'string' ? result : result?.answer ?? ''
      } catch (error) {
        const failed = {
          href,
          label: chapter.label,
          spineIndex: chapter.spineIndex,
          status: 'failed',
          thesis: '',
          points: [],
          terms: [],
          methods: [],
          quotes: [],
          error: String(error?.message ?? error ?? '调用失败'),
          at: new Date().toISOString(),
        }
        const next = mergeChapter(state, failed, hrefs)
        await store.putDistill(bookHash, next)
        throw fail('E_DISTILL_FAILED', `${chapter.label} 没蒸成：${failed.error}`, {
          status: 502,
          detail: failed.error,
        })
      }

      const parsed = parseChapterReply(reply)
      if (!parsed.ok) {
        const failed = {
          href,
          label: chapter.label,
          spineIndex: chapter.spineIndex,
          status: 'failed',
          thesis: '',
          points: [],
          terms: [],
          methods: [],
          quotes: [],
          error: parsed.error,
          at: new Date().toISOString(),
        }
        const next = mergeChapter(state, failed, hrefs)
        await store.putDistill(bookHash, next)
        throw fail('E_DISTILL_FORMAT', `${chapter.label} 没蒸成：${parsed.error}`, { status: 502 })
      }

      // 回源核对：模型给的引文必须能在这一章原文里找到，找不到就标出来。
      const verified = verifyChapterQuotes(chapter.text, parsed)
      const record = {
        href,
        label: chapter.label,
        spineIndex: chapter.spineIndex,
        status: 'done',
        thesis: verified.thesis,
        points: verified.points,
        terms: verified.terms,
        methods: verified.methods,
        quotes: verified.quotes,
        error: '',
        at: new Date().toISOString(),
      }
      const next = mergeChapter(state, record, hrefs)
      await store.putDistill(bookHash, next)
      return { chapter: record, progress: progressOf(next) }
    },

    'distill.skeleton': async (body) => {
      if (!ask) {
        throw fail('E_AI_UNAVAILABLE', '这台机器暂时连不上模型，生成不了全书骨架。', { status: 503 })
      }
      const bookHash = requireBook(body?.bookHash)
      const meta = await store.readMeta(bookHash)
      const state = (await store.readDistill(bookHash)) ?? emptyState({ bookHash, title: meta.title, author: meta.author })
      const done = (Array.isArray(state.chapters) ? state.chapters : []).filter((item) => item?.status === 'done')
      if (done.length === 0) {
        throw fail('E_DISTILL_EMPTY', '还没蒸过任何一章，先生成几章再来做全书骨架。', { status: 400 })
      }
      const prompt = buildSkeletonPrompt({
        bookTitle: meta.title,
        author: meta.author,
        chapters: done.map((item) => ({ label: item.label, thesis: item.thesis })),
      })
      const result = await ask.complete({
        prompt,
        label: '全书骨架',
        kind: 'distill-skeleton',
        bookHash,
        bookTitle: meta.title,
        timeoutMs: 180_000,
      })
      const reply = typeof result === 'string' ? result : result?.answer ?? ''
      const parsed = parseSkeletonReply(reply)
      if (!parsed.ok) throw fail('E_DISTILL_FORMAT', parsed.error, { status: 502 })
      const next = {
        ...state,
        skeleton: {
          oneLine: parsed.oneLine,
          thesis: parsed.thesis,
          structure: parsed.structure,
          audience: parsed.audience,
          at: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }
      await store.putDistill(bookHash, next)
      return { skeleton: next.skeleton }
    },

    'distill.clear': async (body) => store.clearDistill(requireBook(body?.bookHash)),

    'distill.export': async (body) => {
      const bookHash = requireBook(body?.bookHash)
      const state = await store.readDistill(bookHash)
      if (!state) throw fail('E_DISTILL_EMPTY', '这本书还没有蒸馏稿。', { status: 404 })
      return { markdown: toMarkdown(state) }
    },

    // ── AI 状态与账本（0.8.0）──────────────────────────────────────
    // 用户的原话：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍重试。
    // 所以这里给三样东西：静态诊断、真实探测、最近调用账本。
    'ai.status': async () => {
      const status =
        typeof extras.aiStatus === 'function'
          ? await extras.aiStatus()
          : { available: Boolean(ask), checks: [], checkedAt: new Date().toISOString(), provider: '', model: '' }
      const recent = extras.aiLog && typeof extras.aiLog.summary === 'function' ? await extras.aiLog.summary() : null
      return { ...status, recent }
    },

    // 真实探测：发一句极小的话，测网络与供应商。会记进账本（kind=probe）。
    'ai.probe': async () => probeAi({ ask }),

    // 模型名单 + 这次到底会用哪个（0.8.1）。
    //
    // 名单直接来自宿主（和主界面输入框那个选择器同一份），我们不维护副本；
    // `current` 是设置里手选的，`effective` 是按「手选 > 会话当前 > 宿主默认」
    // 算完之后真正会用的那条路由。两个都回，界面才能既显示「你选了谁」
    // 又显示「实际用了谁」——两者不一致时用户最容易困惑。
    'ai.models': async () => {
      const settings = await store.getSettings()
      const catalog = await modelCatalogOf(ctx)
      const parentOptions = resolveRoute(ctx)?.parent?.options ?? {}
      const effective = pickSelection({ settings, catalog, parentOptions })
      return {
        available: catalog.available,
        groups: catalog.groups,
        failures: catalog.failures,
        default: catalog.default ?? null,
        current: {
          provider: settings.aiProvider ?? '',
          model: settings.aiModel ?? '',
          reasoningEffort: settings.aiEffort ?? DEFAULT_EFFORT,
        },
        effective: {
          provider: effective.provider,
          model: effective.model,
          reasoningEffort: effective.reasoningEffort,
          source: effective.source,
          note: effective.effortNote,
        },
        efforts: EFFORT_ORDER.map((id) => ({ id, name: effortLabel(id) })),
        defaultEffort: DEFAULT_EFFORT,
      }
    },

    'ai.log': async (body) => {
      if (extras.aiLog === undefined || extras.aiLog === null) return { items: [] }
      return { items: await extras.aiLog.list(body?.limit ?? 50) }
    },

    'ai.log.clear': async () => {
      if (extras.aiLog === undefined || extras.aiLog === null) return { cleared: true }
      return extras.aiLog.clear()
    },

    'qa.ask': async (body) => {
      if (!ask) {
        // 必须是 AppError：普通 Error 会被 publicError 当成内部错误吞成 500，
        // 用户就看不到「这台机器问不了 AI」这句解释了。
        throw fail('E_AI_UNAVAILABLE', '这台机器暂时连不上模型，问不了 AI。', { status: 503 })
      }
      return ask.ask({
        bookHash: requireBook(body?.bookHash),
        question: body?.question,
        selectedText: body?.selectedText,
        anchorCfiRange: body?.anchorCfiRange,
        chapterHref: body?.chapterHref,
        chapterLabel: body?.chapterLabel,
        bookTitle: body?.bookTitle,
        author: body?.author,
        // 当前工作内容：选区所在段落的前后文（0.8.0）
        surroundingText: body?.surroundingText,
      })
    },

    'qa.list': async (body) =>
      store.listQa(requireBook(body?.bookHash), { limit: body?.limit }),

    'qa.delete': async (body) => store.deleteQa(requireBook(body?.bookHash), body?.id),
  }
}

// ── GET 资源 ──────────────────────────────────────────────────────

// ── PWA：让手机能把这一页「添加到主屏幕」──────────────────────────
//
// 为什么插件要发 manifest：dsh-reading 不是独立 App，它跑在 DSH 的 Web UI 里。
// 手机上想要一个「点开就读书」的图标，唯一不改宿主源码的办法就是把 manifest
// 挂在本插件自己的路由上，再由客户端把 <link rel="manifest"> 注入页面 head。
// start_url 只能是站点根：插件拿不到路由控制权，装了图标后打开的是整个 DSH。

/** 应用图标：仓库根目录的 icon.svg（构建期就存在，不需要再复制一份）。 */
let iconCache = null

async function readIcon() {
  if (iconCache !== null) return iconCache
  try {
    iconCache = await readFile(new URL('../icon.svg', import.meta.url))
  } catch {
    iconCache = null
  }
  return iconCache
}

function serveManifest(res) {
  const manifest = {
    name: '深读 · DSH 阅读器',
    short_name: '深读',
    description: '在 DeepSeek Harness 里读书：EPUB / MOBI / AZW3 / TXT / PDF。',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fcfbf8',
    theme_color: '#fcfbf8',
    icons: [{ src: '/api/dsh-reading/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }
  const body = JSON.stringify(manifest)
  send(res, 200, {
    'content-type': 'application/manifest+json; charset=utf-8',
    'cache-control': 'public, max-age=3600',
    'content-length': Buffer.byteLength(body),
  }, body)
}

async function serveAppIcon(res) {
  const bytes = await readIcon()
  if (bytes === null) {
    throw fail('E_NOT_FOUND', '图标文件丢了。', { status: 404, detail: 'icon.svg missing' })
  }
  send(res, 200, {
    'content-type': 'image/svg+xml',
    'cache-control': 'public, max-age=86400',
    'content-length': bytes.length,
  }, bytes)
}

/**
 * 章节响应。**原样输出**，只改属性值（见文件头）。
 * @param {any} res
 * @param {import('./store.js').LibraryStore} store
 * @param {URLSearchParams} query
 */
async function serveChapter(res, store, query) {
  const book = requireBook(query.get('book'))
  const href = requireHref(query.get('href'))
  const html = await store.chapterHtml(book, href)
  if (html === null) {
    throw fail('E_CHAPTER_NOT_FOUND', '这一章找不到了，可能书被换过。', { status: 404, detail: `missing chapter: ${href}` })
  }
  const parsed = await store.getParsed(book)
  const rewritten = rewriteChapterAssets(html, {
    book,
    chapterHref: href,
    // 用 epub 层的同一套规则（以章节所在目录为基准，越出 OPF 根即放弃改写）。
    // 两处各写一份归一逻辑迟早分叉，症状是「有些图能显示、有些不能」。
    resolve: (baseHref, raw) =>
      typeof parsed.resolveRelative === 'function' ? parsed.resolveRelative(baseHref, raw) : null,
  })
  send(res, 200, { ...CHAPTER_HEADERS, 'content-length': Buffer.byteLength(rewritten) }, rewritten)
}

function dirNameOf(zipPath) {
  const slash = String(zipPath).lastIndexOf('/')
  return slash < 0 ? '' : String(zipPath).slice(0, slash)
}

/** 相对路径拼接并按段吃掉 `.`/`..`；越出根返回 null。 */
export function joinRelative(baseDir, raw) {
  let value = String(raw ?? '').trim()
  const hash = value.indexOf('#')
  if (hash >= 0) value = value.slice(0, hash)
  const question = value.indexOf('?')
  if (question >= 0) value = value.slice(0, question)
  value = value.replace(/\\/g, '/')
  try {
    value = decodeURIComponent(value)
  } catch {
    // 非法编码按原文处理：按名查不到自然会 404。
  }
  const out = baseDir === '' ? [] : String(baseDir).split('/')
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}

/**
 * 资源响应。CSS 改写 url()，其余按字节原样输出。
 * @param {any} res
 * @param {import('./store.js').LibraryStore} store
 * @param {URLSearchParams} query
 */
async function serveAsset(res, store, query) {
  const book = requireBook(query.get('book'))
  const href = requireHref(query.get('href'))
  const baseHref = query.get('base')
  const asset = await store.assetBytes(book, href, baseHref ? requireHref(baseHref) : undefined)
  if (asset === null) {
    throw fail('E_ASSET_NOT_FOUND', '这个图片或样式找不到了。', { status: 404, detail: `missing asset: ${href}` })
  }
  let body = asset.bytes
  let mediaType = asset.mediaType
  if (mediaType === 'text/css' || mediaType === 'application/xhtml+xml' || mediaType === 'text/html') {
    const text = body.toString('utf8')
    const isCss = mediaType === 'text/css'
    const rewritten = isCss
      ? rewriteCssUrls(text, { book, baseHref: href, resolve: (base, raw) => joinRelative(dirNameOf(base), raw) })
      : text
    body = Buffer.from(rewritten, 'utf8')
  }
  send(
    res,
    200,
    {
      'content-type': `${mediaType}${isTextual(mediaType) ? '; charset=utf-8' : ''}`,
      // 资源也可能被恶意 EPUB 塞进脚本（SVG 里就能带）：一律禁脚本。
      'content-security-policy': "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline' 'self'; font-src 'self' data:; script-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
      'content-length': body.length,
    },
    body,
  )
}

/** 是否文本类 media-type（决定要不要加 charset）。 */
function isTextual(mediaType) {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/json' ||
    mediaType === 'image/svg+xml'
  )
}

/**
 * 封面响应：没有封面就 404（docs/05 §3.3）。
 *
 * 缓存策略（0.4.0 的关键修复）：0.3.x 给的是 `max-age=3600`，而封面 URL 里
 * 没有任何版本参数 —— 用户换完封面，最长一小时还在看旧图。现在改成
 * 「立刻过期 + ETag」：浏览器每次都会回来问一句，没换图就 304（不重传），
 * 换了图（coverVersion 变了 → ETag 变了）立刻拿到新图。
 */
async function serveCover(res, store, query, req) {
  const book = requireBook(query.get('book'))
  const asset = await store.coverBytes(book)
  if (asset === null) {
    throw fail('E_COVER_NOT_FOUND', '这本书没有封面。', { status: 404, detail: 'no cover image' })
  }
  const version = Number.isInteger(asset.version) ? asset.version : 0
  const etag = `"c${version}"`
  const headers = {
    'content-type': asset.mediaType === 'application/octet-stream' ? 'image/jpeg' : asset.mediaType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=0, must-revalidate',
    etag,
  }
  const requestHeaders = req && typeof req.headers === 'object' && req.headers !== null ? req.headers : {}
  if (requestHeaders['if-none-match'] === etag) {
    // 304 不带 body，也不该带 content-length（带了某些客户端会等一个不存在的包体）。
    send(res, 304, headers, Buffer.alloc(0))
    return
  }
  send(res, 200, { ...headers, 'content-length': asset.bytes.length }, asset.bytes)
}

/**
 * 下载一本书，按 `limit` 硬性截断。
 *
 * 为什么不用 `response.arrayBuffer()`：那会先按对方声明的体积一次分配完，一个
 * 声明 10GB 的响应能把进程直接拖死。这里边读边累计，超了立刻中止。
 *
 * @param {string} url
 * @param {number} limit
 * @returns {Promise<{ bytes: Buffer, finalUrl: string, contentDisposition: string|null }>}
 */
async function downloadBook(url, limit) {
  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-reading/0.5.1', accept: '*/*' },
      signal: AbortSignal.timeout(90000),
    })
  } catch (error) {
    throw fail('E_IMPORT_DOWNLOAD', '下载失败了，可能是网络不通或对方站点拒绝了访问。', {
      detail: `fetch failed: ${String(error?.message ?? error)}`,
    })
  }
  if (!response.ok) {
    throw fail('E_IMPORT_DOWNLOAD', `下载失败了：对方站点返回 ${response.status}。`, {
      detail: `status ${response.status} for ${url}`,
    })
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    throw fail('E_IMPORT_TOO_BIG', '这本书文件太大了，暂时导入不了。', {
      detail: `content-length=${declared} limit=${limit}`,
    })
  }
  /** @type {Buffer[]} */
  const chunks = []
  let total = 0
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.length
        if (total > limit) {
          throw fail('E_IMPORT_TOO_BIG', '这本书文件太大了，暂时导入不了。', {
            detail: `streamed over limit=${limit}`,
          })
        }
        chunks.push(buffer)
      }
    }
  } catch (error) {
    if (error && error.code === 'E_IMPORT_TOO_BIG') throw error
    throw fail('E_IMPORT_DOWNLOAD', '下载中途断了，重试一次试试。', {
      detail: `stream failed: ${String(error?.message ?? error)}`,
    })
  }
  return {
    bytes: Buffer.concat(chunks, total),
    finalUrl: typeof response.url === 'string' && response.url !== '' ? response.url : url,
    contentDisposition: response.headers.get('content-disposition'),
  }
}

/** 抓一个网页，最多读 `limit` 字节。搜索结果页只需要 HTML 骨架。 */
async function fetchPage(url, limit) {
  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'dsh-reading/0.5.1',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    throw fail('E_SOURCE_FETCH', '连不上这个书源，可能是网络问题或地址写错了。', {
      detail: `fetch failed: ${String(error?.message ?? error)}`,
    })
  }
  if (!response.ok) {
    throw fail('E_SOURCE_FETCH', `书源返回了 ${response.status}，可能地址不对或需要登录。`, {
      detail: `status ${response.status} for ${url}`,
    })
  }
  let text = ''
  try {
    const buffer = await response.arrayBuffer()
    text = Buffer.from(buffer).subarray(0, limit).toString('utf8')
  } catch (error) {
    throw fail('E_SOURCE_FETCH', '读搜索结果的时候断了，重试一次。', {
      detail: `read failed: ${String(error?.message ?? error)}`,
    })
  }
  return { text, finalUrl: typeof response.url === 'string' && response.url !== '' ? response.url : url }
}

// ── 入口 ──────────────────────────────────────────────────────────

/**
 * 建一个纯函数 handler。**不启端口、不碰 ctx**——测试直接调它。
 *
 * @param {{ store: import('./store.js').LibraryStore, logger?: { warn: Function }, maxBodyBytes?: number }} options
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(options) {
  const { store } = options
  const logger = options.logger ?? console
  const config = options.config ?? {}
  const ask = options.ask ?? null
  const methods = buildMethods(store, config, ask, {
    aiStatus: options.aiStatus ?? null,
    aiLog: options.aiLog ?? null,
  }, { ctx: options.ctx ?? null })
  // 导入走 base64，体积约为原文件的 4/3，再留一点 JSON 包装的余量。
  const importLimit = Math.ceil(((store.maxImportBytes ?? 200 * 1024 * 1024) * 4) / 3) + 64 * 1024
  const defaultLimit = options.maxBodyBytes ?? 8 * 1024 * 1024

  return async function handler(req, res) {
    try {
      const rawUrl = typeof req?.url === 'string' ? req.url : '/'
      let parsedUrl
      try {
        parsedUrl = new URL(rawUrl, 'http://dsh.internal')
      } catch (error) {
        throw fail('E_BAD_PATH', '这个地址不合法，打不开。', {
          detail: `bad url: ${String(error?.message ?? error)}`,
        })
      }
      const pathname = parsedUrl.pathname
      const method = String(req?.method ?? 'GET').toUpperCase()

      // 前缀之外的请求不该走到这里（prefix 路由只匹配前缀内），但防御性拒绝。
      if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
        throw fail('E_NOT_FOUND', '没有这个接口。', { status: 404, detail: `outside prefix: ${pathname}` })
      }
      const rest = pathname.slice(API_PREFIX.length).replace(/^\//, '')

      if (method === 'GET' || method === 'HEAD') {
        if (rest === 'chapter') return await serveChapter(res, store, parsedUrl.searchParams)
        if (rest === 'asset') return await serveAsset(res, store, parsedUrl.searchParams)
        if (rest === 'cover') return await serveCover(res, store, parsedUrl.searchParams, req)
        if (rest === 'manifest.webmanifest') return serveManifest(res)
        if (rest === 'icon.svg') return await serveAppIcon(res)
        throw fail('E_NOT_FOUND', '没有这个接口。', { status: 404, detail: `unknown GET: ${rest}` })
      }

      if (method !== 'POST') {
        throw fail('E_METHOD', '这个操作不支持，请刷新页面后重试。', {
          status: 405,
          detail: `method=${method} path=${rest}`,
        })
      }

      // 方法名只允许自有属性：对象字面量查 `constructor` 会命中原型链。
      if (rest === '' || rest.includes('/') || !Object.hasOwn(methods, rest)) {
        throw fail('E_NOT_FOUND', '没有这个接口。', { status: 404, detail: `unknown method: ${rest}` })
      }
      const limit = rest === 'shelf.import' ? importLimit : defaultLimit
      const body = await readBody(req, limit)
      const value = await methods[rest](body)
      writeOk(res, value)
    } catch (error) {
      // writeFailure 自己分诊：AppError 按 code 出信封，其它一律 E_INTERNAL 并只回
      // 一句中文，细节进日志（绝不把宿主堆栈回显给前端）。这里不要按错误类型分两支。
      writeFailure(res, error, logger)
    }
  }
}

/**
 * 把 handler 挂到 `ctx.webServer`。
 *
 * @param {{ webServer: { register: (options: object) => () => void } }} ctx
 * @param {{ store: import('./store.js').LibraryStore, logger?: { warn: Function }, config?: object }} options
 * @returns {() => void} disposer（调用方负责包进 ctx.effect）
 */
export function registerRoutes(ctx, options) {
  // ctx 交给 handler：模型名单要读宿主的 sessionController（0.8.1）。
  const handler = createHandler({ ...options, ctx })
  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  })
}

export { writeOk, writeError, buildMethods }
