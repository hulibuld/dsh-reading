/**
 * pdftext.js —— PDF 内容流里的「字」怎么读出来。
 *
 * 这一层不碰文档结构（交叉引用表、页面树那些在 pdf.js），只做三件事：
 *
 *   1. **字体编码**：PDF 里 `Tj` 后面那串字节不是文字，是**字形编号**。
 *      Type0 / Identity-H 的中文 PDF，`<0001>` 可能是「第」也可能是任意形近字，
 *      必须靠字体字典里的 `/ToUnicode` 映射表才能还原。没有这张表的 CJK 字体，
 *      我们选择**不猜**：字符记成缺失，页面字数不够就判定「提取不到文字」。
 *   2. **排版还原**：内容流里没有「换行」这种东西，只有一串绝对坐标。
 *      这里按文字矩阵的 y 变化判换行、按 x 间距补空格，把一串位置还原成行。
 *   3. **段落**：行再按「上一行有没有把话说完」合成段落——宁可多分几段，
 *      也不要把两章的话粘成一段。
 *
 * 取舍写在 docs/11-格式支持-PDF.md：我们做的是**可读的重排**，不是版式还原。
 * 表格、分栏、图片、公式一律退化成「按阅读顺序排下来的文字」。
 */

/** 递归进入 Form XObject 的最大层数（个别 PDF 会套娃，套太深必然有环）。 */
const MAX_FORM_DEPTH = 6

/** 一次 Tj 最多吃多少字节，防畸形文件把内存吃光。 */
const MAX_STRING_BYTES = 1 << 20

/**
 * WinAnsiEncoding 与 latin1 的差异段（0x80–0x9F）。
 * 这一段是「看起来能读、其实是乱码」的重灾区：0x92 是右弯引号，不是控制字符。
 */
const WIN_ANSI_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

/**
 * 常见字形名 → Unicode。只收印刷体里高频的那些 + 标点，
 * 认不出来的一律留空（见文件头「不猜」原则）。
 */
const GLYPH_NAMES = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1',
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', quoteleft: '‘', quoteright: '’',
  quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', dagger: '†', daggerdbl: '‡',
  perthousand: '‰', guilsinglleft: '‹', guilsinglright: '›', guillemotleft: '«',
  guillemotright: '»', florin: 'ƒ', Euro: '€', trademark: '™', copyright: '©',
  registered: '®', degree: '°', section: '§', paragraph: '¶', periodcentered: '·',
  middot: '·', plusminus: '±', multiply: '×', divide: '÷', fraction: '⁄',
  cwm: '', ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl',
  nbspace: ' ', sfthyphen: '­', hyphensoft: '',
}

/** 名字里 `uni4E2D` / `u4E2D` 这种直接写码点的形式，实际文件里非常多。 */
function glyphNameToUnicode(rawName) {
  const name = String(rawName ?? '')
  if (name === '') return ''
  if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, name)) return GLYPH_NAMES[name]
  let match = /^uni([0-9A-Fa-f]{4,6})$/.exec(name)
  if (match) {
    const code = Number.parseInt(match[1], 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  }
  match = /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (match) {
    const code = Number.parseInt(match[1], 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  }
  // `Aacute` 这种带重音的拉丁字母不在表里，留空比猜成 `A` 更安全。
  return ''
}

/** 16 进制字符串 → UTF-16BE 解码（Node 只有 utf16le，所以要换字节序）。 */
function hexToText(hex) {
  const clean = String(hex ?? '').replace(/[^0-9A-Fa-f]/g, '')
  if (clean === '') return ''
  const even = clean.length % 2 === 0 ? clean : `${clean}0`
  const bytes = Buffer.from(even, 'hex')
  if (bytes.length % 2 !== 0) return bytes.toString('latin1')
  const swapped = Buffer.from(bytes)
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const tmp = swapped[i]
    swapped[i] = swapped[i + 1]
    swapped[i + 1] = tmp
  }
  return swapped.toString('utf16le')
}

