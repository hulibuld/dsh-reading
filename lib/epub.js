/**
 * EPUB 解析（零依赖）：ZIP → container.xml → OPF → spine / toc / 章节正文。
 *
 * 设计要点：
 *   - 只认 ZIP store/deflate；加密、deflate64、Zip64 一律明确失败，不做「尽量读一点」。
 *   - 解压上限（总 512 MB / 单文件 64 MB / 条目 20000）是硬门禁：EPUB 是用户从
 *     网上下载的不可信文件，压缩炸弹必须在这里挡住。
 *   - `chapterHtml()` 返回的是**原始 XHTML 文本**，一个字节都不改。改写资源地址是
 *     路由层的职责（docs/05 §3.4），解析层一旦动手，CFI 就会跟着漂。
 *   - 所有 href 统一成「相对 OPF 所在目录的 POSIX 路径」（如 `text/ch1.xhtml`），
 *     与 meta.spine.href 一致；带 `#fragment` 的 toc href 会被拆开。
 *
 * 什么时候会失败、失败给谁看：
 *   - `E_EPUB_ENCRYPTED` / `E_EPUB_TOO_BIG` / `E_EPUB_NO_CONTAINER` / `E_EPUB_NO_OPF` /
 *     `E_EPUB_BAD_OPF` / `E_EPUB_NO_SPINE`：都是业务错误，message 直接给用户看，
 *     例如「这本书有 DRM 保护，暂时读不了」。
 *   - ZIP/XML 层抛的原始错误码在这里被翻译成 EPUB 语义，避免让用户看到 `E_ZIP64`。
 */

import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { readZip } from './zip.js'
import { parseXml, findAll, childrenByName, findByName, textOf, attr, attrLocal } from './xml.js'
import { fail, isAppError } from './errors.js'

/** 解压总大小上限 512 MB。 */
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024
/** 单文件解压上限 64 MB。 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** 条目总数上限 20000。 */
export const MAX_ENTRIES = 20000

/** 允许作为 spine 章节的 media-type。 */
const CHAPTER_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/xml', 'text/xml'])

