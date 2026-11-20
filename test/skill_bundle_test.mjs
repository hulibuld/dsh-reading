/**
 * 随包 skill 批量注册（0.11.0）的测试。
 *
 * 为什么要有这层测试：注册是「扫目录」的，一件坏事很容易静默发生——目录少扫一层、
 * 排序不稳定、某个 SKILL.md 写坏了把后面的全带崩。这些都不会报错，用户只是
 * 永远触发不到那个 skill。所以这里既测真实 `skills/` 目录（五个都在、顺序稳定），
 * 也造临时目录测坏文件与边界。
 *
 * 另外钉住注册契约：provider/source/resourceBase/invocation 四个字段错了，
 * 宿主那边要么不认，要么把 skill 装成一个没有资源的空壳。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { basename, join } from 'node:path'

import { SKILLS_ROOT, listSkillDirs, loadSkillDir, registerAllSkills } from '../lib/skillbundle.js'

/** 临时技能根目录，测完删掉。 */
async function tempRoot(files) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'dsh-reading-skills-'))
  for (const [name, body] of Object.entries(files)) {
    const skillDir = join(dir, name)
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(join(skillDir, 'SKILL.md'), body, 'utf8')
  }
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

const GOOD = (name) => `---\nname: ${name}\ndescription: ${name} 的说明，够长到能看出它是干什么用的。\n---\n\n# ${name}\n`

