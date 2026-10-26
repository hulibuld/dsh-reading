/**
 * lib/mobi.js 的测试。
 *
 * 这里不依赖任何真实电子书：全部用下面的小工具现场拼出 PalmDB / MOBI / EXTH /
 * PalmDOC / HUFF-CDIC 结构，再断言解析结果。重点覆盖四件事：
 *   1. 三种压缩方式（不压缩、PalmDOC、HUFF/CDIC）都能解出正确文字；
 *   2. 三个错误码各自在什么情况下出现；
 *   3. 书名 / 作者的 EXTH 回退，以及双格式文件只取 KF8 正文；
 *   4. 封面：EXTH 201 定位、魔数扫描回退、没有封面、封面区越界都不影响正文。
 *
 * 直接执行 `node test/mobi_test.mjs` 会自己跑；被其它测试文件 import 时只导出 run。
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

import { extractCover, extractMobiText } from '../lib/mobi.js'
import { buildMinimalMobi } from './mobi_fixture.mjs'

const UTF8 = 65001

/**
 * 造一个 u16 大端 Buffer。
 * @param {number} value
 * @returns {Buffer}
 */
function u16(value) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(value, 0)
  return buf
}

/**
 * 造一个 u32 大端 Buffer。
 * @param {number} value
 * @returns {Buffer}
 */
function u32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/**
 * 拼 EXTH 区。每条数据按 4 字节补齐，保证整个 EXTH 长度是 4 的倍数。
 * @param {[number, Buffer][]} records
 * @returns {Buffer}
 */
function buildExth(records) {
  const parts = []
  for (const [type, data] of records) {
    const padding = Buffer.alloc((4 - (data.length % 4)) % 4)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(type, 0)
    head.writeUInt32BE(8 + data.length + padding.length, 4)
    parts.push(head, data, padding)
  }

  const body = Buffer.concat(parts)
  const head = Buffer.alloc(12)
  head.write('EXTH', 0, 'latin1')
  head.writeUInt32BE(12 + body.length, 4)
  head.writeUInt32BE(records.length, 8)
  return Buffer.concat([head, body])
}

/**
 * 造记录 0（PalmDOC 头 + MOBI 头 + EXTH + 书名）。
 * @param {object} options
 * @returns {Buffer}
 */
function buildRecord0(options) {
  const headerLength = 0xe8
  const headerEnd = 16 + headerLength
  const version = options.version ?? 6
  const exth = options.exthRecords?.length ? buildExth(options.exthRecords) : Buffer.alloc(0)
  const name = Buffer.from(options.fullName ?? '', 'utf8')
  const nameOffset = headerEnd + exth.length

  const rec = Buffer.alloc(nameOffset + name.length)
  rec.writeUInt16BE(options.compression, 0)
  rec.writeUInt32BE(options.textLength, 4)
  rec.writeUInt16BE(options.recordCount, 8)
  rec.writeUInt16BE(4096, 10)
  rec.writeUInt16BE(options.encryptionType ?? 0, 12)
  rec.write('MOBI', 16, 'latin1')
  rec.writeUInt32BE(headerLength, 20)
  rec.writeUInt32BE(options.mobiType ?? (version >= 8 ? 248 : 2), 24)
  rec.writeUInt32BE(options.textEncoding ?? UTF8, 28)
  rec.writeUInt32BE(0x12345678, 32)
  rec.writeUInt32BE(version, 36)
  rec.writeUInt32BE(1 + options.recordCount + (options.huffCount ?? 0), 0x50)
  rec.writeUInt32BE(nameOffset, 0x54)
  rec.writeUInt32BE(name.length, 0x58)
  rec.writeUInt32BE(version, 0x68)
  rec.writeUInt32BE(options.huffOffset ?? 0, 0x70)
  rec.writeUInt32BE(options.huffCount ?? 0, 0x74)
  rec.writeUInt32BE(exth.length > 0 ? 0x40 : 0, 0x80)
  rec.writeUInt32BE(0xffffffff, 0xa8)
  rec.writeUInt32BE(0xffffffff, 0xac)
  rec.writeUInt32BE(0, 0xb0)
  rec.writeUInt16BE(1, 0xc0)
  rec.writeUInt16BE(1, 0xc2)
  rec.writeUInt16BE(0, 0xf2)

  if (exth.length > 0) exth.copy(rec, headerEnd)
  if (name.length > 0) name.copy(rec, nameOffset)
  return rec
}

