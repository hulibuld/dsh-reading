/**
 * schema 一致性测试：手写 `validateRecord` 与 ajv 编译同一个 schema，判定必须完全一致。
 *
 * 为什么需要它：`client/src/contract.js` 是 schema 的手写同构版（浏览器半不引 ajv）。
 * 手写版一旦漏一个字段、写错一个枚举、或者 additionalProperties 忘了关，
 * 浏览器会接受服务端/别的设备判定为非法的记录——两边判定分叉就是数据损坏的开始。
 * 这个测试用 devDependency 里的 ajv 当裁判。
 *
 * 两个必须注意的坑：
 *   1. schema 是 draft 2020-12，默认 `ajv` 导出会抛 `no schema with key or ref ...`。
 *      必须用 `ajv/dist/2020.js`。
 *   2. 顶层用 `oneOf` 分发 7 种记录类型，ajv 会把**所有 7 个分支**的缺失字段都报出来
 *      （docs/01 §2.9.1 / docs/04 §9 记的就是这个）。所以这里只比「整体真假」，
 *      **不比** error 数组的内容。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  makeHighlight, makeNote, makeBookmark, makeQa, makeQuarantine,
  fingerprint, validateRecord, SCHEMA,
} from '../client/src/contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(HERE, '..', 'schema', 'contract.schema.json')

const DEVICE = 'mac-7f3a91'
const CFI_RANGE = 'epubcfi(/6/2[ch1]!/4/2[p1],/1:3,/1:8)'
const CFI_POINT = 'epubcfi(/6/2[ch1]!/4/2[p1]/1:3)'
const EXCERPT = 'lo, W'
const HASH = 'a'.repeat(64)

/** 六种记录各造 4 条：合法 / 缺必填 / 类型错 / 多余字段。 */
function samples() {
  const cases = []

  const highlight = makeHighlight({
    cfi: CFI_RANGE,
    chapterHref: 'text/ch1.xhtml',
    textExcerpt: EXCERPT,
    textFingerprint: fingerprint(EXCERPT),
    color: 'yellow',
    deviceId: DEVICE,
  })
  cases.push(['highlight-ok', highlight])
  {
    const bad = { ...highlight }
    delete bad.textFingerprint
    cases.push(['highlight-missing-textFingerprint', bad])
  }
  cases.push(['highlight-wrong-type-color', { ...highlight, color: 42 }])
  cases.push(['highlight-extra-field', { ...highlight, bogus: true }])

  const note = makeNote({
    cfi: CFI_RANGE,
    chapterHref: 'text/ch1.xhtml',
    textExcerpt: EXCERPT,
    textFingerprint: fingerprint(EXCERPT),
    color: 'blue',
    note: '这里和第三章对不上',
    deviceId: DEVICE,
  })
  cases.push(['note-ok', note])
  {
    const bad = { ...note }
    delete bad.note
    cases.push(['note-missing-note', bad])
  }
  cases.push(['note-empty-note', { ...note, note: '' }])
  cases.push(['note-extra-field', { ...note, extra: 1 }])

  const bookmark = makeBookmark({
    cfi: CFI_POINT,
    chapterHref: 'text/ch1.xhtml',
    label: '读到一半',
    deviceId: DEVICE,
  })
  cases.push(['bookmark-ok', bookmark])
  {
    const bad = { ...bookmark }
    delete bad.chapterHref
    cases.push(['bookmark-missing-chapterHref', bad])
  }
  cases.push(['bookmark-bad-cfi', { ...bookmark, cfi: 'not-a-cfi' }])
  cases.push(['bookmark-extra-field', { ...bookmark, textFingerprint: fingerprint('x') }])

  const qa = makeQa({
    anchorCfiRange: CFI_RANGE,
    cutoffCfi: CFI_RANGE,
    question: '这一段什么意思？',
    answer: '意思是……',
    contextExcerpt: '上下文',
    model: 'some-model',
    deviceId: DEVICE,
  })
  cases.push(['qa-ok', qa])
  {
    const bad = { ...qa }
    delete bad.cutoffCfi
    cases.push(['qa-missing-cutoffCfi', bad])
  }
  cases.push(['qa-empty-answer', { ...qa, answer: '' }])
  cases.push(['qa-extra-field', { ...qa, anchorCfi: CFI_RANGE }])

  const quarantine = makeQuarantine({
    reason: 'fingerprint_drift',
    sourceDeviceId: DEVICE,
    rawCfi: CFI_RANGE,
    rawRecord: '{"id":"x"}',
    repairable: true,
  })
  cases.push(['quarantine-ok', quarantine])
  {
    const bad = { ...quarantine }
    delete bad.sourceDeviceId
    cases.push(['quarantine-missing-sourceDeviceId', bad])
  }
  cases.push(['quarantine-bad-reason', { ...quarantine, reason: 'not_a_reason' }])
  cases.push(['quarantine-extra-field', { ...quarantine, deviceId: DEVICE }])

  const meta = {
    schema: SCHEMA,
    bookHash: 'b'.repeat(64),
    title: '测试书',
    author: 'fixture',
    format: 'epub',
    converterVersion: 'epub/1',
    spine: [{ index: 0, href: 'text/ch1.xhtml', idref: 'ch1' }],
    fileSize: 12345,
    updatedAt: '2024-01-01T00:00:00.000Z',
    deviceId: DEVICE,
    createdAt: '2024-01-01T00:00:00.000Z',
  }
  cases.push(['meta-ok', meta])
  cases.push(['meta-spine-without-index', { ...meta, spine: [{ href: 'text/ch1.xhtml' }] }])
  cases.push(['meta-bad-format', { ...meta, format: 'pdf' }])
  cases.push(['meta-extra-field', { ...meta, nope: 1 }])
  // 0.4.0 三个新字段：进 cases 走「ajv vs validateRecord」双路，而不是只测 ajv 一侧。
  // 只测 ajv 的话，contract.js 的字段表漏写也照样绿——那正是这个测试存在的理由。
  for (const source of ['nav', 'ncx', 'spine', 'auto', 'headings', 'split', 'none']) {
    cases.push([`meta-tocSource-${source}`, { ...meta, tocSource: source }])
  }
  cases.push(['meta-tocSource-unknown', { ...meta, tocSource: 'guess' }])
  cases.push(['meta-tocSource-empty', { ...meta, tocSource: '' }])
  cases.push(['meta-coverVersion-zero', { ...meta, coverVersion: 0 }])
  cases.push(['meta-coverVersion-counted', { ...meta, coverVersion: 3, coverMediaType: 'image/webp' }])
  cases.push(['meta-coverVersion-negative', { ...meta, coverVersion: -1 }])
  cases.push(['meta-coverVersion-fraction', { ...meta, coverVersion: 1.5 }])
  cases.push(['meta-coverVersion-string', { ...meta, coverVersion: '3' }])
  cases.push(['meta-coverMediaType-number', { ...meta, coverMediaType: 42 }])

  const progress = {
    schema: SCHEMA,
    cfi: CFI_RANGE,
    chapterHref: 'text/ch1.xhtml',
    chapterProgression: 0.4,
    bookProgression: 0.12,
    updatedAt: '2024-01-01T00:00:00.000Z',
    deviceId: DEVICE,
  }
  cases.push(['progress-ok', progress])
  {
    const bad = { ...progress }
    delete bad.cfi
    cases.push(['progress-missing-cfi', bad])
  }
  cases.push(['progress-out-of-range', { ...progress, bookProgression: 1.5 }])
  cases.push(['progress-extra-field', { ...progress, note: 'x' }])

  // 一些跨分支的边角：必须两边都判非法
  cases.push(['unknown-type-shape', { schema: SCHEMA, type: 'unknown', id: 'X'.repeat(26) }])
  cases.push(['not-an-object-string', 'hello'])
  cases.push(['not-an-object-null', null])
  cases.push(['empty-object', {}])
  cases.push(['highlight-ulid-too-short', { ...highlight, id: 'abc' }])
  cases.push(['highlight-bad-timestamp', { ...highlight, createdAt: '2024-01-01T00:00:00Z' }])
  cases.push(['highlight-fingerprint-len-negative', {
    ...highlight,
    textFingerprint: { head: 'lo, W', tail: 'lo, W', len: -1, hash: HASH },
  }])

  return cases
}

