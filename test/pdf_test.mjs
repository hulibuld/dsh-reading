#!/usr/bin/env node
/**
 * PDF 解析测试。
 *
 * 这里不下载任何样本文件：测试自己**造** PDF。理由有两条——
 *   1. 真实 PDF 动辄几 MB，不该进仓库；
 *   2. 造出来的文件能精确控制「这一页写了什么字」，才能断言「读出来的就是这几个字」。
 *
 * 覆盖：
 *   - 经典交叉引用表（xref table）+ 未压缩内容流
 *   - FlateDecode 压缩流
 *   - 对象流 /ObjStm + 交叉引用流 /XRef（PDF 1.5 之后的主流写法）
 *   - Type0 / Identity-H + /ToUnicode（中文 PDF 的真实形态）
 *   - ASCIIHexDecode 过滤器
 *   - xref 损坏后的全文件扫描兜底
 *   - 加密 PDF / 扫描件（无文字层）/ 假 PDF 三种失败路径
 *   - parseBook 分诊：魔数识别 pdf、扩展名 .pdf、meta 与 toc 形状
 */

import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { parsePdf, extractPdfText, chaptersFromPages } from '../lib/pdf.js'
import { parseBook, detectFormat, sourceFormatOf, extensionOf } from '../lib/bookformat.js'
import { isAppError } from '../lib/errors.js'
import { buildClassicPdf, streamBody, HEADER } from './pdf_fixture.mjs'

/* ------------------------------------------------------------------ *
 * 造 PDF 的小工具
 * ------------------------------------------------------------------ */

/** 一份「能读」的 PDF：两行文字。 */
function simplePdf({ compress = false } = {}) {
  const content = [
    'BT',
    '/F1 24 Tf',
    '72 700 Td',
    '(Hello PDF World) Tj',
    '0 -30 Td',
    '(Second line here.) Tj',
    'ET',
  ].join('\n')
  return buildClassicPdf([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      n: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    },
    { n: 4, body: streamBody(content, { compress }) },
    { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
  ])
}

/** 中文 PDF：Type0 / Identity-H + ToUnicode 映射。 */
function cidPdf() {
  const content = ['BT', '/F1 24 Tf', '72 700 Td', '<000100020003> Tj', 'ET'].join('\n')
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '3 beginbfchar',
    '<0001> <4E2D>',
    '<0002> <6587>',
    '<0003> <4E66>',
    'endbfchar',
    '1 beginbfrange',
    '<0010> <0012> <0061>',
    'endbfrange',
    'endcmap',
    'end end',
  ].join('\n')
  return buildClassicPdf([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      n: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    },
    { n: 4, body: streamBody(content) },
    {
      n: 5,
      body: '<< /Type /Font /Subtype /Type0 /BaseFont /Song /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    },
    {
      n: 6,
      body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Song /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
    },
    { n: 7, body: streamBody(cmap) },
  ])
}

/**
 * PDF 1.5 写法：对象塞进 /ObjStm，索引走 /XRef 流。
 * 这是现代 PDF 的主流形态，不测它等于没测。
 */
