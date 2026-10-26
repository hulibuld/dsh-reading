/**
 * 契约层单测：构造器的必填硬校验 + 指纹三态 + ULID 单调性。
 *
 * 这个文件的重点是「**不许降级**」：缺字段必须抛，不许返回一条缺字段的记录
 * 让上层「先跑通」。docs/05 §5.3 与铁律 5 都把这条列为硬约束，因为一条没有
 * textFingerprint 的 highlight 会让 L3 校验永远无法执行，而它看起来一切正常。
 */

import assert from 'node:assert/strict'
import {
  SCHEMA, COLORS, QUARANTINE_REASONS,
  makeUlid, fingerprint, compareFingerprint, truncateExcerpt,
  makeHighlight, makeNote, makeBookmark, makeQa, makeQuarantine,
  validateRecord,
} from '../client/src/contract.js'

const DEVICE = 'mac-7f3a91'
const CFI = 'epubcfi(/6/2[ch1]!/4/2[p1],/1:3,/1:8)'
const EXCERPT = 'lo, W'

/** 断言抛出的是契约错误，并且错误信息里点出了那个字段。 */
const throwsField = (fn, field, label) => {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: 应当抛错，但返回了记录`)
  assert.equal(thrown.name, 'ContractError', `${label}: 抛的应是 ContractError，实际 ${thrown.name}`)
  assert.ok(
    String(thrown.message).includes(field) || thrown.field === field,
    `${label}: 错误信息应点出字段 ${field}，实际「${thrown.message}」`,
  )
}

const baseHighlight = (overrides = {}) => ({
  cfi: CFI,
  chapterHref: 'text/ch1.xhtml',
  textExcerpt: EXCERPT,
  textFingerprint: fingerprint(EXCERPT),
  color: 'yellow',
  deviceId: DEVICE,
  ...overrides,
})

/* --------------------------------------------------------- 构造器硬校验 */

function constructorsRequireFields() {
  // 1) 缺 textFingerprint —— 最常见的「先跑通」诱惑
  throwsField(
    () => makeHighlight(baseHighlight({ textFingerprint: undefined })),
    'textFingerprint',
    'makeHighlight 缺 textFingerprint',
  )

  // 2) 缺 textExcerpt
  throwsField(
    () => makeHighlight(baseHighlight({ textExcerpt: undefined })),
    'textExcerpt',
    'makeHighlight 缺 textExcerpt',
  )

  // 3) 缺 cfi
  throwsField(
    () => makeHighlight(baseHighlight({ cfi: undefined })),
    'cfi',
    'makeHighlight 缺 cfi',
  )

  // 4) 缺 chapterHref / color / deviceId —— 同一条规则，逐条断言
  throwsField(
    () => makeHighlight(baseHighlight({ chapterHref: '' })),
    'chapterHref',
    'makeHighlight 空 chapterHref',
  )
  throwsField(
    () => makeHighlight(baseHighlight({ color: undefined })),
    'color',
    'makeHighlight 缺 color',
  )
  throwsField(
    () => makeHighlight(baseHighlight({ deviceId: undefined })),
    'deviceId',
    'makeHighlight 缺 deviceId',
  )

  // 5) textFingerprint 传 null（有人会用它表示「以后再补」）
  throwsField(
    () => makeHighlight(baseHighlight({ textFingerprint: null })),
    'textFingerprint',
    'makeHighlight textFingerprint=null',
  )

  // 6) 指纹对象残缺（只有 head）也不能过
  throwsField(
    () => makeHighlight(baseHighlight({ textFingerprint: { head: 'lo, W' } })),
    'textFingerprint',
    'makeHighlight 指纹残缺',
  )

  // 7) 高亮必须是区间：点 CFI 会被渲染成看不见的零宽高亮
  throwsField(
    () => makeHighlight(baseHighlight({ cfi: 'epubcfi(/6/2[ch1]!/4/2[p1]/1:3)' })),
    'cfi',
    'makeHighlight 用点 CFI',
  )

  // 8) 空摘录也不许：L3 需要一个非空原文
  throwsField(
    () => makeHighlight(baseHighlight({ textExcerpt: '' })),
    'textExcerpt',
    'makeHighlight 空摘录',
  )

  // 9) id 断言里的转义逗号不能被当成区间分隔符（CFI 的转义规则：^ 之后转义一个字符）
  const escaped = makeHighlight(baseHighlight({
    cfi: 'epubcfi(/6/2[ch1]!/4/2[a^,b],/1:0,/1:2)',
  }))
  assert.equal(escaped.cfiStart, '/4/2[a^,b]/1:0', '转义逗号应留在 id 里，不当分隔符')
  assert.equal(escaped.cfiEnd, '/4/2[a^,b]/1:2')
  assert.deepEqual(validateRecord(escaped), { ok: true, errors: [] })

  // 合法输入必须能造出记录，并且能通过 validateRecord
  const highlight = makeHighlight(baseHighlight())
  assert.equal(highlight.schema, SCHEMA)
  assert.equal(highlight.type, 'highlight')
  assert.deepEqual(validateRecord(highlight), { ok: true, errors: [] })
  // cfiStart / cfiEnd 是 schema 里的 cfiPartial：以 / 开头、不含 epubcfi() 外壳、不含 '!'
  // 形态与 vendor 的 collapse() 输出一致（docs/03 §八）：
  //   epubcfi(/4/2[p1],/1:3,/1:8) → cfiStart "/4/2[p1]/1:3"、cfiEnd "/4/2[p1]/1:8"
  // 即「父路径 + 该端尾部」连成一个**点**路径，单独拿去解析也指向正确位置。
  assert.equal(highlight.cfiStart, '/4/2[p1]/1:3', 'cfiStart 应是父路径 + start 尾部')
  assert.equal(highlight.cfiEnd, '/4/2[p1]/1:8', 'cfiEnd 应是父路径 + end 尾部')
  for (const [name, value] of [['cfiStart', highlight.cfiStart], ['cfiEnd', highlight.cfiEnd]]) {
    assert.match(value, /^\/[0-9]/, `${name} 必须以 /数字 开头`)
    assert.ok(!value.includes('!'), `${name} 不许含 !`)
    assert.ok(!value.startsWith('epubcfi('), `${name} 不许带外壳`)
  }
  assert.equal(highlight.textFingerprint.hash.length, 64)
  assert.match(highlight.id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(highlight.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(highlight.createdAt, highlight.updatedAt, '新建记录的 createdAt 应等于 updatedAt')

  // note：另外要求 note 正文非空
  throwsField(
    () => makeNote({ ...baseHighlight(), note: '' }),
    'note',
    'makeNote 空 note',
  )
  const note = makeNote({ ...baseHighlight({ color: 'blue' }), note: '这里和第三章对不上' })
  assert.deepEqual(validateRecord(note), { ok: true, errors: [] })

  // bookmark：**不需要** textExcerpt / textFingerprint（书签没有文字锚点）
  const bookmark = makeBookmark({
    cfi: 'epubcfi(/6/2[ch1]!/4/2[p1]/1:3)',
    chapterHref: 'text/ch1.xhtml',
    label: '读到一半',
    deviceId: DEVICE,
  })
  assert.deepEqual(validateRecord(bookmark), { ok: true, errors: [] })
  assert.equal(bookmark.textExcerpt, undefined, '书签不该凭空多出 textExcerpt')
  assert.equal(bookmark.cfiStart, '/4/2[p1]/1:3')
  throwsField(
    () => makeBookmark({ chapterHref: 'text/ch1.xhtml', deviceId: DEVICE }),
    'cfi',
    'makeBookmark 缺 cfi',
  )

  // qa：位置锚定必填，没锚定的回答不许落盘
  throwsField(
    () => makeQa({ cutoffCfi: CFI, question: 'q', answer: 'a', deviceId: DEVICE }),
    'anchorCfiRange',
    'makeQa 缺 anchorCfiRange',
  )
  const qa = makeQa({
    anchorCfiRange: CFI,
    cutoffCfi: CFI,
    question: '这一段什么意思？',
    answer: '意思是……',
    deviceId: DEVICE,
  })
  assert.deepEqual(validateRecord(qa), { ok: true, errors: [] })

  // quarantine：reason 必须是枚举值之一
  assert.throws(
    () => makeQuarantine({ reason: 'whatever', sourceDeviceId: DEVICE }),
    /reason/,
    '未定义的隔离原因必须拒绝',
  )
  const quarantine = makeQuarantine({
    reason: 'fingerprint_drift',
    sourceDeviceId: DEVICE,
    rawCfi: CFI,
    rawRecord: { id: 'x' },
  })
  assert.equal(quarantine.rawRecord, '{"id":"x"}', 'rawRecord 传对象时应序列化成字符串')
  assert.deepEqual(validateRecord(quarantine), { ok: true, errors: [] })
  assert.equal(QUARANTINE_REASONS.length, 10)
  assert.deepEqual(new Set(COLORS), new Set(['yellow', 'green', 'blue', 'pink', 'purple']))
}

/* ------------------------------------------------------------------ 指纹 */

function fingerprintShape() {
  // 空串：head/tail 都是空，len=0，hash 是 SHA-256 的空输入值
  const empty = fingerprint('')
  assert.deepEqual(empty, {
    head: '',
    tail: '',
    len: 0,
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  })

  // 中文：len 按 UTF-16 code unit 数（每个汉字 1）
  const cjk = fingerprint('中文测试标记位置')
  assert.equal(cjk.len, 8)
  assert.equal(cjk.head, '中文测试标记位置')
  assert.equal(cjk.tail, '中文测试标记位置', '短于 48 时 head 与 tail 重叠，这是允许的')

  // emoji：👨‍👩‍👧 = 8 个 code unit（4 个码点 + 2 个 ZWJ）
  const emoji = fingerprint('前👨‍👩‍👧后')
  assert.equal(emoji.len, 10, 'UTF-16 code unit 计数，不是码点数')
  assert.equal(emoji.head, '前👨‍👩‍👧后')
  assert.equal(emoji.hash.length, 64)

  // 长文本：head 取前 48、tail 取**最后** 32（docs/05 §4.2 特别强调过）
  const long = 'a'.repeat(48) + 'MIDDLE' + 'b'.repeat(32)
  const fp = fingerprint(long)
  assert.equal(fp.len, long.length)
  assert.equal(fp.head, 'a'.repeat(48))
  assert.equal(fp.tail, 'b'.repeat(32), 'tail 必须是最后 32 个 code unit，不是「除 head 外的 32 个」')
  assert.equal(fp.hash.length, 64)

  // 手算对照：hash 与已知 SHA-256 一致
  assert.equal(fingerprint('abc').hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

  assert.throws(() => fingerprint(null), /字符串/, '非字符串必须拒绝（不许 String(null) 糊过去）')
  assert.throws(() => fingerprint(123), /字符串/)
}

function fingerprintThreeStates() {
  const a = fingerprint('同一段文字')
  const b = fingerprint('同一段文字')
  assert.equal(compareFingerprint(a, b), 'ok', '全等应为 ok')

  // head/tail/len 同、hash 不同 → drifted（可渲染，降级提示）
  const drifted = { ...b, hash: 'f'.repeat(64) }
  assert.equal(compareFingerprint(a, drifted), 'drifted', 'hash 变但形状同 → drifted')

  // 长度变 → fail（进隔离）
  assert.equal(compareFingerprint(a, { ...b, len: b.len + 1 }), 'fail', 'len 不同 → fail')
  assert.equal(compareFingerprint(a, { ...b, head: '别的' }), 'fail', 'head 不同 → fail')
  assert.equal(compareFingerprint(a, { ...b, tail: '别的' }), 'fail', 'tail 不同 → fail')

  // 残缺 / 非对象一律 fail（不猜、不部分比对）
  assert.equal(compareFingerprint(a, null), 'fail')
  assert.equal(compareFingerprint(a, { head: 'x' }), 'fail')
  assert.equal(compareFingerprint({}, a), 'fail')
}

function excerptTruncation() {
  const short = truncateExcerpt('短')
  assert.deepEqual(short, { text: '短', truncated: false })

  const longText = 'x'.repeat(600)
  const cut = truncateExcerpt(longText)
  assert.equal(cut.truncated, true)
  assert.equal(Array.from(cut.text).length, 512, '截断按码点算，不是 code unit')

  // 512 上限对 emoji 安全：不会切出孤立代理项
  const emojiText = '👨‍👩‍👧'.repeat(200)
  const emojiCut = truncateExcerpt(emojiText)
  assert.equal(emojiCut.truncated, true)
  for (const ch of emojiCut.text) assert.ok(ch.codePointAt(0) > 0xffff || ch.length === 1)
  assert.equal(truncateExcerpt(longText, 10).text, 'x'.repeat(10))
}

/* ------------------------------------------------------------------- ULID */

function ulidMonotonic() {
  const seen = []
  const existing = new Set()
  for (let i = 0; i < 1000; i++) {
    const id = makeUlid()
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/, `第 ${i} 个 ULID 形状不对：${id}`)
    assert.ok(!existing.has(id), `第 ${i} 个 ULID 重复：${id}`)
    existing.add(id)
    if (seen.length > 0) {
      assert.ok(seen[seen.length - 1] < id, `第 ${i} 个 ULID 破坏字典序单调：${seen[seen.length - 1]} >= ${id}`)
    }
    seen.push(id)
  }

  // 固定时间：时间前缀必须确定（同一毫秒内靠随机部自增保证单调）
  const fixed = Date.UTC(2024, 0, 1, 0, 0, 0)
  const a = makeUlid(fixed)
  const b = makeUlid(fixed)
  assert.equal(a.slice(0, 10), b.slice(0, 10), '同一毫秒的时间前缀应相同')
  assert.ok(a < b, '同一毫秒内必须单调递增')

  // 时钟回拨：时间前缀不回退
  const later = makeUlid(fixed + 5000)
  const back = makeUlid(fixed + 1000)
  assert.ok(later < back, '时钟回拨后仍须保持字典序单调（沿用上次时间）')

  assert.throws(() => makeUlid(-1), /时间/)
  assert.throws(() => makeUlid(Number.NaN), /时间/)
}

/* -------------------------------------------------- validateRecord 的边界 */

function validateRecordBoundaries() {
  // 非对象
  assert.equal(validateRecord(null).ok, false)
  assert.equal(validateRecord([]).ok, false)
  assert.equal(validateRecord('x').ok, false)

  // 多余字段（additionalProperties: false）
  const extra = { ...makeHighlight(baseHighlight()), bogus: 1 }
  const extraResult = validateRecord(extra)
  assert.equal(extraResult.ok, false, '多余字段必须判非法')
  assert.ok(extraResult.errors.some(e => e.field === 'bogus'), '报错要点出多余字段')

  // 缺必填 give 出带路径的报错（docs/01 §2.9.1：报错必须能定位）
  const missing = { ...makeHighlight(baseHighlight()) }
  delete missing.textFingerprint
  const missingResult = validateRecord(missing)
  assert.equal(missingResult.ok, false)
  assert.ok(
    missingResult.errors.some(e => e.field === 'textFingerprint'),
    `报错应点名 textFingerprint，实际 ${JSON.stringify(missingResult.errors)}`,
  )
  assert.ok(
    !missingResult.errors.some(e => e.field === 'bookHash' || e.field === 'title'),
    '不许把 meta 分支的报错混进来（oneOf 的坑）',
  )

  // 枚举 / 正则
  assert.equal(validateRecord({ ...makeHighlight(baseHighlight()), color: 'red' }).ok, false)
  assert.equal(validateRecord({ ...makeHighlight(baseHighlight()), id: 'not-a-ulid' }).ok, false)
  assert.equal(
    validateRecord({ ...makeHighlight(baseHighlight()), createdAt: '2024-01-01T00:00:00Z' }).ok,
    false,
    '时间必须带毫秒与 Z',
  )

  // 指纹子字段的路径要完整
  const badFp = { ...makeHighlight(baseHighlight()) }
  badFp.textFingerprint = { ...badFp.textFingerprint, len: -1 }
  const badFpResult = validateRecord(badFp)
  assert.equal(badFpResult.ok, false)
  assert.ok(
    badFpResult.errors.some(e => e.field === 'textFingerprint.len'),
    `报错路径应是 textFingerprint.len，实际 ${JSON.stringify(badFpResult.errors)}`,
  )
}

export default async function run() {
  constructorsRequireFields()
  fingerprintShape()
  fingerprintThreeStates()
  excerptTruncation()
  ulidMonotonic()
  validateRecordBoundaries()
}
