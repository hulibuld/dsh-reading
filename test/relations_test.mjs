#!/usr/bin/env node
/**
 * 人物关系：纯函数层 + 三条路由（0.13.0 P5）。
 *
 * 只钉三件事，都是「错了用户会以为程序在瞎编」的地方：
 *   1. 不是小说就不生成 —— verdict.fiction===false 时路由拒绝；
 *   2. 每条边都必须能在原文里核上 —— 核不上的丢掉并计数，不许留在图上；
 *   3. 抽一批、失败一批都要落盘 —— 否则断点续跑从第一批重新开始。
 *
 * 模型永远不真调：ask.complete 换成桩。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { LibraryStore } from '../lib/store.js'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { bookDirName } from '../lib/paths.js'
import {
  buildBatchPrompt,
  emptyState,
  fictionVerdict,
  mergeBatch,
  nextBatch,
  normalizeState,
  parseBatchReply,
  planBatches,
  progressOf,
  reindexBatches,
  toInner,
  toMermaid,
  verifyEdges,
} from '../lib/relations.js'

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
  const chapter = (no, body) => ({
    name: 'OEBPS/text/ch' + no + '.xhtml',
    data: '<html xmlns="http://www.w3.org/1999/xhtml"><body>' + body + '</body></html>',
  })
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
        '<dc:title>关系测试</dc:title><dc:creator>测试作者</dc:creator></metadata>' +
        '<manifest>' +
        '<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="ch3"/></spine></package>',
    },
    {
      name: 'OEBPS/nav.xhtml',
      data:
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
        '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">第一章</a></li>' +
        '<li><a href="text/ch2.xhtml">第二章</a></li>' +
        '<li><a href="text/ch3.xhtml">第三章</a></li></ol></nav></body></html>',
    },
    chapter(1, '<p>贾母是宝玉的祖母，府里上上下下都听她的。</p>'),
    chapter(2, '<p>黛玉初进贾府，宝玉见了她便说这个妹妹我见过的。</p>'),
    chapter(3, '<p>袭人原是贾母房里的丫头，后来服侍宝玉。</p>'),
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

async function fails(handler, method, body, status, code) {
  const res = await call(handler, method, body)
  const text = res.text()
  assert.equal(res.statusCode, status, method + ' 状态码应为 ' + status + '，实际 ' + res.statusCode + '：' + text)
  const payload = JSON.parse(text)
  assert.equal(payload.ok, false)
  if (code) assert.equal(payload.error.code, code, '错误码应为 ' + code + '，实际 ' + payload.error.code)
  assert.match(payload.error.message, /[\u4e00-\u9fa5]/, '错误文案必须是中文')
  return payload
}

async function verdictReadsCategoryOnly() {
  // 判不出来一律当「不是小说」，并如实说理由：宁可少画一张图，也不硬凑。
  assert.equal(fictionVerdict({}).fiction, false, '没有分类就不许猜成小说')
  assert.match(fictionVerdict({}).reason, /判断不出/)
  assert.equal(fictionVerdict({ title: '红楼梦' }).fiction, false, '书名不是判据')
  assert.equal(fictionVerdict({ category: '小说' }).fiction, true)
  assert.equal(fictionVerdict({ category: '长篇小说' }).fiction, true)
  assert.equal(fictionVerdict({ tags: ['文学', '小说'] }).fiction, true)
  assert.equal(fictionVerdict({ category: '计算机' }).fiction, false)
  assert.match(fictionVerdict({ category: '计算机' }).reason, /[\u4e00-\u9fa5]/)
}

async function batchesNeverSplitAChapter() {
  const chapters = [
    { href: 'a', label: '第一章', text: 'x'.repeat(30) },
    { href: 'b', label: '第二章', text: 'y'.repeat(30) },
    { href: 'c', label: '第三章', text: 'z'.repeat(60) },
  ]
  const planned = planBatches(chapters, { maxChars: 80, maxBatches: 8 })
  assert.equal(planned.batches.length >= 2, true, '三章装不进一批')
  for (const batch of planned.batches) assert.equal(batch.chapters.length >= 1, true)
  const huge = planBatches([{ href: 'a', label: '大章', text: 'q'.repeat(500) }], { maxChars: 100, maxBatches: 8 })
  assert.equal(huge.batches.length, 1)
  assert.equal(huge.batches[0].chapters.length, 1)
}

async function parseReplyDropsEdgesWithoutQuote() {
  const reply = JSON.stringify({
    persons: [{ name: '宝玉', alias: ['宝二爷'] }, { name: '宝玉' }],
    edges: [
      { from: '宝玉', to: '贾母', label: '祖孙', quote: '贾母是宝玉的祖母' },
      { from: '宝玉', to: '黛玉', label: '知己', quote: '' },
      { from: '宝玉', to: '宝玉', label: '自恋', quote: '宝玉' },
    ],
  })
  const parsed = parseBatchReply(reply)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.persons.length, 1, '重名的人只留一个')
  assert.deepEqual(parsed.persons[0].alias, ['宝二爷'])
  assert.equal(parsed.edges.length, 1, '缺 quote 和自环的边都要丢')
  assert.equal(parseBatchReply('不是 JSON').ok, false)
}

async function verifyDropsQuotesNotInSource() {
  const chapters = [{ href: 'a', label: '第一章', text: '贾母是宝玉的祖母，府里上上下下都听她的。' }]
  const edges = [
    { from: '宝玉', to: '贾母', label: '祖孙', quote: '贾母是宝玉的祖母' },
    { from: '宝玉', to: '黛玉', label: '知己', quote: '这个妹妹我见过的' },
  ]
  const checked = verifyEdges(chapters, edges)
  assert.equal(checked.edges.length, 1, '原文里没有的那条必须丢')
  assert.equal(checked.dropped, 1)
  assert.equal(checked.edges[0].verified, true)
  assert.equal(checked.edges[0].chapterHref, 'a')
  assert.equal(checked.edges[0].chapterLabel, '第一章')
}

async function mergeAndProgressAddUp() {
  const base = emptyState({ bookHash: 'h', category: '小说' })
  const state = reindexBatches(base, planBatches([
    { href: 'a', label: '第一章', text: 'a'.repeat(10) },
    { href: 'b', label: '第二章', text: 'b'.repeat(10) },
  ], { maxChars: 1000, maxBatches: 8 }).batches)
  assert.equal(progressOf(state).total, 1)
  assert.equal(nextBatch(state).index, 0)

  const merged = mergeBatch(state, {
    index: 0,
    chapters: [{ href: 'a', label: '第一章' }],
    persons: [{ name: '宝玉', alias: [] }],
    edges: [{ from: '宝玉', to: '贾母', label: '祖孙', quote: '原文一句', verified: true }],
    dropped: 2,
  })
  const progress = progressOf(merged)
  assert.equal(progress.done, 1)
  assert.equal(progress.finished, true)
  assert.equal(progress.persons, 1)
  assert.equal(progress.edges, 1)
  assert.equal(progress.dropped, 2)
  assert.equal(nextBatch(merged), null)
  assert.equal(merged.persons[0].alias.length, 0, '空别名不许塞空串')
}

async function mermaidKeepsChineseInLabel() {
  const state = normalizeState({
    bookHash: 'h',
    persons: [{ name: '贾 宝玉', alias: [] }, { name: '林黛玉', alias: [] }],
    edges: [{ from: '贾 宝玉', to: '林黛玉', label: '知"己', quote: 'q', verified: true }],
  })
  const code = toMermaid(state)
  assert.match(code, /^graph LR/)
  assert.match(code, /p0\["贾 宝玉"\]/, '中文名放方括号里，id 里不能有空格')
  assert.equal(code.includes('"知"'), false, 'label 里的引号必须去掉')
  assert.equal(toMermaid(emptyState({})), '', '一个人都没有就不要出图')
  assert.match(toInner(emptyState({})), /[\u4e00-\u9fa5]/, '空态也要说人话')
}

async function promptDemandsVerbatimQuote() {
  const prompt = buildBatchPrompt({
    bookTitle: '红楼梦',
    author: '曹雪芹',
    chapters: [{ label: '第一章', text: '贾母是宝玉的祖母。' }],
    knownPersons: ['宝玉'],
    readerLine: '这一位读者多半在问术语。',
  })
  assert.match(prompt, /红楼梦/)
  assert.match(prompt, /逐字复制/)
  assert.match(prompt, /宝玉/)
  assert.match(prompt, /术语/, '画像那一行要进 prompt')
  assert.match(prompt, /只写这一段里确实出现/)
}

export default async function run() {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-relations-'))
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 10, 17, 6, counter++)).toISOString()
  const store = new LibraryStore({ libraryDir, deviceId: 'mac-rel', now, logger: { warn: () => {} } })

  const replies = []
  const seen = []
  const ask = {
    complete: async (input) => {
      seen.push(input)
      const next = replies.shift()
      if (next instanceof Error) throw next
      return { answer: typeof next === 'string' ? next : '' }
    },
  }
  const handler = createHandler({ store, ask, logger: { warn: () => {} } })

  try {
    await verdictReadsCategoryOnly()
    await batchesNeverSplitAChapter()
    await parseReplyDropsEdgesWithoutQuote()
    await verifyDropsQuotesNotInSource()
    await mergeAndProgressAddUp()
    await mermaidKeepsChineseInLabel()
    await promptDemandsVerbatimQuote()

    const imported = await ok(handler, 'shelf.import', {
      filename: '关系.epub',
      dataBase64: makeEpub().toString('base64'),
    })
    const bookHash = imported.bookHash

    {
      const state = await ok(handler, 'relations.get', { bookHash })
      assert.equal(state.progress.total, 0)
      assert.equal(state.persons.length, 0)
      assert.equal(state.edges.length, 0)
      assert.equal(state.canBuild, false, '没有分类就判不出小说，不能直接抽')
      assert.equal(state.verdict.fiction, false, '判不出来一律当不是小说')
      assert.equal(state.bookTitle, '关系测试')
      assert.equal(state.chapterTotal, 3)
      assert.equal(state.sourceChapters, 3)
    }

    // 没分类时点了「抽」：必须当场拒绝，不能白烧一次调用
    {
      const rejected = await fails(handler, 'relations.build', { bookHash }, 400, 'E_NOT_FICTION')
      assert.equal(typeof rejected.error.message, 'string')
      assert.equal(seen.length, 0, '拒绝了就不该调模型')
    }

    await ok(handler, 'book.update', { bookHash, category: '小说' })
    {
      const state = await ok(handler, 'relations.get', { bookHash })
      assert.equal(state.verdict.fiction, true)
      assert.equal(state.canBuild, true)
    }

    replies.push(JSON.stringify({
      persons: [{ name: '宝玉', alias: ['宝二爷'] }, { name: '贾母', alias: [] }],
      edges: [
        { from: '宝玉', to: '贾母', label: '祖孙', quote: '贾母是宝玉的祖母' },
        { from: '宝玉', to: '黛玉', label: '知己', quote: '这一句原文里根本没有' },
      ],
    }))
    {
      const result = await ok(handler, 'relations.build', { bookHash })
      assert.equal(result.done, true, '只有一批，抽完就是 done')
      assert.equal(result.batch.kept, 1, '原文核不上的那条边要丢掉')
      assert.equal(result.batch.dropped, 1)
      assert.equal(result.progress.edges, 1)
      assert.match(result.batch.label, /[\u4e00-\u9fa5]/)
      assert.equal(seen.length, 1, '只调了一次模型')
      assert.equal(seen[0].kind, 'relations')
      // 路由层传下去的是书架目录名（bookDirName），和蒸馏那边一致。
      assert.equal(seen[0].bookHash, bookDirName(bookHash))
      assert.equal(seen[0].timeoutMs, 240000, '抽关系比普通问答慢，超时单独给')
    }

    {
      const state = await ok(handler, 'relations.get', { bookHash })
      assert.equal(state.progress.done, 1)
      assert.equal(state.progress.finished, true)
      assert.equal(state.canBuild, false, '抽完了就不该再给「继续抽」')
      assert.equal(state.persons.length, 2)
      assert.equal(state.edges[0].verified, true)
      // 章名按 chapterIndex 给的来（有目录用目录，没有就是「第 N 章」）
      assert.match(state.edges[0].chapterLabel, /第\s*[0-9一二三四五六七八九十]+\s*章/)
    }

    // 重来一遍才有失败的批次可测：抽完的批次不会再跑。
    await ok(handler, 'relations.clear', { bookHash })
    replies.push(new Error('模型超时'))
    await fails(handler, 'relations.build', { bookHash }, 502, 'E_RELATIONS_FAILED')
    {
      const state = await ok(handler, 'relations.get', { bookHash })
      assert.equal(state.progress.failed, 1, '失败也要记下来')
      assert.equal(state.progress.finished, true)
    }

    replies.push('我拒绝输出 JSON')
    await fails(handler, 'relations.build', { bookHash, index: 0 }, 502, 'E_RELATIONS_FORMAT')

    {
      const cleared = await ok(handler, 'relations.clear', { bookHash })
      assert.equal(cleared.cleared, true)
      const state = await ok(handler, 'relations.get', { bookHash })
      assert.equal(state.persons.length, 0)
      assert.equal(state.edges.length, 0)
      assert.equal(state.progress.total, 0)
      assert.equal(state.verdict.fiction, true, 'verdict 从 meta 重算：清空不等于换书')
    }
  } finally {
    await fs.rm(libraryDir, { recursive: true, force: true })
  }
}
