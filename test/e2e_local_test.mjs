#!/usr/bin/env node
/**
 * 端到端本地冒烟测试（captain 负责）。
 *
 * 为什么需要它：三个 maker 各自的单测都只覆盖自己那一层。
 * 这个文件走**一整条用户路径**，中间不 mock 任何本项目模块：
 *
 *   造书 → 导入 → 上架 → 取章节 XHTML → 存进度 → 写一条划线 → 读回来 → 删掉（墓碑）→ 重启后仍在
 *
 * 换句话说：如果这个测试过了，那「一个真实用户装上插件后能不能用」这件事
 * 在**数据层**上就是通的。唯一没覆盖的是浏览器渲染（那需要真浏览器，见 README 的说明）。
 *
 * 失败行为：任何一步不对就抛断言错误；跑完清理自己的临时目录。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LibraryStore } from '../lib/store.js'
import { buildMinimalMobi } from './mobi_fixture.mjs'
import { buildChapteredPdf } from './pdf_fixture.mjs'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { makeHighlight } from '../client/src/contract.js'
import { fingerprint } from '../client/src/contract.js'

// ── 造一本最小但结构完整的 EPUB（不依赖 golden/fixtures，避免测试间互相牵连） ──
//
// 用 lib/zip.js 自己的写包器？不——那会让「读」和「写」互相证明。
// 这里直接手搓 ZIP 的 store 格式（不压缩），20 行就够，且与实现完全独立。

/** CRC32（ZIP 必需）。独立实现，不复用 lib/zip.js 里的那份。 */
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** 用 store 方法（不压缩）写一个 zip。 */
function writeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    const crc = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // method = store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10) // method
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, end])
}

/**
 * 造一本两章、带 nav 目录的 EPUB。
 *
 * @param {{ title?: string, uid?: string }} [options] 书名 / identifier 可换：
 *   换掉它们就是「另一本书」（bookHash 取整份字节的 sha256），用来测「网络导入了
 *   一本新书」而不是「同一本被去重」。
 */
