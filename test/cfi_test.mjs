/**
 * 锚点核心单测（node test/run.mjs 会加载本文件的 default 导出）。
 *
 * 这里测的是 golden 覆盖不到的**契约细节**：filter 的强制行为、序列化规则、
 * 8 个失败码各自的最短复现、以及「不许吞异常」这条硬规则。
 * golden 负责「200+ 条真实 DOM 上精确往返」，本文件负责「边界与失败面」。
 */

import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import * as CFI from '../client/vendor/epubcfi.foliate.js'
import {
  INJECTED_ATTR, makeFilter, fromRange, toRange, validate,
  spineIndexFromCfi, chapterHrefFromCfi, joinCfi, splitCfi, textOfRange, collapseLocal,
} from '../client/src/cfi.js'
import { fingerprint } from '../client/src/contract.js'

const docOf = (body, options = {}) => {
  const html = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`
  const search = new URLSearchParams({
    book: 'f'.repeat(64),
    href: options.href ?? 'text/ch1.xhtml',
    spine: String(options.spine ?? 0),
    idref: options.idref ?? 'ch1',
  })
  const dom = new JSDOM(html, {
    contentType: 'application/xhtml+xml',
    url: `http://127.0.0.1/api/dsh-reading/chapter?${search.toString()}`,
  })
  if (typeof globalThis.NodeFilter === 'undefined') globalThis.NodeFilter = dom.window.NodeFilter
  return { dom, window: dom.window, document: dom.window.document }
}

const rangeIn = (doc, node, start, end) => {
  const range = doc.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return range
}

const SPINE = { index: 0, idref: 'ch1' }

/* ------------------------------------------------------------- filter 行为 */

/**
 * docs/03 §二 + docs/05 §5.4：注入节点不参与索引，正文锚点一字不差。
 *
 * 本项目的注入面只有一处：iframe 的 `<head>` 里一个 `<style data-dsh-reading-injected>`，
 * 以及覆盖层标记（都在正文**之外**或为空元素）。这两类注入实测稳定。
 *
 * 同一个用例还**反证**铁律 4：如果把文字包进注入元素（高亮用 `<span>` 包裹），
 * filter 不会把偏移重新合并回去——CFI 立刻错位。这条断言的意义是：
 * 将来谁改成「用 span 包高亮」，这里就会红。
 */
function filterIsMandatory() {
  const { window, document: doc } = docOf('<p id="h">Hello, World</p>')
  const text = doc.getElementById('h').firstChild
  const clean = fromRange(window, rangeIn(doc, text, 3, 8), SPINE)
  assert.equal(clean, 'epubcfi(/6/2[ch1]!/4/2[h],/1:3,/1:8)', '干净文档的 CFI 不对')

  // 1) head 里注入 <style>（分栏 CSS）——真实注入点
  const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style')
  style.setAttribute(INJECTED_ATTR, '')
  style.textContent = 'body{columns:600px}'
  doc.head.appendChild(style)

  // 2) 正文里注入空标记元素（覆盖层锚点的占位形态）
  const marker = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
  marker.setAttribute(INJECTED_ATTR, '')
  doc.body.appendChild(marker)

  const afterInject = fromRange(window, rangeIn(doc, text, 3, 8), SPINE)
  assert.equal(afterInject, clean, '注入 style/空标记后，同一选区的 CFI 必须一字不差')

  const back = toRange(window, doc, clean)
  assert.equal(textOfRange(back), 'lo, W', '干净 CFI 必须能反解回原文本')

  // filter 语义：REJECT（整棵子树不算），不是 SKIP。
  // v1.1 从 SKIP 改成 REJECT，理由是 vendor 对这两者的处理不对称：
  // getChildNodes 把 SKIP 的子节点拼进父列表，nodeToParts 却把 SKIP 节点自身那段
  // 丢掉，于是生成与解析各用一套下标（实测能生成出指向错误元素的 CFI）。
  const filter = makeFilter(window)
  assert.equal(filter(style), window.NodeFilter.FILTER_REJECT, '注入节点必须返回 FILTER_REJECT')
  assert.equal(filter(marker), window.NodeFilter.FILTER_REJECT)
  assert.equal(filter(doc.getElementById('h')), window.NodeFilter.FILTER_ACCEPT, '普通元素必须 ACCEPT')
  assert.equal(filter(text), window.NodeFilter.FILTER_ACCEPT, '文本节点必须 ACCEPT（只判元素）')

  // 只有 getAttribute、没有 hasAttribute 的伪节点也要认（兼容 mock / 片段）
  const pseudo = {
    nodeType: 1,
    hasAttribute: undefined,
    getAttribute: name => (name === INJECTED_ATTR ? '' : null),
  }
  assert.equal(filter(pseudo), window.NodeFilter.FILTER_REJECT, 'getAttribute 路径也必须识别注入节点')

  // 3) 反证铁律 4：把文字包进注入元素 → 偏移不再等价（所以绝不许这么干）
  const { window: w2, document: d2 } = docOf('<p id="h">Hello, World</p>')
  const p2 = d2.getElementById('h')
  const t = p2.firstChild
  const wrap = d2.createElementNS('http://www.w3.org/1999/xhtml', 'span')
  wrap.setAttribute(INJECTED_ATTR, '')
  wrap.appendChild(d2.createTextNode(', World'))
  t.nodeValue = 'Hello'
  p2.appendChild(wrap)
  const wrapped = fromRange(w2, rangeIn(d2, wrap.firstChild, 0, 5), SPINE)
  // 包裹后同一段文字的偏移基准从 5..10 变成 0..5：filter 只是把注入元素从**索引**里摘掉，
  // 并不会把被搬走的字符数据还回原坐标。这就是「高亮绝不能用 span 包裹」的机械证据。
  assert.notEqual(wrapped, 'epubcfi(/6/2[ch1]!/4/2[h],/1:5,/1:10)',
    '若包裹正文后 CFI 仍等价，说明这条防线失效了（铁律 4 的机械证据）')
  assert.equal(wrapped, 'epubcfi(/6/2[ch1]!/4/2[h],/1:0,/1:5)',
    '包裹后偏移应重新从 0 起算（被搬走的字符数据不会回到原坐标）')
}

