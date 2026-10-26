/**
 * 极简 ZIP 读写：只支持 store（方法 0），够 golden fixture 用。
 *
 * 为什么不用 JSZip：golden 必须能在「只有 jsdom + ajv 两个 devDependency」的干净 clone 里跑，
 * 多加一个包就多一处安装失败点；而且 fixture 是测试数据，不需要压缩率。
 * 为什么不用 lib/zip.js：那是宿主侧模块，golden 要能在浏览器半改动后独立验证锚点核心。
 *
 * 不支持：deflate、Zip64、加密、data descriptor。遇到就用明确的中文报错拒绝，
 * 不做「尽力而为」——静默读错会让 fixture 与向量悄悄失去对应关系。
 */

import { crc32 } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** 自己算 CRC32：node:zlib 的 crc32 是 20.15 才有的，这里留条退路。 */
const crcOf = (buf) => {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const dosDateTime = (date) => {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f)
  return { time, day }
}

/**
 * 写一个 store-only ZIP。
 *
 * @param {Array<{name:string, data:Buffer|Uint8Array|string}>} entries 顺序即写入顺序
 * @param {{date?: Date}} [options] 固定时间戳可让产物字节级可复现
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const date = options.date ?? new Date(Date.UTC(2020, 0, 1, 0, 0, 0))
  const { time, day } = dosDateTime(date)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || entry.name === '') {
      throw new Error('writeZip: 每个条目都必须有非空 name')
    }
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data instanceof Uint8Array ? entry.data : String(entry.data ?? ''), 'utf8')
    const checksum = crcOf(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 名称
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CEN_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10) // store
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

/**
 * 读 store-only ZIP，返回 `{ names(), has(name), read(name) }`。
 * 路径按条目名精确匹配（EPUB 里就是 `OEBPS/text/ch1.xhtml` 这种）。
 *
 * @param {Buffer} buf
 */
export function readZip(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('readZip: 找不到 EOCD，不是 ZIP')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === 0xffffffff) throw new Error('readZip: 不支持 Zip64')

  const entries = new Map()
  let cursor = centralOffset
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== CEN_SIG) {
      throw new Error(`readZip: 第 ${i} 条中央目录签名不对`)
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    if (method !== 0) {
      throw new Error(`readZip: ${name} 用了压缩方法 ${method}，本读取器只支持 store（0）`)
    }
    if (buffer.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`readZip: ${name} 的本地头签名不对`)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    entries.set(name, {
      name,
      size,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    })
    cursor += 46 + nameLen + extraLen + commentLen
  }

  return {
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    read(name) {
      const entry = entries.get(name)
      if (!entry) throw new Error(`readZip: 没有条目 ${name}`)
      return entry.data
    },
    readText(name) {
      return this.read(name).toString('utf8')
    },
  }
}
