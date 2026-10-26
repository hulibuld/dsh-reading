/**
 * 规范化子节点模型 + 树路径解析（golden 专用，**不复用 vendor**）。
 *
 * 为什么在 golden 里再写一遍：向量里的 `startPath`（`/4/2/2/1`）是独立真值。
 * 如果这个解析器复用 vendor 的 `indexChildNodes`，那么「路径对」和「CFI 对」就变成
 * 同一个实现的两次自我确认，测不出偏一位的错。这里按 EPUB CFI 规范的文字重写一遍：
 *
 *   - 只有元素（nodeType 1）与字符数据（3 文本 / 4 CDATA）参与索引，注释（8）忽略；
 *   - 结果永远呈 [元素, 文本块, 元素, 文本块, ..., 元素] 的形状；
 *   - 相邻的多个字符数据节点合并成**一个**文本块，偏移跨节点累加；
 *   - 首元素之前、末元素之后各补一个「虚拟块」（first / last）；
 *   - 再在最前（0）与最后（n+1）补 before / after 虚拟位置。
 *
 * 于是 `indexedChildren(el)[2i]` 是第 i 个元素，`[2i+1]` 是它后面的文本块。
 */

import { JSDOM } from 'jsdom'

const isText = node => node.nodeType === 3 || node.nodeType === 4
const isElement = node => node.nodeType === 1

/**
 * 按 CFI 规范列出某元素的子节点槽位。
 * 返回数组，每项是 `{ kind:'element'|'chunk'|'first'|'last'|'before'|'after', nodes }`。
 *
 * @param {Element} element
 */
export function indexedChildren(element) {
  const raw = Array.from(element.childNodes).filter(n => isText(n) || isElement(n))
  const slots = []
  for (const node of raw) {
    const last = slots[slots.length - 1]
    if (!last) {
      slots.push(isText(node) ? { kind: 'chunk', nodes: [node] } : { kind: 'element', nodes: [node] })
    } else if (isText(node)) {
      if (last.kind === 'chunk') last.nodes.push(node)
      else slots.push({ kind: 'chunk', nodes: [node] })
    } else {
      if (last.kind === 'element') slots.push({ kind: 'chunk', nodes: [] })
      slots.push({ kind: 'element', nodes: [node] })
    }
  }
  if (slots[0]?.kind === 'element') slots.unshift({ kind: 'first', nodes: [] })
  if (slots[slots.length - 1]?.kind === 'element') slots.push({ kind: 'last', nodes: [] })
  slots.unshift({ kind: 'before', nodes: [] })
  slots.push({ kind: 'after', nodes: [] })
  return slots
}

/** 文本块的纯文本（用于算 offsets 与 excerpt）。 */
export const chunkText = chunk => chunk.nodes.map(n => n.nodeValue).join('')

/**
 * 把一个「规范化路径」解析成 { container, offset }。
 *
 * 路径从 documentElement 的子节点开始计（不含 documentElement 自身）；
 * 例如 body 是 `/4`，body 的第 2 个元素是 `/4/2`。
 *
 * @param {Element} root 通常是 document.documentElement
 * @param {number[]} steps 形如 [4, 2, 2, 1]
 * @param {number} offset 最后一步若是文本块，则是块内合并偏移
 * @returns {{container: Node, offset: number, chunk: object|null}}
 */
export function resolvePath(root, steps, offset = 0) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('resolvePath: 路径不能为空')
  let current = root
  let chunk = null
  for (let i = 0; i < steps.length; i++) {
    const index = steps[i]
    const slots = indexedChildren(current)
    const slot = slots[index]
    if (!slot) {
      throw new Error(`resolvePath: ${steps.slice(0, i + 1).join('/')} 越界（该层只有 ${slots.length} 个槽位）`)
    }
    const isLast = i === steps.length - 1
    if (slot.kind === 'before' || slot.kind === 'after' || slot.kind === 'first' || slot.kind === 'last') {
      if (!isLast) throw new Error(`resolvePath: 虚拟槽位 ${slot.kind} 不能继续下降`)
      // 虚拟槽位不用于向量（高亮端点必须落在字符数据上）
      throw new Error(`resolvePath: 路径落在虚拟槽位 ${slot.kind}，向量只接受字符数据端点`)
    }
    if (slot.kind === 'element') {
      if (isLast) throw new Error('resolvePath: 路径落在元素上，向量只接受字符数据端点')
      current = slot.nodes[0]
      continue
    }
    // 文本块
    if (!isLast) throw new Error('resolvePath: 文本块不能继续下降')
    chunk = slot
    let remaining = offset
    for (const node of slot.nodes) {
      const length = node.nodeValue.length
      if (remaining <= length) return { container: node, offset: remaining, chunk: slot }
      remaining -= length
    }
    throw new Error(`resolvePath: 偏移 ${offset} 超出文本块长度 ${chunkText(slot).length}`)
  }
  throw new Error('resolvePath: 未走到文本块')
}

/** 路径字符串 `/4/2/2/1` → [4,2,2,1]。 */
export function parsePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`parsePath: 路径必须以 / 开头，收到 ${String(path)}`)
  }
  return path.slice(1).split('/').map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`parsePath: 非法索引 ${part}`)
    return Number(part)
  })
}

/**
 * 用 xhtml 字符串造一个「像真实章节」的 jsdom 文档。
 *
 * URL 里带 href/spine/idref，是因为 `validate()` 的签名不带 spine 表（docs/05 §5.2），
 * 章节文档只能靠 URL 自报身份，前缀一致性才判得出来。这正是真实阅读器里
 * `/api/dsh-reading/chapter?book=…&href=…` 的形状。
 *
 * @param {string} html XHTML 文本
 * @param {{bookHash?:string, href:string, spine:number, idref:string}} identity
 */
export function loadChapter(html, identity) {
  const search = new URLSearchParams({
    book: identity.bookHash ?? 'f'.repeat(64),
    href: identity.href,
    spine: String(identity.spine),
    idref: identity.idref,
  })
  const dom = new JSDOM(html, {
    contentType: 'application/xhtml+xml',
    url: `http://127.0.0.1/api/dsh-reading/chapter?${search.toString()}`,
  })
  return { dom, window: dom.window, document: dom.window.document }
}

/** jsdom 的 window 里没有全局 NodeFilter 时，vendor 的 FILTER_REJECT 比较会失效。 */
export function ensureNodeFilter(window) {
  if (typeof globalThis.NodeFilter === 'undefined') globalThis.NodeFilter = window.NodeFilter
}
