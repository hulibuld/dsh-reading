/**
 * Legado（开源阅读）书源兼容层。
 *
 * 目标：让用户把 Legado 的书源 JSON 直接导进来，就能搜书、加书架、读正文。
 * 不是完整实现——Legado 的规则体系里有一半是给它自己那个 Android 壳子用的
 * （WebView 注入、Rhino 脚本、字体解密、购买操作），在 DSH 这套 Node 环境里
 * 既跑不起来也没有意义。这里只实现「纯声明式、足够覆盖大多数正文/目录站」的
 * 那部分：
 *
 *   默认规则（Jsoup 风格） class.odd.0@tag.a.0@text
 *   @css: 选择器            @css:.book-list li@text
 *   JSONPath                $.data.books[*]（含 $..key 递归）
 *   正则净化                @css:#content@html##<script>.*?</script>
 *   连接符号                a|b、a&&b、a%%b
 *   模板变量                /search?key={{key}}&page={{page}}
 *
 * 不支持（遇到时抛一条说得清的中文错误，而不是静默给空值）：
 *   @XPath:、@js:、<js></js>、{{java.xxx}}、WebView 相关字段、字体解密。
 *
 * 这里全部是纯函数 + 一个注入的 fetchText，不自己联网，所以可以脱网单测。
 */

import { decodeEntities } from './sources.js'

/** 一个源最多吐多少条搜索结果。列表页动辄几百条，全给前端没意义。 */
export const MAX_SEARCH_ITEMS = 60

/** 目录最多多少章。网文两三千章的不少，但再多就是在拖垮界面。 */
export const MAX_TOC_ITEMS = 4000

/** 单章正文最多多少字符，防某些站点把整本塞进一页。 */
export const MAX_CONTENT_CHARS = 200000

/** 这些步骤名是「取值动作」而不是「选元素」，只能出现在规则最后。 */
const EXTRACT_STEPS = new Set(['text', 'ownText', 'textNodes', 'href', 'src', 'html', 'all', 'content'])

/** 规则里出现的、我们不支持的写法 → 明确的错误码。 */
function unsupported(feature) {
  const error = new Error(`这个书源用了 ${feature}，插件暂时跑不了它。换一个源，或者把这条规则改写成 CSS/JSONPath。`)
  error.code = 'E_LEGADO_UNSUPPORTED'
  return error
}

// ─────────────────────────────── HTML 解析 ───────────────────────────────

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 内容不按标签解析的标签：里面的尖括号当纯文本。 */
const RAW_TEXT_TAGS = new Set(['script', 'style'])

/**
 * 把 HTML 解析成一棵很宽松的树。浏览器能容忍的东西这里也尽量容忍：
 * 没闭合的标签、大小写混写、属性不带引号、自闭合的 <img/>。
 *
 * 不做的事情：不执行脚本、不加载资源、不纠正错位的表格结构。抓正文用不到。
 *
 * @param {string} html
 * @returns {{type: 'root', children: any[]}}
 */
export function parseHtml(html) {
  const root = { type: 'root', name: '#root', attrs: {}, children: [], parent: null }
  const text = String(html ?? '')
  const stack = [root]
  let index = 0

  const pushText = (chunk) => {
    if (chunk === '') return
    const parent = stack[stack.length - 1]
    parent.children.push({ type: 'text', text: decodeEntities(chunk), parent })
  }

  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open < 0) {
      pushText(text.slice(index))
      break
    }
    if (open > index) pushText(text.slice(index, open))

    // 注释、DOCTYPE、CDATA 一律跳过
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4)
      index = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<!', open)) {
      const end = text.indexOf('>', open + 2)
      index = end < 0 ? text.length : end + 1
      continue
    }

    const close = text.indexOf('>', open + 1)
    if (close < 0) {
      pushText(text.slice(open))
      break
    }
    const rawTag = text.slice(open + 1, close)
    index = close + 1

    // 结束标签
    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim().toLowerCase()
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i
          break
        }
      }
      continue
    }

    const selfClosing = rawTag.endsWith('/')
    const tag = parseTag(rawTag.replace(/\/$/, ''))
    if (tag.name === '') continue

    const parent = stack[stack.length - 1]
    const node = { type: 'tag', name: tag.name, attrs: tag.attrs, children: [], parent }
    parent.children.push(node)

    if (selfClosing || VOID_TAGS.has(tag.name)) continue

    if (RAW_TEXT_TAGS.has(tag.name)) {
      const endTag = text.toLowerCase().indexOf(`</${tag.name}`, index)
      if (endTag < 0) {
        node.children.push({ type: 'text', text: text.slice(index), parent: node })
        index = text.length
      } else {
        node.children.push({ type: 'text', text: text.slice(index, endTag), parent: node })
        const endClose = text.indexOf('>', endTag)
        index = endClose < 0 ? text.length : endClose + 1
      }
      continue
    }

    stack.push(node)
  }

  return root
}