/**
 * 把记录数组包成 PalmDB 文件。
 * @param {Buffer[]} records
 * @returns {Buffer}
 */
function buildPalmDb(records) {
  const header = Buffer.alloc(78)
  header.write('TestBook', 0, 'latin1')
  header.write('BOOK', 60, 'latin1')
  header.write('MOBI', 64, 'latin1')
  header.writeUInt16BE(records.length, 76)

  const table = Buffer.alloc(records.length * 8)
  let offset = 78 + records.length * 8 + 2
  for (let i = 0; i < records.length; i += 1) {
    table.writeUInt32BE(offset, i * 8)
    offset += records[i].length
  }

  return Buffer.concat([header, table, Buffer.alloc(2), ...records])
}

/**
 * 造一本最小的 MOBI。正文记录由调用方给，方便分别造三种压缩样本。
 * @param {object} options
 * @returns {Buffer}
 */
function buildBook(options) {
  const textRecords = options.textRecords
  const textLength = options.textLength
  const huffRecords = options.huffRecords ?? []
  const huffCount = huffRecords.length
  const huffOffset = huffCount > 0 ? 1 + textRecords.length : 0

  const record0 = buildRecord0({
    compression: options.compression ?? 1,
    textLength,
    recordCount: textRecords.length,
    encryptionType: options.encryptionType ?? 0,
    version: options.version ?? 6,
    exthRecords: options.exthRecords ?? [],
    fullName: options.fullName ?? '',
    huffOffset,
    huffCount,
  })

  return buildPalmDb([record0, ...textRecords, ...huffRecords])
}

/**
 * 最小 PalmDOC 编码器：字面量直接输出；≥3 字节的重复才用回溯引用。
 * @param {Buffer} input
 * @returns {Buffer}
 */
function palmDocCompress(input) {
  const out = []
  let pos = 0

  while (pos < input.length) {
    let bestLength = 0
    let bestDistance = 0
    const maxDistance = Math.min(pos, 2047)

    for (let distance = 1; distance <= maxDistance; distance += 1) {
      let length = 0
      while (
        length < 10 &&
        pos + length < input.length &&
        input[pos + length] === input[pos - distance + length]
      ) {
        length += 1
      }
      if (length > bestLength) {
        bestLength = length
        bestDistance = distance
        if (length === 10) break
      }
    }

    if (bestLength >= 3) {
      const pair = 0x8000 | (bestDistance << 3) | (bestLength - 3)
      out.push((pair >>> 8) & 0xff, pair & 0xff)
      pos += bestLength
    } else {
      const count = Math.min(8, input.length - pos)
      out.push(count)
      for (let i = 0; i < count; i += 1) out.push(input[pos + i])
      pos += count
    }
  }

  return Buffer.from(out)
}

/**
 * 造一条 HUFF 记录：256 项相同的一级码表 + 32 组 min/max。
 * 这里只用 8 个 3 位码（C=0..7），方便手写位流。
 * @returns {Buffer}
 */
