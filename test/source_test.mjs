#!/usr/bin/env node
/**
 * 「找书」纯函数层（lib/sources.js）的测试。
 *
 * 这一层不联网，但它是「用户填的模板 → 真实请求 → 候选链接」的接缝：
 * 模板拼错一个字符，用户搜出来是空白页；抽链接的逻辑写错，候选列表里会混进
 * javascript: 死链、重复项，或者把「上一页 / 下一页」这种导航文字也算成书。
 * 所以这里直接用真实形态的搜索结果页 HTML 片段喂进去，断言的是**用户会看到什么**。
 *
 * 对应的联网部分（真的去抓）在 test/e2e_local_test.mjs，那里起一个本地 http
 * 服务器，不碰外网。
 */

import assert from 'node:assert/strict'
import {
  MAX_CANDIDATES,
  buildSearchUrl,
  extractCandidates,
  guessFilename,
} from '../lib/sources.js'

/** 模板替换：正常、编关键词、缺占位符、非 http(s)、空串。 */
function buildsSearchUrl() {
  // 正常：{query} 换成编码后的关键词（中文要编码，否则 fetch 会把地址拼歪）
  assert.equal(
    buildSearchUrl('https://example.com/search?q={query}', '俗世奇人'),
    `https://example.com/search?q=${encodeURIComponent('俗世奇人')}`,
  )

  // 关键词里的 & 必须整体编码：不编码会把后面那个 page=1 参数吃掉
  assert.equal(
    buildSearchUrl('https://example.com/s?q={query}&page=1', 'a & b'),
    'https://example.com/s?q=a%20%26%20b&page=1',
  )

  // 出现多次就换多次（有的站点在路径和参数里各要一次）
  assert.equal(
    buildSearchUrl('https://example.com/{query}/list?q={query}', 'x'),
    'https://example.com/x/list?q=x',
  )

  // 没有 {query}：不能说「搜了但没结果」，要直接说模板不对
  assert.throws(
    () => buildSearchUrl('https://example.com/search?q=', 'x'),
    /占位符|query/,
    '模板里没有 {query} 时必须报错',
  )

  // 只认 http(s)：file:// 和 ftp:// 会让宿主去读本机文件 / 走别的协议
  assert.throws(() => buildSearchUrl('ftp://example.com/?q={query}', 'x'), /http/)
  assert.throws(() => buildSearchUrl('file:///etc/passwd?q={query}', 'x'), /http/)
  assert.throws(() => buildSearchUrl('不是网址/{query}', 'x'), /合法/)
  assert.throws(() => buildSearchUrl('', 'x'), /空/)
  assert.throws(() => buildSearchUrl(null, 'x'), /空/)
}

