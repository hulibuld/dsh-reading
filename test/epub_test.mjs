/**
 * lib/epub.js 的测试。
 *
 * fixture 策略（docs/05 §7 G1）：`golden/fixtures/*.epub` 存在就全部解析一遍，
 * 不存在就用测试内自造的 3 本。测试**不依赖 golden 目录的生成脚本**，这样
 * 宿主侧测试可以独立跑；同时 golden 的 8 本一旦生成，本文件自动把它们纳入回归。
 *
 * 8 本 fixture 的名字与 docs/02 §3 一致：nested-inline / adjacent-text / empty-elements /
 * cdata / ruby / rtl / footnotes / emoji-cjk-b。这里不假定每本的具体内容，只断言
 * 「spine 顺序与 toc 自洽」这类结构性质；自造的 3 本则断言精确内容。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip } from '../lib/zip.js'
import { parseEpub, normalizeHref, resolveHref, mediaTypeFor } from '../lib/epub.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(HERE, '..', 'golden', 'fixtures')

// 8 本 fixture 的名字以 golden/make-fixtures.mjs 实际产出的为准（docs/02 §3 的中文清单
// 与文件名不完全同名，这里跟磁盘上的真名对齐，避免「明明有 8 本却说缺 1 本」）。
const FIXTURE_NAMES = [
  'nested-inline',
  'adjacent-text',
  'empty-elements',
  'cdata',
  'ruby-rt',
  'rtl',
  'footnote-refs',
  'emoji-cjk-b',
]

/** 造一个最小但完整的 EPUB（mimetype → container.xml → OPF → NCX/nav → 章节）。 */
function makeEpub({
  title = '测试书',
  author = '作者',
  chapters = [{ id: 'ch1', href: 'text/ch1.xhtml', label: '第一章', body: '<p>正文</p>' }],
  nav = true,
  ncx = false,
  extraEntries = [],
  opfDir = 'OEBPS',
  cover = null,
} = {}) {
  const entries = [{ name: 'mimetype', data: 'application/epub+zip' }]
  const opfPath = opfDir === '' ? 'content.opf' : `${opfDir}/content.opf`

  entries.push({
    name: 'META-INF/container.xml',
    data:
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      `<rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  })

  const manifestItems = chapters
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join('')
  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('')

  let navItem = ''
  if (nav) {
    navItem = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    const navDir = opfDir === '' ? '' : opfDir
    const navHref = (c) => (navDir === '' ? c.href : c.href)
    entries.push({
      name: navDir === '' ? 'nav.xhtml' : `${navDir}/nav.xhtml`,
      data:
        '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
        '<head><title>nav</title></head><body><nav epub:type="toc"><ol>' +
        chapters
          .map((c) => `<li><a href="${navHref(c)}">${c.label}</a></li>`)
          .join('') +
        '</ol></nav></body></html>',
    })
  }

  let ncxItem = ''
  if (ncx) {
    ncxItem = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    entries.push({
      name: opfDir === '' ? 'toc.ncx' : `${opfDir}/toc.ncx`,
      data:
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>' +
        chapters
          .map(
            (c, i) =>
              `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${c.label}</text></navLabel><content src="${c.href}"/></navPoint>`,
          )
          .join('') +
        '</navMap></ncx>',
    })
  }

  let coverItem = ''
  let coverMeta = ''
  if (cover) {
    coverItem = `<item id="cover-image" href="${cover.href}" media-type="${cover.mediaType}" properties="cover-image"/>`
    coverMeta = ''
    entries.push({ name: opfDir === '' ? cover.href : `${opfDir}/${cover.href}`, data: cover.bytes })
  }

  entries.push({
    name: opfPath,
    data:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>zh</dc:language>` +
      (coverMeta ? coverMeta : '') +
      '</metadata>' +
      `<manifest>${manifestItems}${navItem}${ncxItem}${coverItem}</manifest>` +
      `<spine${ncx ? ' toc="ncx"' : ''}>${spineItems}</spine>` +
      '</package>',
  })

  for (const chapter of chapters) {
    entries.push({
      name: opfDir === '' ? chapter.href : `${opfDir}/${chapter.href}`,
      data:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch</title></head>' +
        `<body>${chapter.body}</body></html>`,
    })
  }

  for (const extra of extraEntries) entries.push(extra)
  return writeZip(entries)
}

