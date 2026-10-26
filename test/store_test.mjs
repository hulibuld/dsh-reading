/**
 * lib/store.js 的测试。
 *
 * 这里断言的是「数据不会丢」这件事，而不是 API 造得好不好看：
 *   - 写入 → 读取 → 墓碑（deleted:true 的行**仍在文件里**，只是读的时候过滤）；
 *   - history/ 轮转保留 20 份，第 21 次覆盖把最旧的那份挤掉；
 *   - jsonl 是追加语义：同一 id 多次写入不去改历史行，读时按 (updatedAt, deviceId) 取最新；
 *   - 书库布局严格是 docs/05 §3.2 那一份（多一个文件都算错）。
 *
 * 每个用例用独立的 mkdtemp 目录，跑完删掉；不碰真实书库。
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip } from '../lib/zip.js'
import { LibraryStore, HISTORY_KEEP, DEFAULT_SETTINGS, compareVersion, mergeSettings, validateRecord, MAX_TITLE_LENGTH, MAX_AUTHOR_LENGTH, MAX_COVER_BYTES, sniffCoverImage } from '../lib/store.js'
import { LibraryPaths, bookDirName, bookHashFull } from '../lib/paths.js'
import { makeDeviceId, ensureDeviceId, DEVICE_ID_PATTERN } from '../lib/device.js'

/** 造一本最小可解析的 EPUB（store 的导入用例要用真书）。 */
function makeEpub(title = '测试书', chapterCount = 2, options = {}) {
  const chapters = Array.from({ length: chapterCount }, (_, i) => ({
    id: `ch${i + 1}`,
    href: `text/ch${i + 1}.xhtml`,
    label: `第 ${i + 1} 章`,
  }))
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
        `<dc:title>${title}</dc:title><dc:creator>某作者</dc:creator><dc:language>zh</dc:language></metadata>` +
        '<manifest>' +
        chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('') +
        // ncx 选项造的是 EPUB2（目录来自 toc.ncx）；plain 选项两者都没有（只剩 spine）。
        (options.plain
          ? ''
          : options.ncx
            ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
            : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>') +
        // 0.4.0：带封面的书用同一个造书器（cover 选项），免得测试里手写两份 OPF。
        (options.cover
          ? '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>'
          : '') +
        `</manifest><spine${options.ncx ? ' toc="ncx"' : ''}>` +
        chapters.map((c) => `<itemref idref="${c.id}"/>`).join('') +
        '</spine></package>',
    },
    ...(options.ncx
      ? [
          {
            name: 'OEBPS/toc.ncx',
            data:
              '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>' +
              chapters
                .map(
                  (c, i) =>
                    `<navPoint id="p${i}" playOrder="${i + 1}"><navLabel><text>${c.label}</text></navLabel>` +
                    `<content src="${c.href}"/></navPoint>`,
                )
                .join('') +
              '</navMap></ncx>',
          },
        ]
      : []),
    ...(options.ncx || options.plain
      ? []
      : [
          {
            name: 'OEBPS/nav.xhtml',
            data:
              '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
              '<nav epub:type="toc"><ol>' +
              chapters.map((c) => `<li><a href="${c.href}">${c.label}</a></li>`).join('') +
              '</ol></nav></body></html>',
          },
        ]),
    ...(options.cover
      ? [
          {
            name: 'OEBPS/images/cover.png',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]),
          },
        ]
      : []),
    ...chapters.map((c) => ({
      name: `OEBPS/${c.href}`,
      data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${c.label}正文</p></body></html>`,
    })),
  ]
  return writeZip(entries)
}

/** 造一条合法的 highlight 记录（ULID + 完整指纹）。 */
function makeHighlight(overrides = {}) {
  return {
    schema: 'dsh-reading/1',
    id: '01J8ZQ6Q7K8M9N0P1Q2R3S4T5V',
    type: 'highlight',
    cfi: 'epubcfi(/6/2[ch1]!/4/2/2/1:0,/4/2/2/1:5)',
    cfiStart: '/4/2/2/1:0',
    cfiEnd: '/4/2/2/1:5',
    chapterHref: 'text/ch1.xhtml',
    textExcerpt: '汪淼',
    textFingerprint: { head: '汪淼', tail: '汪淼', len: 2, hash: 'a'.repeat(64) },
    color: 'yellow',
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    deviceId: 'mac-abc123',
    ...overrides,
  }
}

/** 建一个隔离的临时书库，返回 { store, dir, cleanup }。 */
async function tempStore(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-store-'))
  let tick = 0
  const store = new LibraryStore({
    libraryDir: dir,
    deviceId: options.deviceId ?? 'mac-abc123',
    // 固定时钟推进：history 的文件名靠它排序，测试里必须可控。
    now: options.now ?? (() => new Date(Date.UTC(2026, 9, 22, 0, 0, tick++)).toISOString()),
    logger: { warn: () => {} },
  })
  await store.init()
  return {
    store,
    dir,
    root: path.join(dir, 'dsh-reading'),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

/** 期望某个异步调用抛指定 code。 */
async function expectCode(code, fn) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `期望抛 ${code}，但什么都没抛`)
  assert.equal(caught.code, code, `期望 ${code}，实际 ${caught.code}（${caught.message}）`)
  return caught
}

export default async function run() {
  // ── 1. 书库布局严格按 docs/05 §3.2 ──
  {
    const { store, root, cleanup } = await tempStore()
    try {
      const bytes = makeEpub('布局测试')
      const imported = await store.importBook({ filename: '布局.epub', dataBase64: bytes.toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      assert.equal(dirName.length, 16, '目录名必须是 16 位')
      assert.equal(imported.bookHash.length, 64, 'meta.bookHash 必须是 64 位全串')

      const bookDir = path.join(root, 'books', dirName)
      const listing = (await fs.readdir(bookDir)).sort()
      assert.ok(listing.includes('book.epub'), '必须存原文件 book.epub')
      assert.ok(listing.includes('meta.json'))
      assert.ok(listing.includes('history'), 'books/<hash>/history/ 必须在')

      // meta 必填字段与 §4.1 一致
      const meta = JSON.parse(await fs.readFile(path.join(bookDir, 'meta.json'), 'utf8'))
      for (const key of ['schema', 'bookHash', 'title', 'format', 'converterVersion', 'spine', 'createdAt']) {
        assert.ok(meta[key] !== undefined, `meta 缺必填字段 ${key}`)
      }
      assert.equal(meta.schema, 'dsh-reading/1')
      assert.equal(meta.title, '布局测试')
      assert.equal(meta.bookHash, imported.bookHash)
      assert.equal(meta.format, 'epub')
      // spine 每项必须带 index（schema required: index + href）
      for (const entry of meta.spine) {
        assert.ok(Number.isInteger(entry.index), 'meta.spine[*].index 必须是整数')
        assert.equal(typeof entry.href, 'string')
      }
      assert.deepEqual(
        meta.spine.map((entry) => entry.index),
        [0, 1],
      )
    } finally {
      await cleanup()
    }
  }

  // ── 2. 导入幂等 + 列表 ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const bytes = makeEpub('幂等')
      const first = await store.importBook({ filename: 'a.epub', dataBase64: bytes.toString('base64') })
      const metaFile = path.join(store.paths.bookDir(bookDirName(first.bookHash)), 'meta.json')
      const firstMtime = (await fs.stat(metaFile)).mtimeMs
      const createdAt = JSON.parse(await fs.readFile(metaFile, 'utf8')).createdAt

      const second = await store.importBook({ filename: 'a.epub', dataBase64: bytes.toString('base64') })
      assert.equal(second.bookHash, first.bookHash, '同一份字节必须得到同一个哈希')
      assert.equal(second.meta.createdAt, createdAt, '重复导入不能重置入架时间')
      assert.equal((await fs.stat(metaFile)).mtimeMs, firstMtime, '重复导入不该重写 meta.json')

      const shelf = await store.listShelf()
      assert.equal(shelf.books.length, 1)
      assert.equal(shelf.books[0].title, '幂等')
      assert.equal(shelf.books[0].author, '某作者')
      assert.equal(shelf.books[0].percent, 0)
      assert.equal(shelf.books[0].coverUrl, null, '没有封面时 coverUrl 必须是 null')

      // 书不存在
      await expectCode('E_BOOK_NOT_FOUND', () => store.readMeta('0'.repeat(16)))
    } finally {
      await cleanup()
    }
  }

  // ── 3. 导入失败路径 ──
  {
    const { store, cleanup } = await tempStore({ })
    try {
      await expectCode('E_IMPORT_EMPTY', () => store.importBook({ filename: 'x.epub' }))
      const tiny = new LibraryStore({ libraryDir: store.paths.receivedDir, deviceId: 'mac-abc123', maxImportBytes: 10 })
      await tiny.init()
      const big = Buffer.alloc(64)
      await expectCode('E_IMPORT_TOO_BIG', () =>
        tiny.importBook({ filename: 'big.epub', dataBase64: big.toString('base64') }),
      )
    } finally {
      await cleanup()
    }
  }

  // ── 4. 进度：写入 → 读取 → history 轮转 20 份 ──
  {
    const { store, root, cleanup } = await tempStore()
    try {
      const imported = await store.importBook({ filename: 'p.epub', dataBase64: makeEpub('进度').toString('base64') })
      const dirName = bookDirName(imported.bookHash)

      assert.equal(await store.readProgress(dirName), null, '新书没有进度时返回 null，不是错误')

      const saved = await store.putProgress({
        bookHash: dirName,
        cfi: 'epubcfi(/6/2[ch1]!/4/2/2/1:3)',
        cfiStart: '/4/2/2/1:3',
        chapterHref: 'text/ch1.xhtml',
        percent: 0.25,
      })
      assert.equal(saved.schema, 'dsh-reading/1')
      assert.equal(saved.cfi, 'epubcfi(/6/2[ch1]!/4/2/2/1:3)')
      assert.equal(saved.deviceId, 'mac-abc123')
      // 两套命名都写：客户端读 percent，契约文件读 bookProgression
      assert.equal(saved.percent, 0.25)
      assert.equal(saved.bookProgression, 0.25)

      const read = await store.readProgress(dirName)
      assert.equal(read.cfi, saved.cfi)
      assert.equal(read.bookProgression, 0.25)

      // percent 收敛到 [0,1]
      const clamped = await store.putProgress({ bookHash: dirName, cfi: 'epubcfi(/6/2!/4/2:0)', percent: 9 })
      assert.equal(clamped.percent, 1)
      const clampedLow = await store.putProgress({ bookHash: dirName, cfi: 'epubcfi(/6/2!/4/2:0)', percent: -3 })
      assert.equal(clampedLow.percent, 0)

      // 空 cfi / 非 cfi 一律拒绝
      await expectCode('E_BAD_PROGRESS', () => store.putProgress({ bookHash: dirName, cfi: '' }))
      await expectCode('E_BAD_PROGRESS', () => store.putProgress({ bookHash: dirName, cfi: 'not-a-cfi' }))

      // 连续覆盖 25 次：history 只留最近 20 份
      for (let i = 0; i < 25; i += 1) {
        await store.putProgress({ bookHash: dirName, cfi: `epubcfi(/6/2!/4/2/1:${i})`, percent: i / 30 })
      }
      const historyDir = path.join(root, 'books', dirName, 'history')
      const historyFiles = (await fs.readdir(historyDir)).filter((name) => name.startsWith('progress.json.')).sort()
      assert.equal(historyFiles.length, HISTORY_KEEP, `history 必须留 ${HISTORY_KEEP} 份，实际 ${historyFiles.length}`)
      assert.equal(HISTORY_KEEP, 20, '常量必须是 20（docs/01 §2.8）')

      // 保留下来的必须是最新的 20 份：最后一份的时间戳应晚于第一份
      assert.ok(historyFiles[0] < historyFiles[historyFiles.length - 1], 'history 文件名必须可排序')

      // history 里不含正在使用的 progress.json
      assert.ok(!historyFiles.includes('progress.json'))

      // **`.tmp-*` 临时文件不能挤占历史名额。**
      //
      // writeFileAtomic 写临时文件叫 `progress.json.tmp-<pid>-<rand>`，前缀也是
      // `progress.json.`。原裁剪逻辑用 `name.startsWith(filename + '.')` 挑「我的」，
      // 于是临时文件被当成历史副本；而 `'t' > '2'` 让它永远排在真实历史之后，
      // 结果每轮裁剪都在切真实历史、把垃圾留着。这里手动放两个陈旧 tmp 文件，
      // 再触发一次轮转，断言它们被清掉且真实历史仍有 HISTORY_KEEP 份。
      for (const junk of ['progress.json.tmp-999-aaaaaa', 'progress.json.tmp-999-bbbbbb']) {
        await fs.writeFile(path.join(historyDir, junk), '{}')
      }
      await store.putProgress({ bookHash: dirName, cfi: 'epubcfi(/6/2!/4/2/1:99)', percent: 0.5 })
      const afterJunk = await fs.readdir(historyDir)
      assert.ok(
        !afterJunk.some((name) => name.includes('.tmp-')),
        `history/ 里的 .tmp- 残留必须被清掉，实际还有：${afterJunk.filter((n) => n.includes('.tmp-'))}`,
      )
      const realHistory = afterJunk.filter((name) => name.startsWith('progress.json.') && !name.includes('.tmp-'))
      assert.equal(realHistory.length, HISTORY_KEEP, `真实历史仍须保留 ${HISTORY_KEEP} 份，实际 ${realHistory.length}`)
    } finally {
      await cleanup()
    }
  }

  // ── 5. 标注：写入 → 读取 → 墓碑 ──
  {
    const { store, root, cleanup } = await tempStore()
    try {
      const imported = await store.importBook({ filename: 'a.epub', dataBase64: makeEpub('标注').toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      const file = path.join(root, 'books', dirName, 'annotations.jsonl')

      const record = makeHighlight()
      const { record: stored } = await store.putAnnotation(dirName, record)
      assert.equal(stored.id, record.id)
      assert.equal(stored.schema, 'dsh-reading/1')

      let list = await store.listAnnotations(dirName)
      assert.equal(list.records.length, 1)
      assert.equal(list.records[0].id, record.id)

      // 追加语义：文件里就是一行
      let raw = await fs.readFile(file, 'utf8')
      assert.equal(raw.trim().split('\n').length, 1, '一条记录一行')

      // 更新同一 id：追加第二行，不去改第一行
      const updated = await store.putAnnotation(dirName, { ...record, color: 'blue', textExcerpt: '汪淼2' })
      assert.equal(updated.record.color, 'blue')
      raw = await fs.readFile(file, 'utf8')
      assert.equal(raw.trim().split('\n').length, 2, '同 id 更新是追加，不改写历史行')
      list = await store.listAnnotations(dirName)
      assert.equal(list.records.length, 1, '读的时候按 id 合并成一条')
      assert.equal(list.records[0].color, 'blue', '取 updatedAt 最新的那条')

      // 墓碑：写 deleted:true，文件里仍有两行以上，读取结果里消失
      const deleted = await store.deleteAnnotation(dirName, record.id)
      assert.equal(deleted.deleted, true)
      raw = await fs.readFile(file, 'utf8')
      const lines = raw.trim().split('\n')
      assert.equal(lines.length, 3, '墓碑也是一行，不删行')
      const tombstone = JSON.parse(lines[lines.length - 1])
      assert.equal(tombstone.deleted, true)
      assert.equal(tombstone.id, record.id)
      assert.equal(tombstone.cfi, undefined, '墓碑只保留 id/updatedAt/deviceId')

      const afterDelete = await store.listAnnotations(dirName)
      assert.equal(afterDelete.records.length, 0, '墓碑要从渲染集里过滤掉')

      // 另一条记录不受影响
      const other = makeHighlight({ id: '01J8ZQ6Q7K8M9N0P1Q2R3S4T5W', type: 'bookmark', cfi: 'epubcfi(/6/4!/4/2:0)' })
      await store.putAnnotation(dirName, other)
      assert.equal((await store.listAnnotations(dirName)).records.length, 1)

      // 坏行进隔离舱，不阻断读取
      await fs.appendFile(file, '{ 这不是 json\n')
      const tolerant = await store.listAnnotations(dirName)
      assert.equal(tolerant.records.length, 1, '坏行不能拖垮整份标注')
      // 隔离舱写入是异步的（读路径不能因为写隔离舱而报错），等一拍再断言。
      await new Promise((resolve) => setTimeout(resolve, 60))
      const quarantine = await store.listQuarantine(dirName)
      assert.ok(quarantine.entries.length >= 1, '坏行必须进 quarantine.jsonl')
      assert.ok(
        quarantine.entries.every((entry) => ['schema_invalid', 'fingerprint_drift'].includes(entry.reason)),
        'reason 必须是 schema 里的枚举值',
      )

      // **隔离舱幂等**：同一行坏数据读多少次都只入舱一次。
      //
      // 这是 docs/06 审计的 medium 缺陷回归。原实现用 `Date.now()` 生成 id，
      // 于是每读一次就换一个 id、又追加一条 —— 用户每刷新一次阅读器，
      // quarantine.jsonl 就长一行，隔离舱从「证据」变成「垃圾场」。
      const quarantinedBefore = quarantine.entries.length
      const quarantineFile = path.join(root, 'books', dirName, 'quarantine.jsonl')
      const rawBefore = await fs.readFile(quarantineFile, 'utf8')

      for (let i = 0; i < 3; i += 1) {
        await store.listAnnotations(dirName)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }

      const rawAfter = await fs.readFile(quarantineFile, 'utf8')
      assert.equal(
        rawAfter,
        rawBefore,
        '重复读取同一行坏数据不该再写隔离舱（quarantine.jsonl 必须逐字节不变）',
      )
      const quarantinedAfter = (await store.listQuarantine(dirName)).entries.length
      assert.equal(quarantinedAfter, quarantinedBefore, '隔离舱条目数不该随读取次数增长')

      // 换一个**不同的**坏行仍要入舱 —— 幂等不能变成「一律忽略」。
      await fs.appendFile(file, '{ 另一行也不像 json\n')
      await store.listAnnotations(dirName)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const quarantinedNew = (await store.listQuarantine(dirName)).entries.length
      assert.equal(quarantinedNew, quarantinedBefore + 1, '新的坏行必须照样入舱')
    } finally {
      await cleanup()
    }
  }

  // ── 6. 记录校验：缺必填字段一律拒绝（不降级写入） ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const imported = await store.importBook({ filename: 'v.epub', dataBase64: makeEpub('校验').toString('base64') })
      const dirName = bookDirName(imported.bookHash)

      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ cfi: undefined })))
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ chapterHref: '' })))
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ textExcerpt: undefined })))
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ textFingerprint: undefined })))
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ color: 'magenta' })))
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ id: 'not-a-ulid' })))
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, makeHighlight({ type: 'sticker' })))
      await expectCode('E_BAD_RECORD', () =>
        store.putAnnotation(
          dirName,
          makeHighlight({ textFingerprint: { head: 'x', tail: 'x', len: 1, hash: 'ZZZ' } }),
        ),
      )

      // note 必须带非空 note 文本
      const note = { ...makeHighlight({ type: 'note', id: '01J8ZQ6Q7K8M9N0P1Q2R3S4T5X' }), note: '' }
      await expectCode('E_BAD_RECORD', () => store.putAnnotation(dirName, note))
      const goodNote = { ...note, note: '这里和第三章对不上' }
      await store.putAnnotation(dirName, goodNote)

      // bookmark 不要求指纹，但 id/cfi/chapterHref 仍要
      const bookmark = {
        schema: 'dsh-reading/1',
        id: '01J8ZQ6Q7K8M9N0P1Q2R3S4T5Y',
        type: 'bookmark',
        cfi: 'epubcfi(/6/4[ch2]!/4/2/1:0)',
        cfiStart: '/4/2/1:0',
        chapterHref: 'text/ch2.xhtml',
        label: '读到一半',
        createdAt: '2026-10-22T00:00:00.000Z',
      }
      await store.putAnnotation(dirName, bookmark)

      // 删除要合法 ULID
      await expectCode('E_BAD_RECORD', () => store.deleteAnnotation(dirName, 'nope'))

      // 书不存在时写标注也要拒绝
      await expectCode('E_BOOK_NOT_FOUND', () => store.putAnnotation('f'.repeat(16), makeHighlight()))
    } finally {
      await cleanup()
    }
  }

  // ── 7. 设置：默认值 → 合并写 → history ──
  {
    const { store, root, cleanup } = await tempStore()
    try {
      const initial = await store.getSettings()
      assert.deepEqual(initial, { ...DEFAULT_SETTINGS })
      for (const key of ['fontSize', 'lineHeight', 'theme', 'columns', 'fontFamily']) {
        assert.ok(key in initial, `settings 必须含 ${key}`)
      }

      const merged = await store.putSettings({ fontSize: 22, theme: 'dark' })
      assert.equal(merged.fontSize, 22)
      assert.equal(merged.theme, 'dark')
      assert.equal(merged.lineHeight, DEFAULT_SETTINGS.lineHeight, '没给的字段保留默认值')

      const again = await store.putSettings({ columns: 2 })
      assert.equal(again.fontSize, 22, '合并写不能丢掉上一次的值')
      assert.equal(again.columns, 2)

      const onDisk = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'))
      assert.equal(onDisk.fontSize, 22)

      // 非法值拒绝，且不写坏文件
      await expectCode('E_BAD_SETTINGS', () => store.putSettings({ fontSize: 999 }))
      await expectCode('E_BAD_SETTINGS', () => store.putSettings({ columns: 3 }))
      assert.equal((await store.getSettings()).fontSize, 22, '被拒绝的写入不能改动已有设置')

      // history 里有旧版本
      const historyFiles = await fs.readdir(path.join(root, 'history'))
      assert.ok(
        historyFiles.some((name) => name.startsWith('settings.json.')),
        '覆盖 settings.json 前必须存历史',
      )
    } finally {
      await cleanup()
    }
  }

  // ── 8. 章节 / 资源 / 封面 / 目录 / spine ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const imported = await store.importBook({ filename: 'r.epub', dataBase64: makeEpub('读取', 3).toString('base64') })
      const dirName = bookDirName(imported.bookHash)

      const spine = await store.spine(dirName)
      assert.deepEqual(
        spine.spine.map((entry) => entry.index),
        [0, 1, 2],
      )
      assert.deepEqual(
        spine.spine.map((entry) => entry.href),
        ['text/ch1.xhtml', 'text/ch2.xhtml', 'text/ch3.xhtml'],
      )
      for (const entry of spine.spine) {
        assert.equal(typeof entry.idref, 'string')
        assert.ok(entry.idref.length > 0)
      }

      const toc = await store.toc(dirName)
      assert.equal(toc.toc.length, 3)
      assert.equal(toc.toc[0].spineIndex, 0)
      assert.equal(toc.toc[0].label, '第 1 章')

      const chapter = await store.chapterHtml(dirName, 'text/ch1.xhtml')
      assert.ok(chapter.includes('<p>第 1 章正文</p>'))
      assert.equal(await store.chapterHtml(dirName, 'text/nope.xhtml'), null)
      assert.equal(await store.coverBytes(dirName), null, '没有封面时返回 null')

      // 缓存命中：同一个 bookHash 连续调用不该重复解析
      const first = await store.getParsed(dirName)
      const second = await store.getParsed(dirName)
      assert.equal(first, second, 'getParsed 必须缓存同一个 parse 结果')
    } finally {
      await cleanup()
    }
  }

  // ── 9. 移除书 ──
  {
    const { store, root, cleanup } = await tempStore()
    try {
      const imported = await store.importBook({ filename: 'd.epub', dataBase64: makeEpub('删除').toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      assert.equal((await store.listShelf()).books.length, 1)

      const result = await store.removeBook(dirName)
      assert.equal(result.removed, true)
      assert.equal((await store.listShelf()).books.length, 0)
      await expectCode('E_BOOK_NOT_FOUND', () => store.readMeta(dirName))
      // 幂等：再删一次不炸
      assert.equal((await store.removeBook(dirName)).removed, true)
      // 目录真的没了
      let exists = true
      try {
        await fs.stat(path.join(root, 'books', dirName))
      } catch {
        exists = false
      }
      assert.equal(exists, false)
    } finally {
      await cleanup()
    }
  }

  // ── 10. 坏掉的 meta 不该让整个书架打不开 ──
  {
    const { store, root, cleanup } = await tempStore()
    try {
      await store.importBook({ filename: 'good.epub', dataBase64: makeEpub('好书').toString('base64') })
      // 手工塞一个坏书目录（合法 16 位 hex 目录名，但 meta 是坏的）
      const badDir = path.join(root, 'books', '0123456789abcdef')
      await fs.mkdir(badDir, { recursive: true })
      await fs.writeFile(path.join(badDir, 'meta.json'), '{ 坏掉的 json')
      const shelf = await store.listShelf()
      assert.equal(shelf.books.length, 1, '坏书被跳过，好书照常列出')
      assert.equal(shelf.books[0].title, '好书')
    } finally {
      await cleanup()
    }
  }

  // ── 11. 路径钉死：bookHash 不是 hex 一律拒绝 ──
  {
    const paths = new LibraryPaths('')
    for (const bad of ['../etc', '..', '', 'zzzz', '0'.repeat(15), '0'.repeat(17), '/etc/passwd', 'a/b']) {
      let caught = null
      try {
        bookDirName(bad)
      } catch (error) {
        caught = error
      }
      assert.ok(caught, `bookHash=${JSON.stringify(bad)} 应当被拒绝`)
      assert.equal(caught.code, 'E_BAD_BOOK_HASH')
    }
    // 大写 hex 归一成小写：用户从别处复制哈希常带大写，而 mac 会为此建出两个目录、
    // Linux 会直接找不到书。哈希是 hex，大小写不携带信息，折叠是必要的。
    assert.equal(bookDirName('A'.repeat(16)), 'a'.repeat(16))
    assert.equal(bookDirName('A'.repeat(64)), 'a'.repeat(16))
    // 合法小写 16 位原样通过；全串可截断
    assert.equal(bookDirName('a'.repeat(16)), 'a'.repeat(16))
    assert.equal(bookDirName('a'.repeat(64)), 'a'.repeat(16))
    assert.equal(bookHashFull('a'.repeat(64)), 'a'.repeat(64))
    let fullBad = null
    try {
      bookHashFull('a'.repeat(16))
    } catch (error) {
      fullBad = error
    }
    assert.equal(fullBad.code, 'E_BAD_BOOK_HASH')

    // 默认目录在 home 下，且是 dsh-reading 子目录
    const defaultPaths = new LibraryPaths('')
    assert.ok(defaultPaths.root.endsWith(path.join('.dsh-reading', 'dsh-reading')))
    assert.ok(defaultPaths.booksRoot.endsWith('books'))

    // assertInside：前缀相同的兄弟目录不能被放过
    const base = path.join(os.tmpdir(), 'lib', 'books', 'abcdef0123456789')
    assert.equal(LibraryPaths.assertInside(base, path.join(base, 'meta.json')), path.join(base, 'meta.json'))
    let escape = null
    try {
      LibraryPaths.assertInside(base, `${base}-evil/meta.json`)
    } catch (error) {
      escape = error
    }
    assert.equal(escape.code, 'E_BAD_PATH', '前缀相同的兄弟目录必须拒绝')
  }

  // ── 12. deviceId ──
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reading-device-'))
    try {
      const id = makeDeviceId()
      assert.match(id, DEVICE_ID_PATTERN)
      assert.ok(id.length <= 24)

      const first = await ensureDeviceId(dir)
      assert.match(first, DEVICE_ID_PATTERN)
      const second = await ensureDeviceId(dir)
      assert.equal(second, first, 'deviceId 一经生成必须稳定')

      const raw = JSON.parse(await fs.readFile(path.join(dir, 'device.json'), 'utf8'))
      assert.equal(raw.deviceId, first)

      // 文件里是坏的 id：重新生成，而不是把坏值透出去
      await fs.writeFile(path.join(dir, 'device.json'), JSON.stringify({ deviceId: 'BAD ID' }))
      const repaired = await ensureDeviceId(dir)
      assert.match(repaired, DEVICE_ID_PATTERN)
      assert.notEqual(repaired, 'BAD ID')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  // ── 13. 纯函数：合并规则 / 版本比较 / 设置合并 ──
  {
    // compareVersion：先 updatedAt，再 deviceId 字典序
    const a = { updatedAt: '2026-10-22T00:00:00.000Z', deviceId: 'mac-aaa' }
    const b = { updatedAt: '2026-10-22T00:00:01.000Z', deviceId: 'mac-aaa' }
    assert.ok(compareVersion(b, a) > 0)
    assert.ok(compareVersion(a, b) < 0)
    assert.equal(compareVersion(a, a), 0)
    const c = { updatedAt: a.updatedAt, deviceId: 'mac-zzz' }
    assert.ok(compareVersion(c, a) > 0, '时间相同看 deviceId 字典序')
    assert.ok(compareVersion({}, {}) === 0)

    // mergeSettings 只认五个键
    const settings = mergeSettings(DEFAULT_SETTINGS, { fontSize: 20, unknownKey: 'x' })
    assert.equal(settings.fontSize, 20)
    assert.equal('unknownKey' in settings, false)

    // validateRecord 保留多余字段（客户端将来加字段不用改宿主）
    const validated = validateRecord(makeHighlight({ extraField: 'keep-me' }))
    assert.equal(validated.extraField, 'keep-me')
    assert.equal(validated.id, makeHighlight().id)
  }

  // ── 14. 改书名 / 作者（0.4.0 book.update 的 store 面） ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const bytes = makeEpub('原名', 2)
      const imported = await store.importBook({ filename: '元数据.epub', dataBase64: bytes.toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      const dir = store.paths.bookDir(dirName)
      const metaFile = path.join(dir, 'meta.json')

      const updated = await store.updateMeta(dirName, { title: '  新书名  ', author: ' 新作者 ' })
      assert.equal(updated.book.title, '新书名', '书名要 trim')
      assert.equal(updated.book.author, '新作者')
      assert.equal(updated.book.id, dirName)

      const onDisk = JSON.parse(await fs.readFile(metaFile, 'utf8'))
      assert.equal(onDisk.title, '新书名', '必须真的写回 meta.json')
      assert.equal(onDisk.author, '新作者')
      assert.ok(onDisk.updatedAt > imported.meta.updatedAt, 'updatedAt 要刷新')
      assert.equal(onDisk.bookHash, imported.meta.bookHash, '重写 meta 不能丢字段')
      assert.equal(onDisk.spine.length, imported.meta.spine.length)
      // 原子写：不许留下 .tmp- 半成品
      const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))
      assert.deepEqual(leftovers, [], '原子写不能留下临时文件')

      const shelf = await store.listShelf()
      assert.equal(shelf.books[0].title, '新书名', '书架要看到新书名')

      // 只改作者：书名保持不动
      const authorOnly = await store.updateMeta(dirName, { author: '另一个人' })
      assert.equal(authorOnly.book.title, '新书名')
      assert.equal(authorOnly.book.author, '另一个人')

      // 清空作者 = 这本书没有作者（删字段，不是留空字符串）
      const cleared = await store.updateMeta(dirName, { author: '' })
      assert.equal(cleared.book.author, '')
      const clearedMeta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
      assert.equal('author' in clearedMeta, false, '清空作者应当删掉该字段')

      await expectCode('E_ARGS', () => store.updateMeta(dirName, { title: '   ' }))
      await expectCode('E_ARGS', () => store.updateMeta(dirName, { title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }))
      await expectCode('E_ARGS', () => store.updateMeta(dirName, { author: 'x'.repeat(MAX_AUTHOR_LENGTH + 1) }))
      await expectCode('E_ARGS', () => store.updateMeta(dirName, {}))
      await expectCode('E_BOOK_NOT_FOUND', () => store.updateMeta('0'.repeat(16), { title: '不存在的书' }))

      // 中文报错 + 400：界面直接把 message 摆到输入框下面
      const empty = await expectCode('E_ARGS', () => store.updateMeta(dirName, { title: '' }))
      assert.match(empty.message, /书名不能为空/)
      assert.equal(empty.status, 400)

      // 边界值必须放行：上限本身不是错误
      const edge = await store.updateMeta(dirName, {
        title: '字'.repeat(MAX_TITLE_LENGTH),
        author: '字'.repeat(MAX_AUTHOR_LENGTH),
      })
      assert.equal(edge.book.title.length, MAX_TITLE_LENGTH)
    } finally {
      await cleanup()
    }
  }

  // ── 15. 封面：魔数判定 / 换封面 / 删封面（0.4.0） ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const bytes = makeEpub('带封面的书', 2, { cover: true })
      const imported = await store.importBook({ filename: '封面.epub', dataBase64: bytes.toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      const dir = store.paths.bookDir(dirName)

      assert.equal(imported.meta.coverHref, 'images/cover.png', '书内封面要写进 meta')
      assert.equal((await store.listShelf()).books[0].coverVersion, 0, '没换过封面时版本是 0')

      // 没换过封面：回退到书内归档里的那张图
      const archive = await store.coverBytes(dirName)
      assert.equal(archive.mediaType, 'image/png')
      assert.equal(archive.version, 0)

      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('uploaded-png'),
      ])
      const first = await store.putCover(dirName, png)
      assert.equal(first.book.coverHref, 'cover.png')
      assert.equal(first.book.coverMediaType, 'image/png')
      assert.equal(first.book.coverVersion, 1)
      assert.deepEqual(await fs.readFile(path.join(dir, 'cover.png')), png)
      assert.deepEqual((await store.coverBytes(dirName)).bytes, png, '读盘优先：换过的封面盖过书内封面')

      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('uploaded-jpeg')])
      const second = await store.putCover(dirName, jpg)
      assert.equal(second.book.coverHref, 'cover.jpg')
      assert.equal(second.book.coverMediaType, 'image/jpeg')
      assert.equal(second.book.coverVersion, 2)
      const names = await fs.readdir(dir)
      assert.ok(names.includes('cover.jpg'))
      assert.ok(!names.includes('cover.png'), '换封面必须删掉旧封面文件，目录里只留一张')
      const afterSecond = await store.coverBytes(dirName)
      assert.equal(afterSecond.mediaType, 'image/jpeg')
      assert.equal(afterSecond.version, 2)

      // 魔数判定：扩展名与 MIME 都不作数
      await expectCode('E_ARGS', () => store.putCover(dirName, Buffer.from('not an image')))
      await expectCode('E_COVER_TOO_BIG', () =>
        store.putCover(dirName, Buffer.concat([png, Buffer.alloc(MAX_COVER_BYTES)])),
      )
      await expectCode('E_ARGS', () => store.putCover(dirName, Buffer.alloc(0)))
      // 书不存在时是 404，不是「图片不行」
      await expectCode('E_BOOK_NOT_FOUND', () => store.putCover('0'.repeat(16), png))

      // 删封面：coverHref 置空、文件删掉、版本 +1
      const reset = await store.resetCover(dirName)
      assert.equal(reset.book.coverHref, '')
      assert.equal(reset.book.coverVersion, 3)
      const left = (await fs.readdir(dir)).filter((name) => name.startsWith('cover.'))
      assert.deepEqual(left, [], '删封面要把 cover.* 全删掉')
      assert.equal(await store.coverBytes(dirName), null, '删过封面之后不能再回退到书内封面')
      const shelf = await store.listShelf()
      assert.equal(shelf.books[0].coverUrl, null)
      assert.equal(shelf.books[0].coverVersion, 3, '删封面也要让版本往前走')

      // 四种图都能按魔数认出来（gif/webp 只认字节，不写盘）
      assert.equal(sniffCoverImage(png).ext, 'png')
      assert.equal(sniffCoverImage(jpg).mediaType, 'image/jpeg')
      assert.equal(sniffCoverImage(Buffer.from('GIF89a....')).ext, 'gif')
      assert.equal(sniffCoverImage(Buffer.from('RIFF0000WEBPxxxx')).mediaType, 'image/webp')
      assert.equal(sniffCoverImage(Buffer.from('BM0000')), null)
    } finally {
      await cleanup()
    }
  }

  // ── 16. 目录来源标记（0.4.0 tocSource） ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const epub = makeEpub('目录书', 2)
      const imported = await store.importBook({ filename: '目录.epub', dataBase64: epub.toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      assert.equal(imported.meta.tocSource, 'nav', 'EPUB3 nav 目录要记成 nav')
      const toc = await store.toc(dirName)
      assert.equal(toc.source, 'nav')
      assert.equal(toc.toc.length, 2)

      // 老库：meta 里没有 tocSource → 目录不可信，按 none 处理（空目录）
      const metaFile = path.join(store.paths.bookDir(dirName), 'meta.json')
      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
      delete meta.tocSource
      await fs.writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`)
      const legacy = await store.toc(dirName)
      assert.equal(legacy.source, 'none')
      assert.deepEqual(legacy.toc, [], '老库没有来源标记，不列目录（避免把假目录当真）')

      // EPUB2（toc.ncx）→ ncx；没有 nav 也不会被误记成 nav
      const epub2 = makeEpub('NCX 书', 2, { ncx: true })
      const ncxImported = await store.importBook({ filename: 'ncx.epub', dataBase64: epub2.toString('base64') })
      const ncxDir = bookDirName(ncxImported.bookHash)
      assert.equal(ncxImported.meta.tocSource, 'ncx', 'EPUB2 的目录来自 toc.ncx')
      const ncxToc = await store.toc(ncxDir)
      assert.equal(ncxToc.source, 'ncx')
      assert.deepEqual(
        ncxToc.toc.map((item) => item.label),
        ['第 1 章', '第 2 章'],
      )

      // 既没有 nav 也没有 ncx：字段如实记 spine（拿 idref 冒充的），但不当目录发给界面
      const bare = makeEpub('裸书', 2, { plain: true })
      const bareImported = await store.importBook({ filename: '裸.epub', dataBase64: bare.toString('base64') })
      const bareDir = bookDirName(bareImported.bookHash)
      assert.equal(bareImported.meta.tocSource, 'spine')
      const bareToc = await store.toc(bareDir)
      assert.equal(bareToc.source, 'spine')
      assert.deepEqual(bareToc.toc, [], 'spine 冒充的章名不算目录')

      // TXT：识别到两个真标题 → auto，目录照常给
      const txt = Buffer.from('第一章 起风\n\n正文一。\n\n第二章 天黑\n\n正文二。\n', 'utf8')
      const txtImported = await store.importBook({ filename: '标题.txt', dataBase64: txt.toString('base64') })
      const txtDir = bookDirName(txtImported.bookHash)
      assert.equal(txtImported.meta.tocSource, 'auto', 'TXT 识别到真标题要记成 auto')
      // 新写的 meta.json 里能直接看到这个字段（老库靠 ?? 'none' 兜底，不批量重写）
      const txtMetaOnDisk = JSON.parse(
        await fs.readFile(path.join(store.paths.bookDir(txtDir), 'meta.json'), 'utf8'),
      )
      assert.equal(txtMetaOnDisk.tocSource, 'auto')
      const txtToc = await store.toc(txtDir)
      assert.equal(txtToc.source, 'auto')
      assert.deepEqual(
        txtToc.toc.map((item) => item.label),
        ['第一章 起风', '第二章 天黑'],
      )

      // TXT：没有标题 → 按字数硬切，记 split，且不把「第 N 部分」当目录发出去
      const plain = Buffer.from('这是一段没有任何章节标题的正文。'.repeat(20), 'utf8')
      const plainImported = await store.importBook({ filename: '无标题.txt', dataBase64: plain.toString('base64') })
      const plainDir = bookDirName(plainImported.bookHash)
      assert.equal(plainImported.meta.tocSource, 'none', '硬切就是没有目录，要记成 none')
      const plainToc = await store.toc(plainDir)
      assert.equal(plainToc.source, 'none')
      assert.deepEqual(plainToc.toc, [], '硬切出来的「第 N 部分」不是目录，必须返回空数组')
    } finally {
      await cleanup()
    }
  }

  // ── 17. 问答记录：字段兜底 / 删除（0.4.0 qa.list / qa.delete） ──
  {
    const { store, cleanup } = await tempStore()
    try {
      const epub = makeEpub('问答书', 2)
      const imported = await store.importBook({ filename: '问答.epub', dataBase64: epub.toString('base64') })
      const dirName = bookDirName(imported.bookHash)
      const qaFile = path.join(store.paths.bookDir(dirName), 'qa.jsonl')

      const entry = await store.appendQa(dirName, {
        question: '这段在说什么？',
        answer: '在说一句话。',
        anchorCfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:5)',
        chapterHref: 'text/ch1.xhtml',
        chapterLabel: '第一章',
      })
      const listed = await store.listQa(dirName)
      const record = listed.records.find((item) => item.id === entry.id)
      assert.ok(record, '刚写的问答必须在列表里')
      for (const key of [
        'id',
        'book',
        'bookHash',
        'question',
        'answer',
        'chapterHref',
        'chapterLabel',
        'cutoffCfi',
        'anchorCfiRange',
        'anchorXpath',
        'selectedText',
        'model',
        'createdAt',
        'updatedAt',
      ]) {
        assert.equal(typeof record[key], 'string', `qa.list 必须给出字符串 ${key}`)
      }
      assert.equal(record.book, dirName, '没有 book 字段时用书目录名兜底')
      assert.equal(record.chapterLabel, '第一章')
      assert.equal(record.cutoffCfi, '', '缺的字段补空串，不能是 undefined')

      // 旧库：只有 question/answer/anchorCfiRange 的行也要能读（缺字段不炸）
      const legacyLine = JSON.stringify({
        id: 'qa-legacy-1',
        question: '旧问题',
        answer: '旧答案',
        anchorCfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:2)',
      })
      await fs.appendFile(qaFile, `${legacyLine}\n`)
      const withLegacy = await store.listQa(dirName)
      const legacy = withLegacy.records.find((item) => item.id === 'qa-legacy-1')
      assert.ok(legacy, '旧记录必须能被读出来')
      assert.equal(legacy.chapterHref, '')
      assert.equal(legacy.model, '')
      assert.equal(legacy.createdAt, '')
      assert.equal(legacy.book, dirName)

      // limit 只截尾巴（旧在前），不是分页；非法值按默认上限处理
      for (let i = 0; i < 3; i += 1) {
        await store.appendQa(dirName, {
          question: `问 ${i}`,
          answer: `答 ${i}`,
          anchorCfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:1)',
        })
      }
      const capped = await store.listQa(dirName, { limit: 2 })
      assert.equal(capped.records.length, 2, 'limit 要截断')
      assert.equal(capped.records[0].question, '旧问题', '旧在前：截的是尾巴')
      assert.ok((await store.listQa(dirName, { limit: 999999 })).records.length >= 4, '超大的 limit 收敛后不丢记录')
      assert.ok((await store.listQa(dirName, { limit: -1 })).records.length >= 4, '非法 limit 按默认上限处理')

      // 删除：写墓碑、列表里消失、再删同一条给 404
      const removed = await store.deleteQa(dirName, entry.id)
      assert.equal(removed.deleted, true)
      const afterDelete = await store.listQa(dirName)
      assert.equal(afterDelete.records.some((item) => item.id === entry.id), false)
      assert.ok(afterDelete.records.some((item) => item.id === 'qa-legacy-1'), '删一条不能影响别的记录')
      const raw = await fs.readFile(qaFile, 'utf8')
      assert.ok(raw.includes('"deleted":true'), '删除要写墓碑而不是删行')
      await expectCode('E_QA_NOT_FOUND', () => store.deleteQa(dirName, entry.id))
      await expectCode('E_BAD_RECORD', () => store.deleteQa(dirName, '  '))
      await expectCode('E_BOOK_NOT_FOUND', () => store.deleteQa('0'.repeat(16), 'qa-1'))
    } finally {
      await cleanup()
    }
  }
}
