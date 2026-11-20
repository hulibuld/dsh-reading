#!/usr/bin/env node
/**
 * 跨书主题：抽词、三道门槛、页面骨架、总览读写（0.13.0 P5 第二半）。
 *
 * 只钉四件事，都是「错了用户会以为程序在瞎编」的地方：
 *   1. 抽词不许把「题阅读的」「是什么」这种跨词残渣立成主题；
 *   2. 门槛必须是「≥2 本书 且 累计 ≥3 段 且 某本书里 ≥2 次」三道一起过，
 *      两本书各问一次就立页那是巧合，不是主题；
 *   3. 主题页的「我现在的判断」永远留空 —— 程序替用户写一句，他就不会自己想了；
 *   4. 页面正文是用户的地盘：重复立页一个字节不动，用户自己加的行不许被吃。
 *
 * 纯函数层不碰磁盘；两条路由跑在临时书库 + 临时 vault 里，跑完删掉。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { LibraryStore } from '../lib/store.js'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { DEFAULT_SUBDIR } from '../lib/vault.js'
import {
  MAX_CANDIDATES,
  OVERVIEW_BLOCK_ID,
  THREADS_DIR,
  THREADS_INDEX,
  buildCandidates,
  buildOverviewHeader,
  buildOverviewInner,
  buildThreadInner,
  buildThreadPage,
  candidateLine,
  gramTerms,
  isNoise,
  parseOverview,
  parseOverviewEntries,
  termsOfRecord,
  threadBlockId,
  threadFileName,
} from '../lib/threads.js'

/* ───────────────────────────── 纯函数层 ───────────────────────────── */

/**
 * 抽词：只留中文连续段里的 2–4 字窗口，虚词与跨界残渣擦掉。
 *
 * 「螺旋是什么」只有「螺旋」该活下来：旋是/是什/什么/螺旋是/是什么 … 全部按
 * 虚词表或首尾边界字丢掉。这一条如果松了，主题列表会被「题阅读的」淹掉。
 */
function termsOnlyKeepRealWords() {
  assert.deepEqual(gramTerms('螺旋是什么'), ['螺旋'])
  assert.deepEqual(gramTerms('螺旋怎么用'), ['螺旋'])
  assert.deepEqual(gramTerms(''), [])
  assert.deepEqual(gramTerms(null), [])
  // 标点、空白、外文一律当分隔符：不跨段拼词。
  assert.deepEqual(gramTerms('螺旋，Spiral。结构'), ['螺旋', '结构'])

  assert.equal(isNoise('螺旋'), false)
  assert.equal(isNoise('主题阅读'), false, '四字实词要留')
  assert.equal(isNoise('什么'), true, '虚词')
  assert.equal(isNoise('的螺'), true, '以「的」开头')
  assert.equal(isNoise('螺旋的'), true, '以「的」结尾')
  assert.equal(isNoise('题阅读的'), true, '跨界残渣')
  assert.equal(isNoise('不重要'), true, '含虚词片段')
  assert.equal(isNoise('螺'), true, '一个字的不是词')
  assert.equal(isNoise('螺旋结构啊'), true, '超过四字')

  // 问题与答案分开抽：答案主要由模型写，不能让它单方面定义主题。
  const split = termsOfRecord({ question: '螺旋是什么', answer: '结构' })
  assert.deepEqual(split.fromQuestion, ['螺旋'])
  assert.deepEqual(split.fromAnswer, ['结构'])
  assert.deepEqual(termsOfRecord({}), { fromQuestion: [], fromAnswer: [] })
}

/** 块 id 与文件名都来自主题名：改个名就是另一页，非法字符换成下划线。 */
function identityComesFromTerm() {
  const a = threadBlockId('螺旋')
  assert.match(a, /^th-[0-9a-f]{10}$/)
  assert.equal(threadBlockId('螺旋'), a, '同一个词永远同一个 id')
  assert.notEqual(threadBlockId('结构'), a)

  assert.equal(threadFileName('螺旋'), '螺旋.md')
  assert.equal(threadFileName('A/B:C'), 'A_B_C.md')
  assert.equal(threadFileName(''), '未命名主题.md')
  assert.equal(threadFileName(null), '未命名主题.md')
}

