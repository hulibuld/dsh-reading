#!/usr/bin/env node
/**
 * 生成 golden/vectors.json。
 *
 * 真值从哪来：`expectedCfi` 由 **golden/spec-cfi.mjs**（CFI 规范的独立实现，不 import vendor、
 * 不 import client/src）算出来，`excerpt` 由 jsdom 里真实 Range#toString 取出来。
 * 所以「向量」是独立真值，`cfi.js` 是受测对象，两者算法不同源。
 *
 * 生成完必须再跑 `node golden/check-vectors.mjs`：它把 cfi.js 的真实输出与向量逐条比对，
 * 任何不一致都要人看一眼——不许把「实现跑出来的值」直接写回向量（那样测试就失去意义）。
 *
 * 用法：node golden/make-vectors.mjs [--out golden/vectors.json]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './zip-lite.mjs'
import { loadChapter, indexedChildren, chunkText, resolvePath, parsePath } from './dom-walk.mjs'
import { specCfi } from './spec-cfi.mjs'
import { BOOKS, spineOf } from './make-fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 收出某文档 `<body>` 里所有「文本块槽位」：{ path, length, text, elementPath }。
 *
 * 只收 body 内：head 里的 title 文本虽然也有 CFI 路径，但它不是可标注内容；
 * 文档根下的裸空白文本更麻烦——它的父组为空，`buildRange` 会拼出没有父路径的非法 CFI。
 * 阅读器的标注永远落在正文里，把范围钉在 body 内既是语义正确，也让向量可核对。
 */
export function textSlots(doc) {
  const slots = []
  const rootChildren = indexedChildren(doc.documentElement)
  const bodyIndex = rootChildren.findIndex(
    slot => slot.kind === 'element' && slot.nodes[0].tagName.toLowerCase() === 'body',
  )
  if (bodyIndex < 0) throw new Error('textSlots: 文档里没有 <body>')
  const walk = (element, prefix) => {
    const children = indexedChildren(element)
    children.forEach((slot, index) => {
      if (slot.kind === 'chunk') {
        const text = chunkText(slot)
        if (text.length > 0) {
          slots.push({
            path: [...prefix, index],
            elementPath: prefix,
            length: text.length,
            text,
          })
        }
      } else if (slot.kind === 'element') {
        walk(slot.nodes[0], [...prefix, index])
      }
    })
  }
  walk(doc.documentElement, [])
  return slots.filter(slot => slot.path[0] === bodyIndex && slot.path.length >= 2)
}

const samePath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * 把偏移从代理对中间挪开。
 *
 * CFI 的偏移是 UTF-16 code unit，理论上可以切开一个 emoji（`👨‍👩‍👧` 占 8 个 code unit），
 * 但真实浏览器选区永远落在码点边界上，而切开代理对会让 vectors.json 里出现孤立代理项——
 * JSON 合法、工具链不合法（很多编辑器/脚本会静默替换成 U+FFFD，向量就废了）。
 * 所以生成阶段就吸附：往前挪一位即可，`0` 与末尾保持不动。
 */
const isHigh = code => code >= 0xd800 && code <= 0xdbff
const isLow = code => code >= 0xdc00 && code <= 0xdfff

/** 区间起点：落在配对中间时往后挪一位（不能把低代理项当起点）。 */
const snapStart = (text, offset) => {
  if (offset <= 0 || offset >= text.length) return offset
  return isHigh(text.charCodeAt(offset - 1)) && isLow(text.charCodeAt(offset))
    ? offset + 1
    : offset
}

/** 区间终点：落在配对中间时往前挪一位（不能切开高代理项）。 */
const snapEnd = (text, offset) => {
  if (offset <= 0 || offset >= text.length) return offset
  return isHigh(text.charCodeAt(offset - 1)) && isLow(text.charCodeAt(offset))
    ? offset - 1
    : offset
}

/** 某条路径上最近的可作 parent 的元素路径（用于跨块区间）。 */
const ancestorPath = (path) => path.slice(0, -1)

/**
 * 造区间向量：在同一文本块内选一段，或跨两个文本块选一段。
 * 刻意选「短、可人工肉眼核对」的片段（1–12 个字符），太长就没法 review。
 */
