/**
 * 本地书库（文件系统）。
 *
 * 布局严格按 docs/05 §3.2：
 *
 *   <libraryDir>/dsh-reading/
 *   ├── settings.json
 *   ├── device.json                         ← 本机设备标识，**不参与同步**
 *   └── books/<16 位 hex>/
 *       ├── book.epub
 *       ├── meta.json
 *       ├── progress.json
 *       ├── annotations.jsonl
 *       ├── qa.jsonl
 *       ├── quarantine.jsonl
 *       └── history/
 *
 * 两个设计决定值得单独说明：
 *
 * 1. **jsonl 只追加，墓碑不删行。** 这是为将来的 WebDAV 同步留的形状（docs/01 §2.10）：
 *    两台设备各加一条，合并后两条都在；删除只写 `deleted:true`。读取时按
 *    `(updatedAt, deviceId)` 取每组的最新一条，因此同一 id 多次写入不需要改写历史行。
 *    `progress.json` / `settings.json` 是整文件覆盖写，覆盖前把旧文件复制进 `history/`。
 *
 * 2. **章节正文绝不缓存到磁盘。** 只有内存里的解析缓存（按 bookHash），进程重启即失效。
 *    把改写过资源地址的章节落盘会同时污染 CFI 与内容——这是 docs/05 §3.4 的红线。
 *
 * 什么时候会失败、失败给谁看：
 *   - 书不存在 / 文件缺失 → `E_BOOK_NOT_FOUND`，界面显示「这本书不在了，重新导入试试」。
 *   - 导入超限 → `E_IMPORT_TOO_BIG`；base64 坏了 → `E_IMPORT_BAD_BASE64`。
 *   - 记录字段缺失 → `E_BAD_RECORD`，message 里不点名字段（detail 里点）。
 *   - 其余 IO 异常原样上抛，由 routes 落成 500 内部错误。
 */

import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { LibraryPaths, bookDirName, bookHashFull } from './paths.js'
import { ensureDeviceId } from './device.js'
import { parseBook, extensionOf } from './bookformat.js'
import { fail, isAppError } from './errors.js'
import { buildSearchUrl } from './sources.js'
import { EFFORT_ORDER } from './aimodel.js'

/** 历史副本保留份数（docs/05 §3.2 / docs/01 §2.8）。 */
export const HISTORY_KEEP = 20

/** qa.list 单次最多返回多少条（防坏文件撑爆响应；不是翻页上限）。 */
export const MAX_QA_LIST = 1000

/** 阅读偏好的默认值；键名与 docs/05 §3.3 一字不差。 */
export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 18,
  lineHeight: 1.6,
  theme: 'auto',
  columns: 1,
  fontFamily: '',
  /** 「找书」的书源（0.5.1）。默认空：不内置任何站点，由用户自己填。 */
  bookSources: Object.freeze([]),
  /** 插件里 AI 调用用哪个模型（0.8.1）。空 = 跟随会话/宿主默认。 */
  aiProvider: '',
  aiModel: '',
  /** 思考强度。默认 high（用户要求：默认开、高档，但不锁死 max）。空 = 跟随模型默认。 */
  aiEffort: 'high',
})

/** 书源条数上限。够用，又能挡住把 settings.json 写成通讯录。 */
export const MAX_BOOK_SOURCES = 8

/** 记录类型枚举（docs/01 §2.5）。 */
const RECORD_TYPES = new Set(['highlight', 'note', 'bookmark'])

/** 五色枚举（schema/contract.schema.json `$defs.color`）。 */
const COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple'])

/** ULID 的字符集与长度（Crockford Base32，26 位）。 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 书名长度上限（0.4.0 §4.2）。按 UTF-16 码元算，一个汉字算一个字。 */
export const MAX_TITLE_LENGTH = 120

/** 作者名长度上限。给得比书名短：作者是一串名字，不是一段介绍。 */
export const MAX_AUTHOR_LENGTH = 80

/** 简介上限（0.5.1）。一本书的介绍，不是书评，2000 字足够。 */
export const MAX_DESCRIPTION_LENGTH = 2000
/** 分类名单个上限。 */
export const MAX_CATEGORY_LENGTH = 40
/** 系列名单个上限。 */
export const MAX_SERIES_LENGTH = 80
/** 标签个数与单个长度上限。 */
export const MAX_TAG_COUNT = 12
export const MAX_TAG_LENGTH = 24

/**
 * 归一化标签数组：去空白、去空项、去重、保序。
 * 非法（不是数组 / 超数量 / 超长）返回 `null`，由调用方决定报错。
 *
 * @param {unknown} value
 * @returns {string[]|null}
 */
export function normalizeTags(value) {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_TAG_COUNT * 2) return null
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const item of value) {
    const tag = typeof item === 'string' ? item.trim() : ''
    if (tag === '') continue
    if (Array.from(tag).length > MAX_TAG_LENGTH) return null
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length > MAX_TAG_COUNT) return null
  }
  return out
}

/** 封面图上限 3 MiB：手机原图往往 4–8 MB，客户端会先压一道；这里只兜底。 */
export const MAX_COVER_BYTES = 3 * 1024 * 1024

/**
 * 封面魔数表（施工图 §5.6）：只按文件头认图。
 *
 * 为什么不信扩展名：用户把 `cover.png` 改成 `cover.jpg` 是常规操作，
 * 客户端也会把 content-type 写错；按魔数判是唯一稳的口径。
 */
