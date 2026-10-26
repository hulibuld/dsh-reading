#!/usr/bin/env node
/**
 * dom_immutability_test.mjs —— M2 的灵魂验收：**加 50 条标注，正文 DOM 一个字节都不许变**。
 *
 * 为什么这一条比「高亮画得对不对」还重要：
 *   CFI 的字符偏移是相对**结构**算的。`<p>abcdef</p>` 与 `<p>abc<i></i>def</p>`
 *   文本内容完全一样，但 `<p>` 的字符数据被切成了两段，偏移基准整体位移。
 *   于是「昨天划的线」今天就落到别的句子上 —— 而且是静默的，没人会报错。
 *   docs/04 铁律 4 把它列为不可商量的一条，本文件就是它的自动化证明。
 *
 * 怎么证：同一份章节文档，在「没有任何标注」与「50 条标注全部参与覆盖层计算」两个状态下，
 *   各算一次结构指纹（标签名 + 层级序列 + 每个元素自己的属性名集合），必须逐字节相等。
 *
 * 为什么不用 jsdom 的 layout：jsdom 不做排版，`getClientRects()` 恒为 0 尺寸。
 *   所以本测试注入一个**只读的**几何桩：给 Range 补一个 `getClientRects`，
 *   返回按文档序递增的假矩形。这个桩只回答「你在哪」，不写任何 DOM；
 *   覆盖层拿到的坐标因此是确定的、可断言的。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'client.js')

/**
 * 一章典型的中文 EPUB 正文。
 *
 * 刻意混合几种会让「包裹高亮」出事的结构：
 *   · 嵌套内联（`<em>` / `<i>`）—— 包裹会改变字符数据的分段；
 *   · 相邻文本节点（「，」被注释隔开）—— 偏移基准最脆的地方；
 *   · 空元素（`<br>`、`<i></i>`）—— 包裹时最容易被顺手清掉；
 *   · ruby 注音 —— 文本顺序与视觉顺序不一致；
 *   · emoji 与 CJK 扩展 B —— 代理对，UTF-16 长度 ≠ 字符数。
 */
const CHAPTER_XHTML = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head>
  <title>第一章</title>
  <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
</head>
<body>
  <section id="ch1">
    <h1 id="h1">第一章　起风</h1>
    <p id="p1">他抬头看了看天，云压得很低。</p>
    <p id="p2">街上没人，只有一只<em>瘦猫</em>贴着墙根走。</p>
    <p id="p3">「要下雨了。」他说，<i></i>声音很轻。</p>
    <p id="p4">远处<br/>传来钟声，一共三下。</p>
    <p id="p5">她想起十年前的那个下午<ruby>京都<rt>きょうと</rt></ruby>也在下雨。</p>
    <p id="p6">书上写着：<span class="q">「风起于青萍之末。」</span></p>
    <p id="p7">有人在门廊下等雨停，手里握着一本旧书📖，书页已经发黄。</p>
    <p id="p8">𠀋　——这是一个 CJK 扩展 B 的字，占两个 UTF-16 单元。</p>
    <blockquote id="q1"><p id="p9">雨终于落了下来。</p></blockquote>
    <p id="p10">他把外套脱下来，盖在她肩上。</p>
  </section>
</body>
</html>`

/**
 * 结构指纹：标签名 + 层级 + 属性名（不含属性值）。
 *
 * 只取属性**名**不取值：注入样式时会改 `style` 属性的值（翻页位移），
 * 那属于覆盖层自己的事；但正文里凭空多出一个 `class` 或 `data-*` 就是事故。
 *
 * 不含文本内容：文本不该变，但文本变化会由 CFI 偏移测试抓；
 * 这里盯的是「结构有没有被增删改」。
 *
 * @param {Document} doc
 * @returns {string}
 */
function structureFingerprint(doc) {
  const lines = []

  const walk = (node, depth, path) => {
    if (node.nodeType === 1) {
      const attrs = Array.from(node.attributes || [])
        .map((attr) => attr.name)
        .sort()
        .join(',')
      lines.push(`${depth}|${path}|${node.tagName.toLowerCase()}|${attrs}`)
      let index = 0
      for (const child of Array.from(node.childNodes)) {
        walk(child, depth + 1, `${path}.${index}`)
        index += 1
      }
      return
    }
    if (node.nodeType === 3) {
      // 文本节点也算结构的一部分：文本被拆成两段是「包裹高亮」最典型的痕迹
      lines.push(`${depth}|${path}|#text|${node.data.length}`)
      return
    }
    if (node.nodeType === 8) {
      lines.push(`${depth}|${path}|#comment|${node.data.length}`)
      return
    }
    if (node.nodeType === 4) {
      lines.push(`${depth}|${path}|#cdata|${node.data.length}`)
    }
  }

  walk(doc.documentElement, 0, 'r')
  return lines.join('\n')
}

