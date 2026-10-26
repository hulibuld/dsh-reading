/**
 * 测试用的 PDF 生成器。
 *
 * 单独放一个文件，是因为它被两处用到：`pdf_test.mjs`（解析层）与
 * `e2e_local_test.mjs`（整条导入链路）。如果各写一份，某天改了一处、另一处
 * 还是旧形状，测试会开始说两种话。
 *
 * 只用最朴素的写法：未压缩内容流 + 经典 xref 表。特殊写法（对象流、交叉
 * 引用流、ToUnicode）留在 pdf_test.mjs 里，因为它们是「被测特性」本身。
 */

import { deflateSync } from 'node:zlib'

export const HEADER = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')

/**
 * 用经典 xref 表拼一份 PDF。
 *
 * @param {Array<{ n: number, body: string|Buffer }>} objects 对象号 → 对象体
 * @param {{ root?: number, dictExtra?: string, corruptStartxref?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildClassicPdf(objects, options = {}) {
  const root = options.root ?? 1
  const sorted = [...objects].sort((left, right) => left.n - right.n)
  const maxNum = sorted.length > 0 ? sorted[sorted.length - 1].n : 0
  const chunks = [HEADER]
  let offset = HEADER.length
  const offsets = new Map()
  for (const item of sorted) {
    const body = Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body, 'latin1')
    offsets.set(item.n, offset)
    const head = Buffer.from(`${item.n} 0 obj\n`, 'latin1')
    const tail = Buffer.from('\nendobj\n', 'latin1')
    chunks.push(head, body, tail)
    offset += head.length + body.length + tail.length
  }
  const xrefStart = offset
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`
  for (let num = 1; num <= maxNum; num += 1) {
    const entry = offsets.get(num)
    xref += entry === undefined
      ? '0000000000 00000 f \n'
      : `${String(entry).padStart(10, '0')} 00000 n \n`
  }
  const startxref = options.corruptStartxref ? 999999 : xrefStart
  const trailer = `trailer\n<< /Size ${maxNum + 1} /Root ${root} 0 R ${options.dictExtra ?? ''}>>\nstartxref\n${startxref}\n%%EOF\n`
  chunks.push(Buffer.from(xref + trailer, 'latin1'))
  return Buffer.concat(chunks)
}

/** 造一个内容流对象体（`<< /Length … >> stream … endstream`）。 */
export function streamBody(content, { compress = false } = {}) {
  const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1')
  if (!compress) {
    return Buffer.concat([
      Buffer.from(`<< /Length ${raw.length} >>\nstream\n`, 'latin1'),
      raw,
      Buffer.from('\nendstream', 'latin1'),
    ])
  }
  const packed = deflateSync(raw)
  return Buffer.concat([
    Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    packed,
    Buffer.from('\nendstream', 'latin1'),
  ])
}

/** 转义 PDF 字面量字符串里的三个特殊字符。 */
function escapePdfString(text) {
  return String(text).replace(/([()\\])/g, '\\$1')
}

/**
 * 文本 → PDF 字符串字面量。
 *
 * 纯 ASCII 就写 `(…)`；含非 ASCII 时按规范写成 UTF-16BE + BOM 的十六进制串
 * `<FEFF…>`——真实的中文 PDF 都是这么干的，不然读出来就是一团乱码。
 */
function pdfText(text) {
  const value = String(text)
  if (/^[\x20-\x7e]*$/.test(value)) return `(${escapePdfString(value)})`
  const body = Buffer.from(value, 'utf16le')
  for (let i = 0; i + 1 < body.length; i += 2) {
    const tmp = body[i]
    body[i] = body[i + 1]
    body[i + 1] = tmp
  }
  return `<feff${body.toString('hex')}>`
}

/**
 * 一份多页、带章标题的 PDF，用来走完整导入链路。
 *
 * 每页是一段 `BT … Tj … ET`；章节标题按「第一章 / 第二章」写，让
 * `chaptersFromPages` 认出目录来源是 auto。
 *
 * @param {{ title?: string, author?: string, pages?: Array<string[]> }} [options]
 * @returns {Buffer}
 */
export function buildChapteredPdf(options = {}) {
  const title = options.title ?? '测试之书'
  const author = options.author ?? '测试作者'
  const pages = options.pages ?? [
    ['第一章 起点', '他站在门口，看着外面的雨。'],
    ['雨下了一整夜。', '屋檐下的水滴成一条线。'],
    ['第二章 归途', '第二天早上，天晴了。'],
  ]

  const objects = []
  const pageNums = []
  // 对象编号布局：1 catalog / 2 pages / 3 font / 4 起每页一个 page，紧跟其后是内容流
  let next = 4
  const pageObjects = []
  for (const paragraphs of pages) {
    const pageNum = next
    const contentNum = next + 1
    next += 2
    pageNums.push(pageNum)
    // 内容流按 UTF-8 字节拼：中文直接写在 `( )` 里（有些国产工具就这么干），
    // 解析器那边会按 UTF-8 尝试解码。这里不能用 latin1 转字符串，否则汉字全丢。
    const parts = [Buffer.from('BT\n/F1 18 Tf\n72 720 Td\n', 'latin1')]
    let first = true
    for (const paragraph of paragraphs) {
      if (!first) {
        // 章标题前空一大截（真实书里的小标题前后都有空白），抽取时会变成空行，
        // 从而切成独立段落——这正是 chaptersFromPages 认目录所要的形状。
        // 每段之间空一大截：真实书里段落之间都有明显留白，抽取时会成空行、
        // 切成独立段落——章标题能因此被单独认出来。
        parts.push(Buffer.from('0 -52 Td\n', 'latin1'))
      }
      parts.push(Buffer.from(`(${escapePdfString(paragraph)}) Tj\n`, 'utf8'))
      first = false
    }
    parts.push(Buffer.from('ET', 'latin1'))
    pageObjects.push({ pageNum, contentNum, content: Buffer.concat(parts) })
  }

  objects.push({ n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' })
  objects.push({
    n: 2,
    body: `<< /Type /Pages /Kids [${pageNums.map((num) => `${num} 0 R`).join(' ')}] /Count ${pageNums.length} >>`,
  })
  objects.push({ n: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' })
  for (const page of pageObjects) {
    objects.push({
      n: page.pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page.contentNum} 0 R >>`,
    })
    objects.push({ n: page.contentNum, body: streamBody(page.content) })
  }
  const infoNum = next
  objects.push({
    n: infoNum,
    body: `<< /Title ${pdfText(title)} /Author ${pdfText(author)} >>`,
  })

  return buildClassicPdf(objects, { dictExtra: `/Info ${infoNum} 0 R ` })
}
