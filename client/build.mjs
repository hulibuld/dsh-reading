#!/usr/bin/env node
/**
 * client/build.mjs —— 把 client/src/*.js 拼成 client.js（无打包器）。
 *
 * 为什么不用打包器：这个仓库的运行时依赖必须是零。为十来个纯 ES 模块引入
 * esbuild / rollup，会让「clone 下来就能装」变成「先装一条构建链」。所以走构期拼接：
 *
 *   源头是 client/src/*.js（人能读、能被 node 直接 import 测）；
 *   产物是 client.js（浏览器半，提交进仓库，形状固定为 __ModuleLoader__.load({...})）。
 *
 * 三道防线（都是「静默损坏」的实际教训，不是洁癖）：
 *   1. **按行扫描 + 状态机**剥 import/export，不用裸正则。
 *      正文里有模板字符串、注释、docblock 示例；`/^export\s+/gm` 会把它们一起吃掉的
 *      时候，node --check 还是绿的，只是某个函数静默少了几个字。
 *   2. **每个模块包在自己的 IIFE 里**，只把 exports 交出去。
 *      拼接是同一个函数作用域，两个模块各有一个 `parse` / `partsToString` 就会互相遮蔽，
 *      而且这种遮蔽在产物里完全看不出来。IIFE 让「同名」变成不可能。
 *   3. 产物生成后**真的求值一遍**：`new Function` 过语法，再用假 React 调一次 factory，
 *      捕获顶层 ReferenceError（拼错模块名、用了没导入的东西，都会在这一步炸）。
 *
 * 用法：
 *   node client/build.mjs           # 生成 client.js
 *   node client/build.mjs --check   # 只校验磁盘上的 client.js 与源码同步（CI / pre-commit 用）
 */

import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC_DIR = join(HERE, 'src')
const OUT_FILE = join(ROOT, 'client.js')
const VENDOR_FILE = join(HERE, 'vendor', 'epubcfi.foliate.js')

/**
 * 模块顺序**写死**，不用 readdir。
 *
 * 目录遍历顺序不保证，顺序一变 `--check` 就会随机变红；更糟的是模块之间有下行依赖
 * （reader 用 cfi，annotate 用 contract），顺序错了运行期才炸。
 * 这份名单与 docs/05 §5.1 完全一致。
 */
const MODULES = [
  'sha256.js',
  'cfi.js',
  'contract.js',
  'api.js',
  'style.js',
  'search.js',
  'ai.js',
  'legado-ui.js',
  'shelf.js',
  'toc.js',
  'distill.js',
  'reader.js',
  'annotate.js',
  'style-qa.js',
  'app.js',
]

/** 允许 import vendor 的唯一模块。别处出现 vendor import 直接构建失败。 */
const VENDOR_OWNER = 'cfi.js'

/** 浏览器半的模块 id，必须与 package.json 的 name 一致。 */
const LOADER_ID = 'dsh-reading'

/**
 * 构建期前导：给所有模块用的宿主能力。
 *
 * 这些名字由构建注入，源码里**不要重复声明**。React 来自宿主（factory 的 require），
 * 不 require 任何 @deepseek-ai/* 包 —— 拿不到，而且会把整个 slot 搞白。
 */
const PRELUDE = [
  "var React = require('react')",
  'var h = React.createElement',
  'var useState = React.useState',
  'var useEffect = React.useEffect',
  'var useLayoutEffect = React.useLayoutEffect || React.useEffect',
  'var useRef = React.useRef',
  'var useMemo = React.useMemo',
  'var useCallback = React.useCallback',
]

/** 构建失败时统一抛这个，方便 --check 打印一行说清楚。 */
class BuildError extends Error {}

// ────────────────────────────────────────────────────────────────────────────
// 行扫描状态机
// ────────────────────────────────────────────────────────────────────────────

/**
 * 推进一行的词法状态。
 *
 * 只跟踪「这一行结束时是否还在块注释 / 模板字符串里」——这已经足够判断下一行
 * 是否处于「语句开头」，而 import/export 只可能出现在语句开头。
 * 正则字面量里的引号会让这个近似失准，但失准的后果是「本该处理的 export 没被处理」，
 * 会被最后那条「产物里不许残留 export」的断言抓住，不会静默放行。
 *
 * @param {string} line
 * @param {{ inBlock: boolean, inTemplate: boolean }} state 会被就地修改
 */
