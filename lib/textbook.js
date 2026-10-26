/**
 * 「重排书」构造器：把任意来源的**纯文字章节**包装成与 EPUB 解析结果同形的书对象。
 *
 * 为什么需要它：阅读器的其余部分（store / routes / 客户端 CFI / 标注 / 进度）
 * 全都只认一套东西——`spine` + 章节 XHTML + `toc` + 可选的封面与资源。
 * 只要把 TXT 与 MOBI 的文字包成同样的形状，上游一行都不用改，CFI 也照常工作。
 *
 * 代价要说清：重排书没有插图、没有原始版式、没有字体嵌入。它对「读到文字、
 * 划线、记笔记、续读」是完整的，对「看图表」不是。这是有意的取舍（见 docs/08）。
 * 唯一的例外是**封面**：MOBI/AZW3 里真实存在的封面图会在导入时被抽出来，
 * 作为这本书唯一的资源挂在 `coverHref` 上，好让书架不再显示「首字卡片」。
 *
 * 章节地址是自己造的 `text/chNNN.xhtml`，只在本进程内有效；它不落盘，
 * 每次解析都按同样规则重新生成，因此同一份字节永远得到同样的 href 与同样的 CFI。
 *
 * 什么时候会失败、失败给谁看：
 *   - 章节数组为空 → `E_BOOK_EMPTY`，界面显示「这个文件里没有读到文字」。
 *   - 其它情况不抛错：文字再怪也只是显示得难看。
 */

import { createHash } from 'node:crypto'
import { fail } from './errors.js'

/** 段落里「像章标题」的行最长多少字（超过就按正文处理）。 */
const MAX_HEADING_LENGTH = 60

/** 单章段落数上限：再多的章节对读者也没意义，只会让一次解析卡住。 */
const MAX_PARAGRAPHS_PER_CHAPTER = 20000

/**
 * 把一段文字转成可以安全塞进 XHTML 的形态。
 *
 * 只处理五个预定义实体 + 不可见控制字符：重排书的文字来自我们已经解码过的
 * UTF-8 字符串，不是原始 HTML，因此**不能**把 `&amp;` 再喂一遍（会二次转义）。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXmlText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // XHTML 不允许裸控制字符（\u0000-\u0008 等），它们会让整个文档解析失败，
    // 而解析失败的表现是「这一章空白」，排查起来极难。直接抹掉。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/**
 * 造一章的 XHTML 文档。
 *
 * 不注入任何 `<style>`：阅读器的排版样式由客户端统一注入 iframe，
 * 章节里再写一份会跟字号/行距设置打架。
 *
 * @param {string} label 章节标题
 * @param {string[]} paragraphs 段落纯文本
 * @returns {string}
 */
   /**
 * 合并「硬折行」——把同一段里被源文件强行断成多行的文字接回去。
 *
 * 为什么需要：很多下载来的 TXT / 老 MOBI 每行都带换行（甚至一行只有三五个字），
 * 我们若把每一行都当成一个段落，渲染时每行都会吃到「首行缩进 2em」，看上去
 * 就是「三个字一行、一页只排了半边」。这是排版错乱的第二大来源（第一大来源是
 * 书籍自带 CSS 把 body 挤窄，由 client/src/reader.js 的 applyGeometry 解决）。
 *
 * 判据只有一条：**上一行有没有断句**。上一行以句末/逗号类标点结尾，它就是一段的
 * 结尾，下一行另起；否则这一行是被硬折行切开的，接上去。诗句、标题、对话这类
 * 每行都有标点的文本因此不会被误合并。
 *
 * @param {string[]} paragraphs 逐行的段文本
 * @returns {string[]} 合并后的段落
 */
export function mergeWrappedLines(paragraphs) {
  const input = Array.isArray(paragraphs) ? paragraphs : []

  // 先判「这是不是分行排版的韵文/诗」。诗的每一行都以标点收尾、每行都不长；
  // 硬折行的碎片恰好相反（多数行没有标点）。把诗当硬折行合并会把《静夜思》
  // 揉成一坨，所以这个判断要放在合并之前。
  const nonEmpty = input.map((line) => String(line ?? '').trim()).filter((line) => line !== '')
  if (nonEmpty.length >= 3) {
    const punctuated = nonEmpty.filter((line) => /[，、。！？；：,.;:!?]$/.test(line)).length
    const sorted = nonEmpty.map((line) => line.length).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (punctuated / nonEmpty.length >= 0.7 && median <= 18) {
      return nonEmpty
    }
  }

  /** @type {string[]} */
  const out = []
  let buffer = ''

  const flush = () => {
    if (buffer !== '') {
      out.push(buffer)
      buffer = ''
    }
  }

  for (const raw of input) {
    const line = String(raw ?? '').trim()
    if (line === '') {
      // 空行是明确的「另起一段」信号，比标点更硬
      flush()
      continue
    }
    if (buffer === '') {
      buffer = line
      continue
    }
    if (endsParagraph(buffer)) {
      flush()
      buffer = line
      continue
    }
    buffer = joinWrapped(buffer, line)
  }
  flush()
  return out
}

