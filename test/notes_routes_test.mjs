#!/usr/bin/env node
/**
 * vault.* / notes.* 五个路由的测试。不启端口、不碰真库。
 *
 * 这些路由的重点不是「能返回 JSON」，而是三件事：
 *   1. 没配库时老实说「还没选库」，不白屏也不崩；
 *   2. 选库要真的能写 —— 路径打错必须在选的时候就说，而不是等到第一次同步；
 *   3. 同步是幂等的：点第二次，vault 里的字节一个不变。
 *
 * 库全是 fs.mkdtemp 出来的临时目录，跑完删掉。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { LibraryStore } from '../lib/store.js'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { bookDirName } from '../lib/paths.js'
import { DEFAULT_SUBDIR } from '../lib/vault.js'

/** 最小 res：与 routes_test 同一形状。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
    },
    json() {
      return JSON.parse(this.body.toString('utf8'))
    },
    text() {
      return this.body.toString('utf8')
    },
  }
}

/** 两章的 EPUB。 */
function makeEpub() {
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data:
        '<container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" ' +
        'media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    {
      name: 'OEBPS/content.opf',
      data:
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:title>笔记测试</dc:title><dc:creator>测试作者</dc:creator></metadata>' +
        '<manifest>' +
        '<item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '</manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>',
    },
    {
      name: 'OEBPS/nav.xhtml',
      data:
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
        '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">第一章</a></li>' +
        '<li><a href="text/ch2.xhtml">第二章</a></li></ol></nav></body></html>',
    },
    {
      name: 'OEBPS/text/ch1.xhtml',
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一章的正文。</p></body></html>',
    },
    {
      name: 'OEBPS/text/ch2.xhtml',
      data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章的正文。</p></body></html>',
    },
  ]
  return writeZip(entries)
}

function post(method, body) {
  return { method: 'POST', url: API_PREFIX + '/' + method, body }
}

async function call(handler, method, body) {
  const res = makeRes()
  await handler(post(method, body), res)
  return res
}

async function ok(handler, method, body) {
  const res = await call(handler, method, body)
  assert.equal(res.statusCode, 200, method + ' 应成功，实际 ' + res.statusCode + '：' + res.text())
  const payload = res.json()
  assert.equal(payload.ok, true, method + ' 应 ok:true')
  return payload.value
}

/** 断言失败信封：状态码 + 错误码 + 中文文案（不泄露内部字段）。 */
async function fails(handler, method, body, status, code) {
  const res = await call(handler, method, body)
  const text = res.text()
  assert.equal(res.statusCode, status, method + ' 状态码应为 ' + status + '，实际 ' + res.statusCode + '：' + text)
  const payload = JSON.parse(text)
  assert.equal(payload.ok, false)
  if (code) assert.equal(payload.error.code, code, '错误码应为 ' + code + '，实际 ' + payload.error.code)
  assert.match(payload.error.message, /[\u4e00-\u9fa5]/, '错误文案必须是中文')
  for (const leaked of ['bookHash', 'E_', 'undefined', '/tmp/', 'obsidianVault']) {
    assert.equal(
      payload.error.message.includes(leaked),
      false,
      '文案不该出现内部词 ' + leaked + '：' + payload.error.message,
    )
  }
  return payload
}