/**
 * 结构预检也必须过 filter —— docs/06 审计的 medium 缺陷回归。
 *
 * checkStructure 是「交给 vendor 之前先自己走一遍」的规范模型，它的职责是
 * 把「索引越界 / 偏移越界 / 在文本块上继续下降」分成确定的码。它和 vendor
 * 算的是同一个映射，所以两边必须用**同一份**子节点表。
 *
 * 漏传 filter 的后果不是崩溃，而是**对一份正常的 CFI 报 cfi_resolve_failed**：
 * 注入的 `<style data-dsh-reading-injected>`（阅读器必注入）或空标记元素会
 * 在父节点的槽位表里占掉一格，于是索引整体错位，判定与定位互相打脸。
 * 用户看到的现象是「刚划的标注，点开就报错」。
 */
function structureCheckAlsoUsesFilter() {
  const { window, document: doc } = docOf('<div id="d"><p id="z">abcdef</p></div>')

  // 阅读器一定会做的事：往 body 里插一个带标记的空元素
  const marker = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
  marker.setAttribute(INJECTED_ATTR, '')
  doc.body.insertBefore(marker, doc.body.firstChild)

  const text = doc.getElementById('z').firstChild
  const cfi = fromRange(window, rangeIn(doc, text, 0, 3), SPINE)
  assert.equal(cfi, 'epubcfi(/6/2[ch1]!/4/2/2[z],/1:0,/1:3)',
    '注入节点不该改变 CFI（filter 已把它摘出索引），若变了说明 fromRange 侧也有问题')

  // 关键断言：这份自己算出来的 CFI，必须能通过自己的校验
  const verdict = validate(window, doc, cfi)
  assert.equal(verdict.ok, true,
    `注入节点存在时，合法 CFI 被误判为失败：${verdict.code} / ${verdict.detail}`
    + '（说明 checkStructure 的槽位表没过 filter）')
}

