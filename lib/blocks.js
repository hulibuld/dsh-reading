/**
 * 锚块协议（docs/26 §4）：Obsidian 笔记里「哪一段是插件写的」。
 *
 * 为什么单独一个文件：这是整份 AI 伴读设计的核心机制，也是唯一一处「解析别人
 * 也在改的文件」的地方。把它写成不碰文件系统的纯函数，才能不联网、不建 vault
 * 就把「缺 end / 嵌套 / 块里有注释 / 幂等」这些坑全测一遍；vault.js 只负责把
 * 它算出来的结果落盘，不自己判断字节该不该动。
 *
 * 能做什么：
 *   - 把一份 Markdown 解析成「块以外归用户、块以内归插件」的区间表；
 *   - 渲染块时字节完全确定（同一个块渲染一万次都一样，时间戳来自记录而非 now）；
 *   - 只在块的区间内做替换，块外一个字节都不碰。
 *
 * 不能做什么：
 *   - 不做 Markdown 语法解析（不认代码块、不认 frontmatter），只认 HTML 注释标记；
 *   - 不判断「用户改过没有」（那要台账里的 sha256，属于 notesync 的事，
 *     这里只把当前块的 hash 算出来交给它）；
 *   - 不猜用户的意图：缺 end 的块一律视为「文件可能被手改过」，拒绝重写。
 *
 * 什么时候失败、失败给谁看：
 *   - id 不合法 → 抛 E_BAD_BLOCK_ID，这是程序 bug 不是用户能修的东西；
 *     同步流程里会被 notesync 折成一条「这段没写进去」。
 */

import { createHash } from 'node:crypto'
import { fail } from './errors.js'

/** 起始标记里那段固定文字。解析与渲染共用，避免两处写歪。 */
export const BLOCK_START_TAG = 'dsh-reading:block'

/** 结束标记里那段固定文字。 */
export const BLOCK_END_TAG = 'dsh-reading:end'

/**
 * 合法的块 id：字母数字下划线中划线，1–64 位。
 *
 * 为什么这么窄：id 来自标注 id 与 qa 记录 id（都是 ULID 形状），限定成这个
 * 字符集之后，属性值不用转义，标记就不可能被内容里的引号截断。
 */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 标记行的抓取正则。只认单行：标记是我们自己写的，永远是单行；
 * 允许 `[^\n]*?` 把属性串整段吃掉，但不会越过换行去误吞正文。
 */
const MARKER_RE = /<!--\s*dsh-reading:(block|end)\b([^\n]*?)-->/g

/** 属性串的抓取正则：`key=value`，值可有引号。 */
const ATTR_RE = /([A-Za-z][A-Za-z0-9_-]*)=("[^"]*"|'[^']*'|[^\s"'>]+)/g

/**
 * 把换行统一成 `\n`，去掉 BOM，结尾补且只补一个换行。
 *
 * 为什么整份文件都要过这一步：Obsidian 在 Windows 上编辑过的文件是 CRLF，
 * 而我们的写入固定 LF。不归一的话，同一段内容在两次同步里 hash 不同，
 * 会被误判成「用户改过」。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeMarkdown(text) {
  const raw = typeof text === 'string' ? text : ''
  const body = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return body.replace(/\s+$/, '') + '\n'
}

/**
 * 块内的规范形态：归一换行，去掉首尾空行。
 *
 * 为什么首尾都要削：渲染时我们自己会在块前后各留一个换行，
 * 内容里再带一层就会每次同步多长一行（幂等被破坏）。
 *
 * @param {unknown} inner
 * @returns {string}
 */
export function canonicalInner(inner) {
  const body = typeof inner === 'string' ? inner : ''
  return body
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}

/**
 * 块内容的指纹，台账里存的就是它。
 * @param {unknown} inner
 * @returns {string} 64 位小写 hex
 */
export function hashInner(inner) {
  return createHash('sha256').update(canonicalInner(inner), 'utf8').digest('hex')
}

/**
 * 把内容里「像标记的字节」中和掉。
 *
 * 为什么需要：块内是 AI 写的答案，理论上可能包含 `<!-- dsh-reading:end ... -->`。
 * 一旦原样写进去，下一次解析会提前截断，整块内容丢失。把开头的 `<` 转成
 * `&lt;` 之后它就不再是注释，而渲染结果依旧稳定（转一次之后不会再变），幂等不受影响。
 *
 * @param {string} inner
 * @returns {string}
 */
function neutralizeMarkers(inner) {
  return inner.replace(/<!--(?=\s*dsh-reading:)/g, '&lt;!--')
}