function advanceState(line, state) {
  let i = 0
  while (i < line.length) {
    const ch = line[i]

    if (state.inBlock) {
      if (ch === '*' && line[i + 1] === '/') {
        state.inBlock = false
        i += 2
        continue
      }
      i += 1
      continue
    }

    if (state.inTemplate) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '`') {
        state.inTemplate = false
        i += 1
        continue
      }
      i += 1
      continue
    }

    if (ch === '/' && line[i + 1] === '*') {
      state.inBlock = true
      i += 2
      continue
    }
    // 行注释：后面的内容对「下一行状态」没有影响
    if (ch === '/' && line[i + 1] === '/') return
    if (ch === '`') {
      state.inTemplate = true
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2
          continue
        }
        if (line[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    i += 1
  }
}

/**
 * 解析 import 语句（**支持跨行**）。
 *
 * 为什么必须支持跨行：具名导入一多，格式化工具就会折行。构建器如果只认单行，
 * 第一个折行的人就会撞上一次「构建失败但代码没错」，然后所有人开始迁就构建器。
 * 所以这里按行累积，直到拼出一个完整的 import 语句再解析。
 *
 * @param {string} source 可能跨多行的 import 文本（已去掉首尾空白）
 * @param {string} file
 * @param {number} lineNo
 * @returns {{clause:string, specifier:string, namespace?:string, pairs?:Array<{imported:string,local:string}>}}
 */