function modernPdf() {
  const content = ['BT', '/F1 18 Tf', '60 720 Td', '(Object stream text) Tj', 'ET'].join('\n')
  const contentBody = streamBody(content)
  const contentObjNum = 4
  const objStmNum = 6
  const xrefNum = 7

  // 1 catalog / 2 pages / 3 page / 5 font 四个对象压进对象流
  const packed = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
  ]

  let headerPart = ''
  let bodyPart = ''
  const entries = []
  for (let index = 0; index < packed.length; index += 1) {
    headerPart += `${packed[index].num} ${bodyPart.length} `
    bodyPart += `${packed[index].body} `
    entries.push({ num: packed[index].num, index })
  }
  const objStmData = Buffer.from(headerPart + bodyPart, 'latin1')
  const packedHeaderLength = Buffer.byteLength(headerPart, 'latin1')
  const objStmCompressed = zlib.deflateSync(objStmData)
  const objStmBody = Buffer.concat([
    Buffer.from(
      `<< /Type /ObjStm /N ${packed.length} /First ${packedHeaderLength} /Length ${objStmCompressed.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1',
    ),
    objStmCompressed,
    Buffer.from('\nendstream', 'latin1'),
  ])

  // 先排到对象流为止，记下各自偏移
  const prefix = Buffer.concat([
    HEADER,
    Buffer.from(`${contentObjNum} 0 obj\n`, 'latin1'),
    contentBody,
    Buffer.from('\nendobj\n', 'latin1'),
    Buffer.from(`${objStmNum} 0 obj\n`, 'latin1'),
    objStmBody,
    Buffer.from('\nendobj\n', 'latin1'),
  ])
  const offsets = new Map()
  // 逐个重算偏移（简单可靠：重新拼一遍并记账）
  let cursor = HEADER.length
  offsets.set(contentObjNum, cursor)
  cursor += `${contentObjNum} 0 obj\n`.length + contentBody.length + '\nendobj\n'.length
  offsets.set(objStmNum, cursor)
  cursor += `${objStmNum} 0 obj\n`.length + objStmBody.length + '\nendobj\n'.length
  // startxref 指向「xref 对象的开头」（`7 0 obj` 那个 7），不是它的字典
  const xrefOffset = cursor

  // 交叉引用流：W = [1, 4, 2]
  const rows = []
  const push = (type, field2, field3) => {
    const row = Buffer.alloc(7)
    row[0] = type
    row.writeUInt32BE(field2 >>> 0, 1)
    row.writeUInt16BE(field3 & 0xffff, 5)
    rows.push(row)
  }
  // 行号 = 对象号，必须逐号对齐（漏一个号，后面全部错位）
  push(0, 0, 65535)
  for (let num = 1; num <= 7; num += 1) {
    const packedEntry = entries.find((entry) => entry.num === num)
    if (packedEntry) push(2, objStmNum, packedEntry.index)
    else if (num === contentObjNum) push(1, offsets.get(contentObjNum), 0)
    else if (num === objStmNum) push(1, offsets.get(objStmNum), 0)
    else if (num === xrefNum) push(1, xrefOffset, 0)
    else push(0, 0, 0)
  }

  const xrefData = zlib.deflateSync(Buffer.concat(rows))
  const xrefBody = Buffer.concat([
    Buffer.from(
      `<< /Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /Length ${xrefData.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1',
    ),
    xrefData,
    Buffer.from('\nendstream', 'latin1'),
  ])
  const xrefObj = Buffer.concat([
    Buffer.from(`${xrefNum} 0 obj\n`, 'latin1'),
    xrefBody,
    Buffer.from('\nendobj\n', 'latin1'),
  ])
  const tail = Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, 'latin1')
  return Buffer.concat([prefix, xrefObj, tail])
}

