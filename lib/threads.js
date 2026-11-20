/**
 * threads.js —— 跨书主题聚类（0.13.0 P5 第二半，docs/26 七）。
 *
 * 做的是什么：把「我在好几本书里都问过同一个东西」找出来，提醒用户
 * 「这已经长成一个主题了，要不要单独立一页」。纯函数，不调 AI，不碰文件。
 *
 * 三条设计约束，改的时候别绕开：
 *
 * 1. 机械聚类，不调 AI。理由不是省钱：让模型判「这两个问题是不是同一个主题」
 *    每次答案都不一样，用户第二次点开候选列表就换了，他没法信任这个东西。
 *    抽词 + 跨书计数是确定的，同一批问答永远出同一批候选。
 *
 * 2. 门槛宁可高。一条候选要同时满足「出现在 >=2 本书」「累计 >=3 段讨论」
 *    「在某一本书里也出现 >=2 次」。docs/26 七 的原话是「误报的主题页比没有更烦人」：
 *    主题页一旦立起来就要长期维护，随手立十个，用户下次看到就全当噪音了。
 *
 * 3. 不替用户下判断。「我现在的判断」那一节永远留空。这一页的价值在于
 *    把不同书里关于同一件事的说法并排放，判断是读者自己的事。
 */

import { createHash } from 'node:crypto'

/** 主题页格式版本。改了页面骨架就加一。 */
export const THREADS_VERSION = 1

/** 候选门槛。数字都在这里，别散在函数里。 */
export const MIN_BOOKS = 2
export const MIN_BLOCKS = 3
export const MIN_HITS_IN_ONE_BOOK = 2
export const MAX_CANDIDATES = 12
export const MAX_QUOTE = 120
export const MAX_TERM = 12

/** 主题页放哪、总览放哪。都在 dsh-reading 子目录内，不往用户的库里乱写。 */
export const THREADS_DIR = '_主题'
export const THREADS_INDEX = '_索引/主题总览.md'

/** 抽词长度区间：2-4 字。中文里 1 字的词太泛（人、事、书），5 字以上几乎不成词。 */
const MIN_GRAM = 2
const MAX_GRAM = 4

/** 只要中文连续段。标点、空白、外文一律当分隔符。 */
const SEGMENT = /[\u4e00-\u9fa5]+/g

/**
 * 虚词表。命中即丢——子串切法必然跨词边界，
 * 「主题阅读的方法」会切出「题阅读的」「是什」这种东西，靠这张表擦掉。
 */
const STOPWORDS = new Set([
  '什么', '怎么', '为什', '如何', '哪些', '哪个', '为什么', '我们', '你们', '他们',
  '一个', '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里',
  '可以', '不是', '就是', '还是', '但是', '因为', '所以', '如果', '虽然', '不过',
  '时候', '东西', '事情', '问题', '地方', '方面', '情况', '意思', '内容', '部分',
  '自己', '别人', '大家', '有人', '没有', '有着', '一样', '一些', '一下', '一直',
  '作者', '本书', '书中', '这书', '那本', '这本', '是否', '能否', '应该',
  '觉得', '认为', '感觉', '知道', '看到', '说到', '想问', '请问', '告诉',
])

/** 含这些片段就丢（比虚词更长的噪音）。 */
const NOISE_PARTS = [
  '一个', '这个', '那个', '什么', '怎么', '为什', '如何', '哪些', '我们', '你们',
  '可以', '不是', '就是', '时候', '东西', '事情', '问题', '地方', '方面',
  '意思', '内容', '部分', '自己', '别人', '觉得', '认为', '感觉', '知道',
]

/** 候选词以这些字开头或结尾就丢（跨词边界的典型残渣）。 */
const EDGE_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '被', '把', '让',
  '对', '从', '向', '给', '为', '以', '于', '之', '其', '这', '那', '哪', '什',
  '么', '怎', '吗', '呢', '吧', '啊', '呀', '着', '过', '很', '更', '最', '还',
  '又', '不', '没', '有', '会', '能', '要', '想', '说', '做', '个', '些', '样',
])

