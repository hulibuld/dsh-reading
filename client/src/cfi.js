/**
 * 锚点核心：把 foliate-js 的 CFI 编解码包成「不可能用错」的一层。
 *
 * 三条硬规则（docs/03 §二 §三 §四，docs/05 §5.2）：
 *   1. 本文件是 client/src 下**唯一**允许 import vendor 的模块；
 *   2. 所有导出函数内部强制注入 filter，签名里没有 filter 参数 —— 不给出错的机会；
 *   3. 序列化自己写：每条 local path 只保留最后一段的 id 断言，中间段 id 一律丢弃。
 *
 * 失败行为：所有函数**不吞异常、不返回 null 兜底**。失败一律抛 `Error`，其
 * `name === 'CfiError'`、`code` 是 8 个失败码之一、`detail` 给人看。
 * 唯一的例外是 `validate()`：它是判定函数，失败以 `{ ok:false, level, code }` 返回。
 */

import * as CFI from '../vendor/epubcfi.foliate.js'

/** 注入节点的标记属性。命中它的元素不参与 CFI 索引计算。 */
export const INJECTED_ATTR = 'data-dsh-reading-injected'

/** NodeFilter 常量值（2 = REJECT / 3 = SKIP），免去每个调用点都去取 win.NodeFilter。 */
const REJECT_NODE = 2
const SKIP_NODE = 3

/** 规范要求：spine 间接步固定走 package 文档的第 6 步（/6）。 */
const SPINE_STEP = 6

/** 允许出现的 8 个失败码。多了少了都是契约事故。 */
const CODE = {
  PARSE: 'cfi_parse_failed',
  RESOLVE: 'cfi_resolve_failed',
  INVERTED: 'cfi_range_inverted',
  CROSS_DOC: 'cfi_cross_document',
  COLLAPSED: 'cfi_collapsed_highlight',
  OFFSET: 'cfi_offset_out_of_bounds',
  PREFIX: 'cfi_prefix_mismatch',
  DRIFT: 'fingerprint_drift',
}

/** 每个失败码归属的校验层。validate() 用它填 level。 */
const LEVEL_OF = {
  [CODE.PARSE]: 'L1',
  [CODE.PREFIX]: 'L2',
  [CODE.RESOLVE]: 'L2',
  [CODE.INVERTED]: 'L2',
  [CODE.CROSS_DOC]: 'L2',
  [CODE.COLLAPSED]: 'L2',
  [CODE.OFFSET]: 'L2',
  [CODE.DRIFT]: 'L3',
}

const CFI_WRAPPER = /^epubcfi\(([\s\S]*)\)$/
const ESCAPE_RE = /[\^[\](),;=]/g

/**
 * 造一个带 code 的错误。故意不建子类：跨 iframe 传对象时原型会丢，
 * 只有 name/code/detail 三个自有属性才可靠。
 */
function cfiError(code, detail, cause) {
  const error = new Error(`${code}: ${detail}`)
  error.name = 'CfiError'
  error.code = code
  error.detail = detail
  if (cause) error.cause = cause
  return error
}

const isCfiError = value => value?.name === 'CfiError' && typeof value.code === 'string'

/* ------------------------------------------------------------------ filter */

/**
 * 造项目统一 filter。
 *
 * vendor 内部直接引用**全局** `NodeFilter`（不是 win.NodeFilter）来比对 FILTER_REJECT，
 * 而 Node 侧（golden / 单测）没有这个全局量，所以这里补一次幂等 polyfill：
 * 浏览器里它本来就存在，不会被覆盖。
 *
 * **为什么是 FILTER_REJECT 而不是 FILTER_SKIP**（v1.1 改，v1.0 用 SKIP）：
 * vendor 的 `getChildNodes`（vendor/epubcfi.foliate.js:201-211）对 SKIP 的处理是
 * `return getChildNodes(node, filter)` —— 把注入节点的**子节点拼进父列表**；可它的
 * `nodeToParts` 又会把注入节点自身那一段的 index 记为 -1 后**整段丢弃**，两者拼不到一起。
 * 后果实测：`<p>A</p><div injected><p>B</p></div>` 里给 B 生成 CFI 会得到
 * `!/4/2` —— 解回来指向 **A**（生成侧用了 div 内部的下标，解析侧用的是 body 的下标）。
 * REJECT 下两边都是「整棵不算」，生成与解析自洽。
 *
 * 代价：注入节点里的文本不参与 chunk 计数，也不可被锚定。这正是我们想要的——
 * 注入的是 `<style>`，它的 CSS 文本本来就不该进书签偏移；一旦某天要注入包裹元素，
 * 也必须保证里面没有可锚定的正文（有的话就不是「注入装饰」而是「改正文」了）。
 *
 * @param {Window} win 章节文档所属窗口（iframe 的 contentWindow）
 * @returns {(node: Node) => number} 给 vendor 用的过滤器
 */
export function makeFilter(win) {
  if (typeof globalThis.NodeFilter === 'undefined' && win && win.NodeFilter) {
    globalThis.NodeFilter = win.NodeFilter
  }
  const REJECT = win?.NodeFilter?.FILTER_REJECT ?? REJECT_NODE
  const ACCEPT = win?.NodeFilter?.FILTER_ACCEPT ?? 1
  return node => {
    if (!node || node.nodeType !== 1) return ACCEPT
    // 两种写法都要认：XML 文档里 hasAttribute 一定在，但 mock / 片段可能只有 getAttribute
    const byHas = typeof node.hasAttribute === 'function' && node.hasAttribute(INJECTED_ATTR)
    const byGet = !byHas
      && typeof node.getAttribute === 'function'
      && node.getAttribute(INJECTED_ATTR) != null
    return byHas || byGet ? REJECT : ACCEPT
  }
}