/** 拆 `<div class="a" id='b'>` 这种标签头。属性值不带引号也认。 */
function parseTag(source) {
  const match = /^([a-zA-Z0-9:_-]*)/.exec(source.trim())
  const name = match ? match[1].toLowerCase() : ''
  const attrs = {}
  const rest = source.trim().slice(name.length)
  const attrRe = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let hit
  while ((hit = attrRe.exec(rest)) !== null) {
    const key = hit[1].toLowerCase()
    if (key === '' || key === '/') continue
    const value = hit[2] ?? hit[3] ?? hit[4] ?? ''
    attrs[key] = decodeEntities(value)
  }
  return { name, attrs }
}

/** 子元素（不含文本节点）。 */
function childElements(node) {
  return (node.children || []).filter((item) => item.type === 'tag')
}

/** 后代元素（深度优先，文档顺序）。 */
function descendantElements(node, into = []) {
  for (const child of childElements(node)) {
    into.push(child)
    descendantElements(child, into)
  }
  return into
}

/** 节点下的全部文字（含子孙），空白折叠成一个空格。 */
export function textOf(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text
  let out = ''
  for (const child of node.children || []) out += textOf(child)
  return out
}

/** 只有自己的文本节点，不含子元素里的字。对应 Jsoup 的 ownText。 */
function ownTextOf(node) {
  if (!node) return ''
  return (node.children || [])
    .filter((child) => child.type === 'text')
    .map((child) => child.text)
    .join('')
}

/** 节点的 innerHTML（自己拼回去，够用就行）。 */
function innerHtmlOf(node) {
  if (!node || node.type !== 'tag') return ''
  return (node.children || []).map(serializeNode).join('')
}

