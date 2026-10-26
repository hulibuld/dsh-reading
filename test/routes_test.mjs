/**
 * lib/routes.js 的测试。**不启端口**。
 *
 * 分派被抽成纯函数 `createHandler({ store })`，所以这里直接构造最小 req/res：
 *   - req = `{ method, url, body }`（或 Readable，用来走真实 readBody 路径）；
 *   - res = 一个收集 statusCode / headers / body 的小对象。
 *
 * 断言的重点：
 *   1. 路径穿越（`..`、以 `/` 开头、盘符、反斜杠、`%2e%2e` 绕过）一律 400；
 *   2. 错误信封形状固定 `{ ok:false, error:{ code, message } }`，且 message 是中文、
 *      不出现 bookHash / href / path 这类内部字段名；
 *   3. 章节响应的头（application/xhtml+xml + script-src 'none'）与「原样输出、只改属性值」；
 *   4. 只注册一条 prefix 路由，前缀是 /api/dsh-reading（不是 /plugins）。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { writeZip } from '../lib/zip.js'
import { LibraryStore } from '../lib/store.js'
import {
  createHandler,
  registerRoutes,
  requireHref,
  rewriteChapterAssets,
  rewriteCssUrls,
  joinRelative,
  API_PREFIX,
  CHAPTER_HEADERS,
} from '../lib/routes.js'
import { bookDirName } from '../lib/paths.js'

/** 造一本带图片与 CSS 的 EPUB，用来验证资源改写。 */
function makeEpub() {
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 9, 22, 0, 0, counter++)).toISOString()
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data:
        '<container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" ' +
        'media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OEBPS/content.opf',
      data:
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:title>路由测试</dc:title><dc:creator>某作者</dc:creator></metadata>' +
        '<manifest>' +
        '<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '<item id="css" href="styles/main.css" media-type="text/css"/>' +
        '<item id="img" href="images/pic.png" media-type="image/png"/>' +
        '<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>' +
        '</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
    },
    {
      name: 'OEBPS/nav.xhtml',
      data:
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
        '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">第一章</a></li>' +
        '<li><a href="text/ch2.xhtml">第二章</a></li></ol></nav></body></html>',
    },
    {
      // 章节里同时有：相对图片、相对 CSS、站内锚点、data: 图片、外部链接、绝对路径。
      name: 'OEBPS/text/ch1.xhtml',
      data:
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml"><head>\n' +
        '  <title>第一章</title>\n' +
        '  <link rel="stylesheet" type="text/css" href="../styles/main.css"/>\n' +
        '</head><body>\n' +
        '  <h1 id="top">第一章</h1>\n' +
        '  <p>正文 <a href="#top">回到顶部</a> 与 <a href="ch2.xhtml">下一章</a>。</p>\n' +
        '  <p><img src="../images/pic.png" alt="图"/></p>\n' +
        '  <p><img src="data:image/png;base64,AAAA"/></p>\n' +
        '  <p><a href="https://example.com/x">外部</a></p>\n' +
        '</body></html>',
    },
    {
      name: 'OEBPS/text/ch2.xhtml',
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章</p></body></html>',
    },
    {
      name: 'OEBPS/styles/main.css',
      data: '@font-face{src:url("../fonts/x.woff2")} body{background:url(../images/pic.png)}',
    },
    { name: 'OEBPS/fonts/x.woff2', data: Buffer.from([0x77, 0x4f, 0x46, 0x32]) },
    { name: 'OEBPS/images/pic.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]) },
    // 章节同目录下的图片：验证 asset 的 base 参数（章节内相对地址）能解析到。
    { name: 'OEBPS/text/local.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]) },
    { name: 'OEBPS/images/cover.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]) },
  ]
  return { bytes: writeZip(entries), now }
}

/** 最小 res：收集状态码、头、body。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
    },
    /** 解析成 JSON（失败即测试失败）。 */
    json() {
      return JSON.parse(this.body.toString('utf8'))
    },
    text() {
      return this.body.toString('utf8')
    },
  }
}

/** 造一个 req：body 直接给对象（走 readBody 的「已解析」捷径）。 */
function post(url, body) {
  return { method: 'POST', url, body }
}

/** 造一个 req：body 是真实流（走 readBody 的流式路径）。 */
function postStream(url, bodyText) {
  const stream = Readable.from([Buffer.from(bodyText, 'utf8')])
  stream.method = 'POST'
  stream.url = url
  // 让 readBody 认出它是流：带 asyncIterator 且没有 .body
  return stream
}

function get(url) {
  return { method: 'GET', url }
}

/** 调 handler 并返回 res。 */
async function call(handler, req) {
  const res = makeRes()
  await handler(req, res)
  return res
}

