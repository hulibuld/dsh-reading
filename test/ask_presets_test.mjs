/**
 * 「问 AI 五个模式预设」（0.11.0）的测试。
 *
 * 这一层最怕的不是功能没做，而是**悄悄改坏了默认模式**：老用户不带 mode，
 * 拿到的 prompt 必须和 0.10.3 一字不差。所以这里的第一条断言就是逐字比对，
 * 而不是「差不多」。
 *
 * 另外钉两件容易复发的事：
 *   · 模式只能换开场段与「回答要求」，书名/原文/问题几段不许丢；
 *   · persona 是给模型的系统提示，不该出现在给前端的列表里。
 */

import assert from 'node:assert/strict'

import {
  ASK_PRESETS,
  DEFAULT_ASK_PRESET,
  listAskPresets,
  pickAskPreset,
} from '../lib/askpresets.js'
import { buildAskPrompt } from '../lib/ask.js'

const EXPECTED_IDS = ['general', 'classic', 'paper', 'concept', 'foreign']

/** 一段能同时验「书名、原文、问题都带上了」的输入。 */
const SAMPLE = {
  selectedText: '一个人可以被毁灭，但不能被打败。',
  question: '这句话到底在说什么？',
  bookTitle: '老人与海',
  author: '海明威',
  chapterLabel: '第 20 章',
  surroundingText: '前面的话一个人可以被毁灭，但不能被打败。后面的话',
}

export default async function run() {
  let passed = 0
  const cases = {
    '五个模式都在，顺序与 id 稳定'() {
      assert.deepEqual(
        ASK_PRESETS.map((preset) => preset.id),
        EXPECTED_IDS,
      )
      assert.equal(DEFAULT_ASK_PRESET, 'general')
      for (const preset of ASK_PRESETS) {
        assert.ok(preset.name !== '', `${preset.id} 缺 name`)
        assert.ok(preset.description.length > 10, `${preset.id} 的 description 太短，界面说不清它是什么`)
        assert.ok(preset.persona.length > 10, `${preset.id} 缺 persona`)
        assert.ok(Array.isArray(preset.requirements) && preset.requirements.length >= 3, `${preset.id} 的要求太少`)
        assert.ok(Number.isInteger(preset.maxChars) && preset.maxChars > 0, `${preset.id} 的 maxChars 不对`)
      }
    },

    'general 逐字等于 0.10.3：不带 mode 与 mode=general 的 prompt 完全相同'() {
      const bare = buildAskPrompt(SAMPLE)
      const explicit = buildAskPrompt({ ...SAMPLE, mode: 'general' })
      assert.equal(explicit, bare)

      // 再把开场与四条要求逐字钉住：这是向后兼容的锚点，改一个字老用户就能感觉到
      assert.ok(
        bare.startsWith('你是一位耐心的读书助手。读者正在读一本书，圈住了一段话，想问你一个问题。'),
        `开场段被改了：${bare.slice(0, 60)}`,
      )
      assert.ok(bare.endsWith([
        '回答要求：',
        '1. 用中文，直接回答问题，不要复述原文、不要客套开头。',
        '2. 只用这段原文和常见的通识来回答；如果不确定，就说「不确定」，不要编。',
        '3. 不要剧透这段之后的情节（如果这本书是小说）。',
        '4. 控制在 200 字以内；需要展开时用两三个短段落，不要写成一整段。',
      ].join('\n')), 'general 的四条回答要求被改了')
    },

    '未知 id / 空 id / 非字符串一律退回 general，不抛'() {
      assert.equal(pickAskPreset('general').id, 'general')
      assert.equal(pickAskPreset('nope').id, 'general')
      assert.equal(pickAskPreset('').id, 'general')
      assert.equal(pickAskPreset('   ').id, 'general')
      assert.equal(pickAskPreset(null).id, 'general')
      assert.equal(pickAskPreset(undefined).id, 'general')
      assert.equal(pickAskPreset(42).id, 'general')
      // 走 buildAskPrompt 也必须是同一条路：手滑的 mode 不该让整次提问失败
      assert.equal(buildAskPrompt({ ...SAMPLE, mode: 'nope' }), buildAskPrompt(SAMPLE))
    },

    '每个模式都带书名/原文/问题，且不含别的模式独有的要求'() {
      const prompts = new Map()
      for (const preset of ASK_PRESETS) {
        const prompt = buildAskPrompt({ ...SAMPLE, mode: preset.id })
        prompts.set(preset.id, prompt)
        assert.ok(prompt.includes('老人与海'), `${preset.id} 丢了书名`)
        assert.ok(prompt.includes('海明威'), `${preset.id} 丢了作者`)
        assert.ok(prompt.includes('第 20 章'), `${preset.id} 丢了当前位置`)
        assert.ok(prompt.includes(SAMPLE.selectedText), `${preset.id} 丢了圈住的原文`)
        assert.ok(prompt.includes(`读者的问题：${SAMPLE.question}`), `${preset.id} 丢了问题`)
        assert.ok(prompt.includes('这段文字的上下文'), `${preset.id} 丢了上下文块`)
        assert.ok(prompt.includes(preset.persona), `${preset.id} 的开场不是它自己的 persona`)
        for (const [index, line] of preset.requirements.entries()) {
          assert.ok(prompt.includes(`${index + 1}. ${line}`), `${preset.id} 的第 ${index + 1} 条要求没编号拼进去`)
        }
      }

      // 模式之间不能互相串词：拿每个模式独有的一条要求去别的模式里找
      for (const preset of ASK_PRESETS) {
        const prompt = prompts.get(preset.id)
        for (const other of ASK_PRESETS) {
          if (other.id === preset.id) continue
          for (const line of other.requirements) {
            if (preset.requirements.includes(line)) continue
            assert.ok(!prompt.includes(line), `${preset.id} 的 prompt 混进了 ${other.id} 的要求：${line}`)
          }
        }
        // 只有 general 用那句开场，别的模式不该也用它
        if (preset.id !== 'general') {
          assert.ok(
            !prompt.includes('你是一位耐心的读书助手。'),
            `${preset.id} 还在用 general 的开场段`,
          )
        }
      }
    },

    'listAskPresets 给前端：字段齐，但不泄露 persona'() {
      const list = listAskPresets()
      assert.deepEqual(list.map((item) => item.id), EXPECTED_IDS)
      const known = new Set([...ASK_PRESETS.map((p) => p.persona), ...ASK_PRESETS.map((p) => p.requirements.join(''))])
      for (const item of list) {
        assert.deepEqual(Object.keys(item).sort(), ['description', 'id', 'maxChars', 'name'])
        assert.equal(item.persona, undefined, `${item.id} 把 persona 泄给前端了`)
        assert.ok(!known.has(item.description), `${item.id} 的 description 是 persona 正文`)
      }
      // 列表是新建的浅拷贝：改它不该污染预设本体
      list[0].name = '被改了'
      assert.equal(ASK_PRESETS[0].name, '一般问答')
    },
  }

  for (const [name, fn] of Object.entries(cases)) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      console.error(`  ✗ ${name}`)
      throw error
    }
  }
  console.log(`ask-presets: ${passed} 项通过`)
}