/** 载入 client.js 拿到导出面。复用与 client_build_test 相同的最小 hooks。 */
function loadBundle() {
  const hookContext = { hooks: null, index: 0, dirty: false, pending: [] }

  const need = () => {
    if (!hookContext.hooks) throw new Error('hook 在组件函数之外被调用')
    const index = hookContext.index
    hookContext.index += 1
    return { hooks: hookContext.hooks, index }
  }
  const depsChanged = (prev, deps) => prev === undefined
    || prev.deps === undefined
    || deps === undefined
    || deps.length !== prev.deps.length
    || deps.some((d, i) => !Object.is(d, prev.deps[i]))

  const React = {
    createElement: (type, props, ...children) => ({
      $$kind: 'element',
      type,
      props: {
        ...(props || {}),
        children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
      },
    }),
    Fragment: 'fragment',
    useState: (initial) => {
      const { hooks, index } = need()
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const cell = hooks[index]
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (!Object.is(value, cell.value)) {
          cell.value = value
          hookContext.dirty = true
        }
      }]
    },
    useEffect: (fn, deps) => {
      const { hooks, index } = need()
      const prev = hooks[index]
      if (depsChanged(prev, deps)) {
        hooks[index] = { deps }
        hookContext.pending.push(fn)
      }
    },
    useRef: (initial) => {
      const { hooks, index } = need()
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo: (fn, deps) => {
      const { hooks, index } = need()
      const prev = hooks[index]
      if (depsChanged(prev, deps)) hooks[index] = { value: fn(), deps }
      return hooks[index].value
    },
  }
  React.useLayoutEffect = React.useEffect
  React.useCallback = (fn, deps) => React.useMemo(() => fn, deps)

  const captured = []
  const window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
  const source = readFileSync(CLIENT, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', source)(window, globalThis)
  assert.equal(captured.length, 1, '产物没有调用 __ModuleLoader__.load')

  const bundle = captured[0].factory((name) => {
    if (name === 'react') return React
    throw new Error(`产物 require 了 ${name}`)
  })
  assert.equal(typeof bundle.computeRects, 'function', '产物没有导出 computeRects（覆盖层几何纯函数）')
  return bundle
}

/**
 * 给 Range 补一个只读的几何桩。
 *
 * jsdom 不做排版，`getClientRects()` 返回空列表，覆盖层就画不出任何东西，
 * 这个测试也就退化成「调了没抛」。桩里按点的位置给一个确定的矩形，
 * 并且**只读** —— 它不写 DOM，所以「算 50 条矩形」这件事本身不可能改动正文。
 *
 * @param {Window} win
 */
function stubGeometry(win) {
  const RangeProto = win.Range.prototype
  if (typeof RangeProto.getClientRects !== 'function' || RangeProto.getClientRects()?.length === undefined) {
    // 继续往下装桩；jsdom 一定支持 Range，这里只是防空
  }
  Object.defineProperty(RangeProto, 'getClientRects', {
    configurable: true,
    writable: true,
    value: function getClientRects() {
      // 用起止偏移造一个稳定但各不相同的矩形：同一条 CFI 每次算出的位置必须一样
      const start = this.startOffset || 0
      const end = this.endOffset || start
      const width = Math.max(8, (end - start) * 7)
      const column = Math.floor(start / 120)
      const rect = {
        left: 20 + column * 500,
        top: 30 + (start % 120) * 1.6,
        width,
        height: 20,
        right: 20 + column * 500 + width,
        bottom: 30 + (start % 120) * 1.6 + 20,
        x: 20 + column * 500,
        y: 30 + (start % 120) * 1.6,
      }
      const list = [rect]
      list.item = (i) => list[i] ?? null
      return list
    },
  })
  Object.defineProperty(RangeProto, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: function getBoundingClientRect() {
      const rects = this.getClientRects()
      return rects[0]
    },
  })
}

/** 造一条符合契约的高亮记录（字段齐、CFI 是区间）。 */
function makeRecord(index, cfi) {
  const local = cfi.slice(cfi.indexOf('!') + 1, -1)
  const comma = local.indexOf(',')
  return {
    schema: 'dsh-reading/1',
    id: `01JBX${String(index).padStart(21, '0')}`,
    type: 'highlight',
    cfi,
    cfiStart: comma >= 0 ? local.slice(0, comma) : local,
    cfiEnd: comma >= 0 ? local.slice(comma + 1) : local,
    chapterHref: 'text/ch1.xhtml',
    textExcerpt: '他抬头看了看天',
    textFingerprint: { head: '他抬头看了看天', tail: '看了看天', len: 7, hash: '0'.repeat(64) },
    color: ['yellow', 'green', 'blue', 'pink', 'purple'][index % 5],
    note: '',
    anchorStatus: 'ok',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    deviceId: 'mbp-7f3a',
    deleted: false,
  }
}