/**
 * 注入节点不能改变**已有**锚点的解析结果（t11 复审 M1 的回归）。
 *
 * 真实场景：昨天划好的线存在 annotations.jsonl 里，今天打开章节时阅读器先往
 * `<head>` 插一个 `<style data-dsh-reading-injected>`，然后才去解那些 CFI。
 * 如果注入让槽位表或 chunk 长度变了，这些线会**悄悄跑到别的字上**——不报错。
 *
 * 所以判据是：先在干净文档上取 CFI，再插入注入节点（带 CSS 文本的 `<style>`、
 * 以及一个含元素的包裹 div），同一个 CFI 必须仍解析到同一段文本。
 *
 * 用 FILTER_REJECT 而不是 FILTER_SKIP 才能真正满足这条：vendor 的
 * `getChildNodes` 对 SKIP 会把子节点拼进父列表（chunk 长度因此改变），而
 * `nodeToParts` 又把 SKIP 节点自身那一段丢掉，两边不自洽——实测 SKIP 下
 * `<p>A</p><div injected><p>B</p></div>` 给 B 生成的 `!/4/2` 会解回 A。
 */
function injectedNodesDoNotShiftExistingCfi() {
  // 不用 id：vendor 对「末段带 id」会走 getElementById 短路并忽略字符偏移
  // （docs/03 §四的已知行为），那样测的就不是槽位表了。
  const { window, document: doc } = docOf('<p>alpha</p><p>beta</p>')
  const [first, second] = doc.querySelectorAll('p')

  const cfiFirst = fromRange(window, rangeIn(doc, first.firstChild, 1, 3), SPINE)
  const cfiSecond = fromRange(window, rangeIn(doc, second.firstChild, 0, 2), SPINE)

  // ① head 里插带 CSS 文本的 style（生产形态）
  const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style')
  style.setAttribute(INJECTED_ATTR, '')
  style.textContent = 'p{color:red;font-size:12px}'
  doc.head.appendChild(style)

  // ② 两个段落之间再插一个含元素的注入包裹（最坏情况）
  const wrapper = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div')
  wrapper.setAttribute(INJECTED_ATTR, '')
  const junk = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
  junk.textContent = 'junk'
  wrapper.appendChild(junk)
  doc.body.insertBefore(wrapper, second)

  assert.equal(textOfRange(toRange(window, doc, cfiFirst)), 'lp',
    '注入后第一段锚点必须还落在原来那两个字上')
  assert.equal(textOfRange(toRange(window, doc, cfiSecond)), 'be',
    '注入后第二段锚点必须还落在原来那两个字上')
  assert.equal(validate(window, doc, cfiFirst).ok, true, '注入后旧锚点必须仍通过结构校验')
  assert.equal(validate(window, doc, cfiSecond).ok, true, '注入后旧锚点必须仍通过结构校验')
}

/** 导出面上不许出现 filter 参数——签名的 arity 就是证据。 */
function noFilterParameterAnywhere() {
  const expectedArity = new Map([
    ['makeFilter', 1], ['fromRange', 3], ['toRange', 3], ['validate', 4],
    ['spineIndexFromCfi', 1], ['chapterHrefFromCfi', 1], ['joinCfi', 2],
    ['splitCfi', 1], ['textOfRange', 1], ['collapseLocal', 1],
  ])
  for (const [name, arity] of expectedArity) {
    const fn = {
      makeFilter, fromRange, toRange, validate, spineIndexFromCfi, chapterHrefFromCfi,
      joinCfi, splitCfi, textOfRange, collapseLocal,
    }[name]
    assert.equal(typeof fn, 'function', `${name} 必须是函数`)
    assert.equal(fn.length, arity, `${name} 的参数个数应为 ${arity}（不许有 filter 参数）`)
  }
}

/* ------------------------------------------------------------ 序列化规则 */

