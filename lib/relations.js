/**
 * relations.js —— 02 人物关系：从正文里抽出人，把关系画成 Mermaid。
 *
 * 四件事，按重要性排：
 *
 *   1. **每条边必须带原句**。模型最擅长的是编关系（「他们是旧识」——书里没写）。
 *      所以每条边都要带一句能证明它的原文，落盘前拿回章节纯文本里 indexOf 核对，
 *      核不上就把这条边**丢掉**（docs/26 §十二）。图错了比没有图更糟。
 *   2. **只在小说上做**。非虚构里没有人物，硬抽出来的是「作者」「读者」「我们」。
 *      判据用现成的 meta.category / meta.tags，判不出来就不生成，不硬凑。
 *   3. **分批抽、可中断、可续跑**。一本小说上百章，一次调用塞不下；这里按字符
 *      装箱成若干批，每批一次 AI 调用，批次状态落在 relations.json 里。
 *      用户在界面上点一次跑一批，跑完再点，进度是看得见的。
 *   4. **同一个人只能有一个节点**。第二批抽到「宝玉」、第一批是「贾宝玉」，
 *      合并时按别名并进已有节点，否则图会裂成两半。
 *
 * 纯函数：不碰文件、不调模型。读正文与落盘都在 routes.js / store.js。
 */

import { extractJson, locateQuote } from './distill.js'

/** relations.json 的结构版本。改形状时加一，旧文件按 version 走兼容分支。 */
export const RELATIONS_VERSION = 1

/** 最多从书的开头取多少章来抽。人物基本在前几章全部出场，全书扫一遍纯属浪费。 */
export const MAX_SOURCE_CHAPTERS = 24

/** 一批送进 prompt 的正文上限。再大模型就会开始略读，抽出来的关系变粗糙。 */
export const MAX_BATCH_CHARS = 8000

/** 最多切几批。跑满 8 批还没把主要人物抽全的书，多半不是小说。 */
export const MAX_BATCHES = 8

/** 节点与边的上限：一屏画不下的关系图等于没有。 */
export const MAX_PERSONS = 40
export const MAX_EDGES = 120

/** 一条边的关系词最长几个字。超过就不是「关系」，是一句剧情概括。 */
const MAX_LABEL = 8

const S = (value, max) => {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return max && text.length > max ? text.slice(0, max) : text
}

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * 分类词表。命中「小说」且不命中「非虚构」才认为是小说。
 *
 * 只用现成字段（meta.category 与 meta.tags），不额外调模型判断题材：
 * 判错的代价是一张没用的图，比多一次 90 秒的调用便宜得多。
 */
const FICTION_WORDS = [
  '小说', '文学', 'fiction', 'novel', '故事', '戏剧', '剧本', '诗歌', '词曲',
  '章回', '长篇', '中篇', '短篇', '言情', '武侠', '仙侠', '玄幻', '科幻',
  '推理', '悬疑', '惊悚', '恐怖', '童话', '寓言', '神话', '民间文学', '传奇',
  '青春', '都市', '历史小说', '纪实文学', '散文',
]

const NONFICTION_WORDS = [
  '哲学', '社会科学', '心理学', '经济', '金融', '历史', '教育', '计算机',
  '技术', '数学', '物理', '化学', '生物', '医学', '法律', '管理', '营销',
  '教材', '教辅', '论文', '科普', '工具书', 'self-help', '自助', '商业',
  '政治', '军事', '宗教', '语言学', '考试', '职业', '投资', '编程',
]

/**
 * 这本书该不该出人物关系。
 *
 * @param {object} meta meta.json
 * @returns {{ fiction: boolean, reason: string }}
 */
export function fictionVerdict(meta) {
  const fields = [meta?.category, ...asArray(meta?.tags)]
    .map((item) => S(typeof item === 'string' ? item : '', 40))
    .filter((item) => item !== '')
  if (fields.length === 0) {
    return { fiction: false, reason: '这本书没有登记分类或标签，判断不出是不是小说，所以没做人物关系。' }
  }
  const joined = fields.join(' ').toLowerCase()
  const hitFiction = FICTION_WORDS.find((word) => joined.includes(word.toLowerCase()))
  const hitNonfiction = NONFICTION_WORDS.find((word) => joined.includes(word.toLowerCase()))
  if (hitFiction && !hitNonfiction) {
    return { fiction: true, reason: '分类里有「' + hitFiction + '」，按小说处理。' }
  }
  if (hitNonfiction) {
    return { fiction: false, reason: '分类里有「' + hitNonfiction + '」，不是小说，不做人物关系。' }
  }
  return { fiction: false, reason: '这本书的分类看不出是小说，所以没做人物关系。' }
}

