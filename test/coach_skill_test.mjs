/**
 * 陪读教练 skill（0.9.6）的测试。
 *
 * 测三件事：
 *   1. SKILL.md 真在包里，frontmatter 能被解析出 name 与 description；
 *   2. 宿主没有 skills 服务时注册函数返回 false，绝不抛错（这是可选功能）；
 *   3. 有的注册时，参数形状对：名字、provider、source、resourceBase 都在。
 *
 * 另外钉住一条容易复发的东西：`package.json` 的 `files` 白名单必须含 `skills`，
 * 否则 npm 发包时整个目录被丢掉，本地测试全绿、装到别人机器上 skill 消失。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SKILL_DIR,
  SKILL_NAME,
  splitFrontmatter,
  loadCoachSkill,
  registerCoachSkill,
} from '../lib/coachskill.js'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

export default async function run() {
  let passed = 0
  const cases = {
    'SKILL.md 在包里且能解析出名字与描述'() {
      const skill = loadCoachSkill()
      assert.equal(skill.name, SKILL_NAME)
      assert.ok(skill.description.length > 20, '描述太短，模型不知道什么时候该用')
      assert.ok(skill.content.includes('# 陪读教练'), '正文少了标题')
      assert.ok(skill.content.length > 800, '正文太短，撑不起一套流程')
      assert.equal(skill.resourceDir, SKILL_DIR)
    },

    '两份 references 都在（找不到就没法按图索骥）'() {
      const design = readFileSync(join(SKILL_DIR, 'references', 'question-design.md'), 'utf8')
      const card = readFileSync(join(SKILL_DIR, 'references', 'card-template.md'), 'utf8')
      assert.ok(design.includes('一次一问'), '问题设计里没有「一次一问」')
      assert.ok(card.includes('5️⃣ 原句'), '卡片模板缺第五维')
    },

    'frontmatter 解析：缺 name 要报错，不能静默通过'() {
      assert.throws(() => splitFrontmatter('---\ndescription: x\n---\nbody'), /缺 name/)
      assert.throws(() => splitFrontmatter('no frontmatter'), /第一行必须是 ---/)
      assert.throws(() => splitFrontmatter('---\nname: a\n'), /没有闭合/)
      const ok = splitFrontmatter('---\nname: a\ndescription: "b c"\n---\n\n正文\n')
      assert.deepEqual(ok, { name: 'a', description: 'b c', body: '正文\n' })
    },

    '宿主没有 skills 服务时返回 false，不抛错'() {
      assert.equal(registerCoachSkill(null), false)
      assert.equal(registerCoachSkill({}), false)
      assert.equal(registerCoachSkill({ get: () => null }), false)
      assert.equal(registerCoachSkill({ get: () => ({}) }), false, 'service 没有 register 也算不在')
    },

    '有 skills 服务时按契约注册（名字/provider/source/resourceBase）'() {
      const seen = []
      const skills = { register: (input) => { seen.push(input); return () => {} } }
      const effects = []
      const ok = registerCoachSkill(
        { get: () => skills, effect: (fn) => { effects.push(fn); fn() } },
        { logger: { warn() {} } },
      )
      assert.equal(ok, true)
      assert.equal(effects.length, 1, '必须走 ctx.effect，卸载时才摘得掉')
      assert.equal(seen.length, 1)
      const input = seen[0]
      assert.equal(input.name, SKILL_NAME)
      assert.equal(input.provider, 'dsh-reading')
      assert.equal(input.source, 'bundled')
      assert.equal(input.resourceBase.kind, 'directory')
      assert.equal(input.resourceBase.path, SKILL_DIR)
      assert.equal(input.invocation.modelInvocable, true)
      assert.equal(input.invocation.userInvocable, true)
      assert.ok(input.content.startsWith('# 陪读教练'), '注册的是正文不是带 frontmatter 的全文')
    },

    '发布白名单里有 skills（否则装到别人机器上 skill 会消失）'() {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
      assert.ok(Array.isArray(pkg.files))
      assert.ok(pkg.files.includes('skills'), `files 白名单缺 skills：${pkg.files.join(',')}`)
    },

    '插件入口真的调了注册（不是只写了模块）'() {
      const entry = readFileSync(join(ROOT, 'index.js'), 'utf8')
      assert.ok(entry.includes("from './lib/coachskill.js'"), '入口没有 import 注册模块')
      assert.ok(entry.includes('registerCoachSkill(ctx'), '入口没有调用 registerCoachSkill')
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
  console.log(`coach-skill: ${passed} 项通过`)
}
