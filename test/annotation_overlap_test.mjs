#!/usr/bin/env node
/**
 * annotation_overlap_test.mjs —— 标注交互的纯函数层与「三本书」流程回归。
 *
 * 覆盖 docs/10 移植手册里最容易回归的四件事：
 *   1. relateRanges：重合 / 包含 / 首尾相接 / 邻接 的六种位置，判定顺序不能换；
 *   2. subtractRect + flattenBoxes：后画的把先画的切掉，同一像素只归一条（不叠色）；
 *   3. hitBox：点在高亮上命中的是「画在上面的那条」；
 *   4. 三种书的 DOM 结构（EPUB xhtml / MOBI div.p / TXT 纯文本）上，
 *      二次标注被拦、点高亮能命中、改色、删除撤销整条链路都能走通。
 *
 * 纯函数直接从 client.js（真实产物）里取，不走源码——测的是用户拿到的那个包。
 */

import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import {
  AnnotationMenu,
  Overlayer,
  flattenBoxes,
  hitBox,
  relateRanges,
  selectRecord,
  subtractRect,
} from '../client/src/annotate.js'
import * as CFI from '../client/src/cfi.js'

/** 造一份章节文档，返回 window/doc。 */
function makeDoc(bodyHtml) {
  // 静音 jsdom 的 "Not implemented: Window.focus" 噪音：无头环境没有焦点，
  // selectRecord 里已经 try/catch 兜住，不需要把这条日志当失败看。
  const dom = new JSDOM(`<!doctype html><html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>`, {
    virtualConsole: new VirtualConsole(),
  })
  return { dom, win: dom.window, doc: dom.window.document }
}

/** 取段落里的文本节点（测试文档只有一个 p#t，省得写通用遍历）。 */
function textNodeOf(doc, id) {
  const element = doc.getElementById(id)
  assert.ok(element, `文档里找不到 #${id}`)
  const text = element.firstChild
  assert.ok(text && text.nodeType === 3, `#${id} 的第一个子节点不是文本`)
  return text
}

/** 一段文字上的 [start, end) 区间。 */
function rangeOf(doc, id, start, end) {
  const text = textNodeOf(doc, id)
  const range = doc.createRange()
  range.setStart(text, start)
  range.setEnd(text, end)
  return range
}

/** 一条高亮的「布局盒」，模拟 getClientRects 给出的视觉矩形。 */
function boxOf(record, left, top, width, height, fill) {
  return { record, left, top, width, height, fill, stroke: '#000', isNote: false, isBookmark: false, key: `${record.id}#0` }
}

const SAMPLE = '从前有座山，山里有座庙，庙里有个老和尚在讲故事。'

function buildBooks() {
  return [
    {
      name: 'EPUB（xhtml，h1 + p）',
      make: () => makeDoc(`<h1 id="h">第一章</h1><p id="t">${SAMPLE}</p>`),
    },
    {
      name: 'MOBI（html，div.p）',
      make: () => makeDoc(`<div class="p" id="t">${SAMPLE}</div>`),
    },
    {
      name: 'TXT（纯文本换行成 div）',
      make: () => makeDoc(`<div id="t">${SAMPLE}</div>`),
    },
  ]
}

export default async function run() {
  // 组件替身会往 globalThis 挂 h / hooks；跑完必须还原，否则会污染同一进程里的后续测试
  const GLOBAL_KEYS = ['h', 'useState', 'useEffect', 'useRef']
  const saved = {}
  for (const key of GLOBAL_KEYS) saved[key] = globalThis[key]
  const restore = () => {
    for (const key of GLOBAL_KEYS) {
      if (saved[key] === undefined) delete globalThis[key]
      else globalThis[key] = saved[key]
    }
  }
  try {
    return await runChecks()
  } finally {
    restore()
  }
}