/** 只有图形、没有文字的 PDF（模拟扫描件）。 */
function scannedPdf() {
  const content = ['0.2 0.3 0.4 rg', '10 10 200 200 re', 'f'].join('\n')
  return buildClassicPdf([
    { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { n: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>' },
    { n: 4, body: streamBody(content) },
  ])
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

export default async function run() {
  // ---- 1. 基本解析与文字还原 ----
  {
    const book = parsePdf(simplePdf(), { filename: 'sample.pdf' })
    assert.equal(book.meta.sourceFormat, 'pdf')
    assert.equal(book.meta.format, 'pdf-converted')
    assert.ok(book.spine.length >= 1, '至少要有一章')
    const html = await book.chapterHtml(book.spine[0].href)
    assert.match(html, /Hello PDF World/)
    assert.match(html, /Second line here\./)
    assert.equal(book.coverHref, null, 'PDF 没有封面，走纸封面')
  }

  // ---- 2. FlateDecode 压缩内容流 ----
  {
    const book = parsePdf(simplePdf({ compress: true }))
    const html = await book.chapterHtml(book.spine[0].href)
    assert.match(html, /Hello PDF World/)
  }

  // ---- 3. 对象流 + 交叉引用流（PDF 1.5 写法）----
  {
    const buf = modernPdf()
    const book = parsePdf(buf)
    const html = await book.chapterHtml(book.spine[0].href)
    assert.match(html, /Object stream text/, '对象流里的页面与字体要能被展开')
  }

  // ---- 4. Type0 / Identity-H + ToUnicode（中文）----
  {
    const book = parsePdf(cidPdf())
    const html = await book.chapterHtml(book.spine[0].href)
    assert.match(html, /中文书/, 'ToUnicode 映射后的中文要读得出来')
  }

  // ---- 5. ASCIIHexDecode ----
  {
    const content = 'BT /F1 12 Tf 10 700 Td (Hex filtered) Tj ET'
    const hex = Buffer.from(content, 'latin1').toString('hex')
    const buf = buildClassicPdf([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { n: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
      {
        n: 4,
        body: Buffer.from(
          `<< /Length ${hex.length + 1} /Filter /ASCIIHexDecode >>\nstream\n${hex}>\nendstream`,
          'latin1',
        ),
      },
      { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    ])
    const book = parsePdf(buf)
    assert.match(await book.chapterHtml(book.spine[0].href), /Hex filtered/)
  }

  // ---- 6. xref 损坏 → 全文件扫描兜底 ----
  {
    const broken = buildClassicPdf(
      [
        { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { n: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
        { n: 4, body: streamBody('BT /F1 12 Tf 10 700 Td (Recovered by scan) Tj ET') },
        { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      ],
      { corruptStartxref: true },
    )
    const book = parsePdf(broken)
    assert.match(await book.chapterHtml(book.spine[0].href), /Recovered by scan/)
  }

  // ---- 7. 失败路径 ----
  {
    let encrypted = null
    try {
      parsePdf(
        buildClassicPdf(
          [
            { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
            { n: 2, body: '<< /Type /Pages /Kids [] /Count 0 >>' },
            { n: 5, body: '<< /Filter /Standard /V 2 /R 3 >>' },
          ],
          { dictExtra: '/Encrypt 5 0 R ' },
        ),
      )
    } catch (error) {
      encrypted = error
    }
    assert.ok(encrypted && isAppError(encrypted), '加密 PDF 要抛 AppError')
    assert.equal(encrypted.code, 'E_PDF_ENCRYPTED')

    let scanned = null
    try {
      parsePdf(scannedPdf())
    } catch (error) {
      scanned = error
    }
    assert.ok(scanned && isAppError(scanned))
    assert.equal(scanned.code, 'E_PDF_NO_TEXT', '没有文字层要说「读不到文字」，不能装成功')

    let fake = null
    try {
      parsePdf(Buffer.from('not a pdf at all', 'latin1'))
    } catch (error) {
      fake = error
    }
    assert.ok(fake && isAppError(fake))
    assert.equal(fake.code, 'E_PDF_INVALID')
  }

  // ---- 8. 分诊与落盘扩展名 ----
  {
    assert.equal(detectFormat(simplePdf()), 'pdf')
    assert.equal(sourceFormatOf('book.pdf', 'pdf'), 'pdf')
    assert.equal(extensionOf({ sourceFormat: 'pdf' }), 'pdf')
    assert.equal(extensionOf({ format: 'pdf-converted' }), 'pdf')
    const book = await parseBook(simplePdf(), { filename: 'book.pdf' })
    assert.equal(book.meta.sourceFormat, 'pdf')
  }

  // ---- 9. 章节切分策略 ----
  {
    // 有 ≥2 条真标题 → 认成目录
    const withHeadings = chaptersFromPages([
      { page: 1, paragraphs: ['第一章 起', '正文开始。'] },
      { page: 2, paragraphs: ['更多的字。', '第二章 承', '继续写。'] },
    ])
    assert.equal(withHeadings.tocSource, 'auto')
    assert.equal(withHeadings.chapters.length >= 2, true)
    assert.equal(withHeadings.chapters[0].label, '第一章 起')

    // 没有标题 → 页段合并、不造目录
    const plain = chaptersFromPages([
      { page: 1, paragraphs: ['一句话。'] },
      { page: 2, paragraphs: ['又一句话。'] },
    ])
    assert.equal(plain.tocSource, 'none')
    assert.equal(plain.chapters[0].label, '第 1–2 页')
  }

  // ---- 10. 多页 + 空页：不因为中间有一页没字就整本失败 ----
  {
    const content = 'BT /F1 12 Tf 10 700 Td (Page text) Tj ET'
    const empty = '0 0 100 100 re f'
    const buf = buildClassicPdf([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>' },
      { n: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
      { n: 4, body: streamBody(content) },
      { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      { n: 6, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>' },
      { n: 7, body: streamBody(empty) },
    ])
    const book = parsePdf(buf)
    assert.ok(book.spine.length >= 1)
    const html = await book.chapterHtml(book.spine[0].href)
    assert.match(html, /Page text/)
    assert.equal(book.meta.pdfPages, 2)
  }

  // ---- 11. 元数据：Info 里的书名与作者 ----
  {
    const buf = buildClassicPdf([
      { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { n: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { n: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
      { n: 4, body: streamBody('BT /F1 12 Tf 10 700 Td (Meta) Tj ET') },
      { n: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      { n: 8, body: '<< /Title (A Real Book Title) /Author (Someone) >>' },
    ], { dictExtra: '/Info 8 0 R ' })
    const extracted = extractPdfText(buf)
    assert.equal(extracted.info.title, 'A Real Book Title')
    assert.equal(extracted.info.author, 'Someone')
    const book = parsePdf(buf)
    assert.equal(book.meta.title, 'A Real Book Title')
    assert.equal(book.meta.author, 'Someone')
  }

  console.log('pdf: 11 组用例通过')
}
