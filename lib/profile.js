/**
 * profile.js —— 读者画像：从这本书的「问 AI」记录里读出这位读者怎么读。
 *
 * 为什么要有它（docs/26 §六）：同一本书，有人想知道术语的来路，有人想知道能不能照做。
 * 笔记若按统一口径写，一半人觉得太浅、另一半觉得太绕。画像就是那一句「这次写给谁」。
 *
 * 三条硬约束：
 *
 *   1. **只进结论，不进原文**。一本书问过 30 个问题、每条 400 字，塞进 prompt 就是
 *      一万多字噪声，模型还会去复述问题而不是写笔记。这里输出的是一两百字的判断。
 *   2. **零 AI 也能算**。modes / chapters / focus 全是频次统计 + 停用词表，
 *      不调模型、不联网、不花钱；所以它在任何机器上都立刻可得，不会因为模型挂了就消失。
 *   3. **数字必须是真的**。界面那句话里的每个数都从这里的统计里取，不编、不估。
 *
 * 纯函数，不碰 IO：读 qa.jsonl、写 reader-profile.json 都在 store.js。
 */

/** reader-profile.json 的结构版本。改形状时加一，旧文件按 version 走兼容分支。 */
export const PROFILE_VERSION = 1

/** 算 focus 时看多少条最近的问答。画像会自我强化，所以新出现的词要能从这一窗口顶上来。 */
export const RECENT_QA = 30

/** focus 最多留几个词。再多就成词云，模型读不出重点。 */
export const MAX_FOCUS = 8

/** 一条词要出现在多少个不同的问题里才算数。同一句里重复十次也只算一次。 */
const MIN_DF = 2

/** 少于两条问答时不算 focus：一条问题里的字几乎全是它自己，算出来的「主题」没有意义。 */
const MIN_QUESTIONS = 2

/**
 * 停用词。中文没有空格，抽词只能靠「2–4 字子串 + 跨问题去重」，
 * 所以停用词表必须够脏才挡得住「这个」「什么」这类高频虚词。
 */
const STOPWORDS = new Set([
  '这个', '那个', '这些', '那些', '这样', '那样', '这种', '那种',
  '什么', '怎么', '怎样', '为何', '如何', '哪些', '哪个', '多少',
  '我们', '你们', '他们', '她们', '它们', '自己', '别人', '大家',
  '一个', '一种', '一些', '一下', '一直', '一样', '一遍',
  '可以', '可能', '应该', '需要', '必须', '能够', '不能', '不是', '就是',
  '因为', '所以', '但是', '可是', '如果', '虽然', '然后', '而且', '或者',
  '还是', '已经', '曾经', '正在', '现在', '以后', '之前', '之后', '当时',
  '这里', '那里', '哪里', '上面', '下面', '里面', '外面', '中间',
  '时候', '东西', '事情', '问题', '意思', '地方', '方面', '情况',
  '本书', '全书', '作者', '读者', '这段', '这句', '这段话',
  '有没有', '是不是', '能不能', '要不要', '对不对', '为什么',
])

/**
 * 虚字表：一个候选词只要**以虚字开头或结尾**就丢掉。
 *
 * 中文没有空格，抽词只能切子串，切出来的东西必然跨词边界（「主题阅读的方法」切出
 * 「题阅读的」）。判断「这一段是不是一个词」需要词典，这里不做那件事，只用一条
 * 便宜且够用的规则：真正的主题词很少以「的、是、什、么」这类字开头或结尾。
 */
const EDGE_CHARS = new Set([
  ...'的了是在和与吗呢吧把被就都也很太更最不有这那什么怎样为何如能要会说我你他们个',
  ...'上下中里外前后时把从对给让向再又还只更',
])

/** 只要一个词里含这些片段就当噪声丢掉：它们一定来自疑问句的骨架，不是主题。 */
const NOISE_PARTS = [
  '什么', '怎么', '为什', '为何', '如何', '哪些', '哪一', '多少',
  '我们', '你们', '他们', '自己', '一个', '一种', '一些',
  '这个', '那个', '这样', '那样', '这种', '那种',
  '可以', '不是', '就是', '还是', '已经', '没有', '是不',
  '时候', '东西', '事情', '意思', '地方', '方面',
]

/** 每个问法的「他在问哪一面」。界面那句话与注入 prompt 的那段都用它。 */
const MODE_ASPECT = {
  general: '直接要答案',
  classic: '句子的位置与写法',
  paper: '论证靠不靠得住',
  concept: '术语',
  foreign: '原文',
}

