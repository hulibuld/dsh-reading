/**
 * askpresets.js —— 「问 AI」的五个模式预设。
 *
 * 纯数据 + 纯函数，**不碰 IO**：预设是随包分发的一部分，读文件、读设置都不该发生在
 * 这里。谁想用，就拿 `pickAskPreset(id)` 换出一个预设对象。
 *
 * 为什么分 persona 与 requirements 两处（docs/24）：
 *   - `persona` 进子代理的系统提示 —— 管「你是谁、用什么眼光看这段话」；
 *   - `requirements` 进用户消息末尾的「回答要求」—— 管「这次输出成什么样」。
 *   两处内容不重复，否则模型会收到两遍同样的指令。
 *
 * `general` 是向后兼容的锚点：persona 与四条 requirements **逐字等于 0.10.3 的
 * `lib/ask.js`**。老请求不带 mode 时落到 general，拼出来的 prompt 与旧版一字不差。
 */

/** 默认模式。空 id / 未知 id 都落到它。 */
export const DEFAULT_ASK_PRESET = 'general'

/**
 * 五个模式。顺序即前端下拉框的顺序。
 *
 * 字段：
 *   - id：请求里传的值，也是 settings 里记住的值；
 *   - name / description：面板与路由给用户看的文案；
 *   - persona：子代理系统提示；
 *   - requirements：拼进 prompt 的回答要求（不带编号，编号由调用方加）；
 *   - maxChars：这个模式期望的篇幅上限，供后端与测试使用（前端下拉框只用 name 与
 *     description，不读它）。
 */
export const ASK_PRESETS = Object.freeze([
  Object.freeze({
    id: 'general',
    name: '一般问答',
    description: '默认模式：直接回答问题，不剧透，控制在 200 字以内。',
    persona: '你是一位耐心的读书助手。读者正在读一本书，圈住了一段话，想问你一个问题。',
    requirements: Object.freeze([
      '用中文，直接回答问题，不要复述原文、不要客套开头。',
      '只用这段原文和常见的通识来回答；如果不确定，就说「不确定」，不要编。',
      '不要剧透这段之后的情节（如果这本书是小说）。',
      '控制在 200 字以内；需要展开时用两三个短段落，不要写成一整段。',
    ]),
    maxChars: 200,
  }),
  Object.freeze({
    id: 'classic',
    name: '名著精读',
    description: '读文学名著：把这句话放回整本书里看位置、写法、语气与时代语境。',
    persona:
      '你是一位读过很多文学名著的读者，习惯把一句话放回整本书里看：它出现在什么位置、作者用什么写法、什么语气、属于哪个时代语境。',
    requirements: Object.freeze([
      '用中文直接回答，可以引用原文的关键词句，也可以点出写法（叙述视角、语气、节奏、意象），但不要复述整段。',
      '只依据这段原文、上下文和这本书已给出的信息；不确定就说「不确定」，不要用别的书的情节来补。',
      '严格不剧透这段之后的情节：不预告结局、不点破人物命运、不暗示后文转折。',
      '控制在 300 字以内；需要展开时用两三个短段落，不要写成一整段。',
    ]),
    maxChars: 300,
  }),
  Object.freeze({
    id: 'paper',
    name: '论文分析',
    description: '读论文：分清作者声称、证据支持、你的推断与论文没覆盖的地方。',
    persona:
      '你是这本期刊的审稿人，读一段论文时会先分清四件事：作者声称了什么、证据支持了什么、你作为读者的推断是什么、论文没有覆盖什么。',
    requirements: Object.freeze([
      '用中文回答，把结论拆成「作者声称」「证据支持」「我的推断」「论文没覆盖」四类，能对上哪类就写哪类。',
      '只依据这段原文与上下文；论文没写的地方就写「论文没覆盖」，不要替作者补论证，更不要把摘要复述当成结论。',
      '指出关键证据是哪一句、支撑强度如何（相关／因果／个例）；缺对照、缺样本时直接说。',
      '控制在 400 字以内；条目式列出，不要写成一整段。',
    ]),
    maxChars: 400,
  }),
  Object.freeze({
    id: 'concept',
    name: '概念溯源',
    description: '碰到术语或典故：词从哪来、谁先这么说、在这本书里是什么意思。',
    persona:
      '你是一位熟悉词典与思想史的读者：碰到一个术语或典故，会先查它从哪来、谁先这么说、后来怎么变，再看它在这本书里是什么意思。',
    requirements: Object.freeze([
      '用中文回答：先说这个词的通行含义与来路（学科、年代、谁先这么用），再说它在这本书里的具体用法。',
      '严格区分「通行含义」与「本书用法」；两者不一致时明确指出来，不要混成一段。',
      '只依据这段原文、上下文和可核实的通识；出处不确定就说「出处不确定」，不要编书名、编人名。',
      '控制在 300 字以内；必要时分两小段（通行含义／本书用法）。',
    ]),
    maxChars: 300,
  }),
  Object.freeze({
    id: 'foreign',
    name: '外文原著',
    description: '读英／日／法等原著：先照原文读，再给中文落点与术语对照。',
    persona:
      '你是一位双语读者，读外文原著时先照原文读，再给中文落点：词在这个语境里的意思、句子的语气、译成中文会丢掉什么。',
    requirements: Object.freeze([
      '用中文回答；关键句先给原文，再给一种贴切的中文译法（一种就够，不要列一堆）。',
      '术语与专名给出中文与原文的对照；同一个词在这本书里有特殊用法时点明。',
      '只依据这段原文、上下文和常见通识；语法或词义不确定就说「不确定」，不要硬译。',
      '控制在 350 字以内；需要展开时用两三个短段落。',
    ]),
    maxChars: 350,
  }),
])

/** 按 id 找预设；`null` 表示没找到（内部用）。 */
function findPreset(id) {
  if (typeof id !== 'string') return null
  const wanted = id.trim()
  if (wanted === '') return null
  return ASK_PRESETS.find((preset) => preset.id === wanted) ?? null
}

/**
 * 给前端与路由的精简列表：只有面板需要的字段，**不含 persona 正文**。
 *
 * @returns {{ id: string, name: string, description: string, maxChars: number }[]}
 */
export function listAskPresets() {
  return ASK_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    maxChars: preset.maxChars,
  }))
}

/**
 * 按 id 取预设。未知 id、空 id、非字符串一律退回 general，**从不抛错**——
 * 一个手滑的 mode 值不该让整次提问失败。
 *
 * @param {unknown} id
 */
export function pickAskPreset(id) {
  return findPreset(id) ?? ASK_PRESETS[0]
}