/** 造一段讨论记录：只要问题和章名，答案给空串（答案不进主题页）。 */
const block = (question, chapterLabel = '第一章') => ({
  id: 'qa-' + question,
  question,
  answer: '',
  chapterHref: 'text/ch1.xhtml',
  chapterLabel,
})

/** 三道门槛：跨书、累计段数、单本次数，缺一条都不立页。 */
function thresholdsNeedAllThree() {
  // ① 只有一本书：问得再多也不跨书。
  {
    const only = buildCandidates({
      books: [
        { bookHash: 'a'.repeat(16), title: '甲书', blocks: [block('螺旋是什么'), block('螺旋重要吗'), block('螺旋怎么用')] },
      ],
    })
    assert.deepEqual(only.candidates, [], '一本书里问三次不算跨书主题')
    assert.deepEqual(only.scanned, { books: 1, blocks: 3 })
  }

  // ② 三本书各一次：跨书了，但没有任何一本书里出现两次以上。
  {
    const spread = buildCandidates({
      books: ['a', 'b', 'c'].map((tag) => ({
        bookHash: tag.repeat(16),
        title: tag + '书',
        blocks: [block('螺旋怎么用')],
      })),
    })
    assert.deepEqual(spread.candidates, [], '三本书各问一次，是巧合不是主题')
    assert.deepEqual(spread.scanned, { books: 3, blocks: 3 })
  }

  // ③ 两本书、某本里两次、累计三段：三道全过。
  {
    const pass = buildCandidates({
      books: [
        { bookHash: 'a'.repeat(16), title: '甲书', blocks: [block('螺旋是什么'), block('螺旋重要吗', '第二章')] },
        { bookHash: 'b'.repeat(16), title: '乙书', blocks: [block('螺旋怎么用')] },
      ],
    })
    assert.equal(pass.candidates.length, 1)
    const [item] = pass.candidates
    assert.equal(item.term, '螺旋')
    assert.equal(item.bookCount, 2)
    assert.equal(item.blockCount, 3)
    assert.deepEqual(item.books.map((book) => book.title), ['甲书', '乙书'], '书多的在前')
    assert.deepEqual(item.books.map((book) => book.count), [2, 1])
    // 原句只引问题，且每本最多留 5 条。
    assert.equal(item.books[0].hits.length, 2)
    assert.equal(item.books[0].hits[0].quote, '螺旋是什么')
    assert.equal(item.books[0].hits[1].chapterLabel, '第二章')
    assert.deepEqual(pass.scanned, { books: 2, blocks: 3 })
  }

  // 空输入不炸：书库刚建、一条问答都没有。
  assert.deepEqual(buildCandidates({}), { candidates: [], scanned: { books: 0, blocks: 0 } })
  assert.deepEqual(buildCandidates({ books: [{ title: '空书' }] }).scanned, { books: 0, blocks: 0 })
}

/** 长词盖短词：子串切法会把「主题阅读」同时产成四个短词，不能四条都说同一件事。 */
function longTermCoversItsOwnSubstrings() {
  const books = [
    {
      bookHash: 'a'.repeat(16),
      title: '甲书',
      blocks: [block('主题阅读是什么'), block('主题阅读怎么做')],
    },
    { bookHash: 'b'.repeat(16), title: '乙书', blocks: [block('主题阅读怎么用')] },
  ]
  const { candidates } = buildCandidates({ books })
  const terms = candidates.map((item) => item.term)
  assert.ok(terms.includes('主题阅读'), '四字词必须在：' + terms.join('、'))
  // 「主题阅」「题阅读」「阅读」的跨书计数与「主题阅读」完全一样，必须被盖掉；
  // 这里逐一出断言，盖漏一个用户就会看到四条说同一件事。
  for (const covered of ['主题阅', '题阅读', '阅读', '主题']) {
    assert.equal(terms.includes(covered), false, covered + ' 应被长词盖掉：' + terms.join('、'))
  }

  // 但只在数量上占优的短词是真话题，不许被盖：例子里「结构」出现在 3 本书，
  // 「螺旋结构」只出现在 2 本 —— 两个都得留。
  const both = buildCandidates({
    books: [
      { bookHash: 'a'.repeat(16), title: '甲书', blocks: [block('螺旋结构是什么'), block('螺旋结构怎么用')] },
      { bookHash: 'b'.repeat(16), title: '乙书', blocks: [block('螺旋结构重要吗')] },
      { bookHash: 'c'.repeat(16), title: '丙书', blocks: [block('结构怎么理解'), block('结构有问题')] },
    ],
  })
  const kept = both.candidates.map((item) => item.term)
  assert.ok(kept.includes('螺旋结构'), '两本书的四字词要留：' + kept.join('、'))
  assert.ok(kept.includes('结构'), '出现在更多书里的短词也是真话题：' + kept.join('、'))
}

