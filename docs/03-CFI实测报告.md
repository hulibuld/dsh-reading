# CFI 实测报告：foliate-js 实现的真实行为

> 环境：Node v26.10.0 + jsdom 27.x + `foliate-js/epubcfi.js`（MIT，无构建）。
> 方法：真实 DOM（非 mock），`document.createRange()` 构造选区 → `fromRange` → `parse` → `toRange` → 比对文本。
> 结论分级：**✅ 已验证通过** / **⚠️ 静默失败（必须防御）** / **🔴 契约需修改**。

---

## 一、基础往返：7/7 通过

| 用例 | 输入 DOM | 生成的 CFI | 往返结果 |
|---|---|---|---|
| 纯段落 | `<p id="p1">Hello, World</p>` 选 `lo, W` | `epubcfi(/4/2[p1],/1:3,/1:8)` | ✅ 精确 |
| 相邻文本节点 | `<p id="p2">ab<span>cd</span>ef<!--c-->gh</p>` 选 `bcde` | `epubcfi(/4/2[p2],/1:1,/3:1)` | ✅ 精确 |
| 跨内联元素 | `<p id="p4">a<em>b<strong>c</strong>d</em>e</p>` 选 `abcd` | `epubcfi(/4/2[p4],/1:0,/2/3:1)` | ✅ 精确 |
| 中文 | `<p id="p5">中文测试标记位置</p>` 选 `测试标记` | `epubcfi(/4/2[p5],/1:2,/1:6)` | ✅ 精确（按字符，不按字节） |
| emoji | `<p id="p6">前👨‍👩‍👧后</p>` | `epubcfi(/4/2[p6],/1:1,/1:9)` | ✅ 精确 |
| 空元素 | `<p id="p3">x<div></div>y</p>` 选 `xy` | `epubcfi(/4/2[p3],/1:0,/3:1)` | ✅ 精确 |
| 深层嵌套 | 三层 div + p + span + i | `epubcfi(/4/2/2/2[z],/1:0,/2/3:1)` | ✅ 精确 |

**结论：foliate-js 的 CFI 实现可用，不需要自己重写编解码。**

---

## 二、🔴 最重要的发现：没有 filter，注入一次高亮就全崩

这是整个项目的生死线。实测三组对照：

```
原始 DOM:  <p id="h">Hello, World</p>
注入后:    <p id="h">Hello<span class="hl">, World</span></p>

同一个选区 "lo, W"：
  无 filter → epubcfi(/4/2[h],/1:3,/2/1:3)     ← 被 span 污染，多了 /2/1 一层
  有 filter → epubcfi(/4/2[h],/1:3,/1:8)      ← 与未注入时完全一致 ✅

用「干净 CFI」反解：
  传 filter    → "lo, W"        ✅
  不传 filter  → THROW: Offset out of bound  🔴
```

**含义**：`filter` 参数（`FILTER_SKIP` 语义）是 CFI 与渲染层解耦的唯一机制。它把注入节点从索引计算中摘除，使锚点不受渲染影响。

这不是优化项，是**前置条件**。若哪一处忘了传 filter，该章的 CFI 会全部错位，且错得「看起来正常」——生成的还是合法 CFI 字符串，只是指向别处。

**契约动作**：`core/cfi.ts` 的所有导出函数**必须**强制注入项目内的统一 filter，不暴露「无 filter」的调用路径。API 层面就不给出错的机会。

### 多层嵌套注入也稳

```
注入两层 span 后:  <p id="m">ab<span class="hl1">cdefg<span class="hl2">hij</span></span></p>
干净时 CFI:        epubcfi(/4/2[m],/1:2,/1:7)
注入后 + filter:   epubcfi(/4/2[m],/1:2,/1:7)   ✅ 完全一致
用干净 CFI 反解:   "cdefg"                      ✅
```

---

## 三、⚠️ 静默失败面：parse 不报错，但语义是错的

`CFI.parse()` 的健壮性比想象的高，但**高得危险**。以下 8 个畸形输入中，5 个能"解析成功"：

| # | 输入 CFI | parse | toRange 行为 | 危害 |
|---|---|---|---|---|
| B1 | `epubcfi(/4/2,/1:3)` 只有 start | ✅ | 抛 `Cannot read properties of undefined` | 可捕获，低 |
| **B2** | `epubcfi(/4/2,/1:8,/1:3)` **起止倒置** | ✅ | **静默折叠成 collapsed，无异常** | 🔴 高：高亮变零宽 |
| B3 | `epubcfi(/4/999:5)` 索引越界 | ✅ | 抛 `setStart not of type Node` | 可捕获，低 |
| B4 | `epubcfi(/4/999[p1],...)` id 对但索引越界 | ✅ | 抛 `setStart not of type Node` | 可捕获，低 |
| B5 | `epubcfi(/4/2[p1],/1:0,/1:999)` 偏移超长 | ✅ | 抛 `Offset out of bound` | 可捕获，低 |
| **B6** | `epubcfi(/6/4!/4/2[p1],/1:3,/1:5)` **跨文档** | ✅ | **落到 `#document` offset 1，返回空文本，无异常** | 🔴 高：完全错位 |
| B7 | `epubcfi(/4/2,/1:3,/1:3)` 空区间 | ✅ | collapsed，无异常 | 中：无害但应拒收 |
| B8 | `epubcfi(/4/2[p1],/2:0)` 索引指向元素 | ✅ | 抛 `Cannot read properties of undefined` | 可捕获，低 |