const COVER_MAGIC = [
  {
    ext: 'png',
    mediaType: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    ext: 'jpg',
    mediaType: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'gif',
    mediaType: 'image/gif',
    test: (b) => b.length >= 6 && b.subarray(0, 3).toString('latin1') === 'GIF',
  },
  {
    ext: 'webp',
    mediaType: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
]

/**
 * 按魔数识别封面图片。
 *
 * @param {Buffer} bytes
 * @returns {{ ext: string, mediaType: string }|null} 认不出来返回 null
 */
export function sniffCoverImage(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  for (const image of COVER_MAGIC) {
    if (image.test(buffer)) return { ext: image.ext, mediaType: image.mediaType }
  }
  return null
}

/**
 * 书库门面。一个实例对应一个书库目录；所有读写都从这里走，路由不碰 fs。
 */
export class LibraryStore {
  /**
   * @param {{ libraryDir?: string, maxImportBytes?: number, deviceId?: string, now?: () => string, logger?: { warn: Function } }} [options]
   */
  constructor(options = {}) {
    this.paths = new LibraryPaths(options.libraryDir ?? '')
    this.maxImportBytes =
      Number.isFinite(options.maxImportBytes) && options.maxImportBytes > 0
        ? Math.floor(options.maxImportBytes)
        : 200 * 1024 * 1024
    /** 注入的时钟（测试用）；默认 `new Date().toISOString()`，天然带毫秒与 Z。 */
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
    this.logger = options.logger ?? console
    /** @type {string|null} */
    this.deviceId = typeof options.deviceId === 'string' && options.deviceId !== '' ? options.deviceId : null
    /** @type {Map<string, any>} bookHash(16) → parseEpub 的结果 */
    this.epubCache = new Map()
    // 已经尝试过「补封面」的书目录。失败也只试一次：书架每次刷新都去解一遍
    // 一个坏掉的 20MB MOBI 是不可接受的，宁可这本书一直没有封面。
    this.coverAttempted = new Set()
    this.ready = null
  }

  /** 幂等初始化：建目录骨架 + 拿到 deviceId。 */
  async init() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      await this.paths.ensureRoot()
      if (this.deviceId === null) {
        this.deviceId = await ensureDeviceId(this.paths.root)
      }
      return this
    })()
    try {
      return await this.ready
    } catch (error) {
      // 初始化失败不要留下一个永远拒绝服务的 Promise。
      this.ready = null
      throw error
    }
  }

  /** 拿 deviceId（未 init 时先 init）。 */
  async getDeviceId() {
    await this.init()
    return this.deviceId ?? 'dev-000000'
  }

  // ── 书 ──────────────────────────────────────────────────────────

  /**
   * 导入一本 EPUB。
   *
   * 幂等：同一份字节重复导入只返回已有结果，不重写文件——避免把用户在读的
   * 那份 book.epub 覆盖掉（虽然内容相同，但 mtime 变化会让缓存失效）。
   *
   * @param {{ filename?: string, dataBase64?: string }} input
   * @returns {Promise<{ bookHash: string, meta: object }>}
   */
  async importBook(input) {
    await this.init()
    const filename = typeof input?.filename === 'string' ? input.filename : ''
    const base64 = typeof input?.dataBase64 === 'string' ? input.dataBase64 : ''
    if (base64 === '') {
      throw fail('E_IMPORT_EMPTY', '没有收到书籍文件，请重新选择一次。')
    }

    // 先按 base64 长度粗估，避免为一个明显超限的文件分配几十 MB 的 Buffer。
    const estimated = Math.floor((base64.length * 3) / 4)
    if (estimated > this.maxImportBytes + 4) {
      throw fail('E_IMPORT_TOO_BIG', '这本书文件太大了，暂时导入不了。', {
        detail: `base64 estimate=${estimated} limit=${this.maxImportBytes}`,
      })
    }

    let bytes
    try {
      bytes = Buffer.from(base64, 'base64')
    } catch (error) {
      throw fail('E_IMPORT_BAD_BASE64', '书籍文件传输不完整，请重新导入一次。', {
        detail: `base64 decode failed: ${String(error && error.message)}`,
        cause: error,
      })
    }
    if (bytes.length === 0) {
      throw fail('E_IMPORT_BAD_BASE64', '书籍文件传输不完整，请重新导入一次。')
    }
    if (bytes.length > this.maxImportBytes) {
      throw fail('E_IMPORT_TOO_BIG', '这本书文件太大了，暂时导入不了。', {
        detail: `bytes=${bytes.length} limit=${this.maxImportBytes}`,
      })
    }

    let parsed
    try {
      // 格式分诊在 bookformat 层：EPUB / MOBI(AZW3) / TXT / PDF 都归一到同一形状，
      // 书库这一层不需要知道手里这本书原来是什么格式。
      parsed = await parseBook(bytes, { deviceId: await this.getDeviceId(), now: this.now(), filename })
    } catch (error) {
      throw this.translate(error)
    }

    const bookHash = bookHashFull(parsed.meta.bookHash)
    const dirName = bookDirName(bookHash)
    const dir = await this.paths.ensureBook(dirName)
    const metaFile = path.join(dir, 'meta.json')
    // 落盘用原扩展名（book.epub / book.txt / book.mobi / book.azw3）：
    // 用户去书库目录里翻的时候能一眼看出这是哪来的文件。
    const bookFile = path.join(dir, `book.${extensionOf(parsed.meta)}`)

    const existing = await this.readJson(metaFile)
    if (existing && existing.bookHash === bookHash) {
      return { bookHash, meta: existing }
    }

    await writeFileAtomic(bookFile, bytes)
    const meta = {
      ...parsed.meta,
      // 书名兜底：MOBI 常常没有 EXTH 503，解析器会拿文件名顶上，
      // 而很多下载站的文件名本身就是一串 hash —— 用户看到的就是「一堆乱码」。
      // 这里按「书名 → 文件名 → 明确的无名」三级退回，绝不把 hash 当书名展示。
      title: sensibleTitle(parsed.meta.title, filename),
      bookHash,
      // 保留已有 createdAt：重新导入同一本书不该重置「何时入架」。
      createdAt: existing?.createdAt ?? parsed.meta.createdAt,
      updatedAt: parsed.meta.updatedAt,
    }
    await writeFileAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`)
    this.epubCache.delete(dirName)
    return { bookHash, meta }
  }

  /**
   * 从书库移除一本书（整个目录，含标注）。
   *
   * 这是**用户显式操作**，因此不做 history 备份：备份整个目录会让书库体积翻倍，
   * 而用户点「删除」的意图就是清掉。真要保底靠系统回收站。
   *
   * @param {string} bookHash
   * @returns {Promise<{ removed: true }>}
   */
  async removeBook(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    this.epubCache.delete(dirName)
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch (error) {
      throw fail('E_REMOVE_FAILED', '删除这本书时出错了，请稍后重试。', {
        detail: String(error && error.message),
        cause: error,
      })
    }
    return { removed: true }
  }

  /**
   * 改书名 / 作者（0.4.0）。
   *
   * 只认这两个字段，其余键一律忽略（界面允许只改作者，不强迫重填书名）。
   * 校验放在这一层而不是路由：同一套规则在任何调用方都成立，测试也能直接
   * 打 store 而不绕路由。错误用 `E_ARGS` + 400 —— 这是「你填的内容不行」，
   * 不是「服务器出错了」，界面要能把 message 原样摆到输入框下面。
   *
   * 写盘沿用 meta.json 的整文件原子写：中断只会留下旧版本，不会留下半个 JSON。
   *
   * @param {string} bookHash
   * @param {{ title?: unknown, author?: unknown }} patch
   * @returns {Promise<{ book: { id: string, title: string, author: string, updatedAt: string } }>}
   */
  async updateMeta(bookHash, patch) {
    const meta = await this.readMeta(bookHash)
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const source = patch !== null && typeof patch === 'object' ? patch : {}
    const hasTitle = Object.hasOwn(source, 'title')
    const hasAuthor = Object.hasOwn(source, 'author')
    const hasDescription = Object.hasOwn(source, 'description')
    const hasCategory = Object.hasOwn(source, 'category')
    const hasSeries = Object.hasOwn(source, 'series')
    const hasTags = Object.hasOwn(source, 'tags')
    const hasFavorite = Object.hasOwn(source, 'favorite')
    if (
      !hasTitle && !hasAuthor && !hasDescription && !hasCategory && !hasSeries && !hasTags && !hasFavorite
    ) {
      throw fail('E_ARGS', '没有要改的内容。', { status: 400 })
    }

    const next = { ...meta }
    if (hasTitle) {
      const title = typeof source.title === 'string' ? source.title.trim() : ''
      if (title === '') {
        throw fail('E_ARGS', '书名不能为空。', { status: 400 })
      }
      if (title.length > MAX_TITLE_LENGTH) {
        throw fail('E_ARGS', `书名太长了，最多 ${MAX_TITLE_LENGTH} 个字。`, { status: 400 })
      }
      next.title = title
    }
    if (hasAuthor) {
      const author = typeof source.author === 'string' ? source.author.trim() : ''
      if (author.length > MAX_AUTHOR_LENGTH) {
        throw fail('E_ARGS', `作者名太长了，最多 ${MAX_AUTHOR_LENGTH} 个字。`, { status: 400 })
      }
      // 清空作者 = 这本书没有作者信息，不是「作者叫空字符串」。
      if (author === '') delete next.author
      else next.author = author
    }

    // 简介：长文本，允许换行。清空 = 没有简介。
    if (hasDescription) {
      const description = typeof source.description === 'string' ? source.description.trim() : ''
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw fail('E_ARGS', `简介太长了，最多 ${MAX_DESCRIPTION_LENGTH} 个字。`, { status: 400 })
      }
      if (description === '') delete next.description
      else next.description = description
    }
    // 分类：一本书一个（用户的阅读器不需要多级分类，多级交给标签）。
    if (hasCategory) {
      const category = typeof source.category === 'string' ? source.category.trim() : ''
      if (category.length > MAX_CATEGORY_LENGTH) {
        throw fail('E_ARGS', `分类名太长了，最多 ${MAX_CATEGORY_LENGTH} 个字。`, { status: 400 })
      }
      if (category === '') delete next.category
      else next.category = category
    }
    // 系列：同一套书的合集名（如「三体」），用于把散书归到一起。
    if (hasSeries) {
      const series = typeof source.series === 'string' ? source.series.trim() : ''
      if (series.length > MAX_SERIES_LENGTH) {
        throw fail('E_ARGS', `系列名太长了，最多 ${MAX_SERIES_LENGTH} 个字。`, { status: 400 })
      }
      if (series === '') delete next.series
      else next.series = series
    }
    // 标签：数组，去重保序；空数组 = 清空标签。
    if (hasTags) {
      const tags = normalizeTags(source.tags)
      if (tags === null) {
        throw fail('E_ARGS', `标签最多 ${MAX_TAG_COUNT} 个，每个不超过 ${MAX_TAG_LENGTH} 个字。`, { status: 400 })
      }
      if (tags.length === 0) delete next.tags
      else next.tags = tags
    }
    // 珍藏（星标）：书架筛选「我的珍藏」看的就是它。
    if (hasFavorite) {
      const favorite = source.favorite === true
      if (favorite) next.favorite = true
      else delete next.favorite
    }

    next.updatedAt = this.now()
    await writeFileAtomic(path.join(dir, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`)
    // 解析缓存里也存着 meta（toc/spine 读的是缓存的 parsed），改完必须失效，
    // 否则面板里书名变了、正文里的落款还是旧的。
    this.epubCache.delete(dirName)
    return {
      book: {
        id: dirName,
        title: next.title,
        author: typeof next.author === 'string' ? next.author : '',
        description: typeof next.description === 'string' ? next.description : '',
        category: typeof next.category === 'string' ? next.category : '',
        series: typeof next.series === 'string' ? next.series : '',
        tags: Array.isArray(next.tags) ? next.tags : [],
        favorite: next.favorite === true,
        updatedAt: next.updatedAt,
      },
    }
  }

  /**
   * 换封面（0.4.0）。按**文件头魔数**认图，不认扩展名，也不认客户端声称的
   * content-type —— 后者全是客户端自己写的，改一改就能把任意字节塞进书库。
   *
   * 只保留 `cover.<ext>` 一个文件：换过三次封面的目录如果堆着三张图，
   * 下次读哪张全看 readdir 顺序，那就成了灵异事件。
   *
   * @param {string} bookHash
   * @param {Buffer|Uint8Array} bytes
   * @returns {Promise<{ book: { id: string, coverHref: string, coverMediaType: string, coverVersion: number, updatedAt: string } }>}
   */
  async putCover(bookHash, bytes) {
    const meta = await this.readMeta(bookHash)
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
    if (buffer.length === 0) {
      throw fail('E_ARGS', '没有收到封面图片，请重新选择一次。', { status: 400 })
    }
    if (buffer.length > MAX_COVER_BYTES) {
      throw fail('E_COVER_TOO_BIG', '封面图片太大了，最多 3 MB。', { status: 400 })
    }
    const image = sniffCoverImage(buffer)
    if (!image) {
      throw fail('E_ARGS', '封面只支持 PNG、JPEG、GIF、WebP 图片。', { status: 400 })
    }

    // 先写新图、再删旧图：写到一半失败时旧封面还在，书架不会突然变空。
    const href = `cover.${image.ext}`
    await writeFileAtomic(path.join(dir, href), buffer)
    await removeCoverFiles(dir, href)

    const version = (Number.isInteger(meta.coverVersion) ? meta.coverVersion : 0) + 1
    const next = {
      ...meta,
      coverHref: href,
      coverMediaType: image.mediaType,
      coverVersion: version,
      updatedAt: this.now(),
    }
    await writeFileAtomic(path.join(dir, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`)
    this.epubCache.delete(dirName)
    return {
      book: {
        id: dirName,
        coverHref: href,
        coverMediaType: image.mediaType,
        coverVersion: version,
        updatedAt: next.updatedAt,
      },
    }
  }

  /**
   * 恢复默认封面（0.4.0）：删掉书目录里的封面文件，把 `meta.coverHref` 置成空串。
   *
   * 为什么是空串而不是删字段、也不是 null：
   *   - 删字段 = 回到「老库」形态，coverBytes 会回退到书内归档的封面，等于没删；
   *   - null 过不了 schema（coverHref 只允许 string）。
   * 空串 = 「关于封面这件事，用户已经决定了：就是没有」，读封面时直接 404。
   */
  async resetCover(bookHash) {
    const meta = await this.readMeta(bookHash)
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    await removeCoverFiles(dir, '')
    const version = (Number.isInteger(meta.coverVersion) ? meta.coverVersion : 0) + 1
    const next = { ...meta, coverHref: '', coverVersion: version, updatedAt: this.now() }
    delete next.coverMediaType
    await writeFileAtomic(path.join(dir, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`)
    this.epubCache.delete(dirName)
    return {
      book: { id: dirName, coverHref: '', coverVersion: version, updatedAt: next.updatedAt },
    }
  }

  /**
   * 书架列表：每个书目录读 meta + progress，坏掉的书跳过并 warn（一本书坏掉
   * 不该让整个书架白屏）。
   *
   * @returns {Promise<{ books: Array<{ bookHash: string, title: string, author: string, percent: number, updatedAt: string, coverUrl: string|null }> }>}
   */
  async listShelf() {
    await this.init()
    const dirs = await this.paths.listBookDirs()
    const books = []
    for (const dirName of dirs) {
      const dir = this.paths.bookDir(dirName)
      const meta = await this.readJson(path.join(dir, 'meta.json'))
      if (!meta || typeof meta.title !== 'string') {
        this.warnOnce(`书架里有一本书缺少信息，已跳过：${dirName}`)
        continue
      }
      // 老书（0.2.0 之前导入的）书名可能是文件名 hash，展示时兜一层，
      // 不要把上一次导入的脏数据一直摆在书架上。
      const title = sensibleTitle(meta.title, '')
      // 老的重排书没有封面（那时候还不会从 MOBI 里抽图）。这里补一次，
      // 补到就写回 meta.json，之后走缓存 —— 用户不用为了封面重新导入。
      await this.ensureReflowedCover(dirName, dir, meta)

      const progress = await this.readJson(path.join(dir, 'progress.json'))
      const percent = clampPercent(progress?.percent ?? progress?.bookProgression ?? 0)
      const updatedAt = laterIso(meta.updatedAt, progress?.updatedAt, meta.createdAt)
      books.push({
        bookHash: typeof meta.bookHash === 'string' ? meta.bookHash : dirName,
        title,
        author: sensibleAuthor(meta.author),
        percent,
        updatedAt,
        coverUrl: meta.coverHref ? `/api/dsh-reading/cover?book=${dirName}` : null,
        // 封面版本（0.4.0）：客户端给封面 URL 加 `&v=` 用。换封面 / 删封面后
        // 版本 +1，浏览器就会立刻去取新图，而不是继续用缓存里的旧封面。
        // 没有封面的书是 0；老库没有这个字段也按 0。
        coverVersion: Number.isInteger(meta.coverVersion) ? meta.coverVersion : 0,
        // 源格式：界面用它给重排书（MOBI/TXT）挂一个小标记，也让「这本书是哪来的」
        // 在书架上一眼可见。老书没有这个字段时按 epub 处理。
        sourceFormat: typeof meta.sourceFormat === 'string' ? meta.sourceFormat : 'epub',
        // 书架筛选用的元数据（0.5.1）：简介 / 分类 / 系列 / 标签 / 珍藏。
        // 老库没有这些字段，一律给空值，界面按「未分类」处理。
        description: typeof meta.description === 'string' ? meta.description : '',
        category: typeof meta.category === 'string' ? meta.category : '',
        series: typeof meta.series === 'string' ? meta.series : '',
        tags: Array.isArray(meta.tags) ? meta.tags.filter((tag) => typeof tag === 'string') : [],
        favorite: meta.favorite === true,
      })
    }
    // 最近读过的排前面；没有 updatedAt 的沉底。
    books.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return { books }
  }

  /**
   * 给老的重排书补封面（MOBI / AZW3 里有内嵌封面图，0.2.0 之前没抽）。
   *
   * 只在「这本书确实没有封面 + 源文件还在 + 是 MOBI 系」时才动手，补到就写回
   * meta.json 与 `cover.jpg`，下次直接命中缓存。任何一步失败都只是没有封面，
   * **绝不抛错** —— 书架不能因为一张图打不开就整页崩掉。
   *
   * @param {string} dirName 书目录名
   * @param {string} dir 书目录绝对路径
   * @param {object} meta 这本书的 meta（会被就地修正为补到封面后的版本）
   */
  async ensureReflowedCover(dirName, dir, meta) {
    if (!meta || typeof meta !== 'object') return
    // 是字符串就说明「封面这件事已经定下了」：非空是已有封面，空串是用户显式
    // 删过（book.cover.remove）——两种情况都不该被自动补回来，否则用户点了
    // 「恢复默认封面」，下次刷新书架又冒出一张图。
    if (typeof meta.coverHref === 'string') return
    if (meta.sourceFormat !== 'mobi' && meta.sourceFormat !== 'azw3') return
    if (this.coverAttempted.has(dirName)) return
    this.coverAttempted.add(dirName)

    try {
      const bookFile = await this.locateBookFile(dir)
      const bytes = await fs.readFile(bookFile)
      const { extractCover } = await import('./mobi.js')
      const cover = extractCover(bytes)
      if (!cover || !cover.data || cover.data.length === 0) return

      const mediaType = String(cover.mediaType || '')
      const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/gif' ? 'gif' : 'jpg'
      const href = `cover.${ext}`
      await writeFileAtomic(path.join(dir, href), Buffer.from(cover.data))
      const next = { ...meta, coverHref: href }
      await writeFileAtomic(path.join(dir, 'meta.json'), `${JSON.stringify(next, null, 2)}\n`)
      Object.assign(meta, next)
    } catch (error) {
      // 补封面失败不影响阅读：记一次 warn 就够，别让书架为了图崩掉
      this.warnOnce(`补封面失败（${dirName}）：${String(error && error.message)}`)
    }
  }

  /** 读 meta.json；书不存在或文件坏了都抛业务错误。 */
  async readMeta(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const meta = await this.readJson(path.join(this.paths.bookDir(dirName), 'meta.json'))
    if (!meta) {
      // 404：书真的不在书库里。这不是「请求写错了」，所以不能给 400——
      // 客户端按 404 走「书被删了，回书架」的分支，400 会被当成自己的 bug。
      throw fail('E_BOOK_NOT_FOUND', '这本书不在了，重新导入试试。', {
        status: 404,
        detail: `missing meta: ${dirName}`,
      })
    }
    return meta
  }

  /** spine，形状按 docs/05 §3.3 的 `{ href, idref, index }`。 */
  async spine(bookHash) {
    const meta = await this.readMeta(bookHash)
    const list = Array.isArray(meta.spine) ? meta.spine : []
    return {
      spine: list.map((entry, index) => ({
        href: String(entry?.href ?? ''),
        idref: String(entry?.idref ?? ''),
        index: Number.isInteger(entry?.index) ? entry.index : index,
      })),
    }
  }

  /**
   * 目录 + 来源（0.4.0）。meta.json 按 docs/05 §4.1 不含 toc，所以按需解析并缓存在内存。
   *
   * `source` 是「这个目录是怎么来的」，界面靠它决定要不要挂「自动识别」角标、
   * 以及是不是干脆显示空态（施工图 §6）：
   *   nav / ncx  —— 书里自带真目录
   *   headings   —— TXT 按识别到的真标题切章
   *   auto       —— 转换来的格式（MOBI/AZW3）程序识别出的章名
   *   spine      —— 没有真目录，只能拿 spine 的 idref 冒充
   *   split      —— TXT 按字数硬切出来的「第 N 部分」，不是目录，不给前端
   *   none       —— 没有目录
   *
   * 老库没有 tocSource 字段：那时候的目录「有就列、没有就造」，不可信，
   * 一律按 none 处理（施工图 §6.4：零迁移，不给老书批量重写 meta）。
   */
  async toc(bookHash) {
    const meta = await this.readMeta(bookHash)
    const source = typeof meta.tocSource === 'string' ? meta.tocSource : 'none'
    if (source === 'none' || source === 'split' || source === 'spine') {
      // 三种都不算真目录：硬切的「第 N 部分」、以及拿 spine 的 idref 冒充的章名。
      // 列出来只会让用户以为目录坏了，不如如实说这本书没有目录（字段值仍然记着来源）。
      return { toc: [], source }
    }
    const parsed = await this.getParsed(bookHash)
    return { toc: parsed.toc, source }
  }

  /** 章节原文（未改写）。找不到返回 null，由路由回 404。 */
  /**
   * 书内搜索（0.6.0）。
   *
   * 为什么放在宿主侧而不是客户端：正文在磁盘上，客户端只拿到「当前这一章」的 HTML，
   * 想搜全书就得把整本书灌进浏览器（重排书动辄几百章、几 MB）。这里逐章取文本、
   * 逐章丢，内存只要一章。
   *
   * 命中位置用 `percent`（命中处占这一章纯文本的比例）而不是字符偏移：客户端是
   * 分页模型，拿比例可以直接换算成「这一章的第几页」，不用把 CFI 反向算回来。
   *
   * @param {string} bookHash
   * @param {string} rawQuery
   * @param {{ limit?: number }} [options]
   */
  async searchBook(bookHash, rawQuery, options = {}) {
    const meta = await this.readMeta(bookHash)
    const query = String(rawQuery ?? '').trim()
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 80))
    if (query === '') return { query: '', hits: [], total: 0, truncated: false, scannedChapters: 0 }
    if (query.length > 60) {
      throw fail('E_SEARCH_TOO_LONG', '搜索词太长了，请只输入关键词（不超过 60 个字）。')
    }

    const spine = Array.isArray(meta.spine) ? meta.spine : []
    const labels = chapterLabels(meta)
    const needle = query.toLowerCase()
    const hits = []
    let total = 0
    let scannedChapters = 0
    let truncated = false

    for (let index = 0; index < spine.length; index += 1) {
      const entry = spine[index]
      if (!entry || typeof entry.href !== 'string' || entry.href === '') continue
      const html = await this.chapterHtml(bookHash, entry.href)
      const text = plainTextOfHtml(html)
      scannedChapters += 1
      if (text === '') continue
      const haystack = text.toLowerCase()
      let from = 0
      while (from <= haystack.length) {
        const at = haystack.indexOf(needle, from)
        if (at < 0) break
        total += 1
        if (hits.length < limit) {
          hits.push({
            spineIndex: index,
            chapterLabel: labels.get(index) ?? `第 ${index + 1} 章`,
            percent: text.length > 0 ? at / text.length : 0,
            snippet: snippetAround(text, at, query.length),
            hitOffset: at,
            query,
          })
        } else {
          truncated = true
        }
        from = at + Math.max(1, needle.length)
        // 单字查询在百万字书上会命中几万次，扫到上限就停：用户要的是「有这本书」，
        // 不是把每一次「的」都列出来。
        if (total >= 2000) {
          truncated = true
          break
        }
      }
      if (total >= 2000) break
    }

    return { query, hits, total, truncated, scannedChapters }
  }

  async chapterHtml(bookHash, href) {
    const parsed = await this.getParsed(bookHash)
    return parsed.chapterHtml(href)
  }

  /** 章节引用的资源。 */
  async assetBytes(bookHash, href, baseHref) {
    const parsed = await this.getParsed(bookHash)
    return parsed.assetBytes(href, baseHref)
  }

  /**
   * 封面图字节；没有封面返回 null。返回值带 `version`，路由拿去做 ETag。
   *
   * 读盘优先：用户换过的封面就落在书目录里（`cover.jpg`），比书内归档的封面新。
   * `meta.coverHref` 是空串表示用户显式删过封面——这时候**不能**回退到书内封面，
   * 否则「恢复默认封面」看起来像没生效。
   */
  async coverBytes(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const meta = await this.readMeta(dirName)
    const version = Number.isInteger(meta.coverVersion) ? meta.coverVersion : 0
    const href = typeof meta.coverHref === 'string' ? meta.coverHref : null

    if (href === '') return null
    if (href !== null) {
      try {
        const bytes = await fs.readFile(path.join(dir, href))
        return { bytes, mediaType: coverMediaTypeOf(meta, href), version }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
      // meta 里记的是书内路径（0.2.0 之前导入的 EPUB）：去归档里取。
      const parsed = await this.getParsed(dirName)
      const asset = await parsed.assetBytes(href)
      return asset ? { bytes: asset.bytes, mediaType: asset.mediaType, version } : null
    }

    // 老库根本没有 coverHref 字段：走原来的「书内封面」逻辑。
    const parsed = await this.getParsed(dirName)
    if (!parsed.coverHref) return null
    const asset = await parsed.assetBytes(parsed.coverHref)
    return asset ? { bytes: asset.bytes, mediaType: asset.mediaType, version } : null
  }

  /**
   * 找到书目录里的书籍文件。
   *
   * 为什么不能写死 `book.epub`：支持 TXT 与 MOBI 之后，落盘名跟着格式走
   * （`book.txt` / `book.mobi` / `book.azw3`）。目录本身是按 bookHash 命名的，
   * 里面只会有一个 `book.<ext>`，所以按前缀扫一遍是安全的——顺带让「用户手工
   * 把 epub 换成同名 txt」这种粗暴操作也能被读出来。
   *
   * @param {string} dir 书的目录
   * @returns {Promise<string>} 文件的绝对路径
   * @throws {import('./errors.js').AppError} `E_BOOK_NO_FILE`
   */
  async locateBookFile(dir) {
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch (error) {
      throw fail('E_BOOK_NO_FILE', '这本书的文件不在了，重新导入试试。', {
        status: 404,
        detail: `readdir failed: ${String(error && error.message)}`,
      })
    }
    const found = names.find((name) => name.startsWith('book.'))
    if (!found) {
      throw fail('E_BOOK_NO_FILE', '这本书的文件不在了，重新导入试试。', {
        status: 404,
        detail: `no book.* in ${dir}`,
      })
    }
    return path.join(dir, found)
  }

  /**
   * 拿到（并缓存）解析结果。
   * 缓存键用目录名（16 位），并额外比对文件 mtime+size：用户从外部替换了
   * 书籍文件时能自动失效，不用重启插件。
   */
  async getParsed(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const bookFile = await this.locateBookFile(dir)
    let stat
    try {
      stat = await fs.stat(bookFile)
    } catch {
      throw fail('E_BOOK_NO_FILE', '这本书的文件不在了，重新导入试试。', {
        status: 404,
        detail: `missing: ${bookFile}`,
      })
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const cached = this.epubCache.get(dirName)
    if (cached && cached.stamp === stamp) return cached.parsed

    let parsed
    try {
      parsed = await parseBook(bookFile, {
        deviceId: await this.getDeviceId(),
        now: this.now(),
        filename: path.basename(bookFile),
      })
    } catch (error) {
      throw this.translate(error)
    }
    this.epubCache.set(dirName, { stamp, parsed })
    return parsed
  }

  // ── 蒸馏（0.8.0）───────────────────────────────────────────────

  /**
   * 读书蒸馏结果。
   *
   * 存成单文件 `distill.json`：一本书的蒸馏稿是一个整体（骨架 + 逐章），
   * 拆成 jsonl 反而要在读取时拼装，收益为零。没有蒸过就返回 null。
   */
  async readDistill(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const state = await this.readJson(path.join(this.paths.bookDir(dirName), 'distill.json'))
    return state ?? null
  }

  /** 整份覆盖写蒸馏结果。和别的落盘一样走原子写，避免半份 JSON 落盘。 */
  async putDistill(bookHash, state) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const target = path.join(dir, 'distill.json')
    const payload = state && typeof state === 'object' ? state : {}
    await fs.mkdir(dir, { recursive: true })
    const before = await this.readJson(target)
    if (before) await this.rotateHistory(dir, 'distill.json')
    await writeFileAtomic(target, JSON.stringify(payload, null, 2) + '\n')
    return payload
  }

  /** 清空这本书的蒸馏稿。文件不存在也算成功——用户要的是「没了」。 */
  async clearDistill(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const target = path.join(dir, 'distill.json')
    try {
      const before = await this.readJson(target)
      if (before) await this.rotateHistory(dir, 'distill.json')
      await fs.rm(target, { force: true })
    } catch (error) {
      if (!isAppError(error)) {
        throw fail('E_DISTILL_CLEAR', '清空蒸馏稿失败，可以再试一次。', {
          detail: String(error?.message ?? error),
        })
      }
      throw error
    }
    return { cleared: true }
  }

  /**
   * 一章的纯文本 + 章名，给蒸馏用。
   *
   * 不复用 searchBook：那里按关键词扫全书，这里只要一章，而且要把章名与序号带出来。
   */
  async chapterText(bookHash, href) {
    const meta = await this.readMeta(bookHash)
    const spine = Array.isArray(meta.spine) ? meta.spine : []
    const index = spine.findIndex((entry) => entry?.href === href)
    if (index < 0) {
      throw fail('E_CHAPTER_NOT_FOUND', '这一章不在这本书里，可能目录变了。', { status: 404 })
    }
    const html = await this.chapterHtml(bookHash, href)
    const labels = chapterLabels(meta)
    return {
      href,
      spineIndex: index,
      label: labels.get(index) ?? `第 ${index + 1} 章`,
      text: plainTextOfHtml(html),
      total: spine.length,
    }
  }

  // ── 进度 ────────────────────────────────────────────────────────

  /** 读进度；没有返回 null（不是错误——新书本来就没进度）。 */
  async readProgress(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const progress = await this.readJson(path.join(this.paths.bookDir(dirName), 'progress.json'))
    return progress ?? null
  }

  /**
   * 写进度（整文件覆盖，覆盖前存历史）。
   *
   * 字段兼容两套命名：docs/05 §3.3 的接口用 `percent`，docs/01 §2.4 的契约文件用
   * `bookProgression`。两个都写、值相同，读取时任一存在即可——这样客户端只认
   * 一种名字也能工作，WebDAV 上按契约校验也不会缺字段。
   *
   * @param {{ bookHash: string, cfi: string, cfiStart?: string, chapterHref?: string, percent?: number }} input
   */
  async putProgress(input) {
    await this.init()
    const bookHash = input?.bookHash
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const cfi = typeof input?.cfi === 'string' ? input.cfi.trim() : ''
    if (cfi === '') {
      throw fail('E_BAD_PROGRESS', '这次阅读位置没能保存，请再翻一页试试。', { detail: 'empty cfi' })
    }
    if (!cfi.startsWith('epubcfi(')) {
      throw fail('E_BAD_PROGRESS', '这次阅读位置没能保存，请再翻一页试试。', { detail: `not a cfi: ${cfi.slice(0, 60)}` })
    }
    await this.readMeta(dirName)

    const percent = clampPercent(input?.percent ?? 0)
    const stamp = this.now()
    const progress = {
      schema: 'dsh-reading/1',
      cfi,
      chapterHref: typeof input?.chapterHref === 'string' ? input.chapterHref : '',
      percent,
      bookProgression: percent,
      updatedAt: stamp,
      deviceId: await this.getDeviceId(),
    }
    if (typeof input?.cfiStart === 'string' && input.cfiStart !== '') progress.cfiStart = input.cfiStart

    const file = path.join(dir, 'progress.json')
    await this.rotateHistory(dir, 'progress.json')
    await writeFileAtomic(file, `${JSON.stringify(progress, null, 2)}\n`)
    return progress
  }

  // ── 标注 / 问答 / 隔离舱 ─────────────────────────────────────────

  /** 有效标注（已按 id 去重、已过滤墓碑）。 */
  async listAnnotations(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const records = await this.readJsonlMerged(path.join(dir, 'annotations.jsonl'), dirName)
    return { records: records.filter((record) => record.deleted !== true) }
  }

  /**
   * 问答列表：按 id 逐条合并（与标注同一套规则），墓碑同样会被过滤。
   *
   * @param {string} bookHash
   * @returns {Promise<{ records: Array<object> }>}
   */
  async listQa(bookHash, options = {}) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const records = await this.readJsonlMerged(path.join(dir, 'qa.jsonl'), dirName)
    // 列表按落盘顺序（旧在前）返回，与标注列表同一口径：界面自己决定倒序展示。
    // limit 只截尾巴，不给「翻页」——单本书的问答记录量级很小，翻页反而是负担；
    // 默认上限 MAX_QA_LIST 只是防止一个坏掉的文件把整张响应撑爆。
    const requested = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : MAX_QA_LIST
    const limit = Math.min(requested, MAX_QA_LIST)
    return {
      records: records
        .filter((record) => record.deleted !== true)
        // 旧库的记录只有 question/answer/anchorCfiRange 三个字段（0.3.x 时代落盘的），
        // 缺字段不能让整张列表炸掉：统一补成空串，界面按空串走「没有章节 / 没有模型」
        // 的降级分支。这是 qa.list 的对外形状，不是内部实现细节。
        .map((record) => normalizeQaRecord(record, dirName))
        .slice(0, limit),
    }
  }

  /**
   * 删一条问答记录（0.4.0）。与标注同一套墓碑写盘：不删行，只追加 `deleted:true`。
   *
   * 先查存在性再写：给不存在的 id 写墓碑会让「删」在界面上永远成功，
   * 用户就发现不了自己点错了书。qa 的 id 不是 ULID（`qa-<base36>-<6 位>`），
   * 所以这里只校验「非空字符串」，不套 ULID 的字集规则。
   *
   * @param {string} bookHash
   * @param {string} id
   * @returns {Promise<{ deleted: true, id: string }>}
   */
  async deleteQa(bookHash, id) {
    const meta = await this.readMeta(bookHash)
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const recordId = typeof id === 'string' ? id.trim() : ''
    if (recordId === '') {
      throw fail('E_BAD_RECORD', '这条问答记录的编号不对，删不掉。', { status: 400 })
    }
    const existing = await this.listQa(dirName)
    if (!existing.records.some((record) => record.id === recordId)) {
      throw fail('E_QA_NOT_FOUND', '这条问答记录不在了，可能已经删过了。', { status: 404 })
    }
    const tombstone = {
      schema: 'dsh-reading/1',
      id: recordId,
      // 带上 bookHash：合并后的记录里这个字段仍然指着同一本书，便于排查。
      bookHash: typeof meta.bookHash === 'string' ? meta.bookHash : dirName,
      deleted: true,
      updatedAt: this.now(),
      deviceId: await this.getDeviceId(),
    }
    await appendJsonl(path.join(dir, 'qa.jsonl'), tombstone)
    return { deleted: true, id: recordId }
  }

  /**
   * 追加一条问答记录。
   *
   * 为什么强制要求 `anchorCfiRange`：一个找不回原文的答案等于没答（docs/01 铁律 5）。
   * 这里不做「先问问再补锚点」的宽容处理 —— 宽容的结果是书库里堆满无主答案。
   *
   * @param {string} bookHash
   * @param {{ question: string, answer: string, anchorCfiRange?: string, selectedText?: string, chapterHref?: string, model?: string }} record
   * @returns {Promise<object>} 落盘后的完整记录
   */
  async appendQa(bookHash, record) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)

    const question = typeof record?.question === 'string' ? record.question.trim() : ''
    const answer = typeof record?.answer === 'string' ? record.answer.trim() : ''
    const anchor = typeof record?.anchorCfiRange === 'string' ? record.anchorCfiRange.trim() : ''
    if (question === '' || answer === '') {
      throw fail('E_BAD_QA', '这条问答内容不完整，没有保存。', { status: 400 })
    }
    if (anchor === '') {
      throw fail('E_NO_ANCHOR', '这个回答没有挂到原文上，不保存。', { status: 400 })
    }

    const now = this.now()
    const entry = {
      schema: 'dsh-reading/1',
      id: `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      book: dirName,
      bookHash,
      question,
      answer,
      anchorCfiRange: anchor,
      selectedText: typeof record?.selectedText === 'string' ? record.selectedText.slice(0, 4000) : '',
      chapterHref: typeof record?.chapterHref === 'string' ? record.chapterHref : '',
      // 0.4.0：历史侧栏要显示「哪一章、问到第几句」。问的时候就把标签落下，
      // 免得将来补不上，老记录只能一律写「未知章节」。
      chapterLabel: typeof record?.chapterLabel === 'string' ? record.chapterLabel.slice(0, 200) : '',
      cutoffCfi: typeof record?.cutoffCfi === 'string' ? record.cutoffCfi : '',
      model: typeof record?.model === 'string' ? record.model : '',
      createdAt: now,
      updatedAt: now,
      deviceId: await this.getDeviceId(),
    }
    await appendJsonl(path.join(dir, 'qa.jsonl'), entry)
    return entry
  }

  /**
   * 写一条标注。
   *
   * 服务端补 `updatedAt`（客户端时钟不可信，docs/01 §10.8），并把记录追加到
   * annotations.jsonl。**硬校验必填字段**：缺 cfi / chapterHref / textExcerpt /
   * textFingerprint 直接拒绝（docs/05 §10 第 11 条），不做降级写入。
   */
  async putAnnotation(bookHash, record) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    await this.readMeta(dirName)

    const validated = validateRecord(record)
    const stored = {
      ...validated,
      schema: 'dsh-reading/1',
      updatedAt: this.now(),
      deviceId: await this.getDeviceId(),
    }
    if (typeof stored.createdAt !== 'string' || stored.createdAt === '') stored.createdAt = stored.updatedAt
    await appendJsonl(path.join(dir, 'annotations.jsonl'), stored)
    return { record: stored }
  }

  /** 写墓碑（不删行）。缺 id 或 id 形态不对直接拒绝。 */
  async deleteAnnotation(bookHash, id) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    await this.readMeta(dirName)
    const recordId = String(id ?? '').trim()
    if (!ULID_PATTERN.test(recordId)) {
      throw fail('E_BAD_RECORD', '这条标注的编号不对，删不掉。', { detail: `bad id: ${recordId.slice(0, 40)}` })
    }
    const tombstone = {
      schema: 'dsh-reading/1',
      id: recordId,
      deleted: true,
      updatedAt: this.now(),
      deviceId: await this.getDeviceId(),
    }
    await appendJsonl(path.join(dir, 'annotations.jsonl'), tombstone)
    return { deleted: true }
  }

  /** 隔离舱条目（只写不读的写面在这里，读是给「待修复」面板看的）。 */
  async listQuarantine(bookHash) {
    await this.init()
    const dirName = bookDirName(bookHash)
    const dir = this.paths.bookDir(dirName)
    const entries = await this.readJsonlMerged(path.join(dir, 'quarantine.jsonl'), dirName)
    return { entries }
  }

  /**
   * 记录进隔离舱。本轮没有 UI，但写面先落地：将来同步合并遇到坏行时直接调它。
   * @param {string} bookHash
   * @param {object} entry
   */
  async appendQuarantine(bookHash, entry) {
    await this.init()
    const dir = await this.paths.ensureBook(bookDirName(bookHash))
    const record = {
      schema: 'dsh-reading/1',
      id: typeof entry?.id === 'string' ? entry.id : '',
      sourceDeviceId: typeof entry?.sourceDeviceId === 'string' ? entry.sourceDeviceId : await this.getDeviceId(),
      ingestedAt: this.now(),
      ...entry,
      schema: 'dsh-reading/1',
      ingestedAt: this.now(),
    }
    await appendJsonl(path.join(dir, 'quarantine.jsonl'), record)
    return { entry: record }
  }

  // ── 设置 ────────────────────────────────────────────────────────

  /** 读阅读偏好；文件不存在返回默认值（不算错误）。 */
  async getSettings() {
    await this.init()
    const stored = await this.readJson(this.paths.settingsFile)
    return mergeSettings(DEFAULT_SETTINGS, stored)
  }

  /**
   * 合并写阅读偏好（只接受 §3.3 列出的键）。
   * 覆盖前存历史，方便用户改坏字号后回滚。
   */
  async putSettings(patch) {
    await this.init()
    const current = await this.getSettings()
    const next = mergeSettings(current, patch, { strict: true })
    await this.rotateHistory(this.paths.root, 'settings.json')
    await writeFileAtomic(this.paths.settingsFile, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  // ── 内部工具 ────────────────────────────────────────────────────

  /** 读 JSON；不存在/解析失败返回 null。**坏文件不抛错**，由调用方决定回退策略。 */
  async readJson(file) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      // 文件不存在是正常情况（新书没有 progress / 没改过 settings），返回 null。
      return null
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      this.logger.warn('[dsh-reading] 有一个数据文件损坏，已忽略：', path.basename(file), String(error && error.message))
      return null
    }
  }

  /**
   * 读 jsonl 并按 id 合并。
   *
   * 合并规则与 docs/01 §2.10 一致（将来两端共用同一份）：
   *   1. 逐行 parse，坏行进 quarantine（写回同一目录的 quarantine.jsonl），继续；
   *   2. 按 id 分组，每组取 (updatedAt, deviceId) 最大的一条；
   *   3. 输出先按 createdAt 升序、再按 id 升序，保证写回字节稳定。
   *
   * @param {string} file
   * @param {string} dirName - 只用于日志
   * @returns {Promise<object[]>}
   */
  async readJsonlMerged(file, dirName) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      // 还没写过任何记录：空集合，不是错误。
      return []
    }
    const groups = new Map()
    let lineNumber = 0
    for (const line of raw.split('\n')) {
      lineNumber += 1
      const text = line.trim()
      if (text === '') continue
      let record
      try {
        record = JSON.parse(text)
      } catch (error) {
        this.quarantineBadLine(dirName, file, lineNumber, text, error)
        continue
      }
      if (!record || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') {
        this.quarantineBadLine(dirName, file, lineNumber, text, null)
        continue
      }
      const current = groups.get(record.id)
      // 同一条 (updatedAt, deviceId) 时**后写的赢**：jsonl 是追加日志，文件顺序就是
      // 写入顺序，所以「同一版本」的判定权威是行号而不是内容。
      //
      // 这条不是形式主义：删除墓碑与它要覆盖的记录通常来自同一设备、同一毫秒
      // （用户点删除就是那一瞬间），`compareVersion` 给出 0。若坚持「严格大于才替换」，
      // 墓碑会被它要删的那条记录顶掉，表现是「删了刷新又回来」。
      if (!current || compareVersion(record, current) >= 0) groups.set(record.id, record)
    }
    return [...groups.values()].sort((a, b) => {
      const byCreated = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
      return byCreated !== 0 ? byCreated : String(a.id).localeCompare(String(b.id))
    })
  }

  /**
   * 坏行进隔离舱。刻意**不 await**：读路径不该因为写隔离舱失败而报错，
   * 但失败要留日志（没有空 catch）。
   *
   * **id 必须是内容派生的，不能用时间戳。** 原来用 `Date.now()` 生成 id，
   * 于是同一行坏数据每读一次就换一个 id、又追加一条，quarantine.jsonl
   * 随刷新次数线性膨胀——隔离舱本来是为了留住证据，结果变成了垃圾场。
   * 现在 id = bad-<内容 hash 前 16 位>，同一行永远同一个 id，并且写之前
   * 先把已有 id 读进内存比对，重复的直接跳过。
   */
  quarantineBadLine(dirName, file, lineNumber, text, error) {
    const dir = this.paths.bookDir(dirName)
    const key = `${path.basename(file)}:${lineNumber}:${text}`
    const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
    const id = `bad-${digest}`
    if (this.isQuarantined(dirName, id)) return
    const record = {
      schema: 'dsh-reading/1',
      id,
      reason: 'schema_invalid',
      rawRecord: text.slice(0, 8192),
      sourceDeviceId: this.deviceId ?? 'unknown',
      ingestedAt: this.now(),
    }
    this.markQuarantined(dirName, id)
    this.warnOnce(`有一行标注数据无法解析，已移入隔离区：${path.basename(file)} 第 ${lineNumber} 行 ${String(error?.message ?? '')}`)
    appendJsonl(path.join(dir, 'quarantine.jsonl'), record).catch((writeError) => {
      // 隔离舱也写不进去：只剩日志这一条路，但不能静默。
      // 记一个「没写成功」的内存标记，下次读还会再试一次，而不是永久放弃。
      this.quarantined?.get(dirName)?.delete(id)
      this.logger.warn('[dsh-reading] 隔离舱写入失败：', String(writeError?.message ?? writeError))
    })
  }

  /**
   * 这本书的隔离舱 id 集合（首次访问时从磁盘载入一次）。
   * 只是去重用的索引，读失败就当空集，不影响主流程。
   */
  quarantinedIds(dirName) {
    if (!this.quarantined) this.quarantined = new Map()
    let set = this.quarantined.get(dirName)
    if (set) return set
    set = new Set()
    this.quarantined.set(dirName, set)
    let raw = ''
    try {
      raw = fsSync.readFileSync(path.join(this.paths.bookDir(dirName), 'quarantine.jsonl'), 'utf8')
    } catch {
      return set // 文件还不存在：空集就是正确答案。
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed.id === 'string') set.add(parsed.id)
      } catch {
        // 隔离舱自己出现坏行：不必再隔离自己，跳过即可。
      }
    }
    return set
  }

  /** 该 id 是否已在隔离舱里。 */
  isQuarantined(dirName, id) {
    return this.quarantinedIds(dirName).has(id)
  }

  /** 先把 id 记进内存再写盘：并发读到同一行时不会同时写两遍。 */
  markQuarantined(dirName, id) {
    this.quarantinedIds(dirName).add(id)
  }

  /**
   * 覆盖写之前把旧文件复制进 history/，并裁到 20 份。
   *
   * 文件名里的 ISO 时间把 `:` 换成 `-`：Windows 不允许文件名含冒号，而这个插件
   * 是要在 Windows 上跑的。排序仍成立（定长、字典序即时间序）。
   *
   * @param {string} dir - 文件所在目录（history/ 建在这里）
   * @param {string} filename
   */
  async rotateHistory(dir, filename) {
    const source = path.join(dir, filename)
    let raw
    try {
      raw = await fs.readFile(source)
    } catch {
      return // 文件还不存在：首次写入，没有旧版本可存。
    }
    const historyDir = path.join(dir, 'history')
    try {
      await fs.mkdir(historyDir, { recursive: true })
      const stamp = this.now().replace(/:/g, '-')
      const device = this.deviceId ?? 'unknown'
      // 同一毫秒内两次覆盖写会撞同名（`now()` 只到毫秒），撞上就是后一份
      // 静默覆盖前一份历史。补一个随机尾巴，代价是名字长 6 字符。
      const salt = Math.random().toString(36).slice(2, 8)
      await fs.writeFile(path.join(historyDir, `${filename}.${stamp}.${device}.${salt}`), raw)
      await this.pruneHistory(historyDir, filename)
    } catch (error) {
      // 存历史失败不该阻断主写入：历史是取证材料，不是正确性依赖。
      this.logger.warn('[dsh-reading] 历史副本保存失败：', String(error?.message ?? error))
    }
  }

  /** 只保留最近 HISTORY_KEEP 份同名历史。 */
  async pruneHistory(historyDir, filename) {
    let names
    try {
      names = await fs.readdir(historyDir)
    } catch {
      // history/ 还没建（一次都没覆盖写过）：没有旧副本要清。
      return
    }
    // 两类名字都以 `${filename}.` 开头，但处理方式不同：
    //   - `.tmp-*` 是 writeFileAtomic 崩溃后留下的半成品，**直接删**（它们不是历史）；
    //   - 其余的是正经历史副本，只保留最近 HISTORY_KEEP 份。
    // 原实现把两者混在一起按名排序裁剪，`'t' > '2'` 让 tmp 永远排在最后，
    // 于是每轮都在切真实历史、把垃圾留着。
    const junk = names.filter((name) => name.includes('.tmp-'))
    const mine = names
      .filter((name) => name.startsWith(`${filename}.`) && !name.includes('.tmp-'))
      .sort()

    for (const name of junk) {
      try {
        await fs.rm(path.join(historyDir, name), { force: true })
      } catch (error) {
        this.logger.warn('[dsh-reading] 残留临时文件清理失败：', String(error?.message ?? error))
      }
    }

    const extra = mine.slice(0, Math.max(0, mine.length - HISTORY_KEEP))
    for (const name of extra) {
      try {
        await fs.rm(path.join(historyDir, name), { force: true })
      } catch (error) {
        this.logger.warn('[dsh-reading] 旧历史副本清理失败：', String(error?.message ?? error))
      }
    }
  }

  /** 同一个警告只打一次，避免每次请求刷屏（docs/05 §3.1）。 */
  warnOnce(message) {
    if (!this.warned) this.warned = new Set()
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.logger.warn(`[dsh-reading] ${message}`)
  }

  /** 把解析层错误翻译成书库语义（原样保留 code 与中文 message）。 */
  translate(error) {
    if (isAppError(error)) return error
    return fail('E_BOOK_UNREADABLE', '这本书读取失败了，请重新导入试试。', {
      detail: String(error?.message ?? error),
      cause: error,
    })
  }
}

// ── 模块级工具 ────────────────────────────────────────────────────

/**
 * 原子写：先写同目录临时文件、fsync、再 rename，避免中断留下半个 JSON。
 *
 * fsync 这一步不是形式主义：rename 只保证「目录项原子切换」，不保证数据已经
 * 落盘。进程被 kill（桌面应用里的常见死法）时，可能留下一个名字对、
 * 内容全零的文件——对 progress.json 就是「进度归零」，对 annotations.jsonl
 * 就是「标注全没了」。写完 fsync 一次，代价是一次磁盘同步，换来的是
 * 「要么旧内容、要么新内容」这个真正的原子性。
 */

/** 去掉标签、解开常见实体，得到用于搜索的纯文本。 */
function plainTextOfHtml(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
}

/** 命中词前后各取一段，压成一行；两端截断时补省略号。 */
function snippetAround(text, at, length) {
  const before = 36
  const after = 64
  const start = Math.max(0, at - before)
  const end = Math.min(text.length, at + length + after)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return head + text.slice(start, end).replace(/[\s\u00a0]+/g, ' ').trim() + tail
}

/**
 * spine 下标 → 章节名。目录里同一个 spine 可能有多条（分节锚点），
 * 取第一条就够了：用户只需要知道「在第几章」。
 */
function chapterLabels(meta) {
  const map = new Map()
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      const index = Number(item?.spineIndex)
      if (Number.isInteger(index) && index >= 0 && !map.has(index)) {
        const label = typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim() : ''
        if (label !== '') map.set(index, label)
      }
      if (item?.children) walk(item.children)
      if (item?.subitems) walk(item.subitems)
    }
  }
  walk(meta?.toc)
  return map
}

async function writeFileAtomic(file, data) {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(temp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await renameWithRetry(temp, file)
}

/**
 * 覆盖式 rename。
 *
 * POSIX 上 rename 覆盖同名文件是原子的；Windows 上 `MoveFileEx` 也带 REPLACE，
 * 但只要目标文件被杀毒软件、索引器或资源管理器短暂持有句柄，就会抛 EPERM/EBUSY/
 * EACCES —— 用户看到的是「保存进度失败」，重试一次就好。所以这里退避重试 3 次，
 * 仍失败再删目标重试一次（删失败才算真的失败）。
 */
async function renameWithRetry(from, to) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      await new Promise((resolve) => {
        setTimeout(resolve, 20 * (attempt + 1))
      })
    }
  }
  // 最后一招：先删目标再改名（Windows 上文件被短暂占用时这一步能过去）
  try {
    await fs.rm(to, { force: true })
    await fs.rename(from, to)
    return
  } catch {
    throw lastError
  }
}

/** 追加一行 JSON（每条记录独立一行，允许乱序与重复 id）。 */
async function appendJsonl(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(record)}\n`)
}

