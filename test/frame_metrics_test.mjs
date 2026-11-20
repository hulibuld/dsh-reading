#!/usr/bin/env node
/**
 * 阅读器几何量测试（0.10.3）。
 *
 * 起因：用户报「最底下那行字还是会被遮住」。根因是列高取了外层视口的高度——
 * 那个盒子带上下各 40px 内边距，而 iframe 的 height:100% 只等于内容盒高度，
 * 于是列高比实际可见高度多出 80px，每页底部的一两行被裁在视口外。
 *
 * 这组测试钉四件事：
 *   1. 列高必须等于 iframe 的可见高度，不是外层视口高度；
 *   2. iframe 量不到时，退回外层要扣掉内边距；
 *   3. 都量不到时才用上一次的好值；
 *   4. 尺寸为 0 时不返回负数。
 */

import assert from 'node:assert/strict'
import { frameMetrics } from '../client/src/reader-metrics.js'

/** 造一个「像 DOM 元素」的对象：client 尺寸 + border-box + 内边距。 */
function el({ width = 0, height = 0, padding = 0 } = {}) {
  return {
    clientWidth: width,
    clientHeight: height,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          paddingLeft: `${padding}px`,
          paddingRight: `${padding}px`,
          paddingTop: `${padding}px`,
          paddingBottom: `${padding}px`,
        }),
      },
    },
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0, right: width, bottom: height }),
  }
}

export default async function run() {
  // 1) iframe 有尺寸：外层更高也不能用
  {
    const result = frameMetrics(el({ width: 820, height: 520 }), el({ width: 820, height: 600, padding: 40 }))
    assert.equal(result.width, 820)
    assert.equal(result.height, 520, '列高必须是 iframe 的高度，不是外层带内边距的高度')
    assert.equal(result.fromFrame, true)
    console.log('  ok   frameMetrics：优先用 iframe 自身尺寸')
  }

  // 2) iframe 量不到：退回外层，扣掉上下/左右内边距
  {
    const result = frameMetrics(el({ width: 0, height: 0 }), el({ width: 820, height: 600, padding: 40 }))
    assert.equal(result.width, 740, '外层宽度要扣掉左右内边距')
    assert.equal(result.height, 520, '外层高度要扣掉上下内边距（40+40）')
    assert.equal(result.fromFrame, false)
    console.log('  ok   frameMetrics：iframe 量不到时退回外层并扣内边距')
  }

  // 3) 都量不到：用上一次的好值，避免退化成 120px 窄条
  {
    const result = frameMetrics(null, null, { width: 760, height: 480 })
    assert.equal(result.width, 760)
    assert.equal(result.height, 480)
    console.log('  ok   frameMetrics：量不到时兜上一次的好值')
  }

  // 4) 什么都没有：返回 0，不给负数
  {
    const result = frameMetrics(undefined, undefined)
    assert.equal(result.width, 0)
    assert.equal(result.height, 0)
    console.log('  ok   frameMetrics：空输入安全返回 0')
  }
}