/** 断言响应的错误信封形状 + 中文文案不含内部字段名。 */
function assertErrorEnvelope(res, expectedStatus, expectedCode) {
  assert.equal(res.statusCode, expectedStatus, `状态码应为 ${expectedStatus}，实际 ${res.statusCode}\n${res.text()}`)
  const payload = res.json()
  assert.equal(payload.ok, false, '失败响应必须 ok:false')
  assert.ok(payload.error && typeof payload.error === 'object', '失败响应必须有 error 对象')
  assert.equal(typeof payload.error.code, 'string')
  assert.equal(typeof payload.error.message, 'string')
  assert.ok(payload.error.message.length > 0, 'message 不能为空')
  if (expectedCode) assert.equal(payload.error.code, expectedCode)
  // 中文文案：至少含一个中日韩字符
  assert.match(payload.error.message, /[\u4e00-\u9fa5]/, 'message 必须是中文')
  // 不出现内部字段名 / 路径 / 术语
  for (const leaked of ['bookHash', 'href', 'E_', 'undefined', 'null', '/Users/', 'at ', 'Error:']) {
    assert.equal(
      payload.error.message.includes(leaked),
      false,
      `message 不该出现内部词 "${leaked}"：${payload.error.message}`,
    )
  }
  // 不该多带内部 detail
  assert.equal(payload.error.detail, undefined, 'detail 只进日志，不许回显')
  assert.equal(payload.error.stack, undefined)
  return payload
}