/** 空状态。没抽过时 notes.status 返回它，界面不用判 null。 */
export function emptyState(meta = {}) {
  return {
    version: RELATIONS_VERSION,
    bookHash: typeof meta.bookHash === 'string' ? meta.bookHash : '',
    bookTitle: S(meta.title ?? meta.bookTitle, 120),
    author: S(meta.author, 80),
    updatedAt: '',
    verdict: fictionVerdict(meta),
    batches: [],
    persons: [],
    edges: [],
    dropped: 0,
    truncated: false,
  }
}

/**
 * 把台账补成完整形状。读到坏文件时宁可当空状态，也不要让整页笔记打不开。
 * @param {unknown} raw
 * @param {object} [meta]
 */
export function normalizeState(raw, meta = {}) {
  const base = emptyState(meta)
  if (!raw || typeof raw !== 'object') return base
  const persons = []
  for (const item of asArray(raw.persons)) {
    const name = S(item?.name, 40)
    if (name === '') continue
    persons.push({ name, alias: asArray(item?.alias).map((one) => S(one, 40)).filter((one) => one !== '') })
  }
  const edges = []
  for (const item of asArray(raw.edges)) {
    const from = S(item?.from, 40)
    const to = S(item?.to, 40)
    const label = S(item?.label, MAX_LABEL)
    const quote = String(item?.quote ?? '').replace(/\s+/g, ' ').trim()
    if (from === '' || to === '' || label === '' || quote === '') continue
    if (from === to) continue
    edges.push({
      from,
      to,
      label,
      quote,
      verified: item?.verified === true,
      chapterHref: S(item?.chapterHref, 400),
      chapterLabel: S(item?.chapterLabel, 80),
    })
  }
  const batches = []
  for (const item of asArray(raw.batches)) {
    const index = Number(item?.index)
    if (!Number.isInteger(index) || index < 0) continue
    const status = item?.status === 'done' || item?.status === 'failed' ? item.status : 'pending'
    batches.push({
      index,
      status,
      at: S(item?.at, 40),
      error: S(item?.error, 200),
      chapters: asArray(item?.chapters).map((one) => ({
        href: S(one?.href, 400),
        label: S(one?.label, 80),
      })).filter((one) => one.href !== ''),
    })
  }
  batches.sort((a, b) => a.index - b.index)
  return {
    version: RELATIONS_VERSION,
    bookHash: S(raw.bookHash, 64) || base.bookHash,
    bookTitle: S(raw.bookTitle, 120) || base.bookTitle,
    author: S(raw.author, 80) || base.author,
    updatedAt: S(raw.updatedAt, 40),
    verdict: raw.verdict && typeof raw.verdict === 'object'
      ? { fiction: raw.verdict.fiction === true, reason: S(raw.verdict.reason, 200) }
      : base.verdict,
    batches,
    persons: persons.slice(0, MAX_PERSONS),
    edges: edges.slice(0, MAX_EDGES),
    dropped: Number.isFinite(raw.dropped) ? raw.dropped : 0,
    truncated: raw.truncated === true,
  }
}

/**
 * 装箱：把章节按顺序切成若干批，每批累计正文字符不超过 maxChars。
 *
 * 一章自己就超过上限的（长篇小说的一章常见），单独成一批并把正文截断——
 * 宁可少抽一段，也不要把两章拼在一批里让模型分不清谁是谁。
 *
 * @param {Array<{ href: string, label: string, text: string }>} chapters
 * @param {{ maxChars?: number, maxBatches?: number }} [options]
 * @returns {{ batches: Array<{ index: number, chapters: any[] }>, truncated: boolean }}
 */
export function planBatches(chapters, options = {}) {
  const list = asArray(chapters).filter((item) => item && S(item.href, 400) !== '')
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : MAX_BATCH_CHARS
  const maxBatches = Number.isInteger(options.maxBatches) && options.maxBatches > 0 ? options.maxBatches : MAX_BATCHES

  const batches = []
  let current = []
  let size = 0
  for (const chapter of list) {
    const text = String(chapter.text ?? '')
    const cost = Math.max(1, text.length)
    if (current.length > 0 && size + cost > maxChars) {
      batches.push({ index: batches.length, chapters: current })
      current = []
      size = 0
      if (batches.length >= maxBatches) break
    }
    current.push({
      href: String(chapter.href),
      label: S(chapter.label, 80) || '第 ' + (current.length + 1) + ' 章',
      text: text.slice(0, maxChars),
    })
    size += cost
  }
  if (current.length > 0 && batches.length < maxBatches) {
    batches.push({ index: batches.length, chapters: current })
  }
  return { batches, truncated: batches.length >= maxBatches }
}

