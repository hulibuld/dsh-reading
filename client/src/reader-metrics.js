/**
 * 阅读器几何量：列宽、列高。
 *
 * 单独一个模块，是为了能被 node 直接 import 测 —— reader.js 里有 React 组件，
 * 测试里 import 它会连带把半个应用拉进来。这里的两个函数是纯函数，给一对
 * 「像 DOM 元素」的对象就能算出结果。
 *
 * 历史：这段逻辑原来写在 reader.js 的 geometry() 里，取「iframe 与外层视口」
 * 多路测量的**最大**值。外层视口带上下各 40px 内边距（正文四周的留白），
 * iframe 的 height:100% 只等于内容盒高度，于是「列高比 iframe 高 80px」，
 * 每页最底下那一两行被裁在视口外面 —— 用户的原话是「最底下那行字还是会被遮住」。
 * 列高必须取 iframe 自己的高度；只有量不到时才退回外层，并且要扣掉内边距。
 */

/** 取元素的 client 尺寸（老引擎 / jsdom 里可能是 0）。 */
function clientSize(el) {
  if (!el) return { width: 0, height: 0 }
  return {
    width: Math.max(0, Number(el.clientWidth) || 0),
    height: Math.max(0, Number(el.clientHeight) || 0),
  }
}

/** 取元素的 border-box 尺寸。 */
function rectSize(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return { width: 0, height: 0 }
  const rect = el.getBoundingClientRect()
  if (!rect) return { width: 0, height: 0 }
  return { width: Math.max(0, Number(rect.width) || 0), height: Math.max(0, Number(rect.height) || 0) }
}

/** 取元素的内边距合计；拿不到样式就按 0 算。 */
function paddingOf(el) {
  const view = el && el.ownerDocument ? el.ownerDocument.defaultView : null
  if (!view || typeof view.getComputedStyle !== 'function') return { x: 0, y: 0 }
  try {
    const style = view.getComputedStyle(el)
    const num = (value) => {
      const parsed = parseFloat(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    return {
      x: num(style.paddingLeft) + num(style.paddingRight),
      y: num(style.paddingTop) + num(style.paddingBottom),
    }
  } catch {
    return { x: 0, y: 0 }
  }
}

/**
 * 算出「一列能装多高、多宽」。
 *
 * 优先级：iframe 自己的尺寸 → 外层视口扣掉内边距 → 上一次量到的好值。
 * 绝不把外层高度直接当列高：那是含内边距的盒子，比 iframe 高。
 *
 * @param {object|null} frame   正文 iframe（或其替代元素）
 * @param {object|null} viewport 外层视口（带内边距）
 * @param {{ width?: number, height?: number }} [last] 上一次量到的好值
 * @returns {{ width: number, height: number, fromFrame: boolean }}
 */
export function frameMetrics(frame, viewport, last = {}) {
  const frameClient = clientSize(frame)
  const frameRect = rectSize(frame)
  // 有 clientHeight 就用它：那是 iframe 的内容盒高度，正是「一列」的高度。
  let width = frameClient.width > 0 ? frameClient.width : frameRect.width
  let height = frameClient.height > 0 ? frameClient.height : frameRect.height
  const fromFrame = width >= 200 && height >= 200

  if (!fromFrame) {
    const pad = paddingOf(viewport)
    const viewClient = clientSize(viewport)
    const viewRect = rectSize(viewport)
    const viewWidth = Math.max(viewClient.width, viewRect.width)
    const viewHeight = Math.max(viewClient.height, viewRect.height)
    if (width < 200) width = Math.max(0, viewWidth - pad.x)
    if (height < 200) height = Math.max(0, viewHeight - pad.y)
  }

  if (width < 200 && Number(last.width) >= 200) width = Number(last.width)
  if (height < 200 && Number(last.height) >= 200) height = Number(last.height)

  return {
    width: Math.max(0, Math.floor(width)),
    height: Math.max(0, Math.floor(height)),
    fromFrame,
  }
}