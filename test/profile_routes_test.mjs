#!/usr/bin/env node
/**
 * profile.get / profile.rebuild 两个路由的测试（docs/26 §6.2–6.4）。
 *
 * 纯函数的断言在 profile_test.mjs 里，这里只看**接线**有没有接歪：
 *
 *   1. 没问过时 askedCount=0、sentence=null —— 界面据此说「还没问过」；
 *   2. 问过之后数字对得上，且落盘缓存在 reader-profile.json；
 *   3. 缓存是按「问答条数变了才重算」失效的，不是每次都重算，也不是永远不重算；
 *   4. 蒸一章时，画像那一句真的进了 prompt（这是整个 P4 的目的）；
 *   5. 关掉 readerProfile 之后，缓存不再被读、也不再被写 —— 关掉的功能不留痕。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { LibraryStore } from '../lib/store.js'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { bookDirName } from '../lib/paths.js'

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
    json() {
      return JSON.parse(this.body.toString('utf8'))
    },
    text() {
      return this.body.toString('utf8')
    },
  }
}

function makeEpub() {
  return writeZip([
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
        '<dc:title>画像测试</dc:title><dc:creator>测试作者</dc:creator></metadata>' +
        '<manifest>' +
        '<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
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
      name: 'OEBPS/text/ch1.xhtml',
      data:
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
        '<p>检视阅读是把整本书过一遍，先看清结构。主题阅读是把多本书放在一起比。</p>' +
        '<p>主动阅读要求读者自己提出问题。</p></body></html>',
    },
    {
      name: 'OEBPS/text/ch2.xhtml',
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章的正文。</p></body></html>',
    },
  ])
}

function post(method, body) {
  return { method: 'POST', url: API_PREFIX + '/' + method, body }
}

async function call(handler, method, body) {
  const res = makeRes()
  await handler(post(method, body), res)
  return res
}

async function ok(handler, method, body) {
  const res = await call(handler, method, body)
  assert.equal(res.statusCode, 200, method + ' 应成功，实际 ' + res.statusCode + '：' + res.text())
  const payload = res.json()
  assert.equal(payload.ok, true, method + ' 应 ok:true')
  return payload.value
}

/**
 * 桩 AI：记下每次收到的 prompt，回一段能过解析的蒸馏 JSON。
 *
 * 要同时提供 complete（蒸馏走这条）与 ask（问答走这条）：宿主侧这两条路
 * 走的是同一份 createAskService，桩也必须一样，否则测出来的接线是假的。
 * ask 这边只做两件事：落一条问答、把落盘结果并回记录。
 */
function stubAsk(store, seen, reply) {
  return {
    async complete(input) {
      seen.push(input)
      return { answer: typeof reply === 'function' ? reply(input) : reply }
    },
    async ask(input) {
      const record = {
        question: String(input?.question ?? '').trim(),
        answer: '桩回答',
        anchorCfiRange: input?.anchorCfiRange,
        selectedText: input?.selectedText,
        chapterHref: input?.chapterHref,
        chapterLabel: input?.chapterLabel,
        mode: typeof input?.mode === 'string' ? input.mode : 'general',
        model: 'stub/model',
      }
      const entry = await store.appendQa(input?.bookHash, record)
      Object.assign(record, { qaId: entry.id, createdAt: entry.createdAt })
      return record
    },
  }
}

const CHAPTER_REPLY = JSON.stringify({
  thesis: '阅读是主动的',
  points: [{ claim: '检视阅读先看结构', quote: '检视阅读是把整本书过一遍' }],
  terms: [{ term: '检视阅读', meaning: '先看清结构地过一遍' }],
  methods: [],
  quotes: [],
})

