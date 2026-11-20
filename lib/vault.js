/**
 * Obsidian 库（vault.js）：本插件唯一允许碰用户笔记目录的地方。
 *
 * 为什么单独一个文件、而且只在这一处碰盘：Obsidian 库是用户自己的地盘，
 * 里面可能有他几年的日记和论文。写坏一次，信任就没了。所以把「能写哪里、
 * 怎么写、写坏了怎么退」全部关在这一个文件里，别的地方只能调这里的函数，
 * 谁都不许自己拼路径去 fs.writeFile。
 *
 * 四条铁规矩（docs/26 §三）：
 *   1. 原子写：先写 .tmp 再 rename，断电不留半个文件；
 *   2. 覆盖前备份：旧版落到 <vault>/dsh-reading/.history/，只留 20 份；
 *   3. 路径必须在库内：用 base + sep 前缀比对，不用裸 startsWith；
 *   4. 编码固定：UTF-8 无 BOM、\n 换行、结尾一个换行。
 *
 * 只往 <vault>/dsh-reading/ 里写，库根目录跟别人的笔记一个字都不碰。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fail } from './errors.js'
import {
  findBlock,
  normalizeMarkdown,
  removeBlock as removeBlockFromText,
  renderBlock,
  replaceBlock,
} from './blocks.js'

/** 默认子目录名。用户可以在设置里改，但默认就用这个。 */
export const DEFAULT_SUBDIR = 'dsh-reading'

/** 每个文件保留的历史版本数（沿用 store.js:86 的 HISTORY_KEEP）。 */
export const HISTORY_KEEP = 20

/** 备份目录名（放在子目录下，Obsidian 里一眼能看出是本插件的东西）。 */
export const HISTORY_DIR = '.history'

/**
 * Obsidian 的配置文件在各平台的位置。
 *
 * 这里只做「读」，不改这个文件——它归 Obsidian 所有。
 *
 * @param {{ platform?: string, home?: string, appData?: string }} [env]
 * @returns {string} 绝对路径
 */
export function obsidianConfigPath(env = {}) {
  const platform = env.platform ?? process.platform
  const home = env.home ?? os.homedir()
  if (platform === 'win32') {
    const appData = env.appData ?? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return path.join(appData, 'obsidian', 'obsidian.json')
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')
  }
  return path.join(home, '.config', 'obsidian', 'obsidian.json')
}

/**
 * 读 Obsidian 的 vault 登记表。
 *
 * obsidian.json 的形状是 `{ "vaults": { "<id>": { path, ts, open } } }`，
 * 键是随机 id。读不到（没装 Obsidian、首次启动还没生成）就返回空，不报错——
 * 「没装」是正常情况，不是故障。
 *
 * @param {string} file
 * @returns {Promise<{ vaults: Array<{ path: string, name: string, open: boolean, ts: number }> }>}
 */
export async function readObsidianConfig(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { vaults: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { vaults: [] }
  }
  const table = parsed?.vaults
  if (!table || typeof table !== 'object') return { vaults: [] }
  const vaults = []
  for (const value of Object.values(table)) {
    const vaultPath = typeof value?.path === 'string' ? value.path.trim() : ''
    if (vaultPath === '') continue
    vaults.push({
      path: vaultPath,
      name: path.basename(vaultPath) || vaultPath,
      open: value?.open === true,
      ts: Number(value?.ts) || 0,
    })
  }
  // 正在打开的那个排最前：用户心里「我的库」通常就是他此刻开着那个。
  vaults.sort((left, right) => Number(right.open) - Number(left.open) || right.ts - left.ts)
  return { vaults }
}

/**
 * 探测本机的 Obsidian 库。
 *
 * @param {{ platform?: string, home?: string, appData?: string, configFile?: string }} [options]
 * @returns {Promise<{ found: boolean, vaults: Array<{path:string,name:string,open:boolean}>, configFile: string }>}
 */
export async function detectVaults(options = {}) {
  const configFile = options.configFile ?? obsidianConfigPath(options)
  const { vaults } = await readObsidianConfig(configFile)
  return { found: vaults.length > 0, vaults, configFile }
}

/**
 * 校验用户给（或配置文件里读来）的库路径。
 *
 * 三道关：必须是绝对路径、必须是目录、不能是文件系统根目录。
 * 前两条防手滑，第三条防「选成 / 之后整个磁盘都成了我的写入范围」。
 *
 * @param {unknown} raw
 * @returns {string} 规范化后的绝对路径
 */
export function validateVaultPath(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw fail('E_BAD_VAULT', '还没有告诉我你的 Obsidian 库在哪。')
  if (!path.isAbsolute(text)) {
    throw fail('E_BAD_VAULT', '这个路径看不出在哪台机器上，请给完整路径。', { detail: `relative: ${text}` })
  }
  const resolved = path.resolve(text)
  if (path.parse(resolved).root === resolved) {
    throw fail('E_BAD_VAULT', '不能直接选整个磁盘，请选 Obsidian 库那个文件夹。')
  }
  return resolved
}

