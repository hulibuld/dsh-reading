/**
 * 极简、严格、无 DTD 的 XML 解析器（供 epub.js 用）。
 *
 * 只做 EPUB 真正需要的那一小块：
 *   - 元素 / 属性 / 文本 / CDATA / 注释 / 处理指令 / DOCTYPE（**只跳过，不展开**）；
 *   - 命名空间前缀原样保留在名字里（`dc:title` 就是名字 `dc:title`），不做 NS 解析；
 *   - 五个预定义实体 + 数字实体（`&#38;` / `&#x26;`）。
 *
 * 为什么不用现成库：零运行时依赖（docs/05 §1）；为什么不「尽力而为」：
 * 静默修好的畸形文档会让 CFI 指向错误位置（docs/05 §3.6），宁可硬失败。
 *
 * 安全面：禁外部实体、禁 DTD 展开、禁网络。DOCTYPE 里除了 `[` `]` 内部子集
 * 整体跳过之外，任何实体声明都不会被记录，因此 `&xxe;` 只会当成普通文本保留。
 *
 * 什么时候会失败、失败给谁看：
 *   - 结构不合法（不闭合、标签不匹配、属性没有值、非法字符引用）→ 抛 `E_XML_MALFORMED`，
 *     带行列号但**只在 detail 里**；用户看到的是 epub.js 包装后的「这本书的内容格式不对」。
 */

import { fail } from './errors.js'

/** 预定义实体。XML 只有这五个，其余必须靠 DTD 声明——而我们不展开 DTD。 */
const PREDEFINED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[A-Za-z0-9_:.\-]/
const WS = /[ \t\r\n]/

function malformed(detail, line, column) {
  return fail('E_XML_MALFORMED', '这本书的内容格式不对，读不了。', {
    detail: `${detail} at ${line}:${column}`,
  })
}

/** 行/列只用来说明故障点，进日志；不拼进 message。 */
function position(text, index) {
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1
      lastBreak = i
    }
  }
  return { line, column: index - lastBreak }
}

/**
 * 解码实体。**未知实体按原样保留**（`&xxe;` 保持 `&xxe;`），这是刻意的：
 * 我们不能替用户决定 `&nbsp;` 是不是空白（那需要 DTD），也不知道 `&xxe;` 是什么。
 * 保留原文是最不可能丢信息的做法。
 *
 * @param {string} text
 * @param {(detail: string) => Error} onBad
 * @returns {string}
 */
function decodeEntities(text, onBad) {
  if (text.indexOf('&') < 0) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const amp = text.indexOf('&', i)
    if (amp < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, amp)
    const semi = text.indexOf(';', amp + 1)
    // 超过 ~16 个字符还没遇到分号，几乎肯定不是实体，按字面输出 `&`。
    if (semi < 0 || semi - amp > 16) {
      out += '&'
      i = amp + 1
      continue
    }
    const body = text.slice(amp + 1, semi)
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const digits = hex ? body.slice(2) : body.slice(1)
      const valid = hex ? /^[0-9A-Fa-f]+$/.test(digits) : /^[0-9]+$/.test(digits)
      if (!valid || digits === '') throw onBad(`bad character reference &${body};`)
      const code = Number.parseInt(digits, hex ? 16 : 10)
      // 0 与代理区、超出 Unicode 上界都不是合法 XML 字符。
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw onBad(`invalid character reference &${body};`)
      }
      out += String.fromCodePoint(code)
      i = semi + 1
      continue
    }
    if (Object.hasOwn(PREDEFINED, body)) {
      out += PREDEFINED[body]
      i = semi + 1
      continue
    }
    // 未知实体：原样保留（见上面的注释），连同 `&` 一起跳过，避免死循环。
    out += `&${body};`
    i = semi + 1
  }
  return out
}

/**
 * 解析 XML 文本。
 *
 * 返回的树只有三种节点：
 *   `{ type:'element', name, attrs, children }`
 *   `{ type:'text', value }`      —— 已解码实体，**不 trim、不折叠空白**
 *   `{ type:'cdata', value }`     —— CDATA 原文，未解码
 * 注释 / 处理指令 / DOCTYPE 一律丢弃（CFI 的规范化树也忽略它们，docs/01 §3.2）。
 *
 * @param {string} text
 * @returns {{ type: 'root', children: Array<any> }}
 */
/**
 * 允许的最大元素嵌套深度。
 *
 * 这个数字要够大（正文里 div/span 包裹能到十几层，脚注套脚注也不稀奇），
 * 又要够小（递归 walker 的栈深度安全边界）。512 在两边都留了很大余量。
 */
const MAX_DEPTH = 512

