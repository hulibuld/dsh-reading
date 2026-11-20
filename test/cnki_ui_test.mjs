#!/usr/bin/env node
/**
 * cnki_ui_test.mjs —— 知网检索界面的纯函数层（0.12.0）。
 *
 * 为什么不测渲染：渲染路径由 client_build_test 的假 React 跑（能挡住白屏），
 * 而这里真正会出错的是**判定与拼装**：
 *   - 书名号 / 空白 / 全角标点没归一 → 「明明书架里有，却说不认识」；
 *   - 题录拼装漏字段 → 复制出来的是一行带 undefined / 空括号的脏文本。
 * 这两类错在界面上都不报错、只是结果不对，用户很难描述成 bug，所以在这里钉死。
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import {
  SEARCH_MODES,
  collectName,
  isInShelf,
  normalizeTitle,
  paperToMarkdown,
  resolveSearchMode,
} from '../client/src/cnki.js'

const FULL = {
  title: '20世纪以来中国的大型滑坡及其发生机制',
  authors: ['黄润秋', '许强'],
  journal: '岩石力学与工程学报',
  issue: '2007年03期',
  citations: 3019,
  downloads: 27027,
  url: 'https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD',
}

const cases = {
  '题名归一化：书名号、空白、标点都不影响比对'() {
    assert.equal(normalizeTitle('《大型滑坡》研究'), '大型滑坡研究')
    assert.equal(normalizeTitle('  大型 滑坡\u00a0研究 '), '大型滑坡研究')
    assert.equal(normalizeTitle('大型滑坡研究：以三峡为例'), '大型滑坡研究以三峡为例')
    assert.equal(normalizeTitle(''), '')
    assert.equal(normalizeTitle(null), '')
  },

  '在不在书架：归一后题名相等即命中'() {
    assert.equal(isInShelf({ title: '大型滑坡研究' }, [{ title: '《大型滑坡》研究' }]), true)
    // 作者不同不强求相等（知网与 PDF 里的作者写法常不一致）
    assert.equal(
      isInShelf({ title: '大型滑坡研究', authors: ['黄润秋'] }, [{ title: '大型滑坡研究', author: '黄润秋 等' }]),
      true,
    )
  },

  '在不在书架：空列表 / 非数组 / 空题名都不命中'() {
    assert.equal(isInShelf({ title: '别的' }, []), false)
    assert.equal(isInShelf({ title: 'x' }, null), false)
    assert.equal(isInShelf({ title: 'x' }, 'not-an-array'), false)
    assert.equal(isInShelf({ title: '' }, [{ title: '' }]), false)
    assert.equal(isInShelf(null, [{ title: 'x' }]), false)
  },

  '题录拼装：完整字段含题目、作者、期刊、被引、下载、网址'() {
    const line = paperToMarkdown(FULL)
    assert.ok(line.includes('《20世纪以来中国的大型滑坡及其发生机制》'), '缺少题名')
    assert.ok(line.includes('黄润秋、许强'), '缺少作者')
    assert.ok(line.includes('岩石力学与工程学报'), '缺少期刊')
    assert.ok(line.includes('2007年03期'), '缺少年期')
    assert.ok(line.includes('被引 3019'), '缺少被引')
    assert.ok(line.includes('下载 27027'), '缺少下载')
    assert.ok(line.includes('https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD'), '缺少网址')
  },

  '题录拼装：缺作者与期刊时不留空括号 / undefined / null'() {
    const line = paperToMarkdown({
      title: '一篇学位论文',
      authors: [],
      journal: '',
      issue: '2026-06-01',
      citations: 0,
      downloads: 0,
      url: '',
    })
    assert.ok(line.includes('2026-06-01'), '年期应该保留')
    assert.ok(!line.includes('undefined'), '出现了 undefined')
    assert.ok(!line.includes('null'), '出现了 null')
    assert.ok(!line.includes('()'), '出现了空括号')
    assert.ok(!line.includes('《》'), '出现了空书名号')
    assert.ok(!line.includes('  '), '出现了连续空格')
    assert.equal(line.split('\n').length, 1, '网址为空时不该有第二行')

    // 全空也不抛：只输出题名与统计
    const bare = paperToMarkdown({})
    assert.ok(bare.includes('未命名文献'))
    assert.ok(!bare.includes('undefined') && !bare.includes('null'))
  },

  // 这条用例是 F1 的教训：四个 option 的 value 在 test/ 下曾经零断言，
  // 于是「下载最多」写成 content-3（全局下载榜）也没被 36 组全绿拦住。
  // 锁两层：value 序列本身，以及每一项背后的 field / order。
  '四种找法：value 序列固定，且只有「相关度」走自由词'() {
    assert.deepEqual(
      SEARCH_MODES.map((mode) => mode.value),
      ['title-4', 'title-2', 'content-1', 'title-3'],
      '四种找法的 value 序列变了——面板下拉与检索字段的对应关系会随之错位',
    )
    assert.deepEqual(
      SEARCH_MODES.map((mode) => [mode.field, mode.order]),
      [['title', 4], ['title', 2], ['content', 1], ['title', 3]],
      'field/order 映射不对',
    )
    // 「下载最多」必须是篇名检索：Order=3 是全局排序，配 content= 会捞回全库下载榜。
    const download = SEARCH_MODES.find((mode) => mode.label === '下载最多')
    assert.ok(download, '找不到「下载最多」这一项')
    assert.equal(download.field, 'title', '「下载最多」必须走篇名检索（Title=）')
    assert.equal(download.order, 3, '「下载最多」必须按下载降序')
    // 每个 value 都要能和 field-order 对上，否则 select 的取值就是死的。
    for (const mode of SEARCH_MODES) {
      assert.equal(mode.value, `${mode.field}-${mode.order}`, `${mode.label} 的 value 与 field/order 不一致`)
    }
  },

  '解析下拉值：认得的值原样拆开，不认得的退回经典文献'() {
    assert.deepEqual(resolveSearchMode('title-3'), { field: 'title', order: 3, value: 'title-3' })
    assert.deepEqual(resolveSearchMode('content-1'), { field: 'content', order: 1, value: 'content-1' })
    for (const bad of ['', null, undefined, 42, 'content-3', 'title-9', 'nonsense']) {
      assert.deepEqual(
        resolveSearchMode(bad),
        { field: 'title', order: 4, value: 'title-4' },
        `${String(bad)} 应该退回经典文献`,
      )
    }
  },

  '题名归一化：全角标点视为半角，全角字母数字不算相同'() {
    assert.equal(normalizeTitle('研究（一）'), normalizeTitle('研究(一)'))
    assert.equal(normalizeTitle('甲，乙'), normalizeTitle('甲,乙'))
    // 文档承诺的是标点统一，不是字母数字统一——这条钉住边界，防以后有人顺手加 NFKC。
    assert.notEqual(normalizeTitle('滑坡ＡＢＣ研究'), normalizeTitle('滑坡abc研究'))
  },

  '文献集默认名：条数直接进标题'() {
    assert.equal(collectName(3), '文献集 · 3 篇')
    assert.equal(collectName(1), '文献集 · 1 篇')
    assert.equal(collectName(0), '文献集 · 1 篇')
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
  console.log(`cnki_ui: ${passed} 项通过`)
}

// 直接 `node test/cnki_ui_test.mjs` 时自己跑；被 test/run.mjs import 时不跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