/**
 * 校验子目录名：只允许单层目录名。
 *
 * 为什么限制这么死：子目录要拼进真实路径，`../` 一路出去就能写到库外面。
 * 只允许「不含分隔符、不是 . / ..」之后，拼接结果必然在库内。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function assertSafeSubdir(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return DEFAULT_SUBDIR
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\')) {
    throw fail('E_BAD_SUBDIR', '这个文件夹名不能用，请换一个（不要带斜杠）。', { detail: `subdir: ${text}` })
  }
  if (text.startsWith('.')) {
    throw fail('E_BAD_SUBDIR', '这个文件夹名不能用，请换一个（不要以点开头）。', { detail: `subdir: ${text}` })
  }
  return text
}

/**
 * 写临时文件再改名（原子写）。
 *
 * 自己实现一份而不复用 store.js 里的私有版本：那个函数不导出，改成导出会
 * 把「书库内部实现」摊到公共面上；这段只有十几行，重复一次比分一个共用的
 * 抽象更便宜。
 *
 * @param {string} file
 * @param {string} data
 */
async function writeFileAtomic(file, data) {
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(temp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temp, file)
  } catch (error) {
    // Windows 上目标被索引器/杀毒软件短暂占用会抛 EPERM/EBUSY/EACCES：
    // 先删目标再改名，能过去；仍失败才真的失败。
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error
    await fs.rm(file, { force: true })
    await fs.rename(temp, file)
  }
}

/**
 * Obsidian 库。
 *
 * 构造时给 root（库根）与 subdir（子目录），之后所有路径都是相对子目录的，
 * 出口统一走 resolve() —— 那是唯一一道「不许写出去」的闸。
 */
export class Vault {
  /**
   * @param {{ root: string, subdir?: string, logger?: { warn: Function }, backup?: boolean, keep?: number, now?: () => Date }} options
   */
  constructor(options = {}) {
    this.root = validateVaultPath(options.root)
    this.subdir = assertSafeSubdir(options.subdir)
    this.logger = options.logger ?? { warn() {} }
    this.backup = options.backup !== false
    this.keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : HISTORY_KEEP
    this.now = options.now ?? (() => new Date())
    this.base = path.join(this.root, this.subdir)
  }

  /**
   * 相对路径 → 绝对路径，并保证还在 base 里。
   *
   * 用「相等或以 base+sep 开头」判断，不用裸 startsWith：
   * `/tmp/v-evil` 会被 `/tmp/v` 的前缀匹配放过。
   *
   * @param {string} relPath 相对 base 的路径，用 `/` 或本平台分隔符都行
   * @returns {string}
   */
  resolve(relPath) {
    const text = typeof relPath === 'string' ? relPath : ''
    if (text === '') throw fail('E_BAD_PATH', '这个文件没有名字，写不了。')
    const target = path.resolve(this.base, text)
    if (target !== this.base && !target.startsWith(this.base + path.sep)) {
      throw fail('E_BAD_PATH', '这个文件不在笔记目录里，我不会写到外面去。', { detail: `outside vault: ${target}` })
    }
    return target
  }

  /** 建好子目录骨架（幂等）。 */
  async ensureBase() {
    await fs.mkdir(this.base, { recursive: true })
  }