/**
 * 解析 `/ToUnicode` CMap：`beginbfchar` / `beginbfrange` 两种块。
 *
 * @param {Buffer} bytes
 * @returns {Map<number, string>} 字形码 → 文字
 */
export function parseToUnicode(bytes) {
  const map = new Map()
  if (!bytes || bytes.length === 0) return map
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes)

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const body = block[1] ?? ''
    const pairPattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g
    let match = pairPattern.exec(body)
    while (match !== null) {
      const code = Number.parseInt(match[1], 16)
      const value = hexToText(match[2])
      if (Number.isFinite(code) && value !== '') map.set(code, value)
      match = pairPattern.exec(body)
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? ''
    // 两种形式：`<lo> <hi> <dst>`（递增）与 `<lo> <hi> [ <d1> <d2> … ]`
    const rangePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g
    let match = rangePattern.exec(body)
    while (match !== null) {
      const low = Number.parseInt(match[1], 16)
      const high = Number.parseInt(match[2], 16)
      const span = Math.max(0, Math.min(high - low, 0xffff))
      if (Number.isFinite(low) && span >= 0) {
        if (match[3] !== undefined && match[3].startsWith('<')) {
          const baseHex = match[4] ?? ''
          const clean = baseHex.replace(/[^0-9A-Fa-f]/g, '')
          // 逐码递增：只动最后一个 UTF-16 码元，这是 CMap 规范要求的做法。
          const peeled = clean.length >= 4 ? clean.slice(0, clean.length - 4) : ''
          const tail = clean.length >= 4 ? Number.parseInt(clean.slice(-4), 16) : Number.NaN
          for (let offset = 0; offset <= span; offset += 1) {
            if (!Number.isFinite(tail)) break
            const code = tail + offset
            if (code > 0xffff) break
            const value = hexToText(`${peeled}${code.toString(16).padStart(4, '0')}`)
            if (value !== '') map.set(low + offset, value)
          }
        } else {
          const listText = match[5] ?? ''
          const items = [...listText.matchAll(/<([0-9A-Fa-f]*)>/g)].map((item) => hexToText(item[1]))
          for (let offset = 0; offset <= span && offset < items.length; offset += 1) {
            if (items[offset] !== '') map.set(low + offset, items[offset])
          }
        }
      }
      match = rangePattern.exec(body)
    }
  }

  return map
}

/** 从文字矩阵里取 x / y（PDF 的 `Tm` 是 [a b c d e f]）。 */
function matrixAt(matrix) {
  return { x: matrix[4] ?? 0, y: matrix[5] ?? 0 }
}

function nameValueOf(value) {
  return value && value.t === 'name' ? value.v : ''
}

/**
 * 把字体字典变成一个「字节 → 文字」的翻译器。
 *
 * @param {object} doc 文档对象（提供 resolve / stream）
 * @param {any} fontValue 字体字典或其引用
 */
