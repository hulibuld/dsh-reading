/**
 * TXT 解析测试（lib/txt.js + lib/textbook.js）。
 *
 * 关注四件事：
 *   1. 编码判定（UTF-8 / UTF-8 BOM / UTF-16LE BOM / GB18030）——中文 TXT 的实际风险点；
 *   2. 二进制冒充 txt 要被拦住，而不是解出一屏乱码；
 *   3. 切章规则（第 X 章、序言、无标题按长度切）；
 *   4. 生成的章节必须是**合法的 XHTML**——阅读器按 application/xhtml+xml 送进
 *      iframe，一个没闭合的 `<p>` 会让整章空白，而不是「显示得难看」。
 */

import assert from 'node:assert/strict'
import { decodePlainText, looksLikeText, splitChapters, chunkByLength, parseTxt } from '../lib/txt.js'
import { buildChapterXhtml, buildReflowedBook, escapeXmlText } from '../lib/textbook.js'
import { detectFormat, sourceFormatOf, extensionOf } from '../lib/bookformat.js'
import { parseXml } from '../lib/xml.js'
import { isAppError } from '../lib/errors.js'

/** 断言抛出指定 code 的 AppError。 */
function expectCode(fn, code) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `期望抛出 ${code}，实际没有抛错`)
  assert.ok(isAppError(caught), `期望 AppError，实际 ${caught && caught.name}`)
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught.code}`)
}

/** GB18030 编码的「你好，世界」——用来验证回退解码真的走对了编码。 */
const GB18030_SAMPLE = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7])

/** UTF-16LE 带 BOM 的编码器（Node 只有 UTF-8 的 TextEncoder）。 */
function encodeUtf16le(text) {
  const body = Buffer.alloc(text.length * 2)
  for (let i = 0; i < text.length; i += 1) body.writeUInt16LE(text.charCodeAt(i), i * 2)
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body])
}

/** 编码判定。 */
function decodesKnownEncodings() {
  const utf8 = Buffer.from('第一章 起风了\n他说，走吧。\n', 'utf8')
  assert.equal(decodePlainText(utf8).encoding, 'utf-8')
  assert.ok(decodePlainText(utf8).text.includes('起风了'))

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])
  const bomResult = decodePlainText(withBom)
  assert.equal(bomResult.encoding, 'utf-8')
  // BOM 必须被吃掉，否则它会变成正文里一个看不见的字符，还会让第一行标题切不出来。
  assert.ok(!bomResult.text.startsWith('\uFEFF'))

  const utf16 = encodeUtf16le('你好，世界\n第二行\n')
  const utf16Result = decodePlainText(utf16)
  assert.equal(utf16Result.encoding, 'utf-16le')
  assert.equal(utf16Result.text, '你好，世界\n第二行\n')

  // GB18030：UTF-8 严格解码会失败，必须回退。
  assert.equal(decodePlainText(GB18030_SAMPLE).text, '你好，世界')

  expectCode(() => decodePlainText(Buffer.alloc(0)), 'E_TXT_DECODE_FAILED')
  // 0xFF 0xFF 既不是合法 UTF-8 也不是合法 GB18030 起始字节对
  expectCode(() => decodePlainText(Buffer.from([0xff, 0xff, 0xff])), 'E_TXT_DECODE_FAILED')
}

/** 二进制冒充 txt。 */
function rejectsBinaryFiles() {
  const binary = Buffer.alloc(400)
  for (let i = 0; i < binary.length; i += 1) binary[i] = i % 32 // 大量控制字符
  assert.equal(looksLikeText(binary.toString('latin1')), false)
  // 真正的文本必须放行，别把正常中文当二进制。
  assert.equal(looksLikeText('第一行\n第二行\n你好'), true)
}

/** 切章：第 X 章 / 序言 / 卷。 */
function splitsByHeadings() {
  const text = [
    '书名页',
    '',
    '序言',
    '这是序言的第一段。',
    '这是序言的第二段。',
    '',
    '第一章 起风了',
    '第一章的正文。',
    '',
    '第二章 雨停了',
    '第二章的正文。',
    '',
    '尾声',
    '结束。',
  ].join('\n')

  const chapters = splitChapters(text)
  // 第一个标题之前的「书名页」自成一章，没标题就按序号命名（不能丢内容）。
  assert.deepEqual(
    chapters.map((c) => c.label),
    ['第 1 部分', '序言', '第一章 起风了', '第二章 雨停了', '尾声'],
  )
  assert.deepEqual(chapters[0].paragraphs, ['书名页'])
  assert.equal(chapters[2].paragraphs.length, 1)
  // 标题行本身不能混进正文
  assert.ok(!chapters[2].paragraphs.some((p) => p.includes('第一章 起风了')))
  // 第一章之前的「书名页」不能丢
  assert.ok(chapters[0].paragraphs.includes('书名页') || chapters.some((c) => c.paragraphs.includes('书名页')))
}

/** 硬折行（一行一段，甚至一行三个字）必须合回真段落。 */
function mergesWrappedLines() {
  // 下载站常见的 TXT：每行都硬换行，且断在句中断开的位置
  const text = [
    '第一章 起风了',
    '那天下午',
    '风从窗缝里',
    '钻进来，把桌',
    '上的纸吹得满屋',
    '都是。',
    '他站起来关窗，',
    '发现玻璃上',
    '结了一层薄霜。',
    '',
    '第二段从空行',
    '开始，这里没有',
    '句末标点',
  ].join('\n')

  const chapters = splitChapters(text)
  const body = chapters[0].paragraphs
  // 断在逗号/顿号后的行必须接上，不能变成七零八落的短行
  assert.equal(body[0], '那天下午风从窗缝里钻进来，把桌上的纸吹得满屋都是。')
  assert.equal(body[1], '他站起来关窗，发现玻璃上结了一层薄霜。')
  // 空行是硬分段信号：即使上一段没断句也要分开
  assert.equal(body[2], '第二段从空行开始，这里没有句末标点')
  assert.equal(body.length, 3)

  // 诗行每行都以标点收尾 → 不会被合并成一大坨
  const verse = splitChapters(['床前明月光，', '疑是地上霜。', '举头望明月，'].join('\n'))
  assert.deepEqual(verse[0].paragraphs, ['床前明月光，', '疑是地上霜。', '举头望明月，'])
}

/** 一刀切不出来时按长度切。 */
function chunksLongPlainText() {
  const paragraph = '这是一句用来凑字数的中文，长度大约二十个字左右。'
  const paragraphs = Array.from({ length: 800 }, () => paragraph)
  const chapters = chunkByLength(paragraphs)
  assert.ok(chapters.length > 1, '40 万字的长文必须被切成多段')
  for (const chapter of chapters) {
    assert.ok(chapter.paragraphs.length > 0)
    const size = chapter.paragraphs.reduce((sum, p) => sum + p.length, 0)
    // 单段就超过 8000 字的情况不存在（每段才 27 字），所以每章都该在上限附近
    assert.ok(size <= 8200, `单章 ${size} 字，超过 8000 上限`)
  }
  assert.deepEqual(chapters.map((c) => c.label), chapters.map((_, i) => `第 ${i + 1} 部分`))
}

/** 没有任何标题的纯文本也要能读，且不能变成单章几十万字。 */
function parsesHeadinglessTxt() {
  const lines = []
  for (let i = 0; i < 1200; i += 1) lines.push(`第 ${i + 1} 行正文，讲的是很平常的事情。`)
  const bytes = Buffer.from(lines.join('\n'), 'utf8')
  const book = parseTxt(bytes, { filename: '无标题.txt', deviceId: 'dev-000000', now: '2026-01-01T00:00:00.000Z' })

  assert.equal(book.meta.format, 'txt-converted')
  assert.equal(book.meta.sourceFormat, 'txt')
  assert.equal(book.meta.encoding, 'utf-8')
  assert.equal(book.meta.title, '无标题', '没有书名时回退到文件名')
  assert.ok(book.spine.length > 1, '无标题长文必须被切成多章')
  assert.deepEqual(book.spine.map((s) => s.index), book.spine.map((_, i) => i))
  // 0.4.0 起：硬切出来的分块不是目录，toc 必须是空数组（用户要求纯文本不加章节跳转）
  assert.equal(book.meta.tocSource, 'none')
  assert.deepEqual(book.toc, [], '没有目录就返回空数组，不能硬塞「第 N 部分」')
}

/** 每一章生成的 XHTML 都必须能被 XML 解析器吃掉（这一条能抓住整章空白的 bug）。 */
async function chaptersAreWellFormedXhtml() {
  const text = [
    '第一章 特殊字符',
    '这里有 <尖括号> 与 & 符号，还有 "引号"。',
    '第二段：1 < 2 && 3 > 2。',
    '',
    '第二章 空段落',
    '只有一段。',
  ].join('\n')
  const book = parseTxt(Buffer.from(text, 'utf8'), { filename: '特殊字符.txt' })

  let sawEscapedBrackets = false
  for (const entry of book.spine) {
    const html = await book.chapterHtml(entry.href)
    assert.ok(typeof html === 'string' && html.length > 0, `${entry.href} 读不到内容`)
    // 不抛错即为合法 XML；抛错这里会红。
    const doc = parseXml(html)
    assert.ok(doc, '解析结果不能为空')
    // 转义必须真的生效：整本书的任何一章都不许出现裸的尖括号标签
    assert.ok(!html.includes('<尖括号>'), '不允许出现未转义的尖括号')
    if (html.includes('尖括号')) sawEscapedBrackets = html.includes('&lt;尖括号&gt;')
  }
  assert.ok(sawEscapedBrackets, '正文里的尖括号必须被转义成实体')
}

/** escapeXmlText 不能被二次转义坑到。 */
function escapesOnlyOnce() {
  assert.equal(escapeXmlText('a & b'), 'a &amp; b')
  assert.equal(escapeXmlText('&amp;'), '&amp;amp;') // 入参是纯文本，'&amp;' 是字面量
  assert.equal(escapeXmlText('x\u0000y\u0007z'), 'xyz') // 控制字符必须被抹掉
}

/** 落盘扩展名与格式判定。 */
function detectsFormats() {
  const epubMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
  assert.equal(detectFormat(epubMagic), 'epub')

  // PalmDB 头：仅造出判定所需的最小字段
  const mobi = Buffer.alloc(80)
  mobi.write('BOOKMOBI', 60, 'latin1')
  assert.equal(detectFormat(mobi), 'mobi')
  mobi.write('TEXtREAD', 60, 'latin1')
  assert.equal(detectFormat(mobi), 'mobi')

  assert.equal(detectFormat(Buffer.from('第一章\n正文\n', 'utf8')), 'txt')

  assert.equal(sourceFormatOf('a.azw3', 'mobi'), 'azw3')
  assert.equal(sourceFormatOf('a.azw', 'mobi'), 'azw3')
  assert.equal(sourceFormatOf('a.mobi', 'mobi'), 'mobi')
  assert.equal(sourceFormatOf('a.txt', 'txt'), 'txt')

  assert.equal(extensionOf({ format: 'epub', sourceFormat: 'epub' }), 'epub')
  assert.equal(extensionOf({ format: 'txt-converted', sourceFormat: 'txt' }), 'txt')
  assert.equal(extensionOf({ format: 'mobi-converted', sourceFormat: 'azw3' }), 'azw3')
  // 老书没有 sourceFormat 时按 format 兜底
  assert.equal(extensionOf({ format: 'mobi-converted' }), 'mobi')
}

/** 重排书没有资源：asset / cover / resolveRelative 都必须是 null 而不是抛错。 */
async function reflowedBookHasNoAssets() {
  const book = buildReflowedBook({
    chapters: [{ label: '第一章', paragraphs: ['正文'] }],
    title: '测试书',
    author: '某人',
    format: 'txt-converted',
    sourceFormat: 'txt',
    bytes: Buffer.from('whatever'),
    now: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(book.coverHref, null)
  assert.equal(await book.assetBytes('images/a.png'), null)
  assert.equal(book.resolveRelative('text/ch001.xhtml', '../images/a.png'), null)
  assert.equal(await book.chapterHtml('text/nope.xhtml'), null)
  assert.equal(book.hasEntry('text/ch001.xhtml'), true)
  assert.equal(book.meta.author, '某人')
  assert.equal(book.meta.converterVersion, 'text/1')

  // 空书必须报 E_BOOK_EMPTY，而不是造出一本零章的书（客户端会崩在分页上）
  expectCode(
    () => buildReflowedBook({ chapters: [], title: '空', format: 'txt-converted', sourceFormat: 'txt', bytes: Buffer.from('x') }),
    'E_BOOK_EMPTY',
  )
}

/** 章节标题缺省时的兜底命名。 */
function namesUntitledChapters() {
  const xhtml = buildChapterXhtml('第 1 章', ['段落'])
  assert.ok(xhtml.includes('<title>第 1 章</title>'))
  assert.ok(xhtml.includes('<h1>第 1 章</h1>'))
}

/**
 * 目录来源标记（0.4.0，施工图 §6）。
 *
 * 这条标记决定界面挂不挂「自动识别」角标、以及要不要把「第 N 部分」当目录列出来：
 *   - 识别到 ≥2 个真标题 → auto（界面挂「自动识别」角标），目录照给；
 *   - 一个标题都没有、或只有一个 → none，toc 为空（硬切不是目录）。
 */
function marksTocSource() {
  const headed = parseTxt(Buffer.from('第一章 起风\n\n正文一。\n\n第二章 天黑\n\n正文二。\n', 'utf8'), {
    filename: '标题.txt',
  })
  assert.equal(headed.meta.tocSource, 'auto', '两个真标题要记成 auto（自动识别）')
  assert.equal(headed.tocSource, 'auto', '返回值也要带出来，bookformat 要透传')
  assert.deepEqual(
    headed.toc.map((item) => item.label),
    ['第一章 起风', '第二章 天黑'],
  )

  // 只有一条标题不构成目录（列表只有一项，界面不如不显示）
  const single = parseTxt(Buffer.from('第一章 独苗\n\n正文。\n', 'utf8'), { filename: '单条.txt' })
  assert.equal(single.meta.tocSource, 'none')

  // 完全没有标题 → 按字数硬切
  const plain = parseTxt(Buffer.from('没有任何章节标题的正文。'.repeat(30), 'utf8'), { filename: '无标题.txt' })
  assert.equal(plain.meta.tocSource, 'none')
  assert.deepEqual(plain.toc, [], '硬切出来的章节不是目录')

  // 「第一章的正文就这么开始了」是句子，不是标题，不能被当成 headings
  const sentence = parseTxt(Buffer.from('第一章的正文就这么开始了。\n\n继续往下写。\n', 'utf8'), {
    filename: '句子.txt',
  })
  assert.equal(sentence.meta.tocSource, 'none')
}

export default async function run() {
  let passed = 0
  const cases = [
    ['编码判定', decodesKnownEncodings],
    ['拒绝二进制', rejectsBinaryFiles],
    ['按标题切章', splitsByHeadings],
    ['硬折行合并成真段落', mergesWrappedLines],
    ['按长度切段', chunksLongPlainText],
    ['无标题 TXT', parsesHeadinglessTxt],
    ['章节 XHTML 合法', chaptersAreWellFormedXhtml],
    ['只转义一次', escapesOnlyOnce],
    ['格式判定', detectsFormats],
    ['重排书无资源', reflowedBookHasNoAssets],
    ['无标题章节命名', namesUntitledChapters],
    ['目录来源标记', marksTocSource],
  ]
  for (const [name, fn] of cases) {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  }
  console.log(`txt: ${passed} 项通过`)
}