/** 期望某个异步调用抛指定 code。 */
async function expectCode(code, fn) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `期望抛 ${code}，但什么都没抛`)
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught.code}（${caught.message}）`)
  return caught
}

export default async function run() {
  // ── 1. 基本解析 ──
  const bytes = makeEpub({
    title: '三体',
    author: '刘慈欣',
    chapters: [
      { id: 'ch1', href: 'text/ch1.xhtml', label: '第一章 科学边界', body: '<p>汪淼</p>' },
      { id: 'ch2', href: 'text/ch2.xhtml', label: '第二章 台球', body: '<p>台球</p>' },
      { id: 'ch3', href: 'text/ch3.xhtml', label: '第三章 射手', body: '<p>射手</p>' },
    ],
    cover: { href: 'images/cover.png', mediaType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  })
  const book = await parseEpub(bytes, { deviceId: 'mac-abc123', now: '2026-10-22T00:00:00.000Z', filename: '三体.epub' })

  assert.equal(book.meta.schema, 'dsh-reading/1')
  assert.equal(book.meta.title, '三体')
  assert.equal(book.meta.author, '刘慈欣')
  assert.equal(book.meta.format, 'epub')
  assert.equal(book.meta.converterVersion, 'epub/1')
  assert.equal(book.meta.bookHash.length, 64)
  assert.match(book.meta.bookHash, /^[0-9a-f]{64}$/)
  assert.equal(book.meta.deviceId, 'mac-abc123')
  assert.equal(book.meta.fileSize, bytes.length)
  assert.equal(book.meta.language, 'zh')
  assert.equal(book.coverHref, 'images/cover.png')

  // spine 顺序 = itemref 顺序，索引从 0 连续
  assert.deepEqual(
    book.spine.map((s) => s.href),
    ['text/ch1.xhtml', 'text/ch2.xhtml', 'text/ch3.xhtml'],
  )
  assert.deepEqual(
    book.spine.map((s) => s.idref),
    ['ch1', 'ch2', 'ch3'],
  )
  assert.deepEqual(
    book.spine.map((s) => s.index),
    [0, 1, 2],
  )
  assert.deepEqual(
    book.meta.spine.map((s) => s.href),
    ['text/ch1.xhtml', 'text/ch2.xhtml', 'text/ch3.xhtml'],
  )

  // toc 来自 nav.xhtml，spineIndex 要归位
  assert.equal(book.toc.length, 3)
  assert.equal(book.toc[0].label, '第一章 科学边界')
  assert.equal(book.toc[0].href, 'text/ch1.xhtml')
  assert.equal(book.toc[0].spineIndex, 0)
  assert.equal(book.toc[1].spineIndex, 1)
  assert.equal(book.toc[2].spineIndex, 2)
  assert.equal(book.toc[0].depth, 0)

  // 章节正文原样返回（含 XML 声明，一个字节都不改）
  const html = await book.chapterHtml('text/ch1.xhtml')
  assert.ok(html.startsWith('<?xml version="1.0" encoding="utf-8"?>'), 'XML 声明必须原样保留')
  assert.ok(html.includes('<p>汪淼</p>'))
  assert.equal(await book.chapterHtml('text/nope.xhtml'), null, '不存在的章节返回 null，不抛错')

  // 封面字节能取到
  const cover = await book.assetBytes('images/cover.png')
  assert.deepEqual(cover.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.equal(cover.mediaType, 'image/png')

  // ── 2. NCX 回退（没有 nav 的 EPUB2） ──
  const ncxBook = await parseEpub(
    makeEpub({
      nav: false,
      ncx: true,
      chapters: [
        { id: 'a', href: 'text/a.xhtml', label: '甲', body: '<p>a</p>' },
        { id: 'b', href: 'text/b.xhtml', label: '乙', body: '<p>b</p>' },
      ],
    }),
    { deviceId: 'mac-abc123' },
  )
  assert.deepEqual(
    ncxBook.toc.map((t) => t.label),
    ['甲', '乙'],
  )
  assert.deepEqual(
    ncxBook.toc.map((t) => t.spineIndex),
    [0, 1],
  )

  // ── 3. 没有 nav 也没有 NCX：回退成 spine 目录（不能让阅读器没目录） ──
  const bareBook = await parseEpub(
    makeEpub({
      nav: false,
      chapters: [
        { id: 'only', href: 'text/only.xhtml', label: '唯一', body: '<p>only</p>' },
      ],
    }),
    { deviceId: 'mac-abc123' },
  )
  assert.equal(bareBook.toc.length, 1)
  assert.equal(bareBook.toc[0].href, 'text/only.xhtml')
  assert.equal(bareBook.toc[0].spineIndex, 0)

  // ── 4. OPF 在根目录（opfDir=''）时 href 不能带前缀 ──
  const rootOpf = await parseEpub(
    makeEpub({
      opfDir: '',
      nav: false,
      chapters: [{ id: 'c', href: 'ch1.xhtml', label: '一', body: '<p>一</p>' }],
    }),
    { deviceId: 'mac-abc123' },
  )
  assert.equal(rootOpf.spine[0].href, 'ch1.xhtml')
  assert.equal(rootOpf.toc[0].href, 'ch1.xhtml')
  assert.ok((await rootOpf.chapterHtml('ch1.xhtml')).includes('<p>一</p>'))

  // ── 5. 加密 → E_EPUB_ENCRYPTED ──
  const encrypted = makeEpub({
    extraEntries: [
      {
        name: 'META-INF/encryption.xml',
        data:
          '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" ' +
          'xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="aes"/></enc:EncryptedData></encryption>',
      },
    ],
  })
  await expectCode('E_EPUB_ENCRYPTED', () => parseEpub(encrypted, { deviceId: 'mac-abc123' }))

  // 有 encryption.xml 但没有 EncryptedData（只是字体混淆的声明位）→ 放行
  const harmlessEncryption = makeEpub({
    extraEntries: [
      {
        name: 'META-INF/encryption.xml',
        data: '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>',
      },
    ],
  })
  const allowed = await parseEpub(harmlessEncryption, { deviceId: 'mac-abc123' })
  assert.equal(allowed.spine.length, 1, '空的 encryption.xml 不该拦下整本书')

  // ── 6. 超限 → E_EPUB_TOO_BIG ──
  // 造一条「声明 64 MB + 1」的中央目录项：不必真生成 64 MB 数据。
  const bomb = (() => {
    const base = makeEpub()
    const copy = Buffer.from(base)
    const eocd = copy.length - 22
    const centralOffset = copy.readUInt32LE(eocd + 16)
    // 把第 0 个中央目录项的 uncompressed size 改成 64MB+1
    copy.writeUInt32LE(64 * 1024 * 1024 + 1, centralOffset + 24)
    return copy
  })()
  await expectCode('E_EPUB_TOO_BIG', () => parseEpub(bomb, { deviceId: 'mac-abc123' }))

  // 条目数超限：真造 20001 个条目。只改 EOCD 的计数而不加条目会让包直接判为损坏
  // （中央目录读不满），测不到条目上限这条分支。每项都是空文件，整包约 1.5 MB。
  const manyEntries = (() => {
    const entries = [{ name: 'mimetype', data: 'application/epub+zip' }]
    for (let i = 0; i < 20000; i += 1) entries.push({ name: `pad/${i}.txt`, data: '' })
    return writeZip(entries)
  })()
  await expectCode('E_EPUB_TOO_BIG', () => parseEpub(manyEntries, { deviceId: 'mac-abc123' }))

  // ── 7. 结构缺失的明确错误 ──
  await expectCode('E_EPUB_NO_CONTAINER', () =>
    parseEpub(writeZip([{ name: 'mimetype', data: 'application/epub+zip' }]), { deviceId: 'mac-abc123' }),
  )
  await expectCode('E_EPUB_NO_OPF', () =>
    parseEpub(
      writeZip([
        { name: 'mimetype', data: 'application/epub+zip' },
        {
          name: 'META-INF/container.xml',
          data: '<container><rootfiles><rootfile full-path="missing.opf"/></rootfiles></container>',
        },
      ]),
      { deviceId: 'mac-abc123' },
    ),
  )
  await expectCode('E_EPUB_NO_SPINE', () =>
    parseEpub(
      writeZip([
        { name: 'mimetype', data: 'application/epub+zip' },
        {
          name: 'META-INF/container.xml',
          data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
        },
        {
          name: 'c.opf',
          data:
            '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>t</dc:title></metadata>' +
            '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine/></package>',
        },
        { name: 'a.xhtml', data: '<html><body>a</body></html>' },
      ]),
      { deviceId: 'mac-abc123' },
    ),
  )
  await expectCode('E_EPUB_MALFORMED', () =>
    parseEpub(
      writeZip([
        { name: 'mimetype', data: 'application/epub+zip' },
        {
          name: 'META-INF/container.xml',
          data: '<container><rootfiles><rootfile full-path="c.opf"></rootfiles></container>',
        },
      ]),
      { deviceId: 'mac-abc123' },
    ),
  )

  // ── 8. 文件名回退书名 ──
  const noTitle = writeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    },
    {
      name: 'c.opf',
      data:
        '<package><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine><itemref idref="a"/></spine></package>',
    },
    { name: 'a.xhtml', data: '<html><body>a</body></html>' },
  ])
  const fallback = await parseEpub(noTitle, { deviceId: 'mac-abc123', filename: '我的书.epub' })
  assert.equal(fallback.meta.title, '我的书', '没有 dc:title 时回退文件名（去掉扩展名）')
  assert.equal(fallback.meta.author, '')

  // 多 dc:creator 取第一个非空
  const multiAuthor = writeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    },
    {
      name: 'c.opf',
      data:
        '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>t</dc:title>' +
        '<dc:creator></dc:creator><dc:creator>第二作者</dc:creator></metadata>' +
        '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>' +
        '<spine><itemref idref="a"/></spine></package>',
    },
    { name: 'a.xhtml', data: '<html><body>a</body></html>' },
  ])
  const multiBook = await parseEpub(multiAuthor, { deviceId: 'mac-abc123' })
  assert.equal(multiBook.meta.author, '第二作者')

  // ── 9. 非 XHTML 的 spine 项被跳过（图片页不算章节） ──
  const mixedSpine = writeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
    },
    {
      name: 'c.opf',
      data:
        '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>t</dc:title></metadata>' +
        '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="img" href="p.png" media-type="image/png"/></manifest>' +
        '<spine><itemref idref="a"/><itemref idref="img"/></spine></package>',
    },
    { name: 'a.xhtml', data: '<html><body>a</body></html>' },
    { name: 'p.png', data: Buffer.from([1, 2, 3]) },
  ])
  const mixedBook = await parseEpub(mixedSpine, { deviceId: 'mac-abc123' })
  assert.deepEqual(
    mixedBook.spine.map((s) => s.href),
    ['a.xhtml'],
    'image/png 的 spine 项不该被当成章节',
  )

  // ── 10. 相对地址解析（章节内 ../images 的写法） ──
  const relBook = await parseEpub(
    makeEpub({
      chapters: [{ id: 'c', href: 'text/deep/ch.xhtml', label: '一', body: '<img src="../../images/a.png"/>' }],
      extraEntries: [{ name: 'OEBPS/images/a.png', data: Buffer.from([9, 9, 9]) }],
    }),
    { deviceId: 'mac-abc123' },
  )
  assert.equal(relBook.resolveRelative('text/deep/ch.xhtml', '../../images/a.png'), 'images/a.png')
  assert.equal(relBook.resolveRelative('text/deep/ch.xhtml', '../../../etc/passwd'), null, '越出 OPF 根返回 null')
  const relAsset = await relBook.assetBytes('../../images/a.png', 'text/deep/ch.xhtml')
  assert.deepEqual(relAsset.bytes, Buffer.from([9, 9, 9]))
  assert.equal(await relBook.assetBytes('../nope.png', 'text/deep/ch.xhtml'), null)

  // ── 11. href 归一与 media-type ──
  assert.equal(normalizeHref('./text/ch1.xhtml#frag'), 'text/ch1.xhtml')
  assert.equal(normalizeHref('text/../images/a.png'), 'images/a.png')
  assert.equal(normalizeHref('../outside.png'), null)
  assert.equal(normalizeHref('text/ch1.xhtml?x=1'), 'text/ch1.xhtml')
  assert.equal(resolveHref('OEBPS', 'text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml')
  assert.equal(resolveHref('', 'text/ch1.xhtml'), 'text/ch1.xhtml')
  assert.equal(mediaTypeFor('a/b.xhtml'), 'application/xhtml+xml')
  assert.equal(mediaTypeFor('a/b.jpg'), 'image/jpeg')
  assert.equal(mediaTypeFor('a/b.woff2'), 'font/woff2')
  assert.equal(mediaTypeFor('a/b.unknownext'), 'application/octet-stream')

  // ── 11.1 UTF-16BE 的 OPF（真做字节交换，不能把乱码当解码成功） ──
  {
    const opfText =
      '\ufeff<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:title>大端书</dc:title><dc:creator>大端作者</dc:creator></metadata>' +
      '<manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="a"/></spine></package>'
    // 先用 LE 编码再两两交换字节 → 得到真正的 UTF-16BE 字节流。
    const le = Buffer.from(opfText, 'utf16le')
    for (let i = 0; i + 1 < le.length; i += 2) {
      const low = le[i]
      le[i] = le[i + 1]
      le[i + 1] = low
    }
    const bigEndianBook = await parseEpub(
      writeZip([
        { name: 'mimetype', data: 'application/epub+zip' },
        {
          name: 'META-INF/container.xml',
          data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
        },
        { name: 'c.opf', data: le },
        { name: 'a.xhtml', data: '<html><body>a</body></html>' },
      ]),
      { deviceId: 'mac-abc123' },
    )
    assert.equal(bigEndianBook.meta.title, '大端书', 'UTF-16BE 必须真的交换字节，否则是乱码')
    assert.equal(bigEndianBook.meta.author, '大端作者')
  }

  // ── 12. golden/fixtures 存在则全部解析（8 本全过才算 G1 通过） ──
  let fixtureNames = []
  try {
    const listing = await fs.readdir(FIXTURE_DIR)
    fixtureNames = listing.filter((name) => name.endsWith('.epub')).sort()
  } catch {
    fixtureNames = []
  }

  if (fixtureNames.length === 0) {
    // 没有 golden fixture：自造 3 本（docs/05 §7 允许的退路），断言结构性质。
    const synthetic = [
      makeEpub({
        title: '甲书',
        chapters: [
          { id: 'c1', href: 'text/c1.xhtml', label: '一', body: '<p>一</p>' },
          { id: 'c2', href: 'text/c2.xhtml', label: '二', body: '<p>二</p>' },
        ],
      }),
      makeEpub({
        title: '乙书',
        nav: false,
        ncx: true,
        chapters: [
          { id: 'x1', href: 'text/x1.xhtml', label: 'X1', body: '<p>x1</p>' },
          { id: 'x2', href: 'text/x2.xhtml', label: 'X2', body: '<p>x2</p>' },
          { id: 'x3', href: 'text/x3.xhtml', label: 'X3', body: '<p>x3</p>' },
        ],
      }),
      makeEpub({
        title: '丙书',
        opfDir: '',
        nav: false,
        chapters: [{ id: 'only', href: 'only.xhtml', label: '唯一', body: '<p>only</p>' }],
      }),
    ]
    for (const [index, buffer] of synthetic.entries()) {
      const parsed = await parseEpub(buffer, { deviceId: 'mac-abc123' })
      assert.ok(parsed.spine.length > 0, `自造书 #${index} 必须有 spine`)
      assert.equal(parsed.toc.length, parsed.spine.length, `自造书 #${index} 的 toc 应覆盖全部章节`)
      for (const [i, entry] of parsed.spine.entries()) {
        assert.equal(entry.index, i, `自造书 #${index} 的 spine 索引必须连续`)
        assert.equal(parsed.toc[i].spineIndex, i, `自造书 #${index} 的 toc 必须归位到 spine`)
        const text = await parsed.chapterHtml(entry.href)
        assert.ok(typeof text === 'string' && text.length > 0, `自造书 #${index} 的第 ${i} 章读不出内容`)
      }
    }
  } else {
    // 有 golden fixture：每一本都解析，并优先拿同名 `.spine.json` 当真值比对。
    // 那份 json 由 golden/make-fixtures.mjs 写死，不来自本解析器——用它比才叫
    // 独立真值；没有它时退化成结构自洽断言。
    for (const name of fixtureNames) {
      const file = path.join(FIXTURE_DIR, name)
      const parsed = await parseEpub(file, { deviceId: 'mac-abc123', filename: name })
      assert.ok(parsed.spine.length > 0, `${name}: spine 不能为空`)
      assert.ok(parsed.toc.length > 0, `${name}: toc 不能为空`)
      for (const [i, entry] of parsed.spine.entries()) {
        assert.equal(entry.index, i, `${name}: spine 索引必须连续`)
        assert.ok(entry.href !== '', `${name}: spine[${i}] 缺 href`)
        assert.ok(entry.idref !== '', `${name}: spine[${i}] 缺 idref`)
        const text = await parsed.chapterHtml(entry.href)
        assert.ok(typeof text === 'string' && text.length > 0, `${name}: spine[${i}] 读不出正文`)
      }

      // 独立真值：*.spine.json
      const expectedFile = path.join(FIXTURE_DIR, name.replace(/\.epub$/, '.spine.json'))
      let expected = null
      try {
        expected = JSON.parse(await fs.readFile(expectedFile, 'utf8'))
      } catch {
        expected = null
      }
      if (expected && Array.isArray(expected.spine)) {
        assert.deepEqual(
          parsed.spine.map((entry) => ({ index: entry.index, idref: entry.idref, href: entry.href })),
          expected.spine.map((entry) => ({ index: entry.index, idref: entry.idref, href: entry.href })),
          `${name}: spine 与 ${path.basename(expectedFile)} 不一致`,
        )
        assert.equal(parsed.meta.title.length > 0, true, `${name}: 书名不能为空`)
      }

      for (const item of parsed.toc) {
        assert.equal(typeof item.label, 'string', `${name}: toc label 必须是字符串`)
        assert.ok(Number.isInteger(item.depth) && item.depth >= 0, `${name}: toc depth 必须是非负整数`)
        if (item.href === '') continue
        assert.ok(
          item.spineIndex === -1 || (item.spineIndex >= 0 && item.spineIndex < parsed.spine.length),
          `${name}: toc 的 spineIndex 越界：${item.spineIndex}`,
        )
      }
      const spineHrefs = new Set(parsed.spine.map((s) => s.href))
      for (const item of parsed.toc) {
        if (item.spineIndex >= 0) assert.ok(spineHrefs.has(item.href), `${name}: toc href 不在 spine 里`)
      }
    }

    // 8 本都齐全时，断言名字与 make-fixtures.mjs 的清单对得上。
    if (fixtureNames.length >= 8) {
      const missing = FIXTURE_NAMES.filter(
        (wanted) => !fixtureNames.some((name) => name === `${wanted}.epub`),
      )
      assert.deepEqual(missing, [], `golden/fixtures 缺少这些 fixture：${missing.join(', ')}`)
    }
  }
}