export function buildFont(doc, fontValue) {
  const font = doc.resolve(fontValue)
  const fallback = {
    codeLength: 1,
    map: null,
    differences: null,
    encoding: 'winansi',
    usable: false,
  }
  if (!font || typeof font.get !== 'function') return fallback

  const subtype = nameValueOf(doc.resolve(font.get('Subtype')))
  const result = {
    // Type0（CID 字体）几乎都是两字节码；简单字体一律单字节。
    codeLength: subtype === 'Type0' ? 2 : 1,
    map: null,
    differences: null,
    encoding: 'winansi',
    usable: false,
  }

  const toUnicodeRef = font.get('ToUnicode')
  if (toUnicodeRef) {
    try {
      const cmapBytes = doc.stream(toUnicodeRef)
      if (cmapBytes) {
        const parsed = parseToUnicode(cmapBytes)
        if (parsed.size > 0) {
          result.map = parsed
          result.usable = true
        }
      }
    } catch {
      // ToUnicode 坏了不该让整页失败：退回按单字节基本编码读，读出来是乱码
      // 也仍比让用户看到「整本打不开」好，且字数闸门会兜住。
    }
  }

  const encoding = doc.resolve(font.get('Encoding'))
  if (encoding && encoding.t === 'name') {
    const name = encoding.v
    if (name === 'Identity-H' || name === 'Identity-V') result.codeLength = 2
    else if (name === 'MacRomanEncoding') result.encoding = 'macroman'
  } else if (encoding && typeof encoding.get === 'function') {
    const base = nameValueOf(doc.resolve(encoding.get('BaseEncoding')))
    if (base === 'MacRomanEncoding') result.encoding = 'macroman'
    const differences = doc.resolve(encoding.get('Differences'))
    if (Array.isArray(differences)) {
      /** @type {Map<number, string>} */
      const table = new Map()
      let code = 0
      for (const item of differences) {
        const resolved = doc.resolve(item)
        if (typeof resolved === 'number') {
          code = resolved
        } else if (resolved && resolved.t === 'name') {
          const text = glyphNameToUnicode(resolved.v)
          if (text !== '') table.set(code, text)
          code += 1
        }
      }
      if (table.size > 0) {
        result.differences = table
        result.usable = true
      }
    }
  }

  // 简单字体就算没有 ToUnicode 也能按 WinAnsi 读个大概（英文 PDF 的常态）。
  if (result.codeLength === 1) result.usable = true
  return result
}

/** 单字节按 WinAnsi / MacRoman 近似成文字。 */
function decodeSingleByte(byte, encoding) {
  if (encoding === 'macroman') {
    // MacRoman 的 0x80 以上与 latin1 不同；只补最常用的引号与破折号。
    if (byte === 0xd2 || byte === 0xd3) return '“'
    if (byte === 0xd4 || byte === 0xd5) return '”'
    if (byte === 0xd0) return '–'
    if (byte === 0xd1) return '—'
    if (byte === 0xc9) return '…'
    return String.fromCharCode(byte)
  }
  if (Object.prototype.hasOwnProperty.call(WIN_ANSI_HIGH, byte)) return WIN_ANSI_HIGH[byte]
  return String.fromCharCode(byte)
}

/**
 * 把一段 `Tj` 字节翻译成文字。
 *
 * @returns {{ text: string, unmapped: number }}
 */
export function decodeTextBytes(font, bytes) {
  if (!bytes || bytes.length === 0) return { text: '', unmapped: 0 }
  let text = ''
  let unmapped = 0

  if (font && font.codeLength === 2) {
    const map = font.map
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1]
      const mapped = map ? map.get(code) : undefined
      if (mapped !== undefined) {
        text += mapped
      } else {
        unmapped += 1
      }
    }
    return { text, unmapped }
  }

  // 有一批国产 PDF 工具图省事：字体声明成 WinAnsi（单字节），却把 UTF-8 字节直接写进
  // `Tj`。按 latin1 逐字节翻，屏幕上就是一串带重音的鬼字。这里先按 UTF-8 试一次：
  // 解得开、且有汉字，就用它——比要求用户重制文件现实得多。
  const richFont = font && (
    (font.map && font.map.size > 0) ||
    (font.differences && font.differences.size > 0)
  )
  if (!richFont && bytes.some((byte) => byte >= 0x80)) {
    const utf8 = Buffer.from(bytes).toString('utf8')
    if (!utf8.includes('\uFFFD') && /[\u3400-\u9fff]/.test(utf8)) {
      return { text: utf8, unmapped: 0 }
    }
  }

  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]
    const viaDifference = font && font.differences ? font.differences.get(byte) : undefined
    if (viaDifference !== undefined) {
      text += viaDifference
      continue
    }
    const viaMap = font && font.map ? font.map.get(byte) : undefined
    if (viaMap !== undefined) {
      text += viaMap
      continue
    }
    if (font && font.map && font.map.size > 0) {
      // 有映射表却查不到：不拿 latin1 硬凑，否则屏幕上会是乱码。
      unmapped += 1
      continue
    }
    text += decodeSingleByte(byte, font ? font.encoding : 'winansi')
  }
  return { text, unmapped }
}