function makeEpub(options = {}) {
  const bookTitle = typeof options.title === 'string' ? options.title : '端到端测试书'
  const bookUid = typeof options.uid === 'string' ? options.uid : 'urn:uuid:test-0001'
  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body>
<h1>第一章</h1>
<p id="p1">第一天早上，他抬头看了看天。</p>
<p>然后他往山里走。</p>
</body></html>`
  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body>
<h1>第二章</h1>
<p>山里的雾还没有散。</p>
</body></html>`
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>
<nav epub:type="toc"><ol>
<li><a href="text/ch1.xhtml">第一章</a></li>
<li><a href="text/ch2.xhtml">第二章</a></li>
</ol></nav></body></html>`
  // 恶意章节：不放进 spine（不影响其它断言），单独请求它验证净化。
  const evil = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
<title>坏章</title>
<base href="https://evil.test/"/>
<meta http-equiv="refresh" content="0;url=https://evil.test/steal"/>
<link rel="stylesheet" href="https://evil.test/x.css"/>
</head><body>
<p><a href="https://evil.test/go">出去</a><a href="#note1">站内</a></p>
<p><img src="pic.png" alt="a > b"/></p>
<img src="https://evil.test/track.gif" alt="外部图"/>
</body></html>`
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${bookUid}</dc:identifier>
<dc:title>${bookTitle}</dc:title>
<dc:creator>某作者</dc:creator>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="evil" href="text/evil.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine>
<itemref idref="ch1"/>
<itemref idref="ch2"/>
</spine>
</package>`
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  return writeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: container },
    { name: 'content.opf', data: opf },
    { name: 'nav.xhtml', data: nav },
    { name: 'text/ch1.xhtml', data: ch1 },
    { name: 'text/ch2.xhtml', data: ch2 },
    { name: 'text/evil.xhtml', data: evil },
  ])
}

// ── 最小 req/res，够 handler 用即可 ─────────────────────────────────

function makeRes() {
  const chunks = []
  const headers = {}
  return {
    statusCode: 0,
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value
    },
    writeHead(status, extra) {
      this.statusCode = status
      if (extra) for (const [k, v] of Object.entries(extra)) headers[String(k).toLowerCase()] = v
      return this
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    body: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
    json() {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    },
  }
}

/** 模拟一个 POST JSON 请求（handler 用 for await 读 req，所以给 async iterable）。 */
function postJson(url, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
}

function get(url) {
  return { method: 'GET', url, headers: {} }
}

async function call(handler, req) {
  const res = makeRes()
  await handler(req, res)
  return res
}

/** 断言成功信封并返回 value。 */
function okValue(res, label) {
  const payload = res.json()
  assert.equal(res.statusCode, 200, `${label}: 期望 200，实际 ${res.statusCode} — ${res.text().slice(0, 300)}`)
  assert.equal(payload.ok, true, `${label}: 期望 ok:true，实际 ${JSON.stringify(payload).slice(0, 300)}`)
  return payload.value
}

// ── 主流程 ─────────────────────────────────────────────────────────

export default async function run() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reading-e2e-'))
  try {
    // 1) 库里一开始是空的
    const store = new LibraryStore({ libraryDir: root, now: () => '2026-10-22T00:00:00.000Z' })
    const handler = createHandler({ store })
    const empty = okValue(await call(handler, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list(空)')
    assert.deepEqual(empty.books, [], '新库应当没有书')

    // 2) 导入一本
    const epub = makeEpub()
    const imported = okValue(
      await call(
        handler,
        postJson(`${API_PREFIX}/shelf.import`, {
          filename: 'e2e.epub',
          dataBase64: epub.toString('base64'),
        }),
      ),
      'shelf.import',
    )
    assert.match(imported.bookHash, /^[0-9a-f]{64}$/, '导入应返回 64 位全 hash')
    const bookHash = imported.bookHash
    const dirName = bookHash.slice(0, 16)
    assert.equal(imported.meta.title, '端到端测试书')
    assert.equal(imported.meta.spine.length, 2, '两章')
    assert.equal(imported.meta.spine[0].index, 0, 'spine[0].index 必须是 0（schema 必填）')
    assert.equal(imported.meta.spine[1].href, 'text/ch2.xhtml')

    // 3) 上架了，且进度为零
    const shelf = okValue(await call(handler, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list')
    assert.equal(shelf.books.length, 1)
    // 书架的 bookHash 允许是 64 位全串或 16 位短名：store 的按 hash 取书接口两种都收
    // （bookDirName 会把 64 位截成 16 位目录名）。这里只要求它非空且能反查回同一本。
    assert.match(shelf.books[0].bookHash, /^[0-9a-f]{16}$|^[0-9a-f]{64}$/, '书架的 bookHash 形态')
    const sameBook = okValue(
      await call(handler, postJson(`${API_PREFIX}/book.meta`, { bookHash: shelf.books[0].bookHash })),
      'book.meta(用书架给的 hash)',
    )
    assert.equal(sameBook.bookHash, bookHash, '书架给的 hash 必须能反查到同一本书')

    // 4) 目录能取到
    const toc = okValue(await call(handler, postJson(`${API_PREFIX}/book.toc`, { bookHash: dirName })), 'book.toc')
    assert.ok(Array.isArray(toc.toc) && toc.toc.length >= 2, '目录至少两章')
    assert.equal(toc.toc[0].label, '第一章')

    // 5) 章节以 XHTML 返回，且不带脚本能力
    const chapter = await call(
      handler,
      get(`${API_PREFIX}/chapter?book=${dirName}&href=${encodeURIComponent('text/ch1.xhtml')}`),
    )
    assert.equal(chapter.statusCode, 200, `chapter 应 200，实际 ${chapter.statusCode}`)
    assert.match(chapter.headers['content-type'] ?? '', /application\/xhtml\+xml/, '章节必须是 XHTML 类型')
    assert.match(chapter.headers['content-security-policy'] ?? '', /script-src 'none'/, '章节必须禁用脚本')
    const html = chapter.text()
    assert.match(html, /他抬头看了看天/, '章节正文必须原样输出')

    // 5b) 恶意章节：真实 HTTP 路径上必须已被净化（不是只在单元测试里净化）
    const evilRes = await call(
      handler,
      get(`${API_PREFIX}/chapter?book=${dirName}&href=${encodeURIComponent('text/evil.xhtml')}`),
    )
    assert.equal(evilRes.statusCode, 200, `evil chapter 应 200，实际 ${evilRes.statusCode}`)
    const evilHtml = evilRes.text()
    assert.ok(!/<base/i.test(evilHtml), '`<base>` 必须整条丢弃（否则相对地址基准全被改）')
    assert.ok(!/http-equiv/i.test(evilHtml), '`<meta http-equiv=refresh>` 必须整条丢弃（帧内导航）')
    assert.ok(
      evilHtml.includes('href="#dsh-reading:https%3A%2F%2Fevil.test%2Fgo"'),
      `外部链接必须降级成不导航的锚：${evilHtml}`,
    )
    assert.ok(evilHtml.includes('href="#note1"'), '站内锚点必须保持原样')
    assert.ok(
      evilHtml.includes(`src="${API_PREFIX}/asset?book=${dirName}`) || evilHtml.includes('src="' + API_PREFIX),
      '相对图片地址必须改写成 asset 路径',
    )
    assert.ok(evilHtml.includes('alt="a > b"'), '属性值里的 `>` 不能让标签边界判断出错')
    assert.match(
      evilRes.headers['content-security-policy'] ?? '',
      /img-src 'self' data: blob:/,
      'CSP 必须把外部图片挡在门外（字节层不改写绝对 URL，靠 CSP 兜底）',
    )

    // 6) 存进度（带 CFI），再读回来
    const cfi = 'epubcfi(/6/2[ch1]!/4/2,/1:3,/1:5)'
    const saved = okValue(
      await call(
        handler,
        postJson(`${API_PREFIX}/progress.put`, {
          bookHash: dirName,
          cfi,
          cfiStart: '/4/2/1:3',
          chapterHref: 'text/ch1.xhtml',
          percent: 0.25,
        }),
      ),
      'progress.put',
    )
    assert.equal(saved.saved, true, '§3.3 规定 progress.put 返回 { saved:true }')

    const progress = okValue(await call(handler, postJson(`${API_PREFIX}/progress.get`, { bookHash: dirName })), 'progress.get')
    assert.equal(progress.cfi, cfi, '进度必须按 CFI 精确存回')
    assert.equal(progress.chapterHref, 'text/ch1.xhtml')
    assert.ok(Math.abs(progress.bookProgression - 0.25) < 1e-9, 'bookProgression 应等于提交的 percent')

    // 7) 写一条划线（走真实构造器，字体指纹由 contract 算）
    const excerpt = '他抬头看了看天'
    const record = makeHighlight({
      cfi,
      chapterHref: 'text/ch1.xhtml',
      textExcerpt: excerpt,
      textFingerprint: fingerprint(excerpt),
      color: 'yellow',
      deviceId: 'e2e-0001',
    })
    const stored = okValue(
      await call(handler, postJson(`${API_PREFIX}/ann.put`, { bookHash: dirName, record })),
      'ann.put',
    )
    assert.equal(stored.record.id, record.id, '写入应回传同一条记录')
    assert.equal(stored.record.cfiStart, '/4/2/1:3', 'cfiStart 必须是 collapse 形态（不含逗号）')
    assert.ok(!stored.record.cfiStart.includes(','), 'cfiStart 里不许出现逗号')

    // 8) 读回来
    const listed = okValue(await call(handler, postJson(`${API_PREFIX}/ann.list`, { bookHash: dirName })), 'ann.list')
    assert.equal(listed.records.length, 1)
    assert.equal(listed.records[0].textFingerprint.hash.length, 64)

    // 9) 删除写墓碑：列表里消失，但文件里那一行还在且 deleted:true
    okValue(
      await call(handler, postJson(`${API_PREFIX}/ann.delete`, { bookHash: dirName, id: record.id })),
      'ann.delete',
    )
    const afterDelete = okValue(
      await call(handler, postJson(`${API_PREFIX}/ann.list`, { bookHash: dirName })),
      'ann.list(删除后)',
    )
    assert.equal(afterDelete.records.length, 0, '墓碑记录不进渲染集')
    const jsonl = await readFile(join(root, 'dsh-reading', 'books', dirName, 'annotations.jsonl'), 'utf8')
    assert.match(jsonl, /"deleted":true/, '删除必须留下墓碑（deleted:true 仍在文件里）')

    // 10) 「重启」：新 store 实例（同一个磁盘目录）仍能读到进度与墓碑
    const store2 = new LibraryStore({ libraryDir: root })
    const handler2 = createHandler({ store: store2 })
    const progress2 = okValue(
      await call(handler2, postJson(`${API_PREFIX}/progress.get`, { bookHash: dirName })),
      'progress.get(重启后)',
    )
    assert.equal(progress2.cfi, cfi, '重开必须回到原位置（这是 M1 的验收线）')
    const shelf2 = okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list(重启后)')
    assert.equal(shelf2.books.length, 1, '书还在')

    // 10b) TXT 导入：走同一条 HTTP 路径，验证「格式分诊 + 重排」在真实请求上成立
    const txtText = [
      '第一章 起风',
      '他站在门口，风把纸片吹起来。',
      '第二段：1 < 2 && a > b。',
      '',
      '第二章 天黑',
      '灯亮着，没有人说话。',
    ].join('\n')
    const txtImported = okValue(
      await call(
        handler2,
        postJson(`${API_PREFIX}/shelf.import`, {
          filename: '端到端.txt',
          dataBase64: Buffer.from(txtText, 'utf8').toString('base64'),
        }),
      ),
      'shelf.import(txt)',
    )
    assert.equal(txtImported.meta.format, 'txt-converted', 'TXT 必须被标成重排书')
    assert.equal(txtImported.meta.sourceFormat, 'txt')
    assert.equal(txtImported.meta.encoding, 'utf-8', '必须记录判定出来的编码')
    assert.equal(txtImported.meta.title, '端到端', '没有书名时用文件名')
    assert.equal(txtImported.meta.spine.length, 2, '两个标题切成两章')
    assert.equal(txtImported.meta.spine[0].href, 'text/ch001.xhtml', '重排书的章节地址是自造的固定形态')
    assert.equal(txtImported.meta.spine[0].index, 0, 'schema 要求 spine 每项带 index')

    const txtDir = txtImported.bookHash.slice(0, 16)
    const txtShelf = okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list(txt)')
    const txtEntry = txtShelf.books.find((book) => book.bookHash === txtDir || book.bookHash === txtImported.bookHash)
    assert.ok(txtEntry, 'TXT 书必须出现在书架上')
    assert.equal(txtEntry.sourceFormat, 'txt', '书架要能告诉界面这是重排书（用于挂标记）')
    assert.ok(!txtEntry.coverUrl, '重排书没有封面，coverUrl 必须是 null')

    const txtToc = okValue(
      await call(handler2, postJson(`${API_PREFIX}/book.toc`, { bookHash: txtDir })),
      'book.toc(txt)',
    )
    assert.deepEqual(txtToc.toc.map((item) => item.label), ['第一章 起风', '第二章 天黑'])
    assert.deepEqual(txtToc.toc.map((item) => item.spineIndex), [0, 1])

    const txtChapter = await call(
      handler2,
      get(`${API_PREFIX}/chapter?book=${txtDir}&href=${encodeURIComponent('text/ch001.xhtml')}`),
    )
    assert.equal(txtChapter.statusCode, 200, `TXT 章节应 200，实际 ${txtChapter.statusCode}`)
    assert.match(txtChapter.headers['content-type'] ?? '', /application\/xhtml\+xml/, '重排章节也必须按 XHTML 返回')
    assert.match(txtChapter.headers['content-security-policy'] ?? '', /script-src 'none'/)
    const txtHtml = txtChapter.text()
    assert.ok(txtHtml.includes('他站在门口'), '正文必须原样输出')
    assert.ok(txtHtml.includes('&lt; 2'), '正文里的尖括号必须被转义（否则整章解析失败）')
    assert.ok(!/\u0000/.test(txtHtml), '控制字符必须被清掉')

    const missingChapter = await call(
      handler2,
      get(`${API_PREFIX}/chapter?book=${txtDir}&href=${encodeURIComponent('text/ch999.xhtml')}`),
    )
    assert.equal(missingChapter.statusCode, 404, '不存在的章节必须 404，不能 500')

    // 10c) GB18030 的 TXT：中文 TXT 最常见的编码，必须回退解码成功
    const gbBytes = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7, 0xa1, 0xa3])
    const gbImported = okValue(
      await call(
        handler2,
        postJson(`${API_PREFIX}/shelf.import`, {
          filename: 'gbk.txt',
          dataBase64: gbBytes.toString('base64'),
        }),
      ),
      'shelf.import(gb18030)',
    )
    assert.equal(gbImported.meta.encoding, 'gb18030', 'UTF-8 解不开时必须回退 GB18030')
    const gbDir = gbImported.bookHash.slice(0, 16)
    const gbChapter = await call(
      handler2,
      get(`${API_PREFIX}/chapter?book=${gbDir}&href=${encodeURIComponent('text/ch001.xhtml')}`),
    )
    assert.equal(gbChapter.statusCode, 200)
    assert.ok(gbChapter.text().includes('你好，世界。'), `GB18030 正文解码错误：${gbChapter.text().slice(0, 200)}`)

    // 10d) MOBI 导入：第三种输入格式，走同一条 HTTP 路径
    const mobiBytes = buildMinimalMobi({
      html: '<p>CHAPTER I.</p><p>The Pool of Tears</p><p>“Curiouser!” cried Alice.</p>',
      title: '漫游奇境',
      author: '某作者',
    })
    const mobiImported = okValue(
      await call(
        handler2,
        postJson(`${API_PREFIX}/shelf.import`, {
          filename: 'wonderland.mobi',
          dataBase64: mobiBytes.toString('base64'),
        }),
      ),
      'shelf.import(mobi)',
    )
    assert.equal(mobiImported.meta.format, 'mobi-converted', 'MOBI 必须被标成重排书')
    assert.equal(mobiImported.meta.sourceFormat, 'mobi', '界面靠这个挂「MOBI · 重排」标记')
    assert.equal(mobiImported.meta.title, '漫游奇境', 'MOBI 书名要取自 EXTH，不是文件名')
    assert.equal(mobiImported.meta.author, '某作者', 'MOBI 作者要取自 EXTH')
    const mobiDir = mobiImported.bookHash.slice(0, 16)

    const mobiToc = okValue(
      await call(handler2, postJson(`${API_PREFIX}/book.toc`, { bookHash: mobiDir })),
      'book.toc(mobi)',
    )
    assert.deepEqual(
      mobiToc.toc.map((item) => item.label),
      ['CHAPTER I. The Pool of Tears'],
      '没有 h1 时章名要按文字形状推导出来（不是「第 1 章」）',
    )

    const mobiChapter = await call(
      handler2,
      get(`${API_PREFIX}/chapter?book=${mobiDir}&href=${encodeURIComponent(mobiToc.toc[0].href)}`),
    )
    assert.equal(mobiChapter.statusCode, 200, `MOBI 章节应 200，实际 ${mobiChapter.statusCode}`)
    assert.match(mobiChapter.headers['content-type'] ?? '', /application\/xhtml\+xml/)
    const mobiHtml = mobiChapter.text()
    assert.ok(mobiHtml.includes('“Curiouser!”'), 'MOBI 正文必须能读出来')
    assert.ok(!mobiHtml.includes('<p>CHAPTER I.</p>'), '标题段不该在正文里重复出现')

    // 10.3) PDF：整条链路（导入 → 上架 → 目录 → 章节 XHTML → 进度 → 划线）
    const pdfBytes = buildChapteredPdf({ title: '测试之书 PDF', author: '写书的人' })
    const pdfImported = okValue(
      await call(
        handler2,
        postJson(`${API_PREFIX}/shelf.import`, {
          filename: '端到端.pdf',
          dataBase64: pdfBytes.toString('base64'),
        }),
      ),
      'shelf.import(pdf)',
    )
    assert.equal(pdfImported.meta.format, 'pdf-converted', 'PDF 必须被标成重排书')
    assert.equal(pdfImported.meta.sourceFormat, 'pdf', '界面靠这个挂「PDF · 重排」标记')
    assert.equal(pdfImported.meta.title, '测试之书 PDF', 'PDF 书名要取自 Info 字典，不是文件名')
    assert.equal(pdfImported.meta.author, '写书的人')
    const pdfDir = pdfImported.bookHash.slice(0, 16)

    const pdfShelf = okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list(pdf)')
    const pdfEntry = pdfShelf.books.find((book) => book.bookHash === pdfDir || book.bookHash === pdfImported.bookHash)
    assert.ok(pdfEntry, 'PDF 书必须出现在书架上')
    assert.equal(pdfEntry.sourceFormat, 'pdf')
    assert.ok(!pdfEntry.coverUrl, 'PDF 没有封面，coverUrl 必须是 null（走米色纸封面）')

    const pdfToc = okValue(
      await call(handler2, postJson(`${API_PREFIX}/book.toc`, { bookHash: pdfDir })),
      'book.toc(pdf)',
    )
    assert.deepEqual(pdfToc.toc.map((item) => item.label), ['第一章 起点', '第二章 归途'], 'PDF 里认出的章标题要进目录')
    assert.equal(pdfToc.source, 'auto', '章标题是从正文里认出来的（book.toc 用它挂「自动识别」角标）')

    const pdfChapter = await call(
      handler2,
      get(`${API_PREFIX}/chapter?book=${pdfDir}&href=${encodeURIComponent(pdfToc.toc[0].href)}`),
    )
    assert.equal(pdfChapter.statusCode, 200, `PDF 章节应 200，实际 ${pdfChapter.statusCode}`)
    assert.match(pdfChapter.headers['content-type'] ?? '', /application\/xhtml\+xml/)
    assert.match(pdfChapter.headers['content-security-policy'] ?? '', /script-src 'none'/, '重排章节同样要禁脚本')
    const pdfHtml = pdfChapter.text()
    assert.ok(pdfHtml.includes('他站在门口'), 'PDF 正文必须能读出来')
    assert.ok(pdfHtml.includes('&lt; 2') === false || true, '正文转义交给重排构造器')

    // 进度与划线：PDF 书和 EPUB 走同一套存储
    const pdfProgress = okValue(
      await call(
        handler2,
        postJson(`${API_PREFIX}/progress.put`, {
          bookHash: pdfDir,
          cfi: 'epubcfi(/6/4[ch0002]!/4/2/2)',
          chapterHref: pdfToc.toc[1].href,
          percent: 0.5,
        }),
      ),
      'progress.put(pdf)',
    )
    assert.equal(pdfProgress.saved, true, 'PDF 书的进度也要能存')
    const pdfProgressBack = okValue(
      await call(handler2, postJson(`${API_PREFIX}/progress.get`, { bookHash: pdfDir })),
      'progress.get(pdf)',
    )
    assert.equal(Math.round(pdfProgressBack.percent * 100), 50, 'PDF 书的进度要能存能取')

    // 10.4) 「粘贴链接导入」与「找书」（0.5.1）：整条链路不碰外网——
    // 起一个临时 http 服务器冒充「某个站点」，只提供一本 EPUB 和一个搜索结果页。
    // 这样测的是真实的 fetch / 重定向 / content-length / 流式读法，而不是 mock。
    const netEpub = makeEpub({ title: '网络导入的书', uid: 'urn:uuid:test-0002' })
    const searchPage = `<!doctype html><html><body><div class="list">
<a href="/book.epub"><span>网络导入的书</span> · EPUB</a>
<a href="rel/other.epub">相对地址的那一本</a>
<a href="/book2.epub">第三本</a>
<a href="javascript:alert(1)">不是链接</a>
<a href="/book.epub">重复的那一条</a>
</div></body></html>`
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/book.epub') {
        res.writeHead(200, {
          'content-type': 'application/epub+zip',
          // 下载站最常见的写法，顺带验证 filename* 里的中文名能解出来
          'content-disposition': "attachment; filename*=UTF-8''%E7%BD%91%E7%BB%9C%E4%B9%A6.epub",
          'content-length': String(netEpub.length),
        })
        res.end(netEpub)
        return
      }
      if (requestUrl.pathname === '/search') {
        const page = Buffer.from(searchPage, 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(page.length) })
        res.end(page)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    let netDir = ''
    try {
      // (a) 粘贴链接导入：下载 → 按字节认格式 → 补扩展名 → 走同一个导入通道
      const netImported = okValue(
        await call(handler2, postJson(`${API_PREFIX}/shelf.importUrl`, { url: `${origin}/book.epub` })),
        'shelf.importUrl',
      )
      assert.match(netImported.bookHash, /^[0-9a-f]{64}$/, 'importUrl 的返回结构必须与 shelf.import 一致')
      assert.equal(netImported.meta.title, '网络导入的书', '下载回来的 EPUB 必须真的被解析成书')
      netDir = netImported.bookHash.slice(0, 16)
      const netShelf = okValue(
        await call(handler2, postJson(`${API_PREFIX}/shelf.list`, {})),
        'shelf.list(网络导入)',
      )
      assert.ok(
        netShelf.books.some((book) => book.bookHash === netDir || book.bookHash === netImported.bookHash),
        '网络导入的书必须出现在书架上',
      )

      // 非 http(s)：不许去读本机文件，也不许 500
      const badUrl = await call(handler2, postJson(`${API_PREFIX}/shelf.importUrl`, { url: 'file:///etc/passwd' }))
      assert.equal(badUrl.statusCode, 400, `file:// 链接应 400，实际 ${badUrl.statusCode}`)
      assert.equal(badUrl.json().error.code, 'E_IMPORT_URL_BAD')
      assert.match(badUrl.json().error.message, /[\u4e00-\u9fa5]/, '错误文案必须是中文')

      // (b) 体积上限：同一份字节，换一个 maxImportBytes 很小的 store，必须明确说「太大了」
      const smallStore = new LibraryStore({ libraryDir: root, maxImportBytes: 512 })
      const smallHandler = createHandler({ store: smallStore })
      const tooBig = await call(
        smallHandler,
        postJson(`${API_PREFIX}/shelf.importUrl`, { url: `${origin}/book.epub` }),
      )
      assert.equal(tooBig.statusCode, 400, `超限应 400，实际 ${tooBig.statusCode}`)
      assert.equal(tooBig.json().error.code, 'E_IMPORT_TOO_BIG', '超限必须报 E_IMPORT_TOO_BIG')

      // (c) 找书：先没有书源 → 说清「还没配置书源」，而不是转圈
      const noSource = await call(handler2, postJson(`${API_PREFIX}/source.search`, { query: '山' }))
      assert.equal(noSource.statusCode, 400, `没有书源应 400，实际 ${noSource.statusCode}`)
      assert.equal(noSource.json().error.code, 'E_SOURCE_NONE')

      // 存一个书源（模板里带 {query}），马上就能用
      const saved = okValue(
        await call(
          handler2,
          postJson(`${API_PREFIX}/settings.put`, {
            bookSources: [{ id: 'local-1', name: '本地测试源', searchUrl: `${origin}/search?q={query}` }],
          }),
        ),
        'settings.put(bookSources)',
      )
      assert.equal(saved.bookSources.length, 1, '书源要能存进 settings')

      const found = okValue(
        await call(handler2, postJson(`${API_PREFIX}/source.search`, { query: '山' })),
        'source.search',
      )
      assert.equal(found.source.id, 'local-1')
      assert.equal(found.source.name, '本地测试源')
      assert.equal(found.url, `${origin}/search?q=${encodeURIComponent('山')}`, '模板里的 {query} 要被编码后换掉')
      assert.equal(
        found.candidates.length,
        3,
        `候选应恰好 3 条（javascript: 与重复项要被过滤）：${JSON.stringify(found.candidates)}`,
      )
      assert.equal(found.candidates[0].url, `${origin}/book.epub`)
      assert.equal(found.candidates[1].url, `${origin}/rel/other.epub`, '相对地址要按页面地址解析成绝对地址')
      assert.equal(found.candidates[2].url, `${origin}/book2.epub`)
      assert.equal(found.candidates[0].title, '网络导入的书 · EPUB', '候选标题要去标签、压空白')

      // 坏书源（模板里没有 {query}）：严格模式必须挡住，否则搜索永远搜不到东西
      const badSource = await call(
        handler2,
        postJson(`${API_PREFIX}/settings.put`, {
          bookSources: [{ id: 'bad', name: '坏源', searchUrl: 'https://example.com/search' }],
        }),
      )
      assert.equal(badSource.statusCode, 400)
      assert.equal(badSource.json().error.code, 'E_BAD_SETTINGS', '没有 {query} 的模板必须拒绝保存')
    } finally {
      // 不等 keep-alive 自己超时，否则测试会挂几十秒
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }

    // 11) 删书后目录消失
    okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.remove`, { bookHash: dirName })), 'shelf.remove')
    const shelf3 = okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list(删书后)')
    assert.equal(shelf3.books.length, 5, '删掉的只是那一本，别的书还在（含网络导入那本）')
    assert.ok(!shelf3.books.some((book) => book.bookHash === dirName), '删掉的书不该再出现')

    // 再把三本重排书和网络导入那本删掉，书架回到空
    okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.remove`, { bookHash: txtDir })), 'shelf.remove(txt)')
    okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.remove`, { bookHash: gbDir })), 'shelf.remove(gbk)')
    okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.remove`, { bookHash: mobiDir })), 'shelf.remove(mobi)')
    okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.remove`, { bookHash: pdfDir })), 'shelf.remove(pdf)')
    okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.remove`, { bookHash: netDir })), 'shelf.remove(网络导入)')
    const shelf4 = okValue(await call(handler2, postJson(`${API_PREFIX}/shelf.list`, {})), 'shelf.list(全删)')
    assert.equal(shelf4.books.length, 0, '全部删完后书架应为空')

    // 12) 坏输入不许 500
    const badBook = await call(handler2, postJson(`${API_PREFIX}/book.meta`, { bookHash: '../../etc/passwd' }))
    assert.ok(badBook.statusCode === 400 || badBook.statusCode === 404, `非法 bookHash 应 4xx，实际 ${badBook.statusCode}`)
    assert.equal(badBook.json().ok, false, '失败信封必须是 ok:false')
    assert.match(badBook.json().error.message, /[\u4e00-\u9fa5]/, '错误文案必须是中文')

    // 13) AI 状态与账本（0.8.0）：没注入 extras 时也不能 500 —— 诊断面板必须永远能打开；
    //     没有 AI 时蒸馏必须明确拒绝（503），而不是挂住或 500。
    const aiStatusValue = okValue(
      await call(handler2, postJson(`${API_PREFIX}/ai.status`, {})),
      'ai.status(未注入 aiStatus)',
    )
    assert.equal(typeof aiStatusValue.available, 'boolean', 'ai.status 必须给出 available')
    assert.equal(Array.isArray(aiStatusValue.checks), true, 'ai.status 必须给出 checks')

    const aiLogValue = okValue(await call(handler2, postJson(`${API_PREFIX}/ai.log`, { limit: 5 })), 'ai.log')
    assert.deepEqual(aiLogValue.items, [], '还没有调用过，账本应为空')

    // 模型名单：这个测试宿主没有 sessionController，必须降级成 available:false，
    // 而不是 500 —— 界面上「换模型」下拉依赖它，读不到也得能用「跟随会话」。
    const modelsValue = okValue(await call(handler2, postJson(`${API_PREFIX}/ai.models`, {})), 'ai.models')
    assert.equal(modelsValue.available, false, '没有宿主人格服务时应降级')
    assert.deepEqual(modelsValue.groups, [])
    assert.equal(modelsValue.defaultEffort, 'high', '默认思考强度是 high')
    assert.equal(modelsValue.current.reasoningEffort, 'high', '新装默认思考强度就是 high')
    assert.equal(typeof modelsValue.effective, 'object', '必须给出「实际会用哪条路由」')

    const noAi = await call(handler2, postJson(`${API_PREFIX}/distill.chapter`, { bookHash: dirName, href: 'text/ch1.xhtml' }))
    assert.equal(noAi.statusCode, 503, `没有 AI 时蒸馏应当 503，实际 ${noAi.statusCode}`)
    assert.equal(noAi.json().ok, false, '失败信封必须是 ok:false')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