/* --------------------------------------------------------- 序列化（自己写） */

const escapeCfi = str => String(str).replace(ESCAPE_RE, '^$&')

/** 单个 step 的字符串形态。只输出规范里有意义的字段。 */
const partToString = ({ index, id, offset, temporal, spatial, text, side }) => {
  const param = side ? `;s=${side}` : ''
  return `/${index}`
    + (id ? `[${escapeCfi(id)}${param}]` : '')
    // 规范要求字符偏移显式写出；只有奇数步（字符数据）才有 offset
    + (offset != null && index % 2 ? `:${offset}` : '')
    + (temporal != null ? `~${temporal}` : '')
    + (spatial ? `@${spatial.join(':')}` : '')
    + (text || (!id && side)
      ? `[${text?.map(escapeCfi)?.join(',') ?? ''}${param}]`
      : '')
}

/**
 * 每条 local path 只保留最后一段的 id。
 * docs/03 §四：partsToNode 只读最后一段的 id，中间段 id 既不生效，还会让解析路径断掉。
 */
const sanitizeGroup = group => group.map((part, i) => (
  i === group.length - 1 ? part : { ...part, id: undefined }
))

const groupToString = group => sanitizeGroup(group).map(partToString).join('')

/** parsed 既可能是「点」（groups 数组）也可能是「区间」（{parent,start,end}）。 */
const partsToInner = parsed => (Array.isArray(parsed)
  ? parsed.map(groupToString).join('!')
  : [parsed.parent, parsed.start, parsed.end].map(partsToInner).join(','))

/* --------------------------------------------------------------- L1 语法层 */

/**
 * 数某个字符在 CFI 表达式里出现几次，**跳过转义与 id 断言内部**。
 *
 * 为什么不能用 split().length-1：CFI 的 id 断言允许转义（`a^,b`）且可以含逗号，
 * 直接按字符切会把 `/4/2[a^,b],/1:0,/1:2` 数成 3 个逗号，误判成畸形。
 * 这与 vendor 的 tokenizer 同口径：`^` 之后一个字符原样吞掉。
 */
const countChar = (str, ch) => {
  let count = 0
  let inBracket = 0
  for (let i = 0; i < str.length; i++) {
    const current = str[i]
    if (current === '^') {
      i += 1
      continue
    }
    if (current === '[') {
      inBracket += 1
      continue
    }
    if (current === ']') {
      inBracket = Math.max(0, inBracket - 1)
      continue
    }
    if (current === ch && inBracket === 0) count += 1
  }
  return count
}

/**
 * 拆掉 epubcfi(...) 外壳并做严格语法检查。
 * 不做这一步的话，vendor 的 parse 连 `epubcfi(` 都能「解析成功」返回 [[]]。
 */
function unwrapStrict(cfi) {
  if (typeof cfi !== 'string') {
    throw cfiError(CODE.PARSE, 'CFI 必须是字符串')
  }
  const text = cfi.trim()
  const match = CFI_WRAPPER.exec(text)
  if (!match) {
    throw cfiError(CODE.PARSE, 'CFI 必须整串形如 epubcfi(...)，首尾不许有其它字符')
  }
  const inner = match[1].trim()
  if (!inner) throw cfiError(CODE.PARSE, 'epubcfi() 里是空的')
  if (inner.includes('(') || inner.includes(')')) {
    throw cfiError(CODE.PARSE, 'epubcfi() 内部不许再出现括号（括号不配平）')
  }
  let depth = 0
  for (const ch of inner) {
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth < 0) throw cfiError(CODE.PARSE, '断言方括号 ] 多于 [')
    }
  }
  if (depth !== 0) throw cfiError(CODE.PARSE, '断言方括号没有闭合')
  const bangs = countChar(inner, '!')
  if (bangs !== 1) {
    throw cfiError(CODE.PARSE, `必须是恰好一个 '!'（spine 间接步），实际 ${bangs} 个`)
  }
  // 逗号数只有两种合法值：0 = 点 CFI（单路径），2 = 区间 CFI（parent,start,end）。
  // 写成 1 或 >=3 都拼不出合法区间；vendor 的 parse 会把它们当「两个端点」硬解，
  // 结果要么抛 TypeError 要么静默截断，所以在 L1 就挡掉。
  const commas = countChar(inner, ',')
  if (commas !== 0 && commas !== 2) {
    throw cfiError(CODE.PARSE, `区间 CFI 必须恰好两个逗号（parent,start,end），实际 ${commas} 个`)
  }
  return inner
}

/** '!' 左右切分。两者都不允许为空。 */
function splitInner(inner) {
  const at = inner.indexOf('!')
  const prefix = inner.slice(0, at).trim()
  const local = inner.slice(at + 1).trim()
  if (!prefix.startsWith('/')) throw cfiError(CODE.PARSE, `'!' 左半段必须以 / 开头`)
  if (!local.startsWith('/')) throw cfiError(CODE.PARSE, `'!' 右半段必须以 / 开头`)
  return { prefix, local }
}

