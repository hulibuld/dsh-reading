/**
 * 书库路径解析与目录创建。
 *
 * 书库布局（docs/05 §3.2，与将来的 WebDAV 同构）：
 *
 *   <libraryDir>/dsh-reading/
 *   ├── settings.json
 *   └── books/<bookHash 前 16 位>/
 *       ├── book.epub
 *       ├── meta.json
 *       ├── progress.json
 *       ├── annotations.jsonl
 *       ├── qa.jsonl
 *       ├── quarantine.jsonl
 *       └── history/            ← 覆盖前的旧文件，保留 20 份
 *
 * 为什么把「目录名取 16 位、meta.bookHash 存 64 位」写在这里：目录名短便于肉眼
 * 辨认，全串用于「是不是同一本书」的判定；两处必须同时生成，放一个函数最不容易走偏。
 *
 * 什么时候会失败、失败给谁看：
 *   - bookHash 不是合法 hex → 抛 `E_BAD_BOOK_HASH`（400，message 已中文化）。
 *     这是路由层唯一的路径穿越入口，必须在**拼路径之前**拦掉，不能靠 resolve 后比对。
 *   - 目录创建失败（权限 / 磁盘满）→ 抛原始异常，routes 落成 500 内部错误。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fail } from './errors.js'

/** 书库根目录的默认位置：`~/.dsh-reading`（配置为空时）。 */
export const DEFAULT_LIBRARY_DIR = path.join(homedir(), '.dsh-reading')

/** 单本书目录名用的哈希前缀长度（docs/05 §3.2）。 */
export const BOOK_DIR_HASH_LENGTH = 16

/** 全量 bookHash 的形态：64 位小写 hex。 */
const BOOK_HASH_FULL = /^[0-9a-f]{64}$/
/** 目录名形态：16 位小写 hex（也接受传全串，内部截断）。 */
const BOOK_HASH_DIR = /^[0-9a-f]{16}$/

/**
 * 把用户给的 bookHash 规范化成「目录名」。
 *
 * 两种长度都接受：16 位（目录名本身）与 64 位（meta.bookHash 全串）。
 * 两种都归一到 16 位短名，且对 16 位输入**不再截断**——它已经就是目录名了。
 *
 * 大小写归一成小写：用户从别处复制 hash 时常常带上大写（Windows 剪贴板、
 * 某些哈希工具默认大写），而大小写不同在 mac 上会建出两个目录、在 Linux 上
 * 直接找不到书。哈希本身是 hex，大小写不携带信息，折叠是安全且必要的。
 *
 * @param {unknown} raw
 * @returns {string} 16 位小写 hex
 */
export function bookDirName(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (BOOK_HASH_DIR.test(value)) return value
  if (BOOK_HASH_FULL.test(value)) return value.slice(0, BOOK_DIR_HASH_LENGTH)
  throw fail('E_BAD_BOOK_HASH', '这本书的标识不对，可能链接失效了。', {
    detail: `bad bookHash: ${value.slice(0, 80)}`,
  })
}

/**
 * 校验并返回全量 bookHash（64 位）。用于写 meta 的场合。
 * 同样归一成小写（理由见 bookDirName）。
 * @param {unknown} raw
 * @returns {string}
 */
export function bookHashFull(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (BOOK_HASH_FULL.test(value)) return value
  throw fail('E_BAD_BOOK_HASH', '这本书的标识不对，可能链接失效了。', {
    detail: `bad full bookHash: ${value.slice(0, 80)}`,
  })
}

/**
 * 书库路径工具。所有路径都从这里出，路由和 store 不自己拼。
 */
export class LibraryPaths {
  /**
   * @param {string} libraryDir - 用户配置的书库目录；空串表示用默认目录。
   */
  constructor(libraryDir) {
    const configured = typeof libraryDir === 'string' ? libraryDir.trim() : ''
    /** 用户配置的根（不含 `dsh-reading/`）。 */
    this.receivedDir = configured === '' ? DEFAULT_LIBRARY_DIR : path.resolve(configured)
    /** 插件自己的根：`<libraryDir>/dsh-reading/`。 */
    this.root = path.join(this.receivedDir, 'dsh-reading')
    this.booksRoot = path.join(this.root, 'books')
    this.settingsFile = path.join(this.root, 'settings.json')
  }

  /** 单本书目录：`books/<16 位 hex>`。传非法 hash 会抛错（不返回可疑路径）。 */
  bookDir(bookHash) {
    return path.join(this.booksRoot, bookDirName(bookHash))
  }

  /** 书库根下的固定文件。 */
  file(name) {
    return path.join(this.root, name)
  }

  /**
   * 断言某个绝对路径仍在这本书目录内。
   *
   * 用「相等或以 base + sep 开头」判断，不用裸 startsWith：
   * `/tmp/books/abc-evil` 会被 `/tmp/books/abc` 的前缀匹配放过。
   *
   * @param {string} base - 书目录绝对路径
   * @param {string} target - 待检查的绝对路径
   * @returns {string} target
   */
  static assertInside(base, target) {
    const resolvedBase = path.resolve(base)
    const resolvedTarget = path.resolve(target)
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
      throw fail('E_BAD_PATH', '这个文件不在这本书里，打不开。', {
        detail: `outside book dir: ${resolvedTarget}`,
      })
    }
    return resolvedTarget
  }

  /** 确保书库目录骨架存在（幂等）。 */
  async ensureRoot() {
    await fs.mkdir(this.booksRoot, { recursive: true })
  }

  /**
   * 确保单本书的目录骨架存在（幂等）。
   * @param {string} bookHash
   */
  async ensureBook(bookHash) {
    const dir = this.bookDir(bookHash)
    await fs.mkdir(path.join(dir, 'history'), { recursive: true })
    return dir
  }

  /**
   * 列出全部书目录名（只返回合法 16 位 hex 的目录，其余忽略）。
   * @returns {Promise<string[]>}
   */
  async listBookDirs() {
    let names
    try {
      names = await fs.readdir(this.booksRoot, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    return names
      .filter((entry) => entry.isDirectory() && BOOK_HASH_DIR.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  }
}

/**
 * 新建一份路径工具。纯函数式入口，方便测试里换目录。
 * @param {string} [libraryDir]
 * @returns {LibraryPaths}
 */
export function createPaths(libraryDir) {
  return new LibraryPaths(libraryDir)
}
