/**
 * 数据契约：记录构造器 + 手写同构校验 + 文本指纹。
 *
 * 这个文件是 `schema/contract.schema.json` 的**手写同构版**：浏览器半不许引 ajv
 * （会打破零运行时依赖，也会把包体积翻倍），所以字段表在这里再写一遍。
 * `test/schema_parity_test.mjs` 用 ajv 跑同一批记录，两边判定必须完全一致——
 * 一旦这里漏了字段、写错枚举，那个测试就红。
 *
 * 依赖方向：contract → cfi（拆 CFI 前后段）、contract → sha256（算指纹）。
 * 不反向依赖，保证 build.mjs 的 sha256 → cfi → contract 顺序成立。
 *
 * 失败行为：构造器与 `makeUlid` 出错一律 **throw**（`name === 'ContractError'`），
 * 绝不返回「缺字段的降级记录」——铁律 5 的落地点。`validateRecord` 是判定函数，
 * 失败以 `{ ok:false, errors }` 返回，不抛。
 */

import { sha256Hex, utf8Bytes } from './sha256.js'
import { splitCfi, collapseLocal } from './cfi.js'

/** 契约版本号。所有记录的 `schema` 字段恒等于它。 */
export const SCHEMA = 'dsh-reading/1'

/** 五种划线颜色（与 schema 的 color enum 一字不差）。 */
export const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple']

/** 隔离原因枚举（与 schema 的 quarantine.reason 一字不差）。 */
export const QUARANTINE_REASONS = [
  'cfi_parse_failed',
  'cfi_resolve_failed',
  'cfi_range_inverted',
  'cfi_cross_document',
  'cfi_collapsed_highlight',
  'cfi_offset_out_of_bounds',
  'cfi_prefix_mismatch',
  'fingerprint_drift',
  'schema_invalid',
  'orphan_anchor',
]

/** 锚点状态（schema 的 anchorStatus enum）。 */
export const ANCHOR_STATUS = ['ok', 'repaired', 'drifted', 'quarantined']

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * 造一个契约错误。与 cfi.js 同款：只带自有属性，跨 iframe 传不丢。
 * @param {string} field 出问题的字段（或构造器名）
 * @param {string} message 给人看的说明
 */
function contractError(field, message, code = 'schema_invalid') {
  const error = new Error(`${field}: ${message}`)
  error.name = 'ContractError'
  error.code = code
  error.field = field
  return error
}


const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** JSON Schema 的 length 按 code point 数，不是 UTF-16 code unit 数。这里必须同口径。 */
const codePointLength = text => (typeof text === 'string' ? Array.from(text).length : -1)

/* --------------------------------------------------------------------- ULID */

let lastTime = -1
let lastRandom = null

const randomChars = (count) => {
  const out = new Array(count)
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = new Uint8Array(count)
    cryptoApi.getRandomValues(bytes)
    for (let i = 0; i < count; i++) out[i] = ULID_ALPHABET[bytes[i] % 32]
    return out
  }
  for (let i = 0; i < count; i++) {
    out[i] = ULID_ALPHABET[Math.floor(Math.random() * 32)]
  }
  return out
}

/** 在 base32 数字串上 +1（带进位），用于同毫秒内单调自增。 */
const incrementChars = (chars) => {
  const next = chars.slice()
  for (let i = next.length - 1; i >= 0; i--) {
    const at = ULID_ALPHABET.indexOf(next[i])
    if (at < 31) {
      next[i] = ULID_ALPHABET[at + 1]
      return next
    }
    next[i] = ULID_ALPHABET[0]
  }
  // 80 位随机部整圈回绕（概率 2^-80）：重新取随机，仍保持单调的「不同值」。
  return randomChars(chars.length)
}

