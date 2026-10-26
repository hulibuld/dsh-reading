/**
 * ai.js —— AI 调用状态与失败账本的界面。
 *
 * 用户的原话（m02260）：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍
 * 去重试，非常浪费。所以界面上必须能一眼看到三件事：
 *
 *   1. **现在能不能用**（可用 / 不可用 + 卡在哪一道）
 *   2. **上一次为什么失败**（错误码 + 一句人话）
 *   3. **最近这几次都发生了什么**（时间、用途、耗时、模型、结果）
 *
 * 三块都只读，改不了 AI——能改的只有「换网络 / 配模型 / 再点一次」，所以每块都直接
 * 写出下一步该做什么，而不是只报一个错。
 */

/** 状态色：ok 绿、warn 黄、fail 红、unknown 灰。样式在 style.js 里。 */
export function statusSummary(status, extra = {}) {
  if (extra.probing === true) {
    return { tone: 'warn', text: '正在检测 AI 连接…', hint: '发一句极小的话，测的是网络和模型服务。' }
  }
  if (!status || typeof status !== 'object') {
    return { tone: 'unknown', text: 'AI 状态未知', hint: '点一下看诊断。' }
  }
  const checks = Array.isArray(status.checks) ? status.checks : []
  const broken = checks.find((item) => item && item.ok !== true)
  const recent = status.recent && typeof status.recent === 'object' ? status.recent : null
  const consecutive = recent && Number.isFinite(recent.consecutiveFailures) ? recent.consecutiveFailures : 0
  const last = recent && recent.last && typeof recent.last === 'object' ? recent.last : null

  if (broken) {
    return {
      tone: 'fail',
      text: `AI 用不了：${broken.title || broken.id || '配置不通'}`,
      hint: broken.fix || broken.detail || '点一下看诊断。',
    }
  }
  if (status.available === false) {
    return { tone: 'fail', text: 'AI 用不了', hint: '点一下看诊断。' }
  }
  if (consecutive > 0) {
    const message = last && typeof last.message === 'string' && last.message !== ''
      ? last.message
      : '最近一次调用失败'
    return {
      tone: 'warn',
      text: `AI 连续失败 ${consecutive} 次`,
      hint: message,
    }
  }
  const model = typeof status.model === 'string' && status.model !== '' ? status.model : ''
  return {
    tone: 'ok',
    text: model === '' ? 'AI 可用' : `AI 可用 · ${model}`,
    hint: '点一下看最近的调用记录。',
  }
}

/** 调用记录压成一行：时间 + 用途 + 耗时 + 结果。 */
export function describeRecord(item) {
  if (!item || typeof item !== 'object') return { ok: false, time: '', text: '', detail: '' }
  const time = typeof item.at === 'string' ? item.at.slice(11, 19) : ''
  const label = typeof item.label === 'string' && item.label !== '' ? item.label : item.kind || '调用'
  const ms = Number.isFinite(item.latencyMs) ? item.latencyMs : 0
  const ok = item.ok === true
  const text = ok
    ? `${label} · ${(ms / 1000).toFixed(1)} 秒 · 成功`
    : `${label} · 失败`
  const detail = ok
    ? (typeof item.model === 'string' && item.model !== '' ? item.model : '')
    : [item.code, item.message].filter((part) => typeof part === 'string' && part !== '').join(' · ')
  return { ok, time, text, detail }
}

/** 一行状态条。放在问 AI / 蒸馏面板的顶部，永远看得见。 */
export function AiStatusChip(props) {
  const summary = statusSummary(props.status, { probing: props.probing })
  const onClick = typeof props.onOpen === 'function' ? props.onOpen : undefined
  return h(
    'button',
    {
      type: 'button',
      className: `dr-ai-chip dr-ai-chip-${summary.tone}`,
      title: summary.hint,
      onClick,
      'aria-label': `${summary.text}。${summary.hint}`,
    },
    h('span', { className: 'dr-ai-dot' }),
    h('span', { className: 'dr-ai-chip-text' }, summary.text),
  )
}

