#!/usr/bin/env node
/**
 * golden 校验：把 client/src/cfi.js 放到 200+ 条向量上跑，逐条比对。
 *
 * 判据（每条向量都要过）：
 *   normal     : 按 startPath/startOffset → endPath/endOffset 在 jsdom 里手工造 Range
 *                → fromRange 必须精确等于 expectedCfi
 *                → toRange(expectedCfi) 必须回到同一个 Range，且 textOfRange 等于 excerpt
 *   malformed  : validate() 必须返回 { ok:false, code: expectCode }，且 level 与码匹配；
 *                toRange 必须抛同名 code 的 CfiError（不许「返回 null 兜底」）
 *
 * 另外每条畸形向量都跑一遍**正向对照**：把 CFI 修好之后 validate 必须 ok，
 * 否则「判畸成功」可能只是因为这条文档根本不支持该路径，测不出真问题。
 *
 * 用法：node golden/run.mjs [--filter 子串] [--verbose]
 * 输出：PASS n/n 并退出码 0；任一失败打印明细并退出码 1。
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { readZip } from './zip-lite.mjs'
import { loadChapter, parsePath, resolvePath, ensureNodeFilter, indexedChildren } from './dom-walk.mjs'
import { BOOKS, spineOf, buildAll } from './make-fixtures.mjs'
import {
  fromRange, toRange, validate, textOfRange, collapseLocal,
  makeFilter, spineIndexFromCfi, chapterHrefFromCfi, joinCfi, splitCfi,
} from '../client/src/cfi.js'
import { fingerprint } from '../client/src/contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const FIXTURE_DIR = join(HERE, 'fixtures')

const args = process.argv.slice(2)
const filterArg = (() => {
  const at = args.indexOf('--filter')
  return at >= 0 ? args[at + 1] : ''
})()
const verbose = args.includes('--verbose')

/**
 * fixture 是**可重建产物**（.gitignore 里），干净 clone 里不存在。
 * 所以 run.mjs 必须在开跑前自己补齐——否则 `npm run golden` 在 CI/新机器上第一次
 * 就是「缺文件」的红，而那跟锚点正确性无关。
 */
function ensureFixtures() {
  const expected = Object.keys(BOOKS)
  const present = existsSync(FIXTURE_DIR)
    ? new Set(readdirSync(FIXTURE_DIR).filter(name => name.endsWith('.epub')).map(n => n.replace(/\.epub$/, '')))
    : new Set()
  const missing = expected.filter(name => !present.has(name))
  if (missing.length === 0) return
  console.log(`生成缺失的 fixture（${missing.length}/${expected.length}）：${missing.join(', ')}`)
  mkdirSync(FIXTURE_DIR, { recursive: true })
  for (const [name, { epub, spine }] of buildAll()) {
    if (!missing.includes(name)) continue
    writeFileSync(join(FIXTURE_DIR, `${name}.epub`), epub)
    writeFileSync(join(FIXTURE_DIR, `${name}.spine.json`), `${JSON.stringify({ fixture: name, spine }, null, 2)}\n`)
  }
}

const problems = []
const fail = (vector, message, extra) => {
  problems.push({ id: vector?.id ?? '<no-id>', message, extra })
}

/* ------------------------------------------------------- 夹具：按需装载文档 */

const docCache = new Map()

/** 打开某本 fixture 的某一章，返回真实 jsdom 文档（带 URL 身份）。 */
function chapterDoc(fixture, href) {
  const key = `${fixture}::${href}`
  if (docCache.has(key)) return docCache.get(key)
  const epubPath = join(FIXTURE_DIR, `${fixture}.epub`)
  if (!existsSync(epubPath)) {
    throw new Error(`缺 fixture ${epubPath}，先跑 node golden/make-fixtures.mjs`)
  }
  const book = BOOKS[fixture]
  if (!book) throw new Error(`未知 fixture ${fixture}`)
  const chapterIndex = book.chapters.findIndex(chapter => chapter.href === href)
  if (chapterIndex < 0) throw new Error(`${fixture} 里没有 ${href} 这一章`)
  const zip = readZip(readFileSync(epubPath))
  const html = zip.readText(`OEBPS/${href}`)
  const loaded = loadChapter(html, {
    href,
    spine: chapterIndex,
    idref: book.chapters[chapterIndex].idref,
  })
  ensureNodeFilter(loaded.window)
  const entry = { ...loaded, chapterIndex, chapter: book.chapters[chapterIndex] }
  docCache.set(key, entry)
  return entry
}

/* ------------------------------------------------------------ 向量类型校验 */