/**
 * 渲染一个块。
 *
 * @param {{ id: string, kind?: string, attrs?: Record<string, string|number>, inner?: string }} block
 * @returns {string} 以换行结尾的块文本
 */
export function renderBlock(block) {
  const id = String(block?.id ?? '').trim()
  if (!BLOCK_ID_PATTERN.test(id)) {
    throw fail('E_BAD_BLOCK_ID', '这段笔记的编号不合法，没法写进去。', {
      detail: `bad block id: ${id.slice(0, 80)}`,
    })
  }
  const kind = String(block?.kind ?? 'block').trim() || 'block'
  const attrs = block?.attrs && typeof block.attrs === 'object' ? block.attrs : {}
  const parts = [`id=${id}`, `kind=${kind}`]
  for (const key of Object.keys(attrs).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) continue
    if (key === 'id' || key === 'kind') continue
    const value = String(attrs[key] ?? '').trim()
    // 值里不允许空白与引号：否则会把标记行截断。这类值一律丢掉属性，
    // 而不是转义——少一个属性只是少一点提示信息，写坏标记会让整个块丢失。
    if (value === '' || /[\s"'>]/.test(value)) continue
    parts.push(`${key}=${value}`)
  }
  const inner = neutralizeMarkers(canonicalInner(block?.inner))
  const head = `<!-- ${BLOCK_START_TAG} ${parts.join(' ')} -->`
  const foot = `<!-- ${BLOCK_END_TAG} id=${id} -->`
  return inner === '' ? `${head}\n${foot}\n` : `${head}\n${inner}\n${foot}\n`
}

/**
 * 解析标记行里的属性串。
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseAttrs(text) {
  const attrs = {}
  ATTR_RE.lastIndex = 0
  let match
  while ((match = ATTR_RE.exec(text)) !== null) {
    const key = match[1]
    let value = match[2]
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      value = value.slice(1, -1)
    }
    attrs[key] = value
  }
  return attrs
}

/**
 * 把一份 Markdown 解析成块区间表。
 *
 * 返回的 `blocks` 只包含「有 start、也找到了同名 end」的块；找不到 end 的会被
 * 标成 `closed:false`，中间又冒出别的 start 的标成 `nested:true` —— 这两种
 * 都算「文件可能被手改过」，replaceBlock 拒绝动它们。`problems` 里留着原因，
 * 界面上那句「有 1 段我没敢动」就是从这来的。
 *
 * @param {unknown} markdown
 * @returns {{ blocks: Array<object>, problems: Array<{reason: string, id: string, at: number}> }}
 */
export function parseBlocks(markdown) {
  const text = typeof markdown === 'string' ? markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : ''
  const starts = []
  const ends = []
  MARKER_RE.lastIndex = 0
  let match
  while ((match = MARKER_RE.exec(text)) !== null) {
    const kind = match[1]
    const head = match[0]
    const attrs = parseAttrs(match[2])
    const id = typeof attrs.id === 'string' ? attrs.id : ''
    const record = {
      id,
      attrs,
      markerStart: match.index,
      markerEnd: match.index + head.length,
    }
    if (kind === 'block') starts.push(record)
    else ends.push(record)
  }

  const blocks = []
  const problems = []
  for (const start of starts) {
    if (!BLOCK_ID_PATTERN.test(start.id)) {
      problems.push({ reason: 'bad-id', id: start.id, at: start.markerStart })
      continue
    }
    const end = ends.find((item) => item.id === start.id && item.markerEnd > start.markerEnd)
    if (!end) {
      problems.push({ reason: 'missing-end', id: start.id, at: start.markerStart })
      blocks.push({
        id: start.id,
        kind: start.attrs.kind ?? 'block',
        attrs: start.attrs,
        start: start.markerStart,
        end: text.length,
        innerStart: start.markerEnd,
        innerEnd: text.length,
        inner: '',
        hash: '',
        closed: false,
        nested: false,
      })
      continue
    }
    // 两个标记之间又出现了别的 start → 嵌套（说明被手工拼接或复制过）。
    const nested = starts.some(
      (item) =>
        item !== start &&
        item.markerStart > start.markerEnd &&
        item.markerStart < end.markerStart,
    )
    if (nested) problems.push({ reason: 'nested', id: start.id, at: start.markerStart })
    const inner = text.slice(start.markerEnd, end.markerStart)
    blocks.push({
      id: start.id,
      kind: start.attrs.kind ?? 'block',
      attrs: start.attrs,
      start: start.markerStart,
      end: end.markerEnd,
      innerStart: start.markerEnd,
      innerEnd: end.markerStart,
      inner,
      hash: hashInner(inner),
      closed: true,
      nested,
    })
  }
  // 落单的 end（没有对应 start）：不算问题，只是用户删掉了上半截，忽略即可。
  return { blocks, problems }
}

/**
 * 找某个 id 的块。
 * @param {unknown} markdown
 * @param {string} id
 * @returns {object|null}
 */
export function findBlock(markdown, id) {
  const { blocks } = parseBlocks(markdown)
  return blocks.find((block) => block.id === id) ?? null
}

/**
 * 列出文件里所有块的 id（按出现顺序）。
 * @param {unknown} markdown
 * @returns {string[]}
 */
export function listBlockIds(markdown) {
  return parseBlocks(markdown).blocks.map((block) => block.id)
}

/**
 * 把块追加到文件末尾。
 *
 * 与上一段之间留一个空行（Markdown 里空行是段落分界，不留会把两段粘成一段）。
 *
 * @param {string} markdown
 * @param {object} block
 * @returns {string}
 */
export function appendBlock(markdown, block) {
  const rendered = renderBlock(block)
  const body = typeof markdown === 'string' ? markdown.replace(/\s+$/, '') : ''
  return body === '' ? rendered : `${body}\n\n${rendered}`
}

/**
 * 写入 / 更新 / 跳过 —— 同步里唯一需要调的入口。
 *
 * 四种结果：
 *   - `inserted`：文件里还没有这个 id，追加到末尾；
 *   - `replaced`：块存在且完好，区间内的字节换成新的；
 *   - `unchanged`：块存在，且渲染结果与现有字节**逐字相同**（幂等，不动文件）；
 *   - `malformed`：块缺 end 或嵌了别的块，拒绝重写（宁可少写一次，也不吃掉用户的字）。
 *
 * @param {unknown} markdown
 * @param {object} block
 * @returns {{ markdown: string, action: 'inserted'|'replaced'|'unchanged'|'malformed' }}
 */
export function replaceBlock(markdown, block) {
  const text = typeof markdown === 'string' ? markdown : ''
  const id = String(block?.id ?? '').trim()
  const existing = findBlock(text, id)
  if (!existing) {
    return { markdown: appendBlock(text, block), action: 'inserted' }
  }
  if (!existing.closed || existing.nested) {
    return { markdown: text, action: 'malformed' }
  }
  const rendered = renderBlock(block)
  const slice = text.slice(existing.start, existing.end)
  // 现有区间与渲染结果一致（结尾换行可能差一个，用 trimEnd 比）→ 不动文件。
  if (slice.replace(/\s+$/, '') === rendered.replace(/\s+$/, '')) {
    return { markdown: text, action: 'unchanged' }
  }
  return {
    markdown: text.slice(0, existing.start) + rendered + text.slice(existing.end),
    action: 'replaced',
  }
}

/**
 * 删掉一个块（连标记一起）。
 * @param {unknown} markdown
 * @param {string} id
 * @returns {{ markdown: string, removed: boolean }}
 */
export function removeBlock(markdown, id) {
  const text = typeof markdown === 'string' ? markdown : ''
  const existing = findBlock(text, id)
  if (!existing || !existing.closed) return { markdown: text, removed: false }
  // 连着块前面那个空行一起吃掉，否则删多了会攒出一片空行；
  // 块尾的换行也一并收掉——删完之后这里已经是文件末尾了，
  // 留一层空行会让下一次同步多出一处 diff（结尾换行由 normalizeMarkdown 补）。
  let start = existing.start
  while (start > 0 && text[start - 1] === '\n' && text[start - 2] === '\n') start -= 1
  const joined = text.slice(0, start) + text.slice(existing.end)
  return { markdown: joined.replace(/\s+$/, ''), removed: true }
}

/**
 * 两份文本的块级差异 —— 给「有 3 段你改过，我没有覆盖」那种提示用。
 *
 * @param {unknown} before
 * @param {unknown} after
 * @returns {{ added: string[], removed: string[], changed: string[], same: string[] }}
 */
export function diffBlocks(before, after) {
  const left = new Map(parseBlocks(before).blocks.map((block) => [block.id, block]))
  const right = new Map(parseBlocks(after).blocks.map((block) => [block.id, block]))
  const added = []
  const removed = []
  const changed = []
  const same = []
  for (const [id, block] of right) {
    const old = left.get(id)
    if (!old) added.push(id)
    else if (old.hash !== block.hash) changed.push(id)
    else same.push(id)
  }
  for (const id of left.keys()) {
    if (!right.has(id)) removed.push(id)
  }
  return { added, removed, changed, same }
}