const encodeTime = (ms) => {
  let rest = Math.max(0, Math.floor(ms))
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/**
 * 生成 26 位 ULID（Crockford Base32，字典序≈时间序）。
 *
 * 单调性：同一毫秒内自增随机部，所以连续调用不会出现「后生成的 ID 字典序更小」。
 * 时钟回拨时沿用上一次的时间部分，保证不倒退。
 *
 * @param {number|Date} [now] 时间源，默认 Date.now()；测试用固定值可复现时间前缀
 * @returns {string} 26 位，匹配 `^[0-9A-HJKMNP-TV-Z]{26}$`
 */
export function makeUlid(now) {
  const raw = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now())
  if (!Number.isFinite(raw) || raw < 0) {
    throw contractError('makeUlid', `时间必须是非负有限数，收到 ${String(now)}`)
  }
  const time = Math.floor(raw)
  if (time > lastTime) {
    lastTime = time
    lastRandom = randomChars(16)
  } else {
    // 同一毫秒（或时钟回拨）：时间部分不动，随机部 +1
    lastRandom = incrementChars(lastRandom ?? randomChars(16))
  }
  const id = encodeTime(lastTime) + lastRandom.join('')
  if (!ULID_RE.test(id)) {
    throw contractError('makeUlid', `生成的 ULID 不符合契约正则：${id}`)
  }
  return id
}

/* ------------------------------------------------------------------- 指纹 */

/**
 * 文本指纹（docs/05 §4.2，两端必须一字不差）。
 *
 *   head = 前 48 个 UTF-16 code unit
 *   tail = 后 32 个 UTF-16 code unit   ← 是「最后 32 个」，不是「除 head 外的后 32 个」
 *   len  = UTF-16 code unit 长度
 *   hash = sha256(UTF-8 字节) 的小写 hex
 *
 * 文本短于 48 时 head 与 tail 重叠，这是允许的（不要特判）。
 *
 * @param {string} text
 * @returns {{head:string, tail:string, len:number, hash:string}}
 */
export function fingerprint(text) {
  if (typeof text !== 'string') {
    throw contractError('fingerprint', '只接受字符串（正文是字符串；二进制请先解码）')
  }
  return {
    head: text.slice(0, 48),
    tail: text.slice(Math.max(0, text.length - 32)),
    len: text.length,
    hash: sha256Hex(utf8Bytes(text)),
  }
}

const fingerprintShapeOk = value => isObject(value)
  && typeof value.head === 'string'
  && typeof value.tail === 'string'
  && Number.isInteger(value.len)
  && typeof value.hash === 'string'

/**
 * 指纹三态比对（docs/05 §4.2）。
 *
 * | 条件 | 结果 |
 * |---|---|
 * | head/tail/len/hash 全等 | `ok` |
 * | head/tail/len 全等、hash 不等 | `drifted`（降级渲染，anchorStatus="drifted"） |
 * | 其余 | `fail` → 隔离，reason="fingerprint_drift" |
 *
 * 任一参数不是合法指纹 → `fail`（不猜、不部分比对）。
 *
 * @param {object} a 记录里的指纹
 * @param {object} b 现场算出的指纹
 * @returns {'ok'|'drifted'|'fail'}
 */
export function compareFingerprint(a, b) {
  if (!fingerprintShapeOk(a) || !fingerprintShapeOk(b)) return 'fail'
  if (a.head !== b.head || a.tail !== b.tail || a.len !== b.len) return 'fail'
  return a.hash === b.hash ? 'ok' : 'drifted'
}

/**
 * 把过长的摘录截到契约允许的长度，并告诉调用方是否截过。
 * 为什么提供它：`textExcerpt` 有 512 上限，但「截断」是展示层决定，
 * 不能由构造器偷偷做（那会让 L3 用一段被改过的文本算指纹）。
 *
 * @param {string} text 原文
 * @param {number} [max=512] 上限（code point）
 * @returns {{text:string, truncated:boolean}}
 */
export function truncateExcerpt(text, max = 512) {
  const source = typeof text === 'string' ? text : ''
  const chars = Array.from(source)
  if (chars.length <= max) return { text: source, truncated: false }
  return { text: chars.slice(0, max).join(''), truncated: true }
}

/* ------------------------------------------------------- 字段表（= schema） */

const P = {
  // 语义化类型：直接对应 schema 的 $defs，避免逐处重复写正则
  schema: { const: SCHEMA },
  ulid: { type: 'string', pattern: ULID_RE },
  deviceId: { type: 'string', pattern: /^[a-z0-9]{2,12}-[a-z0-9]{4,12}$/ },
  iso8601: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ },
  bookHash: { type: 'string', pattern: /^[0-9a-f]{64}$/ },
  color: { type: 'string', enum: COLORS },
  cfiFull: { type: 'string', pattern: /^epubcfi\(\s*\/.+!.+\s*\)$/ },
  cfiPartial: { type: 'string', pattern: /^\/[0-9]/ },
  anchorStatus: { type: 'string', enum: ANCHOR_STATUS },
  textFingerprint: {
    type: 'object',
    required: ['head', 'tail', 'len', 'hash'],
    closed: true,
    properties: {
      head: { type: 'string', maxLength: 48 },
      tail: { type: 'string', maxLength: 32 },
      len: { type: 'integer', minimum: 0 },
      hash: { type: 'string', pattern: /^[0-9a-f]{64}$/ },
    },
  },
}