**含义**：`try { toRange() } catch {}` 这套防御**不够**。B2 和 B6 都能顺利走出 try 块，返回一个语法合法、语义完全错误的 Range。

**契约动作（这是原文 D4 要补的第三档）**：

CFI 校验必须做**三层**，不能只做一层：

```
L1 语法层：parse 不抛异常
L2 语义层：toRange 不抛异常
L3 内容层：解析出的文本 === textExcerpt 的指纹   ← 新增，唯一能挡住 B2/B6 的
```

L3 是必须的。`textExcerpt` 字段存在的理由从「校验锚点」升级为「挡住静默失败」。这也解释了为什么 `annotations.jsonl` 里 `textExcerpt` 不能是可选字段。

补充规则：
- `startOffset > endOffset` 同节点时 → 直接判为畸形，不进 L2
- CFI 含 `!` 且引用章节 href 与当前文档不符 → 直接判为畸形（不能跨文档渲染区间）
- `range.collapsed === true` 但记录 `type === 'highlight'` → 判为畸形（高亮不应零宽）

---

## 四、id 断言：只认最后一段，但能抗重排

### 断言是自动加的

foliate-js 在 `nodeToParts` 里读 `node.id`，有 id 就自动写进断言：

```
<p id="hasid">abc</p>  →  epubcfi(/4/2[hasid],/1:1,/1:2)
<p>abc</p>             →  epubcfi(/4/2,/1:1,/1:2)      （无断言）
```

### id 短路优先于索引

```
真实结构:  <div><p id="A">aaa</p><p id="B">bbb</p></div>
正确 CFI:  epubcfi(/4/2/4[B])   → 解析到 p#B  ✅
错误 CFI:  epubcfi(/4/2/2[B])   → 仍解析到 p#B ✅（索引领向了 A，但 id 断言赢了）
```

这是**利好**：说明 `id` 断言是抗内容重排的保险。只要章节内有稳定 id，哪怕 spine 顺序变了、段落挪了，锚点还能找回。

同时也是**风险**：索引错的时候解析**不报错**。所以「解析成功」不等于「索引正确」。L3 内容层校验同样必须存在。

### 🔴 断言必须放在路径末端

```
epubcfi(/4/2[B]/2[p1],/1:0)  → 抛 Cannot read properties of undefined
```

`partsToNode` 只读 `parts[parts.length - 1].id`。中间段的 id 断言**完全不生效**，且会让解析路径断掉。

**契约动作**：生成的 CFI 里，断言只允许出现在**归档路径的最后一段**和**每条 local path 的最后一段**。中间段即使元素有 id 也不能写。这条要写进 `docs/02-CFI-规范.md` 的禁止事项。

---

## 五、注释节点被忽略，但空元素会改变结构

### 注释不占位

```
<p id="c">abc<!--x-->def</p>
  实际文本节点: ["abc", "def"]   ← 两个
  CFI 视为:     /1        ← 一个 chunk，偏移连续
```

`getChildNodes` 只保留 `nodeType ∈ {1, 3, 4}`，注释（8）被丢弃。**相邻文本节点会合并成一个 chunk**，偏移跨节点累加。这与 EPUB CFI 规范「Step Reference to Child Element or Character Data」一致，✅。

### 🔴 但插入空元素会改变 chunk 边界

```
<p id="c">abcdef</p>         → 选 1~5 得  epubcfi(/4/2[c],/1:1,/1:5)
<p id="c">abc<i></i>def</p>  → 选 1~? 得  epubcfi(/4/2[c],/1:1,/1:2)  ← 结构变了
```

文本内容完全相同，但 `<i></i>` 把 chunk 从「1 个文本槽」变成「文本、元素、文本」，偏移基准随之改变。

**含义**：任何往正文里插元素的动作——高亮包裹、脚注悬浮层、注音 ruby、装饰性 span——都会改变 CFI。这就是原文 D3「标注渲染禁止改动正文 DOM」的机械证据：不是风格偏好，是数据完整性要求。

**契约动作**：高亮只能用绝对定位覆盖层（`overlayer.js` 的做法），绝不能用 `<span>` 包裹。若某天必须包裹（例如需要 CSS 才能实现的效果），该章所有 CFI 立即失效。

---

## 六、偏移基准：UTF-16 code unit，两端天然一致

```
文本:      "a👨‍👩‍👧b"
length:    10          ← UTF-16 code unit 计数（👨‍👩‍👧 = 8）
CFI 选:    /1:1 → /1:9  ✅ 完整选中 emoji
```

CFI 的字符偏移是 **UTF-16 code unit**，与 JavaScript `String.length`、Dart `String.length` 完全一致。

