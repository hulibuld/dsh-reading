/**
 * aimodel.js —— 「用哪个模型、想多深」（0.8.1）。
 *
 * 为什么要有这一层：插件里的 AI 调用（问 AI、蒸一章）以前一律跟随宿主默认模型。
 * 用户要的是能自己挑：读闲书时用便宜快的，蒸一本书时换强的、把思考强度调到 high。
 *
 * 三条设计约束：
 *
 *   1. **不自己发明模型名单**。名单从宿主的 `sessionController.modelCatalog()` 读，
 *      它和主界面输入框那个模型选择器是同一份；读不到就老实说「宿主没给名单」，
 *      不内置一份迟早过期的硬编码列表。
 *   2. **强度不能硬塞**。每个模型自己声明它支持哪几档（`reasoning.efforts`）。
 *      用户选的那档不在声明里就退到该模型的默认档，并回一句为什么——
 *      静默塞一个不支持的档，表现是「AI 报错」而不是「设置没生效」。
 *   3. **默认 high，不是 max**。high 是「认真想」的默认档；max 很慢也很贵，
 *      留给用户在具体一章上自己开。
 */

/** 强度档位，从浅到深。宿主各适配器不一定全支持，实际以模型声明为准。 */
export const EFFORT_ORDER = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 默认强度：用户明确要求「默认开、高，但可切换」。 */
export const DEFAULT_EFFORT = 'high'

const EFFORT_TEXT = Object.freeze({
  off: '关（不思考）',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高（慢、贵）',
})

/**
 * 强度档的中文名。
 * @param {string} id
 * @returns {string}
 */
export function effortLabel(id) {
  const key = String(id ?? '')
  return EFFORT_TEXT[key] ?? (key === '' ? '跟随宿主' : key)
}

/**
 * 读宿主的模型名单。
 *
 * `sessionController` 不是插件对等体，是宿主服务，所以按结构探测；拿不到就降级，
 * 让界面显示「宿主没提供名单，只能用默认模型」，而不是抛错白屏。
 *
 * @param {object} ctx cordis 上下文
 * @returns {Promise<{available: boolean, default?: object, groups: object[], failures: object[]}>}
 */
export async function modelCatalogOf(ctx) {
  let service = null
  try {
    service = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController', false) : null
  } catch (error) {
    service = null
  }
  if (!service || typeof service.modelCatalog !== 'function') {
    return { available: false, groups: [], failures: [] }
  }
  try {
    const raw = await Promise.resolve(service.modelCatalog())
    if (!raw || typeof raw !== 'object') return { available: true, groups: [], failures: [] }
    const groups = Array.isArray(raw.groups) ? raw.groups : []
    const failures = Array.isArray(raw.failures) ? raw.failures : []
    // 只留「真的能路由」的模型：宿主已经按这条规矩过滤过一遍，这里再拒一次空 id，
    // 免得下拉里出现一个选了就报错的占位行。
    const cleaned = groups
      .map((group) => {
        if (!group || typeof group !== 'object') return null
        const id = typeof group.id === 'string' ? group.id : ''
        if (id === '') return null
        const models = (Array.isArray(group.models) ? group.models : [])
          .map((model) => {
            if (!model || typeof model !== 'object') return null
            const modelId = typeof model.id === 'string' ? model.id : ''
            if (modelId === '') return null
            const efforts = Array.isArray(model.reasoning?.efforts)
              ? model.reasoning.efforts
                  .map((effort) => {
                    if (!effort || typeof effort !== 'object') return null
                    const effortId = typeof effort.id === 'string' ? effort.id : ''
                    return effortId === '' ? null : { id: effortId, name: typeof effort.name === 'string' ? effort.name : '' }
                  })
                  .filter(Boolean)
              : []
            return {
              id: modelId,
              name: typeof model.name === 'string' ? model.name : modelId,
              description: typeof model.description === 'string' ? model.description : '',
              efforts,
              defaultEffort: typeof model.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : '',
            }
          })
          .filter(Boolean)
        if (models.length === 0) return null
        return { id, name: typeof group.name === 'string' && group.name !== '' ? group.name : id, models }
      })
      .filter(Boolean)
    return {
      available: true,
      ...(raw.default && typeof raw.default === 'object' ? { default: raw.default } : {}),
      groups: cleaned,
      failures: failures
        .map((failure) => {
          if (!failure || typeof failure !== 'object') return null
          const id = typeof failure.id === 'string' ? failure.id : 'host'
          const message = typeof failure.message === 'string' ? failure.message : String(failure.message ?? '')
          return { id, name: typeof failure.name === 'string' ? failure.name : id, message }
        })
        .filter(Boolean),
    }
  } catch (error) {
    return {
      available: false,
      groups: [],
      failures: [{ id: 'host', name: '宿主', message: String(error && error.message ? error.message : error) }],
    }
  }
}

