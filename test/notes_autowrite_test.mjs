#!/usr/bin/env node
/**
 * 「问完一句，笔记自己就会长出来」的测试（docs/26 §五 L0 自动归位）。
 *
 * 这条链路的价值全在**副作用**上：qa.ask 的返回值一个字都不该变（用户要的是答案），
 * 但答完之后 vault 里必须多出一个讨论块。所以这里断言的几乎全是磁盘上的字节，
 * 而不是 JSON 响应。
 *
 * 四组用例对应四种真实处境：
 *   1. 配了库、开关开着  → 答案照常返回，笔记里出现这条问答；
 *   2. 开关关掉          → 照常问、照常落书库，笔记不动（这是用户的明确选择）；
 *   3. 没配库            → 同上，且不许报错（大部分用户压根不用 Obsidian）；
 *   4. 库写不进去        → 答案仍然给到手，只把失败如实塞进返回值。
 *
 * 第 4 组是整条链路的底线：写笔记是顺手的事，不能因为它把答案一起弄丢。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { LibraryStore } from '../lib/store.js'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { bookDirName } from '../lib/paths.js'
import { DEFAULT_SUBDIR } from '../lib/vault.js'

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

/** 两章的 EPUB（与 notes_routes_test 同构，书名换成好认的）。 */
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
        '<dc:title>自动归位</dc:title><dc:creator>测试作者</dc:creator></metadata>' +
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
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一章的正文。</p></body></html>',
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
 * 桩 AI：行为与 lib/ask.js 的 ask() 一致 —— 先 appendQa 落书库，再把 id 并回记录。
 *
 * 为什么不直接用真的 createAskService：它要宿主 ctx（子代理、模型目录、活动会话），
 * 那套东西在测试里全是假的，测出来只能证明「桩能跑」。这里要证明的是**路由层
 * 在拿到答案之后有没有去写笔记**，所以桩只需要复现「答案 + 落盘」这个契约。
 */
function stubAsk(store, label) {
  const seen = []
  return {
    seen,
    async ask(input) {
      seen.push(input)
      const record = {
        question: String(input.question ?? '').trim(),
        answer: label,
        anchorCfiRange: input.anchorCfiRange,
        selectedText: input.selectedText,
        chapterHref: input.chapterHref,
        chapterLabel: input.chapterLabel,
        mode: 'general',
        model: 'stub/model',
      }
      const entry = await store.appendQa(input.bookHash, record)
      Object.assign(record, { qaId: entry.id, createdAt: entry.createdAt })
      return record
    },
  }
}

