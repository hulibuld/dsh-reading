/**
 * legado-ui.js —— 书源面板：导入 Legado 书源、搜书、加入书架。
 *
 * 为什么单独一个面板而不是塞进「导入图书」：导入是本地文件的一件事，
 * 书源是「配置一次、以后天天用」的另一件事。混在一起，用户每次导入都要
 * 从一堆书源里翻过去。
 *
 * 面板两页：
 *   搜索 —— 输入书名 → 各源并发搜 → 结果带来源标记 → 一键加入书架；
 *   书源 —— 粘贴 / 选文件导入 JSON，看列表，能停用和删除。
 *
 * 加入书架只抓目录（几秒），正文等翻到那一章才抓并缓存。界面要说清这一点，
 * 否则用户会以为「没下载完就看不了」。
 */

import { call, humanizeError } from './api.js'

/** 一次搜索界面上最多显示多少条，跟宿主上限一致。 */
const MAX_ROWS = 60

/** 导入框的字数提醒线：超过这个长度的 JSON 多半是整包书源。 */
const BIG_JSON_CHARS = 400000

function errorText(error) {
  return humanizeError(error)
}

export function LegadoPanel(props) {
  const open = props?.open === true
  const [tab, setTab] = React.useState('search')
  const [keyword, setKeyword] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [results, setResults] = React.useState(null)
  const [failures, setFailures] = React.useState([])
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')
  const [sources, setSources] = React.useState(null)
  const [sourceError, setSourceError] = React.useState('')
  const [importText, setImportText] = React.useState('')
  const [importing, setImporting] = React.useState(false)
  const [adding, setAdding] = React.useState('')
  const [added, setAdded] = React.useState([])

  const reloadSources = React.useCallback(async () => {
    setSourceError('')
    try {
      const data = await call('source.legado.list')
      setSources(Array.isArray(data?.sources) ? data.sources : [])
    } catch (err) {
      setSources([])
      setSourceError(errorText(err))
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    setNotice('')
    setError('')
    reloadSources()
  }, [open, reloadSources])

  if (!open) return null

  const runSearch = async () => {
    const term = keyword.trim()
    if (term === '') {
      setError('先输入书名或作者。')
      return
    }
    setSearching(true)
    setError('')
    setNotice('')
    try {
      const data = await call('source.legado.search', { keyword: term })
      setResults(Array.isArray(data?.results) ? data.results.slice(0, MAX_ROWS) : [])
      setFailures(Array.isArray(data?.failures) ? data.failures : [])
    } catch (err) {
      setResults([])
      setFailures([])
      setError(errorText(err))
    } finally {
      setSearching(false)
    }
  }

  const doImport = async (text) => {
    const payload = String(text ?? '').trim()
    if (payload === '') {
      setSourceError('把 Legado 的书源 JSON 粘进来，或者选一个 .json 文件。')
      return
    }
    setImporting(true)
    setSourceError('')
    try {
      const data = await call('source.legado.import', { json: payload })
      const rejected = Array.isArray(data?.rejected) ? data.rejected : []
      const parts = []
      if (data?.added) parts.push(`新增 ${data.added} 个`)
      if (data?.updated) parts.push(`更新 ${data.updated} 个`)
      if (rejected.length > 0) parts.push(`${rejected.length} 个没导进来`)
      setNotice(`已导入：${parts.join('，') || '没有变化'}。`)
      setImportText('')
      await reloadSources()
    } catch (err) {
      setSourceError(errorText(err))
    } finally {
      setImporting(false)
    }
  }

  const onPickFile = (event) => {
    const file = event?.target?.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => doImport(String(reader.result ?? ''))
    reader.onerror = () => setSourceError('这个文件读不出来，换一个试试。')
    reader.readAsText(file, 'utf-8')
  }

  const addBook = async (item) => {
    setAdding(item.bookUrl)
    setError('')
    try {
      const data = await call('book.addFromSource', {
        sourceUrl: item.sourceUrl,
        bookUrl: item.bookUrl,
        name: item.name,
        author: item.author,
        intro: item.intro,
      })
      setAdded((list) => [...list, item.bookUrl])
      setNotice(`《${item.name}》已加入书架，共 ${data?.chapterCount ?? 0} 章。正文翻到哪一章才会抓哪一章。`)
      if (typeof props.onAdded === 'function') props.onAdded(data)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding('')
    }
  }

  const toggleSource = async (source) => {
    try {
      await call('source.legado.toggle', { url: source.url, enabled: source.enabled === false })
      await reloadSources()
    } catch (err) {
      setSourceError(errorText(err))
    }
  }

  const removeSource = async (source) => {
    try {
      await call('source.legado.remove', { url: source.url })
      await reloadSources()
    } catch (err) {
      setSourceError(errorText(err))
    }
  }

  const searchTab = h(
    'div',
    { className: 'dr-legado-body' },
    h(
      'div',
      { className: 'dr-legado-row' },
      h('input', {
        className: 'dr-input',
        type: 'search',
        placeholder: '书名或作者，比如「三体」',
        value: keyword,
        'aria-label': '搜索书名或作者',
        onChange: (event) => setKeyword(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') runSearch()
        },
      }),
      h(
        'button',
        { type: 'button', className: 'dr-btn dr-btn-primary', disabled: searching, onClick: runSearch },
        searching ? '正在搜…' : '搜索',
      ),
    ),
    error !== '' ? h('div', { className: 'dr-note dr-note-error', role: 'alert' }, error) : null,
    notice !== '' ? h('div', { className: 'dr-note dr-note-ok', role: 'status' }, notice) : null,
    results === null
      ? h('p', { className: 'dr-note' }, '在已启用的书源里同时搜索。加进书架的只是目录，正文翻到那一章才会抓。')
      : results.length === 0 && !searching
        ? h('p', { className: 'dr-note' }, '没有搜到。换个关键词，或者先去「书源」页看看源是不是被停用了。')
        : h(
          'ul',
          { className: 'dr-legado-list' },
          results.map((item) => {
            const busy = adding === item.bookUrl
            const done = added.includes(item.bookUrl)
            return h(
              'li',
              { key: `${item.sourceUrl}|${item.bookUrl}`, className: 'dr-legado-item' },
              h(
                'div',
                { className: 'dr-legado-main' },
                h('div', { className: 'dr-legado-name' }, item.name),
                h(
                  'div',
                  { className: 'dr-legado-meta' },
                  [item.author || '作者未知', item.sourceName].filter(Boolean).join(' · '),
                ),
                item.lastChapter
                  ? h('div', { className: 'dr-legado-sub' }, `最新：${item.lastChapter}`)
                  : null,
                item.intro ? h('div', { className: 'dr-legado-sub' }, item.intro.slice(0, 80)) : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-btn',
                  disabled: busy || done,
                  onClick: () => addBook(item),
                },
                done ? '已在书架' : busy ? '加入中…' : '加入书架',
              ),
            )
          }),
        ),
    failures.length > 0
      ? h(
        'details',
        { className: 'dr-legado-failures' },
        h('summary', null, `${failures.length} 个源没搜成`),
        h(
          'ul',
          null,
          failures.map((item) => h('li', { key: item.source }, `${item.source}：${item.reason}`)),
        ),
      )
      : null,
  )

  const sourcesTab = h(
    'div',
    { className: 'dr-legado-body' },
    h(
      'details',
      { className: 'dr-legado-import', open: sources !== null && sources.length === 0 },
      h('summary', null, '导入书源'),
      h('p', { className: 'dr-note' }, 'Legado「网络导入」拿到的 JSON，整包粘进来就行；一个包里几十上百个源都能一次导入。'),
      h('textarea', {
        className: 'dr-input dr-legado-textarea',
        rows: 6,
        placeholder: '[{"bookSourceName":"某某小说网","bookSourceUrl":"https://…","ruleSearch":{…}}]',
        value: importText,
        'aria-label': '书源 JSON',
        onChange: (event) => setImportText(event.target.value),
      }),
      h(
        'div',
        { className: 'dr-legado-row' },
        h(
          'button',
          {
            type: 'button',
            className: 'dr-btn dr-btn-primary',
            disabled: importing,
            onClick: () => doImport(importText),
          },
          importing ? '导入中…' : '导入这段 JSON',
        ),
        h(
          'label',
          { className: 'dr-btn dr-legado-file' },
          '选 .json 文件',
          h('input', {
            type: 'file',
            accept: '.json,application/json',
            onChange: onPickFile,
          }),
        ),
        importText.length > BIG_JSON_CHARS
          ? h('span', { className: 'dr-note' }, `这段有 ${Math.round(importText.length / 1000)} 千字，导入会慢一点。`)
          : null,
      ),
    ),
    sourceError !== '' ? h('div', { className: 'dr-note dr-note-error', role: 'alert' }, sourceError) : null,
    sources === null
      ? h('p', { className: 'dr-note' }, '正在读书源…')
      : sources.length === 0
        ? h('p', { className: 'dr-note' }, '还没有书源。导入一个之后就能在「搜索」页搜书。')
        : h(
          'ul',
          { className: 'dr-legado-list' },
          sources.map((source) => h(
            'li',
            { key: source.url, className: 'dr-legado-item' },
            h(
              'div',
              { className: 'dr-legado-main' },
              h('div', { className: 'dr-legado-name' }, source.name),
              h('div', { className: 'dr-legado-meta' }, source.url),
              h(
                'div',
                { className: 'dr-legado-sub' },
                [
                  source.group ? `分组：${source.group}` : '',
                  source.enabled === false ? '已停用' : '启用中',
                  source.searchUrl ? '' : '没有搜索地址',
                ].filter(Boolean).join(' · '),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-btn',
                onClick: () => toggleSource(source),
              },
              source.enabled === false ? '启用' : '停用',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dr-btn dr-btn-danger',
                onClick: () => removeSource(source),
              },
              '删除',
            ),
          )),
        ),
  )

  return h(
    'div',
    { className: 'dr-modal dr-legado-modal', role: 'dialog', 'aria-label': '书源' },
    h(
      'div',
      { className: 'dr-modal-card dr-legado-card' },
      h(
        'header',
        { className: 'dr-modal-head' },
        h('h2', null, '书源'),
        h('button', { type: 'button', className: 'dr-icon-btn', 'aria-label': '关闭', onClick: props.onClose }, '×'),
      ),
      h(
        'div',
        { className: 'dr-tabs' },
        h(
          'button',
          { type: 'button', className: tab === 'search' ? 'dr-tab is-on' : 'dr-tab', onClick: () => setTab('search') },
          '搜索',
        ),
        h(
          'button',
          { type: 'button', className: tab === 'sources' ? 'dr-tab is-on' : 'dr-tab', onClick: () => setTab('sources') },
          `书源${sources ? `（${sources.length}）` : ''}`,
        ),
      ),
      tab === 'search' ? searchTab : sourcesTab,
    ),
  )
}