/**
 * 一批的抽取 prompt。
 *
 * knownPersons 是前几批已经抽到的人名——不传的话，第二批会把「贾宝玉」再抽一遍、
 * 并且和第一批的「宝玉」裂成两个节点，图画出来是两个人在演同一个角色。
 *
 * @param {{ bookTitle?: string, author?: string, chapters?: any[], knownPersons?: string[], readerLine?: string }} input
 * @returns {string}
 */
export function buildBatchPrompt(input) {
  const title = S(input?.bookTitle, 120) || '这本书'
  const author = S(input?.author, 80)
  const chapters = asArray(input?.chapters)
  const known = asArray(input?.knownPersons).map((item) => S(item, 40)).filter((item) => item !== '')

  const body = chapters
    .map((chapter) => '【' + (S(chapter?.label, 80) || '这一章') + '】\n' + String(chapter?.text ?? '').slice(0, MAX_BATCH_CHARS))
    .join('\n\n')

  const lines = [
    '你在整理一本小说里的人物关系，产出可以直接画成关系图的边。只处理下面这一段原文，不要编造没有出场的人。',
    '',
    '书名：《' + title + '》' + (author !== '' ? '　作者：' + author : ''),
    '',
    '原文：',
    '"""',
    body,
    '"""',
    '',
  ]
  if (known.length > 0) {
    lines.push('已经抽到的人物（同一人请沿用这些名字，不要另起一个）：' + known.join('、'), '')
  }
  lines.push(
    '输出**只有**一个 JSON 对象，不要任何解释、不要 markdown 代码块：',
    '{',
    '  "persons": [{"name": "人物名", "alias": ["别名或别人怎么称呼他"]}],',
    '  "edges": [{"from": "人物A", "to": "人物B", "label": "关系", "quote": "原文里能证明这层关系的句子"}]',
    '}',
    '',
    '硬性要求：',
    '1. quote 必须从上面原文里**逐字复制**，不许改写、不许拼接、不许翻译。找不到能证明的句子，就不要这条边。',
    '2. label 不超过 6 个字，只写关系本身（父子、师徒、情敌、主仆、同窗、夫妻），不要写剧情。',
    '3. 只写这一段里确实出现或被明确提到的关系，不要根据你对这本书的印象补全。',
    '4. edges 的 from / to 必须是 persons 里出现过的名字。没有关系可写就给空数组。',
  )
  const readerLine = S(input?.readerLine, 400)
  if (readerLine !== '') lines.push('5. ' + readerLine)
  return lines.join('\n')
}

/**
 * 解析一批的回答。
 *
 * 宽容的地方：缺 persons、缺 alias、大小写，都放过。
 * 不宽容的地方：缺 quote 的边直接丢——那正是这张图唯一可信的部分。
 *
 * @param {string} text
 * @returns {{ ok: boolean, persons?: any[], edges?: any[], error?: string }}
 */
export function parseBatchReply(text) {
  const parsed = extractJson(text)
  if (!parsed) {
    return { ok: false, error: '模型这次没按格式回答（不是 JSON），这一批没抽成，可以再试一次。' }
  }
  const persons = []
  const seen = new Set()
  for (const item of asArray(parsed.persons)) {
    const name = S(item?.name, 40)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    persons.push({
      name,
      alias: asArray(item?.alias).map((one) => S(one, 40)).filter((one) => one !== '' && one !== name),
    })
  }
  const edges = []
  for (const item of asArray(parsed.edges)) {
    const from = S(item?.from, 40)
    const to = S(item?.to, 40)
    const label = S(item?.label, MAX_LABEL)
    const quote = String(item?.quote ?? '').replace(/\s+/g, ' ').trim()
    if (from === '' || to === '' || label === '' || quote === '') continue
    if (from === to) continue
    edges.push({ from, to, label, quote })
  }
  return { ok: true, persons, edges }
}

/**
 * 回源核对：每条边的原句拿回这一批的正文里找，找不到的边丢掉。
 *
 * 这是 docs/26 §十二 那条对策的落地：**图错了比没有图更糟**，所以宁可掉一条真关系，
 * 也不留一条编出来的。核对沿用 distill.js 的 locateQuote（只做空白折叠，标点一律不动）。
 *
 * @param {Array<{ href: string, label: string, text: string }>} chapters 这一批的章节
 * @param {Array<object>} edges
 * @returns {{ edges: any[], dropped: number }}
 */
