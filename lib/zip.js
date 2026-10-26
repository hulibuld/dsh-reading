/**
 * ZIP 读取与最小写入（零依赖，只用 node:zlib）。
 *
 * 范围刻意收窄到 EPUB 会用到的那一部分：
 *   - 只支持 store(0) 与 deflate(8) 两种压缩方法；
 *   - 不支持加密条目、不支持 Zip64（遇到就抛明确的错误码，不做半对半错的猜测）；
 *   - 文件名按 UTF-8 解码（EPUB 规范要求），不处理 CP437 回退。
 *
 * 为什么要自己写：EPUB 解析只需要「按名取条目」这一件事，引一个 ZIP 库等于引入
 * 一整个依赖树，而插件的硬约束是零运行时依赖（docs/05 §1）。
 *
 * 什么时候会失败、失败给谁看：
 *   - 坏包（找不到中央目录、签名不对、CRC 不符）→ 抛 `E_ZIP_MALFORMED`，
 *     由 epub.js 转成「这本书的文件似乎损坏了」，最终给用户看。
 *   - 加密条目 → `E_ZIP_ENCRYPTED`；Zip64 → `E_ZIP64`；未知压缩方法 → `E_ZIP_METHOD`。
 *   - 这些错误的 detail 里带条目名与偏移，只进日志，不进界面。
 */

import { inflateRawSync } from 'node:zlib'
import { fail } from './errors.js'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50

/** 中央目录里的大小/偏移用 4 字节；全 F 表示「真值在 Zip64 扩展字段里」。 */
const ZIP64_SENTINEL = 0xffffffff

const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

// ── CRC32 ─────────────────────────────────────────────────────────
// 不用 zlib.crc32：它在 Node 20.15 才落地，自己算 40 行更稳，也让校验逻辑
// 在测试里能单独调用。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/**
 * 计算 CRC32（ZIP 用的那个多项式）。
 * @param {Buffer|Uint8Array} bytes
 * @returns {number} 无符号 32 位整数
 */
export function crc32(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ── 读 ────────────────────────────────────────────────────────────

/**
 * 从尾部往前找 EOCD（End Of Central Directory）签名。
 * 注释最长 65535 字节，所以搜索窗口 = 22 + 65535。
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      // 校验注释长度是否恰好把文件收尾：能挡掉正文里碰巧出现的假签名。
      const commentLength = buf.readUInt16LE(i + 20)
      if (i + 22 + commentLength === buf.length) return i
    }
  }
  return -1
}

/** 读 Zip64 的 EOCD 记录只为了判断「是不是 Zip64」，不解析内容。 */
function isZip64(buf, eocdOffset) {
  const locatorOffset = eocdOffset - 20
  if (locatorOffset < 0) return false
  if (buf.readUInt32LE(locatorOffset) !== SIG_ZIP64_LOCATOR) return false
  // 定位器后面紧跟 Zip64 EOCD 记录头，签名对上才算数。
  const recordOffset = Number(buf.readBigUInt64LE(locatorOffset + 8))
  if (!Number.isSafeInteger(recordOffset) || recordOffset < 0 || recordOffset + 4 > buf.length) return false
  return buf.readUInt32LE(recordOffset) === SIG_ZIP64_EOCD
}

/**
 * 解一个条目。
 *
 * data descriptor（bit 3）的处理：本地头里的 size/crc 是 0，真值在压缩数据后面。
 * 我们不去猜 descriptor 的位置（它没有长度前缀、还可能带可选的 64 位 size），
 * 而是直接用中央目录里的 compressedSize 切片——这是规范允许且唯一的可靠来源。
 *
 * @param {Buffer} buf
 * @param {{ name: string, method: number, compressedSize: number, size: number, localOffset: number, crc: number, flags: number }} entry
 * @returns {Buffer}
 */
function extract(buf, entry) {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw fail('E_ZIP_ENCRYPTED', '这个压缩包里的文件是加密的，读不了。', {
      detail: `entry=${entry.name} flags=0x${entry.flags.toString(16)}`,
    })
  }
  const localOffset = entry.localOffset
  if (localOffset + 30 > buf.length) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `local header out of range: ${entry.name}@${localOffset}`,
    })
  }
  if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `bad local signature: ${entry.name}@${localOffset}`,
    })
  }
  const nameLength = buf.readUInt16LE(localOffset + 26)
  const extraLength = buf.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buf.length) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `entry data out of range: ${entry.name} ${dataStart}+${entry.compressedSize}`,
    })
  }
  const raw = buf.subarray(dataStart, dataEnd)

  let out
  if (entry.method === METHOD_STORE) {
    out = Buffer.from(raw)
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      // maxOutputLength 是第二道闸：即使中央目录谎报了一个小 size，inflate 也会
      // 在达到声明大小时停手，不会把整颗炸弹展开到内存里。
      //
      // **必须无条件传**。`entry.size === 0` 时原先传 undefined（不设上限），
      // 于是「声明 0 字节、实际展开几个 GB」的条目正好从这条缝里穿过去——
      // 中央目录的尺寸门禁看的是声明值，看不见真值。空表达的合法输出是 0 字节，
      // 上限给 1 就够；任何真的解出内容来的都会被 maxOutputLength 掐死。
      out = inflateRawSync(raw, { maxOutputLength: entry.size > 0 ? entry.size : 1 })
    } catch (error) {
      // 超出 maxOutputLength 说明「声明的 size 比实际小」——这是炸弹的特征，
      // 报成尺寸错误比报成「结构损坏」更贴近事实，调用方也好翻译。
      if (error && (error.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(String(error.message)))) {
        throw fail('E_ZIP_TOO_BIG', '这个压缩包解开后比它声明的大，已停下。', {
          detail: `inflate exceeded declared size: ${entry.name} declared=${entry.size}`,
          cause: error,
        })
      }
      throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
        detail: `inflate failed: ${entry.name} ${String(error && error.message)}`,
        cause: error,
      })
    }
  } else {
    throw fail('E_ZIP_METHOD', '这个压缩包用了不支持的方式压缩，读不了。', {
      detail: `method=${entry.method} entry=${entry.name}`,
    })
  }

  if (out.length !== entry.size) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `size mismatch: ${entry.name} got=${out.length} want=${entry.size}`,
    })
  }
  const actualCrc = crc32(out)
  // crc 为 0 且 size 为 0 是空文件，真实 CRC 也是 0，比较照样成立。
  if (actualCrc !== entry.crc) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `crc mismatch: ${entry.name} got=${actualCrc.toString(16)} want=${entry.crc.toString(16)}`,
    })
  }
  return out
}