/**
 * 校验 spine 前缀并取出 { index, id }。
 * 前缀必须是纯元素步：`/6/2`、`/6/4`、`/6/2/4`（步数成对，最后一维是 itemref）。
 */
function prefixIdentity(prefix) {
  const groups = CFI.parse(`epubcfi(${prefix})`)
  if (!Array.isArray(groups) || groups.length !== 1) {
    throw cfiError(CODE.PARSE, 'spine 前缀必须是单一路径（不许有第二个 !）')
  }
  const parts = groups[0]
  if (!parts || parts.length < 2 || parts.length % 2 !== 0) {
    throw cfiError(CODE.PARSE, 'spine 前缀必须是成对的元素步，形如 /6/2')
  }
  for (const part of parts) {
    if (!Number.isInteger(part.index) || part.index < 0) {
      throw cfiError(CODE.PARSE, 'spine 前缀里出现了非法索引')
    }
    if (part.offset != null) throw cfiError(CODE.PARSE, 'spine 前缀上不许带字符偏移')
  }
  const last = parts[parts.length - 1]
  if (last.index === 0 || last.index % 2 !== 0) {
    throw cfiError(CODE.PARSE, 'spine 前缀最后一步必须是偶数索引（元素步）')
  }
  if (parts[0].index !== SPINE_STEP) {
    throw cfiError(CODE.PARSE, `spine 前缀必须从 /${SPINE_STEP} 起算`)
  }
  const index = last.index / 2 - 1
  if (!Number.isInteger(index) || index < 0) {
    throw cfiError(CODE.PARSE, 'spine 前缀推导出的 spine 序号非法')
  }
  return { index, id: last.id ?? null }
}

/** 校验 local 段结构，返回可直接交给 vendor 的两种形态。 */
function parseLocal(local) {
  const parsed = CFI.parse(`epubcfi(${local})`)
  if (countChar(local, ',') === 0) {
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw cfiError(CODE.PARSE, '点 CFI 的 local 必须是单一路径')
    }
    const parts = parsed[0]
    if (!parts || parts.length === 0) throw cfiError(CODE.PARSE, 'local 路径里没有任何 step')
    return { isRange: false, point: [parts], paths: [parts] }
  }
  const ok = parsed
    && Array.isArray(parsed.parent) && parsed.parent.length > 0
    && Array.isArray(parsed.start) && parsed.start.length > 0
    && Array.isArray(parsed.end) && parsed.end.length > 0
    && parsed.start[0]?.length > 0 && parsed.end[0]?.length > 0
    && parsed.parent[parsed.parent.length - 1]?.length > 0
  if (!ok) {
    throw cfiError(CODE.PARSE, '区间 CFI 必须两端齐全（父路径 + start + end），缺一端即为畸形')
  }
  return {
    isRange: true,
    parsed,
    // 区间 CFI 的「每条 local path」是三个独立单元：公共父路径、start 尾部、end 尾部。
    // id 断言各自只允许出现在自己那一节的最后一段——父路径以 [z] 收尾是合法的，
    // 也正是 docs/03 §一 里 epubcfi(/4/2[p1],/1:3,/1:8) 的写法。
    paths: [parsed.parent[parsed.parent.length - 1], parsed.start[0], parsed.end[0]],
  }
}

/* --------------------------------------------------- 文档身份（前缀一致性） */

/**
 * 读出「当前章节文档是谁」。
 *
 * 渠道一：文档 URL 的 search 参数（真实阅读器就是这个形状：
 *   /api/dsh-reading/chapter?book=<hash>&href=<urlencoded>[&spine=<i>][&idref=<x>]）。
 * 渠道二：documentElement 上的 data-dsh-reading-spine / -idref（只是属性，不增删节点，
 *   因此不影响 CFI 索引）。
 *
 * 为什么需要它：CFI 前缀只带 spine 序号与 idref，`href` 必须靠 spine 表映射；
 * validate() 的签名（docs/05 §5.2）不带 spine 表，所以只能靠文档自报身份。
 * 两处都没有时**跳过前缀判定**——宁可少判一种，也不许把「不知道」判成失败。
 */
function documentIdentity(doc) {
  const identity = { href: null, spine: null, idref: null }
  const raw = doc?.URL || doc?.documentURI || ''
  if (raw && raw !== 'about:blank') {
    try {
      const params = new URL(raw).searchParams
      if (params.has('href')) identity.href = params.get('href')
      if (params.has('spine')) {
        const n = Number(params.get('spine'))
        if (Number.isInteger(n) && n >= 0) identity.spine = n
      }
      if (params.has('idref')) identity.idref = params.get('idref')
    } catch {
      // URL 解析失败不是锚点错误：只是拿不到身份，跳过前缀判定。
    }
  }
  const root = doc?.documentElement
  if (root && typeof root.getAttribute === 'function') {
    const spine = root.getAttribute('data-dsh-reading-spine')
    if (spine != null && /^\d+$/.test(spine)) identity.spine = Number(spine)
    const idref = root.getAttribute('data-dsh-reading-idref')
    if (idref != null && idref !== '') identity.idref = idref
    const href = root.getAttribute('data-dsh-reading-href')
    if (href != null && href !== '') identity.href = href
  }
  return identity
}

