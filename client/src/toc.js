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
export function flattenToc(toc) {
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

export function TocPanel(props) {
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