/* ------------------------------------------------------------------ *
 * 内容流词法 / 语法
 * ------------------------------------------------------------------ */

function isWhite(byte) {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20
}

function isDelimiter(byte) {
  return (
    byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b ||
    byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25
  )
}

function skipFs(bytes, pos) {
  let i = pos
  while (i < bytes.length) {
    const byte = bytes[i]
    if (isWhite(byte)) {
      i += 1
      continue
    }
    if (byte === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1
      continue
    }
    break
  }
  return i
}

/** 字面量字符串 `( … )`，处理转义与嵌套括号。 */
function readLiteralString(bytes, pos) {
  let depth = 0
  let i = pos
  const out = []
  while (i < bytes.length) {
    const byte = bytes[i]
    if (byte === 0x5c) {
      i += 1
      const next = bytes[i]
      if (next === undefined) break
      switch (next) {
        case 0x6e: out.push(0x0a); i += 1; break
        case 0x72: out.push(0x0d); i += 1; break
        case 0x74: out.push(0x09); i += 1; break
        case 0x62: out.push(0x08); i += 1; break
        case 0x66: out.push(0x0c); i += 1; break
        case 0x28: out.push(0x28); i += 1; break
        case 0x29: out.push(0x29); i += 1; break
        case 0x5c: out.push(0x5c); i += 1; break
        default:
          if (next >= 0x30 && next <= 0x37) {
            // 八进制最多三位
            let value = 0
            let count = 0
            while (count < 3 && bytes[i] >= 0x30 && bytes[i] <= 0x37) {
              value = value * 8 + (bytes[i] - 0x30)
              i += 1
              count += 1
            }
            out.push(value & 0xff)
          } else {
            out.push(next)
            i += 1
          }
      }
      continue
    }
    if (byte === 0x28) {
      depth += 1
      // 最外层那个 `(` 是分隔符，不算正文；嵌套的 `(` 才是内容
      if (depth > 1) out.push(byte)
      i += 1
      continue
    }
    if (byte === 0x29) {
      depth -= 1
      if (depth <= 0) return { value: Buffer.from(out), next: i + 1 }
      out.push(byte)
      i += 1
      continue
    }
    if (depth <= 0) {
      // 开头的 `(` 已经把 depth 顶到 1，走到这里说明括号没配平：当字符串结束。
      return { value: Buffer.from(out), next: i }
    }
    out.push(byte)
    i += 1
    if (out.length > MAX_STRING_BYTES) break
  }
  return { value: Buffer.from(out), next: i }
}

function readHexString(bytes, pos) {
  let i = pos
  let hex = ''
  while (i < bytes.length) {
    const byte = bytes[i]
    if (byte === 0x3e) {
      i += 1
      break
    }
    const char = String.fromCharCode(byte)
    if (/[0-9A-Fa-f]/.test(char)) hex += char
    i += 1
    if (hex.length > MAX_STRING_BYTES * 2) break
  }
  if (hex.length % 2 === 1) hex += '0'
  return { value: Buffer.from(hex, 'hex'), next: i }
}

function readName(bytes, pos) {
  let i = pos + 1
  let raw = ''
  while (i < bytes.length) {
    const byte = bytes[i]
    if (isWhite(byte) || isDelimiter(byte)) break
    if (byte === 0x23 && i + 2 < bytes.length) {
      const hex = bytes.subarray(i + 1, i + 3).toString('latin1')
      const code = Number.parseInt(hex, 16)
      raw += Number.isFinite(code) ? String.fromCharCode(code) : '#'
      i += 3
      continue
    }
    raw += String.fromCharCode(byte)
    i += 1
  }
  return { value: { t: 'name', v: raw }, next: i }
}