function assertPrefixMatches(prefixInfo, doc) {
  const identity = documentIdentity(doc)
  if (identity.spine != null && identity.spine !== prefixInfo.index) {
    throw cfiError(
      CODE.PREFIX,
      `CFI 前缀指向 spine[${prefixInfo.index}]，当前文档声明自己是 spine[${identity.spine}]`,
    )
  }
  if (identity.idref != null && prefixInfo.id != null && identity.idref !== prefixInfo.id) {
    throw cfiError(
      CODE.PREFIX,
      `CFI 前缀 idref 是 ${prefixInfo.id}，当前文档声明自己是 ${identity.idref}`,
    )
  }
}

/* ----------------------------------------------------------------- L2 语义层 */

const mapResolveError = error => (error?.name === 'IndexSizeError'
  ? cfiError(CODE.OFFSET, error.message, error)
  : cfiError(CODE.RESOLVE, error?.message ?? String(error), error))

/** 用 vendor 解析一个点（groups 数组），把它的异常翻译成契约里的码。 */
function resolvePoint(doc, groups, filter) {
  try {
    return CFI.toRange(doc, groups, filter)
  } catch (error) {
    throw mapResolveError(error)
  }
}

/** 落到 #document 或 documentElement 上，就是「跨文档 / 越界」的典型特征。 */
function isCrossDocument(node, doc) {
  if (!node) return true
  if (node.nodeType === 9) return true
  if (node.nodeType === 1 && node === doc.documentElement) return true
  if (node.ownerDocument && node.ownerDocument !== doc) return true
  return false
}

/** 显式校验偏移没有越过容器长度（vendor 抛的是 IndexSizeError，这里再挡一次）。 */
function assertOffsetInRange(node, offset) {
  if (!node) throw cfiError(CODE.RESOLVE, '解析出的容器节点为空')
  const isText = node.nodeType === 3 || node.nodeType === 4
  const limit = isText ? node.nodeValue.length : node.childNodes?.length
  if (typeof limit !== 'number') {
    throw cfiError(CODE.RESOLVE, `容器节点类型 ${node.nodeType} 不支持偏移定位`)
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > limit) {
    throw cfiError(CODE.OFFSET, `偏移 ${offset} 超出容器长度 ${limit}`)
  }
}

/* ------------------------------------------- 结构预检（让失败码可确定） */

const isTextNode = node => node.nodeType === 3 || node.nodeType === 4

/**
 * 按规范列出某元素的规范化子节点槽位。
 *
 * 为什么客户端还要有一份：vendor 的 `partsToNode` 在两种情况下**静默成功**——
 *   1. 路径下降到 `before/after/first/last` 虚拟槽位后还有剩余步：它直接 return，忽略余步；
 *   2. 文本块偏移超出块总长：`partsToNode` 返回 undefined，随后抛的是 TypeError 而不是 IndexSizeError。
 * 这两种都没法从异常里可靠区分（docs/03 §三 B5 vs B3/B4 要判成不同的码），
 * 所以在交给 vendor 之前先用规范模型走一遍结构，把「索引越界」「偏移越界」「在文本块上继续下降」
 * 分成三个确定的码。
 *
 * 这份模型**不参与定位**：定位仍由 vendor 完成，这里只负责否决。
 */
function childSlots(element, filter) {
  // **必须过 filter，而且必须按 vendor 的语义展开。** 覆盖层与阅读器会往章节里塞
  // `<style data-dsh-reading-injected>`，它是个元素节点，而且**自带一个文本子节点**
  // （就是那段 CSS）。vendor 的 `getChildNodes` 对 FILTER_SKIP 的处理是
  // `return getChildNodes(node, filter)` —— 把这个节点的孩子**拼进父列表**，
  // 不是整棵丢掉。所以这里的模型也必须递归展开：否则 §3 的模型少算/多算槽位，
  // 与 vendor 的索引不一致，症状是对一份**正常** CFI 报 cfi_resolve_failed。
  // FILTER_REJECT 才是「整棵丢掉」，两条分支都要有（vendor 那边也分两种）。
  const raw = collectIndexedNodes(element, filter)
  const slots = []
  for (const node of raw) {
    const last = slots[slots.length - 1]
    if (!last) {
      slots.push(isTextNode(node) ? { kind: 'chunk', nodes: [node] } : { kind: 'element', node })
    } else if (isTextNode(node)) {
      if (last.kind === 'chunk') last.nodes.push(node)
      else slots.push({ kind: 'chunk', nodes: [node] })
    } else {
      if (last.kind === 'element') slots.push({ kind: 'chunk', nodes: [] })
      slots.push({ kind: 'element', node })
    }
  }
  if (slots[0]?.kind === 'element') slots.unshift({ kind: 'first' })
  if (slots[slots.length - 1]?.kind === 'element') slots.push({ kind: 'last' })
  slots.unshift({ kind: 'before' })
  slots.push({ kind: 'after' })
  return slots
}

/**
 * 把某个元素的「参与索引」的子节点摊平，逐字对齐 vendor 的 `getChildNodes`。
 *
 * 三种裁决（NodeFilter 常量）：
 *   - ACCEPT(1)：收进来；
 *   - SKIP(3)：**展开它的孩子**再收（注入的 `<style>` 走这条，它的 CSS 文本
 *     因此会并进相邻文本块——这既是 vendor 的行为，也是 `chunkLength` 必须照算的部分）；
 *   - REJECT(2)：整棵丢掉。
 *
 * 递归而不是一层：注入点将来可能是个包裹元素（`<div data-dsh-reading-injected>`
 * 里放锚点标记），一层展开会在那种情况下与 vendor 分叉。
 */
