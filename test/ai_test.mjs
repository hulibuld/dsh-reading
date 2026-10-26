/**
 * AI 调用账本、状态诊断与蒸馏纯函数（0.8.0）的测试。
 *
 * 这一层要防的是「静默失效」：账本写不进去、状态永远显示正常、引文核对永远通过。
 * 所以每条断言都盯着「坏的那一路」——
 *   · 失败也必须有记录（否则用户看到的永远是绿色的「AI 可用」）；
 *   · 四道检查缺任何一道，available 必须变 false；
 *   · 原文里找不到的引文必须被标成未回源。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAiCallLog, withAiLog, MAX_AI_RECORDS } from '../lib/aicall.js'
import { describeAiStatus, probeAi } from '../lib/aistatus.js'
import {
  buildAskPrompt,
} from '../lib/ask.js'
import {
  buildChapterPrompt,
  extractJson,
  locateQuote,
  mergeChapter,
  parseChapterReply,
  parseSkeletonReply,
  progressOf,
  toMarkdown,
  verifyChapterQuotes,
} from '../lib/distill.js'

async function tempPaths() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-ai-'))
  return {
    paths: { file: (name) => path.join(dir, name) },
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

// ── 账本 ────────────────────────────────────────────────────────────

async function logRecordsSuccessAndFailure() {
  const { paths, cleanup } = await tempPaths()
  try {
    const log = createAiCallLog({ paths, logger: { warn: () => {} } })
    const ok = await log.record({ kind: 'ask', label: '问一句', ok: true, latencyMs: 800, model: 'x/y' })
    assert.equal(ok.ok, true)
    const bad = await log.record({
      kind: 'distill',
      label: '第一章',
      ok: false,
      code: 'E_AI_UNAVAILABLE',
      message: '连不上',
    })
    assert.equal(bad.ok, false)

    const items = await log.list(10)
    assert.equal(items.length, 2)
    // 最新在前
    assert.equal(items[0].code, 'E_AI_UNAVAILABLE')
    assert.equal(items[1].label, '问一句')

    const summary = await log.summary()
    assert.equal(summary.total, 2)
    assert.equal(summary.failed, 1)
    assert.equal(summary.consecutiveFailures, 1)
    assert.equal(summary.codes[0].code, 'E_AI_UNAVAILABLE')

    await log.clear()
    assert.equal((await log.list()).length, 0)
  } finally {
    await cleanup()
  }
}

async function logDropsOversizedLines() {
  const { paths, dir, cleanup } = await tempPaths()
  try {
    const log = createAiCallLog({ paths, logger: { warn: () => {} } })
    const file = path.join(dir, 'ai-calls.jsonl')
    await fs.writeFile(file, '这不是 JSON\n{"ok":true,"kind":"ask"}\n\n', 'utf8')
    const items = await log.list()
    // 坏行跳过，好行照用：一行坏了不能让整本账本作废
    assert.equal(items.length, 1)
    assert.equal(items[0].kind, 'ask')
    assert.equal(MAX_AI_RECORDS > 0, true)
  } finally {
    await cleanup()
  }
}

async function wrapperRecordsBothPaths() {
  const { paths, cleanup } = await tempPaths()
  try {
    const log = createAiCallLog({ paths, logger: { warn: () => {} } })
    const fake = {
      async complete(input) {
        if (String(input.prompt).includes('炸')) {
          const error = new Error('连不上模型')
          error.code = 'E_AI_NO_SESSION'
          error.status = 503
          throw error
        }
        return { answer: '好了', model: 'p/m' }
      },
      async ask() {
        return { answer: '答', question: 'q' }
      },
    }
    const wrapped = withAiLog(fake, log)

    const good = await wrapped.complete({ prompt: '正常', label: '正常一调', kind: 'ask' })
    assert.equal(good.answer, '好了')

    await assert.rejects(
      () => wrapped.complete({ prompt: '炸一下', label: '炸', kind: 'distill' }),
      /连不上模型/,
    )

    const items = await log.list(5)
    assert.equal(items.length, 2)
    assert.equal(items[0].ok, false)
    assert.equal(items[0].code, 'E_AI_NO_SESSION')
    assert.equal(items[0].status, 503)
    assert.equal(items[1].ok, true)
    assert.equal(items[1].model, 'p/m')

    // 失败也要保留「这次带的是什么」，否则用户不知道重试的是什么
    assert.equal(items[0].preview, '炸一下')
  } finally {
    await cleanup()
  }
}

// ── 状态诊断 ────────────────────────────────────────────────────────

async function statusReportsEveryBrokenCheck() {
  // 1. 什么都没有：四道全红
  const empty = describeAiStatus({ ctx: { get: () => false } })
  assert.equal(empty.available, false)
  assert.equal(empty.checks.length, 4)
  assert.equal(empty.checks.filter((item) => !item.ok).length, 4)
  for (const check of empty.checks) {
    assert.equal(typeof check.fix, 'string')
    assert.notEqual(check.fix, '')
  }

  // 2. 服务齐全：四道全绿
  const parent = { id: 'agent-1', options: { provider: 'p', model: 'm' } }
  const ctx = {
    get(name) {
      if (name === 'subagents') return { startActivation: () => {} }
      if (name === 'agents') return { roots: () => [parent], list: () => [parent] }
      if (name === 'llm') return { listProviders: () => ['p'], listModels: () => ['m'] }
      return false
    },
  }
  const healthy = describeAiStatus({ ctx })
  assert.equal(healthy.available, true)
  assert.equal(healthy.provider, 'p')
  assert.equal(healthy.model, 'm')

  // 3. 有服务但没有会话：只有 session/route 红
  const noSessionCtx = {
    get(name) {
      if (name === 'subagents') return { startActivation: () => {} }
      if (name === 'agents') return { roots: () => [], list: () => [] }
      return false
    },
  }
  const noSession = describeAiStatus({ ctx: noSessionCtx })
  assert.equal(noSession.available, false)
  assert.equal(noSession.checks.find((item) => item.id === 'session').ok, false)
  assert.equal(noSession.checks.find((item) => item.id === 'route').ok, false)
}

async function probeReportsFailureShape() {
  const failed = await probeAi({
    ask: {
      async complete() {
        const error = new Error('网络不通')
        error.code = 'E_AI_UNAVAILABLE'
        throw error
      },
    },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'E_AI_UNAVAILABLE')
  assert.notEqual(failed.fix, '')

  const ok = await probeAi({ ask: { async complete() { return { answer: '可用', model: 'p/m' } } } })
  assert.equal(ok.ok, true)
  assert.equal(ok.model, 'p/m')
  assert.equal(ok.answer, '可用')

  const missing = await probeAi({ ask: null })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'E_AI_UNAVAILABLE')
}

// ── 「携带当前工作内容」 ──────────────────────────────────────────

async function askPromptCarriesSurroundingText() {
  const prompt = buildAskPrompt({
    selectedText: '这句话',
    question: '什么意思',
    bookTitle: '某书',
    author: '某人',
    chapterLabel: '第一章',
    surroundingText: '前面的话这句话后面的话',
  })
  assert.match(prompt, /这段文字的上下文/)
  assert.match(prompt, /前面的话这句话后面的话/)
  assert.match(prompt, /读者的问题：什么意思/)

  // 没给上下文时不出现空的上下文块（空 """ 对模型是噪音）
  const bare = buildAskPrompt({ selectedText: '这句话', question: '什么意思' })
  assert.doesNotMatch(bare, /这段文字的上下文/)

  // 上下文等于选区时也不重复贴一遍
  const same = buildAskPrompt({ selectedText: '这句话', question: 'q', surroundingText: '这句话' })
  assert.doesNotMatch(same, /这段文字的上下文/)
}

// ── 蒸馏纯函数 ──────────────────────────────────────────────────────

async function distillParsesAndDropsBadItems() {
  const reply = '```json\n' + JSON.stringify({
    thesis: '这一章讲专注',
    points: [
      { claim: '专注是稀缺资源', quote: '专注是一种稀缺资源' },
      { claim: '', quote: '没有 claim 的条目要丢掉' },
    ],
    terms: [
      { term: '深度工作', meaning: '无干扰下的认知密集型工作' },
      { term: '空义项', meaning: '' },
    ],
    methods: [
      { name: '时间块', when: '需要长时间专注时', steps: ['关掉通知', '定 90 分钟'], check: '连续 90 分钟没被打断' },
      { name: '缺判据', when: '什么时候', steps: ['一步'], check: '' },
    ],
    quotes: [{ text: '专注是一种稀缺资源' }, { text: '' }],
  }) + '\n```'
  const parsed = parseChapterReply(reply)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.thesis, '这一章讲专注')
  assert.equal(parsed.points.length, 1)
  assert.equal(parsed.terms.length, 1)
  // 缺 check 或缺步骤（<2 步）的方法一律丢掉：一句话的空方法不算方法
  assert.equal(parsed.methods.length, 1)
  assert.equal(parsed.quotes.length, 1)

  const broken = parseChapterReply('对不起我做不到')
  assert.equal(broken.ok, false)
  assert.match(broken.error, /没按格式/)
}

async function distillExtractsJsonFromNoise() {
  assert.deepEqual(extractJson('前面废话 {"a":1} 后面废话'), { a: 1 })
  assert.equal(extractJson('没有 JSON'), null)
  assert.equal(extractJson(''), null)

  const skeleton = parseSkeletonReply('{"oneLine":"讲专注","thesis":"T","structure":"S","audience":"A"}')
  assert.equal(skeleton.ok, true)
  assert.equal(skeleton.oneLine, '讲专注')
}

async function distillVerifiesQuotesAgainstSource() {
  const chapterText = '深度工作是一种能力。专注是一种稀缺资源。它需要练习。'
  const located = locateQuote(chapterText, '专注是一种稀缺资源')
  assert.notEqual(located, null)
  assert.equal(located.offset > 0, true)

  const verified = verifyChapterQuotes(chapterText, {
    points: [
      { claim: '真引文', quote: '专注是一种稀缺资源' },
      { claim: '编的引文', quote: '专注是天生的天赋' },
    ],
    quotes: [{ text: '它需要练习' }],
  })
  assert.equal(verified.points[0].verified, true)
  assert.equal(verified.points[1].verified, false)
  assert.equal(verified.quotes[0].verified, true)

  // 太短的串不算命中（四字以下到处都是，核对没有意义）
  assert.equal(locateQuote(chapterText, '专注'), null)
}

async function distillMergesInSpineOrder() {
  const state = { version: 1, chapters: [], skeleton: null }
  const a = mergeChapter(state, { href: 'b.xhtml', label: '第二章', status: 'done' }, ['a.xhtml', 'b.xhtml'])
  const b = mergeChapter(a, { href: 'a.xhtml', label: '第一章', status: 'done' }, ['a.xhtml', 'b.xhtml'])
  assert.deepEqual(b.chapters.map((item) => item.href), ['a.xhtml', 'b.xhtml'])
  assert.deepEqual(progressOf(b), { done: 2, failed: 0, total: 2 })

  // 同一章再蒸一次：覆盖而不是追加
  const again = mergeChapter(b, { href: 'a.xhtml', label: '第一章', status: 'failed', error: '超时' }, ['a.xhtml', 'b.xhtml'])
  assert.equal(again.chapters.length, 2)
  assert.equal(again.chapters[0].status, 'failed')

  const markdown = toMarkdown({
    bookTitle: '某书',
    author: '某人',
    skeleton: { oneLine: '一句话', thesis: '主张', structure: '结构', audience: '谁' },
    chapters: [
      {
        href: 'a.xhtml',
        label: '第一章',
        status: 'done',
        thesis: '这一章讲专注',
        points: [{ claim: '论点', quote: '编的引文', verified: false }],
        terms: [{ term: '深度工作', meaning: '定义' }],
        methods: [{ name: '时间块', when: '需要专注', steps: ['关通知', '定 90 分钟'], check: '没被打断' }],
        quotes: [{ text: '真引文', verified: true }],
      },
    ],
  })
  assert.match(markdown, /# 《某书》蒸馏笔记/)
  assert.match(markdown, /## 可以直接照着做的/)
  assert.match(markdown, /完成判据：没被打断/)
  // 未回源的引文必须在导出里标出来，不能悄悄混进笔记
  assert.match(markdown, /未在原文找到/)
}

async function distillPromptKeepsJsonContract() {
  const prompt = buildChapterPrompt({
    bookTitle: '某书',
    author: '某人',
    chapterLabel: '第一章',
    chapterIndex: 0,
    chapterTotal: 3,
    chapterText: '正文内容',
  })
  assert.match(prompt, /只处理下面这一章/)
  assert.match(prompt, /第 1 \/ 3 章/)
  assert.match(prompt, /逐字复制/)
  assert.match(prompt, /正文内容/)
}

export default async function run() {
  await logRecordsSuccessAndFailure()
  await logDropsOversizedLines()
  await wrapperRecordsBothPaths()
  await statusReportsEveryBrokenCheck()
  await probeReportsFailureShape()
  await askPromptCarriesSurroundingText()
  await distillParsesAndDropsBadItems()
  await distillExtractsJsonFromNoise()
  await distillVerifiesQuotesAgainstSource()
  await distillMergesInSpineOrder()
  await distillPromptKeepsJsonContract()
}
