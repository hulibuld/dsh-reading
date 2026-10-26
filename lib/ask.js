/**
 * ask.js —— 「圈住一段话，问问 AI」。
 *
 * 设计上的三条硬约束（来自 docs/01 的铁律与 docs/05 §M4）：
 *
 *   1. **答案必须挂在锚点上**：每次提问都带 `anchorCfiRange`，答案落进 `qa.jsonl`。
 *      没有锚点的回答一律不落盘 —— 一个找不回原文的答案，等于没答。
 *   2. **不替用户拼 LLM 请求**：走宿主自己的子代理机制（`subagents` 服务），
 *      额度、重试、工具表、会话记录都由宿主管。我们只负责「把哪段话交给它」。
 *   3. **服务不可用不是崩溃**：拿不到 subagents / 找不到可用模型时，返回一句
 *      人话说明，界面把这句话显示在提问框下面，不抛栈、不白屏。
 *
 * 为什么不自己调 `llm.stream`：那要自己拼完整请求（工具表、额度、重试、流式分片），
 * 一处拼错就是「AI 不说话」，而子代理这条路是宿主自己的机制，坏了也是宿主的问题。
 */

import { modelCatalogOf, pickSelection, DEFAULT_EFFORT } from './aimodel.js'

/** 回答超时。读书提问不是长任务：90 秒还没回来，用户已经走了。 */
const ASK_TIMEOUT_MS = 90_000

/** 选中文字的入 prompt 上限。太长会把上下文挤爆，也太贵。 */
const MAX_SELECTION_CHARS = 4000

/**
 * 选区所在段落的前后文上限（0.8.0）。
 *
 * 为什么要把「工作内容」也带进去：用户问的常常是「这句话什么意思」，
 * 而只给这一句时模型只能猜。带上前后的几十字，答案通常立刻变准；
 * 更重要的是——失败重试时（用户 m02260 抱怨的那件事）不需要用户重述任何东西。
 */
const MAX_SURROUNDING_CHARS = 1600

/**
 * 从子代理返回的「结果」里捞出正文。
 *
 * 为什么写得这么宽：`startActivation().result` 的形状是宿主内部约定，
 * 不同版本可能在 `text` / `content[]` / `message.content[]` / 纯字符串之间变。
 * 这里按可能性从高到低逐层找，找到就用；一个都找不到才返回空串（由调用方报错）。
 *
 * @param {unknown} result
 * @returns {string}
 */
export function extractAnswerText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result.trim()
  if (typeof result !== 'object') return ''

  const direct = ['text', 'answer', 'output', 'content', 'message', 'finalText', 'summary']
  for (const key of direct) {
    const value = result[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (Array.isArray(value)) {
      const joined = value
        .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim()
      if (joined !== '') return joined
    }
    if (value && typeof value === 'object') {
      const nested = extractAnswerText(value)
      if (nested !== '') return nested
    }
  }
  return ''
}

/** 把一本书 + 一段选中文字 + 一个提问拼成 prompt。 */
export function buildAskPrompt(input) {
  const selection = String(input.selectedText ?? '').slice(0, MAX_SELECTION_CHARS)
  const question = String(input.question ?? '').trim()
  const title = String(input.bookTitle ?? '').trim() || '这本书'
  const author = String(input.author ?? '').trim()
  const chapter = String(input.chapterLabel ?? '').trim()
  const surrounding = String(input.surroundingText ?? '').trim().slice(0, MAX_SURROUNDING_CHARS)

  const lines = [
    '你是一位耐心的读书助手。读者正在读一本书，圈住了一段话，想问你一个问题。',
    '',
    `书名：${title}${author === '' ? '' : `（${author}）`}`,
    chapter === '' ? '' : `当前位置：${chapter}`,
    '',
    // 有前后文就放在选区前面：模型先看到「他在读什么」，再看「他圈住哪句」。
    surrounding === '' || surrounding === selection ? '' : '这段文字的上下文（供参考，不要逐句复述）：',
    surrounding === '' || surrounding === selection ? '' : '"""',
    surrounding === '' || surrounding === selection ? '' : surrounding,
    surrounding === '' || surrounding === selection ? '' : '"""',
    surrounding === '' || surrounding === selection ? '' : '',
    '读者圈住的原文：',
    '"""',
    selection,
    '"""',
    '',
    `读者的问题：${question}`,
    '',
    '回答要求：',
    '1. 用中文，直接回答问题，不要复述原文、不要客套开头。',
    '2. 只用这段原文和常见的通识来回答；如果不确定，就说「不确定」，不要编。',
    '3. 不要剧透这段之后的情节（如果这本书是小说）。',
    '4. 控制在 200 字以内；需要展开时用两三个短段落，不要写成一整段。',
  ].filter((line) => line !== '')
  return lines.join('\n')
}

