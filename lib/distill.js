/**
 * distill.js —— 把一本书蒸馏成「可回源、可执行」的卡片集。
 *
 * 参照 dsh-distillation-director（蒸馏主管）的三条判态原则，但只取能装进阅读器的部分：
 *
 *   1. **忠实度**：引文必须能在正文里找得到。模型给的金句一律拿回章节纯文本里核对，
 *      找不到就标 `verified: false`，界面红字显示「未回源」。不核对就等于让模型编话。
 *   2. **可执行**：方法必须写成三件套（做什么 / 什么时候用 / 完成判据）。缺一件的条目
 *      在解析阶段被丢掉，宁可少一条，也不要一句正确的废话。
 *   3. **只判态不打分**：一章要么蒸完（done）、要么失败（failed），没有 87 分这种分数。
 *
 * 不做的事：不生成 Agent 技能包、不跑门禁脚本、不做多阶段盲测——那些是工作区级工程，
 * 不属于一个阅读器。这里只产出「这本书讲了什么、能直接拿来做什么」。
 */

/** distill.json 的结构版本。改形状时加一，旧文件按 version 走兼容分支。 */
export const DISTILL_VERSION = 1

/** 单章送进 prompt 的正文上限。一本三万字的长章不能整章塞进去：太贵也会挤爆上下文。 */
export const MAX_CHAPTER_CHARS = 12000

/** 一章最多留多少条，防止模型一开口就给 40 条把界面撑爆。 */
export const MAX_POINTS = 8
export const MAX_TERMS = 10
export const MAX_METHODS = 6
export const MAX_QUOTES = 6

const S = (value, max) => {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 每章一次的提取 prompt。要 JSON，因为下游要按字段做回源核对。 */
export function buildChapterPrompt(input) {
  const title = S(input?.bookTitle, 120) || '这本书'
  const author = S(input?.author, 80)
  const label = S(input?.chapterLabel, 80) || '这一章'
  const index = Number.isFinite(input?.chapterIndex) ? input.chapterIndex + 1 : 1
  const total = Number.isFinite(input?.chapterTotal) ? input.chapterTotal : 0
  const text = String(input?.chapterText ?? '').slice(0, MAX_CHAPTER_CHARS)

  return [
    '你在做「把一本书蒸馏成可执行卡片」的提取工作。只处理下面这一章，不要总结全书。',
    '',
    `书名：${title}${author === '' ? '' : `（${author}）`}`,
    `章节：${label}${total > 0 ? `（第 ${index} / ${total} 章）` : ''}`,
    '',
    '章节原文：',
    '"""',
    text,
    '"""',
    '',
    '输出**只有**一个 JSON 对象，不要任何解释、不要 markdown 代码块。字段如下：',
    '{',
    '  "thesis": "这一章的核心主张，一句话，不超过 60 字",',
    '  "points": [{"claim": "一个论点，不超过 80 字", "quote": "支撑它的原文片段，逐字照抄"}],',
    '  "terms": [{"term": "概念名", "meaning": "作者给它的定义，不超过 60 字"}],',
    '  "methods": [{"name": "方法名", "when": "什么时候用它", "steps": ["第一步", "第二步"], "check": "怎么算做完"}],',
    '  "quotes": [{"text": "值得记住的原句，逐字照抄，不超过 120 字"}]',
    '}',
    '',
    '硬性要求：',
    '1. quote / text 必须从上面原文里**逐字复制**，不许改写、不许拼接、不许翻译。找不到合适的就少写几条。',
    '2. methods 只在原文确实给了做法时才有；每条 method 的 when / check 不能空，steps 至少两步。',
    '3. points 2–6 条，terms 0–6 条，methods 0–4 条，quotes 0–4 条。没有就给空数组。',
    '4. 不要评价这本书好不好，只提取。',
  ].join('\n')
}

/** 全书骨架 prompt：拿各章论点合成，不再读原文（省额度）。 */
export function buildSkeletonPrompt(input) {
  const title = S(input?.bookTitle, 120) || '这本书'
  const author = S(input?.author, 80)
  const lines = Array.isArray(input?.chapters) ? input.chapters : []
  const body = lines
    .map((item, i) => `${i + 1}. ${S(item?.label, 60)}：${S(item?.thesis, 120) || '（这章还没蒸）'}`)
    .join('\n')

  return [
    '下面是一本书各章的核心主张，请合成为全书骨架。',
    '',
    `书名：${title}${author === '' ? '' : `（${author}）`}`,
    '',
    body,
    '',
    '输出**只有**一个 JSON 对象，不要解释：',
    '{',
    '  "oneLine": "一句话说清这本书在讲什么，不超过 40 字",',
    '  "thesis": "全书的核心主张，不超过 120 字",',
    '  "structure": "全书怎么展开的（分几部分、每部分做什么），不超过 200 字",',
    '  "audience": "这本书适合谁读、读到什么程度，不超过 80 字"',
    '}',
  ].join('\n')
}

/** 从模型回复里抠出 JSON。模型经常带 ```json 围栏或前后废话。 */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const raw = text.trim()
  if (raw === '') return null
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const candidates = [unfenced]
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // 继续试下一个候选
    }
  }
  return null
}

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * 解析一章的回复。缺字段的条目直接丢掉——一条 method 没有 check，就是一句空话，
 * 留在界面上只会让人以为蒸馏成功了。
 */
