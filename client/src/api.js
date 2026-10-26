/**
 * api.js —— 浏览器半访问宿主的唯一出口。
 *
 * 浏览器拿不到文件系统，所有书本数据都靠宿主侧的 `POST /api/dsh-reading/<method>`
 * 与三个 `GET` 静态路由。这一层做三件事：
 *   1. 统一信封解析（`{ok:true,value}` / `{ok:false,error:{code,message}}`）；
 *   2. 把任何失败翻译成一句人话（humanizeError 是幂等的，界面只显示它的输出）；
 *   3. 把 URL 拼装收在一处，避免各组件各自 `encodeURIComponent` 漏一个参数。
 *
 * 失败行为：`call()` 一律抛 `Error`，`message` 已经是给人看的中文。
 * 调用方只需 `catch (e) { setError(humanizeError(e)) }`，不需要再判断错误类型。
 */

export const API_BASE = '/api/dsh-reading'

/** deviceId 的本地缓存键。只存这一个值，卸载插件时不会有残留语义。 */
const DEVICE_KEY = 'dsh-reading:deviceId'

/**
 * 已知错误码 → 人话。宿主侧的错误码是稳定契约，这里逐条给出「用户该做什么」。
 * 未列入的码走下面的通用兜底，绝不把原始 JSON 或字段名透到屏幕上。
 */
const ERROR_TEXT = {
  E_EPUB_ENCRYPTED: '这本书有 DRM 加密，打不开。请换一本没有加密的 EPUB。',
  E_EPUB_TOO_BIG: '这本书太大或解压后体积异常，为安全起见没有导入。',
  E_EPUB_INVALID: '这个文件不是完整的 EPUB，可能下载时中断了。',
  E_ZIP64: '这个 EPUB 用了暂不支持的 ZIP64 格式，请重新导出后再试。',
  E_MOBI_MALFORMED: '这个 MOBI / AZW3 文件结构不完整，读不出来。换一份再试。',
  E_MOBI_ENCRYPTED: '这本书有 DRM 保护，暂时读不了。请换一本没有加密的。',
  E_MOBI_UNSUPPORTED: '这本书用的压缩方式暂时还不支持，换一本再试。',
  E_TXT_DECODE_FAILED: '这个文本的编码认不出来（试过 UTF-8 与 GB18030），读不了。',
  E_TXT_NOT_TEXT: '这个文件看起来不是文本，可能是别的格式改了扩展名。',
  E_PDF_INVALID: '这个 PDF 文件不完整或不是 PDF，读不出来。换一份再试。',
  E_PDF_ENCRYPTED: '这本 PDF 有密码保护（加密），暂时打不开。请换一本没加密的。',
  E_PDF_NO_TEXT: '这本 PDF 里读不到文字——多半是扫描件（整页是图片）。目前只能读文字版 PDF。',
  E_PDF_NO_PAGES: '这本 PDF 里找不到可以读的页面。',
  E_AI_UNAVAILABLE: '这个版本的宿主没有提供 AI 服务，暂时问不了。',
  E_AI_NO_MODEL: '还没选模型，先在 DSH 里选一个模型再回来问。',
  E_AI_FAILED: 'AI 这次没答上来，稍后再试一次。',
  E_AI_EMPTY: 'AI 没有给出内容，换个问法再试。',
  E_BAD_QUESTION: '先写一句想问的话。',
  E_NO_SELECTION: '先圈住一段原文，再问 AI。',
  E_BOOK_EMPTY: '这个文件里没有读到文字，可能不是一本完整的电子书。',
  E_IMPORT_UNKNOWN_FORMAT: '这个格式还不支持。目前能读 EPUB、MOBI、AZW3、TXT、PDF 五种。',
  E_IMPORT_EMPTY: '没有收到书籍文件，请重新选择一次。',
  E_IMPORT_TOO_BIG: '这本书文件太大了，暂时导入不了。',
  E_IMPORT_URL_BAD: '这个链接打不开，请检查它是否以 http:// 或 https:// 开头。',
  E_IMPORT_DOWNLOAD: '下载失败了，可能是网络不通或对方站点拒绝了访问。',
  E_SOURCE_QUERY: '先输入要搜的书名或作者。',
  E_SOURCE_NONE: '还没有配置书源：先在找书面板里填一个搜索地址模板。',
  E_SOURCE_BAD: '这个书源的搜索地址写得不对，重新填一次。',
  E_SOURCE_FETCH: '连不上这个书源，可能是网络问题或地址写错了。',
  E_IMPORT_BAD_BASE64: '文件传输不完整，请重新导入一次。',
  E_ZIP_CORRUPT: '压缩包已经损坏，换一份文件再试。',
  E_XML_MALFORMED: '这本书的内部结构不合法，无法定位正文。',
  E_NOT_FOUND: '找不到这本书，它可能已经从书架里删掉了。',
  E_NO_BOOK: '找不到这本书，它可能已经从书架里删掉了。',
  E_PATH: '书库里没有这个文件。',
  E_FORBIDDEN: '没有权限访问书库目录，请检查文件夹权限。',
  E_DISK_FULL: '磁盘空间不够了，腾出一些空间再试。',
  E_BUSY: '上一次操作还没结束，请稍等一下。',
  E_BAD_REQUEST: '这次请求没能被接受，请重试一次。',
  E_INTERNAL: '后台出了点问题，请稍后再试。',
}