function buildHuff() {
  const off1 = 0x18
  const off2 = off1 + 1024
  const buf = Buffer.alloc(off2 + 256)
  buf.write('HUFF', 0, 'latin1')
  buf.writeUInt32BE(off1, 4)
  buf.writeUInt32BE(off2, 8)

  // codelen=3、term=1、最大码值 rawMax=7：maxcode 会算成 0xFFFFFFFF。
  const value = (7 << 8) | 0x80 | 3
  for (let i = 0; i < 256; i += 1) buf.writeUInt32BE(value, off1 + i * 4)

  for (let codelen = 1; codelen <= 32; codelen += 1) {
    const base = off2 + (codelen - 1) * 8
    buf.writeUInt32BE(0, base)
    buf.writeUInt32BE(codelen === 3 ? 7 : 0, base + 4)
  }

  return buf
}

/**
 * 造一条 CDIC 记录。短语全部标记为「已解压」（0x8000），避免递归。
 * @param {string[]} phrases
 * @returns {Buffer}
 */
function buildCdic(phrases) {
  const bits = 3
  const tableSize = phrases.length * 2
  let dataSize = 0
  for (const phrase of phrases) dataSize += 2 + Buffer.byteLength(phrase, 'utf8')

  const buf = Buffer.alloc(16 + tableSize + dataSize)
  buf.write('CDIC', 0, 'latin1')
  buf.writeUInt32BE(16, 4)
  buf.writeUInt32BE(phrases.length, 8)
  buf.writeUInt32BE(bits, 12)

  let dataOffset = tableSize
  for (let i = 0; i < phrases.length; i += 1) {
    const bytes = Buffer.from(phrases[i], 'utf8')
    buf.writeUInt16BE(dataOffset, 16 + i * 2)
    buf.writeUInt16BE(0x8000 | bytes.length, 16 + dataOffset)
    bytes.copy(buf, 18 + dataOffset)
    dataOffset += 2 + bytes.length
  }

  return buf
}

/**
 * 期望某个错误码。
 * @param {string} code
 * @param {() => unknown} fn
 * @param {string} label
 */
function expectCode(code, fn, label) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `${label}：应当抛错，但解析成功了`)
  assert.equal(caught.code, code, `${label}：错误码应为 ${code}，实际 ${caught.code}`)
}

// ── 1. 最小 MOBI：不压缩、两个 h1、EXTH 书名与作者 ──
async function testMinimalMobi() {
  const html = [
    '<html><body>',
    '<h1>第一章 开始</h1>',
    '<p>第一段：&amp; 符号 &lt;尖括号&gt;</p>',
    '<p>第二段：&#39;单引号&#39; 和 &quot;双引号&quot;</p>',
    '<p>第三段：&#x4F60;&#22909;，中文 &nbsp; 空格</p>',
    '<p>第四段：重复重复重复重复重复</p>',
    '<p>第五段：结束</p>',
    '<h1>第二章 继续</h1>',
    '<p>第六段：ABC</p>',
    '<p>第七段：DEF</p>',
    '<p>第八段：GHI</p>',
    '<p>第九段：JKL</p>',
    '<p>第十段：MNO</p>',
    '</body></html>',
  ].join('')

  const text = Buffer.from(html, 'utf8')
  const bytes = buildBook({
    textRecords: [text],
    textLength: text.length,
    exthRecords: [
      [100, Buffer.from('作者甲', 'utf8')],
      [100, Buffer.from('作者乙', 'utf8')],
      [503, Buffer.from('测试书名', 'utf8')],
    ],
  })

  const result = extractMobiText(bytes)
  assert.equal(result.title, '测试书名')
  assert.equal(result.author, '作者甲、作者乙')
  assert.equal(result.chapters.length, 2, '应当切出 2 章')

  assert.equal(result.chapters[0].label, '第一章 开始')
  assert.equal(result.chapters[0].paragraphs.length, 6, '第一章有标题 + 5 段')
  assert.equal(result.chapters[0].paragraphs[0], '第一章 开始')
  assert.equal(result.chapters[0].paragraphs[1], '第一段：& 符号 <尖括号>')
  assert.equal(result.chapters[0].paragraphs[2], "第二段：'单引号' 和 \"双引号\"")
  assert.equal(result.chapters[0].paragraphs[3], '第三段：你好，中文 空格')
  assert.equal(result.chapters[0].paragraphs[4], '第四段：重复重复重复重复重复')
  assert.equal(result.chapters[0].paragraphs[5], '第五段：结束')

  assert.equal(result.chapters[1].label, '第二章 继续')
  assert.equal(result.chapters[1].paragraphs.length, 6, '第二章有标题 + 5 段')

  const all = result.chapters.flatMap((chapter) => chapter.paragraphs).join('')
  assert.ok(!/<\/?(p|h1|body|html)\b/i.test(all), '标签必须被剥掉')
  assert.ok(all.includes('<尖括号>'), '&lt; 和 &gt; 应当解码成字面尖括号')
  assert.ok(!all.includes('&amp;'), '实体必须被解码')
}

