#!/usr/bin/env node
/**
 * 读者画像（0.13.0 P4）的测试。
 *
 * 这一层最怕两件事，所以断言全围着它们转：
 *
 *   1. **画像编数字**。界面那句话里的每个数都必须能从问答记录里数出来。
 *      这里造一批成分已知的问答，逐字比对「问过几个、几个集中在哪章」。
 *   2. **画像改坏 prompt**。画像只是「硬性要求」的第 5 条，前四条必须一字不动；
 *      没有画像时，prompt 必须与加这个功能之前逐字一致。
 *
 * 另外钉住 docs/26 §6.5 的坑：停用词要真的挡得住「这个」「什么」，
 * 零问答必须返回 null 而不是一份空画像（界面据此说「还没问过」，不显示 0）。
 */

import assert from 'node:assert/strict'

import {
  MAX_FOCUS,
  PROFILE_VERSION,
  buildProfile,
  focusTerms,
  profilePromptLine,
  profileSentence,
} from '../lib/profile.js'
import { buildChapterPrompt, buildSkeletonPrompt } from '../lib/distill.js'

/** 一批成分已知的问答：5 条，3 条 concept 集中在第三章，2 条 general 在第五章。 */
const QA = [
  { question: '检视阅读和主题阅读的区别是什么？', mode: 'concept', chapterHref: 'text/ch1.xhtml', chapterLabel: '第三章' },
  { question: '检视阅读到底要怎么练？', mode: 'concept', chapterHref: 'text/ch1.xhtml', chapterLabel: '第三章' },
  { question: '主题阅读的步骤能不能照着做？', mode: 'concept', chapterHref: 'text/ch1.xhtml', chapterLabel: '第三章' },
  { question: '主动阅读是什么意思？', mode: 'general', chapterHref: 'text/ch2.xhtml', chapterLabel: '第五章' },
  { question: '这本书讲了什么？', mode: 'general', chapterHref: 'text/ch2.xhtml', chapterLabel: '第五章' },
]

