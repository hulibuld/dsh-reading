/**
 * mynotes.js —— 「这本书我写过什么」（0.13.0 P6）。
 *
 * 反向读：把用户自己在 Obsidian 里这本书文件夹下积累的页读回来，**只读文件名与
 * 一二级小标题**，正文一个字都不往外送（docs/26 §八 那张表里 P6 的红线）。
 *
 * 为什么值得做：正向写笔记解决「程序写给你看」，但读一本书真正的资产是用户自己
 * 那些年的碎笔记。他打开侧栏第一件想知道的是「这本书我以前写过什么」，而不是
 * 「这次要写什么」。这件事不需要模型，只需要读目录。
 *
 * 三条约束：
 *   1. 不建索引、不存台账 —— 产出就是 Markdown，用户随时可能在 Obsidian 里改名
 *      或删页；再存一份索引，两者一不一致界面就开始撒谎（thread.list 同一条理由）；
 *   2. 只读小标题，不读正文 —— readHeadings 逐行匹配 ^#{1,2}，其它行扫过即弃，
 *      返回值里没有任何正文，所以也不存在「不小心把正文喂给模型」这条路；
 *   3. 我们自动写的块（`dsh-reading:block` 标记之间）单独计数 —— 那些 `## 第三章`
 *      是程序加的，不该冒充成「你写过的」。
 */

import { parseBlocks } from './blocks.js'
import { bookFolderName } from './notesync.js'

/** 一次最多列多少页。够看，也防着误连到一个几千页的库把侧栏拖死。 */
export const MINE_MAX_FILES = 200

/** 一页最多收多少条小标题。正文再长，侧栏也只是个目录。 */
export const MINE_MAX_HEADINGS = 40

/** 小标题超过这个长度就截断：侧栏一行放不下，也没人需要那么长的标题。 */
const HEADING_MAX = 80

/** 只认一级与二级标题。三级以下太碎，列出来反而看不清这本书写过什么。 */
const HEADING_RE = /^(#{1,2})\s+(\S.*?)\s*#*\s*$/

/** 截断小标题（长标题保留开头，尾部补省略号）。 */
function clip(text) {
  const value = String(text ?? '').trim()
  return value.length > HEADING_MAX ? value.slice(0, HEADING_MAX - 1).trim() + '…' : value
}

/**
 * 从一篇 Markdown 里读出小标题。
 *
 * `own` 表示「这一行不在程序管理的块里」——也就是用户自己写的。
 * 每条都带 `line`（从 1 数），界面上不必用，但排查「这行是哪来的」时很有用。
 *
 * @param {unknown} markdown
 * @returns {{ headings: {text: string, level: number, own: boolean, line: number}[], ownCount: number }}
 */
export function readHeadings(markdown) {
  const text = String(markdown ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  // 块区间用来区分「程序写的」与「用户写的」。缺 end 的块按 parseBlocks 的口径
  // 一直算到文件尾：宁可把后面的标题误判成程序的，也不要把程序写的算成用户的。
  const ranges = parseBlocks(text).blocks.map((block) => ({ start: block.start, end: block.end }))
  const headings = []
  let ownCount = 0
  let offset = 0
  let line = 0
  for (const raw of text.split('\n')) {
    const at = offset
    offset += raw.length + 1
    line += 1
    const match = HEADING_RE.exec(raw)
    if (!match) continue
    const own = !ranges.some((range) => at > range.start && at < range.end)
    if (own) ownCount += 1
    if (headings.length < MINE_MAX_HEADINGS) {
      headings.push({ text: clip(match[2]), level: match[1].length, own, line })
    }
  }
  return { headings, ownCount }
}

/**
 * 这本书文件夹下的全部页 + 每页的小标题。
 *
 * 只列这本书自己的文件夹（`《书名》-<hash>`）：跨书的事由「跨书主题」负责，
 * 这里回答的是「**这本书**我以前写过什么」。
 *
 * @param {import('./vault.js').Vault} vault
 * @param {{ title?: unknown, bookHash?: unknown }} input
 * @returns {Promise<{ folder: string, files: object[], skipped: number }>}
 */
export async function listMyNotes(vault, input) {
  const folder = bookFolderName({ title: input?.title, bookHash: input?.bookHash })
  const relPaths = await vault.listMarkdown(folder)
  const files = []
  let skipped = 0
  for (const relPath of relPaths) {
    if (files.length >= MINE_MAX_FILES) {
      skipped += 1
      continue
    }
    const markdown = await vault.read(relPath)
    // 目录与文件之间可能有竞争（用户正好在删页）；读不到就当没有，不报错。
    if (typeof markdown !== 'string') continue
    const info = await vault.stat(relPath)
    const parsed = readHeadings(markdown)
    files.push({
      relPath,
      // 文件夹内的相对名，界面上比全路径好认
      name: relPath.startsWith(folder + '/') ? relPath.slice(folder.length + 1) : relPath,
      headings: parsed.headings,
      ownCount: parsed.ownCount,
      size: Number.isFinite(info?.size) ? info.size : 0,
      updatedAt: typeof info?.updatedAt === 'string' ? info.updatedAt : '',
    })
  }
  return { folder, files, skipped }
}