/** 每个问法对应「笔记该怎么写」。画像最终落成这一句，界面与 prompt 共用。 */
const MODE_NOTE = {
  general: '按通用的读法写',
  classic: '先讲这一句在整本书里的位置',
  paper: '分清作者说的和你推的',
  concept: '给出处，少用形容',
  foreign: '保留原文，再给一种译法',
}

/** 各问法的中文名。与 askpresets.js 保持同一份文案，那边改了这里跟着改。 */
const MODE_LABEL = {
  general: '一般问答',
  classic: '名著精读',
  paper: '论文分析',
  concept: '概念溯源',
  foreign: '外文原著',
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** 老记录可能没有 mode 键。空 mode 按 general 算 —— 那时本来就只有一种问法。 */
function normalizeMode(raw) {
  const id = text(raw)
  return Object.prototype.hasOwnProperty.call(MODE_LABEL, id) ? id : 'general'
}

/** 抽一段中文里的所有 2–4 字子串。标点、数字、西文一律不管。 */
function gramsOf(source) {
  const out = new Set()
  const runs = text(source).match(/[\u4e00-\u9fa5]+/g)
  if (!runs) return out
  for (const run of runs) {
    if (run.length < 2) continue
    const longest = Math.min(4, run.length)
    for (let size = 2; size <= longest; size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) out.add(run.slice(i, i + size))
    }
  }
  return out
}

function isNoise(term) {
  if (STOPWORDS.has(term)) return true
  for (const part of NOISE_PARTS) if (term.includes(part)) return true
  return false
}

/**
 * 一个窗口里排得出序的词。
 *
 * 排序：先按出现在多少个不同的问题里（df），再按词长（长的更具体），最后按字典序
 * 保证同一份输入永远得到同一个结果 —— 画像要能对得上历史，不能每次算出来不一样。
 */
function rankTerms(list) {
  const df = new Map()
  for (const question of list) {
    for (const gram of gramsOf(question)) df.set(gram, (df.get(gram) || 0) + 1)
  }
  const candidates = []
  for (const [term, count] of df) {
    if (count < MIN_DF) continue
    if (isNoise(term)) continue
    if (EDGE_CHARS.has(term[0]) || EDGE_CHARS.has(term[term.length - 1])) continue
    candidates.push({ term, df: count })
  }
  candidates.sort((a, b) => b.df - a.df || b.term.length - a.term.length || a.term.localeCompare(b.term))
  const kept = []
  for (const item of candidates) {
    // 被更长的同类词盖住就丢掉：留下「检视阅读」比留下「检视」有用。
    if (kept.some((bigger) => bigger.term.includes(item.term) && bigger.df >= item.df)) continue
    kept.push(item)
    if (kept.length >= MAX_FOCUS) break
  }
  return kept.map((item) => item.term)
}

/**
 * 主题词：最近一窗 + 全部，两套取并集，最近的排前面。
 *
 * 只用「全部」会让老主题永远压着新主题（画像自我强化的第一条坑），
 * 只用「最近」会让问了三十条的老读者突然失忆。并集是这两头之间最省事的解。
 *
 * @param {string[]} questions
 * @returns {string[]}
 */
export function focusTerms(questions) {
  const list = Array.isArray(questions) ? questions.filter((item) => text(item) !== '') : []
  if (list.length < MIN_QUESTIONS) return []
  const recent = rankTerms(list.slice(-RECENT_QA))
  const all = rankTerms(list)
  const out = []
  for (const term of recent) if (!out.includes(term)) out.push(term)
  for (const term of all) {
    if (out.length >= MAX_FOCUS) break
    if (!out.includes(term)) out.push(term)
  }
  return out.slice(0, MAX_FOCUS)
}

/**
 * 从一本书的问答记录算出画像。零条问答返回 null —— 界面据此说「还没问过」，
 * 而不是显示「问过 0 个问题」。
 *
 * @param {{ bookHash?: string, qa?: Array<object>, now?: string }} input
 */