/**
 * 找一条能用的模型路由：优先用当前会话的模型。
 *
 * 找不到不是错误 —— 那就**什么都不传**，让宿主用自己的默认模型去起子代理。
 * 早期版本在这里硬要求「必须解析出 provider/model」，结果是：任何拿不到
 * `agents.roots()` 的场合（CLI 实例、还没开会话的窗口）都会回一句「还没选模型」，
 * 而宿主其实完全可以自己决定用哪个模型。少猜一层，少坏一种情况。
 *
 * @param {object} ctx cordis 上下文
 * @returns {{ parent: object|null, provider: string, model: string }|null}
 */
export function resolveRoute(ctx) {
  let parent = null
  try {
    const agents = ctx.get('agents', false)
    const roots = agents && typeof agents.roots === 'function' ? agents.roots() : []
    if (Array.isArray(roots) && roots.length > 0) {
      parent = roots[0]
    } else {
      // 没有 root（例如刚启动还没开会话）：退一步用任意一个活着的 agent。
      // startActivation 要求 parent 是**注册表里那个确切对象**，所以只能从
      // agents.list() 里拿，不能自己 new 一个。
      const all = agents && typeof agents.list === 'function' ? agents.list() : []
      parent = Array.isArray(all) && all.length > 0 ? all[0] : null
    }
  } catch (error) {
    parent = null
  }

  const options = parent && parent.options ? parent.options : {}
  let provider = typeof options.provider === 'string' ? options.provider : ''
  let model = typeof options.model === 'string' ? options.model : ''

  if (provider === '' || model === '') {
    try {
      const llm = ctx.get('llm', false)
      const providers = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []
      for (const entry of Array.isArray(providers) ? providers : []) {
        const id = typeof entry === 'string' ? entry : entry && entry.id
        if (typeof id !== 'string' || id === '') continue
        const models = typeof llm.listModels === 'function' ? llm.listModels(id) : []
        const first = Array.isArray(models) ? models[0] : null
        const modelId = typeof first === 'string' ? first : first && (first.id || first.model)
        if (typeof modelId === 'string' && modelId !== '') {
          provider = id
          model = modelId
          break
        }
      }
    } catch (error) {
      // 下面统一报「没有可用模型」
    }
  }

  if (process.env.DSH_READING_DEBUG === '1') {
    try {
      const llm = ctx.get('llm', false)
      const agents = ctx.get('agents', false)
      console.warn('[dsh-reading][debug] parent=', parent ? Object.keys(parent) : null,
        'options=', parent && parent.options ? parent.options : null,
        'roots=', agents && typeof agents.roots === 'function' ? agents.roots().length : 'n/a',
        'llmKeys=', llm ? Object.keys(llm) : null)
      if (llm && typeof llm.listProviders === 'function') {
        const provs = llm.listProviders()
        console.warn('[dsh-reading][debug] providers=', JSON.stringify(provs).slice(0, 300))
        const firstId = provs && provs[0] ? (provs[0].id || provs[0]) : null
        if (firstId && typeof llm.listModels === 'function') {
          const models = llm.listModels(firstId)
          console.warn('[dsh-reading][debug] models for', firstId, '=', JSON.stringify(models).slice(0, 600))
        }
        console.warn('[dsh-reading][debug] llm methods=', Object.keys(llm).join(','))
      }
    } catch (error) {
      console.warn('[dsh-reading][debug] probe failed', String(error && error.message))
    }
  }

  if (provider === '' || model === '') return null
  return { parent, provider, model }
}