export default async function run() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,          // schema 里有 draft-2020 的写法，strict 会因未知关键字报错
    validateFormats: false, // iso8601 是 pattern 不是 format，别让 ajv 去查 format
  })
  const validate = ajv.compile(schema)

  const cases = samples()
  assert.ok(cases.length >= 24, `样本应至少 24 条，实际 ${cases.length}`)

  const mismatches = []
  let legalCount = 0
  let illegalCount = 0

  for (const [label, record] of cases) {
    const ajvOk = validate(record) === true
    const manual = validateRecord(record)
    const manualOk = manual.ok
    if (ajvOk) legalCount += 1
    else illegalCount += 1

    if (ajvOk !== manualOk) {
      mismatches.push({
        label,
        ajvOk,
        manualOk,
        ajvErrors: (validate.errors ?? []).slice(0, 3).map(e => `${e.instancePath || '/'} ${e.message}`),
        manualErrors: manual.errors.slice(0, 3),
        record: typeof record === 'object' && record !== null ? JSON.stringify(record).slice(0, 200) : String(record),
      })
    }
  }

  if (mismatches.length > 0) {
    const lines = mismatches.map(m => [
      `  [${m.label}] ajv=${m.ajvOk} validateRecord=${m.manualOk}`,
      `      record : ${m.record}`,
      `      ajv    : ${m.ajvErrors.join(' | ')}`,
      `      manual : ${JSON.stringify(m.manualErrors)}`,
    ].join('\n'))
    assert.fail(`ajv 与 validateRecord 判定不一致（${mismatches.length}/${cases.length} 条）：\n${lines.join('\n')}`)
  }

  // 样本本身要有区分度：全合法或全非法都说明样本造错了
  assert.ok(legalCount > 0, '样本里没有合法记录，测不出「一致地放行」')
  assert.ok(illegalCount > 0, '样本里没有非法记录，测不出「一致地拒绝」')

  // 合法样本必须真的能过 ajv（防止 schema 与构造器一起漂移成「全都非法」）
  const okHighlight = cases.find(([label]) => label === 'highlight-ok')[1]
  assert.equal(validate(okHighlight), true, 'makeHighlight 产出的记录必须能过 ajv')

  // 顺带确认 schema 版本与契约常量一致（改 schema 忘了改 SCHEMA 常量会在这里红）
  const schemaConst = schema.$defs.highlight.properties.schema.const
  assert.equal(schemaConst, SCHEMA, `schema 的 const 是 ${schemaConst}，contract.js 的 SCHEMA 是 ${SCHEMA}`)

  // ── 0.4.0 新增的 meta 字段：两路都必须认，且结论一致 ──
  // 上面的 cases 已经做过「ajv vs validateRecord」全量对比（含这三个字段的七种取值、
  // 负版本号、小数版本号、字符串版本号、未知枚举）。这里再做一层显式断言：
  // 万一哪天有人把这些 case 从 samples() 里删掉，这里的双路断言仍然能拦住「只测 ajv 一侧」。
  const metaOk = cases.find(([label]) => label === 'meta-ok')[1]
  const agree = (record, expected, why) => {
    const ajvOk = validate(record) === true
    const manualOk = validateRecord(record).ok
    assert.equal(ajvOk, expected, `${why}：ajv 判定应为 ${expected}`)
    assert.equal(manualOk, expected, `${why}：validateRecord 判定应为 ${expected}（两路分叉 = 契约漂移）`)
  }
  for (const source of ['nav', 'ncx', 'spine', 'auto', 'headings', 'split', 'none']) {
    agree({ ...metaOk, tocSource: source }, true, `meta.tocSource=${source}`)
  }
  agree({ ...metaOk, tocSource: 'guess' }, false, '未知的 tocSource 要拦下来')
  agree({ ...metaOk, coverVersion: 0 }, true, '没有封面的书写 coverVersion=0 合法')
  agree({ ...metaOk, coverVersion: 3, coverMediaType: 'image/webp' }, true, '改过三次封面的书合法')
  agree({ ...metaOk, coverVersion: -1 }, false, '版本号不能是负数')
  agree({ ...metaOk, coverVersion: 1.5 }, false, '版本号必须是整数')
  agree({ ...metaOk, coverVersion: '3' }, false, '版本号必须是数字，不能是字符串')
  agree({ ...metaOk, coverVersion: 0, bogusField: true }, false, '新字段不能放开多余字段的口子')
}
