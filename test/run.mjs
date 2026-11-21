#!/usr/bin/env node
/**
 * 统一测试入口。
 *
 * 为什么不做成「遍历 test/*.mjs」：目录遍历顺序不保证，出了问题也难定位；
 * 而且三方并行开发时，各自加的测试文件必须能被独立发现。
 *
 * 这里用「按名单加载 + 缺失即 SKIP」：名单固定，缺文件不报错、只打印 SKIP，
 * 这样 A 的测试文件还没落地时，B 也能跑自己的部分。
 *
 * 约定：每个 *_test.mjs 必须导出 `export default async function run()`，
 * 内部用 assert 断言；抛错即失败。也接受 `export async function run()`。
 *
 * 开发依赖缺失（jsdom / ajv）时，相关测试记为 SKIP 而不是 FAIL：插件本身
 * 零运行时依赖，陌生人只 clone 不 `npm install` 也该能跑通不需要 devDeps 的那部分，
 * 而不是被三条红色报错吓到以为仓库坏了。CI 装了 devDeps，所以 CI 仍然全跑。
 *
 * 用法：node test/run.mjs [过滤子串]
 */

import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 测试文件名单（顺序即执行顺序；基础层在前）。 */
const SUITES = [
  // 宿主侧（maker-core）
  'zip_test.mjs',
  'xml_test.mjs',
  'epub_test.mjs',
  'txt_test.mjs',
  'mobi_test.mjs',
  'pdf_test.mjs',
  'paper_test.mjs',
  // 文献集造书（题录 → EPUB 的纯函数 + 入书架，不联网）
  'papercollect_test.mjs',
  'bookformat_test.mjs',
  'store_test.mjs',
  'routes_test.mjs',
  // 「找书」纯函数层（模板拼接 / 候选抽取 / 文件名猜测，不联网）
  'source_test.mjs',
  // 导入书源之后顺手清一次：引用保护优先于「用不了 / 停用」（0.13.1）
  'legado_prune_test.mjs',
  // 搜书四层静默失败：只试前 6 个源 / 尾部配置没拆 / body 当 GET / 结果没净化（0.13.2）
  'legado_search_test.mjs',
  // 知网检索层（HTML → 题录的纯函数 + 可注入 fetch 的网络层，不联网）
  'cnki_test.mjs',
  'legado_test.mjs',
  'shelf_ui_test.mjs',
  // 知网检索界面的纯函数层（题名归一 / 角标判定 / 题录拼装，不联网）
  'cnki_ui_test.mjs',
  'layout_css_test.mjs',
  'frame_metrics_test.mjs',
  'contrast_test.mjs',
  // 深色主题：写错的变量名会静默失效，靠对比度测试查不出来（0.13.1）
  'dark_test.mjs',
  // 错误码 → 人话：没收录的码也要能把后半句放出来（0.13.1）
  'humanize_test.mjs',
  'search_test.mjs',
  'meta_test.mjs',
  'coach_skill_test.mjs',
  'skill_bundle_test.mjs',
  'ask_presets_test.mjs',
  'ai_test.mjs',
  'aimodel_test.mjs',
  'distill_ui_test.mjs',
  // Obsidian 笔记：锚块协议（纯函数）+ 库读写（临时目录，不碰真库）
  'blocks_test.mjs',
  'vault_test.mjs',
  'notesync_test.mjs',
  'notes_routes_test.mjs',
  // 问完一句，笔记自己长出来（L0 自动归位）
  'notes_autowrite_test.mjs',
  // 读者画像：从「问 AI」的记录里读出这位读者怎么读（纯函数 + 缓存）
  'profile_test.mjs',
  // 画像真的进了蒸馏 prompt、缓存真的按条数失效（走路由）
  'profile_routes_test.mjs',
  // 人物关系：判据只认分类、每条边回源核对、失败也落盘（走路由，模型用桩）
  'relations_test.mjs',
  // 跨书主题：抽词只留实词、三道门槛、立页只追加讨论记录、总览往返（走路由）
  'threads_test.mjs',
  // 锚点核心（maker-anchor）
  'cfi_test.mjs',
  'contract_test.mjs',
  'schema_parity_test.mjs',
  // 客户端（maker-client）
  'client_build_test.mjs',
  'client_apply_test.mjs',
  'dom_immutability_test.mjs',
  'menu_geometry_test.mjs',
  'annotation_overlap_test.mjs',
  // 端到端（captain）
  'e2e_local_test.mjs',
]

/** 只在开发期用到的包；缺了应当 SKIP，不该让整仓看起来是坏的。 */
const DEV_ONLY = ['jsdom', 'ajv']

/** 错误是否只是「没装开发依赖」。 */
function missingDevDependency(error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') return null
  const text = String(error?.message ?? '')
  // 只认**开发依赖**缺失；其它模块找不到仍然是真失败（多半是写错了 import）。
  return DEV_ONLY.find((name) => text.includes(`'${name}'`) || text.includes(`"${name}"`)) ?? null
}

const filter = process.argv[2] ?? ''

let pass = 0
let skip = 0
const failures = []
const skipped = []

for (const name of SUITES) {
  if (filter && !name.includes(filter)) continue
  const file = join(HERE, name)
  if (!existsSync(file)) {
    console.log(`SKIP ${name}（文件不存在）`)
    skip += 1
    skipped.push({ name, reason: '文件不存在' })
    continue
  }
  const started = Date.now()
  try {
    const mod = await import(pathToFileURL(file).href)
    const run = mod.default ?? mod.run
    if (typeof run !== 'function') throw new Error(`${name} 没有导出 default/run 函数`)
    await run()
    const ms = Date.now() - started
    console.log(`PASS ${name} (${ms}ms)`)
    pass += 1
  } catch (error) {
    const missing = missingDevDependency(error)
    if (missing) {
      // import 失败发生在模块加载阶段，等价于「这条测试没跑」，不是断言失败。
      console.log(`SKIP ${name}（未安装开发依赖 ${missing}，跑 npm install 后可用）`)
      skip += 1
      skipped.push({ name, reason: `未安装开发依赖 ${missing}` })
      continue
    }
    const ms = Date.now() - started
    console.log(`FAIL ${name} (${ms}ms)`)
    console.log(`     ${error?.stack ?? error}`)
    failures.push({ name, error })
  }
}

console.log('')
console.log(`汇总：${pass} 通过 / ${failures.length} 失败 / ${skip} 跳过`)
if (skipped.length > 0) {
  for (const { name, reason } of skipped) console.log(`  跳过：${name} — ${reason}`)
}

if (failures.length > 0) {
  for (const { name, error } of failures) {
    console.log(`  失败：${name} — ${String(error?.message ?? error).split('\n')[0]}`)
  }
  process.exitCode = 1
} else if (pass === 0) {
  console.log('一个测试都没跑到，视为失败')
  process.exitCode = 1
}
