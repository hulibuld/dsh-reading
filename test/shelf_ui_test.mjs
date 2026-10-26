#!/usr/bin/env node
/**
 * shelf_ui_test.mjs —— 书架筛选的纯函数层。
 *
 * 为什么不测渲染：渲染路径由 client_build_test 的假 React 跑（弱一点但能挡住白屏），
 * 而筛选真正会出错的是**数据判定** —— 「我的珍藏」漏了星标、「按标签」把半截标签算进去、
 * 空值被当成一个可选值混进下拉。这三类错在界面上都表现为「明明有书却筛不出来」，
 * 用户很难描述成 bug，所以在这里钉死。
 */

import assert from 'node:assert/strict'

import { facetValues, filterBooks } from '../client/src/shelf.js'

const BOOKS = [
  { bookHash: 'a', title: '甲', author: '张三', series: '银河', category: '科幻', tags: ['太空', '硬科幻'], favorite: true },
  { bookHash: 'b', title: '乙', author: '张三', series: '', category: '科幻', tags: ['太空'], favorite: false },
  { bookHash: 'c', title: '丙', author: '李四', series: '银河', category: '', tags: [], favorite: true },
  { bookHash: 'd', title: '丁', author: '', series: '', category: '', tags: [], favorite: false },
]

const ids = (list) => list.map((book) => book.bookHash)

const cases = {
  '全部：一行不筛，顺序不变'() {
    assert.deepEqual(ids(filterBooks(BOOKS, 'all', '')), ['a', 'b', 'c', 'd'])
  },

  '我的珍藏：只看 favorite === true'() {
    assert.deepEqual(ids(filterBooks(BOOKS, 'favorite', '')), ['a', 'c'])
  },

  '按系列：值必须完全相等'() {
    assert.deepEqual(ids(filterBooks(BOOKS, 'series', '银河')), ['a', 'c'])
    assert.deepEqual(ids(filterBooks(BOOKS, 'series', '银')), [])
  },

  '按作者：空作者不会被空串筛进来'() {
    assert.deepEqual(ids(filterBooks(BOOKS, 'author', '张三')), ['a', 'b'])
    // 空串 = 下拉里的「全部」，表示这个维度还没选值 → 不筛
    assert.deepEqual(ids(filterBooks(BOOKS, 'author', '')), ['a', 'b', 'c', 'd'])
  },

  '按标签：一个标签可命中多本，未命中的不出现'() {
    assert.deepEqual(ids(filterBooks(BOOKS, 'tag', '太空')), ['a', 'b'])
    assert.deepEqual(ids(filterBooks(BOOKS, 'tag', '硬科幻')), ['a'])
    assert.deepEqual(ids(filterBooks(BOOKS, 'tag', '不存在')), [])
  },

  '按分类：能筛出分类命中项'() {
    assert.deepEqual(ids(filterBooks(BOOKS, 'category', '科幻')), ['a', 'b'])
  },

  '容错：books 不是数组 / 字段缺失时不炸'() {
    assert.deepEqual(filterBooks(null, 'favorite', ''), [])
    assert.deepEqual(filterBooks(undefined, 'tag', 'x'), [])
    assert.deepEqual(ids(filterBooks([{ bookHash: 'x' }], 'favorite', '')), [])
    assert.deepEqual(ids(filterBooks([{ bookHash: 'y' }], 'tag', 'x')), [])
  },

  '可选值：去重、排序、不含空值'() {
    assert.deepEqual(facetValues(BOOKS, 'series'), ['银河'])
    assert.deepEqual(facetValues(BOOKS, 'author'), ['李四', '张三']) // 按拼音：li < zhang
    assert.deepEqual(facetValues(BOOKS, 'category'), ['科幻'])
    assert.deepEqual(facetValues(BOOKS, 'tag'), ['太空', '硬科幻']) // 按拼音：tai < ying
    assert.deepEqual(facetValues(BOOKS, 'favorite'), [])
    assert.deepEqual(facetValues(null, 'series'), [])
  },
}

export default async function run() {
  let passed = 0
  for (const [name, fn] of Object.entries(cases)) {
    try {
      fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      console.error(`  ✗ ${name}`)
      throw error
    }
  }
  console.log(`shelf_ui: ${passed} 项通过`)
}
