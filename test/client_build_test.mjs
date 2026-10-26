#!/usr/bin/env node
/**
 * client_build_test.mjs —— 浏览器半的构建产物测试。
 *
 * 这里测的不是「函数返回值」，而是三件真的会让用户看到白屏的事：
 *   1. 产物形状（loader 出现次数、id、apply/inject）；
 *   2. 注册契约（两个 slot、成对回收）；
 *   3. **渲染路径真的不抛** —— 组件在渲染期抛错，整条 slot 会被退役，
 *      面板静默消失且没有任何报错。所以本文件自带一个极小的 hooks 运行时，
 *      用假 React 把 PanelPage / ShelfView / TocPanel / AnnotationSidebar 真跑一遍。
 *
 * 为什么不用 react-dom：包里没有这个依赖（零运行时依赖是项目红线），
 * 而为了测试装一个 react-dom 会把 devDependencies 变成「装不上就跑不了测试」。
 * 自带那 80 行比多一个依赖便宜。
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'client', 'src')
const CLIENT = join(ROOT, 'client.js')

/** 构建名单必须与 build.mjs 的 MODULES 一致（顺序即断言）。 */
const MODULES = [
  'sha256.js',
  'cfi.js',
  'contract.js',
  'api.js',
  'style.js',
  'shelf.js',
  'toc.js',
  'reader.js',
  'annotate.js',
  'app.js',
]

// ────────────────────────────────────────────────────────────────────────────
// 极小 hooks 运行时：够跑这些组件，不多做一件多余的事
// ────────────────────────────────────────────────────────────────────────────

/**
 * hooks 调度上下文。
 *
 * 关键点：**组件在 factory 执行时就把 `React.useState` 抓进了闭合变量**
 * （`var useState = React.useState`）。所以这些函数必须从一开始就是「会调度」的版本，
 * 不能等渲染器建好再替换 —— 那样组件早就抓走了会抛的那个。
 */
const hookContext = { hooks: null, index: 0 }

/**
 * 造一个假 React。element 的形状由我们决定，渲染器靠 `type` 的类型分流。
 */
