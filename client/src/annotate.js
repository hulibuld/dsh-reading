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

import { call, getDeviceId, humanizeError } from './api.js'
import { colorStyle, HIGHLIGHT_ORDER, HIGHLIGHT_COLORS } from './style.js'
import { AiStatusChip } from './ai.js'
import * as CFI from './cfi.js'
import { fingerprint, makeBookmark, makeHighlight, makeNote } from './contract.js'

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
export function useAnnotations(opts) {
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
export function rangeRectToMenuBase(input) {
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
export const SELECTION_MENU_HEIGHT = 36
const SELECTION_MENU_GAP = 8
const MENU_EDGE = 8

/**
 * 选区菜单该摆在哪。**纯函数**，输入选区矩形，输出菜单盒子（父窗口坐标）。
 *
 * 菜单优先放在选区正上方；上方放不下（选区贴着视口顶）就翻到下方，
 * 因为「盖住刚划的那行字」比「偏一点」更烦人。水平居中，再夹回视口内。
 */
export function placeSelectionMenu(rect, opts) {
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
export function relateRanges(a, b) {
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
export function selectRecord(frameWin, frameDoc, record) {
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
export function findOverlap(frameWin, frameDoc, records, range, chapterHref) {
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
export function subtractRect(base, cut) {
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
export function flattenBoxes(boxes) {
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
export function hitBox(boxes, x, y) {
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
export function computeRects(opts) {
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
export function Overlayer(props) {
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
export function AnnotationMenu(props) {
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
export function SelectionMenu(props) {
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
export function NoteEditor(props) {
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
export function AskPanel(props) {
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
        h(AiModelBar, { compact: true, label: '分析模型' }),
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

export function AnnotationSidebar(props) {
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
export function useQaHistory(opts) {
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
export function qaRoundCount(record) {
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
export function QaSidebar(props) {
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
export function quarantineNote(count) {
  if (typeof count !== 'number' || count <= 0) return ''
  return `${Math.min(count, MAX_QUARANTINE_NOTE)} 条标注位置对不上，暂时没画出来`
}