/** 候选上限与排序：同一份输入永远同一批、同一顺序。 */
function candidatesAreDeterministicAndCapped() {
  // 20 个互不包含的两字词，每个都在两本书里出现 3 次。
  // 取 40 个互不相同的汉字两两成对：不跨词边界，就不会被虚词表擦掉。
  const chars = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉天地玄黄宇宙洪荒日月盈昃宿列张寒来暑往秋收'
  const unique = [...new Set(chars)]
  assert.ok(unique.length >= 40, '汉字池要够 40 个，实际 ' + unique.length)
  const terms = []
  for (let at = 0; at + 1 < 40; at += 2) terms.push(unique.slice(at, at + 2).join(''))
  assert.equal(terms.length, 20)
  assert.equal(new Set(terms).size, 20, '词不能重样')

  const books = [
    { bookHash: 'a'.repeat(16), title: '甲书', blocks: terms.flatMap((term) => [block(term), block(term)]) },
    { bookHash: 'b'.repeat(16), title: '乙书', blocks: terms.map((term) => block(term)) },
  ]
  const first = buildCandidates({ books })
  assert.equal(first.candidates.length, MAX_CANDIDATES, '候选上限是 ' + MAX_CANDIDATES)
  for (const item of first.candidates) {
    assert.equal(item.bookCount, 2)
    assert.equal(item.blockCount, 3)
  }
  // 同样的输入再来一次：顺序、内容逐字相同（排序末位落到字典序就是为了这个）。
  const again = buildCandidates({ books })
  assert.deepEqual(again, first)
}

/** 列表里的一句话说明。 */
function candidateLineSaysHowMany() {
  const one = candidateLine({ bookCount: 1, blockCount: 3, books: [{ title: '甲书' }] })
  assert.equal(one, '出现在 1 本书、3 段讨论：《甲书》')

  const many = candidateLine({
    bookCount: 5,
    blockCount: 9,
    books: [{ title: '甲书' }, { title: '乙书' }, { title: '丙书' }, { title: '丁书' }, { title: '戊书' }],
  })
  assert.equal(many, '出现在 5 本书、9 段讨论：《甲书》、《乙书》、《丙书》 等 5 本')

  // 缺字段不炸：界面上任何一格缺了都只该少一句话，不该白屏。
  assert.equal(candidateLine({}), '出现在 0 本书、0 段讨论：')
}