/**
 * 封面文件的 media-type：优先 meta 里记的，其次按扩展名推。
 *
 * 为什么优先 meta：用户上传的可能是一张 `.jpg` 但魔数是 PNG（改过扩展名），
 * 那时 meta.coverMediaType 是登录时按魔数判出来的，比扩展名可信。
 *
 * @param {object} meta
 * @param {string} href
 * @returns {string}
 */
function coverMediaTypeOf(meta, href) {
  const recorded = typeof meta?.coverMediaType === 'string' ? meta.coverMediaType : ''
  if (recorded.startsWith('image/')) return recorded
  const lower = String(href ?? '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

/**
 * 删掉书目录里除 `keepName` 之外的封面文件。
 *
 * 只认 `cover.<字母数字>` 这个形状：`book.epub` / `meta.json` 这些绝不能碰。
 * 目录不存在时静默返回 —— 删封面是「让它没有」，不是「必须删掉点什么」。
 *
 * @param {string} dir
 * @param {string} keepName 要保留的文件名（空串表示全删）
 */
async function removeCoverFiles(dir, keepName) {
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    if (!/^cover\.[A-Za-z0-9]+$/.test(name)) continue
    if (name === keepName) continue
    await fs.rm(path.join(dir, name), { force: true })
  }
}

/**
 * qa 记录对外形状的兜底（0.4.0）。
 *
 * 旧库（0.3.x 之前）落盘的记录没有 chapterLabel / cutoffCfi / model 这些字段，
 * 直接扔给界面就是一堆 `undefined`，渲染时容易变成「undefined undefined」。
 * 这里统一补空串，并让 `book` 与 `bookHash` 两种叫法都成立（历史落盘用的是
 * bookHash，客户端读的是 book）。
 *
 * @param {unknown} record 落盘记录
 * @param {string} [fallbackBook] 记录里没有书标识时的兜底（书目录名）
 * @returns {object}
 */
export function normalizeQaRecord(record, fallbackBook = '') {
  const source = record !== null && typeof record === 'object' ? record : {}
  const text = (value) => (typeof value === 'string' ? value : '')
  const book = text(source.book) || text(source.bookHash) || String(fallbackBook ?? '')
  return {
    ...source,
    id: text(source.id),
    book,
    bookHash: text(source.bookHash) || book,
    question: text(source.question),
    answer: text(source.answer),
    chapterHref: text(source.chapterHref),
    chapterLabel: text(source.chapterLabel),
    cutoffCfi: text(source.cutoffCfi),
    anchorCfiRange: text(source.anchorCfiRange),
    anchorXpath: text(source.anchorXpath),
    selectedText: text(source.selectedText),
    model: text(source.model),
    createdAt: text(source.createdAt),
    updatedAt: text(source.updatedAt) || text(source.createdAt),
  }
}

/**
 * 版本比较：先 updatedAt，再 deviceId 字典序（保证两端结果一致）。
 * @returns {number} >0 表示 a 更新
 */
export function compareVersion(a, b) {
  const ua = String(a?.updatedAt ?? '')
  const ub = String(b?.updatedAt ?? '')
  if (ua !== ub) return ua > ub ? 1 : -1
  const da = String(a?.deviceId ?? '')
  const db = String(b?.deviceId ?? '')
  if (da !== db) return da > db ? 1 : -1
  return 0
}

/** 百分比收敛到 [0,1]；非数字按 0。 */
function clampPercent(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  if (number <= 0) return 0
  if (number >= 1) return 1
  return number
}

/** 取几个 ISO 时间里最晚的那个（空串视为最旧）。 */
function laterIso(...values) {
  let best = ''
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue
    if (value > best) best = value
  }
  return best
}

