#!/usr/bin/env node
/**
 * 锚块协议（lib/blocks.js）的测试。
 *
 * 这一层是「插件写的段」与「用户手写的段」之间唯一的一道墙。它错了，后果不是
 * 界面上少一行，而是用户几个月的手写笔记被一次同步吃掉。所以这里的用例不测
 * 功能全不全，几乎全在测「什么情况下必须一个字节都不动」：
 *   - 同一个块渲染两遍，第二遍必须是 unchanged（幂等）；
 *   - 用户把 end 标记删了，必须 malformed 拒绝写，不能猜着他的意思补一段；
 *   - AI 的答案里恰好带了标记字样，必须中和掉，不能把块截断；
 *   - 块外的字（用户在笔记里自己写的心得）必须逐字保留。
 *
 * 这里**不碰文件系统**：blocks.js 本来就是纯函数，vault.js 才落盘。
 */

import assert from 'node:assert/strict'
import {
  BLOCK_ID_PATTERN,
  appendBlock,
  canonicalInner,
  diffBlocks,
  findBlock,
  hashInner,
  listBlockIds,
  normalizeMarkdown,
  parseBlocks,
  removeBlock,
  renderBlock,
  replaceBlock,
} from '../lib/blocks.js'

/** 一个典型块：一段讨论。时间戳来自记录，所以渲染结果可复现。 */
const SAMPLE = {
  id: 'a3f2k9m1',
  kind: 'discuss',
  attrs: { chapter: 'ch003', at: '2026-11-17T14:10:00.000Z' },
  inner: '### 有価值的那个问题\n\n> **问**：宝玉为何挨打？\n>\n> **答**：因为他父亲要的是另一种人。',
}

/** 渲染结果字节确定：两遍完全一样，且标记行属性按 key 排序。 */
function rendersDeterministically() {
  const one = renderBlock(SAMPLE)
  const two = renderBlock(SAMPLE)
  assert.equal(one, two, '同一个块渲染两遍必须逐字相同')
  assert.ok(one.startsWith('<!-- dsh-reading:block '), '必须以起始标记开头')
  assert.ok(one.trimEnd().endsWith('-->'), '必须以结束标记收尾')
  assert.ok(one.includes('id=a3f2k9m1'), '标记里要有块 id')
  // 属性按 key 排序：at 在 chapter 之前。
  assert.ok(
    one.indexOf('at=') < one.indexOf('chapter='),
    '属性必须按 key 排序，否则两台机器渲染出的字节不同',
  )
  assert.ok(one.endsWith('\n'), '渲染结果以换行结尾')
}

/** 写第二次必须 unchanged，且文件字节完全不变 —— 这是「每次同步不产生 diff」的根据。 */
function replaceIsIdempotent() {
  const user = '# 读书笔记\n\n我自己写的心得：这一段不许动。\n'
  const first = replaceBlock(user, SAMPLE)
  assert.equal(first.action, 'inserted', '第一次是追加')
  assert.ok(first.markdown.startsWith(user.trimEnd()), '用户原有的字必须原样留在前面')
  const second = replaceBlock(first.markdown, SAMPLE)
  assert.equal(second.action, 'unchanged', '第二次必须判成没变化')
  assert.equal(second.markdown, first.markdown, '判定 unchanged 时字节必须一模一样')
  // 改内容 → replaced，且块外的字还在。
  const changed = replaceBlock(first.markdown, { ...SAMPLE, inner: '改过了' })
  assert.equal(changed.action, 'replaced')
  assert.ok(changed.markdown.includes('我自己写的心得'), '块外的用户笔记不能被吃掉')
}

/** 解析出来的是「区间 + 内容 + 指纹」，同步要靠它判断用户改没改。 */
function parsesBlockAndHash() {
  const rendered = renderBlock(SAMPLE)
  const { blocks, problems } = parseBlocks(rendered)
  assert.equal(problems.length, 0, '干净的块不该有 problem')
  assert.equal(blocks.length, 1)
  const [block] = blocks
  assert.equal(block.id, SAMPLE.id)
  assert.equal(block.kind, 'discuss')
  assert.equal(block.attrs.chapter, 'ch003')
  assert.equal(block.closed, true)
  assert.equal(block.nested, false)
  assert.equal(block.hash, hashInner(block.inner), '块指纹必须能被复算')
  assert.equal(block.hash.length, 64, '指纹是 64 位 hex')
  assert.equal(rendered.slice(block.start, block.end).trimEnd(), rendered.trimEnd(), '区间要覆盖整个块')
}

/** 缺 end 的块：必须报 missing-end 且 closed:false，replaceBlock 拒绝改字节。 */
function refusesMissingEnd() {
  const rendered = renderBlock(SAMPLE)
  const broken = rendered.replace(/<!-- dsh-reading:end[^>]*-->\n?/, '')
  const { blocks, problems } = parseBlocks(broken)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].reason, 'missing-end')
  assert.equal(blocks[0].closed, false)
  const out = replaceBlock(broken, { ...SAMPLE, inner: '想改写' })
  assert.equal(out.action, 'malformed', '缺 end 时必须拒绝，不能猜用户的意思')
  assert.equal(out.markdown, broken, '拒绝时一个字节都不许改')
}

