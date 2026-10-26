/**
 * 无头 Chrome 截 .qa/highlight-overlap.html，再读「最深重叠处」的像素 RGB。
 *
 * 判定：1 条 / 2 条 / 3 条重叠的采样点 RGB 必须一致（允许 ±2 的编码误差）；
 * 对照列（不裁剪）必须明显更深，否则说明这页根本没测出叠色，闸门是假的。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './png-sample.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOT = join(HERE, 'highlight-overlap.png')
const PROFILE = mkdtempSync(join(tmpdir(), 'dr-hl-'))

try {
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=960,400',
    `--user-data-dir=${PROFILE}`,
    '--allow-file-access-from-files',
    `--screenshot=${SHOT}`,
    `file://${join(HERE, 'highlight-overlap.html')}`,
  ], { stdio: 'ignore', timeout: 60000 })
} finally {
  rmSync(PROFILE, { recursive: true, force: true })
}

// 先跑一遍 --dump-dom 读页面自报的采样点（缩放或字体差异时写死坐标会取错地方）
const PAGE = `file://${join(HERE, 'highlight-overlap.html')}`
const dump = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=960,400',
  `--user-data-dir=${PROFILE}`,
  '--allow-file-access-from-files',
  '--dump-dom', PAGE,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 })

const probeMatch = dump.match(/data-json="([^"]+)"/)
if (!probeMatch) { console.error('FAIL 页面没有输出采样点（模块脚本没跑起来？）'); process.exit(1) }
const probe = JSON.parse(probeMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
const png = decodePng(SHOT)
const dpr = probe.dpr || 1
const POINTS = {
  '1 条': probe.samples.one,
  '2 条': probe.samples.two,
  '3 条': probe.samples.three,
  '3 条未裁剪（对照）': probe.samples.naive,
}
const got = {}
for (const [name, point] of Object.entries(POINTS)) got[name] = png.pixel(Math.round(point.x * dpr), Math.round(point.y * dpr))
for (const [name, rgb] of Object.entries(got)) console.log(`${name.padEnd(18)} RGB(${rgb.join(', ')})`)

const base = got['1 条']
const near = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 2)
const fail = (message) => { console.error(`FAIL ${message}`); process.exit(1) }

if (!near(got['2 条'], base)) fail(`2 条与 1 条的 RGB 差超过 2：${got['2 条']} vs ${base}`)
if (!near(got['3 条'], base)) fail(`3 条与 1 条的 RGB 差超过 2：${got['3 条']} vs ${base}`)
const naive = got['3 条未裁剪（对照）']
if (near(naive, base)) fail('对照组没有变深，说明这页没能测出叠色（闸门失效）')

console.log('✓ 同一像素在 1 / 2 / 3 条重叠下 RGB 一致（±2）；对照组确实更深，闸门有效')