const VALID_CODES = new Set([
  'cfi_parse_failed', 'cfi_resolve_failed', 'cfi_range_inverted', 'cfi_cross_document',
  'cfi_collapsed_highlight', 'cfi_offset_out_of_bounds', 'cfi_prefix_mismatch', 'fingerprint_drift',
])

function checkVectorShape(vector) {
  if (!vector.id) return 'vector 缺 id'
  if (vector.kind !== 'normal' && vector.kind !== 'malformed') return `kind 非法：${vector.kind}`
  if (!vector.fixture) return '缺 fixture'
  if (!vector.chapterHref) return '缺 chapterHref'
  if (!Number.isInteger(vector.spineIndex)) return '缺 spineIndex'
  if (vector.kind === 'normal') {
    if (!vector.expectedCfi) return 'normal 向量缺 expectedCfi'
    if (typeof vector.startPath !== 'string') return 'normal 向量缺 startPath'
  } else {
    if (!vector.cfi) return 'malformed 向量缺 cfi'
    if (!VALID_CODES.has(vector.expectCode)) return `expectCode 非法：${vector.expectCode}`
  }
  return null
}

/* --------------------------------------------------------------- normal 向量 */

function runNormal(vector) {
  const { window, document: doc, chapterIndex, chapter } = chapterDoc(vector.fixture, vector.chapterHref)
  if (chapterIndex !== vector.spineIndex) {
    fail(vector, `向量 spineIndex=${vector.spineIndex}，但 fixture 里该章是 ${chapterIndex}`)
    return
  }
  if (chapter.idref !== vector.idref) {
    fail(vector, `向量 idref=${vector.idref}，但 fixture 里是 ${chapter.idref}`)
    return
  }

  const startSteps = parsePath(vector.startPath)
  const start = resolvePath(doc.documentElement, startSteps, vector.startOffset)
  const range = doc.createRange()
  range.setStart(start.container, start.offset)

  if (vector.endPath == null) {
    // 点向量（书签）：Range 必须折叠
    range.collapse(true)
    const spine = { index: chapterIndex, idref: chapter.idref }
    const produced = fromRange(window, range, spine)
    if (produced !== vector.expectedCfi) {
      fail(vector, '点 CFI 与 expectedCfi 不符', { produced, expected: vector.expectedCfi })
      return
    }
    const back = toRange(window, doc, produced)
    if (!back.collapsed) {
      fail(vector, '点 CFI 解析回来不是折叠态')
      return
    }
    if (back.startContainer !== start.container || back.startOffset !== start.offset) {
      fail(vector, '点 CFI 往返后位置变了')
    }
    return
  }

  const endSteps = parsePath(vector.endPath)
  const end = resolvePath(doc.documentElement, endSteps, vector.endOffset)
  range.setEnd(end.container, end.offset)

  const spine = { index: chapterIndex, idref: chapter.idref }
  const produced = fromRange(window, range, spine)
  if (produced !== vector.expectedCfi) {
    fail(vector, 'fromRange 与 expectedCfi 不符', { produced, expected: vector.expectedCfi })
    return
  }

  let back
  try {
    back = toRange(window, doc, vector.expectedCfi)
  } catch (error) {
    fail(vector, `toRange 抛错：${error.code ?? error.name}: ${error.message}`)
    return
  }
  if (back.collapsed) {
    fail(vector, 'toRange 返回折叠 Range（区间向量不该折叠）')
    return
  }
  if (back.startContainer !== start.container || back.startOffset !== start.offset
    || back.endContainer !== end.container || back.endOffset !== end.offset) {
    fail(vector, 'toRange 往返后的端点与手工构造的 Range 不一致')
    return
  }
  const text = textOfRange(back)
  if (text !== vector.excerpt) {
    fail(vector, 'excerpt 不符', { text, excerpt: vector.excerpt })
    return
  }

  // 三层校验：正常向量必须 ok（带指纹时走 L3）
  if (vector.excerpt) {
    const verdict = validate(window, doc, produced, fingerprint(vector.excerpt))
    if (!verdict.ok) {
      fail(vector, `validate 对正常向量判失败：${verdict.code} ${verdict.detail ?? ''}`)
      return
    }
    if (verdict.level !== 'L3') {
      fail(vector, `带指纹的记录应走到 L3，实际 level=${verdict.level}`)
      return
    }
  }

  // 工具函数一致性：前缀反推 + 拆分 + 重组
  if (spineIndexFromCfi(produced) !== chapterIndex) {
    fail(vector, `spineIndexFromCfi 推导出 ${spineIndexFromCfi(produced)}，应为 ${chapterIndex}`)
    return
  }
  if (chapterHrefFromCfi(produced) !== chapter.idref) {
    fail(vector, `chapterHrefFromCfi 应为 ${chapter.idref}，实际 ${chapterHrefFromCfi(produced)}`)
    return
  }
  const { prefix, local } = splitCfi(produced)
  if (joinCfi(prefix, local) !== produced) {
    fail(vector, 'splitCfi → joinCfi 不能还原原 CFI')
    return
  }

  // cfiStart / cfiEnd 的来源：折叠到两端，且各自必须能解析回对应端点位置
  const startLocal = collapseLocal(produced, false)
  const endLocal = collapseLocal(produced, true)
  if (!/^\/[0-9]/.test(startLocal) || startLocal.includes('!') || startLocal.includes(',')) {
    fail(vector, `collapseLocal(start) 不是合法 partial：${startLocal}`)
    return
  }
  if (!/^\/[0-9]/.test(endLocal) || endLocal.includes('!') || endLocal.includes(',')) {
    fail(vector, `collapseLocal(end) 不是合法 partial：${endLocal}`)
    return
  }
}