/**
 * 读一个 ZIP 包。
 *
 * 返回的对象是**惰性**的：`read()` 才真正解压，所以列出目录不会把整本书展开。
 * 同一次读取不缓存（调用方按需自己缓存）；这样内存上限由调用方控制。
 *
 * 尺寸门禁**前置到中央目录阶段**（`limits`）：中央目录里就写着每个条目的解压后
 * 大小，先按这个值判上限，就永远不会为了「发现它太大」而先把它解开——防压缩炸弹
 * 的正确顺序是「先看声明尺寸，再解压」，不是「解开看看有多大」。谎报尺寸的那种
 * 再靠 inflate 的 maxOutputLength 兜第二层。
 *
 * @param {Buffer} buf - 整个 ZIP 文件的字节。
 * @param {{ maxEntryBytes?: number, maxTotalBytes?: number, maxEntries?: number }} [limits]
 * @returns {{
 *   entries: Array<{ name: string, size: number, compressedSize: number, method: number, flags: number, crc: number, read: () => Buffer }>,
 *   has: (name: string) => boolean,
 *   get: (name: string) => Buffer,
 *   totalSize: number
 * }}
 */
export function readZip(buf, limits = {}) {
  if (!Buffer.isBuffer(buf)) {
    if (!(buf instanceof Uint8Array)) {
      throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', { detail: 'input is not bytes' })
    }
    buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  if (buf.length < 22) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', { detail: `too short: ${buf.length}` })
  }

  const eocdOffset = findEocd(buf)
  if (eocdOffset < 0) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', { detail: 'EOCD not found' })
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4)
  const centralDisk = buf.readUInt16LE(eocdOffset + 6)
  const entriesOnDisk = buf.readUInt16LE(eocdOffset + 8)
  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `multi-disk zip: disk=${diskNumber}/${centralDisk} entries=${entriesOnDisk}/${totalEntries}`,
    })
  }

  if (
    isZip64(buf, eocdOffset) ||
    totalEntries === 0xffff ||
    centralSize === ZIP64_SENTINEL ||
    centralOffset === ZIP64_SENTINEL
  ) {
    throw fail('E_ZIP64', '这个 EPUB 用了 Zip64 格式，暂时不支持。', {
      detail: 'zip64 end of central directory detected',
    })
  }

  if (centralOffset + centralSize > buf.length) {
    throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
      detail: `central directory out of range: ${centralOffset}+${centralSize}`,
    })
  }

  if (Number.isInteger(limits.maxEntries) && totalEntries > limits.maxEntries) {
    throw fail('E_ZIP_TOO_BIG', '这个压缩包里的文件太多，已停下。', {
      detail: `entries=${totalEntries} limit=${limits.maxEntries}`,
    })
  }

  /** @type {Array<{ name: string, size: number, compressedSize: number, method: number, flags: number, crc: number, read: () => Buffer }>} */
  const entries = []
  const byName = new Map()
  let totalSize = 0

  let offset = centralOffset
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > buf.length) {
      throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
        detail: `central header out of range at #${i}`,
      })
    }
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
        detail: `bad central signature at #${i}@${offset}`,
      })
    }
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const crc = buf.readUInt32LE(offset + 16)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const size = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)

    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buf.length) {
      throw fail('E_ZIP_MALFORMED', '这个压缩包的结构不对，读不出内容。', {
        detail: `entry name out of range at #${i}`,
      })
    }
    const name = buf.toString('utf8', nameStart, nameEnd)

    if (
      compressedSize === ZIP64_SENTINEL ||
      size === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw fail('E_ZIP64', '这个 EPUB 用了 Zip64 格式，暂时不支持。', {
        detail: `zip64 entry: ${name}`,
      })
    }

    const record = {
      name,
      size,
      compressedSize,
      method,
      flags,
      crc,
      /** 解出这个条目；失败抛上面的错误码。 */
      read: () => extract(buf, { name, method, compressedSize, size, localOffset, crc, flags }),
    }

    // 尺寸门禁在**中央目录阶段**就判，不解压：防压缩炸弹的正确顺序是
    // 「先看声明尺寸，再决定解不解」，不是「解开看看有多大」。谎报尺寸的
    // 那种再由 extract() 里的 maxOutputLength 兜第二层。
    if (Number.isInteger(limits.maxEntryBytes) && size > limits.maxEntryBytes) {
      throw fail('E_ZIP_TOO_BIG', '这个压缩包里的文件解开后太大了，已停下。', {
        detail: `entry too big: ${name} ${size} > ${limits.maxEntryBytes}`,
      })
    }
    totalSize += size
    if (Number.isInteger(limits.maxTotalBytes) && totalSize > limits.maxTotalBytes) {
      throw fail('E_ZIP_TOO_BIG', '这个压缩包解开后太大了，已停下。', {
        detail: `total too big: ${totalSize} > ${limits.maxTotalBytes}`,
      })
    }

    entries.push(record)
    // 同名条目：规范里不允许，真出现了取第一条（与大多数解压器一致）。
    if (!byName.has(name)) byName.set(name, record)

    offset = nameEnd + extraLength + commentLength
  }

  return {
    entries,
    totalSize,
    has: (name) => byName.has(String(name)),
    get: (name) => {
      const record = byName.get(String(name))
      if (!record) {
        throw fail('E_ZIP_MISSING', '这个压缩包里没有要找的文件。', { detail: `missing entry: ${name}` })
      }
      return record.read()
    },
  }
}