/** docs/03 §四：中间段即使有 id 也不能写，只有每条 local path 的最后一段可以。 */
function serializationKeepsOnlyLastId() {
  const { window, document: doc } = docOf(
    '<div id="outer"><section id="mid"><p id="leaf">abcdef</p></section></div>',
  )
  const text = doc.getElementById('leaf').firstChild
  const cfi = fromRange(window, rangeIn(doc, text, 1, 4), SPINE)
  // /4=body, /2=div#outer, /2=section#mid, /2=p#leaf —— 中间两层的 id 都不许出现
  assert.equal(cfi, 'epubcfi(/6/2[ch1]!/4/2/2/2[leaf],/1:1,/1:4)',
    '中间层 id（outer/mid）必须被丢弃，只保留叶子 p 的 id')

  const idParts = cfi.match(/\[[^\]]*\]/g) ?? []
  assert.equal(idParts.length, 2, 'id 断言只应有两处：spine 前缀 + local 末段')

  // 反向验证：中间段带 id 的 CFI 一律判 L2 失败（docs/01 §3.4.2 的契约）。
  //
  // 为什么要拒绝而不是宽容：vendor 实际会**静默忽略**中间段 id（只读最后一段），
  // 于是这种 CFI 「解析成功、位置也对」，让人误以为那些断言在起作用——但它们
  // 一点抗重排能力都没有。静默接受 = 把「看起来有校验」的假象留在库里。
  const withMiddleIds = 'epubcfi(/6/2[ch1]!/4/2[outer]/2[mid]/2[leaf],/1:1,/1:4)'
  let thrown = null
  try {
    toRange(window, doc, withMiddleIds)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '中间段带 id 的 CFI 必须抛错，不许静默接受')
  assert.equal(thrown.name, 'CfiError')
  assert.equal(thrown.code, 'cfi_resolve_failed', `中间段 id 应判 cfi_resolve_failed，实际 ${thrown.code}`)
  assert.match(thrown.detail, /中间段/, 'detail 要说明「中间段不允许 id 断言」')

  const verdict = validate(window, doc, withMiddleIds)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'cfi_resolve_failed')
  assert.equal(verdict.level, 'L2')

  // 端点尾巴上的 id 仍然合法（区间 CFI 的 parent 就以 [leaf] 收尾）
  assert.equal(textOfRange(toRange(window, doc, cfi)), 'bcd')

  // id 短路会掩盖错索引：末段 id 对了就赢，索引写错也「成功」。
  // 这既是抗重排的保险，也是「解析成功 ≠ 索引正确」的来源——所以 L3 不可省。
  const shortcut = toRange(window, doc, 'epubcfi(/6/2[ch1]!/4/2/2/2[leaf],/1:1,/1:4)')
  assert.equal(textOfRange(shortcut), 'bcd', 'id 短路会让错索引也解析成功（L3 必须兜底）')
}

/** 折叠选区 → 无逗号形态；不许被当成区间存（由上层按记录类型拒收）。 */
function collapsedRangeIsPointCfi() {
  const { window, document: doc } = docOf('<p id="b">bookmark here</p>')
  const text = doc.getElementById('b').firstChild
  const collapsed = rangeIn(doc, text, 2, 2)
  assert.equal(collapsed.collapsed, true)
  const cfi = fromRange(window, collapsed, SPINE)
  // 注意末段是文本块（/1），元素 p#b 位于**中间段**，按序列化规则它的 id 被丢弃。
  // 解析侧只读最后一段的 id（docs/03 §四），所以丢了也不影响定位；这点与 golden 向量一致。
  assert.equal(cfi, 'epubcfi(/6/2[ch1]!/4/2/1:2)', '折叠选区应产出点 CFI（无逗号）')
  assert.ok(!cfi.includes(','), '点 CFI 里不该有逗号')

  // 点 CFI 本身是合法的位置（书签就这么用）
  const back = toRange(window, doc, cfi)
  assert.equal(back.collapsed, true)
  assert.equal(back.startOffset, 2)

  // 但要按「记录是 highlight」判时，必须明确失败
  const verdict = validate(window, doc, cfi, fingerprint(''))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'cfi_collapsed_highlight')
}

/* --------------------------------------------------------- 工具函数契约 */

function spineAndPrefixHelpers() {
  assert.equal(spineIndexFromCfi('epubcfi(/6/8!/4/2)'), 3, '/6/8 → spine 3')
  assert.equal(spineIndexFromCfi('epubcfi(/6/2[ch1]!/4/2)'), 0)
  assert.equal(spineIndexFromCfi('epubcfi(/6/2[ch1]!/4/2,/1:0,/1:3)'), 0,
    '区间 CFI 也要能推 spine（不能拿 end 段去算）')
  assert.equal(chapterHrefFromCfi('epubcfi(/6/4[ch2]!/4/2)'), 'ch2')
  assert.equal(chapterHrefFromCfi('epubcfi(/6/4!/4/2)'), null, '没有断言时返回 null')

  assert.equal(joinCfi('/6/2[ch1]', '/4/2,/1:0,/1:3)'.slice(0, -1)),
    'epubcfi(/6/2[ch1]!/4/2,/1:0,/1:3)')
  assert.equal(joinCfi('epubcfi(/6/2[ch1])', '/4/2,/1:0,/1:3'),
    'epubcfi(/6/2[ch1]!/4/2,/1:0,/1:3)', '带壳的 prefix 也要能拼')
  assert.throws(() => joinCfi('/6/2!/4/2', '/4/2'), /./, "两段都带 '!' 必须拒绝")

  assert.deepEqual(splitCfi('epubcfi(/6/2[ch1]!/4/2,/1:0,/1:3)'),
    { prefix: '/6/2[ch1]', local: '/4/2,/1:0,/1:3' })
  assert.throws(() => splitCfi('/4/2,/1:0,/1:3'), /./, '没有 ! 的 partial 不能当完整 CFI 拆')

  assert.throws(() => spineIndexFromCfi('epubcfi('), /./)
}