const S = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return max && text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * 一段文字里的候选词（2-4 字子串）。
 *
 * 不引分词库：中文分词要么带几 MB 的词典，要么依赖宿主，两种都不合适。
 * 跨书计数已经把大部分子串噪音自动压下去了——「题阅读的」这种残渣只在一段里
 * 出现，达不到跨书门槛。
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function gramTerms(text) {
  const source = String(text ?? '')
  const terms = new Set()
  for (const segment of source.match(SEGMENT) ?? []) {
    for (let size = MIN_GRAM; size <= MAX_GRAM; size += 1) {
      for (let at = 0; at + size <= segment.length; at += 1) {
        const term = segment.slice(at, at + size)
        if (isNoise(term)) continue
        terms.add(term)
      }
    }
  }
  return [...terms]
}

/** 这个词像不像噪音。抽词与排序共用一处判断。 */
export function isNoise(term) {
  const text = String(term ?? '')
  if (text.length < MIN_GRAM || text.length > MAX_GRAM) return true
  if (STOPWORDS.has(text)) return true
  if (NOISE_PARTS.some((part) => text.includes(part))) return true
  if (EDGE_CHARS.has(text[0]) || EDGE_CHARS.has(text[text.length - 1])) return true
  return false
}

/**
 * 一条讨论里的词：问题与答案分开抽。
 *
 * 为什么答案也要抽：读者真正关心的东西常常只在答案里被点名
 * （问「这一章在讲什么」，答案里出现「沉默的螺旋」——那才是主题）。
 * 但答案主要由模型写，不能让它单方面定义主题，所以两边分开返回，
 * 计数时合并、页面引用时只用问题原句。
 *
 * @param {{ question?: unknown, answer?: unknown }} record
 * @returns {{ fromQuestion: string[], fromAnswer: string[] }}
 */
export function termsOfRecord(record) {
  return {
    fromQuestion: gramTerms(record?.question),
    fromAnswer: gramTerms(record?.answer),
  }
}

const shortHash = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 10)

/** 主题页锚块 id：来自主题名，改名就是另一页。 */
export function threadBlockId(term) {
  return 'th-' + shortHash(term)
}

