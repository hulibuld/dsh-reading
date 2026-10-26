/**
 * 格式分诊层（lib/bookformat.js）的测试。
 *
 * 这一层是「一份字节 → 一本能读的书」的接缝：格式判错，用户会看到「这本书损坏了」；
 * 分诊正确但归一化漏字段，界面会缺书名/缺章节。所以这里测的是**接缝**，
 * 各格式内部的解析细节分别由 epub_test / mobi_test / txt_test 负责。
 */

import assert from 'node:assert/strict'
import { detectFormat, sourceFormatOf, extensionOf, parseBook } from '../lib/bookformat.js'
import { parseXml } from '../lib/xml.js'
import { isAppError } from '../lib/errors.js'
import { buildMinimalMobi } from './mobi_fixture.mjs'

/** 魔数判定：改扩展名骗不过去。 */
function detectsByMagic() {
  assert.equal(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), 'epub')
  // 扩展名对不上时仍按字节判定：这是「.txt 改名成 .epub」能被正确识别的根据
  const mobi = buildMinimalMobi({ html: '<p>x</p>' })
  assert.equal(detectFormat(mobi), 'mobi')
  assert.equal(sourceFormatOf('x.txt', detectFormat(mobi)), 'mobi')
  assert.equal(detectFormat(Buffer.from('第一章\n正文', 'utf8')), 'txt')
  // 空文件不在这里判（由 parseBook 抛 E_IMPORT_EMPTY）
  assert.equal(detectFormat(Buffer.alloc(0)), 'txt')
}

/** MOBI 走通「解析 → 归一化成书 → 读章节」的完整接缝。 */
async function parsesMobiThroughBookformat() {
  const html = [
    '<html><body>',
    '<h1>第一章 出发</h1>',
    '<p>天还没亮，他就出门了。</p>',
    '<p>路上没有一个人。</p>',
    '<h1>第二章 到达</h1>',
    '<p>傍晚的时候，他到了。</p>',
    '</body></html>',
  ].join('')
  const bytes = buildMinimalMobi({ html, title: '出发与到达', author: '某作者' })

  const book = await parseBook(bytes, {
    filename: 'sample.azw3',
    deviceId: 'dev-000000',
    now: '2026-10-22T00:00:00.000Z',
  })

  assert.equal(book.meta.format, 'mobi-converted', 'MOBI 必须被标成重排书')
  assert.equal(book.meta.sourceFormat, 'azw3', '扩展名要能区分 azw3 与 mobi')
  assert.equal(book.meta.title, '出发与到达')
  assert.equal(book.meta.author, '某作者')
  assert.equal(book.meta.converterVersion, 'mobi/1')
  assert.equal(book.meta.spine.length, 2, '两个 h1 应切成两章')
  assert.equal(book.meta.spine[0].href, 'text/ch001.xhtml')
  assert.equal(book.coverHref, null, '重排书没有封面')

  const html1 = await book.chapterHtml('text/ch001.xhtml')
  assert.ok(html1.includes('天还没亮'), `第一章正文缺失：${String(html1).slice(0, 200)}`)
  assert.ok(!/<h1>第一章 出发<\/h1>\s*<h1>/s.test(html1), '章节之间不该串')
  // 章节必须是合法 XML：否则会被当成坏文档，整章白屏
  parseXml(html1)
  assert.equal(await book.chapterHtml('text/ch404.xhtml'), null, '不存在的章节返回 null（转 404）')
  assert.equal(await book.assetBytes('images/a.png'), null, '重排书没有资源')
}

/**
 * 没有 `<h1>` 的书：章名按文字形状推导（Gutenberg 这类书的章名是普通段落）。
 *
 * 这条用例的价值在于它同时验证「该认的认」和「不该认的不认」——
 * 把正文第一句误当章名，目录会变成一列奇怪的句子。
 */
