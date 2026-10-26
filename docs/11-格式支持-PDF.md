# 11 · 格式支持：PDF

> 状态：已实现（`0.5.0`）。和 [`docs/08`](08-格式支持-TXT与MOBI.md) 是姊妹篇：那篇讲
> TXT / MOBI / AZW3 的重排，这篇讲 PDF 的重排——为什么做、做到什么程度、哪里一定做不到。

---

## 一、结论先说

| 格式 | 支持 | 呈现方式 | 划线 / 笔记 / 进度 | 插图 | 原始版式 |
|---|---|---|---|---|---|
| PDF（文字版） | ✅ | 抽出文字，重排为纯文字章节 | ✅ | ❌ | ❌ |
| PDF（扫描件） | ❌ | —— | —— | —— | —— |
| PDF（加密） | ❌ | 明确拒绝并说明原因 | —— | —— | —— |

三条边界写在这里，免得用户以为「PDF 能导入」就等于「PDF 全能读」：

1. **扫描件读不了。** 整页是图片、没有文字层，本插件不做 OCR。导入时会直接说
   「这本书里读不到文字——多半是扫描件」，而不是给一个空白书架。
2. **加密 PDF 读不了。** 有 `/Encrypt` 就拒绝（`E_PDF_ENCRYPTED`），不做解密。
3. **版式会丢。** 表格、分栏、公式、图片一律退化成流水文字。这是「只为把字读出来」
   这个目标的必然代价——和 MOBI / TXT 的重排是同一笔账。

---

## 二、为什么走「重排」而不是原样渲染

EPUB 能原样渲染，是因为它自带「文档内部节点路径」（spine + XHTML 节点），
一条 EPUB CFI 就能指到某个字。PDF 没有这种东西：它只有画在哪儿的字形，
定位模型是「第几页 + 坐标」，和 CFI 不是一回事。

于是只有两条路：

| 方案 | 代价 |
|---|---|
| 内嵌一个 PDF 渲染器（pdf.js 之类） | 要多带一份几百 KB 的运行时；还得为此发明一套「页内坐标锚点」，与现有 CFI 体系分叉 |
| **抽文字 → 重排成 XHTML 章节** | 版式丢失；但**锚点、标注、进度、数据契约一行都不用改** |

选了后者。理由和当初支持 TXT 一样：**阅读器的其余部分不该为格式分叉**。
重排之后，PDF 书和 TXT 书在系统里长得一模一样——都是「spine + 章节 XHTML + toc」，
CFI 照样生效，划线照样能指回去。

---

## 三、实现：`lib/pdf.js` + `lib/pdftext.js`

两个文件分工明确：

| 文件 | 管什么 |
|---|---|
| `lib/pdftext.js` | 内容流语法：把一页的 `BT … Tj … ET` 翻成文字，管字体、编码、行与段 |
| `lib/pdf.js` | 文档结构：交叉引用表、对象流、过滤器、页面树、章节目录、对外接口 |

### 3.1 文档结构（`lib/pdf.js`）

- **交叉引用表**：优先顺着 `startxref` 读；表坏了、偏移不对（下载站的 PDF 十有八九
  这样）就**全文件扫 `N G obj` 重建索引**，而不是直接报「文件损坏」。
- **对象流 `/ObjStm`**：现代 PDF（1.5+）把普通对象压进流里，不展开它只能看到半个文档。
- **交叉引用流 `/XRef`**：按 `/W` 宽度、`/Index` 区间逐行读，带 PNG 预测器还原。
- **过滤器**：`FlateDecode`（含 PNG/TIFF 预测器）、`LZWDecode`、`ASCIIHexDecode`、
  `ASCII85Decode`、`RunLengthDecode`。图片类过滤器（DCT/JPX/CCITT/JBIG2）直接跳过
  ——那一页只是没有字，不该整本失败。
- **加密**：trailer 里有 `/Encrypt` 就抛 `E_PDF_ENCRYPTED`。

### 3.2 文字（`lib/pdftext.js`）

按 PDF 的文本语义走：`Tf` 选字体、`Td`/`TD`/`Tm`/`T*` 移光标、`Tj`/`TJ`/`'`/`"` 落字。
两处关键判断：

- **换行靠行距**：纵向位移超过字号的 0.45 倍算换行，超过 1.9 倍写空行（= 另起一段）。
- **字距靠横向位移**：同一行里被拆成多段绘制的文字（排版软件逐词定位）按 0.28 倍
  字号的阈值补一个空格。

字体分两路：

