/**
 * notesync.js —— 四类 Obsidian 产物的组装与落盘（0.13.0）。
 *
 * 分工（docs/26 §九）：
 *   blocks.js  —— 锚块协议：parse / render / replace（纯函数）
 *   vault.js   —— 唯一碰文件的地方：探测、原子写、备份、幂等 upsert
 *   notesync.js—— 决定「写什么、写到哪个文件、块 id 叫什么」，然后调 vault
 *
 * 做三类：00 全书地图（map）、01 读书笔记（note）、02 人物关系（relations）。
 * 02 的正文由 relations.js 生成（AI 抽 + 原文核对），这里只负责「什么时候该有这份文件、
 * 块 id 叫什么」。03 思想脉络要跨书聚类，留到 P6。
 *
 * 三条设计约束，改的时候别绕开：
 *
 * 1. **块 id 来自来源记录，不是序号**（docs/26 §四 规则五）。序号一插入就全体错位，
 *    而块 id 错位的后果是「用户改过的那段被后面的新内容顶掉」。所以 id 一律取
 *    来源记录 id 的哈希前缀：qa 记录一条一个，蒸馏一章一个，标注一条一个。
 *
 * 2. **每个块自带标题**。理由是落盘顺序：vault.upsertBlock 只替换已有块或追加到
 *    文件末尾，它不会「插到某个标题下面」。所以块里必须自带 `## 第三章` 这样的行，
 *    否则新章节会变成一串没有归属的段落。代价是：先同步第三章、后同步第二章时，
 *    第二章会排在文件更靠后（不是书里的顺序）。这一期接受，因为正常读法是顺序读；
 *    真要严格排序得引入「整份重排」，那会吃掉用户手写的行间夹注，得不偿失。
 *
 * 3. **时间戳全部来自记录本身**，不用 now()。同一个块重写多少次字节都一样，
 *    幂等才成立（docs/26 §四 规则二）。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import { fail } from './errors.js'
import { hashInner, parseBlocks, renderBlock } from './blocks.js'
import { assertSafeSubdir, createVault, DEFAULT_SUBDIR, validateVaultPath } from './vault.js'
import { emptyState as emptyRelationsState, toInner as toRelationsInner } from './relations.js'

/** 台账版本。形状变了就加一，读的时候按版本迁移或当空处理。 */
export const NOTES_VERSION = 1

/** 产物类别。数组顺序就是界面上从上到下的顺序。 */
export const NOTE_KINDS = Object.freeze(['map', 'note', 'relations'])

/** 书内某段原文 / 一个答案在笔记里最多占多少字。超了截断，完整内容留在书库里。 */
const QUOTE_MAX = 200
const ANSWER_MAX = 600
const THESIS_MAX = 200
const TERM_MAX = 120
const QUESTION_MAX = 80
const FILENAME_MAX = 40

/** 文件名里不能出现的字符（macOS/Windows 取并集）+ 控制字符。 */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 把书名收拾成能当文件夹名 / 文件名用的样子。
 *
 * 只做「删掉不能用的字符 + 折叠空白 + 截断」，不做音译：中文书名留着中文，
 * 用户才认得出这是哪本书。书名本身为空时退回「未命名书籍」。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  const text = String(raw ?? '')
    .replace(UNSAFE_NAME, ' ')
    .replace(/[《》]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return '未命名书籍'
  return text.length > FILENAME_MAX ? text.slice(0, FILENAME_MAX).trim() : text
}

/**
 * 这本书在 vault 里的文件夹名：《书名》-<hash 前 16 位>。
 *
 * 带 hash 是为了同名书（《活着》两个版本）不互相覆盖；用户改了文件夹名也不影响，
 * 台账里存的是 hash，下次同步按 hash 重新定位（这一期还不做重定位，见 §十）。
 *
 * @param {{ title?: unknown, bookHash?: unknown }} input
 * @returns {string}
 */
export function bookFolderName(input) {
  const name = sanitizeName(input?.title)
  const hash = String(input?.bookHash ?? '').trim().toLowerCase().slice(0, 16)
  return hash === '' ? '《' + name + '》' : '《' + name + '》-' + hash
}

/** 文件名带书名前缀：Obsidian 的 [[链接]] 全库按文件名解析，裸「00 全书地图」会连错。 */
export function fileNameOf(title, suffix) {
  return '《' + sanitizeName(title) + '》 ' + suffix + '.md'
}

