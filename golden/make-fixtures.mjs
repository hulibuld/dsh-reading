#!/usr/bin/env node
/**
 * 现场生成 golden 用的 8 本 EPUB。
 *
 * 为什么现场生成而不是提交 .epub：二进制产物会让 review 看不见「书里到底有什么」，
 * 而且改一处正文就得重传一个二进制 diff。脚本才是真源，`.epub` 进 .gitignore。
 *
 * 为什么自己写 ZIP（golden/zip-lite.mjs）而不是 JSZip：见那个文件的头注释。
 *
 * 产物：
 *   golden/fixtures/<name>.epub        8 本，store-only，字节级可复现（固定 mtime）
 *   golden/fixtures/<name>.spine.json  该书 spine 表（run.mjs 用来校验 vector 里的 spineIndex/idref）
 *
 * 用法：node golden/make-fixtures.mjs [--check]
 *   --check 只校验脚本自洽与产物已存在，不重写文件。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip } from './zip-lite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(HERE, 'fixtures')

const XHTML_HEAD = (title) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head>`

/**
 * 8 本书。每本两章。
 *
 * 写这些正文时守着两条：**结构固定**（向量里的路径才有意义）、**覆盖 docs/03 §一 的
 * 七种基础形状 + 真实书里常见的脏结构**（ruby、脚注角标、双向文字、CDATA、空元素）。
 * 原文一律不带缩进——缩进会变成文本节点，把每个路径都往后挪一位，向量就没法手写核对了。
 */
export const BOOKS = {
  'nested-inline': {
    title: '深层内联嵌套',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: '三成 div + p + em/strong',
        body: '<body>'
          + '<div id="d1"><div id="d2"><p id="z">abc<em id="em1">de<strong id="st1">fg</strong>hi</em>jk</p></div></div>'
          + '<p id="p4">a<em>b<strong>c</strong>d</em>e</p>'
          + '<p id="p5">plain paragraph</p>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: '兄弟元素与空 div',
        body: '<body>'
          + '<div id="w1"><p id="a1">alpha</p><p id="a2">beta</p><p id="a3">gamma</p></div>'
          + '<div id="w2"><section id="s1"><p id="b1">delta</p></section><div id="empty"></div></div>'
          + '</body>',
      },
    ],
  },
  'adjacent-text': {
    title: '相邻文本与注释',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: '文本被元素与注释切断',
        body: '<body>'
          + '<p id="p2">ab<span>cd</span>ef<!--c-->gh</p>'
          + '<p id="p2b">甲<em>乙</em>丙<em>丁</em>戊</p>'
          + '<p id="p2c">one<!--x-->two<!--y-->three</p>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: '两段之间夹注释',
        body: '<body>'
          + '<div id="box"><!--lead--><span id="sp1">first</span>tail</div>'
          + '<p id="p2d">尾巴<em>中</em>头</p>'
          + '</body>',
      },
    ],
  },
  'empty-elements': {
    title: '空元素改变 chunk 边界',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: 'br / img / 空 span',
        body: '<body>'
          + '<p id="p3">x<span></span>y</p>'
          + '<p id="p3b">abc<i id="i1"></i>def</p>'
          + '<div id="wrap">a<br/>b<img src="../images/dot.png" alt="dot"/>c</div>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: '连续空元素',
        body: '<body>'
          + '<p id="p3c">前<hr/><span></span>后</p>'
          + '<p id="p3d">only text</p>'
          + '</body>',
      },
    ],
  },
  cdata: {
    title: 'CDATA 段',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: 'CDATA 与文本相邻',
        body: '<body>'
          + '<p id="cd">abc<![CDATA[def]]>ghi</p>'
          + '<p id="cd2"><![CDATA[全部是 CDATA]]></p>'
          + '<p id="cd3">文本<![CDATA[<not-a-tag>]]>尾巴</p>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: 'CDATA 落在元素里',
        body: '<body>'
          + '<div id="cdbox"><p id="cd4">甲<![CDATA[乙丙]]>丁</p><p id="cd5">plain</p></div>'
          + '</body>',
      },
    ],
  },
  'ruby-rt': {
    title: '注音 ruby',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: 'ruby / rt / rp',
        body: '<body>'
          + '<p id="r1"><ruby>漢<rt>kan</rt></ruby>字<ruby>読<rt>yomu</rt></ruby>む</p>'
          + '<p id="r2"><ruby>東<rp>(</rp><rt>とう</rt><rp>)</rp></ruby>京</p>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: 'ruby 与普通文本混排',
        body: '<body>'
          + '<div id="rbox"><p id="r3">前<ruby>花<rt>はな</rt></ruby>後</p>'
          + '<p id="r4">plain after ruby</p></div>'
          + '</body>',
      },
    ],
  },
  rtl: {
    title: '双向文字',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: '希伯来语与阿拉伯语',
        body: '<body>'
          + '<div id="rtl1" dir="rtl"><p id="rp1">שלום עולם</p><p id="rp2">مرحبا بالعالم</p></div>'
          + '<p id="ltr1" dir="ltr">left to right</p>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: '双向混排',
        body: '<body>'
          + '<p id="rmix" dir="rtl">עברית English 中文</p>'
          + '<p id="rnum" dir="rtl">١٢٣ 456</p>'
          + '</body>',
      },
    ],
  },
  'footnote-refs': {
    title: '脚注角标',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: '正文角标 + 尾注',
        body: '<body>'
          + '<p id="fn1">正文一<a id="ref1" href="#note1" epub:type="noteref">1</a>继续</p>'
          + '<p id="fn2">正文二<a id="ref2" href="#note2" epub:type="noteref">2</a>，还有<em>强调</em>。</p>'
          + '<aside id="notes" epub:type="footnotes">'
          + '<p id="note1">注一：说明文字</p><p id="note2">注二：另一段说明</p>'
          + '</aside>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: '角标在段尾',
        body: '<body>'
          + '<p id="fn3">整段结束处<a id="ref3" href="#note3" epub:type="noteref">3</a></p>'
          + '<aside id="notes2"><p id="note3">注三</p></aside>'
          + '</body>',
      },
    ],
  },
  'emoji-cjk-b': {
    title: 'emoji 与中文',
    author: 'fixture',
    chapters: [
      {
        href: 'text/ch1.xhtml',
        idref: 'ch1',
        title: 'ZWJ 家庭 emoji',
        body: '<body>'
          + '<p id="m">前👨‍👩‍👧后</p>'
          + '<p id="cjk">中文测试标记位置</p>'
          + '<p id="mix">a👨‍👩‍👧b中文c🇨🇳d</p>'
          + '</body>',
      },
      {
        href: 'text/ch2.xhtml',
        idref: 'ch2',
        title: '组合字符与变体选择符',
        body: '<body>'
          + '<p id="comb">e\u0301 vs é</p>'
          + '<p id="vs">❤️ 与 ❤ 与 👍🏽</p>'
          + '</body>',
      },
    ],
  },
}