// ── 2. PalmDOC：自己写编码器，解压结果必须与原文一致 ──
async function testPalmDoc() {
  const html = [
    '<h1>压缩测试</h1>',
    '<p>这是一段需要被压缩的中文文字，重复重复重复重复重复重复重复重复重复重复。</p>',
    '<p>第二段：abcabcabcabcabcabcabcabcabcabcabcabc。</p>',
    `<p>第三段：${'甲乙丙丁'.repeat(60)}</p>`,
  ].join('')

  const text = Buffer.from(html, 'utf8')
  const compressed = palmDocCompress(text)
  assert.ok(compressed.length < text.length, '高度重复的正文压缩后应当更短')

  const bytes = buildBook({
    compression: 2,
    textRecords: [compressed],
    textLength: text.length,
  })

  const result = extractMobiText(bytes)
  assert.equal(result.chapters.length, 1)
  assert.equal(result.chapters[0].label, '压缩测试')
  assert.equal(result.chapters[0].paragraphs.length, 4)
  assert.equal(
    result.chapters[0].paragraphs[1],
    '这是一段需要被压缩的中文文字，重复重复重复重复重复重复重复重复重复重复。',
  )
  assert.equal(
    result.chapters[0].paragraphs[2],
    '第二段：abcabcabcabcabcabcabcabcabcabcabcabc。',
  )
  assert.equal(result.chapters[0].paragraphs[3], `第三段：${'甲乙丙丁'.repeat(60)}`)

  // 0xC0–0xFF 分支：输出一个空格 + (c ^ 0x80)。0xC1 → ' A'。
  const highBytes = buildBook({
    compression: 2,
    textRecords: [Buffer.from([0x78, 0xc1])],
    textLength: 3,
  })
  const highResult = extractMobiText(highBytes)
  assert.deepEqual(highResult.chapters[0].paragraphs, ['x A'])
}

// ── 3. HUFF/CDIC：8 个 3 位码，编码「你好，世界」──
async function testHuffCdic() {
  // 字典按倒序下标存放：index = 7 - code。
  // code 1..5 依次对应「你 好 ， 世 界」，code 0 留给填充位（空短语）。
  const dictionary = ['', '', '界', '世', '，', '好', '你', '']
  const text = Buffer.from('你好，世界', 'utf8')

  // code 1..5 = 001 010 011 100 101 → 001010011100101，补 0 成 0x29 0xCA。
  // 15 位用掉之后只剩 1 位，不足 3 位，解码器会自然停止。
  const compressed = Buffer.from([0x29, 0xca])

  const bytes = buildBook({
    compression: 17480,
    textRecords: [compressed],
    textLength: text.length,
    huffRecords: [buildHuff(), buildCdic(dictionary)],
  })

  const result = extractMobiText(bytes)
  assert.equal(result.chapters.length, 1)
  // 没有 <h1> 时 label 刻意留空：章名由 textbook.deriveChapterLabel 按文字形状推导，
  // 推导不出来才由 buildReflowedBook 用「第 N 章」兜底（见 lib/mobi.js buildChapters）。
  assert.equal(result.chapters[0].label, '')
  assert.deepEqual(result.chapters[0].paragraphs, ['你好，世界'])
}