const FORMATS = ['epub', 'mobi-converted', 'txt-converted']
const SOURCE_FORMATS = ['epub', 'mobi', 'azw3', 'txt']

/** 每个 $defs 分支的字段表。`closed: true` = additionalProperties:false。 */
const BRANCHES = {
  meta: {
    closed: true,
    required: ['schema', 'bookHash', 'title', 'format', 'converterVersion', 'spine', 'createdAt'],
    properties: {
      schema: P.schema,
      bookHash: P.bookHash,
      title: { type: 'string', minLength: 1 },
      author: { type: 'string' },
      language: { type: 'string' },
      format: { type: 'string', enum: FORMATS },
      sourceFormat: { type: 'string', enum: SOURCE_FORMATS },
      converterVersion: { type: 'string' },
      totalChars: { type: 'integer', minimum: 0 },
      chapterCount: { type: 'integer', minimum: 0 },
      toc: {
        type: 'array',
        items: {
          required: ['label', 'href'],
          properties: {
            label: { type: 'string' },
            href: { type: 'string' },
            depth: { type: 'integer', minimum: 0 },
          },
        },
      },
      fileSize: { type: 'integer', minimum: 0 },
      spine: {
        type: 'array',
        items: {
          required: ['index', 'href'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            href: { type: 'string' },
            idref: { type: 'string' },
            mediaType: { type: 'string' },
            linear: { type: 'boolean' },
          },
        },
      },
      createdAt: P.iso8601,
      updatedAt: P.iso8601,
      createdBy: P.deviceId,
      deviceId: P.deviceId,
      coverHref: { type: 'string' },
      // 0.4.0：下面三个字段由宿主写进 meta.json，客户端只读。
      // 枚举必须与 schema/contract.schema.json 逐字相同（多一个少一个，
      // schema_parity_test 就是红）——headings / split 也是真值：
      // TXT 识别到的真标题写 headings，按字数硬切写 split，都不许漏。
      tocSource: { type: 'string', enum: ['nav', 'ncx', 'spine', 'auto', 'headings', 'split', 'none'] },
      // 换/删一次封面 +1。客户端拿它拼封面 URL 的 `&v=`，否则换完封面还看旧图。
      coverVersion: { type: 'integer', minimum: 0 },
      coverMediaType: { type: 'string' },
    },
  },
  progress: {
    closed: true,
    required: ['schema', 'cfi', 'updatedAt', 'deviceId'],
    properties: {
      schema: P.schema,
      cfi: P.cfiFull,
      chapterHref: { type: 'string' },
      chapterProgression: { type: 'number', minimum: 0, maximum: 1 },
      bookProgression: { type: 'number', minimum: 0, maximum: 1 },
      updatedAt: P.iso8601,
      deviceId: P.deviceId,
    },
  },
  highlight: {
    closed: true,
    required: [
      'schema', 'id', 'type', 'cfi', 'cfiStart', 'cfiEnd', 'chapterHref',
      'textExcerpt', 'textFingerprint', 'color', 'createdAt', 'updatedAt', 'deviceId',
    ],
    properties: {
      schema: P.schema,
      id: P.ulid,
      type: { const: 'highlight' },
      cfi: P.cfiFull,
      cfiStart: P.cfiPartial,
      cfiEnd: P.cfiPartial,
      chapterHref: { type: 'string', minLength: 1 },
      textExcerpt: { type: 'string', maxLength: 512 },
      textExcerptTruncated: { type: 'boolean' },
      textFingerprint: P.textFingerprint,
      color: P.color,
      note: { type: 'string', maxLength: 8192 },
      createdAt: P.iso8601,
      updatedAt: P.iso8601,
      deviceId: P.deviceId,
      deleted: { type: 'boolean' },
      anchorStatus: P.anchorStatus,
    },
  },
  note: {
    closed: true,
    required: [
      'schema', 'id', 'type', 'cfi', 'cfiStart', 'cfiEnd', 'chapterHref',
      'textExcerpt', 'textFingerprint', 'createdAt', 'updatedAt', 'deviceId', 'color', 'note',
    ],
    properties: {
      schema: P.schema,
      id: P.ulid,
      type: { const: 'note' },
      cfi: P.cfiFull,
      cfiStart: P.cfiPartial,
      cfiEnd: P.cfiPartial,
      chapterHref: { type: 'string', minLength: 1 },
      textExcerpt: { type: 'string', maxLength: 512 },
      textFingerprint: P.textFingerprint,
      color: P.color,
      note: { type: 'string', minLength: 1, maxLength: 8192 },
      createdAt: P.iso8601,
      updatedAt: P.iso8601,
      deviceId: P.deviceId,
      deleted: { type: 'boolean' },
      anchorStatus: P.anchorStatus,
    },
  },
  bookmark: {
    closed: true,
    required: [
      'schema', 'id', 'type', 'cfi', 'cfiStart', 'chapterHref',
      'createdAt', 'updatedAt', 'deviceId',
    ],
    properties: {
      schema: P.schema,
      id: P.ulid,
      type: { const: 'bookmark' },
      cfi: P.cfiFull,
      cfiStart: P.cfiPartial,
      chapterHref: { type: 'string', minLength: 1 },
      label: { type: 'string', maxLength: 256 },
      createdAt: P.iso8601,
      updatedAt: P.iso8601,
      deviceId: P.deviceId,
      deleted: { type: 'boolean' },
    },
  },
  qa: {
    closed: true,
    required: [
      'schema', 'id', 'anchorCfiRange', 'question', 'answer', 'cutoffCfi',
      'createdAt', 'updatedAt', 'deviceId',
    ],
    properties: {
      schema: P.schema,
      id: P.ulid,
      type: { const: 'qa' },
      anchorCfiRange: P.cfiFull,
      anchorAnnotationId: P.ulid,
      question: { type: 'string', minLength: 1, maxLength: 4096 },
      answer: { type: 'string', minLength: 1 },
      contextExcerpt: { type: 'string', maxLength: 8192 },
      contextCfiRange: P.cfiFull,
      cutoffCfi: P.cfiFull,
      model: { type: 'string' },
      threadId: P.ulid,
      parentId: P.ulid,
      createdAt: P.iso8601,
      updatedAt: P.iso8601,
      deviceId: P.deviceId,
      deleted: { type: 'boolean' },
    },
  },
  quarantine: {
    closed: true,
    required: ['schema', 'id', 'reason', 'sourceDeviceId', 'ingestedAt'],
    properties: {
      schema: P.schema,
      id: P.ulid,
      type: { type: 'string' },
      reason: { type: 'string', enum: QUARANTINE_REASONS },
      rawCfi: { type: 'string' },
      rawRecord: { type: 'string' },
      sourceDeviceId: P.deviceId,
      ingestedAt: P.iso8601,
      repairable: { type: 'boolean' },
    },
  },
}