function readNumber(bytes, pos) {
  let i = pos
  let raw = ''
  while (i < bytes.length) {
    const byte = bytes[i]
    const char = String.fromCharCode(byte)
    if (/[0-9+\-.]/.test(char)) {
      raw += char
      i += 1
      continue
    }
    break
  }
  if (raw === '' || raw === '-' || raw === '+' || raw === '.') return { value: null, next: pos }
  const value = Number(raw)
  return { value: Number.isFinite(value) ? value : null, next: i }
}

function readKeyword(bytes, pos) {
  let i = pos
  let raw = ''
  while (i < bytes.length) {
    const byte = bytes[i]
    if (isWhite(byte) || isDelimiter(byte)) break
    raw += String.fromCharCode(byte)
    i += 1
  }
  return { value: raw, next: i }
}

/**
 * 内容流取下一个 token。
 *
 * 返回 `{ t, v }`，`t` ∈ num | str | name | arr | op | eof。
 * 内联图像（`BI … ID … EI`）在这里整体跳过：我们不要图，只要字。
 */
function nextToken(bytes, pos) {
  let i = skipFs(bytes, pos)
  if (i >= bytes.length) return { t: 'eof', v: null, next: i }
  const byte = bytes[i]

  if (byte === 0x28) {
    // 注意：这里要把「开头这个 (」也交给 readLiteralString——它靠数括号定深度，
    // 传 i+1 会让 depth 从头就是 0，于是第一个非括号字符就被判成「括号没配平」，
    // 字符串立刻截断，剩下的 `)` 又没人消费，解析循环原地打转。
    const read = readLiteralString(bytes, i)
    return { t: 'str', v: read.value, next: read.next }
  }
  if (byte === 0x3c) {
    if (bytes[i + 1] === 0x3c) {
      // 内联图像字典不解析，直接当操作符交给上层跳过
      return { t: 'op', v: '<<', next: i + 2 }
    }
    const read = readHexString(bytes, i + 1)
    return { t: 'str', v: read.value, next: read.next }
  }
  if (byte === 0x2f) {
    const read = readName(bytes, i)
    return { t: 'name', v: read.value.v, next: read.next }
  }
  if (byte === 0x5b) {
    // 数组：TJ 的操作数，里面的数字是字距微调
    const items = []
    let cursor = i + 1
    for (;;) {
      const inner = nextToken(bytes, cursor)
      if (inner.t === 'eof') return { t: 'arr', v: items, next: inner.next }
      if (inner.t === 'op' && inner.v === ']') return { t: 'arr', v: items, next: inner.next }
      if (inner.t === 'op' && inner.v === '[') return { t: 'arr', v: items, next: inner.next }
      items.push(inner)
      cursor = inner.next
      if (items.length > 4096) return { t: 'arr', v: items, next: cursor }
    }
  }
  if (byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x3e) {
    return { t: 'op', v: String.fromCharCode(byte), next: i + 1 }
  }
  if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
    const read = readNumber(bytes, i)
    if (read.value === null) {
      const keyword = readKeyword(bytes, i)
      return { t: 'op', v: keyword.value, next: keyword.next }
    }
    return { t: 'num', v: read.value, next: read.next }
  }

  const keyword = readKeyword(bytes, i)
  return { t: 'op', v: keyword.value, next: keyword.next }
}

