#!/usr/bin/env node
/**
 * 文献集造书（lib/papercollect.js）的测试。
 *
 * 这一层是「检索结果 → 一本能读能问的书」的最后一步，判据有两类：
 *
 *   1. **字节层面**：同一份题录两次造出的书必须逐字节相同。否则同一批文献
 *      反复收集会在书架里堆出几本看起来一样、哈希却不同的书。
 *   2. **语义层面**：造出来的字节必须能被我们自己的解析器读懂——标题、目录、
 *      章节数都对得上。只造出「一个 zip」不算数，要造出**这本书**。
 *
 * 另外钉住一条产品底线：知网免费页给的摘要恒定截断在 128 字，我们拿不到全文，
 * 所以每一章都必须带着「不是完整摘要」的说明。这一条不做妥协。
 *
 * 全程不联网、不碰磁盘（解析从字节开始）。
 */

import assert from 'node:assert/strict'

import { collectPapers, buildPaperEpub, DEFAULT_PAPER_TITLE, SNIPPET_NOTICE } from '../lib/papercollect.js'
import { parseEpub } from '../lib/epub.js'
import { readZip } from '../lib/zip.js'

/** 两条能代表真实形态的题录：一条期刊（字段齐）、一条学位论文（无期刊）。 */
function sampleItems() {
  return [
    {
      title: '20世纪以来中国的大型滑坡及其发生机制',
      authors: ['黄润秋'],
      journal: '岩石力学与工程学报',
      issue: '2007年03期',
      type: '期刊',
      keywords: ['边坡工程', '大型滑坡', '实例研究'],
      snippet: '在收集大量资料的基础上，对中国20世纪以来发生的大型滑坡进行了系统研究。',
      url: 'https://www.cnki.com.cn/Article/CJFDTOTAL-YSLX200703000.htm',
      citations: 3019,
      downloads: 27027,
    },
    {
      title: '某滑坡体稳定性分析',
      authors: ['张三', '李四'],
      journal: '',
      issue: '2026-06-13',
      type: '硕士论文',
      keywords: ['滑坡'],
      snippet: '',
      url: '',
      citations: 0,
      downloads: 0,
    },
  ]
}

/** 期望某个调用抛指定 code。 */
async function expectCode(code, fn) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `应当抛 ${code}，但没有抛`)
  assert.equal(caught.code, code, `应当是 ${code}，实际 ${caught?.code}：${caught?.message}`)
  return caught
}

/** 把 ZIP 里的所有文本条目拼起来，用来做「字节里有没有裸标签」这类断言。 */
function allText(bytes) {
  const zip = readZip(bytes)
  const parts = []
  for (const name of zip.names ?? []) {
    if (!/\.(xhtml|opf|xml)$/i.test(name)) continue
    parts.push(zip.get(name).toString('utf8'))
  }
  return parts.join('\n')
}

// ── 1. 字节稳定：同输入两次 → Buffer.compare === 0 ──────────────
async function isByteStable() {
  const input = { title: '文献集 2026-11-12', items: sampleItems() }
  const first = buildPaperEpub(input)
  const second = buildPaperEpub({ title: '文献集 2026-11-12', items: sampleItems() })
  assert.ok(Buffer.isBuffer(first), 'buildPaperEpub 必须返回 Buffer')
  assert.ok(first.length > 500, `造出来的书不该这么小：${first.length} 字节`)
  assert.equal(Buffer.compare(first, second), 0, '同一份题录两次造出的字节必须完全相同')
}