/* --------------------------------------------------------------- 字段校验 */

/**
 * 校验单个字段值，返回错误消息数组（空数组 = 通过）。
 * 语义按 JSON Schema 2020-12：length 用 code point，integer 不含小数。
 */
function checkValue(spec, value, path, errors) {
  if (value === undefined) return
  const type = spec.type
  if (spec.const !== undefined) {
    if (value !== spec.const) {
      errors.push({ field: path, message: `必须恒等于 ${JSON.stringify(spec.const)}` })
      return
    }
    return
  }
  if (spec.enum) {
    if (typeof value !== 'string' || !spec.enum.includes(value)) {
      errors.push({ field: path, message: `必须是 ${spec.enum.join(' / ')} 之一` })
      return
    }
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ field: path, message: '必须是字符串' })
      return
    }
    const len = codePointLength(value)
    if (spec.minLength != null && len < spec.minLength) {
      errors.push({ field: path, message: `至少 ${spec.minLength} 个字符，实际 ${len}` })
    }
    if (spec.maxLength != null && len > spec.maxLength) {
      errors.push({ field: path, message: `最多 ${spec.maxLength} 个字符，实际 ${len}` })
    }
    if (spec.pattern && !spec.pattern.test(value)) {
      errors.push({ field: path, message: `不符合格式 ${String(spec.pattern)}` })
    }
    return
  }
  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ field: path, message: '必须是有限数字' })
      return
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      errors.push({ field: path, message: '必须是整数' })
      return
    }
    if (spec.minimum != null && value < spec.minimum) {
      errors.push({ field: path, message: `不得小于 ${spec.minimum}` })
    }
    if (spec.maximum != null && value > spec.maximum) {
      errors.push({ field: path, message: `不得大于 ${spec.maximum}` })
    }
    return
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push({ field: path, message: '必须是 true/false' })
    return
  }
  if (type === 'object') {
    if (!isObject(value)) {
      errors.push({ field: path, message: '必须是对象' })
      return
    }
    checkObject(spec, value, path, errors)
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ field: path, message: '必须是数组' })
      return
    }
    if (spec.items) {
      value.forEach((item, i) => {
        const itemPath = `${path}[${i}]`
        if (spec.items.required || spec.items.properties) {
          if (!isObject(item)) {
            errors.push({ field: itemPath, message: '必须是对象' })
            return
          }
          checkObject(spec.items, item, itemPath, errors)
        } else {
          checkValue(spec.items, item, itemPath, errors)
        }
      })
    }
  }
}