/** 内联图像：从 `BI` 之后扫到 `EI`（ID 后是二进制数据，不能按 token 走）。 */
function skipInlineImage(bytes, pos) {
  const marker = bytes.subarray(pos, Math.min(pos + 64, bytes.length)).toString('latin1')
  const idAt = marker.indexOf('ID')
  if (idAt === -1) return bytes.length
  let i = pos + idAt + 2
  // ID 之后必须有一个空白，真正数据从一个字节之后开始
  i = Math.min(i + 1, bytes.length)
  while (i < bytes.length - 1) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x49) {
      const before = i === 0 ? 0x20 : bytes[i - 1]
      const after = i + 2 < bytes.length ? bytes[i + 2] : 0x20
      if (isWhite(before) && (isWhite(after) || after === 0x51)) return i + 2
    }
    i += 1
  }
  return bytes.length
}

/* ------------------------------------------------------------------ *
 * 文本状态机
 * ------------------------------------------------------------------ */

function makeState() {
  return {
    /** 累积的字符（含 \n） */
    text: '',
    /** 因为字体没有映射而丢掉的字形数 */
    unmapped: 0,
    /** 成功读出的字符数（不含空白） */
    chars: 0,
    lastX: null,
    lastY: null,
    fontSize: 12,
  }
}

function pushNewline(state, count = 1) {
  if (state.text.endsWith('\n\n')) return
  if (count >= 2) {
    state.text = `${state.text.replace(/\n+$/, '')}\n\n`
    return
  }
  if (state.text !== '' && !state.text.endsWith('\n')) state.text += '\n'
}

/**
 * 读一页内容流，把字排成行。
 *
 * @param {object} doc
 * @param {Buffer} content 已解码的内容流字节
 * @param {any} resources 页面的 /Resources
 * @param {number} depth 当前 Form XObject 深度
 * @returns {{ text: string, unmapped: number, chars: number }}
 */
export function extractPageText(doc, content, resources, depth = 0) {
  const state = makeState()
  runContent(doc, content, resources, state, depth)
  return state
}

function fontFor(doc, resources, name) {
  if (!resources || typeof resources.get !== 'function') return null
  const fonts = doc.resolve(resources.get('Font'))
  if (!fonts || typeof fonts.get !== 'function') return null
  const fontValue = fonts.get(name)
  if (!fontValue) return null
  return buildFont(doc, fontValue)
}

function xobjectFor(doc, resources, name) {
  if (!resources || typeof resources.get !== 'function') return null
  const xobjects = doc.resolve(resources.get('XObject'))
  if (!xobjects || typeof xobjects.get !== 'function') return null
  return doc.resolve(xobjects.get(name))
}