function parseImportStatement(source, file, lineNo) {
  const fail = (why) => {
    throw new BuildError(`${file}:${lineNo} import 语句无法解析（${why}）：${source}`)
  }

  const flat = source.replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim()

  // 副作用 import：import './x.js'
  const bare = /^import\s+(['"])([^'"]+)\1$/.exec(flat)
  if (bare) return { clause: '', specifier: bare[2] }

  const withFrom = /^import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2$/.exec(flat)
  if (!withFrom) fail('缺少 from')
  const clause = withFrom[1].trim()
  const specifier = withFrom[3]

  // import * as NS from '...'
  const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause)
  if (ns) return { clause: 'namespace', specifier, namespace: ns[1] }

  // import { a, b as c } from '...'
  const named = /^\{([\s\S]*)\}$/.exec(clause)
  if (named) {
    const pairs = []
    for (const part of named[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t)
      if (as) {
        pairs.push({ imported: as[1], local: as[2] })
        continue
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(t)) fail(`不认识的名字 "${t}"`)
      pairs.push({ imported: t, local: t })
    }
    return { clause: 'named', specifier, pairs }
  }

  if (/^[A-Za-z_$][\w$]*$/.test(clause)) {
    fail('默认导入（default）没有约定，请改成 import * as NS 或具名导入')
  }
  return fail('不支持的 import 组合（如 默认导入 + 具名导入）')
}

/**
 * 去掉行首的 `export` 关键字。**不用正则**。
 *
 * 为什么要较真：`/^export\s+/` 看起来只匹配行首，但一个 `.replace()` 只要被用在
 * 「整个文件」上，模板字符串里以 `export ` 开头的一行就会被静默吃掉——语法还是对的，
 * 只是某个函数的说明文字少了几个词。所以这里只接受「调用方已经确认这是语句开头」
 * 的单行输入，并且用切片而不是替换，把「只动前缀」这件事写成不可误用的形式。
 *
 * @param {string} line 已是语句开头的一行
 * @returns {string} 去掉 export 关键字与随后的空白
 */
function stripExportKeyword(line) {
  const start = line.length - line.trimStart().length
  if (line.slice(start, start + 6) !== 'export') return line
  let at = start + 6
  while (at < line.length && (line[at] === ' ' || line[at] === '\t')) at += 1
  return line.slice(0, start) + line.slice(at)
}

/** 累积起来的一段文本是否已经是一条完整的 import 语句。 */
function isCompleteImport(source) {
  const flat = source.replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim()
  return /^import\s+(['"])[^'"]+\1$/.test(flat)
    || /^import\s+.+\s+from\s+(['"])[^'"]+\1$/.test(flat)
}

/**
 * 把单个源模块转成「IIFE 体 + 导出表」。
 *
 * @param {string} code
 * @param {string} file 用于报错的相对路径
 * @param {Map<string, { order:number, exports: Map<string,string>, namespace:string }>} registry
 * @returns {{ body:string, exportMap: Map<string,string>, source:string }}
 */
export function transformModule(code, file, registry) {
  const lines = code.split('\n')
  const out = []
  const exportMap = new Map() // exportedName -> localName
  const state = { inBlock: false, inTemplate: false }
  let vendorBody = null

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx]
    const lineNo = idx + 1
    const atStatementStart = !state.inBlock && !state.inTemplate
    const trimmed = raw.trimStart()

    if (atStatementStart && /^import\b/.test(trimmed)) {
      // 累积到语句完整为止：具名导入一多就会被格式化工具折行
      let statement = trimmed
      let consumed = idx
      while (!isCompleteImport(statement)) {
        consumed += 1
        if (consumed >= lines.length) {
          throw new BuildError(`${file}:${lineNo} import 语句没有结束`)
        }
        statement += `\n${lines[consumed].trim()}`
      }
      idx = consumed

      const spec = parseImportStatement(statement, file, lineNo)

      const isVendor = /vendor[\\/]epubcfi(?:\.foliate)?\.js$/.test(spec.specifier)
      const isSibling = spec.specifier.startsWith('./')

      if (!isVendor && !isSibling) {
        throw new BuildError(
          `${file}:${lineNo} 引用了外部包 "${spec.specifier}"。` +
            '浏览器半不许 import 任何 npm 包（宿主只给 react）；' +
            '需要的能力自己写进 client/src/。',
        )
      }

      if (isVendor) {
        if (file !== VENDOR_OWNER) {
          throw new BuildError(
            `${file}:${lineNo} 只有 ${VENDOR_OWNER} 可以 import vendor；` +
              '别的模块请通过 cfi.js 暴露的函数间接使用。',
          )
        }
        if (!existsSync(VENDOR_FILE)) {
          throw new BuildError(`缺少 vendor 文件：${relative(ROOT, VENDOR_FILE)}`)
        }
        if (vendorBody === null) {
          const vendorCode = readFileSync(VENDOR_FILE, 'utf8')
          vendorBody = transformVendor(vendorCode)
        }
        out.push(...vendorNamespaceLines(vendorBody, spec, file, lineNo))
        advanceState(raw, state)
        continue
      }

      // 兄弟模块：必须已在名单里，且必须排在本模块之前，否则运行时读到空对象
      const siblingFile = spec.specifier.slice(2)
      const known = registry.get(siblingFile)
      if (!known) {
        throw new BuildError(
          `${file}:${lineNo} import 了 "${spec.specifier}"，但它不在构建名单里或排在后面。` +
            `名单顺序：${MODULES.join(' → ')}`,
        )
      }

      if (spec.clause === 'namespace') {
        out.push(`      const ${spec.namespace} = ${known.namespace}`)
      } else if (spec.clause === 'named') {
        for (const pair of spec.pairs) {
          if (!known.exports.has(pair.imported)) {
            throw new BuildError(
              `${file}:${lineNo} 从 ${siblingFile} 导入了 "${pair.imported}"，但它没有导出这个名字。` +
                `${siblingFile} 的导出：${[...known.exports.keys()].join(', ') || '（无）'}`,
            )
          }
          out.push(`      const ${pair.local} = ${known.namespace}.${pair.imported}`)
        }
      } else {
        // import './x.js' 只为副作用：拼接后本来就已经执行过了，什么都不用做
        out.push(`      // （副作用 import 已由拼接顺序保证：${spec.specifier}）`)
      }
      advanceState(raw, state)
      continue
    }

    if (atStatementStart && /^export\b/.test(trimmed)) {
      const rest = stripExportKeyword(trimmed)

      if (/^default\b/.test(rest)) {
        throw new BuildError(`${file}:${lineNo} 不支持 export default；请用具名导出`)
      }
      if (/^\*/.test(rest)) {
        throw new BuildError(`${file}:${lineNo} 不支持 export *；请逐个具名导出`)
      }

      const fn = /^(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(rest)
      if (fn) {
        exportMap.set(fn[2], fn[2])
        out.push(stripExportKeyword(raw))
        advanceState(raw, state)
        continue
      }
      const decl = /^(const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(rest)
      if (decl) {
        exportMap.set(decl[2], decl[2])
        out.push(stripExportKeyword(raw))
        advanceState(raw, state)
        continue
      }
      const cls = /^class\s+([A-Za-z_$][\w$]*)/.exec(rest)
      if (cls) {
        exportMap.set(cls[1], cls[1])
        out.push(stripExportKeyword(raw))
        advanceState(raw, state)
        continue
      }
      const named = /^\{([\s\S]*)\}\s*;?\s*$/.exec(rest)
      if (named) {
        for (const part of named[1].split(',')) {
          const t = part.trim()
          if (!t) continue
          const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t)
          if (as) {
            exportMap.set(as[2], as[1])
          } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
            exportMap.set(t, t)
          } else {
            throw new BuildError(`${file}:${lineNo} export { ... } 里有不认识的名字 "${t}"`)
          }
        }
        // 导出别名不需要额外语句：返回对象里直接写 导出名: 本地名
        advanceState(raw, state)
        continue
      }

      throw new BuildError(`${file}:${lineNo} 无法转换的 export 语法：${trimmed}`)
    }

    out.push(raw)
    advanceState(raw, state)
  }

  const body = out.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { body, exportMap, source: code }
}

/**
 * vendor 是 ESM（`export const parse = ...`）。它必须被包在**自己的 IIFE** 里：
 * 它内部有 parse / toRange / partsToString / getChildNodes 这类通用名，
 * 直接摊进外层作用域会和 cfi.js 自己的辅助函数撞车，而撞车的表现是「某个函数被换成了别的实现」，
 * 拼写检查一个都不会报。
 */
function transformVendor(code) {
  const lines = code.split('\n')
  const out = []
  const names = []
  const state = { inBlock: false, inTemplate: false }
  for (const raw of lines) {
    const trimmed = raw.trimStart()
    if (!state.inBlock && !state.inTemplate && /^export\b/.test(trimmed)) {
      const rest = stripExportKeyword(trimmed)
      const decl = /^(const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(rest)
      if (decl) {
        names.push(decl[2])
        out.push(stripExportKeyword(raw))
        advanceState(raw, state)
        continue
      }
      const fn = /^(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(rest)
      if (fn) {
        names.push(fn[2])
        out.push(stripExportKeyword(raw))
        advanceState(raw, state)
        continue
      }
      const named = /^\{([\s\S]*)\}\s*;?\s*$/.exec(rest)
      if (named) {
        for (const part of named[1].split(',')) {
          const t = part.trim()
          if (!t) continue
          const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t)
          names.push(as ? as[2] : t)
        }
        advanceState(raw, state)
        continue
      }
      throw new BuildError(`vendor 有无法转换的 export：${trimmed}`)
    }
    out.push(raw)
    advanceState(raw, state)
  }
  if (names.length === 0) throw new BuildError('vendor 里一个导出都没找到，文件是不是坏的？')
  return { body: out.join('\n').replace(/\s+$/, ''), names }
}

/** vendor 的 import 行替换成：包起来的 IIFE + 绑到 import 写的名字上。 */
function vendorNamespaceLines(vendor, spec, file, lineNo) {
  const lines = []
  const ns = spec.clause === 'namespace' ? spec.namespace : null
  lines.push('      // ── vendor/epubcfi.foliate.js（原样内联，MIT，见 client/vendor/ 头部） ──')
  lines.push('      const __vendor = (function () {')
  lines.push(vendor.body)
  lines.push(`        return { ${vendor.names.map((n) => `${n}: ${n}`).join(', ')} }`)
  lines.push('      })()')
  if (ns) {
    lines.push(`      const ${ns} = __vendor`)
  } else if (spec.clause === 'named') {
    for (const pair of spec.pairs) {
      if (!vendor.names.includes(pair.imported)) {
        throw new BuildError(
          `${file}:${lineNo} 从 vendor 导入了 "${pair.imported}"，但 vendor 里没有这个名字。`,
        )
      }
      lines.push(`      const ${pair.local} = __vendor.${pair.imported}`)
    }
  } else {
    throw new BuildError(
      `${file}:${lineNo} vendor 只能 import * as NS 或具名导入（副作用 import 没有意义）`,
    )
  }
  return lines
}

// ────────────────────────────────────────────────────────────────────────────
// 组装
// ────────────────────────────────────────────────────────────────────────────

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n')
}

/**
 * 生成 client.js 全文。
 * @returns {string}
 */
export function buildClient() {
  const missing = MODULES.filter((name) => !existsSync(join(SRC_DIR, name)))
  if (missing.length > 0) {
    throw new BuildError(
      `缺少源模块：${missing.join(', ')}。` +
        '这些文件由其他实现者提供（锚点核心：sha256/cfi/contract），缺一个都不能出产物。',
    )
  }

  const registry = new Map()
  const chunks = []
  const header = [
    '/**',
    ' * dsh-reading · 浏览器半 —— **构建产物，不要手改**。',
    ' *',
    ' * 由 `node client/build.mjs` 从下列源文件拼成（顺序即依赖顺序）：',
    ...MODULES.map((name) => ` *   client/src/${name}`),
    ' *',
    ' * 要改行为请改 client/src/ 下对应文件，然后重新构建；',
    ' * `node client/build.mjs --check` 会在产物与源码不同步时失败。',
    ' *',
    ' * 四条硬约束（违反会白屏或崩掉整个 slot）：',
    ' *   1. 不 require 任何 @deepseek-ai/dsh-client-* 包，只用宿主给的 react；',
    ' *   2. 插件自己的界面全是 slot 里的 React 组件，iframe 只用于书籍正文视口；',
    ' *   3. 不在组件外写 DOM、不往 document.body 追加节点；',
    ' *   4. 组件抛错会让这条 entry 退役（面板静默消失），所以渲染路径上不许有会抛的表达式。',
    ' */',
    'window.__ModuleLoader__.load({',
    `  id: '${LOADER_ID}',`,
    '  factory: (require) => {',
    "    var module = { exports: {} }",
    '    var exports = module.exports',
    '',
    '    // ── 构建期前导（源码里不要重复声明这些名字） ──',
    ...PRELUDE.map((line) => `    ${line}`),
    '',
  ].join('\n')

  for (const name of MODULES) {
    const filePath = join(SRC_DIR, name)
    const code = readFileSync(filePath, 'utf8')
    const { body, exportMap } = transformModule(code, name, registry)

    const ns = `__mod_${name.replace(/[^A-Za-z0-9_]/g, '_')}`
    registry.set(name, { namespace: ns, exports: exportMap })

    const ret = exportMap.size === 0
      ? 'return {}'
      : `return { ${[...exportMap].map(([exported, local]) => `${exported}: ${local}`).join(', ')} }`

    chunks.push(
      [
        `    // ─── client/src/${name} ───`,
        `    var ${ns} = (function () {`,
        indent(body, 6),
        '',
        `      ${ret}`,
        '    })()',
        '',
      ].join('\n'),
    )
  }

  const app = registry.get('app.js')
  if (!app) throw new BuildError('构建名单里没有 app.js，无法挂载入口')
  for (const required of ['apply', 'inject']) {
    if (!app.exports.has(required)) {
      throw new BuildError(`client/src/app.js 必须导出 ${required}（插件的入口契约）`)
    }
  }

  // 入口只认 apply / inject；其余导出原样透出去，方便调试与测试（
  // dsh-lifecard 也是这种形状：exports.apply + 面板组件本身）。
  const entryNames = ['apply', 'inject']
  const extraNames = [...app.exports.keys()].filter((name) => !entryNames.includes(name))

  const footer = [
    '    // ── 入口：宿主只认这两个名字 ──',
    ...entryNames.map((name) => `    exports.${name} = ${app.namespace}.${name}`),
    ...(extraNames.length > 0
      ? [
        '    // ── 组件也透出去（调试 / 测试用；不影响宿主的加载契约） ──',
        ...extraNames.map((name) => `    exports.${name} = ${app.namespace}.${name}`),
      ]
      : []),
    '    return module.exports',
    '  },',
    '})',
    '',
  ].join('\n')

  const output = header + chunks.join('\n') + footer
  validateOutput(output)
  return output
}

/**
 * 产物自检。任何一条不过就抛 —— 宁可构建失败，也不要交一个「装上去白屏」的 client.js。
 */
function validateOutput(output) {
  const leftover = output
    .split('\n')
    .find((line, i, all) => /^\s*export\s/.test(line) && all[i - 1] !== undefined)
  if (leftover !== undefined) {
    throw new BuildError(`产物里残留 export，转换没做完：${leftover.trim().slice(0, 120)}`)
  }

  const loaderCount = (output.match(/__ModuleLoader__\.load\(/g) || []).length
  if (loaderCount !== 1) {
    throw new BuildError(`__ModuleLoader__.load( 必须恰好出现 1 次，实际 ${loaderCount} 次`)
  }
  if (!output.includes(`id: '${LOADER_ID}'`)) {
    throw new BuildError(`产物的模块 id 不是 '${LOADER_ID}'`)
  }

  // ① 语法：先过 new Function（比 node --check 严格：只允许函数体语法）
  const factoryStart = output.indexOf('  factory: (require) => {')
  const factoryEnd = output.lastIndexOf('  },')
  if (factoryStart < 0 || factoryEnd < 0) {
    throw new BuildError('产物形状不对：找不到 factory 边界')
  }
  const factoryBody = output.slice(factoryStart + '  factory: (require) => {'.length, factoryEnd)
  let factory
  try {
    factory = new Function('require', factoryBody)
  } catch (error) {
    throw new BuildError(`产物不能被 new Function 求值：${error && error.message}`)
  }

  // ② 顶层执行：用假 React 调一次 factory，抓顶层 ReferenceError
  const stubReact = {
    createElement: () => null,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    Fragment: 'fragment',
  }
  const requireStub = (name) => {
    if (name === 'react') return stubReact
    throw new BuildError(`产物在顶层 require 了 "${name}"；浏览器半只允许 react`)
  }
  let api
  try {
    api = factory(requireStub)
  } catch (error) {
    throw new BuildError(`产物顶层执行失败：${error && error.message}`)
  }
  if (typeof api.apply !== 'function') {
    throw new BuildError('产物的 exports.apply 不是函数')
  }
  if (!Array.isArray(api.inject)) {
    throw new BuildError('产物的 exports.inject 不是数组（dsh.client.inject 必须是静态数组）')
  }
  if (!api.inject.includes('slots')) {
    throw new BuildError(`exports.inject 里没有 'slots'，实际是 ${JSON.stringify(api.inject)}`)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const check = argv.includes('--check')
  let output
  try {
    output = buildClient()
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(`构建失败：${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (check) {
    if (!existsSync(OUT_FILE)) {
      console.error('构建校验失败：client.js 不存在。先跑 node client/build.mjs')
      process.exitCode = 1
      return
    }
    const current = readFileSync(OUT_FILE, 'utf8')
    if (current !== output) {
      console.error(
        '构建校验失败：client.js 与 client/src 不同步。\n' +
          '改动源码后必须重新构建：node client/build.mjs',
      )
      process.exitCode = 1
      return
    }
    console.log(`构建校验通过：client.js 与 ${MODULES.length} 个源模块一致`)
    return
  }

  // 落盘前先自证可求值。
  //
  // 语法错了就**不要写出去**：宁可让构建失败、让 client.js 保持上一版可用状态，
  // 也不要把一份坏文件放到插件目录里 —— 宿主 file-watch 到它就会重新组合 bundle，
  // 而组合包是几十个插件共用的，一个文件坏会连累所有人（见下面原子落盘的注释）。
  try {
    // eslint-disable-next-line no-new-func
    new Function(output)
  } catch (error) {
    console.error(`构建失败：生成的 client.js 不是合法 JavaScript（未写入磁盘）。\n${error && error.message}`)
    process.exitCode = 1
    return
  }

  // 原子落盘：先写 .tmp-client.js 再 rename 覆盖。
  //
  // 为什么这次是必须的，不是讲究：DSH 桌面版会 file-watch 插件目录，
  // 正在运行时重建 client.js，watcher 可能在「写了一半」的瞬间读到文件。
  // 那一瞬间的 client.js 是**残缺的 JavaScript**，client-modules 组合出
  // 来的整包 bundle 随之求值失败，浏览器端插件全部 import 失败，
  // 严重时整个 Web 启动挂掉（本机 2026-10-23 13:54 真发生过一次）。
  // rename 在同一文件系统上原子，watcher 要么看见旧文件，要么看见完整新文件。
  const TEMP_FILE = join(ROOT, '.tmp-client.js')
  writeFileSync(TEMP_FILE, output)
  renameSync(TEMP_FILE, OUT_FILE)
  const kb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1)
  console.log(`已生成 client.js（${kb} KB，${MODULES.length} 个模块）`)
}

/**
 * 只在「直接运行时」执行 CLI。
 *
 * 测试会 `import` 本文件来测 transformModule；如果这里无条件跑 main()，
 * 一次 import 就会顺手把 client.js 重新生成一遍 —— 于是「改了源码忘了重建」
 * 这个正是 `--check` 要抓的失败模式，会被测试自己悄悄修好，`--check` 永远绿。
 * 那不是测试，那是掩盖。
 */
function isEntryModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry))
  } catch (error) {
    // 路径解析失败（符号链接、权限）时保守判断：按字符串比
    return fileURLToPath(import.meta.url) === resolve(entry)
  }
}

if (isEntryModule()) {
  main(process.argv.slice(2))
}