export default async function run() {
  let passed = 0
  const cases = {
    '真实 skills/ 下五个 skill 都在，且都有 SKILL.md'() {
      const dirs = listSkillDirs(SKILLS_ROOT)
      const names = dirs.map((dir) => basename(dir))
      assert.ok(names.includes('reading-coach'), `没扫到陪读教练：${names.join(',')}`)
      assert.ok(names.length >= 5, `只扫到 ${names.length} 个：${names.join(',')}`)
      for (const dir of dirs) {
        const skill = loadSkillDir(dir)
        assert.ok(skill.name !== '', `${basename(dir)} 解析不出 name`)
        assert.ok(skill.description.length > 10, `${basename(dir)} 的描述太短`)
        assert.ok(skill.content.length > 200, `${basename(dir)} 正文太短，撑不起一套方法`)
        assert.equal(skill.resourceDir, dir)
      }
    },

    '顺序按目录名排序，重复调用完全一样'() {
      const first = listSkillDirs(SKILLS_ROOT)
      const second = listSkillDirs(SKILLS_ROOT)
      assert.deepEqual(second, first)
      const names = first.map((dir) => basename(dir))
      assert.deepEqual(names, [...names].sort(), `顺序不是目录名升序：${names.join(',')}`)
    },

    '只认带 SKILL.md 的子目录，缺目录 / 空目录返回空数组'() {
      assert.deepEqual(listSkillDirs(join(os.tmpdir(), 'dsh-reading-no-such-root-xyz')), [])
      assert.deepEqual(listSkillDirs(''), [])
    },

    '临时目录里：没有 SKILL.md 的子目录被跳过，坏的 SKILL.md 不影响别人'() {
      return (async () => {
        const { dir, cleanup } = await tempRoot({
          'b-skill': GOOD('b-skill'),
          'a-skill': GOOD('a-skill'),
          'c-broken': '---\ndescription: 没有 name 的坏文件\n---\n正文\n',
          'd-no-skill-md': '',
        })
        try {
          // 删掉 d 的 SKILL.md，让它变成「不是 skill 的目录」
          await fs.rm(join(dir, 'd-no-skill-md', 'SKILL.md'))
          const names = listSkillDirs(dir).map((item) => basename(item))
          assert.deepEqual(names, ['a-skill', 'b-skill', 'c-broken'], '扫描结果不对')

          const seen = []
          const warns = []
          const ok = registerAllSkills(
            {
              get: () => ({ register: (input) => { seen.push(input); return () => {} } }),
              effect: (fn) => fn(),
            },
            { root: dir, logger: { warn: (...args) => warns.push(args.join(' ')) } },
          )
          assert.equal(ok, true, '有能注册的 skill 就该返回 true')
          assert.deepEqual(seen.map((item) => item.name), ['a-skill', 'b-skill'], '坏的应当被跳过，好的要全注册上')
          assert.equal(warns.length, 1, `坏文件应当只 warn 一次，实际 ${warns.length} 次`)
          assert.match(warns[0], /c-broken/, '警告里要能看出是哪个目录坏了')
          for (const input of seen) {
            assert.equal(input.content.startsWith('---'), false, '注册的应当是正文，不带 frontmatter')
          }
        } finally {
          await cleanup()
        }
      })()
    },

    '宿主没有 skills 服务时返回 false，不抛错'() {
      assert.equal(registerAllSkills(null), false)
      assert.equal(registerAllSkills({}), false)
      assert.equal(registerAllSkills({ get: () => null }), false)
      assert.equal(registerAllSkills({ get: () => ({}) }), false, 'service 没有 register 也算不在')
      // 有服务但一个 skill 都没有，同样是 false（没有东西可注册）
      return (async () => {
        const { dir, cleanup } = await tempRoot({})
        try {
          const ok = registerAllSkills(
            { get: () => ({ register: () => {} }), effect: (fn) => fn() },
            { root: dir, logger: { warn() {} } },
          )
          assert.equal(ok, false)
        } finally {
          await cleanup()
        }
      })()
    },

    '有 skills 服务时按契约注册：provider/source/resourceBase/invocation'() {
      const seen = []
      const effects = []
      const undone = []
      let undo = null
      const ok = registerAllSkills(
        {
          get: () => ({ register: (input) => { seen.push(input); return () => undone.push(input.name) } }),
          effect: (fn, label) => { effects.push(label); undo = fn() },
        },
        { logger: { warn() {} } },
      )
      assert.equal(ok, true)
      assert.equal(effects.length, 1, '必须走 ctx.effect，卸载时才摘得掉')
      assert.equal(typeof undo, 'function', 'effect 的回调要把撤销函数交出去')

      const dirs = listSkillDirs(SKILLS_ROOT)
      assert.equal(seen.length, dirs.length, '扫到几个就该注册几个')
      for (const input of seen) {
        assert.equal(input.provider, 'dsh-reading')
        assert.equal(input.source, 'bundled')
        assert.equal(input.resourceBase.kind, 'directory')
        assert.ok(
          dirs.some((dir) => dir === input.resourceBase.path),
          `resourceBase.path 不在 skills/ 里：${input.resourceBase.path}`,
        )
        assert.equal(basename(input.resourceBase.path), input.name, '目录名与 skill 名应当对应')
        // 同 coach_skill_test：本机由 reapply-hide-skill-catalog.mjs 压成 false。
        assert.equal(input.invocation.modelInvocable, false, '本机隐藏模型可调用目录，应为 false')
        assert.equal(input.invocation.userInvocable, true)
      }
      const names = seen.map((item) => item.name)
      assert.ok(names.includes('reading-coach'), `注册列表里没有陪读教练：${names.join(',')}`)
      assert.deepEqual(names, [...new Set(names)], '同名 skill 不能注册两次')

      // 撤销要摘掉全部，且与注册一一对应（少摘一个就是宿主里留了一条幽灵 skill）。
      // 摘的顺序是反着来的（栈），所以比集合而不是比顺序。
      undo()
      assert.deepEqual([...undone].sort(), [...names].sort(), '注册几个就要摘几个')
    },

    '不写死 skill 名单：新增目录会被自动发现'() {
      return (async () => {
        const { dir, cleanup } = await tempRoot({
          'a-skill': GOOD('a-skill'),
          'zz-new-skill': GOOD('zz-new-skill'),
        })
        try {
          const seen = []
          registerAllSkills(
            {
              get: () => ({ register: (input) => { seen.push(input.name); return () => {} } }),
              effect: (fn) => fn(),
            },
            { root: dir, logger: { warn() {} } },
          )
          assert.deepEqual(seen, ['a-skill', 'zz-new-skill'])
        } finally {
          await cleanup()
        }
      })()
    },

    // effect 的回调返回值就是「卸载时怎么摘」。丢掉它，宿主那边技能表里的条目就永远留着，
    // 重载一次就成了两条同名 skill。这里钉住：注册几个就要交回几个 disposer，且真能摘。
    '注册时收好每个 disposer，effect 的回调把它交给宿主'() {
      return (async () => {
        const { dir, cleanup } = await tempRoot({
          'a-skill': GOOD('a-skill'),
          'b-skill': GOOD('b-skill'),
        })
        try {
          const disposed = []
          const warns = []
          let undo = null
          registerAllSkills(
            {
              get: () => ({
                register: (input) => () => {
                  // 第一个 disposer 故意抛：摘一个失败不能挡住摘剩下的。
                  if (input.name === 'a-skill') throw new Error('摘不掉 a')
                  disposed.push(input.name)
                },
              }),
              effect: (fn) => { undo = fn() },
            },
            { root: dir, logger: { warn: (...args) => warns.push(args.join(' ')) } },
          )
          assert.equal(typeof undo, 'function', 'effect 的回调必须返回一个撤销函数')
          undo()
          assert.deepEqual(disposed, ['b-skill'], 'b 该被摘掉（后面的不能被前面挡）')
          assert.equal(warns.length, 1, '摘不掉的要为它留一条警告')
          assert.match(warns[0], /摘不掉/)
        } finally {
          await cleanup()
        }
      })()
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
  console.log(`skill-bundle: ${passed} 项通过`)
}