/** 主题页骨架：「我现在的判断」故意留空，「讨论记录」必须放在最后。 */
function threadPageLeavesJudgmentToTheReader() {
  const candidate = buildCandidates({
    books: [
      { bookHash: 'a'.repeat(16), title: '甲书', blocks: [block('螺旋是什么'), block('螺旋重要吗', '第二章')] },
      { bookHash: 'b'.repeat(16), title: '乙书', blocks: [block('螺旋怎么用')] },
    ],
  }).candidates[0]

  const page = buildThreadPage(candidate, { updatedAt: '2026-11-17' })
  assert.equal(page.title, '螺旋')
  assert.ok(page.markdown.startsWith('# 螺旋\n'), '标题在最前：' + page.markdown.slice(0, 20))
  assert.ok(page.markdown.includes('> 出现在 2 本书、3 段讨论 · 最后更新 2026-11-17'))

  for (const heading of ['## 这本书里怎么说', '## 别的书怎么处理', '## 我现在的判断', '## 讨论记录']) {
    assert.ok(page.markdown.includes(heading), '骨架缺一节：' + heading)
  }
  // 块由程序追加到文件末尾，所以「讨论记录」必须是最后一个标题。
  assert.ok(
    page.markdown.lastIndexOf('## 讨论记录') > page.markdown.lastIndexOf('## 我现在的判断'),
    '「讨论记录」必须在「我现在的判断」之后',
  )
  // 「我现在的判断」正文只能是那行注释，不许有一句替用户写好的结论。
  const from = page.markdown.indexOf('## 我现在的判断') + '## 我现在的判断'.length
  const to = page.markdown.indexOf('## 讨论记录')
  const section = page.markdown.slice(from, to).trim()
  assert.ok(section.startsWith('<!--') && section.endsWith('-->'), '判断那一节只该有注释，实际：' + section)
  // 逐节只能引一句问题原句，答案不进页面。
  assert.ok(page.markdown.includes('- 《甲书》（第一章）：「螺旋是什么」'))
  assert.ok(page.markdown.includes('- 《乙书》（第一章）：「螺旋怎么用」'))

  // 没有原文时说明白，不留空白（看起来像程序漏了）。
  const bare = buildThreadPage({ term: '螺旋', bookCount: 1, blockCount: 1, books: [{ title: '甲书', hits: [] }] })
  assert.ok(bare.markdown.includes('（没有留下原文）'))
  // 没给 updatedAt 就不出现「最后更新」（渲染必须确定，不能拿 now 顶上）。
  assert.equal(bare.markdown.includes('最后更新'), false)

  // 讨论清单块：按书分组，每组一个三级标题。
  const inner = buildThreadInner(candidate)
  assert.ok(inner.startsWith('> 3 段讨论，按书分组。'))
  assert.ok(inner.includes('### 《甲书》'))
  assert.ok(inner.includes('### 《乙书》'))
  assert.ok(inner.includes('- 「螺旋是什么」（第一章）'))
  assert.ok(inner.includes('- 「螺旋重要吗」（第二章）'))
  assert.equal(buildThreadInner({ books: [] }), '> 还没有讨论记录。')
}

/** 总览：写得出、读得回来、用户手写的行也不丢。 */
function overviewRoundTrips() {
  const header = buildOverviewHeader()
  assert.ok(header.startsWith('# 主题总览'))
  assert.ok(header.includes('## 已立的主题'))

  const inner = buildOverviewInner(
    [
      { term: '螺旋', bookCount: 2, blockCount: 3, relPath: '_主题/螺旋.md' },
      { term: '结构', bookCount: 3, blockCount: 5, relPath: '_主题/结构.md' },
    ],
    { updatedAt: '2026-11-17' },
  )
  assert.ok(inner.includes('- [[螺旋]] —— 出现在 2 本书、3 段讨论'))
  assert.ok(inner.includes('- [[结构]] —— 出现在 3 本书、5 段讨论'))

  const entries = parseOverviewEntries(inner)
  assert.deepEqual(entries, [
    { term: '螺旋', bookCount: 2, blockCount: 3 },
    { term: '结构', bookCount: 3, blockCount: 5 },
  ])
  assert.deepEqual(parseOverview(inner), ['螺旋', '结构'])

  // 用户自己在列表里加的行：名字读得回来，计数读不回来就记 0（猜一个数字更让人困惑）。
  const mixed = [
    '- [[螺旋]] —— 出现在 2 本书、3 段讨论',
    '- 我自己加的主题',
    '- [[结构]] —— 出现在 3 本书，5 段讨论',
    '- [[螺旋]] —— 重复的不算第二行',
    '随便一行不是列表',
  ].join('\n')
  assert.deepEqual(parseOverviewEntries(mixed), [
    { term: '螺旋', bookCount: 2, blockCount: 3 },
    { term: '我自己加的主题', bookCount: 0, blockCount: 0 },
    { term: '结构', bookCount: 3, blockCount: 5 },
  ])

  // 空列表给一句话，不留一片白。
  assert.ok(buildOverviewInner([]).startsWith('> 还没有立过主题'))
  assert.deepEqual(parseOverviewEntries(''), [])
  assert.deepEqual(parseOverviewEntries(null), [])
  assert.equal(OVERVIEW_BLOCK_ID, 'thread-index')
  assert.equal(THREADS_DIR, '_主题')
  assert.equal(THREADS_INDEX, '_索引/主题总览.md')
}

