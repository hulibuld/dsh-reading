#!/usr/bin/env node
/**
 * 知网检索层（lib/cnki.js）的测试。
 *
 * 这一层是整条「搜知网 → 存成文献集」链路的地基，且它的输入是别人家网站的
 * HTML——不是我们能控制的。三份 fixture 是当时真跑出来的响应原文：
 * 期刊、硕士论文、空结果。解析器写错一个字段，界面上就是空列或者错位的
 * 作者名，而用户会以为「知网上就是这样」。
 *
 * 这里**不联网**：网络层用假 fetch 把 fixture 喂回去，验的是
 * 「请求体对不对 + 响应怎么变成返回值」。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_PAGE,
  MAX_QUERY_CHARS,
  MAX_SNIPPET_CHARS,
  buildSearchBody,
  normalizeCnkiQuery,
  parseCnkiResults,
  searchCnki,
} from '../lib/cnki.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8')

const JOURNAL_HTML = fixture('cnki-journal.html')
const THESIS_HTML = fixture('cnki-thesis.html')
const EMPTY_HTML = fixture('cnki-empty.html')

/** 期刊：4 条，除 journal/issue 外全字段齐；journal 必须非空。 */
function parsesJournalFixture() {
  const { items, empty } = parseCnkiResults(JOURNAL_HTML)
  assert.equal(empty, false, '期刊结果不能被判成空结果')
  assert.equal(items.length, 4, `期刊 fixture 应解析出 4 条，实际 ${items.length}`)

  for (const [index, item] of items.entries()) {
    const where = `第 ${index + 1} 条（${item.title || '无标题'}）`
    assert.ok(item.title !== '', `${where} 标题为空`)
    assert.ok(!/CNKI\s*文献/.test(item.title), `${where} 标题尾巴没剥干净：${item.title}`)
    assert.ok(!/</.test(item.title), `${where} 标题里还留着标签：${item.title}`)
    assert.ok(/^https:\/\//.test(item.url), `${where} 网址没补上 https：${item.url}`)
    assert.ok(item.fn !== '', `${where} 缺知网文件名`)
    assert.ok(Array.isArray(item.authors) && item.authors.length > 0, `${where} 作者为空`)
    assert.ok(!item.authors.includes(''), `${where} 作者里混进了空串（占位空 a 没滤掉）`)
    assert.ok(item.journal !== '', `${where} 期刊为空`)
    assert.ok(item.issue !== '', `${where} 年期为空`)
    assert.equal(item.type, '期刊', `${where} 文献类型应为「期刊」，实际「${item.type}」`)
    assert.ok(Array.isArray(item.keywords) && item.keywords.length > 0, `${where} 关键词为空`)
    assert.ok(item.keywords.every((keyword) => keyword !== ''), `${where} 关键词里有空串`)
    assert.ok(Number.isInteger(item.citations), `${where} 被引不是整数`)
    assert.ok(item.citations > 0, `${where} 被引应为正数，实际 ${item.citations}`)
    assert.ok(Number.isInteger(item.downloads), `${where} 下载不是整数`)
    assert.ok(item.downloads > 0, `${where} 下载应为正数，实际 ${item.downloads}`)
    assert.ok(item.snippet !== '', `${where} 摘要片段为空`)
  }

  // 抽查已知值：第一条是被引 3019 的《20世纪以来中国的大型滑坡及其发生机制》。
  const first = items[0]
  assert.equal(first.title, '20世纪以来中国的大型滑坡及其发生机制', `第一条标题不对：${first.title}`)
  assert.equal(first.authors[0], '黄润秋', `第一条作者不对：${first.authors.join(',')}`)
  assert.equal(first.journal, '岩石力学与工程学报', `第一条期刊不对：${first.journal}`)
  assert.equal(first.issue, '2007年03期', `第一条年期不对：${first.issue}`)
  assert.equal(first.citations, 3019, `第一条被引不对：${first.citations}`)
  assert.equal(first.downloads, 27027, `第一条下载不对：${first.downloads}`)
  assert.equal(first.fn, 'YSLX200703000', `第一条文件名不对：${first.fn}`)
  assert.equal(
    first.url,
    'https://www.cnki.com.cn/Article/CJFDTOTAL-YSLX200703000.htm',
    `第一条网址不对：${first.url}`,
  )
  // 高亮 span 必须剥掉、只留纯文本
  assert.ok(!first.title.includes('span'), '标题里的高亮标签没剥掉')
  // 关键词取的是 data-key 全串再拆，不是单个 a 的文字
  assert.deepEqual(first.keywords, ['边坡工程', '大型滑坡', '实例研究', '发育规律'], '关键词拆分不对')
  // 命中词被红 span 切开时不能补空格：`大型<span>滑坡</span>` 是「大型滑坡」不是「大型 滑坡」
  assert.ok(first.snippet.includes('大型滑坡'), `片段里被高亮标签拆出了空格：${first.snippet}`)

  // 多作者那条要按出现顺序全收
  const four = items.find((item) => item.title.startsWith('滑坡时空演化规律'))
  assert.deepEqual(
    four.authors,
    ['许强', '汤明高', '徐开祥', '黄学斌'],
    `多作者顺序不对：${four.authors.join(',')}`,
  )
}

/** 学位论文：4 条，journal 恒为空（站点本来就不给），type 是「硕士论文」。 */
function parsesThesisFixture() {
  const { items, empty } = parseCnkiResults(THESIS_HTML)
  assert.equal(empty, false, '学位论文结果不能被判成空结果')
  assert.equal(items.length, 4, `学位论文 fixture 应解析出 4 条，实际 ${items.length}`)

  for (const [index, item] of items.entries()) {
    const where = `第 ${index + 1} 条（${item.title || '无标题'}）`
    assert.ok(item.title !== '', `${where} 标题为空`)
    assert.ok(/^https:\/\//.test(item.url), `${where} 网址没补上 https：${item.url}`)
    assert.ok(item.fn !== '', `${where} 缺知网文件名`)
    assert.equal(item.journal, '', `${where} 学位论文的期刊必须为空串，实际「${item.journal}」`)
    assert.equal(item.type, '硕士论文', `${where} 文献类型应为「硕士论文」，实际「${item.type}」`)
    // 学位论文的发表时间形如 2026-06-10
    assert.match(item.issue, /^\d{4}-\d{2}-\d{2}$/, `${where} 日期不对：${item.issue}`)
    assert.ok(Array.isArray(item.authors) && item.authors.length > 0, `${where} 作者为空`)
    // 导师那一项没有 data-key，不能被当成作者
    assert.ok(!item.authors.some((name) => name.includes('导师')), `${where} 作者里混进了导师`)
    assert.ok(Array.isArray(item.keywords) && item.keywords.length > 0, `${where} 关键词为空`)
    assert.ok(Number.isInteger(item.downloads) && item.downloads > 0, `${where} 下载数不对`)
    // 被引为 0 是正常的（新论文），但必须是数字 0 而不是缺字段
    assert.equal(item.citations, 0, `${where} 被引应为 0，实际 ${item.citations}`)
  }
}

function parsesEmptyFixture() {
  const { items, empty } = parseCnkiResults(EMPTY_HTML)
  assert.deepEqual(items, [], '空结果不该有 items')
  assert.equal(empty, true, '空结果必须标记 empty=true')

  // 空输入不是「没搜到」，是「没拿到东西」——两者要能区分
  assert.deepEqual(parseCnkiResults(''), { items: [], empty: false }, '空字符串不该算空结果')
  assert.deepEqual(parseCnkiResults(null), { items: [], empty: false }, 'null 不该算空结果')

  // 坏 HTML 不许抛：界面拿到空列表 + empty=false，照常显示「没拿到结果」
  const broken = parseCnkiResults('<html>坏掉的</html>')
  assert.deepEqual(broken, { items: [], empty: false }, '坏 HTML 应返回空列表而不是抛错')
  // 有 list-item 壳但没内容时也不能吐半条脏数据
  assert.deepEqual(
    parseCnkiResults('<div class="list-item"><p class="tit"></p></div>').items,
    [],
    '空块不该产出条目',
  )
}

function buildsBody() {
  const body = buildSearchBody({ query: '滑坡', field: 'title', order: 4, year: '2024', page: 3 })
  assert.ok(body.includes('Title='), `请求体缺 Title：${body}`)
  assert.ok(body.includes('Order=4'), `请求体缺 Order=4：${body}`)
  assert.ok(body.includes('Year=2024'), `请求体缺 Year=2024：${body}`)
  assert.ok(body.includes('page=3'), `请求体缺 page=3：${body}`)
  // 中文要按表单编码，不能裸着塞进 body
  assert.ok(body.includes(encodeURIComponent('滑坡')), `中文没编码：${body}`)

  // 翻页夹取：999 页没有意义，夹到上限
  const capped = buildSearchBody({ query: '滑坡', page: 999 })
  assert.equal(MAX_PAGE, 20, '翻页上限常量必须是 20')
  assert.ok(capped.includes('page=20'), `page=999 没被夹到 20：${capped}`)
  assert.ok(!capped.includes('page=999'), `page=999 漏过去了：${capped}`)
  // 下界与非法值
  assert.ok(buildSearchBody({ query: 'x', page: 0 }).includes('page=1'), 'page=0 应夹到 1')
  assert.ok(buildSearchBody({ query: 'x', page: -5 }).includes('page=1'), '负数页应夹到 1')
  assert.ok(buildSearchBody({ query: 'x', page: 'abc' }).includes('page=1'), '非法页应退回 1')

  // 正文检索：字段名是小写 content，且不能同时带上 Title
  const content = buildSearchBody({ query: '滑坡', field: 'content' })
  assert.ok(content.includes('content='), `content 检索缺 content=：${content}`)
  assert.ok(!content.includes('Title='), `content 检索不该带 Title=：${content}`)

  // 年份只认四位数字：日期形态会让站点返回 0 条，所以不传
  assert.ok(!buildSearchBody({ query: 'x', year: '2024-01-01' }).includes('Year='), '日期形态的年份不该传')
  assert.ok(!buildSearchBody({ query: 'x', year: '' }).includes('Year='), '空年份不该传')

  // 排序夹取到 1–4
  assert.ok(buildSearchBody({ query: 'x', order: 9 }).includes('Order=4'), 'order=9 应夹到 4')

  // 空关键词：这不是「没结果」，是用户没填，要明确报错
  assert.throws(() => buildSearchBody({ query: '   ' }), (error) => error.code === 'E_PAPER_QUERY', '空关键词应抛 E_PAPER_QUERY')
  assert.throws(() => buildSearchBody({}), (error) => error.code === 'E_PAPER_QUERY', '缺关键词应抛 E_PAPER_QUERY')
}

function normalizesQuery() {
  assert.equal(normalizeCnkiQuery('  滑坡  '), '滑坡')
  assert.equal(normalizeCnkiQuery('大型\n滑坡'), '大型 滑坡', '内部换行应压成空格')
  assert.equal(normalizeCnkiQuery(''), '')
  assert.equal(normalizeCnkiQuery('   '), '')
  assert.equal(normalizeCnkiQuery(null), '')
  assert.equal(normalizeCnkiQuery(123), '')
  assert.equal(MAX_QUERY_CHARS, 100, '关键词上限常量必须是 100')
  assert.equal(Array.from(normalizeCnkiQuery('滑'.repeat(150))).length, 100, '超长关键词应截到 100 字')
}

function capsSnippet() {
  for (const html of [JOURNAL_HTML, THESIS_HTML]) {
    for (const item of parseCnkiResults(html).items) {
      assert.equal(MAX_SNIPPET_CHARS, 160, '片段上限常量必须是 160')
      assert.ok(
        Array.from(item.snippet).length <= MAX_SNIPPET_CHARS,
        `摘要片段超过 160 字：${Array.from(item.snippet).length}`,
      )
      assert.ok(!item.snippet.includes('<'), '摘要片段里还留着标签')
      assert.ok(!item.snippet.includes('\n'), '摘要片段里还留着换行')
    }
  }
  // 构造一条超长片段，确认真的截断而不是原样返回
  const longHtml = `<div class="list-item">
    <p class="tit"><a class="left" title="标题" href="//example.com/a.htm">标题</a></p>
    <p class="nr">${'字'.repeat(400)}</p>
    <p class="source"><span><a data-key="甲">甲</a></span><span>期刊</span></p>
    <div class="checkbox1" data-fn="X1"></div>
  </div>`
  const [item] = parseCnkiResults(longHtml).items
  assert.equal(Array.from(item.snippet).length, 160, '超长片段应截到 160 字')
}

/** 网络层：假 fetch 把 fixture 喂回去，验请求与返回形状。 */
async function searchesWithInjectedFetch() {
  const calls = []
  const fakeFetch = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      status: 200,
      async text() {
        return THESIS_HTML
      },
    }
  }

  const result = await searchCnki({ query: ' 滑坡 ', field: 'content', order: 4, page: 2 }, { fetch: fakeFetch })

  // 请求形状：POST 到 listresult，表单体带 content=，头里带 referer 与 UA
  assert.equal(calls.length, 1, '应该只发一次请求')
  const [{ url, options }] = calls
  assert.equal(url, 'https://search.cnki.com.cn/search/listresult', `请求地址不对：${url}`)
  assert.equal(options.method, 'POST', '必须是 POST')
  assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded', 'content-type 不对')
  assert.ok(/Mozilla|Chrome/.test(options.headers['user-agent']), 'UA 要像浏览器')
  assert.ok(String(options.headers.referer).includes('search.cnki.com.cn'), 'referer 不对')
  assert.ok(String(options.body).includes('content='), `请求体缺 content=：${options.body}`)
  assert.ok(String(options.body).includes('page=2'), `请求体缺 page=2：${options.body}`)

  // 返回形状：items/empty/page/hasMore/source
  assert.deepEqual(Object.keys(result).sort(), ['empty', 'hasMore', 'items', 'page', 'source'], '返回字段不对')
  assert.equal(result.source, 'cnki')
  assert.equal(result.page, 2)
  assert.equal(result.empty, false)
  assert.equal(result.items.length, 4, `假 fetch 的 4 条应全部解析出来，实际 ${result.items.length}`)
  assert.equal(result.hasMore, false, '不满一页不该给「下一页」')
  assert.equal(result.items[0].type, '硕士论文')

  // 满 20 条的页面才给 hasMore；到上限后不再给
  const twenty = (fn) =>
    Array.from({ length: 20 }, (_, index) => `<div class="list-item">
      <p class="tit"><a class="left" title="标题 ${index}" href="//example.com/${index}.htm">标题</a></p>
      <p class="nr">片段</p>
      <p class="source"><span><a data-key="甲">甲</a></span><span>期刊</span></p>
      <div class="checkbox1" data-fn="${fn}${index}"></div>
    </div>`).join('')

  const fullPage = await searchCnki({ query: 'x', page: 1 }, {
    fetch: async () => ({ ok: true, status: 200, text: async () => twenty('A') }),
  })
  assert.equal(fullPage.items.length, 20)
  assert.equal(fullPage.hasMore, true, '满一页应允许下一页')

  const lastPage = await searchCnki({ query: 'x', page: MAX_PAGE }, {
    fetch: async () => ({ ok: true, status: 200, text: async () => twenty('B') }),
  })
  assert.equal(lastPage.page, MAX_PAGE, '超上限的页码应被夹到 20')
  assert.equal(lastPage.hasMore, false, '到上限不该再给下一页')

  // 空结果：empty=true 且不给下一页
  const emptyResult = await searchCnki({ query: 'zzz', page: 1 }, {
    fetch: async () => ({ ok: true, status: 200, text: async () => EMPTY_HTML }),
  })
  assert.equal(emptyResult.empty, true)
  assert.deepEqual(emptyResult.items, [])
  assert.equal(emptyResult.hasMore, false)
}