export function parseXml(text) {
  if (typeof text !== 'string') {
    throw fail('E_XML_MALFORMED', '这本书的内容格式不对，读不了。', { detail: 'input is not a string' })
  }

  /** @type {Array<any>} */
  const rootChildren = []
  /** 元素栈；栈底是伪根。 */
  const stack = [{ type: 'root', name: '#document', attrs: Object.create(null), children: rootChildren }]
  let index = 0

  const top = () => stack[stack.length - 1]

  while (index < text.length) {
    const lt = text.indexOf('<', index)

    // ── 文本 ──
    if (lt < 0) {
      const raw = text.slice(index)
      if (raw !== '') {
        const { line, column } = position(text, index)
        top().children.push({ type: 'text', value: decodeEntities(raw, (d) => malformed(d, line, column)) })
      }
      index = text.length
      break
    }
    if (lt > index) {
      const raw = text.slice(index, lt)
      const { line, column } = position(text, index)
      top().children.push({ type: 'text', value: decodeEntities(raw, (d) => malformed(d, line, column)) })
      index = lt
    }

    // ── 标记 ──
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4)
      if (end < 0) {
        const { line, column } = position(text, index)
        throw malformed('unterminated comment', line, column)
      }
      index = end + 3
      continue
    }

    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9)
      if (end < 0) {
        const { line, column } = position(text, index)
        throw malformed('unterminated CDATA section', line, column)
      }
      top().children.push({ type: 'cdata', value: text.slice(index + 9, end) })
      index = end + 3
      continue
    }

    if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2)
      if (end < 0) {
        const { line, column } = position(text, index)
        throw malformed('unterminated processing instruction', line, column)
      }
      index = end + 2
      continue
    }

    if (text.startsWith('<!', index)) {
      // DOCTYPE（可能带 [...] 内部子集）。**只跳过，不解析、不记录实体。**
      let cursor = index + 2
      let depth = 0
      while (cursor < text.length) {
        const ch = text[cursor]
        if (ch === '[') depth += 1
        else if (ch === ']') depth -= 1
        else if (ch === '>' && depth <= 0) break
        cursor += 1
      }
      if (cursor >= text.length) {
        const { line, column } = position(text, index)
        throw malformed('unterminated declaration', line, column)
      }
      index = cursor + 1
      continue
    }

    if (text.startsWith('</', index)) {
      const end = text.indexOf('>', index + 2)
      if (end < 0) {
        const { line, column } = position(text, index)
        throw malformed('unterminated end tag', line, column)
      }
      const name = text.slice(index + 2, end).trim()
      const current = top()
      if (current.type !== 'element' || current.name !== name) {
        const { line, column } = position(text, index)
        throw malformed(
          `end tag </${name}> does not match <${current.type === 'element' ? current.name : '#document'}>`,
          line,
          column,
        )
      }
      stack.pop()
      index = end + 1
      continue
    }

    // ── 起始标签（含自闭合） ──
    const { line, column } = position(text, index)
    let cursor = index + 1
    if (cursor >= text.length || !NAME_START.test(text[cursor])) {
      throw malformed('invalid tag name', line, column)
    }
    const nameStart = cursor
    while (cursor < text.length && NAME_CHAR.test(text[cursor])) cursor += 1
    const name = text.slice(nameStart, cursor)

    /** @type {Record<string, string>} */
    const attrs = Object.create(null)
    let selfClosing = false

    for (;;) {
      // 跳过空白
      while (cursor < text.length && WS.test(text[cursor])) cursor += 1
      if (cursor >= text.length) throw malformed('unterminated start tag', line, column)
      if (text[cursor] === '>') {
        cursor += 1
        break
      }
      if (text[cursor] === '/' && text[cursor + 1] === '>') {
        selfClosing = true
        cursor += 2
        break
      }
      // 属性名
      const attrStart = cursor
      if (!NAME_START.test(text[cursor])) {
        throw malformed(`invalid attribute in <${name}>`, line, column)
      }
      while (cursor < text.length && NAME_CHAR.test(text[cursor])) cursor += 1
      const attrName = text.slice(attrStart, cursor)
      while (cursor < text.length && WS.test(text[cursor])) cursor += 1
      if (text[cursor] !== '=') {
        throw malformed(`attribute ${attrName} in <${name}> has no value`, line, column)
      }
      cursor += 1
      while (cursor < text.length && WS.test(text[cursor])) cursor += 1
      const quote = text[cursor]
      if (quote !== '"' && quote !== "'") {
        throw malformed(`attribute ${attrName} in <${name}> is not quoted`, line, column)
      }
      cursor += 1
      const valueEnd = text.indexOf(quote, cursor)
      if (valueEnd < 0) {
        throw malformed(`attribute ${attrName} in <${name}> is unterminated`, line, column)
      }
      const rawValue = text.slice(cursor, valueEnd)
      // XML 规范：属性值里的 `<` 非法；`&` 必须走实体。
      if (rawValue.includes('<')) {
        throw malformed(`attribute ${attrName} in <${name}> contains '<'`, line, column)
      }
      attrs[attrName] = decodeEntities(rawValue, (d) => malformed(d, line, column))
      cursor = valueEnd + 1
    }

    const element = { type: 'element', name, attrs, children: [] }
    top().children.push(element)
    if (!selfClosing) {
      // 嵌套深度上限。解析器本身是迭代的，不会爆栈；但下游 findAll / textOf
      // 是递归的，而且 CFI 解析也要沿 DOM 深度走。一份 20 万层 `<div>` 的
      // 章节（几百 KB 就够）能让 textOf 抛 RangeError: Maximum call stack size
      // exceeded —— 那不是我们能翻译成 8 个失败码的异常，会一路冒到路由层。
      // 在入口处按住，代价是一本正常 EPUB 最深也就几十层。
      if (stack.length > MAX_DEPTH) {
        throw malformed(`元素嵌套超过 ${MAX_DEPTH} 层`, line, column)
      }
      stack.push(element)
    }
    index = cursor
  }

  if (stack.length > 1) {
    const open = stack[stack.length - 1]
    const { line, column } = position(text, text.length)
    throw malformed(`unclosed tag <${open.name}>`, line, column)
  }

  return { type: 'root', children: rootChildren }
}