function rangeCase(slot, startOffset, endOffset) {
  return {
    startPath: slot.path,
    startOffset,
    endOffset,
  }
}

/** 在真实 DOM 上按两条路径造 Range，取它的文本（跨节点时自动包含中间元素文字）。 */
function rangeText(doc, start, end) {
  const a = resolvePath(doc.documentElement, start.path, start.offset)
  const b = resolvePath(doc.documentElement, end.path, end.offset)
  const range = doc.createRange()
  range.setStart(a.container, a.offset)
  range.setEnd(b.container, b.offset)
  return range.toString()
}

export function buildVectors() {
  const vectors = []
  let seq = 0
  const push = vector => {
    seq += 1
    vectors.push({ id: vector.id ?? `auto-${String(seq).padStart(3, '0')}`, ...vector })
  }

  for (const [fixture, book] of Object.entries(BOOKS)) {
    const zip = readZip(readFileSync(join(HERE, 'fixtures', `${fixture}.epub`)))
    const spine = spineOf(book)
    book.chapters.forEach((chapter, chapterIndex) => {
      const html = zip.readText(`OEBPS/${chapter.href}`)
      const { document: doc } = loadChapter(html, {
        href: chapter.href,
        spine: chapterIndex,
        idref: chapter.idref,
      })
      const root = doc.documentElement
      const slots = textSlots(doc)
      const spineRef = { index: chapterIndex, idref: chapter.idref }

      // 1) 块内区间：每个文本块按固定窗口表切片，覆盖段首 / 段中 / 段尾三类锚点形态。
      //    窗口表写死（而不是随机）才能让向量文件可 review、可复现。
      for (const slot of slots) {
        const maxLen = slot.length
        const path = `/${slot.path.join('/')}`
        const windows = [
          [0, Math.min(maxLen, 4), 'head'],
          [0, Math.min(maxLen, 8), 'head8'],
          [1, Math.min(maxLen, 5), 'mid'],
          [Math.max(0, maxLen - 4), maxLen, 'tail'],
          [Math.max(0, maxLen - 2), maxLen, 'tail2'],
          [Math.min(1, maxLen), Math.min(maxLen, 3), 'early'],
        ]
        const seen = new Set()
        for (const [rawA, rawB, tag] of windows) {
          const a = snapStart(slot.text, rawA)
          const b = snapEnd(slot.text, rawB)
          if (!(b > a)) continue          // 零宽窗口不要（吸附后可能塌缩）
          const key = `${a}:${b}`
          if (seen.has(key)) continue
          seen.add(key)
          const start = { path: slot.path, offset: a }
          const end = { path: slot.path, offset: b }
          push({
            id: `${fixture}-c${chapterIndex}-${tag}-${slot.path.join('-')}`,
            fixture,
            chapterHref: chapter.href,
            spineIndex: chapterIndex,
            idref: chapter.idref,
            startPath: path,
            startOffset: a,
            endPath: path,
            endOffset: b,
            expectedCfi: specCfi(root, spineRef, start, end),
            excerpt: slot.text.slice(a, b),
            kind: 'normal',
          })
        }
      }

      // 2) 跨块区间：同一元素下**相邻的两个文本块**各取一段。
      //
      //    这是 CFI 最容易错的形态：一旦把两个块的偏移当成连续坐标算，就会从第一块溢出到
      //    第二块却不报错。所以必须覆盖「元素夹文本」「空元素夹文本」「合并块」三种父结构。
      //    按元素分组而不是按扁平列表取相邻，才能保证两条路径共享父路径（合法区间的前提）。
      const emitCross = (parentPath, left, right, tag) => {
        if (!left || !right) return
        const startOffset = snapStart(left.text, Math.max(0, left.length - 1))
        const endOffset = snapEnd(right.text, Math.min(right.length, 2))
        if (!(endOffset > 0)) return
        const start = { path: left.path, offset: startOffset }
        const end = { path: right.path, offset: endOffset }
        // 跨块区间的文本包含中间元素的文字，不能靠左右两段拼接；用真实 Range 取。
        const excerpt = rangeText(doc, start, end)
        if (!excerpt) return
        push({
          id: `${fixture}-c${chapterIndex}-cross-${tag}-${left.path.join('-')}-${right.path.join('-')}`,
          fixture,
          chapterHref: chapter.href,
          spineIndex: chapterIndex,
          idref: chapter.idref,
          startPath: `/${left.path.join('/')}`,
          startOffset,
          endPath: `/${right.path.join('/')}`,
          endOffset,
          expectedCfi: specCfi(root, spineRef, start, end),
          excerpt,
          kind: 'normal',
        })
      }
      // 只在 body 内配对：文档根下的裸空白文本与 head 的 title 都会让公共前缀退到 0，
      // 拼不出合法区间（也本来就不是可标注内容）。
      const walkPairs = (element, path) => {
        const children = indexedChildren(element)
        const chunks = []
        children.forEach((slot, index) => {
          if (slot.kind === 'chunk') {
            const text = chunkText(slot)
            if (text.length > 0) chunks.push({ path: [...path, index], text, length: text.length })
          } else if (slot.kind === 'element') {
            walkPairs(slot.nodes[0], [...path, index])
          }
        })
        for (let i = 0; i + 1 < chunks.length; i++) {
          emitCross(path, chunks[i], chunks[i + 1], 'sib')
        }
        // 跨空的中间元素：第一块 → 最后一块（覆盖 <br/>、<span></span> 这类空元素的跳号）。
        // 只有两块时与上面的相邻对完全重复，跳过。
        if (chunks.length > 2) {
          emitCross(path, chunks[0], chunks[chunks.length - 1], 'span')
        }
      }
      const bodySlot = indexedChildren(doc.documentElement)[
        indexedChildren(doc.documentElement).findIndex(
          slot => slot.kind === 'element' && slot.nodes[0].tagName.toLowerCase() === 'body',
        )
      ]
      if (bodySlot) walkPairs(bodySlot.nodes[0], [4])

      // 3) 点向量：书签用（每章取第一块偏移 0）
      const first = slots[0]
      if (first) {
        const point = { path: first.path, offset: 0 }
        push({
          id: `${fixture}-c${chapterIndex}-point`,
          fixture,
          chapterHref: chapter.href,
          spineIndex: chapterIndex,
          idref: chapter.idref,
          startPath: `/${first.path.join('/')}`,
          startOffset: 0,
          endPath: null,
          endOffset: null,
          expectedCfi: specCfi(root, spineRef, point, null),
          excerpt: '',
          kind: 'normal',
        })
      }
    })
  }

  vectors.push(...buildMalformedVectors())
  // 去重：同一 (fixture, 起终点, 偏移) 只留第一条。多命中的窗口表会产出等价向量，
  // 留着只会让 vectors.json 变长、review 变累，测同一件事。
  const seenKeys = new Set()
  return vectors.filter((vector) => {
    if (vector.kind !== 'normal') return true
    const key = [
      vector.fixture, vector.chapterHref,
      vector.startPath, vector.startOffset, vector.endPath, vector.endOffset,
    ].join('|')
    if (seenKeys.has(key)) return false
    seenKeys.add(key)
    return true
  })
}

