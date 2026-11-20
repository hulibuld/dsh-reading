# dsh-Reading

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）里读书的插件。

导入 **EPUB / MOBI / AZW3 / TXT / PDF**，分页读，做目录跳转，记住读到哪，划线、写笔记、加书签。
**没有账号，没有服务器，没有遥测**：书和笔记都在你自己的磁盘上。

> 状态：`0.13.0`，M1「能读书」+ M2「能划线」+ 搜索/标注交互 + 手机与多端 + AI 状态诊断与读书蒸馏 + 书源搜书 + PDF 论文版式 + 问 AI 五模式与随包阅读 skill + 知网文献检索 + **AI 伴读与 Obsidian 知识库**，
> 支持五种输入格式（EPUB / MOBI / AZW3 / TXT / PDF 文字版）。
> 这一版加上：**读完的书长成你 Obsidian 库里的一棵笔记树**——全书地图、按章的读书笔记、
> 人物关系图，都用锚块协议写，你自己手写的东西一个字不动；**圈住一段话问完 AI，
> 答案自动落回对应章节**，不用点保存；还会拿你「问过什么」算出读者画像，
> 拿去调蒸馏与人物关系 prompt 的侧重。插件只往你选的库里写，只碰 `dsh-reading/` 一个子目录。
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
├── settings.json                       # 阅读偏好：字号、行高、主题、栏宽，以及 Obsidian 那五个键
└── books/
    └── <bookHash>/                     # sha256(epub 字节) 的前 16 位
        ├── book.epub                   # 原始文件
        ├── meta.json                   # 书名、作者、spine 表
        ├── progress.json               # 读到哪（CFI + 百分比）
        ├── annotations.jsonl           # 划线 / 笔记 / 书签，一行一条
        ├── qa.jsonl                    # 圈住原文问 AI 的问与答
        ├── distill.json                # 按章蒸馏的结果（0.8.0 起）
        ├── relations.json              # 人物关系图（0.13.0 起，仅小说）
        ├── reader-profile.json         # 读者画像（0.13.0 起，从 qa.jsonl 算出来）
        ├── notes.json                  # 笔记同步台账（0.13.0 起，记每个块的 hash）
        ├── quarantine.jsonl            # 解不开的锚点，只写不读
        └── history/                    # 被覆盖前的旧文件，保留最近 20 份