/**
 * 作者名兜底：`Unknown` 是解析器在 EXTH 100 缺失时给的占位，
 * 它不是作者，展示出来只会让书架显得敷衍。
 */
export function sensibleAuthor(rawAuthor) {
  const author = typeof rawAuthor === 'string' ? rawAuthor.trim() : ''
  if (author === '' || /^(unknown|untitled|n\/a|未知)$/i.test(author)) return ''
  return author
}

/** 像不像一串机器生成的 hash（16 进制 16 位以上、或全是数字/连字符的随机串）。 */
function looksLikeHash(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  if (/^[0-9a-f]{16,}$/i.test(value)) return true
  // 文件名常见的 32 位十六进制 + 可选 -/_ 分隔
  if (/^[0-9a-f]{8,}([-_][0-9a-f]{4,})+$/i.test(value)) return true
  return false
}

/**
 * 决定一本书在界面上叫什么。
 *
 * 三级退路：解析器给的标题 → 导入时的文件名（去扩展名、去 `_`/`-` 尾巴）→ 「未命名书籍」。
 * 为什么必须拦：很多下载站把文件名写成 `b350b34a3aa92d90aa59b1d87694187d.mobi`，
 * MOBI 里又没有 EXTH 503，直接展示就是用户说的「书名变成一堆乱码」。
 *
 * @param {unknown} rawTitle 解析器给的标题
 * @param {string} filename 导入时的原始文件名（可为空）
 * @returns {string}
 */