function runContent(doc, bytes, resources, state, depth) {
  let pos = 0
  let font = null
  let matrix = [1, 0, 0, 1, 0, 0]
  let leading = 0
  const stack = []

  const moveTo = (tx, ty) => {
    matrix = [
      matrix[0], matrix[1], matrix[2], matrix[3],
      matrix[0] * tx + matrix[2] * ty + matrix[4],
      matrix[1] * tx + matrix[3] * ty + matrix[5],
    ]
  }

  const notePosition = () => {
    const { x, y } = matrixAt(matrix)
    const fontHeight = Math.max(1, Math.abs(state.fontSize) || 12)
    if (state.lastY !== null && Math.abs(y - state.lastY) > fontHeight * 0.45) {
      const gap = Math.abs(y - state.lastY)
      pushNewline(state, gap > fontHeight * 1.9 ? 2 : 1)
      state.lastX = null
    } else if (state.lastX !== null && x - state.lastX > fontHeight * 0.28) {
      // 同一行里被拆成多段绘制的文字（很多排版软件逐词定位），补一个空格
      if (!/\s$/.test(state.text)) state.text += ' '
    }
    state.lastX = x
    state.lastY = y
  }

  const show = (stringBytes, suffixSpace) => {
    const decoded = decodeTextBytes(font, stringBytes)
    if (decoded.unmapped > 0) state.unmapped += decoded.unmapped
    if (decoded.text !== '') {
      if (state.text === '' || state.text.endsWith('\n')) {
        // 段首不保留多余空白
        state.text += decoded.text.replace(/^[ \t]+/, '')
      } else {
        state.text += decoded.text
      }
      state.chars += decoded.text.replace(/\s/g, '').length
      if (suffixSpace && !/\s$/.test(state.text)) state.text += ' '
      const advance = (decoded.text.length * Math.abs(state.fontSize || 12)) / 2
      const { x, y } = matrixAt(matrix)
      state.lastX = x + advance
      state.lastY = y
    }
  }

  while (pos < bytes.length) {
    let token = nextToken(bytes, pos)
    if (token.next <= pos) {
      // 兜底：任何取不出 token 的字节都跳过去，宁可丢一个字符，不能死循环。
      pos += 1
      continue
    }
    pos = token.next
    if (token.t === 'eof') break

    if (token.t === 'num' || token.t === 'str' || token.t === 'name' || token.t === 'arr') {
      stack.push(token)
      if (stack.length > 64) stack.shift()
      continue
    }

    const op = token.v
    switch (op) {
      case 'BT':
        matrix = [1, 0, 0, 1, 0, 0]
        state.lastX = null
        break
      case 'ET':
        break
      case 'Tf': {
        const sizeToken = stack.length >= 1 ? stack[stack.length - 1] : null
        const nameToken = stack.length >= 2 ? stack[stack.length - 2] : null
        if (sizeToken && sizeToken.t === 'num') state.fontSize = sizeToken.v
        if (nameToken && nameToken.t === 'name') font = fontFor(doc, resources, nameToken.v)
        break
      }
      case 'TL': {
        const value = stack.length >= 1 ? stack[stack.length - 1] : null
        if (value && value.t === 'num') leading = value.v
        break
      }
      case 'Td': {
        const ty = stack.length >= 1 ? stack[stack.length - 1] : null
        const tx = stack.length >= 2 ? stack[stack.length - 2] : null
        if (tx && ty && tx.t === 'num' && ty.t === 'num') {
          moveTo(tx.v, ty.v)
          notePosition()
        }
        break
      }
      case 'TD': {
        const ty = stack.length >= 1 ? stack[stack.length - 1] : null
        const tx = stack.length >= 2 ? stack[stack.length - 2] : null
        if (tx && ty && tx.t === 'num' && ty.t === 'num') {
          leading = -ty.v
          moveTo(tx.v, ty.v)
          notePosition()
        }
        break
      }
      case 'Tm': {
        if (stack.length >= 6) {
          const values = stack.slice(-6).map((item) => (item.t === 'num' ? item.v : 0))
          matrix = [values[0], values[1], values[2], values[3], values[4], values[5]]
          notePosition()
        }
        break
      }
      case 'T*': {
        moveTo(0, -leading || -state.fontSize)
        notePosition()
        break
      }
      case 'Tj': {
        const value = stack.length >= 1 ? stack[stack.length - 1] : null
        if (value && value.t === 'str') show(value.v, false)
        break
      }
      case "'": {
        moveTo(0, -leading || -state.fontSize)
        notePosition()
        const value = stack.length >= 1 ? stack[stack.length - 1] : null
        if (value && value.t === 'str') show(value.v, false)
        break
      }
      case '"': {
        moveTo(0, -leading || -state.fontSize)
        notePosition()
        const value = stack.length >= 1 ? stack[stack.length - 1] : null
        if (value && value.t === 'str') show(value.v, false)
        break
      }
      case 'TJ': {
        const value = stack.length >= 1 ? stack[stack.length - 1] : null
        if (value && value.t === 'arr') {
          for (const item of value.v) {
            if (item.t === 'str') {
              show(item.v, false)
            } else if (item.t === 'num') {
              // 负的字距值表示「往前缩」，超过阈值当成词间空格
              const threshold = Math.abs(state.fontSize || 12) * 0.2
              if (item.v < -threshold && !/\s$/.test(state.text) && state.text !== '') {
                state.text += ' '
              }
            }
          }
        }
        break
      }
      case 'Do': {
        if (depth >= MAX_FORM_DEPTH) break
        const nameToken = stack.length >= 1 ? stack[stack.length - 1] : null
        if (!nameToken || nameToken.t !== 'name') break
        const xobject = xobjectFor(doc, resources, nameToken.v)
        if (!xobject || typeof xobject.get !== 'function') break
        if (nameValueOf(doc.resolve(xobject.get('Subtype'))) !== 'Form') break
        let formBytes = null
        try {
          formBytes = doc.stream(xobject)
        } catch {
          formBytes = null
        }
        if (!formBytes || formBytes.length === 0) break
        const formResources = doc.resolve(xobject.get('Resources')) ?? resources
        const inner = extractPageText(doc, formBytes, formResources, depth + 1)
        if (inner.text !== '') {
          if (state.text !== '' && !state.text.endsWith('\n')) state.text += '\n'
          state.text += inner.text
          state.chars += inner.chars
          state.unmapped += inner.unmapped
          state.lastX = null
          state.lastY = null
        }
        break
      }
      case 'BI':
        pos = skipInlineImage(bytes, pos)
        break
      case '[':
        // 数组开始（正常路径在 nextToken 里处理，这里只是容错）
        break
      default:
        break
    }
    stack.length = 0
  }

  return state
}

