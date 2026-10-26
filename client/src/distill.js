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
export function chapterStatusText(record) {
  if (!record || typeof record !== 'object') return { text: '没蒸', tone: 'idle' }
  if (record.status === 'done') {
    const methods = Array.isArray(record.methods) ? record.methods.length : 0
    return { text: methods > 0 ? `已蒸 · ${methods} 个方法` : '已蒸', tone: 'ok' }
  }
  if (record.status === 'failed') return { text: '失败', tone: 'bad' }
  return { text: '没蒸', tone: 'idle' }
}

/** 「已蒸 3 / 34 章 · 8 个方法」，一句话说清干了多少活。 */
export function distillSummary(data) {
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
export function exportFilename(title) {
  const base = String(title || '').replace(/[\\/:*?"<>|]/g, ' ').trim()
  const safe = base === '' ? '这本书' : base.slice(0, 60)
  return `${safe}-蒸馏笔记.md`
}

/** 触发浏览器下载。没有 document 时静默返回（测试环境）。 */
export function downloadMarkdown(filename, text) {
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
export function DistillPanel(props) {
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