export function parseChapterReply(text) {
  const parsed = extractJson(text)
  if (!parsed) {
    return { ok: false, error: '模型这次没按格式回答（不是 JSON），这一章没蒸成，可以再试一次。' }
  }

  const points = asArray(parsed.points)
    .map((item) => ({ claim: S(item?.claim, 200), quote: S(item?.quote, 300) }))
    .filter((item) => item.claim !== '')
    .slice(0, MAX_POINTS)

  const terms = asArray(parsed.terms)
    .map((item) => ({ term: S(item?.term, 60), meaning: S(item?.meaning, 200) }))
    .filter((item) => item.term !== '' && item.meaning !== '')
    .slice(0, MAX_TERMS)

  const methods = asArray(parsed.methods)
    .map((item) => ({
      name: S(item?.name, 80),
      when: S(item?.when, 120),
      steps: asArray(item?.steps).map((step) => S(step, 160)).filter((step) => step !== '').slice(0, 8),
      check: S(item?.check, 120),
    }))
    .filter((item) => item.name !== '' && item.when !== '' && item.check !== '' && item.steps.length >= 2)
    .slice(0, MAX_METHODS)

  const quotes = asArray(parsed.quotes)
    .map((item) => ({ text: S(item?.text, 300) }))
    .filter((item) => item.text !== '')
    .slice(0, MAX_QUOTES)

  return {
    ok: true,
    thesis: S(parsed.thesis, 200),
    points,
    terms,
    methods,
    quotes,
  }
}

export function parseSkeletonReply(text) {
  const parsed = extractJson(text)
  if (!parsed) {
    return { ok: false, error: '模型这次没按格式回答（不是 JSON），骨架没生成，可以再试一次。' }
  }
  return {
    ok: true,
    oneLine: S(parsed.oneLine, 80),
    thesis: S(parsed.thesis, 300),
    structure: S(parsed.structure, 400),
    audience: S(parsed.audience, 160),
  }
}

/**
 * 回源核对：把引文拿回章节纯文本里找。
 *
 * 归一化只做「空白折叠」——引文里的标点、字形一律不动，因为模型最容易犯的错
 * 就是「改一个标点」或「换一个同义词」，那正是要抓的东西。
 */
export function locateQuote(chapterText, quote) {
  const text = String(chapterText ?? '')
  const needle = String(quote ?? '').replace(/\s+/g, ' ').trim()
  if (text === '' || needle.length < 4) return null
  const normalizedHaystack = text.replace(/\s+/g, ' ')
  const at = normalizedHaystack.indexOf(needle)
  if (at < 0) return null
  return {
    percent: normalizedHaystack.length > 0 ? at / normalizedHaystack.length : 0,
    offset: at,
  }
}

/** 给一章的所有引文打上回源结果。返回新对象，不改入参。 */
export function verifyChapterQuotes(chapterText, record) {
  const withHit = (item) => {
    const hit = locateQuote(chapterText, item.quote ?? item.text)
    return hit === null
      ? { ...item, verified: false, percent: 0 }
      : { ...item, verified: true, percent: hit.percent }
  }
  return {
    ...record,
    points: asArray(record.points).map(withHit),
    quotes: asArray(record.quotes).map(withHit),
  }
}

export function emptyState(meta = {}) {
  return {
    version: DISTILL_VERSION,
    bookHash: typeof meta.bookHash === 'string' ? meta.bookHash : '',
    bookTitle: S(meta.title ?? meta.bookTitle, 120),
    author: S(meta.author, 80),
    updatedAt: '',
    skeleton: null,
    chapters: [],
  }
}