export default async function run() {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-autowrite-'))
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-autowrite-vault-'))
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 10, 17, 6, counter++)).toISOString()
  const store = new LibraryStore({ libraryDir, deviceId: 'mac-autowrite', now, logger: { warn: () => {} } })
  const warnings = []
  const ask = stubAsk(store, '这是桩回答：读一章先看这一章要回答什么问题。')
  const handler = createHandler({
    store,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    ask,
  })

  try {
    const imported = await ok(handler, 'shelf.import', {
      filename: '自动归位.epub',
      dataBase64: makeEpub().toString('base64'),
    })
    const bookHash = imported.bookHash
    const dirName = bookDirName(bookHash)
    const folder = path.join(vaultRoot, DEFAULT_SUBDIR, '《自动归位》-' + dirName)
    const notePath = path.join(folder, '《自动归位》 01 读书笔记.md')

    const askBody = {
      bookHash,
      question: '为什么读一本书要先提出四个问题？',
      selectedText: '第一章的正文',
      anchorCfiRange: 'epubcfi(/6/2[ch1]!/4/2/1:0,/4/2/1:5)',
      chapterHref: 'text/ch1.xhtml',
      chapterLabel: '第一章',
      bookTitle: '自动归位',
      author: '测试作者',
      surroundingText: '第一章的正文。',
      mode: 'general',
    }

    // ── 1. 没配库：照常问答，笔记一动不动，也不许报错 ──
    {
      const value = await ok(handler, 'qa.ask', askBody)
      assert.equal(value.answer, '这是桩回答：读一章先看这一章要回答什么问题。', '答案必须原样返回')
      assert.equal(value.obsidian.skipped, true, '没配库时如实说跳过了')
      assert.equal(value.obsidian.reason, 'no-vault')
      const onDisk = await fs.readdir(path.join(vaultRoot, DEFAULT_SUBDIR)).catch(() => [])
      assert.deepEqual(onDisk, [], '没配库不该凭空造出目录')
    }

    // ── 2. 配好库、开关开着：答完自己长出一条讨论块 ──
    {
      await ok(handler, 'vault.choose', { path: vaultRoot })
      const value = await ok(handler, 'qa.ask', askBody)
      // 这是第一次落盘：文件不存在，所以除了这一条讨论块，还要补章节小节
      // 和书库里**之前那条**（第 1 组问过、落盘成功、只是没库可写）的问答。
      assert.ok(value.obsidian.written >= 1, '至少要把这一条写进去，实际 ' + value.obsidian.written)
      assert.equal(value.obsidian.conflicts, 0)
      assert.equal(value.obsidian.files.length, 1, '只要 01 读书笔记，不要为一条问答重算全书地图')
      assert.equal(value.obsidian.files[0].kind, 'note')
      assert.ok(value.obsidian.files[0].openUrl.startsWith('obsidian://open?'), '要能一键跳过去看')

      const bytes = await fs.readFile(notePath, 'utf8')
      assert.ok(bytes.startsWith('# 《自动归位》 读书笔记'), '标题要自己补上')
      assert.ok(bytes.includes('为什么读一本书要先提出四个问题？'), '问题要进笔记')
      assert.ok(bytes.includes('这是桩回答'), '答案摘摘要进笔记')
      assert.ok(bytes.includes('## 第一章'), '要归到这一章的小节下')
      assert.ok(bytes.includes('dsh-reading:block'), '要遵守锚块协议')
      // 只写问 + 答摘要 + 关联原句：模型名、模式名不许进笔记
      assert.equal(bytes.includes('stub/model'), false, '笔记里不许出现模型名')
      assert.equal(bytes.includes('general'), false, '笔记里不许出现模式名')
    }

    // ── 3. 再问一次：增量追加，不是整份重写 ──
    {
      const before = await fs.readFile(notePath, 'utf8')
      const value = await ok(handler, 'qa.ask', {
        ...askBody,
        question: '那第二个问题是什么？',
        selectedText: '第一章的正文。',
      })
      assert.equal(value.obsidian.written, 1)
      const after = await fs.readFile(notePath, 'utf8')
      assert.ok(after.startsWith(before.slice(0, 40)), '原有标题不该被挪动')
      assert.ok(after.includes('为什么读一本书要先提出四个问题？'), '上一条要留着')
      assert.ok(after.includes('那第二个问题是什么？'), '新的一条要追加进来')
      assert.ok(after.length > before.length, '文件应该变长')
    }

    // ── 4. 开关关掉：照常问、照常落书库，笔记不动 ──
    {
      const before = await fs.readFile(notePath, 'utf8')
      await ok(handler, 'settings.put', { obsidianAutoWrite: false })
      const value = await ok(handler, 'qa.ask', { ...askBody, question: '关了开关还会写吗？' })
      assert.equal(value.obsidian.skipped, true)
      assert.equal(value.obsidian.reason, 'off')
      assert.equal(await fs.readFile(notePath, 'utf8'), before, '关了开关笔记一个字节都不许动')
      // 但书库里的问答记录必须照常长：关的只是 Obsidian。
      const list = await ok(handler, 'qa.list', { bookHash })
      assert.ok(
        list.records.some((record) => record.question === '关了开关还会写吗？'),
        '关了 Obsidian 开关，问答本身仍要落盘',
      )
      await ok(handler, 'settings.put', { obsidianAutoWrite: true })
    }

    // ── 5. 库写不进去：答案必须还给用户 ──
    {
      // 把整棵子目录换成同名文件，任何写入都会立刻失败。
      await fs.rm(path.join(vaultRoot, DEFAULT_SUBDIR), { recursive: true, force: true })
      await fs.writeFile(path.join(vaultRoot, DEFAULT_SUBDIR), 'not a directory')
      const value = await ok(handler, 'qa.ask', { ...askBody, question: '库坏了还能问吗？' })
      assert.equal(typeof value.answer, 'string', '答案必须还在')
      assert.ok(value.answer !== '', '答案不能被吞掉')
      assert.equal(typeof value.obsidian.error, 'string', '失败要如实说出来：' + JSON.stringify(value.obsidian))
      assert.match(value.obsidian.error, /[\u4e00-\u9fa5]/, '错误文案要是人话')
      for (const leaked of ['bookHash', 'E_', 'undefined', '/tmp/', 'ENOTDIR', 'EEXIST']) {
        assert.equal(
          value.obsidian.error.includes(leaked),
          false,
          '文案不该出现内部词 ' + leaked + '：' + value.obsidian.error,
        )
      }
      assert.ok(warnings.length > 0, '失败要留一条日志，排障才查得到')
    }

    console.log(
      'notes_autowrite: 5 组用例通过（没配库跳过、问完自动写、增量追加、关开关只关 Obsidian、库坏不影响答案）',
    )
  } finally {
    await fs.rm(libraryDir, { recursive: true, force: true })
    await fs.rm(vaultRoot, { recursive: true, force: true })
  }
}