/** 主题页文件名。不带书名（跨书），非法字符换成下划线。 */
export function threadFileName(term) {
  const name = S(term, MAX_TERM).replace(/[\\/:*?\"<>|]/g, '_')
  return (name || '未命名主题') + '.md'
}
/**
 * 从多本书的讨论里找候选主题。
 *
 * @param {{ books?: Array<{ bookHash?: string, title?: string, blocks?: any[] }> }} input
 *   blocks 每项 { id?, question?, answer?, chapterLabel?, chapterHref? }
 * @returns {{ candidates: any[], scanned: { books: number, blocks: number } }}
 */
export function buildCandidates(input) {
  const books = asArray(input?.books)

  // term -> { books: Map<bookHash, {title, hits[]}>, blockCount }
  const tally = new Map()
  let scannedBlocks = 0
  let scannedBooks = 0

  for (const book of books) {
    const bookHash = S(book?.bookHash, 64)
    const title = S(book?.title, 120) || '未命名书籍'
    const blocks = asArray(book?.blocks).filter((item) => item && typeof item === 'object')
    if (blocks.length === 0) continue
    scannedBooks += 1
    for (const block of blocks) {
      const question = S(block?.question, 400)
      const answer = S(block?.answer, 2000)
      const terms = termsOfRecord({ question, answer })
      const local = new Set([...terms.fromQuestion, ...terms.fromAnswer])
      if (local.size === 0) continue
      scannedBlocks += 1
      for (const term of local) {
        if (!tally.has(term)) tally.set(term, { books: new Map(), blockCount: 0 })
        const entry = tally.get(term)
        entry.blockCount += 1
        if (!entry.books.has(bookHash)) entry.books.set(bookHash, { bookHash, title, hits: [] })
        const perBook = entry.books.get(bookHash)
        perBook.hits.push({
          qaId: S(block?.id, 40),
          question,
          answer,
          chapterLabel: S(block?.chapterLabel, 80),
          chapterHref: S(block?.chapterHref, 400),
          // 原句取问题的开头：问题的措辞是用户自己的，比答案更能代表他想问什么。
          quote: S(question, MAX_QUOTE),
        })
      }
    }
  }

  const candidates = []
  for (const [term, entry] of tally) {
    const bookCount = entry.books.size
    if (bookCount < MIN_BOOKS) continue
    if (entry.blockCount < MIN_BLOCKS) continue
    // 同一本书里也要出现两次以上：两本书各问一次就立页，那是巧合不是主题。
    const perBook = [...entry.books.values()].sort((a, b) => b.hits.length - a.hits.length)
    if (perBook[0].hits.length < MIN_HITS_IN_ONE_BOOK) continue
    candidates.push({
      term,
      bookCount,
      blockCount: entry.blockCount,
      books: perBook.map((item) => ({
        bookHash: item.bookHash,
        title: item.title,
        count: item.hits.length,
        hits: item.hits.slice(0, 5),
      })),
    })
  }

  // 排序：跨的书多者优先 -> 讨论段数多者优先 -> 词长 -> 字典序。
  // 末两项只为「同一输入永远同一顺序」，用户第二次看到的是同一批。
  candidates.sort((a, b) => (
    b.bookCount - a.bookCount
    || b.blockCount - a.blockCount
    || b.term.length - a.term.length
    || a.term.localeCompare(b.term, 'zh')
  ))

  // 长词盖短词：子串切法会把「主题阅读」同时产成「主题阅」「题阅读」「阅读」「主题」。
  // 它们的跨书计数完全一样，留着就是六条说的是同一件事，用户看到只会觉得这东西不准。
  // 判据要严一点：被盖住的词必须在书数与段数上都不占优——只占数量优势的短词
  // （比如「阅读」出现在 5 本书、而「主题阅读」只在 2 本）是真话题，得留下。
  const kept = []
  for (const item of candidates) {
    const covered = kept.some((bigger) => (
      bigger.term.includes(item.term)
      && bigger.bookCount >= item.bookCount
      && bigger.blockCount >= item.blockCount
    ))
    if (!covered) kept.push(item)
  }

  return {
    candidates: kept.slice(0, MAX_CANDIDATES),
    scanned: { books: scannedBooks, blocks: scannedBlocks },
  }
}

/**
 * 候选主题的一句话说明，给列表用。
 *
 * @param {any} candidate
 * @returns {string}
 */
export function candidateLine(candidate) {
  const books = asArray(candidate?.books)
  const shown = books.slice(0, 3).map((item) => '《' + S(item.title, 40) + '》')
  const more = books.length > shown.length ? ' 等 ' + books.length + ' 本' : ''
  return '出现在 ' + (candidate?.bookCount ?? 0) + ' 本书、'
    + (candidate?.blockCount ?? 0) + ' 段讨论：' + shown.join('、') + more
}
/**
 * 一页主题笔记的正文。
 *
 * 「我现在的判断」永远留空：这一页的意义是把不同书里的说法并排放在
 * 用户眼前，让他自己写结论。程序替他填一句，他就不会再自己想了。
 *
 * @param {any} candidate buildCandidates 的一项
 * @param {{ updatedAt?: string }} [options]
 * @returns {{ title: string, markdown: string }}
 */
export function buildThreadPage(candidate, options = {}) {
  const term = S(candidate?.term, MAX_TERM) || '未命名主题'
  const books = asArray(candidate?.books)
  const updatedAt = S(options?.updatedAt, 40)

  const lines = ['# ' + term, '']
  lines.push(
    '> 出现在 ' + (candidate?.bookCount ?? books.length) + ' 本书、'
    + (candidate?.blockCount ?? 0) + ' 段讨论'
    + (updatedAt !== '' ? ' · 最后更新 ' + updatedAt : ''),
    '',
  )

  lines.push('## 这本书里怎么说', '')
  for (const book of books) {
    const hits = asArray(book?.hits)
    const first = hits[0]
    const where = first && first.chapterLabel !== '' ? '（' + S(first.chapterLabel, 80) + '）' : ''
    lines.push('- 《' + S(book?.title, 60) + '》' + where + '：'
      + (first && first.quote !== '' ? '「' + first.quote + '」' : '（没有留下原文）'))
  }
  lines.push('')

  lines.push(
    '## 别的书怎么处理',
    '',
    '> 这一节留给更深入的说法：哪本书给了方法、哪本书给了反例。',
    '> 想补就直接在下面写，程序不会动你自己加的行。',
    '',
  )

  lines.push(
    '## 我现在的判断',
    '',
    '<!-- 这一段故意留空。主题页的价值在于把不同书的说法并排放，判断是你自己的事。 -->',
    '',
  )

  // 讨论清单由程序写在下面这个标题后（upsertBlock 只会替换已有块或追加到文件末尾，
  // 所以这个标题必须放在最后，块才会落在它正下方）。
  lines.push('## 讨论记录', '')

  return { title: term, markdown: lines.join('\n') }
}

/**
 * 「这一页里有哪些讨论」的锚块正文。
 *
 * 单独一个块、由程序维护：主题页正文是用户的地盘，讨论清单是数据，
 * 两者混在一起，用户改一行就会被判成 userEdited，从此不再更新。
 *
 * @param {any} candidate
 * @returns {string}
 */
export function buildThreadInner(candidate) {
  const books = asArray(candidate?.books)
  if (books.length === 0) return '> 还没有讨论记录。'
  const lines = ['> ' + (candidate?.blockCount ?? 0) + ' 段讨论，按书分组。']
  for (const book of books) {
    lines.push('', '### 《' + S(book?.title, 60) + '》')
    for (const hit of asArray(book?.hits)) {
      const where = hit.chapterLabel !== '' ? '（' + S(hit.chapterLabel, 80) + '）' : ''
      lines.push('- ' + (hit.quote !== '' ? '「' + hit.quote + '」' : '（无原文）') + where)
    }
  }
  return lines.join('\n')
}

/**
 * `_索引/主题总览.md` 的正文：一行一个已立主题。
 *
 * 用列表而不是表格：列表项里能放 [[链接]]，表格里放双链 Obsidian 渲染不好。
 *
 * @param {Array<{ term: string, bookCount?: number, blockCount?: number, relPath?: string }>} threads
 * @param {{ updatedAt?: string }} [options]
 * @returns {string}
 */
export function buildOverviewInner(threads, options = {}) {
  const list = asArray(threads).filter((item) => S(item?.term, MAX_TERM) !== '')
  if (list.length === 0) {
    return '> 还没有立过主题。等同一件事在两本书里都问过，候选会出现在笔记侧栏里。'
  }
  const updatedAt = S(options?.updatedAt, 40)
  const lines = []
  if (updatedAt !== '') lines.push('> 最后更新 ' + updatedAt, '')
  for (const item of list) {
    const name = S(item.term, MAX_TERM)
    const link = S(item.relPath, 200) !== '' ? '[[' + name + ']]' : name
    lines.push('- ' + link + ' —— 出现在 ' + (item.bookCount ?? 0) + ' 本书、' + (item.blockCount ?? 0) + ' 段讨论')
  }
  return lines.join('\n')
}

/** 总览整份也是一个块：它是所有主题的一行摘要，本来就是整体重画的。 */
export const OVERVIEW_BLOCK_ID = 'thread-index'

/**
 * 总览页的文件头。程序维护的块追加在它后面。
 *
 * @returns {string}
 */
export function buildOverviewHeader() {
  return [
    '# 主题总览',
    '',
    '> 这份索引由 dsh-reading 维护：每立一个跨书主题，这里加一行。',
    '> 你自己加的行不会被删，但也不会被自动排序——我没有替你整理的自由。',
    '',
    '## 已立的主题',
    '',
  ].join('\n')
}

/**
 * 从总览正文里读回已立主题（带计数）。
 *
 * 计数读不回来就记 0：索引是用来点进去的，数字只是辅助，
 * 猜错一个数字比丢掉整张列表更让人困惑。
 *
 * @param {unknown} markdown
 * @returns {Array<{ term: string, bookCount: number, blockCount: number }>}
 */
export function parseOverviewEntries(markdown) {
  const entries = []
  const seen = new Set()
  for (const line of String(markdown ?? '').split('\n')) {
    const match = /^\s*[-*]\s+(?:\[\[([^\]]+)\]\]|([^—\n]+?))\s*(?:——|--|$)/.exec(line)
    if (!match) continue
    const name = S(match[1] ?? match[2], MAX_TERM)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    const counts = /(\d+)\s*本书[、,，]\s*(\d+)\s*段讨论/.exec(line)
    entries.push({
      term: name,
      bookCount: counts ? Number(counts[1]) : 0,
      blockCount: counts ? Number(counts[2]) : 0,
    })
  }
  return entries
}

/**
 * 从总览正文里读回已立的主题名。
 *
 * 解析失败就当没立过：宁可让用户再点一次「立成主题」（那一页已存在时会更新，
 * 不会重复建），也不要因为格式猜测错误把整张列表藏起来。
 *
 * @param {unknown} markdown
 * @returns {string[]}
 */
export function parseOverview(markdown) {
  return parseOverviewEntries(markdown).map((item) => item.term)
}