/** collapseLocal：区间 → 某一端的点路径（cfiStart / cfiEnd 的来源）。 */
function collapseLocalContract() {
  const range = 'epubcfi(/6/2[ch1]!/4/2[p1],/1:3,/1:8)'
  assert.equal(collapseLocal(range, false), '/4/2[p1]/1:3', '左端应保留父路径上的 id')
  assert.equal(collapseLocal(range, true), '/4/2[p1]/1:8', '右端同上')
  assert.equal(collapseLocal(range), '/4/2[p1]/1:3', '默认取左端')

  // 点 CFI：两端相同
  const point = 'epubcfi(/6/2[ch1]!/4/2[p1]/1:3)'
  assert.equal(collapseLocal(point, false), '/4/2[p1]/1:3')
  assert.equal(collapseLocal(point, true), '/4/2[p1]/1:3')

  // schema 的 cfiPartial pattern 是 ^/[0-9]，输出必须匹配
  for (const value of [collapseLocal(range, true), collapseLocal(point)]) {
    assert.match(value, /^\/[0-9]/, `cfiPartial 必须匹配 ^/[0-9]，实际 ${value}`)
    assert.ok(!value.includes('!'), 'partial 不许含 !')
    assert.ok(!value.includes(','), '折叠后的点路径不许含逗号')
  }

  // 折叠结果必须真能解析回同一个位置（不是只看起来像）
  const { window, document: doc } = docOf('<p id="p1">Hello, World</p>')
  const fromStart = toRange(window, doc, joinCfi('/6/2[ch1]', collapseLocal(range, false)))
  assert.equal(textOfRange(fromStart), '', '点 Range 的文本应为空')
  assert.equal(textOfRange(toRange(window, doc, range)), 'lo, W', '原区间仍是 lo, W')
  const head = doc.createRange()
  head.setStart(fromStart.startContainer, 0)
  head.setEnd(fromStart.startContainer, fromStart.startOffset)
  assert.equal(textOfRange(head), 'Hel', 'cfiStart 应指向第 3 个字符之前')

  assert.throws(() => collapseLocal('/4/2,/1:0,/1:3'), /./, '没有 ! 的不是完整 CFI')
}

/* ------------------------------------------------------------ 8 个失败码 */

/**
 * 每个码一条最短复现。
 * 注意 cfi_parse_failed 的两条：区间 CFI 是三等分（两个逗号），
 * 写成「两条路径一个逗号」是语法错误，不是「缺 end」的语义错误。
 */