// ── 2. 生成的字节能被 parseEpub 读懂 ────────────────────────────
async function parsesBackAsEpub() {
  const items = sampleItems()
  const bytes = buildPaperEpub({ title: '滑坡研究文献集', items })
  const parsed = await parseEpub(bytes, { deviceId: 'mac-abc123' })
  assert.equal(parsed.meta.title, '滑坡研究文献集', `书名应原样保留，实际 ${parsed.meta.title}`)
  assert.equal(parsed.meta.author, '知网检索', '作者固定标注来源')
  assert.equal(parsed.spine.length, items.length, `spine 应等于题录条数 ${items.length}`)
  assert.equal(parsed.tocSource, 'nav', `目录应来自 EPUB3 nav，实际 ${parsed.tocSource}`)
  assert.equal(parsed.toc.length, items.length, '目录条数应等于题录条数')
  assert.equal(parsed.toc[0].label, items[0].title, '目录第一条必须是中文题名，不能是 c1')
  assert.equal(parsed.toc[1].label, items[1].title, '目录第二条必须是中文题名，不能是 c2')
  assert.equal(parsed.toc[0].spineIndex, 0, '目录要能对回 spine')
}

// ── 3. 空题录 → E_PAPER_COLLECT ─────────────────────────────────
async function rejectsEmptyItems() {
  await expectCode('E_PAPER_COLLECT', () => buildPaperEpub({ title: '空', items: [] }))
  await expectCode('E_PAPER_COLLECT', () => buildPaperEpub({ title: '空' }))
  await expectCode('E_PAPER_COLLECT', () => buildPaperEpub({ title: '空', items: null }))
}

// ── 4. 缺 title 的条目被跳过，而不是整批失败 ────────────────────
async function skipsItemsWithoutTitle() {
  const items = [
    { title: '有题名的一篇', authors: ['甲'], type: '期刊' },
    { title: '   ', authors: ['乙'], type: '期刊' },
    { authors: ['丙'], type: '期刊' },
    { title: '另一篇有题名的', authors: [], type: '硕士论文' },
  ]
  const bytes = buildPaperEpub({ title: '混合', items })
  const parsed = await parseEpub(bytes, { deviceId: 'mac-abc123' })
  assert.equal(parsed.spine.length, 2, `只该收有题名的两条，实际 ${parsed.spine.length}`)
  assert.deepEqual(
    parsed.toc.map((entry) => entry.label),
    ['有题名的一篇', '另一篇有题名的'],
    '跳过的条目不能出现在目录里',
  )

  // 全部缺题名 → 等同于空，必须抛
  await expectCode('E_PAPER_COLLECT', () =>
    buildPaperEpub({ title: '全空', items: [{ title: '' }, { authors: ['甲'] }, {}] }),
  )
}

// ── 5. 标题里的 & 与 < 必须转义 ─────────────────────────────────
async function escapesDangerousTitle() {
  const hostile = 'A & B <script>alert(1)</script> "引号"'
  const bytes = buildPaperEpub({ title: '转义测试 & 检验', items: [{ title: hostile, type: '期刊' }] })

  const zip = readZip(bytes)
  for (const name of zip.names ?? []) {
    if (!/\.(xhtml|opf|xml)$/i.test(name)) continue
    const text = zip.get(name).toString('utf8')
    assert.equal(text.includes('<script>'), false, `${name} 里不该出现裸 <script>`)
  }

  const parsed = await parseEpub(bytes, { deviceId: 'mac-abc123' })
  assert.equal(parsed.meta.title, '转义测试 & 检验', '书名里的 & 转义后应还原')
  assert.equal(parsed.toc[0].label, hostile, '题名里的 & < " 转义后应完整还原')
}

// ── 6. 缺摘要写占位，不缺就写片段 ───────────────────────────────
async function writesSnippetFallback() {
  const withSnippet = sampleItems()[0]
  const withoutSnippet = sampleItems()[1]
  const bytes = buildPaperEpub({ title: '摘要', items: [withSnippet, withoutSnippet] })
  const parsed = await parseEpub(bytes, { deviceId: 'mac-abc123' })

  const chapterOf = async (index) => (await parsed.chapterHtml(parsed.spine[index].href)) ?? ''

  const first = await chapterOf(0)
  assert.ok(first.includes('摘要片段'), '有摘要时也要有这个标题')
  assert.ok(first.includes(withSnippet.snippet), '摘片段落应写入片段原文')

  const second = await chapterOf(1)
  assert.ok(second.includes('知网未提供摘要片段'), '没有摘要时必须写占位文字，不能留空')
}