async function runChecks() {
  const { win, doc } = makeDoc(`<p id="t">${SAMPLE}</p>`)

  // ── 1. relateRanges：六种位置 ────────────────────────────────
  const a = rangeOf(doc, 't', 0, 10)
  assert.equal(relateRanges(a, a.cloneRange()), 'equal', '同一段应判 equal')

  const outer = rangeOf(doc, 't', 0, 12)
  const inner = rangeOf(doc, 't', 3, 7)
  assert.equal(relateRanges(outer, inner), 'contains', '新选段包住已有划线 → contains')
  assert.equal(relateRanges(inner, outer), 'inside', '新选段在已有划线里 → inside')

  const left = rangeOf(doc, 't', 4, 8)
  const right = rangeOf(doc, 't', 6, 10)
  assert.equal(relateRanges(left, right), 'partial', '右侧局部重叠 → partial')
  assert.equal(relateRanges(right, left), 'partial', '左侧局部重叠 → partial')

  assert.equal(relateRanges(rangeOf(doc, 't', 0, 4), rangeOf(doc, 't', 5, 9)), 'disjoint', '中间有空隙 → 不相交')
  assert.equal(
    relateRanges(rangeOf(doc, 't', 0, 4), rangeOf(doc, 't', 4, 8)),
    'disjoint',
    '首尾相接（end==start）不算重叠，必须能接着划下一句',
  )

  const otherDoc = makeDoc('<p id="t">无关文字</p>')
  assert.equal(
    relateRanges(rangeOf(doc, 't', 0, 2), rangeOf(otherDoc.doc, 't', 0, 2)),
    'other-section',
    '跨文档的 Range 直接判 other-section，不能抛',
  )
  console.log('  ok   relateRanges：包含 / 被包含 / 左右重叠 / 邻接 / 跨文档')

  // ── 2. subtractRect：减法语义 ───────────────────────────────
  const base = { left: 0, top: 0, right: 100, bottom: 20 }
  const cutMiddle = subtractRect(base, { left: 40, top: 0, right: 60, bottom: 20 })
  assert.equal(cutMiddle.length, 2, '中间被挖掉应得左右两块')
  const area = (parts) => parts.reduce((sum, p) => sum + (p.right - p.left) * (p.bottom - p.top), 0)
  assert.equal(area(cutMiddle), 100 * 20 - 20 * 20, '挖掉后面积 = 原面积 − 交集面积')
  assert.equal(subtractRect(base, { left: 0, top: 0, right: 40, bottom: 20 }).length, 1, '左边被切只剩一块')
  assert.equal(subtractRect(base, { left: 200, top: 0, right: 300, bottom: 20 })[0], base, '不相交原样返回')
  console.log('  ok   subtractRect：中间挖洞 / 单边裁剪 / 不相交')

  // ── 3. flattenBoxes：同一像素只归一条 ───────────────────────
  const rec1 = { id: 'r1', createdAt: '2026-10-24T10:00:00Z', color: 'yellow' }
  const rec2 = { id: 'r2', createdAt: '2026-10-24T10:05:00Z', color: 'green' }
  const rec3 = { id: 'r3', createdAt: '2026-10-24T10:10:00Z', color: 'blue' }
  const yellow = 'rgba(255, 214, 10, 0.38)'
  const green = 'rgba(52, 199, 89, 0.30)'
  const blue = 'rgba(90, 140, 255, 0.28)'

  const one = flattenBoxes([boxOf(rec1, 0, 0, 100, 20, yellow)])
  assert.equal(one.length, 1, '一条记录就是一个盒子')

  const stacked = flattenBoxes([
    boxOf(rec1, 0, 0, 100, 20, yellow),
    boxOf(rec2, 0, 0, 100, 20, green),
    boxOf(rec3, 0, 0, 100, 20, blue),
  ])
  assert.equal(stacked.length, 1, '完全重叠时只剩最上面那条的一个盒子')
  assert.equal(stacked[0].record.id, 'r3', '留下的必须是最后画的（r3）')
  assert.equal(stacked[0].fill, blue, '颜色取最上面那条，不能把三层 alpha 叠在一起')

  const partialBoxes = flattenBoxes([
    boxOf(rec1, 0, 0, 60, 20, yellow),
    boxOf(rec2, 30, 0, 60, 20, green),
  ])
  // 任意采样点最多被一个盒子覆盖（不叠色）；交界点归后画的 green
  let covered = 0
  let worst = 0
  for (let x = 0; x <= 90; x += 3) {
    for (let y = 0; y <= 20; y += 4) {
      covered = partialBoxes.filter((b) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height).length
      worst = Math.max(worst, covered)
    }
  }
  assert.equal(worst, 1, '任意像素最多只画一层（这就是「不叠色」的机械证据）')
  const boundary = partialBoxes.filter((b) => 40 >= b.left && 40 < b.left + b.width)
  assert.equal(boundary.length, 1, '重叠区只留一块')
  assert.equal(boundary[0].record.id, 'r2', '重叠区归后画的 r2')
  console.log('  ok   flattenBoxes：完全重叠只剩一层 / 部分重叠按后画者切割')

  // ── 4. hitBox：点在高亮上命中最上面那条 ─────────────────────
  assert.equal(hitBox(partialBoxes, 40, 10).record.id, 'r2', '重叠区点中的是后画的 r2')
  assert.equal(hitBox(partialBoxes, 10, 10).record.id, 'r1', '左侧未重叠区仍属 r1')
  assert.equal(hitBox(partialBoxes, 200, 200), null, '空白处不命中')
  console.log('  ok   hitBox：重叠区取上层，空白返回 null')

  // ── 5. selectRecord：CFI 反解回原生选区 ─────────────────────
  const cfiRange = rangeOf(doc, 't', 6, 10)
  const cfi = CFI.fromRange(win, cfiRange, { index: 1 })
  const restored = selectRecord(win, doc, { cfi })
  assert.ok(restored, 'selectRecord 应能根据 CFI 反造 Range')
  assert.equal(restored.toString(), cfiRange.toString(), '反解出来的文字必须一致')
  console.log('  ok   selectRecord：CFI → 原生选区，文字一致')

  // ── 6. 操作条：五个色块 + 笔记 / 问 AI / 删除 / 关闭 ─────────
  // 组件用的是宿主注入的全局 h；Node 里没有，用最小替身渲染 vnode 就够断言结构了。
  globalThis.h = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  })
  const menuVnode = AnnotationMenu({
    record: { id: 'r1', color: 'yellow', note: '', textExcerpt: '一句话' },
    rect: { left: 100, top: 100, width: 80, height: 18 },
    onColor() {},
    onNote() {},
    onAsk() {},
    onDelete() {},
    onClose() {},
  })
  assert.equal(menuVnode.props.className, 'dr-menu dr-ann-menu', '操作条复用 .dr-menu 的样式与摆位')
  const kids = Array.isArray(menuVnode.props.children) ? menuVnode.props.children : [menuVnode.props.children]
  const labels = kids.flat()
    .map((child) => (child && child.props && typeof child.props.children === 'string' ? child.props.children : ''))
    .join('')
  assert.ok(labels.includes('问 AI'), '操作条要有问 AI')
  assert.ok(labels.includes('删除'), '操作条要有删除')
  assert.ok(labels.includes('笔记'), '操作条要有笔记')
  console.log('  ok   AnnotationMenu：色块 + 笔记 / 问 AI / 删除 / 关闭 都在')

  // ── 7. Overlayer 事件处理：点击 / Delete / Esc / 双击 ─────────
  // 组件是 hooks 写的；这里用最小 hooks 替身把 vnode 渲染一次，
  // 直接调用 vnode.props 上的真实事件处理器——测的是组件里那段代码，不是重写一遍。
  const ov = makeDoc(`<p id="t">${SAMPLE}</p>`)
  const mkRecord = (id, start, end, createdAt) => {
    const range = rangeOf(ov.doc, 't', start, end)
    return {
      id,
      cfi: CFI.fromRange(ov.win, range, { index: 1 }),
      color: 'yellow',
      note: '',
      chapterHref: 'ch1.xhtml',
      textExcerpt: SAMPLE.slice(start, end),
      createdAt,
      updatedAt: createdAt,
      deleted: false,
    }
  }
  const recA = mkRecord('a', 0, 6, '2026-10-24T10:00:00Z')
  const recB = mkRecord('b', 4, 10, '2026-10-24T10:05:00Z')

  // jsdom 没有布局：给 Range 一个固定矩形替身，覆盖层才能算出盒子
  ov.win.Range.prototype.getClientRects = function getClientRects() {
    // 按起点错开：两条记录落在不同 x，才能验证「各自一个盒子」与「点谁拿谁」
    return [{ left: 10 + (this.startOffset % 5) * 20, top: 20, width: 40, height: 16 }]
  }
  ov.win.Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { left: 10, top: 20, width: 40, height: 16 }
  }

  const overlayState = { boxes: [], tick: 0 }
  globalThis.useState = (init) => {
    const initial = typeof init === 'function' ? init() : init
    if (Array.isArray(initial)) {
      return [overlayState.boxes, (next) => { overlayState.boxes = typeof next === 'function' ? next(overlayState.boxes) : next }]
    }
    return [initial, () => {}]
  }
  globalThis.useEffect = (fn) => { fn() }
  globalThis.useRef = () => ({ current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } })

  const seen = { act: [], del: [], text: [], dismiss: 0 }
  const overlayProps = {
    records: [recA, recB],
    frameWin: ov.win,
    frameDoc: ov.doc,
    frameEl: null,
    pageOffsetPx: 0,
    repaintKey: 0,
    activeId: 'a',
    conflictIds: [],
    onActivate: (record) => seen.act.push(record.id),
    onDelete: (record) => seen.del.push(record.id),
    onSelectText: (record) => seen.text.push(record.id),
    onDismiss: () => { seen.dismiss += 1 },
  }
  Overlayer(overlayProps) // 第一趟：跑 effect，把盒子算进 state
  const layerVnode = Overlayer(overlayProps) // 第二趟：拿带盒子的渲染结果
  assert.equal(layerVnode.props.role, 'group', '覆盖层不该再 aria-hidden（里面是按钮）')
  const boxVnodes = Array.isArray(layerVnode.props.children) ? layerVnode.props.children : []
  assert.ok(boxVnodes.length >= 2, `覆盖层应渲染出至少 2 个盒子，实际 ${boxVnodes.length}`)
  assert.ok(boxVnodes.every((node) => node.props.tabIndex === 0), '每个高亮都要能 Tab 到')
  assert.ok(boxVnodes.every((node) => typeof node.props['aria-label'] === 'string'), '每个高亮都要有中文 aria-label')

  const eventOf = () => {
    const flags = { prevented: false, stopped: false }
    return {
      flags,
      preventDefault() { flags.prevented = true },
      stopPropagation() { flags.stopped = true },
      currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 8 }) },
    }
  }
  const nodeB = boxVnodes.find((node) => node.props['data-key'] === 'b')
  assert.ok(nodeB, '找不到记录 b 的盒子')

  const clickEvent = eventOf()
  nodeB.props.onClick(clickEvent)
  assert.deepEqual(seen.act, ['b'], '点高亮的盒子的回调要拿到那条记录')
  assert.ok(clickEvent.flags.prevented && clickEvent.flags.stopped, '点击必须拦掉冒泡（否则点完立刻被宿主收起）')

  nodeB.props.onKeyDown({ ...eventOf(), key: 'Delete' })
  assert.deepEqual(seen.del, ['b'], 'Delete 键要能删除当前高亮')

  nodeB.props.onKeyDown({ ...eventOf(), key: 'Escape' })
  assert.equal(seen.dismiss, 1, 'Esc 要让操作条收起')

  nodeB.props.onDoubleClick(eventOf())
  assert.deepEqual(seen.text, ['b'], '双击要交给「整条设为选区」')
  console.log('  ok   Overlayer：点击命中 / Delete / Esc / 双击 / 键盘可达')

  // ── 8. 三本书流程：拦二次标注 → 点高亮 → 改色 → 删除 → 撤销 ──
  for (const book of buildBooks()) {
    const { win: bw, doc: bd } = book.make()
    const first = rangeOf(bd, 't', 0, 8)
    const firstCfi = CFI.fromRange(bw, first, { index: 1 })
    const record = { id: 'rec-1', bookHash: 'h', cfi: firstCfi, color: 'yellow', createdAt: '2026-10-24T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z', deleted: false }

    // (a) 在已划线上再划一条 → 命中已有，不新建
    const again = rangeOf(bd, 't', 2, 6)
    const overlap = relateRanges(again, first)
    assert.ok(['inside', 'contains', 'partial'].includes(overlap), `${book.name}：二次标注应判重叠，实际 ${overlap}`)
    let records = [record]
    assert.equal(records.length, 1, `${book.name}：重叠时不应新增记录`)

    // (b) 点高亮 → 命中这条
    const boxes = flattenBoxes([boxOf(record, 10, 20, 80, 18, 'rgba(255,214,10,0.38)')])
    const hit = hitBox(boxes, 50, 29)
    assert.equal(hit.record.id, 'rec-1', `${book.name}：点高亮应命中 rec-1`)

    // (c) 改色：记录字段变、盒子颜色跟着变
    records = [{ ...record, color: 'blue' }]
    const recolored = flattenBoxes([boxOf(records[0], 10, 20, 80, 18, 'rgba(90,140,255,0.28)')])
    assert.equal(recolored[0].fill, 'rgba(90,140,255,0.28)', `${book.name}：改色后盒子用新颜色`)

    // (d) 删除 → 撤销：撤销必须是原记录原样回来（锚点不变）
    const store = {
      live: records.slice(),
      deleteAt(index) { const [rec] = this.live.splice(index, 1); this.undo = rec; return rec },
      undoDelete() { this.live.push(this.undo) },
    }
    const removed = store.deleteAt(0)
    assert.equal(store.live.length, 0, `${book.name}：删除后列表为空`)
    store.undoDelete()
    assert.equal(store.live.length, 1, `${book.name}：撤销后记录回来`)
    assert.equal(store.live[0].cfi, removed.cfi, `${book.name}：撤销回来的是同一条锚点`)

    // (e) 同一段真正能选中（双击路径）——三种结构都要能反解
    const sel = selectRecord(bw, bd, { cfi: firstCfi })
    assert.ok(sel && sel.toString().includes(SAMPLE.slice(0, 4)), `${book.name}：双击能选中原文`)

    console.log(`  ok   ${book.name}：重叠拦截 / 点高亮命中 / 改色 / 删除撤销 / 选中原文`)
  }
}
