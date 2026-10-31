# 做成 Legado 那样的独立 App：怎么改，值不值

你想要的是「一个能装在手机和电脑上的读书软件，AI 自己填 API key」。这个能做，但它不是给现在的插件加两个文件——它是把插件拆开，装进另一个壳里。这份文档说清代价和顺序。

---

## 一、先说清楚差在哪

现在的 dsh-Reading 是**插件**。它自己没有进程、没有窗口、没有文件权限，一切都是 DSH 宿主给的：

| 能力 | 插件怎么拿到 | 独立 App 得自己有什么 |
| --- | --- | --- |
| 窗口与界面 | DSH Web UI 的插槽 | 自己的窗口（WebView / 原生） |
| 读写书库 | Node 的 `fs`（`~/.dsh-reading`） | 自己的文件系统或数据库 |
| 解压 EPUB / 解 Flate | Node 的 `zlib` | 浏览器 `DecompressionStream` 或原生库 |
| 调 AI | 宿主的会话模型路由 | 用户填的 API key 直连 |
| 抓书源网页 | Node `fetch`（无 CORS） | 原生 HTTP 或代理（浏览器会拦跨域） |
| 后台任务 | 宿主进程 | 自己的线程/服务 |

所以「改成独立 App」不是加功能，是**换地基**。好消息是：真正值钱的那部分——排版引擎、分页算法、标注系统、书源规则引擎、PDF/MOBI 解析——全是纯 JS，能原样搬。

---

## 二、四条路，我建议哪条

| 方案 | 一套前端跑几端 | 体积 | 难度 | 结论 |
| --- | --- | --- | --- | --- |
| **Tauri v2** | Windows / macOS / Linux / Android（iOS 需 Xcode） | 10–20 MB | 中 | **推荐** |
| Electron | Windows / macOS / Linux | 80–150 MB | 中低 | 桌面可用，手机没有 |
| Capacitor + Electron | 手机用 Capacitor，桌面用 Electron | 100 MB+ | 中高 | 两套壳要各修一遍 |
| 原生重写（Kotlin / Swift / C#） | 各写各的 | 小 | 高 | 三倍工作量，不做 |

推荐 Tauri v2 的理由：前端就是我们现在的 `client/src/*`（HTML + CSS + 原生 DOM，没有框架包袱，移植成本最低），Rust 那边只写几个命令——读文件、写文件、HTTP 请求、解压。手机端同理，Tauri v2 的 Android 支持已能出 APK。

代价：Rust 侧要写、要测；iOS 需要 Mac + 苹果开发者账号（99 美元/年），并且阅读器上架 App Store 要处理版权声明——这点绕不过去，Legado 自己也从没上过 App Store。

---

## 三、要动的五块（按顺序，不要跳）

### P1 解析层与文件系统解耦（3 天）

现在 `lib/epub.js`、`lib/mobi.js`、`lib/pdf.js` 里直接 `import { readFileSync } from 'node:fs'` 和 `node:zlib`。改成两个注入点：

```js
// 现状：解析器自己去读盘
const buf = readFileSync(path)

// 目标：解析器只吃字节，谁来读它不管
export async function parseEpub(bytes, options)
```

`zlib` 换成统一的小适配层：Node 用 `zlib`，浏览器用 `DecompressionStream('deflate-raw')`（Chrome 80+ / Safari 16.4+ 都有），Tauri 也可以直接调 Rust。

这一层做完，解析代码一份，两端共用。**现有插件不动行为**，只是把手伸出去的方向变了一下。

### P2 存储层（3 天）

`lib/store.js` 45 KB，全是 `fs`。抽出接口：

```js
interface Store {
  readJson(key) / writeJson(key, value)
  listBooks() / importBook(bytes, name) / removeBook(hash)
  readChapter(hash, href) / writeChapter(hash, href, html)
}
```

三个实现：`nodeFsStore`（现在的，插件继续用）、`tauriFsStore`（桌面）、`idbStore`（手机，存 IndexedDB + 文件系统插件）。

### P3 壳与界面（5–7 天）

Tauri 工程 + 现有前端。要处理的：路由（书架/阅读器从插槽改成整页）、窗口尺寸与安全区、返回键（Android 物理键 = 关闭浮层）、文件选择器（导入书本/封面）、拖拽导入。

### P4 AI 直连（2 天）

设置页加三项：`API 地址`、`API Key`、`模型名`（OpenAI 兼容格式即可，DeepSeek、OpenAI、通义、本地 Ollama 都通）。Key 存进系统钥匙串（Tauri keychain 插件），不写配置文件、不进日志。

