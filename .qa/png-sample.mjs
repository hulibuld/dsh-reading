/**
 * 极简 PNG 解码器（8-bit、非隔行、RGB/RGBA），只为从无头 Chrome 截图里取像素。
 *
 * 为什么不用依赖：仓库的运行时零依赖、开发依赖只有 jsdom/ajv；
 * 为了读几个像素再引 sharp/pngjs 不值得。defilter 只有 5 个类型，实现 40 行。
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

export function decodePng(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || interlace !== 0) throw new Error('只支持 8bit 非隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`不支持的颜色类型 ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const row = raw.subarray(pos, pos + stride)
    pos += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0
      const up = prev ? prev[x] : 0
      const upLeft = prev && x >= channels ? prev[x - channels] : 0
      const value = row[x]
      let restored = value
      if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        restored = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      } else if (filter !== 0) {
        throw new Error(`未知 PNG filter ${filter}`)
      }
      out[x] = restored & 0xff
    }
  }
  return {
    width,
    height,
    channels,
    pixel(x, y) {
      const i = (y * width + x) * channels
      return [pixels[i], pixels[i + 1], pixels[i + 2]]
    },
  }
}