export default async function run() {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-notes-routes-'))
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-vault-'))
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 10, 17, 6, counter++)).toISOString()
  const store = new LibraryStore({ libraryDir, deviceId: 'mac-notes', now, logger: { warn: () => {} } })
  const handler = createHandler({ store, logger: { warn: () => {} } })

  try {
    // ── 1. 没配库时：detect 不炸、status 说清楚「还没选库」 ──
    {
      const detected = await ok(handler, 'vault.detect', {})
      assert.equal(typeof detected.found, 'boolean', 'found 必须是布尔：没装 Obsidian 也不该报错')
      assert.ok(Array.isArray(detected.vaults), 'vaults 必须是数组')
      assert.equal(detected.chosen, '', '还没选过库，chosen 是空串')
      assert.equal(detected.subdir, DEFAULT_SUBDIR, '子目录给默认值')
    }

    // ── 2. 导入一本书 ──
    const imported = await ok(handler, 'shelf.import', {
      filename: '笔记路由.epub',
      dataBase64: makeEpub().toString('base64'),
    })
    const bookHash = imported.bookHash
    const dirName = bookDirName(bookHash)
    assert.equal(imported.meta.title, '笔记测试')

    {
      const status = await ok(handler, 'notes.status', { bookHash })
      assert.equal(status.configured, false, '没配库时 configured 为 false')
      assert.equal(status.vault, '')
      assert.equal(status.vaultError, '', '还没配库不算「库打不开」，两者要分开')
      assert.equal(status.items.length, 2, '两份产物：地图与笔记')
      assert.deepEqual(
        status.items.map((item) => item.kind),
        ['map', 'note'],
      )
      for (const item of status.items) {
        assert.equal(item.exists, false, '还没同步，文件不存在')
      }
      assert.equal(status.items[0].relPath, '《笔记测试》-' + dirName + '/《笔记测试》 00 全书地图.md')
      assert.equal(status.items[1].relPath, '《笔记测试》-' + dirName + '/《笔记测试》 01 读书笔记.md')
    }

    // ── 3. 选库：路径不对必须当场说，不能等到第一次同步 ──
    await fails(handler, 'vault.choose', { path: '/no/such/obsidian/vault' }, 400, null)
    await fails(handler, 'vault.choose', { path: '' }, 400, null)
    await fails(handler, 'vault.choose', { path: 'relative/path' }, 400, null)
    const aFile = path.join(vaultRoot, 'a-file.txt')
    await fs.writeFile(aFile, 'x')
    await fails(handler, 'vault.choose', { path: aFile }, 400, null)

    {
      const chosen = await ok(handler, 'vault.choose', { path: vaultRoot })
      assert.equal(chosen.ok, true)
      assert.equal(chosen.subdir, DEFAULT_SUBDIR)
      // 选完立刻把子目录建出来：用户下一步就该在 Obsidian 里看到这个文件夹。
      const info = await fs.stat(path.join(vaultRoot, DEFAULT_SUBDIR))
      assert.equal(info.isDirectory(), true)
      const settings = await ok(handler, 'settings.get', {})
      assert.equal(settings.obsidianVault, vaultRoot)
      assert.equal(settings.obsidianAutoWrite, true, '自动写默认开')
      const detected = await ok(handler, 'vault.detect', {})
      assert.equal(detected.chosen, vaultRoot)
    }

    // ── 4. 预览：只读，不动磁盘 ──
    {
      const preview = await ok(handler, 'notes.preview', { bookHash, kind: 'note' })
      assert.equal(preview.kind, 'note')
      assert.ok(
        preview.markdown.startsWith('# 《笔记测试》 读书笔记'),
        '标题在前：' + preview.markdown.slice(0, 40),
      )
      assert.ok(preview.markdown.includes('dsh-reading:block'), '预览里要能看到块标记')
      const onDisk = await fs.readdir(path.join(vaultRoot, DEFAULT_SUBDIR)).catch(() => [])
      assert.deepEqual(onDisk, [], '预览不许落盘')
      await fails(handler, 'notes.preview', { bookHash, kind: 'chapter' }, 400, 'E_BAD_KIND')
    }

    // ── 5. 先塞一条问答，再同步：讨论块要写进笔记 ──
    await store.appendQa(bookHash, {
      question: '第一章讲的到底是什么？',
      answer: '讲的是怎么开始读一本书。',
      anchorCfiRange: 'epubcfi(/6/2[ch1]!/4/2/1:0,/4/2/1:5)',
      selectedText: '第一章的正文',
      chapterHref: 'text/ch1.xhtml',
      chapterLabel: '第一章',
      mode: 'classic',
    })

    let firstSync = null
    {
      firstSync = await ok(handler, 'notes.sync', { bookHash })
      assert.equal(firstSync.files.length, 2)
      assert.ok(firstSync.written >= 2, '至少地图块 + 笔记块，实际 ' + firstSync.written)
      assert.equal(firstSync.conflicts, 0)
      for (const file of firstSync.files) {
        assert.ok(file.openUrl.startsWith('obsidian://open?'), 'openUrl 形状不对：' + file.openUrl)
      }

      const folder = path.join(vaultRoot, DEFAULT_SUBDIR, '《笔记测试》-' + dirName)
      const mapBytes = await fs.readFile(path.join(folder, '《笔记测试》 00 全书地图.md'), 'utf8')
      const noteBytes = await fs.readFile(path.join(folder, '《笔记测试》 01 读书笔记.md'), 'utf8')
      assert.ok(mapBytes.startsWith('# 《笔记测试》 全书地图'))
      assert.ok(noteBytes.includes('第一章讲的到底是什么？'), '问答要写进笔记')
      assert.ok(noteBytes.includes('讲的是怎么开始读一本书。'), '答案摘要要写进笔记')
      assert.ok(noteBytes.includes('## 第一章'), '章节小节要带章名')
      // 只写问 + 答摘要 + 关联原句：模型名、模式名不许进笔记
      assert.equal(noteBytes.includes('classic'), false, '笔记里不许出现模式名')
    }

    // ── 6. 再同步一次：一个字节都不许变 ──
    {
      const folder = path.join(vaultRoot, DEFAULT_SUBDIR, '《笔记测试》-' + dirName)
      const beforeMap = await fs.readFile(path.join(folder, '《笔记测试》 00 全书地图.md'), 'utf8')
      const beforeNote = await fs.readFile(path.join(folder, '《笔记测试》 01 读书笔记.md'), 'utf8')
      const second = await ok(handler, 'notes.sync', { bookHash })
      assert.equal(second.written, 0, '第二次不该再写任何块，实际写了 ' + second.written)
      assert.equal(await fs.readFile(path.join(folder, '《笔记测试》 00 全书地图.md'), 'utf8'), beforeMap)
      assert.equal(await fs.readFile(path.join(folder, '《笔记测试》 01 读书笔记.md'), 'utf8'), beforeNote)
      assert.ok(second.updatedAt >= firstSync.updatedAt, '台账时间要往后走')
    }

    // ── 7. 同步后可查状态 ──
    {
      const status = await ok(handler, 'notes.status', { bookHash })
      assert.equal(status.configured, true)
      assert.equal(status.vaultError, '')
      for (const item of status.items) {
        assert.equal(item.exists, true, item.kind + ' 应该在磁盘上')
        assert.ok(item.blocks > 0, item.kind + ' 应该有块')
        assert.equal(item.written, item.blocks, '全部块都在文件里')
        assert.ok(item.syncedAt !== '', '要记下上次同步时间')
      }
      assert.equal(status.skippedQa, 0)
    }

    // ── 8. kinds 只同步指定的一份 ──
    {
      const onlyMap = await ok(handler, 'notes.sync', { bookHash, kinds: ['map'] })
      assert.equal(onlyMap.files.length, 1)
      assert.equal(onlyMap.files[0].kind, 'map')
      await fails(handler, 'notes.sync', { bookHash, kinds: ['ghost'] }, 400, 'E_BAD_KIND')
    }


    // ── 9. 我写过什么：只读标题，正文一个字都不出来 ──
    {
      const folder = path.join(vaultRoot, DEFAULT_SUBDIR, '《笔记测试》-' + dirName)
      await fs.writeFile(
        path.join(folder, '我的碎笔记.md'),
        [
          '# 我的读法',
          '',
          '这一段是正文，不该出现在任何返回值里。',
          '',
          '## 关于第一章',
          '',
          '#### 四级标题太碎，不列',
          '',
        ].join('\n'),
      )

      const mine = await ok(handler, 'notes.mine', { bookHash })
      assert.equal(mine.configured, true)
      assert.equal(mine.vaultError, '')
      assert.equal(mine.folder, '《笔记测试》-' + dirName)
      assert.ok(mine.files.length >= 2, '自己那页与程序写的那页都要列出来')

      const own = mine.files.find((file) => file.name === '我的碎笔记.md')
      assert.ok(own, '要能列出用户自己在库里加的页')
      assert.deepEqual(own.headings.map((item) => item.text), ['我的读法', '关于第一章'], '只收一二级标题')
      assert.equal(own.ownCount, 2, '用户自己写的两行都算他的')
      assert.ok(own.headings.every((item) => item.own === true))
      assert.ok(own.openUrl.startsWith('obsidian://open?'), '每页都要能直接跳去 Obsidian')
      assert.ok(typeof own.updatedAt === 'string' && own.updatedAt !== '', '要带上次改动时间')

      // 程序写的那份：块里的小节不许冒充「你写过的」
      const generated = mine.files.find((file) => file.name.endsWith('01 读书笔记.md'))
      assert.ok(generated, '程序写的笔记也要列出来')
      assert.ok(
        generated.headings.some((item) => item.own === false),
        '块里的小节要标成 own:false',
      )

      // 铁律：返回值里不许出现正文，也不许出现块标记
      const flat = JSON.stringify(mine)
      for (const leaked of ['这一段是正文', 'dsh-reading:block']) {
        assert.equal(flat.includes(leaked), false, '返回值里不该有正文或块标记：' + leaked)
      }

      // 借书的号码不对 / 书不在，都要能看懂
      await fails(handler, 'notes.mine', { bookHash: '' }, 400, 'E_BAD_BOOK_HASH')
      await fails(handler, 'notes.mine', { bookHash: 'ffffffffffffffff' }, 404, 'E_BOOK_NOT_FOUND')
    }

    // ── 10. 书不存在 / 库被拔掉时，文案要能看懂 ──

    await fails(handler, 'notes.status', { bookHash: '' }, 400, 'E_BAD_BOOK_HASH')
    await fails(handler, 'notes.sync', { bookHash: 'ffffffffffffffff' }, 404, 'E_BOOK_NOT_FOUND')
    {
      await store.putSettings({ obsidianVault: path.join(os.tmpdir(), 'dsh-gone-' + Date.now()) })
      const status = await ok(handler, 'notes.status', { bookHash })
      assert.equal(status.configured, true)
      assert.ok(status.vaultError !== '', '库不在时要如实说一句')
      assert.match(status.vaultError, /[\u4e00-\u9fa5]/)

      // 库打不开时，「我写过什么」也只是空着，不报错、不白屏
      const mine = await ok(handler, 'notes.mine', { bookHash })
      assert.equal(mine.configured, true)
      assert.ok(mine.vaultError !== '', '库不在时要如实说一句')
      assert.equal(mine.files.length, 0, '列不出页，但也别抛错')
    }

    console.log(
      'notes_routes: 10 组用例通过（未配库降级、选库四路校验、预览不落盘、首次同步、重复同步字节不变、同步后状态、kinds 子集、我写过什么只读标题、错误文案、库挪走降级）',
    )
  } finally {
    await fs.rm(libraryDir, { recursive: true, force: true })
    await fs.rm(vaultRoot, { recursive: true, force: true })
  }
}