/* ------------------------------------------------------------ malformed 向量 */

function runMalformed(vector) {
  const { window, document: doc, chapterIndex } = chapterDoc(vector.fixture, vector.chapterHref)
  if (vector.spineIndex !== chapterIndex) {
    fail(vector, `畸形向量的 spineIndex=${vector.spineIndex} 与文档 ${chapterIndex} 不符`)
    return
  }

  const expected = vector.fingerprintOf == null ? null : fingerprint(vector.fingerprintOf)
  const verdict = validate(window, doc, vector.cfi, expected)
  if (verdict.ok) {
    fail(vector, `validate 判为通过，期望 ${vector.expectCode}`)
    return
  }
  if (verdict.code !== vector.expectCode) {
    fail(vector, `失败码不符：实际 ${verdict.code}，期望 ${vector.expectCode}`, { detail: verdict.detail })
    return
  }
  const levelOf = {
    cfi_parse_failed: 'L1',
    fingerprint_drift: 'L3',
  }[verdict.code] ?? 'L2'
  if (verdict.level !== levelOf) {
    fail(vector, `失败层级不符：${verdict.code} 应在 ${levelOf}，实际 ${verdict.level}`)
    return
  }

  // toRange 也必须抛同名 code。
  // 两个例外，都是「位置本身合法、错在记录语义」的码：
  //   fingerprint_drift     — L3 内容层，CFI 指的位置是对的，只是文字换了
  //   cfi_collapsed_highlight — 记录类型是 highlight 却零宽；书签拿同一个 CFI 完全合法
  const positionLevelCodes = new Set(['fingerprint_drift', 'cfi_collapsed_highlight'])
  if (!positionLevelCodes.has(verdict.code)) {
    let thrown = null
    try {
      toRange(window, doc, vector.cfi)
    } catch (error) {
      thrown = error
    }
    if (!thrown) {
      fail(vector, `toRange 没抛错（validate 说 ${verdict.code}）`)
      return
    }
    if (thrown.name !== 'CfiError') {
      fail(vector, `toRange 抛的不是 CfiError，而是 ${thrown.name}: ${thrown.message}`)
      return
    }
    if (thrown.code !== vector.expectCode) {
      fail(vector, `toRange 抛的 code=${thrown.code}，期望 ${vector.expectCode}`)
      return
    }
  }

  // 正向对照：把同一章里一条已知合法 CFI 交给 validate，必须 ok。
  // 否则「判畸成功」可能只是因为这条文档根本不支持任何路径。
  const control = controlCfi(vector.fixture, vector.chapterHref, window, doc)
  const controlVerdict = validate(window, doc, control)
  if (!controlVerdict.ok) {
    fail(vector, `正向对照失败：同章合法 CFI 也判成 ${controlVerdict.code}，说明这条文档根本解析不了`)
  }
}

const controlCache = new Map()

