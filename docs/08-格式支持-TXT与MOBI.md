# 08 · 格式支持：TXT 与 MOBI / AZW3

> 状态：已实现（`0.2.0`）。本文说明**为什么这么支持**、**支持到什么程度**，以及
> **哪些地方它一定做不到**。如果你只想知道「能读什么」，看 README 就行。

---

## 一、结论先说

| 格式 | 支持 | 呈现方式 | 划线 / 笔记 / 进度 | 插图 | 原始版式 |
|---|---|---|---|---|---|
| EPUB | ✅ | 原样渲染（章节 XHTML + 打包资源） | ✅ | ✅ | ✅ |
| MOBI（MobiPocket，`.mobi`） | ✅ | 重排为纯文字章节 | ✅ | ❌ | ❌ |
| AZW3（KF8，`.azw3` / `.azw`） | ✅ | 重排为纯文字章节 | ✅ | ❌ | ❌ |
| TXT（`.txt`，UTF-8 / UTF-16 / GB18030） | ✅ | 重排为纯文字章节 | ✅ | 无 | ❌ |
| PDF（文字版） | ✅ | 抽出文字，重排为纯文字章节 | ✅ | ❌ | ❌ |

PDF 在 `0.5.0` 支持了，走的是同一套「重排」思路——把文字抽出来变成 XHTML 章节，
锚点、标注、进度全部照旧。具体边界（扫描件、加密、版式丢失）见
[`docs/11`](11-格式支持-PDF.md)。

---

## 二、为什么加一层「格式归一化」

阅读器的其余部分只认一套东西：

```
spine（有序章节列表） + 章节 XHTML + toc + 可选的封面与资源
```

这套东西原本由 `lib/epub.js` 的 `parseEpub()` 生产。TXT 与 MOBI 的价值判断很简单：

> **能不能把它们的文字，包成同样一套形状？**

能。于是新增 `lib/bookformat.js` 这一层分诊：

```
字节 → detectFormat() → { epub | mobi | txt }
                        ├── epub → lib/epub.js     （原样）
                        ├── mobi → lib/mobi.js     （抽文字）→ lib/textbook.js（重排）
                        └── txt  → lib/txt.js      （解码切章）→ lib/textbook.js（重排）
```

`lib/textbook.js` 是重排书的构造器（`buildReflowedBook`），它造出来的对象与
`parseEpub()` **同形**：同样有 `meta` / `toc` / `spine` / `chapterHtml()` /
`assetBytes()` / `resolveRelative()` / `coverHref`。

收益：`lib/store.js`、`lib/routes.js`、`client/src/reader.js`、`client/src/cfi.js`、
标注与进度，**一行都没为格式分叉**。CFI 也照常工作 —— 因为重排书同样是 XHTML 文档，
`epubcfi(/6/4[ch001]!/4/2/1:5)` 照样指到「第 2 个 spine 项、body/div 的第 1 个 p 的第 5 个字符」。

代价也写在这里：**重排书没有插图、没有原始版式、没有字体嵌入**。
它对「读文字、划线、记笔记、续读」是完整的，对「看图看表」不是。界面上会给这类书
挂一个「TXT · 重排」/「AZW3 · 重排」的标记，免得用户以为图片丢了是 bug。

---

## 三、TXT：三件难事

### 1. 编码

中文 TXT 的编码五花八门：网上抓的常是 GB18030，Windows 记事本存的可能是 UTF-16LE，
手打的才是 UTF-8。策略是**先看 BOM，再严格试 UTF-8，再严格试 GB18030**。

「严格」（`TextDecoder` 的 `fatal: true`）是关键：宽松解码会把 GB18030 的中文变成一屏
`U+FFFD`，而那种乱码**看起来像成功**——文件读进来了、书架上有书、打开是方块。
严格解码让「猜错」直接变成尝试下一个编码。

顺序也不能反：先试 GB18030 会把 UTF-8 的中文解成一堆生僻字（两种编码都「合法」，
但只有一种是对的）。

### 2. 切章

只看行首的「第 X 章 / 卷 / 回 / 节 / 篇 / 部」与「序言 / 楔子 / 前言 / 后记 / 番外 / 附录」
这类标题行。但光有前缀不够——**「第一章的正文。」也以「第一章」开头**。
所以匹配到前缀后还要看余下部分：

- 余下部分以「的 / 里 / 中 / 上 / 下 / 前 / 后 / 也 / 还 / 就 / 将 / 是 / 把 / 被 / 对 / 从 / 在 / 说 / 了 / 过 / 着」开头 → 正文；
- 余下部分含句读标点（。！？；，、）→ 正文；
- 整行超过 60 字 → 正文。

一刀都切不出来时按长度硬切（目标 8000 字一章，单章超过 20000 字再切一刀）。
宁可多切几段，也不能让一本 40 万字的大部头变成单章——分页会卡死。

### 3. 段落

TXT 没有段落标记，只有换行。约定俗成是「一行一段」，空行是排版留白，丢掉。

### 生成的 XHTML

```html
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>第一章 起风</title></head>
<body>
  <h1>第一章 起风</h1>
  <p>他站在门口，风把纸片吹起来。</p>
</body>
</html>
```

两条硬要求：

1. **必须能被 XML 解析器吃掉**。章节是按 `application/xhtml+xml` 送进 iframe 的，
   一个没闭合的 `<p>` 会让**整章空白**，而不是「显示得难看」。
