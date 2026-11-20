#!/usr/bin/env node
/**
 * Obsidian 库层（lib/vault.js）的测试。
 *
 * 这一层每天都会去写用户自己的笔记目录，所以这里的用例全在验「不该动的东西
 * 有没有动」：字节有没有变、块外的字还在不在、手改过的块有没有被覆盖、
 * 删掉的块会不会复活、路径能不能越出库。
 *
 * 全程用临时目录当 vault，不碰真库、不联网、不起 Obsidian。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SUBDIR,
  assertSafeSubdir,
  createVault,
  detectVaults,
  obsidianConfigPath,
  obsidianOpenUrl,
  validateVaultPath,
} from '../lib/vault.js'
import { hashInner } from '../lib/blocks.js'

/** 造一个临时 vault，跑完删掉。 */
async function withVault(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-vault-'))
  try {
    const vault = createVault({
      root,
      subdir: options.subdir ?? DEFAULT_SUBDIR,
      backup: options.backup !== false,
      keep: options.keep,
      now: () => new Date('2026-11-17T14:10:00.000Z'),
      logger: { warn() {} },
    })
    return await fn(vault, root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

const SAMPLE = {
  id: 'a3f2k9m1',
  kind: 'discuss',
  attrs: { chapter: 'ch003', at: '2026-11-17T14:10:00.000Z' },
  inner: '### 阅读的四个层次\n\n> **问**：是并列吗？\n>\n> **答**：不是。',
}

/** 写两次必须字节一致，且第二次连 mtime 都不该变（unchanged 时压根没写盘）。 */
async function writesIdempotently() {
  await withVault(async (vault, root) => {
    const rel = '《测试》-08773db717b9d75d/《测试》 01 读书笔记.md'
    const first = await vault.write(rel, '# 标题\n\n正文\n')
    assert.equal(first.action, 'created')
    const before = await fs.readFile(path.join(root, DEFAULT_SUBDIR, rel), 'utf8')
    assert.equal(before, '# 标题\n\n正文\n', '落盘字节必须是归一化后的形态')
    const second = await vault.write(rel, '# 标题\n\n正文\n')
    assert.equal(second.action, 'unchanged', '内容没变必须判 unchanged')
    const after = await fs.readFile(path.join(root, DEFAULT_SUBDIR, rel), 'utf8')
    assert.equal(after, before, 'unchanged 时字节一个都不许变')
  })
}

/** 用户在块外手写的一段，同步之后必须还在。 */
async function preservesUserText() {
  await withVault(async (vault) => {
    const rel = 'book/note.md'
    await vault.write(rel, '# 我的笔记\n\n我自己写的一段，谁也不许动。\n')
    const first = await vault.upsertBlock(rel, SAMPLE)
    assert.equal(first.action, 'inserted', '第一次落块是追加')
    const again = await vault.upsertBlock(rel, SAMPLE)
    assert.equal(again.action, 'unchanged', '同一块再写一次必须是 unchanged')
    const body = await vault.read(rel)
    assert.ok(body.includes('我自己写的一段'), '用户手写的段必须还在')
    assert.equal(body.split('dsh-reading:block').length - 1, 1, '块只应有一个')
  })
}

/** 用户改过块里的字 → 不覆盖，返回 user-edited，文件一个字节不动。 */
async function refusesUserEditedBlock() {
  await withVault(async (vault) => {
    const rel = 'book/note.md'
    await vault.upsertBlock(rel, SAMPLE)
    const original = await vault.read(rel)
    await vault.write(rel, original.replace('不是。', '是包含关系。'))
    // 写盘会做归一化（结尾只留一个换行），所以比较基准取写完之后的字节。
    const edited = await vault.read(rel)
    const knownHash = hashInner(SAMPLE.inner)
    const result = await vault.upsertBlock(
      rel,
      { ...SAMPLE, inner: '### 重新生成的内容' },
      { expectedHash: knownHash },
    )
    assert.equal(result.action, 'user-edited', '手改过的块必须拒绝覆盖')
    const after = await vault.read(rel)
    assert.equal(after, edited, '拒绝时字节不许变')
    assert.ok(after.includes('是包含关系。'), '用户改的字必须还在')
  })
}

/** 用户把整块删了 → 调用方靠台账不再写；这里验删干净不留空行。 */
async function removesWithoutResidue() {
  await withVault(async (vault) => {
    const rel = 'book/note.md'
    await vault.write(rel, '# 标题\n\n正文一段。\n')
    await vault.upsertBlock(rel, { id: 'x1', inner: '不要了' })
    const out = await vault.removeBlock(rel, 'x1')
    assert.equal(out.removed, true)
    // 写盘固定「结尾一个换行」，所以这里带回 \n；重要的是块和空行都清干净了。
    assert.equal(await vault.read(rel), '# 标题\n\n正文一段。\n', '删完之后要回到用户原文')
    const missing = await vault.removeBlock(rel, 'never-existed')
    assert.equal(missing.removed, false, '删不存在的块返回 false 而不是抛错')
    const gone = await vault.removeBlock('nope.md', 'x1')
    assert.equal(gone.removed, false, '文件不存在也不算错')
  })
}

/** 覆盖前要备份，且只留 keep 份。 */
async function backsUpBeforeOverwrite() {
  await withVault(async (vault, root) => {
    const rel = 'book/note.md'
    const historyDir = path.join(root, DEFAULT_SUBDIR, '.history', rel)
    await vault.write(rel, 'v1\n')
    await vault.write(rel, 'v2\n')
    let names = await fs.readdir(historyDir)
    assert.equal(names.length, 1, '第一次覆盖留下一份旧版')
    const first = await fs.readFile(path.join(historyDir, names[0]), 'utf8')
    assert.equal(first, 'v1\n', '备份的必须是覆盖前的字节')
    for (let index = 0; index < 30; index += 1) {
      await vault.write(rel, `v${index}\n`)
    }
    names = await fs.readdir(historyDir)
    assert.equal(names.length, 20, `历史应只留 20 份，实际 ${names.length}`)
  })
}

/** 关掉备份时不该留 .history。 */
async function honorsBackupFlag() {
  await withVault(
    async (vault, root) => {
      const rel = 'book/note.md'
      await vault.write(rel, 'v1\n')
      const out = await vault.write(rel, 'v2\n')
      assert.equal(out.backup, null, '关掉备份时不返回备份路径')
      await assert.rejects(fs.readdir(path.join(root, DEFAULT_SUBDIR, '.history', rel)))
    },
    { backup: false },
  )
}

/** 路径不许越出子目录。 */
async function blocksPathEscape() {
  await withVault(async (vault) => {
    assert.throws(() => vault.resolve('../evil.md'), /不会写到外面去/)
    assert.throws(() => vault.resolve('a/../../evil.md'), /不会写到外面去/)
    assert.throws(() => vault.resolve('/etc/passwd'), /不会写到外面去/)
    assert.throws(() => vault.resolve(''), /没有名字/)
    assert.ok(vault.resolve('book/note.md').endsWith(path.join('book', 'note.md')))
  })
}

/** 子目录名与库路径的校验：这两处是「写到哪里去」的源头。 */
function validatesPaths() {
  assert.equal(assertSafeSubdir(''), DEFAULT_SUBDIR)
  assert.equal(assertSafeSubdir('  我的笔记  '), '我的笔记')
  assert.throws(() => assertSafeSubdir('../out'), /不能用/)
  assert.throws(() => assertSafeSubdir('a/b'), /不能用/)
  assert.throws(() => assertSafeSubdir('.history'), /不能用/)
  assert.throws(() => validateVaultPath(''), /Obsidian 库在哪/)
  assert.throws(() => validateVaultPath('relative/path'), /完整路径/)
  assert.throws(() => validateVaultPath('/'), /整个磁盘/)
  assert.equal(validateVaultPath('/tmp/v'), '/tmp/v')
}

/** 探测：读得到 obsidian.json 就报出来，读不到返回空且不抛错。 */
async function detectsVaults() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-obsidian-'))
  try {
    const configFile = path.join(root, 'obsidian.json')
    const none = await detectVaults({ configFile })
    assert.equal(none.found, false, '配置文件不存在时 found 为 false')
    assert.deepEqual(none.vaults, [])
    await fs.writeFile(
      configFile,
      JSON.stringify({
        vaults: {
          aaa: { path: '/tmp/v-second', ts: 100, open: false },
          bbb: { path: '/tmp/v-first', ts: 200, open: true },
        },
      }),
    )
    const found = await detectVaults({ configFile })
    assert.equal(found.found, true)
    assert.equal(found.vaults.length, 2)
    assert.equal(found.vaults[0].name, 'v-first', '正在打开的那个排最前')
    assert.equal(found.vaults[0].open, true)
    // 坏 JSON 不能把整个功能炸掉。
    await fs.writeFile(configFile, 'not json at all')
    assert.equal((await detectVaults({ configFile })).found, false, '坏 JSON 按没有处理')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** 各平台配置路径。 */
function resolvesConfigPaths() {
  const home = '/Users/someone'
  assert.equal(
    obsidianConfigPath({ platform: 'darwin', home }),
    '/Users/someone/Library/Application Support/obsidian/obsidian.json',
  )
  assert.equal(
    obsidianConfigPath({ platform: 'linux', home }),
    '/Users/someone/.config/obsidian/obsidian.json',
  )
  assert.ok(
    obsidianConfigPath({ platform: 'win32', home, appData: 'C:\\Users\\someone\\AppData\\Roaming' }).includes(
      path.join('Roaming', 'obsidian', 'obsidian.json'),
    ),
  )
}

/** 打开链接：Obsidian URI 用库名 + 相对路径，不认绝对路径。 */
function buildsOpenUrl() {
  const url = obsidianOpenUrl({ root: '/Users/x/Documents/knowledge base', relPath: 'dsh-reading/《书》/笔记.md' })
  assert.ok(url.startsWith('obsidian://open?vault='))
  assert.ok(url.includes(encodeURIComponent('knowledge base')), '库名要编码')
  assert.ok(url.includes(encodeURIComponent('dsh-reading/《书》/笔记.md')), '路径要编码')
}

/** listMarkdown 只读名字不读正文，且跳过 .history 与隐藏目录。 */
async function listsMarkdownOnly() {
  await withVault(async (vault) => {
    await vault.write('book/《书》 01 读书笔记.md', 'x')
    await vault.write('book/《书》 00 全书地图.md', 'x')
    await vault.write('book/notes.txt', 'not markdown')
    await vault.write('.hidden/secret.md', 'x')
    await vault.write('book/03 思想脉络/主题一.md', 'x')
    await vault.write('book/《书》 01 读书笔记.md', 'y')
    const list = await vault.listMarkdown()
    assert.ok(list.includes('book/《书》 01 读书笔记.md'))
    assert.ok(list.includes('book/《书》 00 全书地图.md'))
    assert.ok(list.includes('book/03 思想脉络/主题一.md'), '子目录要递归')
    assert.ok(!list.some((item) => item.endsWith('.txt')), '只列 .md')
    assert.ok(!list.some((item) => item.includes('.history')), '不列备份目录')
    assert.ok(!list.some((item) => item.startsWith('.hidden')), '不列隐藏目录')
  })
}

/** 块被手工删掉 end → 拒绝改写（宁可少写一次，也不吃掉用户的字）。 */
async function refusesMalformedBlock() {
  await withVault(async (vault) => {
    const rel = 'book/note.md'
    await vault.upsertBlock(rel, SAMPLE)
    const full = await vault.read(rel)
    await vault.write(rel, full.replace(/<!-- dsh-reading:end[^>]*-->/, ''))
    // 比较基准取写完之后的字节（写盘会归一化结尾换行）。
    const broken = await vault.read(rel)
    const out = await vault.upsertBlock(rel, { ...SAMPLE, inner: '新内容' })
    assert.equal(out.action, 'malformed', '缺 end 必须拒绝')
    assert.equal(await vault.read(rel), broken, '拒绝时字节不许变')
  })
}

export default async function run() {
  await writesIdempotently()
  await preservesUserText()
  await refusesUserEditedBlock()
  await removesWithoutResidue()
  await backsUpBeforeOverwrite()
  await honorsBackupFlag()
  await blocksPathEscape()
  validatesPaths()
  await detectsVaults()
  resolvesConfigPaths()
  buildsOpenUrl()
  await listsMarkdownOnly()
  await refusesMalformedBlock()
  console.log('vault: 13 组用例通过（幂等写盘、块外保留、手改拒覆盖、备份保留 20 份、越界拦截、探测与打开链接）')
}