function checkObject(spec, value, path, errors) {
  const properties = spec.properties ?? {}
  for (const key of spec.required ?? []) {
    if (value[key] === undefined) {
      errors.push({ field: path ? `${path}.${key}` : key, message: '缺少必填字段' })
    }
  }
  for (const key of Object.keys(value)) {
    const fieldPath = path ? `${path}.${key}` : key
    const property = properties[key]
    if (!property) {
      if (spec.closed) errors.push({ field: fieldPath, message: 'schema 里没有这个字段' })
      continue
    }
    checkValue(property, value[key], fieldPath, errors)
  }
}

/**
 * 按 `type` 选分支。
 *
 * 为什么不能直接跑顶层 oneOf：docs/01 §2.9.1 实测过，ajv 的 oneOf 报错会把 7 个分支的
 * 缺失字段全倒出来，用户看到的第一条往往是无关的 `bookHash`。这里先定位分支，只报该分支的错。
 *
 * 为什么 quarantine 先认结构不认 type：quarantine 的 `type` 是**自由字符串**（记录原始类型），
 * 它可能恰好等于 "highlight"。此时若按 type 分发会误判到 highlight 分支。
 */
function pickBranch(record) {
  const has = key => Object.prototype.hasOwnProperty.call(record, key)
  if (has('reason') && has('ingestedAt')) return 'quarantine'
  const type = record.type
  if (type === 'highlight' || type === 'note' || type === 'bookmark' || type === 'qa') return type
  if (has('bookHash') || has('title') || has('spine') || has('format') || has('converterVersion')) {
    return 'meta'
  }
  if (has('cfi') || has('chapterProgression') || has('bookProgression') || has('updatedAt')) {
    return 'progress'
  }
  return null
}

/**
 * 校验一条记录。
 *
 * @param {unknown} record
 * @returns {{ok:boolean, errors:Array<{field:string,message:string}>}}
 *   失败时 `errors` 至少一条，`field` 带完整路径（`textFingerprint.len` 这种），
 *   供同步排障时一眼定位。
 */
export function validateRecord(record) {
  if (!isObject(record)) {
    return { ok: false, errors: [{ field: '', message: '记录必须是对象' }] }
  }
  const branch = pickBranch(record)
  if (!branch) {
    return {
      ok: false,
      errors: [{ field: 'type', message: '无法判断记录类型：既没有 type，也不像 meta/progress/quarantine' }],
    }
  }
  const errors = []
  checkObject(BRANCHES[branch], record, '', errors)
  return { ok: errors.length === 0, errors }
}

/* --------------------------------------------------------------- 构造器 */

const nowIso = () => new Date().toISOString()

const requireString = (fields, name, options = {}) => {
  const value = fields?.[name]
  if (typeof value !== 'string' || value === '') {
    throw contractError(name, `${options.label ?? name} 是必填字段，缺失或为空串时拒绝构造记录`)
  }
  return value
}

