#!/usr/bin/env node
/**
 * layout_css_test.mjs —— 分页几何的「防复发」检查。
 *
 * 为什么用读源码 + 正则，而不是渲染出真页面来量：渲染要真浏览器（node 里没有），
 * 而这条 bug 的形状极其固定 —— **给 body 设 overflow:hidden，多栏的第 2 页起会被
 * 容器自己裁掉，页面整页空白，但页码照常递增**。实测（Chrome，真实 MOBI 章节，
 * 700×640 视口）：body overflow:hidden 时第 2 页截图 2.9KB 全白，改成 visible 后
 * 同一页 111KB 有字。所以这里钉的就是那两条声明，成本近乎零，复发必红。
 *
 * 同组还钉住触控板灵敏度：阈值一调回 32px，用户就会重新说「特别不灵敏」。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../client/src/reader.js', import.meta.url)
const source = readFileSync(SRC, 'utf8')
// style.js 是模板字符串拼出来的 CSS，直接读源文本即可（不必执行 ESM）。
const cssText = () => readFileSync(new URL('../client/src/style.js', import.meta.url), 'utf8')

/** 取出 `html body { … }` 那一块 CSS（frameCss 里的注入样式）。 */
function bodyCssBlock() {
  const start = source.indexOf('html body {')
  assert.ok(start >= 0, 'frameCss 里找不到 html body 块')
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, 'html body 块没有正常结束')
  return source.slice(start, end)
}

/** 取出 applyGeometry 函数体。 */
function applyGeometryBody() {
  const start = source.indexOf('function applyGeometry')
  assert.ok(start >= 0, '找不到 applyGeometry')
  const end = source.indexOf('\n}', start)
  return source.slice(start, end)
}

const cases = {
  '注入样式：body 不许 overflow:hidden（会裁掉第 2 页起）'() {
    const block = bodyCssBlock()
    assert.ok(
      !/overflow\s*:\s*hidden/.test(block),
      'body 的 CSS 又写回了 overflow:hidden —— 这会让每章只能看到第一页',
    )
    assert.ok(/overflow\s*:\s*visible/.test(block), 'body 的 CSS 应当显式 overflow: visible')
  },

  '内联几何：applyGeometry 也必须给 body 设 visible'() {
    const body = applyGeometryBody()
    assert.ok(
      !/set\('overflow',\s*'hidden'\)/.test(body),
      'applyGeometry 又把 body 设成 overflow:hidden 了',
    )
    assert.ok(/set\('overflow',\s*'visible'\)/.test(body), 'applyGeometry 应当 set overflow visible')
  },

  '高度必须钉成像素（百分比链断掉会让多栏退化成一列）'() {
    const body = applyGeometryBody()
    assert.ok(/set\('height'/.test(body), 'applyGeometry 应当设置 height')
    assert.ok(/height\s*>\s*0/.test(body), 'height 应当有一个「量到了才用」的判断')
  },

  '一次手势只翻一页：翻完立刻上锁，只有停手才解锁'() {
    assert.ok(/g\.blocked = true/.test(source), '找不到翻页后的上锁（g.blocked = true）')
    assert.ok(/if \(g\.blocked\) return/.test(source), '找不到上锁后的直接返回')
    assert.ok(
      /now - g\.lastWheelAt > GESTURE_GAP[\s\S]{0,120}g\.blocked = false/.test(source),
      '解锁必须挂在「停手超过 GESTURE_GAP」上',
    )
    assert.ok(!/WHEEL_REPEAT/.test(source), 'WHEEL_REPEAT 会让一次滑动连翻多页，不该再出现')
  },

  '翻页动画可以关掉：flashTurn 读 settings.motion'() {
    assert.ok(/settings\.motion === 'off'/.test(source), 'flashTurn 没有读 settings.motion')
  },

  '两侧窄边抬到翻页热区之上（否则点窄边会被热区吃掉）'() {
    const css = cssText()
    const rail = css.slice(css.indexOf('.dr-rail {'), css.indexOf('.dr-rail {') + 200)
    assert.ok(/z-index: 3/.test(rail), '.dr-rail 应当 z-index:3')
    assert.ok(/position: relative/.test(rail), '.dr-rail 应当是定位元素才有 z-index')
  },

  '桌面热区收窄到 16%（34% 会伸到正文右端、压住最后几个字）'() {
    const css = cssText()
    assert.ok(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]{0,200}\.dr-turn-zone \{ width: 16%/,
      '缺少桌面端热区收窄的媒体查询',
    )
  },

  '窄屏（手机）适配：隐藏窄边、放大热区、补 safe-area'() {
    const css = cssText()
    const start = css.indexOf('const CSS_MOBILE')
    assert.ok(start > 0, '找不到 CSS_MOBILE 常量')
    const mobile = css.slice(start)
    assert.ok(/\.dr-rail \{ display: none/.test(mobile), '窄屏应当隐藏两侧窄边（26px 在 390px 屏上占 13%）')
    assert.ok(/\.dr-turn-zone \{ width: 45%/.test(mobile), '窄屏热区应放大到 45%（拇指够得到）')
    assert.ok(/env\(safe-area-inset-bottom/.test(mobile), '缺 safe-area：底部页码会被小白条盖住')
    assert.ok(/env\(safe-area-inset-top/.test(mobile), '缺 safe-area：侧栏顶部会钻到刘海下面')
    assert.ok(/overflow-x: auto/.test(mobile), '窄屏工具栏应当横向滚动而不是换行挤成两行')
  },

  'Windows 覆盖写入：writeFileAtomic 走带重试的 rename'() {
    const store = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8')
    assert.ok(/await renameWithRetry\(temp, file\)/.test(store), 'writeFileAtomic 没走 renameWithRetry')
    const fn = store.slice(store.indexOf('async function renameWithRetry'))
    assert.ok(/EPERM/.test(fn) && /EBUSY/.test(fn), '重试应当只针对 EPERM/EBUSY/EACCES')
  },

  '触控板门槛：WHEEL_STEP 不超过 24'() {
    const step = Number((source.match(/const WHEEL_STEP = (\d+)/) || [])[1])
    assert.ok(Number.isFinite(step) && step > 0, '找不到 WHEEL_STEP')
    assert.ok(step <= 24, `WHEEL_STEP = ${step}，回调到 32 就会「特别不灵敏」`)
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
  console.log(`layout_css: ${passed} 项通过`)
}
