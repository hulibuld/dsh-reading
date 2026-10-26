/**
 * lib/xml.js 的测试。
 *
 * 断言的是「严格性」而不是「宽容性」——这个解析器的价值就在于畸形输入必须报错：
 * 静默修好会让 CFI 指向错误位置（docs/05 §3.6）。
 *
 * 另一组断言与安全相关：DTD 不展开、外部实体不解析。`&xxe;` 必须原样留成文本，
 * 而不是变成某个文件的内容。
 */

import assert from 'node:assert/strict'
import { parseXml, findAll, findByName, childrenByName, textOf, attr, attrLocal } from '../lib/xml.js'

/** 期望抛 E_XML_MALFORMED。 */
function expectMalformed(text, label) {
  let caught = null
  try {
    parseXml(text)
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `${label}：应当抛错，但解析成功了`)
  assert.equal(caught.code, 'E_XML_MALFORMED', `${label}：错误码应为 E_XML_MALFORMED，实际 ${caught.code}`)
}

export default async function run() {
  // ── 1. 基本结构 ──
  const doc = parseXml('<?xml version="1.0" encoding="utf-8"?><root a="1" b="two"><child>hi</child></root>')
  const root = doc.children.find((n) => n.type === 'element')
  assert.equal(root.name, 'root')
  assert.equal(attr(root, 'a'), '1')
  assert.equal(attr(root, 'b'), 'two')
  assert.equal(attr(root, 'missing'), undefined)
  assert.equal(textOf(root), 'hi')
  assert.equal(childrenByName(root, 'child').length, 1)
  assert.equal(findByName(doc, 'child').length, 1)
  assert.equal(findAll(doc, (n) => n.name === '*').length, 0)

  // ── 2. 注释 / 处理指令 / DOCTYPE 都被忽略，且不进 children ──
  const withNoise = parseXml(
    '<?xml version="1.0"?><!-- 头部注释 --><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "x.dtd"><html><!-- 内部 --><body>正文</body></html>',
  )
  const html = findByName(withNoise, 'html')[0]
  assert.ok(html, 'DOCTYPE 之后的元素要能找到')
  assert.equal(textOf(html), '正文', '注释内容不能混进文本')
  assert.equal(
    html.children.filter((n) => n.type === 'element').length,
    1,
    '注释不该产生节点',
  )

  // 带内部子集的 DOCTYPE（最容易被误当成标签的一类）
  const withSubset = parseXml('<!DOCTYPE r [ <!ENTITY x "y"> ]><r>&x;</r>')
  assert.equal(textOf(findByName(withSubset, 'r')[0]), '&x;', 'DTD 内部不展开：&x; 必须原样保留')

  // ── 3. CDATA ──
  const cdata = parseXml('<r><![CDATA[<b>不是标签</b> &amp; 不解码]]></r>')
  const cdataNode = findByName(cdata, 'r')[0].children.find((n) => n.type === 'cdata')
  assert.ok(cdataNode, 'CDATA 要有独立节点')
  assert.equal(cdataNode.value, '<b>不是标签</b> &amp; 不解码', 'CDATA 内容不解码')
  assert.equal(textOf(findByName(cdata, 'r')[0]), '<b>不是标签</b> &amp; 不解码')

  // ── 4. 命名空间前缀原样保留 ──
  const ns = parseXml(
    '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>书名</dc:title><dc:creator>作者</dc:creator></metadata></package>',
  )
  const titleNode = findByName(ns, 'dc:title')[0]
  assert.ok(titleNode, 'dc:title 必须能按全名找到')
  assert.equal(textOf(titleNode), '书名')
  assert.equal(findByName(ns, 'title').length, 1, '按 local name 也要能找')
  const packageNode = findByName(ns, 'package')[0]
  assert.equal(attr(packageNode, 'xmlns:dc'), 'http://purl.org/dc/elements/1.1/')

  // ── 5. 实体 ──
  const entities = parseXml(
    '<r a="&lt;x&gt; &amp; &quot;q&quot; &apos;s&apos;">&amp;&lt;&gt;&quot;&apos;</r>',
  )
  const entityNode = findByName(entities, 'r')[0]
  assert.equal(attr(entityNode, 'a'), '<x> & "q" \'s\'')
  assert.equal(textOf(entityNode), '&<>"\'')

  // 数字实体（十进制 / 十六进制）
  const numeric = parseXml('<r>&#38;&#60;&#x3E;&#x4E2D;&#25991;</r>')
  assert.equal(textOf(findByName(numeric, 'r')[0]), '&<>中文')

  // 未知实体原样保留（不能吞掉，也不能瞎猜）
  assert.equal(textOf(findByName(parseXml('<r>&nbsp;&foo;</r>'), 'r')[0]), '&nbsp;&foo;')

  // 非法字符引用必须报错
  expectMalformed('<r>&#xZZ;</r>', '非法十六进制实体')
  expectMalformed('<r>&#0;</r>', 'NUL 字符引用')
  expectMalformed('<r>&#xD800;</r>', '代理区字符引用')

  // ── 6. 自闭合与空元素 ──
  const selfClosing = parseXml('<r><br/><img src="a.png"/><p>x</p></r>')
  const selfNode = findByName(selfClosing, 'r')[0]
  assert.equal(childrenByName(selfNode, 'br').length, 1)
  assert.equal(childrenByName(selfNode, 'img')[0].attrs.src, 'a.png')
  assert.equal(childrenByName(selfNode, 'br')[0].children.length, 0)

  // ── 7. 空白不折叠（字符偏移依赖原始字符数据） ──
  const spaced = parseXml('<p>  a\n\t b  </p>')
  assert.equal(textOf(findByName(spaced, 'p')[0]), '  a\n\t b  ')

  // ── 8. 相邻文本节点保持分开（CFI 的文本块合并是解析层之上的一步） ──
  const adjacent = parseXml('<p>abc<![CDATA[def]]>ghi</p>')
  const textChildren = findByName(adjacent, 'p')[0].children
  assert.equal(textChildren.filter((n) => n.type === 'text').length, 2)
  assert.equal(textChildren.filter((n) => n.type === 'cdata').length, 1)
  assert.equal(textOf(findByName(adjacent, 'p')[0]), 'abcdefghi')

  // ── 9. 畸形必须报错 ──
  expectMalformed('<r><a></r>', '标签不匹配')
  expectMalformed('<r><a></a>', '外层未闭合')
  expectMalformed('<r>', '只有开标签')
  expectMalformed('<r a=1></r>', '属性值没引号')
  expectMalformed('<r a></r>', '属性没有值')
  expectMalformed('<r><a></a></b>', '多余的结束标签')
  expectMalformed('<!-- 没闭合', '注释未闭合')
  expectMalformed('<r><![CDATA[没闭合</r>', 'CDATA 未闭合')
  expectMalformed('<r a="x></r>', '属性引号未闭合')
  expectMalformed('<r a="x<y"></r>', '属性值含 <')

  // 空串是合法的空文档（没有根元素，但也没有非法结构）。epub.js 会因为没有
  // rootfile 报 E_EPUB_NO_OPF，所以这里只要求不崩、返回空 children。
  assert.deepEqual(parseXml('').children, [])

  // ── 10. attrLocal：认 xlink:href 这类历史写法 ──
  const xlink = parseXml('<r><image xlink:href="a.png" href="b.png"/></r>')
  const image = findByName(xlink, 'image')[0]
  assert.equal(attr(image, 'href'), 'b.png')
  assert.equal(attrLocal(image, 'href'), 'b.png')
  const onlyXlink = parseXml('<r><image xlink:href="a.png"/></r>')
  assert.equal(attrLocal(findByName(onlyXlink, 'image')[0], 'href'), 'a.png')
  assert.equal(attr(findByName(onlyXlink, 'image')[0], 'href'), undefined)

  // ── 11. 大文档不爆栈（深度仅用于确认递归可控） ──
  const deep = parseXml(`<a>${'<b>'.repeat(200)}x${'</b>'.repeat(200)}</a>`)
  assert.equal(textOf(findByName(deep, 'a')[0]), 'x')

  // ── 12. 嵌套深度上限：超限按畸形拒绝，而不是让下游递归爆栈 ──
  // 解析器自己是迭代的（用栈），但 findAll / textOf 是递归的，CFI 也要沿深度走。
  // 一份 20 万层 <div> 的章节（几百 KB 足够）能让 textOf 抛 RangeError，
  // 那不是 8 个失败码之一，会一路裸奔到路由层。所以在解析入口按住。
  const TOO_DEEP = 600
  const monster = `<a>${'<b>'.repeat(TOO_DEEP)}x${'</b>'.repeat(TOO_DEEP)}</a>`
  expectMalformed(monster, `嵌套超过上限（${TOO_DEEP} 层）`)

  // 上限之下仍然放行，别把正常书拦了
  const justUnder = `<a>${'<b>'.repeat(400)}x${'</b>'.repeat(400)}</a>`
  assert.equal(textOf(findByName(parseXml(justUnder), 'a')[0]), 'x', '400 层属于正常范围，必须能读')
}