const CHAPTER_FILES = {
  'styles/book.css': 'body{margin:0}\n',
  'images/dot.png': Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735c1e60000000049454e44ae426082',
    'hex',
  ),
}

const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`

const opfXml = (book) => `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${book.slug}-fixture</dc:identifier>
    <dc:title>${book.title}</dc:title>
    <dc:creator>${book.author}</dc:creator>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
${book.chapters.map(c => `    <item id="${c.idref}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${book.chapters.map(c => `    <itemref idref="${c.idref}"/>`).join('\n')}
  </spine>
</package>
`

const navXml = (book) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><ol>
${book.chapters.map(c => `<li><a href="${c.href}">${c.title}</a></li>`).join('\n')}
</ol></nav></body>
</html>
`

const chapterXml = (chapter) => `${XHTML_HEAD(chapter.title)}
${chapter.body}
</html>
`

/** 一本书 → zip 条目列表（顺序固定：mimetype 必须第一个且不压缩）。 */
export function buildEpubEntries(name, book) {
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: containerXml },
    { name: 'OEBPS/content.opf', data: opfXml({ ...book, slug: name }) },
    { name: 'OEBPS/nav.xhtml', data: navXml(book) },
    { name: 'OEBPS/styles/book.css', data: CHAPTER_FILES['styles/book.css'] },
    { name: 'OEBPS/images/dot.png', data: CHAPTER_FILES['images/dot.png'] },
  ]
  for (const chapter of book.chapters) {
    entries.push({ name: `OEBPS/${chapter.href}`, data: chapterXml(chapter) })
  }
  return entries
}

/** 这本书的 spine 表（0 起），写完给 run.mjs 当交叉校验依据。 */
export function spineOf(book) {
  return book.chapters.map((chapter, index) => ({
    index,
    idref: chapter.idref,
    href: chapter.href,
    title: chapter.title,
  }))
}

export function buildAll() {
  const out = new Map()
  for (const [name, book] of Object.entries(BOOKS)) {
    out.set(name, {
      epub: writeZip(buildEpubEntries(name, book), { date: new Date(Date.UTC(2020, 0, 1)) }),
      spine: spineOf(book),
    })
  }
  return out
}

const main = () => {
  const check = process.argv.includes('--check')
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const all = buildAll()
  let bytes = 0
  for (const [name, { epub, spine }] of all) {
    const epubPath = join(FIXTURE_DIR, `${name}.epub`)
    const spinePath = join(FIXTURE_DIR, `${name}.spine.json`)
    const spineText = `${JSON.stringify({ fixture: name, spine }, null, 2)}\n`
    bytes += epub.length
    if (check) {
      if (!existsSync(epubPath)) throw new Error(`--check: 缺 ${epubPath}，先不带 --check 跑一次`)
      if (!readFileSync(epubPath).equals(epub)) {
        throw new Error(`--check: ${name}.epub 与脚本产出不一致（脚本改过但没重新生成）`)
      }
      if (readFileSync(spinePath, 'utf8') !== spineText) {
        throw new Error(`--check: ${name}.spine.json 与脚本不一致`)
      }
    } else {
      writeFileSync(epubPath, epub)
      writeFileSync(spinePath, spineText)
    }
    console.log(`${check ? 'CHECK' : 'WROTE'} ${name}.epub (${epub.length} bytes, ${spine.length} 章)`)
  }
  console.log(`\n${check ? '校验通过' : '生成完成'}：${all.size} 本，合计 ${bytes} 字节 → ${FIXTURE_DIR}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
