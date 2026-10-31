/**
 * shelf.js —— 书架：列书、导入、删书。
 *
 * 三态是硬要求（docs/05 §7 的 G2 验收就是「不白屏」）：
 *   加载态 —— 一个转圈 + 一句「正在读书架」，不要留空白让用户以为坏了；
 *   空态   —— 说清「这里会有什么」+ 一个明确的导入按钮；
 *   错误态 —— 只显示 humanizeError 过的中文，绝不出现 JSON / 路径 / 堆栈。
 *
 * 导入走「本地文件 → base64 → 宿主写入书库」：浏览器不能直接落盘，
 * 而宿主侧有大小上限与解压炸弹防护（lib/epub.js），所以这里不做预处理，
 * 只负责把字节原样递过去，并在失败时把宿主的中文原因显示出来。
 */

import {
  coverUrl,
  call,
  humanizeError,
  putBookCover,
  resetBookCover,
  updateBook,
} from './api.js'
import { LegadoPanel } from './legado-ui.js'

/** 单次导入的界面提示上限：超过这个大小先提醒一句，但不阻止（宿主说了算）。 */
const BIG_FILE_BYTES = 120 * 1024 * 1024

/**
 * 自选封面的大小上限，与宿主 book.cover.put 的判定一致（3 MiB）。
 *
 * 前端也挡一次：三兆的图 base64 之后接近四兆，白传一趟再被拒，
 * 用户等的是几十秒的进度条和一句「太大了」。
 */
const COVER_MAX_BYTES = 3 * 1024 * 1024

/** 书名 / 作者的长度上限，与 book.update 的校验一致（按字算，不按字节）。 */
const TITLE_MAX = 120
/** 筛选维度的中文名（下拉与空态提示共用）。 */
const FILTER_KINDS = [
  ['all', '全部书籍'],
  ['favorite', '我的珍藏'],
  ['series', '按系列'],
  ['author', '按作者'],
  ['category', '按分类'],
  ['tag', '按标签'],
]

/** 标签个数上限，与宿主 MAX_TAG_COUNT 保持一致。 */
const TAG_MAX_COUNT = 12
const AUTHOR_MAX = 80

/**
 * 读一个 File 成完整 data URL（含 `data:...;base64,` 前缀）。
 * 失败行为：读不出来时 reject 一个 Error，message 是人话。
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('这个文件读不出来，可能已被移动或没有读取权限。'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) {
        reject(new Error('这个文件读不出来，格式可能不对。'))
        return
      }
      resolve(result)
    }
    reader.readAsDataURL(file)
  })
}

/**
 * 读一个 File 成 base64（不含 data: 前缀）。
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
async function readAsBase64(file) {
  const full = await readAsDataUrl(file)
  return full.slice(full.indexOf(',') + 1)
}

/**
 * 从 base64 开头认图片格式（看魔数，不看扩展名也不信 File.type）。
 *
 * 为什么要自己认：宿主按魔数判定，扩展名和浏览器给的 MIME 都可以是假的；
 * 在这里先认一次，选错文件时立刻能说「只支持 PNG、JPEG、WebP」，
 * 而不是让用户等一趟上传再看到同一句话。
 *
 * @param {string} base64
 * @returns {'image/png'|'image/jpeg'|'image/webp'|''} 认不出来时是空串
 */