/** 块里嵌了别的块：同样拒绝。这多半是用户复制粘贴出来的。 */
function refusesNested() {
  const rendered = renderBlock(SAMPLE)
  const inner = renderBlock({ id: 'zz1', inner: '被复制进来的小段' })
  const nested = rendered.replace('### 有価值的那个问题', inner + '### 有価值的那个问题')
  const { problems } = parseBlocks(nested)
  assert.ok(problems.some((item) => item.reason === 'nested'), '必须报嵌套')
  assert.equal(replaceBlock(nested, SAMPLE).action, 'malformed', '嵌套时必须拒绝改写')
}

/** 内容里出现标记字样时必须中和：否则下一次解析会提前截断，整块丢失。 */
function neutralizesMarkerText() {
  const evil = '前面\n<!-- dsh-reading:end id=hack -->\n后面'
  const rendered = renderBlock({ id: 'e1', inner: evil })
  assert.ok(rendered.includes('&lt;!--'), '标记字样必须被中和')
  assert.ok(!/<!-- dsh-reading:end id=hack/.test(rendered), '不能再出现真标记')
  const { blocks, problems } = parseBlocks(rendered)
  assert.equal(problems.length, 0)
  assert.equal(blocks.length, 1, '中和之后仍然只有一个块')
  assert.ok(blocks[0].inner.includes('&lt;!--'), '中和后的字节留在块内')
}

/** 删块：连标记带前面那个空行一起走，不留一片空行。 */
function removesBlockCleanly() {
  const user = '# 标题\n\n正文一段。'
  const doc = appendBlock(user, { id: 'r1', inner: '要删的' })
  const out = removeBlock(doc, 'r1')
  assert.equal(out.removed, true)
  assert.equal(out.markdown, user, '删完之后要回到只有用户原文的样子')
  assert.equal(removeBlock(doc, 'nope').removed, false, '删不存在的块返回 false 而不是抛错')
}

/** 差异报告：同步界面那句「有 1 段你改过」就是从这算出来的。 */
function diffsBlocks() {
  const a = appendBlock('', { id: 'x1', inner: 'v1' })
  const b = replaceBlock(appendBlock(a, { id: 'x2', inner: '新的' }), { id: 'x1', inner: 'v2' })
  const diff = diffBlocks(a, b.markdown)
  assert.deepEqual(diff.added, ['x2'])
  assert.deepEqual(diff.changed, ['x1'])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.same, [], '同名的块 hash 变了就不算 same')
}

/** 归一化：CRLF、BOM、结尾空行都要吃掉，否则跨机器同步会反复判「改过」。 */
function normalizesMarkdown() {
  assert.equal(normalizeMarkdown('\uFEFFa\r\n\r\nb\n\n\n'), 'a\n\nb\n')
  assert.equal(normalizeMarkdown(''), '\n')
  assert.equal(normalizeMarkdown(null), '\n')
  assert.equal(canonicalInner('\n\n内容\n\n'), '内容', '块内首尾空行要削掉')
}

/** 标记行里的属性不能带空白 / 引号，否则会把标记截断；这类属性直接丢掉。 */
function dropsUnsafeAttrs() {
  const line = renderBlock({ id: 'q1', attrs: { bad: 'a b', quote: 'x"y', ok: 'v1' }, inner: '' })
  assert.ok(line.includes('ok=v1'), '正常属性要保留')
  assert.ok(!line.includes('bad='), '含空白的属性要丢掉')
  assert.ok(!line.includes('quote='), '含引号的属性要丢掉')
  assert.equal(parseBlocks(line).blocks.length, 1, '丢属性之后块仍然完好')
}

/** id 不合法要报错（这是程序 bug），合法字符集写死在这里防止有人放松它。 */
function rejectsBadId() {
  assert.throws(() => renderBlock({ id: 'has space', inner: '' }), /编号不合法/)
  assert.throws(() => renderBlock({ id: '', inner: '' }), /编号不合法/)
  assert.throws(() => renderBlock({ id: 'a'.repeat(65), inner: '' }), /编号不合法/)
  assert.ok(BLOCK_ID_PATTERN.test('a'.repeat(64)), '64 位是上限且合法')
  assert.ok(!BLOCK_ID_PATTERN.test('a b'), '空格永远不合法')
}

/** findBlock / listBlockIds 这类查询：顺手验一下空文件不会炸。 */
function queriesWithoutThrowing() {
  assert.equal(findBlock('', 'nope'), null)
  assert.deepEqual(listBlockIds(''), [])
  assert.deepEqual(listBlockIds('# 只有用户自己的字\n'), [])
  assert.deepEqual(parseBlocks(undefined).blocks, [], '非字符串按空文件处理')
}

export default async function run() {
  rendersDeterministically()
  replaceIsIdempotent()
  parsesBlockAndHash()
  refusesMissingEnd()
  refusesNested()
  neutralizesMarkerText()
  removesBlockCleanly()
  diffsBlocks()
  normalizesMarkdown()
  dropsUnsafeAttrs()
  rejectsBadId()
  queriesWithoutThrowing()
  console.log('blocks: 12 组用例通过（幂等、缺 end / 嵌套拒绝改写、标记中和、删块、差异、归一化、非法 id）')
}
