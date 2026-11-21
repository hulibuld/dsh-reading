/**
 * 深色主题令牌守卫（0.13.1）。
 *
 * 起因：0.12 加读书笔记那几块样式时，写 CSS 用的是 `var(--dsh-reading-ui-rule)`、
 * `var(--dsh-reading-ui-bg-card)`、`var(--dsh-reading-mono)` 三个名字，但 CSS_TOKENS
 * 里压根没定义它们。变量没定义 → 整条声明失效 → 一路回落到硬编码的浅色兜底值。
 * 浅色主题下看不出来，深色主题下就成了「白卡片、白虚线、白框」——用户报的
 * 「笔记那一栏刺眼」就是这个。
 *
 * 这组测试钉两件事：
 *   1. 这三个名字必须真的在 CSS_TOKENS 里定义，且定义自身要接宿主 token
 *      （不是写死一个颜色，否则深色主题下照样不会变）；
 *   2. 全站不许再出现 `--dsh-reading-accent` 这种错名 —— 那次是前缀写错了，
 *      少一个 `-ui-` 就静默失效，靠肉眼永远查不出来。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const STYLE = new URL('../client/src/style.js', import.meta.url)
const css = readFileSync(STYLE, 'utf8')

/** 取令牌的定义值（最后一条）。 */
function tokenValue(name) {
  const pattern = new RegExp(`${name}\\s*:\\s*([^;]+);`, 'g')
  let last = ''
  let m
  while ((m = pattern.exec(css)) !== null) last = m[1].trim()
  return last
}

/**
 * 顺着 var() 链往下解，最多 6 层。
 *
 * 只解「整条值就是一个 var(--x, 兜底)」这种形态 —— 混着别的东西（字体栈、
 * 多层阴影）时没有唯一答案，解开反而误导，直接返回当前这一层。
 *
 * @param {string} name 令牌名，如 '--dsh-reading-ui-rule'
 * @returns {string[]} 每一层的原始值，第 0 层是被问的那个名字
 */
function resolveChain(name) {
  const chain = []
  let current = name
  for (let depth = 0; depth < 6; depth += 1) {
    const value = tokenValue(current)
    if (value === '') break
    chain.push(value)
    const only = /^var\(\s*(--[\w-]+)/.exec(value)
    if (!only) break
    const next = only[1]
    if (next === current) break
    current = next
  }
  return chain
}

/** 找到某条选择器规则体（第一条）。 */
function firstRule(selector) {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return ''
  return css.slice(at, css.indexOf('}', at) + 1)
}

export default async function run() {
  let passed = 0
  const cases = {
    '三个缺失别名都已定义'() {
      for (const name of ['--dsh-reading-ui-rule', '--dsh-reading-ui-bg-card', '--dsh-reading-mono']) {
        const value = tokenValue(name)
        assert.notEqual(value, '', `${name} 没有任何定义——用它写的样式会静默失效并回落到浅色兜底`)
      }
    },

    '规则线与卡片底色接宿主 token，不写死颜色'() {
      // 这两个必须能跟主题变；写死 #e2ded5 的话深色主题下还是浅色。
      // 允许间接：别名可以指本插件的另一个令牌，只要那条令牌最终接到宿主 token。
      // （rule 指向 --dsh-reading-ui-line、bg-card 指向 --dsh-reading-ui-bg，都是这样。）
      for (const name of ['--dsh-reading-ui-rule', '--dsh-reading-ui-bg-card']) {
        const chain = resolveChain(name)
        assert.ok(chain.length > 0, `${name} 没有解到任何值`)
        assert.ok(
          chain.some((value) => value.includes('--dsw-')),
          `${name} 最终要接宿主 token，实际链条：${chain.join(' → ')}`,
        )
      }
    },

    '等宽字体别名给得出一个真实的字体栈'() {
      const value = tokenValue('--dsh-reading-mono')
      assert.match(value, /monospace/, `等宽栈里得有 monospace 兜底，实际：${value}`)
      assert.ok(!value.includes('var('), `字体栈不该再套一层变量，实际：${value}`)
    },

    '全站不再出现错名 --dsh-reading-accent'() {
      // 反向守卫：这个名字从来没定义过（正确名是 --dsh-reading-ui-accent）。
      // 允许出现在注释里，但不允许出现在 var() 里。
      const wrong = /var\(\s*--dsh-reading-accent\b/
      assert.ok(!wrong.test(css), `还在用错名 var(--dsh-reading-accent)，正确名是 --dsh-reading-ui-accent`)
    },

    '分页跳转框的聚焦描边走令牌'() {
      const rule = firstRule('.dr-pagejump-input:focus')
      assert.notEqual(rule, '', '缺少分页跳转框的聚焦样式')
      assert.match(rule, /var\(--dsh-reading-ui-accent/, `聚焦描边应取 --dsh-reading-ui-accent，实际：${rule.trim()}`)
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
  console.log(`dark: ${passed} 项通过`)
}
