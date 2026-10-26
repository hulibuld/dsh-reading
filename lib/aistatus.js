/**
 * aistatus.js —— 「AI 到底能不能用、为什么不能用」的诊断。
 *
 * 背景（用户 m02260）：插件里的 AI 调用失败时，界面只给一句「问不了 AI」，
 * 用户既不知道是本机没网、宿主没开会话、还是模型供应商挂了，只能一遍遍重试。
 *
 * 这里把判断拆成四道可独立成立的检查，每道都给「怎么修」：
 *
 *   1. 子代理服务是否存在（宿主版本问题）
 *   2. 服务是否提供 startActivation（宿主 API 变更）
 *   3. 有没有活着的会话能当 parent（用户还没开对话）
 *   4. 拿不拿得到 provider/model（模型没配、额度没了、供应商列表空）
 *
 * 再加一次**真实**探测（`probeAi`）：发一句极小的话，测的是网络与供应商，
 * 不是本机配置。两类信息合起来，用户才知道该修哪里。
 */

import { resolveRoute } from './ask.js'

/** 真实探测用的 prompt：短、确定、不依赖上下文。 */
const PROBE_PROMPT = '只回复两个字：可用'

/** 探测超时。比正常调用短：自检不该让用户等 90 秒。 */
const PROBE_TIMEOUT_MS = 25_000

/** 一句人话的修复建议。界面上直接显示，别让用户去猜。 */
const FIXES = {
  service: '这个 DSH 版本没有给插件提供子代理服务。先升级 DeepSeek Harness 再试。',
  startActivation: '宿主的子代理接口变了（缺 startActivation）。升级 DSH，或等插件更新。',
  session: '先在左边随便开一个对话、发一句话，让 DSH 有一个活动会话，再回来用 AI。',
  route: '拿不到可用的模型：去 DSH 设置里检查模型供应商是否配好、额度是否还有。',
  probe: '本机连不上模型服务：检查网络，或换个供应商再试。',
}

const CHECK_TITLES = {
  service: '子代理服务',
  startActivation: '子代理接口',
  session: '活动会话',
  route: '模型路由',
}

/**
 * 只读状态：不发请求，回答「配置上通不通」。
 *
 * @param {{ ctx: object, log?: object }} deps
 */
export function describeAiStatus({ ctx, log = null } = {}) {
  const checks = []
  let subagents = null
  try {
    subagents = ctx && typeof ctx.get === 'function' ? ctx.get('subagents', false) : null
  } catch {
    subagents = null
  }

  checks.push({
    id: 'service',
    title: CHECK_TITLES.service,
    ok: Boolean(subagents),
    detail: subagents ? '宿主已提供子代理服务' : '宿主没有 subagents 服务',
    fix: FIXES.service,
  })

  const hasStart = Boolean(subagents && typeof subagents.startActivation === 'function')
  checks.push({
    id: 'startActivation',
    title: CHECK_TITLES.startActivation,
    ok: hasStart,
    detail: hasStart ? '可以发起子代理调用' : '缺 startActivation 方法',
    fix: FIXES.startActivation,
  })

  let route = null
  try {
    route = subagents ? resolveRoute(ctx) : null
  } catch {
    route = null
  }

  const hasSession = Boolean(route && route.parent)
  checks.push({
    id: 'session',
    title: CHECK_TITLES.session,
    ok: hasSession,
    detail: hasSession ? '有活动会话可以挂载' : '没有活动会话',
    fix: FIXES.session,
  })

  const provider = route && typeof route.provider === 'string' ? route.provider : ''
  const model = route && typeof route.model === 'string' ? route.model : ''
  const hasRoute = provider !== '' && model !== ''
  checks.push({
    id: 'route',
    title: CHECK_TITLES.route,
    ok: hasRoute,
    detail: hasRoute ? `${provider} / ${model}` : '没解析出可用的 provider/model',
    fix: FIXES.route,
  })

  return {
    available: checks.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    provider,
    model,
    checks,
    log: log && typeof log.file === 'string' ? { file: log.file } : null,
  }
}

/**
 * 真实探测：发一句极小的话，量一次往返。
 *
 * 结果形状固定 `{ ok, latencyMs, model, answer?, code?, message?, fix? }`，
 * 界面直接照着显示，不再二次判断。
 *
 * @param {{ ask: object|null }} deps
 */
export async function probeAi({ ask } = {}) {
  if (!ask || typeof ask.complete !== 'function') {
    return {
      ok: false,
      latencyMs: 0,
      model: '',
      code: 'E_AI_UNAVAILABLE',
      message: '这个版本的宿主没有提供子代理服务，暂时用不了 AI。',
      fix: FIXES.service,
    }
  }
  const startedAt = Date.now()
  try {
    // 传最少的上下文：探测只需要「能不能通」。
    const result = await ask.complete({
      prompt: PROBE_PROMPT,
      label: '连通性自检',
      kind: 'probe',
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const answer = typeof result === 'string' ? result : result && result.answer
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: (result && typeof result === 'object' && typeof result.model === 'string' ? result.model : '') || '',
      answer: typeof answer === 'string' ? answer.slice(0, 200) : '',
      fix: '',
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: '',
      code: typeof error?.code === 'string' ? error.code : 'E_UNKNOWN',
      message: String(error?.message ?? error ?? '未知错误'),
      fix: FIXES.probe,
    }
  }
}