export function sensibleTitle(rawTitle, filename) {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  const generic = title === '' || title === 'Unknown' || title === 'untitled' || looksLikeHash(title)
  if (!generic) return title

  const stem = String(filename ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+$/, '')
    .trim()
  if (stem !== '' && !looksLikeHash(stem)) return stem
  return '未命名书籍'
}

/** settings 合并：只认 §3.3 的五个键，其余键忽略（strict 时抛错）。 */
export function mergeSettings(base, patch, options = {}) {
  const out = { ...DEFAULT_SETTINGS, ...(base ?? {}) }
  if (!patch || typeof patch !== 'object') return out
  const bad = (detail) => {
    if (options.strict) {
      throw fail('E_BAD_SETTINGS', '这些阅读设置没能保存，请调整后再试。', { detail })
    }
    return null
  }

  if (patch.fontSize !== undefined) {
    const value = Number(patch.fontSize)
    if (!Number.isFinite(value) || value < 10 || value > 48) {
      bad(`fontSize out of range: ${String(patch.fontSize)}`)
    } else {
      out.fontSize = Math.round(value * 10) / 10
    }
  }
  if (patch.lineHeight !== undefined) {
    const value = Number(patch.lineHeight)
    if (!Number.isFinite(value) || value < 1 || value > 3) {
      bad(`lineHeight out of range: ${String(patch.lineHeight)}`)
    } else {
      out.lineHeight = Math.round(value * 100) / 100
    }
  }
  if (patch.theme !== undefined) {
    const value = String(patch.theme)
    if (value.length === 0 || value.length > 32) bad(`theme length: ${value.length}`)
    else out.theme = value
  }
  if (patch.columns !== undefined) {
    const value = Number(patch.columns)
    if (!Number.isInteger(value) || value < 1 || value > 2) bad(`columns out of range: ${String(patch.columns)}`)
    else out.columns = value
  }
  if (patch.fontFamily !== undefined) {
    const value = String(patch.fontFamily)
    if (value.length > 200) bad(`fontFamily too long: ${value.length}`)
    else out.fontFamily = value
  }
  if (patch.bookSources !== undefined) {
    const sources = normalizeBookSources(patch.bookSources)
    if (sources === null) bad('bookSources')
    else out.bookSources = sources
  }
  if (patch.aiProvider !== undefined) {
    const value = String(patch.aiProvider)
    if (value.length > 120) bad(`aiProvider too long: ${value.length}`)
    else out.aiProvider = value
  }
  if (patch.aiModel !== undefined) {
    const value = String(patch.aiModel)
    if (value.length > 200) bad(`aiModel too long: ${value.length}`)
    else out.aiModel = value
  }
  if (patch.aiEffort !== undefined) {
    const value = String(patch.aiEffort)
    // 空串是合法值：表示「跟随模型声明的默认档」
    if (value !== '' && !EFFORT_ORDER.includes(value)) bad(`aiEffort unknown: ${value}`)
    else out.aiEffort = value
  }
  return out
}