/**
 * AI 面板：四道检查 + 最近调用账本。
 *
 * 这就是用户要的「集中在一个地方显示」：哪一道不通、上次为什么失败、
 * 最近几次都发生了什么，全在一屏里。
 */
export function AiPanel(props) {
  const status = props.status && typeof props.status === 'object' ? props.status : null
  const items = Array.isArray(props.items) ? props.items : []
  const checks = status && Array.isArray(status.checks) ? status.checks : []
  const recent = status && status.recent && typeof status.recent === 'object' ? status.recent : null
  const summary = statusSummary(status, { probing: props.probing })

  const head = h(
    'div',
    { className: 'dr-ai-head' },
    h('div', { className: 'dr-ai-headline' },
      h('span', { className: `dr-ai-dot dr-ai-dot-${summary.tone}` }),
      h('span', { className: 'dr-ai-title' }, summary.text)),
    h('div', { className: 'dr-ai-hint' }, summary.hint),
    h('div', { className: 'dr-ai-actions' },
      h('button', {
        type: 'button',
        className: 'dr-btn dr-btn-small',
        disabled: props.probing === true,
        onClick: typeof props.onProbe === 'function' ? () => props.onProbe() : undefined,
      }, props.probing === true ? '检测中…' : '测一次连通'),
      h('button', {
        type: 'button',
        className: 'dr-btn dr-btn-small',
        onClick: typeof props.onRefresh === 'function' ? () => props.onRefresh() : undefined,
      }, '刷新'),
      h('button', {
        type: 'button',
        className: 'dr-btn dr-btn-small dr-btn-quiet',
        onClick: typeof props.onClear === 'function' ? () => props.onClear() : undefined,
      }, '清空记录')),
  )

  const checkList = checks.length === 0
    ? h('div', { className: 'dr-state-text' }, '还没拿到诊断结果，点「刷新」。')
    : h('ul', { className: 'dr-ai-checks' }, checks.map((item) => h(
      'li',
      { key: item.id || item.title, className: `dr-ai-check ${item.ok ? 'is-ok' : 'is-bad'}` },
      h('span', { className: 'dr-ai-check-mark' }, item.ok ? '✓' : '✗'),
      h('span', { className: 'dr-ai-check-title' }, item.title || item.id || ''),
      h('span', { className: 'dr-ai-check-detail' }, item.detail || ''),
      item.ok ? null : h('span', { className: 'dr-ai-check-fix' }, `→ ${item.fix || '看诊断'}`),
    )))

  const recentLine = recent
    ? h('div', { className: 'dr-ai-recent' },
      `最近 10 分钟：${recent.total} 次调用，失败 ${recent.failed} 次` +
      (recent.consecutiveFailures > 0 ? `，已连续失败 ${recent.consecutiveFailures} 次` : ''),
      Array.isArray(recent.codes) && recent.codes.length > 0
        ? h('span', { className: 'dr-ai-codes' },
          recent.codes.map((entry) => h('code', { key: entry.code, className: 'dr-ai-code' }, `${entry.code}×${entry.count}`)))
        : null)
    : null

  const empty = h('div', { className: 'dr-state-text' }, '还没有调用记录。用一次「问 AI」或「蒸馏」就会出现。')
  const list = items.length === 0
    ? empty
    : h('ul', { className: 'dr-ai-log' }, items.map((item, index) => {
      const row = describeRecord(item)
      return h('li', { key: item.id || `${index}`, className: `dr-ai-row ${row.ok ? 'is-ok' : 'is-bad'}` },
        h('span', { className: 'dr-ai-row-time' }, row.time),
        h('span', { className: 'dr-ai-row-text' }, row.text),
        row.detail === '' ? null : h('span', { className: 'dr-ai-row-detail' }, row.detail))
    }))

  return h(
    'div',
    { className: 'dr-ai-panel' },
    props.error ? h('div', { className: 'dr-state dr-error' },
      h('div', { className: 'dr-state-title' }, '诊断没读出来'),
      h('div', { className: 'dr-state-text' }, props.error)) : null,
    head,
    h('div', { className: 'dr-ai-section' },
      h('div', { className: 'dr-ai-section-title' }, '四道检查'),
      checkList),
    h('div', { className: 'dr-ai-section' },
      h('div', { className: 'dr-ai-section-title' }, '最近调用'),
      recentLine,
      props.loading === true ? h('div', { className: 'dr-state-text' }, '读取中…') : list),
    h('div', { className: 'dr-ai-foot' },
      status && status.log && typeof status.log.file === 'string'
        ? h('span', { className: 'dr-ai-path' }, `记录文件：${status.log.file}`)
        : null),
  )
}

