#!/usr/bin/env node
/**
 * 论文版式测试（lib/paper.js）。
 *
 * 测的是「认不认得出论文」和「认出来之后排成什么形状」，不测 PDF 解析本身
 * （那个在 pdf_test.mjs 里）。造 PDF 用的是同一份夹具，所以这里的两条腿
 * 分别喂合成段落和真 PDF：段落测规则，PDF 测接线。
 */

import assert from 'node:assert/strict'
import { detectPaperHint, looksLikePaper, parsePaper, splitKeywords, paperChapters, looksLikeSectionHeading } from '../lib/paper.js'
import { parsePdf } from '../lib/pdf.js'
import { buildChapteredPdf } from './pdf_fixture.mjs'

/** 一篇中文论文的首页与正文（模拟逐页抽出来的段落）。 */
const PAPER_PAGES = [
  {
    page: 1,
    paragraphs: [
      '论鲁迅《祝福》中的叙述时间',
      '钱禹舟',
      '云南经济管理学院 教育学院，云南 昆明 650106',
      '摘要：本文讨论《祝福》里两种叙述时间——祥林嫂讲阿毛之死的内时间，与被反复打断的外时间。二者并不重合，正是这种不重合构成了小说的悲剧效果。',
      '关键词：鲁迅；祝福；叙述时间；重复叙述',
    ],
  },
  {
    page: 2,
    paragraphs: [
      '一、问题的提出',
      '《祝福》被反复讨论，但多数研究把注意力放在人物与主题上，对叙述时间本身的处理关注不够。',
      '本文将先从祥林嫂讲故事的场景入手，再看叙述者“我”的位置。',
      '二、内时间：阿毛之死',
      '祥林嫂反复讲述阿毛之死，每一次讲述都是一次重演，时间在这里是圆形的。',
      '（一）第一次讲述',
      '她先是低声说，后来声音越来越大。',
    ],
  },
  {
    page: 3,
    paragraphs: [
      '三、外时间：叙述者的打断',
      '“我”的介入打断了讲述，时间的连续性被切开。',
      '参考文献',
      '[1] 鲁迅. 彷徨[M]. 北京: 北新书局, 1926.',
      '[2] 钱理群. 鲁迅作品的叙述艺术[J]. 文学评论, 2003(2): 12-20.',
    ],
  },
]