/** 四类产物的相对路径（相对 vault 的 subdir）。这一期只用前两个。 */
export function relPathsOf(input) {
  const title = input?.title
  const bookHash = input?.bookHash
  const folder = bookFolderName({ title, bookHash })
  return {
    map: folder + '/' + fileNameOf(title, '00 全书地图'),
    note: folder + '/' + fileNameOf(title, '01 读书笔记'),
    relations: folder + '/' + fileNameOf(title, '02 人物关系'),
    threads: folder + '/' + fileNameOf(title, '03 思想脉络'),
  }
}

/** 短哈希：块 id 里塞不下 64 位，10 位十六进制碰撞概率已经远低于「同一本书里重名」。 */
function shortHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 10)
}

/** 一章在笔记里的块 id。来自 href，不是序号。 */
export function chapterBlockId(href) {
  return 'ch-' + shortHash(href)
}

/** 一条问答在笔记里的块 id。来自 qa 记录 id。 */
export function discussBlockId(qaId) {
  return 'qa-' + shortHash(qaId)
}

/** 一条批注在笔记里的块 id。来自标注 id。 */
export function annotationBlockId(annId) {
  return 'an-' + shortHash(annId)
}

/** 全书地图整份就是一个块：它是整体生成的，没有按条增量的语义。 */
export const MAP_BLOCK_ID = 'map-body'

/**
 * 人物关系整份也是一个块：图是整体重画的。
 *
 * 不拆成「一人一块」的理由：关系图是整体语义，一个人改名会让所有涉及他的边
 * 一起变；拆开就会出现「用户改过的张三那段被保留、李四那段被重写」的割裂图。
 */
export const RELATIONS_BLOCK_ID = 'rel-body'

const S = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return max && text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

const asArray = (value) => (Array.isArray(value) ? value : [])

