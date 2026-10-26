/**
 * CFI 字符串的**独立**规格实现（golden 真值来源，不 import vendor、不 import client/src）。
 *
 * 为什么要写这一份：向量里的 `expectedCfi` 如果由 `cfi.js` 生成再拿去测 `cfi.js`，
 * 就是自己证明自己。这里只按 EPUB CFI 规范的文字拼字符串：
 *
 *   - 步引用 `/n`：n 是规范化子节点槽位号（见 dom-walk.mjs）；
 *   - 字符偏移 `:k`：只出现在最后一步、且该步是文本块时；
 *   - id 断言 `[id]`：只允许出现在**每条 local path 的最后一段**（docs/03 §四），
 *     中间段即使元素有 id 也不写 —— 写了 vendor 会解析失败；
 *   - 区间 `parent,start,end`：parent 是两条路径的公共前缀（不含偏移）；
 *   - spine 前缀 `/6/<2*(index+1)>[idref]`。
 *
 * 这份实现只服务于 golden，不进 client/src（浏览器半不需要它）。
 */

import { indexedChildren, resolvePath } from './dom-walk.mjs'

/** 路径 → 元素链（最后一项可能是文本块的宿主元素）。 */
function elementsAlong(root, steps) {
  const chain = [root]
  let current = root
  for (const step of steps) {
    const slot = indexedChildren(current)[step]
    if (!slot) return chain
    if (slot.kind === 'element') {
      current = slot.nodes[0]
      chain.push(current)
    } else if (slot.kind === 'chunk') {
      // 文本块：链到此为止，block 本身没有 id
      chain.push(null)
    } else {
      chain.push(null)
    }
  }
  return chain
}

const elementIdAt = (root, steps) => {
  if (!steps || steps.length === 0) return null
  const chain = elementsAlong(root, steps)
  const node = chain[chain.length - 1]
  return node && node.nodeType === 1 ? node.getAttribute('id') : null
}

const escapeCfi = str => String(str).replace(/[\^[\](),;=]/g, '^$&')

/** 一段路径 → `/a/b/c:k`，只在最后一段写 id（若该段是元素且有 id）。 */
function pathToLocal(root, steps, offset, withId) {
  const pieces = steps.map((step, i) => {
    const isLast = i === steps.length - 1
    const id = isLast && withId ? elementIdAt(root, steps.slice(0, i + 1)) : null
    const offsetPart = isLast && offset != null && step % 2 === 1 ? `:${offset}` : ''
    return `/${step}${id ? `[${escapeCfi(id)}]` : ''}${offsetPart}`
  })
  return pieces.join('')
}

/** 公共前缀长度（只比较索引）。 */
function commonPrefixLength(a, b) {
  let k = 0
  while (k < a.length && k < b.length && a[k] === b[k]) k += 1
  return k
}

/**
 * 生成完整 CFI。
 *
 * @param {Element} root document.documentElement
 * @param {{index:number, idref?:string}} spine
 * @param {{path:number[], offset:number}} start
 * @param {{path:number[], offset:number}|null} end null = 点 CFI
 * @returns {string}
 */
export function specCfi(root, spine, start, end) {
  const prefix = `/6/${2 * (spine.index + 1)}${spine.idref ? `[${escapeCfi(spine.idref)}]` : ''}`
  if (!end) {
    return `epubcfi(${prefix}!${pathToLocal(root, start.path, start.offset, true)})`
  }
  let k = commonPrefixLength(start.path, end.path)
  // 端点必须落在文本块上，所以公共前缀不能吃掉某个端点自己的最后一步：
  //   同块内选段   /4/2/1 .. /4/2/1  → parent = /4/2   （epubcfi(/4/2[p1],/1:3,/1:8)）
  //   同级两块     /4/2/1 .. /4/2/3  → parent = /4/2   （epubcfi(/4/2[p1],/1:0,/3:1)）
  // 两种情况都是「公共前缀退一格」；吃掉最后一步会拼出 `parent,,` 这种空端点。
  if (k > 0 && (k === start.path.length || k === end.path.length)) k -= 1
  if (k <= 0) throw new Error('specCfi: 两条路径没有可用的公共前缀，无法表示成单个区间 CFI')
  const parent = pathToLocal(root, start.path.slice(0, k), null, true)
  const startRest = pathToLocal(root, start.path.slice(k), start.offset, false)
  const endRest = pathToLocal(root, end.path.slice(k), end.offset, false)
  return `epubcfi(${prefix}!${parent},${startRest},${endRest})`
}

/** 校验一条向量声明的路径在当前文档里真的能落地（生成阶段用）。 */
export function assertPathResolvable(root, path, offset) {
  resolvePath(root, path, offset)
}
