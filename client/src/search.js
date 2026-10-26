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
export function highlightSnippet(snippet, query) {
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
export function SearchPanel(props) {
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