/** 抽候选：相对地址、实体解码、死链过滤、去重、上限。 */
function extractsCandidates() {
  const html = [
    '<html><body><div class="list">',
    '<a href="/book/1.epub" class="item"><span>第一部</span> 俗世奇人</a>',
    '<a href="rel/2.epub">相对地址的那本</a>',
    '<a href=\'https://other.example.com/3.epub\'>单引号属性</a>',
    '<a href="javascript:void(0)">点了没用</a>',
    '<a href="mailto:a@example.com">写信给站长</a>',
    '<a href="#top">回到顶部</a>',
    '<a href="/book/1.epub">重复的那一条</a>',
    '<a href="/book/4.epub">   </a>',
    `<a href="/book/5.epub">${'长'.repeat(121)}</a>`,
    '<a href="/book/6.epub">A &amp; B &#39;quoted&#39; &lt;tag&gt; &#x4E2D;&#25991;</a>',
    '<a name="anchor-no-href">没有 href 的锚</a>',
    '</div></body></html>',
  ].join('\n')

  const list = extractCandidates(html, 'https://example.com/search?q=x')
  const urls = list.map((item) => item.url)

  // 相对地址必须按页面地址解析成绝对地址，否则客户端没法去下载
  assert.ok(urls.includes('https://example.com/book/1.epub'), `相对地址没解析对：${urls.join(', ')}`)
  assert.ok(urls.includes('https://example.com/rel/2.epub'), '不带前导 / 的相对地址也要解析')
  assert.ok(urls.includes('https://other.example.com/3.epub'), '绝对地址保持原样')

  // 死链与空文本一律不进列表
  assert.ok(!urls.some((url) => /^javascript:/i.test(url)), 'javascript: 必须被过滤')
  assert.ok(!urls.some((url) => /^mailto:/i.test(url)), 'mailto: 必须被过滤')
  assert.ok(!urls.some((url) => url.endsWith('#top')), '纯 # 锚点必须被过滤')

  // 同一个地址只留第一条：结果页常见「图 + 标题」各一个链接指向同一本书
  assert.equal(
    urls.filter((url) => url === 'https://example.com/book/1.epub').length,
    1,
    '重复 URL 必须去重',
  )

  // 空白文本、超长文本（导航条 / 版权声明）都不算候选
  assert.ok(!urls.includes('https://example.com/book/4.epub'), '空文本必须被过滤')
  assert.ok(!urls.includes('https://example.com/book/5.epub'), '超过 120 字的文本必须被过滤')

  // 标签要剥掉，实体要解回来，空白要压成一个空格
  const first = list.find((item) => item.url === 'https://example.com/book/1.epub')
  assert.equal(first.title, '第一部 俗世奇人', `标题去标签不对：${first.title}`)
  const entity = list.find((item) => item.url === 'https://example.com/book/6.epub')
  assert.equal(entity.title, "A & B 'quoted' <tag> 中文", `实体解码不对：${entity.title}`)

  // 一共四条：1、2、3、6
  assert.equal(list.length, 4, `候选条数不对：${JSON.stringify(list)}`)

  // 上限：几百条链接的结果页只给前 60 条
  const many = Array.from({ length: 90 }, (_, index) => `<a href="/b/${index}.epub">书 ${index}</a>`).join('')
  const capped = extractCandidates(many, 'https://example.com/')
  assert.equal(MAX_CANDIDATES, 60, '上限常量必须是 60')
  assert.equal(capped.length, 60, `候选上限没生效：${capped.length}`)

  // 坏输入不许抛：界面拿到的是一个空列表，而不是白屏
  assert.deepEqual(extractCandidates('', 'https://example.com/'), [])
  assert.deepEqual(extractCandidates(null, ''), [])
}

/** 猜文件名：Content-Disposition 两种写法、URL 兜底、最后兜底 book。 */
function guessesFilename() {
  // filename* 形式（带编码与语言标记）：中文名要靠这个才不丢
  assert.equal(
    guessFilename('https://example.com/dl/1', "attachment; filename*=UTF-8''%E4%B9%A1%E6%84%81.epub"),
    '乡愁.epub',
  )

  // filename="..." 普通引号形式
  assert.equal(
    guessFilename('https://example.com/dl/2', 'attachment; filename="俗世奇人.epub"'),
    '俗世奇人.epub',
  )

  // 没有响应头时用 URL pathname 的 basename（编码过的中文要还原）
  assert.equal(
    guessFilename('https://example.com/files/%E4%B9%A6.epub?token=1', null),
    '书.epub',
  )

  // 路径分隔符与控制字符必须清掉：文件名里带 ../ 就是越界写入
  assert.equal(
    guessFilename('https://example.com/a', 'attachment; filename="../../evil.epub"'),
    '.._.._evil.epub',
  )
  assert.equal(
    guessFilename('https://example.com/a', 'attachment; filename="a\u0001b.epub"'),
    'a_b.epub',
  )

  // 什么都拿不到时兜底 book（后面 ensureExtension 会补扩展名）
  assert.equal(guessFilename('https://example.com/', ''), 'book')
  assert.equal(guessFilename('https://example.com', null), 'book')
  assert.equal(guessFilename('', undefined), 'book')
  assert.equal(guessFilename('::::', null), 'book')
}

export default async function run() {
  buildsSearchUrl()
  extractsCandidates()
  guessesFilename()
}