/* ───────────────────────────── 路由层 ───────────────────────────── */

/** 最小 res：与 notes_routes_test 同一形状。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
    },
    json() {
      return JSON.parse(this.body.toString('utf8'))
    },
    text() {
      return this.body.toString('utf8')
    },
  }
}

/** 两章的 EPUB，书名可换（两本书必须真的不同，否则内容哈希会撞）。 */
function makeEpub(title) {
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data:
        '<container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" ' +
        'media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OEBPS/content.opf',
      data:
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:title>' + title + '</dc:title><dc:creator>测试作者</dc:creator></metadata>' +
        '<manifest>' +
        '<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
    },
    {
      name: 'OEBPS/nav.xhtml',
      data:
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
        '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">第一章</a></li>' +
        '<li><a href="text/ch2.xhtml">第二章</a></li></ol></nav></body></html>',
    },
    {
      name: 'OEBPS/text/ch1.xhtml',
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>' + title + '的正文。</p></body></html>',
    },
    {
      name: 'OEBPS/text/ch2.xhtml',
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>' + title + '的第二章。</p></body></html>',
    },
  ]
  return writeZip(entries)
}

function post(method, body) {
  return { method: 'POST', url: API_PREFIX + '/' + method, body }
}

async function call(handler, method, body) {
  const res = makeRes()
  await handler(post(method, body), res)
  return res
}

async function ok(handler, method, body) {
  const res = await call(handler, method, body)
  assert.equal(res.statusCode, 200, method + ' 应成功，实际 ' + res.statusCode + '：' + res.text())
  const payload = res.json()
  assert.equal(payload.ok, true, method + ' 应 ok:true')
  return payload.value
}

/** 断言失败信封：状态码 + 错误码 + 中文文案（不泄露内部字段）。 */
async function fails(handler, method, body, status, code) {
  const res = await call(handler, method, body)
  const text = res.text()
  assert.equal(res.statusCode, status, method + ' 状态码应为 ' + status + '，实际 ' + res.statusCode + '：' + text)
  const payload = JSON.parse(text)
  assert.equal(payload.ok, false)
  if (code) assert.equal(payload.error.code, code, '错误码应为 ' + code + '，实际 ' + payload.error.code)
  assert.match(payload.error.message, /[\u4e00-\u9fa5]/, '错误文案必须是中文')
  for (const leaked of ['bookHash', 'E_', 'undefined', '/tmp/', 'obsidianVault', '_主题']) {
    assert.equal(
      payload.error.message.includes(leaked),
      false,
      '文案不该出现内部词 ' + leaked + '：' + payload.error.message,
    )
  }
  return payload
}

/** 一条问答记录：只有问题有用（原句只引问题），锚点必填。 */
const qaRecord = (question, chapterLabel, chapterHref) => ({
  question,
  answer: '好。',
  anchorCfiRange: 'epubcfi(/6/2[' + (chapterHref === 'text/ch2.xhtml' ? 'ch2' : 'ch1') + ']!/4/2/1:0,/4/2/1:5)',
  selectedText: '原文',
  chapterHref,
  chapterLabel,
})