function serializeNode(node) {
  if (node.type === 'text') return escapeHtml(node.text)
  if (node.type !== 'tag') return ''
  const attrs = Object.entries(node.attrs || {})
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join('')
  if (VOID_TAGS.has(node.name)) return `<${node.name}${attrs}>`
  return `<${node.name}${attrs}>${(node.children || []).map(serializeNode).join('')}</${node.name}>`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ─────────────────────────────── CSS 选择器 ───────────────────────────────

/**
 * 把 CSS 选择器拆成 [{ combinator, compound }]。
 * 支持的组合符：空格（后代）、`>`（子元素）。逗号分隔的多个选择器按并集处理。
 */
function parseSelector(selector) {
  const groups = []
  for (const part of String(selector).split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const steps = []
    let combinator = ' '
    let buffer = ''
    const flush = () => {
      if (buffer.trim() !== '') {
        steps.push({ combinator, compound: parseCompound(buffer.trim()) })
        combinator = ' '
      }
      buffer = ''
    }
    for (const char of trimmed) {
      if (char === '>') {
        flush()
        combinator = '>'
      } else if (char === ' ') {
        flush()
      } else {
        buffer += char
      }
    }
    flush()
    if (steps.length > 0) groups.push(steps)
  }
  return groups
}

/** 拆单个复合选择器：`div.a#b[c=d]` → { tag, classes, id, attrs }。 */
function parseCompound(source) {
  const compound = { tag: '', classes: [], id: '', attrs: [] }
  let rest = source
  const tagMatch = /^([a-zA-Z0-9*-]+)/.exec(rest)
  if (tagMatch) {
    compound.tag = tagMatch[1].toLowerCase()
    rest = rest.slice(tagMatch[0].length)
  }
  const tokenRe = /([.#])([^.#[\]\s]+)|\[([^\]]+)\]/g
  let hit
  while ((hit = tokenRe.exec(rest)) !== null) {
    if (hit[1] === '.') compound.classes.push(hit[2])
    else if (hit[1] === '#') compound.id = hit[2]
    else {
      const body = hit[3]
      const attrMatch = /^([^=*^$~|]+)(?:([*^$~|]?=)(.*))?$/.exec(body)
      if (!attrMatch) continue
      compound.attrs.push({
        name: attrMatch[1].trim().toLowerCase(),
        op: attrMatch[2] || '',
        value: (attrMatch[3] ?? '').replace(/^["']|["']$/g, ''),
      })
    }
  }
  return compound
}

function matchesCompound(node, compound) {
  if (node.type !== 'tag') return false
  if (compound.tag !== '' && compound.tag !== '*' && node.name !== compound.tag) return false
  if (compound.id !== '' && node.attrs.id !== compound.id) return false
  if (compound.classes.length > 0) {
    const classes = String(node.attrs.class || '').split(/\s+/)
    for (const name of compound.classes) {
      if (!classes.includes(name)) return false
    }
  }
  for (const attr of compound.attrs) {
    const actual = node.attrs[attr.name]
    if (actual === undefined) return false
    if (attr.op === '=' && actual !== attr.value) return false
    if (attr.op === '*=' && !actual.includes(attr.value)) return false
    if (attr.op === '^=' && !actual.startsWith(attr.value)) return false
    if (attr.op === '$=' && !actual.endsWith(attr.value)) return false
    if (attr.op === '~=' && !String(actual).split(/\s+/).includes(attr.value)) return false
  }
  return true
}

/** 在一个节点集合里按选择器筛出节点（结果按文档顺序、去重）。 */
function selectWithin(roots, selector) {
  const groups = parseSelector(selector)
  if (groups.length === 0) return []
  const seen = new Set()
  const out = []
  for (const root of roots) {
    for (const steps of groups) {
      let current = [root]
      let first = true
      for (const step of steps) {
        const next = []
        for (const node of current) {
          // 第一段既可能是根本身（`#content`），也可能是它的后代（`.book-item`），
          // 所以从自己开始按后代算；`>` 才严格只取直接子元素。
          const pool =
            step.combinator === '>'
              ? childElements(node)
              : first
                ? [node, ...descendantElements(node)]
                : descendantElements(node)
          for (const candidate of pool) {
            if (matchesCompound(candidate, step.compound)) next.push(candidate)
          }
        }
        current = next
        first = false
      }
      for (const node of current) {
        if (seen.has(node)) continue
        seen.add(node)
        out.push(node)
      }
    }
  }
  return sortInDocumentOrder(out)
}

/** 按文档顺序排列：拿不到绝对路径时，用「深度优先序号」近似。 */
function sortInDocumentOrder(nodes) {
  const index = new Map()
  let counter = 0
  const walk = (node) => {
    index.set(node, counter)
    counter += 1
    for (const child of node.children || []) walk(child)
  }
  for (const node of nodes) {
    let top = node
    while (top.parent) top = top.parent
    if (!index.has(top)) walk(top)
  }
  return nodes.slice().sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
}

// ─────────────────────────────── 规则求值 ───────────────────────────────

/**
 * 求一条规则。
 *
 * @param {string} rule 规则原文，可能带 `@css:` / `$.` / `##净化##` 等
 * @param {{root: any, node?: any, baseUrl?: string, vars?: Record<string, string>}} ctx
 * @returns {string} 取到的文字（列表规则会返回多行，用换行分隔）
 */
export function evalRule(rule, ctx) {
  const raw = String(rule ?? '').trim()
  if (raw === '') return ''
  const { body, clean } = splitClean(raw)
  let value
  if (hasJoin(body)) {
    value = evalJoin(body, ctx)
  } else {
    value = evalBody(body, ctx)
  }
  if (clean !== null) value = applyClean(value, clean)
  return value
}

/** 拆出 `##正则##替换` 尾巴。没有就是 null。 */
function splitClean(rule) {
    // 从右往左找 `##`：规则里的正则本身也可能含 `#`，所以只看倒数第二段之后
  const first = rule.indexOf('##')
  if (first <= 0) return { body: rule, clean: null }
  const rest = rule.slice(first + 2)
  const second = rest.indexOf('##')
  const pattern = second < 0 ? rest : rest.slice(0, second)
  const replacement = second < 0 ? '' : rest.slice(second + 2)
  return { body: rule.slice(0, first), clean: { pattern, replacement } }
}

function applyClean(value, clean) {
  let pattern
  try {
    pattern = new RegExp(clean.pattern, 'g')
  } catch {
    return value
  }
  return String(value).replace(pattern, clean.replacement)
}

/** 连接符号只能用在同类规则之间：这里只在顶层切，不递归进括号。 */
function hasJoin(rule) {
  return rule.includes('|') || rule.includes('&&') || rule.includes('%%')
}

function evalJoin(rule, ctx) {
  if (rule.includes('&&')) {
    return rule
      .split('&&')
      .map((part) => evalBody(part.trim(), ctx))
      .filter((part) => part !== '')
      .join('\n')
  }
  if (rule.includes('%%')) {
    const parts = rule.split('%%').map((part) => evalBody(part.trim(), ctx))
    const lines = parts.map((part) => part.split('\n'))
    const out = []
    const max = Math.max(...lines.map((line) => line.length), 0)
    for (let i = 0; i < max; i += 1) {
      for (const line of lines) {
        if (line[i] !== undefined) out.push(line[i])
      }
    }
    return out.join('\n')
  }
  // `|`：取第一个有值的
  for (const part of rule.split('|')) {
    const value = evalBody(part.trim(), ctx)
    if (value !== '' && value !== undefined && value !== null) return value
  }
  return ''
}

function evalBody(rule, ctx) {
  const body = rule.trim()
  if (body === '') return ''
  if (body.startsWith('@css:')) return evalCss(body.slice(5), ctx)
  if (body.startsWith('@json:')) return evalJsonPath(body.slice(6), ctx)
  if (body.startsWith('$.')) return evalJsonPath(body, ctx)
  if (body.startsWith('@XPath:') || body.startsWith('//')) throw unsupported('XPath 规则')
  if (body.startsWith('@js:') || body.includes('<js>')) throw unsupported('内嵌 JavaScript 规则')
  if (body.startsWith(':')) throw unsupported('AllInOne 正则规则')
  if (body.startsWith('@put:') || body.startsWith('@get:')) throw unsupported('@put/@get 变量规则')
  return evalJsoup(body, ctx)
}

/** 当前节点列表：文档级规则从根开始，条目级规则从这一条开始。 */
function contextNodes(ctx) {
  return ctx.node ? [ctx.node] : [ctx.root]
}

function evalCss(rule, ctx) {
  const [selectorPart, extract] = splitExtract(rule)
  const roots = contextNodes(ctx)
  const nodes = selectWithin(roots, selectorPart)
  return nodes.map((node) => extractFrom(node, extract)).filter((part) => part !== '').join('\n')
}

/** 把 `选择器@text` 拆成两截；没有取值动作时默认取文字。 */
function splitExtract(rule) {
  const at = rule.lastIndexOf('@')
  if (at < 0) return [rule, 'text']
  const tail = rule.slice(at + 1).trim()
  if (EXTRACT_STEPS.has(tail)) return [rule.slice(0, at), tail]
  return [rule, 'text']
}

/** `data-src`、`title` 这类裸属性名，且不是选择器写法。 */
function isAttributeStep(step) {
  return /^[a-zA-Z][\w-]*$/.test(step) && !['children', 'text'].includes(step)
}

function extractFrom(node, type) {
  if (type !== null && typeof type === 'object' && typeof type.attr === 'string') {
    return String(node?.attrs?.[type.attr] ?? '').trim()
  }
  switch (type) {
    case 'text':
    case 'all':
    case 'content':
      return textOf(node).trim()
    case 'ownText':
      return ownTextOf(node).trim()
    case 'textNodes':
      return childElements(node)
        .map(() => '')
        .join('')
    case 'href':
      return node.attrs.href || node.attrs['data-href'] || ''
    case 'src':
      return node.attrs.src || node.attrs['data-src'] || node.attrs['data-original'] || ''
    case 'html':
      return innerHtmlOf(node)
    default:
      return textOf(node).trim()
  }
}

/**
 * Jsoup 默认规则：`class.odd.0@tag.a.0@text`。
 *
 * 每一段先解析出「选择什么 + 取第几个」，再在上一段的结果上继续选。
 * 支持 `!0:2` 排除、前缀 `-` 倒序、`[0:3]` 切片。
 */
function evalJsoup(rule, ctx) {
  const { nodes, extract } = jsoupNodes(rule, ctx)
  return nodes.map((node) => extractFrom(node, extract)).filter((part) => part !== '').join('\n')
}

/** 只选元素、不取值：列表规则（搜索结果列表、目录列表）要的是节点本身。 */
function jsoupNodes(rule, ctx) {
  const steps = rule.split('@').map((step) => step.trim()).filter((step) => step !== '')
  let nodes = contextNodes(ctx)
  let extract = 'text'

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    if (EXTRACT_STEPS.has(step)) {
      extract = step
      continue
    }
    // 最后一段是个裸属性名（`tag.img@data-src`）：按属性取，不按选择器走。
    if (i === steps.length - 1 && isAttributeStep(step)) {
      extract = { attr: step }
      continue
    }
    const parsed = parseJsoupStep(step)
    if (parsed === null) continue
    const next = []
    for (const node of nodes) {
      const pool = parsed.children ? childElements(node) : selectWithin([node], parsed.selector)
      let picked = pool
      if (parsed.reverse) picked = picked.slice().reverse()
      if (parsed.slice !== null) picked = applySlice(picked, parsed.slice)
      if (parsed.index !== null) {
        const at = parsed.index < 0 ? picked.length + parsed.index : parsed.index
        picked = picked[at] ? [picked[at]] : []
      }
      next.push(...picked)
    }
    nodes = next
  }

  return { nodes, extract }
}

function applySlice(nodes, spec) {
  const negative = spec.startsWith('!')
  const body = negative ? spec.slice(1) : spec
  const parts = body.split(':').map((part) => (part === '' ? null : Number(part)))
  const indexes = new Set()
  if (parts.length === 1) {
    indexes.add(parts[0])
  } else {
    const [start, end, step] = parts
    const from = start ?? 0
    const to = end ?? nodes.length
    const stride = step && step > 0 ? step : 1
    for (let i = from; i < to; i += stride) indexes.add(i)
  }
  if (negative) return nodes.filter((_, index) => !indexes.has(index))
  return nodes.filter((_, index) => indexes.has(index))
}

/** 解析一段 Jsoup 选择：`class.books.0`、`tag.a.-1`、`id.main`、`children`。 */
function parseJsoupStep(step) {
  let body = step
  let reverse = false
  if (body.startsWith('-')) {
    reverse = true
    body = body.slice(1)
  }

  // 尾部的切片 [0:3] / [!0:2]
  let slice = null
  const sliceMatch = /\[(!?[-\d:]+)\]$/.exec(body)
  if (sliceMatch) {
    slice = sliceMatch[1]
    body = body.slice(0, sliceMatch.index)
  }

  const parts = body.split('.').filter((part) => part !== '')
  if (parts.length === 0) return null
  const kind = parts[0]
  if (kind === 'children') return { selector: '', children: true, index: null, reverse, slice }

  // 最后一段是数字 → 第几个
  let index = null
  if (parts.length > 1 && /^-?\d+$/.test(parts[parts.length - 1])) {
    index = Number(parts.pop())
  }

  let name = parts.slice(1).join('.').trim()
  if (name.startsWith('!')) {
    // `!0:2` 这种排除写在名字位置上
    const body2 = name.slice(1)
    if (/^[-\d:]+$/.test(body2)) {
      return { selector: kind === 'class' ? '*[class]' : '*', children: false, index: null, reverse, slice: `!${body2}` }
    }
    name = name.slice(1)
  }

  let selector
  if (kind === 'class') selector = name === '' ? '*' : `.${cssEscape(name)}`
  else if (kind === 'id') selector = name === '' ? '*' : `#${cssEscape(name)}`
  else if (kind === 'tag') {
    if (name.startsWith('!')) {
      const exclude = name.slice(1)
      return { selector: '*', children: false, index: null, reverse, slice: `!${exclude}` }
    }
    selector = name === '' ? '*' : name
  } else if (kind === 'text') {
    return { selector: '*', children: false, index, reverse, slice }
  } else {
    selector = '*'
  }
  return { selector, children: false, index, reverse, slice }
}

function cssEscape(value) {
  return String(value).replace(/[^\w-]/g, (char) => `\\${char}`)
}

/** JSONPath 子集：`$.a.b[0].c`、`$..a[*]`、`$.a[*].b`。 */
function evalJsonPath(rule, ctx) {
  const values = jsonPathValues(rule, ctx.json)
  return values
    .map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : JSON.stringify(item)))
    .filter((item) => item !== undefined && item !== '')
    .join('\n')
}

/** 取 JSONPath 的原始结果数组（列表规则要的是值本身，不是拼起来的字符串）。 */
function jsonPathValues(rule, doc) {
  if (doc === undefined || doc === null) return []
  const path = String(rule).trim().replace(/^@json:/, '').replace(/^\$\.?/, '')
  const tokens = []
  const tokenRe = /([^.[\]]+)|\[(\d+)\]|\[\*\]|\.\./g
  let hit
  while ((hit = tokenRe.exec(path)) !== null) {
    if (hit[0] === '..') tokens.push({ deep: true })
    else if (hit[1] !== undefined) tokens.push({ key: hit[1] })
    else if (hit[2] !== undefined) tokens.push({ index: Number(hit[2]) })
    else tokens.push({ wildcard: true })
  }

  let current = [doc]
  for (const token of tokens) {
    const next = []
    for (const item of current) {
      if (item === null || item === undefined) continue
      if (token.deep) {
        collectDeep(item, next)
      } else if (token.wildcard) {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item))
      } else if (token.index !== undefined) {
        if (Array.isArray(item) && item[token.index] !== undefined) next.push(item[token.index])
      } else if (token.key !== undefined) {
        if (typeof item === 'object' && Object.hasOwn(item, token.key)) next.push(item[token.key])
      }
    }
    current = next
  }
  return current.filter((item) => item !== undefined)
}