/**
 * 校验书源数组。**校验失败返回 null**，由调用方决定是抛错还是忽略
 * （`getSettings()` 读到脏数据时应该忽略，`putSettings()` 时应该报错）。
 *
 * 规则：最多 8 条；每条必须有 id / name / searchUrl；searchUrl 必须是 http(s)
 * 且含 `{query}`。不校验站点——插件不认识任何具体站点。
 *
 * @param {unknown} value
 * @returns {{ id: string, name: string, searchUrl: string }[]|null}
 */
export function normalizeBookSources(value) {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_BOOK_SOURCES) return null
  /** @type {{ id: string, name: string, searchUrl: string }[]} */
  const out = []
  const ids = new Set()
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const searchUrl = typeof item.searchUrl === 'string' ? item.searchUrl.trim() : ''
    if (id === '' || id.length > 32 || ids.has(id)) return null
    if (name === '' || name.length > 40) return null
    if (searchUrl.length > 500 || !/^https?:\/\//i.test(searchUrl) || !searchUrl.includes('{query}')) return null
    try {
      // 真正拼一次，挡住 `https://` 后面什么都没有这种写法。
      buildSearchUrl(searchUrl, 'x')
    } catch {
      return null
    }
    ids.add(id)
    out.push({ id, name, searchUrl })
  }
  return out
}

