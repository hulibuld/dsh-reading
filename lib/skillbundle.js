/**
 * skillbundle.js —— 把 `skills/` 下随包分发的所有 skill 一次性注册进宿主。
 *
 * 为什么不再一个一个 import：0.11.0 起，随包分发的 skill 从一个长到五个（陪读教练、
 * 拆书、论文精读、文献综述、笔记成文），再往后还会加。每加一个就去 index.js 里手写
 * 一段 `registerXxxSkill(ctx)`，迟早漏一个——而且漏了不会报错，用户只是永远触发不到。
 * 这里改成扫目录：目录里有 SKILL.md 就注册，加 skill 只需要加目录。
 *
 * 三条纪律（沿用 coachskill.js 那套）：
 *   1. **skills 服务不一定在**：宿主没装 skill 插件、或旧版本没有这个服务时静默跳过，
 *      阅读器本身照样能用。
 *   2. **一个坏不拖垮其他**：某个 SKILL.md 写坏了只 warn，剩下的照旧注册。
 *   3. **注册包在 `ctx.effect` 里，并把 disposer 一起交出去**：卸载时自己摘干净。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitFrontmatter } from './coachskill.js'

/** `skills/` 根目录。package.json 的 `files` 白名单必须包含 `skills`，否则发包时被丢掉。 */
export const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

/**
 * 列出 `skills/` 下所有带 SKILL.md 的子目录，按目录名排序。
 *
 * 排序是为了顺序稳定：注册顺序影响宿主那边技能表的排列，也影响测试断言。
 * 目录不存在、读不动都返回空数组——找不到 skill 不是错误，只是没有。
 *
 * @param {string} [root]
 * @returns {string[]} 绝对路径
 */
export function listSkillDirs(root = SKILLS_ROOT) {
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    try {
      if (!statSync(join(dir, 'SKILL.md')).isFile()) continue
    } catch {
      continue
    }
    dirs.push(dir)
  }
  return dirs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 读一个 skill 目录。frontmatter 只认 name 与 description（见 splitFrontmatter）。
 *
 * @param {string} dir
 */
export function loadSkillDir(dir) {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const { name, description, body } = splitFrontmatter(text)
  return { name, description, content: body, resourceDir: dir }
}

/**
 * 注册 `skills/` 下全部 skill。
 *
 * @param {any} ctx - Cordis Context
 * @param {{ logger?: Pick<Console, 'warn'>, root?: string }} [options]
 * @returns {boolean} 有没有至少注册上一个（宿主没有 skills 服务时 false）
 */
export function registerAllSkills(ctx, options = {}) {
  const logger = options.logger ?? console
  const skills = ctx && typeof ctx.get === 'function' ? ctx.get('skills', false) : null
  if (!skills || typeof skills.register !== 'function') {
    // 不是错误：宿主不带 skills 服务时，阅读器本身照样能用。
    return false
  }

  const dirs = listSkillDirs(options.root)
  if (dirs.length === 0) return false

  let registered = 0
  const registerAll = () => {
    // 宿主的 register 会返回一个 disposer。**必须收好**：光靠 effect 摘不掉已经
    // 注册进技能表的条目，卸载/重载之后旧条目还留在表里，再注册一次就成了重复。
    const disposers = []
    for (const dir of dirs) {
      try {
        const loaded = loadSkillDir(dir)
        const dispose = skills.register({
          name: loaded.name,
          description: loaded.description,
          content: loaded.content,
          invocation: { modelInvocable: false, userInvocable: true },
          provider: 'dsh-reading',
          source: 'bundled',
          resourceBase: { kind: 'directory', path: loaded.resourceDir },
        })
        registered += 1
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        // 单个坏了只记一笔：别的 skill 还要能用。
        logger.warn(`[dsh-reading] skill 读不出来，跳过 ${dir}：`, error && error.message)
      }
    }
    // effect 的回调返回值就是「撤销」：宿主卸载时按这个摘。
    return () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch (error) {
          // 摘一个失败不该挡住摘剩下的。
          logger.warn('[dsh-reading] skill 摘不掉：', error && error.message)
        }
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    // effect 会立刻跑一次回调，并把「卸载时怎么撤销」记进宿主
    ctx.effect(registerAll, 'dsh-reading: 随包 skill')
  } else {
    registerAll()
  }
  return registered > 0
}