/** 完全给不出信息时的兜底。绝不留空，也绝不显示异常原文。 */
const GENERIC = '出了点问题，请稍后再试。'

/** 断网 / 宿主没起来时的专用文案 —— 这是用户最常遇到的一类失败。 */
const OFFLINE = '连不上后台。可能是软件刚启动还没准备好，等几秒再试一次。'

/** 这些形态属于「机器语言」，一律不进界面。 */
const MACHINE_PATTERNS = [
  /^[\[{]/, // JSON 开头
  /[{}]/, // JSON 片段
  /\bat\s+\S+\s*\(.*:\d+:\d+\)/, // 堆栈帧
  /\.(?:js|mjs|ts|json):\d+/, // 文件:行号
  /(?:^|[\s"'(])\/(?:Users|home|var|tmp|private|opt)\//, // 绝对路径
  /[A-Za-z]:\\\\/, // Windows 路径
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /\bE_[A-Z][A-Z0-9_]+\b/, // 未翻译的错误码
]

/**
 * 把任何错误压成一句能显示的中文。**幂等**：把结果再喂进来，返回同一个字符串。
 *
 * @param {unknown} err Error / string / 任意值
 * @returns {string} 可直接渲染的文案；空串表示「没有可显示的信息」
 */
export function humanizeError(err) {
  const raw = typeof err === 'string'
    ? err
    : (err && typeof err.message === 'string' ? err.message : '')

  const text = raw.trim()
  if (text === '') return ''

  // 已知码优先：宿主返回的 message 基本就是给人看的中文，码只是补充定位
  for (const code of Object.keys(ERROR_TEXT)) {
    if (text.includes(code)) {
      const rest = text.split(code).pop().replace(/^[:：\s]+/, '').trim()
      // 码后面的中文句子通常更具体（「书库目录不可写」），优先用它
      if (rest !== '' && /[\u4e00-\u9fa5]/.test(rest) && !MACHINE_PATTERNS.some((re) => re.test(rest))) {
        return rest
      }
      return ERROR_TEXT[code]
    }
  }

  if (MACHINE_PATTERNS.some((re) => re.test(text))) return GENERIC

  // 已经有中文、且不含机器语言：视为已经人话（这一步保证幂等）
  if (/[\u4e00-\u9fa5]/.test(text)) return text

  if (/fetch|network|ECONN|ETIMEDOUT|ENOTFOUND|Failed to fetch/i.test(text)) return OFFLINE

  return GENERIC
}

/**
 * 调一个宿主方法。
 *
 * @param {string} method 如 `shelf.list` / `ann.put`
 * @param {object} [body] 请求体（会 JSON 序列化）
 * @returns {Promise<any>} 成功时的 `value`
 * @throws {Error} message 已经是人话
 */
export async function call(method, body) {
  let res
  try {
    res = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch (error) {
    // 网络层抛出来的 TypeError / Failed to fetch 对用户没有意义，直接换成 OFFLINE
    throw new Error(OFFLINE)
  }

  let payload = null
  let text = ''
  try {
    text = await res.text()
    payload = text === '' ? null : JSON.parse(text)
  } catch (error) {
    // 宿主返回了非 JSON（常见于路由没挂上，命中了 SPA 的 index.html）
    throw new Error(res.ok ? GENERIC : ERROR_TEXT.E_INTERNAL)
  }

  if (payload && payload.ok === true) return payload.value

  const err = payload && payload.error
  if (err && typeof err.message === 'string' && err.message.trim() !== '') {
    const combined = err.code ? `${err.code}: ${err.message}` : err.message
    const pretty = humanizeError(combined)
    throw new Error(pretty === '' ? GENERIC : pretty)
  }

  if (res.status === 404) throw new Error(ERROR_TEXT.E_NOT_FOUND)
  if (res.status === 413) throw new Error(ERROR_TEXT.E_EPUB_TOO_BIG)
  if (res.status >= 500) throw new Error(ERROR_TEXT.E_INTERNAL)
  throw new Error(GENERIC)
}

/** 章节地址。href 来自 spine/toc，必须整体编码，否则子目录里带 `#` 的路径会截断。 */
export function chapterUrl(bookHash, href) {
  return `${API_BASE}/chapter?book=${encodeURIComponent(bookHash)}&href=${encodeURIComponent(href)}`
}

/** 章节内引用的图片 / CSS / 字体地址。 */
export function assetUrl(bookHash, href) {
  return `${API_BASE}/asset?book=${encodeURIComponent(bookHash)}&href=${encodeURIComponent(href)}`
}

/**
 * 封面地址。没有封面时宿主返回 404，调用方用 onError 回退到占位块。
 *
 * `version` 传这本书 meta 的 updatedAt：换封面会刷新它，于是地址变了，
 * 浏览器缓存自然失效 —— 宿主给封面设的是 max-age=3600，不带版本号时
 * 换完封面最长一小时还在看旧图。不传（或传空）时退回与旧版一致的地址。
 *
 * @param {string} bookHash
 * @param {string} [version]
 * @returns {string}
 */
export function coverUrl(bookHash, version) {
  const base = `${API_BASE}/cover?book=${encodeURIComponent(bookHash)}`
  const stamp = typeof version === 'string' ? version.trim() : ''
  return stamp === '' ? base : `${base}&v=${encodeURIComponent(stamp)}`
}

/**
 * 书名 / 作者 / 封面的写接口共用的书标识。
 *
 * 同时带 `book` 与 `bookHash`：施工图 §4.2 写的是 `book`，而仓库既有路由
 * （book.meta / book.toc / shelf.remove）一律用 `bookHash`。两个键同值，
 * 宿主取哪个都对，省得客户端和宿主各猜一半。
 */
function bookArgs(bookHash) {
  return { book: bookHash, bookHash }
}

/**
 * 改书名 / 作者。
 *
 * 只传确实要改的字段：author 允许改成空串（用户清掉作者名是合法意图），
 * 所以不能用 `patch.author || oldAuthor` 这种「空串当没传」的写法。
 *
 * @param {string} bookHash
 * @param {{ title?: string, author?: string }} patch
 * @returns {Promise<{ book?: { id: string, title: string, author: string, updatedAt: string } }>}
 */
/** 书内搜索：宿主逐章扫描，返回命中列表（见 docs/13）。 */
export function searchBook(bookHash, query, limit) {
  return call('book.search', { bookHash, query, limit })
}

export function updateBook(bookHash, patch) {
  const body = bookArgs(bookHash)
  const source = patch && typeof patch === 'object' ? patch : {}
  if (typeof source.title === 'string') body.title = source.title
  if (typeof source.author === 'string') body.author = source.author
  // 0.5.1：简介 / 分类 / 系列 / 标签 / 珍藏
  if (typeof source.description === 'string') body.description = source.description
  if (typeof source.category === 'string') body.category = source.category
  if (typeof source.series === 'string') body.series = source.series
  if (Array.isArray(source.tags)) body.tags = source.tags
  if (typeof source.favorite === 'boolean') body.favorite = source.favorite
  return call('book.update', body)
}

/**
 * 换封面。`dataUrl` 是完整的 `data:image/...;base64,...`。
 *
 * @param {string} bookHash
 * @param {string} dataUrl
 * @returns {Promise<{ book?: { id: string, coverHref: string|null, updatedAt: string } }>}
 */
export function putBookCover(bookHash, dataUrl) {
  return call('book.cover.put', { ...bookArgs(bookHash), dataUrl: String(dataUrl || '') })
}

/**
 * 恢复默认封面（删掉自选的图，退回米色纸封面）。
 *
 * @param {string} bookHash
 * @returns {Promise<{ book?: { id: string, coverHref: null, updatedAt: string } }>}
 */
export function resetBookCover(bookHash) {
  return call('book.cover.reset', bookArgs(bookHash))
}

/**
 * 取本机 deviceId（宿主给，缓存在 localStorage）。
 *
 * 拿不到时**不抛**：返回空串，让上层决定「先只读」。
 * 记录写入仍然会失败得明明白白，比在这里把整个书架搞崩好。
 *
 * @returns {Promise<string>}
 */
export async function getDeviceId() {
  try {
    const cached = globalThis.localStorage?.getItem(DEVICE_KEY)
    if (typeof cached === 'string' && /^[a-z0-9]{2,12}-[a-z0-9]{4,12}$/.test(cached)) return cached
  } catch (error) {
    // 隐私模式下 localStorage 会抛，走下面的网络路径即可
  }
  try {
    const info = await call('device.info')
    const id = info && typeof info.deviceId === 'string' ? info.deviceId : ''
    if (id !== '') {
      try {
        globalThis.localStorage?.setItem(DEVICE_KEY, id)
      } catch (error) {
        // 存不进去不影响本次使用
      }
    }
    return id
  } catch (error) {
    return ''
  }
}

/** 清掉缓存的 deviceId（用户换机器 / 排查问题时用）。 */
export function clearDeviceId() {
  try {
    globalThis.localStorage?.removeItem(DEVICE_KEY)
  } catch (error) {
    // 没有 localStorage 就没有残留，什么也不用做
  }
}

// ── AI 状态与账本（0.8.0）─────────────────────────────────────────

/**
 * 读 AI 状态：四道检查 + 最近失败统计。
 *
 * 不抛错：状态读不出来本身也是一种状态（比如插件刚被热重载），
 * 界面要显示「状态未知」，所以这里把失败折成 null 交给调用方。
 */
export async function aiStatus() {
  try {
    return await call('ai.status')
  } catch (error) {
    return null
  }
}

/** 真实探测一次：发一句极小的话。返回 `{ ok, latencyMs, model, code?, message?, fix? }`。 */
export async function aiProbe() {
  return call('ai.probe')
}

/** 最近调用账本，最新在前。 */
export async function aiLog(limit = 50) {
  const result = await call('ai.log', { limit })
  return result && Array.isArray(result.items) ? result.items : []
}

export async function aiLogClear() {
  return call('ai.log.clear', {})
}

/**
 * 模型名单 + 这次实际会用哪条路由（0.8.1）。
 *
 * 名单由宿主给，读不到时后端回 `available:false`，界面据此只显示「跟随会话」。
 * 这一条不吞错：读不到名单必须让用户看见原因。
 */
export async function aiModels() {
  return call('ai.models')
}

// ── 读书蒸馏（0.8.0）──────────────────────────────────────────────

export async function distillGet(bookHash) {
  return call('distill.get', { bookHash })
}

/** 蒸一章。会真的调一次模型，慢（几十秒）——调用方要自己显示进度。 */
export async function distillChapter(bookHash, href) {
  return call('distill.chapter', { bookHash, href })
}

export async function distillSkeleton(bookHash) {
  return call('distill.skeleton', { bookHash })
}

export async function distillClear(bookHash) {
  return call('distill.clear', { bookHash })
}

export async function distillExport(bookHash) {
  const result = await call('distill.export', { bookHash })
  return result && typeof result.markdown === 'string' ? result.markdown : ''
}
