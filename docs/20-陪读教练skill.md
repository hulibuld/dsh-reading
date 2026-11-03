# 陪读教练：随插件安装的一个 skill

## 结论先说

0.9.6 起，插件包里带了一个 DSH skill，名字 `reading-coach`。装好插件、重启 DSH 之后，在聊天里说「陪读」「阅读教练」「带我读这本书」「别替我总结，问我」，这个 skill 就会被载入。

它不弹窗、不进阅读器界面，是给对话里的模型用的一套流程。你现在能感受到的差别只有一件事：模型开始**问你**，一次问一个，等你答完再问下一个；问完给你一张按书里原句核对过的卡片，存进那本书的目录。

## 它做了什么

一个七步的流程：

1. 确认读到哪一章、哪个范围；
2. 问你要几个问题（默认五个，按范围收窄）；
3. **一次只问一个问题**，按「概念澄清 → 因果追问 → 反例检验 → 迁移 → 整合」递进；
4. 你答偏了，先指出偏在哪、再说书里怎么写、然后把问题重问一次——不会说一句「不对」就翻篇；
5. 五个问题问完，给一张五维卡片（一句话要点 / 因果链 / 解决方案 / 边界条件 / 原句）；
6. 卡片落成 Markdown，写在书库那本书的目录下；
7. 可选：就这本书做一轮访谈，产出能写成文章的角度。

第五维「原句」必须逐字抄书里的句子并标章节。找不到合适的句子就写「这一节没有可直接引用的原句」——这一条比卡片好不好看重要。

## 正文从哪来

按这个顺序，前一个拿不到再用后一个：

1. 书架上的书。书库在 `~/.dsh-reading/dsh-reading/books/<bookHash>/`，`meta.json` 里有书名、作者、章节列表与目录，`chapters/0001.xhtml` 是已经打开过的章节正文。
2. 你在对话里贴进来的文字或附件。
3. 只有书名。这时它会找你要正文，而不是凭书名编内容。

第三条是刻意的。**没拿到正文就不开始提问**——模型不知道书里写了什么，问出来的问题就是常识题，反而耽误你。

## 文件在哪

```
dsh-Reading/skills/reading-coach/
├── SKILL.md                      # 流程正文，重启后宿主从这读
└── references/
    ├── question-design.md        # 五个层次、好问题四条硬标准、答偏三种处理
    └── card-template.md          # 卡片骨架、逐维好例坏例、写后自查
```

注册代码在 `lib/coachskill.js`，入口 `index.js` 里一行 `registerCoachSkill(ctx, { logger: console })`。

三件与宿主有关的事：

- 探测服务用 `ctx.get('skills', false)`，**宿主没有 skills 服务时直接跳过**，返回 `false`，不抛错——陪读是可选功能，不能因为它在旧宿主上把阅读器拖成不加载。
- 注册包在 `ctx.effect` 里，插件卸载时那条 skill 记录自己消失。
- `package.json` 的 `files` 白名单加了 `skills`。这一条漏了，本地全绿、装到别人机器上 skill 就不见了（测试里钉住了这一条）。

## 装到别人机器上会怎样

- 宿主有 skills 服务（装了 `dsh-distillation-director` 或 `dsh-plugin-guide` 这类带 skill 的插件就说明有）：skill 出现在技能列表里，名字 `reading-coach`，来源标 `dsh-reading`。
- 宿主没有：静默跳过，日志里没有错误，阅读器一切照常。

## 改它

改 `SKILL.md` 就行，不用动代码——只有名字与描述在 frontmatter 里，其余是正文。改完重启 DSH 生效。

frontmatter 只认 `name` 与 `description` 两个键，写成一行一个 `key: value`。多写别的键会被忽略；少写这两个会报错，日志里是「SKILL.md 的 frontmatter 缺 name」这种原话。

## 出处与改动

提问层次、偏离类型、卡片五维的结构来自开源 skill [`xs-reading-coach`](https://github.com/leacui1124/xs-reading-coach)（作者 leacui1124，仓库未附许可证）。

改写的地方：取正文这一段换成读 dsh-reading 自己的书库结构；落盘路径改成书库目录下；删掉了原版面向 IMA 知识库与「爆款选题清单」的耦合（那部分是为自媒体运营设计的，读者陪读用不上）；补了「用户答不上来怎么办」的三步降级与「别问的四种问题」。

## 测试

`test/coach_skill_test.mjs`，七项：

- SKILL.md 在包里，能解析出名字与描述，正文长度够；
- 两份 references 都在位；
- frontmatter 四种非法输入各自报对应的错；
- 没有 skills 服务时返回 `false` 且不抛；
- 有服务时注册参数对（name / provider / source / invocation / resourceBase）且走 `ctx.effect`；
- `package.json` 的 `files` 含 `skills`；
- `index.js` 真的 import 并调用了注册函数。

## 还差一步没做

阅读器里还没有「陪读」入口。现在只能从聊天侧用。要在阅读器工具栏加一个按钮、把当前章节直接喂给这套流程，需要另做：多轮问答的持久化、卡片在侧栏里可查、跳回原句。那是下一版的事，这一版先把流程与 skill 装进去。