/** 在名单里找一个模型，找不到返回 null。 */
function findModel(catalog, provider, model) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  for (const group of groups) {
    if (group.id !== provider) continue
    const hit = (group.models || []).find((entry) => entry.id === model)
    if (hit) return hit
  }
  return null
}

/**
 * 决定这一次调用用哪条路由、哪一档强度。
 *
 * 优先级：设置里手选的模型 > 当前会话的模型（父会话）> 交给宿主默认。
 * 强度：设置里的档位 > 模型声明的默认档。
 *
 * @param {{settings?: object, catalog?: object, parentOptions?: object}} input
 * @returns {{provider: string, model: string, reasoningEffort: string, source: string,
 *            effortNote: string, effectiveEffort: string}}
 */
export function pickSelection(input) {
  const settings = input?.settings ?? {}
  const catalog = input?.catalog ?? { groups: [], available: false }
  const parentOptions = input?.parentOptions ?? {}

  const userProvider = typeof settings.aiProvider === 'string' ? settings.aiProvider.trim() : ''
  const userModel = typeof settings.aiModel === 'string' ? settings.aiModel.trim() : ''
  const wantEffort = typeof settings.aiEffort === 'string' ? settings.aiEffort.trim() : DEFAULT_EFFORT

  // 1) 手选的模型
  let provider = ''
  let model = ''
  let source = 'host'
  const pinned = userProvider !== '' && userModel !== '' ? findModel(catalog, userProvider, userModel) : null
  if (pinned) {
    provider = userProvider
    model = userModel
    source = 'user'
  } else if (typeof parentOptions.provider === 'string' && parentOptions.provider !== ''
    && typeof parentOptions.model === 'string' && parentOptions.model !== '') {
    // 2) 会话当前模型
    provider = parentOptions.provider
    model = parentOptions.model
    source = 'session'
  } else if (catalog.default && typeof catalog.default.provider === 'string' && typeof catalog.default.model === 'string') {
    // 3) 宿主默认
    provider = catalog.default.provider
    model = catalog.default.model
    source = 'host'
  }

  const entry = provider !== '' && model !== '' ? findModel(catalog, provider, model) : null
  const declared = Array.isArray(entry?.efforts) ? entry.efforts.map((effort) => effort.id) : []

  // 强度：模型没声明任何档位就不传（传了也会被适配器忽略或报错）
  let reasoningEffort = ''
  let effortNote = ''
  const fallbackEffort = entry?.defaultEffort && declared.includes(entry.defaultEffort)
    ? entry.defaultEffort
    : (declared.length > 0 ? declared[declared.length - 1] : '')

  if (wantEffort === '') {
    reasoningEffort = fallbackEffort
    effortNote = declared.length === 0 ? '这个模型不提供思考强度' : '跟随模型默认档'
  } else if (declared.length === 0) {
    reasoningEffort = ''
    effortNote = entry ? '这个模型不提供思考强度' : '宿主没给模型名单，强度交给宿主决定'
  } else if (declared.includes(wantEffort)) {
    reasoningEffort = wantEffort
  } else {
    reasoningEffort = fallbackEffort
    effortNote = `这个模型没有「${effortLabel(wantEffort)}」档，已退到「${effortLabel(fallbackEffort)}」`
  }

  return {
    provider,
    model,
    reasoningEffort,
    source,
    effortNote,
    effectiveEffort: reasoningEffort,
  }
}

/** 给界面看的一句话：这次到底用的哪个模型、多深。 */
export function describeSelection(selection) {
  const provider = selection?.provider ?? ''
  const model = selection?.model ?? ''
  if (provider === '' || model === '') return '跟随宿主默认模型'
  const effort = selection?.reasoningEffort ?? ''
  const head = `${provider}/${model}`
  return effort === '' ? head : `${head} · 思考${effortLabel(effort)}`
}
