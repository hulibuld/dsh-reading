/**
 * 对比度守卫（0.9.7）。
 *
 * 起因：用户报「导入图书按钮白字白底，根本看不清」。根因不是颜色写错，而是
 * `.dr-btn` 早期那条 `background-image: linear-gradient(--dsw-alias-bg-layer-*)`
 * 没被后面的 `background:` 简写清掉——宿主把层色定义成白色时，那层白渐变就盖在
 * 实心蓝上，字还是白的，于是白底白字。
 *
 * 这组测试钉三件事：
 *   1. 主按钮的填充色与文字色必须**自己不依赖宿主 token**（宿主的 brand 可能是浅色）；
 *   2. `.dr-btn` / `.dr-btn-primary` 必须显式 `background-image: none`，不留渐变残影；
 *   3. 算一遍 WCAG 对比度：主按钮 ≥ 4.5（AA 正文），深色主入口 ≥ 7（AAA）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STYLE = new URL('../client/src/style.js', import.meta.url)
const css = readFileSync(STYLE, 'utf8')

/** 取某个选择器的最后一条规则（后写的生效）。 */
function lastRule(selector) {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  let hit = null
  let m
  while ((m = pattern.exec(css)) !== null) hit = m[1]
  return hit ?? ''
}

/** 取令牌的定义值（最后一条）。 */
function tokenValue(name) {
  const pattern = new RegExp(`${name}\\s*:\\s*([^;]+);`, 'g')
  let last = ''
  let m
  while ((m = pattern.exec(css)) !== null) last = m[1].trim()
  return last
}

function hexToRgb(hex) {
  const value = hex.trim().replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16))
}

function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

export default async function run() {
  let passed = 0
  const cases = {
    '主按钮的填充色与文字色是自持的，不引用宿主 token'() {
      const rule = lastRule('.dr-btn-primary')
      assert.ok(rule.includes('--dsh-reading-ui-accent-fill'), '主按钮背景应使用自持令牌 accent-fill')
      assert.ok(rule.includes('--dsh-reading-ui-accent-ink'), '主按钮文字应使用自持令牌 accent-ink')
      const backgroundLine = (rule.match(/background:[^;]+;/) || [''])[0]
      assert.ok(!backgroundLine.includes('--dsw-'), `主按钮背景不能引用宿主 token：${backgroundLine}`)
    },

    '按钮不留背景渐变残影（background-image: none）'() {
      for (const selector of ['.dr-btn', '.dr-btn-primary']) {
        const rule = lastRule(selector)
        assert.ok(
          /background-image:\s*none/.test(rule),
          `${selector} 缺 background-image: none——host 的白色渐变会盖住实心色`,
        )
      }
    },

    '主按钮对比度 ≥ 4.5（WCAG AA 正文）'() {
      const fill = tokenValue('--dsh-reading-ui-accent-fill')
      const ink = tokenValue('--dsh-reading-ui-accent-ink')
      assert.match(fill, /^#[0-9a-fA-F]{6}$/, `accent-fill 应是字面色，实际：${fill}`)
      assert.match(ink, /^#[0-9a-fA-F]{6}$/, `accent-ink 应是字面色，实际：${ink}`)
      const ratio = contrast(hexToRgb(fill), hexToRgb(ink))
      assert.ok(ratio >= 4.5, `主按钮对比度只有 ${ratio.toFixed(2)}:1，低于 4.5`)
    },

    '深色主入口（书源）对比度 ≥ 7（AAA）'() {
      const fill = tokenValue('--dsh-reading-ui-ink-fill')
      assert.match(fill, /^#[0-9a-fA-F]{6}$/)
      const ratio = contrast(hexToRgb(fill), hexToRgb('#ffffff'))
      assert.ok(ratio >= 7, `书源键对比度只有 ${ratio.toFixed(2)}:1，低于 7`)
    },

    '筛选条里的按钮只改底色，不被刷成白字'() {
      const at = css.indexOf('.dr-filters .dr-btn:not(.dr-filters-btn)')
      assert.ok(at >= 0, '缺少筛选条按钮的底色规则')
      const block = css.slice(at, css.indexOf('}', at) + 1)
      assert.match(block, /background:/, '这条规则应当只设置底色')
      assert.ok(!/color:\s*#fff/i.test(block), `这条规则把文字刷成白色了：${block.trim()}`)
    },
  }

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
  console.log(`contrast: ${passed} 项通过`)
}