function collectIndexedNodes(element, filter) {
  const out = []
  for (const child of Array.from(element.childNodes)) {
    if (!isTextNode(child) && child.nodeType !== 1) continue
    const verdict = typeof filter === 'function' ? filter(child) : 1
    if (verdict === REJECT_NODE) continue
    if (verdict === SKIP_NODE) {
      out.push(...collectIndexedNodes(child, filter))
      continue
    }
    out.push(child)
  }
  return out
}

const VIRTUAL = new Set(['before', 'after', 'first', 'last'])

/**
 * id 断言只允许出现在「有意义」的位置（docs/01 §3.4.2 / docs/03 §四）。
 *
 * 背景：vendor 的 `partsToNode` 只读**最后一段**的 id，其它位置的断言既不校验也不报错。
 * 但 vendor 自己的 `collapse()` 会产出 `epubcfi(/4/2[p1]/1:3)` —— 此时 `[p1]` 位于倒数第二段
 * （docs/03 §八 实测）。那是**合法且有信息量**的：它断言「这段文字属于 p#p1」。
 * 而 `cfiStart` / `cfiEnd` 正是这个形态，所以不能一刀切禁掉。
 *
 * 采用的规则（两条都满足「写出来的断言确实会被用到」）：
 *   1. 最后一段可以带 id（`/4/2[p1]`、`/6/2[ch1]`）；
 *   2. 倒数第二段可以带 id，但**仅当**最后一段是带偏移的字符数据步
 *      （`/4/2[p1]/1:3`，即 collapse 形态）。
 * 其余位置（更深的中间段，如 `[outer]/2[mid]/2[leaf]`）一律拒绝：它们纯属噪音，
 * 却让记录看起来比实际更可靠。静默接受等于把假象留在库里。
 */
function assertNoMiddleId(group) {
  const last = group.length - 1
  const lastHasOffset = group[last]?.offset != null
  for (let i = 0; i < group.length; i++) {
    const id = group[i]?.id
    if (!id) continue
    if (i === last) continue
    if (i === last - 1 && lastHasOffset) continue
    throw cfiError(
      CODE.RESOLVE,
      `CFI 路径中间段不允许 id 断言（第 ${i + 1} 段带了 [${id}]）；`
      + '断言只能出现在最后一段，或紧挨字符偏移步的父级',
    )
  }
}

const chunkLength = slot => slot.nodes.reduce((sum, node) => sum + node.nodeValue.length, 0)

/**
 * 结构预检：确认这条 local path 在本文档上「走得通」，并且偏移没有越界。
 * 只否决，不定位；失败抛 cfi_resolve_failed / cfi_offset_out_of_bounds。
 *
 * vendor 的 `partsToNode` 在两种情况下**静默成功**，而这两种必须判成不同的码：
 *   1. 路径落到 before/after/first/last 虚拟槽位后还有剩余步 —— 它直接 return，忽略余步；
 *   2. 文本块偏移超出块总长 —— 它返回 undefined，随后抛的是 TypeError 而不是 IndexSizeError。
 * 靠异常信息区分不可靠，所以在交给 vendor 之前先用规范模型走一遍。
 *
 * **filter 必须传进来。** 这个模型算的是「索引 → 节点」的映射，而 vendor 算的时候是带
 * filter 的；两边若一边过滤、一边不过滤，注入的 `<style>` 会让同一份正常 CFI 在某些
 * 父节点下多算一格，判定就与定位矛盾了。
 *
 * 与 vendor 对齐：末段带 id 断言且该 id 在文档里存在时**跳过索引检查**
 * （id 短路优先于索引，docs/03 §四）。
 */
function checkStructure(doc, groups, filter) {
  for (const group of groups) {
    let node = doc.documentElement
    for (let i = 0; i < group.length; i++) {
      const part = group[i]
      const isLast = i === group.length - 1
      if (isLast && part.id && typeof doc.getElementById === 'function' && doc.getElementById(part.id)) {
        return
      }
      const slots = childSlots(node, filter)
      const slot = slots[part.index]
      if (!slot) {
        throw cfiError(CODE.RESOLVE, `路径 /${group.map(p => p.index).join('/')} 在索引 ${part.index} 处越界`)
      }
      if (VIRTUAL.has(slot.kind)) {
        if (!isLast) {
          throw cfiError(
            CODE.RESOLVE,
            `路径 /${group.map(p => p.index).join('/')} 落到虚拟槽位 ${slot.kind} 后仍有剩余步`,
          )
        }
        return
      }
      if (slot.kind === 'element') {
        if (isLast) {
          if (part.offset != null) {
            throw cfiError(CODE.RESOLVE, '元素步上不许带字符偏移')
          }
          return
        }
        node = slot.node
        continue
      }
      if (!isLast) {
        throw cfiError(CODE.RESOLVE, '文本块上不能继续下降')
      }
      if (part.offset != null) {
        const total = chunkLength(slot)
        if (!Number.isInteger(part.offset) || part.offset < 0 || part.offset > total) {
          throw cfiError(CODE.OFFSET, `偏移 ${part.offset} 超出文本块长度 ${total}`)
        }
      }
      return
    }
  }
}

/** a 是否在 b 之前（文档序）。跨文档或不可比时返回 false，交给别的检查处理。 */
function isBefore(a, b) {
  if (!a || !b || a === b) return false
  try {
    return Boolean(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */)
  } catch {
    return false
  }
}