function allEightCodes() {
  const { window, document: doc } = docOf('<p id="z">abcdef</p>')
  const ok = 'epubcfi(/6/2[ch1]!/4/2[z],/1:0,/1:3)'
  assert.equal(validate(window, doc, ok).ok, true, '基准 CFI 必须能通过')

  const cases = [
    ['cfi_parse_failed', 'epubcfi(/6/2[ch1]!/4/2[z],/1:0)', 'L1'],
    ['cfi_parse_failed', 'epubcfi(/4/2[z],/1:0,/1:3)', 'L1'],
    ['cfi_resolve_failed', 'epubcfi(/6/2[ch1]!/4/99,/1:0,/1:2)', 'L2'],
    ['cfi_range_inverted', 'epubcfi(/6/2[ch1]!/4/2[z],/1:3,/1:1)', 'L2'],
    ['cfi_cross_document', 'epubcfi(/6/2[ch1]!/0)', 'L2'],
    ['cfi_collapsed_highlight', 'epubcfi(/6/2[ch1]!/4/2[z],/1:2,/1:2)', 'L2'],
    ['cfi_offset_out_of_bounds', 'epubcfi(/6/2[ch1]!/4/2[z],/1:0,/1:999)', 'L2'],
    ['cfi_prefix_mismatch', 'epubcfi(/6/4[ch2]!/4/2[z],/1:0,/1:3)', 'L2'],
  ]

  for (const [code, cfi, level] of cases) {
    // cfi_collapsed_highlight 只在「记录带文本」时才成立
    const expected = code === 'cfi_collapsed_highlight' ? fingerprint('ab') : null
    const verdict = validate(window, doc, cfi, expected)
    assert.equal(verdict.ok, false, `${code}: 应当判失败（${cfi}）`)
    assert.equal(verdict.code, code, `${code}: 失败码不符（实际 ${verdict.code}）`)
    assert.equal(verdict.level, level, `${code}: 层级应为 ${level}，实际 ${verdict.level}`)
  }

  // cfi_parse_failed / cfi_resolve_failed 等位置类错误必须**抛**，不许返回 null
  for (const [code, cfi] of cases) {
    if (code === 'cfi_collapsed_highlight') continue // 位置合法，只是记录语义错
    let thrown = null
    try {
      toRange(window, doc, cfi)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, `${code}: toRange 必须抛错，不许静默返回`)
    assert.equal(thrown.name, 'CfiError', `${code}: 抛的必须是 CfiError`)
    assert.equal(thrown.code, code, `${code}: 抛出的 code 不符（实际 ${thrown.code}）`)
  }

  // 第 8 个码：L3 内容层（位置合法，内容不符）
  const drift = validate(window, doc, ok, fingerprint('xyz'))
  assert.equal(drift.ok, false)
  assert.equal(drift.code, 'fingerprint_drift')
  assert.equal(drift.level, 'L3')

  // L3 通过：同一段文字算出的指纹
  assert.equal(validate(window, doc, ok, fingerprint('abc')).ok, true)
}

/** 前缀一致性判定走文档自报身份；两处都没有时必须**跳过**而不是误判。 */
function prefixIdentitySources() {
  const body = '<p id="z">abcdef</p>'
  const viaSearch = docOf(body, { spine: 0, idref: 'ch1' })
  assert.equal(
    validate(viaSearch.window, viaSearch.document, 'epubcfi(/6/2[ch1]!/4/2[z],/1:0,/1:3)').ok,
    true,
  )

  // URL 没身份时，退回 documentElement 上的属性
  const dom = new JSDOM(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`,
  { contentType: 'application/xhtml+xml', url: 'http://127.0.0.1/api/dsh-reading/chapter' })
  if (typeof globalThis.NodeFilter === 'undefined') globalThis.NodeFilter = dom.window.NodeFilter
  const doc = dom.window.document
  const cfi = 'epubcfi(/6/2[ch1]!/4/2[z],/1:0,/1:3)'
  // 没有身份信息：跳过前缀判定，位置本身合法 → ok
  assert.equal(validate(dom.window, doc, cfi).ok, true, '无身份信息时应跳过前缀判定')
  // 补上属性后就会判出来了
  doc.documentElement.setAttribute('data-dsh-reading-spine', '1')
  const mismatch = validate(dom.window, doc, cfi)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'cfi_prefix_mismatch')
}

/** Range 文本按原样取，不做空白归一化（归一化会让 L3 假阴性）。 */
function textOfRangeRaw() {
  const { window, document: doc } = docOf('<p id="s">a  b\nc</p>')
  const text = doc.getElementById('s').firstChild
  const range = rangeIn(doc, text, 0, text.nodeValue.length)
  assert.equal(textOfRange(range), 'a  b\nc', '不许 trim / 不许折叠空白')
  assert.equal(validate(window, doc, fromRange(window, range, SPINE), fingerprint(text.nodeValue)).ok, true)
}

export default async function run() {
  filterIsMandatory()
  noFilterParameterAnywhere()
  serializationKeepsOnlyLastId()
  collapsedRangeIsPointCfi()
  spineAndPrefixHelpers()
  collapseLocalContract()
  allEightCodes()
  prefixIdentitySources()
  textOfRangeRaw()
  structureCheckAlsoUsesFilter()
  injectedNodesDoNotShiftExistingCfi()
}
