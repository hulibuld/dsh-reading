/**
 * 把打包在插件里的「陪读教练」注册成 DSH 的一个 skill。
 *
 * 为什么要有这一层：插件里除了界面，还有「怎么读」这件事本身。陪读那套提问法写在
 * SKILL.md 里，交给宿主的 skills 服务注册，用户在聊天里说「陪读」「带我读这本书」
 * 就能被载入。硬编进某一段 prompt 的话，用户永远看不见它在说什么，也改不了。
 *
 * 三条纪律：
 *   1. **skills 服务不一定在**。宿主没装 skill 插件、或旧版本没有这个服务时，这里
 *      静默跳过——陪读是可选功能，不能因为它把整个阅读器拖成不加载。
 *   2. 注册要包在 `ctx.effect` 里：卸载时自己摘干净，别在宿主里留一条野记录。
 *   3. SKILL.md 的 frontmatter 只认 name 与 description。解析失败要说清是哪一行，
 *      别让宿主那边显示一个没有描述的空 skill。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** skill 目录。package.json 的 `files` 白名单必须包含 `skills`，否则发包时被丢掉。 */
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'reading-coach')

/** skill 在宿主里的名字。改它等于换掉用户记住的那个词，别随手改。 */
export const SKILL_NAME = 'reading-coach'

/**
 * 拆 `---` 之间的 frontmatter。
 *
 * 只支持「一行一个 key: value」这个最小子集：SKILL.md 是我们自己写的，不需要完整
 * YAML。真需要嵌套或数组时再换解析器，别在这里预埋。
 *
 * @param {string} text
 * @returns {{ name: string, description: string, body: string }}
 */
export function splitFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = source.split('\n')
  if (lines[0].trim() !== '---') {
    throw new Error('SKILL.md 第一行必须是 ---')
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) {
    throw new Error('SKILL.md 的 frontmatter 没有闭合的 ---')
  }
  const meta = {}
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '') meta[key] = value
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  if (!meta.name) throw new Error('SKILL.md 的 frontmatter 缺 name')
  if (!meta.description) throw new Error('SKILL.md 的 frontmatter 缺 description')
  return { name: meta.name, description: meta.description, body }
}

/**
 * 读 SKILL.md 并解析。测试可以喂目录，生产走默认目录。
 *
 * @param {string} [dir]
 */
export function loadCoachSkill(dir = SKILL_DIR) {
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  const { name, description, body } = splitFrontmatter(text)
  return { name, description, content: body, resourceDir: dir }
}

/**
 * 注册这个 skill。宿主没有 skills 服务时返回 false，不动任何东西。
 *
 * @param {any} ctx - Cordis Context
 * @param {{ logger?: Pick<Console, 'warn'> }} [options]
 * @returns {boolean} 真的注册上了没有
 */
export function registerCoachSkill(ctx, options = {}) {
  const logger = options.logger ?? console
  const skills = ctx && typeof ctx.get === 'function' ? ctx.get('skills', false) : null
  if (!skills || typeof skills.register !== 'function') {
    // 不是错误：宿主不带 skills 服务时，阅读器本身照样能用。
    return false
  }

  let loaded
  try {
    loaded = loadCoachSkill()
  } catch (error) {
    logger.warn('[dsh-reading] 陪读 skill 读不出来，跳过注册：', error && error.message)
    return false
  }

  const register = () =>
    skills.register({
      name: loaded.name,
      description: loaded.description,
      content: loaded.content,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-reading',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: loaded.resourceDir },
    })

  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-reading: 陪读 skill')
  } else {
    register()
  }
  return true
}