/**
 * L1 + L2 全套：把完整 CFI 解析成 Range。
 * 失败抛 CfiError（码见 §5.2），绝不返回 null / 折叠兜底。
 */
function analyze(win, doc, cfi) {
  if (!doc || typeof doc.createRange !== 'function') {
    throw cfiError(CODE.RESOLVE, 'doc 不是可用的 Document')
  }
  const inner = unwrapStrict(cfi)                       // L1
  const { prefix, local } = splitInner(inner)           // L1
  const prefixInfo = prefixIdentity(prefix)             // L1
  const parsedLocal = parseLocal(local)                 // L1（含「区间必须两端齐全」）
  assertPrefixMatches(prefixInfo, doc)                  // L2 前缀一致性

  const filter = makeFilter(win)
  const startGroups = parsedLocal.isRange
    ? CFI.collapse(parsedLocal.parsed, false)
    : parsedLocal.point
  const endGroups = parsedLocal.isRange
    ? CFI.collapse(parsedLocal.parsed, true)
    : parsedLocal.point

  for (const path of parsedLocal.paths) assertNoMiddleId(path)
  checkStructure(doc, startGroups, filter)
  checkStructure(doc, endGroups, filter)

  const startAt = resolvePoint(doc, startGroups, filter)
  const endAt = resolvePoint(doc, endGroups, filter)

  // 起止倒置：vendor 会**静默折叠**（docs/03 §三 B2），必须在这里显式判掉。
  if (startAt.startContainer === endAt.startContainer) {
    if (startAt.startOffset > endAt.startOffset) {
      throw cfiError(
        CODE.INVERTED,
        `起止倒置：同节点内 ${startAt.startOffset} > ${endAt.startOffset}`,
      )
    }
  } else if (isBefore(endAt.startContainer, startAt.startContainer)) {
    throw cfiError(CODE.INVERTED, '起止倒置：end 在文档序上早于 start')
  }

  // 跨文档 / 落到根节点：vendor 会「解析成功」并返回空文本（docs/03 §三 B6）。
  if (isCrossDocument(startAt.startContainer, doc)) {
    throw cfiError(CODE.CROSS_DOC, '解析结果落在 #document 或 documentElement 上')
  }
  if (isCrossDocument(endAt.startContainer, doc)) {
    throw cfiError(CODE.CROSS_DOC, '解析结果落在 #document 或 documentElement 上')
  }
  assertOffsetInRange(startAt.startContainer, startAt.startOffset)
  assertOffsetInRange(endAt.startContainer, endAt.startOffset)

  const range = doc.createRange()
  try {
    range.setStart(startAt.startContainer, startAt.startOffset)
    range.setEnd(endAt.startContainer, endAt.startOffset)
  } catch (error) {
    throw mapResolveError(error)
  }
  return { range, prefixInfo, isRange: parsedLocal.isRange }
}

/* ------------------------------------------------------------------ 生成侧 */

const assertSpine = spine => {
  const index = spine?.index
  if (!Number.isInteger(index) || index < 0) {
    throw cfiError(CODE.PARSE, 'spine.index 必须是 >= 0 的整数')
  }
  return index
}

/** spine → 前缀路径 `/6/<2*(index+1)>[idref]`。 */
function prefixFromSpine(spine) {
  const index = assertSpine(spine)
  const idref = spine && typeof spine.idref === 'string' && spine.idref !== ''
    ? `[${escapeCfi(spine.idref)}]`
    : ''
  return `/${SPINE_STEP}/${2 * (index + 1)}${idref}`
}

/**
 * 选区 → 完整 CFI（含 spine 前缀）。
 *
 * 失败行为：Range 无效、spine.index 非法、选区落在不可索引的位置时抛
 * `cfi_resolve_failed` / `cfi_parse_failed`。
 * 折叠选区**不在这里判错**（bookmark 需要它）：只返回无逗号的点 CFI，
 * 由调用方按记录类型决定要不要拒收（highlight 见 validate）。
 *
 * @param {Window} win 章节文档所属窗口
 * @param {Range} range 真实 DOM Range
 * @param {{index:number, idref?:string}} spine 0 起的 spine 序号
 * @returns {string} `epubcfi(/6/<step>[idref]!/<local>)`
 */
export function fromRange(win, range, spine) {
  if (!range || !range.startContainer || !range.endContainer) {
    throw cfiError(CODE.RESOLVE, 'fromRange 需要真实的 Range，收到的不是 Range')
  }
  const prefix = prefixFromSpine(spine)
  const filter = makeFilter(win)
  let local
  try {
    local = CFI.fromRange(range, filter)
  } catch (error) {
    throw mapResolveError(error)
  }
  const inner = partsToInner(CFI.parse(local))
  if (!range.collapsed && !hasUnescapedComma(inner)) {
    // vendor 对异常 Range 会退化成点 CFI；静默接受会丢一半区间。
    throw cfiError(CODE.RESOLVE, '非折叠选区退化成点 CFI，拒绝保存')
  }
  return joinCfi(prefix, inner)
}

/**
 * 序列化结果里是否存在**未转义**的顶层逗号（= 真正的区间 CFI）。
 *
 * 不能直接 `inner.includes(',')`：CFI 的转义规则是 `^` 前缀，id 断言里的逗号
 * 会被写成 `^,`。于是 `epubcfi(/6/4[chap^,one]!/4/2/1:0)` 这种合法点 CFI
 * 会被误判成区间，`fromRange` 的「退化保护」就永远不触发——恰恰在最该拦的
 * 时候放行。反过来，`^^` 表示字面量 `^`，扫描时要一并跳过两字符。
 */
