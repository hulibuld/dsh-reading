#!/usr/bin/env node
/**
 * pruneLegadoSources 的守卫（0.13.1）。
 *
 * 导入书源之后会顺手清一次：删掉用不了的、删掉用户停用的。这条路最容易出两种事故：
 *
 *   1. 把「正在被某本书引用」的源删了 —— 那本书的目录和正文就再也抓不回来了，
 *      而用户什么都没做。所以引用保护必须优先于「用不了」和「停用」两条判据；
 *   2. 在用户没操作的时候动手 —— 清理只挂在导入之后，不挂在读、不挂在定时任务里。
 *
 * 这组测试钉四件事：
 *   1. 用不了的（没搜索地址 / 没有列表规则）被删；
 *   2. 停用的被删；
 *   3. 被任何一本书 meta.sourceUrl 引用的，用不了也不删、停用也不删；
 *   4. 没东西可删时**不写文件**（省掉一次没意义的重写，也避免把手写的 JSON 格式化掉）。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LibraryStore } from '../lib/store.js'

/** 造一个够用的书源对象（normalizeSource 的产物形状）。 */
function source(url, extra = {}) {
  return {
    url,
    name: extra.name ?? url,
    group: '',
    type: 'text',
    weight: 0,
    enabled: extra.enabled !== false,
    header: {},
    searchUrl: extra.searchUrl ?? '/s?q={{key}}',
    ruleSearch: extra.ruleSearch ?? { bookList: '//div[@class="book"]', name: '//a/text()' },
    ruleToc: {},
    ruleContent: {},
    ruleBookInfo: {},
  }
}

/** 给书库放一本「引用了某书源」的书（只写 prune 会读的那一个字段）。 */
async function seedBookWithSource(store, dirName, sourceUrl) {
  const dir = store.paths.bookDir(dirName)
  await fs.mkdir(path.join(dir, 'history'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ bookHash: dirName, title: '网络书', sourceUrl }),
  )
}

/** 读回当前落盘的书源列表（用来断言「真的写进去了 / 真的没写」）。 */
async function readSources(store) {
  const file = store.legadoSourcesFile()
  const raw = await fs.readFile(file, 'utf8')
  return JSON.parse(raw).sources
}

async function fileMtime(file) {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return null
  }
}

export default async function run() {
  let passed = 0
  const dirs = []

  async function newStore() {
    const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-prune-'))
    dirs.push(libraryDir)
    const store = new LibraryStore({
      libraryDir,
      deviceId: 'mac-prune',
      logger: { warn: () => {} },
    })
    await store.init()
    return store
  }

  const cases = {
    async '空的源列表：什么都不做，返回零'() {
      const store = await newStore()
      const out = await store.pruneLegadoSources()
      assert.deepEqual(out, { removed: [], kept: 0, protected: 0 })
      // 连文件都不该被创建出来。
      assert.equal(await fileMtime(store.legadoSourcesFile()), null)
    },

    async '用不了的源被删：缺搜索地址、缺列表规则'() {
      const store = await newStore()
      await store.saveLegadoSources([
        source('https://ok.test'),
        source('https://no-search.test', { searchUrl: '' }),
        source('https://no-rule.test', { ruleSearch: { name: '//a/text()' } }),
      ])
      const out = await store.pruneLegadoSources()
      assert.equal(out.removed.length, 2)
      assert.deepEqual(
        out.removed.map((item) => item.url).sort(),
        ['https://no-rule.test', 'https://no-search.test'],
      )
      assert.ok(out.removed.every((item) => item.reason === 'unusable'))
      assert.equal(out.kept, 1)
      assert.deepEqual((await readSources(store)).map((item) => item.url), ['https://ok.test'])
    },

    async '停用的源被删，即使是能用的'() {
      const store = await newStore()
      await store.saveLegadoSources([
        source('https://on.test'),
        source('https://off.test', { enabled: false }),
      ])
      const out = await store.pruneLegadoSources()
      assert.deepEqual(out.removed.map((item) => item.url), ['https://off.test'])
      assert.equal(out.removed[0].reason, 'disabled')
      assert.deepEqual((await readSources(store)).map((item) => item.url), ['https://on.test'])
    },

    async '被书引用着的源一条都不删——哪怕用不了、哪怕停用了'() {
      const store = await newStore()
      await store.saveLegadoSources([
        source('https://used-broken.test', { searchUrl: '' }),
        source('https://used-off.test', { enabled: false }),
        source('https://free.test', { searchUrl: '' }),
      ])
      await seedBookWithSource(store, '0123456789abcdef', 'https://used-broken.test')
      await seedBookWithSource(store, 'fedcba9876543210', 'https://used-off.test')

      const out = await store.pruneLegadoSources()
      assert.deepEqual(out.removed.map((item) => item.url), ['https://free.test'])
      assert.equal(out.kept, 2)
      assert.equal(out.protected, 2)
      const left = (await readSources(store)).map((item) => item.url).sort()
      assert.deepEqual(left, ['https://used-broken.test', 'https://used-off.test'])
    },

    async '没有被引用、又完全正常的源原样留着'() {
      const store = await newStore()
      await store.saveLegadoSources([source('https://a.test'), source('https://b.test')])
      const out = await store.pruneLegadoSources()
      assert.deepEqual(out.removed, [])
      assert.equal(out.kept, 2)
      assert.equal(out.protected, 0)
    },

    async '没东西可删时不动文件（不重写、不重排格式）'() {
      const store = await newStore()
      const file = store.legadoSourcesFile()
      // 手写一份「故意不是标准缩进」的 JSON：正常清理不该把它重排。
      await fs.mkdir(store.paths.root, { recursive: true })
      await fs.writeFile(file, JSON.stringify({ version: 1, sources: [source('https://keep.test')] }))
      const before = await fileMtime(file)
      await store.pruneLegadoSources()
      assert.equal(await fileMtime(file), before, '没有删除时就该保持原文件不动')
    },

    async '多次清理是幂等的'() {
      const store = await newStore()
      await store.saveLegadoSources([source('https://ok.test'), source('https://bad.test', { searchUrl: '' })])
      const first = await store.pruneLegadoSources()
      assert.equal(first.removed.length, 1)
      const second = await store.pruneLegadoSources()
      assert.deepEqual(second.removed, [])
      assert.equal(second.kept, 1)
    },

    async 'meta.json 坏掉不影响清理（读不出引用就当没引用）'() {
      const store = await newStore()
      const dir = store.paths.bookDir('1111111111111111')
      await fs.mkdir(path.join(dir, 'history'), { recursive: true })
      await fs.writeFile(path.join(dir, 'meta.json'), '{坏掉的 JSON')
      await store.saveLegadoSources([source('https://bad.test', { searchUrl: '' })])
      const out = await store.pruneLegadoSources()
      // 坏 meta 读出来是 null，没有 sourceUrl 可保护，于是这条照常删掉。
      assert.deepEqual(out.removed.map((item) => item.url), ['https://bad.test'])
      assert.equal(out.protected, 0)
    },
  }

  try {
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
    console.log(`legado prune: ${passed} 项通过`)
  } finally {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
  }
}