/** 把一章的结果并进 state：同一 href 覆盖，其余保持章节顺序（按 spine 顺序传入）。 */
export function mergeChapter(state, record, spineHrefs = null) {
  const base = state && typeof state === 'object' ? state : emptyState()
  const chapters = asArray(base.chapters).filter((item) => item?.href !== record?.href)
  chapters.push(record)
  const order = Array.isArray(spineHrefs) && spineHrefs.length > 0
    ? spineHrefs
    : chapters.map((item) => item?.href)
  const rank = new Map(order.map((href, i) => [href, i]))
  chapters.sort((a, b) => (rank.get(a?.href) ?? 9999) - (rank.get(b?.href) ?? 9999))
  return {
    ...base,
    version: DISTILL_VERSION,
    chapters,
    updatedAt: new Date().toISOString(),
  }
}

export function progressOf(state) {
  const chapters = asArray(state?.chapters)
  const done = chapters.filter((item) => item?.status === 'done').length
  const failed = chapters.filter((item) => item?.status === 'failed').length
  return { done, failed, total: chapters.length }
}

/** 导出 Markdown：给人看的东西，必须自己站得住，贴到别处也读得通。 */
export function toMarkdown(state) {
  const base = state && typeof state === 'object' ? state : emptyState()
  const lines = []
  const title = S(base.bookTitle, 120) || '未命名书籍'
  lines.push(`# 《${title}》蒸馏笔记`, '')
  if (S(base.author, 80) !== '') lines.push(`作者：${base.author}`, '')
  const skeleton = base.skeleton
  if (skeleton) {
    if (S(skeleton.oneLine, 80) !== '') lines.push(`> ${skeleton.oneLine}`, '')
    if (S(skeleton.thesis, 300) !== '') lines.push('**全书主张**：' + skeleton.thesis, '')
    if (S(skeleton.structure, 400) !== '') lines.push('**怎么展开的**：' + skeleton.structure, '')
    if (S(skeleton.audience, 160) !== '') lines.push('**适合谁读**：' + skeleton.audience, '')
    lines.push('')
  }

  const methods = asArray(base.chapters).flatMap((chapter) =>
    asArray(chapter.methods).map((method) => ({ ...method, chapterLabel: chapter.label })),
  )
  if (methods.length > 0) {
    lines.push('## 可以直接照着做的', '')
    for (const method of methods) {
      lines.push(`### ${method.name}`)
      if (S(method.when, 120) !== '') lines.push(`- 什么时候用：${method.when}`)
      if (asArray(method.steps).length > 0) {
        lines.push('- 步骤：')
        for (const step of method.steps) lines.push(`  ${step}`)
      }
      if (S(method.check, 120) !== '') lines.push(`- 完成判据：${method.check}`)
      if (S(method.chapterLabel, 80) !== '') lines.push(`- 出自：${method.chapterLabel}`)
      lines.push('')
    }
  }

  lines.push('## 逐章', '')
  for (const chapter of asArray(base.chapters)) {
    const label = S(chapter.label, 80) || '未命名章节'
    lines.push(`### ${label}`)
    if (chapter.status !== 'done') {
      lines.push('', '（这一章没蒸成）', '')
      continue
    }
    if (S(chapter.thesis, 200) !== '') lines.push('', `**主张**：${chapter.thesis}`)
    for (const point of asArray(chapter.points)) {
      lines.push('', `- ${point.claim}`)
      if (S(point.quote, 300) !== '') {
        lines.push(`  > ${point.quote}${point.verified ? '' : '（未在原文找到，可能被改写）'}`)
      }
    }
    if (asArray(chapter.terms).length > 0) {
      lines.push('', '概念：')
      for (const term of chapter.terms) lines.push(`- **${term.term}**：${term.meaning}`)
    }
    if (asArray(chapter.quotes).length > 0) {
      lines.push('', '金句：')
      for (const quote of chapter.quotes) {
        lines.push(`> ${quote.text}${quote.verified ? '' : '（未在原文找到）'}`)
      }
    }
    lines.push('')
  }

  const unverified = asArray(base.chapters).reduce(
    (sum, chapter) =>
      sum +
      asArray(chapter.points).filter((item) => item.verified === false).length +
      asArray(chapter.quotes).filter((item) => item.verified === false).length,
    0,
  )
  if (unverified > 0) {
    lines.push(`> 有 ${unverified} 条引文没能在原文里找到（已标注），引用前请回书里核对。`, '')
  }
  return lines.join('\n')
}