请求直接 `POST {baseURL}/chat/completions`，把现在 `lib/distill.js` 的 prompt 原样复用——那部分已经是纯函数。

### P5 书源与网络（2 天）

浏览器的 `fetch` 会拦跨域，所以书源请求必须走 Tauri 的 HTTP 插件（原生请求，不受 CORS 限制）。`lib/legado.js` 那套规则引擎不用改，它只处理字符串。

### P6 打包与签名（3 天）

| 平台 | 产物 | 门槛 |
| --- | --- | --- |
| Windows | `.msi` / `.exe` | 不签名也能装，会弹「未知发布者」；签名要证书（约 300 美元/年） |
| macOS | `.dmg` | 不公证的话用户要右键打开；公证需苹果开发者账号 |
| Android | `.apk` | 自己签名，直接发文件就能装；上 Play 要 25 美元 |
| iOS | `.ipa` | 必须苹果账号；不上架只能自签或用 TestFlight |

---

## 四、什么能原样搬，什么得重写

**原样搬（约占 60% 代码）**
- `client/src/reader.js` 分页与翻页、`annotate.js` 标注系统、`shelf.js` 书架、`style.js` 全部样式
- `lib/legado.js` 书源规则引擎、`lib/txt.js` 文本切章、`lib/xml.js`、`lib/cfi.js`
- `lib/distill.js` 的 prompt 与解析

**要改接口（约 30%）**
- `lib/epub.js`、`lib/mobi.js`、`lib/pdf.js`：出入参改成字节，去掉 `fs`
- `lib/store.js`：换成 Store 接口
- `lib/routes.js`：HTTP 路由变成直接函数调用（没有服务器了）

**要重写（约 10%）**
- AI 调用：从「宿主会话」改成「用户 key + fetch」
- 窗口壳、文件选择、钥匙串、系统分享

---

## 五、里程碑与工期

| 阶段 | 内容 | 工期 | 能不能中途停 |
| --- | --- | --- | --- |
| P1 | 解析层解耦 | 3 天 | 能，插件行为不变 |
| P2 | 存储层抽象 | 3 天 | 能 |
| P3 | Tauri 壳 + 界面搬迁 | 5–7 天 | 能（桌面先跑起来） |
| P4 | AI 直连 + key 管理 | 2 天 | 能 |
| P5 | 书源原生请求 | 2 天 | 能 |
| P6 | 三平台打包签名 | 3 天 | Android 最省事 |

合计 **18–20 个工作日**。前两个阶段做完，插件一点没坏，只是代码更好搬——这是唯一「不做也划算」的部分。

---

## 六、风险，写在前头

1. **App Store 永远不会收**。阅读器类应用要证明内容合法来源，Z-Library 那类书源更不可能。Legado 也只发 APK。所以 iOS 只能自签/TestFlight，Android 侧载，桌面直接发安装包。
2. **签名证书要钱**：Windows 代码签名证书约 300 美元/年，苹果 99 美元/年。不买也能发，只是用户装的时候会看到警告。
3. **两套代码会分叉**。插件版和 App 版共用解析层与前端，但壳不同、AI 调用不同。每次改动要两边都验一遍，否则半年后就变成两个项目。缓解办法：把共用部分做成 workspace 里的一个 package，两边都依赖它。
4. **数据迁移**：App 第一次启动是空书架。要提供一个「从 DSH 导出书库 → 导入 App」的搬运路径（导出 zip，App 里选文件导入）。
5. **手机上的渲染差异**：WebView 版本五花八门，分页逻辑在低端机上要重新验证，尤其是 `column-width` 多栏渲染在老 Android WebView 上不稳。

---

## 七、我的建议

如果你要的是「手机上读书，界面跟现在一样」，那 **P1 + P2 + P3 + P6(Android)** 就够，大约 2 周，先出 APK。iOS 和桌面后补。

如果你只是想要「不装 DSH 也能读」，那其实还有更省的路：**PWA + 本地缓存**——但那需要那台机器一直开着，不是真离线。

这条路的确定性：技术上没有拦路虎，全是工程量。不确定的是签名、分发渠道和上架政策，那些不是写代码能解决的。

---

## 八、这一版没做的事

- 没有建 Tauri 工程，没有引入 Rust 依赖
- 没有动 `lib/` 里任何解析器的接口
- 插件版本仍是「宿主内运行」的形态

等你说开始，我从 P1 动手，一天后给你看解耦后的解析层，插件照常能用。