/* ── 模型与思考强度（0.8.1）─────────────────────────────────────────
 *
 * 用户的要求：AI 能换模型，思考强度默认开、默认「高」，但也要能自己调。
 *
 * 界面上分两个下拉：
 *   · 模型——按 provider 分组，第一项是「跟随当前会话」（= 不给插件指定模型）；
 *   · 思考强度——只列这个模型真正声明的档位，第一项「跟随模型默认」。
 *
 * 为什么不把「强度」做成全局开关：每个模型支持的档位不一样，模型换了强度却留在
 * 一个它不认识的档上，用户会看到「设置对了但没用」。所以强度跟着模型一起选。
 */

/** 把「provider/model」拼成下拉的 value。 */
export function modelValue(provider, model) {
  return `${provider ?? ''}/${model ?? ''}`
}

/** 从 `provider/model` 拆回来；不合法的返回空。 */
export function parseModelValue(value) {
  const text = String(value ?? '')
  const at = text.indexOf('/')
  if (at <= 0 || at === text.length - 1) return { provider: '', model: '' }
  return { provider: text.slice(0, at), model: text.slice(at + 1) }
}

/** 拍平成下拉用的扁平列表（保留分组标签）。 */
export function modelGroups(models) {
  const groups = Array.isArray(models?.groups) ? models.groups : []
  return groups
    .map((group) => ({
      id: typeof group.id === 'string' ? group.id : '',
      name: typeof group.name === 'string' && group.name !== '' ? group.name : (group.id || ''),
      models: (Array.isArray(group.models) ? group.models : []).map((model) => ({
        id: typeof model.id === 'string' ? model.id : '',
        name: typeof model.name === 'string' && model.name !== '' ? model.name : (model.id || ''),
        efforts: Array.isArray(model.efforts) ? model.efforts.map((effort) => effort.id).filter(Boolean) : [],
        defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : '',
      })),
    }))
    .filter((group) => group.id !== '' && group.models.length > 0)
}

/** 某个模型支持哪些强度档；没有声明就返回空数组（界面据此禁用下拉）。 */
export function effortsForModel(models, provider, model) {
  for (const group of modelGroups(models)) {
    if (group.id !== provider) continue
    const hit = group.models.find((entry) => entry.id === model)
    if (hit) return hit.efforts
  }
  return []
}

/** 「这次实际会用哪个模型、多深」的一句话。 */
export function describeEffective(models) {
  const effective = models?.effective ?? null
  if (!effective || typeof effective.provider !== 'string' || effective.provider === '') {
    return '跟随当前会话的模型'
  }
  const head = `${effective.provider}/${effective.model}`
  const effort = typeof effective.reasoningEffort === 'string' ? effective.reasoningEffort : ''
  const label = effort === '' ? '' : ` · 思考 ${effort}`
  const source = effective.source === 'user' ? '（你选的）' : (effective.source === 'session' ? '（跟随会话）' : '（宿主默认）')
  return `${head}${label}${source}`
}