const requireFingerprint = (fields) => {
  const value = fields?.textFingerprint
  if (!fingerprintShapeOk(value)) {
    throw contractError(
      'textFingerprint',
      '指纹是必填字段（L3 校验的唯一输入）。先对 textExcerpt 调 fingerprint()，不要传 null',
    )
  }
  return value
}

/**
 * 通用信封（docs/05 §4.3）：id / createdAt / updatedAt / deviceId / schema 五件套。
 *
 * `type` 为 null 时（meta / progress / quarantine）不写该字段——它们不在 schema 的
 * properties 里，多写一个键会被 additionalProperties:false 判非法。
 *
 * @param {string|null} type
 * @param {object} fields
 * @returns {object}
 */
export function makeRecord(type, fields) {
  if (!isObject(fields)) {
    throw contractError('makeRecord', '第二个参数必须是字段对象')
  }
  const now = nowIso()
  return {
    schema: SCHEMA,
    ...(type ? { type } : {}),
    ...fields,
    id: fields.id ?? makeUlid(),
    createdAt: fields.createdAt ?? now,
    updatedAt: fields.updatedAt ?? now,
  }
}

/** 高亮 / 笔记共用的字段装配（两者只差 note 必填）。 */
function makeTextAnchorRecord(type, fields) {
  const cfi = requireString(fields, 'cfi', { label: 'CFI 区间' })
  const chapterHref = requireString(fields, 'chapterHref', { label: '章节 href' })
  const textExcerpt = requireString(fields, 'textExcerpt', { label: 'textExcerpt（L3 校验的原文）' })
  const textFingerprint = requireFingerprint(fields)
  const color = requireString(fields, 'color', { label: '划线颜色' })
  const { local } = splitCfi(cfi)
  if (!local.includes(',')) {
    throw contractError(
      'cfi',
      'highlight/note 的 CFI 必须是区间形态（parent,start,end）。零宽锚点会在渲染时变成看不见的高亮',
      'cfi_collapsed_highlight',
    )
  }
  // cfiStart / cfiEnd 是「这一端的位置」，形态与 vendor collapse() 一致：
  //   epubcfi(/6/4[ch1]!/4/2[p1],/1:3,/1:8) → "/4/2[p1]/1:3" 与 "/4/2[p1]/1:8"
  // 单独拿去解析也指向正确字符，进度恢复才不会退化成整段。
  const cfiStart = collapseLocal(cfi, false)
  const cfiEnd = collapseLocal(cfi, true)
  const record = {
    schema: SCHEMA,
    type,
    id: fields.id ?? makeUlid(),
    cfi,
    cfiStart,
    cfiEnd,
    chapterHref,
    textExcerpt,
    ...(type === 'highlight' && fields.textExcerptTruncated !== undefined
      ? { textExcerptTruncated: fields.textExcerptTruncated }
      : {}),
    textFingerprint,
    color,
  }
  if (fields.note !== undefined) record.note = fields.note
  if (fields.anchorStatus !== undefined) record.anchorStatus = fields.anchorStatus
  if (fields.deleted !== undefined) record.deleted = fields.deleted
  const now = nowIso()
  record.createdAt = fields.createdAt ?? now
  record.updatedAt = fields.updatedAt ?? now
  record.deviceId = requireString(fields, 'deviceId', { label: 'deviceId（宿主 device.info 给的）' })
  return record
}

/**
 * 造一条高亮记录。
 *
 * 必填：`cfi`（区间形态）、`chapterHref`、`textExcerpt`、`textFingerprint`、`color`、`deviceId`。
 * 缺任一 → **throw**（`ContractError`），不返回降级记录：没有指纹就没法做 L3，
 * 没有摘录就没法在指纹失效时给人看。这条来自铁律 5 / docs/03 §三。
 *
 * @param {object} fields
 * @returns {object} 通过 `validateRecord` 的记录
 */
export function makeHighlight(fields) {
  const record = makeTextAnchorRecord('highlight', fields)
  return record
}

/**
 * 造一条笔记记录。必填项同 highlight，另外 `note` 不得为空串。
 * 失败抛 `ContractError`。
 *
 * @param {object} fields
 * @returns {object}
 */
export function makeNote(fields) {
  const note = requireString(fields, 'note', { label: 'note 正文' })
  const record = makeTextAnchorRecord('note', fields)
  record.note = note
  return record
}

