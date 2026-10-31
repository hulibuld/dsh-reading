/**
 * Legado 书源兼容层的行为测试。
 *
 * 全部脱网：fetchText 是注入的假函数，返回预先写好的 HTML/JSON。
 * 这样测的是「规则引擎读得对不对」，不是「那个站点今天还开不开」。
 */

import assert from 'node:assert/strict'
import {
  parseSourceList,
  normalizeSource,
  parseHtml,
  evalRule,
  fillUrlTemplate,
  searchSource,
  tocOfSource,
  contentOfSource,
  normalizeParagraphs,
  htmlToParagraphs,
} from '../lib/legado.js'

const SEARCH_HTML = `<!doctype html><html><body>
<div class="result-list">
  <div class="book-item">
    <h3><a href="/book/1">传习录</a></h3>
    <div class="author">王阳明</div>
    <div class="intro">心学入门读本</div>
    <img data-src="/cover/1.jpg">
  </div>
  <div class="book-item">
    <h3><a href="/book/2">近思录</a></h3>
    <div class="author">朱熹</div>
    <div class="intro">理学纲目</div>
    <img data-src="/cover/2.jpg">
  </div>
</div></body></html>`

const TOC_HTML = `<html><body><div class="chapter-list">
  <a href="/c/1">第一章 起</a>
  <a href="/c/2">第二章 承</a>
  <a href="/c/3">第三章 转</a>
</div></body></html>`

const CONTENT_HTML = `<html><body>
<div id="content"><p>　　第一条正文。</p><p>第二条正文，被站点<br>硬折了一行。</p>
<p>本章未完，请收藏本站。</p></div>
</body></html>`

const JSON_SEARCH = JSON.stringify({
  code: 0,
  data: { books: [{ title: '书甲', writer: '作者甲', url: '/b/1' }, { title: '书乙', writer: '作者乙', url: '/b/2' }] },
})

function fakeFetch(map) {
  return async (url) => {
    const hit = map[url]
    if (!hit) throw new Error(`测试没有准备这个地址：${url}`)
    return { url, text: hit }
  }
}

const jsoupSource = normalizeSource({
  bookSourceUrl: 'https://demo.test',
  bookSourceName: '演示源',
  searchUrl: '/search?key={{key}}&page={{page}}',
  ruleSearch: {
    bookList: 'class.book-item',
    name: 'tag.h3@tag.a@text',
    author: 'class.author@text',
    intro: 'class.intro@text',
    coverUrl: 'tag.img@data-src',
    bookUrl: 'tag.h3@tag.a@href',
  },
  ruleToc: {
    chapterList: '-class.chapter-list@tag.a',
    chapterName: 'tag.a@text',
    chapterUrl: 'tag.a@href',
  },
  ruleContent: { content: '@css:#content@html##<p>##' },
})

const cssSource = normalizeSource({
  bookSourceUrl: 'https://css.test',
  bookSourceName: 'CSS 源',
  searchUrl: '/s?q={{key}}',
  ruleSearch: {
    bookList: '@css:.book-item',
    name: '@css:h3 a@text',
    author: '@css:.author@text',
    bookUrl: '@css:h3 a@href',
  },
  ruleToc: { chapterList: '@css:.chapter-list a', chapterName: '@css:a@text', chapterUrl: '@css:a@href' },
  ruleContent: { content: '@css:#content p@text' },
})

const jsonSource = normalizeSource({
  bookSourceUrl: 'https://json.test',
  bookSourceName: 'JSON 源',
  searchUrl: '/api/search?q={{key}}',
  ruleSearch: {
    bookList: '$.data.books[*]',
    name: '$.title',
    author: '$.writer',
    bookUrl: '$.url',
  },
  ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },
  ruleContent: { content: '$.content' },
})

