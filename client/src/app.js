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

import {
  aiLog,
  aiLogClear,
  aiProbe,
  aiModels,
  aiStatus,
  call,
  distillChapter,
  distillClear,
  distillExport,
  distillGet,
  distillSkeleton,
  getDeviceId,
  humanizeError,
  searchBook,
} from './api.js'
import { ensureStyle, cssText, HIGHLIGHT_COLORS, HIGHLIGHT_ORDER } from './style.js'
import { ShelfView } from './shelf.js'
import { TocPanel, flattenToc } from './toc.js'
import { ReaderView, THEMES, FONT_CHOICES } from './reader.js'
import * as CFI from './cfi.js'
import {
  AnnotationMenu,
  AnnotationSidebar,
  AskPanel,
  NoteEditor,
  Overlayer,
  QaSidebar,
  SelectionMenu,
  computeRects,
  findOverlap,
  rangeRectToMenuBase,
  selectRecord,
  useAnnotations,
  useQaHistory,
} from './annotate.js'
import { ensureQaStyle } from './style-qa.js'
import { SearchPanel } from './search.js'
import { AiPanel, AiModelPicker, statusSummary } from './ai.js'
import { DistillPanel, distillSummary, downloadMarkdown, exportFilename } from './distill.js'

/**
 * 取选区所在段落的全文，当作「当前工作内容」交给 AI（0.8.0）。
 *
 * 为什么要按块节点找：用户圈的往往是一个短语，而模型需要的是它所在的整段。
 * 找不到块节点（比如整本书是一串裸文本）就退一步用选区起点所在的字符节点。
 *
 * @param {Range} range
 * @returns {string} 最多 1500 字，空串表示取不到
 */
export function surroundingOfSelection(range) {
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

export function rememberAskDraft(bookHash, payload) {
  try {
    if (typeof bookHash !== 'string' || bookHash === '') return
    globalThis.localStorage?.setItem(`${ASK_DRAFT_PREFIX}${bookHash}`, JSON.stringify({ at: Date.now(), payload }))
  } catch (error) {
    // 隐私模式 / 存满：存不下不影响这次提问
  }
}

export function readAskDraft(bookHash) {
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

export function forgetAskDraft(bookHash) {
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

  // 分组标题：Legado 的设置也是这么分的（文字 / 纸张 / 翻页），
  // 一屏七八个控件不分段，用户找不到「字号在哪」。
  const group = (label) => h('div', { className: 'dr-set-group' }, label)

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
      group('文字'),
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
      group('纸张'),
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
      group('翻页'),
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
export function PanelPage(props) {
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
export function PanelIcon(props) {
  const size = Number.isFinite(props && props.size) ? props.size : 20
  // 视框收一圈：图形本身占不满 24×24，外壳给的尺寸又固定，
  // 直接放大宽度会和左侧栏那一排图标错位。收紧视框是等尺寸下把书放大。
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '3.2 3.4 17.6 17.4',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.55,
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

export function apply(ctx) {
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
export const inject = ['slots']

// ── 对外可见的组件面 ──────────────────────────────────────────
// 产物只有一个出口（exports 从 app 的导出表生成），所以调试与测试要用的东西
// 都从这里透出去。它们不影响宿主的加载契约：宿主只认 apply / inject。
//   TocPanel / AnnotationSidebar / Overlayer 给测试逐块渲染；
//   computeRects 是覆盖层的几何纯函数，也是「不改正文 DOM」的证明点。
export { computeRects, Overlayer, AnnotationMenu, AnnotationSidebar, SelectionMenu, AskPanel }
export { ReaderView }
export { ShelfView }
export { TocPanel }