export function buildProfile(input) {
  const records = (Array.isArray(input?.qa) ? input.qa : []).filter((item) => item && typeof item === 'object')
  if (records.length === 0) return null

  const bookHash = text(input?.bookHash)
  const now = text(input?.now) || new Date().toISOString()

  const modes = {}
  const chapterMap = new Map()
  const questions = []

  for (const record of records) {
    const question = text(record.question)
    if (question !== '') questions.push(question)

    const mode = normalizeMode(record.mode)
    modes[mode] = (modes[mode] || 0) + 1

    const href = text(record.chapterHref)
    const label = text(record.chapterLabel)
    if (href !== '' || label !== '') {
      const key = href !== '' ? href : label
      const current = chapterMap.get(key) ?? { href, label: label !== '' ? label : href, count: 0 }
      current.count += 1
      if (current.label === current.href && label !== '') current.label = label
      chapterMap.set(key, current)
    }
  }

  const chapters = [...chapterMap.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5)

  const focus = focusTerms(questions)
  const entries = Object.entries(modes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const top = entries[0] ?? null

  const habits = []
  if (top && top[1] >= 2 && top[1] * 2 >= records.length) {
    habits.push('多半在问' + (MODE_ASPECT[top[0]] ?? '内容'))
  }
  if (chapters.length > 0 && chapters[0].count >= 3 && chapters[0].count * 2 >= records.length) {
    habits.push('常在同一章里连着追问')
  }
  if (Object.keys(modes).length >= 3) habits.push('换着角度看同一本书')

  return {
    version: PROFILE_VERSION,
    bookHash,
    updatedAt: now,
    askedCount: records.length,
    modes,
    chapters,
    focus,
    habits: habits.slice(0, 3),
    note: MODE_NOTE[top?.[0]] ?? MODE_NOTE.general,
  }
}

/** 问得最多的那一章（没有章节信息时返回 null）。 */
function topChapter(profile) {
  const chapters = Array.isArray(profile?.chapters) ? profile.chapters : []
  const first = chapters[0]
  if (!first || !Number.isInteger(first.count) || first.count <= 0) return null
  return { href: text(first.href), label: text(first.label) || text(first.href), count: first.count }
}

/** 用得最多的那种问法（没有记录时返回 null）。 */
function topMode(profile) {
  const modes = profile?.modes && typeof profile.modes === 'object' ? profile.modes : {}
  const entries = Object.entries(modes).filter(([, count]) => Number.isInteger(count) && count > 0)
  if (entries.length === 0) return null
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const [id, count] = entries[0]
  return { id, count, label: MODE_LABEL[id] ?? MODE_LABEL.general }
}

/**
 * 界面那句话。两行：第一行是「问过多少、集中在哪」，第二行是「所以在问什么、笔记怎么写」。
 *
 * 刻意不解释「什么是画像」——用户不需要知道有这么一个东西，只需要知道它据此怎么写。
 * 没问过就返回 null，界面说「还没问过」，不显示「0 个问题」。
 *
 * @returns {{ head: string, tail: string } | null}
 */
export function profileSentence(profile) {
  const asked = Number.isInteger(profile?.askedCount) ? profile.askedCount : 0
  if (asked <= 0) return null

  const chapter = topChapter(profile)
  let head = '这本书你问过 ' + asked + ' 个问题'
  if (chapter && chapter.count >= 2) head += '，' + chapter.count + ' 个集中在' + chapter.label
  head += '。'

  const mode = topMode(profile)
  const parts = []
  if (mode && mode.count >= 2) {
    parts.push('多半在问' + (MODE_ASPECT[mode.id] ?? '内容') + '（' + mode.count + ' 次「' + mode.label + '」）。')
  }
  parts.push('笔记会' + (MODE_NOTE[mode?.id] ?? MODE_NOTE.general) + '。')

  return { head, tail: parts.join('') }
}

/**
 * 注入蒸馏 prompt 的那一段。
 *
 * 只加一段、只影响侧重与详略，不改上面任何一条硬性要求 —— 这是 docs/26 §6.3 的规矩：
 * persona 管「你是谁」，画像管「这次写给谁」。没有画像时返回空串，调用方据此整段不写。
 */
export function profilePromptLine(profile) {
  const asked = Number.isInteger(profile?.askedCount) ? profile.askedCount : 0
  if (asked <= 0) return ''

  const chapter = topChapter(profile)
  const bits = ['这位读者在这本书里问过 ' + asked + ' 个问题']
  if (chapter && chapter.count >= 2) bits.push(chapter.count + ' 个集中在「' + chapter.label + '」')
  let line = bits.join('，') + '。'

  const mode = topMode(profile)
  if (mode && mode.count >= 2) {
    line += '他多半在问' + (MODE_ASPECT[mode.id] ?? '内容') + '（' + mode.count + ' 次用「' + mode.label + '」）。'
  }

  const focus = Array.isArray(profile?.focus) ? profile.focus.filter((item) => text(item) !== '') : []
  if (focus.length > 0) line += '反复出现的词：' + focus.slice(0, 6).join('、') + '。'

  line += '写给他时' + (MODE_NOTE[mode?.id] ?? MODE_NOTE.general) + '。'
  return line
}