/** ISO 时刻 → 2026-11-17 22:10（本地时区，来自记录本身，不用 now）。 */
function stampOf(iso) {
  const text = String(iso ?? '').trim()
  if (text === '') return ''
  const at = new Date(text)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/**
 * 把目录拍平成 spineIndex → 章名。
 *
 * 目录树有 children / subitems 两种子字段（EPUB nav 与 NCX 各一种），都认。
 *
 * @param {unknown} toc
 * @returns {Map<number, string>}
 */
export function flattenTocLabels(toc) {
  const labels = new Map()
  const walk = (items, depth) => {
    for (const item of asArray(items)) {
      const index = item?.spineIndex
      const label = S(item?.label, 80)
      if (Number.isInteger(index) && index >= 0 && label !== '' && !labels.has(index)) {
        labels.set(index, label)
      }
      // 深度兜底：坏目录可能自引用，5 层之后再往下就不是人写的目录了。
      if (depth < 5) walk(item?.children ?? item?.subitems, depth + 1)
    }
  }
  walk(toc, 0)
  return labels
}

/**
 * 00 全书地图的正文。
 *
 * @param {{ skeleton?: object|null, labels?: Map<number,string>, spineHrefs?: string[] }} input
 * @returns {string}
 */
export function buildMapInner(input) {
  const lines = []
  const skeleton = input?.skeleton && typeof input.skeleton === 'object' ? input.skeleton : null
  if (skeleton) {
    const oneLine = S(skeleton.oneLine, 120)
    if (oneLine !== '') lines.push('> ' + oneLine, '')
    const thesis = S(skeleton.thesis, 400)
    if (thesis !== '') lines.push('**全书主张**：' + thesis, '')
    const structure = S(skeleton.structure, 600)
    if (structure !== '') lines.push('**怎么展开的**：' + structure, '')
    const audience = S(skeleton.audience, 200)
    if (audience !== '') lines.push('**适合谁读**：' + audience, '')
  } else {
    lines.push('> 还没有生成全书骨架。打开这本书的「读书蒸馏」，先生成骨架，再回来同步一次。', '')
  }

  const labels = input?.labels instanceof Map ? input.labels : new Map()
  const hrefs = asArray(input?.spineHrefs)
  if (hrefs.length > 0) {
    lines.push('## 分几个阶段', '')
    hrefs.forEach((href, index) => {
      const label = labels.get(index) ?? '第 ' + (index + 1) + ' 章'
      lines.push((index + 1) + '. ' + label)
    })
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 一章蒸馏结果的正文（不含块标记）。
 *
 * 引文没能在原文里找到的，逐条标注 —— 模型最容易犯的错是「改一个标点」，
 * 用户看一眼标注就知道该不该引用（沿用 distill.js 的 verified 字段）。
 */
export function buildChapterInner(chapter) {
  const lines = ['## ' + (S(chapter?.label, 80) || '未命名章节'), '']
  if (chapter?.status !== 'done') {
    lines.push('（这一章还没蒸出来。）', '')
    return lines.join('\n').trimEnd()
  }

  const thesis = S(chapter?.thesis, THESIS_MAX)
  if (thesis !== '') lines.push('**这一章在说什么**：' + thesis, '')

  const points = asArray(chapter?.points)
  if (points.length > 0) {
    lines.push('**要点**', '')
    for (const point of points) {
      lines.push('- ' + S(point?.claim, 200))
      const quote = S(point?.quote, QUOTE_MAX)
      if (quote !== '') {
        lines.push('  > ' + quote + (point?.verified === false ? '（未在原文找到，可能被改写）' : ''))
      }
    }
    lines.push('')
  }

  const terms = asArray(chapter?.terms)
  if (terms.length > 0) {
    lines.push('**概念**', '')
    for (const term of terms) lines.push('- **' + S(term?.term, 40) + '**：' + S(term?.meaning, TERM_MAX))
    lines.push('')
  }

  const quotes = asArray(chapter?.quotes)
  if (quotes.length > 0) {
    lines.push('**原句**', '')
    for (const quote of quotes) {
      const text = S(quote?.text, QUOTE_MAX)
      if (text !== '') lines.push('> ' + text + (quote?.verified === false ? '（未在原文找到）' : ''))
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

/**
 * 一条问答的正文（discuss 块）。
 *
 * docs/26 §十二 的硬要求：只写问、答摘要、关联原句，不写 prompt、不写模型名。
 * 写进去就成了流水账，笔记不再像笔记。完整问答留在书库的 qa.jsonl 里。
 */
export function buildDiscussInner(qa, chapterLabel) {
  const at = stampOf(qa?.createdAt ?? qa?.updatedAt)
  const question = S(qa?.question, QUESTION_MAX) || '（这个问题没记下来）'
  const lines = ['### ' + (at === '' ? question : at + ' · ' + question), '']
  lines.push('> **问**：' + S(qa?.question, 300), '')
  const answer = S(qa?.answer, ANSWER_MAX)
  if (answer !== '') lines.push('> **答**：' + answer, '')
  const selected = S(qa?.selectedText, QUOTE_MAX)
  if (selected !== '') {
    lines.push('- 关联原句：「' + selected + '」' + (chapterLabel ? '（' + chapterLabel + '）' : ''))
  }
  return lines.join('\n').trimEnd()
}

/** 一条批注的正文（annotation 块）。 */
export function buildAnnotationInner(annotation) {
  const at = stampOf(annotation?.createdAt ?? annotation?.updatedAt)
  const excerpt = S(annotation?.textExcerpt, QUOTE_MAX)
  const kind = S(annotation?.type, 20)
  const title = at === '' ? '我的批注' : at + ' · 我的批注'
  const lines = ['### ' + title, '']
  if (excerpt !== '') lines.push('> ' + excerpt)
  const note = String(annotation?.note ?? '').trim()
  if (note !== '') lines.push('', note)
  else if (kind === 'highlight') lines.push('', '（只划了线，没写批注。）')
  return lines.join('\n').trimEnd()
}
/**
 * 组装一次同步计划。**纯函数**：不碰文件，只决定写什么。
 *
 * @param {object} input
 * @param {object} input.meta           meta.json
 * @param {object} input.toc            store.toc() 的结果
 * @param {object|null} input.distill   distill.json（没蒸过就是 null）
 * @param {Array} input.annotations     listAnnotations().records
 * @param {Array} input.qa              listQa().records
 * @param {object|null} [input.relations] relations.json（没抽过就是 null）
 * @returns {object}
 */
export function planSync(input) {
  const meta = input?.meta && typeof input.meta === 'object' ? input.meta : {}
  const bookHash = String(meta.bookHash ?? '').trim().toLowerCase()
  const title = S(meta.title, 200) || '未命名书籍'
  const relPaths = relPathsOf({ title, bookHash })
  const banner = '> 这份笔记由 dsh-reading 自动写入。你自己加的段落不会被动；`dsh-reading:block` 标记之间的内容由程序管理——你若改过那一段，我就再也不覆盖它。'

  const spine = asArray(meta.spine).map((entry, index) => ({
    href: String(entry?.href ?? ''),
    index: Number.isInteger(entry?.index) ? entry.index : index,
  }))
  const labels = flattenTocLabels(input?.toc?.toc)
  for (const chapter of spine) chapter.label = labels.get(chapter.index) ?? '第 ' + (chapter.index + 1) + ' 章'
  const labelByHref = new Map(spine.map((chapter) => [chapter.href, chapter.label]))

  // ── 00 全书地图 ──
  const mapFile = {
    kind: 'map',
    relPath: relPaths.map,
    header: '# 《' + sanitizeName(title) + '》 全书地图\n\n' + banner,
    blocks: [{
      id: MAP_BLOCK_ID,
      kind: 'map',
      attrs: { book: shortHash(bookHash) },
      inner: buildMapInner({
        skeleton: input?.distill?.skeleton ?? null,
        labels,
        spineHrefs: spine.map((chapter) => chapter.href),
      }),
    }],
  }

  // ── 01 读书笔记 ──
  const distillByHref = new Map(
    asArray(input?.distill?.chapters).map((chapter) => [String(chapter?.href ?? ''), chapter]),
  )

  const annotationByHref = new Map()
  for (const record of asArray(input?.annotations)) {
    if (!record || record.deleted === true || String(record.id ?? '').trim() === '') continue
    const href = String(record.chapterHref ?? '')
    if (href === '') continue
    if (!annotationByHref.has(href)) annotationByHref.set(href, [])
    annotationByHref.get(href).push(record)
  }

  const qaByHref = new Map()
  let skippedQa = 0
  for (const record of asArray(input?.qa)) {
    if (!record || record.deleted === true) continue
    const href = String(record.chapterHref ?? '')
    // 没有 id 就生不出稳定的块 id，没有 chapterHref 就不知道归到哪一章：
    // 宁可跳过并计数（界面上如实说「有 N 条没写进去」），也不要用序号凑数。
    if (String(record.id ?? '').trim() === '' || href === '') {
      skippedQa += 1
      continue
    }
    if (!qaByHref.has(href)) qaByHref.set(href, [])
    qaByHref.get(href).push(record)
  }

  const noteBlocks = []
  // 按 spine 顺序铺开：一章一个块，后面跟它的批注块与讨论块。
  for (const chapter of spine) {
    if (chapter.href === '') continue
    const distillChapter = distillByHref.get(chapter.href) ?? null
    const annotations = annotationByHref.get(chapter.href) ?? []
    const discussions = qaByHref.get(chapter.href) ?? []
    if (!distillChapter && annotations.length === 0 && discussions.length === 0) continue

    noteBlocks.push({
      id: chapterBlockId(chapter.href),
      kind: 'chapter',
      attrs: { href: chapter.href },
      inner: distillChapter
        ? buildChapterInner({ ...distillChapter, label: distillChapter.label || chapter.label })
        : buildChapterInner({ label: chapter.label, status: 'pending' }),
    })
    for (const annotation of annotations) {
      noteBlocks.push({
        id: annotationBlockId(annotation.id),
        kind: 'annotation',
        attrs: { href: chapter.href },
        inner: buildAnnotationInner(annotation),
      })
    }
    for (const record of discussions) {
      noteBlocks.push({
        id: discussBlockId(record.id),
        kind: 'discuss',
        attrs: { href: chapter.href },
        inner: buildDiscussInner(record, labelByHref.get(chapter.href) ?? ''),
      })
    }
  }

  const noteFile = {
    kind: 'note',
    relPath: relPaths.note,
    header: '# 《' + sanitizeName(title) + '》 读书笔记\n\n' + banner,
    blocks: noteBlocks,
  }

  // ── 02 人物关系 ──
  //
  // 只在「这本书是小说」或「已经动手抽过」时才出现这份文件。非虚构书里抽出来的
  // 人是「作者」「读者」「我们」，写进笔记库纯属噪音；但一旦用户点过生成，
  // 哪怕一条边都没核上，也要让他看得见进度（relations.toInner 会出占位说明）。
  const relationsState = input?.relations && typeof input.relations === 'object' ? input.relations : null
  const relationsStarted = relationsState !== null
    && ((asArray(relationsState.batches).length > 0) || (asArray(relationsState.edges).length > 0))
  const relationsWanted = relationsStarted || relationsState?.verdict?.fiction === true
  const relationsFile = relationsWanted
    ? {
      kind: 'relations',
      relPath: relPaths.relations,
      header: '# 《' + sanitizeName(title) + '》 人物关系\n\n' + banner,
      blocks: [{
        id: RELATIONS_BLOCK_ID,
        kind: 'relations',
        attrs: { book: shortHash(bookHash) },
        inner: toRelationsInner(relationsState ?? emptyRelationsState(meta)),
      }],
    }
    : null

  const files = [mapFile, noteFile]
  if (relationsFile) files.push(relationsFile)

  return {
    bookHash,
    title,
    author: S(meta.author, 80),
    folder: bookFolderName({ title, bookHash }),
    files,
    skippedQa,
  }
}

/** 空台账。没有笔记时 notes.status 返回它，界面不用判 null。 */
export function emptyLedger(bookHash) {
  return {
    version: NOTES_VERSION,
    bookHash: String(bookHash ?? ''),
    vault: '',
    subdir: DEFAULT_SUBDIR,
    updatedAt: '',
    files: {},
    blocks: {},
  }
}

/**
 * 把台账补成完整形状。读到坏文件时宁可当空台账，也不要让整页笔记打不开。
 * @param {unknown} raw
 * @param {string} [bookHash]
 */
export function normalizeLedger(raw, bookHash) {
  const base = emptyLedger(bookHash)
  if (!raw || typeof raw !== 'object') return base
  const files = {}
  for (const kind of NOTE_KINDS) {
    const entry = raw.files?.[kind]
    if (entry && typeof entry === 'object' && typeof entry.relPath === 'string') {
      files[kind] = { relPath: entry.relPath, syncedAt: String(entry.syncedAt ?? '') }
    }
  }
  const blocks = {}
  for (const [id, entry] of Object.entries(raw.blocks ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    blocks[id] = {
      file: String(entry.file ?? ''),
      sha256: String(entry.sha256 ?? ''),
      userEdited: entry.userEdited === true,
      deletedByUser: entry.deletedByUser === true,
    }
  }
  return {
    version: NOTES_VERSION,
    bookHash: String(raw.bookHash ?? bookHash ?? ''),
    vault: String(raw.vault ?? ''),
    subdir: String(raw.subdir ?? DEFAULT_SUBDIR),
    updatedAt: String(raw.updatedAt ?? ''),
    files,
    blocks,
  }
}

/** 把标题与块拼成待写字节（块之间空一行，结尾一个换行）。**只用于预览**与建文件时的初稿。 */
export function composeFile(header, blocks) {
  const parts = []
  const head = String(header ?? '').replace(/\s+$/, '')
  if (head !== '') parts.push(head)
  for (const block of asArray(blocks)) parts.push(renderBlock(block).replace(/\s+$/, ''))
  return parts.join('\n\n') + '\n'
}

const idSetOf = (markdown) => new Set(parseBlocks(markdown).blocks.map((block) => block.id))

/**
 * 执行计划：真正落盘。**唯一会写 vault 的地方**。
 *
 * 每个块独立判定，一处失败不影响其他块：
 *   - 台账记着 deletedByUser → 不复活（用户删过的位置再加回来，他得再删一次）
 *   - 台账记着 userEdited    → 不再覆盖（他改过的字比我们的新内容重要）
 *   - 文件里已经没有这个块、台账却有 → 判定为用户手动删掉，记 deletedByUser
 *   - 现有块的 hash 与台账指纹不一致 → 用户改过，记 userEdited 并跳过
 *
 * @param {{ vault: object, plan: object, ledger?: object, now?: () => Date }} input
 */
export async function applyPlan(input) {
  const vault = input?.vault
  const plan = input?.plan
  if (!vault || typeof vault.upsertBlock !== 'function') {
    throw fail('E_NO_VAULT', '还没告诉我去哪个 Obsidian 库写笔记，请先到设置里选一下。', { status: 400 })
  }
  const ledger = normalizeLedger(input?.ledger, plan?.bookHash)
  const now = typeof input?.now === 'function' ? input.now : () => new Date()
  const results = []
  let written = 0
  let skipped = 0
  let conflicts = 0

  for (const file of asArray(plan?.files)) {
    const kind = String(file?.kind ?? '')
    const relPath = String(file?.relPath ?? '')
    if (relPath === '') continue

    // 文件不存在时先落一个只有标题的骨架：upsertBlock 只会追加块，
    // 不先写标题的话，用户打开看到的第一个字就是 HTML 注释。
    let before = await vault.read(relPath)
    if (before === null) {
      const header = String(file?.header ?? '').replace(/\s+$/, '')
      if (header !== '') before = (await vault.write(relPath, header + '\n')).action === 'created' ? header + '\n' : await vault.read(relPath)
    }
    const beforeIds = before === null ? new Set() : idSetOf(before)

    for (const block of asArray(file?.blocks)) {
      const id = String(block?.id ?? '')
      const known = ledger.blocks[id]
      const entry = { file: kind, relPath, id, action: 'skipped', reason: '' }

      if (known?.deletedByUser === true) {
        entry.reason = 'deleted-by-user'
        skipped += 1
        results.push(entry)
        continue
      }
      if (known?.userEdited === true) {
        entry.reason = 'user-edited'
        conflicts += 1
        results.push(entry)
        continue
      }
      if (known && before !== null && !beforeIds.has(id)) {
        // 文件还在、块没了 —— 用户自己删的。记下来，以后不再往这儿加。
        ledger.blocks[id] = { file: kind, sha256: known.sha256, userEdited: false, deletedByUser: true }
        entry.reason = 'deleted-by-user'
        skipped += 1
        results.push(entry)
        continue
      }

      const outcome = await vault.upsertBlock(relPath, block, {
        expectedHash: known?.sha256 || undefined,
      })
      entry.action = outcome.action
      if (outcome.backup) entry.backup = outcome.backup

      if (outcome.action === 'user-edited') {
        ledger.blocks[id] = { file: kind, sha256: known?.sha256 ?? '', userEdited: true, deletedByUser: false }
        entry.reason = 'user-edited'
        conflicts += 1
        results.push(entry)
        continue
      }
      if (outcome.action === 'malformed') {
        entry.reason = 'malformed'
        skipped += 1
        results.push(entry)
        continue
      }

      ledger.blocks[id] = {
        file: kind,
        sha256: hashInner(block?.inner),
        userEdited: false,
        deletedByUser: false,
      }
      if (outcome.action === 'inserted' || outcome.action === 'replaced') written += 1
      else skipped += 1
      results.push(entry)
    }

    ledger.files[kind] = { relPath, syncedAt: now().toISOString() }
  }

  ledger.version = NOTES_VERSION
  ledger.bookHash = String(plan?.bookHash ?? ledger.bookHash)
  ledger.updatedAt = now().toISOString()
  return { ledger, results, written, skipped, conflicts }
}

/**
 * 生成「这本书的笔记现在长什么样」的摘要，给侧栏用。**只读**，不写盘。
 *
 * @param {{ plan: object, ledger: object, existing: Record<string, string|null> }} input
 */
export function summarize(input) {
  const plan = input?.plan ?? {}
  const ledger = normalizeLedger(input?.ledger, plan.bookHash)
  const existing = input?.existing ?? {}
  const items = []
  for (const file of asArray(plan.files)) {
    const relPath = String(file?.relPath ?? '')
    const markdown = existing[file.kind]
    const onDisk = typeof markdown === 'string' ? new Set(parseBlocks(markdown).blocks.map((b) => b.id)) : null
    const blocks = asArray(file?.blocks)
    const present = onDisk === null ? 0 : blocks.filter((block) => onDisk.has(String(block?.id ?? ''))).length
    items.push({
      kind: file.kind,
      relPath,
      exists: onDisk !== null,
      blocks: blocks.length,
      written: present,
      syncedAt: ledger.files[file.kind]?.syncedAt ?? '',
    })
  }
  const conflicted = Object.values(ledger.blocks).filter((entry) => entry.userEdited === true).length
  return { items, conflicted, skippedQa: Number(plan.skippedQa ?? 0) }
}

/**
 * 从设置里造一个 Vault。库没配好就抛中文错误 —— 界面上要能看懂「先去设置里选库」。
 *
 * @param {object} settings
 * @param {object} [logger]
 * @returns {import('./vault.js').Vault}
 */
export function openVault(settings, logger) {
  const root = validateVaultPath(settings?.obsidianVault)
  const subdir = assertSafeSubdir(settings?.obsidianSubdir)
  return createVault({
    root,
    subdir,
    logger,
    backup: settings?.obsidianBackup !== false,
  })
}

/** 库内文件的绝对路径（给「在 Finder 里显示」用；写盘一律走 vault，不自己拼）。 */
export function absoluteOf(vault, relPath) {
  return path.join(vault.base, String(relPath ?? ''))
}

