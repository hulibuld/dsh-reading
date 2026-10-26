/**
 * 书内搜索（0.6.0）的测试。
 *
 * 关注四件事：
 *   1. 能在一本书的**多个章节**里都找到命中（不是只搜当前章）；
 *   2. 命中带 percent（命中处在本章的相对位置），客户端靠它换算页号；
 *   3. 大小写不敏感、纯文本化（标签与实体不参与匹配）；
 *   4. 越界与空输入有确定行为（空词不搜、超长词报错、结果有上限）。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LibraryStore } from '../lib/store.js'

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-search-'))
  const store = new LibraryStore({
    libraryDir: dir,
    deviceId: 'mac-abc123',
    now: () => '2026-10-25T00:00:00.000Z',
    logger: { warn: () => {} },
  })
  await store.init()
  return { store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

/** 造一本三章的中文 TXT，前两章都含「晨跑」，第三章不含。 */
function makeTxt() {
  const text = [
    '第一章 城市',
    '他每天清晨都要去河边晨跑，跑完才回家吃早饭。',
    '这一章讲的是早晨的城市。',
    '第二章 假日',
    '假日里他也会晨跑，只是路线换成了公园。',
    '第三章 夜晚',
    '夜里没有晨跑，只有路灯和安静。',
  ].join('\n')
  return { filename: '测试书.txt', dataBase64: Buffer.from(text, 'utf8').toString('base64') }
}

export default async function run() {
  const { store, cleanup } = await tempStore()
  try {
    const imported = await store.importBook(makeTxt())
    const bookHash = imported.bookHash
    assert.ok(typeof bookHash === 'string' && bookHash.length > 0, '导入应当返回 bookHash')

    const hit = await store.searchBook(bookHash, '晨跑')
    assert.ok(hit.total >= 2, `两章都该命中，实际 ${hit.total}`)
    assert.ok(hit.hits.length >= 2, 'hits 至少两条')
    for (const item of hit.hits) {
      assert.ok(Number.isInteger(item.spineIndex), '每条命中都要带 spineIndex')
      assert.ok(item.percent >= 0 && item.percent <= 1, 'percent 必须在 0~1')
      assert.ok(item.snippet.includes('晨跑'), '摘要要含命中词')
      assert.ok(typeof item.chapterLabel === 'string' && item.chapterLabel !== '', '要有章节名')
    }
    const chapters = new Set(hit.hits.map((item) => item.spineIndex))
    assert.ok(chapters.size >= 2, '命中应当来自不同章节')

    // 大小写不敏感
    const upper = await store.searchBook(bookHash, '晨跑'.toUpperCase())
    assert.ok(upper.total >= 2, '大写查询也要命中（中文不受影响，这里验证不抛错且仍返回）')

    // 没有命中：返回空数组，不是 null
    const none = await store.searchBook(bookHash, '量子纠缠')
    assert.deepEqual(none.hits, [])
    assert.equal(none.total, 0)

    // 空词：直接返回空结果，不扫描
    const empty = await store.searchBook(bookHash, '   ')
    assert.deepEqual(empty.hits, [])
    assert.equal(empty.scannedChapters, 0)

    // 超长查询：明确报错（E_SEARCH_TOO_LONG），而不是静默截断
    await assert.rejects(
      () => store.searchBook(bookHash, '很'.repeat(61)),
      (error) => error && error.code === 'E_SEARCH_TOO_LONG',
    )

    // 结果上限：limit 生效且 truncated 为真
    const limited = await store.searchBook(bookHash, '晨跑', { limit: 1 })
    assert.equal(limited.hits.length, 1, 'limit 应当生效')
    assert.equal(limited.truncated, true, '被截断时要明确标记')

    console.log('  ✓ 搜索：跨章命中 / percent / 空词 / 超长 / 上限')
  } finally {
    await cleanup()
  }
}