export default async function run() {
  /* -------------------- 判据 -------------------- */
  {
    const lines = PAPER_PAGES.flatMap((page) => page.paragraphs)
    assert.equal(looksLikePaper(lines), true, '有摘要+关键词应判为论文')
    assert.equal(
      looksLikePaper(['摘要：这是一段摘要。', '正文开始。']),
      false,
      '只有摘要、没有关键词也没有参考文献，不能判为论文',
    )
    assert.equal(looksLikePaper(['第一章 起点', '他站在门口。']), false, '普通书不能误判成论文')
    assert.equal(looksLikePaper([]), false, '空数组安全返回 false')
    console.log('  ok   looksLikePaper：摘要+关键词/参考文献 才认')
  }

  /* -------------------- 章节标题判据 -------------------- */
  {
    assert.equal(looksLikeSectionHeading('一、问题的提出'), true)
    assert.equal(looksLikeSectionHeading('（一）第一次讲述'), true)
    assert.equal(looksLikeSectionHeading('参考文献'), true)
    assert.equal(looksLikeSectionHeading('2.1 Method'), true)
    assert.equal(looksLikeSectionHeading('这句话是一段很长的正文，长度明显超过四十个字的上限，所以不该被当成标题。'), false)
    assert.equal(looksLikeSectionHeading('摘要：本文讨论'), false, '摘要行本身不是标题')
    console.log('  ok   looksLikeSectionHeading：中文序号 / 括号 / 结构词 / 英文数字')
  }

  /* -------------------- 结构抽取 -------------------- */
  {
    const paper = parsePaper(PAPER_PAGES)
    assert.ok(paper, '应当认出一篇论文')
    assert.equal(paper.title, '论鲁迅《祝福》中的叙述时间')
    assert.deepEqual(paper.authors, ['钱禹舟'])
    assert.equal(paper.affiliations.length, 1)
    assert.match(paper.affiliations[0], /云南经济管理学院/)
    assert.match(paper.abstract, /^本文讨论/, '摘要正文不含「摘要：」标签')
    assert.deepEqual(paper.keywords, ['鲁迅', '祝福', '叙述时间', '重复叙述'])
    assert.equal(paper.sections.length, 4, '一级标题 3 个 + 二级标题 1 个')
    assert.equal(paper.sections[0].heading, '一、问题的提出')
    assert.ok(paper.sections[0].paragraphs.length >= 2)
    assert.equal(paper.references.length, 2)
    assert.match(paper.references[0], /^\[1\] 鲁迅/)
    assert.ok(
      !paper.sections.some((section) => section.heading === '参考文献'),
      '参考文献不该混进正文小节',
    )
    console.log('  ok   parsePaper：标题 / 作者 / 单位 / 摘要 / 关键词 / 小节 / 参考文献')
  }

  /* -------------------- 关键词拆分 -------------------- */
  {
    assert.deepEqual(splitKeywords('鲁迅；祝福、叙述时间，重复叙述'), ['鲁迅', '祝福', '叙述时间', '重复叙述'])
    assert.deepEqual(splitKeywords(''), [])
    assert.deepEqual(splitKeywords('关键词。'), ['关键词'], '去掉句末句号')
    console.log('  ok   splitKeywords：中英文分隔符都认')
  }

  /* -------------------- 排版产物 -------------------- */
  {
    const paper = parsePaper(PAPER_PAGES)
    const chapters = paperChapters(paper)
    assert.equal(chapters.length, 6, '首页 1 + 正文 4 + 参考文献 1')
    assert.match(chapters[0].label, /论鲁迅/)
    assert.match(chapters[0].html, /class="pp-title"/)
    assert.match(chapters[0].html, /class="pp-authors"/)
    assert.match(chapters[0].html, /pp-abstract/)
    assert.match(chapters[0].html, /pp-tag">鲁迅</)
    const byLabel = (needle) => chapters.find((chapter) => chapter.label.includes(needle))
    assert.match(byLabel('一、问题的提出').html, /<h2 class="pp-h1">一、问题的提出<\/h2>/, '一级标题')
    assert.match(
      byLabel('（一）第一次讲述').html,
      /<h2 class="pp-h2">（一）第一次讲述<\/h2>/,
      '（一）应排成二级标题',
    )
    assert.equal(chapters[chapters.length - 1].label, '参考文献')
    assert.match(chapters[chapters.length - 1].html, /class="pp-ref"/)
    for (const chapter of chapters) {
      assert.match(chapter.html, /^<\?xml/, '每章都是完整 XHTML')
      assert.match(chapter.html, /<html xmlns="http:\/\/www.w3.org\/1999\/xhtml"/)
    }
    console.log('  ok   paperChapters：首页 / 小节 / 参考文献三段的 HTML 与标签')
  }

  /* -------------------- 只报告，不替用户决定 -------------------- */
  {
    const pdfBytes = buildChapteredPdf({
      title: '论鲁迅《祝福》中的叙述时间',
      pages: PAPER_PAGES.map((page) => page.paragraphs),
    })
    const auto = parsePdf(pdfBytes, { filename: '论文.pdf' })
    assert.equal(auto.meta.pdfLayout, 'book', '默认不自己套论文版式')
    assert.equal(auto.meta.pdfPaperHint.looksLikePaper, true, '但要报告「像论文」')
    assert.equal(auto.meta.pdfPaperHint.title, '论鲁迅《祝福》中的叙述时间')
    assert.ok(auto.meta.pdfPaperHint.sample.length <= 6, '只看开头几行')
    assert.match(auto.meta.pdfPaperHint.reason, /摘要/)

    // 用户选了「论文」之后，才真的按论文排。
    const book = parsePdf(pdfBytes, { filename: '论文.pdf', layout: 'paper' })
    assert.equal(book.meta.pdfLayout, 'paper', 'meta 要标明这是论文版式')
    assert.equal(book.meta.converterVersion, 'pdf/2-paper')
    assert.equal(book.meta.sourceFormat, 'pdf')
    assert.equal(book.meta.title, '论鲁迅《祝福》中的叙述时间', '书名取论文标题而不是 PDF Info')
    assert.equal(book.meta.author, '钱禹舟')
    assert.ok(book.toc.length >= 5, '目录里应有点得动的章节')
    assert.equal(book.toc[0].label, '论鲁迅《祝福》中的叙述时间')
    assert.ok(
      book.toc.some((item) => item.label === '参考文献'),
      '参考文献也要在目录里',
    )
    const first = (await book.chapterHtml(book.spine[0].href)).toString()
    assert.match(first, /class="pp-title"/)
    assert.deepEqual(book.meta.pdfKeywords, ['鲁迅', '祝福', '叙述时间', '重复叙述'])
    console.log('  ok   parsePdf：论文走 pdf/2-paper，标题/作者/关键词/目录都接上')
  }

  /* -------------------- 期刊页眉占掉前两行也认得出 -------------------- */
  {
    const withHeader = [
      { page: 1, paragraphs: ['文学评论 2023 年第 2 期', 'ISSN 0511-4683', '论鲁迅《祝福》中的叙述时间', '钱禹舟', '摘要：本文讨论叙述时间。', '关键词：鲁迅；祝福'] },
      { page: 2, paragraphs: ['一、问题的提出', '正文。'] },
    ]
    const hint = detectPaperHint(withHeader)
    assert.equal(hint.looksLikePaper, true, '页眉占两行时仍要认得出论文')
    assert.equal(hint.title, '文学评论 2023 年第 2 期', '提示里的标题就是第一行，界面上让人自己确认')
    assert.ok(hint.sample.length <= 6)
    console.log('  ok   detectPaperHint：期刊页眉在前也能认出，只看首页开头几段')
  }

  /* -------------------- 封面页 + 次页摘要：论文常这样排 -------------------- */
  {
    const withCover = [
      { page: 1, paragraphs: ['分类号 I206', '学校代码 10673', '硕士学位论文'] },
      { page: 2, paragraphs: ['论鲁迅《祝福》中的叙述时间', '钱禹舟', '摘要：本文讨论叙述时间。', '关键词：鲁迅；祝福'] },
      { page: 3, paragraphs: ['一、问题的提出'] },
    ]
    const hint = detectPaperHint(withCover)
    assert.equal(hint.looksLikePaper, true, '摘要排在第二页也要认出来')
    assert.equal(hint.hasKeywords, true)
    assert.match(hint.reason, /摘要/)
    console.log('  ok   detectPaperHint：封面页 + 次页摘要也认论文')
  }

  /* -------------------- 只有摘要 + 参考文献：也算 -------------------- */
  {
    const hint = detectPaperHint([
      { page: 1, paragraphs: ['一篇没有关键词的旧派论文', '摘要：本文讨论。'] },
      { page: 2, paragraphs: ['参考文献', '[1] 某某. 书[M].'] },
    ])
    assert.equal(hint.hasKeywords, false)
    assert.equal(hint.hasReferences, true)
    assert.equal(hint.looksLikePaper, true, '摘要 + 参考文献，没有关键词也算论文')
  }

  /* -------------------- 普通文学书：不能误判 -------------------- */
  {
    const hint = detectPaperHint([
      { page: 1, paragraphs: ['祝福', '鲁迅', '旧历的年底毕竟最像年底，村镇上不必说。'] },
      { page: 2, paragraphs: ['她不是鲁镇人。'] },
    ])
    assert.equal(hint.looksLikePaper, false)
    assert.equal(hint.reason, '', '不像就别多话，界面上什么都不说')
    console.log('  ok   detectPaperHint：普通书不误判，reason 留空')
  }

  /* -------------------- 硬排论文但结构不够 → 明确报错 -------------------- */
  {
    let code = ''
    try {
      parsePdf(buildChapteredPdf({}), { filename: '书.pdf', layout: 'paper' })
    } catch (error) {
      code = error?.code ?? error?.name ?? 'unknown'
    }
    assert.equal(code, 'E_PAPER_LAYOUT', '排不出论文版式要给可读的错误，不能悄悄退回')
    console.log('  ok   parsePdf：强制论文版式但认不出结构时报 E_PAPER_LAYOUT')
  }

  /* -------------------- 普通 PDF 不受影响 -------------------- */
  {
    const book = parsePdf(buildChapteredPdf({}), { filename: '书.pdf' })
    assert.equal(book.meta.pdfLayout, 'book', '没有摘要的 PDF 走普通重排')
    assert.equal(book.meta.converterVersion, 'pdf/1')
    assert.equal(book.meta.pdfKeywords, undefined, '普通书不该带论文痕迹')
    console.log('  ok   parsePdf：普通书仍走 pdf/1，不误判')
  }
}