```

三条约定：

1. **备份就是复制这个目录。** 没有数据库，没有二进制格式，全部是 JSON / JSONL。
2. **`quarantine.jsonl` 只增不减。** 解不开的锚点不进渲染，但记录永远留着 ——
   那是你的数据，坏了也不该被悄悄扔掉。
3. **删除是墓碑，不是删行。** `annotations.jsonl` 里被删的记录变成 `"deleted": true`，
   文件里那一行还在。这是将来做多设备合并的前提：没有墓碑，另一台设备会把它「复活」。

0.13.0 的笔记**不存在这里**，它们写进你自己的 Obsidian 库：

```
<obsidianVault>/dsh-reading/                     # 只碰这一个子目录
├── 《书名》 <短哈希>/                            # 短哈希 = sha256(bookHash) 前 10 位
│   ├── 00 全书地图.md
│   ├── 01 读书笔记.md
│   ├── 02 人物关系.md
│   └── 03 思想脉络.md
├── _主题/                                       # 跨书主题，全局一份
│   └── <主题>.md
├── _索引/主题总览.md
└── .history/                                    # 覆盖前留底，每份保留最近 20 版
```

笔记那块是 Markdown；书库那块才是插件自己的数据。两者可以分开备份、分开迁移。

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

只在 `cordis.patch.yml` 里能设的就这两项。其余都在界面上改（字数偏好、主题、字号、
Obsidian 库位置、自动写回开关、读者画像开关），存进 `<libraryDir>/settings.json`。

---

## 它能做什么

**书架** — 列表带封面、进度圈、最近阅读。点封面进阅读视图。
「导入」选本地文件（也可以直接拖进窗口）。
对着卡片**右键**（或点右上角 **✎**）是编辑入口：改书名、作者、简介，填分类、系列、
打标签、标成「我的珍藏」，换封面图，或者把封面恢复成默认的纸封面。
封面一律按 2:3 摆，同一行不会因为谁名字长就把旁边那张挤歪。

左上角两级下拉可以筛书架：全部 / 我的珍藏 / 按系列 / 按作者 / 按分类 / 按标签。
筛选是纯前端的，不动书的数据。细节见 [docs/13](docs/13-书籍信息与筛选.md)。

「导入」面板分四段：从电脑选文件、粘贴一条下载直链、用你自己填的书源搜关键词，
或者**直接搜知网**。前两段与书源那段**不内置任何站点**——你填什么它抓什么，见 [docs/12](docs/12-找书与网络导入.md)。
第四段反过来了：它内置知网那个老检索站，因为那一处不用登录就能拿到题录。

书源面板里导入 JSON 有三条路：**贴链接**（最省事，服务端替你去下载，上限 32 MB、超时 180 秒）、
把整包粘进文本框、或者选一个 `.json` 文件。整包书源常有一二十兆，粘贴那条路实际很难走完。

**知网检索** — 不用账号、不用配东西，输入主题词就能搜中文文献。四种找法对应四种用途：

| 下拉里写的 | 什么时候用 |
|---|---|
| 经典文献（被引最高） | 刚进一个领域，看公认的那几篇 |
| 最新发表 | 追前沿，看这两年谁在写 |
| 相关度 | 说不准怎么描述，先随便看看 |
| 下载最多 | 想知道大家都在下什么 |

每条结果给出标题、文献类型、作者、期刊年期、被引次数、下载次数和正文开头一段。
关键词不进列表，存成文献集时才写进那一章。
三个动作：新标签打开知网详情页（你自己登录去下 PDF）、复制题录、勾选。

**勾几条点「存成文献集」，书架里就多一本真书**——能翻页、能划线、能圈一句问 AI。
问的时候选「论文分析」模式，拿到的是四档判决那套格式。已经在书架里的会标「已在本地」，
同一批题录存两次也只有一本书。

它**只做检索，不做登录、不做下载**。能拿到什么、拿不到什么、为什么，
以及那个「被引排序却搜出无关文章」的坑，都写在 [docs/25](docs/25-知网文献检索.md)。

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

**问之前先选怎么看这段话** — 面板顶部模型选择器旁边有个模式下拉，五个：

| 模式 | 什么时候用 | 它给什么 |
|---|---|---|
| 一般问答 | 默认，问什么都行 | 直接回答，不绕 |
| 名著精读 | 读小说、散文、戏剧 | 这句话在整本书里的位置、写法、语气，会引原句 |
| 论文分析 | 读论文 | 分清作者声称、证据支持、你的推断、论文没覆盖 |
| 概念溯源 | 碰到术语、典故 | 词从哪来、通行含义与这本书里的用法差在哪 |
| 外文原著 | 读英日法等原文 | 关键句给原文加一种译法，术语中英对照 |

选过一次会记住，下次打开还是那个模式。每个模式的人设进子代理的系统提示、回答要求进这次提问的正文，两处不重复。要加模式改 `lib/askpresets.js` 一处即可，细节见 [docs/24](docs/24-问AI模式与内置skill.md)。

**它还带四个读书 skill**（连同原来的陪读教练一共五个）— 装好插件重启，聊天里就能用（前提是你的 DSH 装了 skill 工具，一般是有的）：

| skill | 说这句话就载入 | 它干什么 |
|---|---|---|
| `reading-coach` | 「陪读」「带我读这本书」 | 一次只问一个问题，把你问明白，最后落一张卡片 |
| `book-analysis` | 「分析这本书」「这本书好在哪」 | 先给四百字判读报告停下等确认，再按结构、人物、视角、语言、文学史位置拆，每维挂原句 |
| `paper-reading` | 「读这篇论文」「值不值得读」 | 先给四档判决，再决定读多深，只精读承重单元 |
| `literature-review` | 「做综述」「这几篇放一起比」 | 按概念分组，缺口分类，真矛盾与口径差异分开 |
| `notes-to-article` | 「把读书笔记改成文章」 | 找一处能立住的判断，五段结构，引文守规矩 |

五个 skill 的正文都在插件的 `skills/` 目录里，跟着包装走，不用另装。想改哪一条直接改那个 `SKILL.md`，重启生效。

**问过的话找得回来** — 阅读视图工具栏有个「问答」入口，打开就是这本书的全部问答记录：
按时间倒序列出你问过什么、它答了什么、问的是哪一段原文、在第几章。顶部有搜索框，
点任意一条就跳回那段原文所在的位置，接着问也行（同一个锚点上续问，答案不会串）。
记录存在这本书自己的 `qa.jsonl` 里，不上传。

**读完的书长成一棵笔记树** — 这一版最大的新增。挑一个 Obsidian 库，插件往里面的
`dsh-reading/` 写三样东西：全书地图、按章的读书笔记、人物关系图（只有小说才写）。

它不是「导出一份 Markdown」——导一次就过期了。写的是**活的笔记**：

- **你问完 AI，答案自己落进对应章节**，不用点保存。默认开，设置里可关；
- **你自己手写的东西一个字不动**。每段插件内容包在一对 HTML 注释里（锚块），
  同步只替换自己那一块；块里的字你改过，它就整块跳过并告诉你「有 1 段你改过，我没动」；
  块被你删掉了，它记下来**永不复活**；
- **人物关系是一条条从原文里抽的，每条都带原句**，抽完拿原句回去 `indexOf` 核对，
  核不上的直接丢掉并报数——宁可比少几条，也不要凭空编两个人名；
- **一个主题要在两本以上的书里都出现过才成页**（`_主题/<主题>.md`），
  只出现一次的词多半是噪声；
- **它会看你问过什么**。面板顶部一张画像卡：「你问过 12 个问题，集中在第 3、7 章，
  反复在问『叙事视角』」——这句会注进蒸馏与人物关系的 prompt，让 AI 按你关心的侧重写。
  画像只进结论不进原文，零 AI 也能算，不花钱。

设置里四个开关（`obsidianVault` / `obsidianSubdir` / `obsidianAutoWrite` / `obsidianBackup`），
另加一个 `readerProfile`。选库那一步会真写一次目录做可用性确认——只 `stat` 挡不住
「目录在但只读」，那种要等到你写了半小时笔记才炸。

设计稿与它没实现的三项（AI 提炼、`_索引/我的阅读.md`、跨书页注画像）在
[docs/26](docs/26-AI伴读与Obsidian知识库.md)。


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
node test/run.mjs          # 45 组测试，按层从下往上跑：
                           #   格式层 zip / xml / epub / txt / mobi / pdf / paper /
                           #     papercollect / bookformat
                           #   存储与路由 store / routes / source / cnki / legado
                           #   界面纯函数 shelf_ui / cnki_ui / layout_css / frame_metrics /
                           #     contrast / search / meta
                           #   AI 与 skill coach_skill / skill_bundle / ask_presets /
                           #     ai / aimodel / distill_ui
                           #   Obsidian blocks / vault / notesync / notes_routes /
                           #     notes_autowrite / profile / profile_routes /
                           #     relations / threads
                           #   锚点核心 cfi / contract / schema_parity
                           #   客户端 client_build / client_apply / dom_immutability /
                           #     menu_geometry / annotation_overlap
                           #   端到端 e2e_local
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
index.js                 宿主入口：Config + apply + 一条 prefix 路由 + 注册 skills/
lib/                     宿主侧（Node，零运行时依赖）
├── 格式层
│   ├── zip.js           ZIP 读取（node:zlib 的 inflateRawSync）
│   ├── xml.js           严格 XML 子集解析（不展开 DTD、不做外部实体）
│   ├── epub.js          EPUB → spine / toc / 章节 XHTML
│   ├── mobi.js          MOBI / AZW3 → 同一份章节结构
│   ├── txt.js           TXT 按编码与章节正则切
│   ├── pdf.js           PDF 取文本层与页面尺寸
│   ├── pdftext.js       PDF 文本重排（栏检测、行合并）
│   ├── paper.js         PDF 论文版式识别
│   ├── papercollect.js  题录 → 一本能读的文献集（造书）
│   └── bookformat.js    「这是什么文件」的统一判定
├── 存储与路由
│   ├── store.js         本地书库读写、墓碑、history 轮转、设置
│   ├── routes.js        /api/dsh-reading/** 的分派（纯函数，可无端口测试）
│   ├── paths.js         书库路径与分片目录
│   ├── device.js        设备标识
│   └── errors.js        AppError 与错误码
├── 书源与网络
│   ├── textbook.js      教材版式辅助（章节标题与习题段的识别）
│   ├── sources.js       检索模板拼接、候选抽取、文件名猜测（纯函数）
│   ├── legado.js        Legado 书源规则解释与搜书
│   └── cnki.js          知网 HTML → 题录（纯函数 + 可注入 fetch）
├── AI 通道
│   ├── ask.js           圈一段话问 AI：prompt 拼装与落盘
│   ├── askpresets.js    五个问答模式（人设 + 回答要求）
│   ├── aicall.js        子代理调用的唯一出口
│   ├── aimodel.js       模型列表与选择状态的读取
│   ├── aistatus.js      「AI 能不能用」的诊断
│   ├── distill.js       按章蒸馏：prompt、原句回核、成 Markdown
│   └── skillbundle.js   扫 skills/ 逐个注册（单个坏掉只 warn）
├── Obsidian 笔记（0.13.0）
│   ├── blocks.js        锚块协议的解析与渲染（纯函数）
│   ├── vault.js         库发现、路径校验、原子写、备份轮转
│   ├── notesync.js      计划与落地：哪个文件哪一块该是什么
│   ├── mynotes.js       只读标题的「我写过什么」
│   ├── profile.js       读者画像统计（纯函数）
│   ├── relations.js     人物关系分批抽取 + 原句回核
│   └── threads.js       跨书主题的候选筛选与成页
└── coachskill.js        陪读教练 skill 的注册（由 skillbundle 统一调用）
client/
├── build.mjs            构期拼接（无打包器）：src/*.mjs → client.js
├── vendor/              foliate-js/epubcfi.js 原样副本（MIT，锁版本）
└── src/                 18 个模块
    ├── cfi.js           ★ 锚点核心，唯一允许碰 vendor 的文件
    ├── contract.js      记录构造 / 字段校验 / 指纹
    ├── sha256.js        纯 JS sha256（同步）
    ├── reader.js        iframe 分页阅读器
    ├── reader-metrics.js 版心尺寸与分页容量估算（纯函数）
    ├── annotate.js      覆盖层 + 选区菜单 + 标注侧栏
    ├── search.js        书内搜索
    ├── toc.js           目录树
    ├── shelf.js         书架与书卡
    ├── cnki.js          知网检索面板
    ├── legado-ui.js     书源面板
    ├── ai.js            AI 面板
    ├── distill.js       蒸馏面板
    ├── notes.js         读书笔记面板（0.13.0）
    ├── style.js         全部 CSS（按版本分段常量）
    ├── style-qa.js      问答面板样式
    ├── api.js           宿主路由的客户端封装
    └── app.js           应用外壳与两个屏
skills/                  随包分发的五个 skill（各自一个 SKILL.md）
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

`node test/run.mjs` 跑 45 组测试。仓库本身**零运行时依赖**，
所以只 clone 不装包也能跑通其中 42 组；依赖 `jsdom` / `ajv` 的 3 组（`cfi`、
`annotation_overlap`、`schema_parity`）会自动记为 SKIP 而不是 FAIL ——
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
| [`docs/18`](docs/18-多端打包规划.md) | 手机 APK 与桌面安装包怎么打、先打哪个、坑在哪 |
| [`docs/19`](docs/19-独立多端App方案.md) | 做成 Legado 那样独立 App 的路线、工期与代价 |
| [`docs/23`](docs/23-外部阅读器桥.md) | 外部阅读器桥：Zotero / KOReader / Calibre / Obsidian 怎么连 |
| [`docs/22`](docs/22-插图公式与扫描件.md) | 插图 / 公式 / 扫描件：认不出的自动截成图片，分三期做 |
| [`docs/21`](docs/21-论文版式.md) | PDF 论文版式：为什么让用户选、线索字段、两种排版差异 |
| [`docs/20`](docs/20-陪读教练skill.md) | 随插件带的陪读教练 skill：七步流程、取正文的三种来源、怎么改 |
| [`docs/24`](docs/24-问AI模式与内置skill.md) | 问 AI 的五个模式与随包带的四个阅读 skill：怎么选、怎么加、为什么不做成 agent preset |
| [`docs/25`](docs/25-知网文献检索.md) | 知网检索：不用登录能拿到什么、拿不到什么、四种找法、文献集怎么做 |
| [`docs/26`](docs/26-AI伴读与Obsidian知识库.md) | AI 伴读 + Obsidian 知识库：四类笔记、锚块协议、问完自动写回、按「问过什么」个性化（**0.13.0 已实现**，与设计稿的差异见文末「没做的三项」） |

---

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 能读 | 导入、书架、分页、目录、进度 | ✅ |
| M2 能记 | 五色高亮、笔记、书签、覆盖层 | ✅ |
| M3 能找 | 书源搜书、粘贴直链、知网检索存文献集 | ✅ |
| M4 能问 | 圈一段话问 AI（防剧透）、五个模式、问答记录 | ✅ |
| M5 能蒸 | 逐章蒸馏 + 全书骨架 + 导出 Markdown | ✅ |
| M6 能进库 | Obsidian 笔记树、锚块协议、问完自动写回、读者画像、人物关系、跨书主题 | ✅ 0.13.0 |
| M7 能同步 | WebDAV 四步探测、逐记录合并、history 轮转 | 未开始 |
| M8 能跨端 | 手机端阅读器与多端打包 | 部分（窄屏样式已通，打包见 [docs/18](docs/18-多端打包规划.md)） |

M7 起才有多设备。在那之前数据只在本机，**请自己备份 `~/.dsh-reading/` 与你的 `dsh-reading/` 笔记目录**。

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
- **没有 TTS，没有阅读时长统计。**（书内搜索 0.6.0 起就有，顶部「⌕ 搜索」）
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