export default async function run() {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><div id="layer"></div></body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true },
  )
  const win = dom.window
  const doc = new win.DOMParser().parseFromString(CHAPTER_XHTML, 'application/xhtml+xml')

  assert.ok(doc.documentElement, 'XHTML 解析失败（这本该不会发生）')

  // 找一个可用的窗口对象：cfi.js 需要 NodeFilter 与 document
  globalThis.NodeFilter = win.NodeFilter
  stubGeometry(win)

  const bundle = loadBundle()
  const computeRects = bundle.computeRects

  // ── 基线：没有任何标注时的结构指纹 ──────────────────────────────
  const before = structureFingerprint(doc)
  assert.ok(before.length > 0, '结构指纹是空的，取指纹的实现有问题')

  // ── 造 50 条真实锚点 ────────────────────────────────────────────
  // cfi.js 在 client/src 里，浏览器半不能 import 它，但测试是 Node，
  // 直接动态 import 源文件即可（测的就是同一份实现）。
  const cfiModule = await import(new URL('../client/src/cfi.js', import.meta.url).href)

  const paragraphs = Array.from(doc.querySelectorAll('p')).filter((p) => {
    const text = p.textContent || ''
    return text.length >= 4
  })
  assert.ok(paragraphs.length >= 5, `正文段落太少（${paragraphs.length}），测试样本不够`)

  const records = []
  for (let i = 0; i < 50; i += 1) {
    const target = paragraphs[i % paragraphs.length]
    // 找到这一段里第一个足够长的文本节点
    let textNode = null
    for (const child of Array.from(target.childNodes)) {
      if (child.nodeType === 3 && (child.data || '').length >= 4) {
        textNode = child
        break
      }
    }
    if (!textNode) {
      for (const inner of Array.from(target.querySelectorAll('*'))) {
        for (const child of Array.from(inner.childNodes)) {
          if (child.nodeType === 3 && (child.data || '').length >= 4) {
            textNode = child
            break
          }
        }
        if (textNode) break
      }
    }
    assert.ok(textNode, `第 ${i} 条找不到可锚定的文本节点`)

    const range = doc.createRange()
    const start = Math.min(i % 3, Math.max(0, textNode.data.length - 4))
    const end = Math.min(start + 4, textNode.data.length)
    range.setStart(textNode, start)
    range.setEnd(textNode, end)

    const cfi = cfiModule.fromRange(win, range, { index: 0, idref: 'ch1' })
    records.push(makeRecord(i, cfi))
  }
  assert.equal(records.length, 50, '必须造满 50 条锚点（验收线就是 50）')

  // ── 关键动作：让覆盖层算 50 条矩形 ──────────────────────────────
  const layerBox = { left: 0, top: 0 }
  const frameBox = { left: 12, top: 40 }

  const first = computeRects({
    frameDoc: doc,
    frameWin: win,
    records,
    layerBox,
    frameBox,
    pageOffsetPx: 0,
  })

  assert.ok(first.boxes.length >= 50, `50 条标注只算出 ${first.boxes.length} 个矩形`)
  assert.equal(first.broken.length, 0, `有 ${first.broken.length} 条锚点解析失败：${JSON.stringify(first.broken[0]?.code)}`)

  // 翻页、再来一次：位置应该整体左移，但正文结构仍然不许动
  const second = computeRects({
    frameDoc: doc,
    frameWin: win,
    records,
    layerBox,
    frameBox,
    pageOffsetPx: 548,
  })
  assert.ok(second.boxes.length >= 50, '翻页后矩形数量不该变少')

  // **坐标换算不许再减一次翻页位移。**
  //
  // 这是 docs/06 审计抓出的 high 缺陷的回归断言。`range.getClientRects()` 返回的是
  // **视觉**矩形，翻页用的 `transform: translateX(-offset)` 已经算进 rect.left 里了；
  // 若 computeRects 再减一次 pageOffsetPx，就是双重扣减 —— 表现为「第 2 页起划线
  // 整体左移一页」，不报错、不崩溃，肉眼要盯很久才发现。
  //
  // 测试里的 rect 是 stub 出来的常量（不随 pageOffsetPx 变），所以正确的实现下
  // 两次结果必须**逐字段相同**。老实现会差出整整 548px，一断言就露馅。
  assert.equal(second.boxes.length, first.boxes.length, '翻页后矩形数量变了')
  for (let i = 0; i < first.boxes.length; i += 1) {
    assert.equal(
      second.boxes[i].left,
      first.boxes[i].left,
      `第 ${i} 个矩形在翻页后横向位置变了（${first.boxes[i].left} → ${second.boxes[i].left}）：`
      + '说明 computeRects 把 getClientRects 已含的 transform 又减了一次',
    )
    assert.equal(second.boxes[i].top, first.boxes[i].top, `第 ${i} 个矩形在翻页后纵向位置变了`)
  }

  // **CFI → Range 必须缓存。**
  //
  // 这是 t11 复审 F1 的回归：不缓存时 `computeRects` 每画一条都要重新 parse CFI、
  // 走一遍结构预检、再让 vendor 从 documentElement 逐层下降，实测 200 条 ≈ 730ms、
  // 翻页会整层重绘再算一遍。docs/03 §七要求单章 >100 条标注必须缓存。
  //
  // 判据用「暖缓存的那一轮显著快于冷启动那一轮」：冷启动要解析 50 次 CFI，
  // 暖缓存只重量矩形。这里留了很宽的余量（只要快过 60% 就算过），
  // 因为 CI 机器的时钟抖动比这个差距大得多；命中率是 100% 还是 0% 会差出十倍以上。
  {
    const onePass = (pageOffsetPx) => {
      const started = process.hrtime.bigint()
      const result = computeRects({
        frameDoc: doc, frameWin: win, records, layerBox, frameBox, pageOffsetPx,
      })
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6
      return { result, elapsed }
    }

    const cold = onePass(0)
    const warm = onePass(1096) // 再翻两页：矩形要重量，但 CFI 已经解过了
    assert.equal(warm.result.boxes.length, cold.result.boxes.length, '暖缓存那一轮的矩形数量变了')

    // 冷启动太快（机器极快 / records 太少）时这条断言没有统计意义，跳过计时部分
    if (cold.elapsed >= 20) {
      assert.ok(
        warm.elapsed <= cold.elapsed * 0.6,
        `第二次 computeRects 没有变快（${cold.elapsed.toFixed(1)}ms → ${warm.elapsed.toFixed(1)}ms）：`
        + 'CFI→Range 没有按文档缓存，翻页时会重解全部锚点',
      )
    }
  }

  // ── 复验：正文结构指纹必须一字不差 ──────────────────────────────
  const after = structureFingerprint(doc)

  if (before !== after) {
    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')
    const diffAt = beforeLines.findIndex((line, i) => line !== afterLines[i])
    assert.fail(
      '正文 DOM 结构被改动了（铁律 4 违规）。'
      + `\n  位置：第 ${diffAt} 行`
      + `\n  之前：${beforeLines[diffAt] ?? '(缺失)'}`
      + `\n  之后：${afterLines[diffAt] ?? '(缺失)'}`
      + `\n  行数：${beforeLines.length} → ${afterLines.length}`,
    )
  }
  assert.equal(before, after, '正文 DOM 结构被改动了（铁律 4 违规）')

  // 属性值也不许变（除了覆盖层自己的那个容器）——正文里的元素属性一个都不许动
  const attrBefore = Array.from(doc.querySelectorAll('*')).map((el) => (
    Array.from(el.attributes || []).map((a) => `${a.name}=${a.value}`).sort().join('&')
  )).join('|')

  computeRects({ frameDoc: doc, frameWin: win, records, layerBox, frameBox, pageOffsetPx: 0 })

  const attrAfter = Array.from(doc.querySelectorAll('*')).map((el) => (
    Array.from(el.attributes || []).map((a) => `${a.name}=${a.value}`).sort().join('&')
  )).join('|')
  assert.equal(attrBefore, attrAfter, '正文元素的属性值被改动了（铁律 4 违规）')

  // ── 反向验证：覆盖层确实**没有**能力注入节点（源码级断言） ──────
  const annotateSource = readFileSync(join(ROOT, 'client', 'src', 'annotate.js'), 'utf8')
  for (const forbidden of ['appendChild', 'insertBefore', 'innerHTML', 'outerHTML', 'replaceChild', 'wrap', 'surroundContents']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(annotateSource),
      `annotate.js 里出现了 ${forbidden}：高亮只能画覆盖层，绝不能改动正文 DOM`,
    )
  }
  // 但必须真的读了 range 的几何
  assert.ok(/getClientRects/.test(annotateSource), 'annotate.js 没有读 getClientRects，覆盖层画不出来')

  // ── 注入节点的标记：reader.js 唯一注入的那个 <style> 必须打标记 ──
  const readerSource = readFileSync(join(ROOT, 'client', 'src', 'reader.js'), 'utf8')
  assert.ok(
    /data-dsh-reading-injected/.test(readerSource) || /INJECTED_ATTR/.test(readerSource),
    'reader.js 注入的 <style> 没有打 data-dsh-reading-injected 标记（CFI filter 会把它算进索引）',
  )
  const createCalls = readerSource.match(/createElement\(/g) || []
  assert.ok(
    createCalls.length <= 2,
    `reader.js 里 createElement 出现 ${createCalls.length} 次，注入节点应该只有那一个 <style>`,
  )
}