/** 强度档的中文名。宿主给的 name 优先，没有就用我们自己的对照表。 */
export function effortName(efforts, id) {
  const list = Array.isArray(efforts) ? efforts : []
  const hit = list.find((entry) => entry && entry.id === id)
  if (hit && typeof hit.name === 'string' && hit.name !== '') return hit.name
  const table = { off: '关', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
  return table[id] ?? id
}

/**
 * 模型选择区。
 *
 * 三行：说明、两个下拉、一行「实际使用」。改动即时保存（父组件负责 put），
 * 所以这里没有「保存」按钮——多一个按钮就多一次「我改完忘了点」。
 */
export function AiModelPicker(props) {
  const models = props.models && typeof props.models === 'object' ? props.models : null
  const groups = modelGroups(models)
  const current = models?.current ?? {}
  const provider = typeof current.provider === 'string' ? current.provider : ''
  const model = typeof current.model === 'string' ? current.model : ''
  const effort = typeof current.reasoningEffort === 'string' ? current.reasoningEffort : ''
  const efforts = typeof models?.efforts === 'object' && Array.isArray(models.efforts) ? models.efforts : []
  const declared = effortsForModel(models, provider, model)
  const busy = props.saving === true

  const options = [h('option', { key: '__follow', value: '' }, '跟随当前会话（推荐）')]
  groups.forEach((group) => {
    options.push(h(
      'optgroup',
      { key: group.id, label: group.name },
      group.models.map((entry) => h(
        'option',
        { key: `${group.id}/${entry.id}`, value: modelValue(group.id, entry.id) },
        entry.name,
      )),
    ))
  })

  const effortOptions = [h('option', { key: '__default', value: '' }, '跟随模型默认')]
  // 只列这个模型声明过的档位。没选具体模型（跟随会话）时列全部常用档，
  // 因为会话那边可能支持更多——这里给的是「你想让插件要求多深」的意图。
  const candidates = declared.length > 0 ? declared : ['off', 'low', 'medium', 'high', 'max']
  candidates.forEach((id) => {
    effortOptions.push(h(
      'option',
      { key: id, value: id },
      `${effortName(efforts, id)}${id === 'high' ? '（默认）' : ''}`,
    ))
  })

  const onChangeModel = (event) => {
    if (typeof props.onChange !== 'function') return
    const next = parseModelValue(event && event.target ? event.target.value : '')
    props.onChange({ provider: next.provider, model: next.model, reasoningEffort: effort })
  }
  const onChangeEffort = (event) => {
    if (typeof props.onChange !== 'function') return
    props.onChange({ provider, model, reasoningEffort: String(event && event.target ? event.target.value : '') })
  }

  const unavailable = models !== null && models.available === false
    ? h('div', { className: 'dr-ai-hint' }, '宿主没有提供模型名单，当前只能跟随会话。升级 DSH 或换个安装方式后再试。')
    : null
  const note = models?.effective?.note
    ? h('div', { className: 'dr-ai-hint' }, models.effective.note)
    : null

  return h(
    'div',
    { className: 'dr-ai-models' },
    h('div', { className: 'dr-ai-section-title' }, '用哪个模型'),
    h('div', { className: 'dr-ai-hint' }, '问 AI 和蒸馏都用这里选的模型。默认「跟随当前会话」，你不用管。'),
    unavailable,
    h('label', { className: 'dr-ai-field' },
      h('span', { className: 'dr-ai-field-label' }, '模型'),
      h('select', {
        className: 'dr-select',
        disabled: busy || groups.length === 0,
        value: provider !== '' && model !== '' ? modelValue(provider, model) : '',
        onChange: onChangeModel,
      }, options)),
    h('label', { className: 'dr-ai-field' },
      h('span', { className: 'dr-ai-field-label' }, '思考强度'),
      h('select', {
        className: 'dr-select',
        disabled: busy,
        value: effort,
        onChange: onChangeEffort,
      }, effortOptions)),
    h('div', { className: 'dr-ai-effective' }, `实际使用：${describeEffective(models)}`),
    note,
  )
}