function sniffCoverMime(base64) {
  if (typeof base64 !== 'string' || base64 === '') return ''
  let bytes = []
  try {
    // 只要前 12 个字节就够判三种格式；取 32 个 base64 字符恰好解出 24 字节
    const head = typeof atob === 'function' ? atob(base64.slice(0, 32)) : ''
    bytes = Array.from(head, (char) => char.charCodeAt(0))
  } catch (error) {
    return ''
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return ''
}

/** 把 0–1 的进度压成「读完了 42%」这种能读的字。 */
function percentText(percent) {
  const value = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0
  const clamped = Math.max(0, Math.min(1, value))
  return `已读 ${Math.round(clamped * 100)}%`
}

/** 一个纯装饰的加载态。props.text 是给人看的一句说明。 */
function Loading(props) {
  return h(
    'div',
    { className: 'dr-state' },
    h('div', { className: 'dr-spinner', role: 'status', 'aria-label': props.text || '正在加载' }),
    h('div', { className: 'dr-state-text' }, props.text || '正在加载…'),
  )
}

/** 统一的空态。actions 是一组已经做好的按钮节点。 */
function EmptyState(props) {
  return h(
    'div',
    { className: 'dr-state' },
    h('div', { className: 'dr-state-title' }, props.title),
    props.text ? h('div', { className: 'dr-state-text' }, props.text) : null,
    props.actions ? h('div', { className: 'dr-state-actions' }, props.actions) : null,
  )
}

/** 错误提示条。文本已经过 humanizeError，这里不再做任何加工。 */
function ErrorNote(props) {
  if (!props.text) return null
  return h(
    'div',
    { className: 'dr-error-box', role: 'alert' },
    h('div', null, props.text),
  )
}

/**
 * 无封面书的书名字号。
 *
 * 目标是「像一本纸书的封面」：4 个字以内要撑满，20 个字以上要能缩到不溢出。
 * 用长度分段而不是 CSS clamp，因为中文字数才知道该多大 —— 英文 26 个字符
 * 大约等于中文 8 个字的视觉重量。
 */
function coverFontSize(title) {
  const text = String(title || '')
  // 中日韩字符按 1 计，其余按半个计
  let weight = 0
  for (const char of text) weight += char.codePointAt(0) > 0x2e7f ? 1 : 0.5
  if (weight <= 4) return '20px'
  if (weight <= 8) return '17px'
  if (weight <= 14) return '14.5px'
  if (weight <= 22) return '12.5px'
  return '11px'
}

/**
 * 没有封面（或封面没读出来）时用的「米色纸封面」。
 *
 * 书架上大量本地书没有内嵌封面，空白方块会让整个书架看起来像加载失败；
 * 所以退成一张纸书封面：米色纸、居中书名、上下两条细线、底部作者。
 * 留白比字号更重要，书名按长度自动缩字号。
 */
function PaperCover(props) {
  const title = String(props.title || '未命名')
  const author = typeof props.author === 'string' ? props.author : ''
  return h(
    'div',
    { className: 'dr-cover-fallback', 'aria-hidden': 'true' },
    h('div', { className: 'dr-cover-frame' },
      h('div', { className: 'dr-cover-rule' }),
      h(
        'div',
        { className: 'dr-cover-text', style: { fontSize: coverFontSize(title) } },
        title,
      ),
      h('div', { className: 'dr-cover-rule' }),
    ),
    author ? h('div', { className: 'dr-cover-author' }, author) : null,
  )
}

/**
 * 封面盒子。
 *
 * 盒子的尺寸完全由 CSS 决定（width:100% + aspect-ratio:2/3），图片只负责
 * 填满它。这条规矩是「封面大小错乱」的解药：只要让图片的 intrinsic 尺寸
 * 参与排版（比如写死 height:auto），一张 200×800 的细长封面就会把卡片撑高，
 * 同一行里的卡片高度、封面高度立刻各不相同。
 *
 * 少数封面比例极端（比 1:2 还细、接近方形或横版），铺满会把主体裁掉大半，
 * 所以给它们加一层模糊铺底 + contain 居中：盒子仍是 2:3，眼睛看到的还是整张图。
 */
function CoverArt(props) {
  const title = String(props.title || '未命名')
  const author = typeof props.author === 'string' ? props.author : ''
  const src = typeof props.src === 'string' ? props.src : ''
  // 判定结果和被判定的那张图绑在一起（ratio.src === src）：换封面、恢复默认后
  // src 一变，旧判定自动失效，不需要再写一个「换图时清状态」的 effect ——
  // effect 在 DOM 之后才跑，缓存命中时 onLoad 可能先到，状态会被清回去。
  const [ratio, setRatio] = useState(null) // { src, extreme }
  const [brokenSrc, setBrokenSrc] = useState('')

  const broken = src !== '' && brokenSrc === src
  const showImage = src !== '' && !broken
  const extreme = showImage && ratio !== null && ratio.src === src && ratio.extreme === true
  const className = `dr-cover${extreme ? ' is-extreme' : ''}`

  return h(
    'div',
    { className },
    extreme
      ? h('div', {
        className: 'dr-cover-blur',
        'aria-hidden': 'true',
        style: { backgroundImage: `url("${src.replace(/"/g, '%22')}")` },
      })
      : null,
    showImage
      ? h('img', {
        key: src,
        src,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        onError: () => setBrokenSrc(src),
        onLoad: (event) => {
          const img = event && (event.currentTarget || event.target)
          const width = img && typeof img.naturalWidth === 'number' ? img.naturalWidth : 0
          const height = img && typeof img.naturalHeight === 'number' ? img.naturalHeight : 0
          if (width <= 0 || height <= 0) return
          const value = width / height
          // 标准书封是 2:3 ≈ 0.667；细长条和接近方形的都算极端。
          setRatio({ src, extreme: value < 0.5 || value > 0.95 })
        },
      })
      : h(PaperCover, { title, author }),
  )
}

/**
 * 封面地址里的版本号。
 *
 * 宿主现在给 `coverVersion`（换/删一次封面 +1，没封面时是 0），比 updatedAt 准：
 * updatedAt 也会因为改书名、改阅读进度更新时间等无关操作变化，那样换封面的缓存键
 * 会白跳一次。老库/老接口没有这个字段，回退到 updatedAt——**绝不能回退到空**，
 * 否则浏览器按 max-age 的老缓存会把刚换上的封面顶掉，用户看到「换了没生效」。
 */
function coverVersionOf(book) {
  if (book && Number.isInteger(book.coverVersion)) return String(book.coverVersion)
  return book && typeof book.updatedAt === 'string' ? book.updatedAt : ''
}

/**
 * 一张书卡。
 *
 * 封面加载失败时回退成米色纸封面：本地书常常没有封面，空白方块会让书架
 * 看起来像出错。
 */
function BookCard(props) {
  const book = props.book
  const percent = typeof book.percent === 'number' ? book.percent : 0
  const title = book.title || '未命名'
  // 带版本号的封面地址：换完封面的那一刻版本号变了，地址就变了，
  // 不会被浏览器按老缓存顶回旧图（coverVersion 由宿主维护，换/删一次 +1）。
  const cover = typeof book.coverUrl === 'string' && book.coverUrl !== ''
    ? coverUrl(book.bookHash, coverVersionOf(book))
    : ''

  return h(
    'button',
    {
      type: 'button',
      className: 'dr-book',
      onClick: () => props.onOpen(book.bookHash),
      title: `${title}${book.author ? ` · ${book.author}` : ''}`,
    },
    h(CoverArt, { src: cover, title, author: book.author || '' }),
    h('div', { className: 'dr-book-title' }, title),
    // 重排书（MOBI / TXT 转来的）没有原始版式，挂个小标记免得用户以为图片丢了。
    book.sourceFormat && book.sourceFormat !== 'epub'
      ? h(
        'div',
        { className: 'dr-book-badge' },
        book.sourceFormat === 'txt' ? 'TXT · 重排' : `${String(book.sourceFormat).toUpperCase()} · 重排`,
      )
      : null,
    book.favorite === true
      ? h('div', { className: 'dr-book-star', title: '我的珍藏' }, '★')
      : null,
    h('div', { className: 'dr-book-meta dr-ellipsis' }, book.author || '作者未知'),
    // 分类 / 系列 / 标签：只显示一行，最多两个，多了反而把卡片塞满
    (book.series || book.category || (Array.isArray(book.tags) && book.tags.length > 0))
      ? h(
        'div',
        { className: 'dr-book-meta dr-ellipsis dr-book-taxon' },
        [
          book.series ? `系列·${book.series}` : '',
          book.category ? book.category : '',
          ...(Array.isArray(book.tags) ? book.tags.map((tag) => `#${tag}`) : []),
        ].filter((item) => item !== '').slice(0, 2).join(' · '),
      )
      : null,
    h(
      'div',
      { className: 'dr-progress', role: 'progressbar', 'aria-valuenow': Math.round(percent * 100) },
      h('div', {
        className: 'dr-progress-fill',
        style: { width: `${Math.round(Math.max(0, Math.min(1, percent)) * 100)}%` },
      }),
    ),
    h('div', { className: 'dr-book-meta' }, percent > 0 ? percentText(percent) : '还没开始读'),
  )
}

/**
 * 编辑书名 / 作者 / 封面的弹窗。
 *
 * 保存顺序是刻意的：先写封面，再改书名 —— 宿主每次写盘都会刷新 meta 的
 * updatedAt，而这个字段是封面地址的版本号。封面必须紧跟最后一次写盘，
 * 否则书架重新取列表时拿到的还是旧版本号，图和文字会各说各话。
 */
function BookEditDialog(props) {
  const book = props.book
  const [title, setTitle] = useState(typeof book.title === 'string' ? book.title : '')
  const [author, setAuthor] = useState(typeof book.author === 'string' ? book.author : '')
  // 0.5.1 的新字段：简介 / 分类 / 系列 / 标签 / 珍藏
  const [description, setDescription] = useState(typeof book.description === 'string' ? book.description : '')
  const [category, setCategory] = useState(typeof book.category === 'string' ? book.category : '')
  const [series, setSeries] = useState(typeof book.series === 'string' ? book.series : '')
  const [tagText, setTagText] = useState(Array.isArray(book.tags) ? book.tags.join('、') : '')
  const [favorite, setFavorite] = useState(book.favorite === true)
  const [coverDataUrl, setCoverDataUrl] = useState('')
  const [coverCleared, setCoverCleared] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  // 每次选完图就换一个新的 input（key 变化 → React 重新挂载），等于把选择清空：
  // 用户重选同一张图也能再触发 change。不改 DOM 也能做到这件事。
  const [pickSeq, setPickSeq] = useState(0)

  const titleLength = Array.from(String(title)).length
  const authorLength = Array.from(String(author)).length
  const savedCover = typeof book.coverUrl === 'string' && book.coverUrl !== ''
    ? coverUrl(book.bookHash, coverVersionOf(book))
    : ''
  // 预览优先级：新选的图 > 已删除（显示纸封面）> 现有封面
  const preview = coverDataUrl !== '' ? coverDataUrl : (coverCleared ? '' : savedCover)

  const close = () => {
    if (saving) return
    if (typeof props.onCancel === 'function') props.onCancel()
  }

  const onPickCover = async (event) => {
    const input = event && event.target
    const file = input && input.files && input.files[0]
    // 立刻换一个 input（见 pickSeq 的注释）：等于清空选择，
    // 用户重选同一张图时 change 才会再响一次。
    setPickSeq((n) => n + 1)
    if (!file) return
    setError('')
    if (typeof file.size === 'number' && file.size > COVER_MAX_BYTES) {
      setError('封面文件太大，请换一张小于 3 MB 的图片。')
      return
    }
    try {
      const base64 = await readAsBase64(file)
      const mime = sniffCoverMime(base64)
      if (mime === '') {
        setError('只支持 PNG、JPEG、WebP 图片。')
        return
      }
      setCoverDataUrl(`data:${mime};base64,${base64}`)
      setCoverCleared(false)
    } catch (err) {
      setError(humanizeError(err))
    }
  }

  const onSave = async () => {
    if (saving) return
    const nextTitle = String(title).trim()
    const nextAuthor = String(author).trim()
    // 先在本地挡一遍：宿主也会校验，但让用户等一趟网络才知道书名为空没必要
    if (nextTitle === '') {
      setError('书名不能为空。')
      return
    }
    if (Array.from(nextTitle).length > TITLE_MAX) {
      setError(`书名最多 ${TITLE_MAX} 个字。`)
      return
    }
    if (Array.from(nextAuthor).length > AUTHOR_MAX) {
      setError(`作者名最多 ${AUTHOR_MAX} 个字。`)
      return
    }

    setSaving(true)
    setError('')
    try {
      if (coverDataUrl !== '') await putBookCover(book.bookHash, coverDataUrl)
      else if (coverCleared) await resetBookCover(book.bookHash)
      // 标签用中文顿号或逗号分隔都行，两种都拆
      const tags = String(tagText)
        .split(/[、,，;；\s]+/)
        .map((item) => item.trim())
        .filter((item) => item !== '')
      if (tags.length > TAG_MAX_COUNT) {
        setError(`标签最多 ${TAG_MAX_COUNT} 个。`)
        setSaving(false)
        return
      }
      const result = await updateBook(book.bookHash, {
        title: nextTitle,
        author: nextAuthor,
        description: String(description).trim(),
        category: String(category).trim(),
        series: String(series).trim(),
        tags,
        favorite,
      })
      const saved = result && typeof result === 'object'
        && result.book && typeof result.book === 'object' ? result.book : null
      if (typeof props.onSaved === 'function') props.onSaved(saved)
      // 上层通常在这里把弹窗关掉；万一没关（比如没接 onSaved），
      // 按钮不能永远停在「正在保存…」
      setSaving(false)
    } catch (err) {
      // 弹窗不关：用户改的东西还在，改一下重试比重新填一遍省事
      setError(humanizeError(err))
      setSaving(false)
    }
  }

  return h(
    'div',
    {
      className: 'dr-modal-mask',
      role: 'presentation',
      onClick: close,
    },
    h(
      'div',
      {
        className: 'dr-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '编辑书名和封面',
        onClick: (event) => event.stopPropagation(),
      },
      h(
        'div',
        { className: 'dr-modal-head' },
        h('span', null, '编辑书名和封面'),
        h('div', { className: 'dr-grow' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dr-iconbtn',
            title: '关闭',
            'aria-label': '关闭编辑窗口',
            disabled: saving,
            onClick: close,
          },
          '×',
        ),
      ),
      h(
        'div',
        { className: 'dr-modal-body' },
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '书名'),
          h('input', {
            type: 'text',
            className: 'dr-input',
            value: title,
            maxLength: TITLE_MAX,
            placeholder: '这本书叫什么',
            'aria-label': '书名',
            onChange: (event) => setTitle(event.target.value),
          }),
          h('div', { className: 'dr-field-value' }, `${titleLength}/${TITLE_MAX}`),
        ),
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '作者'),
          h('input', {
            type: 'text',
            className: 'dr-input',
            value: author,
            maxLength: AUTHOR_MAX,
            placeholder: '不知道就留空',
            'aria-label': '作者',
            onChange: (event) => setAuthor(event.target.value),
          }),
          h('div', { className: 'dr-field-value' }, `${authorLength}/${AUTHOR_MAX}`),
        ),
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '分类'),
          h('input', {
            type: 'text',
            className: 'dr-input',
            value: category,
            maxLength: 40,
            placeholder: '如：科幻、散文、教材（留空 = 未分类）',
            'aria-label': '分类',
            onChange: (event) => setCategory(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '系列'),
          h('input', {
            type: 'text',
            className: 'dr-input',
            value: series,
            maxLength: 80,
            placeholder: '同一套书填同一个名字，如：三体',
            'aria-label': '系列',
            onChange: (event) => setSeries(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '标签'),
          h('input', {
            type: 'text',
            className: 'dr-input',
            value: tagText,
            placeholder: '用顿号或逗号分开，如：硬科幻、已读完',
            'aria-label': '标签',
            onChange: (event) => setTagText(event.target.value),
          }),
          h('div', { className: 'dr-field-value' }, `最多 ${TAG_MAX_COUNT} 个`),
        ),
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '简介'),
          h('textarea', {
            className: 'dr-input dr-textarea',
            value: description,
            rows: 4,
            placeholder: '这本书讲什么（记给自己看，不会上传）',
            'aria-label': '简介',
            onChange: (event) => setDescription(event.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dr-field dr-field-inline' },
          h(
            'label',
            { className: 'dr-check' },
            h('input', {
              type: 'checkbox',
              checked: favorite,
              onChange: (event) => setFavorite(event.target.checked),
            }),
            h('span', null, '加入我的珍藏'),
          ),
        ),
        h(
          'div',
          { className: 'dr-field' },
          h('div', { className: 'dr-field-label' }, '封面'),
          h(
            'div',
            { className: 'dr-edit-cover' },
            h('div', { className: 'dr-edit-cover-preview' },
              h(CoverArt, { src: preview, title: title || book.title, author }),
            ),
            h(
              'div',
              { className: 'dr-edit-cover-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-btn dr-btn-sm',
                  title: '选择图片',
                  'aria-label': '选择封面图片',
                  onClick: () => {
                    if (fileRef.current) fileRef.current.click()
                  },
                },
                '选择图片',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dr-btn dr-btn-sm dr-btn-ghost',
                  title: '删除封面，用默认的纸封面',
                  'aria-label': '删除封面',
                  disabled: preview === '',
                  onClick: () => {
                    setCoverDataUrl('')
                    setCoverCleared(true)
                  },
                },
                '删除封面',
              ),
              h('div', { className: 'dr-field-hint' }, 'PNG、JPEG 或 WebP，最大 3 MB'),
            ),
          ),
          h('input', {
            key: pickSeq,
            ref: fileRef,
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp',
            'aria-hidden': 'true',
            tabIndex: -1,
            style: { display: 'none' },
            onChange: onPickCover,
          }),
        ),
        error ? h('div', { className: 'dr-form-error', role: 'alert' }, error) : null,
      ),
      h(
        'div',
        { className: 'dr-modal-foot' },
        h(
          'button',
          {
            type: 'button',
            className: 'dr-btn dr-btn-ghost',
            title: '取消',
            disabled: saving,
            onClick: close,
          },
          '取消',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dr-btn dr-btn-primary',
            title: '保存',
            disabled: saving,
            onClick: onSave,
          },
          saving ? '正在保存…' : '保存',
        ),
      ),
    ),
  )
}