/** 按扩展名给 media-type（EPUB 章节里引用的图片/CSS/字体）。 */
const MEDIA_TYPES = {
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.ncx': 'application/x-dtbncx+xml',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

/** 从路径扩展名推 media-type；未知给 `application/octet-stream`。 */
export function mediaTypeFor(href) {
  const clean = String(href ?? '').split(/[?#]/, 1)[0].toLowerCase()
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MEDIA_TYPES[clean.slice(dot)] ?? 'application/octet-stream'
}

/**
 * 规范化一个 ZIP 内路径 / 相对 href 成 POSIX、无前导 `./`、已解码 `%xx` 的形态。
 *
 * 只做「写法归一」，不做越界判断：`..` 保留，交给 resolveHref 逐段吃掉。
 * 若吃掉 `..` 后仍要往上走（越过 OPF 根），返回 null——这种 href 一律当成不存在。
 *
 * @param {string} href
 * @returns {string|null}
 */
export function normalizeHref(href) {
  let value = String(href ?? '').trim()
  const hash = value.indexOf('#')
  if (hash >= 0) value = value.slice(0, hash)
  const query = value.indexOf('?')
  if (query >= 0) value = value.slice(0, query)
  value = value.replace(/\\/g, '/')
  try {
    value = decodeURIComponent(value)
  } catch {
    // 非法百分号编码：按原文处理，后面按名查不到自然返回 null。
  }
  const out = []
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
 * 把相对 href 解析成「相对 OPF 目录」的路径。
 *
 * @param {string} baseDir - 当前文件（OPF 或章节）所在的 ZIP 内目录，`''` 表示根。
 * @param {string} href
 * @returns {string|null} 解析失败（越过根）返回 null
 */
export function resolveHref(baseDir, href) {
  const normalized = normalizeHref(href)
  if (normalized === null) return null
  const joined = baseDir ? `${baseDir}/${normalized}` : normalized
  return normalizeHref(joined)
}

/** POSIX dirname。 */
function dirnameOf(zipPath) {
  const slash = zipPath.lastIndexOf('/')
  return slash < 0 ? '' : zipPath.slice(0, slash)
}

/** 把 ZIP 错误翻译成 EPUB 语义，保证用户看到的不是 `E_ZIP64`。 */
function translateZipError(error) {
  if (!isAppError(error)) return error
  if (error.code === 'E_ZIP_TOO_BIG') {
    // readZip 的尺寸门禁触发了：对用户来说就是「这本书太大」。
    return fail('E_EPUB_TOO_BIG', '这本书展开后太大了，暂时读不了。', {
      detail: error.detail,
      cause: error,
    })
  }
  if (error.code === 'E_ZIP64') {
    return fail('E_EPUB_UNSUPPORTED', '这本书用了暂不支持的压缩格式，读不了。', {
      detail: error.detail,
      cause: error,
    })
  }
  if (error.code === 'E_ZIP_ENCRYPTED' || error.code === 'E_ZIP_METHOD') {
    return fail('E_EPUB_ENCRYPTED', '这本书有 DRM 保护或用了不支持的压缩方式，读不了。', {
      detail: error.detail,
      cause: error,
    })
  }
  if (error.code === 'E_ZIP_MALFORMED' || error.code === 'E_ZIP_MISSING') {
    return fail('E_EPUB_MALFORMED', '这本书的文件似乎损坏了，读不出来。', {
      detail: error.detail,
      cause: error,
    })
  }
  return error
}

/**
 * 解码 XHTML/XML 字节：优先 UTF-8，其次 UTF-16 BOM。
 *
 * UTF-16BE 那段必须真做字节交换再交给 Node：Node 只有 utf16le，直接把 BE 的
 * 字节按 LE 读出来是**乱码但不报错**，表现为「这本书打开全是问号」。宁可多
 * 拷一次 buffer，也不要静默出乱码。
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function decodeText(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2)
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const body = bytes.subarray(2)
      const swapped = Buffer.alloc(body.length - (body.length % 2))
      for (let i = 0; i + 1 < body.length; i += 2) {
        swapped[i] = body[i + 1]
        swapped[i + 1] = body[i]
      }
      return swapped.toString('utf16le')
    }
  }
  let text = bytes.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/**
 * 解析一本 EPUB。
 *
 * @param {string|Buffer|Uint8Array} source - 文件路径或整个文件的字节。
 * @param {{ deviceId?: string, now?: string, filename?: string }} [options]
 *   `now`/`deviceId` 只用于填 meta，测试里传固定值以便断言。
 * @returns {Promise<{
 *   meta: object,
 *   toc: Array<{ label: string, href: string, spineIndex: number, depth: number }>,
 *   spine: Array<{ href: string, idref: string, index: number, mediaType: string }>,
 *   coverHref: string|null,
 *   bookHash: string,
 *   chapterHtml: (href: string) => Promise<string|null>,
 *   assetBytes: (href: string, baseHref?: string) => Promise<{ bytes: Buffer, mediaType: string }|null>,
 *   hasEntry: (zipPath: string) => boolean,
 *   dispose: () => Promise<void>
 * }>}
 */
export async function parseEpub(source, options = {}) {
  const { bytes, filename, tempPath } = await loadSource(source, options)
  const bookHash = createHash('sha256').update(bytes).digest('hex')
  const fileSize = bytes.length

  let zip
  try {
    // 上限直接交给 readZip：它在读中央目录时就用「声明的解压后大小」判，
    // 一字节都不解压。这样超限包永远走不到 inflate，内存不会被炸弹碰到。
    zip = readZip(bytes, {
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxEntries: MAX_ENTRIES,
    })
  } catch (error) {
    throw translateZipError(error)
  }

  // ── 加密检测：有 EncryptedData 就拒绝（字体混淆同样算，宁可明确失败） ──
  if (zip.has('META-INF/encryption.xml')) {
    let encryptionText = ''
    try {
      encryptionText = decodeText(zip.get('META-INF/encryption.xml'))
    } catch (error) {
      throw translateZipError(error)
    }
    if (/<\s*(?:[A-Za-z_][\w.-]*:)?EncryptedData\b/.test(encryptionText)) {
      throw fail('E_EPUB_ENCRYPTED', '这本书有 DRM 保护，暂时读不了。', {
        detail: 'META-INF/encryption.xml declares EncryptedData',
      })
    }
  }

  if (!zip.has('META-INF/container.xml')) {
    throw fail('E_EPUB_NO_CONTAINER', '这个文件看起来不是一本 EPUB。', {
      detail: 'missing META-INF/container.xml',
    })
  }

  const containerXml = safeParse(decodeText(readEntry(zip, 'META-INF/container.xml')), 'META-INF/container.xml')
  const rootfiles = findAll(containerXml, (node) => node.name === 'rootfile' || node.name.endsWith(':rootfile'))
  const opfPath = rootfiles.length > 0 ? attr(rootfiles[0], 'full-path') : undefined
  if (!opfPath) {
    throw fail('E_EPUB_NO_OPF', '这本书的目录信息缺失，读不了。', {
      detail: 'container.xml has no rootfile@full-path',
    })
  }
  const opfZipPath = normalizeHref(opfPath)
  if (!opfZipPath || !zip.has(opfZipPath)) {
    throw fail('E_EPUB_NO_OPF', '这本书的目录信息缺失，读不了。', {
      detail: `rootfile not found: ${opfPath}`,
    })
  }

  const opfDir = dirnameOf(opfZipPath)
  const opfXml = safeParse(decodeText(readEntry(zip, opfZipPath)), opfZipPath)

  const metadata = findByName(opfXml, 'metadata')[0] ?? { children: [] }
  const title = firstText(metadata, 'title') || deriveTitle(filename, opfZipPath)
  const author = firstText(metadata, 'creator')
  const language = firstText(metadata, 'language')

  // ── manifest ──
  // href 统一存「相对 OPF 目录」的形态（`text/ch1.xhtml`），与 docs/05 §4.1 一致。
  // ZIP 内路径只在内部用 zipPathFor() 临时算，绝不外泄——否则 meta.spine.href
  // 会带上 `OEBPS/` 这类前缀，手机端照契约重建 CFI 前缀时就会对不上。
  /** @type {Map<string, { id: string, href: string, mediaType: string, properties: string }>} */
  const manifest = new Map()
  const manifestNode = findByName(opfXml, 'manifest')[0]
  if (manifestNode) {
    for (const item of childrenByName(manifestNode, 'item')) {
      const id = attr(item, 'id')
      const rawHref = attr(item, 'href')
      if (!id || !rawHref) continue
      const href = normalizeHref(rawHref)
      if (href === null) continue
      manifest.set(id, {
        id,
        href,
        mediaType: (attr(item, 'media-type') ?? mediaTypeFor(href)).toLowerCase(),
        properties: (attr(item, 'properties') ?? '').toLowerCase(),
      })
    }
  }

  // ── spine ──
  const spineNode = findByName(opfXml, 'spine')[0]
  if (!spineNode) {
    throw fail('E_EPUB_NO_SPINE', '这本书没有可读的章节。', { detail: 'OPF has no <spine>' })
  }
  /** @type {Array<{ href: string, idref: string, index: number, mediaType: string }>} */
  const spine = []
  for (const itemref of childrenByName(spineNode, 'itemref')) {
    const idref = attr(itemref, 'idref')
    if (!idref) continue
    const item = manifest.get(idref)
    if (!item) continue
    // 只收 XHTML/HTML：EPUB 的 spine 也可能塞图片页之类的非文本项。
    if (!CHAPTER_TYPES.has(item.mediaType)) continue
    if (spine.length >= MAX_ENTRIES) break
    spine.push({ href: item.href, idref, index: spine.length, mediaType: item.mediaType })
  }
  if (spine.length === 0) {
    throw fail('E_EPUB_NO_SPINE', '这本书没有可读的章节。', { detail: 'spine resolved to 0 chapters' })
  }

  /** 按名字查章节在 spine 里的位置（用于 toc 归位）。 */
  const spineIndexByHref = new Map()
  for (const entry of spine) {
    if (!spineIndexByHref.has(entry.href)) spineIndexByHref.set(entry.href, entry.index)
  }

  // ── toc：EPUB3 nav 优先，回退 EPUB2 NCX，最后回退 spine ──
  // 三个来源的 href 都要归一成「相对 OPF 目录」，与 spine 的写法一致，
  // 否则 spineIndex 查不到、客户端也拼不出章节地址。
  //
  // tocSource 记录「这个目录到底是从哪来的」（0.4.0，施工图 §6）：界面靠它
  // 决定挂不挂「自动识别」角标。spine 兜底的那份是 idref 冒充的章名，
  // 服务端会当作「没有目录」不发给界面，但字段值仍然如实记成 spine。
  let toc = []
  let tocSource = 'none'
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
  if (navItem) {
    toc = readNavToc(zip, navItem.href, spineIndexByHref, opfDir)
    if (toc.length > 0) tocSource = 'nav'
  }
  if (toc.length === 0) {
    const ncxId = attr(spineNode, 'toc')
    const ncxItem = ncxId ? manifest.get(ncxId) : undefined
    const ncx = ncxItem ?? [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
    if (ncx) {
      toc = readNcxToc(zip, ncx.href, spineIndexByHref, opfDir)
      if (toc.length > 0) tocSource = 'ncx'
    }
  }
  if (toc.length === 0) {
    toc = spine.map((entry) => ({
      label: entry.idref,
      href: entry.href,
      spineIndex: entry.index,
      depth: 0,
    }))
    tocSource = 'spine'
  }

  // ── cover ──
  let coverHref = null
  const coverItem =
    [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('cover-image')) ??
    (() => {
      const metaCover = findByName(opfXml, 'meta').find((node) => attr(node, 'name') === 'cover')
      const id = metaCover ? attr(metaCover, 'content') : undefined
      return id ? manifest.get(id) : undefined
    })()
  if (coverItem && /^image\//.test(coverItem.mediaType)) coverHref = coverItem.href

  const zipPathFor = (href) => {
    const resolved = resolveHref(opfDir, href)
    return resolved === null ? null : resolved
  }

  /**
   * 以某个文件为基准解析相对地址，返回「ZIP 内绝对路径」。
   *
   * 为什么不能在「相对 OPF 的路径」上直接 `..`：`text/ch1.xhtml` 里写
   * `../images/a.png` 表示 OPF 根下的 `images/a.png`，而单纯对相对路径做归一
   * 会在第一步就被判成「越界」。正确做法是先拼成 ZIP 内绝对路径再逐段吃 `..`。
   *
   * @param {string} baseHref - ZOP 相对基准文件（如 `text/ch1.xhtml`）
   * @param {string} raw - 相对地址
   * @returns {string|null} 越出 ZIP 根返回 null
   */
  const zipPathFrom = (baseHref, raw) => {
    const basePath = zipPathFor(baseHref)
    if (basePath === null) return null
    const baseDir = dirnameOf(basePath)
    const rawPath = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    const joined = baseDir === '' ? rawPath : `${baseDir}/${rawPath}`
    return normalizeHref(joined)
  }

  /**
   * 对外暴露的相对地址解析：返回「OPF 相对路径」，跑出 OPF 目录一律 null
   * （章节不允许引用书外的东西，也不允许跳出 OPF 根）。
   */
  const resolveRelative = (baseHref, raw) => {
    const zipPath = zipPathFrom(baseHref, raw)
    if (zipPath === null) return null
    if (opfDir === '') return zipPath
    if (zipPath === opfDir) return ''
    if (!zipPath.startsWith(`${opfDir}/`)) return null
    return zipPath.slice(opfDir.length + 1)
  }

  /**
   * 读章节原文。找不到返回 null（调用方转 404），不抛错——
   * 目录里可能有一条指向已删文件的 href，那不该让整章 500。
   * @param {string} href
   * @returns {Promise<string|null>}
   */
  async function chapterHtml(href) {
    const zipPath = zipPathFor(href)
    if (zipPath === null || !zip.has(zipPath)) return null
    try {
      return decodeText(readEntry(zip, zipPath))
    } catch (error) {
      throw translateZipError(error)
    }
  }

  /**
   * 读章节引用的资源。
   * @param {string} href - 可以是 OPF 相对路径，也可以是章节内的相对地址。
   * @param {string} [baseHref] - 章节自身的 href；给了就先按章节目录解析一次。
   * @returns {Promise<{ bytes: Buffer, mediaType: string }|null>}
   */
  async function assetBytes(href, baseHref) {
    const candidates = []
    const direct = zipPathFor(href)
    if (direct) candidates.push(direct)
    if (baseHref) {
      const fromChapter = zipPathFrom(baseHref, href)
      if (fromChapter) candidates.push(fromChapter)
    }
    for (const zipPath of candidates) {
      if (!zip.has(zipPath)) continue
      try {
        return { bytes: readEntry(zip, zipPath), mediaType: mediaTypeFor(zipPath) }
      } catch (error) {
        throw translateZipError(error)
      }
    }
    return null
  }

  const now = typeof options.now === 'string' && options.now !== '' ? options.now : new Date().toISOString()

  const meta = {
    schema: 'dsh-reading/1',
    bookHash,
    title,
    // author 允许空串，但字段保留：schema 里它不是必填，客户端却会读它，
    // 缺字段与空串在界面上表现不同（前者是 undefined，后者是「没有作者」）。
    author,
    format: 'epub',
    fileSize,
    // 每一项都带 index：schema 的 $defs/meta.spine.required 是 ["index","href"]。
    // index 是 CFI 前缀校验与重建的唯一依据，不是可推导的冗余。
    spine: spine.map((entry) => ({
      index: entry.index,
      href: entry.href,
      idref: entry.idref,
      mediaType: entry.mediaType,
    })),
    converterVersion: 'epub/1',
    createdAt: now,
    updatedAt: now,
    deviceId: typeof options.deviceId === 'string' ? options.deviceId : '',
  }
  if (language) meta.language = language
  if (coverHref) meta.coverHref = coverHref
  meta.tocSource = tocSource

  return {
    meta,
    toc,
    tocSource,
    spine,
    coverHref,
    bookHash,
    chapterHtml,
    assetBytes,
    hasEntry: (zipPath) => zip.has(zipPath),
    /**
     * OPF 相对 href → ZIP 内路径。路由层用它把章节地址解析成同一套路径，
     * 避免两处各写一份归一逻辑（分叉后的表现是「图有时能显示有时不能」）。
     */
    hrefToZipPath: (href) => zipPathFor(href),
    /**
     * 以某文件为基准解析相对地址，返回 OPF 相对路径；越出 OPF 根返回 null。
     * 章节里的 `../images/a.jpg` 靠它归一。
     */
    resolveRelative: (baseHref, raw) => resolveRelative(baseHref, raw),
    /** OPF 所在目录（ZIP 内路径，`''` 表示根），路由层拼资源地址时用。 */
    opfDir,
    /** 临时文件（base64 导入时落过盘）在解析完成后清掉；路径导入时是 no-op。 */
    dispose: async () => {
      if (tempPath) {
        try {
          await fs.rm(tempPath, { force: true })
        } catch {
          // 临时文件删不掉不影响阅读：系统临时目录本来就会自己清。
        }
      }
    },
  }
}

/** 读一个条目并套上单文件上限（inflate 有 maxOutputLength，双保险）。 */
function readEntry(zip, name) {
  let bytes
  try {
    bytes = zip.get(name)
  } catch (error) {
    throw translateZipError(error)
  }
  if (bytes.length > MAX_ENTRY_BYTES) {
    throw fail('E_EPUB_TOO_BIG', '这本书展开后太大了，暂时读不了。', {
      detail: `entry decoded too big: ${name} ${bytes.length}`,
    })
  }
  return bytes
}

function safeParse(text, label) {
  try {
    return parseXml(text)
  } catch (error) {
    if (isAppError(error) && error.code === 'E_XML_MALFORMED') {
      throw fail('E_EPUB_MALFORMED', '这本书的内容格式不对，读不了。', {
        detail: `${label}: ${error.detail}`,
        cause: error,
      })
    }
    throw error
  }
}

/** 取 metadata 下某个元素的第一个非空文本。 */
function firstText(metadata, name) {
  for (const node of findByName(metadata, name)) {
    const value = textOf(node).trim()
    if (value !== '') return value
  }
  return ''
}

/** 书名回退：先用文件名，去掉扩展名与常见后缀垃圾。 */
function deriveTitle(filename, opfZipPath) {
  const raw = String(filename ?? '').trim() || basename(opfZipPath)
  const withoutExt = raw.replace(/\.epub$/i, '')
  return withoutExt === '' ? '未命名' : withoutExt
}

/** 从 source 拿到字节与文件名。Buffer 直接用；路径读盘；两者都记下临时文件以便清理。 */
async function loadSource(source, options) {
  if (typeof source === 'string') {
    const bytes = await fs.readFile(source)
    return { bytes, filename: options.filename ?? basename(source), tempPath: null }
  }
  if (source instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength)
    return { bytes, filename: options.filename ?? '', tempPath: null }
  }
  throw fail('E_EPUB_MALFORMED', '这本书的文件似乎损坏了，读不出来。', {
    detail: 'unsupported source type',
  })
}

/**
 * 解析 EPUB3 导航文档。
 *
 * 只要 `nav` 元素里带 `epub:type="toc"`（属性前缀不固定，用 attrLocal 找），
 * 递归读 `ol > li > a` 得到 label/href/depth。找不到 toc nav 就返回空数组，
 * 让调用方回退 NCX。
 *
 * href 输出的形态与 manifest 一致（相对 OPF 目录）：nav 文档自己可能在下级目录，
 * 它里面写的 `../text/ch1.xhtml` 必须先拼成 ZIP 内路径再折回 OPF 相对路径，
 * 否则 spineIndex 查不到、目录点击会 404。
 *
 * @param {{ has: Function, get: Function }} zip
 * @param {string} navHref - nav 文档的 OPF 相对 href
 * @param {Map<string, number>} spineIndexByHref
 * @param {string} opfDir
 */
function readNavToc(zip, navHref, spineIndexByHref, opfDir) {
  const navPath = resolveHref(opfDir, navHref)
  if (navPath === null || !zip.has(navPath)) return []
  let xml
  try {
    xml = safeParse(decodeText(readEntry(zip, navPath)), navPath)
  } catch {
    // nav 文档坏了不该让整本书打不开：返回空数组，让调用方回退 NCX / spine。
    return []
  }
  const navs = findByName(xml, 'nav')
  const tocNav =
    navs.find((node) => (attrLocal(node, 'type') ?? '').split(/\s+/).includes('toc')) ?? navs[0]
  if (!tocNav) return []
  const baseDir = dirnameOf(navPath)
  const out = []

  const walk = (parent, depth) => {
    for (const ol of childrenByName(parent, 'ol')) {
      for (const li of childrenByName(ol, 'li')) {
        const anchor = childrenByName(li, 'a')[0] ?? childrenByName(li, 'span')[0]
        if (anchor) {
          const rawHref = attr(anchor, 'href')
          const label = textOf(anchor).replace(/\s+/g, ' ').trim()
          if (rawHref !== undefined) {
            const href = toOpfRelative(resolveHref(baseDir, rawHref), opfDir)
            if (href !== null && label !== '') {
              out.push({ label, href, spineIndex: spineIndexByHref.get(href) ?? -1, depth })
            }
          }
        }
        // 嵌套 ol 进下一层；li 直接套 li 的畸形结构也继续走。
        walk(li, depth + 1)
      }
    }
  }
  walk(tocNav, 0)
  return out
}

/**
 * 把 ZIP 内路径折回「相对 OPF 目录」的形态。跑出 OPF 目录返回 null——
 * 目录里指向书外（或别的目录）的项没有意义，宁可丢掉也不要让点击落空。
 *
 * @param {string|null} zipPath
 * @param {string} opfDir
 * @returns {string|null}
 */
function toOpfRelative(zipPath, opfDir) {
  if (zipPath === null) return null
  if (opfDir === '') return zipPath
  if (zipPath === opfDir) return ''
  if (!zipPath.startsWith(`${opfDir}/`)) return null
  return zipPath.slice(opfDir.length + 1)
}

/**
 * 解析 EPUB2 NCX。
 *
 * navPoint 递归；label 取 navLabel/text 第一个非空；href 取 content@src。
 * 解析失败返回空数组（NCX 是可选的，坏了不该让整本书打不开）。
 */
function readNcxToc(zip, ncxHref, spineIndexByHref, opfDir) {
  const ncxPath = resolveHref(opfDir, ncxHref)
  if (ncxPath === null || !zip.has(ncxPath)) return []
  let xml
  try {
    xml = safeParse(decodeText(readEntry(zip, ncxPath)), ncxPath)
  } catch {
    // NCX 是 EPUB2 的可选件：解析失败时回退成「用 spine 的 idref 当标题」。
    return []
  }
  const baseDir = dirnameOf(ncxPath)
  const out = []

  const walk = (parent, depth) => {
    for (const point of childrenByName(parent, 'navPoint')) {
      const labelNode = childrenByName(point, 'navLabel')[0]
      const label = labelNode ? textOf(labelNode).replace(/\s+/g, ' ').trim() : ''
      const content = childrenByName(point, 'content')[0]
      const rawHref = content ? attr(content, 'src') : undefined
      if (rawHref !== undefined && label !== '') {
        const href = toOpfRelative(resolveHref(baseDir, rawHref), opfDir)
        if (href !== null) {
          out.push({ label, href, spineIndex: spineIndexByHref.get(href) ?? -1, depth })
        }
      }
      walk(point, depth + 1)
    }
  }

  const navMap = findByName(xml, 'navMap')[0]
  if (navMap) walk(navMap, 0)
  return out
}