2. **控制字符必须抹掉**。`\u0000-\u0008` 这类字符在 XHTML 里非法，同样导致整章解析失败。
   它们常常来自从别处粘贴的文本。

章节里**不写任何 `<style>`**：排版样式由客户端统一注入 iframe，章节内再写一份会和
字号/行高设置打架。

---

## 四、MOBI / AZW3：手写解析器

零运行时依赖的前提下，`lib/mobi.js`（约 1040 行）实现了：

| 环节 | 做了什么 |
|---|---|
| PalmDB | 头（78 字节）+ 记录表（每项 8 字节）→ 记录体切分，所有偏移越界都报 `E_MOBI_MALFORMED` |
| PalmDOC 头 | compression / textLength / recordCount / encryptionType |
| MOBI 头 | `MOBI` magic、headerLength、textEncoding（1252 / 65001）、firstNonBookIndex、fullName 偏移 |
| EXTH | type 100 作者、503 书名、524 语言、121 KF8 边界 |
| 解压 1 | 不压缩，记录直接拼接 |
| 解压 2 | PalmDOC LZ77（字面段 `0x01–0x08`、回溯 `0x80–0xBF`、空格 `0xC0–0xFF`） |
| 解压 17480 | HUFF/CDIC：HUFF 位流查表 + 倒序字典 + CDIC 短语（含嵌套短语缓存）；先试 `inflateSync`，失败再走 HUFF |
| KF8 | `version >= 8` 且有 EXTH 121 时只取 KF8 部分 |
| 切章 | `<mbp:pagebreak>` → `<h1>`~`<h3>` → `filepos=` 锚点 → 每 300 段硬切 |
| 文字化 | 剥标签、解实体、`<br>`/`</p>`/`</div>` 当段落分隔、合并空白 |

**DRM 一律明确拒绝**（`E_MOBI_ENCRYPTED`），不做任何破解尝试。

### 章名从哪来

MOBI 的章名常常不是 `<h1>`，而是 `<p><b>CHAPTER I.</b></p>`——抽成纯文本后只是普通段落。
所以 `lib/mobi.js` 在没有标题时**刻意留空 label**，交给 `lib/textbook.js` 的
`deriveChapterLabel()` 按文字形状再认一遍：

- 短（≤60 字）、以「第 X 章 / CHAPTER N / PART N / 序言 / 目录」这类开头；
- 不以句末标点收尾（`CHAPTER I.` 这种只有句点的写法例外）；
- 下一段若是短句且不像句子，并进标题（`CHAPTER I.` + `Down the Rabbit-Hole`）。

认不出来才由 `buildReflowedBook` 用「第 1 章」兜底。这条规则的价值是双向的：
**该认的认，不该认的不认**——把正文第一句误当章名，目录会变成一列奇怪的句子。

### 真机验证

用 Project Gutenberg 的公版书（Alice's Adventures in Wonderland，`.mobi` 两种）实测：

| 样本 | 结果 |
|---|---|
| `pg11.mobi`（MOBI6，PalmDOC） | 书名/作者正确，19 章 167,033 字，无乱码替换符，章名 `CHAPTER I. Down the Rabbit-Hole` 等正确 |
| `pg11-kf8.mobi`（KF8 + HUFF/CDIC） | 书名/作者正确，19 章 180,328 字，无乱码替换符，章名正确 |

这两个文件**不进仓库**（版权与体积都不合适），测试里用的是自造的最小 MOBI 样本。

---

## 五、落盘与接口的变化

- 书籍文件不再写死 `book.epub`，改成 `book.<原扩展名>`：`book.epub` / `book.txt` /
  `book.mobi` / `book.azw3`。回复读时按 `book.` 前缀找（目录本身按 bookHash 命名，
  里面只会有一个）。这让「用户手工把 epub 换成同名 txt」也能被读出来。
- `meta.json` 新增两个已被设计稿预留的字段：
  - `format`: `epub` / `mobi-converted` / `txt-converted`
  - `sourceFormat`: `epub` / `mobi` / `azw3` / `txt`
  - （TXT 额外有 `encoding`，只做诊断用）
- `shelf.list` 的每一项新增 `sourceFormat`，界面据此挂「重排」标记。
- 错误码新增：`E_MOBI_MALFORMED` / `E_MOBI_ENCRYPTED` / `E_MOBI_UNSUPPORTED` /
  `E_TXT_DECODE_FAILED` / `E_TXT_NOT_TEXT` / `E_BOOK_EMPTY` / `E_IMPORT_UNKNOWN_FORMAT`，
  客户端都有对应人话文案。

格式判定**先看魔数、再看扩展名**：改扩展名骗不过去（`.txt` 改名 `.epub` 会按文本处理）。

---

## 六、这一层做不到什么（诚实清单）

1. **没有插图。** 重排书只剩文字。EPUB 的图片照旧显示。
2. **没有原始版式。** 首行缩进、居中、表格、分栏全部消失，统一按段落重排。
3. **MOBI 的 FDST / skeleton 没有还原。** 复杂排版的 AZW3 可能段落顺序不完美。
4. **CP1252 编码的真实书未验证**（只有代码映射表）；UTF-8 真机通过。
5. **带 DRM 的真书未验证**，只有自造样本（encryptionType=1、EXTH 405）。
6. **512 MB 解压上限只有逻辑保护**，没有造压缩炸弹实测。
7. **TXT 的章节识别基于行首模式**，不是 NLP。极端排版（一行一句、全角空格缩进混合、
   章名与正文同一行）会切错，但内容不会丢——最坏情况是按长度切成「第 N 部分」。