/** 造一条该章必然合法的 CFI（取第一个长度 >= 2 的文本块前两个字）。 */
function controlCfi(fixture, href, window, doc) {
  const key = `${fixture}::${href}`
  if (controlCache.has(key)) return controlCache.get(key)
  const { chapterIndex, chapter } = chapterDoc(fixture, href)
  const findFirst = (element, path) => {
    const children = indexedChildren(element)
    for (let i = 0; i < children.length; i++) {
      const slot = children[i]
      if (slot.kind === 'chunk') {
        const text = slot.nodes.map(n => n.nodeValue).join('')
        if (text.length >= 2) return { path: [...path, i], nodes: slot.nodes }
      } else if (slot.kind === 'element') {
        const found = findFirst(slot.nodes[0], [...path, i])
        if (found) return found
      }
    }
    return null
  }
  const hit = findFirst(doc.documentElement, [])
  if (!hit) throw new Error(`${fixture}/${href} 里找不到长度 >= 2 的文本块，无法构造对照 CFI`)
  const range = doc.createRange()
  range.setStart(hit.nodes[0], 0)
  range.setEnd(hit.nodes[0], Math.min(2, hit.nodes[0].nodeValue.length))
  const cfi = fromRange(window, range, { index: chapterIndex, idref: chapter.idref })
  controlCache.set(key, cfi)
  return cfi
}

/* ---------------------------------------------------------- 覆盖度自检（硬性） */

function assertCoverage(vectors) {
  const malformed = vectors.filter(v => v.kind === 'malformed')
  if (vectors.length < 200) {
    fail(null, `向量总数 ${vectors.length} < 200（docs/05 §6 的硬要求）`)
  }
  if (malformed.length < 30) {
    fail(null, `畸形向量 ${malformed.length} < 30（docs/05 §6 的硬要求）`)
  }
  const covered = new Set(malformed.map(v => v.expectCode))
  const missing = [...VALID_CODES].filter(code => !covered.has(code))
  if (missing.length > 0) {
    fail(null, `畸形向量没有覆盖这些失败码：${missing.join(', ')}`)
  }
  // 8 本 fixture 都要有 normal 向量
  for (const fixture of Object.keys(BOOKS)) {
    if (!vectors.some(v => v.kind === 'normal' && v.fixture === fixture)) {
      fail(null, `fixture ${fixture} 没有任何 normal 向量`)
    }
  }
}

/* --------------------------------------------------------------- main */

function main() {
  ensureFixtures()
  const vectorsPath = join(HERE, 'vectors.json')
  if (!existsSync(vectorsPath)) {
    console.error('缺 golden/vectors.json，先跑 node golden/make-vectors.mjs')
    process.exitCode = 1
    return
  }
  const payload = JSON.parse(readFileSync(vectorsPath, 'utf8'))
  if (!payload?.vectors || !Array.isArray(payload.vectors)) {
    console.error('vectors.json 结构不对：缺 vectors 数组')
    process.exitCode = 1
    return
  }
  let vectors = payload.vectors
  if (filterArg) vectors = vectors.filter(v => String(v.id ?? '').includes(filterArg))

  assertCoverage(payload.vectors)

  const started = Date.now()
  let passed = 0
  let index = 0
  for (const vector of vectors) {
    index += 1
    const shapeError = checkVectorShape(vector)
    if (shapeError) {
      fail(vector, `结构问题：${shapeError}`)
      continue
    }
    if (filterArg && !String(vector.id).includes(filterArg) && !vector.fixture.includes(filterArg)) {
      // --filter 只影响打印，不过滤执行；这里保留全量执行
    }
    const before = problems.length
    try {
      if (vector.kind === 'normal') runNormal(vector)
      else runMalformed(vector)
    } catch (error) {
      fail(vector, `运行异常：${error?.stack ?? error}`)
    }
    if (problems.length === before) passed += 1
    else if (verbose) {
      for (const problem of problems.slice(before)) {
        console.log(`    [${problem.id}] ${problem.message}`)
        if (problem.extra) console.log(`        ${JSON.stringify(problem.extra)}`)
      }
    }
    if (index % 500 === 0) console.log(`  ...${index} 条`)
  }
  const total = vectors.length
  const ms = Date.now() - started
  const digest = createHash('sha256').update(readFileSync(vectorsPath)).digest('hex').slice(0, 12)

  console.log('')
  if (problems.length === 0) {
    console.log(`PASS ${passed}/${total}`)
    console.log(`     vectors.json sha256:${digest}… · ${ms}ms · ${Object.keys(BOOKS).length} fixtures`)
    process.exitCode = 0
    return
  }

  console.log(`FAIL ${passed}/${total}（${problems.length} 个问题）`)
  for (const problem of problems.slice(0, 40)) {
    console.log(`  [${problem.id}] ${problem.message}`)
    if (problem.extra) console.log(`      ${JSON.stringify(problem.extra)}`)
  }
  if (problems.length > 40) console.log(`  ……另有 ${problems.length - 40} 个问题未打印（--verbose 看全部）`)
  process.exitCode = 1
}

main()
