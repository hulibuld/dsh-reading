/**
 * cnki.js —— 知网检索界面的纯函数层（0.12.0）。
 *
 * 这里只放「不碰 DOM、不碰网络」的判定与拼装：
 *   normalizeTitle   —— 书名/题名的归一化，用来判断「这篇是不是已经在书架里」；
 *   isInShelf        —— 那条检索结果在不在书架；
 *   SEARCH_MODES / resolveSearchMode —— 面板「怎么找」那张表（选项 → field + order）；
 *   paperToMarkdown  —— 单条题录拼成一行 Markdown，供「复制题录」用；
 *   collectName      —— 文献集的默认书名。
 *
 * 为什么单独一个模块：shelf.js 是组件，渲染路径上抛错会让整个面板静默消失，
 * 而这些判定（书名号、空白、全半角标点）恰恰是最容易在边界上出错的地方，
 * 抽出来就能脱网单测（test/cnki_ui_test.mjs）。
 */

/**
 * 题名里「不影响是不是同一篇」的字符：书名号、各种引号、顿号逗号句号、
 * 冒号分号、问叹号、括号、方括号、破折号、连字符、斜杠、间隔号。
 *
 * 知网给的是《大型滑坡研究》，而书架里的书名常常写成「大型滑坡研究」——只比
 * 字面量的话，用户会觉得「明明有却说没有」。**只做字符归一，不做后缀容忍**：
 * 「大型滑坡研究（修订版）」归一后是「大型滑坡研究修订版」，与「大型滑坡研究」
 * 不相等，仍判为不在书架（宁可少标一个角标，也不要把两篇不同的文献并成一笔）。
 */
const TITLE_NOISE = /[《》〈〉“”‘’"'、，,。.：:；;！!？?（）()【】[\]—\-_/·]/g

/**
 * 归一化题名：转小写 → 去掉所有空白 → 去掉标点噪声。
 *
 * **不做 NFKC**：全角字母数字（`２０世纪`、`滑坡ＡＢＣ研究`）与半角不判相等。
 * 文档里写的「全半角统一」指的是标点（`（一）` 与 `(一)`、`甲，乙` 与 `甲,乙`），
 * 这条能力 TITLE_NOISE 已经给了；再往前一步去归一字母数字，判断依据就从「同一个
 * 字符」变成「看起来像同一个字符」，误合并的成本比多标一个角标高。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTitle(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  return raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(TITLE_NOISE, '')
}

/**
 * 面板「怎么找」那张表：下拉的四个选项，以及它们背后的检索字段与排序。
 *
 * 为什么要单独抽成常量：这张表曾经把「下载最多」写成 `content=词&Order=3`，而
 * 知网的 `Order=3` 和 `Order=4` 一样是**全局排序**——`content=` 允许正文任意位置
 * 命中，两者一乘捞回来的是全库下载榜（真机实测「滑坡」20 条里只有 1 条标题含词，
 * 首条是《中国特色社会主义理论体系的传统文化基础研究》）。界面上完全看不出来：
 * 跑题结果的下载数更大，标签还写着「下载最多」。所以三种排序都配篇名检索，
 * 只有「相关度」用自由词（它本来就不排序，靠相关度兜）。
 *
 * value 是 `field-order` 拼起来的字符串，与 select 的取值一一对应。
 */
export const SEARCH_MODES = [
  { value: 'title-4', label: '经典文献（被引最高）', field: 'title', order: 4 },
  { value: 'title-2', label: '最新发表', field: 'title', order: 2 },
  { value: 'content-1', label: '相关度', field: 'content', order: 1 },
  { value: 'title-3', label: '下载最多', field: 'title', order: 3 },
]

/** 下拉的缺省值：不认得的值一律退回「经典文献」。 */
const DEFAULT_SEARCH_MODE = SEARCH_MODES[0]

/**
 * 把 select 的值拆回 `{field, order}`。
 *
 * 解析放在这里而不是 shelf.js 的 onChange 里：那边是 `lastIndexOf('-')` 手拆，
 * 拆错了界面照跑、只是搜错东西，正是上面那张表出事的方式。让它可单测。
 *
 * @param {unknown} value
 * @returns {{ field: string, order: number, value: string }}
 */
export function resolveSearchMode(value) {
  const raw = typeof value === 'string' ? value : ''
  const found = SEARCH_MODES.find((mode) => mode.value === raw)
  const mode = found || DEFAULT_SEARCH_MODE
  return { field: mode.field, order: mode.order, value: mode.value }
}

/** 把任意值压成去空白的字符串；非字符串一律当空。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 计数：只接受有限非负数，其余当 0（避免 undefined / NaN 进正文）。 */
function count(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

/**
 * 这条检索结果是不是已经在书架里了。
 *
 * 作者只作辅助、不强求相等：知网上写「黄润秋」，PDF 里可能是「黄润秋 等」，
 * 要求一致会让角标几乎永远不出现。所以只比归一后的题名。
 *
 * @param {{ title?: string } | null | undefined} item
 * @param {Array<{ title?: string }> | null | undefined} books
 * @returns {boolean}
 */
export function isInShelf(item, books) {
  if (!Array.isArray(books) || books.length === 0) return false
  const title = normalizeTitle(item && item.title)
  if (title === '') return false
  return books.some((book) => normalizeTitle(book && book.title) === title)
}

/**
 * 单条题录 → Markdown 一行（有网址时再多一行缩进）。
 *
 * 形状固定为：
 *   - 《题名》. 作者、作者. 期刊, 年期. 被引 N, 下载 N.
 *     https://…
 *
 * 缺字段时整段省略，**不许**出现 undefined / null / 空括号：
 * 作者空了就不要那一段；期刊与年期只剩一个就只写那一个；都没了就省略；
 * 网址空了就不写第二行（按钮那边也会因此变成不可点）。
 *
 * @param {object | null | undefined} item
 * @returns {string}
 */
export function paperToMarkdown(item) {
  const source = item && typeof item === 'object' ? item : {}
  const title = text(source.title) || '未命名文献'
  const authors = Array.isArray(source.authors)
    ? source.authors.map((name) => text(name)).filter((name) => name !== '')
    : []
  const journal = text(source.journal)
  const issue = text(source.issue)
  const citations = count(source.citations)
  const downloads = count(source.downloads)
  const url = text(source.url)

  const parts = [`- 《${title}》`]
  if (authors.length > 0) parts.push(authors.join('、'))
  const source2 = [journal, issue].filter((value) => value !== '').join(', ')
  if (source2 !== '') parts.push(source2)
  parts.push(`被引 ${citations}, 下载 ${downloads}`)

  let line = `${parts.join('. ')}.`
  if (url !== '') line += `\n  ${url}`
  return line
}

/**
 * 文献集的默认书名。条数取整、下限 1，保证不会出现「0 篇」这种怪名字。
 *
 * @param {number} count
 * @returns {string}
 */
export function collectName(count) {
  const number = Number(count)
  const total = Number.isFinite(number) && number > 0 ? Math.floor(number) : 1
  return `文献集 · ${total} 篇`
}