/**
 * 校验一条标注记录（schema/contract.schema.json 的宿主侧同构子集）。
 *
 * 只拦**会让锚点失去意义**的缺失：没有 cfi 就无法定位，没有 textFingerprint 就无法
 * 做 L3 校验。多余字段保留（客户端将来加字段不用改宿主）。
 *
 * @param {unknown} record
 * @returns {object}
 */
export function validateRecord(record) {
  const bad = (field) =>
    fail('E_BAD_RECORD', '这条标注缺少必要信息，没能保存。', { detail: `invalid field: ${field}` })
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw bad('#record')

  const type = String(record.type ?? '')
  if (!RECORD_TYPES.has(type)) throw bad('type')

  const id = String(record.id ?? '').trim()
  if (!ULID_PATTERN.test(id)) throw bad('id')

  const cfi = String(record.cfi ?? '').trim()
  if (!cfi.startsWith('epubcfi(')) throw bad('cfi')

  const chapterHref = String(record.chapterHref ?? '').trim()
  if (chapterHref === '') throw bad('chapterHref')

  const out = { ...record, id, type, cfi, chapterHref }

  if (type === 'highlight' || type === 'note') {
    if (typeof record.textExcerpt !== 'string') throw bad('textExcerpt')
    const fingerprint = record.textFingerprint
    if (!fingerprint || typeof fingerprint !== 'object') throw bad('textFingerprint')
    if (typeof fingerprint.head !== 'string') throw bad('textFingerprint.head')
    if (typeof fingerprint.tail !== 'string') throw bad('textFingerprint.tail')
    if (!Number.isInteger(fingerprint.len)) throw bad('textFingerprint.len')
    if (typeof fingerprint.hash !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint.hash)) {
      throw bad('textFingerprint.hash')
    }
    const color = String(record.color ?? '')
    if (!COLORS.has(color)) throw bad('color')
    out.color = color
    if (type === 'note') {
      if (typeof record.note !== 'string' || record.note.trim() === '') throw bad('note')
    }
  }

  if (type === 'bookmark') {
    const color = String(record.color ?? 'yellow')
    out.color = COLORS.has(color) ? color : 'yellow'
  }

  return out
}
