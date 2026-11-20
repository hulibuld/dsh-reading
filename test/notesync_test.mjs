#!/usr/bin/env node
/**
 * Obsidian 产物同步（lib/notesync.js）的测试。
 *
 * 这一层做的是「把书库里的蒸馏/标注/问答，装配成两份 Markdown 写进用户自己的库」。
 * 所以用例的重心不是「写出来好看」，而是这几条硬规矩：
 *   同一份数据同步两次，字节不许变（幂等）；
 *   块外用户手写的段落不许丢；
 *   用户改过的块不许覆盖，删掉的块不许复活；
 *   没有锚点信息的记录宁可跳过并计数，也不许拿序号凑块 id。
 *
 * 全程临时目录当 vault，不碰真库、不联网、不起 Obsidian。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listBlockIds, parseBlocks } from '../lib/blocks.js'
import { createVault, DEFAULT_SUBDIR } from '../lib/vault.js'
import {
  applyPlan,
  buildDiscussInner,
  chapterBlockId,
  composeFile,
  discussBlockId,
  emptyLedger,
  MAP_BLOCK_ID,
  normalizeLedger,
  NOTES_VERSION,
  planSync,
  relPathsOf,
  sanitizeName,
  summarize,
} from '../lib/notesync.js'

const HASH = '08773db717b9d75d2c1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c'
const TITLE = '如何阅读一本书'

/** 造一本最小的「书」：三章，无真目录（真实书库里的老书就是这样）。 */
function makeMeta(overrides = {}) {
  return {
    bookHash: HASH,
    title: TITLE,
    author: '轻阅读编写组',
    spine: [
      { href: 'text/ch001.xhtml', idref: 'c1', index: 0 },
      { href: 'text/ch002.xhtml', idref: 'c2', index: 1 },
      { href: 'text/ch003.xhtml', idref: 'c3', index: 2 },
    ],
    ...overrides,
  }
}

function makePlan(overrides = {}) {
  return planSync({
    meta: makeMeta(),
    toc: { toc: [], source: 'none' },
    distill: null,
    annotations: [],
    qa: [],
    ...overrides,
  });
}

/** 一条问答记录（形状取自 store.normalizeQaRecord）。 */
function makeQa(id, href, question) {
  return {
    id,
    question,
    answer: '这是模型给的一段答案，用来验证摘要会被截断与折叠空白。',
    chapterHref: href,
    chapterLabel: '',
    selectedText: '阅读的四个层次',
    mode: 'classic',
    model: 'gpt-4o-mini',
    createdAt: '2026-11-17T06:10:00.000Z',
  };
}

/** 把某个块整段从文本里剪掉，模拟用户在 Obsidian 里手动删除。 */
function stripBlock(markdown, id) {
  const found = parseBlocks(markdown).blocks.find((block) => block.id === id)
  if (!found) return markdown
  return markdown.slice(0, found.start) + markdown.slice(found.end)
}

