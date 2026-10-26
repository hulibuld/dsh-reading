/**
 * dsh-reading —— 宿主侧入口。
 *
 * 三件事：
 *   1. 声明插件身份与依赖的服务（`webServer`）；
 *   2. 声明配置 schema（**必须是 schemastery**，普通对象会让插件静默不激活，
 *      报错是 `Cannot read properties of undefined (reading 'validate')`，docs/05 §10 坑 1）；
 *   3. 在 `ctx.effect` 里注册**一条** prefix 路由 `/api/dsh-reading`，返回 disposer。
 *
 * 业务逻辑全在 lib/ 里：这里只做装配。没有 UI、没有会话事件、没有工具。
 *
 * 为什么 `apply` 不 await 顶层 IO：cordis 的 apply 是同步装配阶段，在里面 await
 * 会把插件加载拖进不确定状态；书库目录与 deviceId 都在第一次请求时惰性初始化。
 *
 * 什么时候会失败、失败给谁看：
 *   - 缺 `webServer` 服务 → cordis 不会加载本插件（`inject` 声明了它），不会半死；
 *   - 书库目录不可写 → 首次请求返回 500，界面提示重试，日志里有具体原因；
 *   - 装配阶段的异常一律 console.warn 一次，不刷屏（docs/05 §3.1）。
 */

import z from '@deepseek-ai/schemastery'
import { LibraryStore } from './lib/store.js'
import { registerRoutes, createHandler } from './lib/routes.js'
import { createAskService } from './lib/ask.js'
import { createAiCallLog, withAiLog } from './lib/aicall.js'
import { describeAiStatus } from './lib/aistatus.js'
import { DEFAULT_LIBRARY_DIR } from './lib/paths.js'

/** 插件名。与 package.json 的 `name` 一致，也是 cordis 里的行标识。 */
export const name = 'dsh-reading'

/**
 * 依赖的宿主服务。缺 `webServer` 就明确失败，不做半死状态——
 * 声明在 inject 里，cordis 会在服务可用后才调用 apply。
 */
export const inject = ['webServer']

/**
 * 插件配置。
 *
 * `libraryDir` 空串 = 用默认目录（`~/.dsh-reading`）。默认值写死在这里而不是
 * 每次运行时再兜底，是为了让配置表单里一眼能看出「不填会落在哪」。
 * `maxImportBytes` 默认 200 MB：足够放下绝大多数 EPUB，又不至于让一次 base64
 * 请求撑爆内存。
 */
export const Config = z.object({
  libraryDir: z.string().default('').description('书库根目录，留空则使用默认目录'),
  maxImportBytes: z.number().default(200 * 1024 * 1024).description('单本书导入大小上限（字节）'),
})

/** 每个 profile 只允许一个实例：两个实例会抢同一个书库目录与同一批 history 文件。 */
let activeStore = null

/**
 * 插件装配。
 *
 * `ctx` 是宿主注入的 Cordis Context；本插件只用到它提供的 `webServer.register`。
 * 这里故意不写 Cordis 的类型注解：Cordis 由宿主提供，写成 import 类型会让静态检查
 * 认为本包依赖它，而本包既不需要也无法声明这条依赖。
 *
 * @param {{ webServer: { register: (options: object) => () => void } }} ctx
 * @param {{ libraryDir?: string, maxImportBytes?: number }} config - 已过 schema 校验的配置
 */
export function apply(ctx, config) {
  const resolved = config ?? {}
  const libraryDir = typeof resolved.libraryDir === 'string' ? resolved.libraryDir.trim() : ''
  const maxImportBytes =
    Number.isFinite(resolved.maxImportBytes) && resolved.maxImportBytes > 0 ? resolved.maxImportBytes : undefined

  const store = new LibraryStore({
    libraryDir,
    maxImportBytes,
    logger: console,
  })
  if (activeStore !== null && activeStore !== store) {
    // 不是错误：热重载会新建实例。只提示一句，别让用户以为坏了两份数据。
    console.warn('[dsh-reading] 检测到新的插件实例，旧实例的缓存已释放。')
  }
  activeStore = store

  // 「圈住一段话问 AI」走宿主自己的子代理机制（见 lib/ask.js 顶部说明）。
  // 这里只是把它造出来；真正不可用时是请求期返回 503，不影响插件加载。
  const askService = createAskService({ ctx, store, logger: console })
  // 每次 AI 调用都记账（成功也记，才能看出「最近是好的」还是「一直在挂」）。
  const aiLog = createAiCallLog({ paths: store.paths, logger: console })
  const ask = withAiLog(askService, aiLog)

  ctx.effect(
    () =>
      registerRoutes(ctx, {
        store,
        logger: console,
        ask,
        aiLog,
        aiStatus: () => describeAiStatus({ ctx, log: aiLog }),
        config: { libraryDir: libraryDir === '' ? DEFAULT_LIBRARY_DIR : libraryDir },
      }),
    'dsh-reading: /api/dsh-reading 路由',
  )
}

/**
 * 测试与诊断用：按同一份配置造一个「没挂到 webServer 上」的 handler。
 * 生产路径永远走 `apply`；这个导出只是为了让集成测试不启端口也能跑通整条链路。
 *
 * @param {{ libraryDir?: string, maxImportBytes?: number, deviceId?: string, now?: () => string }} [options]
 */
export function createStandaloneHandler(options = {}) {
  const store = new LibraryStore({ ...options, logger: console })
  return { store, handler: createHandler({ store, logger: console }) }
}
