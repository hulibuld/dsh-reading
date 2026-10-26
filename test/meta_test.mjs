/**
 * 书籍元数据（0.5.1）的测试：简介 / 分类 / 系列 / 标签 / 珍藏 / 书源设置。
 *
 * 这些字段全部是「用户自己填的、只存在本机」的信息，所以测试关注两件事：
 *   1. 写了能读回来，清空能真的删掉（不是留一个空字符串在 meta.json 里）；
 *   2. 越界输入要**拒绝**而不是截断——截断会让用户以为存进去了，其实少了半截。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LibraryStore,
  mergeSettings,
  normalizeTags,
  MAX_TAG_COUNT,
  DEFAULT_SETTINGS,
} from '../lib/store.js'

/** 64 位十六进制的假 bookHash；目录名取前 16 位。 */
const BOOK_HASH = 'a1'.repeat(32)
const DIR_NAME = BOOK_HASH.slice(0, 16)

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-meta-'))
  const store = new LibraryStore({
    libraryDir: dir,
    deviceId: 'mac-abc123',
    now: () => '2026-10-25T00:00:00.000Z',
    logger: { warn: () => {} },
  })
  await store.init()
  const bookDir = path.join(dir, 'dsh-reading', 'books', DIR_NAME)
  await fs.mkdir(bookDir, { recursive: true })
  await fs.writeFile(
    path.join(bookDir, 'meta.json'),
    `${JSON.stringify({ schema: 'dsh-reading/1', bookHash: BOOK_HASH, title: '原书名', author: '某作者' }, null, 2)}\n`,
  )
  return { store, dir, bookDir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

/** 改完读回来。 */
async function patchAndRead(store, patch) {
  await store.updateMeta(BOOK_HASH, patch)
  return store.readMeta(BOOK_HASH)
}

async function writesAndReadsBack() {
  const { store, cleanup } = await tempStore()
  try {
    const meta = await patchAndRead(store, {
      title: '新书名',
      author: '新作者',
      description: '这是一本书的简介。',
      category: '科幻',
      series: '三体',
      tags: ['硬科幻', ' 硬科幻 ', '已读完', ''],
      favorite: true,
    })
    assert.equal(meta.title, '新书名')
    assert.equal(meta.author, '新作者')
    assert.equal(meta.description, '这是一本书的简介。')
    assert.equal(meta.category, '科幻')
    assert.equal(meta.series, '三体')
    // 去空白、去重、丢空项，顺序保留
    assert.deepEqual(meta.tags, ['硬科幻', '已读完'])
    assert.equal(meta.favorite, true)
  } finally {
    await cleanup()
  }
}

async function clearingReallyDeletes() {
  const { store, bookDir, cleanup } = await tempStore()
  try {
    await patchAndRead(store, {
      description: '简介',
      category: '科幻',
      series: '三体',
      tags: ['a'],
      favorite: true,
    })
    const meta = await patchAndRead(store, {
      description: '  ',
      category: '',
      series: '',
      tags: [],
      favorite: false,
    })
    // 清空 = 字段消失，不是留空串
    assert.equal('description' in meta, false)
    assert.equal('category' in meta, false)
    assert.equal('series' in meta, false)
    assert.equal('tags' in meta, false)
    assert.equal('favorite' in meta, false)
    const raw = JSON.parse(await fs.readFile(path.join(bookDir, 'meta.json'), 'utf8'))
    assert.equal('description' in raw, false)
  } finally {
    await cleanup()
  }
}

async function rejectsOversizedInput() {
  const { store, cleanup } = await tempStore()
  try {
    const tooManyTags = Array.from({ length: MAX_TAG_COUNT + 1 }, (_, i) => `标签${i}`)
    await assert.rejects(() => store.updateMeta(BOOK_HASH, { tags: tooManyTags }), /标签最多/)
    await assert.rejects(() => store.updateMeta(BOOK_HASH, { description: 'x'.repeat(2001) }), /简介太长/)
    await assert.rejects(() => store.updateMeta(BOOK_HASH, { category: 'x'.repeat(41) }), /分类名太长/)
    await assert.rejects(() => store.updateMeta(BOOK_HASH, { series: 'x'.repeat(81) }), /系列名太长/)
    await assert.rejects(() => store.updateMeta(BOOK_HASH, { tags: 'not-an-array' }), /标签最多/)
    await assert.rejects(() => store.updateMeta(BOOK_HASH, {}), /没有要改的内容/)
  } finally {
    await cleanup()
  }
}

async function shelfExposesMetadata() {
  const { store, cleanup } = await tempStore()
  try {
    await store.updateMeta(BOOK_HASH, {
      description: '简介',
      category: '科幻',
      series: '三体',
      tags: ['硬科幻'],
      favorite: true,
    })
    const shelf = await store.listShelf()
    const book = shelf.books.find((item) => item.bookHash === BOOK_HASH || item.bookHash === DIR_NAME)
    assert.ok(book, '书架里应该有这本书')
    assert.equal(book.description, '简介')
    assert.equal(book.category, '科幻')
    assert.equal(book.series, '三体')
    assert.deepEqual(book.tags, ['硬科幻'])
    assert.equal(book.favorite, true)
  } finally {
    await cleanup()
  }
}

function normalizesTags() {
  assert.deepEqual(normalizeTags([' a ', 'a', 'b', '']), ['a', 'b'])
  assert.deepEqual(normalizeTags([]), [])
  assert.equal(normalizeTags(null), null)
  assert.equal(normalizeTags('x'), null)
  assert.equal(normalizeTags(['x'.repeat(25)]), null)
}

async function validatesBookSources() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-src-'))
  try {
    const store = new LibraryStore({ libraryDir: dir, logger: { warn: () => {} } })
    const ok = await store.putSettings({
      bookSources: [{ id: 's1', name: '我的站', searchUrl: 'https://example.com/search?q={query}' }],
    })
    assert.equal(ok.bookSources.length, 1)
    assert.equal((await store.getSettings()).bookSources[0].id, 's1')

    // 缺 {query} 的模板存不进去（否则搜出来的永远是同一个页面）
    await assert.rejects(
      () => store.putSettings({ bookSources: [{ id: 's2', name: 'x', searchUrl: 'https://example.com/search' }] }),
      /设置没能保存/,
    )
    // 非 http(s) 也不行
    await assert.rejects(
      () => store.putSettings({ bookSources: [{ id: 's3', name: 'x', searchUrl: 'file:///tmp/{query}' }] }),
      /设置没能保存/,
    )
    // 超过 8 条
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      name: `源${i}`,
      searchUrl: 'https://example.com/?q={query}',
    }))
    await assert.rejects(() => store.putSettings({ bookSources: many }), /设置没能保存/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function defaultsHaveEmptySources() {
  assert.deepEqual(DEFAULT_SETTINGS.bookSources, [])
  // 老 settings.json 没有这个键时，合并结果要有空数组而不是 undefined
  const merged = mergeSettings(DEFAULT_SETTINGS, { fontSize: 20 })
  assert.deepEqual(merged.bookSources, [])
}

const cases = {
  写入并读回所有新字段: writesAndReadsBack,
  清空字段是真的删掉: clearingReallyDeletes,
  超长与超量输入被拒绝: rejectsOversizedInput,
  书架带出元数据: shelfExposesMetadata,
  标签归一化: normalizesTags,
  书源设置校验: validatesBookSources,
  默认书源为空: defaultsHaveEmptySources,
}

/** 统一入口约定：`export default async function run()`。 */
export default async function run() {
  let passed = 0
  for (const [name, fn] of Object.entries(cases)) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      console.error(`  ✗ ${name}`)
      throw error
    }
  }
  console.log(`meta: ${passed} 项通过`)
}