/**
 * 提问服务。
 *
 * @param {{ ctx: object, store: object, logger?: { warn?: Function } }} deps
 */
export function createAskService({ ctx, store, logger }) {
  const warn = (message) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(`[dsh-reading] ${message}`)
      else console.warn(`[dsh-reading] ${message}`)
    } catch (error) {
      // 日志失败不能再抛
    }
  }

  return {
    /**
     * 跑一段 prompt，拿回纯文本 —— 「圈一段话问 AI」与「读书蒸馏」共用这一条通道。
     *
     * 为什么拆出来：蒸馏要把整章原文交给模型并要求它回 JSON，请求形状和提问不同，
     * 但子代理的启动、超时、回收、取值完全一样。复制一份迟早会走偏。
     *
     * @param {{ prompt: string, label?: string, timeoutMs?: number }} input
     * @returns {Promise<{ answer: string, model: string }>}
     */
    async complete(input) {
      const prompt = String(input?.prompt ?? '')
      if (prompt.trim() === '') {
        const { fail } = await import('./errors.js')
        throw fail('E_BAD_PROMPT', '这次没有可交给 AI 的内容。', { status: 400 })
      }
      const label = String(input?.label ?? '读书提问')
      const timeoutMs = Number.isFinite(input?.timeoutMs) ? Number(input.timeoutMs) : ASK_TIMEOUT_MS

      const subagents = ctx.get('subagents', false)
      if (process.env.DSH_READING_DEBUG === '1' && subagents) {
        try {
          console.warn('[dsh-reading][debug] subagent providers=', JSON.stringify(typeof subagents.list === 'function' ? subagents.list() : Object.keys(subagents)))
          const agents = ctx.get('agents', false)
          const roots = agents && typeof agents.roots === 'function' ? agents.roots() : []
          console.warn('[dsh-reading][debug] roots=', roots.length, 'rootIds=', roots.map((r) => r && r.id).join(','))
        } catch (error) {
          console.warn('[dsh-reading][debug] subagents probe failed', String(error && error.message))
        }
      }
      if (!subagents || typeof subagents.startActivation !== 'function') {
        const { fail } = await import('./errors.js')
        throw fail('E_AI_UNAVAILABLE', '这个版本的宿主没有提供子代理服务，暂时问不了 AI。', {
          status: 503,
          detail: 'subagents.startActivation missing',
        })
      }

      // 拿不到路由就用宿主默认模型（见 resolveRoute 的说明）；parent 却是必需的：
      // 子代理必须挂在一个活着的会话上，否则宿主无法授权这次生成。
      const route = resolveRoute(ctx)
      if (!route || !route.parent) {
        const { fail } = await import('./errors.js')
        throw fail('E_AI_NO_SESSION', '先在对话里发一句话，让 DSH 有一个活动会话，再回来问 AI。', {
          status: 503,
          detail: 'no live agent available for subagent parent',
        })
      }

      // 用哪个模型、想多深：设置里手选 > 会话当前模型 > 宿主默认（0.8.1）。
      // 读设置失败不能让问 AI 一起失败——那就退回宿主默认，并记一句日志。
      let settings = {}
      try {
        settings = (await store.getSettings()) ?? {}
      } catch (error) {
        warn(`读设置失败，本次跟随宿主默认模型：${String(error && error.message ? error.message : error)}`)
      }
      let catalog = { available: false, groups: [], failures: [] }
      if (typeof store?.getSettings === 'function') {
        try {
          catalog = await modelCatalogOf(ctx)
        } catch (error) {
          catalog = { available: false, groups: [], failures: [] }
        }
      }
      const selection = pickSelection({
        settings,
        catalog,
        parentOptions: route.parent && route.parent.options ? route.parent.options : {},
      })
      if (selection.effortNote !== '') warn(`思考强度：${selection.effortNote}`)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let activation
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label,
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: route.parent,
            ...(selection.provider !== '' && selection.model !== ''
              ? {
                  agentOptions: {
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.reasoningEffort === '' ? {} : { reasoningEffort: selection.reasoningEffort }),
                  },
                }
              : {}),
          },
          signal: controller.signal,
          // caller：结果交回我们，不往父会话里塞一条完成通知
          delivery: 'caller',
        })
      } catch (error) {
        clearTimeout(timer)
        const { fail } = await import('./errors.js')
        const reason = String(error && error.message ? error.message : error)
        // 这句进宿主日志：用户在界面上只看到一句人话，排障要看真实原因
        warn(`AI 启动失败：${reason}`)
        if (/model|provider/i.test(reason)) {
          throw fail('E_AI_NO_MODEL', '还没选模型，先在 DSH 里选一个模型再回来问。', {
            status: 503,
            detail: reason,
            cause: error,
          })
        }
        throw fail('E_AI_FAILED', 'AI 没能启动，稍后再试一次。', {
          status: 502,
          detail: String(error && error.message ? error.message : error),
          cause: error,
        })
      }

      let result = null
      try {
        // `activation.result` 是 PromiseWithResolvers（`{promise, resolve, reject}`），
        // 不是 Promise 本身 —— 直接 await 它会立刻拿到那个对象，答案永远是空的。
        // 老版本/外部 provider 上它也可能是普通 Promise，所以两种都认。
        const pending = activation.result
        result = pending && typeof pending.promise !== 'undefined' ? await pending.promise : await pending
      } catch (error) {
        clearTimeout(timer)
        const { fail } = await import('./errors.js')
        throw fail('E_AI_FAILED', 'AI 这次没答上来，稍后再试一次。', {
          status: 502,
          detail: String(error && error.message ? error.message : error),
          cause: error,
        })
      } finally {
        clearTimeout(timer)
        if (typeof activation.dispose === 'function') {
          try {
            await activation.dispose()
          } catch (error) {
            // 回收失败不影响已经拿到的答案
          }
        }
      }

      const answer = extractAnswerText(result)
      if (answer === '') {
        const { fail } = await import('./errors.js')
        throw fail('E_AI_EMPTY', 'AI 没有给出内容，换个问法再试。', {
          status: 502,
          detail: `empty answer; result keys=${result && typeof result === 'object' ? Object.keys(result).join(',') : typeof result}`,
        })
      }
      return {
        answer,
        model: selection.provider !== '' && selection.model !== ''
          ? `${selection.provider}/${selection.model}`
          : (route && route.provider ? `${route.provider}/${route.model}` : ''),
        effort: selection.reasoningEffort,
        routeSource: selection.source,
      }
    },

    /**
     * 问一个问题。成功返回 `{ answer, question, anchorCfiRange, createdAt }`。
     *
     * @param {object} input
     */
    async ask(input) {
      const question = String(input?.question ?? '').trim()
      if (question === '') {
        const { fail } = await import('./errors.js')
        throw fail('E_BAD_QUESTION', '先写一句想问的话。', { status: 400 })
      }
      const selectedText = String(input?.selectedText ?? '').trim()
      if (selectedText === '') {
        const { fail } = await import('./errors.js')
        throw fail('E_NO_SELECTION', '先圈住一段原文，再问 AI。', { status: 400 })
      }
      const prompt = buildAskPrompt({
        selectedText,
        question,
        bookTitle: input?.bookTitle,
        author: input?.author,
        chapterLabel: input?.chapterLabel,
        // 当前工作内容（0.8.0）：选区所在段落的前后文，失败重试时不用用户重述
        surroundingText: input?.surroundingText,
      })

      const { answer, model } = await this.complete({ prompt, label: '读书提问' })

      const record = {
        question,
        answer,
        anchorCfiRange: typeof input?.anchorCfiRange === 'string' ? input.anchorCfiRange : '',
        selectedText,
        chapterHref: typeof input?.chapterHref === 'string' ? input.chapterHref : '',
        model,
      }

      try {
        await store.appendQa(input?.bookHash, record)
      } catch (error) {
        // 落盘失败不该吞掉答案：用户已经在等了，先给他看，再记一笔
        warn(`问答落盘失败：${String(error && error.message)}`)
      }

      return record
    },
  }
}