/** 元素名匹配（支持 `*` 与 `local`，忽略命名空间前缀）。 */
function nameMatches(nodeName, wanted) {
  if (wanted === '*') return true
  if (nodeName === wanted) return true
  const colon = nodeName.indexOf(':')
  const local = colon >= 0 ? nodeName.slice(colon + 1) : nodeName
  return local === wanted
}

/**
 * 深度优先找出所有满足条件的元素（不匹配者也继续往下找）。
 *
 * @param {any} node - parseXml 的结果或任意节点。
 * @param {(node: any) => boolean} pred
 * @returns {Array<any>}
 */
export function findAll(node, pred) {
  const out = []
  const visit = (current) => {
    if (!current) return
    if (current.type === 'element' && pred(current)) out.push(current)
    const kids = current.children
    if (Array.isArray(kids)) for (const kid of kids) visit(kid)
  }
  visit(node)
  return out
}

/**
 * 按名字找子孙元素。`findAll(node, n => n.name === name)` 的糖，带前缀忽略。
 * @param {any} node
 * @param {string} name - `itemref` / `dc:title` / `*`
 * @returns {Array<any>}
 */
export function findByName(node, name) {
  return findAll(node, (element) => nameMatches(element.name, name))
}

/**
 * 找**直接子元素**（不含孙辈）。OPF 里 `manifest/item` 与 `spine/itemref`
 * 必须按直接子元素找，否则会把嵌套的 reference 也算进来。
 * @param {any} node
 * @param {string} name
 * @returns {Array<any>}
 */
export function childrenByName(node, name) {
  const kids = Array.isArray(node?.children) ? node.children : []
  return kids.filter((kid) => kid.type === 'element' && nameMatches(kid.name, name))
}

/**
 * 递归取文本。**不压缩、不 trim 空白**——字符偏移依赖原始字符数据（docs/01 §3.4）。
 * CDATA 视为文本（与 DOM 的 nodeType 4 一致，两者都进 CFI 文本块）。
 * @param {any} node
 * @returns {string}
 */
export function textOf(node) {
  if (!node) return ''
  if (node.type === 'text' || node.type === 'cdata') return node.value
  if (!Array.isArray(node.children)) return ''
  let out = ''
  for (const kid of node.children) out += textOf(kid)
  return out
}

/**
 * 取属性。返回 undefined 表示没有——调用方自己决定缺失时怎么办。
 * @param {any} node
 * @param {string} name
 * @returns {string|undefined}
 */
export function attr(node, name) {
  const attrs = node?.attrs
  if (!attrs) return undefined
  return Object.hasOwn(attrs, name) ? attrs[name] : undefined
}

/**
 * 取「忽略命名空间前缀」的属性，用于 `xlink:href` 这类历史写法。
 * @param {any} node
 * @param {string} local - 例如 `href`
 * @returns {string|undefined}
 */
export function attrLocal(node, local) {
  const attrs = node?.attrs
  if (!attrs) return undefined
  if (Object.hasOwn(attrs, local)) return attrs[local]
  for (const key of Object.keys(attrs)) {
    const colon = key.indexOf(':')
    if (colon >= 0 && key.slice(colon + 1) === local) return attrs[key]
  }
  return undefined
}
