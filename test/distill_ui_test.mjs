/**
 * 蒸馏面板的纯函数测试（0.8.0）。
 *
 * 面板本身靠 client_build_test 的假 React 渲染冒烟；这里只钉容易悄悄错的两件事：
 *   · 进度统计不能把「失败」算成「已蒸」；
 *   · 导出文件名不能带路径分隔符（Windows 上会直接写不出来）。
 */

import assert from 'node:assert/strict'
import { chapterStatusText, distillSummary, exportFilename, downloadMarkdown } from '../client/src/distill.js'

async function statusTextDistinguishesStates() {
  assert.equal(chapterStatusText(null).tone, 'idle')
  assert.equal(chapterStatusText({ status: 'failed' }).tone, 'bad')
  assert.equal(chapterStatusText({ status: 'done', methods: [] }).text, '已蒸')
  assert.equal(chapterStatusText({ status: 'done', methods: [{ name: 'a' }] }).text, '已蒸 · 1 个方法')
}

async function summaryCountsOnlyRealProgress() {
  const data = {
    chapters: [
      { href: 'a.xhtml', label: '第一章', index: 0 },
      { href: 'b.xhtml', label: '第二章', index: 1 },
      { href: 'c.xhtml', label: '第三章', index: 2 },
    ],
    state: {
      chapters: [
        { href: 'a.xhtml', status: 'done', methods: [{ name: 'm1' }, { name: 'm2' }] },
        { href: 'b.xhtml', status: 'failed', error: '超时' },
      ],
    },
  }
  const summary = distillSummary(data)
  assert.equal(summary.total, 3)
  assert.equal(summary.done, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.methods, 2)

  // 空数据不能抛：面板首屏就是「还没取到」
  assert.deepEqual(distillSummary(null), { total: 0, done: 0, failed: 0, methods: 0 })
}

async function filenameStripsUnsafeChars() {
  assert.equal(exportFilename('深度工作'), '深度工作-蒸馏笔记.md')
  assert.equal(exportFilename('a/b:c*d?'), 'a b c d -蒸馏笔记.md'.replace(' -', '-'))
  assert.equal(exportFilename(''), '这本书-蒸馏笔记.md')
  const long = exportFilename('长'.repeat(200))
  assert.equal(long.length <= 80, true)
}

async function downloadIsSilentWithoutDocument() {
  // 测试环境没有 document：必须安静返回 false，不能抛
  assert.equal(downloadMarkdown('x.md', 'y'), false)
}

export default async function run() {
  await statusTextDistinguishesStates()
  await summaryCountsOnlyRealProgress()
  await filenameStripsUnsafeChars()
  await downloadIsSilentWithoutDocument()
}