function collectDeep(value, into) {
  if (value === null || value === undefined) return
  if (typeof value === 'object') {
    into.push(value)
    for (const item of Object.values(value)) collectDeep(item, into)
  }
}

// ─────────────────────────────── 模板变量 ───────────────────────────────

/**
 * 把 `/search?key={{key}}&page={{page}}` 里的模板换成真实值。
 *
 * 支持 key / page 两个变量。`{{java.xxx}}` 这种要走 Rhino 的写法直接报错——
 * 静默替换成空串才是坑，用户会以为「搜到 0 个结果」。
 */
export function fillUrlTemplate(template, vars) {
  const raw = String(template ?? '')
  if (/\{\{\s*[^{}]*[.(]/u.test(raw)) throw unsupported('{{java.xxx}} 这类脚本模板')
  return raw.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name) => {
    const key = name.trim()
    if (Object.hasOwn(vars, key)) return encodeURIComponent(String(vars[key]))
    return whole
  })
}

// ─────────────────────────────── 源归一化 ───────────────────────────────

const RULE_SEARCH_FIELDS = ['bookList', 'name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'bookUrl']
const RULE_TOC_FIELDS = ['chapterList', 'chapterName', 'chapterUrl', 'nextTocUrl', 'isVip']
const RULE_CONTENT_FIELDS = ['content', 'nextContentUrl']

function pickStrings(source, fields) {
  const out = {}
  for (const field of fields) {
    const value = source?.[field]
    out[field] = typeof value === 'string' ? value.trim() : ''
  }
  return out
}

/**
 * 把一个 Legado 源对象归一化成插件内部形状。
 *
 * @param {any} raw Legado 导出的单个源（JSON 对象）
 * @returns {object}
 */
export function normalizeSource(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('书源不是一个 JSON 对象')
  const url = String(raw.bookSourceUrl ?? '').trim()
  const name = String(raw.bookSourceName ?? '').trim()
  if (url === '') throw new Error('书源缺少 bookSourceUrl，没法确定它属于哪个站点')
  if (name === '') throw new Error('书源缺少 bookSourceName，界面上没法显示它')

  let header = {}
  if (typeof raw.header === 'string' && raw.header.trim() !== '') {
    try {
      header = JSON.parse(raw.header)
    } catch {
      header = {}
    }
  } else if (raw.header && typeof raw.header === 'object') {
    header = raw.header
  }

  return {
    url,
    name,
    group: String(raw.bookSourceGroup ?? '').trim(),
    type: Number(raw.bookSourceType ?? 0) === 1 ? 'audio' : 'text',
    weight: Number(raw.weight ?? 0) || 0,
    enabled: raw.enabled !== false,
    header: Object.fromEntries(
      Object.entries(header).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
    ),
    searchUrl: String(raw.searchUrl ?? '').trim(),
    ruleSearch: pickStrings(raw.ruleSearch, RULE_SEARCH_FIELDS),
    ruleToc: pickStrings(raw.ruleToc, RULE_TOC_FIELDS),
    ruleContent: pickStrings(raw.ruleContent, RULE_CONTENT_FIELDS),
    ruleBookInfo: pickStrings(raw.ruleBookInfo, ['name', 'author', 'intro', 'coverUrl', 'tocUrl', 'kind']),
  }
}

/**
 * 导入 Legado 的书源 JSON。既接受 `[源, 源]` 数组，也接受单个对象。
 *
 * @param {string|any} input JSON 文本或已解析的对象
 * @returns {{sources: object[], rejected: {name: string, reason: string}[]}}
 */
export function parseSourceList(input) {
  let data = input
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch (error) {
      throw new Error(`这不是合法的 JSON：${String(error?.message ?? error)}`)
    }
  }
  const list = Array.isArray(data) ? data : [data]
  const sources = []
  const rejected = []
  const seen = new Set()
  for (const item of list) {
    try {
      const source = normalizeSource(item)
      if (seen.has(source.url)) {
        rejected.push({ name: source.name, reason: '同一个站点重复出现，只保留第一个' })
        continue
      }
      seen.add(source.url)
      sources.push(source)
    } catch (error) {
      rejected.push({ name: String(item?.bookSourceName ?? '未命名'), reason: String(error?.message ?? error) })
    }
  }
  return { sources, rejected }
}

// ─────────────────────────────── 三个业务动作 ───────────────────────────────

function absolute(url, base) {
  const raw = String(url ?? '').trim()
  if (raw === '') return ''
  try {
    return new URL(raw, base).toString()
  } catch {
    return raw
  }
}

/**
 * 列表规则统一入口：返回节点数组或 JSON 值数组，调用方两条路都认。
 *
 * 列表规则三种写法都见过：Jsoup 的 `class.book-list@tag.li`、`@css:`、`$.data[*]`。
 * 分开处理是因为 JSON 源根本没有 DOM 可查。
 */
function resolveListRule(rule, { root, json }) {
  const text = String(rule ?? '').trim()
  if (text === '') return { nodes: [], values: [] }
  if (text.startsWith('$.') || text.startsWith('@json:')) {
    return { nodes: [], values: jsonPathValues(text, json) }
  }
  if (text.startsWith('//') || text.startsWith('@XPath:')) throw unsupported('XPath 规则')
  if (text.startsWith('@css:')) {
    return { nodes: selectWithin([root], normalizeListSelector(text)), values: [] }
  }
  const { nodes } = jsoupNodes(text, { root, node: null })
  return { nodes, values: [] }
}

/** 按条目取规则值：条目规则相对于「当前这一条」求值，不是整页。 */
function ruleOf(rule, { root, node, baseUrl, json }) {
  if (!rule) return ''
  return evalRule(rule, { root, node, baseUrl, json }).split('\n')[0].trim()
}

/**
 * 在单个源上搜索。
 *
 * @param {{source: object, keyword: string, page?: number, fetchText: (url: string, init?: any) => Promise<{url: string, text: string}>}} input
 * @returns {Promise<{items: object[], raw: string}>}
 */
export async function searchSource(input) {
  const { source, keyword } = input
  const page = Math.max(1, Number(input.page) || 1)
  if (!source.searchUrl) throw new Error(`「${source.name}」没有填搜索地址`)
  if (!source.ruleSearch.bookList) throw new Error(`「${source.name}」没有填搜索结果列表规则`)

  const url = absolute(
    fillUrlTemplate(source.searchUrl, { key: keyword, page, pageIndex: page - 1 }),
    source.url,
  )
  const { text, url: finalUrl } = await input.fetchText(url, { headers: source.header })
  const root = parseHtml(text)
  let jsonDoc = null
  if (isJsonRule(source.ruleSearch.bookList)) {
    try {
      jsonDoc = JSON.parse(text)
    } catch (error) {
      throw new Error(`「${source.name}」的搜索结果不是合法 JSON：${String(error?.message ?? error)}`)
    }
  }
  const list = resolveListRule(source.ruleSearch.bookList, { root, json: jsonDoc })
  const entries = list.values.length > 0
    ? list.values.map((value) => ({ node: null, json: value }))
    : list.nodes.map((node) => ({ node, json: null }))

  const items = []
  const seen = new Set()
  for (const entry of entries) {
    if (items.length >= MAX_SEARCH_ITEMS) break
    const ctx = { root, node: entry.node, baseUrl: finalUrl, json: entry.json }
    const name = ruleOf(source.ruleSearch.name, ctx)
    if (name === '') continue
    const bookUrl = absolute(ruleOf(source.ruleSearch.bookUrl, ctx), finalUrl)
    if (bookUrl === '' || seen.has(bookUrl)) continue
    seen.add(bookUrl)
    items.push({
      name,
      author: ruleOf(source.ruleSearch.author, ctx),
      kind: ruleOf(source.ruleSearch.kind, ctx),
      wordCount: ruleOf(source.ruleSearch.wordCount, ctx),
      lastChapter: ruleOf(source.ruleSearch.lastChapter, ctx),
      intro: ruleOf(source.ruleSearch.intro, ctx),
      coverUrl: absolute(ruleOf(source.ruleSearch.coverUrl, ctx), finalUrl),
      bookUrl,
      sourceName: source.name,
      sourceUrl: source.url,
    })
  }
  return { items, raw: '' }
}

/** 列表规则是不是 JSONPath。 */
function isJsonRule(rule) {
  const text = String(rule ?? '').trim()
  return text.startsWith('$.') || text.startsWith('@json:')
}

/** 列表规则本身就是个选择器；统一交给 CSS 引擎，`@css:` 前缀也能吃。 */
function normalizeListSelector(rule) {
  const body = String(rule).trim().replace(/^@css:/, '')
  const [selector] = splitExtract(body)
  return selector
}

/**
 * 取一本书的目录。
 *
 * @param {{source: object, bookUrl: string, fetchText: Function, maxPages?: number}} input
 * @returns {Promise<{chapters: {title: string, url: string}[], tocUrl: string}>}
 */
export async function tocOfSource(input) {
  const { source } = input
  if (!source.ruleToc.chapterList) throw new Error(`「${source.name}」没有填目录列表规则`)

  let target = input.bookUrl
  const { text, url: finalUrl } = await input.fetchText(target, { headers: source.header })
  const root = parseHtml(text)

  // 详情页上的 tocUrl 规则：把目录地址从详情页里挑出来
  if (source.ruleBookInfo.tocUrl) {
    const picked = ruleOf(source.ruleBookInfo.tocUrl, { root, baseUrl: finalUrl })
    if (picked !== '') {
      const absoluteToc = absolute(picked, finalUrl)
      if (absoluteToc !== finalUrl) {
        const next = await input.fetchText(absoluteToc, { headers: source.header })
        return collectChapters(source, next.text, next.url)
      }
    }
  }
  return collectChapters(source, text, finalUrl)
}

function collectChapters(source, html, baseUrl) {
  const root = parseHtml(html)
  let jsonDoc = null
  if (isJsonRule(source.ruleToc.chapterList)) {
    try {
      jsonDoc = JSON.parse(html)
    } catch (error) {
      throw new Error(`「${source.name}」的目录不是合法 JSON：${String(error?.message ?? error)}`)
    }
  }
  const list = resolveListRule(source.ruleToc.chapterList, { root, json: jsonDoc })
  const entries = list.values.length > 0
    ? list.values.map((value) => ({ node: null, json: value }))
    : list.nodes.map((node) => ({ node, json: null }))
  const reversed = String(source.ruleToc.chapterList).trim().startsWith('-')
  const ordered = reversed ? entries.slice().reverse() : entries
  const chapters = []
  const seen = new Set()
  for (const entry of ordered) {
    if (chapters.length >= MAX_TOC_ITEMS) break
    const ctx = { root, node: entry.node, baseUrl, json: entry.json }
    const title = ruleOf(source.ruleToc.chapterName, ctx)
    const url = absolute(ruleOf(source.ruleToc.chapterUrl, ctx), baseUrl)
    if (title === '' || url === '' || seen.has(url)) continue
    seen.add(url)
    chapters.push({ title, url })
  }
  return { chapters, tocUrl: baseUrl }
}

/**
 * 取一章正文。
 *
 * @param {{source: object, chapterUrl: string, fetchText: Function}} input
 * @returns {Promise<{title: string, paragraphs: string[]}>}
 */
export async function contentOfSource(input) {
  const { source } = input
  if (!source.ruleContent.content) throw new Error(`「${source.name}」没有填正文规则`)
  const { text, url: finalUrl } = await input.fetchText(input.chapterUrl, { headers: source.header })
  const root = parseHtml(text)
  let raw = evalRule(source.ruleContent.content, { root, baseUrl: finalUrl })
  if (source.ruleContent.content.includes('@html')) {
    // @html 取到的是 HTML 片段，拆成段落；纯文本规则直接用行
    raw = htmlToParagraphs(raw).join('\n')
  }
  const paragraphs = normalizeParagraphs(raw)
  return { title: '', paragraphs: paragraphs.slice(0, 400), chars: paragraphs.join('').length }
}

/** 把 HTML 片段拆成纯文本行：块级标签当换行，`<br>` 当换行，其余标签剥掉。 */
export function htmlToParagraphs(html) {
  const withBreaks = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
  return normalizeParagraphs(decodeEntities(withBreaks))
}

/** 折行还原 + 去空行 + 去掉常见站点噪声行。 */
export function normalizeParagraphs(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u00a0\u3000]/g, ' ').trim())
    .filter((line) => line !== '')
    .filter((line) => !isNoiseLine(line))
  const merged = []
  for (const line of lines) {
    const prev = merged[merged.length - 1]
    // 中文正文里被硬折的行：上一行以逗号/顿号这类「没说完」的标点收尾，
    // 或者又长又没句末标点、下一行也不是短句 → 合并成一段。
    const dangling = /[，、；：,;]$/.test(prev || '')
    const unfinished = prev && !/[。！？…”』」）】]$/.test(prev) && prev.length > 16 && line.length > 12
    if (prev && (dangling || unfinished)) {
      merged[merged.length - 1] = prev + line
    } else {
      merged.push(line)
    }
  }
  return merged
    .map((line) => line.slice(0, 4000))
    .slice(0, 3000)
}

/** 站点广告、求票、章节字数统计之类的噪声行。只认非常确定的几条。 */
function isNoiseLine(line) {
  if (line.length > 80) return false
  return /^(本章未完|请收藏|加入书签|手机版阅读|上一章|下一章|目录|返回目录|最新章节|百度搜索|记住本站|一秒记住)/.test(line)
    || /^章节目录$/.test(line)
}