// ── 7. 每一章都带「不是完整摘要」的说明 ─────────────────────────
async function everyChapterStatesItIsOnlyASnippet() {
  const bytes = buildPaperEpub({ title: '说明', items: sampleItems() })
  const parsed = await parseEpub(bytes, { deviceId: 'mac-abc123' })
  for (const entry of parsed.spine) {
    const html = (await parsed.chapterHtml(entry.href)) ?? ''
    assert.ok(html.includes('不是完整摘要'), `每一章都要说明这不是完整摘要：${entry.href}`)
    assert.ok(html.includes(SNIPPET_NOTICE), `说明措辞应与常量一致：${entry.href}`)
  }
}

// ── 8. 字段缺失时不留下空悬挂（无期刊 → 不出现两个空格） ─────────
async function omitsMissingSourceParts() {
  const bytes = buildPaperEpub({ title: '缺字段', items: sampleItems() })
  const parsed = await parseEpub(bytes, { deviceId: 'mac-abc123' })
  const thesis = (await parsed.chapterHtml(parsed.spine[1].href)) ?? ''
  assert.ok(thesis.includes('张三、李四'), '多位作者用顿号连接')
  assert.ok(thesis.includes('2026-06-13'), '学位论文没有刊名，但年期要保留')
  assert.equal(thesis.includes('作者未标注'), false, '作者存在时不该出现「作者未标注」')

  const noAuthors = buildPaperEpub({ title: '无作者', items: [{ title: '某篇', type: '期刊' }] })
  const parsedNoAuthors = await parseEpub(noAuthors, { deviceId: 'mac-abc123' })
  const blank = (await parsedNoAuthors.chapterHtml(parsedNoAuthors.spine[0].href)) ?? ''
  assert.ok(blank.includes('作者未标注'), '没有作者时要写「作者未标注」')
}

// ── 9. collectPapers 走 store.importBook，返回 {bookHash, title} ─
async function collectsThroughStore() {
  const seen = []
  const fakeStore = {
    async importBook(input) {
      seen.push(input)
      return { bookHash: 'a'.repeat(64), meta: { title: '文献集' } }
    },
  }
  const result = await collectPapers(fakeStore, { title: '文献集 X', items: sampleItems() })
  assert.equal(seen.length, 1, '应当只导入一次')
  assert.equal(seen[0].filename, '文献集.epub', '文件名固定，用户区分得出这是造出来的书')
  const decoded = Buffer.from(seen[0].dataBase64, 'base64')
  assert.deepEqual(decoded, buildPaperEpub({ title: '文献集 X', items: sampleItems() }), '入库的字节必须与纯函数产物一致')
  assert.deepEqual(result, { bookHash: 'a'.repeat(64), title: '文献集 X' })

  // 书名留空 / 不是字符串 → 退回默认名，而不是造一本无名书
  const fallback = await collectPapers(fakeStore, { items: sampleItems() })
  assert.equal(fallback.title, DEFAULT_PAPER_TITLE, '没给书名时应退回默认名')

  // 空题录照样抛，不会先调 importBook
  await expectCode('E_PAPER_COLLECT', () => collectPapers(fakeStore, { title: '空', items: [] }))
  assert.equal(seen.length, 2, '空题录不该走到 importBook')
}

/** 全部用例。抛错即失败。 */
export default async function run() {
  await isByteStable()
  await parsesBackAsEpub()
  await rejectsEmptyItems()
  await skipsItemsWithoutTitle()
  await escapesDangerousTitle()
  await writesSnippetFallback()
  await everyChapterStatesItIsOnlyASnippet()
  await omitsMissingSourceParts()
  await collectsThroughStore()
  console.log('papercollect: 9 组用例通过（字节稳定 / 可被 parseEpub 读回 / 空题录与缺题名 / 转义 / 摘要诚实性 / 入库）')
}