/**
 * 书架视图。
 *
 * props:
 *   onOpen(bookHash)      —— 点开一本书
 *   onImported(bookHash)  —— 导入成功（可选，用于直接跳进去读）
 *
 * 这里自己管加载/错误状态，不把网络细节漏给 app.js —— 上层只关心「打开哪本书」。
 */

/**
 * 「导入」面板（0.5.1）。
 *
 * 三条路并列摆出来，而不是藏在二级菜单里：
 *   ① 本地文件 —— 原来就有的行为；
 *   ② 粘贴链接 —— 从任何地方复制来的书籍直链，粘进来就下载入架；
 *   ③ 找书     —— 用户自己填一个「搜索地址模板」，插件去抓结果页列出候选。
 *
 * 为什么不内置书源：插件不该替用户决定去哪个站点找书。这里只提供机制，
 * 地址由用户自己填；模板里 `{query}` 会被换成关键词。
 */
function ImportDialog(props) {
  const fileRef = useRef(null)
  const [url, setUrl] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlError, setUrlError] = useState('')

  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchInfo, setSearchInfo] = useState('')
  const [candidates, setCandidates] = useState(null)
  const [downloading, setDownloading] = useState('')
  const [downloadError, setDownloadError] = useState('')

  const [sources, setSources] = useState(null)
  const [sourceId, setSourceId] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [formName, setFormName] = useState('')
  const [formTemplate, setFormTemplate] = useState('')
  const [formError, setFormError] = useState('')
  const [savingSource, setSavingSource] = useState(false)

  useEffect(() => {
    let alive = true
    call('settings.get')
      .then((value) => {
        if (!alive) return
        const list = Array.isArray(value && value.bookSources) ? value.bookSources : []
        setSources(list)
        if (list.length > 0) setSourceId(list[0].id)
        else setFormOpen(true)
      })
      .catch(() => {
        if (!alive) return
        setSources([])
        setFormOpen(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const busy = urlBusy || downloading !== '' || savingSource
  const close = () => {
    if (busy) return
    if (typeof props.onClose === 'function') props.onClose()
  }

  const submitUrl = async () => {
    const value = url.trim()
    if (value === '') {
      setUrlError('先把链接粘贴到上面的框里。')
      return
    }
    setUrlError('')
    setUrlBusy(true)
    try {
      await props.onImportUrl(value)
    } catch (error) {
      setUrlError(humanizeError(error))
    } finally {
      setUrlBusy(false)
    }
  }

  const runSearch = async () => {
    const value = keyword.trim()
    if (value === '') {
      setSearchError('输入书名或作者，再点搜索。')
      return
    }
    if (Array.isArray(sources) && sources.length === 0) {
      setSearchError('还没有书源：先在下面填一个搜索地址模板。')
      return
    }
    setSearching(true)
    setSearchError('')
    setSearchInfo('')
    setCandidates(null)
    try {
      const result = await call('source.search', { query: value, sourceId: sourceId || undefined })
      const list = Array.isArray(result && result.candidates) ? result.candidates : []
      setCandidates(list)
      const name = result && result.source && result.source.name ? result.source.name : '书源'
      setSearchInfo(
        list.length === 0
          ? `${name} 没有返回可用的链接。可能站点改版了，换一个书源试试。`
          : `${name} · 找到 ${list.length} 条，点右边的「下载」加入书架`,
      )
    } catch (error) {
      setSearchError(humanizeError(error))
    } finally {
      setSearching(false)
    }
  }

  const download = async (candidate) => {
    setDownloadError('')
    setDownloading(candidate.url)
    try {
      await props.onImportUrl(candidate.url, candidate.title)
    } catch (error) {
      setDownloadError(humanizeError(error))
    } finally {
      setDownloading('')
    }
  }

  const saveSource = async () => {
    const name = formName.trim() === '' ? '我的书源' : formName.trim()
    const template = formTemplate.trim()
    if (!/^https?:\/\//i.test(template)) {
      setFormError('搜索地址要以 http:// 或 https:// 开头。')
      return
    }
    if (!template.includes('{query}')) {
      setFormError('搜索地址里要留一个 {query}，它会被换成你搜的关键词。')
      return
    }
    setSavingSource(true)
    setFormError('')
    const next = (sources || []).filter((item) => item && item.name !== name)
    next.push({ id: `src-${Date.now().toString(36)}`, name, searchUrl: template })
    try {
      const saved = await call('settings.put', { bookSources: next })
      const list = Array.isArray(saved && saved.bookSources) ? saved.bookSources : next
      setSources(list)
      setSourceId(list[list.length - 1].id)
      setFormOpen(false)
      setFormName('')
      setFormTemplate('')
    } catch (error) {
      setFormError(humanizeError(error))
    } finally {
      setSavingSource(false)
    }
  }

  const fileInput = h('input', {
    ref: fileRef,
    type: 'file',
    accept: '.epub,.mobi,.azw,.azw3,.txt,.pdf,application/epub+zip,application/x-mobipocket-ebook,text/plain,application/pdf',
    style: { display: 'none' },
    onChange: props.onFilePicked,
  })

  return h(
    'div',
    { className: 'dr-modal-mask', role: 'presentation', onClick: close },
    h(
      'div',
      {
        className: 'dr-modal dr-import',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '导入图书',
        onClick: (event) => event.stopPropagation(),
      },
      h(
        'div',
        { className: 'dr-modal-head' },
        h('span', null, '导入图书'),
        h('div', { className: 'dr-grow' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dr-iconbtn',
            title: '关闭',
            'aria-label': '关闭导入窗口',
            disabled: busy,
            onClick: close,
          },
          '×',
        ),
      ),
      h(
        'div',
        { className: 'dr-modal-body' },
        // ① 本地文件
        h(
          'div',
          { className: 'dr-import-section' },
          h('div', { className: 'dr-import-title' }, '① 从电脑里选'),
          h('div', { className: 'dr-import-hint' }, '支持 EPUB / MOBI / AZW3 / TXT / PDF。'),
          h(
            'button',
            {
              type: 'button',
              className: 'dr-btn dr-btn-primary',
              disabled: busy,
              onClick: () => {
                if (fileRef.current) fileRef.current.click()
              },
            },
            '选择文件',
          ),
          fileInput,
        ),
        // ② 粘贴链接
        h(
          'div',
          { className: 'dr-import-section' },
          h('div', { className: 'dr-import-title' }, '② 粘贴下载链接'),
          h('div', { className: 'dr-import-hint' }, '在任意网页上复制这本书的文件地址（以 .epub / .pdf / .txt 结尾的那种），粘进来直接下载入架。'),
          h('input', {
            type: 'text',
            className: 'dr-input',
            value: url,
            placeholder: 'https://…/book.epub',
            'aria-label': '书籍下载链接',
            onChange: (event) => setUrl(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submitUrl()
            },
          }),
          h(
            'div',
            { className: 'dr-import-row' },
            h(
              'button',
              { type: 'button', className: 'dr-btn dr-btn-primary', disabled: busy, onClick: submitUrl },
              urlBusy ? '正在下载…' : '下载并导入',
            ),
          ),
          urlError !== '' ? h('div', { className: 'dr-import-error' }, urlError) : null,
        ),
        // ③ 找书
        h(
          'div',
          { className: 'dr-import-section' },
          h('div', { className: 'dr-import-title' }, '③ 找书（用你自己的书源）'),
          h('div', { className: 'dr-import-hint' }, '填一个「搜索地址模板」，插件去抓那个页面的搜索结果显示出来。模板里把关键词的位置写成 {query}。'),
          h(
            'div',
            { className: 'dr-import-row' },
            h('input', {
              type: 'text',
              className: 'dr-input',
              value: keyword,
              placeholder: '书名或作者',
              'aria-label': '搜索关键词',
              onChange: (event) => setKeyword(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runSearch()
              },
            }),
            Array.isArray(sources) && sources.length > 1
              ? h(
                'select',
                {
                  className: 'dr-input dr-select',
                  value: sourceId,
                  'aria-label': '选择书源',
                  onChange: (event) => setSourceId(event.target.value),
                },
                sources.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
              )
              : null,
            h(
              'button',
              { type: 'button', className: 'dr-btn', disabled: searching || busy, onClick: runSearch },
              searching ? '正在搜…' : '搜索',
            ),
          ),
          searchError !== '' ? h('div', { className: 'dr-import-error' }, searchError) : null,
          searchInfo !== '' ? h('div', { className: 'dr-import-hint' }, searchInfo) : null,
          downloadError !== '' ? h('div', { className: 'dr-import-error' }, downloadError) : null,
          candidates !== null && candidates.length > 0
            ? h(
              'div',
              { className: 'dr-candidates' },
              candidates.map((item) => h(
                'div',
                { key: item.url, className: 'dr-candidate' },
                h('div', { className: 'dr-candidate-title', title: item.url }, item.title),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dr-btn',
                    disabled: downloading !== '',
                    onClick: () => download(item),
                  },
                  downloading === item.url ? '下载中…' : '下载',
                ),
              )),
            )
            : null,
          // 书源管理：有书源时收起来，没书源时直接展开
          formOpen
            ? h(
              'div',
              { className: 'dr-source-form' },
              h('input', {
                type: 'text',
                className: 'dr-input',
                value: formName,
                placeholder: '书源名字（随便起，如「我的站」）',
                'aria-label': '书源名字',
                onChange: (event) => setFormName(event.target.value),
              }),
              h('input', {
                type: 'text',
                className: 'dr-input',
                value: formTemplate,
                placeholder: 'https://example.com/search?q={query}',
                'aria-label': '搜索地址模板',
                onChange: (event) => setFormTemplate(event.target.value),
              }),
              h(
                'div',
                { className: 'dr-import-row' },
                h(
                  'button',
                  { type: 'button', className: 'dr-btn dr-btn-primary', disabled: busy, onClick: saveSource },
                  savingSource ? '保存中…' : '保存书源',
                ),
                Array.isArray(sources) && sources.length > 0
                  ? h('button', { type: 'button', className: 'dr-btn', onClick: () => setFormOpen(false) }, '取消')
                  : null,
              ),
              formError !== '' ? h('div', { className: 'dr-import-error' }, formError) : null,
            )
            : h(
              'button',
              { type: 'button', className: 'dr-btn dr-import-linkbtn', onClick: () => setFormOpen(true) },
              '添加/修改书源',
            ),
        ),
      ),
    ),
  )
}

/**
 * 书架筛选（0.5.1）。
 *
 * 「我的珍藏」是唯一不需要第二个参数的筛选项；其余三类（系列 / 作者 / 分类 / 标签）
 * 都要先选一个具体值。做成两级下拉而不是一堆标签墙：书多了以后标签墙会失控。
 *
 * @param {any[]} books
 * @param {string} kind
 * @param {string} value
 * @returns {any[]}
 */
export function filterBooks(books, kind, value) {
  const list = Array.isArray(books) ? books : []
  if (kind === 'favorite') return list.filter((book) => book.favorite === true)
  // 下拉里的「全部」是空串：选了维度但还没选值时，先当「不筛」，
  // 否则用户会以为「按作者 → 全部」把书弄丢了。
  if (value === '') return list
  if (kind === 'series') return list.filter((book) => (book.series || '') === value)
  if (kind === 'author') return list.filter((book) => (book.author || '') === value)
  if (kind === 'category') return list.filter((book) => (book.category || '') === value)
  if (kind === 'tag') return list.filter((book) => Array.isArray(book.tags) && book.tags.includes(value))
  return list
}

/** 某个筛选维度下所有可选值（去重、排序、去掉空值）。 */
export function facetValues(books, kind) {
  const list = Array.isArray(books) ? books : []
  const out = new Set()
  for (const book of list) {
    if (kind === 'series' && book.series) out.add(book.series)
    if (kind === 'author' && book.author) out.add(book.author)
    if (kind === 'category' && book.category) out.add(book.category)
    if (kind === 'tag' && Array.isArray(book.tags)) book.tags.forEach((tag) => out.add(tag))
  }
  return Array.from(out).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
}

export function ShelfView(props) {
  const [books, setBooks] = useState(null) // null = 还在读
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState(null) // 正在编辑的书；null = 弹窗关着
  const [importOpen, setImportOpen] = useState(false) // 「导入」面板（0.5.1）
  const [legadoOpen, setLegadoOpen] = useState(false) // 书源面板：搜书、加书（0.9.0）
  const [filterKind, setFilterKind] = useState('all') // 书架筛选维度（0.5.1）
  const [filterValue, setFilterValue] = useState('')
  const [notice, setNotice] = useState('') // 一句话提示，几秒后自己消失
  const inputRef = useRef(null)

  useEffect(() => {
    let alive = true
    setBooks(null)
    setError('')
    call('shelf.list')
      .then((value) => {
        if (!alive) return
        const list = value && Array.isArray(value.books) ? value.books : []
        setBooks(list)
      })
      .catch((err) => {
        if (!alive) return
        setError(humanizeError(err))
        setBooks([])
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const reload = useCallback(() => {
    setReloadKey((n) => n + 1)
  }, [])

  // 提示条两秒后自己走：这种「已保存」不该占着屏幕等用户点掉
  useEffect(() => {
    if (notice === '') return undefined
    const timer = setTimeout(() => setNotice(''), 2200)
    return () => clearTimeout(timer)
  }, [notice])

  const onEdit = useCallback((book) => {
    setError('')
    setEditing(book)
  }, [])

  const onEditCancel = useCallback(() => {
    setEditing(null)
  }, [])

  const onEditSaved = useCallback(() => {
    setEditing(null)
    setNotice('已保存')
    // 必须重新取列表：封面地址里带的是 meta 的 updatedAt 版本号，
    // 只改本地字段的话，封面会一直显示旧图（浏览器手里还有旧缓存）。
    reload()
  }, [reload])

  const onPickFile = useCallback(
    async (event) => {
      const input = event.target
      const file = input && input.files && input.files[0]
      // 允许重复选同一个文件：不清空的话第二次选它不会触发 change
      if (input) input.value = ''
      if (!file) return

      setImportError('')
      if (typeof file.size === 'number' && file.size > BIG_FILE_BYTES) {
        // 不阻止，只是先提醒：宿主侧有真正的上限判定
        setImportError('这个文件很大，导入可能要一会儿。')
      }
      setImporting(true)
      try {
        const dataBase64 = await readAsBase64(file)
        const result = await call('shelf.import', { filename: file.name, dataBase64 })
        const bookHash = result && result.bookHash
        if (typeof bookHash === 'string' && bookHash !== '') {
          if (typeof props.onImported === 'function') {
            props.onImported(bookHash)
          } else {
            reload()
          }
        } else {
          reload()
        }
      } catch (err) {
        setImportError(humanizeError(err))
      } finally {
        setImporting(false)
      }
    },
    [props.onImported, reload],
  )

  // 「粘贴链接 / 找书下载」共用一条通道：宿主负责下载、嗅探格式、入架。
  const onImportUrl = useCallback(
    async (url, title) => {
      setImportError('')
      setImporting(true)
      try {
        const filename = typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
        const result = await call('shelf.importUrl', filename ? { url, filename } : { url })
        const bookHash = result && result.bookHash
        setImportOpen(false)
        setNotice('已加入书架')
        if (typeof bookHash === 'string' && bookHash !== '' && typeof props.onImported === 'function') {
          props.onImported(bookHash)
        } else {
          reload()
        }
      } catch (err) {
        // 抛回给面板显示：面板里的输入框还在，用户可以直接改链接重试。
        throw err
      } finally {
        setImporting(false)
      }
    },
    [props.onImported, reload],
  )

  const onRemove = useCallback(
    async (bookHash, title) => {
      const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(
          `把《${title || '这本书'}》从书架里移除？\n\n批注和阅读进度也会一起删掉，这一步不能撤销。`,
        )
        : true
      if (!confirmed) return
      setError('')
      try {
        await call('shelf.remove', { bookHash })
        reload()
      } catch (err) {
        setError(humanizeError(err))
      }
    },
    [reload],
  )

  const fileInput = h('input', {
    ref: inputRef,
    type: 'file',
    // 五种格式一起放进来：扩展名只是给文件选择器看的提示，真正的格式判定
    // 在宿主侧按文件字节（魔数）做，改扩展名骗不过去。
    accept: '.epub,.mobi,.azw,.azw3,.txt,.pdf,application/epub+zip,application/x-mobipocket-ebook,text/plain,application/pdf',
    style: { display: 'none' },
    onChange: onPickFile,
  })

  const importButton = h(
    'button',
    {
      type: 'button',
      className: 'dr-btn dr-btn-primary dr-btn-lg',
      disabled: importing,
      onClick: () => setImportOpen(true),
    },
    h('svg', {
      width: 17,
      height: 17,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M4 5.5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z' }),
    h('path', { d: 'M20 5.5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z' }),
    ),
    importing ? '正在导入…' : '导入图书',
  )

  const safeBooks = Array.isArray(books) ? books : []
  const facets = filterKind === 'all' || filterKind === 'favorite' ? [] : facetValues(safeBooks, filterKind)
  const visibleBooks = filterBooks(safeBooks, filterKind, filterValue)
  const filterLabel = (FILTER_KINDS.find(([value]) => value === filterKind) ?? ['all', '全部书籍'])[1]

  // 筛选栏固定左上角：先选「按什么筛」，再选「具体值」。
  const filterBar = h(
    'div',
    { className: 'dr-filters' },
    h(
      'select',
      {
        className: 'dr-input dr-select dr-filter-select',
        value: filterKind,
        'aria-label': '筛选方式',
        onChange: (event) => {
          setFilterKind(event.target.value)
          setFilterValue('')
        },
      },
      FILTER_KINDS.map(([value, label]) => h('option', { key: value, value }, label)),
    ),
    facets.length > 0
      ? h(
        'select',
        {
          className: 'dr-input dr-select dr-filter-select',
          value: filterValue,
          'aria-label': '筛选值',
          onChange: (event) => setFilterValue(event.target.value),
        },
        [h('option', { key: '__any', value: '' }, '全部')].concat(
          facets.map((value) => h('option', { key: value, value }, value)),
        ),
      )
      : null,
    filterKind !== 'all'
      ? h(
        'button',
        {
          type: 'button',
          className: 'dr-btn',
          onClick: () => {
            setFilterKind('all')
            setFilterValue('')
          },
        },
        '清除筛选',
      )
      : null,
    h(
      'button',
      {
        type: 'button',
        className: 'dr-btn dr-filters-btn',
        onClick: () => setLegadoOpen(true),
        title: '导入 Legado 书源、按书源搜书',
      },
      '书源',
    ),
    safeBooks.length > 0
      ? h('span', { className: 'dr-filters-count' }, `${visibleBooks.length} / ${safeBooks.length} 本`)
      : null,
  )

  const head = h(
    'div',
    { className: 'dr-head' },
    h('div', { className: 'dr-head-title' }, '书架'),
    h(
      'div',
      { className: 'dr-head-sub' },
      books === null ? '正在读取…' : books.length === 0 ? '还没有书' : `${books.length} 本`,
    ),
    h('div', { className: 'dr-grow' }),
    books !== null && books.length > 0
      ? h('button', { type: 'button', className: 'dr-btn', onClick: reload }, '刷新')
      : null,
    importButton,
    fileInput,
  )

  let body
  if (books === null) {
    body = h(Loading, { text: '正在读书架…' })
  } else if (books.length === 0 && error === '') {
    body = h(EmptyState, {
      title: '书架还是空的',
      text: '支持 EPUB / MOBI / AZW3 / TXT / PDF，点右上角「导入图书」就能开始读。书会存在你自己的磁盘上，不上传任何服务器。',
      actions: importButton,
    })
  } else if (visibleBooks.length === 0) {
    // 书架有书、但当前筛选下面没有 → 不是「书架空了」，要说清楚并给一条退路。
    body = h(
      'div',
      { className: 'dr-filter-empty' },
      h('div', null, `「${filterLabel}」下面还没有书。`),
      h(
        'button',
        {
          type: 'button',
          className: 'dr-btn',
          onClick: () => {
            setFilterKind('all')
            setFilterValue('')
          },
        },
        '看全部书籍',
      ),
    )
  } else {
    body = h(
      'div',
      { className: 'dr-grid' },
      // 每个格子自己是一个 grid item（.dr-book-cell），样式里给它 min-width:0：
      // 长作者名 / 长书名不许把格子撑宽，否则卡片会溢出去盖住邻卡。
      visibleBooks.map((book) => h(
        'div',
        {
          key: book.bookHash,
          className: 'dr-book-cell',
          // 右键 = 改这本书的信息。和右上角「✎」是同一个入口，
          // 但右键更符合「对着这本书操作」的直觉。
          onContextMenu: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            onEdit(book)
          },
        },
        h(BookCard, { book, onOpen: props.onOpen }),
        h(
          'button',
          {
            type: 'button',
            className: 'dr-iconbtn',
            title: '编辑书名和封面',
            'aria-label': `编辑《${book.title || '未命名'}》的书名和封面`,
            style: { position: 'absolute', top: 14, right: 46 },
            onClick: (event) => {
              event.stopPropagation()
              onEdit(book)
            },
          },
          '✎',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dr-iconbtn',
            title: '从书架移除',
            'aria-label': `从书架移除《${book.title || '未命名'}》`,
            style: { position: 'absolute', top: 14, right: 14 },
            onClick: (event) => {
              event.stopPropagation()
              onRemove(book.bookHash, book.title)
            },
          },
          '×',
        ),
      )),
    )
  }

  return h(
    'div',
    { className: 'dr-root' },
    head,
    books !== null ? filterBar : null,
    h(
      'div',
      { className: 'dr-body' },
      error ? h(ErrorNote, { text: error }) : null,
      importError ? h(ErrorNote, { text: importError }) : null,
      body,
    ),
    importOpen
      ? h(ImportDialog, {
        onClose: () => setImportOpen(false),
        onFilePicked: (event) => {
          setImportOpen(false)
          onPickFile(event)
        },
        onImportUrl,
      })
      : null,
    editing
      ? h(BookEditDialog, {
        book: editing,
        onCancel: onEditCancel,
        onSaved: onEditSaved,
      })
      : null,
    h(LegadoPanel, {
      open: legadoOpen,
      onClose: () => setLegadoOpen(false),
      onAdded: () => {
        reload()
        setNotice('已加入书架')
      },
    }),
    notice !== '' ? h('div', { className: 'dr-toast', role: 'status' }, notice) : null,
  )
}