async function derivesChapterLabelsFromParagraphs() {
  const html = [
    '<p>CHAPTER I.</p>',
    '<p>Down the Rabbit-Hole</p>',
    '<p>Alice was beginning to get very tired.</p>',
    '<p>CHAPTER II.</p>',
    '<p>The Pool of Tears</p>',
    '<p>“Curiouser and curiouser!” cried Alice.</p>',
  ].join('')
  const bytes = buildMinimalMobi({ html, title: 'Alice', author: 'Lewis Carroll' })
  const book = await parseBook(bytes, { filename: 'alice.mobi' })
  assert.equal(book.meta.spine.length, 1, '没有 h1 时应整本一章（切章交给段落形态）')
  assert.deepEqual(
    book.toc.map((item) => item.label),
    ['CHAPTER I. Down the Rabbit-Hole'],
    `章名推导错误：${JSON.stringify(book.toc.map((item) => item.label))}`,
  )
  // 推导出来的标题要从正文里摘掉，别让读者看到同样两行
  const chapter = await book.chapterHtml(book.spine[0].href)
  assert.ok(!chapter.includes('Down the Rabbit-Hole</p>'), '标题段本不该继续留在正文里')
  assert.ok(chapter.includes('Alice was beginning'), '正文不能被吃掉')

  // 正文第一句不能当章名
  const plain = buildMinimalMobi({ html: '<p>他说，走吧。</p><p>天亮了。</p>', title: 'X' })
  const plainBook = await parseBook(plain, { filename: 'x.mobi' })
  assert.equal(plainBook.toc[0].label, '第 1 章', '以句末标点收尾的句子不许当章名')
}

/** TXT 走同一条接缝，且文件名能当书名用。 */
async function parsesTxtThroughBookformat() {
  const bytes = Buffer.from('第一章 开场\n他说了句什么。\n第二章 收尾\n然后就没有然后了。\n', 'utf8')
  const book = await parseBook(bytes, { filename: '口述史.txt', now: '2026-10-22T00:00:00.000Z' })
  assert.equal(book.meta.format, 'txt-converted')
  assert.equal(book.meta.sourceFormat, 'txt')
  assert.equal(book.meta.title, '口述史', '没有书名时用文件名（去扩展名）')
  assert.equal(book.meta.spine.length, 2)
  const html = await book.chapterHtml('text/ch002.xhtml')
  assert.ok(html.includes('然后就没有然后了'))
}

/** 空输入要给出明确错误，而不是造出一本零章的书。 */
async function rejectsEmptyInput() {
  let caught = null
  try {
    await parseBook(Buffer.alloc(0))
  } catch (error) {
    caught = error
  }
  assert.ok(caught && isAppError(caught), '空输入必须抛 AppError')
  assert.equal(caught.code, 'E_IMPORT_EMPTY')
}

/** 落盘扩展名按源格式走。 */
function mapsExtensions() {
  assert.equal(extensionOf({ format: 'epub', sourceFormat: 'epub' }), 'epub')
  assert.equal(extensionOf({ format: 'mobi-converted', sourceFormat: 'mobi' }), 'mobi')
  assert.equal(extensionOf({ format: 'mobi-converted', sourceFormat: 'azw3' }), 'azw3')
  assert.equal(extensionOf({ format: 'txt-converted', sourceFormat: 'txt' }), 'txt')
}

/** MOBI 的封面要一路透传到重排书：coverHref 与 assetBytes 都得能用。 */
async function passesMobiCoverThrough() {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    Buffer.from('封面尾巴'),
  ])
  const bytes = buildMinimalMobi({
    html: '<h1>封面透传</h1><p>正文。</p>',
    title: '封面透传',
    cover: { bytes: jpeg, coverOffset: 0 },
  })

  const book = await parseBook(bytes, { filename: 'cover.mobi', now: '2026-10-23T00:00:00.000Z' })

  assert.equal(book.coverHref, 'cover.jpg')
  assert.equal(book.meta.coverHref, 'cover.jpg', 'meta.coverHref 是书架取封面的依据')
  const data = await book.assetBytes(book.meta.coverHref)
  assert.ok(data instanceof Uint8Array, 'assetBytes(coverHref) 必须返回字节')
  assert.deepEqual(Buffer.from(data), jpeg)
  assert.equal(data.mediaType, 'image/jpeg', '封面路由按 mediaType 写 Content-Type')
  assert.equal(await book.assetBytes('images/a.png'), null, '不存在的资源仍是 null')
}

export default async function run() {
  const cases = [
    ['魔数判定', detectsByMagic],
    ['MOBI 接缝', parsesMobiThroughBookformat],
    ['章名推导', derivesChapterLabelsFromParagraphs],
    ['TXT 接缝', parsesTxtThroughBookformat],
    ['空输入', rejectsEmptyInput],
    ['扩展名映射', mapsExtensions],
    ['MOBI 封面透传', passesMobiCoverThrough],
  ]
  let passed = 0
  for (const [name, fn] of cases) {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  }
  console.log(`bookformat: ${passed} 项通过`)
}