| 字体 | 怎么解 |
|---|---|
| 简单字体（Type1/TrueType，`/Differences`） | 单字节 → 字形表；再用 `/ToUnicode` 覆盖 |
| 复合字体（Type0 / Identity-H） | 双字节 → `/ToUnicode` CMap（`beginbfchar` / `beginbfrange`） |

### 3.3 三个真实世界的坑（都会让「中文 PDF 打不开」）

1. **字体声明成 WinAnsi，内容里却写 UTF-8 字节。** 一批国产工具图省事这么干。
   按 latin1 逐字节翻就是「KÕKf」这种鬼字。做法：单字节字体且没有映射表时，先按
   UTF-8 试一次——解得开、含汉字就用它（`lib/pdftext.js` 的 `decodeTextBytes`）。
2. **`/Info` 里的书名是直接塞的 UTF-8 字节**（规范要求 PDFDocEncoding / UTF-16BE 带 BOM）。
   同样先按 UTF-8 试，解出替换符 `U+FFFD` 才退回 latin1（`lib/pdf.js` 的 `decodeDocString`）。
3. **字面量字符串的括号会被截断。** 词法层的 `readLiteralString` 靠数括号定深度，
   调用方必须把「开头这个 `(`」也传进去；传 `i + 1` 会让深度从头就是 0，第一个字符
   就判成「括号没配平」，留下一个没人消费的 `)`，解析循环原地打转（表现为导入时
   一直转圈，什么都不发生）。这个 bug 在本轮回归里被抓到过，现在两处都有防线：
   调用点传 `i`，且主循环对「token 没前进」的字节强制跳一个字符。

---

## 四、章节怎么来

`extractPdfText()` 把每页的文字切成段落，`chaptersFromPages()` 再决定章节目录：

- 认出 **≥2 条**章标题（`第 X 章 / Chapter N / 卷一` 这类形状，与 TXT 共用 `isHeadingLine`）
  → 按标题切章，`tocSource: 'auto'`，目录可点跳；
- 认不出来 → **每 8 页合成一章**，章名「第 1–8 页」，`tocSource: 'none'`，
  目录面板显示空态（**不伪造章节跳转**）。

这条规则和 TXT 的目录来源标记是同一套（见 `docs/10` 与 `schema/contract.schema.json`
里的 `meta.tocSource`），客户端不需要为 PDF 单独判断。

---

## 五、和其余部分的接口

```js
import { parsePdf } from './pdf.js'
const book = parsePdf(bytes, { filename, deviceId, now })
// book 与 parseEpub 同形：meta / spine / toc / chapterHtml(href) / assetBytes / coverHref
```

- `buildReflowedBook()` 负责生成合法 XHTML 章节，PDF 这里只提供
  `{ chapters: [{ label, paragraphs }], tocSource }`。
- **没有封面**：PDF 首屏是文字，抽出来当封面没意义，所以 `coverHref` 为 `null`，
  书架显示米色纸封面。想要「首屏当封面」的话，需要先做图片解码，那是另一件事。
- 落盘扩展名由 `extensionOf()` 给 `book.pdf`，用户去书库目录里翻能一眼认出来。

---

## 六、测试

| 文件 | 覆盖 |
|---|---|
| `test/pdf_test.mjs` | 11 组：最简单的 PDF、FlateDecode、对象流 + 交叉引用流、Type0/Identity-H + ToUnicode 中文、ASCIIHex、LZW、坏 xref 靠扫描救回、扫描件报 `E_PDF_NO_TEXT`、章节切分、格式识别 |
| `test/pdf_fixture.mjs` | 造书的共用工具（经典 xref + 多页 + 章标题 + UTF-16BE 书名） |
| `test/e2e_local_test.mjs` | 一整条用户路径：导入 PDF → 上架 → 目录 → 章节 XHTML → 存进度 → 删掉 |

`node test/run.mjs` 里 `pdf_test.mjs` 排在 `bookformat_test.mjs` 之前——格式识别
的用例会顺带验证 PDF 不会被误判成 TXT。

---

## 七、做不到 / 没做

| 事 | 为什么不做 |
|---|---|
| 扫描件 OCR | 要带模型或云服务，和「零依赖、数据不出本机」冲突 |
| 保留分栏 / 表格 / 公式 | 需要版面分析，不是「把字读出来」这个层次 |
| 按页码跳转（第 123 页） | 重排之后没有「页」这个概念了；用章节 + 进度代替 |
| PDF 里的书签树（`/Outlines`） | 暂未读；目录只认正文里的章标题。如果以后要读，入口在 `PdfDocument` 里加一个 `outlines()` |
| 加密 PDF 解密 | 不做 |