export function verifyEdges(chapters, edges) {
  const list = asArray(chapters)
  const kept = []
  let dropped = 0
  for (const edge of asArray(edges)) {
    let hit = null
    let at = -1
    for (const chapter of list) {
      const found = locateQuote(chapter?.text, edge?.quote)
      if (found) {
        hit = chapter
        at = found.offset
        break
      }
    }
    if (!hit) {
      dropped += 1
      continue
    }
    kept.push({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      quote: edge.quote,
      verified: true,
      chapterHref: String(hit.href ?? ''),
      chapterLabel: S(hit.label, 80),
      offset: at,
    })
  }
  return { edges: kept, dropped }
}

const edgeKey = (edge) => S(edge?.from, 40) + '|' + S(edge?.to, 40) + '|' + S(edge?.label, MAX_LABEL)

/**
 * 把一批的结果并进状态。
 *
 * 合并规则：
 *   · 人名按「名字或别名」认亲：新来的「宝玉」若已在某个节点的 alias 里，就并进那个节点；
 *   · 边按 from|to|label 去重（同一对人物可能在不同章反复出现，留第一条有原句的）；
 *   · 反向边不去重（「A 是 B 的父亲」和「B 是 A 的儿子」在图上是一条边，但这里不猜）。
 *
 * @param {object} state
 * @param {{ index: number, chapters?: any[], persons?: any[], edges?: any[], dropped?: number, error?: string }} batch
 * @returns {object} 新状态，不改入参
 */
export function mergeBatch(state, batch) {
  const base = normalizeState(state)
  const index = Number.isInteger(batch?.index) ? batch.index : -1
  const persons = base.persons.map((item) => ({ name: item.name, alias: item.alias.slice() }))
  const byName = new Map()
  const byAlias = new Map()
  const remember = (item, at) => {
    byName.set(item.name, at)
    for (const alias of item.alias) if (!byAlias.has(alias)) byAlias.set(alias, at)
  }
  persons.forEach((item, at) => remember(item, at))

  for (const incoming of asArray(batch?.persons)) {
    const name = S(incoming?.name, 40)
    if (name === '') continue
    const aliases = asArray(incoming?.alias).map((one) => S(one, 40)).filter((one) => one !== '' && one !== name)
    const at = byName.get(name) ?? byAlias.get(name)
    if (at !== undefined) {
      const existing = persons[at]
      for (const alias of aliases) {
        if (!existing.alias.includes(alias)) existing.alias.push(alias)
        if (!byAlias.has(alias)) byAlias.set(alias, at)
      }
      byName.set(name, at)
      continue
    }
    persons.push({ name, alias: aliases })
    remember(persons[persons.length - 1], persons.length - 1)
  }

  const edges = base.edges.map((item) => ({ ...item }))
  const seen = new Set(edges.map(edgeKey))
  let dropped = base.dropped + (Number.isFinite(batch?.dropped) ? batch.dropped : 0)
  for (const incoming of asArray(batch?.edges)) {
    const key = edgeKey(incoming)
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ ...incoming })
    if (edges.length >= MAX_EDGES) {
      dropped += 1
      break
    }
  }

  const batches = base.batches.map((item) => ({ ...item, chapters: item.chapters.slice() }))
  const known = batches.find((item) => item.index === index)
  const record = {
    index,
    status: S(batch?.error, 200) !== '' ? 'failed' : 'done',
    at: new Date().toISOString(),
    error: S(batch?.error, 200),
    chapters: asArray(batch?.chapters).map((item) => ({ href: S(item?.href, 400), label: S(item?.label, 80) })),
  }
  if (known) Object.assign(known, record)
  else batches.push(record)
  batches.sort((a, b) => a.index - b.index)

  return {
    ...base,
    version: RELATIONS_VERSION,
    updatedAt: record.at,
    batches,
    persons: persons.slice(0, MAX_PERSONS),
    edges: edges.slice(0, MAX_EDGES),
    dropped,
  }
}

/**
 * 把批次清单落进状态（还没跑的状态）。两次点击之间状态要一致，
 * 所以批次表由 planBatches 定，不由「跑了哪些」反推。
 */