export default async function run() {
  // 1) 导入：数组、去重、坏源进 rejected
  const imported = parseSourceList(JSON.stringify([
    { bookSourceUrl: 'https://a.test', bookSourceName: '甲' },
    { bookSourceUrl: 'https://a.test', bookSourceName: '甲重复' },
    { bookSourceName: '没有地址' },
  ]))
  assert.equal(imported.sources.length, 1, '重复站点应只留一个')
  assert.equal(imported.rejected.length, 2, '重复项与缺地址项都要进 rejected')
  assert.match(imported.rejected[0].reason, /重复/)
  assert.match(imported.rejected[1].reason, /bookSourceUrl/)

  // 2) 单个对象也能导入
  const single = parseSourceList({ bookSourceUrl: 'https://b.test', bookSourceName: '乙' })
  assert.equal(single.sources.length, 1)

  // 3) 非法 JSON 有中文报错
  assert.throws(() => parseSourceList('{不是 json'), /合法/)

  // 4) 请求头字符串被解析成小写键
  const withHeader = normalizeSource({
    bookSourceUrl: 'https://h.test',
    bookSourceName: '带头',
    header: '{"User-Agent":"x","Referer":"https://h.test/"}',
  })
  assert.equal(withHeader.header['user-agent'], 'x')

  // 5) Jsoup 规则：列表 + 相对地址补全
  const searchMap = {
    'https://demo.test/search?key=%E4%BC%A0%E4%B9%A0%E5%BD%95&page=1': SEARCH_HTML,
  }
  const found = await searchSource({
    source: jsoupSource,
    keyword: '传习录',
    fetchText: fakeFetch(searchMap),
  })
  assert.equal(found.items.length, 2, '两条书都要抓到')
  assert.equal(found.items[0].name, '传习录')
  assert.equal(found.items[0].author, '王阳明')
  assert.equal(found.items[0].bookUrl, 'https://demo.test/book/1')
  assert.equal(found.items[0].coverUrl, 'https://demo.test/cover/1.jpg', 'data-src 也要认')

  // 6) CSS 规则同样能抓
  const cssFound = await searchSource({
    source: cssSource,
    keyword: '传习录',
    fetchText: fakeFetch({ 'https://css.test/s?q=%E4%BC%A0%E4%B9%A0%E5%BD%95': SEARCH_HTML }),
  })
  assert.equal(cssFound.items.length, 2)
  assert.equal(cssFound.items[1].name, '近思录')

  // 7) JSONPath 源
  const jsonFound = await searchSource({
    source: jsonSource,
    keyword: '书',
    fetchText: fakeFetch({ 'https://json.test/api/search?q=%E4%B9%A6': JSON_SEARCH }),
  })
  assert.equal(jsonFound.items.length, 2, 'JSON 列表要抓到两条')
  assert.equal(jsonFound.items[0].name, '书甲')
  assert.equal(jsonFound.items[1].author, '作者乙')

  // 8) 目录：`-` 前缀倒序
  const toc = await tocOfSource({
    source: jsoupSource,
    bookUrl: 'https://demo.test/book/1',
    fetchText: fakeFetch({ 'https://demo.test/book/1': TOC_HTML }),
  })
  assert.equal(toc.chapters.length, 3)
  assert.equal(toc.chapters[0].title, '第三章 转', '带 - 的目录列表要倒序')
  assert.equal(toc.chapters[0].url, 'https://demo.test/c/3')

  // 9) 正文：@html 转段落，噪声行被丢掉，硬折行被合并
  const content = await contentOfSource({
    source: jsoupSource,
    chapterUrl: 'https://demo.test/c/1',
    fetchText: fakeFetch({ 'https://demo.test/c/1': CONTENT_HTML }),
  })
  assert.ok(content.paragraphs.length >= 2, `正文至少两段，实际 ${content.paragraphs.length}`)
  assert.match(content.paragraphs[0], /第一条正文/)
  assert.ok(!content.paragraphs.some((line) => line.includes('本章未完')), '噪声行要过滤')

  // 10) 模板变量：key 要编码，page 不编码
  assert.equal(
    fillUrlTemplate('/search?key={{key}}&page={{page}}', { key: '三体', page: 2 }),
    '/search?key=%E4%B8%89%E4%BD%93&page=2',
  )
  // 11) 脚本模板明确报错，不静默给空
  assert.throws(() => fillUrlTemplate('/s?k={{java.base64Encode(key)}}', { key: 'x' }), /插件事项|书源|跑不了/)

  // 12) 不支持的规则写法要有明确错误
  const xpathSource = normalizeSource({
    bookSourceUrl: 'https://x.test',
    bookSourceName: 'XPath 源',
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: '//div[@class="book"]', name: '//a/text()' },
  })
  await assert.rejects(
    () => searchSource({ source: xpathSource, keyword: 'x', fetchText: fakeFetch({ 'https://x.test/s?q=x': SEARCH_HTML }) }),
    /XPath/,
  )

  // 13) 纯函数：段落合并与噪声过滤
  const merged = normalizeParagraphs('这是一段被站点硬折成两行而且长度足够的正文内容，\n后半句应该被合并回同一段里。\n请收藏本站\n第二段。')
  assert.equal(merged.length, 2, `应合并成两段，实际 ${merged.length} 段：${JSON.stringify(merged)}`)
  assert.match(merged[0], /后半句应该被合并/)

  // 14) HTML 片段 → 段落
  const fromHtml = htmlToParagraphs('<p>甲段</p><p>乙段</p>')
  assert.deepEqual(fromHtml, ['甲段', '乙段'])

  // 15) evalRule 的连接符号与净化
  const root = parseHtml(SEARCH_HTML)
  assert.equal(evalRule('class.author@text', { root }), '王阳明\n朱熹')
  assert.equal(evalRule('class.result-list@tag.div.0@class', { root }), 'result-list', '裸属性名当属性取值')
  assert.equal(evalRule('class.author.0@text##王.明##王先生', { root }), '王先生')

  console.log('legado: 15 项通过')
}