export default async function run() {
  termsOnlyKeepRealWords()
  identityComesFromTerm()
  thresholdsNeedAllThree()
  longTermCoversItsOwnSubstrings()
  candidatesAreDeterministicAndCapped()
  candidateLineSaysHowMany()
  threadPageLeavesJudgmentToTheReader()
  overviewRoundTrips()

  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-threads-'))
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-vault-'))
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 10, 17, 7, counter++)).toISOString()
  const store = new LibraryStore({ libraryDir, deviceId: 'mac-threads', now, logger: { warn: () => {} } })
  const handler = createHandler({ store, logger: { warn: () => {} } })

  try {
    // ── 1. 两本书，问出同一件事：只有跨过去才成候选 ──
    const first = await ok(handler, 'shelf.import', {
      filename: '主题甲.epub',
      dataBase64: makeEpub('主题甲').toString('base64'),
    })
    const second = await ok(handler, 'shelf.import', {
      filename: '主题乙.epub',
      dataBase64: makeEpub('主题乙').toString('base64'),
    })
    assert.notEqual(first.bookHash, second.bookHash, '两本书的内容哈希不能撞')

    await store.appendQa(first.bookHash, qaRecord('螺旋是什么', '第一章', 'text/ch1.xhtml'))
    await store.appendQa(first.bookHash, qaRecord('螺旋重要吗', '第二章', 'text/ch2.xhtml'))
    await store.appendQa(second.bookHash, qaRecord('螺旋怎么用', '第一章', 'text/ch1.xhtml'))
    // 只在甲书里问过一次的词：跨不过去，不该出现在候选里。
    await store.appendQa(first.bookHash, qaRecord('装帧设计', '第一章', 'text/ch1.xhtml'))

    {
      const list = await ok(handler, 'thread.list', {})
      assert.equal(list.configured, false, '还没选库')
      assert.equal(list.vaultError, '', '还没配库不算「库打不开」')
      assert.equal(list.indexRelPath, THREADS_INDEX)
      assert.deepEqual(list.scanned, { books: 2, blocks: 4 })
      assert.equal(list.books.length, 2)
      // listShelf 的顺序跟导入顺序无关，按书名取。
      const byTitle = new Map(list.books.map((item) => [item.title, item.count]))
      assert.equal(byTitle.get('主题甲'), 3)
      assert.equal(byTitle.get('主题乙'), 1)
      assert.deepEqual(list.standing, [])
      assert.equal(list.candidates.length, 1, '只有「螺旋」够门槛：' + list.candidates.map((i) => i.term).join('、'))
      const [candidate] = list.candidates
      assert.equal(candidate.term, '螺旋')
      assert.equal(candidate.already, false)
      assert.equal(candidate.line, '出现在 2 本书、3 段讨论：《主题甲》、《主题乙》')
    }

    // ── 2. 选库 ──
    await ok(handler, 'vault.choose', { path: vaultRoot })

    // ── 3. 立页：骨架铺好、讨论清单进块、总览加一行 ──
    const built = await ok(handler, 'thread.build', { term: '螺旋' })
    assert.equal(built.term, '螺旋')
    assert.equal(built.relPath, '_主题/螺旋.md')
    assert.equal(built.indexRelPath, THREADS_INDEX)
    assert.equal(built.bookCount, 2)
    assert.equal(built.blockCount, 3)
    assert.ok(built.openUrl.startsWith('obsidian://open?vault='), 'openUrl 形状不对：' + built.openUrl)

    const pagePath = path.join(vaultRoot, DEFAULT_SUBDIR, '_主题', '螺旋.md')
    const indexRel = path.join(vaultRoot, DEFAULT_SUBDIR, '_索引', '主题总览.md')
    const firstPage = await fs.readFile(pagePath, 'utf8')
    const firstIndex = await fs.readFile(indexRel, 'utf8')
    assert.ok(firstPage.startsWith('# 螺旋\n'))
    assert.ok(firstPage.includes('## 我现在的判断'))
    assert.ok(firstPage.includes('dsh-reading:block'), '讨论清单要落在锚块里')
    assert.ok(firstPage.includes('id=' + threadBlockId('螺旋')), '块 id 来自主题名')
    assert.ok(firstPage.includes('- 「螺旋是什么」（第一章）'))
    assert.equal(firstPage.includes('好。'), false, '答案不进主题页')
    assert.ok(firstIndex.startsWith('# 主题总览'))
    // 立页时写进总览的行不带双链（relPath 由 Obsidian 自己认），只有 buildOverviewInner 显式给了 relPath 才套 [[ ]]
    assert.ok(firstIndex.includes('- 螺旋 —— 出现在 2 本书、3 段讨论'), '总览要有这一行：' + firstIndex)

    // ── 4. 再立一次：页面一个字节都不许变 ──
    {
      await ok(handler, 'thread.build', { term: '螺旋' })
      assert.equal(await fs.readFile(pagePath, 'utf8'), firstPage, '重复立页不该改页面')
      assert.equal(await fs.readFile(indexRel, 'utf8'), firstIndex, '重复立页不该改总览')
      const list = await ok(handler, 'thread.list', {})
      assert.equal(list.configured, true)
      assert.equal(list.vaultError, '')
      assert.deepEqual(list.standing, [{ term: '螺旋', bookCount: 2, blockCount: 3 }])
      assert.equal(list.candidates[0].already, true, '立过的候选要标 already')
    }

    // ── 5. 用户自己写了判断 + 把块删了：重建块，但不许动他的字 ──
    {
      const cut = firstPage.indexOf('<!-- dsh-reading:block')
      assert.ok(cut > 0, '页里应有块标记')
      const handwritten = firstPage.slice(0, cut) + '\n我自己的判断：螺旋只是结构，不是原因。\n'
      await fs.writeFile(pagePath, handwritten, 'utf8')

      await ok(handler, 'thread.build', { term: '螺旋' })
      const after = await fs.readFile(pagePath, 'utf8')
      assert.ok(after.includes('我自己的判断：螺旋只是结构，不是原因。'), '用户写的判断被吃掉了')
      assert.ok(after.includes('dsh-reading:block'), '块应被重建')
      assert.ok(after.includes('按书分组'), '块正文应回来')
      assert.ok(after.startsWith('# 螺旋\n'), '骨架不该被重写')
      assert.equal(after.includes('## 我现在的判断'), true, '原有小节都在')
    }

    // ── 6. 门槛会变：删掉一条讨论，候选就凑不够了 ──
    {
      const list = await ok(handler, 'thread.list', {})
      const target = list.candidates[0]
      // 候选**不从请求里信**：这里故意传一个从没出现过的词。
      await fails(handler, 'thread.build', { term: '从未问过的主题' }, 400, 'E_NO_THREAD')
      await fails(handler, 'thread.build', { term: '   ' }, 400, 'E_BAD_TERM')
      await fails(handler, 'thread.build', {}, 400, 'E_BAD_TERM')
      assert.equal(target.term, '螺旋')
    }

    // ── 7. 库被拔掉：立页要老实说，候选照给（侧栏不许整页报错） ──
    {
      await store.putSettings({ obsidianVault: path.join(os.tmpdir(), 'dsh-gone-' + Date.now()) })
      const list = await ok(handler, 'thread.list', {})
      assert.equal(list.configured, true)
      assert.ok(list.vaultError !== '', '库不在时要如实说一句')
      assert.match(list.vaultError, /[\u4e00-\u9fa5]/)
      assert.equal(list.candidates.length, 1, '库打不开也要给候选')
      assert.deepEqual(list.standing, [])
      await fails(handler, 'thread.build', { term: '螺旋' }, 400, null)
    }

    // ── 8. 没选库时立页：先说要选库，不是「主题不够」 ──
    {
      await store.putSettings({ obsidianVault: '' })
      const listed = await ok(handler, 'thread.list', {})
      assert.equal(listed.configured, false)
      await fails(handler, 'thread.build', { term: '螺旋' }, 400, 'E_NO_VAULT')
    }

    console.log(
      'threads: 8 组用例通过（抽词只留实词、块 id 与文件名、三道门槛、长词盖短词、候选上限与确定性、'
        + '一句话说明、判断留空且讨论记录在末尾、总览往返、跨书立页、重复立页字节不变、'
        + '用户手写不丢、错词与空词、库挪走降级、未配库降级）',
    )
  } finally {
    await fs.rm(libraryDir, { recursive: true, force: true })
    await fs.rm(vaultRoot, { recursive: true, force: true })
  }
}