/**
 * 造一条书签。
 *
 * 书签是**点锚点**：只要求 `cfi` 是单路径（无逗号），schema 里也只有 `cfiStart`、没有 `cfiEnd`。
 * 传区间 CFI 会取 start 端（书签语义就是「跳到这里」）。
 * 失败（缺 cfi/chapterHref/deviceId、CFI 不是完整 CFI）抛 `ContractError`。
 *
 * @param {object} fields
 * @returns {object}
 */
export function makeBookmark(fields) {
  const cfi = requireString(fields, 'cfi', { label: '书签 CFI' })
  const chapterHref = requireString(fields, 'chapterHref', { label: '章节 href' })
  // 书签是点锚点；传区间时取它的起点（书签语义就是「跳到这里」）。
  const cfiStart = collapseLocal(cfi, false)
  const record = {
    schema: SCHEMA,
    type: 'bookmark',
    id: fields.id ?? makeUlid(),
    cfi,
    cfiStart,
    chapterHref,
    ...(fields.label !== undefined ? { label: fields.label } : {}),
    createdAt: fields.createdAt ?? nowIso(),
    updatedAt: fields.updatedAt ?? nowIso(),
    deviceId: requireString(fields, 'deviceId', { label: 'deviceId（宿主 device.info 给的）' }),
  }
  if (fields.deleted !== undefined) record.deleted = fields.deleted
  return record
}

/**
 * 造一条 AI 问答记录。`anchorCfiRange` / `cutoffCfi` / `question` / `answer` 全为必填：
 * 没有位置锚定的回答不许落盘（契约 §qa 的 description）。
 * 失败抛 `ContractError`。
 *
 * @param {object} fields
 * @returns {object}
 */
export function makeQa(fields) {
  const anchorCfiRange = requireString(fields, 'anchorCfiRange', { label: 'anchorCfiRange' })
  const cutoffCfi = requireString(fields, 'cutoffCfi', { label: 'cutoffCfi' })
  const question = requireString(fields, 'question', { label: 'question' })
  const answer = requireString(fields, 'answer', { label: 'answer' })
  splitCfi(anchorCfiRange)
  splitCfi(cutoffCfi)
  const record = {
    schema: SCHEMA,
    type: 'qa',
    id: fields.id ?? makeUlid(),
    anchorCfiRange,
    question,
    answer,
    cutoffCfi,
  }
  for (const key of ['anchorAnnotationId', 'contextExcerpt', 'contextCfiRange', 'model', 'threadId', 'parentId']) {
    if (fields[key] !== undefined) record[key] = fields[key]
  }
  if (fields.deleted !== undefined) record.deleted = fields.deleted
  record.createdAt = fields.createdAt ?? nowIso()
  record.updatedAt = fields.updatedAt ?? nowIso()
  record.deviceId = requireString(fields, 'deviceId', { label: 'deviceId（宿主 device.info 给的）' })
  return record
}

/**
 * 造一条隔离记录（只写不读，等以后能修）。
 *
 * `reason` 必须是 10 个枚举值之一，`sourceDeviceId` 是**原记录**的设备 id
 * （不是本机的——隔离舱要留给跨设备排障用）。`ingestedAt` 默认取当前时间。
 * 失败抛 `ContractError`。
 *
 * @param {object} fields
 * @returns {object}
 */
export function makeQuarantine(fields) {
  const reason = fields?.reason
  if (typeof reason !== 'string' || !QUARANTINE_REASONS.includes(reason)) {
    throw contractError('reason', `必须是 ${QUARANTINE_REASONS.join(' / ')} 之一`)
  }
  const sourceDeviceId = requireString(fields, 'sourceDeviceId', { label: 'sourceDeviceId（原记录的设备 id）' })
  const record = {
    schema: SCHEMA,
    id: fields.id ?? makeUlid(),
    reason,
    sourceDeviceId,
    ingestedAt: fields.ingestedAt ?? nowIso(),
  }
  if (fields.type !== undefined) record.type = fields.type
  if (fields.rawCfi !== undefined) record.rawCfi = fields.rawCfi
  if (fields.rawRecord !== undefined) {
    record.rawRecord = typeof fields.rawRecord === 'string'
      ? fields.rawRecord
      : JSON.stringify(fields.rawRecord)
  }
  if (fields.repairable !== undefined) record.repairable = fields.repairable
  return record
}