  /**
   * 读一个 Markdown。不存在返回 null（不是错误：第一次同步本来就没有文件）。
   * @param {string} relPath
   * @returns {Promise<string|null>}
   */
  async read(relPath) {
    const file = this.resolve(relPath)
    try {
      return await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * 看一个文件的基本信息（大小、最后修改时间）。不存在返回 null。
   *
   * 「这本书我写过什么」要显示「上次改：X」，但那是锦上添花：
   * 拿不到就返回 null，调用方照旧列出标题。
   *
   * @param {string} relPath
   * @returns {Promise<{ size: number, updatedAt: string }|null>}
   */
  async stat(relPath) {
    const file = this.resolve(relPath)
    try {
      const info = await fs.stat(file)
      return { size: info.size, updatedAt: info.mtime.toISOString() }
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * 写一个 Markdown：原子写 + 覆盖前备份 + 内容没变就不动。
   *
   * 返回 action：
   *   - `created`：原来没有这个文件；
   *   - `updated`：有，且内容真的变了（已备份旧版）；
   *   - `unchanged`：内容逐字相同，**一个字节都没动**（重复同步不产生 diff）。
   *
   * @param {string} relPath
   * @param {string} markdown
   * @returns {Promise<{ relPath: string, action: 'created'|'updated'|'unchanged', backup: string|null }>}
   */
  async write(relPath, markdown) {
    const file = this.resolve(relPath)
    const body = normalizeMarkdown(markdown)
    let before = null
    try {
      before = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (before !== null && normalizeMarkdown(before) === body) {
      return { relPath, action: 'unchanged', backup: null }
    }
    let backupFile = null
    if (before !== null && this.backup) {
      backupFile = await this.#backup(relPath, before)
    }
    await writeFileAtomic(file, body)
    return { relPath, action: before === null ? 'created' : 'updated', backup: backupFile }
  }

  /**
   * 把一个块的当前内容换掉（不存在就追加）。
   *
   * 逻辑全在 blocks.js 里；这里只负责「读 → 换 → 写」。块外一个字不碰，
   * 因为 replaceBlock 只替换 start..end 之间的字节。
   *
   * 传了 expectedHash 时多做一件事：块在文件里的当前指纹与它不一致，说明用户
   * 在 Obsidian 里手改过这一块。这时**不覆盖**，返回 `user-edited`，由界面说一句
   * 「有 N 段你改过，我没有覆盖」。指纹来自台账（notesync 负责存）。
   *
   * @param {string} relPath
   * @param {{ id: string, kind?: string, attrs?: object, inner?: string }} block
   * @param {{ expectedHash?: string }} [options]
   * @returns {Promise<{ relPath: string, action: string, backup: string|null }>}
   */
  async upsertBlock(relPath, block, options = {}) {
    const before = (await this.read(relPath)) ?? ''
    const expectedHash = typeof options.expectedHash === 'string' ? options.expectedHash : ''
    if (expectedHash !== '') {
      const existing = findBlock(before, block?.id)
      if (existing?.closed && !existing.nested && existing.hash !== expectedHash) {
        return { relPath, action: 'user-edited', backup: null }
      }
    }
    const replaced = replaceBlock(before, block)
    // 三种「不必写」：没变、块被手改坏了（宁可少写一次也不吃掉用户的字）。
    if (replaced.action === 'unchanged' || replaced.action === 'malformed') {
      return { relPath, action: replaced.action, backup: null }
    }
    const result = await this.write(relPath, replaced.markdown)
    return { relPath, action: replaced.action, backup: result.backup }
  }

  /**
   * 删掉文件里的一个块（文件不存在就当成功）。
   * @param {string} relPath
   * @param {string} id
   * @returns {Promise<{ relPath: string, removed: boolean, backup: string|null }>}
   */
  async removeBlock(relPath, id) {
    const before = await this.read(relPath)
    if (before === null) return { relPath, removed: false, backup: null }
    const out = removeBlockFromText(before, id)
    if (!out.removed) return { relPath, removed: false, backup: null }
    const result = await this.write(relPath, out.markdown)
    return { relPath, removed: true, backup: result.backup }
  }

  /**
   * 列出子目录下某个目录里的 Markdown（取名字即可，不读正文）。
   *
   * P6 的「这本书我写过什么」只用它：只读文件名与一级标题，不读正文喂 AI。
   *
   * @param {string} [dirRel]
   * @returns {Promise<string[]>} 相对 base 的路径，正斜杠分隔
   */
  async listMarkdown(dirRel = '') {
    const dir = this.resolve(dirRel || '.')
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const out = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push(...(await this.listMarkdown(rel)))
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(rel)
      }
    }
    return out.sort((left, right) => left.localeCompare(right, 'zh'))
  }

  /**
   * 备份旧内容到 .history/<相对路径>/<时间戳>.md，并把超过 keep 份的最旧的删掉。
   *
   * 备份失败**不阻断写入**：备份是保险，主文件写不进去才是真故障。
   * @param {string} relPath
   * @param {string} content
   * @returns {Promise<string|null>} 备份文件的相对路径
   */
  async #backup(relPath, content) {
    try {
      // 时间戳后面挂一个短随机串：同一秒内备份两次（或者测试里用固定时钟）时
      // 文件名不会撞，否则后者会把前者覆盖掉，历史永远只剩一份。
      const stamp = this.now().toISOString().replace(/[:.]/g, '-')
      const salt = Math.random().toString(36).slice(2, 6)
      const relBackup = `${HISTORY_DIR}/${relPath}/${stamp}-${salt}.md`
      const file = this.resolve(relBackup)
      await writeFileAtomic(file, content)
      await this.#pruneHistory(relPath)
      return relBackup
    } catch (error) {
      this.logger?.warn?.('[dsh-reading] 备份笔记失败：', error?.message ?? error)
      return null
    }
  }

  /**
   * 只留最新的 keep 份历史。
   * @param {string} relPath
   */
  async #pruneHistory(relPath) {
    const dir = this.resolve(`${HISTORY_DIR}/${relPath}`)
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort()
    const extra = names.slice(0, Math.max(0, names.length - this.keep))
    for (const name of extra) {
      await fs.rm(path.join(dir, name), { force: true })
    }
  }
}

/**
 * 造一个 Vault。纯函数式入口，测试里换临时目录用。
 * @param {object} options
 * @returns {Vault}
 */
export function createVault(options) {
  return new Vault(options)
}

/**
 * 把库内文件换算成 Obsidian 的打开链接。
 *
 * 这是「打开」按钮唯一需要的换算：Obsidian 的 URI 用 vault 名字 + 相对路径，
 * 不认绝对路径。库名取目录名——Obsidian 就是这么认的。
 *
 * @param {{ root: string, relPath: string }} input
 * @returns {string}
 */
export function obsidianOpenUrl(input) {
  const name = path.basename(input.root)
  const rel = String(input.relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return `obsidian://open?vault=${encodeURIComponent(name)}&file=${encodeURIComponent(rel)}`
}

/** 便于测试与路由复用的常量：块渲染也走同一份实现。 */
export { renderBlock }