function makeFakeReact() {
  const createElement = (type, props, ...children) => ({
    $$kind: 'element',
    type,
    props: {
      ...(props || {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    },
  })

  const need = () => {
    if (!hookContext.hooks) {
      throw new Error('hook 在组件函数之外被调用（组件只有在渲染时才能用 hook）')
    }
    const index = hookContext.index
    hookContext.index += 1
    return { hooks: hookContext.hooks, index }
  }

  const depsChanged = (prev, deps) => prev === undefined
    || prev.deps === undefined
    || deps === undefined
    || deps.length !== prev.deps.length
    || deps.some((d, i) => !Object.is(d, prev.deps[i]))

  const api = {
    createElement,
    Fragment: 'fragment',
    useState: (initial) => {
      const { hooks, index } = need()
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const cell = hooks[index]
      const set = (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (!Object.is(value, cell.value)) {
          cell.value = value
          hookContext.dirty = true
        }
      }
      return [cell.value, set]
    },
    useEffect: (fn, deps) => {
      const { hooks, index } = need()
      const prev = hooks[index]
      if (depsChanged(prev, deps)) {
        hooks[index] = { deps }
        hookContext.pending.push(fn)
      }
    },
    useRef: (initial) => {
      const { hooks, index } = need()
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo: (fn, deps) => {
      const { hooks, index } = need()
      const prev = hooks[index]
      if (depsChanged(prev, deps)) hooks[index] = { value: fn(), deps }
      return hooks[index].value
    },
  }
  api.useLayoutEffect = api.useEffect
  api.useCallback = (fn, deps) => api.useMemo(() => fn, deps)

  return api
}

/**
 * 把组件渲染到「稳定」为止。
 *
 * 最多 8 轮：防 effect 里无条件 setState 把测试挂死；真无限更新时这里明确报错，
 * 而不是让 CI 转圈。
 */
function createRenderer() {
  const instances = new Map()
  const calls = []
  hookContext.dirty = false
  hookContext.pending = []

  const slotFor = (key) => {
    let hooks = instances.get(key)
    if (!hooks) {
      hooks = []
      instances.set(key, hooks)
    }
    return hooks
  }

  const renderNode = (node, path, tags, rootProps) => {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) {
      return node.map((child, i) => renderNode(child, `${path}[${i}]`, tags))
        .filter((x) => x !== null)
        .join('')
    }
    if (typeof node === 'function') {
      const props = rootProps !== undefined ? rootProps : (node.__props || {})
      return renderNode(callComponent(node, props, path), `${path}/${node.name || 'anon'}`, tags)
    }
    if (typeof node === 'object' && node.$$kind === 'element') {
      const { type, props } = node
      if (type === 'fragment') return renderNode(props.children, `${path}#frag`, tags)
      if (typeof type === 'function') {
        const inner = { ...props }
        delete inner.children
        return renderNode(callComponent(type, inner, path), `${path}/${type.name || 'anon'}`, tags)
      }
      if (typeof type === 'string') {
        tags.push(type)
        return renderNode(props.children, `${path}<${type}>`, tags)
      }
      return null
    }
    return null
  }

  const callComponent = (component, props, path) => {
    const key = `${path}::${component.name || 'anon'}`
    calls.push({ component, props, key })
    const hooks = slotFor(key)
    const saved = { hooks: hookContext.hooks, index: hookContext.index }
    hookContext.hooks = hooks
    hookContext.index = 0
    try {
      return component(props)
    } finally {
      hookContext.hooks = saved.hooks
      hookContext.index = saved.index
    }
  }

  /**
   * @param {Function} component
   * @param {object} [props]
   * @returns {{tags:string[], html:string, passes:number}}
   */
  const render = (component, props, maxPasses = 8) => {
    const tags = []
    let html = ''
    let passes = 0
    hookContext.dirty = true
    while (hookContext.dirty) {
      if (passes >= maxPasses) {
        throw new Error(`渲染 ${maxPasses} 轮还在更新，疑似无限重渲染`)
      }
      passes += 1
      hookContext.dirty = false
      hookContext.pending = []
      tags.length = 0
      html = renderNode(component, 'root', tags, props) ?? ''
      const effects = hookContext.pending
      hookContext.pending = []
      for (const fn of effects) fn()
    }
    return { tags, html, passes }
  }

  return { render, calls }
}

// ────────────────────────────────────────────────────────────────────────────
// 断言
// ────────────────────────────────────────────────────────────────────────────

/**
 * ⓪ 产物必须与源码同步。
 *
 * 测试进程**不能**顺手重建产物：那样「改了源码忘了构建」这个失败模式会被测试自己
 * 悄悄修好，`--check` 永远绿，而实际发出去的 client.js 是旧的。
 * 所以这里独立算一遍期望产物，与磁盘上的逐字节比较。
 */
async function assertInSync() {
  const build = await import(new URL('../client/build.mjs', import.meta.url).href)
  assert.equal(typeof build.buildClient, 'function', 'build.mjs 没有导出 buildClient')

  const expected = build.buildClient()
  assert.ok(existsSync(CLIENT), 'client.js 不存在，先跑 node client/build.mjs')

  const actual = readFileSync(CLIENT, 'utf8')
  if (actual !== expected) {
    const expectedLines = expected.split('\n')
    const actualLines = actual.split('\n')
    const at = expectedLines.findIndex((line, i) => line !== actualLines[i])
    assert.fail(
      'client.js 与 client/src 不同步 —— 改了源码必须重新构建（node client/build.mjs）。'
      + `\n  第一处差异在第 ${at + 1} 行`
      + `\n  期望：${(expectedLines[at] ?? '(缺失)').slice(0, 120)}`
      + `\n  实际：${(actualLines[at] ?? '(缺失)').slice(0, 120)}`,
    )
  }
}

/** ① 产物存在且形状对。 */
function assertShape() {
  assert.ok(existsSync(CLIENT), 'client.js 不存在，先跑 node client/build.mjs')
  const text = readFileSync(CLIENT, 'utf8')

  const loaderCount = (text.match(/__ModuleLoader__\.load\(/g) || []).length
  assert.equal(loaderCount, 1, `__ModuleLoader__.load( 必须恰好 1 次，实际 ${loaderCount}`)

  assert.ok(text.includes("id: 'dsh-reading'"), "产物里的模块 id 必须是 'dsh-reading'")

  assert.ok(/exports\.apply\s*=\s*\S+/.test(text), '产物缺少 exports.apply 赋值')
  assert.ok(/exports\.inject\s*=\s*\S+/.test(text), '产物缺少 exports.inject 赋值')

  const leftover = text.split('\n').filter((line) => /^\s*export\s/.test(line))
  assert.equal(leftover.length, 0, `产物里残留 export：${leftover[0] ?? ''}`)

  assert.ok(!/require\(\s*['"]@deepseek-ai\//.test(text), '产物里 require 了 @deepseek-ai/* 包')
  assert.ok(!/require\(\s*['"](?!react['"])/.test(text), '产物里 require 了 react 之外的东西')
}

/** ② client/src 下每个模块都在产物里，且没有外部 npm import。 */
function assertModules() {
  const text = readFileSync(CLIENT, 'utf8')
  for (const name of MODULES) {
    assert.ok(existsSync(join(SRC, name)), `缺少源模块 client/src/${name}`)
    assert.ok(text.includes(`client/src/${name}`), `产物里没有 ${name} 的痕迹（构建名单漏了？）`)
  }

  const entries = readdirSync(SRC).filter((name) => name.endsWith('.js'))
  for (const name of entries) {
    const code = readFileSync(join(SRC, name), 'utf8')
    // 跨行具名导入会被格式化工具折行，所以按整段匹配，不按行匹配
    const statements = code.match(/^import\s+[\s\S]*?from\s+['"][^'"]+['"]/gm)
      || code.match(/^import\s+['"][^'"]+['"]/gm)
      || []
    const bareSideEffect = code.match(/^import\s+['"][^'"]+['"]/gm) || []
    const all = [...statements, ...bareSideEffect]
    for (const statement of all) {
      const spec = /from\s*['"]([^'"]+)['"]/.exec(statement)
        || /^import\s*['"]([^'"]+)['"]/.exec(statement)
      assert.ok(spec, `${name} 的 import 语句解析不出模块名：${statement.slice(0, 60)}`)
      const target = spec[1]
      assert.ok(
        target.startsWith('./') || target.startsWith('../'),
        `${name} import 了外部包 "${target}"：浏览器半不许 import 任何 npm 包`,
      )
    }
  }

  // 正则正控：确认匹配器本身没坏（坏掉的负向检查=永远通过，是假绿的最大来源）
  const known = readFileSync(join(SRC, 'reader.js'), 'utf8')
  const probe = known.match(/^import\s+[\s\S]*?from\s+['"][^'"]+['"]/gm) || []
  assert.ok(probe.length >= 2, 'import 匹配器失效了（reader.js 至少有两处 import）')
}

/** ③ reader.js 的 iframe 沙箱：只开 same-origin，绝不给 allow-scripts。 */
function assertSandbox() {
  const code = readFileSync(join(SRC, 'reader.js'), 'utf8')
  const sandbox = /sandbox:\s*(['"])([^'"]*)\1/.exec(code)
  assert.ok(sandbox, "reader.js 的 iframe 缺少 sandbox 属性")
  assert.equal(
    sandbox[2],
    'allow-same-origin',
    `iframe 的 sandbox 必须恰好是 'allow-same-origin'，实际是 '${sandbox[2]}'`,
  )
  // 注释里解释「为什么不给 allow-scripts」是允许的，但不许出现在实际属性值里
  assert.ok(
    !/allow-scripts/.test(sandbox[2]),
    'iframe 的 sandbox 带了 allow-scripts：书里的脚本会执行',
  )
  assert.ok(/onFrameReady/.test(code), 'reader.js 必须把文档通过 onFrameReady 抛给外层')
  assert.ok(/contentDocument/.test(code), 'reader.js 必须取 contentDocument（sandbox 决定拿不拿得到）')
  assert.ok(/contentWindow/.test(code), 'reader.js 必须取 contentWindow（CFI 需要它）')

  const built = readFileSync(CLIENT, 'utf8')
  assert.ok(built.includes("sandbox: 'allow-same-origin'"), '产物里丢了 iframe sandbox')
}

/** ④ style.js 只用 --dsw-alias-* / --dsw-radius-*，且每个 var() 都带 fallback。 */
function assertStyleTokens() {
  const code = readFileSync(join(SRC, 'style.js'), 'utf8')
  const cssStart = code.indexOf('const CSS = `')
  assert.ok(cssStart >= 0, 'style.js 里找不到 CSS 模板')
  const css = code.slice(cssStart)

  const vars = css.match(/var\(\s*--[^)]*\)/g) || []
  assert.ok(vars.length > 20, `对主题 token 的引用太少（${vars.length}），样式可能没用 token`)

  for (const usage of vars) {
    const nameMatch = /var\(\s*(--[A-Za-z0-9-]+)\s*(,)?/.exec(usage)
    assert.ok(nameMatch, `看不懂的 var()：${usage}`)
    const name = nameMatch[1]
    // 组件本地布局变量（--dsh-reading-*）是允许的：它们不是主题色，而是
    // 插件自己的尺寸与「阅读纸色」。纸色四档定义在 reader.js 的 THEMES 里，
    // 是电子墨水阅读器的语义，不该跟着宿主主题走（见 style.js 头部说明）。
    assert.ok(
      name.startsWith('--dsw-alias-')
      || name.startsWith('--dsw-radius-')
      || name.startsWith('--dsh-reading-'),
      `style.js 用了非白名单 token：${name}（只允许 --dsw-alias-* / --dsw-radius-* / --dsh-reading-*）`,
    )
    assert.ok(nameMatch[2] === ',', `var(${name}) 没有 fallback：宿主缺这个 token 时会变成透明`)
  }

  // 主题分支由主题层负责，特性组件里不许写 prefers-color-scheme 改色
  assert.ok(
    !/prefers-color-scheme/.test(css),
    'style.js 里出现了 prefers-color-scheme：明暗切换属于主题层',
  )

  // 圆角规范：圆形/胶囊必须与 corner-shape: round 成对出现，否则在支持
  // superellipse 的引擎上会变成「方一点的圆」，与同一排的其他控件对不上。
  const rules = [...css.matchAll(/\{([^{}]*)\}/g)]
  for (const rule of rules) {
    const body = rule[1]
    if (/border-radius:\s*(?:50%|999px|100%)/.test(body)) {
      assert.ok(
        /corner-shape:\s*round/.test(body),
        `圆形/胶囊没有配 corner-shape: round：${body.trim().split('\n')[0]}`,
      )
    }
  }

  // 圆角值只允许走 --dsw-radius-* 或者规范里的固定例外（0 / 0.5px 边框不在此列）
  const literalRadii = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((value) => !value.includes('var(--dsw-radius-') && !value.startsWith('50%') && !value.startsWith('999px'))
  assert.equal(
    literalRadii.length,
    0,
    `style.js 里出现了不走 token 的字面圆角：${literalRadii.join(' / ')}`,
  )
}

/** ⑤ apply/inject 与两个 slot 的注册、成对回收。 */
function assertRegistration(api) {
  assert.equal(typeof api.apply, 'function', 'exports.apply 必须是函数')
  assert.ok(Array.isArray(api.inject), 'exports.inject 必须是数组')
  assert.deepEqual(api.inject, ['slots'], 'exports.inject 必须恰好是 [\'slots\']')

  const registered = []
  const disposals = []
  const effects = []

  const ctx = {
    slots: {
      inject(key, fn) {
        assert.ok(typeof key === 'string' && key !== '', 'slots.inject 的 key 必须是非空字符串')
        return fn()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {
          const at = registered.findIndex((item) => item.spec === spec)
          if (at >= 0) registered.splice(at, 1)
          disposals.push(spec)
        }
      },
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {}
    },
    get() {
      return undefined
    },
  }

  api.apply(ctx)

  assert.equal(registered.length, 2, `必须注册两个 slot，实际 ${registered.length}`)

  const main = registered.find((item) => item.spec.name === 'main')
  assert.ok(main, '缺少 main slot 注册')
  assert.equal(main.spec.key, 'dsh-reading', 'main slot 的 key 必须是 dsh-reading')
  assert.equal(typeof main.component, 'function', 'main slot 的组件必须是函数')

  const side = registered.find((item) => item.spec.name === 'sidebar.panellist')
  assert.ok(side, '缺少 sidebar.panellist slot 注册')
  assert.equal(side.spec.id, 'dsh-reading', 'sidebar.panellist 的 id 必须是 dsh-reading')
  assert.equal(side.spec.order, 36, 'sidebar.panellist 的 order 必须是 36')
  assert.equal(typeof side.component, 'function', 'sidebar.panellist 的组件必须是函数')
  assert.equal(typeof side.spec.label, 'function', 'sidebar.panellist 必须提供 label()')

  // 回收：两个都要被撤掉（少一个，重载后图标会重复）
  assert.equal(effects.length, 1, 'apply 必须只建一个 effect')
  effects[0].dispose()
  assert.equal(registered.length, 0, `disposer 没有成对回收，还剩 ${registered.length} 个注册`)
  assert.equal(disposals.length, 2, `应该回收 2 次，实际 ${disposals.length}`)
}

/** ⑥ 渲染路径：真的跑组件，任何抛出都是白屏事故。 */
function assertRenders(bundle) {
  const renderer = createRenderer()

  // PanelIcon：一个纯 SVG，最容易验证「真的画出了东西」
  const iconResult = renderer.render(bundle.PanelIcon, { size: 18 })
  assert.ok(iconResult.tags.includes('svg'), 'PanelIcon 没有渲染出 svg')

  // 目录：空态与有目录两条路径都不许抛
  const tocFilled = renderer.render(bundle.TocPanel, {
    toc: [{ label: '第一章', href: 'text/ch1.xhtml', spineIndex: 0, depth: 0 }],
    currentSpineIndex: 0,
    onJump() {},
  })
  assert.ok(tocFilled.html.includes('第一章'), '目录没有渲染出标签')
  assert.ok(tocFilled.tags.includes('button'), '目录应该有可点的行')

  const tocEmpty = renderer.render(bundle.TocPanel, { toc: [], currentSpineIndex: 0, onJump() {} })
  assert.ok(tocEmpty.html.length > 0, '目录空态渲染成了空字符串（用户会看到白屏）')

  const sideEmpty = renderer.render(bundle.AnnotationSidebar, {
    records: [],
    onJump() {},
    onRemove() {},
    onUpdateColor() {},
  })
  assert.ok(sideEmpty.html.length > 0, '标注侧栏空态渲染成了空字符串')

  const sideFilled = renderer.render(bundle.AnnotationSidebar, {
    records: [{
      id: '01JBX00000000000000000000A',
      type: 'highlight',
      cfi: 'epubcfi(/6/2[ch1]!/4/2/2/1:0,/4/2/2/1:8)',
      chapterHref: 'text/ch1.xhtml',
      textExcerpt: '他抬头看了看天',
      color: 'yellow',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      deviceId: 'mbp-7f3a',
    }],
    onJump() {},
    onRemove() {},
    onUpdateColor() {},
  })
  assert.ok(sideFilled.html.includes('他抬头看了看天'), '标注侧栏没有渲染出摘录')

  // 真正的风险点：面板根组件。它一抛，整个 slot 白掉。
  const panel = renderer.render(bundle.PanelPage, {})
  assert.ok(panel.html.length > 0, 'PanelPage 渲染成了空字符串（用户会看到白屏）')
  assert.ok(panel.tags.includes('div'), 'PanelPage 没有渲染出任何 div')
}

/** ⑦ 源码里不许出现个人信息（docs/05 §0 红线）。 */
function assertNoPersonalInfo() {
  const targets = [...MODULES.map((name) => join(SRC, name)), CLIENT,
    join(ROOT, 'locale', 'zh.json'), join(ROOT, 'locale', 'en.json'), join(ROOT, 'icon.svg')]
  for (const file of targets) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    // 三条规则故意写成「结构」而不是「某个名字」：把要防的那串字面量写进测试，
    // 等于把它永久留在仓库里——这正是要防的事情本身。
    assert.ok(!/\/(?:Users|home)\/[A-Za-z0-9._-]+/.test(text), `${file} 里出现了本机绝对路径`)
    assert.ok(!/\b(?:1[3-9]\d{9})\b/.test(text), `${file} 里出现了手机号`)
    assert.ok(!/[A-Za-z0-9._%+-]+@(?:qq|163|126|gmail|outlook|foxmail)\.com/i.test(text),
      `${file} 里出现了私人邮箱（示例请用 example@example.com）`)
  }
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * 入口。test/run.mjs 会 `import()` 本文件并调用导出的 run。
 *
 * @returns {Promise<void>}
 */
/**
 * ⑧ 行扫描状态机：证明它不会被模板字符串里的 `export ` 骗到。
 *
 * 这是构建器里最值得单独测的一段。历史教训（dsh-ai-waifu 的 build-client.mjs 头部注释）：
 * 某个模块的主要产出是一段巨大的提示词模板字符串，里面恰好有一行以 `export ` 开头，
 * 裸正则把它一起剥了 —— 提示词静默少几个词，`node --check` 绿、`--check` 绿、
 * 单测测的是 src 不测产物，全绿。
 */
async function assertStateMachine() {
  const build = await import(new URL('../client/build.mjs', import.meta.url).href)
  const transform = build.transformModule
  assert.equal(typeof transform, 'function', 'build.mjs 没有导出 transformModule（无法直接测状态机）')

  // ① 模板字符串里以 `export ` 开头的行必须原样保留
  const tricky = [
    "export const TEMPLATE = `",
    "export 这行在模板里，不该被剥掉",
    "  export function alsoInside() {}",
    "`",
    "",
    "export function real() { return 1 }",
  ].join('\n')

  const result = transform(tricky, 'probe.js', new Map())
  assert.ok(
    result.body.includes('export 这行在模板里'),
    '状态机把模板字符串里的 export 行剥掉了（静默损坏）',
  )
  assert.ok(
    result.body.includes('export function alsoInside()'),
    '状态机把模板字符串里的 export function 剥掉了',
  )
  assert.ok(
    result.body.includes('function real()'),
    '状态机没有剥掉真正的 export function',
  )
  // 真正的判据不是「有没有某行以 export 开头」（模板里可以有），
  // 而是「这段代码还能不能当函数体求值」：残留的语句级 export 会直接是语法错误。
  assert.doesNotThrow(
    () => new Function(result.body),
    '转换后的模块体不能求值 —— 说明有语句级 export 残留',
  )
  assert.ok(result.exportMap.has('real'), 'real 没有被登记为导出')
  assert.ok(result.exportMap.has('TEMPLATE'), 'TEMPLATE 没有被登记为导出')

  // ② export { a as b } 别名必须记成 b → a
  const aliased = transform('const a = 1\nexport { a as b }\n', 'probe2.js', new Map())
  assert.equal(aliased.exportMap.get('b'), 'a', 'export 别名没有正确映射')

  // ③ 外部包 import 必须响亮失败（不是静默忽略）
  assert.throws(
    () => transform("import { debounce } from 'lodash'\n", 'probe3.js', new Map()),
    /外部包|不许 import/,
    '外部 npm 具名 import 没有构建期报错',
  )
  // 默认导入没有约定，构建器要明确拒绝而不是猜
  assert.throws(
    () => transform("import lodash from 'lodash'\n", 'probe3b.js', new Map()),
    /默认导入/,
    '默认导入没有被拒绝',
  )

  // ④ 兄弟模块 import：名单里没有时必须报错（否则运行期读到空对象）
  assert.throws(
    () => transform("import { x } from './nope.js'\n", 'probe4.js', new Map()),
    /不在构建名单里或排在后面/,
    '未知兄弟模块 import 没有构建期报错',
  )

  // ⑤ 跨行具名导入必须能解析（格式化工具会折行）
  const registry = new Map([['dep.js', {
    namespace: '__mod_dep_js',
    exports: new Map([['a', 'a'], ['b', 'b']]),
  }]])
  const multiline = transform(
    "import {\n  a,\n  b,\n} from './dep.js'\n\nconst c = a + b\n",
    'probe5.js',
    registry,
  )
  assert.ok(multiline.body.includes('const a = __mod_dep_js.a'), '跨行导入的 a 没有绑上')
  assert.ok(multiline.body.includes('const b = __mod_dep_js.b'), '跨行导入的 b 没有绑上')

  // ⑥ 从兄弟模块导入不存在的名字必须报错
  assert.throws(
    () => transform("import { nope } from './dep.js'\n", 'probe6.js', registry),
    /没有导出这个名字/,
    '导入了不存在的名字却没报错',
  )
}

export default async function run() {
  await assertInSync()
  assertShape()
  assertModules()
  assertSandbox()
  assertStyleTokens()
  assertNoPersonalInfo()

  // 产物在假 window 上执行一次，拿到真正的 exports。
  // 注意：必须在 factory **之前**把 hooks 版 React 准备好 —— 组件会把
  // `React.useState` 抓进闭合变量，晚一步替换就抓不到。
  const fakeReact = makeFakeReact()
  const captured = []
  const window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
  const source = readFileSync(CLIENT, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', source)(window, globalThis)
  assert.equal(captured.length, 1, '产物没有调用 __ModuleLoader__.load')

  const bundle = captured[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`产物 require 了 ${name}，浏览器半只允许 react`)
  })

  await assertStateMachine()
  assertRegistration(bundle)
  assertRenders(bundle)
}