export default async function run() {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-profile-routes-'))
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 10, 17, 7, counter++)).toISOString()
  const store = new LibraryStore({ libraryDir, deviceId: 'mac-profile', now, logger: { warn: () => {} } })
  const seen = []
  const warnings = []
  const handler = createHandler({
    store,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    ask: stubAsk(store, seen, CHAPTER_REPLY),
  })

  try {
    const imported = await ok(handler, 'shelf.import', {
      filename: '画像测试.epub',
      dataBase64: makeEpub().toString('base64'),
    })
    const bookHash = imported.bookHash
    const dirName = bookDirName(bookHash)
    const profilePath = path.join(libraryDir, 'dsh-reading', 'books', dirName, 'reader-profile.json')

    // ── 1. 没问过：如实说 0 个问题，但 sentence 是 null（界面不显示「0 个问题」）──
    {
      const value = await ok(handler, 'profile.get', { bookHash })
      assert.equal(value.enabled, true, '默认是开着的')
      assert.equal(value.askedCount, 0)
      assert.equal(value.sentence, null, '没问过就该是 null，界面据此说「还没问过」')
      assert.equal(value.profile, null)
      const onDisk = await fs.readFile(profilePath, 'utf8').catch(() => null)
      assert.equal(onDisk, null, '零问答不该往盘上写一份空画像')
    }

    // ── 2. 问过几句：数字对得上，并且落盘缓存 ──
    const askBody = (question, mode, chapterHref, chapterLabel) => ({
      bookHash,
      question,
      selectedText: '检视阅读是把整本书过一遍',
      anchorCfiRange: 'epubcfi(/6/2[ch1]!/4/2/1:0,/4/2/1:5)',
      chapterHref,
      chapterLabel,
      bookTitle: '画像测试',
      author: '测试作者',
      surroundingText: '检视阅读是把整本书过一遍，先看清结构。',
      mode,
    })

    await ok(handler, 'qa.ask', askBody('检视阅读和主题阅读的区别是什么？', 'concept', 'text/ch1.xhtml', '第一章'))
    await ok(handler, 'qa.ask', askBody('检视阅读到底要怎么练？', 'concept', 'text/ch1.xhtml', '第一章'))
    await ok(handler, 'qa.ask', askBody('主动阅读是什么意思？', 'general', 'text/ch1.xhtml', '第一章'))

    {
      const value = await ok(handler, 'profile.get', { bookHash })
      assert.equal(value.askedCount, 3)
      assert.equal(value.profile.modes.concept, 2)
      assert.equal(value.profile.modes.general, 1)
      assert.equal(value.profile.chapters[0].label, '第一章')
      assert.equal(value.profile.chapters[0].count, 3)
      assert.ok(value.sentence && typeof value.sentence.head === 'string')
      assert.match(value.sentence.head, /这本书你问过 3 个问题/)
      assert.match(value.sentence.head, /3 个集中在第一章/)

      const onDisk = JSON.parse(await fs.readFile(profilePath, 'utf8'))
      assert.equal(onDisk.version, 1, '缓存里要带结构版本，改形状时才能认出老文件')
      // 画像记的是目录名（16 位），不是导入时给的 64 位哈希：
      // requireBook 会统一成目录名，两边必须同一个口径，否则缓存判据永远失效。
      assert.equal(onDisk.bookHash, dirName)
      assert.equal(onDisk.askedCount, 3)
    }

    // ── 3. 缓存命中：第二次读不再重算（cached=true），条数变化后重算 ──
    {
      const again = await ok(handler, 'profile.get', { bookHash })
      assert.equal(again.cached, true, '没问新问题就该走缓存')

      await ok(handler, 'qa.ask', askBody('主题阅读要读几本书？', 'concept', 'text/ch2.xhtml', '第二章'))
      const fresh = await ok(handler, 'profile.get', { bookHash })
      assert.equal(fresh.cached, false, '问了新问题就必须重算')
      assert.equal(fresh.askedCount, 4)
      assert.equal(fresh.profile.modes.concept, 3)
    }

    // ── 4. 蒸一章：画像那一句真的进了 prompt ──
    {
      seen.length = 0
      const dbgRes = await call(handler, 'distill.chapter', { bookHash, href: 'text/ch1.xhtml' })
      assert.equal(dbgRes.statusCode, 200, 'distill 失败：' + dbgRes.text() + ' / 日志：' + warnings.join(' | '))
      assert.equal(seen.length, 1, '应该只调一次模型')
      const prompt = seen[0].prompt
      assert.match(prompt, /硬性要求：/, '原有要求段落还在')
      assert.match(prompt, /逐字复制/, '逐字抄的底线不能被画像顶掉')
      assert.match(prompt, /这位读者在这本书里问过 4 个问题/, '画像句子要进 prompt：' + prompt.slice(-400))
      assert.match(prompt, /第 1 条不变/, '要明确说清画像不松动逐字抄')
    }

    // ── 5. 重新分析：无视缓存重算并落盘 ──
    {
      const rebuilt = await ok(handler, 'profile.rebuild', { bookHash })
      assert.equal(rebuilt.askedCount, 4)
      assert.ok(rebuilt.sentence && typeof rebuilt.sentence.tail === 'string')
      const after = await ok(handler, 'profile.get', { bookHash })
      assert.equal(after.cached, true, '重算之后缓存是最新的')
    }

    // ── 6. 关掉 readerProfile：不读缓存、不写盘、prompt 回到通用口径 ──
    {
      await ok(handler, 'settings.put', { readerProfile: false })
      const off = await ok(handler, 'profile.get', { bookHash })
      assert.equal(off.enabled, false)
      assert.equal(off.sentence, null, '关掉之后界面不该再显示那两行')
      assert.equal(off.profile, null)

      seen.length = 0
      await ok(handler, 'distill.chapter', { bookHash, href: 'text/ch2.xhtml' })
      const prompt = seen[0].prompt
      assert.equal(prompt.includes('这位读者'), false, '关掉之后 prompt 必须回到通用口径')
      assert.match(prompt, /不要评价这本书好不好/, '通用口径的四条要求还在')
    }

    // ── 7. 打开回来：缓存还在，不用重算 ──
    {
      await ok(handler, 'settings.put', { readerProfile: true })
      const back = await ok(handler, 'profile.get', { bookHash })
      assert.equal(back.enabled, true)
      assert.equal(back.cached, true, '关掉再打开不该白丢一次统计')
      assert.equal(back.askedCount, 4)
    }
  } finally {
    await fs.rm(libraryDir, { recursive: true, force: true })
  }

  console.log('读者画像路由：7 组用例全部通过')
}