/** 网络层出错时给的是能直接显示的中文错误 + 机器可读 code。 */
async function reportsFetchFailures() {
  // 网络层失败
  await assert.rejects(
    () => searchCnki({ query: 'x' }, { fetch: async () => { throw new Error('ECONNRESET') } }),
    (error) => error.code === 'E_PAPER_FETCH' && /知网/.test(error.message),
    '网络异常应抛 E_PAPER_FETCH',
  )
  // 非 2xx
  await assert.rejects(
    () => searchCnki({ query: 'x' }, { fetch: async () => ({ ok: false, status: 503, text: async () => '' }) }),
    (error) => error.code === 'E_PAPER_FETCH' && error.message.includes('503'),
    '非 2xx 应抛 E_PAPER_FETCH 并带上状态码',
  )
  // 空关键词在发请求之前就被拦住
  let called = false
  await assert.rejects(
    () => searchCnki({ query: ' ' }, { fetch: async () => { called = true } }),
    (error) => error.code === 'E_PAPER_QUERY',
    '空关键词应抛 E_PAPER_QUERY',
  )
  assert.equal(called, false, '空关键词不该真的发请求')
}

export default async function run() {
  parsesJournalFixture()
  parsesThesisFixture()
  parsesEmptyFixture()
  buildsBody()
  normalizesQuery()
  capsSnippet()
  searchesWithInjectedFetch()
  await reportsFetchFailures()
  console.log('cnki: 8 组用例通过（三份 fixture 解析 4+4+0 条，请求体与注入 fetch 均已验）')
}