/** 临时 vault：跑完删掉，固定时钟（台账里的 updatedAt 才好断言）。 */
async function withVault(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-notesync-'))
  try {
    const vault = createVault({
      root,
      subdir: DEFAULT_SUBDIR,
      backup: true,
      now: () => new Date('2026-11-17T14:10:00.000Z'),
      logger: { warn() {} },
    })
    return await fn(vault, root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

const fixedNow = () => new Date('2026-11-17T14:10:00.000Z')

/** 两份产物的路径必须与 docs/26 §二 一字不差：《书名》-hash16/《书名》 00 全书地图.md */
async function namesPathsLikeSpec() {
  const plan = makePlan()
  assert.equal(plan.files.length, 2, '这一期只有地图与笔记两份')
  assert.deepEqual(plan.files.map((file) => file.kind), ['map', 'note'], '顺序即界面顺序：地图在前')
  const paths = relPathsOf({ title: TITLE, bookHash: HASH })
  assert.equal(paths.map, '《如何阅读一本书》-08773db717b9d75d/《如何阅读一本书》 00 全书地图.md')
  assert.equal(paths.note, '《如何阅读一本书》-08773db717b9d75d/《如何阅读一本书》 01 读书笔记.md')
  assert.equal(plan.files[0].relPath, paths.map)
  assert.equal(plan.files[1].relPath, paths.note)
  // 文件名里的非法字符要被清掉，否则 macOS 上根本建不出文件。
  assert.equal(sanitizeName('a/b:c*d?'), 'a b c d')
  assert.equal(sanitizeName('《书名》'), '书名')
  assert.equal(sanitizeName('   '), '未命名书籍')
}

/** 空书上同步两次：两次都成功，第二次一个字节都不写。 */
async function syncsTwiceIdempotently() {
  await withVault(async (vault) => {
    // 给一条问答，笔记文件才不是空的（空笔记只落标题、没有块）。
    const plan = makePlan({ qa: [makeQa('qa-sync01', 'text/ch001.xhtml', '同步幂等用的问题')] })
    const first = await applyPlan({ vault, plan, ledger: emptyLedger(HASH), now: fixedNow })
    assert.equal(first.written, 3, '地图 1 个块 + 笔记 2 个块（章节 + 讨论）')
    const mapPath = plan.files[0].relPath
    const notePath = plan.files[1].relPath
    const mapBytes = await vault.read(mapPath)
    const noteBytes = await vault.read(notePath)
    assert.ok(mapBytes.startsWith('# 《如何阅读一本书》 全书地图'), '文件第一行得是标题，不能是 HTML 注释')
    assert.ok(noteBytes.startsWith('# 《如何阅读一本书》 读书笔记'))
    assert.deepEqual(listBlockIds(mapBytes), [MAP_BLOCK_ID])

    const second = await applyPlan({ vault, plan, ledger: first.ledger, now: fixedNow })
    assert.equal(second.written, 0, '第二次不该再写任何块')
    assert.equal(await vault.read(mapPath), mapBytes, '地图字节必须一致')
    assert.equal(await vault.read(notePath), noteBytes, '笔记字节必须一致')
    assert.equal(second.ledger.version, NOTES_VERSION)
  })
}

/** 块外用户自己写的段落，同步多少次都得原样留着。 */
async function preservesUserText() {
  await withVault(async (vault) => {
    const plan = makePlan()
    const first = await applyPlan({ vault, plan, ledger: emptyLedger(HASH), now: fixedNow })
    const notePath = plan.files[1].relPath
    const mine = '\n## 我自己的感想\n\n这段话是用户手写的，程序不许动它。\n'
    await vault.write(notePath, (await vault.read(notePath)) + mine)

    const plan2 = makePlan({ qa: [makeQa('qa-abc123', 'text/ch002.xhtml', '检视阅读和分析阅读是并列的吗？')] })
    await applyPlan({ vault, plan: plan2, ledger: first.ledger, now: fixedNow })
    const after = await vault.read(notePath)
    assert.ok(after.includes('这段话是用户手写的，程序不许动它。'), '用户手写段必须还在')
    assert.ok(after.includes('检视阅读和分析阅读是并列的吗？'), '新问答要写进去')
  })
}

/** 用户改过块内的字 → 之后永远不再覆盖，并在台账里标 userEdited。 */
async function refusesUserEditedBlock() {
  await withVault(async (vault) => {
    const qa = makeQa('qa-abc123', 'text/ch002.xhtml', '原问题')
    const plan = makePlan({ qa: [qa] })
    const first = await applyPlan({ vault, plan, ledger: emptyLedger(HASH), now: fixedNow })
    const notePath = plan.files[1].relPath
    const blockId = discussBlockId('qa-abc123')

    const bytes = await vault.read(notePath)
    assert.ok(bytes.includes(blockId), '讨论块该在文件里')
    await vault.write(notePath, bytes.replace('这是模型给的一段答案', '我把它改写成了自己的话'))

    const plan2 = makePlan({ qa: [{ ...qa, question: '改了的问题' }] })
    const second = await applyPlan({ vault, plan: plan2, ledger: first.ledger, now: fixedNow })
    assert.equal(second.conflicts, 1, '必须记一次冲突')
    assert.equal(second.written, 0, '冲突时一个字都不许写')
    assert.equal(second.ledger.blocks[blockId].userEdited, true)
    const after = await vault.read(notePath)
    assert.ok(after.includes('我把它改写成了自己的话'), '用户改过的字必须留着')
    assert.ok(!after.includes('改了的问题'), '不该覆盖成新版')

    const third = await applyPlan({ vault, plan: plan2, ledger: second.ledger, now: fixedNow })
    assert.equal(third.written, 0)
    assert.equal(third.conflicts, 1, '台账记着 userEdited，直接跳过')
  })
}

/** 用户把块整段删了 → 记 deletedByUser，以后不再复活。 */
async function neverResurrectsDeletedBlock() {
  await withVault(async (vault) => {
    const qa = makeQa('qa-del001', 'text/ch002.xhtml', '会被删掉的问题')
    const plan = makePlan({ qa: [qa] })
    const first = await applyPlan({ vault, plan, ledger: emptyLedger(HASH), now: fixedNow })
    const notePath = plan.files[1].relPath
    const blockId = discussBlockId('qa-del001')

    const stripped = stripBlock(await vault.read(notePath), blockId)
    assert.ok(!stripped.includes(blockId), '块要被真删掉')
    await vault.write(notePath, stripped)

    const second = await applyPlan({ vault, plan, ledger: first.ledger, now: fixedNow })
    assert.equal(second.ledger.blocks[blockId].deletedByUser, true, '要记成用户删的')
    assert.ok(!(await vault.read(notePath)).includes(blockId), '第一次发现删除时也不许补回去')

    const third = await applyPlan({ vault, plan, ledger: second.ledger, now: fixedNow })
    assert.ok(!(await vault.read(notePath)).includes(blockId), '以后永远不许复活')
  })
}

/** 没有 id / 没有 chapterHref 的问答：跳过并计数，不许拿序号凑块 id。 */
async function skipsRecordsWithoutAnchor() {
  const plan = makePlan({
    qa: [
      makeQa('qa-ok', 'text/ch001.xhtml', '有锚点的问题'),
      makeQa('', 'text/ch001.xhtml', '没有 id 的问题'),
      makeQa('qa-nohref', '', '没有章节的问题'),
    ],
  })
  assert.equal(plan.skippedQa, 2, '两条没有锚点信息的要被跳过并计数')
  const noteBlocks = plan.files[1].blocks
  assert.deepEqual(noteBlocks.map((block) => block.id), [chapterBlockId('text/ch001.xhtml'), discussBlockId('qa-ok')])
}

/** 块按 spine 顺序铺开，与蒸馏结果进来的顺序无关。 */
async function ordersBlocksBySpine() {
  const distill = {
    skeleton: { oneLine: '一句话', thesis: '全书主张', structure: '怎么展开', audience: '适合谁' },
    chapters: [
      { href: 'text/ch003.xhtml', label: '第三章', status: 'done', thesis: '三', points: [], terms: [], quotes: [] },
      { href: 'text/ch001.xhtml', label: '第一章', status: 'done', thesis: '一', points: [], terms: [], quotes: [] },
    ],
  }
  const plan = makePlan({ distill })
  assert.deepEqual(
    plan.files[1].blocks.map((block) => block.id),
    [chapterBlockId('text/ch001.xhtml'), chapterBlockId('text/ch003.xhtml')],
    'ch001 在 ch003 前面',
  )
  assert.ok(!plan.files[1].blocks.some((block) => block.id === chapterBlockId('text/ch002.xhtml')))
}

/** 讨论块只写问、答摘要、关联原句：不写 prompt、不写模型名（docs/26 §十二）。 */
async function discussBlockHasNoPromptOrModel() {
  const inner = buildDiscussInner(makeQa('qa-x', 'text/ch001.xhtml', '一个问题'), '第一章')
  assert.ok(inner.includes('一个问题'))
  assert.ok(inner.includes('关联原句：「阅读的四个层次」'))
  assert.ok(!inner.includes('gpt-4o-mini'), '不许写模型名')
  assert.ok(!inner.includes('classic'), '不许写模式名')
  assert.ok(inner.includes('（第一章）'), '关联原句要带章节名')
}

/** 台账读到坏数据不许抛：当空台账，界面才打得开。 */
async function toleratesGarbageLedger() {
  const base = normalizeLedger(null, HASH)
  assert.equal(base.version, NOTES_VERSION)
  assert.deepEqual(base.files, {})
  assert.deepEqual(base.blocks, {})
  const mixed = normalizeLedger({
    files: { map: { relPath: 'a.md', syncedAt: 'x' }, ghost: { relPath: 'b.md' } },
    blocks: { keep: { file: 'note', sha256: 'h', userEdited: true }, drop: 42 },
  }, HASH)
  assert.deepEqual(Object.keys(mixed.files), ['map'], '不认识的文件类别丢掉')
  assert.deepEqual(Object.keys(mixed.blocks), ['keep'], '非对象条目丢掉')
  assert.equal(mixed.blocks.keep.userEdited, true)
  assert.equal(mixed.blocks.keep.deletedByUser, false)
}

/** 摘要：告诉侧栏「两份文件在不在、各写了几个块、上次什么时候同步」。 */
async function summarizesState() {
  await withVault(async (vault) => {
    const plan = makePlan({ qa: [makeQa('qa-1', 'text/ch001.xhtml', '问题一')] })
    const before = summarize({ plan, ledger: emptyLedger(HASH), existing: {} })
    assert.equal(before.items.length, 2)
    assert.equal(before.items[0].exists, false, '还没同步过')
    assert.equal(before.items[1].blocks, 2, '一个章节块 + 一个讨论块')
    assert.equal(before.items[1].written, 0)

    const first = await applyPlan({ vault, plan, ledger: emptyLedger(HASH), now: fixedNow })
    const existing = {
      map: await vault.read(plan.files[0].relPath),
      note: await vault.read(plan.files[1].relPath),
    }
    const after = summarize({ plan, ledger: first.ledger, existing })
    assert.equal(after.items[0].exists, true)
    assert.equal(after.items[0].written, 1)
    assert.equal(after.items[1].written, 2)
    assert.equal(after.items[1].syncedAt, '2026-11-17T14:10:00.000Z')
    assert.equal(after.conflicted, 0)
  })
}

/** 只预览不落盘：composeFile 的结果与真正写下去的第一版一致。 */
async function previewMatchesWhatGetsWritten() {
  await withVault(async (vault) => {
    const plan = makePlan()
    await applyPlan({ vault, plan, ledger: emptyLedger(HASH), now: fixedNow })
    for (const file of plan.files) {
      const preview = composeFile(file.header, file.blocks)
      assert.equal(preview, await vault.read(file.relPath), file.kind + ' 预览必须与落盘一致')
      assert.equal(parseBlocks(preview).problems.length, 0, '自己写的块不许有解析问题')
    }
  })
}

export default async function run() {
  await namesPathsLikeSpec()
  await syncsTwiceIdempotently()
  await preservesUserText()
  await refusesUserEditedBlock()
  await neverResurrectsDeletedBlock()
  await skipsRecordsWithoutAnchor()
  await ordersBlocksBySpine()
  await discussBlockHasNoPromptOrModel()
  await toleratesGarbageLedger()
  await summarizesState()
  await previewMatchesWhatGetsWritten()
  console.log('notesync: 11 组用例通过')
}
