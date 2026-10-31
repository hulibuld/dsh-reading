# dsh-Reading

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）里读书的插件。

导入 **EPUB / MOBI / AZW3 / TXT / PDF**，分页读，做目录跳转，记住读到哪，划线、写笔记、加书签。
**没有账号，没有服务器，没有遥测**：书和笔记都在你自己的磁盘上。

> 状态：`0.9.0`，M1「能读书」+ M2「能划线」+ 搜索/标注交互 + 手机与多端 + AI 状态诊断与读书蒸馏 + 书源搜书，
> 支持五种输入格式（EPUB / MOBI / AZW3 / TXT / PDF 文字版）。
> 这一版加上：**Legado 书源的导入与搜书**（用自己的源，抓目录、按章取正文）、
> 阅读设置按「文字 / 纸张 / 翻页」分组。插件不内置任何书源，也不带默认站点。
> 跨端同步（WebDAV）**还没做**，见 [路线图](#路线图)。

---

## 它解决什么问题

DSH 里能读文档，但读**书**是另一件事：一本 30 万字的小说需要分页、需要目录、
需要「上次读到哪」、需要把喜欢的句子划下来日后翻回去。

dsh-Reading 就是补这一块。它只有一条设计原则，写在所有实现细节之前：

> **锚点是 EPUB CFI，不是百分比，不是「第几个字符」。**

百分比会漂：改字号、换设备、换窗口宽度，百分比指的位置就变了。
CFI 是 EPUB 规范里定义的结构化位置（`epubcfi(/6/4[ch01]!/4/2/2/1:12)`），
它指「第 4 个 spine 项、body 下第 2 个 div 的第 2 个 p 的第 1 个文本块的第 12 个字符」。
改字号不影响它，换设备也不影响它 —— 前提是实现严格按规范（下面「它凭什么可信」讲这件事）。

---

## 安装

### 前置

| 项 | 要求 |
|---|---|
| DSH | `>= 0.2.0-rc.1 < 0.3.0`（CLI `dsh --version` 自查） |
| Node.js | `>= 22.19.0` |
| 平台 | 桌面版 DSH（Web UI；面板挂在左侧栏图标条） |

### 从本地目录装

**桌面版（Electron，profile 名通常是 `desktop`）**：profile 由应用独占管理，CLI 的
`dsh plugin` 会拒绝操作它（`profile "desktop" is managed exclusively by the Electron application`）。
请在应用里的**插件管理**界面安装这个目录。

**命令行版 / 自建 profile**：

```bash
dsh plugin --profile web add /path/to/dsh-Reading
```

（`--profile` 放在 `add` **前面**；写成 `dsh plugin add <dir> --profile web` 会被当成 pnpm 参数、报缺 `--profile`。）

装完**重启 DSH**：插件清单在启动时确定，运行期改文件不会热载。
重启后左侧栏底部图标条里会出现一本打开的小册子，点它进书架。

### 卸载

```bash
dsh plugin --profile web remove dsh-reading
```

桌面版同样在插件管理界面里卸载。

卸载**不会**删你的书和笔记。它们在自己的目录里，见下节。

---

## 数据在哪

默认 `~/.dsh-reading/`（可用配置项 `libraryDir` 改）：

```
<libraryDir>/
├── settings.json                       # 阅读偏好：字号、行高、主题、栏宽
└── books/
    └── <bookHash>/                     # sha256(epub 字节) 的前 16 位
        ├── book.epub                   # 原始文件
        ├── meta.json                   # 书名、作者、spine 表
        ├── progress.json               # 读到哪（CFI + 百分比）
        ├── annotations.jsonl           # 划线 / 笔记 / 书签，一行一条
        ├── qa.jsonl                    # 给将来的 AI 问答留的位置（当前只读写结构）
        ├── quarantine.jsonl            # 解不开的锚点，只写不读
        └── history/                    # 被覆盖前的旧文件，保留最近 20 份
```

三条约定：

1. **备份就是复制这个目录。** 没有数据库，没有二进制格式，全部是 JSON / JSONL。
2. **`quarantine.jsonl` 只增不减。** 解不开的锚点不进渲染，但记录永远留着 ——
   那是你的数据，坏了也不该被悄悄扔掉。
3. **删除是墓碑，不是删行。** `annotations.jsonl` 里被删的记录变成 `"deleted": true`，
   文件里那一行还在。这是将来做多设备合并的前提：没有墓碑，另一台设备会把它「复活」。

---

## 配置

装完就能用。要改的话，在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: reading
  name: 'dsh-reading'
  config:
    libraryDir: /Volumes/books/dsh-reading   # 默认 '' = ~/.dsh-reading
    maxImportBytes: 209715200                # 默认 200 MB
```

改完同样要重启 DSH。

---

## 它能做什么

**书架** — 列表带封面、进度圈、最近阅读。点封面进阅读视图。
「导入」选本地文件（也可以直接拖进窗口）。
对着卡片**右键**（或点右上角 **✎**）是编辑入口：改书名、作者、简介，填分类、系列、
打标签、标成「我的珍藏」，换封面图，或者把封面恢复成默认的纸封面。
封面一律按 2:3 摆，同一行不会因为谁名字长就把旁边那张挤歪。

左上角两级下拉可以筛书架：全部 / 我的珍藏 / 按系列 / 按作者 / 按分类 / 按标签。
筛选是纯前端的，不动书的数据。细节见 [docs/13](docs/13-书籍信息与筛选.md)。

「导入」面板分三段：从电脑选文件、粘贴一条下载直链、或者用你自己填的书源搜关键词。
插件**不内置任何站点**，也不带默认书源——你填什么它抓什么，见 [docs/12](docs/12-找书与网络导入.md)。

**格式** — 能读五种：

| 格式 | 呈现 | 说明 |
|---|---|---|
| EPUB | 原样渲染 | 插图、版式都保留 |
| MOBI / AZW3 | 重排为纯文字 | 没有插图与原版式，书架上标「重排」 |
| TXT | 重排为纯文字 | 自动认 UTF-8 / UTF-16 / GB18030，按「第 X 章」切章 |
| PDF（文字版） | 重排为纯文字 | 扫描件与加密 PDF 读不了；表格、分栏会退化成流水文字 |

导入按钮写「导入图书」，因为这五种格式都能导——不写「导入 EPUB」，免得让人以为只认 EPUB。

重排书的划线、笔记、进度和 EPUB 完全一样——锚点仍然是 CFI。
细节与取舍见 [docs/08](docs/08-格式支持-TXT与MOBI.md) 与 [docs/11](docs/11-格式支持-PDF.md)。

**阅读** — 分栏分页；翻页可点正文两侧的窄边（悬停浮出 ‹ ›）、按键盘左右、滚轮或触控板两指横滑（一次手势只翻一页）。
字号、行高、栏宽、明暗都在阅读视图的设置里调，改动即时生效、立刻落盘。

**目录** — 章节树，当前章节高亮，点一下跳过去。目录分三种来源，面板上会标明是哪一种：

- **真目录**（EPUB 自带的 nav / NCX）：带层级；
- **自动识别**：TXT / MOBI 这类没有真目录的书，按正文里的「第 X 章」标题认出来，标「自动识别」；
- **没有目录**：正文里连章节标题都没有的书，面板会直接说「这本书没有目录」，不编造一个假的章节列表。

**书里的目录页也能点** — 正文里那页手打的「目录」，只要章节名本身是链接（带下划线那种），
直接点那行字就跳到对应章节，跨文件的锚点也认；外链会问要不要用浏览器打开，
文内脚注（`#fn-1`）留在本章处理。

**进度** — 关书时自动存 CFI；重开精确回到原处（不是「大概第 60%」）。

**划线 / 笔记 / 书签** — 选中正文出菜单，五色高亮；一条高亮可以再挂笔记；
书签不依赖选中。侧栏列出本书全部标注，按章节、按颜色筛，点一条跳回去。

**划过的线是能点的** — 点一下已有高亮，它进入选中态并浮出一条操作条：

| 你想做的事 | 怎么做 |
|---|---|
| 改颜色 | 点操作条上的五个色块，立刻生效、立刻存盘 |
| 写笔记 | 点「笔记」写到原来的锚点上，锚点不会丢 |
| 拿这段去问 AI | 点「问 AI」，这段原文自动带进提问面板 |
| 复制这段 | **双击**高亮，整条文字变成系统选区，直接 Ctrl/⌘+C |
| 删掉 | 点「删除」；5 秒内还能点提示条上的「撤销」找回 |
| 键盘党 | 高亮可 Tab 聚焦：Enter 选中整条、Delete 删除、Esc 收起 |

**不会越叠越深** — 同一段文字不允许划第二次：再圈一段和已有高亮重叠的文字时不会新建，
而是把已有那条亮出来告诉你「这段已经划过线了」。老数据如果已经叠了，渲染时也只画一层，
同一块地方永远只有一个颜色。

---

### 圈住一段话，问问 AI

读到一段没读懂的话，用鼠标圈住它，浮出来的小菜单里点 **问 AI**，在底部输入框里写下你的问题（Enter 发送）。回答会直接显示在下面，同时**带着这段原文的位置**存进这本书的 `qa.jsonl` —— 下次翻回来还能找到它问过什么。

- 回答只用这段原文和通识，不确定就说不确定，不编；
- 小说里会刻意不剧透后面的情节；
- 这个功能走宿主自己的子代理机制，所以**你得先在 DSH 里选一个模型**。没选模型时它会告诉你「还没选模型」，而不是默默失败。

**问过的话找得回来** — 阅读视图工具栏有个「问答」入口，打开就是这本书的全部问答记录：
按时间倒序列出你问过什么、它答了什么、问的是哪一段原文、在第几章。顶部有搜索框，
点任意一条就跳回那段原文所在的位置，接着问也行（同一个锚点上续问，答案不会串）。
记录存在这本书自己的 `qa.jsonl` 里，不上传。


## 它凭什么可信

读完上一节你会问：凭什么说「重开回到原处」是精确的？这里把三件容易被做错的事列出来，
因为它们决定了你的笔记三年后还在不在原位。

### 一、高亮不碰正文

划线最自然的做法是往正文里插 `<span class="hl">`。dsh-Reading **不这么做**，
因为插一个元素就会改变 CFI 的编号基准：

```
<p id="p">abcdef</p>          选 1~5  →  epubcfi(/4/2[p],/1:1,/1:5)
<p id="p">abc<span></span>def</p>   →  同一个选区变成 /1:1,/1:2
```

文本一个字没变，锚点全错。所以高亮画在**覆盖层**上：用 `getClientRects()` 拿到每段文字的矩形，
在父窗口的绝对定位层里画色块。正文 DOM 一个节点都不动 —— 这条有测试守着
（`test/dom_immutability_test.mjs`：加 50 条标注前后正文 DOM 结构指纹必须相同）。

### 二、CFI 计算强制带 filter

即使不碰正文，本项目自己也会往文档里注入东西（分页用的 `<style>`）。
所以所有 CFI 调用都强制带一个 filter：命中 `data-dsh-reading-injected` 的节点返回
`FILTER_REJECT`，整棵子树不参与索引。

（设计稿原本写的是 `FILTER_SKIP`。实测 vendor 对 SKIP 的处理前后不一致 ——
索引展开时把子节点并进父列表、生成路径时又把该节点那一段丢掉 —— 会算出一份
解回错位置的 CFI；改用 REJECT 后两边自洽。细节见 `docs/07-审计修复记录.md` 的 F7。）

这条不是可选项。`client/src/cfi.js` 的导出函数签名里**没有 filter 参数** ——
想漏传也传不了。

### 三、校验分三层

`foliate-js` 的 `parse()` 很宽容：8 种明显畸形的 CFI 里有 5 种能「解析成功」，
其中两种最危险 —— 起止倒置（`/1:8,/1:3`）会静默折叠成零宽高亮，
跨文档（`/6/4!/4/2`）会落到 `#document` 上返回空文本。两者都不报错。

只靠 `try/catch` 挡不住。所以校验分三层：

| 层 | 检查 | 失败码 |
|---|---|---|
| L1 语法 | `parse()` 不抛 + 恰好一个 `!` | `cfi_parse_failed` |
| L2 语义 | 能解析成 Range + 起止不倒置 + 不跨文档 + highlight 不零宽 | `cfi_resolve_failed` / `cfi_range_inverted` / `cfi_cross_document` / `cfi_collapsed_highlight` / `cfi_offset_out_of_bounds` / `cfi_prefix_mismatch` |
| L3 内容 | 解析出的文本指纹 == 记录里的指纹 | `fingerprint_drift` |

L3 是唯一能挡住那两种静默失败的层，所以 `textExcerpt` 与 `textFingerprint`
在数据契约里是**必填字段**，不是可选的校验提示。

指纹算法（`client/src/contract.js`，两端必须一字不差）：

```
head = 文本前 48 个 UTF-16 code unit
tail = 文本后 32 个 UTF-16 code unit
len  = 文本长度（UTF-16 code unit）
hash = sha256(文本 UTF-8 字节) 的小写 hex
```

四项全等 → `ok`；`head`/`tail`/`len` 全等但 `hash` 不等 → `drifted`（降级渲染，
可能是空白规范化差异）；其余 → 进 `quarantine.jsonl`，不进渲染，但记录保留。

---

## 开发

```bash
npm install --no-save --ignore-scripts jsdom@30 ajv@8   # 只在开发时需要

node golden/run.mjs        # 锚点一致性向量（318 条，含 45 条畸形）
node test/run.mjs          # 12 个测试文件：zip / xml / epub / store / routes / cfi /
                           #   contract / schema_parity / client_build / client_apply /
                           #   dom_immutability / e2e_local
node client/build.mjs      # 从 client/src/*.mjs 生成 client.js
node client/build.mjs --check   # 只校验 client.js 与源码同步（CI 用）
npm run verify             # 以上全跑一遍
```

**渲染部分（书架、阅读器、划线覆盖层）需要真实浏览器**，上面的 node 测试覆盖纯逻辑、
产物形状与「bundle 能不能装载并注册座位」，但布局与滚动这类视觉行为只能人工点一遍。
改动 UI 后请在 DSH 里实际点一遍。

`docs/06` 与 `docs/07` 是一次外部审计的报告与修复记录（11 条缺陷，2 条高危）。
它们不是宣传材料：先看那份报告，就知道这个项目哪些地方被认真怀疑过、哪些地方还没有。

### 目录

```
index.js                 宿主入口：Config + apply + 一条 prefix 路由
lib/                     宿主侧（Node，零运行时依赖）
├── zip.js               ZIP 读取（node:zlib 的 inflateRawSync）
├── xml.js               严格 XML 子集解析（不展开 DTD、不做外部实体）
├── epub.js              EPUB → spine / toc / 章节 XHTML
├── store.js             本地书库读写、墓碑、history 轮转
├── routes.js            /api/dsh-reading/** 的分派（纯函数，可无端口测试）
└── paths.js device.js errors.js
client/
├── build.mjs            构期拼接（无打包器）：src/*.mjs → client.js
├── vendor/              foliate-js/epubcfi.js 原样副本（MIT，锁版本）
└── src/
    ├── cfi.js           ★ 锚点核心，唯一允许碰 vendor 的文件
    ├── contract.js      记录构造 / 字段校验 / 指纹
    ├── sha256.js        纯 JS sha256（同步）
    ├── reader.js        iframe 分页阅读器
    ├── annotate.js      覆盖层 + 选区菜单 + 标注侧栏
    └── shelf.js toc.js style.js api.js app.js
golden/                  一致性向量与 fixture 生成器
schema/contract.schema.json   机器可校验的字段契约
```

### 为什么没有打包器

`client.js` 必须是自包含的 CJS（`window.__ModuleLoader__.load({...})`），
而 `client/src/*.mjs` 是给人看的 ESM。中间只差两件事：剥 `export` 关键字、
把 vendor 的 `import` 内联进来。`client/build.mjs` 用一个行扫描状态机做这两件事，
末尾断言产物里 `export ` 出现 0 次、`new Function` 能求值、`__ModuleLoader__.load(` 恰好 1 次。

不引 esbuild 的理由：为一个 600 行的产物加一条构建链，比这 300 行拼接脚本更容易腐烂。

### 自己跑一致性向量

`golden/fixtures/` 里的 8 本 EPUB 由 `golden/make-fixtures.mjs` 现场生成
（不入库，见 `.gitignore`），覆盖嵌套内联、相邻文本节点、空元素、CDATA、ruby 注音、
RTL、脚注引用、emoji + CJK 扩展 B 八种刁钻结构。

```bash
node golden/make-fixtures.mjs    # 生成 fixtures
node golden/make-vectors.mjs     # 重新生成 vectors.json（改了 fixture 才需要）
node golden/run.mjs              # 跑全部向量
```

### 测试与 CI

`node test/run.mjs` 跑 15 个测试文件。仓库本身**零运行时依赖**，
所以只 clone 不装包也能跑通其中 12 个；依赖 `jsdom` / `ajv` 的 3 个（`cfi`、
`schema_parity`、`dom_immutability`）会自动记为 SKIP 而不是 FAIL ——
装了开发依赖就全跑，CI 里是全跑的（`.github/workflows/ci.yml`，Node 22 与 24 双版本）。

`npm run verify` = `node --check index.js` + 产物同步校验 + 一致性向量 + 全部单测。

### 文档

| 文件 | 内容 |
|---|---|
| [`docs/01`](docs/01-技术方案与数据契约.md) | 技术方案与数据契约（最初的设计稿） |
| [`docs/02`](docs/02-分阶段实现计划.md) | 分阶段实现计划 |
| [`docs/03`](docs/03-CFI实测报告.md) | foliate-js epubcfi 的实测报告（六条铁律的由来） |
| [`docs/04`](docs/04-交付文稿-给实现者.md) | 给实现者的交付文稿 |
| [`docs/05`](docs/05-实现决策-落地版.md) | 落地版实现决策（施工图，优先级高于 01–04） |
| [`docs/06`](docs/06-独立审计报告.md) | 独立审计报告：11 条缺陷（外部视角，含 2 条高危） |
| [`docs/07`](docs/07-审计修复记录.md) | 上述缺陷的逐条修复与回归测试记录 |
| [`docs/08`](docs/08-格式支持-TXT与MOBI.md) | TXT / MOBI / AZW3 的支持方式与取舍（重排书的边界） |
| [`docs/09`](docs/09-对标-开源阅读器.md) | 对标 foliate-js / epub.js / koodo / readest：书内链接、封面、锚点算法 |
| [`docs/10`](docs/10-标注交互移植手册.md) | 标注交互：重叠拆分、命中判定、点选与改色 |
| [`docs/11`](docs/11-格式支持-PDF.md) | PDF 的支持方式与边界（扫描件 / 加密 / 版式丢失） |
| [`docs/12`](docs/12-找书与网络导入.md) | 粘贴链接导入与自定义书源（零内置站点、零内置地址） |
| [`docs/13`](docs/13-书籍信息与筛选.md) | 书名/作者/简介/分类/系列/标签/珍藏的字段、上限与筛选语义 |
| [`docs/14`](docs/14-搜索与标注交互.md) | 书内搜索、标注重叠拆分、点击选中与删除、问答记录 |
| [`docs/15`](docs/15-多端与手机适配.md) | 为什么没有 APK/EXE、手机三步用法、窄屏适配清单、Windows 审计 |
| [`docs/16`](docs/16-AI状态与读书蒸馏.md) | AI 四道检查与调用账本、携带工作内容、按章蒸馏与回源核对 |
| [`docs/17`](docs/17-书源与Legado兼容.md) | 书源规则支持到什么程度、字段怎么用、一次搜索发生什么 |

---

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 能读 | 导入、书架、分页、目录、进度 | ✅ 本轮 |
| M2 能记 | 五色高亮、笔记、书签、覆盖层 | ✅ 本轮 |
| M3 能同步 | WebDAV 四步探测、逐记录合并、history 轮转 | 未开始 |
| M4 能问 | 按 `cutoffCfi` 硬截断的 AI 问答（防剧透） | 未开始 |
| M5 能跨端 | 手机端阅读器，跑同一批向量 | 未开始 |

M3 起才有多设备。在那之前数据只在本机，**请自己备份 `~/.dsh-reading/`**。

---

## 已知限制

- **PDF 只支持文字版**：抽文字重排成纯文字章节，锚点仍走 CFI，所以表格、分栏、公式、
  插图一律退化成流水文字。**扫描件读不了**（整页是图片，不做 OCR，导入时会直接说
  「这本书里读不到文字」），**加密 PDF 读不了**（有 `/Encrypt` 就拒绝，不做解密）。
  理由见 [docs/11](docs/11-格式支持-PDF.md)。
- **MOBI / AZW3 / TXT 没有插图与原版式**：这三类走「文字重排」，只剩章节与段落。
- **MOBI 的复杂排版**（FDST / skeleton）没有还原，个别书段落顺序可能不完美。
- **加密 EPUB（DRM）不能打开**，会明确报错而不是白屏。
- **竖排 / RTL 文本**能读，但跨页选区的高亮矩形会降级成整段高亮。
- **没有全文搜索**，没有 TTS，没有阅读统计。
- **单用户**：没有账号概念，也就不存在共享书库。

---

## 许可证

**GPL-3.0-or-later**，见 [LICENSE](LICENSE)。

`client/vendor/epubcfi.foliate.js` 是 [foliate-js](https://github.com/johnfactotum/foliate-js)
的 `epubcfi.js` 原样副本（MIT，Copyright © 2022 John Factotum），文件头记着版本与 sha256。
按 GPL-3.0 的兼容规则随本仓库分发。

内置的第三方条目只有它一个。其余全部是本仓库自己的代码，运行时不依赖任何 npm 包
（`dependencies` 是空对象；`jsdom` 与 `ajv` 只在开发与测试时用）。

---

## 参与

Issue 与 PR 都欢迎。提 PR 前请跑一遍 `npm run verify`。

改动 CFI / 指纹 / 合并算法这类**会影响已有笔记位置**的代码时，请额外说明：
旧数据是否仍然可读。这条是本项目唯一不能商量的东西。