/**
 * 畸形向量：覆盖 8 个失败码（docs/03 §三 B1–B8 + docs/05 §5.2 的码表）。
 *
 * 每条都指定 `fixture`/`chapterHref`，因为「畸形」是相对于某一份文档而言的：
 * 索引越界、前缀不符、指纹漂移离开具体章节就没有意义。
 *
 * 语法要点：区间 CFI 是三等分 `parent,start,end`（两个逗号），点 CFI 单路径（零个逗号）。
 * 写成「两个路径一个逗号」不是区间，而是语法错误——这里刻意有几条这样的向量，
 * 它们必须落在 cfi_parse_failed 而不是别的码上。
 */
export function buildMalformedVectors() {
  const out = []
  const push = (id, fixture, chapterHref, spineIndex, idref, cfi, expectCode, options = {}) => {
    out.push({
      id,
      fixture,
      chapterHref,
      spineIndex,
      idref,
      cfi,
      expectCode,
      recordType: options.recordType ?? 'bookmark',
      // 空串表示「这是带文本锚点的记录，但摘录是空」——用来造零宽高亮
      fingerprintOf: options.fingerprintOf ?? null,
      note: options.note ?? '',
      kind: 'malformed',
    })
  }

  const F = 'nested-inline'
  const H = 'text/ch1.xhtml'
  const F2 = 'adjacent-text'
  const H2 = 'text/ch1.xhtml'
  const F3 = 'emoji-cjk-b'
  const H3 = 'text/ch1.xhtml'
  const Z = '/4/2/2/2[z]' // nested-inline ch1 的 <p id="z">abc…</p>

  // ── cfi_parse_failed：L1 语法层
  push('mal-parse-001', F, H, 0, 'ch1', '/6/2[ch1]!/4/2/2/2[z],/1:0,/1:3', 'cfi_parse_failed', {
    note: '缺 epubcfi() 外壳',
  })
  push('mal-parse-002', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2[z],/1:0,/1:3', 'cfi_parse_failed', {
    note: '缺右括号',
  })
  push('mal-parse-003', F, H, 0, 'ch1', 'epubcfi()', 'cfi_parse_failed', { note: '空 CFI' })
  push('mal-parse-004', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2[z]!/1:0)', 'cfi_parse_failed', {
    note: "两个 '!'（spine 间接步只能有 1 个）",
  })
  push('mal-parse-005', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2[z],/1:0,/1:1,/1:3)', 'cfi_parse_failed', {
    note: '三个逗号（四端点）——区间只允许 parent,start,end',
  })
  push('mal-parse-006', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2[z],/1:0)', 'cfi_parse_failed', {
    note: '一个逗号：只有 parent+start，缺 end',
  })
  push('mal-parse-007', F, H, 0, 'ch1', 'epubcfi(/4/2[ch1]!/4/2/2/2[z],/1:0,/1:3)', 'cfi_parse_failed', {
    note: 'spine 前缀不从 /6 起算',
  })
  push('mal-parse-008', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2[z,/1:0,/1:3)', 'cfi_parse_failed', {
    note: '断言方括号没闭合',
  })
  push('mal-parse-009', F, H, 0, 'ch1', 'epubcfi(/4/2/2/2[z],/1:0,/1:3)', 'cfi_parse_failed', {
    note: "没有 '!' 的 partial CFI 不能当完整 CFI 用",
  })
  push('mal-parse-010', F, H, 0, 'ch1', 'epubcfi(/6/3[ch1]!/4/2/2/2[z],/1:0,/1:3)', 'cfi_parse_failed', {
    note: 'spine 前缀用了奇数索引（不是元素步）',
  })
  push('mal-parse-011', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!', 'cfi_parse_failed', {
    note: "只有 '!' 左半段",
  })
  push('mal-parse-012', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/ /1:0,/1:3)', 'cfi_parse_failed', {
    note: '右半段不是路径',
  })
  push('mal-parse-013', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2[z],/1:0,/1:3)x', 'cfi_parse_failed', {
    note: 'epubcfi(...) 后面还有字符',
  })

  // ── cfi_resolve_failed：能过 L1，但按树走不到节点（B3/B8 一类）
  push('mal-resolve-001', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/999:0,/4/999:2,/4/999:3)', 'cfi_resolve_failed', {
    note: 'B3：索引越界到不存在的元素',
  })
  push('mal-resolve-002', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2[z],/9:0,/9:3)', 'cfi_resolve_failed', {
    note: 'B8：字符偏移写在元素步上（index 不是字符数据步）',
  })
  push('mal-resolve-003', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2/1,1/1:0,1/1:2)', 'cfi_resolve_failed', {
    note: '在文本块上继续下降',
  })
  push('mal-resolve-004', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/1:0,/1:2,/1:3)', 'cfi_resolve_failed', {
    note: 'local 首步带字符偏移（字符数据不能当路径起点）',
  })
  push('mal-resolve-005', F2, H2, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2/1:0)', 'cfi_resolve_failed', {
    note: 'adjacent-text 文档里没有这一层（嵌套深度不符）',
  })
  push('mal-resolve-006', F3, H3, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/99,/1:0,/1:2)', 'cfi_resolve_failed', {
    note: 'B3 变体：emoji 本章节里也不存在的索引',
  })
  // docs/03 §四 / docs/01 §3.4.2：中间段 id 断言不提供任何校验能力（vendor 静默忽略），
  // 按契约判 L2 失败进隔离，而不是「解析成功但看起来有校验」。
  push('mal-resolve-007', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2[z]/2,/1:0,/1:3)', 'cfi_resolve_failed', {
    note: '中间段带 id 断言（[z] 不在末段）→ 拒绝，不静默忽略',
  })
  push('mal-resolve-008', F2, H2, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2[p2]/2,/1:0,/1:2)', 'cfi_resolve_failed', {
    note: '中间段带 id 断言（p#p2 后面还有 /2，所以 p2 不在末段）',
  })

  // ── cfi_range_inverted：B2 起止倒置（vendor 会静默折叠成零宽）
  push('mal-inverted-001', F, H, 0, 'ch1', `epubcfi(/6/2[ch1]!${Z},/1:3,/1:1)`, 'cfi_range_inverted', {
    note: 'B2：同节点内 3 > 1',
  })
  push('mal-inverted-002', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2/2/2,/3:1,/1:1)', 'cfi_range_inverted', {
    note: '跨节点倒置：jk 段在 abc 段之后',
  })
  push('mal-inverted-003', F2, H2, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2,/3:3,/1:0)', 'cfi_range_inverted', {
    note: '跨节点倒置：efgh 早于 ab',
  })
  push('mal-inverted-004', F, 'text/ch2.xhtml', 1, 'ch2', 'epubcfi(/6/4[ch2]!/4/2,/4/1:3,/2/1:1)', 'cfi_range_inverted', {
    note: '跨节点倒置：beta 的尾字早于 alpha',
  })

  // ── cfi_cross_document：解析结果落到 #document 或 documentElement
  push('mal-cross-001', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/0)', 'cfi_cross_document', {
    note: 'B6 类：/0 落到 #document',
  })
  push('mal-cross-002', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4,/0,/1:2)', 'cfi_cross_document', {
    note: 'start 落在 html 的 before 虚拟位',
  })
  push('mal-cross-003', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/2,/0,/1:1)', 'cfi_cross_document', {
    note: '落到 head 之前的虚拟块',
  })
  push('mal-cross-004', F3, H3, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4,/0,/1:1)', 'cfi_cross_document', {
    note: 'B6 变体：区间端点是 html 的 before 虚拟位（跨文档/越界的典型形态）',
  })

  // ── cfi_collapsed_highlight：B7 空区间 / 点 CFI 被当高亮存下来
  push('mal-collapsed-001', F, H, 0, 'ch1', `epubcfi(/6/2[ch1]!${Z},/1:3,/1:3)`, 'cfi_collapsed_highlight', {
    note: 'B7：起止相同',
    recordType: 'highlight',
    fingerprintOf: '',
  })
  push('mal-collapsed-002', F, H, 0, 'ch1', `epubcfi(/6/2[ch1]!${Z},/1:2,/1:2)`, 'cfi_collapsed_highlight', {
    note: 'B7 变体：段中零宽（fromRange 折叠态被误存成 highlight）',
    recordType: 'highlight',
    fingerprintOf: '',
  })
  push('mal-collapsed-003', F2, H2, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2,/3:1,/3:1)', 'cfi_collapsed_highlight', {
    note: 'B7：efgh 段零宽',
    recordType: 'note',
    fingerprintOf: '',
  })
  push('mal-collapsed-004', F3, H3, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/4,/1:1,/1:1)', 'cfi_collapsed_highlight', {
    note: 'B7：中文段零宽',
    recordType: 'highlight',
    fingerprintOf: '',
  })

  // ── cfi_offset_out_of_bounds：B5 偏移超长
  push('mal-offset-001', F, H, 0, 'ch1', `epubcfi(/6/2[ch1]!${Z},/1:0,/1:999)`, 'cfi_offset_out_of_bounds', {
    note: 'B5：end 偏移超长',
  })
  push('mal-offset-002', F, H, 0, 'ch1', `epubcfi(/6/2[ch1]!${Z},/1:999,/1:1000)`, 'cfi_offset_out_of_bounds', {
    note: 'B5 变体：start 偏移超长',
  })
  push('mal-offset-003', F3, H3, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/4,/1:0,/1:18)', 'cfi_offset_out_of_bounds', {
    note: '把字节数当偏移用（中文 6 字 / 18 字节）',
  })
  push('mal-offset-004', F2, H2, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/6,/1:0,/1:99)', 'cfi_offset_out_of_bounds', {
    note: 'B5：跨合并文本块后偏移按单节点算',
  })

  // ── cfi_prefix_mismatch：前缀指向的章节不是当前文档
  push('mal-prefix-001', F, H, 0, 'ch1', `epubcfi(/6/4[ch2]!${Z},/1:0,/1:3)`, 'cfi_prefix_mismatch', {
    note: 'URL 声明 spine=0/ch1，CFI 前缀却是 spine=1/ch2',
  })
  push('mal-prefix-002', F, 'text/ch2.xhtml', 1, 'ch2', 'epubcfi(/6/2[ch1]!/4/2,/1:0,/1:2)', 'cfi_prefix_mismatch', {
    note: '反方向：当前 ch2，CFI 前缀指 ch1',
  })
  push('mal-prefix-003', F, H, 0, 'ch1', `epubcfi(/6/2[wrong-idref]!${Z},/1:0,/1:3)`, 'cfi_prefix_mismatch', {
    note: '序号对但 idref 不符',
  })
  push('mal-prefix-004', F3, 'text/ch2.xhtml', 1, 'ch2', 'epubcfi(/6/2[ch1]!/4/4,/1:0,/1:2)', 'cfi_prefix_mismatch', {
    note: 'emoji 本的第二章文档 vs 第一章前缀',
  })

  // ── fingerprint_drift：位置合法，但内容已经不是记录里那一段
  push('mal-drift-001', F, H, 0, 'ch1', `epubcfi(/6/2[ch1]!${Z},/1:0,/1:3)`, 'fingerprint_drift', {
    note: '区间解析到 abc，指纹却按 "xyz" 算',
    recordType: 'highlight',
    fingerprintOf: 'xyz',
  })
  push('mal-drift-002', F, H, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/4/2/2,/1:0,/1:1)', 'fingerprint_drift', {
    note: '区间解析到 c，指纹按 "d" 算（跨元素后偏移错位）',
    recordType: 'highlight',
    fingerprintOf: 'd',
  })
  push('mal-drift-003', F2, H2, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/2,/3:0,/3:4)', 'fingerprint_drift', {
    note: '区间是 efgh，指纹按 "efg"（长度不符）',
    recordType: 'note',
    fingerprintOf: 'efg',
  })
  push('mal-drift-004', F3, H3, 0, 'ch1', 'epubcfi(/6/2[ch1]!/4/4,/1:0,/1:2)', 'fingerprint_drift', {
    note: '字符偏移曾按字节算过的记录：文本对不上',
    recordType: 'highlight',
    fingerprintOf: '\u1eb9\u0300',
  })

  return out
}

const main = () => {
  const outIndex = process.argv.indexOf('--out')
  const outPath = outIndex > 0 ? process.argv[outIndex + 1] : join(HERE, 'vectors.json')
  const vectors = buildVectors()
  const normal = vectors.filter(v => v.kind === 'normal').length
  const malformed = vectors.filter(v => v.kind === 'malformed').length
  const codes = new Set(vectors.filter(v => v.kind === 'malformed').map(v => v.expectCode))
  const payload = {
    version: 1,
    generatedBy: 'golden/make-vectors.mjs',
    note: 'expectedCfi 由 golden/spec-cfi.mjs（规范独立实现）算出，excerpt 由 jsdom 真实 Range 取出；'
      + 'cfi.js 不得参与生成。',
    stats: { total: vectors.length, normal, malformed, codes: [...codes].sort() },
    vectors,
  }
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`WROTE ${outPath}`)
  console.log(`  total=${vectors.length} normal=${normal} malformed=${malformed}`)
  console.log(`  codes=${[...codes].sort().join(', ')}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
