/**
 * 浏览器半产物的**装载冒烟**：把 client.js 放进一个最小宿主环境里跑一遍。
 *
 * 为什么值得单独一个测试：`client_build_test` 只检查产物「形状」（loader 出现一次、
 * 每个模块都在、没有本机路径）。形状对但不一定能跑 —— 少一个 `export`、
 * 模块顺序颠倒、`apply` 里引用了不存在的服务，产物照样「形状正确」，
 * 到真实宿主里却是白屏或面板静默退役（外壳不会报错，只会让这条 entry 退役）。
 *
 * 这里真的执行 bundle，真的调 `apply()`，断言：
 *   1. `window.__ModuleLoader__.load` 被调用，id 正确，factory 可求值；
 *   2. 只 `require('react')` —— 插件不许依赖别的东西；
 *   3. `apply(ctx)` 注册了 main 与 sidebar.panellist 两处座位；
 *   4. 宿主没有 slots 服务时**安静退化**，不抛错（老版本宿主不该让插件崩）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url)

/** 只实现 bundle 用到的那几个 React API。 */
const React = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: () => null,
  Fragment: 'fragment',
}

/** 装载 bundle，返回它导出的模块对象。 */
function loadBundle() {
  const code = readFileSync(new URL('client.js', ROOT), 'utf8')
  let loaded = null
  const fakeWindow = {
    __ModuleLoader__: { load: (spec) => { loaded = spec } },
  }
  // 用 Function 求值：既不值得为一次冒烟引 vm，也顺便验证产物是纯表达式。
  const evaluate = new Function('window', 'document', 'console', 'require', code)
  evaluate(fakeWindow, undefined, console, (name) => {
    if (name === 'react') return React
    throw new Error(`bundle 只允许 require('react')，实际 require('${name}')`)
  })

  assert.ok(loaded, 'bundle 没有调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-reading', 'loader id 必须是 dsh-reading')
  assert.equal(typeof loaded.factory, 'function', 'loader 必须带 factory')

  return loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`factory 只允许 require('react')，实际 require('${name}')`)
  })
}

export default async function run() {
  const api = loadBundle()

  assert.equal(typeof api.apply, 'function', '没有导出 apply')
  assert.ok(Array.isArray(api.inject), 'inject 必须是静态数组（宿主要静态读它）')
  assert.ok(api.inject.includes('slots'), `inject 应包含 slots，实际 ${JSON.stringify(api.inject)}`)

  // ── 1. 正常宿主：两处座位都要注册上 ──
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject: (key, fn) => { injections.push(key); fn(); return () => {} },
      register: (entry, component) => { registrations.push({ entry, component }); return () => {} },
    },
    effect: (fn) => { const dispose = fn(); return () => (typeof dispose === 'function' ? dispose() : undefined) },
  }

  api.apply(ctx)

  assert.ok(injections.includes('main'), `缺 main 座位注册（实际 ${JSON.stringify(injections)}）`)
  assert.ok(injections.includes('sidebar.panellist'), `缺 sidebar.panellist 座位注册（实际 ${JSON.stringify(injections)}）`)
  assert.equal(registrations.length, 2, `应当注册 2 个组件，实际 ${registrations.length}`)

  for (const { entry, component } of registrations) {
    assert.equal(typeof component, 'function', `座位 ${entry.name} 的组件不是函数`)
    // 侧栏图标要有 order 和 label，主面板要有 key —— 外壳靠这些排座位
    if (entry.name === 'sidebar.panellist') {
      assert.equal(typeof entry.order, 'number', '侧栏图标必须给 order')
      assert.equal(typeof entry.label, 'function', '侧栏图标必须给 label()')
      assert.equal(entry.id, 'dsh-reading', '侧栏面板 id 必须与插件同名')
    }
    if (entry.name === 'main') {
      assert.equal(typeof entry.key, 'string', '主面板必须给 key')
    }
  }

  // ── 2. 没有 slots 服务的宿主：安静退化，不抛 ──
  api.apply({ effect: (fn) => fn(), slots: undefined })
}
