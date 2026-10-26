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

import { assetUrl, chapterUrl, humanizeError } from './api.js'
import * as CFI from './cfi.js'
import { statusSummary } from './ai.js'

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
export const LINK_PREFIX = '#dsh-reading:'

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
export const THEMES = [
  { key: 'light', label: '白纸', paper: '#fcfbf8', ink: '#22262b', rule: '#e6e2d8' },
  { key: 'sepia', label: '羊皮纸', paper: '#f4ecd8', ink: '#4a3f35', rule: '#ded0b2' },
  { key: 'green', label: '护眼绿', paper: '#e6efe0', ink: '#2c382c', rule: '#cfdcc6' },
  { key: 'dark', label: '夜间', paper: '#1b1d21', ink: '#c9cdd3', rule: '#2f333a' },
]

/** 取配色；认不出来的 theme 一律回退白纸（用户改坏了也不该变成透明背景）。 */
export function themeOf(key) {
  const found = THEMES.find((item) => item.key === key)
  return found || THEMES[0]
}

/**
 * 字体选择。值是完整的 font-family 栈，不是单个字体名 ——
 * 中文阅读器只写 `Songti SC` 的话，Windows/Linux 会掉成默认黑体。
 */
export const FONT_CHOICES = [
  { key: '', label: '跟随系统', stack: '' },
  { key: 'serif', label: '宋体 / 衬线', stack: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", serif' },
  { key: 'sans', label: '黑体 / 无衬线', stack: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { key: 'kai', label: '楷体', stack: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
]

/** 把设置里的 fontFamily 解析成能直接写进 CSS 的栈。 */
export function fontStackOf(key) {
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
export function resolveSpineTarget(spine, currentHref, rawHref, opts = {}) {
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
export function findAnchor(doc, fragment) {
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
export function ReaderView(props) {
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
