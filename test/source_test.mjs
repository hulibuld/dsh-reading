#!/usr/bin/env node
/**
 * 入库前的纯函数层（lib/sources.js）的测试。
 *
 * 这一层不联网，但它是「一个链接 → 一个能落盘的文件名」的接缝：
 * 中文名解错，用户书架里就是一堆 %E4%B9%A1；文件名里混进 `../`，就是越界写入。
 * 所以这里直接用真实形态的响应头与 URL 喂进去，断言的是**落到盘上会叫什么**。
 *
 * 0.13.1：老「网页模板书源」退役（buildSearchUrl / extractCandidates 已删），
 * 这里只剩文件名相关三条。
 */

import assert from 'node:assert/strict'
import { decodeEntities, ensureExtension, guessFilename } from '../lib/sources.js'

/** 猜文件名：Content-Disposition 两种写法、URL 兜底、最后兜底 book。 */
function guessesFilename() {
  // filename* 形式（带编码与语言标记）：中文名要靠这个才不丢
  assert.equal(
    guessFilename('https://example.com/dl/1', "attachment; filename*=UTF-8''%E4%B9%A1%E6%84%81.epub"),
    '乡愁.epub',
  )

  // filename="..." 普通引号形式
  assert.equal(
    guessFilename('https://example.com/dl/2', 'attachment; filename="俗世奇人.epub"'),
    '俗世奇人.epub',
  )

  // 没有响应头时用 URL pathname 的 basename（编码过的中文要还原）
  assert.equal(
    guessFilename('https://example.com/files/%E4%B9%A6.epub?token=1', null),
    '书.epub',
  )

  // 路径分隔符与控制字符必须清掉：文件名里带 ../ 就是越界写入
  assert.equal(
    guessFilename('https://example.com/a', 'attachment; filename="../../evil.epub"'),
    '.._.._evil.epub',
  )
  assert.equal(
    guessFilename('https://example.com/a', 'attachment; filename="a\u0001b.epub"'),
    'a_b.epub',
  )

  // 什么都拿不到时兜底 book（后面 ensureExtension 会补扩展名）
  assert.equal(guessFilename('https://example.com/', ''), 'book')
  assert.equal(guessFilename('https://example.com', null), 'book')
  assert.equal(guessFilename('', undefined), 'book')
  assert.equal(guessFilename('::::', null), 'book')
}

/** 补扩展名：已有的不动，没有的按嗅探结果补，认不出的给 .txt。 */
function ensuresExtension() {
  assert.equal(ensureExtension('书.epub', 'epub'), '书.epub', '已经有扩展名的不许再动')
  assert.equal(ensureExtension('书', 'epub'), '书.epub')
  assert.equal(ensureExtension('书', 'mobi'), '书.mobi')
  assert.equal(ensureExtension('书', 'pdf'), '书.pdf')
  assert.equal(ensureExtension('书', 'txt'), '书.txt')
  assert.equal(ensureExtension('书', 'unknown'), '书.txt', '认不出的格式兜底 .txt')
  assert.equal(ensureExtension('', 'epub'), 'book.epub', '空名字兜底 book')
  assert.equal(ensureExtension('   ', 'epub'), 'book.epub', '全空白也兜底 book')
}

/** 实体解码：legado.js 与 cnki.js 都靠它把页面文字还原成中文。 */
function decodesEntities() {
  assert.equal(decodeEntities('A &amp; B'), 'A & B')
  assert.equal(decodeEntities('&#x4E2D;&#25991;'), '中文')
  assert.equal(decodeEntities('&quot;引号&quot;'), '"引号"')
  assert.equal(decodeEntities('a&nbsp;b'), 'a b')
  assert.equal(decodeEntities(null), '', '坏输入不许抛')
}

export default async function run() {
  guessesFilename()
  ensuresExtension()
  decodesEntities()
}