function hasUnescapedComma(inner) {
  // 方括号里是 id / text 断言：`[p^,1]` 的逗号是转义过的字面量，`[a,b]` 这种
  // text 断言里的裸逗号也不是区间分隔符。断言内部整段跳过，别当成区间。
  let inBracket = false
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '^') {
      i += 1
      continue
    }
    if (inBracket) {
      if (ch === ']') inBracket = false
      continue
    }
    if (ch === '[') {
      inBracket = true
      continue
    }
    if (ch === ',') return true
  }
  return false
}

/* ------------------------------------------------------------------ 解析侧 */

/**
 * 完整 CFI + 当前章节文档 → Range。
 *
 * 内部顺序：L1 语法 → L2 语义（前缀一致 / 解析 / 倒置 / 跨文档 / 偏移）→ 构造 Range。
 * 任何一步失败抛 `CfiError`，**不返回 null**。
 * 高亮专用的「不许零宽」判定在 validate()，不在这里（书签本来就是零宽的）。
 *
 * @param {Window} win 章节文档所属窗口
 * @param {Document} doc 章节文档
 * @param {string} cfi 完整 CFI（必须恰好一个 '!'）
 * @returns {Range}
 */
export function toRange(win, doc, cfi) {
  return analyze(win, doc, cfi).range
}

/**
 * 三层校验。
 *
 * L1 语法：parse 不抛 + 恰好一个 '!' + 区间两端齐全 → `cfi_parse_failed`
 * L2 语义：前缀一致、能解析成 Range、不倒置、不跨文档、偏移不越界 →
 *          `cfi_prefix_mismatch` / `cfi_resolve_failed` / `cfi_range_inverted` /
 *          `cfi_cross_document` / `cfi_offset_out_of_bounds`，
 *          以及「记录是 highlight 却解析成零宽」→ `cfi_collapsed_highlight`
 * L3 内容：解析出的文本与 `expectedFingerprint` 比对，不符 → `fingerprint_drift`
 *
 * L3 的口径（与 docs/05 §4.2 的三态对齐）：head / tail / len 任一不等 → 判 fail（本函数返回
 * `fingerprint_drift`）；三者全等则本函数判 ok。`hash` 的比对需要 sha256，而本文件只允许
 * import vendor（契约要求），所以 ok / drifted 的细分由调用方用 `contract.compareFingerprint()`
 * 决定——drifted 仍然是「可渲染」，不是隔离，因此不属于失败码。
 *
 * 「是否 highlight」不靠参数传：`expectedFingerprint` 存在即代表这是带文本锚点的记录
 * （highlight / note），零宽即为畸形。书签不带指纹，不会走到这条判定。
 *
 * @param {Window} win
 * @param {Document} doc
 * @param {string} cfi
 * @param {{head:string,tail:string,len:number,hash:string}|null} [expectedFingerprint]
 * @returns {{ok:boolean, level:'L1'|'L2'|'L3', code?:string, detail?:string}}
 */
export function validate(win, doc, cfi, expectedFingerprint) {
  let analysis
  try {
    analysis = analyze(win, doc, cfi)
  } catch (error) {
    if (isCfiError(error)) {
      return {
        ok: false,
        level: LEVEL_OF[error.code] ?? 'L2',
        code: error.code,
        detail: error.detail,
      }
    }
    return {
      ok: false,
      level: 'L2',
      code: CODE.RESOLVE,
      detail: error?.message ?? String(error),
    }
  }

  const { range } = analysis
  if (expectedFingerprint) {
    if (range.collapsed) {
      return {
        ok: false,
        level: 'L2',
        code: CODE.COLLAPSED,
        detail: '记录带文本指纹（highlight / note），但解析出的区间是零宽',
      }
    }
    const actual = textOfRange(range)
    const drift = compareShape(actual, expectedFingerprint)
    if (drift) {
      return { ok: false, level: 'L3', code: CODE.DRIFT, detail: drift }
    }
    return { ok: true, level: 'L3' }
  }
  return { ok: true, level: 'L2' }
}

/** L3 的形状比对（head/tail/len）。返回 null 表示通过，否则返回失败原因。 */
function compareShape(text, expected) {
  if (!expected || typeof expected !== 'object') return 'expectedFingerprint 不是对象'
  const { head, tail, len } = expected
  if (typeof head !== 'string' || typeof tail !== 'string' || typeof len !== 'number') {
    return 'expectedFingerprint 缺少 head/tail/len，无法比对'
  }
  if (text.length !== len) return `文本长度 ${text.length} ≠ 记录里的 ${len}`
  if (text.slice(0, 48) !== head) return '文本头部 48 个 code unit 与记录不符'
  if (text.slice(Math.max(0, text.length - 32)) !== tail) return '文本尾部 32 个 code unit 与记录不符'
  return null
}

/* -------------------------------------------------------------------- 工具 */

/**
 * 从完整 CFI 推导 spine 序号（0 起）。
 * 直接 `parts.at(-1).at(-1)` 对区间 CFI 会拿到 end 段，所以这里走 prefixIdentity。
 * 失败抛 `cfi_parse_failed`。
 *
 * @param {string} cfi
 * @returns {number}
 */