/* ------------------------------------------------------------------ *
 * 行 → 段落
 * ------------------------------------------------------------------ */

/** 一句话说完了没有：中文和西文的句末标点都算。 */
function endsSentence(line) {
  return /[。！？!?；;：:…"”』」）)]$/.test(line)
}

/**
 * 把行拼成段落。
 *
 * 判据只有两条，都刻意保守：
 *   - 上一行「把话说完了」（句末标点）且**明显短于本页最长行**（换段常缩进/留白）；
 *   - 上一行末尾是段末标点且下一行是缩进开头（首行缩进）。
 * 宁可多分几段：段落粘在一起最多是读着难受，把两段话的首尾接错会读成病句。
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function linesToParagraphs(lines) {
  // 空行是**硬分段信号**：抽取阶段遇到大行距会写 `\n\n`，那是「这里另起一段」，
  // 比按句末标点猜可靠得多。先按空行切块，块内再按下面的启发式拼。
  const blocks = []
  let currentBlock = []
  for (const line of lines) {
    if (String(line).trim() === '') {
      if (currentBlock.length > 0) blocks.push(currentBlock)
      currentBlock = []
      continue
    }
    currentBlock.push(line)
  }
  if (currentBlock.length > 0) blocks.push(currentBlock)
  if (blocks.length > 1) {
    return blocks.flatMap((block) => linesToParagraphs(block))
  }

  const clean = lines.map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((line) => line !== '')
  if (clean.length === 0) return []
  const lengths = clean.map((line) => line.length)
  const maxLength = Math.max(...lengths)

  /** @type {string[]} */
  const paragraphs = []
  let buffer = ''
  for (let index = 0; index < clean.length; index += 1) {
    const line = clean[index]
    if (buffer === '') {
      buffer = line
    } else {
      const previous = clean[index - 1] ?? ''
      const previousShort = previous.length <= Math.max(20, maxLength * 0.72)
      const breakNow = endsSentence(previous) && previousShort
      if (breakNow) {
        paragraphs.push(buffer)
        buffer = line
      } else {
        // 中文行尾接中文行首不加空格；碰到西文单词边界才补一个。
        const needsSpace = /[A-Za-z0-9,;:.)!?]$/.test(buffer) && /^[A-Za-z0-9(“"']/.test(line)
        buffer = needsSpace ? `${buffer} ${line}` : `${buffer}${line}`
      }
    }
    if (index === clean.length - 1) paragraphs.push(buffer)
  }
  return paragraphs.filter((paragraph) => paragraph !== '')
}