/**
 * 「这一行是不是一段的结尾」。
 *
 * 只认真正的句末/分句号。逗号顿号（，、）**不算**——中文硬折行常常正好折在
 * 逗号后面，把它们当段尾，等于原封不动地保留错乱的行。英文句点要更像一句话
 * 才算段尾（长度 ≥ 40），否则 `CHAPTER I.`、`Mr.` 这种缩写/小标题会被切断，
 * 章名推导就只剩「CHAPTER I.」。
 */
function endsParagraph(text) {
  const line = String(text ?? '').trim()
  if (line === '') return true
  if (/[。！？!?…‥；;：:」』”’"'）)】》〉\]]$/.test(line)) return true
  if (/[.．]$/.test(line)) return line.length >= 40
  return false
}

/**
 * 把两段正文接起来：中日韩文字之间不加空格，拉丁字母/数字之间补一个空格。
 * 直接原样拼接会让英文单词黏在一起（`thissentence`）。
 */
function joinWrapped(left, right) {
  const a = left[left.length - 1]
  const b = right[0]
  const cjk = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/
  if (cjk.test(a) || cjk.test(b)) return left + right
  // 英文硬折行：`CHAPTER I.` + `Down the…` 这类，不补空格会黏成 `I.Down`
  if (/[A-Za-z0-9.,!?;:'")\]]/.test(a) && /[A-Za-z0-9("'[]/.test(b)) return `${left} ${right}`
  return left + right
}

export function buildChapterXhtml(label, paragraphs) {
  const title = escapeXmlText(label)
  const body = paragraphs
    .map((text) => `    <p>${escapeXmlText(text)}</p>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
${body}
</body>
</html>
`
}

/**
 * 把重排章节包成完整的书对象。
 *
 * 返回的形状与 `lib/epub.js` 的 `parseEpub` 一致（见 docs/05 §2）：
 * store 与 routes 只依赖 `meta` / `toc` / `chapterHtml` / `assetBytes` /
 * `resolveRelative` / `coverHref` 这几样，两者可以互换。
 *
 * 封面只影响两处：`coverHref`（没有封面时是 null）与 `assetBytes(coverHref)`
 * （没有封面时对所有 href 都返回 null）。其它章节地址与 CFI 完全不变。
 *
 * @param {{
 *   chapters: Array<{ label: string, paragraphs: string[] }>,
 *   title: string,
 *   author?: string,
 *   format: 'mobi-converted' | 'txt-converted',
 *   sourceFormat: 'mobi' | 'azw3' | 'txt',
 *   converterVersion?: string,
 *   bytes: Uint8Array,
 *   filename?: string,
 *   deviceId?: string,
 *   now?: string,
 *   language?: string,
 *   cover?: { data: Uint8Array, mediaType: string } | null,
 *   tocSource?: string,
 * }} input
 */
export function buildReflowedBook(input) {
  const rawChapters = Array.isArray(input?.chapters) ? input.chapters : []
  /** @type {Array<{ label: string, paragraphs: string[] }>} */
  const chapters = []
  for (const chapter of rawChapters) {
    // 注意顺序：**先用原始行认章名，再合硬折行**。
    // 反过来的话，「CHAPTER I.」和它下面那行标题会被合并成一段长文字，章名反而认不出来。
    const raw = (Array.isArray(chapter?.paragraphs) ? chapter.paragraphs : [])
      .map((text) => String(text ?? '').trim())
      .filter((text) => text !== '')
    const label = String(chapter?.label ?? '').trim()
    if (raw.length === 0 && label === '') continue
    chapters.push({ label, raw, paragraphs: raw })
  }
  if (chapters.length === 0) {
    throw fail('E_BOOK_EMPTY', '这个文件里没有读到文字，可能不是一本电子书。')
  }

  // 没有标题的章节先试着自己找一个（MOBI 抽出来的书常常没有 <h1>）。
  for (const chapter of chapters) {
    if (chapter.label === '') {
      const derived = deriveChapterLabel(chapter.raw)
      if (derived.label !== '') {
        chapter.label = derived.label
        chapter.paragraphs = derived.paragraphs
      }
    }
    // 认完章名，再合硬折行：源文件一行一段的话，这里还原成真段落。
    chapter.paragraphs = mergeWrappedLines(chapter.paragraphs)
      .map((text) => String(text ?? '').trim())
      .filter((text) => text !== '')
      .slice(0, MAX_PARAGRAPHS_PER_CHAPTER)
    delete chapter.raw
  }

  const bytes = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
  const bookHash = createHash('sha256').update(bytes).digest('hex')

  /** @type {Map<string, string>} href → XHTML；同一次解析内复用，不落盘。 */
  const chapterFiles = new Map()
  const spine = chapters.map((chapter, index) => {
    const href = `text/ch${String(index + 1).padStart(3, '0')}.xhtml`
    const label = chapter.label === '' ? `第 ${index + 1} 章` : chapter.label
    chapterFiles.set(href, buildChapterXhtml(label, chapter.paragraphs))
    return { index, href, idref: `ch${index + 1}`, mediaType: 'application/xhtml+xml' }
  })

  const toc = spine.map((entry, index) => ({
    label: chapters[index].label === '' ? `第 ${index + 1} 章` : chapters[index].label,
    href: entry.href,
    spineIndex: entry.index,
    depth: 0,
  }))

  const now = typeof input.now === 'string' && input.now !== '' ? input.now : new Date().toISOString()
  const title = String(input.title ?? '').trim()
  const author = String(input.author ?? '').trim()

  // 封面是这本书唯一的外部资源。没有封面时（比如 TXT、或解析器没抽到）整条链路
  // 保持原样：coverHref 为 null，assetBytes 对所有 href 都返回 null。
  const inputCover = input?.cover
  const cover =
    inputCover && inputCover.data instanceof Uint8Array && inputCover.data.length > 0
      ? inputCover
      : null
  const coverHref = cover
    ? `cover.${cover.mediaType === 'image/png' ? 'png' : cover.mediaType === 'image/gif' ? 'gif' : 'jpg'}`
    : null

  if (cover && coverHref) {
    // store/routes 读封面时按 EPUB 的形状取 `asset.bytes` / `asset.mediaType`
    // （见 lib/store.js 的 coverBytes 与 lib/routes.js 的 serveCover）。重排书的
    // 对外契约是「assetBytes(coverHref) 直接返回字节」，所以在这份字节上挂两个
    // 不可枚举的只读别名，两边都不用为格式分叉；逐字节比较与序列化都不受影响。
    // 万一传进来的字节不可扩展，也只是少了两个兼容别名，不能让整本书导入失败。
    try {
      Object.defineProperties(cover.data, {
        bytes: { value: cover.data, enumerable: false, writable: false, configurable: false },
        mediaType: {
          value: cover.mediaType,
          enumerable: false,
          writable: false,
          configurable: false,
        },
      })
    } catch {
      // 忽略：assetBytes 仍然按契约返回原始字节。
    }
  }

  /** @type {Record<string, unknown>} */
  const meta = {
    schema: 'dsh-reading/1',
    bookHash,
    title: title === '' ? deriveTitle(input.filename) : title,
    author,
    format: input.format,
    sourceFormat: input.sourceFormat,
    fileSize: bytes.length,
    spine: spine.map((entry) => ({
      index: entry.index,
      href: entry.href,
      idref: entry.idref,
      mediaType: entry.mediaType,
    })),
    converterVersion: input.converterVersion ?? 'text/1',
    createdAt: now,
    updatedAt: now,
    deviceId: typeof input.deviceId === 'string' ? input.deviceId : '',
  }
  if (typeof input.language === 'string' && input.language !== '') meta.language = input.language
  if (coverHref) meta.coverHref = coverHref
  // 目录来源（0.4.0，施工图 §6）：TXT 由 parseTxt 判 headings/split；
  // MOBI/AZW3 转换来的书是程序自动识别的章名，记 auto。
  meta.tocSource =
    typeof input.tocSource === 'string' && input.tocSource !== '' ? input.tocSource : 'auto'

  /** 章节 href 归一：容忍 `./`、URL 编码与反斜杠，与 zip 层的口径保持一致。 */
  const normalizeHref = (href) => {
    let value = String(href ?? '').trim().replace(/\\/g, '/')
    try {
      value = decodeURIComponent(value)
    } catch {
      // 非法编码按原文查：查不到自然 404，不会误命中别的章节。
    }
    while (value.startsWith('./')) value = value.slice(2)
    return value
  }

  return {
    meta,
    toc,
    spine,
    bookHash,
    coverHref,
    // 目录来源也放在顶层，和 lib/epub.js 的返回形状保持一致（bookformat 只是透传）。
    tocSource: meta.tocSource,
    /**
     * 读章节。找不到返回 null（调用方转 404），不抛错。
     * @param {string} href
     * @returns {Promise<string|null>}
     */
    async chapterHtml(href) {
      return chapterFiles.get(normalizeHref(href)) ?? null
    },
    /**
     * 读资源。重排书只有封面这一样资源：`href === coverHref` 时返回封面字节，
     * 其它一律 null（不存在不抛错，调用方转 404）。没有封面时恒为 null。
     * @param {string} href
     * @returns {Promise<Uint8Array|null>}
     */
    async assetBytes(href) {
      if (cover && coverHref && normalizeHref(href) === coverHref) return cover.data
      return null
    },
    /** 章节文件是否存在于本书。 */
    hasEntry: (href) => chapterFiles.has(normalizeHref(href)),
    /** 重排书的地址就是它自己，没有「ZIP 内路径」这一层。 */
    hrefToZipPath: (href) => normalizeHref(href),
    /**
     * 重排书没有任何可引用的相对资源，因此永远返回 null；
     * 保留这个函数是为了让 routes 不必区分书的来源（见 docs/05 §2）。
     */
    resolveRelative: () => null,
    /** 没有 OPF 概念，目录根就是根。 */
    opfDir: '',
    /** 没有临时文件需要清。 */
    dispose: async () => {},
  }
}

/**
 * 段落里「像章标题」的一行：MOBI 的书常见 `<p><b>CHAPTER I.</b></p>` 这种写法，
 * 抽成纯文本后就是普通段落，光看标签抽不出目录。这里按文字形状认一遍：
 * 短、不带句末标点、以「第 X 章 / CHAPTER N / PART N / 序言」这类开头。
 */
const CHAPTER_TITLE_PATTERN =
  /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节節回卷篇部集]|chapter\s+[0-9ivxlcdm]+\b|part\s+[0-9ivxlcdm]+\b|prologue\b|epilogue\b|序章|序言|自序|前言|引子|引言|楔子|尾声|尾聲|终章|終章|后记|後記|番外|附录|附錄|目录|目錄|contents\b)/i

/** 句末标点：标题一般不带。 */
const TITLE_STOP_PUNCTUATION = /[。！？；.,!?;]$/

/**
 * 给没有标题的章节找一个像样的名字。
 *
 * 只从**第一段**里找，且必须是短句、不以句末标点收尾——否则「他说，走吧。」
 * 这种正文第一句会被误当标题。实在找不到就返回空串，由调用方用序号兜底。
 *
 * @param {string[]} paragraphs
 * @returns {{ label: string, paragraphs: string[] }}
 */
export function deriveChapterLabel(paragraphs) {
  const first = paragraphs.length > 0 ? String(paragraphs[0]).trim() : ''
  if (first === '' || first.length > MAX_HEADING_LENGTH) return { label: '', paragraphs }
  if (!CHAPTER_TITLE_PATTERN.test(first)) return { label: '', paragraphs }
  // 「CHAPTER I.」以句点收尾是正常写法，不能被当成一句话否掉；
  // 其它以句末标点收尾的一律按正文处理（「他说，走吧。」）。
  if (TITLE_STOP_PUNCTUATION.test(first) && !/^chapter\s+[0-9ivxlcdm]+\.$/i.test(first)) {
    return { label: '', paragraphs }
  }

  let label = first
  let used = 1
  // 「CHAPTER I.」下一段常常是真正的书名（「Down the Rabbit-Hole」）：
  // 两段都短、都不像句子时并成一个标题，读者看到的是完整章名。
  const second = paragraphs.length > 1 ? String(paragraphs[1]).trim() : ''
  if (/^[^。！？；，,.!?;:]{1,40}$/.test(second) && !CHAPTER_TITLE_PATTERN.test(second)) {
    label = `${label} ${second}`
    used = 2
  }

  // 当成标题后就从正文里摘掉：否则读者会看到同样的字重复两次。
  return { label, paragraphs: paragraphs.slice(used) }
}

/** 书名回退：用文件名去掉扩展名。 */
function deriveTitle(filename) {
  const raw = String(filename ?? '').trim()
  if (raw === '') return '未命名'
  const withoutPath = raw.replace(/^.*[/\\]/, '')
  const withoutExt = withoutPath.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  return withoutExt === '' ? '未命名' : withoutExt
}