export default async function run() {
  let passed = 0
  const cases = {
    '零问答：画像为 null，不去编一份空统计'() {
      assert.equal(buildProfile({ bookHash: 'abc', qa: [] }), null)
      assert.equal(buildProfile({ bookHash: 'abc' }), null)
      assert.equal(buildProfile({}), null)
    },

    '零问答：界面那句话是 null，不是「0 个问题」'() {
      assert.equal(profileSentence(null), null)
      assert.equal(profileSentence(buildProfile({ qa: [] })), null)
      assert.equal(profilePromptLine(null), '')
      assert.equal(profilePromptLine(buildProfile({ qa: [] })), '')
    },

    '统计数字与输入一一对得上'() {
      const profile = buildProfile({ bookHash: 'abc', qa: QA })
      assert.equal(profile.version, PROFILE_VERSION)
      assert.equal(profile.bookHash, 'abc')
      assert.equal(profile.askedCount, 5)
      assert.deepEqual(profile.modes, { concept: 3, general: 2 })
      assert.equal(profile.chapters[0].label, '第三章')
      assert.equal(profile.chapters[0].count, 3)
      assert.equal(profile.chapters[1].label, '第五章')
      assert.equal(profile.chapters[1].count, 2)
    },

    '全用 concept 问的书：concept 就是最大值'() {
      const profile = buildProfile({
        bookHash: 'abc',
        qa: QA.filter((item) => item.mode === 'concept'),
      })
      const counts = Object.values(profile.modes)
      assert.equal(Math.max(...counts), profile.modes.concept)
      assert.equal(profile.note, '给出处，少用形容')
    },

    '停用词表生效：这个 / 什么 不进 focus'() {
      const terms = focusTerms(['这个什么意思', '那个怎么理解', '这个什么区别'])
      assert.deepEqual(terms, [])
      const profile = buildProfile({
        qa: [
          { question: '这个什么？', mode: 'general' },
          { question: '那个怎么？', mode: 'general' },
        ],
      })
      assert.deepEqual(profile.focus, [])
    },

    'focus 只留真词，且不超过上限'() {
      const profile = buildProfile({ bookHash: 'abc', qa: QA })
      assert.ok(profile.focus.length > 0, '有实质问题时不该是空名单')
      assert.ok(profile.focus.length <= MAX_FOCUS)
      assert.equal(profile.focus.includes('检视阅读'), true, '反复出现的主题词要能顶上来：' + profile.focus.join('/'))
      assert.equal(profile.focus.includes('主题阅读'), true)
      for (const term of profile.focus) {
        assert.equal(term.length >= 2, true, '单词不该进名单：' + term)
        assert.equal(term.includes('什么'), false, '疑问骨架不该进名单：' + term)
      }
    },

    '切出来的半个词会被挡掉（题阅读的、是什 这类）'() {
      const profile = buildProfile({ bookHash: 'abc', qa: QA })
      for (const term of profile.focus) {
        assert.equal(/^[的了是在]/.test(term), false, '不该以虚字开头：' + term)
        assert.equal(/[的了是在]$/.test(term), false, '不该以虚字结尾：' + term)
      }
    },

    '一条问答不算主题：样本太小，任何词都可能是巧合'() {
      assert.deepEqual(focusTerms(['检视阅读到底怎么练']), [])
      const profile = buildProfile({ qa: [{ question: '检视阅读到底怎么练', mode: 'concept' }] })
      assert.equal(profile.askedCount, 1)
      assert.deepEqual(profile.focus, [])
    },

    '老记录没有 mode：按 general 算，不报错'() {
      const profile = buildProfile({
        qa: [
          { question: '这里讲了什么', chapterHref: 'a.xhtml', chapterLabel: '第一章' },
          { question: '这一段什么意思', chapterHref: 'a.xhtml', chapterLabel: '第一章' },
        ],
      })
      assert.deepEqual(profile.modes, { general: 2 })
      assert.equal(profile.chapters[0].count, 2)
    },

    '界面那句话的措辞（数字必须来自记录）'() {
      const profile = buildProfile({ bookHash: 'abc', qa: QA })
      const sentence = profileSentence(profile)
      assert.equal(sentence.head, '这本书你问过 5 个问题，3 个集中在第三章。')
      assert.match(sentence.tail, /多半在问术语（3 次「概念溯源」）。/)
      assert.match(sentence.tail, /笔记会给出处，少用形容。/)
    },

    '问答太少时不硬说「集中在某一章」'() {
      const profile = buildProfile({
        qa: [
          { question: '第一章讲了什么', mode: 'general', chapterHref: 'a.xhtml', chapterLabel: '第一章' },
          { question: '第二章讲了什么', mode: 'general', chapterHref: 'b.xhtml', chapterLabel: '第二章' },
        ],
      })
      assert.equal(profileSentence(profile).head, '这本书你问过 2 个问题。')
    },

    '画像进 prompt 的方式：追加成第 5 条，前四条一字不动'() {
      const plain = buildChapterPrompt({ bookTitle: 'X', chapterLabel: '第一章', chapterText: '正文' })
      const withProfile = buildChapterPrompt({
        bookTitle: 'X',
        chapterLabel: '第一章',
        chapterText: '正文',
        readerLine: '这位读者问过 5 个问题。写给他时给出处，少用形容。',
      })
      assert.equal(plain.includes('5. '), false, '没有画像时不该出现第 5 条')
      for (const line of [
        '1. quote / text 必须从上面原文里**逐字复制**，不许改写、不许拼接、不许翻译。找不到合适的就少写几条。',
        '2. methods 只在原文确实给了做法时才有；每条 method 的 when / check 不能空，steps 至少两步。',
        '3. points 2–6 条，terms 0–6 条，methods 0–4 条，quotes 0–4 条。没有就给空数组。',
        '4. 不要评价这本书好不好，只提取。',
      ]) {
        assert.equal(plain.includes(line), true, '原有要求丢了：' + line)
        assert.equal(withProfile.includes(line), true, '带画像时原有要求也不许丢：' + line)
      }
      assert.equal(withProfile.includes('5. 这位读者问过 5 个问题。'), true)
      assert.equal(withProfile.includes('第 1 条不变'), true, '要说清「逐字抄」这条不被画像松动')
    },

    '画像进 prompt 的方式：骨架的四个字段一个不少'() {
      const plain = buildSkeletonPrompt({ bookTitle: 'X', chapters: [{ label: '第一章', thesis: '论点' }] })
      const withProfile = buildSkeletonPrompt({
        bookTitle: 'X',
        chapters: [{ label: '第一章', thesis: '论点' }],
        readerLine: '这位读者问过 5 个问题。',
      })
      for (const field of ['"oneLine"', '"thesis"', '"structure"', '"audience"']) {
        assert.equal(plain.includes(field), true, '骨架字段丢了：' + field)
        assert.equal(withProfile.includes(field), true, '带画像时骨架字段也不许丢：' + field)
      }
      assert.equal(plain.includes('读这本书的人'), false)
      assert.equal(withProfile.includes('读这本书的人：这位读者问过 5 个问题。'), true)
    },

    '画像那句话把统计说全：问过多少 / 集中哪章 / 什么词 / 怎么写'() {
      const line = profilePromptLine(buildProfile({ bookHash: 'abc', qa: QA }))
      assert.match(line, /问过 5 个问题/)
      assert.match(line, /3 个集中在「第三章」/)
      assert.match(line, /多半在问术语/)
      assert.match(line, /反复出现的词：/)
      assert.match(line, /写给他时/)
    },
  }

  for (const [name, fn] of Object.entries(cases)) {
    await fn()
    passed += 1
    console.log('  ok  ' + name)
  }
  console.log('读者画像单测：' + passed + ' 项断言全部通过')
}