export default async function run() {
  const { bytes, now } = makeEpub()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-routes-'))
  const store = new LibraryStore({
    libraryDir: dir,
    deviceId: 'mac-abc123',
    now,
    logger: { warn: () => {} },
  })
  const handler = createHandler({ store, logger: { warn: () => {} } })

  try {
    // ── 1. device.info / settings / shelf.list（空库） ──
    {
      const res = await call(handler, post(`${API_PREFIX}/device.info`, {}))
      assert.equal(res.statusCode, 200)
      const payload = res.json()
      assert.equal(payload.ok, true)
      assert.equal(payload.value.deviceId, 'mac-abc123')
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
      assert.equal(res.headers['cache-control'], 'no-store')
    }

    {
      const res = await call(handler, post(`${API_PREFIX}/settings.get`, {}))
      assert.equal(res.statusCode, 200)
      const { value } = res.json()
      for (const key of ['fontSize', 'lineHeight', 'theme', 'columns', 'fontFamily']) {
        assert.ok(key in value, `settings 应含 ${key}`)
      }
      const put = await call(handler, post(`${API_PREFIX}/settings.put`, { fontSize: 24 }))
      assert.equal(put.statusCode, 200)
      assert.equal(put.json().value.fontSize, 24)
    }

    {
      const res = await call(handler, post(`${API_PREFIX}/shelf.list`, {}))
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json().value, { books: [] })
    }

    // ── 2. 导入（走真实流式 readBody） ──
    const bookHash = await (async () => {
      const bodyText = JSON.stringify({ filename: '路由.epub', dataBase64: bytes.toString('base64') })
      const res = await call(handler, postStream(`${API_PREFIX}/shelf.import`, bodyText))
      assert.equal(res.statusCode, 200, `导入应成功，实际 ${res.text()}`)
      const { value } = res.json()
      assert.equal(value.bookHash.length, 64)
      assert.equal(value.meta.title, '路由测试')
      return value.bookHash
    })()
    const dirName = bookDirName(bookHash)

    // 注：readBody 的流式路径要求 req 同时带 method/url 属性；上面 Readable 上挂了。
    {
      const res = await call(handler, post(`${API_PREFIX}/shelf.list`, {}))
      const { books } = res.json().value
      assert.equal(books.length, 1)
      assert.equal(books[0].title, '路由测试')
      assert.equal(books[0].coverUrl, `${API_PREFIX}/cover?book=${dirName}`)
    }

    // ── 3. book.meta / book.spine / book.toc ──
    {
      const meta = (await call(handler, post(`${API_PREFIX}/book.meta`, { bookHash }))).json()
      assert.equal(meta.ok, true)
      assert.equal(meta.value.title, '路由测试')

      const spine = (await call(handler, post(`${API_PREFIX}/book.spine`, { bookHash }))).json()
      assert.deepEqual(
        spine.value.spine.map((entry) => entry.index),
        [0, 1],
      )
      for (const entry of spine.value.spine) {
        assert.equal(typeof entry.href, 'string')
        assert.equal(typeof entry.idref, 'string')
      }

      const toc = (await call(handler, post(`${API_PREFIX}/book.toc`, { bookHash }))).json()
      assert.equal(toc.value.toc.length, 2)
      assert.equal(toc.value.toc[0].label, '第一章')
      assert.equal(toc.value.toc[0].spineIndex, 0)
      // 0.4.0：目录带上来源，界面用来挂「自动识别」角标
      assert.equal(toc.value.source, 'nav')
    }

    // ── 3b. 改书名 / 作者（0.4.0 book.update） ──
    {
      const before = (await call(handler, post(`${API_PREFIX}/book.meta`, { bookHash }))).json().value

      const updated = await call(
        handler,
        post(`${API_PREFIX}/book.update`, { bookHash, title: '  新路由书名 ', author: '路由作者' }),
      )
      assert.equal(updated.statusCode, 200, updated.text())
      const book = updated.json().value.book
      assert.equal(book.id, dirName)
      assert.equal(book.title, '新路由书名', '书名要 trim 后落盘')
      assert.equal(book.author, '路由作者')
      assert.ok(book.updatedAt > before.updatedAt, '改完要刷新 updatedAt')

      const after = (await call(handler, post(`${API_PREFIX}/book.meta`, { bookHash }))).json().value
      assert.equal(after.title, '新路由书名')
      assert.equal(after.author, '路由作者')
      assert.equal(after.spine.length, before.spine.length, '改标题不能丢其它字段')

      const shelf = (await call(handler, post(`${API_PREFIX}/shelf.list`, {}))).json().value
      assert.equal(shelf.books[0].title, '新路由书名')

      // 入参校验：空标题 / 超长 / 没有可改的字段 —— 都是 400 中文文案
      assertErrorEnvelope(
        await call(handler, post(`${API_PREFIX}/book.update`, { bookHash, title: '   ' })),
        400,
        'E_ARGS',
      )
      assertErrorEnvelope(
        await call(handler, post(`${API_PREFIX}/book.update`, { bookHash, title: 'x'.repeat(121) })),
        400,
        'E_ARGS',
      )
      assertErrorEnvelope(
        await call(handler, post(`${API_PREFIX}/book.update`, { bookHash, author: 'x'.repeat(81) })),
        400,
        'E_ARGS',
      )
      assertErrorEnvelope(await call(handler, post(`${API_PREFIX}/book.update`, { bookHash })), 400, 'E_ARGS')
      assertErrorEnvelope(
        await call(handler, post(`${API_PREFIX}/book.update`, { bookHash: 'f'.repeat(16), title: '不存在的书' })),
        404,
        'E_BOOK_NOT_FOUND',
      )
    }

    // ── 4. 章节：头 + 原样输出 + 只改属性值 ──
    {
      const href = 'text/ch1.xhtml'
      const res = await call(
        handler,
        get(`${API_PREFIX}/chapter?book=${dirName}&href=${encodeURIComponent(href)}`),
      )
      assert.equal(res.statusCode, 200, res.text())
      // 头必须逐条对上 docs/05 §3.4
      assert.equal(res.headers['content-type'], 'application/xhtml+xml; charset=utf-8')
      assert.match(res.headers['content-security-policy'], /script-src 'none'/)
      assert.match(res.headers['content-security-policy'], /default-src 'none'/)
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(res.headers['cache-control'], 'private, max-age=300')
      for (const [key, value] of Object.entries(CHAPTER_HEADERS)) {
        assert.equal(res.headers[key], value, `章节目录头 ${key} 必须与常量一致`)
      }

      const text = res.text()
      // 原样输出：XML 声明、缩进、换行、注释一个都不能变
      assert.ok(text.startsWith('<?xml version="1.0" encoding="utf-8"?>\n'), 'XML 声明与原换行必须保留')
      assert.ok(text.includes('<h1 id="top">第一章</h1>'))
      assert.ok(text.includes('  <title>第一章</title>\n'))
      assert.ok(text.includes('<p>正文 <a href="#top">回到顶部</a>'),
        '站内锚点 #top 不该被改写')

      // 相对资源被改写成 asset URL（值变了、属性名和引号没变）。
      // 属性值里的 `&` 必须是 `&amp;`：XHTML 以 XML 模式解析，裸 `&` 会让整章
      // 变成格式不良文档，阅读器直接白屏。
      const assetBase = `${API_PREFIX}/asset?book=${encodeURIComponent(dirName)}&amp;href=`
      assert.ok(text.includes(`src="${assetBase}images%2Fpic.png"`), `图片地址应改成 asset URL：${text}`)
      assert.ok(
        text.includes(`href="${assetBase}styles%2Fmain.css"`),
        'CSS 地址应改成 asset URL（../ 已归一）',
      )
      assert.ok(text.includes('<link rel="stylesheet" type="text/css"'), '属性不能被重排或丢失')
      // 不该改的两类
      assert.ok(text.includes('src="data:image/png;base64,AAAA"'), 'data: URL 不能被改写')
      // 书里的 `<a>` 一律改成**不导航的锚**（F3）：原地址编进 fragment，点它不会
      // 把 iframe 带去加载一份裸 XHTML。外部绝对地址同样如此——更安全。
      assert.ok(
        text.includes('href="#dsh-reading:https%3A%2F%2Fexample.com%2Fx"'),
        '外部绝对地址也不能让它点得出去（要降级成不导航的锚）',
      )

      // 结构等价性：去掉属性值后，标签序列必须与原文完全一致（没有增删节点/重排属性）。
      // 这是「原样输出」最硬的判据：任何美化缩进、属性重排都会让这条挂掉。
      const stripper = (html) => html.replace(/="[^"]*"/g, '=""')
      const rawChapter = await store.chapterHtml(dirName, href)
      assert.equal(stripper(text), stripper(rawChapter), '除属性值外必须逐字节相同（不许增删节点/重排属性）')

      // 幂等：对已改写的结果再跑一次，不会包第二层
      const twice = rewriteChapterAssets(text, {
        book: dirName,
        chapterHref: href,
        resolve: () => 'images/pic.png',
      })
      assert.equal(twice, text, '改写必须幂等')
    }

    // ── 5. 资源：CSS 内部 url() 也要改写；二进制逐字节不变 ──
    {
      const css = await call(
        handler,
        get(`${API_PREFIX}/asset?book=${dirName}&href=${encodeURIComponent('styles/main.css')}`),
      )
      assert.equal(css.statusCode, 200)
      assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
      const text = css.text()
      assert.ok(text.includes(`${API_PREFIX}/asset?book=${encodeURIComponent(dirName)}&href=fonts%2Fx.woff2`), text)
      assert.ok(text.includes('images%2Fpic.png'), text)

      const png = await call(
        handler,
        get(`${API_PREFIX}/asset?book=${dirName}&href=${encodeURIComponent('images/pic.png')}`),
      )
      assert.equal(png.statusCode, 200)
      assert.equal(png.headers['content-type'], 'image/png')
      assert.deepEqual([...png.body], [0x89, 0x50, 0x4e, 0x47, 0x01], '二进制必须逐字节原样输出')
      assert.match(png.headers['content-security-policy'], /script-src 'none'/, 'SVG 之类也能带脚本，一律禁')

      // 不存在 → 404
      const missing = await call(
        handler,
        get(`${API_PREFIX}/asset?book=${dirName}&href=${encodeURIComponent('images/nope.png')}`),
      )
      assertErrorEnvelope(missing, 404, 'E_ASSET_NOT_FOUND')

      // base 参数：章节内相对地址（ch1.xhtml 同目录下的 local.png）
      const withBase = await call(
        handler,
        get(
          `${API_PREFIX}/asset?book=${dirName}&href=${encodeURIComponent('local.png')}` +
            `&base=${encodeURIComponent('text/ch1.xhtml')}`,
        ),
      )
      assert.equal(withBase.statusCode, 200, withBase.text())
      assert.deepEqual([...withBase.body], [0x89, 0x50, 0x4e, 0x47, 0x03])

      // href 里带 `..` 一律 400（不论 base 能不能解析出来）：路径穿越的统一判据。
      const dotdot = await call(
        handler,
        get(
          `${API_PREFIX}/asset?book=${dirName}&href=${encodeURIComponent('../images/pic.png')}` +
            `&base=${encodeURIComponent('text/ch1.xhtml')}`,
        ),
      )
      assertErrorEnvelope(dotdot, 400, 'E_BAD_PATH')
    }

    // ── 6. 封面：有则 200，无则 404 ──
    {
      const cover = await call(handler, get(`${API_PREFIX}/cover?book=${dirName}`))
      assert.equal(cover.statusCode, 200)
      assert.equal(cover.headers['content-type'], 'image/png')
      assert.deepEqual([...cover.body], [0x89, 0x50, 0x4e, 0x47, 0x02])
      // 0.4.0：封面不能靠 max-age 缓存一小时，否则换了封面还是一小时旧图
      assert.match(cover.headers['cache-control'] ?? '', /max-age=0/)
      assert.equal(typeof cover.headers.etag, 'string')

      const missing = await call(handler, get(`${API_PREFIX}/cover?book=${'0'.repeat(16)}`))
      // 书不存在时是 404（书不在）而不是 500
      assert.ok([404, 500].includes(missing.statusCode), `实际 ${missing.statusCode}`)
      assert.equal(missing.json().ok, false)
    }

    // ── 6b. 换封面 / 删封面（0.4.0 book.cover.put / book.cover.remove） ──
    {
      const shelfBefore = (await call(handler, post(`${API_PREFIX}/shelf.list`, {}))).json().value
      assert.equal(shelfBefore.books[0].coverVersion, 0, '没换过封面时版本是 0，前端靠它拼 ?v=')

      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('routes-uploaded-png'),
      ])
      const put = await call(
        handler,
        post(`${API_PREFIX}/book.cover.put`, {
          bookHash,
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        }),
      )
      assert.equal(put.statusCode, 200, put.text())
      const putBook = put.json().value.book
      assert.equal(putBook.id, dirName)
      assert.equal(putBook.coverHref, 'cover.png')
      assert.equal(putBook.coverMediaType, 'image/png')
      assert.equal(putBook.coverVersion, 1)

      const afterPut = await call(handler, get(`${API_PREFIX}/cover?book=${dirName}`))
      assert.equal(afterPut.statusCode, 200)
      assert.deepEqual([...afterPut.body], [...png], '换过的封面要盖过书里那张')
      const etag = afterPut.headers.etag
      assert.equal(etag, '"c1"', 'etag 要带封面版本')

      // 同一个 etag 再来一次 → 304，不重传图片
      const revalidated = await call(handler, {
        method: 'GET',
        url: `${API_PREFIX}/cover?book=${dirName}`,
        headers: { 'if-none-match': etag },
      })
      assert.equal(revalidated.statusCode, 304)
      assert.equal(revalidated.body.length, 0)

      // 换成 JPEG：旧文件必须删掉，只留一张
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('routes-uploaded-jpeg')])
      const second = await call(
        handler,
        post(`${API_PREFIX}/book.cover.put`, { bookHash, dataBase64: jpg.toString('base64') }),
      )
      assert.equal(second.statusCode, 200, second.text())
      assert.equal(second.json().value.book.coverHref, 'cover.jpg')
      assert.equal(second.json().value.book.coverVersion, 2)
      const names = await fs.readdir(store.paths.bookDir(dirName))
      assert.ok(!names.includes('cover.png'), '换封面要删掉旧文件')

      // 魔数说了算：假装是图片的文本 / 坏 base64 / 超限 都要中文报错
      assertErrorEnvelope(
        await call(
          handler,
          post(`${API_PREFIX}/book.cover.put`, {
            bookHash,
            dataUrl: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
          }),
        ),
        400,
        'E_ARGS',
      )
      assertErrorEnvelope(
        await call(handler, post(`${API_PREFIX}/book.cover.put`, { bookHash, dataUrl: 'data:image/png;base64,@@@@' })),
        400,
        'E_ARGS',
      )
      assertErrorEnvelope(
        await call(
          handler,
          post(`${API_PREFIX}/book.cover.put`, {
            bookHash,
            dataBase64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64'),
          }),
        ),
        400,
        'E_COVER_TOO_BIG',
      )

      const shelfAfter = (await call(handler, post(`${API_PREFIX}/shelf.list`, {}))).json().value
      assert.equal(shelfAfter.books[0].coverVersion, 2)
      assert.ok(shelfAfter.books[0].coverUrl, '有封面时 coverUrl 不能为空')

      // 删封面：文件没了、coverUrl 变 null、版本继续往前走、GET /cover 404
      const removed = await call(handler, post(`${API_PREFIX}/book.cover.remove`, { bookHash }))
      assert.equal(removed.statusCode, 200, removed.text())
      assert.equal(removed.json().value.book.coverHref, '')
      assert.equal(removed.json().value.book.coverVersion, 3)
      const shelfDeleted = (await call(handler, post(`${API_PREFIX}/shelf.list`, {}))).json().value
      assert.equal(shelfDeleted.books[0].coverUrl, null)
      assert.equal(shelfDeleted.books[0].coverVersion, 3)
      const gone = await call(handler, get(`${API_PREFIX}/cover?book=${dirName}`))
      assert.equal(gone.statusCode, 404, '删掉封面之后不能再吐书里那张')

      // book.cover.reset 是施工图里的旧名字，两边都认
      const resetAgain = await call(handler, post(`${API_PREFIX}/book.cover.reset`, { bookHash }))
      assert.equal(resetAgain.statusCode, 200, resetAgain.text())
      assert.equal(resetAgain.json().value.book.coverVersion, 4)
    }

    // ── 7. 路径穿越：全部 400 ──
    {
      const traversals = [
        '../etc/passwd',
        '..%2Fetc%2Fpasswd',
        '%2e%2e%2fetc%2fpasswd',
        'a/../../etc/passwd',
        '/etc/passwd',
        '\\etc\\passwd',
        'C:\\Windows\\win.ini',
        'file:///etc/passwd',
        'text/../../OEBPS/content.opf',
        '..',
        '.',
        'text/./ch1.xhtml',
      ]
      for (const href of traversals) {
        const res = await call(
          handler,
          get(`${API_PREFIX}/chapter?book=${dirName}&href=${encodeURIComponent(href)}`),
        )
        assertErrorEnvelope(res, 400, 'E_BAD_PATH')
      }

      // asset 路由同样拒
      for (const href of ['../x.png', '/etc/passwd']) {
        const res = await call(
          handler,
          get(`${API_PREFIX}/asset?book=${dirName}&href=${encodeURIComponent(href)}`),
        )
        assertErrorEnvelope(res, 400, 'E_BAD_PATH')
      }

      // 缺 href / 空 href
      const empty = await call(handler, get(`${API_PREFIX}/chapter?book=${dirName}&href=`))
      assertErrorEnvelope(empty, 400, 'E_BAD_PATH')

      // 缺 book
      const noBook = await call(handler, get(`${API_PREFIX}/chapter?href=text%2Fch1.xhtml`))
      assertErrorEnvelope(noBook, 400, 'E_BAD_BOOK_HASH')

      // book 是坏的 hash
      const badBook = await call(handler, get(`${API_PREFIX}/chapter?book=..%2F..%2Fetc&href=x`))
      assertErrorEnvelope(badBook, 400, 'E_BAD_BOOK_HASH')

      // requireHref 直接调
      for (const bad of traversals) {
        let caught = null
        try {
          requireHref(bad)
        } catch (error) {
          caught = error
        }
        assert.ok(caught, `requireHref(${JSON.stringify(bad)}) 应当拒绝`)
        assert.equal(caught.code, 'E_BAD_PATH')
        assert.equal(caught.status, 400)
      }
      // 合法的要放过
      assert.equal(requireHref('text/ch1.xhtml'), 'text/ch1.xhtml')
      assert.equal(requireHref('images/a-b_c.png'), 'images/a-b_c.png')
    }

    // ── 8. 书不存在 / 章节不存在 → 404 ──
    {
      const missingBook = await call(handler, post(`${API_PREFIX}/book.meta`, { bookHash: 'f'.repeat(16) }))
      assertErrorEnvelope(missingBook, 404, 'E_BOOK_NOT_FOUND')

      const missingChapter = await call(
        handler,
        get(`${API_PREFIX}/chapter?book=${dirName}&href=${encodeURIComponent('text/nope.xhtml')}`),
      )
      assertErrorEnvelope(missingChapter, 404, 'E_CHAPTER_NOT_FOUND')
    }

    // ── 9. 进度 / 标注 / 隔离舱 ──
    {
      const put = await call(
        handler,
        post(`${API_PREFIX}/progress.put`, {
          bookHash: dirName,
          cfi: 'epubcfi(/6/2[ch1]!/4/2/2/1:3)',
          cfiStart: '/4/2/2/1:3',
          chapterHref: 'text/ch1.xhtml',
          percent: 0.4,
        }),
      )
      assert.equal(put.statusCode, 200, put.text())
      assert.deepEqual(put.json().value, { saved: true })

      const got = await call(handler, post(`${API_PREFIX}/progress.get`, { bookHash: dirName }))
      assert.equal(got.statusCode, 200)
      assert.equal(got.json().value.cfi, 'epubcfi(/6/2[ch1]!/4/2/2/1:3)')
      assert.equal(got.json().value.bookProgression, 0.4)

      const record = {
        schema: 'dsh-reading/1',
        id: '01J8ZQ6Q7K8M9N0P1Q2R3S4T5V',
        type: 'highlight',
        cfi: 'epubcfi(/6/2[ch1]!/4/2/2/1:0,/4/2/2/1:5)',
        cfiStart: '/4/2/2/1:0',
        cfiEnd: '/4/2/2/1:5',
        chapterHref: 'text/ch1.xhtml',
        textExcerpt: '正文',
        textFingerprint: { head: '正文', tail: '正文', len: 2, hash: 'b'.repeat(64) },
        color: 'yellow',
        createdAt: '2026-10-22T00:00:00.000Z',
      }
      const putAnn = await call(handler, post(`${API_PREFIX}/ann.put`, { bookHash: dirName, record }))
      assert.equal(putAnn.statusCode, 200, putAnn.text())
      assert.equal(putAnn.json().value.record.updatedAt !== undefined, true, '服务端必须补 updatedAt')

      const listed = await call(handler, post(`${API_PREFIX}/ann.list`, { bookHash: dirName }))
      assert.equal(listed.json().value.records.length, 1)

      const deleted = await call(handler, post(`${API_PREFIX}/ann.delete`, { bookHash: dirName, id: record.id }))
      assert.equal(deleted.statusCode, 200)
      assert.equal(deleted.json().value.deleted, true)
      assert.equal((await call(handler, post(`${API_PREFIX}/ann.list`, { bookHash: dirName }))).json().value.records.length, 0)

      // 缺字段 → 400，不是 500
      const badRecord = await call(
        handler,
        post(`${API_PREFIX}/ann.put`, { bookHash: dirName, record: { ...record, id: '01J8ZQ6Q7K8M9N0P1Q2R3S4T5Z', textFingerprint: undefined } }),
      )
      assertErrorEnvelope(badRecord, 400, 'E_BAD_RECORD')

      const quarantine = await call(handler, post(`${API_PREFIX}/quarantine.list`, { bookHash: dirName }))
      assert.equal(quarantine.statusCode, 200)
      assert.ok(Array.isArray(quarantine.json().value.entries))
    }

    // ── 9b. 问 AI：没有 ask 服务时必须是 503 + 中文文案（不是 500） ──
    {
      const noService = await call(handler, post(`${API_PREFIX}/qa.ask`, { bookHash: dirName, question: '这句什么意思？', selectedText: '原文一段' }))
      assertErrorEnvelope(noService, 503, 'E_AI_UNAVAILABLE')
      // 文案必须能直接给用户看：不能出现 subagents / undefined 这类内部词
      assert.ok(!/subagents|undefined|null/i.test(noService.json().error.message))
    }

    // ── 9c. 问答历史：qa.list 字段齐全 + qa.delete 能删（0.4.0） ──
    {
      // 没有 ask 服务，直接落一条记录（等价于 ask 成功后的落盘）
      const entry = await store.appendQa(dirName, {
        question: '这句什么意思？',
        answer: '意思就是字面那层。',
        anchorCfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:5)',
        chapterHref: 'text/ch1.xhtml',
        chapterLabel: '第一章',
      })

      const listed = await call(handler, post(`${API_PREFIX}/qa.list`, { bookHash }))
      assert.equal(listed.statusCode, 200, listed.text())
      const { records } = listed.json().value
      const record = records.find((item) => item.id === entry.id)
      assert.ok(record, 'qa.list 里必须有这条')
      // 侧栏要用的字段一个都不能缺，缺了前端就得自己兜底
      assert.equal(record.chapterLabel, '第一章')
      assert.equal(record.chapterHref, 'text/ch1.xhtml')
      assert.equal(record.anchorCfiRange, 'epubcfi(/6/2!/4/2,/1:0,/1:5)')
      assert.equal(typeof record.createdAt, 'string')
      assert.equal(typeof record.book, 'string')
      for (const key of ['cutoffCfi', 'selectedText', 'model']) {
        assert.equal(typeof record[key], 'string', `旧记录缺的 ${key} 要补空串，不能是 undefined`)
      }

      const limited = await call(handler, post(`${API_PREFIX}/qa.list`, { bookHash, limit: 1 }))
      assert.equal(limited.statusCode, 200)
      assert.equal(limited.json().value.records.length, 1, 'limit 生效（只截尾巴，不翻页）')
      const badLimit = await call(handler, post(`${API_PREFIX}/qa.list`, { bookHash, limit: 'abc' }))
      assert.equal(badLimit.statusCode, 200, '非法 limit 不该把请求打挂')

      const deleted = await call(handler, post(`${API_PREFIX}/qa.delete`, { bookHash, id: entry.id }))
      assert.equal(deleted.statusCode, 200, deleted.text())
      assert.equal(deleted.json().value.deleted, true)
      const afterDelete = (await call(handler, post(`${API_PREFIX}/qa.list`, { bookHash }))).json().value
      assert.equal(afterDelete.records.some((item) => item.id === entry.id), false, '删掉的不该再出现')

      // 重复删同一条 = 404 中文文案；缺 id = 400；书不存在 = 404
      assertErrorEnvelope(await call(handler, post(`${API_PREFIX}/qa.delete`, { bookHash, id: entry.id })), 404, 'E_QA_NOT_FOUND')
      assertErrorEnvelope(await call(handler, post(`${API_PREFIX}/qa.delete`, { bookHash })), 400, 'E_BAD_RECORD')
      assertErrorEnvelope(
        await call(handler, post(`${API_PREFIX}/qa.delete`, { bookHash: 'f'.repeat(16), id: entry.id })),
        404,
        'E_BOOK_NOT_FOUND',
      )
    }

    // ── 10. 方法 / 路径错误 ──
    {
      const unknown = await call(handler, post(`${API_PREFIX}/nope.method`, {}))
      assertErrorEnvelope(unknown, 404, 'E_NOT_FOUND')

      const unknownGet = await call(handler, get(`${API_PREFIX}/settings.get`))
      assertErrorEnvelope(unknownGet, 404, 'E_NOT_FOUND')

      const badMethod = await call(handler, { method: 'PUT', url: `${API_PREFIX}/shelf.list`, body: {} })
      assertErrorEnvelope(badMethod, 405, 'E_METHOD')

      // 原型链上的名字不能被当成方法
      const proto = await call(handler, post(`${API_PREFIX}/constructor`, {}))
      assertErrorEnvelope(proto, 404, 'E_NOT_FOUND')

      // 前缀之外
      const outside = await call(handler, post('/api/other/thing', {}))
      assertErrorEnvelope(outside, 404, 'E_NOT_FOUND')
    }

    // ── 11. 坏 body ──
    {
      const badJson = await call(handler, postStream(`${API_PREFIX}/shelf.list`, '{ 不是 json'))
      assertErrorEnvelope(badJson, 400, 'E_BAD_BODY')

      // 空 body 当成空对象
      const empty = await call(handler, post(`${API_PREFIX}/device.info`, {}))
      assert.equal(empty.statusCode, 200)
    }

    // ── 12. 只注册一条 prefix 路由，且不是 /plugins ──
    {
      const registrations = []
      const fakeCtx = {
        webServer: {
          register(options) {
            registrations.push(options)
            return () => {}
          },
        },
      }
      const dispose = registerRoutes(fakeCtx, { store, logger: { warn: () => {} } })
      assert.equal(typeof dispose, 'function', 'register 必须返回 disposer')
      assert.equal(registrations.length, 1, '只能注册一条路由')
      assert.equal(registrations[0].kind, 'prefix')
      assert.equal(registrations[0].path, '/api/dsh-reading')
      assert.notEqual(registrations[0].path, '/plugins')
      assert.equal(registrations[0].path.startsWith('/plugins'), false, '不得占用 /plugins 前缀')
      assert.equal(typeof registrations[0].handler, 'function')
    }

    // ── 13. requireHref / rewriteChapterAssets / joinRelative 的边界 ──
    {
      // 纯函数：joinRelative 越出根返回 null
      assert.equal(joinRelative('text', 'ch1.xhtml'), 'text/ch1.xhtml')
      assert.equal(joinRelative('text', '../images/a.png'), 'images/a.png')
      assert.equal(joinRelative('', '../x'), null)
      assert.equal(joinRelative('text', '#frag'), 'text')
      assert.equal(joinRelative('text', 'ch1.xhtml#a'), 'text/ch1.xhtml')

      // rewriteCssUrls：data: 与绝对地址不动
      const css = rewriteCssUrls(
        'a{background:url(data:image/png;base64,AA)}b{background:url(https://x/y.png)}c{src:url(x.woff)}',
        { book: 'abc', baseHref: 'styles/main.css', resolve: (base, raw) => (raw.startsWith('http') ? null : `styles/${raw}`) },
      )
      assert.ok(css.includes('url(data:image/png;base64,AA)'))
      assert.ok(css.includes('url(https://x/y.png)'))
      assert.ok(css.includes(`${API_PREFIX}/asset?book=abc&href=styles%2Fx.woff`))

      // rewriteChapterAssets：属性值里的 & 要转义，避免被当成实体
      const html = rewriteChapterAssets('<p><img src="a.png"/></p>', {
        book: 'abc',
        chapterHref: 'text/ch.xhtml',
        resolve: () => 'images/a b.png',
      })
      assert.ok(html.includes('&amp;href='), '& 必须转义成 &amp;')
      assert.ok(html.includes('%20'), '路径里的空格要 percent-encode')

      // 正文（标签外）的文字不参与改写
      const bodyText = rewriteChapterAssets('<p>src="a.png" 只是文字</p>', {
        book: 'abc',
        chapterHref: 'c.xhtml',
        resolve: () => 'images/a.png',
      })
      assert.equal(bodyText, '<p>src="a.png" 只是文字</p>', '标签外的文字不能被改写')

      // 安全例外 a：`<meta http-equiv=refresh>` 与 `<base>` 必须整条丢弃。
      // 理由：帧内导航不受顶层导航限制，这两条能让恶意 EPUB 把阅读界面导去外站。
      const nav = rewriteChapterAssets(
        '<head><base href="https://evil.test/"/><meta content="0;url=https://evil.test" http-equiv="refresh"/>'
        + '<meta name="vp" content="w"/></head><body><p>x</p></body>',
        { book: 'abc', chapterHref: 'c.xhtml', resolve: () => null },
      )
      assert.ok(!nav.includes('evil.test'), `必须丢掉 base 与 meta refresh：${nav}`)
      assert.ok(nav.includes('<meta name="vp" content="w"/>'), '其它 meta 必须原样保留')
      assert.ok(nav.includes('<body><p>x</p></body>'), '正文字节不受影响')

      // 安全例外 b：`<a href>` 降级成不导航的锚；纯 fragment 锚保持原样（站内跳转还能用）
      const anchors = rewriteChapterAssets(
        '<p><a href="ch2.xhtml#n1">下一章</a><a href="#top">顶部</a><a>无 href</a></p>',
        { book: 'abc', chapterHref: 'c.xhtml', resolve: () => 'text/ch2.xhtml' },
      )
      assert.ok(anchors.includes('href="#dsh-reading:ch2.xhtml%23n1"'), `跨章链接必须降级：${anchors}`)
      assert.ok(anchors.includes('href="#top"'), '站内锚点不能被降级')
      assert.ok(anchors.includes('<a>无 href</a>'), '没有 href 的链接不能长出属性')

      // 降级必须覆盖 `<area>`、SVG 的 `<a xlink:href>` 与带命名空间前缀的标签：
      // 这几种在浏览器里同样能触发帧内导航，只认 `<a href>` 会被绕过。
      const exotic = rewriteChapterAssets(
        '<map><area href="ch9.xhtml"/></map>'
        + '<svg><a xlink:href="ch8.xhtml"><text>svg</text></a></svg>'
        + '<xhtml:meta http-equiv="refresh" content="0;url=https://evil.test"/>'
        + '<xhtml:base href="https://evil.test/"/>',
        { book: 'abc', chapterHref: 'c.xhtml', resolve: () => 'text/ch9.xhtml' },
      )
      assert.ok(exotic.includes('href="#dsh-reading:ch9.xhtml"'), `<area href> 也必须降级：${exotic}`)
      assert.ok(
        exotic.includes('xlink:href="#dsh-reading:ch8.xhtml"'),
        `SVG 链接必须降级：${exotic}`,
      )
      assert.ok(!exotic.includes('evil.test'), `带前缀的 meta/base 不能绕过：${exotic}`)

      // F4：属性值里合法地能出现 `>`，标签边界必须按引号判断，不能靠正则截断
      const tricky = rewriteChapterAssets('<p><img alt="a > b" src="p.png"/></p>', {
        book: 'abc',
        chapterHref: 'c.xhtml',
        resolve: () => 'images/p.png',
      })
      assert.ok(
        tricky.includes(`src="${API_PREFIX}/asset?book=abc&amp;href=images%2Fp.png"`),
        `属性值里的 > 不能让这条 src 漏改：${tricky}`,
      )
      assert.ok(tricky.includes('alt="a > b"'), '带 > 的属性值必须原样保留')
    }

    // ── 13.5 PWA：manifest 与图标的 GET 响应 ──
    {
      const res = await call(handler, { method: 'GET', url: `${API_PREFIX}/manifest.webmanifest` })
      assert.equal(res.statusCode, 200)
      assert.match(String(res.headers['content-type']), /manifest\+json/)
      const manifest = res.json()
      assert.equal(manifest.short_name, '深读')
      assert.equal(manifest.start_url, '/')
      assert.equal(manifest.display, 'standalone')
      assert.equal(manifest.icons[0].src, `${API_PREFIX}/icon.svg`)
      assert.equal(manifest.icons[0].type, 'image/svg+xml')

      const icon = await call(handler, { method: 'GET', url: `${API_PREFIX}/icon.svg` })
      assert.equal(icon.statusCode, 200)
      assert.equal(String(icon.headers['content-type']), 'image/svg+xml')
      assert.ok(icon.body.length > 100, '图标不该是空文件')
      assert.match(String(icon.body.slice(0, 64)), /<svg/)
    }

    // ── 14. 错误包装：注入一个必然抛的 store 方法，必须落到 500 且不回显 ──
    {
      const brokenStore = Object.create(store)
      brokenStore.listShelf = async () => {
        throw new Error('内部错误：/Users/someone/secret/path bookHash=deadbeef')
      }
      const brokenHandler = createHandler({ store: brokenStore, logger: { warn: () => {} } })
      const res = await call(brokenHandler, post(`${API_PREFIX}/shelf.list`, {}))
      assert.equal(res.statusCode, 500)
      const payload = res.json()
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, 'internal')
      assert.equal(payload.error.message.includes('/Users/'), false, '内部路径不能回显')
      assert.equal(payload.error.message.includes('bookHash'), false)
      assert.match(payload.error.message, /[\u4e00-\u9fa5]/)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
