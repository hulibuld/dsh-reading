/**
 * lib/zip.js 的测试。
 *
 * 覆盖的是「真包长什么样」而不是 API 表面积：
 *   - store 与 deflate 两种方法都能读对；
 *   - data descriptor（general purpose bit 3）的条目——本地头里 size/crc 是 0，
 *     真值只在中央目录，这是 EPUB 里最常见的一种写法；
 *   - Zip64 明确抛 E_ZIP64，不做半对半错的猜测；
 *   - CRC / 长度不符要报错（静默放过等于把损坏的书当好的）。
 *
 * 测试里自造 ZIP 字节，不用外部 fixture：这样每条断言的真值都在本文件里看得见。
 */

import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { readZip, writeZip, crc32 } from '../lib/zip.js'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/**
 * 手搓一个「带 data descriptor」的 ZIP：bit 3 置位，本地头里的 crc/size 全为 0，
 * 真值放在压缩数据后面的 descriptor（签名 0x08074b50）里，同时中央目录里也有一份。
 *
 * @param {{ name: string, data: Buffer, method?: number }} entry
 */
function buildZipWithDescriptor(entry) {
  const nameBytes = Buffer.from(entry.name, 'utf8')
  const method = entry.method ?? 8
  const body = method === 8 ? deflateRawSync(entry.data) : entry.data
  const crc = crc32(entry.data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(SIG_LOCAL, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0808, 6) // bit 3（descriptor）+ bit 11（UTF-8）
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0x21, 12) // 1980-01-01
  local.writeUInt32LE(0, 14) // ← 刻意留 0：真值在 descriptor 里
  local.writeUInt32LE(0, 18)
  local.writeUInt32LE(0, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)

  const descriptor = Buffer.alloc(16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(crc, 4)
  descriptor.writeUInt32LE(body.length, 8)
  descriptor.writeUInt32LE(entry.data.length, 12)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(SIG_CENTRAL, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0808, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc, 16) // ← 中央目录里必须有真值
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(entry.data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(0, 42)

  const head = Buffer.concat([local, nameBytes, body, descriptor])
  const directory = Buffer.concat([central, nameBytes])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(head.length, 16)
  return Buffer.concat([head, directory, eocd])
}

/** 造一个 Zip64 形态的包：EOCD 里条目数写 0xffff，触发明确拒绝。 */
function buildZip64Sentinel() {
  const base = writeZip([{ name: 'a.txt', data: 'x' }])
  const copy = Buffer.from(base)
  const eocd = copy.length - 22
  copy.writeUInt16LE(0xffff, eocd + 8)
  copy.writeUInt16LE(0xffff, eocd + 10)
  return copy
}

/** 造一个带 Zip64 定位器 + Zip64 EOCD 记录的真形态包。 */
function buildZip64Locator() {
  const base = writeZip([{ name: 'a.txt', data: 'hello' }])
  const withoutEocd = base.subarray(0, base.length - 22)
  const zip64EocdOffset = withoutEocd.length

  const zip64Eocd = Buffer.alloc(56)
  zip64Eocd.writeUInt32LE(0x06064b50, 0)
  zip64Eocd.writeBigUInt64LE(44n, 4)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
  locator.writeUInt32LE(1, 16)

  // 规范顺序：…中央目录 → Zip64 EOCD → Zip64 定位器 → EOCD。
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(0xffffffff, 12) // central size 用哨兵
  eocd.writeUInt32LE(0, 16)

  return Buffer.concat([withoutEocd, zip64Eocd, locator, eocd])
}

/**
 * 造一个**中央目录谎报尺寸**的包：声明 size=0，实际 deflate 数据展开有 bombBytes 字节。
 *
 * 这是压缩炸弹的标准写法，也是 docs/06 审计抓出的 high 缺陷的样本：
 * 中央目录阶段的尺寸门禁看的是声明值（0，永远合法），真正的上限只能靠
 * inflate 的 maxOutputLength 兜。若那里在 size===0 时漏传选项，这颗炸弹
 * 就会直接展开到内存里。
 *
 * @param {number} bombBytes 实际展开的字节数
 */
function buildLyingSizeZip(bombBytes) {
  const nameBytes = Buffer.from('bomb.bin', 'utf8')
  const payload = Buffer.alloc(bombBytes, 0x41) // 全 'A'，deflate 压缩率极高
  const body = deflateRawSync(payload)
  // 压缩率约 1000:1（20 MB → 约 20 KB）。断言它确实是个「小输入大输出」的炸弹。
  assert.ok(body.length * 100 < bombBytes, `炸弹的压缩体应当远小于展开尺寸，实际 ${body.length} vs ${bombBytes}`)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(SIG_LOCAL, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt16LE(0x21, 10)
  local.writeUInt32LE(crc32(payload), 14) // 本地头的 crc 是真值
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(0, 22) // ← 谎报：uncompressed size = 0
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(SIG_CENTRAL, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(0x21, 12)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc32(payload), 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(0, 24) // ← 谎报：uncompressed size = 0
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)

  const head = Buffer.concat([local, nameBytes, body])
  const directory = Buffer.concat([central, nameBytes])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(head.length, 16)
  return Buffer.concat([head, directory, eocd])
}

/** 期望某个调用抛指定 code。 */
function expectCode(code, fn) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `期望抛 ${code}，但什么都没抛`)
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught.code}（${caught.message}）`)
  return caught
}

export default async function run() {
  // ── 1. store（不压缩） ──
  const stored = writeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container/>' },
    { name: 'text/ch1.xhtml', data: '<html><body>第一章</body></html>' },
  ])
  const storedZip = readZip(stored)
  assert.equal(storedZip.entries.length, 3)
  assert.equal(storedZip.get('mimetype').toString(), 'application/epub+zip')
  assert.equal(storedZip.get('text/ch1.xhtml').toString(), '<html><body>第一章</body></html>')
  assert.equal(storedZip.entries[0].method, 0, 'writeZip 必须用 store(0)')
  assert.ok(storedZip.has('META-INF/container.xml'))
  assert.equal(storedZip.has('nope'), false)
  assert.equal(storedZip.entries[2].size, Buffer.byteLength('<html><body>第一章</body></html>'))
  expectCode('E_ZIP_MISSING', () => storedZip.get('nope'))

  // 二进制内容必须逐字节一致（图片不能过文本编码）
  const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f])
  const withBinary = readZip(writeZip([{ name: 'images/a.png', data: binary }]))
  assert.deepEqual(withBinary.get('images/a.png'), binary)

  // ── 2. deflate ──
  const deflated = buildZipWithDescriptor({
    name: 'text/ch1.xhtml',
    data: Buffer.from('<html><body>' + '你好，世界。'.repeat(50) + '</body></html>'),
    method: 8,
  })
  const deflatedZip = readZip(deflated)
  const deflatedEntry = deflatedZip.entries[0]
  assert.equal(deflatedEntry.method, 8, '这条必须是 deflate')
  assert.ok(deflatedEntry.flags & 0x0008, 'bit 3 必须被识别为 data descriptor')
  assert.ok(deflatedEntry.compressedSize < deflatedEntry.size, '压缩后应该更小')
  assert.equal(
    deflatedZip.get('text/ch1.xhtml').toString(),
    '<html><body>' + '你好，世界。'.repeat(50) + '</body></html>',
  )

  // ── 3. data descriptor + store 方法（两条路径都要过） ──
  const storedDescriptor = buildZipWithDescriptor({
    name: 'mimetype',
    data: Buffer.from('application/epub+zip'),
    method: 0,
  })
  assert.equal(readZip(storedDescriptor).get('mimetype').toString(), 'application/epub+zip')

  // ── 4. Zip64 → E_ZIP64 ──
  expectCode('E_ZIP64', () => readZip(buildZip64Sentinel()))
  expectCode('E_ZIP64', () => readZip(buildZip64Locator()))

  // ── 5. 坏包 ──
  expectCode('E_ZIP_MALFORMED', () => readZip(Buffer.from('not a zip at all')))
  expectCode('E_ZIP_MALFORMED', () => readZip(Buffer.alloc(8)))

  const corrupted = Buffer.from(stored)
  // 把 ch1 的正文首字节改掉：CRC 必然不符。
  const bodyIndex = corrupted.indexOf(Buffer.from('<html><body>第一章'))
  assert.ok(bodyIndex > 0)
  corrupted[bodyIndex + 5] = 0x58 // '<' → 'X'
  expectCode('E_ZIP_MALFORMED', () => readZip(corrupted).get('text/ch1.xhtml'))

  // 中央目录签名坏掉
  const brokenCentral = Buffer.from(stored)
  const centralOffset = brokenCentral.readUInt32LE(brokenCentral.length - 22 + 16)
  brokenCentral.writeUInt32LE(0xdeadbeef, centralOffset)
  expectCode('E_ZIP_MALFORMED', () => readZip(brokenCentral))

  // ── 5b. 压缩炸弹：中央目录谎报 size=0，必须被 maxOutputLength 掐死 ──
  // 20 MB 全 'A' 压缩后只有几 KB。声明 size=0 让中央目录门禁看不见它，
  // 只有 inflate 的上限能拦住——正是审计指出的那条缝。
  const bomb = buildLyingSizeZip(20 * 1024 * 1024)
  const bombZip = readZip(bomb) // 中央目录阶段应当放行（声明 0 字节）
  assert.equal(bombZip.entries.length, 1)
  assert.equal(bombZip.entries[0].size, 0, '这条炸弹的声明尺寸必须是 0（否则测不到这条缝）')
  expectCode('E_ZIP_TOO_BIG', () => bombZip.get('bomb.bin'))

  // 声明 0、实际也真是 0 字节的条目仍然要能正常读（上限不能误伤空文件）
  const emptyOk = readZip(writeZip([{ name: 'empty.txt', data: '' }]))
  assert.equal(emptyOk.get('empty.txt').length, 0, '空文件必须能正常解出')

  // ── 6. CRC32 本身 ──
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC32 标准校验值')
  assert.equal(crc32(Buffer.alloc(0)), 0)

  // ── 7. 字节稳定：同一输入两次写出完全一致（fixture 与 golden 依赖这条） ──
  const a = writeZip([{ name: 'x', data: 'y' }])
  const b = writeZip([{ name: 'x', data: 'y' }])
  assert.deepEqual(a, b)

  // ── 8. 惰性：列出条目不解压（read() 才真正 inflate） ──
  const lazy = readZip(deflated)
  assert.equal(lazy.entries.length, 1)
  assert.equal(typeof lazy.entries[0].read, 'function')
  assert.equal(lazy.entries[0].read().toString().slice(0, 12), '<html><body>')
}