**含义**：两端不需要做任何编码转换。这是 A0-5 风险清单里可以划掉的一项——Dart 侧不存在「UTF-8 字节偏移 vs 字符偏移」的坑。（仍要注意：iOS/Android 输入法可能产生未配对的代理项，但 EPUB 正文不会。）

---

## 七、性能：单条够用，全量重算不行

```
文档: 2000 个 <p>，约 5 万字
生成 fromRange: 2.18 ms / 次
解析 toRange:   2.01 ms / 次
```

单条标注的读写完全无感。但：

- 1000 条标注全量重算 ≈ 2 秒 → **不可接受**，会卡住翻页
- 单章 200 条标注 ≈ 400 ms → 仍偏高

**契约动作**：按 `chapterHref` 缓存「规范化后的子节点索引表」，标注只在该章首次打开时解析一次，之后复用。这解释了原文 R2 的必要性，且给出了具体阈值：**单章标注 > 100 条时必须走缓存**。

---

## 八、`fake` 与 `fake.toIndex` 的正确用法

```
fake.fromIndex(0)  →  epubcfi(/6/2)     （spine 第 0 项）
fake.fromIndex(3)  →  epubcfi(/6/8)     （spine 第 3 项）
```

`toIndex` 不是 `fake.toIndex(parts)` 直接能用——传整个 parse 结果会返回 `null`。正确写法是取最后一维的最后一项：

```js
const parts = CFI.parse('epubcfi(/6/8!/4/2)')
const spineIdx = parts.at(-1).at(-1).index / 2 - 1   // → 3 ✅
```

**契约动作**：`core/cfi.ts` 提供 `spineIndexFromCfi()` 封装这个细节，两端都用同一份逻辑。这是「两端必须使用同一套 CFI 生成解析规则」的具体落地点之一。

`compare` 与 `collapse` 实测正常：

```
compare('.../1:3,/1:8', '.../1:5,/1:6')  →  -1 ✅
collapse(range, false)  →  epubcfi(/4/2[p1]/1:3)   ✅（折叠到 start）
collapse(range, true)   →  epubcfi(/4/2[p1]/1:8)   ✅（折叠到 end）
```

注意 `collapse` 输出的是 **non-range CFI**（没有逗号），格式与区间 CFI 不同。契约里 `cfiPartial` 与 `cfiFull` 的区分要能容纳这个形态，或明确约定存储时一律用区间形态。

---

## 九、对数据契约的修改清单

| # | 原文 | 实测后改为 | 依据 |
|---|---|---|---|
| 1 | 校验只有语法层 | 三层校验（语法/语义/内容），L3 比对 textExcerpt 指纹 | §三 B2/B6 静默失败 |
| 2 | `textExcerpt` 用于「校验锚点」 | 升级为**必填**，且是 L3 唯一输入 | §三 |
| 3 | 未规定断言位置 | 断言只允许在每条 local path 的**最后一段** | §四 中间段 id 不生效 |
| 4 | 「畸形 CFI 丢弃」 | 补：`startOffset > endOffset`、跨 `!` 文档不符、highlight 却 collapsed 三种追加判畸 | §三 |
| 5 | 未规定性能 | 单章标注 > 100 条必须走索引缓存 | §七 |
| 6 | `spineIndex` 未明确 | 统一走 `spineIndexFromCfi()`，不各自实现 | §八 |
| 7 | 未提 filter | `core/cfi.ts` 强制内置 filter，不暴露无 filter 路径 | §二 |
| 8 | A0-5 风险含编码不一致 | 该项可划掉，UTF-16 两端天然一致 | §六 |

---

## 十、仍未验证的事项

以下几条**这次没有实测**，不能当成已知：

1. **Flutter/Readium 侧能否拿到同样的 DOM 结构** —— 这是 A0-5 的核心，必须做 spike。上面所有结论都建立在「我们能拿到真实 DOM 并手工构造 Range」这个前提上。Web 端显然可以；Readium 的 `evaluateJavascript` 或 decorations API 能否给出等价的 (元素路径, 文本序号, 偏移)，**未知**。
2. **CSS multi-column 下的跨页 Range 矩形** —— CFI 层面没问题，但渲染成多个矩形块需要 `getClientRects()`，分页容器里可能有碎片化结果。
3. **竖排（vertical-rl）的 CFI 行为** —— 逻辑上无关（CFI 是结构锚点，不看方向），但 foliate 的分页器在竖排下有独立代码路径。
4. **加解密 EPUB（DRM-free 但有 obfuscation）** —— `mimetype` / `META-INF/encryption.xml` 的处理。
5. **10 万字体量下的完整章节解析耗时** —— 2000 段是 5 万字量级，10 万字翻倍后是否仍可接受。

建议 A0-5 spike 至少覆盖第 1 条。第 1 条若为否，上面 §二~§八 的大部分结论仍然有效（它们验证的是 CFI 算法本身），但手机端要换 Plan B 的结构锚点，两端的 `anchor` 字段语义会分叉，需要在契约里预留联合类型。
