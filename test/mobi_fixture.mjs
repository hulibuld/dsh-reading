/**
 * 造「最小可读 MOBI」的测试夹具。
 *
 * e2e 与格式分诊两处都要用同一份样本：样本各自复制一份迟早会分叉，
 * 一边改了字段另一边还按老结构断言，红的时候很难判断是解析器还是夹具的问题。
 */

/** 大端 u16/u32 的简写。 */
const u16 = (value) => {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(value, 0)
  return buf
}
const u32 = (value) => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/**
 * 造一本最小 MOBI（不压缩、MOBI6、EXTH 带书名与作者）。
 *
 * 只造到「能被解析出文字」为止：PalmDB 头 + 记录表 + PalmDOC 头/MOBI 头 + 正文。
 *
 * 传了 `cover` 时会额外追加一条图片记录（正文记录之后），并写 MOBI 头的
 * firstImageIndex 指向它；`coverOffset` 给数字时再写 EXTH 201。不给 `cover`
 * 时生成的字节与旧版完全一致（firstImageIndex 留 0 = 没有图片）。
 *
 * @param {{
 *   html: string,
 *   title?: string,
 *   author?: string,
 *   cover?: {
 *     bytes: Buffer | Uint8Array,
 *     coverOffset?: number,
 *     firstImageIndex?: number,
 *   },
 * }} options
 * @returns {Buffer}
 */
export function buildMinimalMobi(options) {
  const html = Buffer.from(options.html, 'utf8')
  const cover = options.cover
    ? {
        bytes: Buffer.from(options.cover.bytes),
        coverOffset: options.cover.coverOffset,
        firstImageIndex: options.cover.firstImageIndex,
      }
    : null

  const exthRecords = []
  if (options.author) exthRecords.push([100, Buffer.from(options.author, 'utf8')])
  if (options.title) exthRecords.push([503, Buffer.from(options.title, 'utf8')])
  // EXTH 201 = 封面记录相对 firstImageIndex 的偏移；不给就不写，用来测魔数扫描。
  if (cover && cover.coverOffset !== undefined) exthRecords.push([201, u32(cover.coverOffset)])

  const exthParts = []
  for (const [type, data] of exthRecords) {
    const pad = Buffer.alloc((4 - (data.length % 4)) % 4)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(type, 0)
    head.writeUInt32BE(8 + data.length + pad.length, 4)
    exthParts.push(head, data, pad)
  }
  const exthBody = Buffer.concat(exthParts)
  const exth = Buffer.alloc(12)
  exth.write('EXTH', 0, 'latin1')
  exth.writeUInt32BE(12 + exthBody.length, 4)
  exth.writeUInt32BE(exthRecords.length, 8)

  const headerLength = 0xe8
  const headerEnd = 16 + headerLength
  const fullName = Buffer.from(options.title ?? '', 'utf8')
  const nameOffset = headerEnd + 12 + exthBody.length

  const rec0 = Buffer.alloc(nameOffset + fullName.length)
  rec0.writeUInt16BE(1, 0) // compression = none
  rec0.writeUInt32BE(html.length, 4)
  rec0.writeUInt16BE(1, 8) // recordCount
  rec0.writeUInt16BE(4096, 10)
  rec0.writeUInt16BE(0, 12) // encryptionType
  rec0.write('MOBI', 16, 'latin1')
  rec0.writeUInt32BE(headerLength, 20)
  rec0.writeUInt32BE(2, 24) // mobiType = book
  rec0.writeUInt32BE(65001, 28) // UTF-8
  rec0.writeUInt32BE(6, 36) // fileVersion 6
  rec0.writeUInt32BE(2, 0x50) // firstNonBookIndex
  rec0.writeUInt32BE(nameOffset, 0x54)
  rec0.writeUInt32BE(fullName.length, 0x58)
  // firstImageIndex：有封面时指向正文之后的那条记录；没有就留 0（= 没有图片区）。
  rec0.writeUInt32BE(cover ? (cover.firstImageIndex ?? 2) : 0, 0x6c)
  rec0.writeUInt32BE(exthRecords.length > 0 ? 0x40 : 0, 0x80)
  Buffer.concat([exth, exthBody]).copy(rec0, headerEnd)
  if (fullName.length > 0) fullName.copy(rec0, nameOffset)

  const records = [rec0, html]
  if (cover) records.push(cover.bytes)
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