export function reindexBatches(state, planned) {
  const base = normalizeState(state)
  const batches = asArray(planned).map((item) => {
    const known = base.batches.find((one) => one.index === item.index)
    return {
      index: item.index,
      status: known ? known.status : 'pending',
      at: known ? known.at : '',
      error: known ? known.error : '',
      chapters: asArray(item.chapters).map((one) => ({ href: S(one?.href, 400), label: S(one?.label, 80) })),
    }
  })
  return { ...base, batches }
}

/** 下一次该跑哪一批；全跑完（或全失败）返回 null。 */
export function nextBatch(state) {
  const base = normalizeState(state)
  return base.batches.find((item) => item.status !== 'done' && item.status !== 'failed') ?? null
}

/** 进度，给界面说「第 3 / 8 批」。 */
export function progressOf(state) {
  const base = normalizeState(state)
  const done = base.batches.filter((item) => item.status === 'done').length
  const failed = base.batches.filter((item) => item.status === 'failed').length
  return {
    done,
    failed,
    total: base.batches.length,
    persons: base.persons.length,
    edges: base.edges.length,
    dropped: base.dropped,
    finished: base.batches.length > 0 && done + failed >= base.batches.length,
  }
}

/** Mermaid 里要转义的字符：引号会截断 label，反斜杠会吃掉后面的字。 */
const mermaidSafe = (value) => String(value ?? '').replace(/["\\]/g, '').replace(/\s+/g, ' ').trim()

/**
 * 出 Mermaid 关系图。
 *
 * 用 graph LR（从左到右），长篇小说的人物表横着排比竖着排好看得多。
 * 节点 id 用 p0/p1…，中文名只出现在显示文本里——Mermaid 的 id 里出现空格会解析失败。
 *
 * @param {object} state
 * @returns {string} 没有边时返回空串
 */
export function toMermaid(state) {
  const base = normalizeState(state)
  if (base.edges.length === 0) return ''
  const nodes = new Map()
  const idOf = (name) => {
    const key = S(name, 40)
    if (nodes.has(key)) return nodes.get(key)
    const id = 'p' + nodes.size
    nodes.set(key, id)
    return id
  }
  for (const edge of base.edges) {
    idOf(edge.from)
    idOf(edge.to)
  }
  const lines = ['graph LR']
  for (const [name, id] of nodes) lines.push('  ' + id + '["' + mermaidSafe(name) + '"]')
  for (const edge of base.edges) {
    lines.push('  ' + idOf(edge.from) + ' -- "' + mermaidSafe(edge.label) + '" --> ' + idOf(edge.to))
  }
  return lines.join('\n')
}

/**
 * 整份 Markdown（02 人物关系.md 的正文，不含标题，标题由 notesync 加）。
 *
 * 图在上面、依据在下面：用户先看图对不对，觉得不对再往下逐条看原句。
 *
 * @param {object} state
 * @returns {string}
 */
export function toInner(state) {
  const base = normalizeState(state)
  if (base.edges.length === 0) {
    const progress = progressOf(base)
    if (progress.total === 0) {
      return '> 还没有开始抽。点一次「生成」，一批一批来；每批都能回源，核不上的关系会被丢掉。'
    }
    if (!progress.finished) {
      return '> 已抽 ' + progress.done + ' / ' + progress.total + ' 批，还没出现可用的关系。继续点「生成」跑下一批。'
    }
    return '> 这些章节里没有找到能在原文中核对的关系。'
  }

  const lines = []
  const progress = progressOf(base)
  lines.push(
    '> ' + base.persons.length + ' 个人、' + base.edges.length + ' 条关系，每条都回源核对过。'
      + (base.dropped > 0 ? '另有 ' + base.dropped + ' 条因为原句核不上被丢掉了。' : '')
      + (progress.finished ? '' : '（已跑 ' + progress.done + ' / ' + progress.total + ' 批）'),
    '',
  )
  lines.push('## 关系图', '')
  lines.push('```mermaid', toMermaid(base), '```', '')
  lines.push('## 每条关系的依据', '')
  for (const edge of base.edges) {
    const where = edge.chapterLabel !== '' ? '（' + edge.chapterLabel + '）' : ''
    lines.push('- **' + edge.from + ' — ' + edge.label + ' → ' + edge.to + '**' + where)
    lines.push('  > ' + edge.quote)
  }
  const aliases = base.persons.filter((item) => item.alias.length > 0)
  if (aliases.length > 0) {
    lines.push('', '## 同一人的别的叫法', '')
    for (const person of aliases) lines.push('- **' + person.name + '**：' + person.alias.join('、'))
  }
  return lines.join('\n')
}