// ── 3b. 标成 17480 但实际是 deflate 的正文（第三方工具常见）──
async function testDeflateInHuff() {
  const html = Buffer.from('<h1>Deflate 正文</h1><p>这段数据其实是 zlib 压的。</p>', 'utf8')
  const packed = deflateSync(html)

  const bytes = buildBook({
    compression: 17480,
    textRecords: [packed],
    textLength: html.length,
    // 故意不提供 HUFF/CDIC：解析器必须先用 inflate 成功。
  })

  const result = extractMobiText(bytes)
  assert.equal(result.chapters.length, 1)
  assert.equal(result.chapters[0].label, 'Deflate 正文')
  assert.deepEqual(result.chapters[0].paragraphs, ['Deflate 正文', '这段数据其实是 zlib 压的。'])
}

// ── 4. 三个错误码各一条 ──
async function testErrors() {
  const junk = Buffer.from(Array.from({ length: 100 }, (_, i) => (i * 37 + 11) & 0xff))
  expectCode('E_MOBI_MALFORMED', () => extractMobiText(junk), '随机字节')

  const encryptedByte = buildBook({
    textRecords: [Buffer.from('<p>正文</p>', 'utf8')],
    textLength: Buffer.byteLength('<p>正文</p>', 'utf8'),
    encryptionType: 1,
  })
  expectCode('E_MOBI_ENCRYPTED', () => extractMobiText(encryptedByte), 'encryptionType=1')

  const unknownCompression = buildBook({
    compression: 99,
    textRecords: [Buffer.from('x')],
    textLength: 1,
  })
  expectCode('E_MOBI_UNSUPPORTED', () => extractMobiText(unknownCompression), 'compression=99')
}

// ── 5. 书名回退：没有 EXTH 503、也没有 fullName，title 必须是空串 ──
async function testTitleFallback() {
  const text = Buffer.from('<p>正文</p>', 'utf8')
  const bytes = buildBook({
    textRecords: [text],
    textLength: text.length,
  })

  const result = extractMobiText(bytes)
  assert.equal(result.title, '')
  assert.equal(result.author, '')
  assert.equal(result.chapters.length, 1)
}

// ── 6. 双格式：有 EXTH 121 时只取 KF8 部分，不能把旧版正文混进来 ──
async function testKf8Dual() {
  const oldText = Buffer.from('<h1>旧版</h1><p>旧版正文</p>', 'utf8')
  const newText = Buffer.from('<h1>新版</h1><p>新版正文</p>', 'utf8')

  // 记录布局：0 = MOBI6 头，1 = MOBI6 正文，2 = BOUNDARY，3 = KF8 头，4 = KF8 正文。
  const mobi6Header = buildRecord0({
    compression: 1,
    textLength: oldText.length,
    recordCount: 1,
    version: 6,
    exthRecords: [
      [503, Buffer.from('MOBI6 标题', 'utf8')],
      [121, u32(3)],
    ],
  })
  const kf8Header = buildRecord0({
    compression: 1,
    textLength: newText.length,
    recordCount: 1,
    version: 8,
    exthRecords: [[503, Buffer.from('KF8 标题', 'utf8')]],
  })

  const bytes = buildPalmDb([
    mobi6Header,
    oldText,
    Buffer.from('BOUNDARYBOUNDARY'),
    kf8Header,
    newText,
  ])

  const result = extractMobiText(bytes)
  assert.equal(result.title, 'KF8 标题')
  assert.equal(result.chapters.length, 1)
  assert.equal(result.chapters[0].label, '新版')
  assert.deepEqual(result.chapters[0].paragraphs, ['新版', '新版正文'])

  const all = result.chapters.flatMap((chapter) => chapter.paragraphs).join('')
  assert.ok(!all.includes('旧版正文'), '不能把 MOBI6 的正文混进 KF8 结果')
}