// ── 写（仅 store，测试与 fixture 用） ───────────────────────────────

function dosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()))
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2) & 0x1f)
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, day }
}

/**
 * 写一个 ZIP 包（全部 store 不压缩）。
 *
 * 只给测试和 fixture 生成用：产物必须**字节稳定**（同一份输入两次写出的字节相同），
 * 否则 golden 与书库哈希都不成立。所以时间戳取传入的 fixedDate（默认固定值），
 * 不读系统时钟。
 *
 * @param {Array<{ name: string, data?: Buffer|string, mtime?: Date }>} entries
 * @param {{ mtime?: Date }} [options]
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const fixedDate = options.mtime ?? new Date(Date.UTC(2020, 0, 1, 0, 0, 0))
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = String(entry.name)
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : Buffer.from(entry.data ?? [])
    const crc = crc32(data)
    const { time, day } = dosDateTime(entry.mtime ?? fixedDate)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // bit 11: name is UTF-8
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBytes, data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(SIG_CENTRAL, 0)
    header.writeUInt16LE(20, 4) // version made by
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(METHOD_STORE, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(day, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attrs
    header.writeUInt32LE(0, 38) // external attrs
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, eocd])
}

export const ZIP_METHOD_STORE = METHOD_STORE
export const ZIP_METHOD_DEFLATE = METHOD_DEFLATE
export const ZIP_FLAG_DATA_DESCRIPTOR = FLAG_DATA_DESCRIPTOR
