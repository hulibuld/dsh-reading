/**
 * dsh-reading · 浏览器半 —— **构建产物，不要手改**。
 *
 * 由 `node client/build.mjs` 从下列源文件拼成（顺序即依赖顺序）：
 *   client/src/sha256.js
 *   client/src/cfi.js
 *   client/src/contract.js
 *   client/src/api.js
 *   client/src/style.js
 *   client/src/search.js
 *   client/src/shelf.js
 *   client/src/toc.js
 *   client/src/ai.js
 *   client/src/distill.js
 *   client/src/reader.js
 *   client/src/annotate.js
 *   client/src/style-qa.js
 *   client/src/app.js
 *
 * 要改行为请改 client/src/ 下对应文件，然后重新构建；
 * `node client/build.mjs --check` 会在产物与源码不同步时失败。
 *
 * 四条硬约束（违反会白屏或崩掉整个 slot）：
 *   1. 不 require 任何 @deepseek-ai/dsh-client-* 包，只用宿主给的 react；
 *   2. 插件自己的界面全是 slot 里的 React 组件，iframe 只用于书籍正文视口；
 *   3. 不在组件外写 DOM、不往 document.body 追加节点；
 *   4. 组件抛错会让这条 entry 退役（面板静默消失），所以渲染路径上不许有会抛的表达式。
 */
window.__ModuleLoader__.load({
  id: 'dsh-reading',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // ── 构建期前导（源码里不要重复声明这些名字） ──
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useLayoutEffect = React.useLayoutEffect || React.useEffect
    var useRef = React.useRef
    var useMemo = React.useMemo
    var useCallback = React.useCallback
    // ─── client/src/sha256.js ───
    var __mod_sha256_js = (function () {
      /**
       * 纯 JS 同步 SHA-256。
       *
       * 为什么不用 crypto.subtle：它是异步的，而指纹比对发生在「构造记录」与「渲染前校验」
       * 这两个同步路径上；并且不是所有 webview 都暴露 crypto.subtle（非安全上下文没有）。
       * 为什么不用 node:crypto：浏览器半不许碰 node 内建模块。
       *
       * 失败行为：本模块不抛异常。非字符串输入按 UTF-8 字节处理，字符串输入先按 UTF-8 编码；
       * 参数类型完全不合法（null / undefined / 对象）时也按空字节序列处理，返回空串的哈希，
       * 绝不会静默返回一个「看起来像哈希」的错值——调用方从返回值拿不到任何错误信号，
       * 所以调用方必须在调用前就保证输入是 string 或 Uint8Array。
       */

      const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
      ])

      const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0

      /**
       * 把字符串按 UTF-8 编码成字节。
       * 行为与 TextEncoder 完全一致：孤立代理项（未配对的 high/low surrogate）编码为 U+FFFD
       * 的字节序列 EF BF BD，而不是抛错或产出非法 UTF-8。这一点必须稳定：
       * 同一段文字在不同端算出的指纹要一致，不能让「半个 emoji」变成两种字节。
       *
       * @param {string} str
       * @returns {Uint8Array} UTF-8 字节
       */
      function utf8Bytes(str) {
        const text = typeof str === 'string' ? str : String(str ?? '')
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text)
        const out = []
        for (let i = 0; i < text.length; i++) {
          let cp = text.codePointAt(i)
          const high = text.charCodeAt(i)
          if (high >= 0xd800 && high <= 0xdbff) {
            const low = text.charCodeAt(i + 1)
            if (low >= 0xdc00 && low <= 0xdfff) i++
            else cp = 0xfffd // 孤立 high surrogate
          } else if (high >= 0xdc00 && high <= 0xdfff) cp = 0xfffd // 孤立 low surrogate
          if (cp < 0x80) out.push(cp)
          else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
          else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
          else out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f),
          )
        }
        return Uint8Array.from(out)
      }

      const toBytes = input => {
        if (input instanceof Uint8Array) return input
        if (input instanceof ArrayBuffer) return new Uint8Array(input)
        if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (typeof input === 'string') return utf8Bytes(input)
        return new Uint8Array(0)
      }

      /**
       * 同步计算 SHA-256，返回 64 位小写 hex。
       *
       * @param {string|Uint8Array|ArrayBuffer} bytesOrString 字符串按 UTF-8 编码
       * @returns {string} 64 位小写十六进制
       */
      function sha256Hex(bytesOrString) {
        const bytes = toBytes(bytesOrString)
        const h = new Uint32Array([
          0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ])
        const w = new Uint32Array(64)

        // 填充：0x80 + 若干 0x00 + 8 字节大端位长。注意 JS 的位长要用「字节数 * 8」的双字表示。
        const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000)
        const bitLenLo = (bytes.length * 8) >>> 0
        const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6))
        padded.set(bytes)
        padded[bytes.length] = 0x80
        const dv = new DataView(padded.buffer)
        dv.setUint32(padded.length - 8, bitLenHi, false)
        dv.setUint32(padded.length - 4, bitLenLo, false)

        for (let off = 0; off < padded.length; off += 64) {
          for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
          for (let i = 16; i < 64; i++) {
            const s0 = rotl(w[i - 15], 25) ^ rotl(w[i - 15], 14) ^ (w[i - 15] >>> 3)
            const s1 = rotl(w[i - 2], 15) ^ rotl(w[i - 2], 13) ^ (w[i - 2] >>> 10)
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
          }
          let [a, b, c, d, e, f, g, hh] = h
          for (let i = 0; i < 64; i++) {
            const S1 = rotl(e, 26) ^ rotl(e, 21) ^ rotl(e, 7)
            const ch = (e & f) ^ (~e & g)
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
            const S0 = rotl(a, 30) ^ rotl(a, 19) ^ rotl(a, 10)
            const maj = (a & b) ^ (a & c) ^ (b & c)
            const t2 = (S0 + maj) >>> 0
            hh = g
            g = f
            f = e
            e = (d + t1) >>> 0
            d = c
            c = b
            b = a
            a = (t1 + t2) >>> 0
          }
          h[0] = (h[0] + a) >>> 0
          h[1] = (h[1] + b) >>> 0
          h[2] = (h[2] + c) >>> 0
          h[3] = (h[3] + d) >>> 0
          h[4] = (h[4] + e) >>> 0
          h[5] = (h[5] + f) >>> 0
          h[6] = (h[6] + g) >>> 0
          h[7] = (h[7] + hh) >>> 0
        }

        let hex = ''
        for (const word of h) hex += word.toString(16).padStart(8, '0')
        return hex
      }

      return { utf8Bytes: utf8Bytes, sha256Hex: sha256Hex }
    })()

    // ─── client/src/cfi.js ───
    var __mod_cfi_js = (function () {
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

            // ── vendor/epubcfi.foliate.js（原样内联，MIT，见 client/vendor/ 头部） ──
            const __vendor = (function () {
      /**
       *  vendored: foliate-js/epubcfi.js
       *  upstream: https://github.com/johnfactotum/foliate-js  (npm foliate-js@1.0.1)
       *  license: MIT — Copyright (c) 2022 John Factotum
       *  sha256 : 0fdd0e1a2041255e4d60bcc8cad4c3293cbd4d8cb4fdecbc24435e0d4195662d
       *
       *  本文件是原样副本，**不要改**。所有本项目的改动都写在 client/src/cfi.js 里。
       *  升级步骤：npm pack foliate-js@<ver> → 覆盖本文件 → 更新上面的版本与 sha256 →
       *  跑 `npm run golden` 与 `npm test`。
       */
      const findIndices = (arr, f) => arr
          .map((x, i, a) => f(x, i, a) ? i : null).filter(x => x != null)
      const splitAt = (arr, is) => [-1, ...is, arr.length].reduce(({ xs, a }, b) =>
          ({ xs: xs?.concat([arr.slice(a + 1, b)]) ?? [], a: b }), {}).xs
      const concatArrays = (a, b) =>
          a.slice(0, -1).concat([a[a.length - 1].concat(b[0])]).concat(b.slice(1))

      const isNumber = /\d/
      const isCFI = /^epubcfi\((.*)\)$/
      const escapeCFI = str => str.replace(/[\^[\](),;=]/g, '^$&')

      const wrap = x => isCFI.test(x) ? x : `epubcfi(${x})`
      const unwrap = x => x.match(isCFI)?.[1] ?? x
      const lift = f => (...xs) =>
          `epubcfi(${f(...xs.map(x => x.match(isCFI)?.[1] ?? x))})`
      const joinIndir = lift((...xs) => xs.join('!'))

      const tokenizer = str => {
          const tokens = []
          let state, escape, value = ''
          const push = x => (tokens.push(x), state = null, value = '')
          const cat = x => (value += x, escape = false)
          for (const char of Array.from(str.trim()).concat('')) {
              if (char === '^' && !escape) {
                  escape = true
                  continue
              }
              if (state === '!') push(['!'])
              else if (state === ',') push([','])
              else if (state === '/' || state === ':') {
                  if (isNumber.test(char)) {
                      cat(char)
                      continue
                  } else push([state, parseInt(value)])
              } else if (state === '~') {
                  if (isNumber.test(char) || char === '.') {
                      cat(char)
                      continue
                  } else push(['~', parseFloat(value)])
              } else if (state === '@') {
                  if (char === ':') {
                      push(['@', parseFloat(value)])
                      state = '@'
                      continue
                  }
                  if (isNumber.test(char) || char === '.') {
                      cat(char)
                      continue
                  } else push(['@', parseFloat(value)])
              } else if (state === '[') {
                  if (char === ';' && !escape) {
                      push(['[', value])
                      state = ';'
                  } else if (char === ',' && !escape) {
                      push(['[', value])
                      state = '['
                  } else if (char === ']' && !escape) push(['[', value])
                  else cat(char)
                  continue
              } else if (state?.startsWith(';')) {
                  if (char === '=' && !escape) {
                      state = `;${value}`
                      value = ''
                  } else if (char === ';' && !escape) {
                      push([state, value])
                      state = ';'
                  } else if (char === ']' && !escape) push([state, value])
                  else cat(char)
                  continue
              }
              if (char === '/' || char === ':' || char === '~' || char === '@'
              || char === '[' || char === '!' || char === ',') state = char
          }
          return tokens
      }

      const findTokens = (tokens, x) => findIndices(tokens, ([t]) => t === x)

      const parser = tokens => {
          const parts = []
          let state
          for (const [type, val] of tokens) {
              if (type === '/') parts.push({ index: val })
              else {
                  const last = parts[parts.length - 1]
                  if (type === ':') last.offset = val
                  else if (type === '~') last.temporal = val
                  else if (type === '@') last.spatial = (last.spatial ?? []).concat(val)
                  else if (type === ';s') last.side = val
                  else if (type === '[') {
                      if (state === '/' && val) last.id = val
                      else {
                          last.text = (last.text ?? []).concat(val)
                          continue
                      }
                  }
              }
              state = type
          }
          return parts
      }

      // split at step indirections, then parse each part
      const parserIndir = tokens =>
          splitAt(tokens, findTokens(tokens, '!')).map(parser)

      const parse = cfi => {
          const tokens = tokenizer(unwrap(cfi))
          const commas = findTokens(tokens, ',')
          if (!commas.length) return parserIndir(tokens)
          const [parent, start, end] = splitAt(tokens, commas).map(parserIndir)
          return { parent, start, end }
      }

      const partToString = ({ index, id, offset, temporal, spatial, text, side }) => {
          const param = side ? `;s=${side}` : ''
          return `/${index}`
              + (id ? `[${escapeCFI(id)}${param}]` : '')
              // "CFI expressions [..] SHOULD include an explicit character offset"
              + (offset != null && index % 2 ? `:${offset}` : '')
              + (temporal ? `~${temporal}` : '')
              + (spatial ? `@${spatial.join(':')}` : '')
              + (text || (!id && side) ? '['
                  + (text?.map(escapeCFI)?.join(',') ?? '')
                  + param + ']' : '')
      }

      const toInnerString = parsed => parsed.parent
          ? [parsed.parent, parsed.start, parsed.end].map(toInnerString).join(',')
          : parsed.map(parts => parts.map(partToString).join('')).join('!')

      const toString = parsed => wrap(toInnerString(parsed))

      const collapse = (x, toEnd) => typeof x === 'string'
          ? toString(collapse(parse(x), toEnd))
          : x.parent ? concatArrays(x.parent, x[toEnd ? 'end' : 'start']) : x

      // create range CFI from two CFIs
      const buildRange = (from, to) => {
          if (typeof from === 'string') from = parse(from)
          if (typeof to === 'string') to = parse(to)
          from = collapse(from)
          to = collapse(to, true)
          // ranges across multiple documents are not allowed; handle local paths only
          const localFrom = from[from.length - 1], localTo = to[to.length - 1]
          const localParent = [], localStart = [], localEnd = []
          let pushToParent = true
          const len = Math.max(localFrom.length, localTo.length)
          for (let i = 0; i < len; i++) {
              const a = localFrom[i], b = localTo[i]
              pushToParent &&= a?.index === b?.index && !a?.offset && !b?.offset
              if (pushToParent) localParent.push(a)
              else {
                  if (a) localStart.push(a)
                  if (b) localEnd.push(b)
              }
          }
          // copy non-local paths from `from`
          const parent = from.slice(0, -1).concat([localParent])
          return toString({ parent, start: [localStart], end: [localEnd] })
      }

      const compare = (a, b) => {
          if (typeof a === 'string') a = parse(a)
          if (typeof b === 'string') b = parse(b)
          if (a.start || b.start) return compare(collapse(a), collapse(b))
              || compare(collapse(a, true), collapse(b, true))

          for (let i = 0; i < Math.max(a.length, b.length); i++) {
              const p = a[i] ?? [], q = b[i] ?? []
              const maxIndex = Math.max(p.length, q.length) - 1
              for (let i = 0; i <= maxIndex; i++) {
                  const x = p[i], y = q[i]
                  if (!x) return -1
                  if (!y) return 1
                  if (x.index > y.index) return 1
                  if (x.index < y.index) return -1
                  if (i === maxIndex) {
                      // TODO: compare temporal & spatial offsets
                      if (x.offset > y.offset) return 1
                      if (x.offset < y.offset) return -1
                  }
              }
          }
          return 0
      }

      const isTextNode = ({ nodeType }) => nodeType === 3 || nodeType === 4
      const isElementNode = ({ nodeType }) => nodeType === 1

      const getChildNodes = (node, filter) => {
          const nodes = Array.from(node.childNodes)
              // "content other than element and character data is ignored"
              .filter(node => isTextNode(node) || isElementNode(node))
          return filter ? nodes.map(node => {
              const accept = filter(node)
              if (accept === NodeFilter.FILTER_REJECT) return null
              else if (accept === NodeFilter.FILTER_SKIP) return getChildNodes(node, filter)
              else return node
          }).flat().filter(x => x) : nodes
      }

      // child nodes are organized such that the result is always
      //     [element, text, element, text, ..., element],
      // regardless of the actual structure in the document;
      // so multiple text nodes need to be combined, and nonexistent ones counted;
      // see "Step Reference to Child Element or Character Data (/)" in EPUB CFI spec
      const indexChildNodes = (node, filter) => {
          const nodes = getChildNodes(node, filter)
              .reduce((arr, node) => {
                  let last = arr[arr.length - 1]
                  if (!last) arr.push(node)
                  // "there is one chunk between each pair of child elements"
                  else if (isTextNode(node)) {
                      if (Array.isArray(last)) last.push(node)
                      else if (isTextNode(last)) arr[arr.length - 1] = [last, node]
                      else arr.push(node)
                  } else {
                      if (isElementNode(last)) arr.push(null, node)
                      else arr.push(node)
                  }
                  return arr
              }, [])
          // "the first chunk is located before the first child element"
          if (isElementNode(nodes[0])) nodes.unshift('first')
          // "the last chunk is located after the last child element"
          if (isElementNode(nodes[nodes.length - 1])) nodes.push('last')
          // "'virtual' elements"
          nodes.unshift('before') // "0 is a valid index"
          nodes.push('after') // "n+2 is a valid index"
          return nodes
      }

      const partsToNode = (node, parts, filter) => {
          const { id } = parts[parts.length - 1]
          if (id) {
              const el = node.ownerDocument.getElementById(id)
              if (el) return { node: el, offset: 0 }
          }
          for (const { index } of parts) {
              const newNode = node ? indexChildNodes(node, filter)[index] : null
              // handle non-existent nodes
              if (newNode === 'first') return { node: node.firstChild ?? node }
              if (newNode === 'last') return { node: node.lastChild ?? node }
              if (newNode === 'before') return { node, before: true }
              if (newNode === 'after') return { node, after: true }
              node = newNode
          }
          const { offset } = parts[parts.length - 1]
          if (!Array.isArray(node)) return { node, offset }
          // get underlying text node and offset from the chunk
          let sum = 0
          for (const n of node) {
              const { length } = n.nodeValue
              if (sum + length >= offset) return { node: n, offset: offset - sum }
              sum += length
          }
      }

      const nodeToParts = (node, offset, filter) => {
          const { parentNode, id } = node
          const indexed = indexChildNodes(parentNode, filter)
          const index = indexed.findIndex(x =>
              Array.isArray(x) ? x.some(x => x === node) : x === node)
          // adjust offset as if merging the text nodes in the chunk
          const chunk = indexed[index]
          if (Array.isArray(chunk)) {
              let sum = 0
              for (const x of chunk) {
                  if (x === node) {
                      sum += offset
                      break
                  } else sum += x.nodeValue.length
              }
              offset = sum
          }
          const part = { id, index, offset }
          return (parentNode !== node.ownerDocument.documentElement
              ? nodeToParts(parentNode, null, filter).concat(part) : [part])
              // remove ignored nodes
              .filter(x => x.index !== -1)
      }

      const fromRange = (range, filter) => {
          const { startContainer, startOffset, endContainer, endOffset } = range
          const start = nodeToParts(startContainer, startOffset, filter)
          if (range.collapsed) return toString([start])
          const end = nodeToParts(endContainer, endOffset, filter)
          return buildRange([start], [end])
      }

      const toRange = (doc, parts, filter) => {
          const startParts = collapse(parts)
          const endParts = collapse(parts, true)

          const root = doc.documentElement
          const start = partsToNode(root, startParts[0], filter)
          const end = partsToNode(root, endParts[0], filter)

          const range = doc.createRange()

          if (start.before) range.setStartBefore(start.node)
          else if (start.after) range.setStartAfter(start.node)
          else range.setStart(start.node, start.offset)

          if (end.before) range.setEndBefore(end.node)
          else if (end.after) range.setEndAfter(end.node)
          else range.setEnd(end.node, end.offset)
          return range
      }

      // faster way of getting CFIs for sorted elements in a single parent
      const fromElements = elements => {
          const results = []
          const { parentNode } = elements[0]
          const parts = nodeToParts(parentNode)
          for (const [index, node] of indexChildNodes(parentNode).entries()) {
              const el = elements[results.length]
              if (node === el)
                  results.push(toString([parts.concat({ id: el.id, index })]))
          }
          return results
      }

      const toElement = (doc, parts) =>
          partsToNode(doc.documentElement, collapse(parts)).node

      // turn indices into standard CFIs when you don't have an actual package document
      const fake = {
          fromIndex: index => wrap(`/6/${(index + 1) * 2}`),
          toIndex: parts => parts?.at(-1).index / 2 - 1,
      }

      // get CFI from Calibre bookmarks
      // see https://github.com/johnfactotum/foliate/issues/849
      const fromCalibrePos = pos => {
          const [parts] = parse(pos)
          const item = parts.shift()
          parts.shift()
          return toString([[{ index: 6 }, item], parts])
      }
      const fromCalibreHighlight = ({ spine_index, start_cfi, end_cfi }) => {
          const pre = fake.fromIndex(spine_index) + '!'
          return buildRange(pre + start_cfi.slice(2), pre + end_cfi.slice(2))
      }
              return { isCFI: isCFI, joinIndir: joinIndir, parse: parse, collapse: collapse, compare: compare, fromRange: fromRange, toRange: toRange, fromElements: fromElements, toElement: toElement, fake: fake, fromCalibrePos: fromCalibrePos, fromCalibreHighlight: fromCalibreHighlight }
            })()
            const CFI = __vendor

      /** 注入节点的标记属性。命中它的元素不参与 CFI 索引计算。 */
      const INJECTED_ATTR = 'data-dsh-reading-injected'

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
      function makeFilter(win) {
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
      function fromRange(win, range, spine) {
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
      function toRange(win, doc, cfi) {
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
      function validate(win, doc, cfi, expectedFingerprint) {
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
      function spineIndexFromCfi(cfi) {
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
      function chapterHrefFromCfi(cfi) {
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
      function joinCfi(prefix, localRange) {
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
      function splitCfi(cfi) {
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
      function collapseLocal(cfi, toEnd = false) {
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
      function textOfRange(range) {
        if (!range || typeof range.toString !== 'function') {
          throw cfiError(CODE.RESOLVE, 'textOfRange 需要真实的 Range')
        }
        return range.toString()
      }

      return { INJECTED_ATTR: INJECTED_ATTR, makeFilter: makeFilter, fromRange: fromRange, toRange: toRange, validate: validate, spineIndexFromCfi: spineIndexFromCfi, chapterHrefFromCfi: chapterHrefFromCfi, joinCfi: joinCfi, splitCfi: splitCfi, collapseLocal: collapseLocal, textOfRange: textOfRange }
    })()

    // ─── client/src/contract.js ───
    var __mod_contract_js = (function () {
      /**
       * 数据契约：记录构造器 + 手写同构校验 + 文本指纹。
       *
       * 这个文件是 `schema/contract.schema.json` 的**手写同构版**：浏览器半不许引 ajv
       * （会打破零运行时依赖，也会把包体积翻倍），所以字段表在这里再写一遍。
       * `test/schema_parity_test.mjs` 用 ajv 跑同一批记录，两边判定必须完全一致——
       * 一旦这里漏了字段、写错枚举，那个测试就红。
       *
       * 依赖方向：contract → cfi（拆 CFI 前后段）、contract → sha256（算指纹）。
       * 不反向依赖，保证 build.mjs 的 sha256 → cfi → contract 顺序成立。
       *
       * 失败行为：构造器与 `makeUlid` 出错一律 **throw**（`name === 'ContractError'`），
       * 绝不返回「缺字段的降级记录」——铁律 5 的落地点。`validateRecord` 是判定函数，
       * 失败以 `{ ok:false, errors }` 返回，不抛。
       */

            const sha256Hex = __mod_sha256_js.sha256Hex
            const utf8Bytes = __mod_sha256_js.utf8Bytes
            const splitCfi = __mod_cfi_js.splitCfi
            const collapseLocal = __mod_cfi_js.collapseLocal

      /** 契约版本号。所有记录的 `schema` 字段恒等于它。 */
      const SCHEMA = 'dsh-reading/1'

      /** 五种划线颜色（与 schema 的 color enum 一字不差）。 */
      const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple']

      /** 隔离原因枚举（与 schema 的 quarantine.reason 一字不差）。 */
      const QUARANTINE_REASONS = [
        'cfi_parse_failed',
        'cfi_resolve_failed',
        'cfi_range_inverted',
        'cfi_cross_document',
        'cfi_collapsed_highlight',
        'cfi_offset_out_of_bounds',
        'cfi_prefix_mismatch',
        'fingerprint_drift',
        'schema_invalid',
        'orphan_anchor',
      ]

      /** 锚点状态（schema 的 anchorStatus enum）。 */
      const ANCHOR_STATUS = ['ok', 'repaired', 'drifted', 'quarantined']

      const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
      const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

      /**
       * 造一个契约错误。与 cfi.js 同款：只带自有属性，跨 iframe 传不丢。
       * @param {string} field 出问题的字段（或构造器名）
       * @param {string} message 给人看的说明
       */
      function contractError(field, message, code = 'schema_invalid') {
        const error = new Error(`${field}: ${message}`)
        error.name = 'ContractError'
        error.code = code
        error.field = field
        return error
      }


      const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

      /** JSON Schema 的 length 按 code point 数，不是 UTF-16 code unit 数。这里必须同口径。 */
      const codePointLength = text => (typeof text === 'string' ? Array.from(text).length : -1)

      /* --------------------------------------------------------------------- ULID */

      let lastTime = -1
      let lastRandom = null

      const randomChars = (count) => {
        const out = new Array(count)
        const cryptoApi = globalThis.crypto
        if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
          const bytes = new Uint8Array(count)
          cryptoApi.getRandomValues(bytes)
          for (let i = 0; i < count; i++) out[i] = ULID_ALPHABET[bytes[i] % 32]
          return out
        }
        for (let i = 0; i < count; i++) {
          out[i] = ULID_ALPHABET[Math.floor(Math.random() * 32)]
        }
        return out
      }

      /** 在 base32 数字串上 +1（带进位），用于同毫秒内单调自增。 */
      const incrementChars = (chars) => {
        const next = chars.slice()
        for (let i = next.length - 1; i >= 0; i--) {
          const at = ULID_ALPHABET.indexOf(next[i])
          if (at < 31) {
            next[i] = ULID_ALPHABET[at + 1]
            return next
          }
          next[i] = ULID_ALPHABET[0]
        }
        // 80 位随机部整圈回绕（概率 2^-80）：重新取随机，仍保持单调的「不同值」。
        return randomChars(chars.length)
      }

      const encodeTime = (ms) => {
        let rest = Math.max(0, Math.floor(ms))
        let out = ''
        for (let i = 0; i < 10; i++) {
          out = ULID_ALPHABET[rest % 32] + out
          rest = Math.floor(rest / 32)
        }
        return out
      }

      /**
       * 生成 26 位 ULID（Crockford Base32，字典序≈时间序）。
       *
       * 单调性：同一毫秒内自增随机部，所以连续调用不会出现「后生成的 ID 字典序更小」。
       * 时钟回拨时沿用上一次的时间部分，保证不倒退。
       *
       * @param {number|Date} [now] 时间源，默认 Date.now()；测试用固定值可复现时间前缀
       * @returns {string} 26 位，匹配 `^[0-9A-HJKMNP-TV-Z]{26}$`
       */
      function makeUlid(now) {
        const raw = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now())
        if (!Number.isFinite(raw) || raw < 0) {
          throw contractError('makeUlid', `时间必须是非负有限数，收到 ${String(now)}`)
        }
        const time = Math.floor(raw)
        if (time > lastTime) {
          lastTime = time
          lastRandom = randomChars(16)
        } else {
          // 同一毫秒（或时钟回拨）：时间部分不动，随机部 +1
          lastRandom = incrementChars(lastRandom ?? randomChars(16))
        }
        const id = encodeTime(lastTime) + lastRandom.join('')
        if (!ULID_RE.test(id)) {
          throw contractError('makeUlid', `生成的 ULID 不符合契约正则：${id}`)
        }
        return id
      }

      /* ------------------------------------------------------------------- 指纹 */

      /**
       * 文本指纹（docs/05 §4.2，两端必须一字不差）。
       *
       *   head = 前 48 个 UTF-16 code unit
       *   tail = 后 32 个 UTF-16 code unit   ← 是「最后 32 个」，不是「除 head 外的后 32 个」
       *   len  = UTF-16 code unit 长度
       *   hash = sha256(UTF-8 字节) 的小写 hex
       *
       * 文本短于 48 时 head 与 tail 重叠，这是允许的（不要特判）。
       *
       * @param {string} text
       * @returns {{head:string, tail:string, len:number, hash:string}}
       */
      function fingerprint(text) {
        if (typeof text !== 'string') {
          throw contractError('fingerprint', '只接受字符串（正文是字符串；二进制请先解码）')
        }
        return {
          head: text.slice(0, 48),
          tail: text.slice(Math.max(0, text.length - 32)),
          len: text.length,
          hash: sha256Hex(utf8Bytes(text)),
        }
      }

      const fingerprintShapeOk = value => isObject(value)
        && typeof value.head === 'string'
        && typeof value.tail === 'string'
        && Number.isInteger(value.len)
        && typeof value.hash === 'string'

      /**
       * 指纹三态比对（docs/05 §4.2）。
       *
       * | 条件 | 结果 |
       * |---|---|
       * | head/tail/len/hash 全等 | `ok` |
       * | head/tail/len 全等、hash 不等 | `drifted`（降级渲染，anchorStatus="drifted"） |
       * | 其余 | `fail` → 隔离，reason="fingerprint_drift" |
       *
       * 任一参数不是合法指纹 → `fail`（不猜、不部分比对）。
       *
       * @param {object} a 记录里的指纹
       * @param {object} b 现场算出的指纹
       * @returns {'ok'|'drifted'|'fail'}
       */
      function compareFingerprint(a, b) {
        if (!fingerprintShapeOk(a) || !fingerprintShapeOk(b)) return 'fail'
        if (a.head !== b.head || a.tail !== b.tail || a.len !== b.len) return 'fail'
        return a.hash === b.hash ? 'ok' : 'drifted'
      }

      /**
       * 把过长的摘录截到契约允许的长度，并告诉调用方是否截过。
       * 为什么提供它：`textExcerpt` 有 512 上限，但「截断」是展示层决定，
       * 不能由构造器偷偷做（那会让 L3 用一段被改过的文本算指纹）。
       *
       * @param {string} text 原文
       * @param {number} [max=512] 上限（code point）
       * @returns {{text:string, truncated:boolean}}
       */
      function truncateExcerpt(text, max = 512) {
        const source = typeof text === 'string' ? text : ''
        const chars = Array.from(source)
        if (chars.length <= max) return { text: source, truncated: false }
        return { text: chars.slice(0, max).join(''), truncated: true }
      }

      /* ------------------------------------------------------- 字段表（= schema） */

      const P = {
        // 语义化类型：直接对应 schema 的 $defs，避免逐处重复写正则
        schema: { const: SCHEMA },
        ulid: { type: 'string', pattern: ULID_RE },
        deviceId: { type: 'string', pattern: /^[a-z0-9]{2,12}-[a-z0-9]{4,12}$/ },
        iso8601: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ },
        bookHash: { type: 'string', pattern: /^[0-9a-f]{64}$/ },
        color: { type: 'string', enum: COLORS },
        cfiFull: { type: 'string', pattern: /^epubcfi\(\s*\/.+!.+\s*\)$/ },
        cfiPartial: { type: 'string', pattern: /^\/[0-9]/ },
        anchorStatus: { type: 'string', enum: ANCHOR_STATUS },
        textFingerprint: {
          type: 'object',
          required: ['head', 'tail', 'len', 'hash'],
          closed: true,
          properties: {
            head: { type: 'string', maxLength: 48 },
            tail: { type: 'string', maxLength: 32 },
            len: { type: 'integer', minimum: 0 },
            hash: { type: 'string', pattern: /^[0-9a-f]{64}$/ },
          },
        },
      }

      const FORMATS = ['epub', 'mobi-converted', 'txt-converted']
      const SOURCE_FORMATS = ['epub', 'mobi', 'azw3', 'txt']

      /** 每个 $defs 分支的字段表。`closed: true` = additionalProperties:false。 */
      const BRANCHES = {
        meta: {
          closed: true,
          required: ['schema', 'bookHash', 'title', 'format', 'converterVersion', 'spine', 'createdAt'],
          properties: {
            schema: P.schema,
            bookHash: P.bookHash,
            title: { type: 'string', minLength: 1 },
            author: { type: 'string' },
            language: { type: 'string' },
            format: { type: 'string', enum: FORMATS },
            sourceFormat: { type: 'string', enum: SOURCE_FORMATS },
            converterVersion: { type: 'string' },
            totalChars: { type: 'integer', minimum: 0 },
            chapterCount: { type: 'integer', minimum: 0 },
            toc: {
              type: 'array',
              items: {
                required: ['label', 'href'],
                properties: {
                  label: { type: 'string' },
                  href: { type: 'string' },
                  depth: { type: 'integer', minimum: 0 },
                },
              },
            },
            fileSize: { type: 'integer', minimum: 0 },
            spine: {
              type: 'array',
              items: {
                required: ['index', 'href'],
                properties: {
                  index: { type: 'integer', minimum: 0 },
                  href: { type: 'string' },
                  idref: { type: 'string' },
                  mediaType: { type: 'string' },
                  linear: { type: 'boolean' },
                },
              },
            },
            createdAt: P.iso8601,
            updatedAt: P.iso8601,
            createdBy: P.deviceId,
            deviceId: P.deviceId,
            coverHref: { type: 'string' },
            // 0.4.0：下面三个字段由宿主写进 meta.json，客户端只读。
            // 枚举必须与 schema/contract.schema.json 逐字相同（多一个少一个，
            // schema_parity_test 就是红）——headings / split 也是真值：
            // TXT 识别到的真标题写 headings，按字数硬切写 split，都不许漏。
            tocSource: { type: 'string', enum: ['nav', 'ncx', 'spine', 'auto', 'headings', 'split', 'none'] },
            // 换/删一次封面 +1。客户端拿它拼封面 URL 的 `&v=`，否则换完封面还看旧图。
            coverVersion: { type: 'integer', minimum: 0 },
            coverMediaType: { type: 'string' },
          },
        },
        progress: {
          closed: true,
          required: ['schema', 'cfi', 'updatedAt', 'deviceId'],
          properties: {
            schema: P.schema,
            cfi: P.cfiFull,
            chapterHref: { type: 'string' },
            chapterProgression: { type: 'number', minimum: 0, maximum: 1 },
            bookProgression: { type: 'number', minimum: 0, maximum: 1 },
            updatedAt: P.iso8601,
            deviceId: P.deviceId,
          },
        },
        highlight: {
          closed: true,
          required: [
            'schema', 'id', 'type', 'cfi', 'cfiStart', 'cfiEnd', 'chapterHref',
            'textExcerpt', 'textFingerprint', 'color', 'createdAt', 'updatedAt', 'deviceId',
          ],
          properties: {
            schema: P.schema,
            id: P.ulid,
            type: { const: 'highlight' },
            cfi: P.cfiFull,
            cfiStart: P.cfiPartial,
            cfiEnd: P.cfiPartial,
            chapterHref: { type: 'string', minLength: 1 },
            textExcerpt: { type: 'string', maxLength: 512 },
            textExcerptTruncated: { type: 'boolean' },
            textFingerprint: P.textFingerprint,
            color: P.color,
            note: { type: 'string', maxLength: 8192 },
            createdAt: P.iso8601,
            updatedAt: P.iso8601,
            deviceId: P.deviceId,
            deleted: { type: 'boolean' },
            anchorStatus: P.anchorStatus,
          },
        },
        note: {
          closed: true,
          required: [
            'schema', 'id', 'type', 'cfi', 'cfiStart', 'cfiEnd', 'chapterHref',
            'textExcerpt', 'textFingerprint', 'createdAt', 'updatedAt', 'deviceId', 'color', 'note',
          ],
          properties: {
            schema: P.schema,
            id: P.ulid,
            type: { const: 'note' },
            cfi: P.cfiFull,
            cfiStart: P.cfiPartial,
            cfiEnd: P.cfiPartial,
            chapterHref: { type: 'string', minLength: 1 },
            textExcerpt: { type: 'string', maxLength: 512 },
            textFingerprint: P.textFingerprint,
            color: P.color,
            note: { type: 'string', minLength: 1, maxLength: 8192 },
            createdAt: P.iso8601,
            updatedAt: P.iso8601,
            deviceId: P.deviceId,
            deleted: { type: 'boolean' },
            anchorStatus: P.anchorStatus,
          },
        },
        bookmark: {
          closed: true,
          required: [
            'schema', 'id', 'type', 'cfi', 'cfiStart', 'chapterHref',
            'createdAt', 'updatedAt', 'deviceId',
          ],
          properties: {
            schema: P.schema,
            id: P.ulid,
            type: { const: 'bookmark' },
            cfi: P.cfiFull,
            cfiStart: P.cfiPartial,
            chapterHref: { type: 'string', minLength: 1 },
            label: { type: 'string', maxLength: 256 },
            createdAt: P.iso8601,
            updatedAt: P.iso8601,
            deviceId: P.deviceId,
            deleted: { type: 'boolean' },
          },
        },
        qa: {
          closed: true,
          required: [
            'schema', 'id', 'anchorCfiRange', 'question', 'answer', 'cutoffCfi',
            'createdAt', 'updatedAt', 'deviceId',
          ],
          properties: {
            schema: P.schema,
            id: P.ulid,
            type: { const: 'qa' },
            anchorCfiRange: P.cfiFull,
            anchorAnnotationId: P.ulid,
            question: { type: 'string', minLength: 1, maxLength: 4096 },
            answer: { type: 'string', minLength: 1 },
            contextExcerpt: { type: 'string', maxLength: 8192 },
            contextCfiRange: P.cfiFull,
            cutoffCfi: P.cfiFull,
            model: { type: 'string' },
            threadId: P.ulid,
            parentId: P.ulid,
            createdAt: P.iso8601,
            updatedAt: P.iso8601,
            deviceId: P.deviceId,
            deleted: { type: 'boolean' },
          },
        },
        quarantine: {
          closed: true,
          required: ['schema', 'id', 'reason', 'sourceDeviceId', 'ingestedAt'],
          properties: {
            schema: P.schema,
            id: P.ulid,
            type: { type: 'string' },
            reason: { type: 'string', enum: QUARANTINE_REASONS },
            rawCfi: { type: 'string' },
            rawRecord: { type: 'string' },
            sourceDeviceId: P.deviceId,
            ingestedAt: P.iso8601,
            repairable: { type: 'boolean' },
          },
        },
      }

      /* --------------------------------------------------------------- 字段校验 */

      /**
       * 校验单个字段值，返回错误消息数组（空数组 = 通过）。
       * 语义按 JSON Schema 2020-12：length 用 code point，integer 不含小数。
       */
      function checkValue(spec, value, path, errors) {
        if (value === undefined) return
        const type = spec.type
        if (spec.const !== undefined) {
          if (value !== spec.const) {
            errors.push({ field: path, message: `必须恒等于 ${JSON.stringify(spec.const)}` })
            return
          }
          return
        }
        if (spec.enum) {
          if (typeof value !== 'string' || !spec.enum.includes(value)) {
            errors.push({ field: path, message: `必须是 ${spec.enum.join(' / ')} 之一` })
            return
          }
        }
        if (type === 'string') {
          if (typeof value !== 'string') {
            errors.push({ field: path, message: '必须是字符串' })
            return
          }
          const len = codePointLength(value)
          if (spec.minLength != null && len < spec.minLength) {
            errors.push({ field: path, message: `至少 ${spec.minLength} 个字符，实际 ${len}` })
          }
          if (spec.maxLength != null && len > spec.maxLength) {
            errors.push({ field: path, message: `最多 ${spec.maxLength} 个字符，实际 ${len}` })
          }
          if (spec.pattern && !spec.pattern.test(value)) {
            errors.push({ field: path, message: `不符合格式 ${String(spec.pattern)}` })
          }
          return
        }
        if (type === 'integer' || type === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            errors.push({ field: path, message: '必须是有限数字' })
            return
          }
          if (type === 'integer' && !Number.isInteger(value)) {
            errors.push({ field: path, message: '必须是整数' })
            return
          }
          if (spec.minimum != null && value < spec.minimum) {
            errors.push({ field: path, message: `不得小于 ${spec.minimum}` })
          }
          if (spec.maximum != null && value > spec.maximum) {
            errors.push({ field: path, message: `不得大于 ${spec.maximum}` })
          }
          return
        }
        if (type === 'boolean') {
          if (typeof value !== 'boolean') errors.push({ field: path, message: '必须是 true/false' })
          return
        }
        if (type === 'object') {
          if (!isObject(value)) {
            errors.push({ field: path, message: '必须是对象' })
            return
          }
          checkObject(spec, value, path, errors)
          return
        }
        if (type === 'array') {
          if (!Array.isArray(value)) {
            errors.push({ field: path, message: '必须是数组' })
            return
          }
          if (spec.items) {
            value.forEach((item, i) => {
              const itemPath = `${path}[${i}]`
              if (spec.items.required || spec.items.properties) {
                if (!isObject(item)) {
                  errors.push({ field: itemPath, message: '必须是对象' })
                  return
                }
                checkObject(spec.items, item, itemPath, errors)
              } else {
                checkValue(spec.items, item, itemPath, errors)
              }
            })
          }
        }
      }

      function checkObject(spec, value, path, errors) {
        const properties = spec.properties ?? {}
        for (const key of spec.required ?? []) {
          if (value[key] === undefined) {
            errors.push({ field: path ? `${path}.${key}` : key, message: '缺少必填字段' })
          }
        }
        for (const key of Object.keys(value)) {
          const fieldPath = path ? `${path}.${key}` : key
          const property = properties[key]
          if (!property) {
            if (spec.closed) errors.push({ field: fieldPath, message: 'schema 里没有这个字段' })
            continue
          }
          checkValue(property, value[key], fieldPath, errors)
        }
      }

      /**
       * 按 `type` 选分支。
       *
       * 为什么不能直接跑顶层 oneOf：docs/01 §2.9.1 实测过，ajv 的 oneOf 报错会把 7 个分支的
       * 缺失字段全倒出来，用户看到的第一条往往是无关的 `bookHash`。这里先定位分支，只报该分支的错。
       *
       * 为什么 quarantine 先认结构不认 type：quarantine 的 `type` 是**自由字符串**（记录原始类型），
       * 它可能恰好等于 "highlight"。此时若按 type 分发会误判到 highlight 分支。
       */
      function pickBranch(record) {
        const has = key => Object.prototype.hasOwnProperty.call(record, key)
        if (has('reason') && has('ingestedAt')) return 'quarantine'
        const type = record.type
        if (type === 'highlight' || type === 'note' || type === 'bookmark' || type === 'qa') return type
        if (has('bookHash') || has('title') || has('spine') || has('format') || has('converterVersion')) {
          return 'meta'
        }
        if (has('cfi') || has('chapterProgression') || has('bookProgression') || has('updatedAt')) {
          return 'progress'
        }
        return null
      }

      /**
       * 校验一条记录。
       *
       * @param {unknown} record
       * @returns {{ok:boolean, errors:Array<{field:string,message:string}>}}
       *   失败时 `errors` 至少一条，`field` 带完整路径（`textFingerprint.len` 这种），
       *   供同步排障时一眼定位。
       */
      function validateRecord(record) {
        if (!isObject(record)) {
          return { ok: false, errors: [{ field: '', message: '记录必须是对象' }] }
        }
        const branch = pickBranch(record)
        if (!branch) {
          return {
            ok: false,
            errors: [{ field: 'type', message: '无法判断记录类型：既没有 type，也不像 meta/progress/quarantine' }],
          }
        }
        const errors = []
        checkObject(BRANCHES[branch], record, '', errors)
        return { ok: errors.length === 0, errors }
      }

      /* --------------------------------------------------------------- 构造器 */

      const nowIso = () => new Date().toISOString()

      const requireString = (fields, name, options = {}) => {
        const value = fields?.[name]
        if (typeof value !== 'string' || value === '') {
          throw contractError(name, `${options.label ?? name} 是必填字段，缺失或为空串时拒绝构造记录`)
        }
        return value
      }

      const requireFingerprint = (fields) => {
        const value = fields?.textFingerprint
        if (!fingerprintShapeOk(value)) {
          throw contractError(
            'textFingerprint',
            '指纹是必填字段（L3 校验的唯一输入）。先对 textExcerpt 调 fingerprint()，不要传 null',
          )
        }
        return value
      }

      /**
       * 通用信封（docs/05 §4.3）：id / createdAt / updatedAt / deviceId / schema 五件套。
       *
       * `type` 为 null 时（meta / progress / quarantine）不写该字段——它们不在 schema 的
       * properties 里，多写一个键会被 additionalProperties:false 判非法。
       *
       * @param {string|null} type
       * @param {object} fields
       * @returns {object}
       */
      function makeRecord(type, fields) {
        if (!isObject(fields)) {
          throw contractError('makeRecord', '第二个参数必须是字段对象')
        }
        const now = nowIso()
        return {
          schema: SCHEMA,
          ...(type ? { type } : {}),
          ...fields,
          id: fields.id ?? makeUlid(),
          createdAt: fields.createdAt ?? now,
          updatedAt: fields.updatedAt ?? now,
        }
      }

      /** 高亮 / 笔记共用的字段装配（两者只差 note 必填）。 */
      function makeTextAnchorRecord(type, fields) {
        const cfi = requireString(fields, 'cfi', { label: 'CFI 区间' })
        const chapterHref = requireString(fields, 'chapterHref', { label: '章节 href' })
        const textExcerpt = requireString(fields, 'textExcerpt', { label: 'textExcerpt（L3 校验的原文）' })
        const textFingerprint = requireFingerprint(fields)
        const color = requireString(fields, 'color', { label: '划线颜色' })
        const { local } = splitCfi(cfi)
        if (!local.includes(',')) {
          throw contractError(
            'cfi',
            'highlight/note 的 CFI 必须是区间形态（parent,start,end）。零宽锚点会在渲染时变成看不见的高亮',
            'cfi_collapsed_highlight',
          )
        }
        // cfiStart / cfiEnd 是「这一端的位置」，形态与 vendor collapse() 一致：
        //   epubcfi(/6/4[ch1]!/4/2[p1],/1:3,/1:8) → "/4/2[p1]/1:3" 与 "/4/2[p1]/1:8"
        // 单独拿去解析也指向正确字符，进度恢复才不会退化成整段。
        const cfiStart = collapseLocal(cfi, false)
        const cfiEnd = collapseLocal(cfi, true)
        const record = {
          schema: SCHEMA,
          type,
          id: fields.id ?? makeUlid(),
          cfi,
          cfiStart,
          cfiEnd,
          chapterHref,
          textExcerpt,
          ...(type === 'highlight' && fields.textExcerptTruncated !== undefined
            ? { textExcerptTruncated: fields.textExcerptTruncated }
            : {}),
          textFingerprint,
          color,
        }
        if (fields.note !== undefined) record.note = fields.note
        if (fields.anchorStatus !== undefined) record.anchorStatus = fields.anchorStatus
        if (fields.deleted !== undefined) record.deleted = fields.deleted
        const now = nowIso()
        record.createdAt = fields.createdAt ?? now
        record.updatedAt = fields.updatedAt ?? now
        record.deviceId = requireString(fields, 'deviceId', { label: 'deviceId（宿主 device.info 给的）' })
        return record
      }

      /**
       * 造一条高亮记录。
       *
       * 必填：`cfi`（区间形态）、`chapterHref`、`textExcerpt`、`textFingerprint`、`color`、`deviceId`。
       * 缺任一 → **throw**（`ContractError`），不返回降级记录：没有指纹就没法做 L3，
       * 没有摘录就没法在指纹失效时给人看。这条来自铁律 5 / docs/03 §三。
       *
       * @param {object} fields
       * @returns {object} 通过 `validateRecord` 的记录
       */
      function makeHighlight(fields) {
        const record = makeTextAnchorRecord('highlight', fields)
        return record
      }

      /**
       * 造一条笔记记录。必填项同 highlight，另外 `note` 不得为空串。
       * 失败抛 `ContractError`。
       *
       * @param {object} fields
       * @returns {object}
       */
      function makeNote(fields) {
        const note = requireString(fields, 'note', { label: 'note 正文' })
        const record = makeTextAnchorRecord('note', fields)
        record.note = note
        return record
      }

      /**
       * 造一条书签。
       *
       * 书签是**点锚点**：只要求 `cfi` 是单路径（无逗号），schema 里也只有 `cfiStart`、没有 `cfiEnd`。
       * 传区间 CFI 会取 start 端（书签语义就是「跳到这里」）。
       * 失败（缺 cfi/chapterHref/deviceId、CFI 不是完整 CFI）抛 `ContractError`。
       *
       * @param {object} fields
       * @returns {object}
       */
      function makeBookmark(fields) {
        const cfi = requireString(fields, 'cfi', { label: '书签 CFI' })
        const chapterHref = requireString(fields, 'chapterHref', { label: '章节 href' })
        // 书签是点锚点；传区间时取它的起点（书签语义就是「跳到这里」）。
        const cfiStart = collapseLocal(cfi, false)
        const record = {
          schema: SCHEMA,
          type: 'bookmark',
          id: fields.id ?? makeUlid(),
          cfi,
          cfiStart,
          chapterHref,
          ...(fields.label !== undefined ? { label: fields.label } : {}),
          createdAt: fields.createdAt ?? nowIso(),
          updatedAt: fields.updatedAt ?? nowIso(),
          deviceId: requireString(fields, 'deviceId', { label: 'deviceId（宿主 device.info 给的）' }),
        }
        if (fields.deleted !== undefined) record.deleted = fields.deleted
        return record
      }

      /**
       * 造一条 AI 问答记录。`anchorCfiRange` / `cutoffCfi` / `question` / `answer` 全为必填：
       * 没有位置锚定的回答不许落盘（契约 §qa 的 description）。
       * 失败抛 `ContractError`。
       *
       * @param {object} fields
       * @returns {object}
       */
      function makeQa(fields) {
        const anchorCfiRange = requireString(fields, 'anchorCfiRange', { label: 'anchorCfiRange' })
        const cutoffCfi = requireString(fields, 'cutoffCfi', { label: 'cutoffCfi' })
        const question = requireString(fields, 'question', { label: 'question' })
        const answer = requireString(fields, 'answer', { label: 'answer' })
        splitCfi(anchorCfiRange)
        splitCfi(cutoffCfi)
        const record = {
          schema: SCHEMA,
          type: 'qa',
          id: fields.id ?? makeUlid(),
          anchorCfiRange,
          question,
          answer,
          cutoffCfi,
        }
        for (const key of ['anchorAnnotationId', 'contextExcerpt', 'contextCfiRange', 'model', 'threadId', 'parentId']) {
          if (fields[key] !== undefined) record[key] = fields[key]
        }
        if (fields.deleted !== undefined) record.deleted = fields.deleted
        record.createdAt = fields.createdAt ?? nowIso()
        record.updatedAt = fields.updatedAt ?? nowIso()
        record.deviceId = requireString(fields, 'deviceId', { label: 'deviceId（宿主 device.info 给的）' })
        return record
      }

      /**
       * 造一条隔离记录（只写不读，等以后能修）。
       *
       * `reason` 必须是 10 个枚举值之一，`sourceDeviceId` 是**原记录**的设备 id
       * （不是本机的——隔离舱要留给跨设备排障用）。`ingestedAt` 默认取当前时间。
       * 失败抛 `ContractError`。
       *
       * @param {object} fields
       * @returns {object}
       */
      function makeQuarantine(fields) {
        const reason = fields?.reason
        if (typeof reason !== 'string' || !QUARANTINE_REASONS.includes(reason)) {
          throw contractError('reason', `必须是 ${QUARANTINE_REASONS.join(' / ')} 之一`)
        }
        const sourceDeviceId = requireString(fields, 'sourceDeviceId', { label: 'sourceDeviceId（原记录的设备 id）' })
        const record = {
          schema: SCHEMA,
          id: fields.id ?? makeUlid(),
          reason,
          sourceDeviceId,
          ingestedAt: fields.ingestedAt ?? nowIso(),
        }
        if (fields.type !== undefined) record.type = fields.type
        if (fields.rawCfi !== undefined) record.rawCfi = fields.rawCfi
        if (fields.rawRecord !== undefined) {
          record.rawRecord = typeof fields.rawRecord === 'string'
            ? fields.rawRecord
            : JSON.stringify(fields.rawRecord)
        }
        if (fields.repairable !== undefined) record.repairable = fields.repairable
        return record
      }

      return { SCHEMA: SCHEMA, COLORS: COLORS, QUARANTINE_REASONS: QUARANTINE_REASONS, ANCHOR_STATUS: ANCHOR_STATUS, makeUlid: makeUlid, fingerprint: fingerprint, compareFingerprint: compareFingerprint, truncateExcerpt: truncateExcerpt, validateRecord: validateRecord, makeRecord: makeRecord, makeHighlight: makeHighlight, makeNote: makeNote, makeBookmark: makeBookmark, makeQa: makeQa, makeQuarantine: makeQuarantine }
    })()

    // ─── client/src/api.js ───
    var __mod_api_js = (function () {
      /**
       * api.js —— 浏览器半访问宿主的唯一出口。
       *
       * 浏览器拿不到文件系统，所有书本数据都靠宿主侧的 `POST /api/dsh-reading/<method>`
       * 与三个 `GET` 静态路由。这一层做三件事：
       *   1. 统一信封解析（`{ok:true,value}` / `{ok:false,error:{code,message}}`）；
       *   2. 把任何失败翻译成一句人话（humanizeError 是幂等的，界面只显示它的输出）；
       *   3. 把 URL 拼装收在一处，避免各组件各自 `encodeURIComponent` 漏一个参数。
       *
       * 失败行为：`call()` 一律抛 `Error`，`message` 已经是给人看的中文。
       * 调用方只需 `catch (e) { setError(humanizeError(e)) }`，不需要再判断错误类型。
       */

      const API_BASE = '/api/dsh-reading'

      /** deviceId 的本地缓存键。只存这一个值，卸载插件时不会有残留语义。 */
      const DEVICE_KEY = 'dsh-reading:deviceId'

      /**
       * 已知错误码 → 人话。宿主侧的错误码是稳定契约，这里逐条给出「用户该做什么」。
       * 未列入的码走下面的通用兜底，绝不把原始 JSON 或字段名透到屏幕上。
       */
      const ERROR_TEXT = {
        E_EPUB_ENCRYPTED: '这本书有 DRM 加密，打不开。请换一本没有加密的 EPUB。',
        E_EPUB_TOO_BIG: '这本书太大或解压后体积异常，为安全起见没有导入。',
        E_EPUB_INVALID: '这个文件不是完整的 EPUB，可能下载时中断了。',
        E_ZIP64: '这个 EPUB 用了暂不支持的 ZIP64 格式，请重新导出后再试。',
        E_MOBI_MALFORMED: '这个 MOBI / AZW3 文件结构不完整，读不出来。换一份再试。',
        E_MOBI_ENCRYPTED: '这本书有 DRM 保护，暂时读不了。请换一本没有加密的。',
        E_MOBI_UNSUPPORTED: '这本书用的压缩方式暂时还不支持，换一本再试。',
        E_TXT_DECODE_FAILED: '这个文本的编码认不出来（试过 UTF-8 与 GB18030），读不了。',
        E_TXT_NOT_TEXT: '这个文件看起来不是文本，可能是别的格式改了扩展名。',
        E_PDF_INVALID: '这个 PDF 文件不完整或不是 PDF，读不出来。换一份再试。',
        E_PDF_ENCRYPTED: '这本 PDF 有密码保护（加密），暂时打不开。请换一本没加密的。',
        E_PDF_NO_TEXT: '这本 PDF 里读不到文字——多半是扫描件（整页是图片）。目前只能读文字版 PDF。',
        E_PDF_NO_PAGES: '这本 PDF 里找不到可以读的页面。',
        E_AI_UNAVAILABLE: '这个版本的宿主没有提供 AI 服务，暂时问不了。',
        E_AI_NO_MODEL: '还没选模型，先在 DSH 里选一个模型再回来问。',
        E_AI_FAILED: 'AI 这次没答上来，稍后再试一次。',
        E_AI_EMPTY: 'AI 没有给出内容，换个问法再试。',
        E_BAD_QUESTION: '先写一句想问的话。',
        E_NO_SELECTION: '先圈住一段原文，再问 AI。',
        E_BOOK_EMPTY: '这个文件里没有读到文字，可能不是一本完整的电子书。',
        E_IMPORT_UNKNOWN_FORMAT: '这个格式还不支持。目前能读 EPUB、MOBI、AZW3、TXT、PDF 五种。',
        E_IMPORT_EMPTY: '没有收到书籍文件，请重新选择一次。',
        E_IMPORT_TOO_BIG: '这本书文件太大了，暂时导入不了。',
        E_IMPORT_URL_BAD: '这个链接打不开，请检查它是否以 http:// 或 https:// 开头。',
        E_IMPORT_DOWNLOAD: '下载失败了，可能是网络不通或对方站点拒绝了访问。',
        E_SOURCE_QUERY: '先输入要搜的书名或作者。',
        E_SOURCE_NONE: '还没有配置书源：先在找书面板里填一个搜索地址模板。',
        E_SOURCE_BAD: '这个书源的搜索地址写得不对，重新填一次。',
        E_SOURCE_FETCH: '连不上这个书源，可能是网络问题或地址写错了。',
        E_IMPORT_BAD_BASE64: '文件传输不完整，请重新导入一次。',
        E_ZIP_CORRUPT: '压缩包已经损坏，换一份文件再试。',
        E_XML_MALFORMED: '这本书的内部结构不合法，无法定位正文。',
        E_NOT_FOUND: '找不到这本书，它可能已经从书架里删掉了。',
        E_NO_BOOK: '找不到这本书，它可能已经从书架里删掉了。',
        E_PATH: '书库里没有这个文件。',
        E_FORBIDDEN: '没有权限访问书库目录，请检查文件夹权限。',
        E_DISK_FULL: '磁盘空间不够了，腾出一些空间再试。',
        E_BUSY: '上一次操作还没结束，请稍等一下。',
        E_BAD_REQUEST: '这次请求没能被接受，请重试一次。',
        E_INTERNAL: '后台出了点问题，请稍后再试。',
      }

      /** 完全给不出信息时的兜底。绝不留空，也绝不显示异常原文。 */
      const GENERIC = '出了点问题，请稍后再试。'

      /** 断网 / 宿主没起来时的专用文案 —— 这是用户最常遇到的一类失败。 */
      const OFFLINE = '连不上后台。可能是软件刚启动还没准备好，等几秒再试一次。'

      /** 这些形态属于「机器语言」，一律不进界面。 */
      const MACHINE_PATTERNS = [
        /^[\[{]/, // JSON 开头
        /[{}]/, // JSON 片段
        /\bat\s+\S+\s*\(.*:\d+:\d+\)/, // 堆栈帧
        /\.(?:js|mjs|ts|json):\d+/, // 文件:行号
        /(?:^|[\s"'(])\/(?:Users|home|var|tmp|private|opt)\//, // 绝对路径
        /[A-Za-z]:\\\\/, // Windows 路径
        /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
        /\bE_[A-Z][A-Z0-9_]+\b/, // 未翻译的错误码
      ]

      /**
       * 把任何错误压成一句能显示的中文。**幂等**：把结果再喂进来，返回同一个字符串。
       *
       * @param {unknown} err Error / string / 任意值
       * @returns {string} 可直接渲染的文案；空串表示「没有可显示的信息」
       */
      function humanizeError(err) {
        const raw = typeof err === 'string'
          ? err
          : (err && typeof err.message === 'string' ? err.message : '')

        const text = raw.trim()
        if (text === '') return ''

        // 已知码优先：宿主返回的 message 基本就是给人看的中文，码只是补充定位
        for (const code of Object.keys(ERROR_TEXT)) {
          if (text.includes(code)) {
            const rest = text.split(code).pop().replace(/^[:：\s]+/, '').trim()
            // 码后面的中文句子通常更具体（「书库目录不可写」），优先用它
            if (rest !== '' && /[\u4e00-\u9fa5]/.test(rest) && !MACHINE_PATTERNS.some((re) => re.test(rest))) {
              return rest
            }
            return ERROR_TEXT[code]
          }
        }

        if (MACHINE_PATTERNS.some((re) => re.test(text))) return GENERIC

        // 已经有中文、且不含机器语言：视为已经人话（这一步保证幂等）
        if (/[\u4e00-\u9fa5]/.test(text)) return text

        if (/fetch|network|ECONN|ETIMEDOUT|ENOTFOUND|Failed to fetch/i.test(text)) return OFFLINE

        return GENERIC
      }

      /**
       * 调一个宿主方法。
       *
       * @param {string} method 如 `shelf.list` / `ann.put`
       * @param {object} [body] 请求体（会 JSON 序列化）
       * @returns {Promise<any>} 成功时的 `value`
       * @throws {Error} message 已经是人话
       */
      async function call(method, body) {
        let res
        try {
          res = await fetch(`${API_BASE}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
        } catch (error) {
          // 网络层抛出来的 TypeError / Failed to fetch 对用户没有意义，直接换成 OFFLINE
          throw new Error(OFFLINE)
        }

        let payload = null
        let text = ''
        try {
          text = await res.text()
          payload = text === '' ? null : JSON.parse(text)
        } catch (error) {
          // 宿主返回了非 JSON（常见于路由没挂上，命中了 SPA 的 index.html）
          throw new Error(res.ok ? GENERIC : ERROR_TEXT.E_INTERNAL)
        }

        if (payload && payload.ok === true) return payload.value

        const err = payload && payload.error
        if (err && typeof err.message === 'string' && err.message.trim() !== '') {
          const combined = err.code ? `${err.code}: ${err.message}` : err.message
          const pretty = humanizeError(combined)
          throw new Error(pretty === '' ? GENERIC : pretty)
        }

        if (res.status === 404) throw new Error(ERROR_TEXT.E_NOT_FOUND)
        if (res.status === 413) throw new Error(ERROR_TEXT.E_EPUB_TOO_BIG)
        if (res.status >= 500) throw new Error(ERROR_TEXT.E_INTERNAL)
        throw new Error(GENERIC)
      }

      /** 章节地址。href 来自 spine/toc，必须整体编码，否则子目录里带 `#` 的路径会截断。 */
      function chapterUrl(bookHash, href) {
        return `${API_BASE}/chapter?book=${encodeURIComponent(bookHash)}&href=${encodeURIComponent(href)}`
      }

      /** 章节内引用的图片 / CSS / 字体地址。 */
      function assetUrl(bookHash, href) {
        return `${API_BASE}/asset?book=${encodeURIComponent(bookHash)}&href=${encodeURIComponent(href)}`
      }

      /**
       * 封面地址。没有封面时宿主返回 404，调用方用 onError 回退到占位块。
       *
       * `version` 传这本书 meta 的 updatedAt：换封面会刷新它，于是地址变了，
       * 浏览器缓存自然失效 —— 宿主给封面设的是 max-age=3600，不带版本号时
       * 换完封面最长一小时还在看旧图。不传（或传空）时退回与旧版一致的地址。
       *
       * @param {string} bookHash
       * @param {string} [version]
       * @returns {string}
       */
      function coverUrl(bookHash, version) {
        const base = `${API_BASE}/cover?book=${encodeURIComponent(bookHash)}`
        const stamp = typeof version === 'string' ? version.trim() : ''
        return stamp === '' ? base : `${base}&v=${encodeURIComponent(stamp)}`
      }

      /**
       * 书名 / 作者 / 封面的写接口共用的书标识。
       *
       * 同时带 `book` 与 `bookHash`：施工图 §4.2 写的是 `book`，而仓库既有路由
       * （book.meta / book.toc / shelf.remove）一律用 `bookHash`。两个键同值，
       * 宿主取哪个都对，省得客户端和宿主各猜一半。
       */
      function bookArgs(bookHash) {
        return { book: bookHash, bookHash }
      }

      /**
       * 改书名 / 作者。
       *
       * 只传确实要改的字段：author 允许改成空串（用户清掉作者名是合法意图），
       * 所以不能用 `patch.author || oldAuthor` 这种「空串当没传」的写法。
       *
       * @param {string} bookHash
       * @param {{ title?: string, author?: string }} patch
       * @returns {Promise<{ book?: { id: string, title: string, author: string, updatedAt: string } }>}
       */
      /** 书内搜索：宿主逐章扫描，返回命中列表（见 docs/13）。 */
      function searchBook(bookHash, query, limit) {
        return call('book.search', { bookHash, query, limit })
      }

      function updateBook(bookHash, patch) {
        const body = bookArgs(bookHash)
        const source = patch && typeof patch === 'object' ? patch : {}
        if (typeof source.title === 'string') body.title = source.title
        if (typeof source.author === 'string') body.author = source.author
        // 0.5.1：简介 / 分类 / 系列 / 标签 / 珍藏
        if (typeof source.description === 'string') body.description = source.description
        if (typeof source.category === 'string') body.category = source.category
        if (typeof source.series === 'string') body.series = source.series
        if (Array.isArray(source.tags)) body.tags = source.tags
        if (typeof source.favorite === 'boolean') body.favorite = source.favorite
        return call('book.update', body)
      }

      /**
       * 换封面。`dataUrl` 是完整的 `data:image/...;base64,...`。
       *
       * @param {string} bookHash
       * @param {string} dataUrl
       * @returns {Promise<{ book?: { id: string, coverHref: string|null, updatedAt: string } }>}
       */
      function putBookCover(bookHash, dataUrl) {
        return call('book.cover.put', { ...bookArgs(bookHash), dataUrl: String(dataUrl || '') })
      }

      /**
       * 恢复默认封面（删掉自选的图，退回米色纸封面）。
       *
       * @param {string} bookHash
       * @returns {Promise<{ book?: { id: string, coverHref: null, updatedAt: string } }>}
       */
      function resetBookCover(bookHash) {
        return call('book.cover.reset', bookArgs(bookHash))
      }

      /**
       * 取本机 deviceId（宿主给，缓存在 localStorage）。
       *
       * 拿不到时**不抛**：返回空串，让上层决定「先只读」。
       * 记录写入仍然会失败得明明白白，比在这里把整个书架搞崩好。
       *
       * @returns {Promise<string>}
       */
      async function getDeviceId() {
        try {
          const cached = globalThis.localStorage?.getItem(DEVICE_KEY)
          if (typeof cached === 'string' && /^[a-z0-9]{2,12}-[a-z0-9]{4,12}$/.test(cached)) return cached
        } catch (error) {
          // 隐私模式下 localStorage 会抛，走下面的网络路径即可
        }
        try {
          const info = await call('device.info')
          const id = info && typeof info.deviceId === 'string' ? info.deviceId : ''
          if (id !== '') {
            try {
              globalThis.localStorage?.setItem(DEVICE_KEY, id)
            } catch (error) {
              // 存不进去不影响本次使用
            }
          }
          return id
        } catch (error) {
          return ''
        }
      }

      /** 清掉缓存的 deviceId（用户换机器 / 排查问题时用）。 */
      function clearDeviceId() {
        try {
          globalThis.localStorage?.removeItem(DEVICE_KEY)
        } catch (error) {
          // 没有 localStorage 就没有残留，什么也不用做
        }
      }

      // ── AI 状态与账本（0.8.0）─────────────────────────────────────────

      /**
       * 读 AI 状态：四道检查 + 最近失败统计。
       *
       * 不抛错：状态读不出来本身也是一种状态（比如插件刚被热重载），
       * 界面要显示「状态未知」，所以这里把失败折成 null 交给调用方。
       */
      async function aiStatus() {
        try {
          return await call('ai.status')
        } catch (error) {
          return null
        }
      }

      /** 真实探测一次：发一句极小的话。返回 `{ ok, latencyMs, model, code?, message?, fix? }`。 */
      async function aiProbe() {
        return call('ai.probe')
      }

      /** 最近调用账本，最新在前。 */
      async function aiLog(limit = 50) {
        const result = await call('ai.log', { limit })
        return result && Array.isArray(result.items) ? result.items : []
      }

      async function aiLogClear() {
        return call('ai.log.clear', {})
      }

      /**
       * 模型名单 + 这次实际会用哪条路由（0.8.1）。
       *
       * 名单由宿主给，读不到时后端回 `available:false`，界面据此只显示「跟随会话」。
       * 这一条不吞错：读不到名单必须让用户看见原因。
       */
      async function aiModels() {
        return call('ai.models')
      }

      // ── 读书蒸馏（0.8.0）──────────────────────────────────────────────

      async function distillGet(bookHash) {
        return call('distill.get', { bookHash })
      }

      /** 蒸一章。会真的调一次模型，慢（几十秒）——调用方要自己显示进度。 */
      async function distillChapter(bookHash, href) {
        return call('distill.chapter', { bookHash, href })
      }

      async function distillSkeleton(bookHash) {
        return call('distill.skeleton', { bookHash })
      }

      async function distillClear(bookHash) {
        return call('distill.clear', { bookHash })
      }

      async function distillExport(bookHash) {
        const result = await call('distill.export', { bookHash })
        return result && typeof result.markdown === 'string' ? result.markdown : ''
      }

      return { API_BASE: API_BASE, humanizeError: humanizeError, call: call, chapterUrl: chapterUrl, assetUrl: assetUrl, coverUrl: coverUrl, searchBook: searchBook, updateBook: updateBook, putBookCover: putBookCover, resetBookCover: resetBookCover, getDeviceId: getDeviceId, clearDeviceId: clearDeviceId, aiStatus: aiStatus, aiProbe: aiProbe, aiLog: aiLog, aiLogClear: aiLogClear, aiModels: aiModels, distillGet: distillGet, distillChapter: distillChapter, distillSkeleton: distillSkeleton, distillClear: distillClear, distillExport: distillExport }
    })()

    // ─── client/src/style.js ───
    var __mod_style_js = (function () {
      /**
       * style.js —— 插件全部样式的唯一来源。
       *
       * 两条约束来自 DSH 的 Web UI 规范，违反会被审查打回：
       *   1. 只消费 `--dsw-alias-*` 语义 token 与 `--dsw-radius-*` 圆角 token，
       *      不复制主题色板、不写主题分支（明暗切换由主题层负责）；
       *   2. 每个 `var()` 都带 fallback —— 插件可能装在还没提供该 token 的宿主版本上，
       *      缺一个变量就整块背景变透明，用户看到的是「白底白字」。
       *
       * 两类例外，都只许出现在各自的单一来源里：
       *   1. 高亮五色：docs/05 §5.5 明确要求用固定 rgba 而不是主题派生色，
       *      因为浅色主题下派生出来的黄会发灰，读者根本看不出「划了哪一句」。
       *      这五个值集中在 HIGHLIGHT_COLORS 里，别处不要另写字面色。
       *   2. 阅读纸色：电子墨水阅读器的「纸」是自己的语义（白纸/羊皮纸/护眼绿/夜间），
       *      不是宿主主题的一部分 —— 深色主题下用户仍可能想看羊皮纸。四档配色定义在
       *      reader.js 的 THEMES 里，经 `--dsh-reading-paper/ink/rule` 三个组件变量传进样式表。
       *      这三个是布局变量命名空间（`--dsh-reading-*`），不是主题 token 的替代品。
       *
       * 注入方式：ensureStyle(doc) 幂等往 <head> 追加一个 <style id="dsh-reading-style">。
       * 注意这只对**父窗口**生效；书籍 iframe 里的 <style> 由 reader.js 单独注入，
       * 且必须带 data-dsh-reading-injected（CFI filter 靠它跳过）。
       */

      /** 父窗口样式表的 id。用 id 而不是 class，便于「只注入一次」。 */
      const STYLE_ID = 'dsh-reading-style'

      /**
       * 五色高亮。名字是 schema 的枚举值（yellow/green/blue/pink/purple），不能改。
       * rgba 的 alpha 刻意压得低：覆盖层压在正文之上，太重会把字盖住。
       */
      const HIGHLIGHT_COLORS = {
        yellow: { fill: 'rgba(255, 214, 64, 0.38)', stroke: 'rgba(214, 168, 0, 0.85)', label: '黄' },
        green: { fill: 'rgba(64, 200, 120, 0.34)', stroke: 'rgba(24, 148, 76, 0.85)', label: '绿' },
        blue: { fill: 'rgba(74, 158, 255, 0.32)', stroke: 'rgba(28, 108, 208, 0.85)', label: '蓝' },
        pink: { fill: 'rgba(255, 122, 168, 0.34)', stroke: 'rgba(206, 62, 118, 0.85)', label: '粉' },
        purple: { fill: 'rgba(168, 122, 255, 0.32)', stroke: 'rgba(118, 68, 208, 0.85)', label: '紫' },
      }

      /** 五色的稳定顺序。侧栏、选区菜单都按它排，用户形成肌肉记忆。 */
      const HIGHLIGHT_ORDER = ['yellow', 'green', 'blue', 'pink', 'purple']

      /** 取某色的样式；未知颜色回退到黄色而不是抛错（旧数据可能带别的值）。 */
      function colorStyle(color) {
        return HIGHLIGHT_COLORS[color] ?? HIGHLIGHT_COLORS.yellow
      }

      const CSS = `
      /* ─────────────────────────────────────────────────────────────
         根容器：插件在 slot 里拿不到确定高度，所以自己撑满并允许收缩。
         --dsh-reading-* 是本组件自己的布局变量（不是主题色），
         色值一律来自 --dsw-alias-*。
         ───────────────────────────────────────────────────────────── */
      .dr-root {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--dsw-alias-bg-base, #ffffff);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-size: 13px;
        line-height: 1.55;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        overflow: hidden;
      }

      .dr-grow { flex: 1 1 auto; min-width: 0; min-height: 0; }
      .dr-row { display: flex; align-items: center; gap: 8px; }
      .dr-col { display: flex; flex-direction: column; gap: 8px; }
      .dr-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dr-wrap { display: flex; flex-wrap: wrap; gap: 6px; }

      /* ── 页头 ─────────────────────────────────────────────────────── */
      .dr-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: var(--dsw-alias-bg-layer-1, #fbfbfc);
        border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
      }
      .dr-head-title {
        font-size: 13.5px;
        font-weight: 650;
        letter-spacing: 0.01em;
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-head-sub {
        font-size: 11.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }

      /* ── 按钮 / 控件：统一 R12，H28–36 ─────────────────────────────── */
      .dr-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        box-sizing: border-box;
        height: 28px;
        padding: 0 10px;
        border-radius: var(--dsw-radius-md, 12px);
        border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 550;
        white-space: nowrap;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
      }
      .dr-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); }
      .dr-btn:active { transform: translateY(0.5px); }
      .dr-btn:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      .dr-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        transform: none;
      }
      .dr-btn-primary {
        border-color: transparent;
        background: var(--dsw-alias-button-primary-fill, #4a7dff);
        color: var(--dsw-alias-label-primary-inverted, #ffffff);
      }
      .dr-btn-primary:hover { background: var(--dsw-alias-button-primary-hover, #3d6ded); }
      .dr-btn-ghost {
        border-color: transparent;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #5b6069);
      }
      .dr-btn-ghost:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-btn-sm { height: 24px; padding: 0 8px; font-size: 12px; }
      .dr-iconbtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        padding: 0;
        border-radius: var(--dsw-radius-md, 12px);
        border: 0.5px solid transparent;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #5b6069);
        cursor: pointer;
        font-family: inherit;
      }
      .dr-iconbtn:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-iconbtn:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      .dr-iconbtn[aria-pressed="true"] {
        background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
        color: var(--dsw-alias-label-primary, #1f2328);
      }

      .dr-input, .dr-select, .dr-textarea {
        box-sizing: border-box;
        width: 100%;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--dsw-alias-label-primary, #1f2328);
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
        border-radius: var(--dsw-radius-md, 12px);
        padding: 7px 9px;
      }
      .dr-textarea { resize: vertical; min-height: 76px; line-height: 1.6; }
      .dr-input:focus, .dr-select:focus, .dr-textarea:focus {
        outline: none;
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
      }

      /* ── 书架 ─────────────────────────────────────────────────────── */
      .dr-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 16px;
      }
      .dr-grid {
        display: grid;
        /* auto-fill 不能换成 auto-fit：auto-fit 会把空列折叠掉，书架只有两三本书时
           剩下的卡片会被拉成「一本占半屏」的超大封面。 */
        grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
        /* 拉伸对齐：同一行的格子统一高度。封面高度由 aspect-ratio 决定（同一行格子
           等宽 → 封面等高），卡片再吸收多余高度、把进度条压到底部
           （.dr-progress 的 margin-top:auto），一行里的卡就一样高。 */
        align-items: stretch;
        gap: 14px;
      }

      /* 格子：grid item 的 min-width 默认是 auto，而卡片里有 nowrap 的作者名，
         于是长作者会把格子撑到比列宽还宽，卡片溢出去盖住邻卡 —— 这就是
         「封面大小错乱 / 堆叠」的根因。min-width:0 把最小内容宽度这个闸门关掉。 */
      .dr-book-cell {
        position: relative;
        display: flex;
        min-width: 0;
        width: 100%;
        max-width: 200px;
        margin: 0 auto;
      }

      /* 书卡：独立内容卡 → R20 (--dsw-radius-xl) */
      .dr-book {
        display: flex;
        flex-direction: column;
        /* 卡片宽度只听格子的（width:100%），自己不参与最小内容宽度的计算 */
        min-width: 0;
        width: 100%;
        gap: 8px;
        padding: 10px;
        text-align: left;
        font-family: inherit;
        color: inherit;
        cursor: pointer;
        border-radius: var(--dsw-radius-xl, 20px);
        border: 0.5px solid var(--dsw-alias-settings-card-stroke, #e6e6ea);
        background: var(--dsw-alias-settings-card-fill, #ffffff);
        transition: border-color 0.12s, transform 0.08s;
      }
      .dr-book:hover {
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
        transform: translateY(-1px);
      }
      .dr-book:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 2px;
      }
      .dr-book:active { transform: none; }

      /* 封面：一本书一格，比例恒定 2:3。用 aspect-ratio 而不是固定高度，窄栏也不变形。
         尺寸只由卡片宽度决定（aspect-ratio），真实封面与米色纸封面共用同一套
         几何 —— 之前真封面走 img 的 intrinsic 尺寸、纸封面走 flex 居中，
         两者在窄栏里会不一样大，看起来就是「封面大小错乱」。 */
      .dr-cover {
        position: relative;
        width: 100%;
        /* 盒子自己撑起 2:3，绝不让 flex 压缩它：卡片被拉高时矮封面会变形 */
        flex: 0 0 auto;
        aspect-ratio: 2 / 3;
        border-radius: var(--dsw-radius-md, 12px);
        overflow: hidden;
        isolation: isolate;
        background: var(--dsw-alias-bg-layer-3, #eceef2);
      }
      .dr-cover img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
        display: block;
      }
      /* 比例极端的封面（比 1:2 还细、接近方形或横版）：铺满会把主体裁掉大半，
         改成「模糊铺底 + 完整图居中」。盒子仍是 2:3，所以同行卡片高度不受影响，
         也不会出现「一张封面被裁成一条」。 */
      .dr-cover.is-extreme {
        background: #2b2e34;
      }
      .dr-cover.is-extreme > img {
        object-fit: contain;
      }
      .dr-cover-blur {
        position: absolute;
        /* 往外多铺 8px：模糊会把边缘吸透明，不多铺就露出一圈底色 */
        inset: -8px;
        background-position: center;
        background-size: cover;
        background-repeat: no-repeat;
        filter: blur(14px) saturate(1.05);
        opacity: 0.55;
        pointer-events: none;
      }
      /* 没有封面的书：排成一本米色纸书的封面，而不是一行灰色小字。
         颜色刻意写死而不走主题 token —— 纸封面就是纸，深色主题下也该是米色。 */
      .dr-cover-fallback {
        position: absolute;
        inset: 0;
        display: grid;
        /* 第一行吃满剩余高度放书名，第二行给作者留固定一条 —— 不用绝对定位，
           长书名再长也压不到作者名字上去。 */
        grid-template-rows: 1fr auto;
        align-items: center;
        justify-items: center;
        row-gap: 8px;
        padding: 14px 12px 10px;
        background: linear-gradient(160deg, #f6eedb 0%, #efe3c8 60%, #e9dcbe 100%);
        color: #4a3f35;
        text-align: center;
        overflow: hidden;
      }
      .dr-cover-frame {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 9px;
        width: 100%;
        min-height: 0;
        max-height: 100%;
        overflow: hidden;
      }
      .dr-cover-rule {
        width: 26px;
        height: 0;
        border-top: 1px solid rgba(74, 63, 53, 0.42);
      }
      .dr-cover-text {
        max-width: 100%;
        font-family: "Songti SC", "SimSun", "Source Han Serif SC", serif;
        font-weight: 600;
        line-height: 1.32;
        letter-spacing: 0.04em;
        text-wrap: balance;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        -webkit-box-orient: vertical;
        word-break: break-word;
      }
      .dr-cover-author {
        /* nowrap 让内容不肯收缩，overflow 只裁「看得见的」、不减小最小内容宽度，
           所以必须显式把宽度钉在盒子里，否则长作者名会把整个格子顶宽。 */
        min-width: 0;
        max-width: 100%;
        width: 100%;
        font-size: 9.5px;
        letter-spacing: 0.02em;
        color: rgba(74, 63, 53, 0.66);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dr-book-title {
        /* 同一个道理：两行截断的书名也不许参与「最小内容宽度」的计算 */
        min-width: 0;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2328);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .dr-book-meta {
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      /* 重排书标记（MOBI / TXT 转来的）：小、浅、不抢书名。 */
      .dr-book-badge {
        align-self: center;
        padding: 1px 6px;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsw-alias-bg-layer-3, #eceef2);
        color: var(--dsw-alias-label-secondary, #5c6270);
        font-size: 10px;
        line-height: 1.5;
        white-space: nowrap;
      }
      .dr-progress {
        height: 3px;
        /* 贴底：同一行里有的卡多了「TXT · 重排」标记，卡片被拉成等高之后，
           进度条和「读了 30%」一起压在底部，一行看过去才是齐的 */
        margin-top: auto;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsw-alias-bg-layer-3, #eceef2);
        overflow: hidden;
      }
      .dr-progress-fill {
        height: 100%;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsw-alias-brand-primary, #4a7dff);
      }

      /* ── 编辑书名 / 封面的弹窗 ───────────────────────────────────── */
      /* 封面预览沿用书卡的 2:3 盒子，只是窄一些：用户在弹窗里看到的就是书架上
         会变成的样子，比例不一致会让他以为「保存后封面会变形」。 */
      .dr-edit-cover {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .dr-edit-cover-preview {
        flex: 0 0 auto;
        width: 84px;
      }
      .dr-edit-cover-actions {
        flex: 1 1 auto;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        min-width: 0;
      }
      .dr-field-hint {
        width: 100%;
        font-size: 11.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      /* 表单里的错误提示：不走错误框，弹窗里空间小，一行红字更省地方 */
      .dr-form-error {
        margin-top: 10px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--dsw-alias-state-error-primary, #d93025);
      }

      /* 轻提示（保存成功之类）：飘在底部中间，两秒自己走，不挡点击 */
      .dr-toast {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%);
        z-index: 60;
        padding: 8px 14px;
        border-radius: 999px;
        corner-shape: round;
        background: rgba(20, 22, 26, 0.86);
        color: #ffffff;
        font-size: 12px;
        line-height: 1.4;
        pointer-events: none;
      }

      /* ── 空态 / 加载态 / 错误态 ───────────────────────────────────── */
      .dr-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 40px 24px;
        text-align: center;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      .dr-state-title {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-secondary, #5b6069);
      }
      .dr-state-text {
        font-size: 12.5px;
        line-height: 1.6;
        max-width: 34em;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        white-space: pre-wrap;
      }
      .dr-state-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
      .dr-error { color: var(--dsw-alias-state-error-primary, #d93025); }
      .dr-error-box {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px 12px;
        margin: 0 0 12px;
        border-radius: var(--dsw-radius-md, 12px);
        border: 1px solid var(--dsw-alias-state-error-secondary, #f0c0bd);
        background: var(--dsw-alias-bg-layer-2, #fdf3f2);
        color: var(--dsw-alias-state-error-primary, #d93025);
        font-size: 12.5px;
        line-height: 1.55;
      }
      .dr-spinner {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        corner-shape: round;
        border: 2px solid var(--dsw-alias-border-l3, #d9d9e0);
        border-top-color: var(--dsw-alias-brand-primary, #4a7dff);
        animation: dr-spin 0.8s linear infinite;
      }
      @keyframes dr-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .dr-spinner { animation-duration: 2.4s; }
        .dr-book, .dr-btn { transition: none; }
      }

      /* ── 阅读器 ───────────────────────────────────────────────────── */
      .dr-reader {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--dsw-alias-bg-layer-1, #f7f7f9);
      }
      .dr-reader-bar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-base, #ffffff);
      }
      .dr-reader-title {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-reader-main {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        position: relative;
      }

      /* 书籍视口：这里是唯一一个 iframe，装的是 EPUB 章节本身，不是插件页面。
         它必须看得见纸面质感，所以背景给一个偏暖的白，字色由章节 CSS 决定。 */
      .dr-viewport {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        position: relative;
        overflow: hidden;
        background: var(--dsw-alias-bg-base, #ffffff);
      }
      .dr-frame {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }
      /* 覆盖层：绝对定位于视口之上，pointer-events:none 保证正文选择不被挡住；
         需要点击的条目自己打开 pointer-events。 */
      .dr-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      .dr-hl {
        position: absolute;
        border-radius: var(--dsw-radius-xs, 4px);
        pointer-events: auto;
        cursor: pointer;
      }
      .dr-hl-note::after {
        content: "";
        position: absolute;
        right: -2px;
        bottom: -2px;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        corner-shape: round;
        background: var(--dsw-alias-label-secondary, #5b6069);
      }
      /* 选中态：操作条打开的那条（或刚判为冲突的两条）描一圈。
         focus-visible 也走同一圈——键盘 Tab 过去要看得见焦点在哪。 */
      .dr-hl:focus { outline: none; }
      .dr-hl:hover,
      .dr-hl:focus-visible,
      .dr-hl-active {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      .dr-hl-conflict {
        outline: 2px solid var(--dsw-alias-label-secondary, #5b6069);
        outline-offset: 1px;
      }
      /* 操作条上的是刚点中的那个颜色：加一圈深色描边，别只靠色差暗示。 */
      .dr-swatch-on {
        box-shadow: 0 0 0 2px var(--dsw-alias-label-primary, #22262b);
      }
      /* 删除是破坏性操作，用次要文字色而不是大红：阅读界面里红色太吵。 */
      .dr-btn-danger { color: var(--dsw-alias-label-secondary, #5b6069); }
      .dr-btn-danger:hover { color: var(--dsw-alias-label-primary, #22262b); }
      /* 带「撤销」的 toast 得能点，所以单独放开 pointer-events（.dr-toast 默认不让点）。 */
      .dr-toast-with-action { pointer-events: auto; }
      .dr-toast-action {
        margin-left: 10px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--dsw-alias-brand-primary, #8ab4ff);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }

      /* 翻页窄边：正文留白里的一条 26px 竖条，看得见、点得到。
         不用「盖在正文上的大块透明热区」——那会抢鼠标，划过字就误翻页。
         也不占正文宽度：它是 flex 里的独立一格，正文容器自己按剩余宽度重新分栏。 */
      .dr-rail {
        flex: 0 0 auto;
        /* 抬到翻页热区（.dr-turn-zone, z-index:1）之上：热区是压在正文上的绝对定位块，
           它原本会盖住这两条窄边，让「点窄边翻页」时灵时不灵。 */
        position: relative;
        z-index: 3;
        width: 26px;
        border: 0;
        padding: 0;
        margin: 0;
        align-self: stretch;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--dsh-reading-ink, #22262b);
        cursor: pointer;
        -webkit-user-select: none;
        user-select: none;
      }
      .dr-rail-chevron {
        font-size: 18px;
        line-height: 1;
        opacity: 0.22;
        transition: opacity 0.12s, transform 0.12s;
      }
      .dr-rail:hover .dr-rail-chevron { opacity: 0.7; transform: scale(1.18); }
      .dr-rail:active .dr-rail-chevron { transform: scale(1.04); }
      .dr-rail:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: -4px;
        border-radius: var(--dsw-radius-xs, 4px);
      }
      .dr-rail:disabled { cursor: default; }
      .dr-rail:disabled .dr-rail-chevron { opacity: 0.08; transform: none; }

      /* 翻页动效：只做「位置感」，不动 DOM、不碰选区。
         220ms 与 reader.js 里 flashTurn 的定时器对齐。 */
      @keyframes dr-turn-next {
        from { opacity: 0.55; transform: translateX(14px); }
        to { opacity: 1; transform: none; }
      }
      @keyframes dr-turn-prev {
        from { opacity: 0.55; transform: translateX(-14px); }
        to { opacity: 1; transform: none; }
      }
      .dr-viewport.dr-turn-next .dr-frame { animation: dr-turn-next 0.22s ease-out both; }
      .dr-viewport.dr-turn-prev .dr-frame { animation: dr-turn-prev 0.22s ease-out both; }
      @media (prefers-reduced-motion: reduce) {
        .dr-viewport.dr-turn-next .dr-frame,
        .dr-viewport.dr-turn-prev .dr-frame { animation: none; }
      }

      .dr-pageinfo {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 6px 12px;
        font-size: 11.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        border-top: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-base, #ffffff);
      }

      /* ── 目录 / 标注侧栏（面板 R28 只给真正的外壳用） ──────────────── */
      .dr-side {
        flex: 0 0 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        border-left: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-base, #ffffff);
        overflow: hidden;
      }
      .dr-side-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        font-size: 12px;
        font-weight: 600;
        color: var(--dsw-alias-label-secondary, #5b6069);
      }
      .dr-side-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 6px;
      }

      /* 目录行：控件级 R12；缩进按 depth 给，不用嵌套列表（深度只有几级，够了） */
      .dr-toc-row {
        display: block;
        width: 100%;
        box-sizing: border-box;
        text-align: left;
        padding: 5px 9px;
        border: 0;
        border-radius: var(--dsw-radius-md, 12px);
        background: transparent;
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-family: inherit;
        font-size: 12.5px;
        line-height: 1.45;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dr-toc-row:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-toc-row[aria-current="true"] {
        background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-weight: 600;
      }
      .dr-toc-row:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: -2px;
      }

      /* 「自动识别」的说明条：目录是猜出来的时候，先自报家门。
         用户看到这一句，才知道「章节名有点怪」不是我们弄坏了书。 */
      .dr-toc-note {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 4px 9px 8px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 11.5px;
        line-height: 1.5;
      }
      .dr-toc-badge {
        flex: 0 0 auto;
        padding: 1px 6px;
        border-radius: 999px;
        corner-shape: round;
        background: rgba(0, 0, 0, 0.06);
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-size: 11px;
        line-height: 1.5;
        opacity: 0.85;
        white-space: nowrap;
      }
      .dr-toc-note-text {
        min-width: 0;
      }

      /* 标注条目 */
      .dr-ann {
        display: flex;
        gap: 7px;
        align-items: flex-start;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 8px;
        border: 0.5px solid transparent;
        border-radius: var(--dsw-radius-md, 12px);
        background: transparent;
        text-align: left;
        font-family: inherit;
        color: inherit;
        cursor: pointer;
      }
      .dr-ann:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        border-color: var(--dsw-alias-border-l2, #e6e6ea);
      }
      .dr-ann:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: -2px;
      }
      .dr-ann-dot {
        flex: 0 0 8px;
        width: 8px;
        height: 8px;
        margin-top: 5px;
        border-radius: 50%;
        corner-shape: round;
      }
      .dr-ann-main { flex: 1 1 auto; min-width: 0; }
      .dr-ann-text {
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--dsw-alias-label-primary, #1f2328);
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }
      .dr-ann-note {
        margin-top: 3px;
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }
      .dr-ann-meta {
        margin-top: 3px;
        font-size: 11px;
        color: var(--dsw-alias-label-quaternary, #a8adb5);
      }

      /* ── 选区菜单（挂父窗口，避免被 iframe 裁切） ──────────────────── */
      .dr-menu {
        position: fixed;
        z-index: 40;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 6px;
        border: 0;
        border-radius: var(--dsw-radius-lg, 16px);
        background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.97));
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 8px 22px rgba(0, 0, 0, 0.12);
      }
      .dr-swatch {
        width: 20px;
        height: 20px;
        padding: 0;
        border: 1px solid var(--dsw-alias-border-l3, #d9d9e0);
        border-radius: 50%;
        corner-shape: round;
        cursor: pointer;
      }
      .dr-swatch:hover { transform: scale(1.12); }
      .dr-swatch:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      .dr-menu-sep {
        width: 1px;
        height: 18px;
        margin: 0 2px;
        background: var(--dsw-alias-border-l2, #e6e6ea);
      }

      /* 笔记编辑小卡：对话框级别的浮层，用 panel 圆角 */
      .dr-note-card {
        position: fixed;
        z-index: 41;
        width: 268px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border: 0;
        border-radius: var(--dsw-radius-panel, 28px);
        background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.98));
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 10px 28px rgba(0, 0, 0, 0.16);
      }
      .dr-note-card .dr-textarea {
        border-radius: var(--dsw-radius-md, 12px);
        min-height: 64px;
      }
      .dr-note-actions { display: flex; justify-content: flex-end; gap: 6px; }

      /* 顶部细进度条：阅读时一直看得见「读到哪了」 */
      .dr-topbar {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 2px;
        background: transparent;
        z-index: 4;
        pointer-events: none;
      }
      .dr-topbar-fill {
        height: 100%;
        background: var(--dsw-alias-brand-primary, #4a7dff);
        transition: width 0.2s;
      }
      /* ─────────────────────────────────────────────────────────────
         阅读器外观：纸面、底栏、设置抽屉、使用说明。
         纸色/墨色来自 reader.js 的四档配色，经内联 CSS 变量传进来
         （--dsh-reading-paper / --dsh-reading-ink / --dsh-reading-rule），缺省时回落到白纸。
         ───────────────────────────────────────────────────────────── */
      .dr-reader {
        background: var(--dsh-reading-paper, #fcfbf8);
        color: var(--dsh-reading-ink, #22262b);
      }
      .dr-reader-bar {
        background: var(--dsh-reading-paper, #fcfbf8);
        border-bottom: 0.5px solid var(--dsh-reading-rule, #e6e2d8);
      }
      .dr-reader-title { color: var(--dsh-reading-ink, #22262b); }
      .dr-reader-bar .dr-head-sub { color: var(--dsh-reading-ink, #22262b); opacity: 0.55; }
      .dr-reader-bar .dr-btn-ghost { color: var(--dsh-reading-ink, #22262b); }
      .dr-reader-bar .dr-iconbtn { color: var(--dsh-reading-ink, #22262b); }
      .dr-reader-bar .dr-iconbtn:hover { background: rgba(128, 128, 128, 0.14); }
      .dr-reader .dr-iconbtn-q {
        font-weight: 700;
        font-family: ui-serif, Georgia, serif;
      }
      .dr-viewport { background: var(--dsh-reading-paper, #fcfbf8); }
      .dr-frame { background: var(--dsh-reading-paper, #fcfbf8); }
      .dr-rail { color: var(--dsh-reading-ink, #22262b); }

      /* 底栏：可见的「上一页 / 下一页」+ 页码 + 本章进度。只在鼠标移上来时才显形，
         读的时候不抢注意力；触屏设备（hover:none）常显。 */
      .dr-pagebar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 12px;
        border-top: 0.5px solid var(--dsh-reading-rule, #e6e2d8);
        background: var(--dsh-reading-paper, #fcfbf8);
        font-size: 11.5px;
        color: var(--dsh-reading-ink, #22262b);
        opacity: 0.72;
        transition: opacity 160ms ease;
      }
      .dr-reader:hover .dr-pagebar { opacity: 1; }
      .dr-pagebtn {
        flex: 0 0 auto;
        height: 26px;
        padding: 0 10px;
        border-radius: var(--dsw-radius-sm, 8px);
        border: 0.5px solid var(--dsh-reading-rule, #e6e2d8);
        background: rgba(128, 128, 128, 0.06);
        color: inherit;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
      }
      .dr-pagebtn:hover:not(:disabled) { background: rgba(128, 128, 128, 0.16); }
      .dr-pagebtn:disabled { opacity: 0.35; cursor: default; }
      .dr-pagebtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff); outline-offset: 1px; }
      .dr-pagebar-mid {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        justify-content: center;
      }
      .dr-pagebar-num {
        font-variant-numeric: tabular-nums;
        opacity: 0.85;
        /* 从 <span> 改成 <button>：点它就能输入页码跳转，所以要抹掉浏览器默认按钮外观 */
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        background: transparent;
        padding: 1px 6px;
        border-radius: var(--dsw-radius-xs, 4px);
        font: inherit;
        color: inherit;
        cursor: pointer;
      }
      .dr-pagebar-num:hover {
        opacity: 1;
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
      .dr-pagejump { display: inline-flex; align-items: baseline; gap: 4px; }
      .dr-pagejump-input {
        width: 52px;
        padding: 1px 4px;
        border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
        border-radius: var(--dsw-radius-xs, 4px);
        background: color-mix(in srgb, currentColor 6%, transparent);
        color: inherit;
        font: inherit;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      .dr-pagejump-input::-webkit-outer-spin-button,
      .dr-pagejump-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .dr-pagejump-input:focus { outline: 2px solid var(--dsh-reading-accent, #4a7dff); outline-offset: 1px; }
      .dr-pagejump-hint { opacity: 0.6; white-space: nowrap; }
      .dr-pagebar-pct { font-variant-numeric: tabular-nums; opacity: 0.6; white-space: nowrap; }
      .dr-pagebar-track {
        flex: 0 1 220px;
        height: 3px;
        min-width: 60px;
        border-radius: var(--dsw-radius-xs, 4px);
        background: rgba(128, 128, 128, 0.22);
        overflow: hidden;
      }
      .dr-pagebar-fill {
        height: 100%;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsh-reading-ink, #22262b);
        opacity: 0.42;
        transition: width 160ms ease;
      }
      @media (hover: none) {
        .dr-pagebar { opacity: 0.95; }
      }

      /* ── 设置抽屉：从右侧滑出，浮在正文之上 ─────────────────────── */
      .dr-drawer {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 8;
        width: 292px;
        max-width: 88%;
        display: flex;
        flex-direction: column;
        background: var(--dsw-alias-bg-base, #ffffff);
        color: var(--dsw-alias-label-primary, #1f2328);
        border-left: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        box-shadow: -12px 0 32px rgba(0, 0, 0, 0.14);
        border-radius: var(--dsw-radius-xl, 20px) 0 0 var(--dsw-radius-xl, 20px);
        animation: dr-drawer-in 160ms ease-out;
      }
      @keyframes dr-drawer-in {
        from { transform: translateX(12px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .dr-drawer-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        font-size: 12.5px;
        font-weight: 600;
      }
      .dr-drawer-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .dr-field { display: flex; flex-direction: column; gap: 8px; }
      .dr-field-label {
        font-size: 11.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        letter-spacing: 0.02em;
      }
      .dr-field-value {
        font-size: 11.5px;
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-variant-numeric: tabular-nums;
        min-width: 42px;
        text-align: right;
      }
      .dr-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .dr-chip {
        height: 28px;
        padding: 0 11px;
        border-radius: var(--dsw-radius-sm, 8px);
        border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-size: 12px;
        cursor: pointer;
      }
      .dr-chip:hover { background: var(--dsw-alias-interactive-bg-hover, #e9eaee); }
      .dr-chip.is-on {
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
        color: var(--dsw-alias-brand-primary, #4a7dff);
        background: rgba(74, 125, 255, 0.1);
        font-weight: 600;
      }
      .dr-slider-row { display: flex; align-items: center; gap: 8px; }
      .dr-slider {
        flex: 1 1 auto;
        min-width: 0;
        height: 3px;
        appearance: none;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsw-alias-border-l2, #e6e6ea);
        outline: none;
      }
      .dr-slider::-webkit-slider-thumb {
        appearance: none;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        corner-shape: round;
        background: var(--dsw-alias-brand-primary, #4a7dff);
        border: 2px solid var(--dsw-alias-bg-base, #ffffff);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24);
        cursor: pointer;
      }
      .dr-step {
        flex: 0 0 auto;
        height: 26px;
        min-width: 32px;
        padding: 0 6px;
        border-radius: var(--dsw-radius-sm, 8px);
        border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-size: 11.5px;
        cursor: pointer;
      }
      .dr-step:hover { background: var(--dsw-alias-interactive-bg-hover, #e9eaee); }
      .dr-themes { display: flex; gap: 8px; }
      .dr-theme {
        flex: 1 1 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        padding: 4px;
        border: 0;
        background: transparent;
        cursor: pointer;
      }
      .dr-theme-swatch {
        width: 100%;
        aspect-ratio: 3 / 4;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--dsw-radius-sm, 8px);
        border: 1px solid transparent;
        font-size: 15px;
        font-weight: 600;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
      }
      .dr-theme.is-on .dr-theme-swatch { border-color: var(--dsw-alias-brand-primary, #4a7dff); }
      .dr-theme-label {
        font-size: 10.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      .dr-theme.is-on .dr-theme-label { color: var(--dsw-alias-brand-primary, #4a7dff); font-weight: 600; }
      .dr-drawer-error {
        font-size: 11.5px;
        color: var(--dsw-alias-state-error-primary, #d93025);
      }
      .dr-drawer-foot {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-top: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
      }

      /* ── 使用说明弹窗 ────────────────────────────────────────────── */
      .dr-modal-mask {
        position: absolute;
        inset: 0;
        z-index: 12;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.42);
      }
      .dr-modal {
        width: 100%;
        max-width: 560px;
        max-height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--dsw-alias-bg-base, #ffffff);
        color: var(--dsw-alias-label-primary, #1f2328);
        border-radius: var(--dsw-radius-xl, 20px);
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3);
        overflow: hidden;
      }
      .dr-modal-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        font-size: 13px;
        font-weight: 600;
      }
      .dr-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 14px;
        font-size: 12.5px;
        line-height: 1.72;
        color: var(--dsw-alias-label-secondary, #5b6069);
      }
      .dr-modal-body p { margin: 0 0 10px; }
      .dr-modal-body h4 {
        margin: 16px 0 8px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-keys { display: flex; flex-direction: column; gap: 5px; }
      .dr-key-row { display: flex; align-items: baseline; gap: 10px; }
      .dr-key-row kbd {
        flex: 0 0 150px;
        padding: 1px 6px;
        border-radius: var(--dsw-radius-xs, 4px);
        border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-modal-foot {
        flex: 0 0 auto;
        display: flex;
        justify-content: flex-end;
        padding: 10px 14px;
        border-top: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
      }

      @media (prefers-reduced-motion: reduce) {
        .dr-topbar-fill { transition: none; }
      }

      /* 窄容器：侧栏改为覆盖在正文上，避免正文被挤到 0 宽 */
      @media (max-width: 720px) {
        .dr-side {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          z-index: 5;
          box-shadow: 0 0 24px rgba(0, 0, 0, 0.16);
        }
        .dr-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
        /* 窄栏里列宽本身就可能小于 200px，别再给上限，否则卡片两侧留空太宽 */
        .dr-book-cell { max-width: none; }
        .dr-body { padding: 12px; }
      }

      /* 宽栏：列再宽也把卡片钳住（else 一本占四分之一屏，封面大得离谱），
         格子居中留白，比让封面无限变大好看 */
      @media (min-width: 1100px) {
        .dr-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
        .dr-book-cell { max-width: 184px; }
      }

      /* ── 问 AI：划词菜单里那个按钮 + 底部提问面板 ────────────────────── */

      .dr-menu-ask {
        /* 五个色板之后第一个实心按钮，视觉上把「问 AI」和「选颜色」分开 */
        margin: 0 2px;
      }

      .dr-ask-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.28);
        display: flex;
        align-items: flex-end;
        justify-content: center;
        z-index: 40;
      }

      .dr-ask {
        width: 100%;
        max-height: 72%;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px 14px 12px;
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        color: var(--dsw-alias-label-primary, #22262b);
        border-radius: var(--dsw-radius-xl, 20px) var(--dsw-radius-xl, 20px) 0 0;
        box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.18);
      }

      .dr-ask-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .dr-ask-title {
        font-size: 13px;
        font-weight: 600;
      }

      .dr-ask-quote {
        font-size: 12px;
        line-height: 1.6;
        color: var(--dsw-alias-label-secondary, #6b7280);
        background: var(--dsw-alias-bg-layer-2, #f5f5f4);
        border-left: 2px solid var(--dsw-alias-accent-primary, #4a7dff);
        border-radius: var(--dsw-radius-xs, 4px);
        padding: 8px 10px;
        max-height: 4.9em;
        overflow: hidden;
      }

      .dr-ask-input {
        min-height: 56px;
        resize: vertical;
      }

      .dr-ask-answer {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-layer-2, #f5f5f4);
      }

      .dr-ask-answer-label {
        font-size: 11px;
        letter-spacing: 0.04em;
        color: var(--dsw-alias-label-secondary, #6b7280);
      }

      .dr-ask-answer-text {
        font-size: 13px;
        line-height: 1.75;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .dr-ask-answer-meta {
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
      }

      .dr-ask-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }


      /* ── 书架筛选（0.5.1） ───────────────────────────────────────── */
      .dr-filters {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 0 0 10px;
      }
      .dr-filter-select {
        width: auto;
        min-width: 96px;
        padding: 5px 8px;
        font-size: 12.5px;
      }
      .dr-filters-count {
        font-size: 11.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        margin-left: auto;
      }
      .dr-filter-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 56px 20px;
        color: var(--dsw-alias-label-secondary, #5c6270);
        font-size: 13px;
        text-align: center;
      }
      .dr-book-taxon {
        font-size: 10.5px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      .dr-book-star {
        position: absolute;
        top: 6px;
        left: 8px;
        font-size: 13px;
        line-height: 1;
        color: #d9a520;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        pointer-events: none;
      }

      /* ── 元数据编辑与导入面板里的控件（0.5.1） ───────────────────── */
      .dr-textarea {
        resize: vertical;
        min-height: 68px;
        line-height: 1.6;
        font-family: inherit;
      }
      .dr-select {
        width: auto;
        padding: 5px 8px;
      }
      .dr-field-inline {
        flex-direction: row;
        align-items: center;
      }
      .dr-check {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 13px;
        color: var(--dsw-alias-label-primary, #1f2328);
        cursor: pointer;
      }

      /* ── 导入面板：本地文件 / 粘贴链接 / 找书（0.5.1） ───────────── */
      .dr-import {
        width: min(560px, calc(100vw - 32px));
      }
      .dr-import .dr-modal-body {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .dr-import-section {
        display: flex;
        flex-direction: column;
        gap: 7px;
        padding: 12px;
        border: 1px solid var(--dsw-alias-border-l1, #e3e5e8);
        border-radius: var(--dsw-radius-m, 8px);
        background: var(--dsw-alias-bg-layer-1, #fafafa);
      }
      .dr-import-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-import-hint {
        font-size: 11.5px;
        line-height: 1.6;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      .dr-import-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dr-import-error {
        font-size: 11.5px;
        color: var(--dsw-alias-label-error, #c4342b);
      }
      .dr-import-linkbtn {
        align-self: flex-start;
        font-size: 12px;
      }
      .dr-candidates {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 260px;
        overflow-y: auto;
      }
      .dr-candidate {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: var(--dsw-radius-s, 6px);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
      }
      .dr-candidate-title {
        flex: 1;
        min-width: 0;
        font-size: 12.5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dr-source-form {
        display: flex;
        flex-direction: column;
        gap: 7px;
        padding-top: 6px;
        border-top: 1px dashed var(--dsw-alias-border-l1, #e3e5e8);
      }

      /* 窄屏：筛选栏与导入面板都退化成单列 */
      @media (max-width: 720px) {
        .dr-filters {
          gap: 6px;
        }
        .dr-filter-select {
          flex: 1 1 40%;
        }
        .dr-filters-count {
          margin-left: 0;
        }
        .dr-import {
          width: calc(100vw - 16px);
        }
        .dr-import-row {
          flex-direction: column;
          align-items: stretch;
        }
      }
      `

      /**
       * v0.6.0 追加样式块。
       *
       * 为什么单独成一个常量：这一版加的东西彼此无关（高亮配色、菜单紧凑化、目录强调、
       * 翻页热区、搜索/笔记/问答三块面板、相对单位替换），混进上面那份 1500 行的 CSS 里
       * 以后没人找得到。集中一块 + 拼在末尾（后写覆盖先写），既好读也好回滚。
       *
       * 三条自家规矩照旧：只消费 --dsw-alias-* 语义 token 与 --dsw-radius-* 圆角 token，
       * 每个 var() 都带 fallback，不写主题分支（纸面主题除外，见 A 段的说明）。
       * 全文一律不用 oklch 色彩函数：纸面与高亮都留在 sRGB，老 WebView 也认。
       */
      const CSS_V060 = `
      /* ═══════════════════ A. 高亮五色跟随纸面主题 ═══════════════════
         问题：HIGHLIGHT_COLORS 的五色是固定浅色 rgba，叠在夜间纸面上会把浅灰正文洗掉，
         「划了哪一句」看得见、字却看不见。

         做法：把「填色 + 描边」提升成组件变量，亮/暗各一套。
         兜底：默认值就是 HIGHLIGHT_COLORS 里的原值 —— 变量缺失时观感与改动前完全一致。

         ⚠ 选择器说明（这里曾经想写 .dr-page[data-theme="night"]，但实测不成立）：
           · 全仓 grep：没有任何 data-theme 属性（0 处），也没有 .dr-page 这个节点。
           · 纸面主题的真实机制是：reader.js 在 .dr-reader 上内联
             --dsh-reading-paper / --dsh-reading-ink / --dsh-reading-rule，
             主题键来自 reader.js 的 THEMES：light / sepia / green / dark。
           · 所以钩子挂在 .dr-reader 上，夜间按真实键写 [data-theme="dark"]，
             再留一个 night 别名（等上层哪天改用 night 命名时不用再改样式）。
         这两条夜间规则在 .dr-reader 拿到 data-theme 之前不会匹配，等于死规则；
         死规则不进层叠、不影响任何现有渲染，但要让夜间配色真的生效，
         需要 reader.js 补一行 data-theme（不属本次改动范围）。
         ─────────────────────────────────────────────────────────────── */
      .dr-reader,
      .dr-root {
        /* 亮色纸面：浅底 + 深字，与 HIGHLIGHT_COLORS 的观感对齐 */
        --dsh-reading-hl-yellow: rgba(255, 214, 64, 0.38);
        --dsh-reading-hl-green: rgba(64, 200, 120, 0.34);
        --dsh-reading-hl-blue: rgba(74, 158, 255, 0.32);
        --dsh-reading-hl-pink: rgba(255, 122, 168, 0.34);
        --dsh-reading-hl-purple: rgba(168, 122, 255, 0.32);
        --dsh-reading-hl-yellow-underline: rgba(214, 168, 0, 0.85);
        --dsh-reading-hl-green-underline: rgba(24, 148, 76, 0.85);
        --dsh-reading-hl-blue-underline: rgba(28, 108, 208, 0.85);
        --dsh-reading-hl-pink-underline: rgba(206, 62, 118, 0.85);
        --dsh-reading-hl-purple-underline: rgba(118, 68, 208, 0.85);
      }

      /* 夜间纸面：深底 + 亮描边。
         底色的 alpha 刻意压到 0.55 上下 —— 覆盖层压在字上，太实就把 #c9cdd3 的正文盖住了；
         描边提亮到纯色，靠那一条线把「划到哪」交代清楚，而不是靠整块发光。 */
      .dr-reader[data-theme="dark"],
      .dr-reader[data-theme="night"],
      .dr-root[data-theme="dark"],
      .dr-root[data-theme="night"] {
        --dsh-reading-hl-yellow: rgba(122, 92, 0, 0.55);
        --dsh-reading-hl-green: rgba(16, 92, 56, 0.55);
        --dsh-reading-hl-blue: rgba(20, 66, 132, 0.6);
        --dsh-reading-hl-pink: rgba(122, 28, 66, 0.55);
        --dsh-reading-hl-purple: rgba(78, 44, 132, 0.55);
        --dsh-reading-hl-yellow-underline: #ffd640;
        --dsh-reading-hl-green-underline: #4ad98a;
        --dsh-reading-hl-blue-underline: #6aa9ff;
        --dsh-reading-hl-pink-underline: #ff8fbb;
        --dsh-reading-hl-purple-underline: #b493ff;
      }

      /* 变量优先。为什么必须 !important：划线的颜色现在是 annotate.js 用内联
         style.background / boxShadow 写的（annotate.js:755），内联样式的优先级高于任何
         类选择器，不加 !important 这条规则永远输。
         生效条件：annotate.js 给盒子补一个 dr-hl-<color> 类名（类名与 HIGHLIGHT_ORDER
         一一对应）。在那之前这些规则不匹配任何节点，是纯粹的「备好的接口」，不会改坏现有颜色。 */
      .dr-hl-yellow {
        background: var(--dsh-reading-hl-yellow, rgba(255, 214, 64, 0.38)) !important;
        box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-yellow-underline, rgba(214, 168, 0, 0.85)) !important;
      }
      .dr-hl-green {
        background: var(--dsh-reading-hl-green, rgba(64, 200, 120, 0.34)) !important;
        box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-green-underline, rgba(24, 148, 76, 0.85)) !important;
      }
      .dr-hl-blue {
        background: var(--dsh-reading-hl-blue, rgba(74, 158, 255, 0.32)) !important;
        box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-blue-underline, rgba(28, 108, 208, 0.85)) !important;
      }
      .dr-hl-pink {
        background: var(--dsh-reading-hl-pink, rgba(255, 122, 168, 0.34)) !important;
        box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-pink-underline, rgba(206, 62, 118, 0.85)) !important;
      }
      .dr-hl-purple {
        background: var(--dsh-reading-hl-purple, rgba(168, 122, 255, 0.32)) !important;
        box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-purple-underline, rgba(118, 68, 208, 0.85)) !important;
      }

      /* 划线盒子抬到 D 段翻页热区（.dr-turn-zone，z-index:1）之上：
         正文最底下两行的划线正好落在热区范围里，不提层级就点不动了。
         .dr-overlay 自己没有 z-index（不是层叠上下文），所以这里直接比大小是有效的。 */
      .dr-hl { z-index: 2; }

      /* ═══════════════════ B. 划词小窗更紧凑 ═══════════════════
         现状：选区菜单的节点是 .dr-menu，靠「子节点里有 5 个 .dr-swatch」认出来
         （annotate.js:886；.dr-selmenu 只出现在 app.js 的 KEEP 名单里，没有节点用它）。
         所以不能直接把 .dr-menu 收窄 —— 同一个类还挂着划线操作条（.dr-ann-menu）。
         用 :has() 精确圈住「带色板的那一个」，别的手法都会误伤。
         目标：总宽 ≤ 240px、五个色点一行、三个按钮 ≤12px 不换行。
         数字是量出来的：子项全是 flex: 0 0 auto，压不动，max-width 只是天花板，
         内容超了照样把菜单撑出去（实测 240px 上限被顶到 248px）。
         现在 5 色点(16) + 4 个按钮 + 9 个间隙(2px) 合计 ≈ 227px，留 13px 余量。 */
      .dr-menu:has(> .dr-swatch) {
        max-width: 240px;
        gap: 2px;
        padding: 3px;
        border-radius: var(--dsw-radius-md, 12px);
        flex-wrap: nowrap;
      }
      .dr-menu:has(> .dr-swatch) > .dr-swatch {
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
      }
      .dr-menu:has(> .dr-swatch) > .dr-menu-sep {
        height: 14px;
        margin: 0 1px;
      }
      .dr-menu:has(> .dr-swatch) > .dr-btn {
        flex: 0 0 auto;
        height: 22px;
        padding: 0 5px;
        font-size: 11px;
      }
      .dr-menu:has(> .dr-swatch) > .dr-menu-ask {
        margin: 0;
      }
      /* 窄屏：一行塞不下就换行，但按钮得变宽 —— 手指点不中 22px 高的细条。 */
      @media (max-width: 520px) {
        .dr-menu:has(> .dr-swatch) {
          max-width: min(240px, calc(100vw - 12px));
          flex-wrap: wrap;
          row-gap: 4px;
        }
        .dr-menu:has(> .dr-swatch) > .dr-btn {
          flex: 1 1 auto;
          min-width: 52px;
        }
      }

      /* ═══════════════════ C. 目录「当前章」更醒目 ═══════════════════
         目录行是整行的按钮，光靠底色区分「现在读到哪一章」在侧栏里太弱。
         补一条 3px 左侧强调竖条（box-shadow 画，不占宽度、不改 padding 计算）
         + 稍重一点的底色，形成「选中条」的形状记忆。
         结构里没有小圆点（toc.js 的目录行只有文字 + 缩进），所以不造 .dr-toc-dot。 */
      .dr-toc-row[aria-current="true"] {
        background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
        color: var(--dsw-alias-label-primary, #1f2328);
        font-weight: 600;
        box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary, #4a7dff);
      }
      .dr-toc-row[aria-current="true"]:hover {
        background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
      }
      /* 「共 N 章 · 当前第 M 章」：说明性小字，别和章节名抢注意力 */
      .dr-toc-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 9px 6px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 11px;
        line-height: 1.5;
        font-variant-numeric: tabular-nums;
      }

      /* ═══════════════════ D. 页面底部的大翻页热区 ═══════════════════
         左右翻页条（.dr-rail）细，摸鱼式阅读时鼠标够不着。底部再给两块大热区：
         左右各 34% 宽、18% 高，静默透明，hover 才浮出 ‹ / ›。
         相对单位（%）而不是 px：热区跟视口一起缩放，缩放窗口后不会缩成一条缝。

         注意：reader.js 现在在渲染时也内联写了同一组几何值（position/bottom/left/
         width/height）和 opacity，内联优先，所以这一段主要是「hover 才浮出」的行为
         与没有内联时的兜底尺寸 —— 两边数字要保持一致（34% / 18%）。
         禁用态用的是原生 disabled 属性，不是类名，所以 :disabled 与 .is-disabled 都写。 */
      .dr-turn-zone {
        position: absolute;
        bottom: 0;
        z-index: 1;
        width: 34%;
        height: 18%;
        display: flex;
        align-items: flex-end;
        padding: 0 8px 10px;
        border: 0;
        background: transparent;
        color: var(--dsh-reading-ink, #22262b);
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
        transition: background 0.14s ease;
      }
      .dr-turn-zone-prev { left: 0; justify-content: flex-start; }
      .dr-turn-zone-next { left: auto; right: 0; justify-content: flex-end; }
      /* 桌面（精确指针）上把热区收窄到两侧 16%、贴边放箭头：
         34% 宽的热区在宽屏上会伸到正文右端下方，鼠标停在那里时那层淡灰底和 24px 的
         「›」正好压住正文最后几个字（用户报的就是这个）。手机上拇指够不着窄边，
         所以 34% 只在触屏（hover:none）保留。 */
      @media (hover: hover) and (pointer: fine) {
        .dr-turn-zone { width: 16%; }
        .dr-turn-zone-next { padding-right: 2px; }
        .dr-turn-zone-prev { padding-left: 2px; }
        .dr-turn-zone:hover { background: transparent; }
        .dr-turn-zone-chevron { font-size: 18px; }
      }
      .dr-turn-zone:hover { background: rgba(128, 128, 128, 0.07); }
      .dr-turn-zone:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: -3px;
      }
      .dr-turn-zone-chevron {
        font-size: 24px;
        line-height: 1;
        opacity: 0;
        transition: opacity 0.14s ease, transform 0.14s ease;
      }
      .dr-turn-zone:hover .dr-turn-zone-chevron,
      .dr-turn-zone:focus-visible .dr-turn-zone-chevron { opacity: 0.5; }
      .dr-turn-zone-prev:hover .dr-turn-zone-chevron { transform: translateX(-2px); }
      .dr-turn-zone-next:hover .dr-turn-zone-chevron { transform: translateX(2px); }
      /* 翻到头/翻到第一页：热区留着位置但不可点，淡淡地退场 */
      .dr-turn-zone.is-disabled,
      .dr-turn-zone:disabled {
        pointer-events: none;
        cursor: default;
        opacity: 0.25;
      }
      /* 用户的系统设置里开了「减少动效」就别做浮出动画 */
      @media (prefers-reduced-motion: reduce) {
        .dr-turn-zone,
        .dr-turn-zone-chevron { transition: none; }
      }

      /* ═══════════════════ E. 书内搜索面板 ═══════════════════
         结构与 client/src/search.js 对齐（类名一字未改），这里只管长相。
         面板本身是右边栏里的一张卡：竖向 flex + min-height:0，
         否则长结果列表会把整张卡撑出容器、把输入框顶出可视区。
         纯白底不跟纸面走：搜索是「工具界面」，不是正文。 */
      .dr-search-panel {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        padding: 10px;
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-base, #ffffff);
      }
      .dr-search-head {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .dr-search-title {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2328);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dr-search-close {
        flex: 0 0 auto;
        width: 24px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0.5px solid transparent;
        border-radius: var(--dsw-radius-sm, 8px);
        background: transparent;
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-family: inherit;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
      }
      .dr-search-close:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-search-close:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      .dr-search-row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .dr-search-input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--dsw-alias-label-primary, #1f2328);
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
        border-radius: var(--dsw-radius-md, 12px);
        padding: 6px 9px;
      }
      .dr-search-input:focus {
        outline: none;
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
      }
      .dr-search-go {
        flex: 0 0 auto;
        height: 26px;
        padding: 0 10px;
        border: 0.5px solid transparent;
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-button-primary-fill, #4a7dff);
        color: var(--dsw-alias-label-primary-inverted, #ffffff);
        font-family: inherit;
        font-size: 12px;
        font-weight: 550;
        cursor: pointer;
        transition: background 0.12s;
      }
      .dr-search-go:hover { background: var(--dsw-alias-button-primary-hover, #3d6ded); }
      .dr-search-go:disabled { opacity: 0.45; cursor: not-allowed; }
      .dr-search-go:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      .dr-search-status {
        font-size: 12px;
        line-height: 1.5;
        color: var(--dsw-alias-label-secondary, #5b6069);
      }
      .dr-search-status.is-error { color: var(--dsw-alias-state-error-primary, #d93025); }
      /* 结果列表必须自己滚：父级是竖向 flex，不给 overflow 就撑破面板 */
      .dr-side-body.dr-search-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 0;
      }
      .dr-search-hit {
        display: block;
        width: 100%;
        box-sizing: border-box;
        text-align: left;
        padding: 8px 6px;
        border: 0;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: transparent;
        color: inherit;
        font-family: inherit;
        cursor: pointer;
      }
      .dr-search-hit:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); }
      .dr-search-hit[aria-selected="true"] {
        background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
      }
      .dr-search-hit:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: -2px;
      }
      .dr-search-hit-chapter {
        font-size: 12px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #1f2328);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dr-search-hit-snippet {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        margin-top: 2px;
        font-size: 13px;
        line-height: 1.5;
        color: var(--dsw-alias-label-secondary, #5b6069);
      }
      /* 命中词：强调色底、不加圆角 —— 圆角会让它在两行截断里像个小药丸，太吵 */
      .dr-search-hit-snippet mark {
        background: rgba(74, 125, 255, 0.18);
        color: inherit;
        border-radius: var(--dsw-radius-none, 0);
        padding: 0 1px;
      }
      .dr-search-hit-pos {
        margin-top: 3px;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-variant-numeric: tabular-nums;
      }

      /* ═══════════════════ F. 笔记面板：搜索 / 筛选 / 时间线分组 ═══════════════════
         笔记一多，找一条要滚很久：先给搜索框，再给筛选 chips，最后按时间分组。
         视觉上一律比正文轻一档 —— 这是工具区，不是阅读区。 */
      .dr-note-search {
        box-sizing: border-box;
        width: 100%;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--dsw-alias-label-primary, #1f2328);
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
        border-radius: var(--dsw-radius-md, 12px);
        padding: 6px 9px;
      }
      .dr-note-search:focus {
        outline: none;
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
      }
      .dr-facet-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      /* 只圈 .dr-facet-chips 里的 chip：设置面板里还有一组 .dr-chip（28px、8px 圆角、
         .is-on 态），那是滑杆旁边的选择器，不该被笔记筛选的 pill 形状带跑。 */
      .dr-facet-chips .dr-chip {
        height: 26px;
        padding: 0 10px;
        border-radius: 999px;
        corner-shape: round;
        border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-family: inherit;
        font-size: 11.5px;
        line-height: 1;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      .dr-facet-chips .dr-chip:hover {
        background: var(--dsw-alias-interactive-bg-hover, #e9eaee);
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-facet-chips .dr-chip[aria-pressed="true"] {
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
        background: rgba(74, 125, 255, 0.12);
        color: var(--dsw-alias-brand-primary, #4a7dff);
        font-weight: 600;
      }
      .dr-note-group { margin-top: 14px; }
      .dr-note-group:first-child { margin-top: 4px; }
      /* 分组标题：「今天 / 本周 / 更早」这种时间标签，小字距 + 大写让它在列表里像分隔符 */
      .dr-note-group-head {
        margin: 0 0 4px;
        padding: 0 2px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .dr-note-time {
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      /* 笔记条目：行距收紧一档，让一屏多看到两三条；左右 padding 用相对单位跟栏宽一起缩 */
      .dr-note-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        box-sizing: border-box;
        padding: 6px clamp(8px, 1%, 14px);
        border: 0.5px solid transparent;
        border-radius: var(--dsw-radius-md, 12px);
        line-height: 1.45;
        text-align: left;
        background: transparent;
        color: inherit;
        font-family: inherit;
        cursor: pointer;
      }
      .dr-note-item:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        border-color: var(--dsw-alias-border-l2, #e6e6ea);
      }
      .dr-note-item:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: -2px;
      }
      /* 右侧操作按钮默认藏起来：一屏十几条笔记，每条都挂三个按钮会变成一片图标墙。
         鼠标悬停或键盘聚焦到条目时才显形；触屏没有 hover，就让它常显。 */
      .dr-note-item .dr-note-actions {
        flex: 0 0 auto;
        display: flex;
        gap: 2px;
        opacity: 0;
        transition: opacity 0.12s ease;
      }
      .dr-note-item:hover .dr-note-actions,
      .dr-note-item:focus-within .dr-note-actions { opacity: 1; }
      @media (hover: none) {
        .dr-note-item .dr-note-actions { opacity: 1; transition: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dr-note-item .dr-note-actions { transition: none; }
      }

      /* ═══════════════════ G. 问答面板：滚动区 / 上下按钮 / 快捷键提示 ═══════════════════
         问答回答可能很长，容器必须是「自己滚」而不是「把面板撑长」；
         overscroll-behavior 防止滚到底继续滚时把整页带着跳。 */
      .dr-qa-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
      }
      /* 右下角竖排两个圆按钮：不占正文宽度，浮在滚动区上；容器本身不接收事件，
         只有按钮接收，否则滚动区右下的文字会被一块透明层挡住选不了。 */
      .dr-scroll-btns {
        position: absolute;
        right: 8px;
        bottom: 8px;
        z-index: 3;
        display: flex;
        flex-direction: column;
        gap: 6px;
        pointer-events: none;
      }
      .dr-scroll-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
        border-radius: 50%;
        corner-shape: round;
        background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.94));
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-family: inherit;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, opacity 0.12s;
      }
      .dr-scroll-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
        color: var(--dsw-alias-label-primary, #1f2328);
      }
      .dr-scroll-btn:disabled { opacity: 0.35; cursor: default; }
      .dr-scroll-btn:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
        outline-offset: 1px;
      }
      /* Shift+滚轮 提示：键盘键帽的观感，等宽字体 + 1px 边框 + 4px 圆角，
         让人一眼看出「这是个可以按的键」，而不是正文里的英文单词。 */
      .dr-keyhint {
        display: inline-block;
        padding: 0 5px;
        border: 1px solid var(--dsw-alias-border-l2, #e6e6ea);
        border-radius: var(--dsw-radius-sm, 4px);
        background: var(--dsw-alias-bg-layer-2, #f2f3f5);
        color: var(--dsw-alias-label-secondary, #5b6069);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        line-height: 1.6;
        white-space: nowrap;
      }
      .dr-keyhint kbd {
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
      }

      /* ═══════════════════ H. 测量用的固定像素 → 相对单位 ═══════════════════
         翻页条、正文留白、侧栏宽度都是「跟着视口走」的尺寸，写死 px 在放大窗口后
         会显得又窄又空。换成 clamp(min, 百分比, max)：两头都有闸，中间随窗口伸缩。
         clamp 的下界保证不塌（缩到最小也有 18px 可点、8px 留白）。 */
      .dr-rail {
        width: clamp(18px, 2.4%, 40px);
      }
      .dr-reader-main {
        padding-left: clamp(8px, 1.2%, 24px);
        padding-right: clamp(8px, 1.2%, 24px);
      }
      /* 侧栏：优先用拖拽后的宽度（reader.js 内联的 --dsh-reading-side-width），
         没有就用相对宽度兜底。之前这个内联变量根本没被消费，等于白设。 */
      .dr-side {
        width: var(--dsh-reading-side-width, clamp(248px, 26%, 380px));
        max-width: 100%;
      }
      /* 窄容器下侧栏是覆盖层（见上文 @media 720px），26% 会窄到放不下章节名，
         改用「最多 88%」的比例，同时仍受 380px 上界约束。 */
      @media (max-width: 720px) {
        .dr-side {
          width: var(--dsh-reading-side-width, clamp(232px, 78%, 380px));
          max-width: 88%;
        }
      }
      `

      /**
       * 移动端（0.7.0）：手机上真正要解决的不是「字小」，而是三件事 ——
       * ① 两侧 26px 的翻页窄边在 390px 屏上占 13%，正文被挤成细条；
       * ② 手指没有 hover，所有「鼠标划过才出现」的东西等于不存在；
       * ③ 刘海屏与底部小白条会盖住工具栏和页码行。
       * 所以这里做的是：窄屏隐藏窄边、热区放大到拇指区、工具栏压缩成图标、
       * 侧栏改成整屏抽屉、四周补 safe-area 内边距。
       */
      const CSS_MOBILE = `
      @media (max-width: 720px) {
        /* 窄边占地太贵：手机上用「点左三分之一 / 右三分之一」和左右滑动翻页，
           窄边整体退场（保留 DOM，键盘与读屏仍然能用）。 */
        .dr-rail { display: none; }

        /* 翻页热区：底部 42% 高、左右各 45%，中间留 10% 不接手势以免和划词抢。 */
        .dr-turn-zone { width: 45%; height: 42%; }
        .dr-turn-zone-chevron { opacity: 0.35; font-size: 20px; }

        /* 正文留白：窄屏上 44px 是奢侈，收到 18px。 */
        .dr-viewport { padding: 16px 18px !important; }

        /* 工具栏：按钮多，窄屏不换行而是横向滚动（隐藏滚动条），
           高度压到 44px、触摸目标不小于 40px —— 手指点得到比看得全重要。 */
        .dr-reader-bar {
          padding: 0 6px;
          min-height: 44px;
          gap: 2px;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .dr-reader-bar::-webkit-scrollbar { display: none; }
        .dr-btn, .dr-iconbtn {
          flex: 0 0 auto;
          min-width: 40px;
          min-height: 38px;
          padding: 0 10px;
          font-size: 12.5px;
        }

        /* 页码行：贴住底部小白条之上 */
        .dr-pagebar { padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px)); }

        /* 侧栏抽屉：整屏宽，从右侧滑入；顶部吃进刘海高度。 */
        .dr-side {
          position: absolute;
          inset: 0 0 0 auto;
          z-index: 20;
          width: 92% !important;
          max-width: 92% !important;
          padding-top: env(safe-area-inset-top, 0px);
          box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
        }

        /* 划词小窗与问 AI 面板：贴底，避开小白条 */
        .dr-menu { max-width: calc(100vw - 16px); }
        .dr-ask { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
      }

      /* 触摸设备上，凡是「hover 才出现」的东西都要常态可见或干脆不出现。 */
      @media (hover: none) {
        .dr-rail-chevron { opacity: 0.5; }
        .dr-turn-zone-chevron { opacity: 0.35; }
        .dr-turn-zone:hover { background: transparent; }
      }

      /* 横屏手机：高度很小，底部热区会让正文只剩一条，直接改回窄条。 */
      @media (max-height: 460px) {
        .dr-turn-zone { height: 22%; }
      }
      `

      /** AI 状态面板样式（0.8.0）。单独一段，方便一眼看出这一版加了什么。 */
      const CSS_AI = `
      /* ── AI 状态与账本（0.8.0）────────────────────────────────────────
       * 用户的原话：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍重试。
       * 所以这里只做「说清楚」：点、色、一行字。不加动画，不抢视线。
       */
      .dr-ai-dot {
        display: inline-block;
        corner-shape: round;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--dsw-alias-label-quaternary, #8a8a8a);
        flex: none;
      }
      .dr-ai-entry { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; }
      .dr-ai-entry-ok .dr-ai-dot { background: #2f9e5f; }
      .dr-ai-entry-warn .dr-ai-dot { background: #d79315; }
      .dr-ai-entry-fail .dr-ai-dot { background: #d24338; }
      .dr-ai-entry-warn { color: #b87908; }
      .dr-ai-entry-fail { color: #c0392b; }

      .dr-ai-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        padding: 3px 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
        border-radius: var(--dsw-radius-sm, 4px);
        background: transparent;
        color: var(--dsw-alias-label-primary, inherit);
        font: inherit;
        font-size: 11.5px;
        cursor: pointer;
        text-align: left;
      }
      .dr-ai-chip:hover { background: rgba(0, 0, 0, 0.04); }
      .dr-ai-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dr-ai-chip-ok .dr-ai-dot { background: #2f9e5f; }
      .dr-ai-chip-warn .dr-ai-dot { background: #d79315; }
      .dr-ai-chip-fail .dr-ai-dot { background: #d24338; }
      .dr-ai-chip-fail { border-color: rgba(210, 67, 56, 0.5); color: #c0392b; }

      .dr-ai-panel { display: flex; flex-direction: column; gap: 12px; padding: 2px 12px 14px; overflow: auto; }
      .dr-ai-head { display: flex; flex-direction: column; gap: 5px; }

      /* 模型与强度（0.8.1）：两行下拉 + 一行「实际使用」。
       * 下拉宽度铺满，因为模型名很长（provider/model），窄了只能看到一半。 */
      .dr-ai-models { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.07); }
      .dr-ai-field { display: flex; flex-direction: column; gap: 3px; }
      .dr-ai-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #777); }
      .dr-ai-effective { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #777); }

      .dr-ai-headline { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
      .dr-ai-hint { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #777); }
      .dr-ai-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
      .dr-ai-section { display: flex; flex-direction: column; gap: 7px; }
      .dr-ai-section-title {
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--dsw-alias-label-secondary, #777);
      }
      .dr-ai-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .dr-ai-check {
        display: grid;
        grid-template-columns: 14px 1fr;
        gap: 2px 6px;
        font-size: 12px;
        line-height: 1.45;
        padding: 6px 8px;
        border-radius: var(--dsw-radius-sm, 4px);
        background: rgba(0, 0, 0, 0.03);
      }
      .dr-ai-check.is-bad { background: rgba(210, 67, 56, 0.09); }
      .dr-ai-check-mark { font-weight: 700; }
      .dr-ai-check.is-ok .dr-ai-check-mark { color: #2f9e5f; }
      .dr-ai-check.is-bad .dr-ai-check-mark { color: #c0392b; }
      .dr-ai-check-title { font-weight: 600; }
      .dr-ai-check-detail { grid-column: 2; color: var(--dsw-alias-label-secondary, #777); font-size: 11.5px; }
      .dr-ai-check-fix { grid-column: 2; color: #b87908; font-size: 11.5px; }

      .dr-ai-recent { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #777); display: flex; flex-wrap: wrap; gap: 6px; }
      .dr-ai-code { font-size: 10.5px; padding: 1px 4px; border-radius: var(--dsw-radius-sm, 4px); background: rgba(0, 0, 0, 0.06); }
      .dr-ai-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
      .dr-ai-row {
        display: grid;
        grid-template-columns: 52px 1fr;
        gap: 2px 8px;
        font-size: 11.5px;
        padding: 4px 6px;
        border-radius: var(--dsw-radius-sm, 4px);
        background: rgba(0, 0, 0, 0.02);
      }
      .dr-ai-row.is-bad { background: rgba(210, 67, 56, 0.07); }
      .dr-ai-row-time { color: var(--dsw-alias-label-secondary, #777); font-variant-numeric: tabular-nums; }
      .dr-ai-row-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dr-ai-row-detail { grid-column: 2; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; word-break: break-word; }
      .dr-ai-row.is-bad .dr-ai-row-detail { color: #c0392b; }
      .dr-ai-foot { font-size: 10.5px; color: var(--dsw-alias-label-quaternary, #8a8a8a); word-break: break-all; }
      `

      /** 读书蒸馏面板样式（0.8.0）。 */
      const CSS_DISTILL = `
      /* ── 读书蒸馏（0.8.0）────────────────────────────────────────────
       * 一章一行，行内就是「蒸 / 重蒸 / 读原文」三个动作。不做树状嵌套：
       * 一本书几十章，树一层就把面板撑爆了。
       */
      .dr-distill-entry { display: inline-flex; align-items: center; gap: 5px; }
      .dr-dist-panel { display: flex; flex-direction: column; gap: 10px; padding: 2px 12px 14px; overflow: auto; }
      .dr-dist-head { display: flex; flex-direction: column; gap: 8px; }
      .dr-dist-progress { font-size: 12px; font-weight: 600; }
      .dr-dist-sub { font-weight: 400; color: var(--dsw-alias-label-secondary, #777); }
      .dr-dist-failed { color: var(--dsw-alias-label-error, #c0392b); }
      .dr-dist-note {
        font-size: 11.5px;
        line-height: 1.5;
        padding: 6px 8px;
        border-radius: var(--dsw-radius-sm, 4px);
        background: rgba(0, 0, 0, 0.04);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .dr-dist-note-bad { background: rgba(210, 67, 56, 0.09); color: var(--dsw-alias-label-error, #c0392b); }
      .dr-dist-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .dr-dist-toast { margin: 0 12px 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #777); }
      .dr-dist-skeleton {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border-radius: var(--dsw-radius-sm, 4px);
        background: rgba(0, 0, 0, 0.035);
      }
      .dr-dist-skeleton-title { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #777); }
      .dr-dist-skeleton-line { font-size: 12.5px; font-weight: 600; }
      .dr-dist-skeleton-row { display: grid; grid-template-columns: 52px 1fr; gap: 6px; font-size: 11.5px; }
      .dr-dist-skeleton-row > span { color: var(--dsw-alias-label-secondary, #777); }
      .dr-dist-skeleton-row p { margin: 0; line-height: 1.55; }
      .dr-dist-list { display: flex; flex-direction: column; gap: 6px; }
      .dr-dist-row {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 7px 8px;
        border-radius: var(--dsw-radius-sm, 4px);
        background: rgba(0, 0, 0, 0.025);
      }
      .dr-dist-row-done { background: rgba(47, 158, 95, 0.06); }
      .dr-dist-row-failed { background: rgba(210, 67, 56, 0.07); }
      .dr-dist-row-head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
      .dr-dist-row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
      .dr-dist-badge { font-size: 10.5px; padding: 1px 5px; border-radius: var(--dsw-radius-sm, 4px); background: rgba(0, 0, 0, 0.07); }
      .dr-dist-row-error { font-size: 11px; color: var(--dsw-alias-label-error, #c0392b); }
      .dr-dist-detail { display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; }
      .dr-dist-thesis { font-weight: 600; line-height: 1.5; }
      .dr-dist-points { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; }
      .dr-dist-points .is-unverified .dr-dist-point-claim { text-decoration: line-through; opacity: 0.7; }
      .dr-dist-quote { display: block; margin-top: 2px; color: var(--dsw-alias-label-secondary, #777); font-style: italic; }
      .dr-dist-warn { margin-left: 4px; color: var(--dsw-alias-label-error, #c0392b); }
      .dr-dist-terms { margin: 0; display: flex; flex-direction: column; gap: 3px; }
      .dr-dist-term { display: grid; grid-template-columns: 72px 1fr; gap: 6px; }
      .dr-dist-term dt { font-weight: 600; }
      .dr-dist-term dd { margin: 0; color: var(--dsw-alias-label-secondary, #777); }
      .dr-dist-methods { display: flex; flex-direction: column; gap: 6px; }
      .dr-dist-method {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 6px 8px;
        border-left: 2px solid var(--dsw-alias-brand-primary, #4a7);
        background: rgba(0, 0, 0, 0.025);
        border-radius: var(--dsw-radius-sm, 4px);
      }
      .dr-dist-method-name { font-weight: 600; }
      .dr-dist-method-when, .dr-dist-method-check { color: var(--dsw-alias-label-secondary, #777); }
      .dr-dist-steps { margin: 0; padding-left: 16px; }
      .dr-dist-foot { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-quaternary, #8a8a8a); }
      `

      /**
       * 取整份 CSS 文本（用于测试和调试；正常渲染走 ensureStyle）。
       * 拼接顺序有语义：基础样式在前，v0.6.0 增量在后 —— 后写的规则覆盖先写的。
       * @returns {string}
       */
      function cssText() {
        return CSS + CSS_V060 + CSS_MOBILE + CSS_AI + CSS_DISTILL
      }

      /**
       * 幂等注入父窗口样式表。
       *
       * 失败行为：不抛。`doc.head` 还不存在（脚本在 <head> 之前执行）时静默返回，
       * 调用方（apply / 组件挂载）会再调一次。样式缺失不会让插件崩，只是难看。
       *
       * @param {Document} doc 通常是 document
       */
      function ensureStyle(doc) {
        const target = doc || (typeof document !== 'undefined' ? document : null)
        if (!target || !target.head) return
        if (target.getElementById(STYLE_ID) !== null) return
        const style = target.createElement('style')
        style.id = STYLE_ID
        style.textContent = cssText()
        target.head.appendChild(style)
      }

      return { HIGHLIGHT_COLORS: HIGHLIGHT_COLORS, HIGHLIGHT_ORDER: HIGHLIGHT_ORDER, colorStyle: colorStyle, CSS_AI: CSS_AI, CSS_DISTILL: CSS_DISTILL, cssText: cssText, ensureStyle: ensureStyle }
    })()

    // ─── client/src/search.js ───
    var __mod_search_js = (function () {
      /**
       * search.js —— 书内搜索面板。
       *
       * 书内搜索和目录解决的是同一个问题的两半：目录给「已知位置」，搜索给
       * 「只记得一句话」的位置。所以这里的每一条结果都必须同时回答三件事——
       * 在哪一章、哪句话、多深。只丢一段正文出来，用户还得自己翻回去，那等于没搜。
       *
       * 面板自己不请求数据：results / searching / error 由 app 拉好传进来。
       * 为什么不在这里搜：一次搜索要扫遍全部 spine 的正文，慢，而且连点两次就会
       * 并发压宿主。让上层串行触发，才能保证「敲一次回车只发一次请求」，
       * 也方便上层做去抖、取消、和「搜完自动跳到第一条」这类策略。
       */

      /**
       * 把一段文字按命中词切成碎片，供渲染时插 <mark>。
       *
       * 为什么不用 new RegExp(query) 拼接：查询词里带 ( [ . * ? + 这些字符时，
       * 轻则把文字切错位置，重则抛 SyntaxError 直接把整个面板炸掉——
       * 而用户搜「（上）」是完全正常的动作。所以这里用 indexOf 逐段扫描，
       * 查询词永远只被当成字面量，不参与任何语法。
       *
       * 为什么还得先比对折叠后的长度：toLowerCase 偶尔会改变字符串长度
       * （İ、ß 这类字符），那时 lowerText 的下标和原文对不上，
       * 切出来就是半个字。宁可整段不高亮，也不要在读者眼前切碎汉字。
       *
       * @param {string} snippet 一段正文（宿主给的已截断片段）
       * @param {string} query   用户输入的查询词
       * @returns {Array<{text: string, mark: boolean}>} 片段，按原文顺序
       */
      function highlightSnippet(snippet, query) {
        const text = typeof snippet === 'string' ? snippet : ''
        const needle = typeof query === 'string' ? query.trim() : ''

        // 空词、空正文都只返回一段：调用方可以无脑 map，不用先判空。
        if (text === '' || needle === '') return [{ text, mark: false }]

        const lowerText = text.toLowerCase()
        const lowerNeedle = needle.toLowerCase()

        if (lowerText.length !== text.length || lowerNeedle.length !== needle.length) {
          return [{ text, mark: false }]
        }

        const parts = []
        let from = 0
        let at = lowerText.indexOf(lowerNeedle, from)
        while (at !== -1) {
          // 只在真有命中时才 push 未命中的片段：全未命中时 parts 为空的判断因此更简单。
          if (at > from) parts.push({ text: text.slice(from, at), mark: false })
          parts.push({ text: text.slice(at, at + needle.length), mark: true })
          from = at + needle.length
          at = lowerText.indexOf(lowerNeedle, from)
        }

        if (parts.length === 0) return [{ text, mark: false }]
        // 收尾：命中之后剩下的原文不能丢，否则「多深」这条线索会被截断。
        if (from < text.length) parts.push({ text: text.slice(from), mark: false })
        return parts
      }

      /**
       * 章节名兜底。
       *
       * 命中行没有章节名时给「第 N 章」而不是留空：空着会让用户没法判断
       * 这条结果值不值得点，而章序号是唯一还剩下的定位信息。
       */
      function chapterLabelOf(hit) {
        const label = typeof hit.chapterLabel === 'string' ? hit.chapterLabel.trim() : ''
        if (label !== '') return label
        return Number.isInteger(hit.spineIndex) ? `第 ${hit.spineIndex + 1} 章` : '未知章节'
      }

      /** 位置给百分比不给字数：读者对「第 1234 字」没有直觉，对「这章靠后」有。 */
      function percentOf(value) {
        const raw = Number(value)
        if (!Number.isFinite(raw)) return '—'
        const percent = Math.max(0, Math.min(100, Math.round(raw * 100)))
        return `${percent}%`
      }

      /**
       * 书内搜索面板。
       *
       * props:
       *   open          —— 面板是否展开；false 时整个组件渲染 null（面板不占位）
       *   query         —— 输入框当前值（受控）
       *   onChange(text)
       *   onSubmit()    —— 回车或点「搜索」；只通知，不在这里发请求
       *   results       —— null = 还没搜过；[] = 搜过但没有；有值 = 命中列表
       *   searching     —— 搜索中
       *   error         —— humanizeError 之后的中文错误
       *   onJump(hit)   —— 点一条结果（关面板 + 跳页由上层负责）
       *   onClose()
       */
      function SearchPanel(props) {
        const open = props.open === true
        const query = typeof props.query === 'string' ? props.query : ''
        const searching = props.searching === true
        const error = typeof props.error === 'string' ? props.error.trim() : ''

        // null 和 [] 必须分开：前者是「还没搜」，后者是「搜了没有」，
        // 把 null 折成 [] 会让用户以为自己的关键词一定没命中。
        const results = Array.isArray(props.results) ? props.results : null
        const hits = results === null ? [] : results
        const total = hits.length

        const inputRef = useRef(null)
        const hitRefs = useRef([])
        // 记住「上一次真正提交的词」：用户搜完又接着改输入框时，
        // 「没有找到「x」」必须引用搜过的词，而不是他正在打的半个词。
        const [submitted, setSubmitted] = useState('')
        const [active, setActive] = useState(0)

        // 结果的指纹只用来判断「换了一批」，不参与渲染。
        // 直接依赖 results 引用不够：上层每次渲染都可能新建数组，会白白重置焦点。
        const resultKey = useMemo(() => {
          if (results === null) return 'none'
          const first = results[0]
          const last = results[results.length - 1]
          const stamp = (hit) => (hit && typeof hit === 'object'
            ? `${hit.spineIndex}:${hit.hitOffset}:${typeof hit.snippet === 'string' ? hit.snippet.length : 0}`
            : '')
          return [results.length, stamp(first), stamp(last)].join('|')
        }, [results])

        // 换了新一批结果就回到第一条：上一次停在第 17 条，这次只剩 3 条时，
        // 焦点若留在「等价位置」，用户会以为自己没搜到东西。
        useEffect(() => {
          setActive(0)
        }, [resultKey])

        // 打开即聚焦输入框：点「书内搜索」就是为了马上打字，
        // 还要再点一次输入框就是白费一个动作。延时是因为面板刚挂载时样式还没落定，
        // 立刻 focus 在部分浏览器里会被随后的布局改动抢走。
        useEffect(() => {
          if (!open) return undefined
          const timer = setTimeout(() => {
            const node = inputRef.current
            if (node && typeof node.focus === 'function') node.focus()
          }, 30)
          return () => clearTimeout(timer)
        }, [open])

        // 必须在所有 hook 之后才允许提前返回，否则 open 一变化 hook 数量就变了。
        if (!open) return null

        const activeIndex = total === 0 ? -1 : Math.min(Math.max(active, 0), total - 1)

        const emitChange = (text) => {
          if (typeof props.onChange === 'function') props.onChange(text)
        }

        const close = () => {
          if (typeof props.onClose === 'function') props.onClose()
        }

        const submit = () => {
          const keyword = query.trim()
          // 空词不发请求：搜一个空格要扫完整本书，结果却毫无意义。
          // 搜索中也不再发：连点两次「搜索」就是两个并发扫描，宿主会被压垮。
          if (keyword === '' || searching) return
          setSubmitted(keyword)
          if (typeof props.onSubmit === 'function') props.onSubmit()
        }

        const focusHit = (index) => {
          if (total === 0) return
          const next = Math.min(Math.max(index, 0), total - 1)
          setActive(next)
          const node = hitRefs.current[next]
          if (node && typeof node.focus === 'function') node.focus()
        }

        const head = h(
          'div',
          { className: 'dr-search-head' },
          h('span', { className: 'dr-search-title' }, '书内搜索'),
          h('div', { className: 'dr-grow' }),
          h('button', {
            type: 'button',
            className: 'dr-icon-btn dr-search-close',
            title: '关闭',
            'aria-label': '关闭',
            onClick: close,
          }, '×'),
        )

        const row = h(
          'div',
          { className: 'dr-search-row' },
          h('input', {
            className: 'dr-input dr-search-input',
            type: 'search',
            placeholder: '搜索这本书里的文字',
            value: query,
            ref: inputRef,
            'aria-label': '书内搜索',
            onChange: (event) => emitChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              } else if (event.key === 'ArrowDown' && total > 0) {
                // 从输入框直接下探到结果：搜完继续用键盘挑，手不用离开键盘。
                event.preventDefault()
                focusHit(activeIndex < 0 ? 0 : activeIndex)
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'dr-btn dr-search-go',
            // 禁用而不是静默忽略：按钮亮着却没反应，用户会怀疑是不是卡住了。
            disabled: searching || query.trim() === '',
            onClick: submit,
          }, '搜索'),
        )

        let statusText = ''
        if (error !== '') {
          statusText = error
        } else if (searching) {
          statusText = '正在搜索…'
        } else if (results !== null && total > 0) {
          statusText = `找到 ${total} 处`
        } else if (results !== null && total === 0) {
          const shown = (submitted || query).trim()
          // 兜底成「这段文字」而不是留一对空引号：空引号看起来像界面坏了。
          statusText = `没有找到「${shown === '' ? '这段文字' : shown}」`
        } else {
          statusText = '输入关键词后按回车'
        }

        const status = h(
          'div',
          {
            className: error !== '' ? 'dr-search-status is-error' : 'dr-search-status',
            role: 'status',
            'aria-live': 'polite',
          },
          statusText,
        )

        let body = null
        if (total > 0) {
          body = h(
            'div',
            { className: 'dr-side-body dr-search-list', role: 'listbox', 'aria-label': '搜索结果' },
            hits.map((raw, index) => {
              const hit = raw && typeof raw === 'object' ? raw : {}
              const chapter = chapterLabelOf(hit)
              const percent = percentOf(hit.percent)
              // hit.query 是发出这次搜索时的词，比输入框里的当前值更贴合这段正文；
              // 只有宿主没回填时才退回当前输入。
              const keyword = typeof hit.query === 'string' && hit.query !== '' ? hit.query : query
              const fragments = highlightSnippet(
                typeof hit.snippet === 'string' ? hit.snippet : '',
                keyword,
              )
              return h(
                'button',
                {
                  key: `${hit.spineIndex}-${hit.hitOffset}-${index}`,
                  type: 'button',
                  role: 'option',
                  // aria-selected 而不是 :focus：焦点要能被上下键「搬走」，
                  // 但「当前这一条」是选择态，两者不该混成一个概念。
                  'aria-selected': index === activeIndex ? 'true' : 'false',
                  tabIndex: index === activeIndex ? 0 : -1,
                  className: 'dr-search-hit',
                  ref: (node) => { hitRefs.current[index] = node },
                  onClick: () => {
                    if (typeof props.onJump === 'function') props.onJump(raw)
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      focusHit(index + 1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      focusHit(index - 1)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      close()
                    }
                  },
                },
                h('div', { className: 'dr-search-hit-chapter' }, chapter),
                h(
                  'div',
                  { className: 'dr-search-hit-snippet' },
                  fragments.map((part, i) => (
                    part.mark ? h('mark', { key: `mark-${i}` }, part.text) : part.text
                  )),
                ),
                h('div', { className: 'dr-search-hit-pos', title: '在这一章里的位置' }, percent),
              )
            }),
          )
        } else if (results === null && !searching && error === '') {
          // 还没搜过时给一句「会得到什么」，比留一块空白更能让人敢按下回车。
          body = h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-text' }, '结果会按章节顺序列出，点一条就跳到那句话。'),
          )
        }

        return h(
          'div',
          { className: 'dr-search-panel' },
          head,
          row,
          status,
          body,
        )
      }

      return { highlightSnippet: highlightSnippet, SearchPanel: SearchPanel }
    })()

    // ─── client/src/shelf.js ───
    var __mod_shelf_js = (function () {
      /**
       * shelf.js —— 书架：列书、导入、删书。
       *
       * 三态是硬要求（docs/05 §7 的 G2 验收就是「不白屏」）：
       *   加载态 —— 一个转圈 + 一句「正在读书架」，不要留空白让用户以为坏了；
       *   空态   —— 说清「这里会有什么」+ 一个明确的导入按钮；
       *   错误态 —— 只显示 humanizeError 过的中文，绝不出现 JSON / 路径 / 堆栈。
       *
       * 导入走「本地文件 → base64 → 宿主写入书库」：浏览器不能直接落盘，
       * 而宿主侧有大小上限与解压炸弹防护（lib/epub.js），所以这里不做预处理，
       * 只负责把字节原样递过去，并在失败时把宿主的中文原因显示出来。
       */

            const coverUrl = __mod_api_js.coverUrl
            const call = __mod_api_js.call
            const humanizeError = __mod_api_js.humanizeError
            const putBookCover = __mod_api_js.putBookCover
            const resetBookCover = __mod_api_js.resetBookCover
            const updateBook = __mod_api_js.updateBook

      /** 单次导入的界面提示上限：超过这个大小先提醒一句，但不阻止（宿主说了算）。 */
      const BIG_FILE_BYTES = 120 * 1024 * 1024

      /**
       * 自选封面的大小上限，与宿主 book.cover.put 的判定一致（3 MiB）。
       *
       * 前端也挡一次：三兆的图 base64 之后接近四兆，白传一趟再被拒，
       * 用户等的是几十秒的进度条和一句「太大了」。
       */
      const COVER_MAX_BYTES = 3 * 1024 * 1024

      /** 书名 / 作者的长度上限，与 book.update 的校验一致（按字算，不按字节）。 */
      const TITLE_MAX = 120
      /** 筛选维度的中文名（下拉与空态提示共用）。 */
      const FILTER_KINDS = [
        ['all', '全部书籍'],
        ['favorite', '我的珍藏'],
        ['series', '按系列'],
        ['author', '按作者'],
        ['category', '按分类'],
        ['tag', '按标签'],
      ]

      /** 标签个数上限，与宿主 MAX_TAG_COUNT 保持一致。 */
      const TAG_MAX_COUNT = 12
      const AUTHOR_MAX = 80

      /**
       * 读一个 File 成完整 data URL（含 `data:...;base64,` 前缀）。
       * 失败行为：读不出来时 reject 一个 Error，message 是人话。
       *
       * @param {File} file
       * @returns {Promise<string>}
       */
      function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('这个文件读不出来，可能已被移动或没有读取权限。'))
          reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : ''
            const comma = result.indexOf(',')
            if (comma < 0) {
              reject(new Error('这个文件读不出来，格式可能不对。'))
              return
            }
            resolve(result)
          }
          reader.readAsDataURL(file)
        })
      }

      /**
       * 读一个 File 成 base64（不含 data: 前缀）。
       *
       * @param {File} file
       * @returns {Promise<string>}
       */
      async function readAsBase64(file) {
        const full = await readAsDataUrl(file)
        return full.slice(full.indexOf(',') + 1)
      }

      /**
       * 从 base64 开头认图片格式（看魔数，不看扩展名也不信 File.type）。
       *
       * 为什么要自己认：宿主按魔数判定，扩展名和浏览器给的 MIME 都可以是假的；
       * 在这里先认一次，选错文件时立刻能说「只支持 PNG、JPEG、WebP」，
       * 而不是让用户等一趟上传再看到同一句话。
       *
       * @param {string} base64
       * @returns {'image/png'|'image/jpeg'|'image/webp'|''} 认不出来时是空串
       */
      function sniffCoverMime(base64) {
        if (typeof base64 !== 'string' || base64 === '') return ''
        let bytes = []
        try {
          // 只要前 12 个字节就够判三种格式；取 32 个 base64 字符恰好解出 24 字节
          const head = typeof atob === 'function' ? atob(base64.slice(0, 32)) : ''
          bytes = Array.from(head, (char) => char.charCodeAt(0))
        } catch (error) {
          return ''
        }
        if (bytes.length >= 8
          && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
          && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
        if (bytes.length >= 12
          && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
          && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
        return ''
      }

      /** 把 0–1 的进度压成「读完了 42%」这种能读的字。 */
      function percentText(percent) {
        const value = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0
        const clamped = Math.max(0, Math.min(1, value))
        return `已读 ${Math.round(clamped * 100)}%`
      }

      /** 一个纯装饰的加载态。props.text 是给人看的一句说明。 */
      function Loading(props) {
        return h(
          'div',
          { className: 'dr-state' },
          h('div', { className: 'dr-spinner', role: 'status', 'aria-label': props.text || '正在加载' }),
          h('div', { className: 'dr-state-text' }, props.text || '正在加载…'),
        )
      }

      /** 统一的空态。actions 是一组已经做好的按钮节点。 */
      function EmptyState(props) {
        return h(
          'div',
          { className: 'dr-state' },
          h('div', { className: 'dr-state-title' }, props.title),
          props.text ? h('div', { className: 'dr-state-text' }, props.text) : null,
          props.actions ? h('div', { className: 'dr-state-actions' }, props.actions) : null,
        )
      }

      /** 错误提示条。文本已经过 humanizeError，这里不再做任何加工。 */
      function ErrorNote(props) {
        if (!props.text) return null
        return h(
          'div',
          { className: 'dr-error-box', role: 'alert' },
          h('div', null, props.text),
        )
      }

      /**
       * 无封面书的书名字号。
       *
       * 目标是「像一本纸书的封面」：4 个字以内要撑满，20 个字以上要能缩到不溢出。
       * 用长度分段而不是 CSS clamp，因为中文字数才知道该多大 —— 英文 26 个字符
       * 大约等于中文 8 个字的视觉重量。
       */
      function coverFontSize(title) {
        const text = String(title || '')
        // 中日韩字符按 1 计，其余按半个计
        let weight = 0
        for (const char of text) weight += char.codePointAt(0) > 0x2e7f ? 1 : 0.5
        if (weight <= 4) return '20px'
        if (weight <= 8) return '17px'
        if (weight <= 14) return '14.5px'
        if (weight <= 22) return '12.5px'
        return '11px'
      }

      /**
       * 没有封面（或封面没读出来）时用的「米色纸封面」。
       *
       * 书架上大量本地书没有内嵌封面，空白方块会让整个书架看起来像加载失败；
       * 所以退成一张纸书封面：米色纸、居中书名、上下两条细线、底部作者。
       * 留白比字号更重要，书名按长度自动缩字号。
       */
      function PaperCover(props) {
        const title = String(props.title || '未命名')
        const author = typeof props.author === 'string' ? props.author : ''
        return h(
          'div',
          { className: 'dr-cover-fallback', 'aria-hidden': 'true' },
          h('div', { className: 'dr-cover-frame' },
            h('div', { className: 'dr-cover-rule' }),
            h(
              'div',
              { className: 'dr-cover-text', style: { fontSize: coverFontSize(title) } },
              title,
            ),
            h('div', { className: 'dr-cover-rule' }),
          ),
          author ? h('div', { className: 'dr-cover-author' }, author) : null,
        )
      }

      /**
       * 封面盒子。
       *
       * 盒子的尺寸完全由 CSS 决定（width:100% + aspect-ratio:2/3），图片只负责
       * 填满它。这条规矩是「封面大小错乱」的解药：只要让图片的 intrinsic 尺寸
       * 参与排版（比如写死 height:auto），一张 200×800 的细长封面就会把卡片撑高，
       * 同一行里的卡片高度、封面高度立刻各不相同。
       *
       * 少数封面比例极端（比 1:2 还细、接近方形或横版），铺满会把主体裁掉大半，
       * 所以给它们加一层模糊铺底 + contain 居中：盒子仍是 2:3，眼睛看到的还是整张图。
       */
      function CoverArt(props) {
        const title = String(props.title || '未命名')
        const author = typeof props.author === 'string' ? props.author : ''
        const src = typeof props.src === 'string' ? props.src : ''
        // 判定结果和被判定的那张图绑在一起（ratio.src === src）：换封面、恢复默认后
        // src 一变，旧判定自动失效，不需要再写一个「换图时清状态」的 effect ——
        // effect 在 DOM 之后才跑，缓存命中时 onLoad 可能先到，状态会被清回去。
        const [ratio, setRatio] = useState(null) // { src, extreme }
        const [brokenSrc, setBrokenSrc] = useState('')

        const broken = src !== '' && brokenSrc === src
        const showImage = src !== '' && !broken
        const extreme = showImage && ratio !== null && ratio.src === src && ratio.extreme === true
        const className = `dr-cover${extreme ? ' is-extreme' : ''}`

        return h(
          'div',
          { className },
          extreme
            ? h('div', {
              className: 'dr-cover-blur',
              'aria-hidden': 'true',
              style: { backgroundImage: `url("${src.replace(/"/g, '%22')}")` },
            })
            : null,
          showImage
            ? h('img', {
              key: src,
              src,
              alt: '',
              loading: 'lazy',
              decoding: 'async',
              onError: () => setBrokenSrc(src),
              onLoad: (event) => {
                const img = event && (event.currentTarget || event.target)
                const width = img && typeof img.naturalWidth === 'number' ? img.naturalWidth : 0
                const height = img && typeof img.naturalHeight === 'number' ? img.naturalHeight : 0
                if (width <= 0 || height <= 0) return
                const value = width / height
                // 标准书封是 2:3 ≈ 0.667；细长条和接近方形的都算极端。
                setRatio({ src, extreme: value < 0.5 || value > 0.95 })
              },
            })
            : h(PaperCover, { title, author }),
        )
      }

      /**
       * 封面地址里的版本号。
       *
       * 宿主现在给 `coverVersion`（换/删一次封面 +1，没封面时是 0），比 updatedAt 准：
       * updatedAt 也会因为改书名、改阅读进度更新时间等无关操作变化，那样换封面的缓存键
       * 会白跳一次。老库/老接口没有这个字段，回退到 updatedAt——**绝不能回退到空**，
       * 否则浏览器按 max-age 的老缓存会把刚换上的封面顶掉，用户看到「换了没生效」。
       */
      function coverVersionOf(book) {
        if (book && Number.isInteger(book.coverVersion)) return String(book.coverVersion)
        return book && typeof book.updatedAt === 'string' ? book.updatedAt : ''
      }

      /**
       * 一张书卡。
       *
       * 封面加载失败时回退成米色纸封面：本地书常常没有封面，空白方块会让书架
       * 看起来像出错。
       */
      function BookCard(props) {
        const book = props.book
        const percent = typeof book.percent === 'number' ? book.percent : 0
        const title = book.title || '未命名'
        // 带版本号的封面地址：换完封面的那一刻版本号变了，地址就变了，
        // 不会被浏览器按老缓存顶回旧图（coverVersion 由宿主维护，换/删一次 +1）。
        const cover = typeof book.coverUrl === 'string' && book.coverUrl !== ''
          ? coverUrl(book.bookHash, coverVersionOf(book))
          : ''

        return h(
          'button',
          {
            type: 'button',
            className: 'dr-book',
            onClick: () => props.onOpen(book.bookHash),
            title: `${title}${book.author ? ` · ${book.author}` : ''}`,
          },
          h(CoverArt, { src: cover, title, author: book.author || '' }),
          h('div', { className: 'dr-book-title' }, title),
          // 重排书（MOBI / TXT 转来的）没有原始版式，挂个小标记免得用户以为图片丢了。
          book.sourceFormat && book.sourceFormat !== 'epub'
            ? h(
              'div',
              { className: 'dr-book-badge' },
              book.sourceFormat === 'txt' ? 'TXT · 重排' : `${String(book.sourceFormat).toUpperCase()} · 重排`,
            )
            : null,
          book.favorite === true
            ? h('div', { className: 'dr-book-star', title: '我的珍藏' }, '★')
            : null,
          h('div', { className: 'dr-book-meta dr-ellipsis' }, book.author || '作者未知'),
          // 分类 / 系列 / 标签：只显示一行，最多两个，多了反而把卡片塞满
          (book.series || book.category || (Array.isArray(book.tags) && book.tags.length > 0))
            ? h(
              'div',
              { className: 'dr-book-meta dr-ellipsis dr-book-taxon' },
              [
                book.series ? `系列·${book.series}` : '',
                book.category ? book.category : '',
                ...(Array.isArray(book.tags) ? book.tags.map((tag) => `#${tag}`) : []),
              ].filter((item) => item !== '').slice(0, 2).join(' · '),
            )
            : null,
          h(
            'div',
            { className: 'dr-progress', role: 'progressbar', 'aria-valuenow': Math.round(percent * 100) },
            h('div', {
              className: 'dr-progress-fill',
              style: { width: `${Math.round(Math.max(0, Math.min(1, percent)) * 100)}%` },
            }),
          ),
          h('div', { className: 'dr-book-meta' }, percent > 0 ? percentText(percent) : '还没开始读'),
        )
      }

      /**
       * 编辑书名 / 作者 / 封面的弹窗。
       *
       * 保存顺序是刻意的：先写封面，再改书名 —— 宿主每次写盘都会刷新 meta 的
       * updatedAt，而这个字段是封面地址的版本号。封面必须紧跟最后一次写盘，
       * 否则书架重新取列表时拿到的还是旧版本号，图和文字会各说各话。
       */
      function BookEditDialog(props) {
        const book = props.book
        const [title, setTitle] = useState(typeof book.title === 'string' ? book.title : '')
        const [author, setAuthor] = useState(typeof book.author === 'string' ? book.author : '')
        // 0.5.1 的新字段：简介 / 分类 / 系列 / 标签 / 珍藏
        const [description, setDescription] = useState(typeof book.description === 'string' ? book.description : '')
        const [category, setCategory] = useState(typeof book.category === 'string' ? book.category : '')
        const [series, setSeries] = useState(typeof book.series === 'string' ? book.series : '')
        const [tagText, setTagText] = useState(Array.isArray(book.tags) ? book.tags.join('、') : '')
        const [favorite, setFavorite] = useState(book.favorite === true)
        const [coverDataUrl, setCoverDataUrl] = useState('')
        const [coverCleared, setCoverCleared] = useState(false)
        const [saving, setSaving] = useState(false)
        const [error, setError] = useState('')
        const fileRef = useRef(null)
        // 每次选完图就换一个新的 input（key 变化 → React 重新挂载），等于把选择清空：
        // 用户重选同一张图也能再触发 change。不改 DOM 也能做到这件事。
        const [pickSeq, setPickSeq] = useState(0)

        const titleLength = Array.from(String(title)).length
        const authorLength = Array.from(String(author)).length
        const savedCover = typeof book.coverUrl === 'string' && book.coverUrl !== ''
          ? coverUrl(book.bookHash, coverVersionOf(book))
          : ''
        // 预览优先级：新选的图 > 已删除（显示纸封面）> 现有封面
        const preview = coverDataUrl !== '' ? coverDataUrl : (coverCleared ? '' : savedCover)

        const close = () => {
          if (saving) return
          if (typeof props.onCancel === 'function') props.onCancel()
        }

        const onPickCover = async (event) => {
          const input = event && event.target
          const file = input && input.files && input.files[0]
          // 立刻换一个 input（见 pickSeq 的注释）：等于清空选择，
          // 用户重选同一张图时 change 才会再响一次。
          setPickSeq((n) => n + 1)
          if (!file) return
          setError('')
          if (typeof file.size === 'number' && file.size > COVER_MAX_BYTES) {
            setError('封面文件太大，请换一张小于 3 MB 的图片。')
            return
          }
          try {
            const base64 = await readAsBase64(file)
            const mime = sniffCoverMime(base64)
            if (mime === '') {
              setError('只支持 PNG、JPEG、WebP 图片。')
              return
            }
            setCoverDataUrl(`data:${mime};base64,${base64}`)
            setCoverCleared(false)
          } catch (err) {
            setError(humanizeError(err))
          }
        }

        const onSave = async () => {
          if (saving) return
          const nextTitle = String(title).trim()
          const nextAuthor = String(author).trim()
          // 先在本地挡一遍：宿主也会校验，但让用户等一趟网络才知道书名为空没必要
          if (nextTitle === '') {
            setError('书名不能为空。')
            return
          }
          if (Array.from(nextTitle).length > TITLE_MAX) {
            setError(`书名最多 ${TITLE_MAX} 个字。`)
            return
          }
          if (Array.from(nextAuthor).length > AUTHOR_MAX) {
            setError(`作者名最多 ${AUTHOR_MAX} 个字。`)
            return
          }

          setSaving(true)
          setError('')
          try {
            if (coverDataUrl !== '') await putBookCover(book.bookHash, coverDataUrl)
            else if (coverCleared) await resetBookCover(book.bookHash)
            // 标签用中文顿号或逗号分隔都行，两种都拆
            const tags = String(tagText)
              .split(/[、,，;；\s]+/)
              .map((item) => item.trim())
              .filter((item) => item !== '')
            if (tags.length > TAG_MAX_COUNT) {
              setError(`标签最多 ${TAG_MAX_COUNT} 个。`)
              setSaving(false)
              return
            }
            const result = await updateBook(book.bookHash, {
              title: nextTitle,
              author: nextAuthor,
              description: String(description).trim(),
              category: String(category).trim(),
              series: String(series).trim(),
              tags,
              favorite,
            })
            const saved = result && typeof result === 'object'
              && result.book && typeof result.book === 'object' ? result.book : null
            if (typeof props.onSaved === 'function') props.onSaved(saved)
            // 上层通常在这里把弹窗关掉；万一没关（比如没接 onSaved），
            // 按钮不能永远停在「正在保存…」
            setSaving(false)
          } catch (err) {
            // 弹窗不关：用户改的东西还在，改一下重试比重新填一遍省事
            setError(humanizeError(err))
            setSaving(false)
          }
        }

        return h(
          'div',
          {
            className: 'dr-modal-mask',
            role: 'presentation',
            onClick: close,
          },
          h(
            'div',
            {
              className: 'dr-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '编辑书名和封面',
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'dr-modal-head' },
              h('span', null, '编辑书名和封面'),
              h('div', { className: 'dr-grow' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-iconbtn',
                  title: '关闭',
                  'aria-label': '关闭编辑窗口',
                  disabled: saving,
                  onClick: close,
                },
                '×',
              ),
            ),
            h(
              'div',
              { className: 'dr-modal-body' },
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '书名'),
                h('input', {
                  type: 'text',
                  className: 'dr-input',
                  value: title,
                  maxLength: TITLE_MAX,
                  placeholder: '这本书叫什么',
                  'aria-label': '书名',
                  onChange: (event) => setTitle(event.target.value),
                }),
                h('div', { className: 'dr-field-value' }, `${titleLength}/${TITLE_MAX}`),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '作者'),
                h('input', {
                  type: 'text',
                  className: 'dr-input',
                  value: author,
                  maxLength: AUTHOR_MAX,
                  placeholder: '不知道就留空',
                  'aria-label': '作者',
                  onChange: (event) => setAuthor(event.target.value),
                }),
                h('div', { className: 'dr-field-value' }, `${authorLength}/${AUTHOR_MAX}`),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '分类'),
                h('input', {
                  type: 'text',
                  className: 'dr-input',
                  value: category,
                  maxLength: 40,
                  placeholder: '如：科幻、散文、教材（留空 = 未分类）',
                  'aria-label': '分类',
                  onChange: (event) => setCategory(event.target.value),
                }),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '系列'),
                h('input', {
                  type: 'text',
                  className: 'dr-input',
                  value: series,
                  maxLength: 80,
                  placeholder: '同一套书填同一个名字，如：三体',
                  'aria-label': '系列',
                  onChange: (event) => setSeries(event.target.value),
                }),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '标签'),
                h('input', {
                  type: 'text',
                  className: 'dr-input',
                  value: tagText,
                  placeholder: '用顿号或逗号分开，如：硬科幻、已读完',
                  'aria-label': '标签',
                  onChange: (event) => setTagText(event.target.value),
                }),
                h('div', { className: 'dr-field-value' }, `最多 ${TAG_MAX_COUNT} 个`),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '简介'),
                h('textarea', {
                  className: 'dr-input dr-textarea',
                  value: description,
                  rows: 4,
                  placeholder: '这本书讲什么（记给自己看，不会上传）',
                  'aria-label': '简介',
                  onChange: (event) => setDescription(event.target.value),
                }),
              ),
              h(
                'div',
                { className: 'dr-field dr-field-inline' },
                h(
                  'label',
                  { className: 'dr-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: favorite,
                    onChange: (event) => setFavorite(event.target.checked),
                  }),
                  h('span', null, '加入我的珍藏'),
                ),
              ),
              h(
                'div',
                { className: 'dr-field' },
                h('div', { className: 'dr-field-label' }, '封面'),
                h(
                  'div',
                  { className: 'dr-edit-cover' },
                  h('div', { className: 'dr-edit-cover-preview' },
                    h(CoverArt, { src: preview, title: title || book.title, author }),
                  ),
                  h(
                    'div',
                    { className: 'dr-edit-cover-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dr-btn dr-btn-sm',
                        title: '选择图片',
                        'aria-label': '选择封面图片',
                        onClick: () => {
                          if (fileRef.current) fileRef.current.click()
                        },
                      },
                      '选择图片',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dr-btn dr-btn-sm dr-btn-ghost',
                        title: '删除封面，用默认的纸封面',
                        'aria-label': '删除封面',
                        disabled: preview === '',
                        onClick: () => {
                          setCoverDataUrl('')
                          setCoverCleared(true)
                        },
                      },
                      '删除封面',
                    ),
                    h('div', { className: 'dr-field-hint' }, 'PNG、JPEG 或 WebP，最大 3 MB'),
                  ),
                ),
                h('input', {
                  key: pickSeq,
                  ref: fileRef,
                  type: 'file',
                  accept: 'image/png,image/jpeg,image/webp',
                  'aria-hidden': 'true',
                  tabIndex: -1,
                  style: { display: 'none' },
                  onChange: onPickCover,
                }),
              ),
              error ? h('div', { className: 'dr-form-error', role: 'alert' }, error) : null,
            ),
            h(
              'div',
              { className: 'dr-modal-foot' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-btn dr-btn-ghost',
                  title: '取消',
                  disabled: saving,
                  onClick: close,
                },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-btn dr-btn-primary',
                  title: '保存',
                  disabled: saving,
                  onClick: onSave,
                },
                saving ? '正在保存…' : '保存',
              ),
            ),
          ),
        )
      }

      /**
       * 书架视图。
       *
       * props:
       *   onOpen(bookHash)      —— 点开一本书
       *   onImported(bookHash)  —— 导入成功（可选，用于直接跳进去读）
       *
       * 这里自己管加载/错误状态，不把网络细节漏给 app.js —— 上层只关心「打开哪本书」。
       */

      /**
       * 「导入」面板（0.5.1）。
       *
       * 三条路并列摆出来，而不是藏在二级菜单里：
       *   ① 本地文件 —— 原来就有的行为；
       *   ② 粘贴链接 —— 从任何地方复制来的书籍直链，粘进来就下载入架；
       *   ③ 找书     —— 用户自己填一个「搜索地址模板」，插件去抓结果页列出候选。
       *
       * 为什么不内置书源：插件不该替用户决定去哪个站点找书。这里只提供机制，
       * 地址由用户自己填；模板里 `{query}` 会被换成关键词。
       */
      function ImportDialog(props) {
        const fileRef = useRef(null)
        const [url, setUrl] = useState('')
        const [urlBusy, setUrlBusy] = useState(false)
        const [urlError, setUrlError] = useState('')

        const [keyword, setKeyword] = useState('')
        const [searching, setSearching] = useState(false)
        const [searchError, setSearchError] = useState('')
        const [searchInfo, setSearchInfo] = useState('')
        const [candidates, setCandidates] = useState(null)
        const [downloading, setDownloading] = useState('')
        const [downloadError, setDownloadError] = useState('')

        const [sources, setSources] = useState(null)
        const [sourceId, setSourceId] = useState('')
        const [formOpen, setFormOpen] = useState(false)
        const [formName, setFormName] = useState('')
        const [formTemplate, setFormTemplate] = useState('')
        const [formError, setFormError] = useState('')
        const [savingSource, setSavingSource] = useState(false)

        useEffect(() => {
          let alive = true
          call('settings.get')
            .then((value) => {
              if (!alive) return
              const list = Array.isArray(value && value.bookSources) ? value.bookSources : []
              setSources(list)
              if (list.length > 0) setSourceId(list[0].id)
              else setFormOpen(true)
            })
            .catch(() => {
              if (!alive) return
              setSources([])
              setFormOpen(true)
            })
          return () => {
            alive = false
          }
        }, [])

        const busy = urlBusy || downloading !== '' || savingSource
        const close = () => {
          if (busy) return
          if (typeof props.onClose === 'function') props.onClose()
        }

        const submitUrl = async () => {
          const value = url.trim()
          if (value === '') {
            setUrlError('先把链接粘贴到上面的框里。')
            return
          }
          setUrlError('')
          setUrlBusy(true)
          try {
            await props.onImportUrl(value)
          } catch (error) {
            setUrlError(humanizeError(error))
          } finally {
            setUrlBusy(false)
          }
        }

        const runSearch = async () => {
          const value = keyword.trim()
          if (value === '') {
            setSearchError('输入书名或作者，再点搜索。')
            return
          }
          if (Array.isArray(sources) && sources.length === 0) {
            setSearchError('还没有书源：先在下面填一个搜索地址模板。')
            return
          }
          setSearching(true)
          setSearchError('')
          setSearchInfo('')
          setCandidates(null)
          try {
            const result = await call('source.search', { query: value, sourceId: sourceId || undefined })
            const list = Array.isArray(result && result.candidates) ? result.candidates : []
            setCandidates(list)
            const name = result && result.source && result.source.name ? result.source.name : '书源'
            setSearchInfo(
              list.length === 0
                ? `${name} 没有返回可用的链接。可能站点改版了，换一个书源试试。`
                : `${name} · 找到 ${list.length} 条，点右边的「下载」加入书架`,
            )
          } catch (error) {
            setSearchError(humanizeError(error))
          } finally {
            setSearching(false)
          }
        }

        const download = async (candidate) => {
          setDownloadError('')
          setDownloading(candidate.url)
          try {
            await props.onImportUrl(candidate.url, candidate.title)
          } catch (error) {
            setDownloadError(humanizeError(error))
          } finally {
            setDownloading('')
          }
        }

        const saveSource = async () => {
          const name = formName.trim() === '' ? '我的书源' : formName.trim()
          const template = formTemplate.trim()
          if (!/^https?:\/\//i.test(template)) {
            setFormError('搜索地址要以 http:// 或 https:// 开头。')
            return
          }
          if (!template.includes('{query}')) {
            setFormError('搜索地址里要留一个 {query}，它会被换成你搜的关键词。')
            return
          }
          setSavingSource(true)
          setFormError('')
          const next = (sources || []).filter((item) => item && item.name !== name)
          next.push({ id: `src-${Date.now().toString(36)}`, name, searchUrl: template })
          try {
            const saved = await call('settings.put', { bookSources: next })
            const list = Array.isArray(saved && saved.bookSources) ? saved.bookSources : next
            setSources(list)
            setSourceId(list[list.length - 1].id)
            setFormOpen(false)
            setFormName('')
            setFormTemplate('')
          } catch (error) {
            setFormError(humanizeError(error))
          } finally {
            setSavingSource(false)
          }
        }

        const fileInput = h('input', {
          ref: fileRef,
          type: 'file',
          accept: '.epub,.mobi,.azw,.azw3,.txt,.pdf,application/epub+zip,application/x-mobipocket-ebook,text/plain,application/pdf',
          style: { display: 'none' },
          onChange: props.onFilePicked,
        })

        return h(
          'div',
          { className: 'dr-modal-mask', role: 'presentation', onClick: close },
          h(
            'div',
            {
              className: 'dr-modal dr-import',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '导入图书',
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'dr-modal-head' },
              h('span', null, '导入图书'),
              h('div', { className: 'dr-grow' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-iconbtn',
                  title: '关闭',
                  'aria-label': '关闭导入窗口',
                  disabled: busy,
                  onClick: close,
                },
                '×',
              ),
            ),
            h(
              'div',
              { className: 'dr-modal-body' },
              // ① 本地文件
              h(
                'div',
                { className: 'dr-import-section' },
                h('div', { className: 'dr-import-title' }, '① 从电脑里选'),
                h('div', { className: 'dr-import-hint' }, '支持 EPUB / MOBI / AZW3 / TXT / PDF。'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dr-btn dr-btn-primary',
                    disabled: busy,
                    onClick: () => {
                      if (fileRef.current) fileRef.current.click()
                    },
                  },
                  '选择文件',
                ),
                fileInput,
              ),
              // ② 粘贴链接
              h(
                'div',
                { className: 'dr-import-section' },
                h('div', { className: 'dr-import-title' }, '② 粘贴下载链接'),
                h('div', { className: 'dr-import-hint' }, '在任意网页上复制这本书的文件地址（以 .epub / .pdf / .txt 结尾的那种），粘进来直接下载入架。'),
                h('input', {
                  type: 'text',
                  className: 'dr-input',
                  value: url,
                  placeholder: 'https://…/book.epub',
                  'aria-label': '书籍下载链接',
                  onChange: (event) => setUrl(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitUrl()
                  },
                }),
                h(
                  'div',
                  { className: 'dr-import-row' },
                  h(
                    'button',
                    { type: 'button', className: 'dr-btn dr-btn-primary', disabled: busy, onClick: submitUrl },
                    urlBusy ? '正在下载…' : '下载并导入',
                  ),
                ),
                urlError !== '' ? h('div', { className: 'dr-import-error' }, urlError) : null,
              ),
              // ③ 找书
              h(
                'div',
                { className: 'dr-import-section' },
                h('div', { className: 'dr-import-title' }, '③ 找书（用你自己的书源）'),
                h('div', { className: 'dr-import-hint' }, '填一个「搜索地址模板」，插件去抓那个页面的搜索结果显示出来。模板里把关键词的位置写成 {query}。'),
                h(
                  'div',
                  { className: 'dr-import-row' },
                  h('input', {
                    type: 'text',
                    className: 'dr-input',
                    value: keyword,
                    placeholder: '书名或作者',
                    'aria-label': '搜索关键词',
                    onChange: (event) => setKeyword(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') runSearch()
                    },
                  }),
                  Array.isArray(sources) && sources.length > 1
                    ? h(
                      'select',
                      {
                        className: 'dr-input dr-select',
                        value: sourceId,
                        'aria-label': '选择书源',
                        onChange: (event) => setSourceId(event.target.value),
                      },
                      sources.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                    )
                    : null,
                  h(
                    'button',
                    { type: 'button', className: 'dr-btn', disabled: searching || busy, onClick: runSearch },
                    searching ? '正在搜…' : '搜索',
                  ),
                ),
                searchError !== '' ? h('div', { className: 'dr-import-error' }, searchError) : null,
                searchInfo !== '' ? h('div', { className: 'dr-import-hint' }, searchInfo) : null,
                downloadError !== '' ? h('div', { className: 'dr-import-error' }, downloadError) : null,
                candidates !== null && candidates.length > 0
                  ? h(
                    'div',
                    { className: 'dr-candidates' },
                    candidates.map((item) => h(
                      'div',
                      { key: item.url, className: 'dr-candidate' },
                      h('div', { className: 'dr-candidate-title', title: item.url }, item.title),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dr-btn',
                          disabled: downloading !== '',
                          onClick: () => download(item),
                        },
                        downloading === item.url ? '下载中…' : '下载',
                      ),
                    )),
                  )
                  : null,
                // 书源管理：有书源时收起来，没书源时直接展开
                formOpen
                  ? h(
                    'div',
                    { className: 'dr-source-form' },
                    h('input', {
                      type: 'text',
                      className: 'dr-input',
                      value: formName,
                      placeholder: '书源名字（随便起，如「我的站」）',
                      'aria-label': '书源名字',
                      onChange: (event) => setFormName(event.target.value),
                    }),
                    h('input', {
                      type: 'text',
                      className: 'dr-input',
                      value: formTemplate,
                      placeholder: 'https://example.com/search?q={query}',
                      'aria-label': '搜索地址模板',
                      onChange: (event) => setFormTemplate(event.target.value),
                    }),
                    h(
                      'div',
                      { className: 'dr-import-row' },
                      h(
                        'button',
                        { type: 'button', className: 'dr-btn dr-btn-primary', disabled: busy, onClick: saveSource },
                        savingSource ? '保存中…' : '保存书源',
                      ),
                      Array.isArray(sources) && sources.length > 0
                        ? h('button', { type: 'button', className: 'dr-btn', onClick: () => setFormOpen(false) }, '取消')
                        : null,
                    ),
                    formError !== '' ? h('div', { className: 'dr-import-error' }, formError) : null,
                  )
                  : h(
                    'button',
                    { type: 'button', className: 'dr-btn dr-import-linkbtn', onClick: () => setFormOpen(true) },
                    '添加/修改书源',
                  ),
              ),
            ),
          ),
        )
      }

      /**
       * 书架筛选（0.5.1）。
       *
       * 「我的珍藏」是唯一不需要第二个参数的筛选项；其余三类（系列 / 作者 / 分类 / 标签）
       * 都要先选一个具体值。做成两级下拉而不是一堆标签墙：书多了以后标签墙会失控。
       *
       * @param {any[]} books
       * @param {string} kind
       * @param {string} value
       * @returns {any[]}
       */
      function filterBooks(books, kind, value) {
        const list = Array.isArray(books) ? books : []
        if (kind === 'favorite') return list.filter((book) => book.favorite === true)
        // 下拉里的「全部」是空串：选了维度但还没选值时，先当「不筛」，
        // 否则用户会以为「按作者 → 全部」把书弄丢了。
        if (value === '') return list
        if (kind === 'series') return list.filter((book) => (book.series || '') === value)
        if (kind === 'author') return list.filter((book) => (book.author || '') === value)
        if (kind === 'category') return list.filter((book) => (book.category || '') === value)
        if (kind === 'tag') return list.filter((book) => Array.isArray(book.tags) && book.tags.includes(value))
        return list
      }

      /** 某个筛选维度下所有可选值（去重、排序、去掉空值）。 */
      function facetValues(books, kind) {
        const list = Array.isArray(books) ? books : []
        const out = new Set()
        for (const book of list) {
          if (kind === 'series' && book.series) out.add(book.series)
          if (kind === 'author' && book.author) out.add(book.author)
          if (kind === 'category' && book.category) out.add(book.category)
          if (kind === 'tag' && Array.isArray(book.tags)) book.tags.forEach((tag) => out.add(tag))
        }
        return Array.from(out).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
      }

      function ShelfView(props) {
        const [books, setBooks] = useState(null) // null = 还在读
        const [error, setError] = useState('')
        const [importing, setImporting] = useState(false)
        const [importError, setImportError] = useState('')
        const [reloadKey, setReloadKey] = useState(0)
        const [editing, setEditing] = useState(null) // 正在编辑的书；null = 弹窗关着
        const [importOpen, setImportOpen] = useState(false) // 「导入」面板（0.5.1）
        const [filterKind, setFilterKind] = useState('all') // 书架筛选维度（0.5.1）
        const [filterValue, setFilterValue] = useState('')
        const [notice, setNotice] = useState('') // 一句话提示，几秒后自己消失
        const inputRef = useRef(null)

        useEffect(() => {
          let alive = true
          setBooks(null)
          setError('')
          call('shelf.list')
            .then((value) => {
              if (!alive) return
              const list = value && Array.isArray(value.books) ? value.books : []
              setBooks(list)
            })
            .catch((err) => {
              if (!alive) return
              setError(humanizeError(err))
              setBooks([])
            })
          return () => {
            alive = false
          }
        }, [reloadKey])

        const reload = useCallback(() => {
          setReloadKey((n) => n + 1)
        }, [])

        // 提示条两秒后自己走：这种「已保存」不该占着屏幕等用户点掉
        useEffect(() => {
          if (notice === '') return undefined
          const timer = setTimeout(() => setNotice(''), 2200)
          return () => clearTimeout(timer)
        }, [notice])

        const onEdit = useCallback((book) => {
          setError('')
          setEditing(book)
        }, [])

        const onEditCancel = useCallback(() => {
          setEditing(null)
        }, [])

        const onEditSaved = useCallback(() => {
          setEditing(null)
          setNotice('已保存')
          // 必须重新取列表：封面地址里带的是 meta 的 updatedAt 版本号，
          // 只改本地字段的话，封面会一直显示旧图（浏览器手里还有旧缓存）。
          reload()
        }, [reload])

        const onPickFile = useCallback(
          async (event) => {
            const input = event.target
            const file = input && input.files && input.files[0]
            // 允许重复选同一个文件：不清空的话第二次选它不会触发 change
            if (input) input.value = ''
            if (!file) return

            setImportError('')
            if (typeof file.size === 'number' && file.size > BIG_FILE_BYTES) {
              // 不阻止，只是先提醒：宿主侧有真正的上限判定
              setImportError('这个文件很大，导入可能要一会儿。')
            }
            setImporting(true)
            try {
              const dataBase64 = await readAsBase64(file)
              const result = await call('shelf.import', { filename: file.name, dataBase64 })
              const bookHash = result && result.bookHash
              if (typeof bookHash === 'string' && bookHash !== '') {
                if (typeof props.onImported === 'function') {
                  props.onImported(bookHash)
                } else {
                  reload()
                }
              } else {
                reload()
              }
            } catch (err) {
              setImportError(humanizeError(err))
            } finally {
              setImporting(false)
            }
          },
          [props.onImported, reload],
        )

        // 「粘贴链接 / 找书下载」共用一条通道：宿主负责下载、嗅探格式、入架。
        const onImportUrl = useCallback(
          async (url, title) => {
            setImportError('')
            setImporting(true)
            try {
              const filename = typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
              const result = await call('shelf.importUrl', filename ? { url, filename } : { url })
              const bookHash = result && result.bookHash
              setImportOpen(false)
              setNotice('已加入书架')
              if (typeof bookHash === 'string' && bookHash !== '' && typeof props.onImported === 'function') {
                props.onImported(bookHash)
              } else {
                reload()
              }
            } catch (err) {
              // 抛回给面板显示：面板里的输入框还在，用户可以直接改链接重试。
              throw err
            } finally {
              setImporting(false)
            }
          },
          [props.onImported, reload],
        )

        const onRemove = useCallback(
          async (bookHash, title) => {
            const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
              ? window.confirm(
                `把《${title || '这本书'}》从书架里移除？\n\n批注和阅读进度也会一起删掉，这一步不能撤销。`,
              )
              : true
            if (!confirmed) return
            setError('')
            try {
              await call('shelf.remove', { bookHash })
              reload()
            } catch (err) {
              setError(humanizeError(err))
            }
          },
          [reload],
        )

        const fileInput = h('input', {
          ref: inputRef,
          type: 'file',
          // 五种格式一起放进来：扩展名只是给文件选择器看的提示，真正的格式判定
          // 在宿主侧按文件字节（魔数）做，改扩展名骗不过去。
          accept: '.epub,.mobi,.azw,.azw3,.txt,.pdf,application/epub+zip,application/x-mobipocket-ebook,text/plain,application/pdf',
          style: { display: 'none' },
          onChange: onPickFile,
        })

        const importButton = h(
          'button',
          {
            type: 'button',
            className: 'dr-btn dr-btn-primary',
            disabled: importing,
            onClick: () => setImportOpen(true),
          },
          importing ? '正在导入…' : '导入图书',
        )

        const safeBooks = Array.isArray(books) ? books : []
        const facets = filterKind === 'all' || filterKind === 'favorite' ? [] : facetValues(safeBooks, filterKind)
        const visibleBooks = filterBooks(safeBooks, filterKind, filterValue)
        const filterLabel = (FILTER_KINDS.find(([value]) => value === filterKind) ?? ['all', '全部书籍'])[1]

        // 筛选栏固定左上角：先选「按什么筛」，再选「具体值」。
        const filterBar = h(
          'div',
          { className: 'dr-filters' },
          h(
            'select',
            {
              className: 'dr-input dr-select dr-filter-select',
              value: filterKind,
              'aria-label': '筛选方式',
              onChange: (event) => {
                setFilterKind(event.target.value)
                setFilterValue('')
              },
            },
            FILTER_KINDS.map(([value, label]) => h('option', { key: value, value }, label)),
          ),
          facets.length > 0
            ? h(
              'select',
              {
                className: 'dr-input dr-select dr-filter-select',
                value: filterValue,
                'aria-label': '筛选值',
                onChange: (event) => setFilterValue(event.target.value),
              },
              [h('option', { key: '__any', value: '' }, '全部')].concat(
                facets.map((value) => h('option', { key: value, value }, value)),
              ),
            )
            : null,
          filterKind !== 'all'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-btn',
                onClick: () => {
                  setFilterKind('all')
                  setFilterValue('')
                },
              },
              '清除筛选',
            )
            : null,
          safeBooks.length > 0
            ? h('span', { className: 'dr-filters-count' }, `${visibleBooks.length} / ${safeBooks.length} 本`)
            : null,
        )

        const head = h(
          'div',
          { className: 'dr-head' },
          h('div', { className: 'dr-head-title' }, '书架'),
          h(
            'div',
            { className: 'dr-head-sub' },
            books === null ? '正在读取…' : books.length === 0 ? '还没有书' : `${books.length} 本`,
          ),
          h('div', { className: 'dr-grow' }),
          books !== null && books.length > 0
            ? h('button', { type: 'button', className: 'dr-btn', onClick: reload }, '刷新')
            : null,
          importButton,
          fileInput,
        )

        let body
        if (books === null) {
          body = h(Loading, { text: '正在读书架…' })
        } else if (books.length === 0 && error === '') {
          body = h(EmptyState, {
            title: '书架还是空的',
            text: '支持 EPUB / MOBI / AZW3 / TXT / PDF，点右上角「导入图书」就能开始读。书会存在你自己的磁盘上，不上传任何服务器。',
            actions: importButton,
          })
        } else if (visibleBooks.length === 0) {
          // 书架有书、但当前筛选下面没有 → 不是「书架空了」，要说清楚并给一条退路。
          body = h(
            'div',
            { className: 'dr-filter-empty' },
            h('div', null, `「${filterLabel}」下面还没有书。`),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-btn',
                onClick: () => {
                  setFilterKind('all')
                  setFilterValue('')
                },
              },
              '看全部书籍',
            ),
          )
        } else {
          body = h(
            'div',
            { className: 'dr-grid' },
            // 每个格子自己是一个 grid item（.dr-book-cell），样式里给它 min-width:0：
            // 长作者名 / 长书名不许把格子撑宽，否则卡片会溢出去盖住邻卡。
            visibleBooks.map((book) => h(
              'div',
              {
                key: book.bookHash,
                className: 'dr-book-cell',
                // 右键 = 改这本书的信息。和右上角「✎」是同一个入口，
                // 但右键更符合「对着这本书操作」的直觉。
                onContextMenu: (event) => {
                  if (event && typeof event.preventDefault === 'function') event.preventDefault()
                  onEdit(book)
                },
              },
              h(BookCard, { book, onOpen: props.onOpen }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-iconbtn',
                  title: '编辑书名和封面',
                  'aria-label': `编辑《${book.title || '未命名'}》的书名和封面`,
                  style: { position: 'absolute', top: 14, right: 46 },
                  onClick: (event) => {
                    event.stopPropagation()
                    onEdit(book)
                  },
                },
                '✎',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-iconbtn',
                  title: '从书架移除',
                  'aria-label': `从书架移除《${book.title || '未命名'}》`,
                  style: { position: 'absolute', top: 14, right: 14 },
                  onClick: (event) => {
                    event.stopPropagation()
                    onRemove(book.bookHash, book.title)
                  },
                },
                '×',
              ),
            )),
          )
        }

        return h(
          'div',
          { className: 'dr-root' },
          head,
          books !== null ? filterBar : null,
          h(
            'div',
            { className: 'dr-body' },
            error ? h(ErrorNote, { text: error }) : null,
            importError ? h(ErrorNote, { text: importError }) : null,
            body,
          ),
          importOpen
            ? h(ImportDialog, {
              onClose: () => setImportOpen(false),
              onFilePicked: (event) => {
                setImportOpen(false)
                onPickFile(event)
              },
              onImportUrl,
            })
            : null,
          editing
            ? h(BookEditDialog, {
              book: editing,
              onCancel: onEditCancel,
              onSaved: onEditSaved,
            })
            : null,
          notice !== '' ? h('div', { className: 'dr-toast', role: 'status' }, notice) : null,
        )
      }

      return { filterBooks: filterBooks, facetValues: facetValues, ShelfView: ShelfView }
    })()

    // ─── client/src/toc.js ───
    var __mod_toc_js = (function () {
      /**
       * toc.js —— 目录面板。
       *
       * 目录是「一本书的骨架」，用户靠它判断「这本书值不值得读下去」。
       * 所以这里只做三件事：按 depth 缩进、标出当前章、点了就跳。
       *
       * 三态齐全：加载中（宿主还在解 OPF）、空（这本书真的没有目录）、
       * 出错（humanizeError 过的中文）。
       *
       * 目录还会带上「它是怎么来的」（source，见下方 TocPanel 说明）：
       * 猜出来的目录必须自报家门，否则用户会把识别的误差记在书或插件头上。
       */

      /**
       * 把任意形态的 toc 压平成可以直接渲染的一维数组。
       *
       * 宿主给的是 `{ label, href, spineIndex, depth }`；但真实 EPUB 的 nav
       * 常常有嵌套（`children` / `subitems`），而不同解析器的字段名不一致，
       * 所以这里做一次归一化：**能算出 spineIndex 的才算有效条目**，算不出的丢掉——
       * 点了跳不到的目录行比没有这一行更让人恼火。
       *
       * @param {Array} toc
       * @returns {Array<{label:string, href:string|null, spineIndex:number, depth:number}>}
       */
      function flattenToc(toc) {
        const out = []
        const seen = new Set()

        const walk = (items, depth) => {
          if (!Array.isArray(items)) return
          for (const raw of items) {
            if (!raw || typeof raw !== 'object') continue

            const spineIndex = Number.isInteger(raw.spineIndex)
              ? raw.spineIndex
              : Number.isInteger(raw.index) ? raw.index : null
            const href = typeof raw.href === 'string' && raw.href !== '' ? raw.href : null
            const label = typeof raw.label === 'string' && raw.label.trim() !== ''
              ? raw.label.trim()
              : (href ? href.split('/').pop().replace(/\.[^.]+$/, '') : '')

            if (spineIndex !== null && spineIndex >= 0 && label !== '') {
              // 同一 spineIndex 可能出现多次（分卷标题 + 首章），保留第一次的短标签即可，
              // 但千万别把「不同章但同 index」的条目合并掉——那会丢章节。
              const key = `${spineIndex}\u0000${label}`
              if (!seen.has(key)) {
                seen.add(key)
                out.push({
                  label,
                  href,
                  spineIndex,
                  depth: Number.isInteger(raw.depth) ? Math.max(0, raw.depth) : depth,
                })
              }
            }

            const children = Array.isArray(raw.children)
              ? raw.children
              : Array.isArray(raw.subitems) ? raw.subitems : null
            if (children) walk(children, depth + 1)
          }
        }

        walk(toc, 0)
        return out
      }

      /** 加载态。 */
      function TocLoading() {
        return h(
          'div',
          { className: 'dr-state' },
          h('div', { className: 'dr-spinner', role: 'status', 'aria-label': '正在读取目录' }),
          h('div', { className: 'dr-state-text' }, '正在读取目录…'),
        )
      }

      /**
       * 目录面板。
       *
       * 目录有三种来源，用户得知道自己在看哪一种，所以每种都有一句人话：
       *   nav / ncx —— 书里自带的目录，最可信，什么都不用说；
       *   auto      —— 从正文标题里猜的（TXT / 重排书），必须标「自动识别」，
       *                 因为猜错是常态，用户会以为是我们把书读坏了；
       *   none      —— 真的没有，给一句「怎么继续往下读」比空着强。
       *
       * props:
       *   toc                 —— 宿主给的原始 toc（null = 加载中）
       *   items               —— 已经 flatten 过的扁平目录（优先于 toc）
       *   source              —— 'nav' | 'ncx' | 'auto' | 'none'；缺省视为未知（不标角标）
       *   currentSpineIndex   —— 当前章（0 起）；用来高亮
       *   onJump(spineIndex, href)
       *   error               —— 已经 humanizeError 过的文案（可选）
       *   loading             —— 显式指定加载态（toc 为 null 时默认也算加载中）
       */

      /** 自动识别的说明文字。写「可能不准」而不是「推断结果」，后者是行话。 */
      const AUTO_NOTE = '按正文里的标题自动分段，可能和原书目录不一样'

      function TocPanel(props) {
        const given = Array.isArray(props.items) ? props.items : null
        const items = useMemo(
          () => (given !== null ? given : flattenToc(props.toc)),
          [given, props.toc],
        )
        const loading = props.loading === true
          || (props.toc === null && given === null && !props.error)

        const listRef = useRef(null)
        const current = Number.isInteger(props.currentSpineIndex) ? props.currentSpineIndex : -1

        // 打开目录时把「当前章」滚到可见位置：一百多行目录，默认停在第一行，
        // 用户得自己找「我读到哪了」——这一步应该由我们代劳。
        useEffect(() => {
          const node = listRef.current
          if (!node || current < 0 || typeof node.querySelector !== 'function') return
          const row = node.querySelector('.dr-toc-row[aria-current="true"]')
          if (!row || typeof row.scrollIntoView !== 'function') return
          // 目录面板刚挂载时尺寸还是 0，立刻滚会被修正回去；下一帧更稳。
          const timer = setTimeout(() => {
            if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
          }, 30)
          return () => clearTimeout(timer)
        }, [current, items])

        if (props.error) {
          return h(
            'div',
            { className: 'dr-state dr-error' },
            h('div', { className: 'dr-state-title' }, '目录读不出来'),
            h('div', { className: 'dr-state-text' }, props.error),
          )
        }

        if (loading) return h(TocLoading)

        if (items.length === 0) {
          return h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-title' }, '这本书没有目录'),
            // 没有目录不等于读不下去：告诉用户还能怎么翻，比让他对着空白栏猜好。
            h('div', { className: 'dr-state-text' }, '可以用左右两侧翻页，或按 → 键往下读。'),
          )
        }

        const children = []

        if (props.source === 'auto') {
          children.push(h(
            'div',
            { className: 'dr-toc-note' },
            h('span', { className: 'dr-toc-badge' }, '自动识别'),
            h('span', { className: 'dr-toc-note-text' }, AUTO_NOTE),
          ))
        }

        const spineSet = new Set()
        items.forEach((item) => {
          const index = Number.isInteger(item.spineIndex) ? item.spineIndex : (Number.isInteger(item.index) ? item.index : -1)
          if (index >= 0) spineSet.add(index)
        })
        const chapterCount = spineSet.size > 0 ? spineSet.size : items.length

        items.forEach((item, i) => {
          const spineIndex = Number.isInteger(item.spineIndex)
            ? item.spineIndex
            : (Number.isInteger(item.index) ? item.index : -1)
          const depth = Number.isInteger(item.depth) ? Math.max(0, item.depth) : 0
          children.push(h(
            'button',
            {
              key: `${spineIndex}-${i}`,
              type: 'button',
              className: 'dr-toc-row',
              'aria-current': spineIndex === current ? 'true' : 'false',
              title: item.label,
              // 缩进用 padding 而不是嵌套 div：目录行是「一条条可点的按钮」，
              // 层级只影响缩进，不该额外套一层容器（套了之后键盘 Tab 会多走一步）。
              style: { paddingLeft: `${9 + depth * 12}px` },
              onClick: () => {
                if (typeof props.onJump === 'function') props.onJump(spineIndex, item.href)
              },
            },
            item.label,
          ))
        })

        return h(
          'div',
          { className: 'dr-side-body', role: 'navigation', 'aria-label': '目录', ref: listRef },
          // 顶部一行「共 N 章 · 当前第 M 章」：目录动辄几十上百行，当前读到哪
          // 光靠一条高亮不够，得有个数字当坐标。
          h(
            'div',
            { className: 'dr-toc-head' },
            `共 ${chapterCount} 章`,
            current >= 0 ? ` · 当前第 ${current + 1} 章` : '',
          ),
          children,
        )
      }

      return { flattenToc: flattenToc, TocPanel: TocPanel }
    })()

    // ─── client/src/ai.js ───
    var __mod_ai_js = (function () {
      /**
       * ai.js —— AI 调用状态与失败账本的界面。
       *
       * 用户的原话（m02260）：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍
       * 去重试，非常浪费。所以界面上必须能一眼看到三件事：
       *
       *   1. **现在能不能用**（可用 / 不可用 + 卡在哪一道）
       *   2. **上一次为什么失败**（错误码 + 一句人话）
       *   3. **最近这几次都发生了什么**（时间、用途、耗时、模型、结果）
       *
       * 三块都只读，改不了 AI——能改的只有「换网络 / 配模型 / 再点一次」，所以每块都直接
       * 写出下一步该做什么，而不是只报一个错。
       */

      /** 状态色：ok 绿、warn 黄、fail 红、unknown 灰。样式在 style.js 里。 */
      function statusSummary(status, extra = {}) {
        if (extra.probing === true) {
          return { tone: 'warn', text: '正在检测 AI 连接…', hint: '发一句极小的话，测的是网络和模型服务。' }
        }
        if (!status || typeof status !== 'object') {
          return { tone: 'unknown', text: 'AI 状态未知', hint: '点一下看诊断。' }
        }
        const checks = Array.isArray(status.checks) ? status.checks : []
        const broken = checks.find((item) => item && item.ok !== true)
        const recent = status.recent && typeof status.recent === 'object' ? status.recent : null
        const consecutive = recent && Number.isFinite(recent.consecutiveFailures) ? recent.consecutiveFailures : 0
        const last = recent && recent.last && typeof recent.last === 'object' ? recent.last : null

        if (broken) {
          return {
            tone: 'fail',
            text: `AI 用不了：${broken.title || broken.id || '配置不通'}`,
            hint: broken.fix || broken.detail || '点一下看诊断。',
          }
        }
        if (status.available === false) {
          return { tone: 'fail', text: 'AI 用不了', hint: '点一下看诊断。' }
        }
        if (consecutive > 0) {
          const message = last && typeof last.message === 'string' && last.message !== ''
            ? last.message
            : '最近一次调用失败'
          return {
            tone: 'warn',
            text: `AI 连续失败 ${consecutive} 次`,
            hint: message,
          }
        }
        const model = typeof status.model === 'string' && status.model !== '' ? status.model : ''
        return {
          tone: 'ok',
          text: model === '' ? 'AI 可用' : `AI 可用 · ${model}`,
          hint: '点一下看最近的调用记录。',
        }
      }

      /** 调用记录压成一行：时间 + 用途 + 耗时 + 结果。 */
      function describeRecord(item) {
        if (!item || typeof item !== 'object') return { ok: false, time: '', text: '', detail: '' }
        const time = typeof item.at === 'string' ? item.at.slice(11, 19) : ''
        const label = typeof item.label === 'string' && item.label !== '' ? item.label : item.kind || '调用'
        const ms = Number.isFinite(item.latencyMs) ? item.latencyMs : 0
        const ok = item.ok === true
        const text = ok
          ? `${label} · ${(ms / 1000).toFixed(1)} 秒 · 成功`
          : `${label} · 失败`
        const detail = ok
          ? (typeof item.model === 'string' && item.model !== '' ? item.model : '')
          : [item.code, item.message].filter((part) => typeof part === 'string' && part !== '').join(' · ')
        return { ok, time, text, detail }
      }

      /** 一行状态条。放在问 AI / 蒸馏面板的顶部，永远看得见。 */
      function AiStatusChip(props) {
        const summary = statusSummary(props.status, { probing: props.probing })
        const onClick = typeof props.onOpen === 'function' ? props.onOpen : undefined
        return h(
          'button',
          {
            type: 'button',
            className: `dr-ai-chip dr-ai-chip-${summary.tone}`,
            title: summary.hint,
            onClick,
            'aria-label': `${summary.text}。${summary.hint}`,
          },
          h('span', { className: 'dr-ai-dot' }),
          h('span', { className: 'dr-ai-chip-text' }, summary.text),
        )
      }

      /**
       * AI 面板：四道检查 + 最近调用账本。
       *
       * 这就是用户要的「集中在一个地方显示」：哪一道不通、上次为什么失败、
       * 最近几次都发生了什么，全在一屏里。
       */
      function AiPanel(props) {
        const status = props.status && typeof props.status === 'object' ? props.status : null
        const items = Array.isArray(props.items) ? props.items : []
        const checks = status && Array.isArray(status.checks) ? status.checks : []
        const recent = status && status.recent && typeof status.recent === 'object' ? status.recent : null
        const summary = statusSummary(status, { probing: props.probing })

        const head = h(
          'div',
          { className: 'dr-ai-head' },
          h('div', { className: 'dr-ai-headline' },
            h('span', { className: `dr-ai-dot dr-ai-dot-${summary.tone}` }),
            h('span', { className: 'dr-ai-title' }, summary.text)),
          h('div', { className: 'dr-ai-hint' }, summary.hint),
          h('div', { className: 'dr-ai-actions' },
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-small',
              disabled: props.probing === true,
              onClick: typeof props.onProbe === 'function' ? () => props.onProbe() : undefined,
            }, props.probing === true ? '检测中…' : '测一次连通'),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-small',
              onClick: typeof props.onRefresh === 'function' ? () => props.onRefresh() : undefined,
            }, '刷新'),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-small dr-btn-quiet',
              onClick: typeof props.onClear === 'function' ? () => props.onClear() : undefined,
            }, '清空记录')),
        )

        const checkList = checks.length === 0
          ? h('div', { className: 'dr-state-text' }, '还没拿到诊断结果，点「刷新」。')
          : h('ul', { className: 'dr-ai-checks' }, checks.map((item) => h(
            'li',
            { key: item.id || item.title, className: `dr-ai-check ${item.ok ? 'is-ok' : 'is-bad'}` },
            h('span', { className: 'dr-ai-check-mark' }, item.ok ? '✓' : '✗'),
            h('span', { className: 'dr-ai-check-title' }, item.title || item.id || ''),
            h('span', { className: 'dr-ai-check-detail' }, item.detail || ''),
            item.ok ? null : h('span', { className: 'dr-ai-check-fix' }, `→ ${item.fix || '看诊断'}`),
          )))

        const recentLine = recent
          ? h('div', { className: 'dr-ai-recent' },
            `最近 10 分钟：${recent.total} 次调用，失败 ${recent.failed} 次` +
            (recent.consecutiveFailures > 0 ? `，已连续失败 ${recent.consecutiveFailures} 次` : ''),
            Array.isArray(recent.codes) && recent.codes.length > 0
              ? h('span', { className: 'dr-ai-codes' },
                recent.codes.map((entry) => h('code', { key: entry.code, className: 'dr-ai-code' }, `${entry.code}×${entry.count}`)))
              : null)
          : null

        const empty = h('div', { className: 'dr-state-text' }, '还没有调用记录。用一次「问 AI」或「蒸馏」就会出现。')
        const list = items.length === 0
          ? empty
          : h('ul', { className: 'dr-ai-log' }, items.map((item, index) => {
            const row = describeRecord(item)
            return h('li', { key: item.id || `${index}`, className: `dr-ai-row ${row.ok ? 'is-ok' : 'is-bad'}` },
              h('span', { className: 'dr-ai-row-time' }, row.time),
              h('span', { className: 'dr-ai-row-text' }, row.text),
              row.detail === '' ? null : h('span', { className: 'dr-ai-row-detail' }, row.detail))
          }))

        return h(
          'div',
          { className: 'dr-ai-panel' },
          props.error ? h('div', { className: 'dr-state dr-error' },
            h('div', { className: 'dr-state-title' }, '诊断没读出来'),
            h('div', { className: 'dr-state-text' }, props.error)) : null,
          head,
          h('div', { className: 'dr-ai-section' },
            h('div', { className: 'dr-ai-section-title' }, '四道检查'),
            checkList),
          h('div', { className: 'dr-ai-section' },
            h('div', { className: 'dr-ai-section-title' }, '最近调用'),
            recentLine,
            props.loading === true ? h('div', { className: 'dr-state-text' }, '读取中…') : list),
          h('div', { className: 'dr-ai-foot' },
            status && status.log && typeof status.log.file === 'string'
              ? h('span', { className: 'dr-ai-path' }, `记录文件：${status.log.file}`)
              : null),
        )
      }

      /* ── 模型与思考强度（0.8.1）─────────────────────────────────────────
       *
       * 用户的要求：AI 能换模型，思考强度默认开、默认「高」，但也要能自己调。
       *
       * 界面上分两个下拉：
       *   · 模型——按 provider 分组，第一项是「跟随当前会话」（= 不给插件指定模型）；
       *   · 思考强度——只列这个模型真正声明的档位，第一项「跟随模型默认」。
       *
       * 为什么不把「强度」做成全局开关：每个模型支持的档位不一样，模型换了强度却留在
       * 一个它不认识的档上，用户会看到「设置对了但没用」。所以强度跟着模型一起选。
       */

      /** 把「provider/model」拼成下拉的 value。 */
      function modelValue(provider, model) {
        return `${provider ?? ''}/${model ?? ''}`
      }

      /** 从 `provider/model` 拆回来；不合法的返回空。 */
      function parseModelValue(value) {
        const text = String(value ?? '')
        const at = text.indexOf('/')
        if (at <= 0 || at === text.length - 1) return { provider: '', model: '' }
        return { provider: text.slice(0, at), model: text.slice(at + 1) }
      }

      /** 拍平成下拉用的扁平列表（保留分组标签）。 */
      function modelGroups(models) {
        const groups = Array.isArray(models?.groups) ? models.groups : []
        return groups
          .map((group) => ({
            id: typeof group.id === 'string' ? group.id : '',
            name: typeof group.name === 'string' && group.name !== '' ? group.name : (group.id || ''),
            models: (Array.isArray(group.models) ? group.models : []).map((model) => ({
              id: typeof model.id === 'string' ? model.id : '',
              name: typeof model.name === 'string' && model.name !== '' ? model.name : (model.id || ''),
              efforts: Array.isArray(model.efforts) ? model.efforts.map((effort) => effort.id).filter(Boolean) : [],
              defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : '',
            })),
          }))
          .filter((group) => group.id !== '' && group.models.length > 0)
      }

      /** 某个模型支持哪些强度档；没有声明就返回空数组（界面据此禁用下拉）。 */
      function effortsForModel(models, provider, model) {
        for (const group of modelGroups(models)) {
          if (group.id !== provider) continue
          const hit = group.models.find((entry) => entry.id === model)
          if (hit) return hit.efforts
        }
        return []
      }

      /** 「这次实际会用哪个模型、多深」的一句话。 */
      function describeEffective(models) {
        const effective = models?.effective ?? null
        if (!effective || typeof effective.provider !== 'string' || effective.provider === '') {
          return '跟随当前会话的模型'
        }
        const head = `${effective.provider}/${effective.model}`
        const effort = typeof effective.reasoningEffort === 'string' ? effective.reasoningEffort : ''
        const label = effort === '' ? '' : ` · 思考 ${effort}`
        const source = effective.source === 'user' ? '（你选的）' : (effective.source === 'session' ? '（跟随会话）' : '（宿主默认）')
        return `${head}${label}${source}`
      }

      /** 强度档的中文名。宿主给的 name 优先，没有就用我们自己的对照表。 */
      function effortName(efforts, id) {
        const list = Array.isArray(efforts) ? efforts : []
        const hit = list.find((entry) => entry && entry.id === id)
        if (hit && typeof hit.name === 'string' && hit.name !== '') return hit.name
        const table = { off: '关', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
        return table[id] ?? id
      }

      /**
       * 模型选择区。
       *
       * 三行：说明、两个下拉、一行「实际使用」。改动即时保存（父组件负责 put），
       * 所以这里没有「保存」按钮——多一个按钮就多一次「我改完忘了点」。
       */
      function AiModelPicker(props) {
        const models = props.models && typeof props.models === 'object' ? props.models : null
        const groups = modelGroups(models)
        const current = models?.current ?? {}
        const provider = typeof current.provider === 'string' ? current.provider : ''
        const model = typeof current.model === 'string' ? current.model : ''
        const effort = typeof current.reasoningEffort === 'string' ? current.reasoningEffort : ''
        const efforts = typeof models?.efforts === 'object' && Array.isArray(models.efforts) ? models.efforts : []
        const declared = effortsForModel(models, provider, model)
        const busy = props.saving === true

        const options = [h('option', { key: '__follow', value: '' }, '跟随当前会话（推荐）')]
        groups.forEach((group) => {
          options.push(h(
            'optgroup',
            { key: group.id, label: group.name },
            group.models.map((entry) => h(
              'option',
              { key: `${group.id}/${entry.id}`, value: modelValue(group.id, entry.id) },
              entry.name,
            )),
          ))
        })

        const effortOptions = [h('option', { key: '__default', value: '' }, '跟随模型默认')]
        // 只列这个模型声明过的档位。没选具体模型（跟随会话）时列全部常用档，
        // 因为会话那边可能支持更多——这里给的是「你想让插件要求多深」的意图。
        const candidates = declared.length > 0 ? declared : ['off', 'low', 'medium', 'high', 'max']
        candidates.forEach((id) => {
          effortOptions.push(h(
            'option',
            { key: id, value: id },
            `${effortName(efforts, id)}${id === 'high' ? '（默认）' : ''}`,
          ))
        })

        const onChangeModel = (event) => {
          if (typeof props.onChange !== 'function') return
          const next = parseModelValue(event && event.target ? event.target.value : '')
          props.onChange({ provider: next.provider, model: next.model, reasoningEffort: effort })
        }
        const onChangeEffort = (event) => {
          if (typeof props.onChange !== 'function') return
          props.onChange({ provider, model, reasoningEffort: String(event && event.target ? event.target.value : '') })
        }

        const unavailable = models !== null && models.available === false
          ? h('div', { className: 'dr-ai-hint' }, '宿主没有提供模型名单，当前只能跟随会话。升级 DSH 或换个安装方式后再试。')
          : null
        const note = models?.effective?.note
          ? h('div', { className: 'dr-ai-hint' }, models.effective.note)
          : null

        return h(
          'div',
          { className: 'dr-ai-models' },
          h('div', { className: 'dr-ai-section-title' }, '用哪个模型'),
          h('div', { className: 'dr-ai-hint' }, '问 AI 和蒸馏都用这里选的模型。默认「跟随当前会话」，你不用管。'),
          unavailable,
          h('label', { className: 'dr-ai-field' },
            h('span', { className: 'dr-ai-field-label' }, '模型'),
            h('select', {
              className: 'dr-select',
              disabled: busy || groups.length === 0,
              value: provider !== '' && model !== '' ? modelValue(provider, model) : '',
              onChange: onChangeModel,
            }, options)),
          h('label', { className: 'dr-ai-field' },
            h('span', { className: 'dr-ai-field-label' }, '思考强度'),
            h('select', {
              className: 'dr-select',
              disabled: busy,
              value: effort,
              onChange: onChangeEffort,
            }, effortOptions)),
          h('div', { className: 'dr-ai-effective' }, `实际使用：${describeEffective(models)}`),
          note,
        )
      }

      return { statusSummary: statusSummary, describeRecord: describeRecord, AiStatusChip: AiStatusChip, AiPanel: AiPanel, modelValue: modelValue, parseModelValue: parseModelValue, modelGroups: modelGroups, effortsForModel: effortsForModel, describeEffective: describeEffective, effortName: effortName, AiModelPicker: AiModelPicker }
    })()

    // ─── client/src/distill.js ───
    var __mod_distill_js = (function () {
      /**
       * distill.js —— 「读书蒸馏」面板。
       *
       * 它做的事（和它故意不做的事）写在这里，免得以后越做越像一套黑箱：
       *
       *   · **做**：一章一章地把书蒸成「这一章讲什么 + 关键概念 + 能照着做的方法 +
       *     可回源的句子」，再合成一张全书骨架，最后一键导出 Markdown。
       *   · **不做**：不搬蒸馏主管那套多阶段门禁流水线（那是工作区级的工程，要跑 Python
       *     门禁脚本）。阅读器里要的是「读完一本书真的能带走点什么」，不是再造一条产线。
       *   · **硬规矩**：引文必须能在原文里找到（宿主侧逐条核对，找不到就标出来）；
       *     方法必须能执行（做什么 / 什么时候用 / 怎么算做完），凑不齐就不算方法。
       *
       * 进度是可见的：一章一次调用，失败只丢一章，不会把整本书的成果一起废掉。
       */

      /** 一章蒸完 / 失败 / 没蒸，三种状态的文案。 */
      function chapterStatusText(record) {
        if (!record || typeof record !== 'object') return { text: '没蒸', tone: 'idle' }
        if (record.status === 'done') {
          const methods = Array.isArray(record.methods) ? record.methods.length : 0
          return { text: methods > 0 ? `已蒸 · ${methods} 个方法` : '已蒸', tone: 'ok' }
        }
        if (record.status === 'failed') return { text: '失败', tone: 'bad' }
        return { text: '没蒸', tone: 'idle' }
      }

      /** 「已蒸 3 / 34 章 · 8 个方法」，一句话说清干了多少活。 */
      function distillSummary(data) {
        const chapters = data && Array.isArray(data.chapters) ? data.chapters : []
        const state = data && data.state && typeof data.state === 'object' ? data.state : null
        const records = state && Array.isArray(state.chapters) ? state.chapters : []
        const done = records.filter((item) => item && item.status === 'done')
        const methods = done.reduce(
          (sum, item) => sum + (Array.isArray(item.methods) ? item.methods.length : 0),
          0,
        )
        return {
          total: chapters.length,
          done: done.length,
          failed: records.filter((item) => item && item.status === 'failed').length,
          methods,
        }
      }

      /** 导出用的文件名：书名里不能带路径分隔符，稳妥起见也去掉引号。 */
      function exportFilename(title) {
        const base = String(title || '').replace(/[\\/:*?"<>|]/g, ' ').trim()
        const safe = base === '' ? '这本书' : base.slice(0, 60)
        return `${safe}-蒸馏笔记.md`
      }

      /** 触发浏览器下载。没有 document 时静默返回（测试环境）。 */
      function downloadMarkdown(filename, text) {
        const doc = typeof document !== 'undefined' ? document : null
        if (!doc || typeof Blob === 'undefined') return false
        const blob = new Blob([String(text ?? '')], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = doc.createElement('a')
        link.href = url
        link.download = filename
        link.style.display = 'none'
        doc.body.appendChild(link)
        link.click()
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url)
            link.remove()
          } catch (error) {
            // 清理失败无所谓
          }
        }, 0)
        return true
      }

      function MethodCard(method, key) {
        return h(
          'div',
          { className: 'dr-dist-method', key },
          h('div', { className: 'dr-dist-method-name' }, method.name),
          h('div', { className: 'dr-dist-method-when' }, `什么时候用：${method.when}`),
          h('ol', { className: 'dr-dist-steps' }, (method.steps || []).map((step, i) => h('li', { key: i }, step))),
          h('div', { className: 'dr-dist-method-check' }, `怎么算做完：${method.check}`),
        )
      }

      function ChapterDetail(record) {
        return h(
          'div',
          { className: 'dr-dist-detail' },
          record.thesis ? h('div', { className: 'dr-dist-thesis' }, record.thesis) : null,
          Array.isArray(record.points) && record.points.length > 0
            ? h('ul', { className: 'dr-dist-points' }, record.points.map((point, i) => h(
              'li',
              { key: i, className: point.verified === false ? 'is-unverified' : '' },
              h('span', { className: 'dr-dist-point-claim' }, point.claim),
              point.quote ? h('q', { className: 'dr-dist-quote' }, point.quote) : null,
              point.verified === false ? h('span', { className: 'dr-dist-warn' }, '（原文里没找到这句）') : null,
            )))
            : null,
          Array.isArray(record.terms) && record.terms.length > 0
            ? h('dl', { className: 'dr-dist-terms' }, record.terms.map((term, i) => h(
              'div',
              { key: i, className: 'dr-dist-term' },
              h('dt', null, term.term),
              h('dd', null, term.meaning),
            )))
            : null,
          Array.isArray(record.methods) && record.methods.length > 0
            ? h('div', { className: 'dr-dist-methods' }, record.methods.map((method, i) => MethodCard(method, i)))
            : null,
        )
      }

      /**
       * 面板本体。
       *
       * @param {object} props
       * @param {object|null} props.data      distill.get 的返回
       * @param {boolean} props.loading
       * @param {string}  props.error
       * @param {string}  props.busyHref      正在蒸的那一章（按钮显示进度、全部禁用）
       * @param {object}  props.aiStatus      AI 状态（决定开蒸前要不要先劝一句）
       * @param {Function} props.onChapter    (href) => void
       * @param {Function} props.onSkeleton   () => void
       * @param {Function} props.onExport     () => void
       * @param {Function} props.onClear      () => void
       * @param {Function} props.onJump       (href) => void 跳到这一章
       * @param {Function} props.onOpenAi     () => void 打开 AI 状态面板
       */
      function DistillPanel(props) {
        const data = props.data && typeof props.data === 'object' ? props.data : null
        const chapters = data && Array.isArray(data.chapters) ? data.chapters : []
        const state = data && data.state && typeof data.state === 'object' ? data.state : null
        const records = state && Array.isArray(state.chapters) ? state.chapters : []
        const byHref = new Map(records.map((item) => [item && item.href, item]))
        const summary = distillSummary(data)
        const busyHref = typeof props.busyHref === 'string' ? props.busyHref : ''
        const skeleton = state && state.skeleton && typeof state.skeleton === 'object' ? state.skeleton : null
        const aiBroken = props.aiStatus && props.aiStatus.available === false

        if (props.error) {
          return h(
            'div',
            { className: 'dr-state dr-error' },
            h('div', { className: 'dr-state-title' }, '蒸馏面板打不开'),
            h('div', { className: 'dr-state-text' }, props.error),
          )
        }

        if (props.loading === true && data === null) {
          return h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-spinner', role: 'status', 'aria-label': '正在读取蒸馏稿' }),
            h('div', { className: 'dr-state-text' }, '正在读取…'),
          )
        }

        if (chapters.length === 0) {
          return h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-title' }, '这本书还没有章节'),
            h('div', { className: 'dr-state-text' }, '没有章节就没法一章一章地蒸。'),
          )
        }

        const head = h(
          'div',
          { className: 'dr-dist-head' },
          h('div', { className: 'dr-dist-progress' },
            `已蒸 ${summary.done} / ${summary.total} 章`,
            summary.methods > 0 ? h('span', { className: 'dr-dist-sub' }, ` · ${summary.methods} 个可执行方法`) : null,
            summary.failed > 0 ? h('span', { className: 'dr-dist-sub dr-dist-failed' }, ` · ${summary.failed} 章失败`) : null),
          aiBroken
            ? h('div', { className: 'dr-dist-note dr-dist-note-bad' },
              'AI 现在通不了，蒸不了。先去看看是什么问题：',
              h('button', {
                type: 'button',
                className: 'dr-btn dr-btn-sm',
                onClick: typeof props.onOpenAi === 'function' ? () => props.onOpenAi() : undefined,
              }, 'AI 状态'))
            : null,
          h('div', { className: 'dr-dist-actions' },
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-sm',
              disabled: summary.done === 0 || busyHref !== '',
              title: summary.done === 0 ? '先蒸几章，才有骨架可谈' : '把已蒸的章合成一张全书骨架',
              onClick: typeof props.onSkeleton === 'function' ? () => props.onSkeleton() : undefined,
            }, skeleton ? '重做全书骨架' : '生成全书骨架'),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-sm',
              disabled: summary.done === 0,
              title: '导出一份 Markdown，能直接存进笔记软件',
              onClick: typeof props.onExport === 'function' ? () => props.onExport() : undefined,
            }, '导出 Markdown'),
            h('button', {
              type: 'button',
              className: 'dr-btn dr-btn-sm dr-btn-quiet',
              disabled: records.length === 0,
              onClick: typeof props.onClear === 'function' ? () => props.onClear() : undefined,
            }, '清空')),
        )

        const skeletonNode = skeleton
          ? h('div', { className: 'dr-dist-skeleton' },
            h('div', { className: 'dr-dist-skeleton-title' }, '全书骨架'),
            skeleton.oneLine ? h('div', { className: 'dr-dist-skeleton-line' }, skeleton.oneLine) : null,
            skeleton.thesis ? h('div', { className: 'dr-dist-skeleton-row' }, h('span', null, '主论点'), h('p', null, skeleton.thesis)) : null,
            skeleton.structure ? h('div', { className: 'dr-dist-skeleton-row' }, h('span', null, '结构'), h('p', null, skeleton.structure)) : null,
            skeleton.audience ? h('div', { className: 'dr-dist-skeleton-row' }, h('span', null, '适合谁'), h('p', null, skeleton.audience)) : null,
          )
          : null

        const rows = chapters.map((chapter) => {
          const record = byHref.get(chapter.href) || null
          const status = chapterStatusText(record)
          const busy = busyHref === chapter.href
          return h(
            'div',
            { key: chapter.href, className: `dr-dist-row dr-dist-row-${status.tone}` },
            h('div',
              { className: 'dr-dist-row-head' },
              h('span', { className: 'dr-dist-row-label', title: chapter.label }, chapter.label),
              h('span', { className: 'dr-dist-badge' }, status.text),
              h('div', { className: 'dr-grow' }),
              record && record.status === 'done'
                ? h('button', {
                  type: 'button',
                  className: 'dr-btn dr-btn-sm dr-btn-quiet',
                  onClick: typeof props.onJump === 'function' ? () => props.onJump(chapter.href) : undefined,
                  title: '跳到这一章读原文',
                }, '读原文')
                : null,
              h('button', {
                type: 'button',
                className: 'dr-btn dr-btn-sm',
                disabled: busy || busyHref !== '' || aiBroken,
                title: aiBroken ? 'AI 通不了，先修 AI' : '蒸这一章（一次调用，几十秒）',
                onClick: typeof props.onChapter === 'function' ? () => props.onChapter(chapter.href) : undefined,
              }, busy ? '蒸馏中…' : (record && record.status === 'done' ? '重蒸' : '蒸这一章'))),
            record && record.status === 'failed' && record.error
              ? h('div', { className: 'dr-dist-row-error' }, record.error)
              : null,
            record && record.status === 'done' ? ChapterDetail(record) : null,
          )
        })

        return h(
          'div',
          { className: 'dr-dist-panel' },
          head,
          skeletonNode,
          h('div', { className: 'dr-dist-list' }, rows),
          h('div', { className: 'dr-dist-foot' },
            '蒸一章是一次独立的 AI 调用：失败只丢这一章，进度都留着。引文会自动核对原文，找不到的会标出来。'),
        )
      }

      return { chapterStatusText: chapterStatusText, distillSummary: distillSummary, exportFilename: exportFilename, downloadMarkdown: downloadMarkdown, DistillPanel: DistillPanel }
    })()

    // ─── client/src/reader.js ───
    var __mod_reader_js = (function () {
      /**
       * reader.js —— 阅读器：iframe 装章节，CSS 多栏分页，翻页靠 translateX。
       *
       * 为什么用 iframe：EPUB 的章节是独立 XHTML 文档，有自己的 `<head>`、自己的 CSS、
       * 自己的字体栈。把它塞进页面的某个 div 里，书里的 `body { ... }` 会把插件本身的
       * 布局一起改掉（这是所有「在页面里渲染电子书」的项目都会踩的第一个坑）。
       *
       * **这个 iframe 装的是书，不是插件页面。** 插件自己的界面（书架、目录、侧栏、
       * 按钮）全是正常的 React 组件，渲染在 slot 里；iframe 只是「纸面」。
       *
       * 分页方案（docs/05 §5.4，已定，不改）：
       *   1. 往 contentDocument 注入**唯一一个** `<style data-dsh-reading-injected>`，
       *      给 body 设 `column-width: 容器宽; column-gap: 间距; height: 100%`；
       *   2. 总页数 = `(内容总宽 + gap) / (列宽 + gap)`；
       *   3. 翻页 = `body.style.transform = translateX(-page * (列宽 + gap))`。
       *
       * 铁律 4（绝不改动正文 DOM）：本文件对 contentDocument 的**唯一**写操作是
       * 插入那一个 `<style>`。不包裹元素、不改 innerHTML、不 append 任何渲染节点。
       * 高亮全部由 annotate.js 在父窗口画覆盖层。
       *
       * 沙箱：`sandbox="allow-same-origin"`，**不带 allow-scripts**。
       *   - 不带 allow-same-origin 就拿不到 contentDocument，CFI 算不出来；
       *   - 带 allow-scripts 就等于允许书里的脚本执行（EPUB 是外来文件，必须当不可信输入）。
       * 两者一起带则沙箱形同虚设，所以这是一个「只开一半」的刻意选择。
       */

            const assetUrl = __mod_api_js.assetUrl
            const chapterUrl = __mod_api_js.chapterUrl
            const humanizeError = __mod_api_js.humanizeError
            const CFI = __mod_cfi_js
            const statusSummary = __mod_ai_js.statusSummary

      /**
       * 注入节点的标记。**从 cfi.js 取，不要另写字面量**：
       * filter 认定的是那个字符串，两处各写一份，改了一处就等于锚点集体错位。
       */
      const INJECTED_ATTR = CFI.INJECTED_ATTR

      /** 栏间距（px）。太窄会把两栏读成一段，太宽翻页时又显得空。 */
      const COLUMN_GAP = 48

      /** 视口左右留白（px）。留白放在父容器上，不放进 body —— 否则列宽会算错。 */
      // 正文上下留白：固定 40px，够放页眉页脚，又不至于把版面切碎。
      const SIDE_PADDING = 40
      // 正文左右留白：按视口宽度自适应（44–72px）。
      // 用户的原话是「把正文的位置给挤得窄一点」——两侧 26px 的翻页窄边是固定宽的，
      // 窗口越宽，正文越容易被推得贴边。给一个按百分比走的留白，宽屏自动让出更多，
      // 窄屏也不会把一行挤成三五个字。
      const SIDE_PADDING_X = 'clamp(44px, 4.2%, 72px)'

      /**
       * 书内链接前缀。服务端解析 EPUB 时把每一章里的 `<a href>` 全部改写成
       * `#dsh-reading:<encodeURIComponent(原地址)>`（docs/施工图 0.4.0 §1.2）：
       *   - 包成 `#` 开头，是为了让 iframe 永远不会去导航（hash 变了也不白屏）；
       *   - 原文完整编进字符串里，客户端才有机会自己决定「跳章 / 开外链 / 复制邮箱」。
       * 与 server 端改写函数里的前缀必须一字不差。
       */
      const LINK_PREFIX = '#dsh-reading:'

      /** 两次指针落点相差多少 px 以内才算「点了一下」（超过就是拖选 / 滑动）。 */
      const CLICK_SLOP = 6

      /** 锚点第一次量不到时的安静重试延迟（图片 / 字体撑开版面之后才量得准）。 */
      const ANCHOR_RETRY_MS = 400

      /**
       * 阅读配色。
       *
       * 一张纸一个配色：纸色、墨色、分隔线。iframe 内外用的是同一份调色板 ——
       * 外层用 CSS 变量，内层用字面量（跨文档读不到父窗口的变量），所以必须同源。
       */
      const THEMES = [
        { key: 'light', label: '白纸', paper: '#fcfbf8', ink: '#22262b', rule: '#e6e2d8' },
        { key: 'sepia', label: '羊皮纸', paper: '#f4ecd8', ink: '#4a3f35', rule: '#ded0b2' },
        { key: 'green', label: '护眼绿', paper: '#e6efe0', ink: '#2c382c', rule: '#cfdcc6' },
        { key: 'dark', label: '夜间', paper: '#1b1d21', ink: '#c9cdd3', rule: '#2f333a' },
      ]

      /** 取配色；认不出来的 theme 一律回退白纸（用户改坏了也不该变成透明背景）。 */
      function themeOf(key) {
        const found = THEMES.find((item) => item.key === key)
        return found || THEMES[0]
      }

      /**
       * 字体选择。值是完整的 font-family 栈，不是单个字体名 ——
       * 中文阅读器只写 `Songti SC` 的话，Windows/Linux 会掉成默认黑体。
       */
      const FONT_CHOICES = [
        { key: '', label: '跟随系统', stack: '' },
        { key: 'serif', label: '宋体 / 衬线', stack: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", serif' },
        { key: 'sans', label: '黑体 / 无衬线', stack: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
        { key: 'kai', label: '楷体', stack: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
      ]

      /** 把设置里的 fontFamily 解析成能直接写进 CSS 的栈。 */
      function fontStackOf(key) {
        const found = FONT_CHOICES.find((item) => item.key === key)
        if (found) return found.stack
        // 不是预设值就当成用户自己写的字体名，原样用（宿主已限制长度 ≤200）
        return typeof key === 'string' ? key : ''
      }

      /**
       * 构造注入给书籍文档的 CSS。
       *
       * 只做「怎么排版」，不做「长什么样」：颜色、字体沿用书自己的样式，
       * 读者打开一本书，期待看到的是这本书的设计，不是我们的。
       *
       * 唯独重排书（MOBI / TXT 转来的）例外：它们没有自己的 CSS，段落全是裸 `<p>`，
       * 不补「首行缩进 + 两端对齐」就会排成一片左对齐的碎行，像记事本而不像书。
       *
       * @param {{width:number, gap:number, settings?:object, reflowed?:boolean}} opts
       * @returns {string}
       */
      function frameCss(opts) {
        const width = Math.max(120, Math.floor(opts.width))
        const gap = Math.max(0, Math.floor(opts.gap))
        const settings = opts.settings ?? {}
        const theme = themeOf(settings.theme)
        const reflowed = opts.reflowed === true
        const fontSize = Number.isFinite(settings.fontSize) && settings.fontSize > 0
          ? `font-size: ${settings.fontSize}px !important;`
          : ''
        const lineHeight = Number.isFinite(settings.lineHeight) && settings.lineHeight > 0
          ? `line-height: ${settings.lineHeight} !important;`
          : ''
        const stack = fontStackOf(settings.fontFamily)
        const fontFamily = stack !== '' ? `font-family: ${stack} !important;` : ''

        // 几何量一律 !important：分页的前提是「这一列正好等于视口宽」。
        // 书自带的样式表常写 body { width: 600px } / margin: 0 auto / padding: 2em，
        // 我们这条样式排在它前面时会被它盖掉 —— 结果就是正文只占屏幕左边一小块，
        // 字号一大会变成「三个字一行」。版式可以听书的，几何不能。
        return `
      html {
        height: 100% !important;
        width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        /* 视口之外的内容一律裁掉：多栏溢出是「其他页」，不是滚动条 */
        overflow: hidden !important;
        background: ${theme.paper};
      }
      html body {
        box-sizing: content-box !important;
        width: ${width}px !important;
        min-width: ${width}px !important;
        max-width: none !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        column-width: ${width}px !important;
        column-count: auto !important;
        column-gap: ${gap}px !important;
        column-fill: auto !important;
        transform: translateX(0px);
        transform-origin: 0 0;
        /* 多栏溢出的是「其他页」，必须在 body 里可见，由 html 统一裁到视口 */
        overflow: visible !important;
        overflow-wrap: break-word;
        background: ${theme.paper};
        color: ${theme.ink};
        ${fontSize}
        ${lineHeight}
        ${fontFamily}
      }
      /* 书里常见的「居中单栏」写法会把正文挤到中间或左边，这里一并抹平 */
      html body > div, html body > section, html body > main, html body > article {
        max-width: none !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
      }
      ${reflowed ? `/* 重排书没有自己的样式表：这里替它补齐「像一本书」的最小排版 */
      p {
        margin: 0.55em 0;
        text-indent: 2em;
        text-align: justify;
        text-justify: inter-ideograph;
      }
      h1, h2, h3 {
        text-indent: 0;
        text-align: center;
        line-height: 1.4;
        margin: 0.4em 0 1.1em;
        font-size: 1.24em;
      }
      blockquote { text-indent: 0; margin: 0.8em 1.6em; opacity: 0.9; }` : ''}
      img, svg, video {
        max-width: 100%;
        height: auto;
      }
      table { max-width: 100%; }
      pre { white-space: pre-wrap; overflow-wrap: break-word; }
      ::selection { background: rgba(74, 125, 255, 0.28); }
      `
      }


      /**
       * 把分页必需的几何量以**内联 !important** 钉到 body 上。
       *
       * 为什么不只靠注入的样式表：书籍自带的 CSS 优先级不可控（有的直接写
       * `body{width:480px;margin:0 auto}`，个别还有 !important）。分页模型要求
       * 「一列 = 一个视口」，这条被破坏，正文就会缩成左边一窄条、字号一大众字挤一行。
       * 内联 !important 是 CSS 里唯一稳妥的压制手段，且不会影响字体、颜色等版式。
       */
      function applyGeometry(doc, width, gap, height) {
        const body = doc && doc.body
        if (!body || !body.style) return
        const set = (prop, value) => {
          try {
            body.style.setProperty(prop, value, 'important')
          } catch (error) {
            /* 老引擎不支持第三参时静默跳过：样式表那条还在兜底 */
          }
        }
        set('width', `${width}px`)
        set('min-width', `${width}px`)
        set('max-width', 'none')
        // 高度一定要钉成 px：`height:100%` 依赖 html 的高度，链上任何一环是 auto，
        // 多栏就会退化成「一列到底」，页数被量成 1，用户只能看到每章第一屏。
        set('height', Number.isFinite(height) && height > 0 ? `${Math.floor(height)}px` : '100%')
        set('box-sizing', 'content-box')
        set('margin', '0')
        set('padding', '0')
        set('border-width', '0')
        set('column-width', `${width}px`)
        set('column-count', 'auto')
        set('column-gap', `${gap}px`)
        set('column-fill', 'auto')
        // 千万别给 body 设 overflow:hidden：多栏的「第 2 页起」是画在 body 盒子外面的，
        // 一旦 body 自己裁剪，后面的页就整页空白（只剩页码在变）。裁剪交给 html 做。
        set('overflow', 'visible')
      }

      /** 原子地替换书籍文档里那个唯一的注入节点。node 从不新增第二个。 */
      function injectFrameStyle(doc, css) {
        let node = doc.querySelector(`style[${INJECTED_ATTR}]`)
        const head = doc.head || doc.documentElement
        if (!node) {
          // XHTML 文档（EPUB 章节）必须建在同名的 XHTML 命名空间里，
          // 否则 createElement 造出的是「无命名空间」元素，样式表可能整个不生效。
          const isXml = typeof doc.contentType === 'string' && doc.contentType.indexOf('xml') >= 0
          node = isXml ? doc.createElementNS('http://www.w3.org/1999/xhtml', 'style') : doc.createElement('style')
          node.setAttribute(INJECTED_ATTR, '')
          // 追加到 head **末尾**：同优先级时后写的赢。放最前面会被书自己的样式表盖掉，
          // 分页几何一旦被盖掉，正文就会缩成左边窄窄一条。
          head.appendChild(node)
        } else if (node.parentNode !== head || head.lastElementChild !== node) {
          // 章节文档可能在我们之后又插了 <link>/<style>，重新挪到末尾保持最高顺位
          head.appendChild(node)
        }
        if (node.textContent !== css) node.textContent = css
      }

      /** 视口左上角第一个字符的 Range（CFI 的「当前位置」就是它）。 */
      function caretRangeAtPoint(doc, x, y) {
        try {
          if (typeof doc.caretRangeFromPoint === 'function') {
            const range = doc.caretRangeFromPoint(x, y)
            if (range) return range
          }
          if (typeof doc.caretPositionFromPoint === 'function') {
            const pos = doc.caretPositionFromPoint(x, y)
            if (pos && pos.offsetNode) {
              const range = doc.createRange()
              range.setStart(pos.offsetNode, pos.offset)
              range.collapse(true)
              return range
            }
          }
        } catch (error) {
          // 点落在没有文本的位置（图片、空白栏、页面外）会抛或返回 null，这不算错误
        }
        return null
      }

      /** 取一个 Range 的第一个片段左边界；空 Range 用 boundingRect 兜底。 */
      function rangeLeft(range) {
        const rects = range.getClientRects()
        if (rects && rects.length > 0) return rects[0].left
        const box = range.getBoundingClientRect()
        return box ? box.left : 0
      }

      /** 这本书是不是「重排书」（MOBI / AZW3 / TXT 转来的纯文字）。 */
      function isReflowed(meta) {
        const format = meta && typeof meta.format === 'string' ? meta.format : ''
        return format === 'txt-converted' || format === 'mobi-converted'
      }

      /** decodeURIComponent 的兜底版：书里的链接是外来数据，坏一个 `%` 不该整章报错。 */
      function safeDecode(value) {
        try {
          return decodeURIComponent(value)
        } catch (error) {
          return value
        }
      }

      /**
       * 把 EPUB 里的路径规范化成 spine 里的写法：去掉 `./`、吃掉 `..`、合并重复斜杠。
       * 例：`Text/../Images/a.jpg` → `Images/a.jpg`。
       */
      function normalizePath(path) {
        const parts = String(path).split('/')
        const out = []
        for (const part of parts) {
          if (part === '' || part === '.') continue
          if (part === '..') {
            if (out.length > 0) out.pop()
            continue
          }
          out.push(part)
        }
        return out.join('/')
      }

      /** 章节 href 所在的目录（`Text/ch1.xhtml` → `Text`）。 */
      function dirOf(href) {
        const clean = String(href).split('#')[0].split('?')[0]
        const at = clean.lastIndexOf('/')
        return at < 0 ? '' : clean.slice(0, at)
      }

      /** 去掉查询串（`ch1.xhtml?v=2` → `ch1.xhtml`）。 */
      function stripQuery(href) {
        const at = String(href).indexOf('?')
        return at < 0 ? String(href) : String(href).slice(0, at)
      }

      /** 在 spine 里找一章。先按「原样路径」「相对当前章目录」两种候选精确比，最后才按文件名兜底。 */
      function spineHrefOf(item) {
        if (typeof item === 'string') return item
        if (item && typeof item.href === 'string') return item.href
        return ''
      }

      function findSpineIndex(spine, path, currentHref) {
        const list = Array.isArray(spine) ? spine : []
        const plain = normalizePath(path)
        if (plain === '') return -1
        const near = normalizePath(`${dirOf(currentHref)}/${path}`)
        const candidates = new Set([plain, near])
        for (let i = 0; i < list.length; i += 1) {
          const href = stripQuery(spineHrefOf(list[i]))
          if (href === '') continue
          const clean = normalizePath(href)
          if (candidates.has(clean) || candidates.has(safeDecode(clean))) return i
        }
        // 兜底：只比文件名，且必须**唯一**命中 —— 否则宁可当成资源，也不要跳到错章
        const base = plain.split('/').pop().toLowerCase()
        if (base === '') return -1
        let only = -1
        let hits = 0
        for (let i = 0; i < list.length; i += 1) {
          const href = stripQuery(spineHrefOf(list[i]))
          if (href === '') continue
          if (href.split('/').pop().toLowerCase() === base) {
            hits += 1
            only = i
          }
        }
        return hits === 1 ? only : -1
      }

      /**
       * 把一条书内链接解析成「该跳到哪、还是该开浏览器」。
       *
       * **纯函数**：不碰 DOM、不发请求，只吃 spine 与当前章 href。reader 与测试共用它，
       * 「点链接没反应 / 白屏」这类问题可以直接对着判据表断言，不用模拟整个阅读器。
       *
       * 判定顺序照 docs/施工图 0.4.0 §2.4（顺序不可换）：
       *   前缀 → 协议（http/https / mailto / tel / javascript: 之类）→ 拆 hash
       *   → 空路径（同章锚点）→ 相对路径查 spine → 查不到再当站内资源。
       *
       * @param {Array} spine                     [{ href, idref }]
       * @param {string} currentHref              当前章的 spine href
       * @param {string} rawHref                  `<a>` 上的原始 href（可能带 #dsh-reading: 前缀）
       * @param {{ currentIndex?: number, assetBase?: string }} [opts]
       * @returns {{kind:'chapter', spineIndex:number, fragment:string}
       *          |{kind:'external', url:string}
       *          |{kind:'contact', scheme:string, value:string}
       *          |{kind:'asset', url:string}
       *          |{kind:'missing', path:string}
       *          |{kind:'ignore', reason:string}}
       */
      function resolveSpineTarget(spine, currentHref, rawHref, opts = {}) {
        // 当前章以 currentHref 为准（spine 里查得到就用查到的序号）；opts.currentIndex 只在
        // 调用方给不出 href 时兜底 —— 两个参数打架时，宁可相信章节地址。
        const derived = findSpineIndex(spine, currentHref, currentHref)
        const currentIndex = derived >= 0
          ? derived
          : (Number.isInteger(opts.currentIndex) ? opts.currentIndex : 0)
        const assetBase = typeof opts.assetBase === 'string' ? opts.assetBase : ''
        const raw = typeof rawHref === 'string' ? rawHref.trim() : ''
        if (raw === '') return { kind: 'ignore', reason: 'empty' }

        // ① 剥掉服务端加的前缀（只剥一次，与原地址 encodeURIComponent 对偶）
        const decoded = raw.startsWith(LINK_PREFIX) ? safeDecode(raw.slice(LINK_PREFIX.length)).trim() : raw
        if (decoded === '' || decoded === '#') {
          // 书里原本就是 `href="#"` 或空锚：原地定位，findAnchor 拿不到就停章首，无副作用
          return { kind: 'chapter', spineIndex: currentIndex, fragment: '' }
        }

        // ② 协议分流。控制字符先去掉：`java\nscript:` 这类写法在浏览器里也是 javascript:
        const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, '')
        // 协议相对地址（//host/path）在 EPUB 里少见但合法，按 https 交浏览器
        if (cleaned.startsWith('//')) return { kind: 'external', url: `https:${cleaned}` }
        const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)
        if (schemeMatch) {
          const scheme = schemeMatch[1].toLowerCase()
          if (scheme === 'http' || scheme === 'https') {
            try {
              return { kind: 'external', url: new URL(cleaned).href }
            } catch (error) {
              return { kind: 'missing', path: cleaned }
            }
          }
          if (scheme === 'mailto') {
            return { kind: 'contact', scheme: 'mailto', value: cleaned.slice(scheme.length + 1) }
          }
          if (scheme === 'tel') {
            return { kind: 'contact', scheme: 'tel', value: cleaned.slice(scheme.length + 1) }
          }
          // javascript: / data: / file: / about: 以及任何没见过的协议：一律不执行、不导航
          return { kind: 'ignore', reason: `scheme:${scheme}` }
        }

        // ③ 拆 hash：`ch3.xhtml#sec-3-2` → 路径 + 锚点
        const hashAt = cleaned.indexOf('#')
        const pathPart = (hashAt < 0 ? cleaned : cleaned.slice(0, hashAt)).trim()
        const fragmentRaw = hashAt < 0 ? '' : cleaned.slice(hashAt + 1)
        const fragment = safeDecode(fragmentRaw)

        // ④ 空路径 = 同一份文档内的锚点（`#fn-1`、回链）
        if (pathPart === '') {
          return { kind: 'chapter', spineIndex: currentIndex, fragment }
        }

        // ⑤ 相对路径 → 查 spine
        const index = findSpineIndex(spine, pathPart, currentHref)
        if (index >= 0) return { kind: 'chapter', spineIndex: index, fragment }

        // ⑥ 带锚点却查不到章节：不能当资源（.xhtml 当图片画不出来），按缺失处理
        if (fragment !== '') return { kind: 'missing', path: pathPart }

        // ⑦ 不是章节 → 资源（插图、附件的相对路径）；章节样子的地址则算缺失
        if (/\.x?html?$/i.test(pathPart)) return { kind: 'missing', path: pathPart }
        if (assetBase !== '') {
          const resolved = normalizePath(`${dirOf(currentHref)}/${pathPart}`)
          return { kind: 'asset', url: `${assetBase}${resolved}` }
        }
        return { kind: 'missing', path: pathPart }
      }

      /**
       * 在书籍文档里找锚点元素。
       *
       * 为什么要自己找而不是 `doc.querySelector('#' + frag)`：
       *   1. EPUB 里的 id 是外来数据，可能带空格、点号、中文，直接拼选择器会抛；
       *   2. 老书用 `<a name="fn-1">` 而不是 id；
       *   3. 少数书把 id 写在 `<body>` 下很深的位置，`getElementById` 之外还要兜一层。
       * 找不到就返回 null（调用方停在章首，不报错）。
       *
       * @param {Document} doc
       * @param {string} fragment  已解码的锚点名
       * @returns {Element|null}
       */
      function findAnchor(doc, fragment) {
        const frag = typeof fragment === 'string' ? fragment : ''
        if (!doc || frag === '') return null
        const tried = new Set([frag, safeDecode(frag), encodeURIComponent(frag), frag.trim()])
        for (const name of tried) {
          if (name === '') continue
          try {
            const found = typeof doc.getElementById === 'function' ? doc.getElementById(name) : null
            if (found) return found
          } catch (error) {
            // 个别文档实现会在畸形 id 上抛，继续走下面的元素表
          }
        }
        let nodes = null
        try {
          nodes = doc.querySelectorAll ? doc.querySelectorAll('[id], [name]') : null
        } catch (error) {
          nodes = null
        }
        if (!nodes) return null
        const limit = Math.min(nodes.length, 20000)
        for (let i = 0; i < limit; i += 1) {
          const el = nodes[i]
          if (!el || typeof el.getAttribute !== 'function') continue
          if (tried.has(el.getAttribute('id')) || tried.has(el.getAttribute('name'))) return el
        }
        return null
      }

      /** 外链兜底复制。宿主是 Electron 时 window.open 常被拦，复制是最后一条可用路径。 */
      function copyPlainText(text) {
        const value = typeof text === 'string' ? text : ''
        if (value === '') return false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(value).catch(() => {})
            return true
          }
        } catch (error) {
          // 没有剪贴板权限就算复制失败，调用方会给出「打不开」的提示
        }
        return false
      }

      /**
       * 阅读器。
       *
       * props:
       *   bookHash           —— 书的 hash
       *   meta               —— { title, author, spine:[{href,idref}] }
       *   initialCfi         —— 恢复位置（可空）
       *   initialPercent     —— CFI 失效时的降级位置（0–1）
       *   settings           —— { fontSize, lineHeight, fontFamily }（可空）
       *   onProgress({ cfi, cfiStart, chapterHref, percent })
       *   onSelection({ range, text, chapterHref, spineIndex })
       *   onPageText(text)
       *   onFrameReady(doc, win)   —— 必须抛给外层，annotate 靠它挂选中监听
       *   apiRef             —— { current: { jumpToCfi, jumpToSpine, nextPage, prevPage, getFrameDocument } }
       *   onClose()          —— 回到书架
       *   side               —— 右侧面板节点（目录 / 标注），由 app.js 决定
       *   sideWidth          —— 右侧面板宽度（px）
       *   sideKind           —— 'toc' | 'annotations' | 'qa' | null
       *   onToggleSide(kind) —— 点工具栏按钮
       *   onJumpSpine(index, { fragment }) —— 跨章跳转交给 app（可空；空时自己跳）
       *   onNotice(text)     —— 一行中文提示（外链被拦、邮箱已复制等）
       *   closeMenus({ source }) —— 点正文空白 / Esc 时让 app 收起所有浮层（§3.2）
       *   qaCount            —— 工具栏「问答」按钮上的条数徽标
       */
      function ReaderView(props) {
        const spine = props.meta && Array.isArray(props.meta.spine) ? props.meta.spine : []
        const spineCount = spine.length

        const [chapterIndex, setChapterIndex] = useState(() => {
          // 有 CFI 就先按 CFI 里的 spine 序号起；CFI 坏了再退回 0
          const cfi = typeof props.initialCfi === 'string' ? props.initialCfi : ''
          if (cfi !== '') {
            try {
              const index = CFI.spineIndexFromCfi(cfi)
              if (Number.isInteger(index) && index >= 0 && index < Math.max(1, spineCount)) return index
            } catch (error) {
              // CFI 前缀坏了不是致命问题：下面还有 percent 兜底
            }
          }
          return 0
        })
        const [page, setPage] = useState(0)
        const [pageCount, setPageCount] = useState(1)
        // 「点页码 → 输入第几页 → 跳过去」：没有目录的书（PDF / 输错的 TXT）唯一的定位手段
        const [jumpOpen, setJumpOpen] = useState(false)
        const [jumpText, setJumpText] = useState('')
        const [loading, setLoading] = useState(true)
        const [error, setError] = useState('')
        const [percent, setPercent] = useState(0)

        const frameRef = useRef(null)
        const viewportRef = useRef(null)
        const docRef = useRef(null)
        const winRef = useRef(null)
        const pageRef = useRef(0)
        const pageCountRef = useRef(1)
        const chapterRef = useRef(chapterIndex)
        // 每次 load 只恢复一次位置：加载完成 → 定位 → 把 pending 清掉
        const pendingRef = useRef({
          cfi: typeof props.initialCfi === 'string' ? props.initialCfi : null,
          percent: typeof props.initialPercent === 'number' ? props.initialPercent : 0,
          page: 0,
        })
        const apiRefInternal = useRef(null)
        const progressTimer = useRef(null)
        const turnTimer = useRef(null)
        // 上一次量到的可靠列宽：面板隐藏/未布局时用它兜底，避免退化成 120px 窄条
        const lastWidthRef = useRef(0)
        // 上次量到的高度与「页数可疑」的重试计数（见 paginate 的兜底）
        const lastHeightRef = useRef(0)
        const pageRetryRef = useRef(0)
        const pageRetryTimer = useRef(null)
        const anchorRetryRef = useRef(null)
        // 「跳到这里」的黄色闪框：只画在父窗口里，绝不写正文 DOM。
        const [flash, setFlash] = useState(null)
        const flashTimerRef = useRef(null)
        // 手势状态与翻页函数都放在 ref 里，给「滚轮/触控板」那个 effect 用：
        // 它只挂一次事件，永远调用最新的翻页实现。
        const gestureRef = useRef({ armed: true, blocked: false, lastWheelAt: 0, accumulated: 0 })
        const navRef = useRef(null)

        chapterRef.current = chapterIndex

        const currentHref = spineCount > 0 && spine[chapterIndex]
          ? (spine[chapterIndex].href || '')
          : ''

        /**
         * 把几何量算出来：列宽 = iframe 视口宽，间距固定。
         *
         * 这里量错一次就得整章重排，所以取多路测量的最大值：iframe 的 clientWidth、
         * 它的 border-box 宽、外层视口宽。面板刚挂载（隐藏、宽度未落定）时前两者可能是 0，
         * 外层视口往往已经有正确宽度；再兜一个「上一次量到的好值」，避免退化成 120px 的
         * 窄条 —— 那正是「三个字一行、字只占屏幕左半边」的样子。
         */
        const geometry = useCallback(() => {
          const frame = frameRef.current
          const viewport = viewportRef.current
          const candidates = []
          if (frame) {
            candidates.push(Number(frame.clientWidth) || 0)
            const box = typeof frame.getBoundingClientRect === 'function' ? frame.getBoundingClientRect() : null
            if (box) candidates.push(Number(box.width) || 0)
          }
          if (viewport) {
            candidates.push(Number(viewport.clientWidth) || 0)
            const vbox = typeof viewport.getBoundingClientRect === 'function' ? viewport.getBoundingClientRect() : null
            if (vbox) candidates.push(Number(vbox.width) || 0)
          }
          let width = Math.floor(Math.max(0, ...candidates))
          if (width < 200) {
            const last = Number(lastWidthRef.current) || 0
            if (last >= 200) width = last
          }
          if (width >= 200) lastWidthRef.current = width

          // 高度同理：分页用的是「一列能装多高」，量不到高度时多栏退化成单栏，
          // 读数会变成「这一章只有一页」—— 正文其实被排在首屏下面，永远翻不到。
          const heightCandidates = []
          if (frame) {
            heightCandidates.push(Number(frame.clientHeight) || 0)
            const box = typeof frame.getBoundingClientRect === 'function' ? frame.getBoundingClientRect() : null
            if (box) heightCandidates.push(Number(box.height) || 0)
          }
          if (viewport) {
            heightCandidates.push(Number(viewport.clientHeight) || 0)
            const vbox = typeof viewport.getBoundingClientRect === 'function' ? viewport.getBoundingClientRect() : null
            if (vbox) heightCandidates.push(Number(vbox.height) || 0)
          }
          let height = Math.floor(Math.max(0, ...heightCandidates))
          if (height < 200) {
            const last = Number(lastHeightRef.current) || 0
            if (last >= 200) height = last
          }
          if (height >= 200) lastHeightRef.current = height

          // 栏间距按视口宽度的比例算：48px 写死时，窄屏（约 600px）两栏之间空出一大条，
          // 宽屏（1600px）又挤在一起。6.8% 在两侧都留得下呼吸感，上下限防止极端值。
          const gap = Math.max(28, Math.min(72, Math.round(Math.max(120, width) * 0.068)))
          return { width: Math.max(120, width), height: Math.max(0, height), gap }
        }, [])

        /** 在父窗口里画一个 1.5 秒的黄色闪框（「跳到这里了」），坐标从书籍文档换算。 */
        const showFlashBox = useCallback((rect) => {
          const frame = frameRef.current
          const viewport = viewportRef.current
          if (!frame || !viewport || !rect) return
          const frameBox = frame.getBoundingClientRect()
          const viewportBox = viewport.getBoundingClientRect()
          setFlash({
            left: `${frameBox.left - viewportBox.left + rect.left}px`,
            top: `${frameBox.top - viewportBox.top + rect.top}px`,
            width: `${Math.max(12, Math.min(rect.width, frameBox.width))}px`,
            height: `${Math.max(16, rect.height)}px`,
          })
          if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
          flashTimerRef.current = setTimeout(() => {
            flashTimerRef.current = null
            setFlash(null)
          }, 1500)
        }, [])

        /** 闪一下某个锚点元素（页内链接、跨章锚点）。找不到就什么都不做。 */
        const flashAnchor = useCallback((fragment) => {
          const doc = docRef.current
          if (!doc || typeof fragment !== 'string' || fragment === '') return
          const el = findAnchor(doc, fragment)
          if (!el) return
          try {
            showFlashBox(el.getBoundingClientRect())
          } catch (error) {
            // 量不到位置不影响已经完成的跳转
          }
        }, [showFlashBox])

        /** 闪一下某个 CFI 对应的文字（问答记录「回到原文」用这条路径）。 */
        const flashCfi = useCallback((cfi) => {
          const doc = docRef.current
          const win = winRef.current
          if (!doc || !win || typeof cfi !== 'string' || cfi === '') return
          try {
            const range = CFI.toRange(win, doc, cfi)
            const rects = range.getClientRects()
            if (rects && rects.length > 0) {
              showFlashBox(rects[0])
              return
            }
            const box = range.getBoundingClientRect()
            if (box && (box.width > 0 || box.height > 0)) showFlashBox(box)
          } catch (error) {
            // 解析失败就不闪：跳转本身已经尽力了
          }
        }, [showFlashBox])

        /**
         * 应用某页的位移。这是「翻页」的唯一实现。
         *
         * 顺手把 `pageOffsetPx` 上报给外层：覆盖层要在**父窗口**里画，
         * 而正文被推走了多少只有这里知道。少报一次，划线就会整体错开一整页宽。
         */
        const applyPage = useCallback((nextPage) => {
          const doc = docRef.current
          const { width, gap } = geometry()
          const clamped = Math.max(0, Math.min(pageCountRef.current - 1, nextPage))
          pageRef.current = clamped
          setPage(clamped)
          const offset = clamped * (width + gap)
          if (doc && doc.body) {
            doc.body.style.transform = `translateX(${-offset}px)`
          }
          if (typeof props.onPageChange === 'function') {
            props.onPageChange({ pageOffsetPx: offset, frameEl: frameRef.current, page: clamped })
          }
          return clamped
        }, [geometry, props.onPageChange])

        /**
         * 重新分页：注入/更新样式 → 量总宽 → 算页数 → 回到合适的位置。
         * 失败行为：不抛。量不出来时保持 1 页，正文照样能读（只是翻不动）。
         */
        const paginate = useCallback((restore) => {
          const doc = docRef.current
          const win = winRef.current
          if (!doc || !win || !doc.body) return

          const { width, height, gap } = geometry()
          if (width < 40) return

          // 双保险：样式表归样式表，几何量再用内联 !important 钉一次。
          // 有的书把自己的 body 写成 width:480px; margin:0 auto（甚至有 !important），
          // 只靠注入的 <style> 会被它压住，正文就缩到中间一窄条 —— 那正是「只占左半边、
          // 三个字一行」的来源。内联 !important 的优先级高于任何样式表规则，钉得住。
          applyGeometry(doc, width, gap, height)
          injectFrameStyle(doc, frameCss({
            width,
            gap,
            settings: props.settings,
            reflowed: isReflowed(props.meta),
          }))
          // 先归零再量：位移会让 getBoundingClientRect 一并偏移，量出来的页数就不对了
          doc.body.style.transform = 'translateX(0px)'

          // 多栏溢出区不一定每个引擎都算进 scrollWidth，三种量法取最大，避免少数一页
          const bodyBox = doc.body.getBoundingClientRect()
          let totalWidth = Math.max(doc.body.scrollWidth || 0, doc.documentElement.scrollWidth || 0)
          const last = doc.body.lastElementChild
          if (last) {
            const lastRight = last.getBoundingClientRect().right - bodyBox.left
            if (Number.isFinite(lastRight)) totalWidth = Math.max(totalWidth, lastRight)
          }
          let total = Math.max(1, Math.round((totalWidth + gap) / (width + gap)))

          // 兜底：正文很长、却只量出一页 —— 只有一种解释，要么高度没量到（多栏退化成一列），
          // 要么量得太早（字体/样式还没生效）。这时**不能**把 1 页当真：用户会以为每章只剩
          // 第一屏。下一帧再量，最多试 8 次（约 130ms），试完还不行就按 1 页走，绝不卡死。
          const textLength = (doc.body.textContent || '').length
          if (total <= 1 && textLength > 1500 && height >= 200 && pageRetryRef.current < 8) {
            pageRetryRef.current += 1
            if (pageRetryTimer.current !== null) clearTimeout(pageRetryTimer.current)
            pageRetryTimer.current = setTimeout(() => {
              pageRetryTimer.current = null
              if (!docRef.current) return
              paginate(restore)
            }, 16)
            return { anchorFound: null, page: pageRef.current }
          }
          pageRetryRef.current = 0

          pageCountRef.current = total
          setPageCount(total)

          if (restore) {
            let target = 0
            let anchorFound = null

            // 恢复位置的优先级（docs/施工图 0.4.0 §2.5）：
            //   page > 0    —— 翻章边界（到上一章最后一页 / 到章首），必须最先认
            //   fragment    —— 书内链接的锚点，按分页几何换算页号（禁止 scrollIntoView）
            //   cfi         —— 进度 / 问答记录锚点
            //   percent     —— 最后兜底
            if (typeof restore.page === 'number' && restore.page > 0) {
              target = restore.page
            } else if (typeof restore.fragment === 'string' && restore.fragment !== '') {
              const anchor = findAnchor(doc, restore.fragment)
              anchorFound = anchor !== null
              if (anchor) {
                const rect = anchor.getBoundingClientRect()
                target = Math.floor((Math.max(0, rect.left) + 1) / (width + gap))
              } else {
                target = 0
                if (typeof console !== 'undefined' && typeof console.debug === 'function') {
                  console.debug('[dsh-reading] 本章找不到锚点，停在章首：', restore.fragment)
                }
              }
            } else if (restore.cfi) {
              try {
                const range = CFI.toRange(win, doc, restore.cfi)
                const left = rangeLeft(range)
                target = Math.floor((left + 1) / (width + gap))
              } catch (err) {
                // CFI 在这份文档里解析不出来（书换了版本 / 前缀漂移）→ 用百分比降级
                target = Math.round((restore.percent || 0) * (total - 1))
              }
            } else if (restore.percent > 0) {
              target = Math.round(restore.percent * (total - 1))
            }

            target = Math.max(0, Math.min(total - 1, target))
            applyPage(target)
            // 闪框放在 applyPage 之后：位移已经写进 body，量出来的矩形才是这一页的
            if (restore.flash === true) {
              if (restore.cfi) flashCfi(restore.cfi)
              else if (restore.fragment) flashAnchor(restore.fragment)
            }
            return { anchorFound, page: target }
          } else {
            applyPage(pageRef.current)
          }
        }, [applyPage, flashAnchor, flashCfi, geometry, props.settings])

        /** 当前页位置 → { cfi, cfiStart, chapterHref, percent }。 */
        const snapshot = useCallback(() => {
          const doc = docRef.current
          const win = winRef.current
          const index = chapterRef.current
          const href = spineCount > 0 && spine[index] ? (spine[index].href || '') : ''
          const count = Math.max(1, pageCountRef.current)
          const current = pageRef.current

          const chapterFraction = count <= 1 ? 0 : current / (count - 1)
          const bookFraction = spineCount <= 1
            ? chapterFraction
            : Math.max(0, Math.min(1, (index + chapterFraction) / spineCount))

          let cfi = ''
          let cfiStart = ''
          if (doc && win) {
            const range = caretRangeAtPoint(doc, 2, 2)
            if (range) {
              try {
                const idref = spine[index] && spine[index].idref ? spine[index].idref : undefined
                cfi = CFI.fromRange(win, range, { index, idref })
                // cfiStart 必须是 **collapse 形态**（单点路径、无逗号），不能拿 splitCfi().local：
                // 那是区间左半段，`/4/2[p1],/1:3` 单独拿去解析不是合法 CFI，
                // 而 schema 的 cfiPartial 要求 `^/[0-9]` 的单点路径（docs/05 §4.3）。
                cfiStart = CFI.collapseLocal(cfi, false)
              } catch (err) {
                // 取不到位置就不写 cfi：宁可只存百分比，也不要存一个错的 CFI
                cfi = ''
                cfiStart = ''
              }
            }
          }

          return { cfi, cfiStart, chapterHref: href, percent: bookFraction }
        }, [spine, spineCount])

        /** 上报进度（去抖：连按翻页只写一次）。 */
        const emitProgress = useCallback(() => {
          if (progressTimer.current !== null) {
            clearTimeout(progressTimer.current)
          }
          progressTimer.current = setTimeout(() => {
            progressTimer.current = null
            const payload = snapshot()
            setPercent(payload.percent)
            if (typeof props.onProgress === 'function') props.onProgress(payload)
          }, 220)
        }, [props.onProgress, snapshot])

        /** onLoad 的全部工作：注入样式、分页、恢复位置、把文档抛给外层。 */
        const handleLoad = useCallback(() => {
          const frame = frameRef.current
          if (!frame) return
          let doc = null
          let win = null
          try {
            doc = frame.contentDocument
            win = frame.contentWindow
          } catch (err) {
            setError('这本书的内容打不开。可能是文件损坏，换一本试试。')
            setLoading(false)
            return
          }
          if (!doc || !doc.body) {
            setError('这本书的正文是空的，可能文件不完整。')
            setLoading(false)
            return
          }

          docRef.current = doc
          winRef.current = win
          setLoading(false)
          setError('')

          if (typeof props.onFrameReady === 'function') {
            // 外层（annotate）靠这个挂 selectionchange；抛错不该让阅读器整个挂掉
            try {
              props.onFrameReady(doc, win)
            } catch (err) {
              console.warn('[dsh-reading] onFrameReady 回调出错：', err)
            }
          }

          const pending = pendingRef.current
          pendingRef.current = { cfi: null, percent: 0, page: 0 }
          const result = paginate(pending)

          // 有些书在 load 事件之后还要等图片 / 字体把版面撑开，锚点这一刻未必量得到。
          // 安静重试一次；期间用户若已经翻页或换章就放弃（不能把人从正在读的地方拽走）。
          if (pending.fragment && result && result.anchorFound === false) {
            const retryIndex = chapterRef.current
            if (anchorRetryRef.current !== null) clearTimeout(anchorRetryRef.current)
            anchorRetryRef.current = setTimeout(() => {
              anchorRetryRef.current = null
              if (chapterRef.current !== retryIndex || !docRef.current) return
              if (pageRef.current !== 0) return
              paginate({ fragment: pending.fragment, page: 0 })
            }, ANCHOR_RETRY_MS)
          }

          emitProgress()
        }, [emitProgress, paginate, props.onFrameReady])

        const goChapter = useCallback((nextIndex, restore) => {
          const count = spineCount
          if (count === 0) return
          const clamped = Math.max(0, Math.min(count - 1, nextIndex))
          setLoading(true)
          setError('')
          pendingRef.current = restore ?? { cfi: null, percent: 0, page: 0 }
          pageRef.current = 0
          setPage(0)
          if (clamped === chapterRef.current) {
            // 同一章：不重设 src（浏览器会忽略相同 src），直接重新定位
            if (docRef.current) {
              paginate(pendingRef.current)
              setLoading(false)
              pendingRef.current = { cfi: null, percent: 0, page: 0 }
            }
            return
          }
          setChapterIndex(clamped)
        }, [paginate, spineCount])

        /**
         * 翻页动效：给视口挂一个 200ms 的类，CSS 里让书页轻轻滑进来。
         *
         * 为什么不用真·翻页动画（卷曲、阴影）：那是 canvas/WebGL 级的模拟，代价大
         * 且在 iframe 上做会牵连选区与 CFI 定位。这里只做「位置感」——上一页往左
         * 滑出去一点、下一页从右边进来一点，肉眼能看出「翻过去了」，但不动 DOM。
         */
        const flashTurn = useCallback((direction) => {
          const root = viewportRef.current
          if (!root) return
          // 「翻页动画」关掉时直接返回：不挂类就没有位移与透明度过渡。
          // 默认跟随系统（prefers-reduced-motion）由 CSS 兜底，这里只管用户显式关闭。
          if (props.settings && props.settings.motion === 'off') return
          root.classList.remove('dr-turn-next', 'dr-turn-prev')
          // 强制一次重排：连续翻页时同名类不会重启动画
          void root.offsetWidth
          root.classList.add(direction > 0 ? 'dr-turn-next' : 'dr-turn-prev')
          if (turnTimer.current !== null) clearTimeout(turnTimer.current)
          turnTimer.current = setTimeout(() => {
            turnTimer.current = null
            root.classList.remove('dr-turn-next', 'dr-turn-prev')
          }, 220)
        }, [])

        const nextPage = useCallback(() => {
          const count = pageCountRef.current
          if (pageRef.current < count - 1) {
            flashTurn(1)
            applyPage(pageRef.current + 1)
            emitProgress()
            return
          }
          if (chapterRef.current < spineCount - 1) {
            goChapter(chapterRef.current + 1, { page: 0 })
          }
        }, [applyPage, emitProgress, flashTurn, goChapter, spineCount])

        const prevPage = useCallback(() => {
          if (pageRef.current > 0) {
            flashTurn(-1)
            applyPage(pageRef.current - 1)
            emitProgress()
            return
          }
          if (chapterRef.current > 0) {
            // 回上一章的最后一页：先记「到章尾」，加载完成后再定位
            goChapter(chapterRef.current - 1, { page: Number.MAX_SAFE_INTEGER })
          }
        }, [applyPage, emitProgress, flashTurn, goChapter])

        /** 直接跳到本章第 n 页（1 起算，用户输入用）。 */
        const gotoPage = useCallback((n) => {
          const count = Math.max(1, pageCountRef.current)
          const target = Math.round(Number(n))
          if (!Number.isFinite(target)) return false
          const clamped = Math.max(0, Math.min(count - 1, target - 1))
          if (clamped !== pageRef.current) flashTurn(clamped > pageRef.current ? 1 : -1)
          applyPage(clamped)
          emitProgress()
          return true
        }, [applyPage, emitProgress, flashTurn])

        /** 每次渲染后刷新 navRef：滚轮 effect 只挂一次，但必须调到最新的翻页实现。 */
        useEffect(() => {
          navRef.current = { next: nextPage, prev: prevPage }
        }, [nextPage, prevPage])

        /**
         * 跳到某个 CFI。
         *
         * 第二个参数 `chapterHref` 是「CFI 里没写章节时」的兜底（问答记录只存了锚点 CFI +
         * 章节 href，旧记录还可能只有 href）。CFI 自带 spine 序号时优先用它。
         * 跳完闪一下目标文字，让用户知道「就是这儿」。
         */
        const jumpToCfi = useCallback((cfi, chapterHref) => {
          if (typeof cfi !== 'string' || cfi === '') return false
          let index = chapterRef.current
          let parsed = null
          try {
            parsed = CFI.spineIndexFromCfi(cfi)
          } catch (error) {
            parsed = null
          }
          if (Number.isInteger(parsed) && parsed >= 0 && parsed < spineCount) {
            index = parsed
          } else if (typeof chapterHref === 'string' && chapterHref !== '') {
            const found = spine.findIndex((item) => item && item.href === chapterHref)
            if (found >= 0) index = found
          }
          const restore = { cfi, percent: 0, page: 0, flash: true }
          if (index === chapterRef.current) {
            if (docRef.current) {
              paginate(restore)
              emitProgress()
            }
            return true
          }
          goChapter(index, restore)
          return true
        }, [emitProgress, goChapter, paginate, spine, spineCount])

        /**
         * 跳到第 index 章。第二个参数可以是 `{ fragment }`：
         *   - 书内链接的跨章锚点走这条（`jumpToSpine(3, { fragment: 'sec-3-2' })`）；
         *   - 空对象 / 不传 = 到章首。
         * 同章也接受：直接重新定位，不重设 src。
         */
        const jumpToSpine = useCallback((index, target) => {
          if (!Number.isInteger(index) || index < 0 || index >= spineCount) return false
          const opts = target && typeof target === 'object' ? target : {}
          const fragment = typeof opts.fragment === 'string' ? opts.fragment : ''
          const restore = { page: 0, fragment, flash: opts.flash !== false }
          if (index === chapterRef.current) {
            if (docRef.current) paginate(restore)
            return true
          }
          goChapter(index, restore)
          return true
        }, [goChapter, paginate, spineCount])

        /** 一句中文提示。app 有 toast 就走 toast；没有就退到 console，绝不弹 alert。 */
        const notice = useCallback((text) => {
          if (typeof text !== 'string' || text === '') return
          if (typeof props.onNotice === 'function') {
            try {
              props.onNotice(text)
            } catch (error) {
              console.warn('[dsh-reading] onNotice 回调出错：', error)
            }
            return
          }
          if (typeof console !== 'undefined' && typeof console.debug === 'function') {
            console.debug('[dsh-reading]', text)
          }
        }, [props.onNotice])

        /**
         * 点正文空白 / Esc 时请求 app 统一收起浮层（docs/施工图 0.4.0 §3.2）。
         *
         * 为什么由 app 提供：浮层（目录栏、字号栏、笔记栏、划词菜单、问 AI）全在 ReaderScreen
         * 的 state 里，只有它知道该关哪些；reader 只负责「判断这是不是一次真正的空白点击」。
         */
        const requestCloseMenus = useCallback((source) => {
          const close = typeof props.closeMenus === 'function'
            ? props.closeMenus
            : (typeof props.closeOverlays === 'function' ? props.closeOverlays : null)
          if (!close) return
          try {
            close({ source })
          } catch (error) {
            // 收起失败不该把阅读器带崩
            console.warn('[dsh-reading] closeMenus 回调出错：', error)
          }
        }, [props.closeMenus, props.closeOverlays])

        /** 外链交给浏览器；被拦（Electron 常拦）就复制地址并给一句中文提示。 */
        const openExternal = useCallback((url, copyText) => {
          let opened = null
          try {
            opened = typeof window !== 'undefined' ? window.open(url, '_blank', 'noopener,noreferrer') : null
          } catch (error) {
            opened = null
          }
          if (opened) return
          if (copyPlainText(copyText || url)) {
            notice('链接已复制，请在浏览器里打开')
            return
          }
          notice('这个链接打不开')
        }, [notice])

        // 把方法交给外层（annotate 的「跳回原文」、toc 的跳转都靠它）
        useEffect(() => {
          const api = {
            jumpToCfi,
            jumpToSpine,
            nextPage,
            prevPage,
            getFrameDocument: () => docRef.current,
            getFrameWindow: () => winRef.current,
            getPageInfo: () => ({ page: pageRef.current, pageCount: pageCountRef.current, chapterIndex: chapterRef.current }),
            gotoPage,
            getPageOffset: () => {
              const { width, gap } = geometry()
              return pageRef.current * (width + gap)
            },
            /** 当前页首字符的 CFI —— 加书签时用它当锚点。 */
            currentCfi: () => {
              const doc = docRef.current
              const win = winRef.current
              if (!doc || !win) return ''
              const range = caretRangeAtPoint(doc, 2, 2)
              if (!range) return ''
              try {
                const index = chapterRef.current
                const idref = spine[index] && spine[index].idref ? spine[index].idref : undefined
                return CFI.fromRange(win, range, { index, idref })
              } catch (error) {
                return ''
              }
            },
            repaginate: () => paginate(null),
          }
          apiRefInternal.current = api
          if (props.apiRef) props.apiRef.current = api
          return () => {
            if (apiRefInternal.current === api) apiRefInternal.current = null
          }
        }, [geometry, jumpToCfi, jumpToSpine, nextPage, prevPage, paginate, props.apiRef, spine])

        // 阅读偏好变化（字号 / 行距 / 字体）会改变文本长度 → 页数跟着变，必须重排。
        // 只依赖 props.settings 的「内容」而不是对象身份：上层每次渲染都新建对象的话，
        // 用身份当依赖会变成无限重排。
        const settingsKey = JSON.stringify(props.settings || {})
        useEffect(() => {
          if (!docRef.current) return
          const keep = snapshot()
          paginate({ cfi: keep.cfi, percent: keep.percent })
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [settingsKey])

        // 尺寸变化 → 重新分页，并尽量停在原处
        useEffect(() => {
          const target = viewportRef.current
          if (!target || typeof ResizeObserver === 'undefined') {
            // 没有 ResizeObserver 的老 webview：至少响应一次窗口缩放
            const onResize = () => paginate({ cfi: snapshot().cfi, percent: snapshot().percent })
            window.addEventListener('resize', onResize)
            return () => window.removeEventListener('resize', onResize)
          }
          let raf = 0
          const observer = new ResizeObserver(() => {
            if (raf !== 0) cancelAnimationFrame(raf)
            raf = requestAnimationFrame(() => {
              raf = 0
              if (!docRef.current) return
              const keep = snapshot()
              paginate({ cfi: keep.cfi, percent: keep.percent })
            })
          })
          observer.observe(target)
          return () => {
            if (raf !== 0) cancelAnimationFrame(raf)
            observer.disconnect()
          }
        }, [paginate, snapshot])

        // 选中文本 → 交给 annotate（父窗口挂监听，菜单画在父窗口，才不会被 iframe 裁掉）
        useEffect(() => {
          const doc = docRef.current
          if (!doc) return undefined
          let timer = null
          const onSelectionChange = () => {
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = null
              const win = winRef.current
              const selection = win && typeof win.getSelection === 'function' ? win.getSelection() : null
              if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                if (typeof props.onSelection === 'function') props.onSelection(null)
                return
              }
              const range = selection.getRangeAt(0)
              const text = range.toString()
              if (text.trim() === '') {
                if (typeof props.onSelection === 'function') props.onSelection(null)
                return
              }
              if (typeof props.onSelection === 'function') {
                props.onSelection({
                  range,
                  text,
                  chapterHref: currentHref,
                  spineIndex: chapterRef.current,
                })
              }
            }, 120)
          }
          doc.addEventListener('selectionchange', onSelectionChange)
          return () => {
            if (timer !== null) clearTimeout(timer)
            doc.removeEventListener('selectionchange', onSelectionChange)
          }
        }, [currentHref, loading, props.onSelection])

        // 键盘翻页：焦点在阅读器里时生效；输入框里不抢键
        useEffect(() => {
          const doc = docRef.current
          const root = viewportRef.current
          if (!root) return undefined
          const onKeyDown = (event) => {
            const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return
            // Ctrl/⌘+F：浏览器自带的页内查找只能查到「当前这一章的当前页」，
            // 用户以为搜的是全书，搜不到就以为书里没有。这里接管成书内搜索。
            if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
              event.preventDefault()
              if (typeof props.onToggleSide === 'function') props.onToggleSide('search')
              return
            }
            // Alt+Q：一步打开问答记录（与工具栏那个「问答」按钮同一条路）
            if (event.altKey && (event.key === 'q' || event.key === 'Q')) {
              event.preventDefault()
              if (typeof props.onToggleSide === 'function') props.onToggleSide('qa')
              return
            }
            // Esc：让 app 把浮层一起收掉（目录 / 字号 / 笔记 / 划词菜单 / 问 AI）
            if (event.key === 'Escape') {
              event.preventDefault()
              // 宿主文档上 app 也挂了一个 Esc 监听；这里不停住会让 closeOverlays 跑两遍，
              // 第二遍拿着旧的 sideKind 又把侧栏 toggle 回来。
              event.stopPropagation()
              requestCloseMenus('escape')
              return
            }
            if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
              event.preventDefault()
              nextPage()
            } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
              event.preventDefault()
              prevPage()
            }
          }
          root.addEventListener('keydown', onKeyDown)
          if (doc) doc.addEventListener('keydown', onKeyDown)
          return () => {
            root.removeEventListener('keydown', onKeyDown)
            if (doc) doc.removeEventListener('keydown', onKeyDown)
          }
        }, [loading, nextPage, prevPage, props.onToggleSide, requestCloseMenus])

        /**
         * 书内链接：事件委派拦截（docs/施工图 0.4.0 §2.4）。
         *
         * 为什么一定要 preventDefault：服务端把 `<a href>` 改成了 `#dsh-reading:<原地址>`，
         * 不拦的话点一下就是「一次 hash 导航」；部分书里残留的相对路径 / 外链更会把
         * iframe 整个导航走（正文白屏，用户以为书坏了）。键盘 Enter 激活链接同样走 click，
         * 所以不需要额外接 keydown。
         */
        useEffect(() => {
          const doc = docRef.current
          if (!doc) return undefined
          const onClick = (event) => {
            if (typeof event.button === 'number' && event.button !== 0) return
            const node = event.target
            const anchor = node && typeof node.closest === 'function' ? node.closest('a[href]') : null
            if (!anchor) return

            // 先拦再说：晚一步浏览器已经开始导航
            event.preventDefault()
            event.stopPropagation()

            const raw = anchor.getAttribute('href') || ''
            const target = resolveSpineTarget(spine, currentHref, raw, {
              currentIndex: chapterRef.current,
              assetBase: props.bookHash ? assetUrl(props.bookHash, '') : '',
            })

            if (target.kind === 'chapter') {
              if (target.spineIndex === chapterRef.current) {
                if (docRef.current) paginate({ page: 0, fragment: target.fragment, flash: true })
                emitProgress()
              } else if (typeof props.onJumpSpine === 'function') {
                props.onJumpSpine(target.spineIndex, { fragment: target.fragment, source: 'link' })
              } else {
                jumpToSpine(target.spineIndex, { fragment: target.fragment })
              }
              return
            }
            if (target.kind === 'external') {
              openExternal(target.url)
              return
            }
            if (target.kind === 'contact') {
              const value = target.value.trim()
              if (target.scheme === 'mailto') {
                if (copyPlainText(value)) notice(`邮箱地址已复制：${value}`)
                else notice('这个链接打不开')
              } else {
                if (copyPlainText(value)) notice(`电话：${value}`)
                else notice(`电话：${value}`)
              }
              return
            }
            if (target.kind === 'asset') {
              // 书内图片/附件：不弹新窗口（宿主的 window.open 多半也打不开 dsh-reading://）
              notice('这个链接指向书里的图片或附件，不用单独打开')
              return
            }
            if (target.kind === 'missing') {
              notice('这个链接打不开')
            }
            // kind === 'ignore'：javascript:/空协议 → 已经 preventDefault，什么都不做
          }
          doc.addEventListener('click', onClick, true)
          return () => doc.removeEventListener('click', onClick, true)
        }, [chapterIndex, currentHref, emitProgress, jumpToSpine, loading, notice, openExternal, paginate, props.bookHash, props.onJumpSpine, spine])

        /**
         * 点正文空白 → 收起所有浮层（§3.2）。判据是「pointerdown 到 pointerup 有没有形成一次真正的点击」：
         *   - 位移超过 6px = 拖选 / 滑动 → 不收（否则用户刚划完词，选区就被清掉）；
         *   - 有非空选区 → 不收；
         *   - 点在链接上 → 不收（那是导航，不是点空白）。
         */
        useEffect(() => {
          const doc = docRef.current
          if (!doc) return undefined
          let start = null
          const onPointerDown = (event) => {
            if (typeof event.button === 'number' && event.button !== 0) {
              start = null
              return
            }
            start = { x: event.clientX, y: event.clientY }
          }
          const onPointerUp = (event) => {
            if (!start) return
            const from = start
            start = null
            if (Math.abs(event.clientX - from.x) > CLICK_SLOP) return
            if (Math.abs(event.clientY - from.y) > CLICK_SLOP) return
            const node = event.target
            if (node && typeof node.closest === 'function' && node.closest('a[href]')) return
            const win = winRef.current
            let selection = null
            try {
              selection = win && typeof win.getSelection === 'function' ? win.getSelection() : null
            } catch (error) {
              selection = null
            }
            if (selection && !selection.isCollapsed && String(selection).trim() !== '') return
            requestCloseMenus('content')
          }
          doc.addEventListener('pointerdown', onPointerDown, true)
          doc.addEventListener('pointerup', onPointerUp, true)
          return () => {
            doc.removeEventListener('pointerdown', onPointerDown, true)
            doc.removeEventListener('pointerup', onPointerUp, true)
          }
        }, [loading, requestCloseMenus])


        /**
         * 滚轮 / 触控板两指 / 手指触摸 → 翻页。
         *
         * 四条输入要一起接：
         *   - 鼠标滚轮：`deltaY`（上下滚）当翻页，这一条是最常见的「我就想往下读」；
         *   - 触控板两指横滑：`deltaX` 为主，方向与直觉一致（往左滑 = 下一页）；
         *   - 触摸屏：pointerdown/up 位移，阈值 48px，纵向滑动不抢（那是选择文本）；
         *   - **鼠标拖拽一律不翻页**：那是选字。翻页有窄条、键盘、滚轮，不该抢这个手势。
         *
         * 事件必须同时挂在父容器与 iframe 文档上：指针在书页上时事件被 iframe 吃掉，
         * 只挂父容器会表现为「正文区域怎么滚都不翻页」。
         */
        useEffect(() => {
          const root = viewportRef.current
          if (!root) return undefined
          const doc = docRef.current
          const targetNode = doc && doc.body ? doc.body : null

          // 一次「手势」只翻一页。触控板是这么工作的：两指一滑，先是手指推的一串
          // wheel 事件，松手后系统还会再补一段**惯性滚动**（动量），前后加起来能连续
          // 几十个事件、持续将近一秒。早期版本只做了 240ms 节流，惯性还没走完锁就
          // 过期了，于是「滑一下翻四五页」。
          //
          // 现在的判据不是时间够不够，而是**这一串事件停没停**：
          //   armed  = 允许下一次翻页（上一条手势已经结束）
          //   手势结束 = 两个事件之间隔了 200ms 以上（惯性最长也就是几百毫秒）
          // 翻过一页就 armed=false，只有等到一段真正的空白，才会重新 armed。
          // 停手判定：两串事件间隔超过它就算新手势。200ms 太长了 —— 触控板惯性
          // 事件能连 500ms，用户以为「没反应」，其实是我们还在上一次手势里。
          const GESTURE_GAP = 140
          // 翻一页需要的位移（越小越灵敏）。20px 是「手一推就翻」的量级，
          // 但配合下面的 blocked 锁，一次手势无论如何只翻一页，不会连翻。
          const WHEEL_STEP = 20
          // 手势状态放 ref：`nextPage` / `prevPage` 的身份会随 props 变化，effect
          // 因此会重跑一次；如果状态是闭包里的 let，重跑就等于「手还没松就又允许翻页」，
          // 惯性动量会把一次滑动翻成四五页。
          const g = gestureRef.current
          const turn = (direction) => {
            const nav = navRef.current
            if (!nav) return
            if (direction > 0) nav.next()
            else nav.prev()
          }

          // ── 「跟手」预览：手在推，纸就跟着动一点 ───────────────────────────
          // 纯阈值翻页（推够 32px 忽然整页跳）在触控板上手感很硬：手指在滑，画面
          // 纹丝不动，等攒够距离才「啪」地换页。这里在手指推动期间给正文一个按阻尼
          // 比例的小位移，越推越跟手；越过阈值立刻完成翻页，没越过就弹回去。
          const previewState = { active: false, snapped: false }
          const snapTimer = { id: null }

          const baseOffset = () => {
            const { width, gap } = geometry()
            return pageRef.current * (width + gap)
          }

          const paintOffset = (px, transition) => {
            const body = doc && doc.body
            if (!body) return
            body.style.transition = transition || 'none'
            body.style.transform = `translateX(${-px}px)`
          }

          const showPreview = (deltaPx) => {
            if (!doc || !doc.body) return
            const { width } = geometry()
            // 阻尼 + 封顶：最多推出半屏多一点，再多就说明该翻页了
            const cap = Math.max(48, Math.min(width * 0.55, 260))
            const damped = Math.max(-cap, Math.min(cap, deltaPx * 0.55))
            previewState.active = true
            previewState.snapped = false
            paintOffset(baseOffset() + damped, 'none')
          }

          const snapBack = () => {
            if (!previewState.active || previewState.snapped) return
            previewState.active = false
            paintOffset(baseOffset(), 'transform 140ms cubic-bezier(0.22, 0.61, 0.36, 1)')
          }

          const scheduleSnap = () => {
            if (snapTimer.id !== null) clearTimeout(snapTimer.id)
            snapTimer.id = setTimeout(() => {
              snapTimer.id = null
              snapBack()
            }, GESTURE_GAP)
          }

          const finishTurn = (direction) => {
            previewState.snapped = true
            previewState.active = false
            if (snapTimer.id !== null) clearTimeout(snapTimer.id)
            snapTimer.id = null
            turn(direction)
          }

          const onWheel = (event) => {
            // 书页里 overflow:hidden，本来也不会滚动；这里只负责把「滚」翻译成「翻页」
            const dx = Number(event.deltaX) || 0
            const dy = Number(event.deltaY) || 0
            const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy
            if (delta === 0) return
            const now = Date.now()
            // 停手了（事件间隔超过 GESTURE_GAP）→ 新手势：解锁、位移归零。
            // 用力甩一下时，惯性事件会连续几百毫秒不断流，所以「同一个手势」期间
            // 永远不会重新解锁 —— 一次手势只翻一页，这是硬保证，不是阈值推测。
            if (now - g.lastWheelAt > GESTURE_GAP) {
              g.accumulated = 0
              g.blocked = false
            }
            g.lastWheelAt = now
            if (g.blocked) return
            g.accumulated += delta
            showPreview(g.accumulated)
            scheduleSnap()
            if (Math.abs(g.accumulated) < WHEEL_STEP) return
            g.accumulated = 0
            // 锁住：这一串事件剩下的部分（惯性、手指继续推）一律不再翻页
            g.blocked = true
            finishTurn(delta > 0 ? 1 : -1)
          }

          let startX = 0
          let startY = 0
          let tracking = false
          // pointerdown 那一刻的选区文本。判据是「这次手势有没有形成文本选区」，
          // 所以基线要在按下时记，而不是松手时才现看（松手时选区可能已经被浏览器收掉）。
          let selectionAtStart = ''

          /** 读一次书籍文档的选区文本；拿不到就当空（宁可不翻页，也不打断用户划词）。 */
          const readSelectionText = () => {
            const win = winRef.current
            try {
              const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null
              if (!sel || sel.isCollapsed) return ''
              return String(sel).trim()
            } catch (error) {
              return ''
            }
          }

          const onPointerDown = (event) => {
            // 鼠标拖动 = 选字，**任何情况下都不翻页**。翻页另有两侧窄条、键盘、滚轮三条路，
            // 不必再抢一个手势；而「从左拖到最右松手就翻页」正好毁掉最常用的划词。
            if (event.pointerType === 'mouse') {
              tracking = false
              return
            }
            // 触摸屏 / 触控笔：只有单指主键才算翻页手势
            if (event.pointerType !== 'touch' && event.button !== 0) {
              tracking = false
              return
            }
            tracking = true
            startX = event.clientX
            startY = event.clientY
            selectionAtStart = readSelectionText()
          }

          const onPointerMove = (event) => {
            if (!tracking) return
            const dx = event.clientX - startX
            const dy = event.clientY - startY
            // 纵向为主 = 在选字，不做预览（手一抖就把正文推开很难看）
            if (Math.abs(dx) <= Math.abs(dy)) return
            showPreview(dx)
          }

          const onPointerUp = (event) => {
            if (!tracking) return
            tracking = false
            const dx = event.clientX - startX
            const dy = event.clientY - startY
            if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) {
              snapBack()
              return
            }
            // 划词不翻页：本次手势形成了选区（松手时还非空），或按下前本来就有选区
            // （触控板划词常常先有一小段选区），都不翻 —— 否则刚选中的一段会被翻走。
            if (readSelectionText() !== '' || selectionAtStart !== '') {
              snapBack()
              return
            }
            finishTurn(dx < 0 ? 1 : -1)
          }

          const onPointerCancel = () => {
            tracking = false
            selectionAtStart = ''
            snapBack()
          }

          for (const node of [root, targetNode]) {
            if (!node) continue
            node.addEventListener('wheel', onWheel, { passive: true })
            node.addEventListener('pointerdown', onPointerDown, { passive: true })
            node.addEventListener('pointermove', onPointerMove, { passive: true })
            node.addEventListener('pointerup', onPointerUp, { passive: true })
            node.addEventListener('pointercancel', onPointerCancel, { passive: true })
          }
          return () => {
            if (snapTimer.id !== null) clearTimeout(snapTimer.id)
            snapTimer.id = null
            for (const node of [root, targetNode]) {
              if (!node) continue
              node.removeEventListener('wheel', onWheel)
              node.removeEventListener('pointerdown', onPointerDown)
              node.removeEventListener('pointermove', onPointerMove)
              node.removeEventListener('pointerup', onPointerUp)
              node.removeEventListener('pointercancel', onPointerCancel)
            }
          }
          // 只依赖 loading：翻页函数走 navRef，避免每次翻页重绑事件、
          // 顺便把上面的手势状态（在 gestureRef 里）保住。
        }, [loading])

        useEffect(() => () => {
          if (progressTimer.current !== null) {
            clearTimeout(progressTimer.current)
            progressTimer.current = null
          }
          if (anchorRetryRef.current !== null) {
            clearTimeout(anchorRetryRef.current)
            anchorRetryRef.current = null
          }
          if (flashTimerRef.current !== null) {
            clearTimeout(flashTimerRef.current)
            flashTimerRef.current = null
          }
        }, [])

        const title = props.meta && props.meta.title ? props.meta.title : '未命名'
        const chapterLabel = spineCount > 0 && spine[chapterIndex]
          ? `第 ${chapterIndex + 1} / ${spineCount} 节`
          : ''
        const src = currentHref !== '' ? chapterUrl(props.bookHash, currentHref) : ''
        const qaCount = Number.isFinite(props.qaCount) ? Math.max(0, Math.floor(props.qaCount)) : 0

        const bar = h(
          'div',
          // data-dr-keep-open：app.js 的「点正文收起」白名单认这个标记，
          // 点工具栏按钮不会把自己的面板关掉（§3.2 白名单）。
          { className: 'dr-reader-bar', 'data-dr-keep-open': '' },
          typeof props.onClose === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-btn dr-btn-ghost dr-btn-sm',
                onClick: props.onClose,
                title: '回到书架',
              },
              '← 书架',
            )
            : null,
          h('div', { className: 'dr-reader-title dr-ellipsis', title }, title),
          chapterLabel !== '' ? h('div', { className: 'dr-head-sub' }, chapterLabel) : null,
          h('div', { className: 'dr-grow' }),
          typeof props.onToggleSide === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-iconbtn',
                title: '书内搜索（Ctrl/⌘ + F）',
                'aria-label': '书内搜索',
                'aria-pressed': props.sideKind === 'search' ? 'true' : 'false',
                onClick: () => props.onToggleSide('search'),
              },
              '⌕',
            )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dr-iconbtn',
              title: '目录',
              'aria-label': '目录',
              'aria-pressed': props.sideKind === 'toc' ? 'true' : 'false',
              onClick: () => {
                if (typeof props.onToggleSide === 'function') props.onToggleSide('toc')
              },
            },
            '☰',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dr-iconbtn',
              title: '划线笔记',
              'aria-label': '划线笔记',
              'aria-pressed': props.sideKind === 'annotations' ? 'true' : 'false',
              onClick: () => {
                if (typeof props.onToggleSide === 'function') props.onToggleSide('annotations')
              },
            },
            '✎',
          ),
          // 「问答」常驻工具栏、一次点击直达（不藏进二级菜单）；有记录时带条数徽标。
          // 快捷键 Alt+Q 在下面的 keydown 里，与这个按钮走同一条 onToggleSide('qa')。
          typeof props.onToggleSide === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-btn dr-btn-sm dr-qa-entry',
                title: qaCount > 0 ? `问答记录（Alt+Q）· ${qaCount} 条` : '问答记录（Alt+Q）',
                'aria-label': qaCount > 0 ? `问答记录，${qaCount} 条` : '问答记录',
                'aria-pressed': props.sideKind === 'qa' ? 'true' : 'false',
                onClick: () => props.onToggleSide('qa'),
              },
              '问答',
              qaCount > 0 ? h('span', { className: 'dr-toc-badge' }, qaCount > 99 ? '99+' : String(qaCount)) : null,
            )
            : null,
          // 读书蒸馏入口：常驻一个按钮，一次点击直达（有成果时带条数）
          typeof props.onOpenDistill === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-btn dr-btn-sm dr-distill-entry',
                title: props.distillDone > 0 ? `读书蒸馏 · 已蒸 ${props.distillDone} 章` : '读书蒸馏：把这本书变成能带走的笔记',
                'aria-label': '读书蒸馏',
                'aria-pressed': props.sideKind === 'distill' ? 'true' : 'false',
                onClick: props.onOpenDistill,
              },
              '蒸馏',
              props.distillDone > 0 ? h('span', { className: 'dr-toc-badge' }, String(props.distillDone)) : null,
            )
            : null,
          // AI 状态点：一眼看出「现在能不能用」。绿色可用、黄色最近失败、红色配置不通。
          // 点开是「AI 状态」面板——那里才有四道检查与最近调用账本。
          typeof props.onOpenAi === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: `dr-iconbtn dr-ai-entry dr-ai-entry-${statusSummary(props.aiStatus, { probing: props.aiProbing }).tone}`,
                title: `${statusSummary(props.aiStatus, { probing: props.aiProbing }).text}（点开看诊断）`,
                'aria-label': 'AI 状态',
                'aria-pressed': props.sideKind === 'ai' ? 'true' : 'false',
                onClick: props.onOpenAi,
              },
              h('span', { className: 'dr-ai-dot' }),
              'AI',
            )
            : null,
          typeof props.onOpenSettings === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-iconbtn',
                title: '阅读设置',
                'aria-label': '阅读设置',
                onClick: props.onOpenSettings,
              },
              'Aa',
            )
            : null,
          typeof props.onOpenHelp === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-iconbtn dr-iconbtn-q',
                title: '使用说明',
                'aria-label': '使用说明',
                onClick: props.onOpenHelp,
              },
              '?',
            )
            : null,
        )

        let viewportBody
        if (error !== '') {
          viewportBody = h(
            'div',
            { className: 'dr-state dr-error' },
            h('div', { className: 'dr-state-title' }, '这一章打不开'),
            h('div', { className: 'dr-state-text' }, humanizeError(error)),
            h(
              'div',
              { className: 'dr-state-actions' },
              h(
                'button',
                { type: 'button', className: 'dr-btn', onClick: () => goChapter(chapterIndex, { page: 0 }) },
                '重试',
              ),
              chapterIndex > 0
                ? h(
                  'button',
                  { type: 'button', className: 'dr-btn', onClick: () => goChapter(chapterIndex - 1, { page: 0 }) },
                  '回上一节',
                )
                : null,
            ),
          )
        } else if (src === '') {
          viewportBody = h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-title' }, '这本书没有可读的正文'),
            h('div', { className: 'dr-state-text' }, 'EPUB 里没有找到章节文件，可能文件已经损坏。'),
          )
        } else {
          viewportBody = h('iframe', {
            ref: frameRef,
            className: 'dr-frame',
            title: `正文：${title}`,
            src,
            // 只开 same-origin：拿来 contentDocument 算 CFI；绝不给 allow-scripts
            sandbox: 'allow-same-origin',
            onLoad: handleLoad,
          })
        }

        const sideNode = props.side
          ? h(
            'aside',
            {
              className: 'dr-side',
              style: Number.isFinite(props.sideWidth) ? { '--dsh-reading-side-width': `${props.sideWidth}px` } : undefined,
            },
            props.side,
          )
          : null

        const theme = themeOf(props.settings && props.settings.theme ? props.settings.theme : 'light')

        return h(
          'div',
          {
            className: 'dr-reader',
            // data-theme 是主题钩子：style.js 里高亮色的明/暗两套变量挂在
            // [data-theme="dark"] 上，没有这个属性那套变量永远不生效。
            'data-theme': theme.key,
            style: {
              '--dsh-reading-paper': theme.paper,
              '--dsh-reading-ink': theme.ink,
              '--dsh-reading-rule': theme.rule,
            },
          },
          // 顶部细进度条：绝对定位在 .dr-reader（position:relative）上沿，
          // 不放进 .dr-pageinfo —— 那一行是 flex 文本行，不是定位上下文。
          h('div', { className: 'dr-topbar' },
            h('div', { className: 'dr-topbar-fill', style: { width: `${Math.round(percent * 100)}%` } })),
          bar,
          h(
            'div',
            { className: 'dr-reader-main' },
            // 左右两条「翻页窄边」：各占 26px，落在正文之外的留白里，不压字。
            // 之前是两个各占 22% 宽的**隐形**热区，鼠标划过正文就误翻页，而且看不见、
            // 不知道能点 —— 换成看得见的窄条，兼作左右翻页按钮。
            h(
              'button',
              {
                type: 'button',
                className: 'dr-rail dr-rail-left',
                'aria-label': '上一页',
                title: '上一页（←）',
                'data-dr-keep-open': '',
                disabled: chapterIndex === 0 && page === 0,
                onClick: prevPage,
              },
              h('span', { className: 'dr-rail-chevron', 'aria-hidden': 'true' }, '‹'),
            ),
            // 底部左右两块翻页热区：手机上拇指天然落在屏幕下方，两侧 26px 的窄边够不着。
            // 这两块压在正文之上，但只占底部 18% 高、左右各 34% 宽，中间 32% 留白给划词。
            h(
              'button',
              {
                type: 'button',
                className: 'dr-turn-zone dr-turn-zone-prev',
                'aria-label': '上一页',
                title: '上一页（←）',
                'data-dr-keep-open': '',
                disabled: chapterIndex === 0 && page === 0,
                onClick: prevPage,
                style: {
                  position: 'absolute', bottom: 0, left: 0, width: '34%', height: '18%',
                  border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-start',
                  color: 'inherit', opacity: 0.5, zIndex: 2,
                },
              },
              h('span', { className: 'dr-turn-zone-chevron', 'aria-hidden': 'true' }, '‹'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-turn-zone dr-turn-zone-next',
                'aria-label': '下一页',
                title: '下一页（→）',
                'data-dr-keep-open': '',
                disabled: chapterIndex >= spineCount - 1 && page >= pageCount - 1,
                onClick: nextPage,
                style: {
                  position: 'absolute', bottom: 0, right: 0, width: '34%', height: '18%',
                  border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
                  color: 'inherit', opacity: 0.5, zIndex: 2,
                },
              },
              h('span', { className: 'dr-turn-zone-chevron', 'aria-hidden': 'true' }, '›'),
            ),
            h(
              'div',
              {
                className: 'dr-viewport',
                ref: viewportRef,
                tabIndex: 0,
                style: { padding: `${SIDE_PADDING}px ${SIDE_PADDING_X}` },
              },
              viewportBody,
              // 「跳到这里」的闪框：声明式渲染在父窗口里，正文 DOM 一个字节都不动
              flash
                ? h('div', {
                  className: 'dr-jump-flash',
                  'aria-hidden': 'true',
                  style: {
                    position: 'absolute',
                    pointerEvents: 'none',
                    zIndex: 2,
                    borderRadius: '3px',
                    background: 'rgba(255, 205, 0, 0.34)',
                    boxShadow: '0 0 0 1px rgba(255, 170, 0, 0.55)',
                    transition: 'opacity 0.5s ease',
                    ...flash,
                  },
                })
                : null,
              props.overlay ? props.overlay : null,
              loading
                ? h(
                  'div',
                  { className: 'dr-state', style: { position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-base, #fff)' } },
                  h('div', { className: 'dr-spinner', role: 'status', 'aria-label': '正在打开这一节' }),
                  h('div', { className: 'dr-state-text' }, '正在打开这一节…'),
                )
                : null,
            ),
            sideNode,
            h(
              'button',
              {
                type: 'button',
                className: 'dr-rail dr-rail-right',
                'aria-label': '下一页',
                title: '下一页（→）',
                'data-dr-keep-open': '',
                onClick: nextPage,
              },
              h('span', { className: 'dr-rail-chevron', 'aria-hidden': 'true' }, '›'),
            ),
          ),
          h(
            'div',
            { className: 'dr-pagebar' },
            h(
              'button',
              {
                type: 'button',
                className: 'dr-pagebtn',
                onClick: prevPage,
                disabled: chapterIndex === 0 && page === 0,
                title: '上一页（← / 触控板向右滑 / 滚轮向上）',
              },
              '‹ 上一页',
            ),
            h(
              'div',
              { className: 'dr-pagebar-mid' },
              jumpOpen
                ? h(
                  'span',
                  { className: 'dr-pagejump' },
                  h('input', {
                    className: 'dr-pagejump-input',
                    type: 'number',
                    min: 1,
                    max: Math.max(1, pageCount),
                    value: jumpText,
                    placeholder: `${Math.min(page + 1, pageCount)}`,
                    autoFocus: true,
                    'aria-label': `跳到本章第几页，共 ${pageCount} 页`,
                    onInput: (event) => setJumpText(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        gotoPage(jumpText === '' ? page + 1 : jumpText)
                        setJumpOpen(false)
                        setJumpText('')
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setJumpOpen(false)
                        setJumpText('')
                      }
                      event.stopPropagation()
                    },
                    onBlur: () => {
                      // 失焦就收起来：点别处等于取消，不留一个悬着的输入框
                      setJumpOpen(false)
                      setJumpText('')
                    },
                  }),
                  h('span', { className: 'dr-pagejump-hint' }, `/ ${pageCount}`),
                )
                : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dr-pagebar-num',
                    title: pageCount > 1 ? `跳到本章第几页（共 ${pageCount} 页）` : '本章只有一页',
                    'aria-label': `第 ${Math.min(page + 1, pageCount)} 页，共 ${pageCount} 页，点击可输入页码跳转`,
                    onClick: () => {
                      setJumpText(String(Math.min(page + 1, pageCount)))
                      setJumpOpen(true)
                    },
                  },
                  `${Math.min(page + 1, pageCount)} / ${pageCount}`,
                ),
              h(
                'div',
                {
                  className: 'dr-pagebar-track',
                  role: 'progressbar',
                  'aria-valuemin': 0,
                  'aria-valuemax': Math.max(1, pageCount - 1),
                  'aria-valuenow': page,
                  title: '点击跳到这一章的任意位置',
                },
                h('div', {
                  className: 'dr-pagebar-fill',
                  style: { width: `${pageCount <= 1 ? 100 : Math.round((page / (pageCount - 1)) * 100)}%` },
                }),
              ),
              h('span', { className: 'dr-pagebar-pct' }, `全书 ${Math.round(percent * 100)}%`),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-pagebtn',
                onClick: nextPage,
                title: '下一页（→ / 空格 / 触控板向左滑 / 滚轮向下）',
              },
              '下一页 ›',
            ),
          ),
        )
      }

      return { LINK_PREFIX: LINK_PREFIX, THEMES: THEMES, themeOf: themeOf, FONT_CHOICES: FONT_CHOICES, fontStackOf: fontStackOf, resolveSpineTarget: resolveSpineTarget, findAnchor: findAnchor, ReaderView: ReaderView }
    })()

    // ─── client/src/annotate.js ───
    var __mod_annotate_js = (function () {
      /**
       * annotate.js —— 划线、笔记、书签：数据 hook + 覆盖层 + 选区菜单 + 侧栏。
       *
       * 铁律 4 的落地点：**正文 DOM 一个字节都不改**。
       * 高亮是父窗口里的一层绝对定位 <div>，位置来自 `range.getClientRects()`。
       * 为什么这一条不能妥协：`<p>abcdef</p>` 与 `<p>abc<i></i>def</p>` 文本一样，
       * 但 CFI 的偏移基准不同。插一个空元素，整章锚点集体偏移，用户昨天划的线今天就跑到别的句子上了。
       *
       * 坐标换算（容易错，写清楚；实现只有一处 `rangeRectToMenuBase`，别在调用点重新推导）：
       *   rect 是 `range.getBoundingClientRect()` 的结果，**已经含翻页位移**——
       *   CSSOM View 规定它返回变换后的视觉矩形，而翻页正是靠
       *   `doc.body.style.transform = translateX(-offset)` 做的。
       *   iframe 本身在父窗口里有位置（padding、工具栏），所以
       *   最终位置 = iframeRect.left + rect.left − 覆盖层原点；**不减翻页位移**。
       * 这里统一用「覆盖层自己的 getBoundingClientRect」当原点，避免逐层累加出错。
       */

            const call = __mod_api_js.call
            const getDeviceId = __mod_api_js.getDeviceId
            const humanizeError = __mod_api_js.humanizeError
            const colorStyle = __mod_style_js.colorStyle
            const HIGHLIGHT_ORDER = __mod_style_js.HIGHLIGHT_ORDER
            const HIGHLIGHT_COLORS = __mod_style_js.HIGHLIGHT_COLORS
            const AiStatusChip = __mod_ai_js.AiStatusChip
            const CFI = __mod_cfi_js
            const fingerprint = __mod_contract_js.fingerprint
            const makeBookmark = __mod_contract_js.makeBookmark
            const makeHighlight = __mod_contract_js.makeHighlight
            const makeNote = __mod_contract_js.makeNote

      /** 只在内存里保留的「已隔离」计数上限，避免侧栏渲染一个巨大的列表。 */
      const MAX_QUARANTINE_NOTE = 3

      /**
       * 最近一次 useAnnotations 拿到的 bookHash。
       *
       * 为什么要有这个兜底：AskPanel 要能把一条回答存成笔记（ann.put 必须带 bookHash），
       * 而它现在挂在 ReaderScreen 里，渲染处没有把 bookHash 传下来。改 app.js 是包 A / t6
       * 的写面（t4 正在改同一个文件），所以这里记住「当前这本书」——同一时刻只有一个
       * ReaderScreen 在跑，取最近一次注解 hook 的书不会串。t6 接 AskPanel 时传 props.bookHash
       * 即可覆盖这条兜底。
       */
      let lastBookHash = ''

      /** 把一段长回答截成侧栏能两行显示的长度（只做展示，不改原文）。 */
      function shortText(text, limit) {
        const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
        const max = Number.isFinite(limit) ? limit : 60
        if (value.length <= max) return value
        return `${value.slice(0, max)}…`
      }

      /** 记录类型 → 中文名。侧栏用它区分「划线 / 笔记 / 书签」。 */
      const TYPE_LABEL = { highlight: '划线', note: '笔记', bookmark: '书签' }

      /** 把 ISO 时间压成「3 天前」这类相对说法；解析不了就返回空串，不显示假信息。 */
      function relativeTime(iso) {
        if (typeof iso !== 'string' || iso === '') return ''
        const then = Date.parse(iso)
        if (!Number.isFinite(then)) return ''
        const diff = Date.now() - then
        if (diff < 0) return '刚刚'
        const minute = 60 * 1000
        const hour = 60 * minute
        const day = 24 * hour
        if (diff < minute) return '刚刚'
        if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
        if (diff < day) return `${Math.floor(diff / hour)} 小时前`
        if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
        const date = new Date(then)
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      }

      /** 裁剪长文本，用于侧栏摘要。 */
      function excerptOf(text, max) {
        const value = typeof text === 'string' ? text : ''
        const limit = max ?? 160
        if (value.length <= limit) return value
        return `${value.slice(0, limit)}…`
      }

      /**
       * 标注数据 hook。
       *
       * opts:
       *   bookHash   —— 哪本书
       *   frameDoc   —— 书籍文档（annotate 解析 CFI 要用）
       *   frameWin   —— 书籍窗口（filter / Range 要用）
       *   deviceId   —— 写记录时要带
       *   onError(msg)—— 已经 humanizeError 过的中文
       *
       * 返回的 records 永远是「当前书、未删除、可渲染」的记录；
       * 解析失败的记录不参与渲染（铁律 6：不渲染，但也不删除）。
       *
       * 失败行为：读列表失败时 records 为空并把错误交给 onError；
       * 写失败时抛给调用方（用户点了按钮，必须让他知道没存上）。
       */
      function useAnnotations(opts) {
        const [records, setRecords] = useState([])
        const [loading, setLoading] = useState(true)
        const [quarantined, setQuarantined] = useState(0)
        const bookHash = opts.bookHash
        const deviceId = opts.deviceId
        const reportError = opts.onError
        // 记住当前这本书：AskPanel「存成笔记」没有显式 bookHash 时用它兜底
        if (typeof bookHash === 'string' && bookHash !== '') lastBookHash = bookHash

        const reload = useCallback(async () => {
          if (typeof bookHash !== 'string' || bookHash === '') return
          setLoading(true)
          try {
            const value = await call('ann.list', { bookHash })
            const list = value && Array.isArray(value.records) ? value.records : []
            const live = list.filter((record) => record && record.deleted !== true && typeof record.id === 'string')
            setRecords(live)
            if (typeof reportError === 'function') reportError('')
          } catch (error) {
            setRecords([])
            if (typeof reportError === 'function') reportError(humanizeError(error))
          } finally {
            setLoading(false)
          }
        }, [bookHash, reportError])

        useEffect(() => {
          reload()
        }, [reload])

        /** 写入一条记录：宿主补 updatedAt，成功后本地立刻替换，避免全量重读。 */
        const put = useCallback(async (record) => {
          const value = await call('ann.put', { bookHash, record })
          const saved = value && value.record ? value.record : record
          setRecords((prev) => {
            const index = prev.findIndex((item) => item.id === saved.id)
            if (index < 0) return [...prev, saved]
            const next = prev.slice()
            next[index] = saved
            return next
          })
          return saved
        }, [bookHash])

        /** 删一条：宿主写墓碑，本地立刻移除（不重读整个列表）。 */
        const remove = useCallback(async (id) => {
          await call('ann.delete', { bookHash, id })
          setRecords((prev) => prev.filter((item) => item.id !== id))
        }, [bookHash])

        /**
         * 乐观删除：先把本地那条拿掉，宿主失败时由调用方用 restoreLocal 放回。
         *
         * 为什么要乐观：删除要走宿主协议往返，jsdom/慢机器上能到上百毫秒；
         * 用户点「删除」后高亮还在屏幕上闪一下，会以为没删掉又点一次。
         */
        const removeLocal = useCallback((id) => {
          setRecords((prev) => prev.filter((item) => item.id !== id))
        }, [])

        /** 撤销删除 / 失败回滚：按原字段再 put 一次（宿主是 upsert，墓碑会被覆盖回去）。 */
        const restoreLocal = useCallback(async (record) => {
          if (!record || typeof record.id !== 'string') return null
          return put(record)
        }, [put])

        /** 改颜色：只改本地那一条，走同一条 put 路径。 */
        const updateColor = useCallback(async (id, color) => {
          const target = records.find((item) => item.id === id)
          if (!target) return
          if (!HIGHLIGHT_COLORS[color]) return
          await put({ ...target, color })
        }, [put, records])

        /**
         * 从真实选区造一条高亮。
         *
         * 记录的字段装配全部交给 contract.makeHighlight/makeNote：
         * 那里面做硬校验（cfi 必须是区间形态、textExcerpt 与 textFingerprint 必填、deviceId 必填），
         * 缺一个就 throw。这里**不兜底**——存一条没有锚点的划线，等于存了一条永远找不回来的数据。
         *
         * 失败行为：抛 Error，message 已中文化，由调用方显示。
         */
        const addHighlight = useCallback(async ({ range, text, chapterHref, spineIndex, color, note }) => {
          const win = opts.frameWin
          const chosen = HIGHLIGHT_COLORS[color] ? color : 'yellow'
          const excerpt = typeof text === 'string' ? text : ''
          if (excerpt.trim() === '') throw new Error('没有选中文字，先划一段再存。')
          if (!win || !range) throw new Error('书籍还没加载完，稍等一下再划。')
          if (typeof deviceId !== 'string' || deviceId === '') {
            throw new Error('还没拿到这台设备的标识，稍等两秒再试一次。')
          }

          let cfi = ''
          try {
            cfi = CFI.fromRange(win, range, { index: spineIndex })
          } catch (error) {
            throw new Error('这段文字的位置算不出来，换一段再试。')
          }

          const truncated = truncateForContract(excerpt)
          const fields = {
            cfi,
            chapterHref,
            textExcerpt: truncated.text,
            textFingerprint: fingerprint(excerpt),
            color: chosen,
            deviceId,
          }
          if (truncated.truncated) fields.textExcerptTruncated = true

          const record = typeof note === 'string' && note !== ''
            ? makeNote({ ...fields, note: note.slice(0, 8 * 1024) })
            : makeHighlight(fields)

          return put(record)
        }, [deviceId, opts.frameWin, put])

        /** 给已有划线加一段笔记：保留原锚点与颜色，只补 note 并把类型升为 note。 */
        const addNote = useCallback(async ({ anchorRecordId, noteText }) => {
          const target = records.find((item) => item.id === anchorRecordId)
          if (!target) throw new Error('找不到这条划线，它可能已经被删掉了。')
          const text = typeof noteText === 'string' ? noteText.trim() : ''
          if (text === '') throw new Error('笔记是空的。')
          if (typeof deviceId !== 'string' || deviceId === '') {
            throw new Error('还没拿到这台设备的标识，稍等两秒再试一次。')
          }
          const record = makeNote({
            cfi: target.cfi,
            chapterHref: target.chapterHref,
            textExcerpt: target.textExcerpt,
            textFingerprint: target.textFingerprint,
            color: target.color,
            note: text.slice(0, 8 * 1024),
            deviceId,
          })
          return put(record)
        }, [deviceId, put, records])

        /**
         * 书签：点锚点，不带文本指纹。
         * 失败（cfi 为空 / 不是完整 CFI / deviceId 缺失）抛 Error。
         */
        const addBookmark = useCallback(async ({ cfi, cfiStart, chapterHref, label }) => {
          if (typeof cfi !== 'string' || cfi === '') throw new Error('现在拿不到当前位置，稍等一下再试。')
          if (typeof deviceId !== 'string' || deviceId === '') {
            throw new Error('还没拿到这台设备的标识，稍等两秒再试一次。')
          }
          const record = makeBookmark({
            cfi,
            chapterHref,
            label: typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 200) : '书签',
            deviceId,
          })
          return put(record)
        }, [deviceId, put])

        return {
          records,
          loading,
          quarantined,
          reload,
          addHighlight,
          addNote,
          addBookmark,
          remove,
          removeLocal,
          restoreLocal,
          updateColor,
        }
      }

      /** 摘录截断走契约同一实现：截断是展示层决定，不能偷偷改变参与指纹的文本。 */
      function truncateForContract(text) {
        const chars = Array.from(text)
        if (chars.length <= 512) return { text, truncated: false }
        return { text: chars.slice(0, 512).join(''), truncated: true }
      }

      /**
       * 选区矩形（书籍视口坐标）→ 父窗口坐标。**纯函数，坐标换算的唯一实现。**
       *
       * 为什么这条换算必须只写一遍：这是 0.3.x 最招人恨的 bug 的现场。
       * 曾经在调用点写成 `iframeRect.left + rect.left - pageOffset`，看起来天经地义
       * （「正文被 translateX 推走了 offset，得加回来」），但 `range.getBoundingClientRect()`
       * 与 `getClientRects()` 返回的都是**变换后**的视觉矩形，CSS transform 已经在里面了。
       * 于是翻了 N 页就多减 N 个页宽：选区菜单越往后离文字越远，
       * 第 1 页看着还挺准，第 10 页偏出去一屏——难点在于它不报错，只是错位。
       *
       * @param {object} input
       * @param {{left:number, top:number, width:number, height:number}} input.rangeRect  range.getBoundingClientRect()（已含翻页位移）
       * @param {{left:number, top:number}|null} [input.frameBox]   iframe 在父窗口里的位置
       * @param {{left:number, top:number}|null} [input.layerBox]   覆盖层原点；两者都缺省按 0 算（视口坐标）
       * @param {number} [input.pageOffset]  当前翻页位移。**不参与换算**，只为让「页码变了要重算」这件事显式
       * @returns {{left:number, top:number, width:number, height:number}}
       */
      function rangeRectToMenuBase(input) {
        const src = input && input.rangeRect ? input.rangeRect : null
        if (!src) return { left: 0, top: 0, width: 0, height: 0 }
        const frameBox = input.frameBox || null
        const layerBox = input.layerBox || null
        // 先落到父窗口视口坐标（加 iframe 位置），再减覆盖层原点（覆盖层 div 自己也在布局里）。
        const originX = (frameBox ? frameBox.left : 0) - (layerBox ? layerBox.left : 0)
        const originY = (frameBox ? frameBox.top : 0) - (layerBox ? layerBox.top : 0)
        // pageOffset 只读出来、不做减法：留着它，调用方的依赖数组才不会把它当死参数删掉。
        void (Number.isFinite(input.pageOffset) ? input.pageOffset : 0)
        return {
          left: originX + (Number(src.left) || 0),
          top: originY + (Number(src.top) || 0),
          width: Math.max(0, Number(src.width) || 0),
          height: Math.max(0, Number(src.height) || 0),
        }
      }

      /** 选区菜单的高度与离选区的间距（px）。改这里等于改 .dr-menu 的尺寸，两处要一起看。 */
      const SELECTION_MENU_HEIGHT = 36
      const SELECTION_MENU_GAP = 8
      const MENU_EDGE = 8

      /**
       * 选区菜单该摆在哪。**纯函数**，输入选区矩形，输出菜单盒子（父窗口坐标）。
       *
       * 菜单优先放在选区正上方；上方放不下（选区贴着视口顶）就翻到下方，
       * 因为「盖住刚划的那行字」比「偏一点」更烦人。水平居中，再夹回视口内。
       */
      function placeSelectionMenu(rect, opts) {
        const box = rect || { left: 0, top: 0, width: 0, height: 0 }
        const options = opts || {}
        const menuWidth = Number.isFinite(options.menuWidth) ? options.menuWidth : 268
        const menuHeight = Number.isFinite(options.menuHeight) ? options.menuHeight : SELECTION_MENU_HEIGHT
        const viewportWidth = Number.isFinite(options.viewportWidth) ? options.viewportWidth : 1024
        const viewportHeight = Number.isFinite(options.viewportHeight) ? options.viewportHeight : 768
        const gap = Number.isFinite(options.gap) ? options.gap : SELECTION_MENU_GAP

        const centered = box.left + box.width / 2 - menuWidth / 2
        const maxLeft = viewportWidth - menuWidth - MENU_EDGE
        const left = Math.max(MENU_EDGE, Math.min(Math.max(MENU_EDGE, maxLeft), centered))

        let top = box.top - gap - menuHeight
        if (top < MENU_EDGE) top = box.top + box.height + gap
        const maxTop = viewportHeight - menuHeight - MENU_EDGE
        top = Math.max(MENU_EDGE, Math.min(Math.max(MENU_EDGE, maxTop), top))

        return { left, top, width: menuWidth, height: menuHeight }
      }

      /* ─────────────────────────────────────────────────────────────
         点高亮 / 重叠判定 / 不叠色：纯函数区。

         `computeRects` 保留「一条记录 = 若干原始矩形」的语义不动（测试靠它数盒子），
         裁剪（flattenBoxes）只在 Overlayer 渲染时做。这样正文结构与记录语义都不变，
         换来的只是同一像素永远只被一条记录画一次——重叠不再叠色。

         出处：foliate-js/pkg/overlayer.js:34-42（hitTest 逆序遍历 rect，后加在上）、
         web-highlighter/src/painter/dom.ts:274-291（重叠拆分，先画的让位给后画的）。
         ───────────────────────────────────────────────────────────── */

      /**
       * Range.compareBoundaryPoints 的常量，**名字按实际语义写**。
       *
       * 这几个常量的官方名字是反的（MDN 也照样误导人）：`START_TO_END` 实际比较的是
       * 「本段的 end」与「对方段的 start」。无头 Chrome 与 jsdom 都实测过这张表，
       * 名字按实测语义写，省得下一次又踩：
       *   END_VS_START(1)  = this.end   vs source.start
       *   START_VS_END(3)  = this.start vs source.end
       *   START_VS_START(0) / END_VS_END(2) 名实相符
       */
      const CMP = { START_VS_START: 0, END_VS_START: 1, END_VS_END: 2, START_VS_END: 3 }

      /**
       * 两个 Range 的相对位置。**纯函数**，只读 Range，不动 DOM。
       *
       * 首尾相接（a.end === b.start 或 a.start === b.end）必须判 disjoint：
       * 用户挨着上一句接着划，是正常操作，不能报「重叠」。
       *
       * @returns {'disjoint'|'partial'|'contains'|'inside'|'equal'|'other-section'}
       *   contains = a 包住 b；inside = a 在 b 里面。
       */
      function relateRanges(a, b) {
        if (!a || !b) return 'disjoint'
        // 跨章节的 Range 没有可比性：浏览器不等，jsdom 会直接抛。
        try {
          const docA = a.startContainer && a.startContainer.ownerDocument
          const docB = b.startContainer && b.startContainer.ownerDocument
          if (docA && docB && docA !== docB) return 'other-section'
        } catch (err) {
          return 'disjoint'
        }

        let startVsEnd
        let endVsStart
        try {
          startVsEnd = a.compareBoundaryPoints(CMP.START_VS_END, b)
          endVsStart = a.compareBoundaryPoints(CMP.END_VS_START, b)
        } catch (err) {
          return 'disjoint'
        }
        if (startVsEnd >= 0) return 'disjoint' // a.start >= b.end：a 整段在 b 后面（含首尾相接）
        if (endVsStart <= 0) return 'disjoint' // a.end <= b.start：a 整段在 b 前面（含首尾相接）

        const startVsStart = a.compareBoundaryPoints(CMP.START_VS_START, b)
        const endVsEnd = a.compareBoundaryPoints(CMP.END_VS_END, b)
        if (startVsStart === 0 && endVsEnd === 0) return 'equal'
        if (startVsStart <= 0 && endVsEnd >= 0) return 'contains'
        if (startVsStart >= 0 && endVsEnd <= 0) return 'inside'
        return 'partial'
      }

      /**
       * 选中一条记录（双击 / 跳回高亮用）。**唯一写选区的入口**，别在调用点再写一遍。
       *
       * 出处：foliate-js/pkg/overlayer.js:3-8 用 range 直接 addRange；
       * 比手拼 caretRangeFromPoint 稳——记录里的 CFI 已经换算过三本书三种起点。
       *
       * @returns {Range|null} 换算不出来时返回 null，调用方负责给中文提示
       */
      function selectRecord(frameWin, frameDoc, record) {
        if (!frameWin || !frameDoc || !record) return null
        let range = null
        try {
          range = resolveCached(frameWin, frameDoc, record.cfi)
        } catch (err) {
          range = null
        }
        if (!range) return null
        let selection = null
        try {
          selection = typeof frameWin.getSelection === 'function' ? frameWin.getSelection() : null
        } catch (err) {
          selection = null
        }
        if (!selection) return null
        selection.removeAllRanges()
        selection.addRange(range)
        try {
          frameWin.focus()
        } catch (err) {
          // 无头环境没有焦点，忽略
        }
        return range
      }

      /**
       * 新选段跟本书已有记录撞不撞。**纯函数**（只读 frameDoc/frameWin 换算 Range）。
       *
       * @returns {Array<{record:object, kind:string}>} kind ∈ contains/inside/partial
       */
      function findOverlap(frameWin, frameDoc, records, range, chapterHref) {
        const conflicts = []
        if (!range || !Array.isArray(records)) return conflicts
        for (const record of records) {
          if (!record || record.deleted === true) continue
          if (typeof chapterHref === 'string' && chapterHref !== '' && record.chapterHref !== chapterHref) continue
          let other = null
          try {
            other = resolveCached(frameWin, frameDoc, record.cfi)
          } catch (err) {
            other = null
          }
          if (!other) continue
          const kind = relateRanges(range, other)
          if (kind === 'contains' || kind === 'inside' || kind === 'partial') {
            conflicts.push({ record, kind })
          }
        }
        return conflicts
      }

      /**
       * 矩形差集：base 减去 cut，返回 0~4 块 `{left, top, right, bottom}`。**纯函数**。
       *
       * 这是「后画的把先画的切掉」那一步的最小实现：
       * 重叠部分整块让给后画者，先画者剩下的边角继续可见，不会被新色盖深。
       */
      function subtractRect(base, cut) {
        if (!base) return []
        if (!cut) return [base]
        const left = Math.max(base.left, cut.left)
        const top = Math.max(base.top, cut.top)
        const right = Math.min(base.right, cut.right)
        const bottom = Math.min(base.bottom, cut.bottom)
        if (right <= left || bottom <= top) return [base] // 不相交，原样返回

        const parts = []
        if (cut.left > base.left) parts.push({ left: base.left, top: base.top, right: cut.left, bottom: base.bottom })
        if (cut.right < base.right) parts.push({ left: cut.right, top: base.top, right: base.right, bottom: base.bottom })
        const midWidthStart = Math.max(base.left, cut.left)
        const midWidthEnd = Math.min(base.right, cut.right)
        if (cut.top > base.top) parts.push({ left: midWidthStart, top: base.top, right: midWidthEnd, bottom: cut.top })
        if (cut.bottom < base.bottom) parts.push({ left: midWidthStart, top: cut.bottom, right: midWidthEnd, bottom: base.bottom })
        return parts
      }

      /**
       * 把「一条记录可能有多个矩形」的原始盒子裁成互不重叠的绘制盒。**纯函数**。
       *
       * 输入必须按绘制顺序（旧→新）排好；后画的盒子会把先画的切掉，交集归后画的。
       * 输出的每个盒子都带 `record` 与 `key`，点击时才能反查到是哪一条。
       */
      function flattenBoxes(boxes) {
        // 已画区域：{left, top, right, bottom, source}，source 指向产生它的原始盒子。
        let painted = []
        for (const box of boxes || []) {
          if (!box) continue
          const cover = {
            left: Number(box.left) || 0,
            top: Number(box.top) || 0,
            right: (Number(box.left) || 0) + (Number(box.width) || 0),
            bottom: (Number(box.top) || 0) + (Number(box.height) || 0),
          }
          // 后画的把先画的切掉：新的盖住哪块，老的那块就少哪块。
          const next = []
          for (const part of painted) next.push(...subtractRect(part, cover).map((rest) => ({ ...rest, source: part.source })))
          next.push({ ...cover, source: box })
          painted = next
        }
        return painted.map((part, index) => ({
          ...part.source,
          left: part.left,
          top: part.top,
          width: Math.max(0, part.right - part.left),
          height: Math.max(0, part.bottom - part.top),
          key: `${part.source.key}#${index}`,
        }))
      }

      /** 命中测试：点在哪个绘制盒上。逆序 = 后画的在上，与视觉叠放顺序一致。**纯函数**。 */
      function hitBox(boxes, x, y) {
        for (let i = (boxes || []).length - 1; i >= 0; i -= 1) {
          const box = boxes[i]
          if (!box) continue
          if (x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height) return box
        }
        return null
      }

      /**
       * 把记录换算成覆盖层矩形。**纯函数，不碰 DOM 的写入端。**
       *
       * 这个函数值得单独存在，有两个理由：
       *   1. 它是「不改正文也能画高亮」的证明 —— 测试可以直接调它，
       *      在加 50 条标注前后各算一次，断言正文 XML 序列化一字不差；
       *   2. 它只读 `range.getClientRects()`，从不 insert/append/替换任何节点。
       *      覆盖层要真改 DOM 的话，只能改**父窗口**里自己那层 div。
       *
       * 输入里的 rect 是 `range.getClientRects()` 的结果，即**已含翻页 transform 的视觉坐标**
       * （相对 iframe 视口左上角）。输出是覆盖层自己坐标系里的位置。
       *
       * @param {object} opts
       * @param {Document} opts.frameDoc  书籍文档
       * @param {Window} opts.frameWin    书籍窗口（filter / Range 需要）
       * @param {Array} opts.records      已过滤的记录
       * @param {{left:number, top:number}} [opts.layerBox]   覆盖层原点
       * @param {{left:number, top:number}} [opts.frameBox]   iframe 在父窗口里的位置
       * @param {number} [opts.pageOffsetPx]                  当前翻页位移（仅作重算触发，不参与换算）
       * @param {number} [opts.minWidth]                      片段最小宽度（视觉上至少看得见）
       * @returns {{boxes:Array, broken:Array<{record:object, code:string}>}}
       */
      function computeRects(opts) {
        const frameDoc = opts.frameDoc
        const frameWin = opts.frameWin
        const records = Array.isArray(opts.records) ? opts.records : []
        const layerBox = opts.layerBox || { left: 0, top: 0 }
        const frameBox = opts.frameBox || { left: layerBox.left, top: layerBox.top }
        // pageOffsetPx 不再参与坐标换算（见下面 boxes.push 处的注释），但仍然被读取一次：
        // 它让「页码变了」这件事成为调用方依赖的一部分，也避免参数变成死参数。
        void opts.pageOffsetPx
        const minWidth = Number.isFinite(opts.minWidth) ? opts.minWidth : 2

        const boxes = []
        const broken = []
        if (!frameDoc || !frameWin) return { boxes, broken }

        for (const record of records) {
          if (!record || record.deleted === true) continue
          const isBookmark = record.type === 'bookmark'
          const cfi = typeof record.cfi === 'string' ? record.cfi : ''
          if (cfi === '') continue

          let range = null
          try {
            range = resolveCached(frameWin, frameDoc, cfi)
          } catch (error) {
            broken.push({ record, code: error && error.code ? error.code : 'cfi_resolve_failed' })
            continue
          }
          if (!range) continue

          const style = colorStyle(record.color)
          const rects = range.getClientRects()
          if (!rects || rects.length === 0) {
            // 书签没有矩形（它本来就是零宽的点）时**什么都不画**。老实现会给它补一个
            // 假的 {0,0,10,14}，结果每次翻页都在页面左上角画一个小方块，看起来像
            // 「有东西坏了」而不是像一枚书签。书签的存在感由侧栏列表负责。
            if (isBookmark) continue
            broken.push({ record, code: 'cfi_offset_out_of_bounds' })
            continue
          }

          const isNote = record.type === 'note' || (typeof record.note === 'string' && record.note !== '')
          const count = rects.length

          for (let i = 0; i < count; i += 1) {
            const rect = rects[i]
            if (rect.width < 0.5 && rect.height < 0.5) continue
            // 坐标换算：iframe 视口坐标 → 父窗口坐标 → 覆盖层局部坐标。
            // **不减翻页位移**（rect 已含 transform，理由见 rangeRectToMenuBase 注释）。
            // 换算本体只有一处实现，选区菜单走同一个函数，改一处两处都对。
            const base = rangeRectToMenuBase({ rangeRect: rect, frameBox, layerBox })

            // 裁剪到「页」的边界：一段跨栏的文字，浏览器给出的矩形会从本栏末尾一直延伸到
            // 下一栏（甚至伸出 iframe），不裁就会画到正文外、压到侧栏和翻页热区上。
            //
            // 但**只在这张页有真实尺寸时才裁**：量不到 frameBox 的尺寸（单元测试的假 DOM、
            // 或者框架还没上屏）时，裁剪会把所有盒子裁成 0 个 —— 那等于「什么都没画」，
            // 比画到页外更糟。所以这种情形退回不裁。
            const pageWidth = Number(frameBox.width)
            const pageHeight = Number(frameBox.height)
            const canClip = Number.isFinite(pageWidth) && pageWidth > 0 && Number.isFinite(pageHeight) && pageHeight > 0
            const pageLeft = frameBox.left - layerBox.left
            const pageTop = frameBox.top - layerBox.top
            const clippedLeft = canClip ? Math.max(base.left, pageLeft) : base.left
            const clippedTop = canClip ? Math.max(base.top, pageTop) : base.top
            const clippedRight = canClip
              ? Math.min(base.left + Math.max(0, rect.width), pageLeft + pageWidth)
              : base.left + Math.max(0, rect.width)
            const clippedBottom = canClip
              ? Math.min(base.top + Math.max(0, rect.height), pageTop + pageHeight)
              : base.top + Math.max(0, rect.height)
            const clippedWidth = clippedRight - clippedLeft
            const clippedHeight = clippedBottom - clippedTop
            // 完全在页外（多半是「下一栏的那一段」）→ 这一页不该画它。
            if (clippedWidth < 0.5 || clippedHeight < 0.5) continue

            boxes.push({
              key: `${record.id}:${i}`,
              record,
              left: clippedLeft,
              top: clippedTop,
              width: Math.max(minWidth, clippedWidth),
              height: Math.max(isBookmark ? 10 : 4, clippedHeight),
              fill: style.fill,
              stroke: style.stroke,
              isNote,
              isBookmark,
            })
          }
        }

        return { boxes, broken }
      }

      /**
       * CFI → Range 的**按文档缓存**（docs/03 §七：单章 >100 条标注必须缓存）。
       *
       * 为什么必须有：`toRange` 每次都要重新 parse CFI、跑一遍结构预检、再让 vendor 从
       * documentElement 逐层下降。实测 1000 次约 3.6 s；翻页会整层重绘，等于再算一遍，
       * 用户看到的就是「翻一页卡半秒」。缓存命中后同一条记录只算一次。
       *
       * 为什么只缓存 Range、不缓存矩形：矩形依赖当前排版与翻页位移，必须每次重量；
       * Range 只依赖 DOM 结构，而这份文档在换章之前不会变。**换章就是新 Document 对象**，
       * WeakMap 的键随之失效，天生不用手工清。
       *
       * 容量上限只是保险：正常一章几十条记录；超过 4000 条说明调用方在灌随机 CFI，
       * 那种情况宁可丢缓存也不要无限涨。
       */
      const rangeCache = new WeakMap()
      const RANGE_CACHE_LIMIT = 4000

      function resolveCached(frameWin, frameDoc, cfi) {
        let byCfi = rangeCache.get(frameDoc)
        if (!byCfi) {
          byCfi = new Map()
          rangeCache.set(frameDoc, byCfi)
        }
        const hit = byCfi.get(cfi)
        if (hit) return hit
        const range = CFI.toRange(frameWin, frameDoc, cfi)
        if (byCfi.size >= RANGE_CACHE_LIMIT) byCfi.clear()
        byCfi.set(cfi, range)
        return range
      }

      /**
       * 覆盖层：把每条记录画成一组绝对定位 div（画在**父窗口**，不碰书籍 DOM）。
       *
       * props:
       *   records      —— 已过滤的记录
       *   frameWin     —— 书籍窗口
       *   frameDoc     —— 书籍文档
       *   frameEl      —— iframe 元素（量位置用）
       *   pageOffsetPx —— 当前翻页位移（正数；会从这里减去）
       *   containerEl  —— 覆盖层的父容器（原点）
       *   repaintKey   —— 外部变化信号（翻页 / 尺寸），变一次重算一次
       *   onBadAnchor(record, code) —— 解析失败，交给上层计数
       *
       * 每次重算都整层重建，不做增量：覆盖层的 div 很轻（一条高亮最多十几个），
       * 增量更新换不来可感知的收益，却会引入「旧 div 忘了删」这类脏状态。
       */
      function Overlayer(props) {
        const layerRef = useRef(null)
        const [boxes, setBoxes] = useState([])
        const [tick, setTick] = useState(0)

        const records = props.records
        const pageOffset = props.pageOffsetPx
        const frameDoc = props.frameDoc
        const frameWin = props.frameWin
        const repaintKey = props.repaintKey

        // 容器尺寸变化（窗口缩放 / 侧栏开关）也要重算
        useEffect(() => {
          const target = props.containerEl || layerRef.current
          if (!target || typeof ResizeObserver === 'undefined') return undefined
          const observer = new ResizeObserver(() => setTick((n) => n + 1))
          observer.observe(target)
          return () => observer.disconnect()
        }, [props.containerEl])

        useEffect(() => {
          const layer = layerRef.current
          if (!layer || !frameDoc || !frameWin) {
            setBoxes([])
            return
          }

          // 绘制顺序 = 记录创建顺序（旧→新），与「后加的盖在上面」一致；
          // computeRects 仍按传入顺序吐原始盒子，裁剪留给 flattenBoxes。
          const ordered = Array.isArray(records)
            ? records.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
            : []

          const result = computeRects({
            frameDoc,
            frameWin,
            records: ordered,
            layerBox: layer.getBoundingClientRect(),
            frameBox: props.frameEl ? props.frameEl.getBoundingClientRect() : null,
            pageOffsetPx: pageOffset,
          })

          // 书签是透明竖线，不参与裁剪也不该被别人切出缺口，原样保留。
          const highlights = result.boxes.filter((box) => !box.isBookmark)
          const bookmarks = result.boxes.filter((box) => box.isBookmark)
          setBoxes(flattenBoxes(highlights).concat(bookmarks))

          if (typeof props.onBadAnchor === 'function') {
            if (result.broken.length === 0) {
              props.onBadAnchor(null, '')
            } else {
              for (const item of result.broken) props.onBadAnchor(item.record, item.code)
            }
          }
        }, [records, pageOffset, frameDoc, frameWin, props.frameEl, props.onBadAnchor, repaintKey, tick])

        const activeId = props.activeId || null
        const conflictIds = Array.isArray(props.conflictIds) ? props.conflictIds : []

        const activate = (box, event) => {
          if (typeof props.onActivate !== 'function') return
          const el = event && event.currentTarget ? event.currentTarget : null
          const rect = el && typeof el.getBoundingClientRect === 'function'
            ? el.getBoundingClientRect()
            : { left: box.left, top: box.top, width: box.width, height: box.height }
          props.onActivate(box.record, rect)
        }

        return h(
          'div',
          { className: 'dr-overlay', ref: layerRef, role: 'group', 'aria-label': '我的划线' },
          boxes.map((box) => h('div', {
            key: box.key,
            className: [
              'dr-hl',
              // 颜色也做成类名：夜间主题下内联的浅色底几乎看不见，style.js 用
              // .dr-hl-<color> + 主题变量覆盖背景与描边（见 style.js 的「变量优先」注释）。
              box.record && box.record.color ? `dr-hl-${box.record.color}` : '',
              box.isNote ? 'dr-hl-note' : '',
              !box.isBookmark && box.record && box.record.id === activeId ? 'dr-hl-active' : '',
              !box.isBookmark && box.record && conflictIds.indexOf(box.record.id) !== -1 ? 'dr-hl-conflict' : '',
            ].filter(Boolean).join(' '),
            title: excerptOf(box.record.textExcerpt || box.record.label || '', 120),
            role: box.isBookmark ? 'presentation' : 'button',
            tabIndex: box.isBookmark ? -1 : 0,
            'aria-label': box.isBookmark ? null : `划线：${excerptOf(box.record.textExcerpt || box.record.label || '', 80)}；回车打开操作，Delete 删除，双击选中文字`,
            'aria-pressed': box.isBookmark ? null : box.record && box.record.id === activeId ? 'true' : 'false',
            'data-key': box.record ? box.record.id : null,
            style: {
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              height: box.isBookmark ? `${Math.max(12, box.height)}px` : `${box.height}px`,
              background: box.isBookmark ? 'transparent' : box.fill,
              boxShadow: box.isBookmark ? 'none' : `inset 0 -1px 0 ${box.stroke}`,
              borderLeft: box.isBookmark ? `2px solid ${box.stroke}` : 'none',
              pointerEvents: box.isBookmark ? 'none' : undefined,
            },
            onClick: box.isBookmark ? undefined : (event) => {
              // preventDefault + stopPropagation：不让点击冒泡到宿主文档
              // （app.js 的「点空白收起浮层」会把它当成点外面，刚打开的操作条立刻又被关掉）。
              event.preventDefault()
              event.stopPropagation()
              activate(box, event)
            },
            onDoubleClick: box.isBookmark ? undefined : (event) => {
              event.preventDefault()
              event.stopPropagation()
              if (typeof props.onSelectText === 'function') props.onSelectText(box.record)
            },
            onKeyDown: box.isBookmark ? undefined : (event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault()
                event.stopPropagation()
                activate(box, event)
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault()
                event.stopPropagation()
                if (typeof props.onDelete === 'function') props.onDelete(box.record)
              } else if (event.key === 'Escape') {
                event.stopPropagation()
                if (typeof props.onDismiss === 'function') props.onDismiss()
              }
            },
          })),
        )
      }

      /**
       * 划线操作条：点高亮后出现（单条记录的颜色 / 笔记 / 问 AI / 删除）。
       *
       * 为什么不复用 SelectionMenu：两者的锚点不同——SelectionMenu 跟着「刚选中的文字」，
       * 这个跟着「已经存在的那条记录」，而且要多一个删除。共用 .dr-menu 的样式与摆位函数。
       *
       * props:
       *   record   —— 当前记录（ann.list 的形状）
       *   rect     —— 记录在父窗口里的矩形（overlayer 点击时拿到）
       *   onColor(color) / onNote() / onAsk() / onDelete() / onClose()
       */
      function AnnotationMenu(props) {
        const record = props.record
        if (!record) return null
        const rect = props.rect || { left: 0, top: 0, width: 0, height: 0 }
        const menuWidth = HIGHLIGHT_ORDER.length * 24 + 236
        const menuBox = placeSelectionMenu(rect, {
          menuWidth,
          viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 1024,
          viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 768,
        })

        return h(
          'div',
          {
            className: 'dr-menu dr-ann-menu',
            role: 'toolbar',
            'aria-label': '划线操作',
            style: { left: `${menuBox.left}px`, top: `${menuBox.top}px` },
            onMouseDown: (event) => event.preventDefault(),
          },
          HIGHLIGHT_ORDER.map((color) => h('button', {
            key: color,
            type: 'button',
            className: `dr-swatch${record.color === color ? ' dr-swatch-on' : ''}`,
            title: `改成${HIGHLIGHT_COLORS[color].label}色`,
            'aria-label': `改成${HIGHLIGHT_COLORS[color].label}色`,
            'aria-pressed': record.color === color ? 'true' : 'false',
            style: { background: colorStyle(color).fill, borderColor: colorStyle(color).stroke },
            onClick: () => props.onColor(color),
          })),
          h('div', { className: 'dr-menu-sep' }),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: props.onNote, title: '给这条划线写笔记' },
            record.note ? '改笔记' : '笔记',
          ),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-primary dr-btn-sm dr-menu-ask', onClick: props.onAsk, title: '就这条划线的原文问 AI' },
            '问 AI',
          ),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm dr-btn-danger', onClick: props.onDelete, title: '删除这条划线（可撤销）' },
            '删除',
          ),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: props.onClose, title: '关闭' },
            '×',
          ),
        )
      }

      /**
       * 选区菜单：五色 + 记笔记 + 书签。
       *
       * 画在父窗口的 fixed 层上 —— 画进 iframe 会被裁切（书页边缘就是 iframe 边界）。
       *
       * props:
       *   selection  —— { rect, ... } 或 null；rect 是父窗口坐标系里的位置
       *   onHighlight(color)
       *   onNote()
       *   onBookmark()
       *   onDismiss()
       */
      function SelectionMenu(props) {
        const selection = props.selection
        if (!selection) return null

        const rect = selection.rect || { left: 0, top: 0, width: 0, height: 0 }
        // 摆位走纯函数（placeSelectionMenu）：这里只负责把「量得到的东西」给它，
        // 一旦再在调用点手写一次 -44 之类的偏移，就会重演「越翻越偏」的老 bug。
        const menuWidth = HIGHLIGHT_ORDER.length * 24 + 148
        const menuBox = placeSelectionMenu(rect, {
          menuWidth,
          viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 1024,
          viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 768,
        })
        const left = menuBox.left
        const top = menuBox.top

        return h(
          'div',
          {
            className: 'dr-menu',
            role: 'toolbar',
            'aria-label': '划线',
            style: { left: `${left}px`, top: `${top}px` },
            onMouseDown: (event) => event.preventDefault(),
          },
          HIGHLIGHT_ORDER.map((color) => h('button', {
            key: color,
            type: 'button',
            className: 'dr-swatch',
            title: `${HIGHLIGHT_COLORS[color].label}色`,
            'aria-label': `用${HIGHLIGHT_COLORS[color].label}色划线`,
            style: { background: colorStyle(color).fill, borderColor: colorStyle(color).stroke },
            onClick: () => props.onHighlight(color),
          })),
          h('div', { className: 'dr-menu-sep' }),
          // 「问 AI」放在划线色板之后、笔记之前：选完色最想做的第二件事就是问一句。
          h(
            'button',
            {
              type: 'button',
              className: 'dr-btn dr-btn-primary dr-btn-sm dr-menu-ask',
              onClick: props.onAsk,
              title: '就这段原文问 AI',
            },
            '问 AI',
          ),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: props.onNote },
            '笔记',
          ),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: props.onBookmark },
            '书签',
          ),
          h(
            'button',
            { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: props.onDismiss, title: '取消' },
            '×',
          ),
        )
      }

      /**
       * 笔记编辑浮层（点「笔记」后出现）。
       *
       * props: { rect, value, onChange, onSave, onCancel, saving, error }
       */
      function NoteEditor(props) {
        if (!props.rect) return null
        const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
        const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
        const width = 268
        const left = Math.max(8, Math.min(viewportWidth - width - 8, props.rect.left))
        const top = Math.max(8, Math.min(viewportHeight - 200, props.rect.top + 16))

        return h(
          'div',
          { className: 'dr-note-card', style: { left: `${left}px`, top: `${top}px` }, role: 'dialog', 'aria-label': '写笔记' },
          h('textarea', {
            className: 'dr-textarea',
            placeholder: '写点什么…（Ctrl+Enter 保存）',
            value: props.value,
            autoFocus: true,
            onChange: (event) => props.onChange(event.target.value),
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                props.onSave()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                props.onCancel()
              }
            },
          }),
          props.error ? h('div', { className: 'dr-error', style: { fontSize: '11.5px' } }, props.error) : null,
          h(
            'div',
            { className: 'dr-note-actions' },
            h('button', { type: 'button', className: 'dr-btn dr-btn-sm', onClick: props.onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-btn dr-btn-primary dr-btn-sm',
                disabled: props.saving === true,
                onClick: props.onSave,
              },
              props.saving === true ? '保存中…' : '保存',
            ),
          ),
        )
      }

      /**
       * 「问 AI」面板：贴着屏幕底部滑出，带原文摘要 + 上下文 + 输入框 + 回答。
       *
       * 0.4.0 的精修点（用户原话「问 AI 的界面更精细一点」）：
       *   - 引用原文默认两行、超出可展开（长段落不再把面板顶满）；
       *   - 书名 + 章节名做成胶囊，让用户知道这一问是在哪本书的哪一节；
       *   - 同一面板多轮追问：`继续追问` 只把焦点放回输入框，不清掉上一条回答
       *     （「新问题把上一条顶掉」是上一版最刺眼的毛病）；
       *   - 回答区自己滚动；加载是骨架 + 中文状态；错误是中文人话 + 原地重试；
       *   - 回答可复制、可存成这本书的一条笔记；
       *   - 面板宽度跟屏幕走，窄屏不横溢。
       *
       * props（与旧版兼容，可多传）:
       *   open / onClose / question / onChange(text) / onSubmit() / asking / error
       *   selection    —— { text, cfi, chapterHref, chapterLabel, bookTitle }
       *   answer       —— 当前这一轮的回答
       *   metaText     —— 「已保存到这本书的问答」这类补充说明
       *   round        —— 当前是第几轮（≥2 显示「第 N 轮」）
       *   bookHash     —— 存笔记用；不传则退回最近一次 useAnnotations 记住的书
       *   recordId     —— 打开的是历史里哪一条（变化时重置展开/提示状态）
       *   onNewQuestion() —— 「继续追问」：父组件清空输入并保持上一条回答
       *   onCopy(text) —— 自定义复制实现（默认 navigator.clipboard）
       *   onSaveNote({ question, answer, selection }) —— 自定义存笔记（默认写 ann.put）
       */
      function AskPanel(props) {
        const open = props.open === true
        const selection = props.selection && typeof props.selection === 'object' ? props.selection : null
        const excerpt = String(selection && selection.text ? selection.text : '').trim()
        const turns = Array.isArray(props.turns)
          ? props.turns.filter((turn) => turn && typeof turn.answer === 'string' && turn.answer.trim() !== '')
          : []
        const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
        const answer = typeof props.answer === 'string' && props.answer.trim() !== ''
          ? props.answer.trim()
          : (lastTurn ? lastTurn.answer.trim() : '')
        const question = typeof props.question === 'string' ? props.question : ''
        const chapterLabel = selection && typeof selection.chapterLabel === 'string' ? selection.chapterLabel : ''
        const bookTitle = selection && typeof selection.bookTitle === 'string' ? selection.bookTitle : ''
        const round = Number.isFinite(props.round)
          ? Math.max(1, Math.floor(props.round))
          : (turns.length > 0 ? turns.length : (answer === '' ? 0 : 1))
        const quoteLong = excerpt.length > 72 || excerpt.split('\n').filter((line) => line.trim() !== '').length > 2
        const canSave = answer !== '' && !!selection && !!selection.cfi && !!selection.chapterHref && !!excerpt

        const [expanded, setExpanded] = useState(false)
        const [saving, setSaving] = useState(false)
        const [phase, setPhase] = useState('')
        const [notice, setNotice] = useState('')
        const [focusTick, setFocusTick] = useState(0)
        const inputRef = useRef(null)
        const recordKey = props.recordId || (selection && selection.cfi) || ''

        // 换一条记录 / 重新打开：收起原文、清掉上一条的「已复制 / 已存」提示
        useEffect(() => {
          if (!open) return
          setExpanded(false)
          setSaving(false)
          setPhase('')
          setNotice('')
        }, [open, recordKey])

        // 打开即聚焦输入框（「继续追问」也走这里把焦点拉回来）
        useEffect(() => {
          if (!open) return undefined
          const timer = setTimeout(() => {
            const node = inputRef.current
            if (node && typeof node.focus === 'function') node.focus()
          }, 30)
          return () => clearTimeout(timer)
        }, [open, focusTick])

        if (!open) return null

        /** 复制回答：优先剪贴板，失败给中文提示，不假装成功。 */
        const copyAnswer = async () => {
          if (answer === '') return
          let copied = false
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(answer)
              copied = true
            }
          } catch (error) {
            copied = false
          }
          if (!copied && typeof props.onCopy === 'function') {
            try {
              props.onCopy(answer)
              copied = true
            } catch (error) {
              copied = false
            }
          }
          setPhase(copied ? 'copied' : '')
          setNotice(copied ? '回答已复制' : '这个环境不让自动复制，请手动选中回答')
        }

        /** 存成笔记：默认写 ann.put（不新增 DOM、不改正文）。 */
        const saveAsNote = async () => {
          if (!canSave || saving) return
          if (typeof props.onSaveNote === 'function') {
            setSaving(true)
            try {
              await props.onSaveNote({ question, answer, selection })
              setPhase('saved')
              setNotice('已存成笔记，可在「划线笔记」里找到')
            } catch (error) {
              setNotice(humanizeError(error))
            } finally {
              setSaving(false)
            }
            return
          }
          const bookHash = typeof props.bookHash === 'string' && props.bookHash !== ''
            ? props.bookHash
            : lastBookHash
          if (bookHash === '') {
            setNotice('还没接上这本书，先复制回答保存吧')
            return
          }
          setSaving(true)
          try {
            const deviceId = await getDeviceId()
            const record = makeNote({
              cfi: selection.cfi,
              chapterHref: selection.chapterHref,
              textExcerpt: excerpt,
              textFingerprint: fingerprint(excerpt),
              color: HIGHLIGHT_ORDER[0],
              deviceId,
              note: `问：${question}\n\n答：${answer}`,
            })
            await call('ann.put', { bookHash, record })
            setPhase('saved')
            setNotice('已存成笔记，可在「划线笔记」里找到')
          } catch (error) {
            setNotice(humanizeError(error))
          } finally {
            setSaving(false)
          }
        }

        const followUp = () => {
          if (typeof props.onNewQuestion === 'function') props.onNewQuestion()
          setExpanded(false)
          setNotice('')
          setPhase('')
          setFocusTick((value) => value + 1)
        }

        return h(
          'div',
          { className: 'dr-ask-backdrop', role: 'presentation', onClick: props.onClose },
          h(
            'div',
            {
              className: 'dr-ask',
              role: 'dialog',
              'aria-label': '问 AI',
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'dr-ask-head' },
              h('span', { className: 'dr-ask-title' }, '问 AI'),
              round >= 2 ? h('span', { className: 'dr-chip dr-ask-round' }, `第 ${round} 轮`) : null,
              // AI 状态点：失败前就能看出「现在根本连不上」，不用先试一次再怀疑
              typeof props.onOpenAi === 'function'
                ? h(AiStatusChip, {
                  status: props.aiStatus,
                  probing: props.aiProbing === true,
                  onOpen: props.onOpenAi,
                })
                : null,
              h('button', {
                type: 'button',
                className: 'dr-icon-btn',
                title: '关闭（Esc）',
                'aria-label': '关闭',
                onClick: props.onClose,
              }, '×'),
            ),
            excerpt !== ''
              ? h(
                'div',
                { className: `dr-ask-quote${quoteLong && !expanded ? ' is-collapsed' : ''}` },
                h('div', { className: 'dr-ask-quote-text' }, excerpt),
                quoteLong
                  ? h('button', {
                    type: 'button',
                    className: 'dr-linkbtn dr-ask-quote-more',
                    onClick: () => setExpanded((value) => !value),
                  }, expanded ? '收起原文' : '展开全文')
                  : null,
              )
              : h('div', { className: 'dr-ask-quote dr-ask-quote-empty' }, '这一问没有选中原文，等于在问整节。'),
            bookTitle !== '' || chapterLabel !== ''
              ? h(
                'div',
                { className: 'dr-ask-context' },
                bookTitle !== '' ? h('span', { className: 'dr-chip dr-ask-chip' }, bookTitle) : null,
                bookTitle !== '' && chapterLabel !== '' ? h('span', { className: 'dr-ask-sep' }, '·') : null,
                chapterLabel !== '' ? h('span', { className: 'dr-chip dr-ask-chip' }, chapterLabel) : null,
              )
              : null,
            h('textarea', {
              className: 'dr-textarea dr-ask-input',
              placeholder: '想问什么？例如「这句话到底在说什么」「作者为什么这么写」',
              value: question,
              ref: inputRef,
              rows: 2,
              onChange: (event) => props.onChange(event.target.value),
              onKeyDown: (event) => {
                // Enter 直接发；Shift+Enter 换行（与聊天框的直觉一致）
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  props.onSubmit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  props.onClose()
                }
              },
            }),
            props.error
              ? h(
                'div',
                { className: 'dr-ask-error' },
                h('div', { className: 'dr-error' }, props.error),
                h('div', { className: 'dr-ask-error-hint' }, '问题还留着，可以直接再试一次；一直不行就看 AI 状态面板里的诊断。'),
                h('button', {
                  type: 'button',
                  className: 'dr-btn dr-btn-sm',
                  disabled: props.asking === true,
                  onClick: props.onSubmit,
                }, props.asking === true ? '正在重试…' : '重试'),
              )
              : null,
            // 这次调用带了什么：让用户知道「AI 看到的不是只有我圈的那一句」
            selection
              ? h('div', { className: 'dr-ask-context' },
                `本次携带：${bookTitle || '这本书'}${chapterLabel === '' ? '' : ` · ${chapterLabel}`} · 选区 ${excerpt.length} 字` +
                (Number.isFinite(props.surroundingChars) && props.surroundingChars > 0
                  ? ` · 上下文 ${props.surroundingChars} 字`
                  : ''),
              )
              : null,
            props.asking === true
              ? h(
                'div',
                { className: 'dr-ask-loading', role: 'status', 'aria-live': 'polite' },
                h('span', { className: 'dr-ask-skeleton' }),
                h('span', { className: 'dr-ask-skeleton' }),
                h('span', { className: 'dr-ask-skeleton dr-ask-skeleton-short' }),
                h('span', { className: 'dr-ask-loading-text' }, 'AI 正在读这段原文…'),
              )
              : null,
            // 多轮追问：每一轮都留在面板里，新问题不把上一条回答顶掉
            answer !== ''
              ? (turns.length > 1
                ? h(
                  'div',
                  { className: 'dr-ask-turns', 'aria-live': 'polite' },
                  turns.map((turn, index) => h(
                    'div',
                    { key: `${index}-${turn.question || ''}`, className: 'dr-ask-answer' },
                    h('div', { className: 'dr-ask-answer-label' }, `第 ${index + 1} 轮`),
                    typeof turn.question === 'string' && turn.question !== ''
                      ? h('div', { className: 'dr-ask-turn-question' }, turn.question)
                      : null,
                    h('div', { className: 'dr-ask-answer-text' }, turn.answer),
                  )),
                  props.metaText ? h('div', { className: 'dr-ask-answer-meta' }, props.metaText) : null,
                )
                : h(
                  'div',
                  { className: 'dr-ask-answer', 'aria-live': 'polite' },
                  h('div', { className: 'dr-ask-answer-label' }, round >= 2 ? `第 ${round} 轮回答` : '回答'),
                  h('div', { className: 'dr-ask-answer-text' }, answer),
                  props.metaText ? h('div', { className: 'dr-ask-answer-meta' }, props.metaText) : null,
                ))
              : null,
            notice !== '' ? h('div', { className: 'dr-ask-notice', role: 'status' }, notice) : null,
            h('div', { className: 'dr-ask-hint' }, '回答由宿主的子代理生成，不需要在这里配密钥。'),
            h(
              'div',
              { className: 'dr-ask-actions' },
              answer !== ''
                ? h('button', { type: 'button', className: 'dr-btn dr-btn-sm', onClick: followUp }, '继续追问')
                : null,
              answer !== ''
                ? h('button', { type: 'button', className: 'dr-btn dr-btn-sm', onClick: copyAnswer }, phase === 'copied' ? '已复制' : '复制回答')
                : null,
              canSave
                ? h('button', {
                  type: 'button',
                  className: 'dr-btn dr-btn-sm',
                  disabled: saving || phase === 'saved',
                  onClick: saveAsNote,
                }, phase === 'saved' ? '已存成笔记' : (saving ? '保存中…' : '存成笔记'))
                : null,
              h('button', { type: 'button', className: 'dr-btn dr-btn-sm', onClick: props.onClose }, '关闭'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-btn dr-btn-primary dr-btn-sm',
                  disabled: props.asking === true || question.trim() === '',
                  onClick: props.onSubmit,
                },
                props.asking === true ? '正在想…' : (answer !== '' ? '再问一次' : '问一下'),
              ),
            ),
          ),
        )
      }

      /**
       * 标注侧栏：这本书的全部划线 / 笔记 / 书签。
       *
       * props:
       *   records        —— 已过滤记录
       *   loading        —— 加载态
       *   error          —— humanizeError 过的文案
       *   quarantined    —— 隔离条数（有就显示一行说明，让用户知道「东西还在，只是没画出来」）
       *   onJump(record)
       *   onRemove(id)
       *   onUpdateColor(id, color)
       *   onAddBookmark() —— 在当前页加书签（可选）
       */
      /**
       * 把「一处命中」按章节或时间归组，返回扁平的行数组。
       *
       * 为什么返回扁平数组而不是嵌套对象：渲染侧只要一次 map，遇到 group 行就画标题、
       * 遇到 record 行就画条目；嵌套结构会让 header 与条目分开渲染，key 也难稳。
       * 章节优先——用户找一条划线，脑子里想的是「哪一章」，不是「哪天划的」。
       */
      function groupRows(records, mode) {
        const rows = []
        if (!Array.isArray(records) || records.length === 0) return rows
        let currentKey = null
        const dayStart = (value) => {
          const date = new Date(value)
          if (Number.isNaN(date.getTime())) return ''
          const zero = new Date(date.getFullYear(), date.getMonth(), date.getDate())
          return String(zero.getTime())
        }
        const today = dayStart(Date.now())
        const yesterday = dayStart(Date.now() - 86400000)
        const weekAgo = Date.now() - 6 * 86400000

        records.forEach((record, index) => {
          let key = ''
          let label = ''
          if (mode === 'time') {
            const stamp = Date.parse(record.updatedAt || record.createdAt || '') || 0
            if (dayStart(stamp) === today) { key = 'today'; label = '今天' }
            else if (dayStart(stamp) === yesterday) { key = 'yesterday'; label = '昨天' }
            else if (stamp >= weekAgo) { key = 'week'; label = '最近一周' }
            else { key = 'older'; label = '更早' }
          } else {
            const chapter = typeof record.chapterLabel === 'string' ? record.chapterLabel.trim() : ''
            key = chapter === '' ? 'unknown' : `ch:${chapter}`
            label = chapter === '' ? '未标章节' : chapter
          }
          if (key !== currentKey) {
            currentKey = key
            rows.push({ type: 'group', key: `g:${key}`, label })
          }
          rows.push({ type: 'record', key: record.id || `r:${index}`, record })
        })
        return rows
      }

      /** 笔记面板的搜索框 + 三个筛选 chip + 分组切换。 */
      function NoteFilterBar(props) {
        const KINDS = [
          ['all', '全部'],
          ['highlight', '划线'],
          ['note', '笔记'],
          ['bookmark', '书签'],
        ]
        return h(
          'div',
          { className: 'dr-col', style: { gap: 6, padding: '0 8px 6px' } },
          h('input', {
            className: 'dr-input dr-note-search',
            type: 'search',
            value: props.query,
            placeholder: '搜索划线、笔记、章节名',
            'aria-label': '搜索划线笔记',
            onChange: (event) => props.onQuery(event.target.value),
          }),
          h(
            'div',
            { className: 'dr-facet-chips' },
            KINDS.map(([key, label]) => h(
              'button',
              {
                key,
                type: 'button',
                className: 'dr-chip',
                'aria-pressed': props.kind === key ? 'true' : 'false',
                onClick: () => props.onKind(key),
              },
              label,
            )),
            h('div', { className: 'dr-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-chip',
                title: '切换分组的依据',
                onClick: () => props.onGroupBy(props.groupBy === 'chapter' ? 'time' : 'chapter'),
              },
              props.groupBy === 'chapter' ? '按章节' : '按时间',
            ),
          ),
        )
      }

      function AnnotationSidebar(props) {
        const records = Array.isArray(props.records) ? props.records : []
        const sorted = useMemo(() => {
          const copy = records.slice()
          copy.sort((a, b) => {
            const ta = Date.parse(a.createdAt || '') || 0
            const tb = Date.parse(b.createdAt || '') || 0
            return ta - tb
          })
          return copy
        }, [records])

        // 搜索与筛选（0.6.0）：一本几十万字的书，划线轻松上百条，翻列表找不到东西。
        // 三个筛选维度都做成「就地生效」，不重新请求：数据全在内存里，重算一次可忽略。
        const [query, setQuery] = useState('')
        const [kind, setKind] = useState('all')
        const [groupBy, setGroupBy] = useState('chapter')

        const filtered = useMemo(() => {
          const needle = String(query || '').trim().toLowerCase()
          return sorted.filter((record) => {
            if (kind !== 'all') {
              const recordKind = record.type === 'note' || (typeof record.note === 'string' && record.note !== '')
                ? 'note'
                : record.type === 'bookmark' ? 'bookmark' : 'highlight'
              if (recordKind !== kind) return false
            }
            if (needle === '') return true
            const haystack = [
              record.textExcerpt || '',
              record.note || '',
              record.label || '',
              record.chapterLabel || '',
            ].join('\n').toLowerCase()
            return haystack.indexOf(needle) >= 0
          })
        }, [sorted, query, kind])

        const rows = useMemo(() => groupRows(filtered, groupBy), [filtered, groupBy])

        const head = h(
          'div',
          { className: 'dr-side-head' },
          h('span', null, '划线笔记'),
          h('div', { className: 'dr-grow' }),
          h(
            'span',
            { className: 'dr-head-sub' },
            filtered.length === sorted.length ? `${sorted.length} 条` : `${filtered.length} / ${sorted.length} 条`,
          ),
        )

        if (props.error) {
          return h(
            'div',
            { className: 'dr-col', style: { height: '100%' } },
            head,
            h(
              'div',
              { className: 'dr-state dr-error' },
              h('div', { className: 'dr-state-title' }, '笔记读不出来'),
              h('div', { className: 'dr-state-text' }, props.error),
            ),
          )
        }

        if (props.loading) {
          return h(
            'div',
            { className: 'dr-col', style: { height: '100%' } },
            head,
            h(
              'div',
              { className: 'dr-state' },
              h('div', { className: 'dr-spinner', role: 'status', 'aria-label': '正在读取笔记' }),
              h('div', { className: 'dr-state-text' }, '正在读取笔记…'),
            ),
          )
        }

        if (sorted.length === 0) {
          return h(
            'div',
            { className: 'dr-col', style: { height: '100%' } },
            head,
            h(
              'div',
              { className: 'dr-state' },
              h('div', { className: 'dr-state-title' }, '还没有划线'),
              h(
                'div',
                { className: 'dr-state-text' },
                '在正文里拖选一段文字，会弹出颜色菜单。划过的线都会收在这里。',
              ),
            ),
          )
        }

        return h(
          'div',
          { className: 'dr-col', style: { height: '100%', minHeight: 0 } },
          head,
          h(NoteFilterBar, {
            query,
            onQuery: setQuery,
            kind,
            onKind: setKind,
            groupBy,
            onGroupBy: setGroupBy,
            total: sorted.length,
            shown: filtered.length,
          }),
          h(
            'div',
            { className: 'dr-side-body' },
            typeof props.quarantined === 'number' && props.quarantined > 0
              ? h(
                'div',
                { className: 'dr-head-sub', style: { padding: '4px 8px 8px' } },
                `另有 ${props.quarantined} 条位置对不上，暂时没有画出来（记录还在，没有删除）`,
              )
              : null,
            rows.length === 0
              ? h(
                'div',
                { className: 'dr-state' },
                h('div', { className: 'dr-state-title' }, '没有符合条件的内容'),
                h('div', { className: 'dr-state-text' }, '换个关键词，或点「全部」看看完整列表。'),
              )
              : null,
            rows.map((entry) => {
              if (entry.type === 'group') {
                return h('div', { key: entry.key, className: 'dr-note-group-head' }, entry.label)
              }
              const record = entry.record
              const style = colorStyle(record.color)
              const isBookmark = record.type === 'bookmark'
              const text = isBookmark
                ? (record.label || '书签')
                : excerptOf(record.textExcerpt || '', 220)
              const note = typeof record.note === 'string' ? record.note : ''
              return h(
                'div',
                { key: record.id, className: 'dr-col', style: { gap: 2 } },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dr-ann',
                    title: '跳到原文',
                    onClick: () => {
                      if (typeof props.onJump === 'function') props.onJump(record)
                    },
                  },
                  h('span', { className: 'dr-ann-dot', style: { background: style.fill, boxShadow: `inset 0 0 0 1px ${style.stroke}` } }),
                  h(
                    'span',
                    { className: 'dr-ann-main' },
                    h('span', { className: 'dr-ann-text' }, text || '（没有摘录）'),
                    note !== '' ? h('span', { className: 'dr-ann-note' }, note) : null,
                    h(
                      'span',
                      { className: 'dr-ann-meta' },
                      `${TYPE_LABEL[record.type] || '标注'} · ${relativeTime(record.updatedAt || record.createdAt) || '刚刚'}`,
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'dr-row', style: { paddingLeft: 14, gap: 4 } },
                  isBookmark
                    ? null
                    : HIGHLIGHT_ORDER.map((color) => h('button', {
                      key: color,
                      type: 'button',
                      className: 'dr-swatch',
                      title: `改成${HIGHLIGHT_COLORS[color].label}色`,
                      'aria-label': `改成${HIGHLIGHT_COLORS[color].label}色`,
                      style: {
                        width: 14,
                        height: 14,
                        background: colorStyle(color).fill,
                        borderColor: record.color === color ? colorStyle(color).stroke : 'transparent',
                      },
                      onClick: () => {
                        if (typeof props.onUpdateColor === 'function') props.onUpdateColor(record.id, color)
                      },
                    })),
                  h('div', { className: 'dr-grow' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dr-btn dr-btn-ghost dr-btn-sm',
                      title: '删除这条标注',
                      onClick: () => {
                        if (typeof props.onRemove === 'function') props.onRemove(record.id)
                      },
                    },
                    '删除',
                  ),
                ),
              )
            }),
          ),
        )
      }

      /**
       * 「问答记录」的数据 hook：这本书的 qa 记录全部走 qa.list（不靠内存态）。
       *
       * 为什么刷新后还能看见：qa.ask 成功时宿主已经把记录落进 qa.jsonl，
       * 这里每次打开面板都重新拉一遍，所以「昨天划过的那段」今天还在。
       *
       * @param {{ bookHash?: string, limit?: number, onError?: Function }} opts
       * @returns {{ records: object[], loading: boolean, error: string, reload: Function }}
       */
      function useQaHistory(opts) {
        const options = opts || {}
        const bookHash = options.bookHash
        const limit = Number.isFinite(options.limit) ? options.limit : 200
        const reportError = options.onError
        const [records, setRecords] = useState([])
        const [loading, setLoading] = useState(true)
        const [error, setError] = useState('')
        const [tick, setTick] = useState(0)

        useEffect(() => {
          let alive = true
          if (typeof bookHash !== 'string' || bookHash === '') {
            setRecords([])
            setLoading(false)
            setError('')
            return () => { alive = false }
          }
          setLoading(true)
          call('qa.list', { bookHash, limit })
            .then((value) => {
              if (!alive) return
              const list = value && Array.isArray(value.records) ? value.records : []
              setRecords(list)
              setError('')
              if (typeof reportError === 'function') reportError('')
            })
            .catch((err) => {
              if (!alive) return
              setRecords([])
              setError(humanizeError(err))
              if (typeof reportError === 'function') reportError(humanizeError(err))
            })
            .finally(() => {
              if (alive) setLoading(false)
            })
          return () => { alive = false }
        }, [bookHash, limit, reportError, tick])

        const reload = useCallback(() => setTick((value) => value + 1), [])

        return { records, loading, error, reload }
      }

      /** 一条 qa 记录有几轮：优先 rounds，其次 turns，最后按一问一答算 1 轮。 */
      function qaRoundCount(record) {
        if (!record || typeof record !== 'object') return 1
        if (Number.isFinite(record.rounds) && record.rounds > 0) return Math.floor(record.rounds)
        if (Array.isArray(record.turns) && record.turns.length > 0) return record.turns.length
        if (Array.isArray(record.messages) && record.messages.length > 0) return Math.ceil(record.messages.length / 2) || 1
        return 1
      }

      /** 一条记录引用的原句：qa.jsonl 落的是 selectedText，老数据/标注记录可能叫别的名字。 */
      function qaQuote(record) {
        if (!record || typeof record !== 'object') return ''
        const candidates = [record.textExcerpt, record.selectedText, record.quote, record.excerpt, record.text]
        for (const value of candidates) {
          if (typeof value === 'string' && value.trim() !== '') return value.replace(/\s+/g, ' ').trim()
        }
        return ''
      }

      /** 一条记录的「问」与「答」文本；兼容单轮字段与多轮 turns。 */
      function qaTexts(record) {
        const question = typeof record.question === 'string' ? record.question : ''
        const answer = typeof record.answer === 'string' ? record.answer : ''
        if (question !== '' || answer !== '') return { question, answer }
        const turns = Array.isArray(record.turns) ? record.turns.filter((turn) => turn && typeof turn === 'object') : []
        const last = turns.length > 0 ? turns[turns.length - 1] : null
        return {
          question: last && typeof last.question === 'string' ? last.question : '',
          answer: last && typeof last.answer === 'string' ? last.answer : '',
        }
      }

      /**
       * 「问答记录」侧栏（docs/施工图 0.4.0 §5.3）。
       *
       * 组件自己不请求数据：records / loading / error 都由 app 用 useQaHistory 拉好传进来，
       * 这样「划完线刚存的那条」能立刻出现在列表里，后端也不重复读文件。
       *
       * props:
       *   records        —— qa.list 的 records（旧的在前，这里自己按时间倒序）
       *   loading        —— 加载态
       *   error          —— humanizeError 过的文案
       *   onJump(record) —— 点一条：关面板 + 跳回原文并高亮（三级降级由 reader 做）
       *   onDelete?(record) —— 未接 qa.delete 时不传，删除键自动隐藏
       *   onReload()     —— 可选：手动刷新
       */
      function QaSidebar(props) {
        const records = Array.isArray(props.records) ? props.records : []
        const [query, setQuery] = useState('')
        const [expandedId, setExpandedId] = useState('')
        const searchRef = useRef(null)
        const qaListRef = useRef(null)
        const scrollQa = useCallback((direction) => {
          const node = qaListRef.current
          if (!node) return
          // 一次滚「一屏的 80%」：比固定 px 更符合「翻一页」的直觉，也不受面板高度影响。
          const step = Math.max(160, Math.round(node.clientHeight * 0.8))
          node.scrollTop = node.scrollTop + direction * step
        }, [])

        // 「打开即聚焦搜索框」——用户点工具栏「问答」就是为了找一条
        useEffect(() => {
          const timer = setTimeout(() => {
            const node = searchRef.current
            if (node && typeof node.focus === 'function') node.focus()
          }, 30)
          return () => clearTimeout(timer)
        }, [])

        const sorted = useMemo(() => {
          const copy = records.filter((record) => record && typeof record === 'object')
          copy.sort((a, b) => {
            const ta = Date.parse(a.createdAt || '') || 0
            const tb = Date.parse(b.createdAt || '') || 0
            if (tb !== ta) return tb - ta
            return String(b.id || '').localeCompare(String(a.id || ''))
          })
          return copy
        }, [records])

        const keyword = query.trim().toLowerCase()
        const filtered = useMemo(() => {
          if (keyword === '') return sorted
          return sorted.filter((record) => {
            const { question, answer } = qaTexts(record)
            const haystack = [
              question,
              answer,
              qaQuote(record),
              record.chapterLabel,
              record.chapterHref,
              record.bookTitle,
            ].filter((value) => typeof value === 'string').join('\n').toLowerCase()
            return haystack.includes(keyword)
          })
        }, [keyword, sorted])

        const head = h(
          'div',
          { className: 'dr-side-head' },
          h('span', null, '问答记录'),
          h('div', { className: 'dr-grow' }),
          h('span', { className: 'dr-head-sub' }, keyword === '' ? `${sorted.length} 条` : `${filtered.length} / ${sorted.length} 条`),
          typeof props.onReload === 'function'
            ? h('button', {
              type: 'button',
              className: 'dr-icon-btn',
              title: '刷新',
              'aria-label': '刷新问答记录',
              onClick: props.onReload,
            }, '↻')
            : null,
          typeof props.onClose === 'function'
            ? h(
              'button',
              {
                type: 'button',
                className: 'dr-icon-btn',
                title: '关闭',
                'aria-label': '关闭问答记录',
                onClick: props.onClose,
              },
              '×',
            )
            : null,
        )

        const search = h('input', {
          className: 'dr-input dr-qa-search',
          type: 'search',
          placeholder: '搜原文、问题或回答',
          value: query,
          ref: searchRef,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              if (query !== '') setQuery('')
              else if (typeof props.onClose === 'function') props.onClose()
            }
          },
        })

        let body = null
        if (props.loading === true && sorted.length === 0) {
          body = h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-spinner', role: 'status', 'aria-label': '正在读问答记录' }),
            h('div', { className: 'dr-state-text' }, '正在读问答记录…'),
          )
        } else if (typeof props.error === 'string' && props.error !== '') {
          body = h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-title' }, '问答记录读不出来'),
            h('div', { className: 'dr-state-text' }, props.error),
            typeof props.onReload === 'function'
              ? h('button', { type: 'button', className: 'dr-btn dr-btn-sm', onClick: props.onReload }, '重试')
              : null,
          )
        } else if (sorted.length === 0) {
          body = h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-title' }, '还没有问答记录'),
            h('div', { className: 'dr-state-text' }, '划一段话点「问 AI」，问答会存在这里。'),
          )
        } else if (filtered.length === 0) {
          body = h(
            'div',
            { className: 'dr-state' },
            h('div', { className: 'dr-state-text' }, `没有找到含「${query.trim()}」的问答。`),
          )
        } else {
          body = h(
            'div',
            {
              className: 'dr-side-body dr-qa-list dr-qa-scroll',
              ref: qaListRef,
              // 普通滚轮滚列表本身（列表很长时这是唯一自然的手势）；Shift+滚轮加速。
              // 不拦的话轮子会冒泡到阅读器，变成「翻页」——用户想找旧问答，结果书翻了。
              onWheel: (event) => {
                const node = qaListRef.current
                if (!node) return
                const step = event.shiftKey ? 2.5 : 1
                const delta = (Number(event.deltaY) || 0) * step
                if (delta === 0) return
                const before = node.scrollTop
                node.scrollTop = before + delta
                if (node.scrollTop !== before) {
                  event.preventDefault()
                  event.stopPropagation()
                }
              },
            },
            filtered.map((record) => {
              const id = String(record.id || '')
              const { question, answer } = qaTexts(record)
              const quote = qaQuote(record)
              const chapter = typeof record.chapterLabel === 'string' && record.chapterLabel !== ''
                ? record.chapterLabel
                : (typeof record.chapterHref === 'string' ? record.chapterHref : '')
              const rounds = qaRoundCount(record)
              const expanded = expandedId === id
              return h(
                'div',
                { key: id || `${question}-${record.createdAt}`, className: 'dr-qa-item' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dr-qa-quote',
                    title: '跳回这段原文',
                    onClick: () => {
                      if (typeof props.onJump === 'function') props.onJump(record)
                    },
                  },
                  h('span', { className: 'dr-qa-quote-text' }, quote || '（这条没有引用原文）'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dr-qa-question',
                    title: '跳回这段原文',
                    onClick: () => {
                      if (typeof props.onJump === 'function') props.onJump(record)
                    },
                  },
                  question || '（没有记下问题）',
                ),
                h(
                  'div',
                  { className: 'dr-qa-meta' },
                  h('span', { className: 'dr-qa-chapter' }, chapter || '未知章节'),
                  h('span', { className: 'dr-qa-dot' }, '·'),
                  h('span', null, relativeTime(record.createdAt) || '刚刚'),
                  h('span', { className: 'dr-qa-dot' }, '·'),
                  h('span', null, `${rounds} 轮`),
                ),
                expanded && answer !== ''
                  ? h('div', { className: 'dr-qa-answer' }, answer)
                  : null,
                h(
                  'div',
                  { className: 'dr-qa-actions' },
                  answer !== ''
                    ? h('button', {
                      type: 'button',
                      className: 'dr-btn dr-btn-ghost dr-btn-sm',
                      onClick: () => setExpandedId(expanded ? '' : id),
                    }, expanded ? '收起回答' : '看回答')
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dr-btn dr-btn-ghost dr-btn-sm',
                      onClick: () => {
                        if (typeof props.onJump === 'function') props.onJump(record)
                      },
                    },
                    '跳回原文',
                  ),
                  typeof props.onDelete === 'function'
                    ? h('button', {
                      type: 'button',
                      className: 'dr-btn dr-btn-ghost dr-btn-sm',
                      title: '删除这条问答',
                      onClick: () => props.onDelete(record),
                    }, '删除')
                    : null,
                ),
              )
            }),
          )
        }

        return h(
          'aside',
          { className: 'dr-side', 'aria-label': '问答记录' },
          head,
          h('div', { className: 'dr-qa-search-row' }, search),
          // 滚动手势的说明书：不说用户永远不知道 Shift 能加速，
          // 也不知道「滚轮只滚列表、不翻书」是我们特意做的。
          h(
            'div',
            { className: 'dr-qa-hint' },
            '滚轮滚动列表',
            h('span', { className: 'dr-qa-dot' }, '·'),
            '按住 ',
            h('kbd', { className: 'dr-keyhint' }, 'Shift'),
            ' 加速',
          ),
          body,
          h(
            'div',
            { className: 'dr-scroll-btns' },
            h('button', {
              type: 'button',
              className: 'dr-scroll-btn',
              title: '向上滚动',
              'aria-label': '向上滚动',
              onClick: () => scrollQa(-1),
            }, '↑'),
            h('button', {
              type: 'button',
              className: 'dr-scroll-btn',
              title: '向下滚动',
              'aria-label': '向下滚动',
              onClick: () => scrollQa(1),
            }, '↓'),
          ),
        )
      }

      /** 供上层做「隔离了几条」的提示文案；MAX_QUARANTINE_NOTE 是给未来的上限预留。 */
      function quarantineNote(count) {
        if (typeof count !== 'number' || count <= 0) return ''
        return `${Math.min(count, MAX_QUARANTINE_NOTE)} 条标注位置对不上，暂时没画出来`
      }

      return { useAnnotations: useAnnotations, rangeRectToMenuBase: rangeRectToMenuBase, SELECTION_MENU_HEIGHT: SELECTION_MENU_HEIGHT, placeSelectionMenu: placeSelectionMenu, relateRanges: relateRanges, selectRecord: selectRecord, findOverlap: findOverlap, subtractRect: subtractRect, flattenBoxes: flattenBoxes, hitBox: hitBox, computeRects: computeRects, Overlayer: Overlayer, AnnotationMenu: AnnotationMenu, SelectionMenu: SelectionMenu, NoteEditor: NoteEditor, AskPanel: AskPanel, AnnotationSidebar: AnnotationSidebar, useQaHistory: useQaHistory, qaRoundCount: qaRoundCount, QaSidebar: QaSidebar, quarantineNote: quarantineNote }
    })()

    // ─── client/src/style-qa.js ───
    var __mod_style_qa_js = (function () {
      /**
       * style-qa.js —— 问答历史侧栏（QaSidebar）与「问 AI」面板精修的样式表。
       *
       * 为什么单独一个文件、不并进 style.js：
       *   1. style.js 是「整面板」的样式，改它会让 client_build 的模块断言跟着动；
       *   2. 问答侧栏是本次新增的独立部件，单独一个 <style> 注入失败也只丢这一块，
       *      不会把书架/正文的样式一起带塌；
       *   3. 施工图 docs/10-0.4.0-施工图.md §8.4 规定：新增 CSS 一律不引用 `--dsw-*` token，
       *      用固定中性色，避免 token 白名单测试失败。放在独立文件里最容易守住这条。
       *
       * 类名：主体是 .dr-qa*（记录行）与 .dr-ask*（面板精修），布局复用
       * .dr-side / .dr-side-head / .dr-side-body / .dr-state / .dr-btn 等 style.js 已有类。
       * 这里**不**再定侧栏宽度：宽度由 app.js 的 SIDE_WIDTH 决定。
       *
       * 深色主题：侧栏和面板都在父窗口里，文字颜色一律继承（currentColor），
       * 分隔线/底色用半透明黑或半透明白，深色面板下不会出现「黑字黑底」。
       */

      /** <style> 元素的 id。重复注入时靠它去重，插件重载不会叠出两份样式。 */
      const QA_STYLE_ID = 'dsh-reading-qa'

      /**
       * 问答侧栏 + 问 AI 面板的样式文本。
       *
       * 只写父窗口里的部件，不碰正文 iframe（铁律：正文只注入那一个 <style>）。
       * 所有颜色都是固定值或半透明叠加，不引用任何设计 token。
       */
      const cssTextQa = `
      /* ── 问答记录侧栏 ───────────────────────────────────────────── */

      .dr-qa-search-row {
        flex: 0 0 auto;
        padding: 8px 10px 6px;
      }

      .dr-qa-search {
        width: 100%;
        box-sizing: border-box;
        font-size: 12px;
      }

      .dr-qa-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 6px 10px;
      }

      .dr-qa-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 9px 10px;
        border-radius: 10px;
        border-bottom: 0.5px solid rgba(0, 0, 0, 0.07);
        color: inherit;
      }

      .dr-qa-item:hover {
        background: rgba(0, 0, 0, 0.035);
      }

      /* 引用原句：两行截断 + 左侧竖线，和问题正文一眼分开 */
      .dr-qa-quote {
        display: block;
        width: 100%;
        box-sizing: border-box;
        margin: 0;
        padding: 2px 0 2px 8px;
        border: 0;
        border-left: 2px solid rgba(120, 120, 130, 0.45);
        background: transparent;
        color: inherit;
        opacity: 0.82;
        font-family: inherit;
        font-size: 11.5px;
        line-height: 1.45;
        text-align: left;
        cursor: pointer;
      }

      .dr-qa-quote-text {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        overflow: hidden;
        overflow-wrap: anywhere;
      }

      .dr-qa-question {
        display: block;
        width: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 600;
        line-height: 1.45;
        text-align: left;
        cursor: pointer;
        overflow-wrap: anywhere;
      }

      .dr-qa-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        font-size: 10.5px;
        line-height: 1.4;
        opacity: 0.62;
      }

      .dr-qa-chapter {
        max-width: 12em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dr-qa-dot {
        opacity: 0.6;
      }

      /* 展开后的完整回答：保留换行，最多 40vh，自己滚 */
      .dr-qa-answer {
        max-height: 40vh;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 7px 9px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.04);
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .dr-qa-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px;
      }

      /* ── 工具栏「问答」入口与条数徽标（常驻、一次点击可达） ────── */

      .dr-qa-entry {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .dr-qa-entry[aria-pressed='true'] {
        background: rgba(0, 0, 0, 0.08);
      }

      .dr-qa-entry .dr-toc-badge {
        display: inline-block;
        min-width: 14px;
        padding: 0 4px;
        border-radius: 7px;
        background: rgba(120, 120, 130, 0.22);
        font-size: 10px;
        line-height: 14px;
        text-align: center;
        opacity: 0.9;
      }

      /* ── 「问 AI」面板精修 ─────────────────────────────────────── */

      .dr-ask {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: min(78vh, 640px);
      }

      .dr-ask-round {
        margin-left: 2px;
      }

      /* 引用原文：默认两行，可展开 */
      .dr-ask-quote {
        position: relative;
        flex: 0 0 auto;
        padding-right: 4px;
        overflow: hidden;
      }

      .dr-ask-quote.is-collapsed {
        max-height: 3.1em;
      }

      .dr-ask-quote.is-collapsed .dr-ask-quote-text {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        overflow: hidden;
      }

      .dr-ask-quote-text {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .dr-ask-quote-more {
        margin-top: 2px;
        font-size: 11.5px;
      }

      .dr-ask-quote-empty {
        opacity: 0.66;
        font-size: 11.5px;
      }

      /* 上下文胶囊：书名 · 章节名 */
      .dr-ask-context {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        line-height: 1.4;
        opacity: 0.78;
      }

      .dr-ask-chip {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dr-ask-sep {
        opacity: 0.5;
      }

      /* 多轮追问：每一轮一张卡，整块自己滚 */
      .dr-ask-turns {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 40vh;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .dr-ask-turn-question {
        margin-bottom: 2px;
        font-size: 11.5px;
        line-height: 1.45;
        opacity: 0.68;
        overflow-wrap: anywhere;
      }

      /* 回答：自己滚，不再把面板顶出屏幕 */
      .dr-ask-answer {
        flex: 0 1 auto;
        max-height: 38vh;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .dr-ask-answer-text {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      /* 加载骨架 */
      .dr-ask-loading {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.035);
      }

      .dr-ask-skeleton {
        display: block;
        height: 10px;
        border-radius: 5px;
        background: linear-gradient(90deg, rgba(0, 0, 0, 0.07) 0%, rgba(0, 0, 0, 0.13) 50%, rgba(0, 0, 0, 0.07) 100%);
        background-size: 200% 100%;
        animation: dr-qa-shimmer 1.3s ease-in-out infinite;
      }

      .dr-ask-skeleton-short {
        width: 62%;
      }

      .dr-ask-loading-text {
        font-size: 11px;
        opacity: 0.68;
      }

      @keyframes dr-qa-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      /* 错误：中文人话 + 重试 */
      .dr-ask-error {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(196, 62, 62, 0.08);
      }

      .dr-ask-error-hint {
        font-size: 11px;
        opacity: 0.72;
      }

      .dr-ask-notice {
        font-size: 11.5px;
        color: #1f7a4d;
      }

      .dr-ask-hint {
        font-size: 10.5px;
        line-height: 1.4;
        opacity: 0.56;
      }

      .dr-ask-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding-top: 2px;
      }

      /* 窄屏：面板贴边、按钮不挤成一条线 */
      @media (max-width: 560px) {
        .dr-ask {
          max-height: 88vh;
        }

        .dr-ask-quote.is-collapsed {
          max-height: 2.7em;
        }

        .dr-ask-answer {
          max-height: 30vh;
        }

        .dr-ask-actions .dr-btn {
          flex: 1 1 auto;
        }
      }

      /* 尊重系统「减少动态效果」 */
      @media (prefers-reduced-motion: reduce) {
        .dr-ask-skeleton {
          animation: none;
        }
      }
      `

      /**
       * 把问答复用样式注入到宿主文档。幂等：已有同 id 的 <style> 就直接返回。
       *
       * 只操作宿主页面（不是书籍 iframe）：正文文档里仍然只允许那一个阅读样式。
       *
       * @param {Document} doc    通常是宿主页面 document
       * @returns {boolean}       true = 本次真的注入了；false = 已存在 / 无 document
       */
      function ensureQaStyle(doc) {
        if (!doc || typeof doc.createElement !== 'function') return false
        const head = doc.head || doc.documentElement
        if (!head || typeof head.appendChild !== 'function') return false
        if (typeof doc.getElementById === 'function' && doc.getElementById(QA_STYLE_ID)) return false
        const style = doc.createElement('style')
        style.id = QA_STYLE_ID
        style.textContent = cssTextQa
        head.appendChild(style)
        return true
      }

      return { QA_STYLE_ID: QA_STYLE_ID, cssTextQa: cssTextQa, ensureQaStyle: ensureQaStyle }
    })()

    // ─── client/src/app.js ───
    var __mod_app_js = (function () {
      /**
       * app.js —— 面板根组件与 DSH 注册。整个浏览器半唯一的 apply / inject 出口。
       *
       * 界面结构（一个面板，两个屏幕）：
       *
       *   书架  ──点一本书──▶  阅读器
       *    ▲                     │ 工具栏：目录 / 划线笔记
       *    └─────「← 书架」───────┘
       *
       * 为什么不做成「右侧栏 tab + 左侧图标」两套界面：阅读需要整块宽度，
       * 侧栏那一列放不下正文。所以书架和阅读器都在主区域里切换，
       * 左侧栏只提供一个入口图标（点开就是主区域里的这个面板）。
       *
       * 注册方式照 dsh-lifecard 的双入口模式（已验证可用）：
       *   slots.inject('main', ...)             —— 左侧栏图标点开后主区域显示什么
       *   slots.inject('sidebar.panellist', ...) —— 左侧栏那一排图标本身
       * 两个注册都必须回收；任何一个漏了，插件重载后图标会重复出现。
       */

            const aiLog = __mod_api_js.aiLog
            const aiLogClear = __mod_api_js.aiLogClear
            const aiProbe = __mod_api_js.aiProbe
            const aiModels = __mod_api_js.aiModels
            const aiStatus = __mod_api_js.aiStatus
            const call = __mod_api_js.call
            const distillChapter = __mod_api_js.distillChapter
            const distillClear = __mod_api_js.distillClear
            const distillExport = __mod_api_js.distillExport
            const distillGet = __mod_api_js.distillGet
            const distillSkeleton = __mod_api_js.distillSkeleton
            const getDeviceId = __mod_api_js.getDeviceId
            const humanizeError = __mod_api_js.humanizeError
            const searchBook = __mod_api_js.searchBook
            const ensureStyle = __mod_style_js.ensureStyle
            const cssText = __mod_style_js.cssText
            const HIGHLIGHT_COLORS = __mod_style_js.HIGHLIGHT_COLORS
            const HIGHLIGHT_ORDER = __mod_style_js.HIGHLIGHT_ORDER
            const ShelfView = __mod_shelf_js.ShelfView
            const TocPanel = __mod_toc_js.TocPanel
            const flattenToc = __mod_toc_js.flattenToc
            const ReaderView = __mod_reader_js.ReaderView
            const THEMES = __mod_reader_js.THEMES
            const FONT_CHOICES = __mod_reader_js.FONT_CHOICES
            const CFI = __mod_cfi_js
            const AnnotationMenu = __mod_annotate_js.AnnotationMenu
            const AnnotationSidebar = __mod_annotate_js.AnnotationSidebar
            const AskPanel = __mod_annotate_js.AskPanel
            const NoteEditor = __mod_annotate_js.NoteEditor
            const Overlayer = __mod_annotate_js.Overlayer
            const QaSidebar = __mod_annotate_js.QaSidebar
            const SelectionMenu = __mod_annotate_js.SelectionMenu
            const computeRects = __mod_annotate_js.computeRects
            const findOverlap = __mod_annotate_js.findOverlap
            const rangeRectToMenuBase = __mod_annotate_js.rangeRectToMenuBase
            const selectRecord = __mod_annotate_js.selectRecord
            const useAnnotations = __mod_annotate_js.useAnnotations
            const useQaHistory = __mod_annotate_js.useQaHistory
            const ensureQaStyle = __mod_style_qa_js.ensureQaStyle
            const SearchPanel = __mod_search_js.SearchPanel
            const AiPanel = __mod_ai_js.AiPanel
            const AiModelPicker = __mod_ai_js.AiModelPicker
            const statusSummary = __mod_ai_js.statusSummary
            const DistillPanel = __mod_distill_js.DistillPanel
            const distillSummary = __mod_distill_js.distillSummary
            const downloadMarkdown = __mod_distill_js.downloadMarkdown
            const exportFilename = __mod_distill_js.exportFilename

      /**
       * 取选区所在段落的全文，当作「当前工作内容」交给 AI（0.8.0）。
       *
       * 为什么要按块节点找：用户圈的往往是一个短语，而模型需要的是它所在的整段。
       * 找不到块节点（比如整本书是一串裸文本）就退一步用选区起点所在的字符节点。
       *
       * @param {Range} range
       * @returns {string} 最多 1500 字，空串表示取不到
       */
      function surroundingOfSelection(range) {
        const LIMIT = 1500
        try {
          if (!range || typeof range.toString !== 'function') return ''
          let node = range.startContainer
          if (node && node.nodeType === 3) node = node.parentNode
          let block = node
          while (block && block.nodeType === 1) {
            const tag = String(block.tagName || '').toLowerCase()
            if (tag === 'p' || tag === 'div' || tag === 'li' || tag === 'blockquote' || /^h[1-6]$/.test(tag)) break
            block = block.parentNode
          }
          const text = block && typeof block.textContent === 'string' ? block.textContent : ''
          const trimmed = text.replace(/\s+/g, ' ').trim()
          return trimmed.length > LIMIT ? trimmed.slice(0, LIMIT) : trimmed
        } catch (error) {
          return ''
        }
      }

      /**
       * 失败的提问草稿（0.8.0）。
       *
       * 用户的原话：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍去重试，
       * 非常浪费。所以每次提交前把整份请求存在本机，失败后可原样重发——
       * 问题、锚点、选区、上下文都在，用户不用重新找那句话。
       */
      const ASK_DRAFT_PREFIX = 'dsh-reading:ask-draft:'

      function rememberAskDraft(bookHash, payload) {
        try {
          if (typeof bookHash !== 'string' || bookHash === '') return
          globalThis.localStorage?.setItem(`${ASK_DRAFT_PREFIX}${bookHash}`, JSON.stringify({ at: Date.now(), payload }))
        } catch (error) {
          // 隐私模式 / 存满：存不下不影响这次提问
        }
      }

      function readAskDraft(bookHash) {
        try {
          if (typeof bookHash !== 'string' || bookHash === '') return null
          const raw = globalThis.localStorage?.getItem(`${ASK_DRAFT_PREFIX}${bookHash}`)
          if (typeof raw !== 'string' || raw === '') return null
          const parsed = JSON.parse(raw)
          const payload = parsed && parsed.payload
          if (!payload || typeof payload.question !== 'string' || payload.question.trim() === '') return null
          return payload
        } catch (error) {
          return null
        }
      }

      function forgetAskDraft(bookHash) {
        try {
          if (typeof bookHash !== 'string' || bookHash === '') return
          globalThis.localStorage?.removeItem(`${ASK_DRAFT_PREFIX}${bookHash}`)
        } catch (error) {
          // 忽略
        }
      }

      /** 面板 id。左侧栏图标与主区域页面靠这个 id 配对，两边必须同一个常量。 */
      const PANEL_ID = 'dsh-reading'

      /** 左侧栏里的排序。36 接在 lifecard(35) 后面，不抢别人的位置。 */
      const PANEL_ORDER = 36

      /** 右侧面板宽度。目录和笔记用同一个宽度，切换时正文不会跳。 */
      const SIDE_WIDTH = 244

      /**
       * 目录栏标题右边的计数。
       *
       * 没有目录时不能写「0 章」：那读起来像「这本书一章都没有」，而书其实好好的，
       * 只是没有可用目录（TXT 硬切、拿 spine 冒充都被判成 none）。所以直接说人话。
       */
      function tocHeadSub(source, count) {
        if (source === 'none') return '没有目录'
        if (source === 'auto' || source === 'headings') return `${count} 段 · 自动识别`
        return `${count} 章`
      }

      /** 阅读偏好默认值。与宿主 settings.get 的默认值一致，缺字段时用它兜底。 */
      const DEFAULT_SETTINGS = {
        fontSize: 18,
        lineHeight: 1.75,
        // 翻页动画：'on' 默认（跟随系统减少动态效果），'off' 完全不动
        motion: 'on',
        theme: 'auto',
        columns: 2,
        fontFamily: '',
      }

      /** 统一的加载态。 */
      function Loading(props) {
        return h(
          'div',
          { className: 'dr-state' },
          h('div', { className: 'dr-spinner', role: 'status', 'aria-label': props.text || '正在加载' }),
          h('div', { className: 'dr-state-text' }, props.text || '正在加载…'),
        )
      }

      /** 统一的错误态，带一个重试按钮。 */
      function ErrorState(props) {
        return h(
          'div',
          { className: 'dr-state dr-error' },
          h('div', { className: 'dr-state-title' }, props.title || '出了点问题'),
          h('div', { className: 'dr-state-text' }, props.text || '请稍后再试。'),
          props.onRetry
            ? h(
              'div',
              { className: 'dr-state-actions' },
              h('button', { type: 'button', className: 'dr-btn', onClick: props.onRetry }, '重试'),
            )
            : null,
        )
      }

      /**
       * 阅读屏幕：拿到 meta / toc / 进度之后才挂载。
       *
       * 这里集中持有三件会互相影响的状态：
       *   · frameDoc / frameWin —— 由 ReaderView 的 onFrameReady 抛上来，annotate 要用；
       *   · frameEl + pageOffset —— 覆盖层换算坐标要用；
       *   · selection —— 选区菜单要画在父窗口。
       * 拆成更小的组件会让这三者在 props 里来回传，反而更难跟。
       */
      /** 字号的上下限。与宿主 mergeSettings 的范围一致（10–48），界面只放常用段。 */
      const FONT_SIZE_MIN = 13
      const FONT_SIZE_MAX = 30

      /** 行距档位。给档位而不是滑杆：连续滑杆调不出「刚好舒服」的那一档。 */
      const LINE_HEIGHT_CHOICES = [
        { value: 1.5, label: '紧凑' },
        { value: 1.75, label: '标准' },
        { value: 2.0, label: '宽松' },
      ]

      /**
       * 阅读设置抽屉。
       *
       * 每次改动立刻生效（父组件的 settings 一更新，reader 就重排），同时把改动
       * 攒进 settings.put —— 去抖 500ms，避免拖字号时把 settings.json 写成筛子。
       * 保存失败不打断阅读：只在抽屉底部留一行红字。
       */
      function SettingsDrawer(props) {
        const settings = props.settings || {}
        const fontSize = Number.isFinite(settings.fontSize) ? settings.fontSize : 18
        const lineHeight = Number.isFinite(settings.lineHeight) ? settings.lineHeight : 1.75
        const themeKey = typeof settings.theme === 'string' ? settings.theme : 'light'
        const fontKey = typeof settings.fontFamily === 'string' ? settings.fontFamily : ''

        const change = (patch) => {
          if (typeof props.onChange === 'function') props.onChange(patch)
        }

        return h(
          'div',
          { className: 'dr-drawer', role: 'dialog', 'aria-label': '阅读设置' },
          h(
            'div',
            { className: 'dr-drawer-head' },
            h('span', null, '阅读设置'),
            h('div', { className: 'dr-grow' }),
            h('button', {
              type: 'button',
              className: 'dr-iconbtn',
              title: '关闭',
              'aria-label': '关闭',
              onClick: props.onClose,
            }, '×'),
          ),
          h(
            'div',
            { className: 'dr-drawer-body' },
            // ── 字体
            h('div', { className: 'dr-field' },
              h('div', { className: 'dr-field-label' }, '字体'),
              h(
                'div',
                { className: 'dr-chips' },
                FONT_CHOICES.map((item) => h(
                  'button',
                  {
                    key: item.key === '' ? 'default' : item.key,
                    type: 'button',
                    className: `dr-chip${fontKey === item.key ? ' is-on' : ''}`,
                    style: item.stack !== '' ? { fontFamily: item.stack } : undefined,
                    onClick: () => change({ fontFamily: item.key }),
                  },
                  item.label,
                )),
              ),
            ),
            // ── 字号
            h('div', { className: 'dr-field' },
              h('div', { className: 'dr-field-label' }, '字号'),
              h(
                'div',
                { className: 'dr-slider-row' },
                h('button', {
                  type: 'button',
                  className: 'dr-step',
                  'aria-label': '减小字号',
                  onClick: () => change({ fontSize: Math.max(FONT_SIZE_MIN, Math.round((fontSize - 1) * 10) / 10) }),
                }, 'A－'),
                h('input', {
                  type: 'range',
                  className: 'dr-slider',
                  min: FONT_SIZE_MIN,
                  max: FONT_SIZE_MAX,
                  step: 0.5,
                  value: fontSize,
                  'aria-label': '字号',
                  onChange: (event) => change({ fontSize: Number(event.target.value) }),
                }),
                h('button', {
                  type: 'button',
                  className: 'dr-step',
                  'aria-label': '增大字号',
                  onClick: () => change({ fontSize: Math.min(FONT_SIZE_MAX, Math.round((fontSize + 1) * 10) / 10) }),
                }, 'A＋'),
                h('span', { className: 'dr-field-value' }, `${fontSize}px`),
              ),
            ),
            // ── 行距
            h('div', { className: 'dr-field' },
              h('div', { className: 'dr-field-label' }, '行距'),
              h(
                'div',
                { className: 'dr-chips' },
                LINE_HEIGHT_CHOICES.map((item) => h(
                  'button',
                  {
                    key: item.value,
                    type: 'button',
                    className: `dr-chip${Math.abs(lineHeight - item.value) < 0.01 ? ' is-on' : ''}`,
                    onClick: () => change({ lineHeight: item.value }),
                  },
                  item.label,
                )),
              ),
            ),
            // ── 背景与墨色
            h('div', { className: 'dr-field' },
              h('div', { className: 'dr-field-label' }, '背景'),
              h(
                'div',
                { className: 'dr-themes' },
                THEMES.map((item) => h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    className: `dr-theme${themeKey === item.key ? ' is-on' : ''}`,
                    title: item.label,
                    onClick: () => change({ theme: item.key }),
                  },
                  h('span', {
                    className: 'dr-theme-swatch',
                    style: { background: item.paper, color: item.ink, borderColor: item.rule },
                  }, '文'),
                  h('span', { className: 'dr-theme-label' }, item.label),
                )),
              ),
            ),
            // ── 翻页动画
            // 有人就是嫌那个 200ms 的滑动碍眼（尤其连着翻很多页时），给个硬开关。
            h(
              'div',
              { className: 'dr-field' },
              h('div', { className: 'dr-field-label' }, '翻页动画'),
              h(
                'div',
                { className: 'dr-field-row' },
                h('button', {
                  type: 'button',
                  className: `dr-chip${settings.motion !== 'off' ? ' is-on' : ''}`,
                  'aria-pressed': settings.motion !== 'off' ? 'true' : 'false',
                  onClick: () => change({ motion: 'on' }),
                }, '有（默认）'),
                h('button', {
                  type: 'button',
                  className: `dr-chip${settings.motion === 'off' ? ' is-on' : ''}`,
                  'aria-pressed': settings.motion === 'off' ? 'true' : 'false',
                  onClick: () => change({ motion: 'off' }),
                }, '关掉'),
              ),
            ),
            props.error
              ? h('div', { className: 'dr-drawer-error', role: 'alert' }, props.error)
              : null,
            h(
              'div',
              { className: 'dr-drawer-foot' },
              h('button', {
                type: 'button',
                className: 'dr-btn dr-btn-sm',
                onClick: () => change({ fontSize: 18, lineHeight: 1.75, theme: 'light', fontFamily: '' }),
              }, '恢复默认'),
              h('div', { className: 'dr-grow' }),
              h('span', { className: 'dr-head-sub' }, props.saving ? '正在保存…' : '设置会自动保存'),
            ),
          ),
        )
      }

      /**
       * 使用说明。
       *
       * 第一次打开阅读器会自己弹一次（记在 localStorage），之后只能从工具栏的「?」进。
       * 内容按「你会想干什么」组织，不按功能清单组织 —— 说明书的第一句话应该是
       * 用户的问题，不是产品的功能名。
       */
      function HelpDialog(props) {
        const rows = [
          { keys: '→ / 空格', text: '下一页' },
          { keys: '← / Shift+空格', text: '上一页' },
          { keys: 'PageDown / PageUp', text: '下一页 / 上一页' },
          { keys: '触控板两指左右滑', text: '翻页（一次手势只翻一页，往下滚也行）' },
          { keys: '鼠标滚轮', text: '翻页' },
          { keys: '点正文两侧的窄边', text: '翻页（悬停会浮出 ‹ ›）' },
          { keys: '拖选文字', text: '弹出划线菜单：五色高亮 / 写笔记 / 加书签 / 问 AI' },
          { keys: 'Esc', text: '关掉当前弹层' },
        ]

        return h(
          'div',
          { className: 'dr-modal-mask', role: 'presentation', onClick: props.onClose },
          h(
            'div',
            { className: 'dr-modal', role: 'dialog', 'aria-label': '使用说明', onClick: (event) => event.stopPropagation() },
            h(
              'div',
              { className: 'dr-modal-head' },
              h('span', null, '怎么用'),
              h('div', { className: 'dr-grow' }),
              h('button', { type: 'button', className: 'dr-iconbtn', title: '关闭', onClick: props.onClose }, '×'),
            ),
            h(
              'div',
              { className: 'dr-modal-body' },
              h('p', null, '左侧栏点 Reading 图标打开面板。书架里点一本书开始读，读到哪会自动记住，下次打开直接回到那一页。'),
              h('p', null, '支持的格式：EPUB 原样排版（保留插图和版式）；MOBI / AZW3 / TXT / PDF 会转成纯文字重排 —— 能读、能划线、能记笔记，但不保留原书的插图和字体。扫描版 PDF 和加密 PDF 读不了，界面会直接说明原因。'),
              h('h4', null, '把书放进书架'),
              h('p', null, '书架的「导入」面板有三段：①从电脑里选文件（也能把文件直接拖进窗口）；②粘贴一条指向文件本身的下载直链；③「找书」——先自己填一个书源（搜索地址模板，用 {query} 代替关键词），再搜关键词，从结果里点一条下载。插件不内置任何站点，也不带默认书源。'),
              h('h4', null, '整理书架'),
              h('p', null, '对着书封右键（或点卡片右上角 ✎）可以改书名、作者、简介，填分类、系列，打标签，标成「我的珍藏」，换封面或恢复纸封面。左上角两级下拉可以按「我的珍藏 / 系列 / 作者 / 分类 / 标签」筛书架。'),
              h('h4', null, '翻页'),
              h(
                'div',
                { className: 'dr-keys' },
                rows.map((row) => h(
                  'div',
                  { key: row.keys, className: 'dr-key-row' },
                  h('kbd', null, row.keys),
                  h('span', null, row.text),
                )),
              ),
              h('h4', null, '划线、笔记与书签'),
              h('p', null, '用鼠标（或手指）拖过一段文字，会浮出一个小菜单：选颜色就是高亮，选「笔记」可以在这段话旁边写一段自己的话，选「书签」记住当前位置。所有标注都在右侧「✎」面板里，点一条就跳回原文。'),
              h('h4', null, '阅读设置'),
              h('p', null, '工具栏的「Aa」里可以换字体、调字号与行距、换背景色（白纸 / 羊皮纸 / 护眼绿 / 夜间）。改完立即生效，也会自动保存。'),
              h('h4', null, '数据存在哪里'),
              h('p', null, '默认在本机的 ~/.dsh-reading/ 下，一本书一个目录：正文副本、阅读进度、全部标注、题库都在里面，纯文本（JSON），可以自己备份或同步。卸载插件不会删掉它们。'),
              h('h4', null, '读不了怎么办'),
              h('p', null, '加密的 MOBI（DRM）和 KFX 打不开；扫描版 PDF（整页是图、没有文字层）也打不开，会提示「这本书没有可提取的文字」；加密 PDF 会提示需要先解密。遇到解析失败，把书架里那本书删掉重新导入一次通常就好。'),
            ),
            h(
              'div',
              { className: 'dr-modal-foot' },
              h('button', { type: 'button', className: 'dr-btn dr-btn-primary', onClick: props.onClose }, '知道了'),
            ),
          ),
        )
      }

      /**
       * AI 状态中心（0.8.0）。
       *
       * 三样东西总是一起出现，所以做成一个 hook：状态（四道检查 + 最近失败统计）、
       * 真实探测、调用账本。分开取会让面板闪三次。
       *
       * 只在打开「AI 状态」面板时才取：这是诊断面板，不是每次阅读都要加载的东西。
       */
      function useAiCenter({ active }) {
        const [status, setStatus] = useState(null)
        const [items, setItems] = useState([])
        const [loading, setLoading] = useState(false)
        const [probing, setProbing] = useState(false)
        const [error, setError] = useState('')
        const [models, setModels] = useState(null)
        const [savingModel, setSavingModel] = useState(false)
        const seq = useRef(0)

        const reload = useCallback(async () => {
          const mine = seq.current + 1
          seq.current = mine
          setLoading(true)
          setError('')
          try {
            const [next, list, modelInfo] = await Promise.all([aiStatus(), aiLog(50), aiModels()])
            if (mine !== seq.current) return
            setStatus(next)
            setItems(Array.isArray(list) ? list : [])
            setModels(modelInfo ?? null)
          } catch (failure) {
            if (mine !== seq.current) return
            setError(humanizeError(failure))
          } finally {
            if (mine === seq.current) setLoading(false)
          }
        }, [])

        const probe = useCallback(async () => {
          setProbing(true)
          setError('')
          try {
            await aiProbe()
          } catch (failure) {
            setError(humanizeError(failure))
          } finally {
            setProbing(false)
            reload()
          }
        }, [reload])

        const clear = useCallback(async () => {
          try {
            await aiLogClear()
          } catch (failure) {
            setError(humanizeError(failure))
            return
          }
          reload()
        }, [reload])

        // 换模型 / 换强度：先保存再重读。
        // 不做「保存」按钮——改完就生效，用户不用记着点一下；
        // 保存失败要把话说明白，否则界面会一直显示旧的「实际使用」。
        const changeModel = useCallback(async (next) => {
          setSavingModel(true)
          setError('')
          try {
            await call('settings.put', {
              aiProvider: String(next?.provider ?? ''),
              aiModel: String(next?.model ?? ''),
              aiEffort: String(next?.reasoningEffort ?? ''),
            })
          } catch (failure) {
            setError(humanizeError(failure))
          } finally {
            setSavingModel(false)
            reload()
          }
        }, [reload])

        useEffect(() => {
          if (active) reload()
        }, [active, reload])

        return { status, items, loading, probing, error, models, savingModel, changeModel, reload, probe, clear }
      }

      /**
       * 读书蒸馏（0.8.0）。
       *
       * 一章一次调用，所以「正在蒸哪一章」必须是显式状态：否则用户点完只能干等，
       * 也不知道点的是不是自己那一章。失败只记这一章，列表里的其它章不受影响。
       */
      function useDistill({ active, bookHash }) {
        const [data, setData] = useState(null)
        const [loading, setLoading] = useState(false)
        const [error, setError] = useState('')
        const [busyHref, setBusyHref] = useState('')
        const [notice, setNotice] = useState('')

        const load = useCallback(async () => {
          if (typeof bookHash !== 'string' || bookHash === '') return
          setLoading(true)
          setError('')
          try {
            setData(await distillGet(bookHash))
          } catch (failure) {
            setError(humanizeError(failure))
          } finally {
            setLoading(false)
          }
        }, [bookHash])

        const runChapter = useCallback(async (href) => {
          if (typeof href !== 'string' || href === '') return
          setBusyHref(href)
          setError('')
          setNotice('')
          try {
            await distillChapter(bookHash, href)
            setNotice('这一章蒸好了。')
          } catch (failure) {
            // 失败的章节宿主已经落盘（status=failed），这里只负责说清楚
            setError(humanizeError(failure))
          } finally {
            setBusyHref('')
            await load()
          }
        }, [bookHash, load])

        const runSkeleton = useCallback(async () => {
          setError('')
          setNotice('')
          try {
            await distillSkeleton(bookHash)
            setNotice('全书骨架已更新。')
          } catch (failure) {
            setError(humanizeError(failure))
          }
          await load()
        }, [bookHash, load])

        const runExport = useCallback(async () => {
          setError('')
          try {
            const markdown = await distillExport(bookHash)
            const title = data && typeof data.bookTitle === 'string' ? data.bookTitle : ''
            const saved = downloadMarkdown(exportFilename(title), markdown)
            setNotice(saved ? '已导出 Markdown。' : '这个环境不能下载文件。')
          } catch (failure) {
            setError(humanizeError(failure))
          }
        }, [bookHash, data])

        const runClear = useCallback(async () => {
          setError('')
          try {
            await distillClear(bookHash)
            setNotice('蒸馏稿已清空。')
          } catch (failure) {
            setError(humanizeError(failure))
          }
          await load()
        }, [bookHash, load])

        useEffect(() => {
          if (active) load()
        }, [active, load])

        return { data, loading, error, busyHref, notice, load, runChapter, runSkeleton, runExport, runClear }
      }

      function ReaderScreen(props) {
        const [frameDoc, setFrameDoc] = useState(null)
        const [settingsOpen, setSettingsOpen] = useState(false)
        const [helpOpen, setHelpOpen] = useState(false)
        const [settingsSaving, setSettingsSaving] = useState(false)
        const [settingsError, setSettingsError] = useState('')
        const settingsSaveTimer = useRef(null)
        const [frameWin, setFrameWin] = useState(null)
        const [frameEl, setFrameEl] = useState(null)
        const [pageOffset, setPageOffset] = useState(0)
        const [pageTick, setPageTick] = useState(0)
        const [selection, setSelection] = useState(null)
        // 点中的那条已有划线：{record, rect, conflictIds}。操作条（改色 / 笔记 / 问 AI / 删除）跟着它。
        const [activeAnn, setActiveAnn] = useState(null)
        // 选中已有文字会触发 selectionchange：放行期内 reader 不再弹选区菜单，免得两个浮层打架。
        const suppressSelectionRef = useRef(0)
        const [noteAnchorId, setNoteAnchorId] = useState('')
        const [noteTarget, setNoteTarget] = useState(null)
        const [noteText, setNoteText] = useState('')
        const [noteSaving, setNoteSaving] = useState(false)
        const [noteError, setNoteError] = useState('')
        const [annError, setAnnError] = useState('')
        const [quarantinedIds, setQuarantinedIds] = useState({})
        const [deviceId, setDeviceId] = useState('')
        // 「问 AI」：面板开着时 anchor 里存着这次提问要挂的那段原文锚点。
        // 锚点必须在圈选的那一刻算好（选区一关，Range 就散了）。
        const [askOpen, setAskOpen] = useState(false)
        const [askAnchor, setAskAnchor] = useState(null)
        const [askQuestion, setAskQuestion] = useState('')
        const [askAnswer, setAskAnswer] = useState('')
        const [askAsking, setAsking] = useState(false)
        const [askError, setAskError] = useState('')
        // 同一次问答的多轮上下文：每成功一问 push 一轮，追问不再把上一轮顶掉
        const [askTurns, setAskTurns] = useState([])
        // 一句中文提示（链接打不开 / 已复制 / 删除可撤销），无操作 2.4 秒消失，带操作 5 秒
        const [toast, setToast] = useState('')
        const [toastAction, setToastAction] = useState(null)

        const apiRef = useRef(null)
        const viewportWrapRef = useRef(null)
        const settingsRef = useRef(props.settings || DEFAULT_SETTINGS)

        settingsRef.current = props.settings || DEFAULT_SETTINGS

        useEffect(() => {
          let alive = true
          getDeviceId().then((id) => {
            if (alive) setDeviceId(id)
          })
          return () => {
            alive = false
          }
        }, [])

        const annotations = useAnnotations({
          bookHash: props.bookHash,
          frameDoc,
          frameWin,
          deviceId,
          onError: setAnnError,
        })

        // 问答记录：每次挂载都走 qa.list（不靠内存态），刷新 / 重开面板后历史还在
        const qaHistory = useQaHistory({ bookHash: props.bookHash })
        // AI 状态中心：诊断面板打开时才取（见 useAiCenter 注释）
        const aiCenter = useAiCenter({ active: props.sideKind === 'ai' })
        // 读书蒸馏：一章一次调用，进度落在宿主侧（distill.json）
        const distill = useDistill({ active: props.sideKind === 'distill', bookHash: props.bookHash })

        // 书内搜索（0.6.0）：真正的扫描在宿主侧（client/src/api.js 的 searchBook），
        // 面板只负责把命中列表画出来。这里用序号防止「搜了 A、又搜了 B，A 的结果慢到
        // 后回来把 B 覆盖掉」——异步请求的经典错位。
        const [searchQuery, setSearchQuery] = useState('')
        const [searchResults, setSearchResults] = useState(null)
        const [searching, setSearching] = useState(false)
        const [searchError, setSearchError] = useState('')
        const searchSeq = useRef(0)

        const runSearch = useCallback(() => {
          const query = String(searchQuery || '').trim()
          if (query === '') return
          const seq = searchSeq.current + 1
          searchSeq.current = seq
          setSearching(true)
          setSearchError('')
          searchBook(props.bookHash, query)
            .then((data) => {
              if (searchSeq.current !== seq) return
              setSearchResults(Array.isArray(data?.hits) ? data.hits : [])
            })
            .catch((error) => {
              if (searchSeq.current !== seq) return
              setSearchResults([])
              setSearchError(humanizeError(error))
            })
            .finally(() => {
              if (searchSeq.current === seq) setSearching(false)
            })
        }, [props.bookHash, searchQuery])

        const onBadAnchor = useCallback((record, code) => {
          if (record === null) {
            setQuarantinedIds((prev) => (Object.keys(prev).length === 0 ? prev : {}))
            return
          }
          setQuarantinedIds((prev) => (prev[record.id] ? prev : { ...prev, [record.id]: code || 'cfi_resolve_failed' }))
        }, [])

        const handleFrameReady = useCallback((doc, win) => {
          setFrameDoc(doc)
          setFrameWin(win)
          // 拿到文档的同时把 iframe 元素也记下来（覆盖层坐标换算的基准）
          const iframe = doc && doc.defaultView ? doc.defaultView.frameElement : null
          setFrameEl(iframe || null)
        }, [])

        const handlePageChange = useCallback((info) => {
          setPageOffset(Number.isFinite(info.pageOffsetPx) ? info.pageOffsetPx : 0)
          setFrameEl(info.frameEl || null)
          setPageTick((n) => n + 1)
        }, [])

        const handleSelection = useCallback((next) => {
          // 刚点了高亮 / 双击选中已有记录：这一轮 selectionchange 是我们自己造成的，别弹选区菜单
          if (Date.now() < suppressSelectionRef.current) {
            setSelection(null)
            return
          }
          if (!next) {
            setSelection(null)
            return
          }
          // 选区矩形是**书籍视口坐标**（且已含翻页 transform）；换算成父窗口坐标只能走
          // annotate.js 的 rangeRectToMenuBase —— 曾经在这里手写「originX + rangeRect.left - pageOffset」，
          // 于是第 N 页起菜单往左偏出 (N-1) 个页宽：越往后翻，按钮离选中的字越远。
          let rect = { left: 0, top: 0, width: 0, height: 0 }
          try {
            const rangeRect = next.range.getBoundingClientRect()
            const frameBox = frameEl ? frameEl.getBoundingClientRect() : null
            const wrapBox = viewportWrapRef.current ? viewportWrapRef.current.getBoundingClientRect() : null
            rect = rangeRectToMenuBase({
              rangeRect,
              // iframe 还没量到（首帧）时拿外层容器当锚点，至少不会把菜单扔到屏幕外
              frameBox: frameBox || wrapBox,
              layerBox: null,
              pageOffset,
            })
          } catch (error) {
            // 量不出来就把菜单放在左上角，至少能用
          }
          setSelection({ ...next, rect })
        }, [frameEl, pageOffset])

        const dismissSelection = useCallback(() => {
          setSelection(null)
          setNoteTarget(null)
          setNoteAnchorId('')
          setNoteText('')
          setNoteError('')
          try {
            if (frameWin && typeof frameWin.getSelection === 'function') frameWin.getSelection().removeAllRanges()
          } catch (error) {
            // 跨文档清选区失败不影响任何功能
          }
        }, [frameWin])

        /**
         * 统一收起所有浮层（docs/施工图 0.4.0 §3.2）。三个入口都调它：
         *   - 宿主文档 pointerdown（工具栏、空白、页脚）；
         *   - 书籍 iframe 里的 pointerdown（reader 判断完「不是拖选 / 不是链接」后回调 closeMenus）；
         *   - Esc（宿主文档与 iframe 各接一次）。
         * 只关不跳：关闭动作不产生任何导航或翻页。
         */
        const closeOverlays = useCallback(() => {
          setSettingsOpen(false)
          setHelpOpen(false)
          setAskOpen(false)
          setActiveAnn(null)
          dismissSelection()
          // 侧栏（目录 / 笔记 / 问答）由 PanelPage 管，toggle 同一个 kind = 关
          if (props.sideKind && typeof props.onToggleSide === 'function') props.onToggleSide(props.sideKind)
        }, [dismissSelection, props.onToggleSide, props.sideKind])

        // 宿主文档：点空白 / 工具栏外侧时收起；白名单里的控件不动（点它们有自己的事要做）
        useEffect(() => {
          if (typeof document === 'undefined') return undefined
          const KEEP = [
            '.dr-ask', '.dr-side', '.dr-reader-bar', '.dr-rail', '.dr-pagebar',
            '.dr-hl', '.dr-menu', '.dr-selmenu', '.dr-note', '.dr-modal', '.dr-settings',
            '.dr-help', '.dr-toast', '.dr-toc-row',
            'a[href]', 'button', 'input', 'textarea', 'select', 'label',
          ].join(',')
          const onPointerDown = (event) => {
            if (typeof event.button === 'number' && event.button !== 0) return
            const node = event.target
            if (node && typeof node.closest === 'function' && node.closest(KEEP)) return
            // 选区非空 = 用户正在划词（宿主层极少见，iframe 内由 reader 判）
            let selected = ''
            try {
              selected = typeof window.getSelection === 'function' ? String(window.getSelection() || '').trim() : ''
            } catch (error) {
              selected = ''
            }
            if (selected !== '') return
            closeOverlays()
          }
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            closeOverlays()
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [closeOverlays])

        const showToast = useCallback((text, action) => {
          if (typeof text !== 'string' || text === '') return
          setToast(text)
          setToastAction(action && typeof action.run === 'function' ? action : null)
        }, [])

        useEffect(() => {
          if (toast === '') return undefined
          const timer = setTimeout(() => {
            setToast('')
            setToastAction(null)
          }, toastAction ? 5000 : 2400)
          return () => clearTimeout(timer)
        }, [toast, toastAction])

        /**
         * 点一条问答记录：关面板 + 跳回原文并高亮（§5.5 三级降级）。
         *   CFI → 直接 jumpToCfi（reader 会闪一下目标文字）；
         *   退到章节 href → 按 spine 序号跳章；
         *   再退不了 → 什么都不做，不报错弹窗。
         */
        const onJumpQa = useCallback((record) => {
          const api = apiRef.current
          const cfi = record && typeof record.anchorCfiRange === 'string' && record.anchorCfiRange !== ''
            ? record.anchorCfiRange
            : (record && typeof record.cfi === 'string' ? record.cfi : '')
          const href = record && typeof record.chapterHref === 'string' ? record.chapterHref : ''
          if (props.sideKind && typeof props.onToggleSide === 'function') props.onToggleSide(props.sideKind)
          if (!api) return
          if (cfi !== '' && typeof api.jumpToCfi === 'function') {
            api.jumpToCfi(cfi, href)
            return
          }
          const spine = props.meta && Array.isArray(props.meta.spine) ? props.meta.spine : []
          const index = href === '' ? -1 : spine.findIndex((item) => item && item.href === href)
          if (index >= 0 && typeof api.jumpToSpine === 'function') api.jumpToSpine(index, {})
        }, [props.meta, props.onToggleSide, props.sideKind])

        /** 删除一条问答：qa.delete 已就绪就真删，失败给一句中文提示（不是静默吞掉）。 */
        const onDeleteQa = useCallback(async (record) => {
          const id = record && typeof record.id === 'string' ? record.id : ''
          if (id === '') return
          try {
            await call('qa.delete', { bookHash: props.bookHash, id })
            qaHistory.reload()
          } catch (error) {
            showToast(humanizeError(error))
          }
        }, [props.bookHash, qaHistory, showToast])

        /** 某条记录在父窗口里的矩形（操作条锚点 / 重叠时定位用）。 */
        const rectOfRecord = useCallback((record) => {
          if (!record || !frameDoc || !frameWin) return null
          try {
            const computed = computeRects({
              frameDoc,
              frameWin,
              records: [record],
              layerBox: null,
              frameBox: frameEl ? frameEl.getBoundingClientRect() : null,
              pageOffsetPx: pageOffset,
            })
            const box = computed.boxes.find((item) => !item.isBookmark)
            return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null
          } catch (error) {
            return null
          }
        }, [frameDoc, frameEl, frameWin, pageOffset])

        /**
         * 打开某条划线的操作条（点高亮 / 键盘 Enter / 重叠提示都走这里）。
         *
         * 先 selectRecord 再 setSelection(null)：点高亮会顺带选中那条文字（双击、键盘复制都能用），
         * 这个选区是程序造成的，要挡掉 reader 的「选区菜单」回调。
         */
        const activateAnnotation = useCallback((record, rect, conflictIds) => {
          if (!record || typeof record.id !== 'string') return
          suppressSelectionRef.current = Date.now() + 700
          selectRecord(frameWin, frameDoc, record)
          setSelection(null)
          setNoteTarget(null)
          setActiveAnn({
            record,
            rect: rect || rectOfRecord(record),
            conflictIds: Array.isArray(conflictIds) ? conflictIds : [],
          })
        }, [frameDoc, frameWin, rectOfRecord])

        /** 重叠拦截：不新建，聚焦已有那条（部分重叠时两条一起描边，点哪条都行）。 */
        const blockOnOverlap = useCallback((conflicts) => {
          if (!Array.isArray(conflicts) || conflicts.length === 0) return false
          const first = conflicts[0]
          const partial = conflicts.some((item) => item.kind === 'partial')
          dismissSelection()
          activateAnnotation(first.record, rectOfRecord(first.record), conflicts.map((item) => item.record.id))
          showToast(partial ? '和已有划线重叠了一部分，先改那条或换个位置' : '这段已经划过线了，点高亮能改色或删除')
          return true
        }, [activateAnnotation, dismissSelection, rectOfRecord, showToast])

        /**
         * 删除一条划线：乐观删除 + 5 秒撤销。
         * 宿主删除是 upsert 墓碑，所以「撤销」= 把原记录原样 put 回去，锚点不动。
         */
        const deleteAnnotation = useCallback(async (record) => {
          if (!record || typeof record.id !== 'string') return
          const target = record
          setActiveAnn(null)
          setSelection(null)
          annotations.removeLocal(target.id)
          try {
            await call('ann.delete', { bookHash: props.bookHash, id: target.id })
            showToast('已删除这条划线', {
              label: '撤销',
              run: async () => {
                try {
                  await annotations.restoreLocal(target)
                  showToast('已恢复')
                } catch (error) {
                  showToast(humanizeError(error))
                }
              },
            })
          } catch (error) {
            try {
              await annotations.restoreLocal(target)
            } catch (restoreError) {
              // 回滚也失败时列表会在下次 reload 时自愈，不静默吞掉用户操作
            }
            showToast(humanizeError(error))
          }
        }, [annotations, props.bookHash, showToast])

        /** 操作条改色：先改本地再落盘，失败时重读把界面拉回真实状态。 */
        const onAnnColor = useCallback(async (color) => {
          if (!activeAnn) return
          const id = activeAnn.record.id
          setActiveAnn((prev) => (prev ? { ...prev, record: { ...prev.record, color } } : prev))
          try {
            await annotations.updateColor(id, color)
          } catch (error) {
            showToast(humanizeError(error))
            annotations.reload()
          }
        }, [activeAnn, annotations, showToast])

        /** 操作条「笔记」：复用同一个 NoteEditor，保存时走 ann 的加笔记路径。 */
        const onAnnNote = useCallback(() => {
          if (!activeAnn) return
          setNoteTarget({ rect: activeAnn.rect })
          setNoteAnchorId(activeAnn.record.id)
          setNoteText(activeAnn.record.note || '')
          setNoteError('')
          setActiveAnn(null)
        }, [activeAnn])

        /** 操作条「问 AI」：把已有记录的锚点原样带进提问面板。 */
        const onAnnAsk = useCallback(() => {
          if (!activeAnn) return
          const record = activeAnn.record
          const chapter = (Array.isArray(props.toc) ? props.toc : []).find(
            (item) => item && item.href === record.chapterHref,
          )
          suppressSelectionRef.current = Date.now() + 700
          setAskAnchor({
            cfi: typeof record.cfi === 'string' ? record.cfi : '',
            text: record.textExcerpt || '',
            chapterHref: record.chapterHref,
            chapterLabel: chapter && typeof chapter.label === 'string' ? chapter.label : '',
            bookTitle: props.meta && props.meta.title ? props.meta.title : '',
            author: props.meta && props.meta.author ? props.meta.author : '',
          })
          setAskQuestion('')
          setAskAnswer('')
          setAskError('')
          setAskTurns([])
          setActiveAnn(null)
          setAskOpen(true)
        }, [activeAnn, props.meta, props.toc])

        /** 双击高亮＝整条文字设为原生选区，方便用户自己复制。 */
        const onAnnSelectText = useCallback((record) => {
          suppressSelectionRef.current = Date.now() + 700
          if (!selectRecord(frameWin, frameDoc, record)) showToast('找不到这段原文了')
          setActiveAnn(null)
        }, [frameDoc, frameWin, showToast])

        // 记录被改色 / 恢复后，操作条拿到的还是旧对象：跟 annotations.records 同步一次。
        useEffect(() => {
          if (!activeAnn) return
          const fresh = annotations.records.find((item) => item.id === activeAnn.record.id)
          if (!fresh) {
            setActiveAnn(null)
            return
          }
          if (fresh !== activeAnn.record) setActiveAnn((prev) => (prev ? { ...prev, record: fresh } : prev))
        }, [annotations.records, activeAnn])

        const onHighlight = useCallback(async (color) => {
          if (!selection) return
          const conflicts = findOverlap(frameWin, frameDoc, annotations.records, selection.range, selection.chapterHref)
          if (blockOnOverlap(conflicts)) return
          setAnnError('')
          try {
            await annotations.addHighlight({
              range: selection.range,
              text: selection.text,
              chapterHref: selection.chapterHref,
              spineIndex: selection.spineIndex,
              color,
            })
            dismissSelection()
          } catch (error) {
            setAnnError(humanizeError(error))
            dismissSelection()
          }
        }, [annotations, blockOnOverlap, dismissSelection, frameDoc, frameWin, selection])

        /**
         * 点「问 AI」：在选区还活着的时候把锚点算出来，再打开面板。
         *
         * 为什么现在就算 CFI：Range 属于书籍窗口里的选区，一旦用户关掉菜单或点别处，
         * 选区就被清掉了，事后再也拿不到「他问的是哪一段」。锚点必须先定格。
         */
        const onStartAsk = useCallback(() => {
          if (!selection) return
          let cfi = ''
          try {
            if (frameWin && selection.range) {
              cfi = CFI.fromRange(frameWin, selection.range, { index: selection.spineIndex })
            }
          } catch (error) {
            cfi = ''
          }
          if (cfi === '') {
            setAnnError('这段文字的位置算不出来，换一段再问。')
            return
          }
          const chapter = (Array.isArray(props.toc) ? props.toc : []).find(
            (item) => item && item.href === selection.chapterHref,
          )
          // 当前工作内容（0.8.0）：选区所在段落的前后文。问「这句什么意思」时，
          // 只给这一句模型只能猜；带上前后文答案立刻变准，失败重试也不用用户重述。
          const surrounding = surroundingOfSelection(selection.range)
          setAskAnchor({
            cfi,
            text: selection.text,
            chapterHref: selection.chapterHref,
            chapterLabel: chapter && typeof chapter.label === 'string' ? chapter.label : '',
            bookTitle: props.meta && props.meta.title ? props.meta.title : '',
            author: props.meta && props.meta.author ? props.meta.author : '',
            surroundingText: surrounding,
          })
          // 上次有一条没发出去（断网 / 供应商挂了）：把问题恢复回来，用户可以直接重试。
          const draft = readAskDraft(props.bookHash)
          const restored = draft && draft.question.trim() !== '' ? draft.question : ''
          setAskQuestion(restored)
          setAskAnswer('')
          setAskError(restored === '' ? '' : '上次那条没发出去，问题已经填回来了，可以直接再试一次。')
          setAskTurns([])
          setSelection(null)
          setAskOpen(true)
        }, [frameWin, props.meta, props.toc, selection])

        /** 提交提问：答案由宿主侧落进 qa.jsonl（带锚点），这里只负责显示。 */
        const onSubmitAsk = useCallback(async () => {
          if (!askAnchor) return
          const question = String(askQuestion || '').trim()
          if (question === '') {
            setAskError('先写一句想问的话。')
            return
          }
          setAsking(true)
          setAskError('')
          try {
            const payload = {
              bookHash: props.bookHash,
              question,
              selectedText: askAnchor.text,
              anchorCfiRange: askAnchor.cfi,
              chapterHref: askAnchor.chapterHref,
              chapterLabel: askAnchor.chapterLabel,
              bookTitle: props.meta && props.meta.title ? props.meta.title : '',
              author: props.meta && props.meta.author ? props.meta.author : '',
              // 当前工作内容：选区所在段落的前后文（0.8.0）
              surroundingText: askAnchor.surroundingText || '',
            }
            // 发之前先把这次请求落在本机：失败时用户不必重述，重试就是「同一份再发一次」
            rememberAskDraft(props.bookHash, payload)
            const value = await call('qa.ask', payload)
            const answer = value && typeof value.answer === 'string' ? value.answer : ''
            setAskAnswer(answer)
            // 追问逐轮累积：上一轮回答留在面板里，AI 侧记录也已落进 qa.jsonl
            setAskTurns((prev) => (answer === '' ? prev : [...prev, { question, answer }]))
            setAskQuestion('')
            // 成功了就清掉失败草稿：留着只会让下次打开时冒出一次「上次没发出去」
            forgetAskDraft(props.bookHash)
            // 新记录已经落盘，列表不用等下次打开才出现
            if (typeof qaHistory.reload === 'function') qaHistory.reload()
          } catch (error) {
            setAskError(humanizeError(error))
          } finally {
            setAsking(false)
          }
        }, [askAnchor, askQuestion, props.bookHash, props.meta, qaHistory])

        /** 「继续追问」：清掉输入框、保留上面的轮次，聚焦回输入框。 */
        const onNewQuestion = useCallback(() => {
          setAskQuestion('')
          setAskError('')
        }, [])

        const onStartNote = useCallback(() => {
          if (!selection) return
          setNoteTarget(selection)
          setNoteText('')
          setNoteError('')
          setSelection(null)
        }, [selection])

        const onSaveNote = useCallback(async () => {
          if (!noteTarget) return
          setNoteSaving(true)
          setNoteError('')
          try {
            if (noteAnchorId !== '') {
              // 给已有划线补笔记：保留原锚点与颜色，类型升为 note
              await annotations.addNote({ anchorRecordId: noteAnchorId, noteText })
            } else {
              const conflicts = findOverlap(
                frameWin,
                frameDoc,
                annotations.records,
                noteTarget.range,
                noteTarget.chapterHref,
              )
              if (blockOnOverlap(conflicts)) return
              await annotations.addHighlight({
                range: noteTarget.range,
                text: noteTarget.text,
                chapterHref: noteTarget.chapterHref,
                spineIndex: noteTarget.spineIndex,
                color: 'yellow',
                note: noteText,
              })
            }
            setNoteTarget(null)
            setNoteAnchorId('')
            setNoteText('')
            dismissSelection()
          } catch (error) {
            setNoteError(humanizeError(error))
          } finally {
            setNoteSaving(false)
          }
        }, [annotations, blockOnOverlap, dismissSelection, frameDoc, frameWin, noteAnchorId, noteTarget, noteText])

        const onBookmark = useCallback(async () => {
          setAnnError('')
          try {
            const api = apiRef.current
            if (!api) throw new Error('阅读器还没准备好，等下再试。')
            const info = api.getPageInfo()
            const cfi = typeof api.currentCfi === 'function' ? api.currentCfi() : ''
            if (cfi === '') throw new Error('这一页拿不到位置，翻一页再试。')
            await annotations.addBookmark({ cfi, chapterHref: props.meta.spine[info.chapterIndex]?.href ?? '', label: '书签' })
            dismissSelection()
          } catch (error) {
            setAnnError(humanizeError(error))
            dismissSelection()
          }
        }, [annotations, dismissSelection, props.meta])

        const onJump = useCallback((record) => {
          const api = apiRef.current
          if (api && typeof record.cfi === 'string') api.jumpToCfi(record.cfi)
        }, [])

        // 侧栏删除与操作条删除走同一条路径：乐观删除 + 5 秒撤销（不用 window.confirm，
        // 那个弹窗挡不住误删，反而让「删错了」只能靠重划一遍）。
        const onRemove = useCallback((id) => {
          const record = annotations.records.find((item) => item.id === id)
          if (record) deleteAnnotation(record)
        }, [annotations.records, deleteAnnotation])

        const sideNode = props.sideKind === 'toc'
          ? h(
            'div',
            { className: 'dr-col', style: { height: '100%', minHeight: 0, gap: 0 } },
            h('div', { className: 'dr-side-head' }, h('span', null, '目录'), h('div', { className: 'dr-grow' }), h('span', { className: 'dr-head-sub' }, tocHeadSub(props.tocSource, flattenToc(props.toc).length))),
            h(TocPanel, {
              // 没有目录（或只是硬切的「第 N 部分」）时给空数组，面板据此进空态：
              // 列一堆点了也跳不准的假章名，比承认「这本书没有目录」更糟。
              items: props.tocSource === 'none' ? [] : undefined,
              toc: props.toc,
              source: props.tocSource,
              currentSpineIndex: props.currentSpineIndex,
              error: props.tocError,
              onJump: (index) => {
                const api = apiRef.current
                if (api) api.jumpToSpine(index)
              },
            }),
          )
          : props.sideKind === 'annotations'
            ? h(AnnotationSidebar, {
              records: annotations.records,
              loading: annotations.loading,
              error: annError,
              quarantined: Object.keys(quarantinedIds).length,
              onJump,
              onRemove,
              onUpdateColor: (id, color) => {
                annotations.updateColor(id, color).catch((error) => setAnnError(humanizeError(error)))
              },
            })
            : props.sideKind === 'qa'
              ? h(QaSidebar, {
                records: qaHistory.records,
                loading: qaHistory.loading,
                error: qaHistory.error,
                onJump: onJumpQa,
                onDelete: onDeleteQa,
                onReload: qaHistory.reload,
                onClose: () => {
                  if (typeof props.onToggleSide === 'function') props.onToggleSide('qa')
                },
              })
              : props.sideKind === 'search'
                ? h(SearchPanel, {
                  open: true,
                  query: searchQuery,
                  onChange: setSearchQuery,
                  onSubmit: runSearch,
                  results: searchResults,
                  searching,
                  error: searchError,
                  onJump: (hit) => {
                    const api = apiRef.current
                    if (!api || !hit) return
                    // 命中位置以「这一章的第几成」给，reader 换算成页号（分页模型不能 scrollIntoView）
                    api.jumpToSpine(hit.spineIndex, { percent: hit.percent, flash: true })
                  },
                  onClose: () => {
                    if (typeof props.onToggleSide === 'function') props.onToggleSide('search')
                  },
                })
                : props.sideKind === 'ai'
                  ? h(
                    'div',
                    { className: 'dr-col', style: { height: '100%', minHeight: 0, gap: 0 } },
                    h('div', { className: 'dr-side-head' },
                      h('span', null, 'AI 状态'),
                      h('div', { className: 'dr-grow' }),
                      h('span', { className: 'dr-head-sub' },
                        statusSummary(aiCenter.status, { probing: aiCenter.probing }).tone === 'ok' ? '正常' : '有问题')),
                    h(AiModelPicker, {
                      models: aiCenter.models,
                      saving: aiCenter.savingModel === true,
                      onChange: aiCenter.changeModel,
                    }),
                    h(AiPanel, {
                      status: aiCenter.status,
                      items: aiCenter.items,
                      loading: aiCenter.loading,
                      probing: aiCenter.probing,
                      error: aiCenter.error,
                      onProbe: aiCenter.probe,
                      onRefresh: aiCenter.reload,
                      onClear: aiCenter.clear,
                    }),
                  )
                  : props.sideKind === 'distill'
                    ? h(
                      'div',
                      { className: 'dr-col', style: { height: '100%', minHeight: 0, gap: 0 } },
                      h('div', { className: 'dr-side-head' },
                        h('span', null, '读书蒸馏'),
                        h('div', { className: 'dr-grow' }),
                        h('span', { className: 'dr-head-sub' },
                          `${distillSummary(distill.data).done} / ${distillSummary(distill.data).total} 章`)),
                      distill.error
                        ? h('div', { className: 'dr-error', style: { margin: '0 12px 8px' } }, distill.error)
                        : null,
                      distill.notice
                        ? h('div', { className: 'dr-dist-toast' }, distill.notice)
                        : null,
                      h(DistillPanel, {
                        data: distill.data,
                        loading: distill.loading,
                        error: '',
                        busyHref: distill.busyHref,
                        aiStatus: aiCenter.status,
                        onChapter: distill.runChapter,
                        onSkeleton: distill.runSkeleton,
                        onExport: distill.runExport,
                        onClear: distill.runClear,
                        onOpenAi: () => {
                          if (typeof props.onToggleSide === 'function') props.onToggleSide('ai')
                        },
                        onJump: (href) => {
                          const chapters = distill.data && Array.isArray(distill.data.chapters) ? distill.data.chapters : []
                          const hit = chapters.find((item) => item && item.href === href)
                          const api = apiRef.current
                          if (hit && api && typeof api.jumpToSpine === 'function') api.jumpToSpine(hit.index)
                        },
                      }),
                    )
                    : null

        /**
         * 改设置：立刻生效（父组件 state 更新 → reader 重排），500ms 后落盘。
         *
         * 为什么要去抖：拖字号滑杆会连着产生几十次改动，每次都写 settings.json
         * 会把历史目录刷成全屏垃圾 —— 而「改坏字号能回滚」正是 history 存在的理由。
         */
        const patchSettings = useCallback((patch) => {
          const next = { ...settingsRef.current, ...patch }
          settingsRef.current = next
          if (typeof props.onPatchSettings === 'function') props.onPatchSettings(next)
          setSettingsSaving(true)
          setSettingsError('')

          if (settingsSaveTimer.current !== null) clearTimeout(settingsSaveTimer.current)
          settingsSaveTimer.current = setTimeout(async () => {
            settingsSaveTimer.current = null
            try {
              const saved = await call('settings.put', patch)
              if (saved && typeof saved === 'object' && typeof props.onPatchSettings === 'function') {
                props.onPatchSettings({ ...settingsRef.current, ...saved })
              }
            } catch (error) {
              setSettingsError(humanizeError(error))
            } finally {
              setSettingsSaving(false)
            }
          }, 500)
        }, [props.onPatchSettings])

        useEffect(() => () => {
          if (settingsSaveTimer.current !== null) clearTimeout(settingsSaveTimer.current)
        }, [])

        // 第一次进阅读器自动弹一次说明；之后只在用户点「?」时打开
        useEffect(() => {
          try {
            if (typeof window === 'undefined' || !window.localStorage) return
            if (window.localStorage.getItem('dsh-reading:help-seen') === '1') return
            window.localStorage.setItem('dsh-reading:help-seen', '1')
            setHelpOpen(true)
          } catch (error) {
            // localStorage 被禁（隐私模式）就不弹，不算错
          }
        }, [])

        return h(
          'div',
          { className: 'dr-root', ref: viewportWrapRef },
          annError && !annotations.loading
            ? h('div', { className: 'dr-error-box', role: 'alert', style: { margin: '8px 12px 0' } }, annError)
            : null,
          h(ReaderView, {
            bookHash: props.bookHash,
            meta: props.meta,
            initialCfi: props.initialCfi,
            initialPercent: props.initialPercent,
            settings: props.settings,
            apiRef,
            onFrameReady: handleFrameReady,
            onPageChange: handlePageChange,
            onSelection: handleSelection,
            onProgress: props.onProgress,
            onClose: props.onClose,
            onOpenSettings: () => {
              setSettingsOpen((open) => !open)
              setHelpOpen(false)
            },
            onOpenHelp: () => {
              setHelpOpen(true)
              setSettingsOpen(false)
            },
            // 问答入口的条数徽标：reader 工具栏上常驻
            qaCount: qaHistory.records.length,
            // 工具栏上的 AI 状态点：颜色直接告诉用户「现在能不能用」
            aiStatus: aiCenter.status,
            aiProbing: aiCenter.probing,
            onOpenAi: () => {
              if (typeof props.onToggleSide === 'function') props.onToggleSide('ai')
            },
            // 读书蒸馏入口（0.8.0）
            distillDone: distillSummary(distill.data).done,
            onOpenDistill: () => {
              if (typeof props.onToggleSide === 'function') props.onToggleSide('distill')
            },
            // 正文点击 / Esc 收起浮层（reader 判断完白名单与拖选后回调）
            closeMenus: closeOverlays,
            // 书内链接跨章跳转与一句中文提示
            onJumpSpine: (index, target) => {
              const api = apiRef.current
              if (api && typeof api.jumpToSpine === 'function') api.jumpToSpine(index, target)
            },
            onNotice: showToast,
            sideKind: props.sideKind,
            sideWidth: SIDE_WIDTH,
            side: sideNode,
            onToggleSide: props.onToggleSide,
            overlay: frameDoc
              ? h(Overlayer, {
                records: annotations.records,
                frameWin,
                frameDoc,
                frameEl,
                pageOffsetPx: pageOffset,
                repaintKey: pageTick,
                activeId: activeAnn ? activeAnn.record.id : null,
                conflictIds: activeAnn ? activeAnn.conflictIds : [],
                onActivate: (record, rect) => activateAnnotation(record, rect),
                onSelectText: onAnnSelectText,
                onDelete: deleteAnnotation,
                onDismiss: () => setActiveAnn(null),
                onBadAnchor,
              })
              : null,
          }),
          settingsOpen
            ? h(SettingsDrawer, {
              settings: props.settings,
              saving: settingsSaving,
              error: settingsError,
              onChange: patchSettings,
              onClose: () => setSettingsOpen(false),
            })
            : null,
          helpOpen
            ? h(HelpDialog, { onClose: () => setHelpOpen(false) })
            : null,
          // 一句中文提示（外链被拦 / 邮箱已复制），不占布局、不拦点击
          toast !== ''
            ? h('div', {
              className: `dr-toast${toastAction ? ' dr-toast-with-action' : ''}`,
              role: 'status',
              style: {
                position: 'fixed',
                left: '50%',
                bottom: '64px',
                transform: 'translateX(-50%)',
                zIndex: 9999,
                maxWidth: '80vw',
                padding: '7px 14px',
                borderRadius: '10px',
                background: 'rgba(32,32,36,0.92)',
                color: '#fff',
                fontSize: '12px',
                lineHeight: 1.5,
                pointerEvents: toastAction ? 'auto' : 'none',
                boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
              },
            },
            h('span', null, toast),
            toastAction
              ? h('button', {
                type: 'button',
                className: 'dr-toast-action',
                onClick: () => {
                  const action = toastAction
                  setToast('')
                  setToastAction(null)
                  if (action && typeof action.run === 'function') action.run()
                },
              }, toastAction.label)
              : null)
            : null,
          h(SelectionMenu, {
            selection,
            onHighlight,
            onAsk: onStartAsk,
            onNote: onStartNote,
            onBookmark,
            onDismiss: dismissSelection,
          }),
          activeAnn
            ? h(AnnotationMenu, {
              record: activeAnn.record,
              rect: activeAnn.rect,
              onColor: onAnnColor,
              onNote: onAnnNote,
              onAsk: onAnnAsk,
              onDelete: () => deleteAnnotation(activeAnn.record),
              onClose: () => setActiveAnn(null),
            })
            : null,
          h(AskPanel, {
            open: askOpen,
            selection: askAnchor,
            question: askQuestion,
            onChange: setAskQuestion,
            onSubmit: onSubmitAsk,
            onClose: () => setAskOpen(false),
            asking: askAsking,
            answer: askAnswer,
            turns: askTurns,
            error: askError,
            bookHash: props.bookHash,
            metaText: askAnswer === '' ? '' : '已保存到这本书的问答里',
            // 这次调用随身携带了什么、现在 AI 通不通（0.8.0）
            surroundingChars: askAnchor && typeof askAnchor.surroundingText === 'string' ? askAnchor.surroundingText.length : 0,
            aiStatus: aiCenter.status,
            aiProbing: aiCenter.probing,
            onOpenAi: () => {
              setAskOpen(false)
              if (typeof props.onToggleSide === 'function') props.onToggleSide('ai')
            },
          }),
          h(NoteEditor, {
            rect: noteTarget ? noteTarget.rect : null,
            value: noteText,
            onChange: setNoteText,
            onSave: onSaveNote,
            onCancel: () => {
              setNoteTarget(null)
              setNoteText('')
              setNoteError('')
            },
            saving: noteSaving,
            error: noteError,
          }),
        )
      }

      /**
       * 面板根组件。两个屏幕（书架 / 阅读器）在这里切换。
       *
       * 开一本书要拿四样东西：meta（标题 + spine）、toc（目录）、progress（上次读到哪）、
       * settings（字号栏宽）。四个并行发，任何一个失败都算「打不开这本书」——
       * 缺 spine 的阅读器没法翻页，缺 toc 还能读，所以 toc 失败只降级不拦截。
       */
      function PanelPage(props) {
        const [screen, setScreen] = useState('shelf')
        const [bookHash, setBookHash] = useState('')
        const [meta, setMeta] = useState(null)
        const [toc, setToc] = useState(null)
        const [tocError, setTocError] = useState('')
        // 目录是哪来的（nav / ncx / auto / headings / spine / split / none）。
        // 界面靠它决定标不标「自动识别」、还是干脆进空态 —— 猜出来的目录必须自报家门。
        const [tocSource, setTocSource] = useState('none')
        const [initialCfi, setInitialCfi] = useState(null)
        const [initialPercent, setInitialPercent] = useState(0)
        const [settings, setSettings] = useState(DEFAULT_SETTINGS)
        const [loading, setLoading] = useState(false)
        const [error, setError] = useState('')
        const [sideKind, setSideKind] = useState('toc')
        const [currentSpineIndex, setCurrentSpineIndex] = useState(0)
        const [openToken, setOpenToken] = useState(0)

        useEffect(() => {
          // 组件挂载时再补一次：apply 早于 <head> 完全就绪的情况是存在的
          if (typeof document === 'undefined') return
          ensureStyle(document)
          ensureQaStyle(document)
        }, [])

        const openBook = useCallback(async (hash) => {
          setBookHash(hash)
          setScreen('reader')
          setLoading(true)
          setError('')
          setMeta(null)
          setToc(null)
          setTocError('')
          setTocSource('none')
          setCurrentSpineIndex(0)
          setOpenToken((n) => n + 1)

          const settle = async (promise) => {
            try {
              return { ok: true, value: await promise }
            } catch (err) {
              return { ok: false, error: err }
            }
          }

          const [metaResult, tocResult, progressResult, settingsResult] = await Promise.all([
            settle(call('book.meta', { bookHash: hash })),
            settle(call('book.toc', { bookHash: hash })),
            settle(call('progress.get', { bookHash: hash })),
            settle(call('settings.get')),
          ])

          if (!metaResult.ok) {
            setError(humanizeError(metaResult.error))
            setLoading(false)
            return
          }

          setMeta(metaResult.value)
          // 目录来源有两处可信信息：book.toc 响应里的 source（宿主当场解析出来的，最新）
          // 和 meta.tocSource（落盘时记下的）。前者优先；两处都没有就是老库，按 none 处理
          // （老库的目录「有就列、没有就造」，不可信，见 store.toc 的注释）。
          const tocValue = tocResult.ok && tocResult.value ? tocResult.value : null
          const sourceFromToc = tocValue && typeof tocValue.source === 'string' ? tocValue.source : ''
          const sourceFromMeta = metaResult.value && typeof metaResult.value.tocSource === 'string'
            ? metaResult.value.tocSource
            : ''
          const source = sourceFromToc || sourceFromMeta || 'none'
          // 面板只认四种展示来源（nav / ncx / auto / none）：
          //   · split / spine 是宿主硬切出来的「第 N 部分」占位，点不准，一律展示成「没有目录」；
          //   · headings 是自动识别，展示成 auto，侧栏角标和说明文字才与 tocHeadSub 一致。
          // 存进 state 的是「展示来源」而不是原始枚举：TocPanel 靠它决定空态与角标。
          const SHOW_SOURCE = { split: 'none', spine: 'none', headings: 'auto' }
          const displaySource = SHOW_SOURCE[source] || (['nav', 'ncx', 'auto', 'none'].includes(source) ? source : 'none')
          setTocSource(displaySource)
          if (tocValue) {
            setToc(Array.isArray(tocValue.toc) ? tocValue.toc : [])
          } else {
            setToc([])
            setTocError(tocResult.ok ? '' : humanizeError(tocResult.error))
          }

          const progress = progressResult.ok ? progressResult.value : null
          if (progress && typeof progress.cfi === 'string' && progress.cfi !== '') {
            setInitialCfi(progress.cfi)
          } else {
            setInitialCfi(null)
          }
          setInitialPercent(progress && Number.isFinite(progress.percent) ? progress.percent : 0)

          if (settingsResult.ok && settingsResult.value) {
            setSettings({ ...DEFAULT_SETTINGS, ...settingsResult.value })
          }

          setLoading(false)
        }, [])

        const closeBook = useCallback(() => {
          setScreen('shelf')
          setMeta(null)
          setToc(null)
          setTocSource('none')
          setBookHash('')
          setError('')
          setInitialCfi(null)
        }, [])

        const onProgress = useCallback((payload) => {
          setCurrentSpineIndex((prev) => {
            if (!meta || !Array.isArray(meta.spine)) return prev
            const index = meta.spine.findIndex((item) => item && item.href === payload.chapterHref)
            return index >= 0 ? index : prev
          })
          if (typeof payload.cfi !== 'string' || payload.cfi === '') return
          call('progress.put', {
            bookHash,
            cfi: payload.cfi,
            cfiStart: payload.cfiStart,
            chapterHref: payload.chapterHref,
            percent: payload.percent,
          }).catch((error) => {
            // 进度写入失败不打断阅读：用户还在读书，弹个错误条反而碍事
            console.warn('[dsh-reading] 进度没存上：', humanizeError(error))
          })
        }, [bookHash, meta])

        const toggleSide = useCallback((kind) => {
          setSideKind((prev) => (prev === kind ? null : kind))
        }, [])

        if (screen === 'shelf') {
          return h(
            'div',
            { className: 'dr-root' },
            h(ShelfView, {
              onOpen: openBook,
              onImported: (hash) => {
                openBook(hash)
              },
            }),
          )
        }

        if (loading) {
          return h(
            'div',
            { className: 'dr-root' },
            h(
              'div',
              { className: 'dr-head' },
              h('button', { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: closeBook }, '← 书架'),
              h('div', { className: 'dr-head-title' }, '正在打开…'),
            ),
            h(Loading, { text: '正在准备这本书…' }),
          )
        }

        if (error !== '') {
          return h(
            'div',
            { className: 'dr-root' },
            h(
              'div',
              { className: 'dr-head' },
              h('button', { type: 'button', className: 'dr-btn dr-btn-ghost dr-btn-sm', onClick: closeBook }, '← 书架'),
              h('div', { className: 'dr-head-title' }, '打不开这本书'),
            ),
            h(ErrorState, {
              title: '打不开这本书',
              text: error,
              onRetry: () => openBook(bookHash),
            }),
          )
        }

        if (!meta) {
          return h(
            'div',
            { className: 'dr-root' },
            h(ErrorState, { title: '这本书没有信息', text: '文件可能损坏了，重新导入一次试试。' }),
          )
        }

        return h(ReaderScreen, {
          key: `${bookHash}:${openToken}`,
          bookHash,
          meta,
          toc,
          tocSource,
          tocError,
          initialCfi,
          initialPercent,
          settings,
          onPatchSettings: setSettings,
          sideKind,
          currentSpineIndex,
          onToggleSide: toggleSide,
          onProgress,
          onClose: closeBook,
        })
      }

      /**
       * 左侧栏那个图标。
       *
       * 用内联 SVG 而不是 emoji：图标要跟主题前景色走，emoji 在深色主题下会显得脏。
       * `currentColor` 让它在任何主题下都是「这一行的文字颜色」。
       */
      function PanelIcon(props) {
        const size = Number.isFinite(props && props.size) ? props.size : 18
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          // 一本打开的书：左页 + 右页 + 中缝
          h('path', { d: 'M12 6.2C10.4 5 8.3 4.5 5.6 4.7c-.6 0-1.1.5-1.1 1.1v11.3c0 .6.5 1.1 1.1 1.1 2.7-.2 4.8.3 6.4 1.5' }),
          h('path', { d: 'M12 6.2C13.6 5 15.7 4.5 18.4 4.7c.6 0 1.1.5 1.1 1.1v11.3c0 .6-.5 1.1-1.1 1.1-2.7-.2-4.8.3-6.4 1.5' }),
          h('path', { d: 'M12 6.2v13.5' }),
          h('path', { d: 'M8 8.4h2M8 11.2h2M14 8.4h2M14 11.2h2' }),
        )
      }

      /**
       * 插件入口。
       *
       * 只做注册，不做任何 IO：`dsh.web` 启动时 apply 会被调用，
       * 这里一旦 await 或抛错，整个 slot 会静默退役（面板消失且没有报错）。
       *
       * `slots.inject(key, fn)` 的语义：座位什么时候出现由外壳决定，
       * 座位不在就先不注册；座位出现时 fn 会再跑一次。所以两个注册都必须返回 disposer，
       * 并在同一个 ctx.effect 里成对回收 —— 少回收一个，重载后图标会重复。
       */
      /**
       * PWA：把「添加到主屏幕」需要的东西挂进宿主页面。
       *
       * 为什么由客户端注入而不是让宿主发：插件只拿到 `register` 前缀路由的控制权，
       * 拿不到页面 head。manifest 走本插件自己的路由（`/api/dsh-reading/manifest.webmanifest`），
       * 这里只负责把 <link> 与几个 meta 挂上。idempotent：重复 apply（热重载）不会叠两遍。
       */
      function ensurePwaHead(doc) {
        if (!doc || !doc.head) return
        const has = (selector) => doc.head.querySelector(selector) !== null
        const append = (tag, attrs) => {
          const node = doc.createElement(tag)
          for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
          node.setAttribute('data-dsh-reading', '')
          doc.head.appendChild(node)
        }
        try {
          if (!has('link[rel="manifest"]')) {
            append('link', { rel: 'manifest', href: '/api/dsh-reading/manifest.webmanifest' })
          }
          if (!has('meta[name="theme-color"]')) append('meta', { name: 'theme-color', content: '#fcfbf8' })
          if (!has('meta[name="mobile-web-app-capable"]')) {
            append('meta', { name: 'mobile-web-app-capable', content: 'yes' })
          }
          // iOS 不认 manifest 的 display，要这组苹果专用 meta 才会全屏打开
          if (!has('meta[name="apple-mobile-web-app-capable"]')) {
            append('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' })
          }
          if (!has('meta[name="apple-mobile-web-app-title"]')) {
            append('meta', { name: 'apple-mobile-web-app-title', content: '深读' })
          }
        } catch (error) {
          // 沙箱宿主里改 head 可能抛 SecurityError；装不上图标不该影响读书
          console.warn('[dsh-reading] PWA head 注入失败：', String(error?.message ?? error))
        }
      }

      function apply(ctx) {
        // apply 一旦抛错，整条 slot 会静默退役（面板消失且没有报错）。
        // 所以样式注入必须裹在 try 里：它只是锦上添花，任何失败都不该带走面板本身。
        // （原来只判 typeof document，但 ensureStyle 内部还要建 <style>、插 head，
        //   沙箱宿主里这一步会抛 SecurityError。）
        try {
          if (typeof document !== 'undefined') {
            ensureStyle(document)
            // 问答侧栏 / 问 AI 精修的样式：幂等，重复注入不会叠
            ensureQaStyle(document)
            // PWA：手机上「添加到主屏幕」，打开就是全屏阅读
            ensurePwaHead(document)
          }
        } catch (error) {
          console.warn('[dsh-reading] 样式注入失败，界面会退化成无样式：', String(error?.message ?? error))
        }

        const slots = ctx && ctx.slots
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          // 没有 slots 服务就什么都不做：不算失败，只是这个宿主版本不提供 UI 座位
          console.warn('[dsh-reading] 当前宿主没有 slots 服务，面板入口不提供。')
          return
        }

        ctx.effect(() => {
          const disposers = []

          // 一、主区域：点左侧栏图标后显示的就是它
          // main 是 **keyed** 插槽，官方 registerOptions 只登记了 key —— 不要顺手带
          // priority / order 这类没登记过的选项：宽松校验的宿主会当冗余字段忽略，
          // 严格校验的宿主会直接抛错，而 apply 一抛错整条 slot 就静默退役（面板消失）。
          disposers.push(slots.inject('main', () => slots.register({
            name: 'main',
            key: PANEL_ID,
          }, PanelPage)))

          // 二、左侧栏那一排图标
          disposers.push(slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => 'Reading',
          }, PanelIcon)))

          return () => {
            for (const dispose of disposers.splice(0)) {
              // 回收时某一边出错，不该把另一边漏在那儿（否则图标会重复）
              try {
                dispose()
              } catch (error) {
                // 卸载路径上的失败没有办法上报，也不影响已经撤掉的那一边
              }
            }
          }
        }, 'dsh-reading: 面板入口')
      }

      /** 静态数组，不能是函数或变量 —— client-modules 在扫描期就要读到它。 */
      const inject = ['slots']

      // ── 对外可见的组件面 ──────────────────────────────────────────
      // 产物只有一个出口（exports 从 app 的导出表生成），所以调试与测试要用的东西
      // 都从这里透出去。它们不影响宿主的加载契约：宿主只认 apply / inject。
      //   TocPanel / AnnotationSidebar / Overlayer 给测试逐块渲染；
      //   computeRects 是覆盖层的几何纯函数，也是「不改正文 DOM」的证明点。

      return { surroundingOfSelection: surroundingOfSelection, rememberAskDraft: rememberAskDraft, readAskDraft: readAskDraft, forgetAskDraft: forgetAskDraft, PanelPage: PanelPage, PanelIcon: PanelIcon, apply: apply, inject: inject, computeRects: computeRects, Overlayer: Overlayer, AnnotationMenu: AnnotationMenu, AnnotationSidebar: AnnotationSidebar, SelectionMenu: SelectionMenu, AskPanel: AskPanel, ReaderView: ReaderView, ShelfView: ShelfView, TocPanel: TocPanel }
    })()
    // ── 入口：宿主只认这两个名字 ──
    exports.apply = __mod_app_js.apply
    exports.inject = __mod_app_js.inject
    // ── 组件也透出去（调试 / 测试用；不影响宿主的加载契约） ──
    exports.surroundingOfSelection = __mod_app_js.surroundingOfSelection
    exports.rememberAskDraft = __mod_app_js.rememberAskDraft
    exports.readAskDraft = __mod_app_js.readAskDraft
    exports.forgetAskDraft = __mod_app_js.forgetAskDraft
    exports.PanelPage = __mod_app_js.PanelPage
    exports.PanelIcon = __mod_app_js.PanelIcon
    exports.computeRects = __mod_app_js.computeRects
    exports.Overlayer = __mod_app_js.Overlayer
    exports.AnnotationMenu = __mod_app_js.AnnotationMenu
    exports.AnnotationSidebar = __mod_app_js.AnnotationSidebar
    exports.SelectionMenu = __mod_app_js.SelectionMenu
    exports.AskPanel = __mod_app_js.AskPanel
    exports.ReaderView = __mod_app_js.ReaderView
    exports.ShelfView = __mod_app_js.ShelfView
    exports.TocPanel = __mod_app_js.TocPanel
    return module.exports
  },
})
