/**
 * 选区菜单几何单测（0.4.0 t11 修「划词菜单离选区很远，越往后翻偏得越多」）。
 *
 * 被测的是 client/src/annotate.js 里真正在跑的两个纯函数：
 *   · rangeRectToMenuBase({ rangeRect, frameBox, layerBox, pageOffset }) → 选区在父窗口里的矩形
 *   · placeSelectionMenu(rect, opts)                                      → 菜单盒子
 *
 * 这个 bug 值得单独立一个测试文件：它不报错、也不是每页都错——第 1 页看着还挺准，
 * 第 10 页偏出去一屏。根因是 `range.getBoundingClientRect()` 返回的矩形已经含了
 * 祖先的 transform（翻页位移），0.3.x 在调用点又减了一次 pageOffset，翻了 N 页
 * 就多减 N 个页宽。下面把「pageOffset 不参与换算」写成断言，并且在最后放一条
 * 反向断言：谁把减法加回来，这里立刻红。
 *
 * 断言口径：菜单中心与选区中心差 ≤1px；菜单底边与选区顶边差 8px（≤12px 即算贴住）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rangeRectToMenuBase, placeSelectionMenu, SELECTION_MENU_HEIGHT } from '../client/src/annotate.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EPS = 1
const FRAME = { left: 120, top: 48 }
const centerX = (box) => box.left + box.width / 2

/** 选区矩形 + iframe 位置 → 菜单盒子；和 app.js 的调用方式一致。 */
function menuFor(rangeRect, pageOffset, opts = {}) {
  const base = rangeRectToMenuBase({
    rangeRect,
    frameBox: opts.frameBox ?? FRAME,
    layerBox: opts.layerBox ?? null,
    pageOffset,
  })
  const menu = placeSelectionMenu(base, {
    menuWidth: opts.menuWidth ?? 268,
    menuHeight: SELECTION_MENU_HEIGHT,
    gap: 8,
    viewportWidth: opts.viewportWidth ?? 1280,
    viewportHeight: opts.viewportHeight ?? 900,
  })
  return { base, menu }
}

export default async function run() {
  // ── 第 1 页：pageOffset = 0，最朴素的情形 ────────────────────────────────
  const page1 = menuFor({ left: 180, top: 260, width: 220, height: 22 }, 0)
  assert.ok(Math.abs(page1.base.left - (FRAME.left + 180)) <= EPS,
    `第 1 页 base.left 应为 ${FRAME.left + 180}，实际 ${page1.base.left}`)
  assert.ok(Math.abs(centerX(page1.menu) - centerX(page1.base)) <= EPS,
    `第 1 页菜单中心 ${centerX(page1.menu)} 与选区中心 ${centerX(page1.base)} 差超过 ${EPS}px`)
  assert.ok(Math.abs((page1.base.top - (page1.menu.top + page1.menu.height)) - 8) <= 0.5,
    '第 1 页菜单底边应贴着选区顶边（间距 8px）')
  console.log('  ok   第 1 页：菜单水平居中 + 贴在选区上方')

  // ── 第 10 页：pageOffset 很大，核心断言是它**不参与**换算 ─────────────────
  const page10 = menuFor({ left: 180, top: 260, width: 220, height: 22 }, 8100)
  assert.deepEqual(page10.base, page1.base,
    `pageOffset 不该改变换算结果：page1=${JSON.stringify(page1.base)} page10=${JSON.stringify(page10.base)}`)
  assert.ok(Math.abs(centerX(page10.menu) - centerX(page1.menu)) <= EPS,
    '第 10 页与第 1 页的菜单水平位置应一致（误差 ≤1px）')
  console.log('  ok   第 10 页：pageOffset=8100 不影响菜单位置')

  // 反向断言：把 pageOffset 再减一次（0.3.x 的旧写法）必须显著错位。
  // 没有这一条，上面两条即使实现恒定返回 0 也能通过，测不出「减法bug 是否复活」。
  const buggyLeft = FRAME.left + 180 - 8100
  assert.ok(Math.abs(buggyLeft - page10.base.left) > 1000,
    `反向断言失败：旧写法 left=${buggyLeft} 与新结果 ${page10.base.left} 应当相差数千像素`)

  // ── 双栏第二栏：跨栏选区（宽 780）也不该被 pageOffset 影响 ────────────────
  const wide = { left: 480, top: 240, width: 780, height: 44 }
  const noOffset = menuFor(wide, 0, { viewportWidth: 1600 })
  const withOffset = menuFor(wide, 13200, { viewportWidth: 1600 })
  assert.deepEqual(withOffset.base, noOffset.base, '双栏情形下 pageOffset 同样不参与换算')
  assert.ok(Math.abs(centerX(withOffset.menu) - centerX(withOffset.base)) <= EPS,
    '跨栏选区的菜单中心应落在选区中心上')
  assert.ok(withOffset.menu.left >= 8 && withOffset.menu.left + withOffset.menu.width <= 1600 - 8,
    '菜单不能被夹到视口外')
  console.log('  ok   双栏第二栏：跨栏选区居中，pageOffset=13200 不偏移')

  // ── 竖向：上方放不下时翻到下方，且不盖住选区 ─────────────────────────────
  // frame 的 top 记为 0，让「选区贴着视口顶」这件事在父窗口坐标里也成立。
  const nearTop = menuFor({ left: 180, top: 20, width: 220, height: 22 }, 2700, { frameBox: { left: FRAME.left, top: 0 } })
  assert.ok(nearTop.menu.top >= nearTop.base.top + nearTop.base.height,
    '选区贴着视口顶时菜单应翻到选区下方')
  const gap = nearTop.menu.top - (nearTop.base.top + nearTop.base.height)
  assert.ok(gap <= 12, `菜单与选区竖向间隔 ${gap}px，超过 12px`)
  console.log('  ok   贴顶选区：菜单翻到下方，间距 ≤12px')

  // ── 覆盖层原点：layerBox 生效（菜单挂在 layer 里时减去 layer 左上角） ──────
  const plain = menuFor({ left: 180, top: 260, width: 220, height: 22 }, 0)
  const layered = menuFor({ left: 180, top: 260, width: 220, height: 22 }, 0, { layerBox: { left: 10, top: 20 } })
  assert.ok(Math.abs(layered.base.left - (plain.base.left - 10)) <= EPS, 'layerBox.left 应被减掉')
  assert.ok(Math.abs(layered.base.top - (plain.base.top - 20)) <= EPS, 'layerBox.top 应被减掉')
  console.log('  ok   layerBox 生效：覆盖层原点换算正确')

  // ── 调用点检查：app.js 不许再手写「减去 pageOffset」的换算 ────────────────
  // 去掉注释再扫，避免把「讲清 bug 来龙去脉」的注释当成残留代码。
  const app = readFileSync(join(ROOT, 'client/src/app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
  assert.ok(app.includes('rangeRectToMenuBase('), 'app.js 的选区换算应调用 rangeRectToMenuBase')
  assert.ok(!/rangeRect\.left\s*-\s*pageOffset/.test(app),
    'app.js 里还有 `rangeRect.left - pageOffset`：翻页位移被减了两次，菜单会越翻越偏')
  console.log('  ok   app.js 的选区换算只走 rangeRectToMenuBase')

  console.log('菜单几何单测：7 项断言全部通过')
}