export function spineIndexFromCfi(cfi) {
  const inner = unwrapStrict(cfi)
  return prefixIdentity(splitInner(inner).prefix).index
}

/**
 * 取 CFI 前缀里 spine 间接步上的 id 断言（OPF 里的 idref）。
 *
 * 注意：返回的是 **idref，不是 href**。docs/05 §5.2 定的名字如此；要判断「这一章是不是
 * 记录里那一章」，调用方还得用 meta.spine 把 idref/spineIndex 映射成 href。
 *
 * @param {string} cfi
 * @returns {string|null}
 */
export function chapterHrefFromCfi(cfi) {
  const inner = unwrapStrict(cfi)
  return prefixIdentity(splitInner(inner).prefix).id
}

/**
 * 组装完整 CFI，并**校验恰一个 '!'**。
 * 参数可以带 `epubcfi()` 外壳，也可以只给路径；内部统一归一化。
 *
 * @param {string} prefix 形如 `/6/4[ch1]`
 * @param {string} localRange 形如 `/4/2[p1],/1:3,/1:8`
 * @returns {string}
 */
export function joinCfi(prefix, localRange) {
  const normalize = value => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw cfiError(CODE.PARSE, 'joinCfi 的两段都必须是字符串')
    }
    const trimmed = value.trim()
    const match = CFI_WRAPPER.exec(trimmed)
    return (match ? match[1] : trimmed).trim()
  }
  const left = normalize(prefix)
  const right = normalize(localRange)
  if (!left.startsWith('/') || !right.startsWith('/')) {
    throw cfiError(CODE.PARSE, 'joinCfi 的两段都必须以 / 开头')
  }
  if (left.includes('!') || right.includes('!')) {
    throw cfiError(CODE.PARSE, "joinCfi 的两段都不许自带 '!'")
  }
  const joined = `epubcfi(${left}!${right})`
  if (countChar(joined, '!') !== 1) {
    throw cfiError(CODE.PARSE, "组装结果必须恰好一个 '!'")
  }
  return joined
}

/**
 * 拆成 { prefix, local } 两段（都不含 `epubcfi()` 外壳）。
 * 与 schema 的 `cfiPartial` 同构：local 以 `/` 开头、不含 `!`。
 * 失败（不是完整 CFI、`!` 不是恰好一个）抛 `cfi_parse_failed`。
 *
 * @param {string} cfi
 * @returns {{prefix:string, local:string}}
 */
export function splitCfi(cfi) {
  return splitInner(unwrapStrict(cfi))
}

/**
 * 把区间 CFI 折叠成某一端的**点路径**（partial CFI 形态），用于 `cfiStart` / `cfiEnd`。
 *
 * 输出形态与 vendor 的 `collapse()` 一致（docs/03 §八）：
 *   epubcfi(/6/4[ch1]!/4/2[p1],/1:3,/1:8)
 *     → collapseLocal(cfi, false) = "/4/2[p1]/1:3"
 *     → collapseLocal(cfi, true)  = "/4/2[p1]/1:8"
 *
 * 为什么存这个而不是只存公共父路径：`cfiPartial` 的语义是「这一端的位置」，
 * 只留 `/4/2[p1]` 就把「第几个字符」丢了，进度恢复会退化成整段定位。
 *
 * 点 CFI 传入时两端相同（返回该点路径），这是书签的正常用法。
 * 失败（不是完整 CFI / 语法畸形）抛 `cfi_parse_failed`。
 *
 * @param {string} cfi 完整 CFI（恰好一个 '!'）
 * @param {boolean} [toEnd=false] true = 取区间右端，false = 取左端
 * @returns {string} 以 `/` 开头、不含 `!`、不含逗号的 partial CFI
 */
export function collapseLocal(cfi, toEnd = false) {
  const inner = unwrapStrict(cfi)
  const { local } = splitInner(inner)
  if (countChar(local, ',') === 0) return local.replace(/\s+/g, '')
  const parsed = CFI.parse(`epubcfi(${local})`)
  if (!parsed?.parent?.length || !parsed?.start?.length || !parsed?.end?.length) {
    throw cfiError(CODE.PARSE, '区间 CFI 必须两端齐全，无法折叠')
  }
  const collapsed = CFI.collapse(parsed, toEnd)
  // 这里**不能**走 partsToInner：那是「生成新 CFI」用的序列化，会按 docs/03 §四 丢掉中间段 id。
  // 折叠是「把已有区间还原成它自己的端点路径」，必须原样保留 `[p1]`——否则 cfiStart 就丢了
  // 父路径上的 id 断言，与 cfi.cfi 对不上。vendor 的 partToString 已经做了正确转义。
  const text = collapsed.map(group => group.map(partToString).join('')).join('!')
  if (!text.startsWith('/') || text.includes('!') || countChar(text, ',') !== 0) {
    throw cfiError(CODE.PARSE, `折叠结果不是单一点路径：${text}`)
  }
  return text
}

/**
 * 取 Range 的纯文本。CFI 的偏移是 UTF-16 code unit，Range#toString 也是，
 * 所以这里不做任何空白归一化——归一化会让 L3 假阴性。
 *
 * @param {Range} range
 * @returns {string}
 */
export function textOfRange(range) {
  if (!range || typeof range.toString !== 'function') {
    throw cfiError(CODE.RESOLVE, 'textOfRange 需要真实的 Range')
  }
  return range.toString()
}