// ── 7. 封面：EXTH 201 定位 JPEG，整条记录逐字节返回（尾部杂数据不裁剪） ──
async function testCoverViaExth201() {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    // 有些 MOBI 会把 FLIS/FCIS 之类的尾部数据拼在 JPEG 记录后面，必须原样整条返回。
    Buffer.from('FLISFLIS'),
  ])
  const bytes = buildMinimalMobi({
    html: '<h1>有封面的书</h1><p>正文。</p>',
    title: '有封面的书',
    cover: { bytes: jpeg, coverOffset: 0 },
  })

  const cover = extractCover(bytes)
  assert.ok(cover, '带 EXTH 201 的 JPEG 封面应该能抽出来')
  assert.equal(cover.mediaType, 'image/jpeg')
  assert.deepEqual(Buffer.from(cover.data), jpeg)

  // 同一次解析里 extractMobiText 也要带上封面，调用方不用解析两遍。
  const result = extractMobiText(bytes)
  assert.equal(result.chapters.length, 1)
  assert.ok(result.cover, 'extractMobiText 的返回值应带 cover')
  assert.equal(result.cover.mediaType, 'image/jpeg')
  assert.deepEqual(Buffer.from(result.cover.data), jpeg)
}

// ── 8. 没有 EXTH 201：从 firstImageIndex 起按魔数扫到 PNG ──
async function testCoverViaMagicScan() {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR00000000'),
  ])
  const bytes = buildMinimalMobi({
    html: '<p>没有 EXTH 201，只有一条 PNG 记录。</p>',
    title: '扫描封面',
    cover: { bytes: png }, // 不给 coverOffset → 不写 EXTH 201
  })

  const cover = extractCover(bytes)
  assert.ok(cover, '没有 EXTH 201 时应靠魔数扫描找到图片')
  assert.equal(cover.mediaType, 'image/png')
  assert.deepEqual(Buffer.from(cover.data), png)
}

// ── 9. 完全没有图片记录 → null（不是抛错） ──
async function testNoCover() {
  const bytes = buildMinimalMobi({ html: '<h1>无封面</h1><p>正文。</p>', title: '无封面' })

  assert.equal(extractCover(bytes), null)
  const result = extractMobiText(bytes)
  assert.equal(result.chapters.length, 1)
  assert.equal(result.cover, null, '没有封面时 cover 必须是 null，不能是 undefined')
}

// ── 10. 封面区越界 → null，但正文照常读出来（封面坏不能连累整本书） ──
async function testCoverIndexOutOfRange() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const bytes = buildMinimalMobi({
    html: '<h1>封面越界</h1><p>书还是能读的。</p>',
    title: '封面越界',
    // firstImageIndex 指到记录表之外：解析器应当当作「没有封面」。
    cover: { bytes: jpeg, firstImageIndex: 999 },
  })

  assert.equal(extractCover(bytes), null)

  const result = extractMobiText(bytes)
  assert.equal(result.title, '封面越界')
  assert.equal(result.chapters.length, 1)
  assert.deepEqual(result.chapters[0].paragraphs, ['封面越界', '书还是能读的。'])
  assert.equal(result.cover, null)
}

/**
 * 按顺序跑完所有用例。
 * @returns {Promise<void>}
 */
export default async function run() {
  const tests = [
    testMinimalMobi,
    testPalmDoc,
    testHuffCdic,
    testDeflateInHuff,
    testErrors,
    testTitleFallback,
    testKf8Dual,
    testCoverViaExth201,
    testCoverViaMagicScan,
    testNoCover,
    testCoverIndexOutOfRange,
  ]

  for (const test of tests) await test()
  console.log(`mobi: ${tests.length} 项通过`)
}

// 直接 `node test/mobi_test.mjs` 时自己跑；被其它测试文件 import 时不跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
