/**
 * style.js —— 插件全部样式的唯一来源。
 *
 * 两条约束来自 DSH 的 Web UI 规范，违反会被审查打回：
 *   1. 只消费 `--dsw-alias-*` 语义 token 与 `--dsw-radius-*` 圆角 token，
 *      不复制主题色板、不写主题分支（明暗切换由主题层负责）；
 *   2. 每个 `var()` 都带 fallback —— 插件可能装在还没提供该 token 的宿主版本上，
 *      缺一个变量就整块背景变透明，用户看到的是「白底白字」。
 *
 * 两类例外，都只许出现在各自的单一来源里：
 *   1. 高亮五色：docs/05 §5.5 明确要求用固定 rgba 而不是主题派生色，
 *      因为浅色主题下派生出来的黄会发灰，读者根本看不出「划了哪一句」。
 *      这五个值集中在 HIGHLIGHT_COLORS 里，别处不要另写字面色。
 *   2. 阅读纸色：电子墨水阅读器的「纸」是自己的语义（白纸/羊皮纸/护眼绿/夜间），
 *      不是宿主主题的一部分 —— 深色主题下用户仍可能想看羊皮纸。四档配色定义在
 *      reader.js 的 THEMES 里，经 `--dsh-reading-paper/ink/rule` 三个组件变量传进样式表。
 *      这三个是布局变量命名空间（`--dsh-reading-*`），不是主题 token 的替代品。
 *
 * 注入方式：ensureStyle(doc) 幂等往 <head> 追加一个 <style id="dsh-reading-style">。
 * 注意这只对**父窗口**生效；书籍 iframe 里的 <style> 由 reader.js 单独注入，
 * 且必须带 data-dsh-reading-injected（CFI filter 靠它跳过）。
 */

/** 父窗口样式表的 id。用 id 而不是 class，便于「只注入一次」。 */
const STYLE_ID = 'dsh-reading-style'

/**
 * 五色高亮。名字是 schema 的枚举值（yellow/green/blue/pink/purple），不能改。
 * rgba 的 alpha 刻意压得低：覆盖层压在正文之上，太重会把字盖住。
 */
export const HIGHLIGHT_COLORS = {
  yellow: { fill: 'rgba(255, 214, 64, 0.38)', stroke: 'rgba(214, 168, 0, 0.85)', label: '黄' },
  green: { fill: 'rgba(64, 200, 120, 0.34)', stroke: 'rgba(24, 148, 76, 0.85)', label: '绿' },
  blue: { fill: 'rgba(74, 158, 255, 0.32)', stroke: 'rgba(28, 108, 208, 0.85)', label: '蓝' },
  pink: { fill: 'rgba(255, 122, 168, 0.34)', stroke: 'rgba(206, 62, 118, 0.85)', label: '粉' },
  purple: { fill: 'rgba(168, 122, 255, 0.32)', stroke: 'rgba(118, 68, 208, 0.85)', label: '紫' },
}

/** 五色的稳定顺序。侧栏、选区菜单都按它排，用户形成肌肉记忆。 */
export const HIGHLIGHT_ORDER = ['yellow', 'green', 'blue', 'pink', 'purple']

/** 取某色的样式；未知颜色回退到黄色而不是抛错（旧数据可能带别的值）。 */
export function colorStyle(color) {
  return HIGHLIGHT_COLORS[color] ?? HIGHLIGHT_COLORS.yellow
}

const CSS = `
/* ─────────────────────────────────────────────────────────────
   根容器：插件在 slot 里拿不到确定高度，所以自己撑满并允许收缩。
   --dsh-reading-* 是本组件自己的布局变量（不是主题色），
   色值一律来自 --dsw-alias-*。
   ───────────────────────────────────────────────────────────── */
.dr-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  line-height: 1.55;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  overflow: hidden;
}

.dr-grow { flex: 1 1 auto; min-width: 0; min-height: 0; }
.dr-row { display: flex; align-items: center; gap: 8px; }
.dr-col { display: flex; flex-direction: column; gap: 8px; }
.dr-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-wrap { display: flex; flex-wrap: wrap; gap: 6px; }

/* ── 页头 ─────────────────────────────────────────────────────── */
.dr-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--dsw-alias-bg-layer-1, #fbfbfc);
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
}
.dr-head-title {
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-head-sub {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}

/* ── 按钮 / 控件：统一 R12，H28–36 ─────────────────────────────── */
.dr-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-md, 12px);
  border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.dr-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); }
.dr-btn:active { transform: translateY(0.5px); }
.dr-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
.dr-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}
.dr-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4a7dff);
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
}
.dr-btn-primary:hover { background: var(--dsw-alias-button-primary-hover, #3d6ded); }
.dr-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6069);
}
.dr-btn-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-btn-sm { height: 24px; padding: 0 8px; font-size: 12px; }
.dr-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--dsw-radius-md, 12px);
  border: 0.5px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6069);
  cursor: pointer;
  font-family: inherit;
}
.dr-iconbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-iconbtn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
.dr-iconbtn[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
  color: var(--dsw-alias-label-primary, #1f2328);
}

.dr-input, .dr-select, .dr-textarea {
  box-sizing: border-box;
  width: 100%;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
  border-radius: var(--dsw-radius-md, 12px);
  padding: 7px 9px;
}
.dr-textarea { resize: vertical; min-height: 76px; line-height: 1.6; }
.dr-input:focus, .dr-select:focus, .dr-textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #4a7dff);
}

/* ── 书架 ─────────────────────────────────────────────────────── */
.dr-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px;
}
.dr-grid {
  display: grid;
  /* auto-fill 不能换成 auto-fit：auto-fit 会把空列折叠掉，书架只有两三本书时
     剩下的卡片会被拉成「一本占半屏」的超大封面。 */
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  /* 拉伸对齐：同一行的格子统一高度。封面高度由 aspect-ratio 决定（同一行格子
     等宽 → 封面等高），卡片再吸收多余高度、把进度条压到底部
     （.dr-progress 的 margin-top:auto），一行里的卡就一样高。 */
  align-items: stretch;
  gap: 14px;
}

/* 格子：grid item 的 min-width 默认是 auto，而卡片里有 nowrap 的作者名，
   于是长作者会把格子撑到比列宽还宽，卡片溢出去盖住邻卡 —— 这就是
   「封面大小错乱 / 堆叠」的根因。min-width:0 把最小内容宽度这个闸门关掉。 */
.dr-book-cell {
  position: relative;
  display: flex;
  min-width: 0;
  width: 100%;
  max-width: 200px;
  margin: 0 auto;
}

/* 书卡：独立内容卡 → R20 (--dsw-radius-xl) */
.dr-book {
  display: flex;
  flex-direction: column;
  /* 卡片宽度只听格子的（width:100%），自己不参与最小内容宽度的计算 */
  min-width: 0;
  width: 100%;
  gap: 8px;
  padding: 10px;
  text-align: left;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
  border-radius: var(--dsw-radius-xl, 20px);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, #e6e6ea);
  background: var(--dsw-alias-settings-card-fill, #ffffff);
  transition: border-color 0.12s, transform 0.08s;
}
.dr-book:hover {
  border-color: var(--dsw-alias-brand-primary, #4a7dff);
  transform: translateY(-1px);
}
.dr-book:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 2px;
}
.dr-book:active { transform: none; }

/* 封面：一本书一格，比例恒定 2:3。用 aspect-ratio 而不是固定高度，窄栏也不变形。
   尺寸只由卡片宽度决定（aspect-ratio），真实封面与米色纸封面共用同一套
   几何 —— 之前真封面走 img 的 intrinsic 尺寸、纸封面走 flex 居中，
   两者在窄栏里会不一样大，看起来就是「封面大小错乱」。 */
.dr-cover {
  position: relative;
  width: 100%;
  /* 盒子自己撑起 2:3，绝不让 flex 压缩它：卡片被拉高时矮封面会变形 */
  flex: 0 0 auto;
  aspect-ratio: 2 / 3;
  border-radius: var(--dsw-radius-md, 12px);
  overflow: hidden;
  isolation: isolate;
  background: var(--dsw-alias-bg-layer-3, #eceef2);
}
.dr-cover img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
}
/* 比例极端的封面（比 1:2 还细、接近方形或横版）：铺满会把主体裁掉大半，
   改成「模糊铺底 + 完整图居中」。盒子仍是 2:3，所以同行卡片高度不受影响，
   也不会出现「一张封面被裁成一条」。 */
.dr-cover.is-extreme {
  background: #2b2e34;
}
.dr-cover.is-extreme > img {
  object-fit: contain;
}
.dr-cover-blur {
  position: absolute;
  /* 往外多铺 8px：模糊会把边缘吸透明，不多铺就露出一圈底色 */
  inset: -8px;
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  filter: blur(14px) saturate(1.05);
  opacity: 0.55;
  pointer-events: none;
}
/* 没有封面的书：排成一本米色纸书的封面，而不是一行灰色小字。
   颜色刻意写死而不走主题 token —— 纸封面就是纸，深色主题下也该是米色。 */
.dr-cover-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  /* 第一行吃满剩余高度放书名，第二行给作者留固定一条 —— 不用绝对定位，
     长书名再长也压不到作者名字上去。 */
  grid-template-rows: 1fr auto;
  align-items: center;
  justify-items: center;
  row-gap: 8px;
  padding: 14px 12px 10px;
  background: linear-gradient(160deg, #f6eedb 0%, #efe3c8 60%, #e9dcbe 100%);
  color: #4a3f35;
  text-align: center;
  overflow: hidden;
}
.dr-cover-frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  width: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}
.dr-cover-rule {
  width: 26px;
  height: 0;
  border-top: 1px solid rgba(74, 63, 53, 0.42);
}
.dr-cover-text {
  max-width: 100%;
  font-family: "Songti SC", "SimSun", "Source Han Serif SC", serif;
  font-weight: 600;
  line-height: 1.32;
  letter-spacing: 0.04em;
  text-wrap: balance;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.dr-cover-author {
  /* nowrap 让内容不肯收缩，overflow 只裁「看得见的」、不减小最小内容宽度，
     所以必须显式把宽度钉在盒子里，否则长作者名会把整个格子顶宽。 */
  min-width: 0;
  max-width: 100%;
  width: 100%;
  font-size: 9.5px;
  letter-spacing: 0.02em;
  color: rgba(74, 63, 53, 0.66);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-book-title {
  /* 同一个道理：两行截断的书名也不许参与「最小内容宽度」的计算 */
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dr-book-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
/* 重排书标记（MOBI / TXT 转来的）：小、浅、不抢书名。 */
.dr-book-badge {
  align-self: center;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-3, #eceef2);
  color: var(--dsw-alias-label-secondary, #5c6270);
  font-size: 10px;
  line-height: 1.5;
  white-space: nowrap;
}
.dr-progress {
  height: 3px;
  /* 贴底：同一行里有的卡多了「TXT · 重排」标记，卡片被拉成等高之后，
     进度条和「读了 30%」一起压在底部，一行看过去才是齐的 */
  margin-top: auto;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-3, #eceef2);
  overflow: hidden;
}
.dr-progress-fill {
  height: 100%;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-brand-primary, #4a7dff);
}

/* ── 编辑书名 / 封面的弹窗 ───────────────────────────────────── */
/* 封面预览沿用书卡的 2:3 盒子，只是窄一些：用户在弹窗里看到的就是书架上
   会变成的样子，比例不一致会让他以为「保存后封面会变形」。 */
.dr-edit-cover {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.dr-edit-cover-preview {
  flex: 0 0 auto;
  width: 84px;
}
.dr-edit-cover-actions {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.dr-field-hint {
  width: 100%;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
/* 表单里的错误提示：不走错误框，弹窗里空间小，一行红字更省地方 */
.dr-form-error {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary, #d93025);
}

/* 轻提示（保存成功之类）：飘在底部中间，两秒自己走，不挡点击 */
.dr-toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 60;
  padding: 8px 14px;
  border-radius: 999px;
  corner-shape: round;
  background: rgba(20, 22, 26, 0.86);
  color: #ffffff;
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
}

/* ── 空态 / 加载态 / 错误态 ───────────────────────────────────── */
.dr-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dr-state-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #5b6069);
}
.dr-state-text {
  font-size: 12.5px;
  line-height: 1.6;
  max-width: 34em;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  white-space: pre-wrap;
}
.dr-state-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.dr-error { color: var(--dsw-alias-state-error-primary, #d93025); }
.dr-error-box {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  margin: 0 0 12px;
  border-radius: var(--dsw-radius-md, 12px);
  border: 1px solid var(--dsw-alias-state-error-secondary, #f0c0bd);
  background: var(--dsw-alias-bg-layer-2, #fdf3f2);
  color: var(--dsw-alias-state-error-primary, #d93025);
  font-size: 12.5px;
  line-height: 1.55;
}
.dr-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  corner-shape: round;
  border: 2px solid var(--dsw-alias-border-l3, #d9d9e0);
  border-top-color: var(--dsw-alias-brand-primary, #4a7dff);
  animation: dr-spin 0.8s linear infinite;
}
@keyframes dr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dr-spinner { animation-duration: 2.4s; }
  .dr-book, .dr-btn { transition: none; }
}

/* ── 阅读器 ───────────────────────────────────────────────────── */
.dr-reader {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #f7f7f9);
}
.dr-reader-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dr-reader-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-reader-main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  position: relative;
}

/* 书籍视口：这里是唯一一个 iframe，装的是 EPUB 章节本身，不是插件页面。
   它必须看得见纸面质感，所以背景给一个偏暖的白，字色由章节 CSS 决定。 */
.dr-viewport {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dr-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}
/* 覆盖层：绝对定位于视口之上，pointer-events:none 保证正文选择不被挡住；
   需要点击的条目自己打开 pointer-events。 */
.dr-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.dr-hl {
  position: absolute;
  border-radius: var(--dsw-radius-xs, 4px);
  pointer-events: auto;
  cursor: pointer;
}
.dr-hl-note::after {
  content: "";
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-label-secondary, #5b6069);
}
/* 选中态：操作条打开的那条（或刚判为冲突的两条）描一圈。
   focus-visible 也走同一圈——键盘 Tab 过去要看得见焦点在哪。 */
.dr-hl:focus { outline: none; }
.dr-hl:hover,
.dr-hl:focus-visible,
.dr-hl-active {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
.dr-hl-conflict {
  outline: 2px solid var(--dsw-alias-label-secondary, #5b6069);
  outline-offset: 1px;
}
/* 操作条上的是刚点中的那个颜色：加一圈深色描边，别只靠色差暗示。 */
.dr-swatch-on {
  box-shadow: 0 0 0 2px var(--dsw-alias-label-primary, #22262b);
}
/* 删除是破坏性操作，用次要文字色而不是大红：阅读界面里红色太吵。 */
.dr-btn-danger { color: var(--dsw-alias-label-secondary, #5b6069); }
.dr-btn-danger:hover { color: var(--dsw-alias-label-primary, #22262b); }
/* 带「撤销」的 toast 得能点，所以单独放开 pointer-events（.dr-toast 默认不让点）。 */
.dr-toast-with-action { pointer-events: auto; }
.dr-toast-action {
  margin-left: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #8ab4ff);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

/* 翻页窄边：正文留白里的一条 26px 竖条，看得见、点得到。
   不用「盖在正文上的大块透明热区」——那会抢鼠标，划过字就误翻页。
   也不占正文宽度：它是 flex 里的独立一格，正文容器自己按剩余宽度重新分栏。 */
.dr-rail {
  flex: 0 0 auto;
  /* 抬到翻页热区（.dr-turn-zone, z-index:1）之上：热区是压在正文上的绝对定位块，
     它原本会盖住这两条窄边，让「点窄边翻页」时灵时不灵。 */
  position: relative;
  z-index: 3;
  width: 26px;
  border: 0;
  padding: 0;
  margin: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--dsh-reading-ink, #22262b);
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}
.dr-rail-chevron {
  font-size: 18px;
  line-height: 1;
  opacity: 0.22;
  transition: opacity 0.12s, transform 0.12s;
}
.dr-rail:hover .dr-rail-chevron { opacity: 0.7; transform: scale(1.18); }
.dr-rail:active .dr-rail-chevron { transform: scale(1.04); }
.dr-rail:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: -4px;
  border-radius: var(--dsw-radius-xs, 4px);
}
.dr-rail:disabled { cursor: default; }
.dr-rail:disabled .dr-rail-chevron { opacity: 0.08; transform: none; }

/* 翻页动效：只做「位置感」，不动 DOM、不碰选区。
   220ms 与 reader.js 里 flashTurn 的定时器对齐。 */
@keyframes dr-turn-next {
  from { opacity: 0.55; transform: translateX(14px); }
  to { opacity: 1; transform: none; }
}
@keyframes dr-turn-prev {
  from { opacity: 0.55; transform: translateX(-14px); }
  to { opacity: 1; transform: none; }
}
.dr-viewport.dr-turn-next .dr-frame { animation: dr-turn-next 0.22s ease-out both; }
.dr-viewport.dr-turn-prev .dr-frame { animation: dr-turn-prev 0.22s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .dr-viewport.dr-turn-next .dr-frame,
  .dr-viewport.dr-turn-prev .dr-frame { animation: none; }
}

.dr-pageinfo {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  border-top: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-base, #ffffff);
}

/* ── 目录 / 标注侧栏（面板 R28 只给真正的外壳用） ──────────────── */
.dr-side {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-base, #ffffff);
  overflow: hidden;
}
.dr-side-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #5b6069);
}
.dr-side-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
}

/* 目录行：控件级 R12；缩进按 depth 给，不用嵌套列表（深度只有几级，够了） */
.dr-toc-row {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 5px 9px;
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.45;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dr-toc-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-toc-row[aria-current="true"] {
  background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-weight: 600;
}
.dr-toc-row:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: -2px;
}

/* 「自动识别」的说明条：目录是猜出来的时候，先自报家门。
   用户看到这一句，才知道「章节名有点怪」不是我们弄坏了书。 */
.dr-toc-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 9px 8px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-size: 11.5px;
  line-height: 1.5;
}
.dr-toc-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  corner-shape: round;
  background: rgba(0, 0, 0, 0.06);
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.85;
  white-space: nowrap;
}
.dr-toc-note-text {
  min-width: 0;
}

/* 标注条目 */
.dr-ann {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  width: 100%;
  box-sizing: border-box;
  padding: 7px 8px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  text-align: left;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
}
.dr-ann:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  border-color: var(--dsw-alias-border-l2, #e6e6ea);
}
.dr-ann:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: -2px;
}
.dr-ann-dot {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  corner-shape: round;
}
.dr-ann-main { flex: 1 1 auto; min-width: 0; }
.dr-ann-text {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, #1f2328);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.dr-ann-note {
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.dr-ann-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-quaternary, #a8adb5);
}

/* ── 选区菜单（挂父窗口，避免被 iframe 裁切） ──────────────────── */
.dr-menu {
  position: fixed;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.97));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 8px 22px rgba(0, 0, 0, 0.12);
}
.dr-swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l3, #d9d9e0);
  border-radius: 50%;
  corner-shape: round;
  cursor: pointer;
}
.dr-swatch:hover { transform: scale(1.12); }
.dr-swatch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
.dr-menu-sep {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--dsw-alias-border-l2, #e6e6ea);
}

/* 笔记编辑小卡：对话框级别的浮层，用 panel 圆角 */
.dr-note-card {
  position: fixed;
  z-index: 41;
  width: 268px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 0;
  border-radius: var(--dsw-radius-panel, 28px);
  background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.98));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 10px 28px rgba(0, 0, 0, 0.16);
}
.dr-note-card .dr-textarea {
  border-radius: var(--dsw-radius-md, 12px);
  min-height: 64px;
}
.dr-note-actions { display: flex; justify-content: flex-end; gap: 6px; }

/* 顶部细进度条：阅读时一直看得见「读到哪了」 */
.dr-topbar {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: transparent;
  z-index: 4;
  pointer-events: none;
}
.dr-topbar-fill {
  height: 100%;
  background: var(--dsw-alias-brand-primary, #4a7dff);
  transition: width 0.2s;
}
/* ─────────────────────────────────────────────────────────────
   阅读器外观：纸面、底栏、设置抽屉、使用说明。
   纸色/墨色来自 reader.js 的四档配色，经内联 CSS 变量传进来
   （--dsh-reading-paper / --dsh-reading-ink / --dsh-reading-rule），缺省时回落到白纸。
   ───────────────────────────────────────────────────────────── */
.dr-reader {
  background: var(--dsh-reading-paper, #fcfbf8);
  color: var(--dsh-reading-ink, #22262b);
}
.dr-reader-bar {
  background: var(--dsh-reading-paper, #fcfbf8);
  border-bottom: 0.5px solid var(--dsh-reading-rule, #e6e2d8);
}
.dr-reader-title { color: var(--dsh-reading-ink, #22262b); }
.dr-reader-bar .dr-head-sub { color: var(--dsh-reading-ink, #22262b); opacity: 0.55; }
.dr-reader-bar .dr-btn-ghost { color: var(--dsh-reading-ink, #22262b); }
.dr-reader-bar .dr-iconbtn { color: var(--dsh-reading-ink, #22262b); }
.dr-reader-bar .dr-iconbtn:hover { background: rgba(128, 128, 128, 0.14); }
.dr-reader .dr-iconbtn-q {
  font-weight: 700;
  font-family: ui-serif, Georgia, serif;
}
.dr-viewport { background: var(--dsh-reading-paper, #fcfbf8); }
.dr-frame { background: var(--dsh-reading-paper, #fcfbf8); }
.dr-rail { color: var(--dsh-reading-ink, #22262b); }

/* 底栏：可见的「上一页 / 下一页」+ 页码 + 本章进度。只在鼠标移上来时才显形，
   读的时候不抢注意力；触屏设备（hover:none）常显。 */
.dr-pagebar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-top: 0.5px solid var(--dsh-reading-rule, #e6e2d8);
  background: var(--dsh-reading-paper, #fcfbf8);
  font-size: 11.5px;
  color: var(--dsh-reading-ink, #22262b);
  opacity: 0.72;
  transition: opacity 160ms ease;
}
.dr-reader:hover .dr-pagebar { opacity: 1; }
.dr-pagebtn {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 0.5px solid var(--dsh-reading-rule, #e6e2d8);
  background: rgba(128, 128, 128, 0.06);
  color: inherit;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.dr-pagebtn:hover:not(:disabled) { background: rgba(128, 128, 128, 0.16); }
.dr-pagebtn:disabled { opacity: 0.35; cursor: default; }
.dr-pagebtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff); outline-offset: 1px; }
.dr-pagebar-mid {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
}
.dr-pagebar-num {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  /* 从 <span> 改成 <button>：点它就能输入页码跳转，所以要抹掉浏览器默认按钮外观 */
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  background: transparent;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.dr-pagebar-num:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.dr-pagejump { display: inline-flex; align-items: baseline; gap: 4px; }
.dr-pagejump-input {
  width: 52px;
  padding: 1px 4px;
  border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  border-radius: var(--dsw-radius-xs, 4px);
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: inherit;
  font: inherit;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dr-pagejump-input::-webkit-outer-spin-button,
.dr-pagejump-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.dr-pagejump-input:focus { outline: 2px solid var(--dsh-reading-accent, #4a7dff); outline-offset: 1px; }
.dr-pagejump-hint { opacity: 0.6; white-space: nowrap; }
.dr-pagebar-pct { font-variant-numeric: tabular-nums; opacity: 0.6; white-space: nowrap; }
.dr-pagebar-track {
  flex: 0 1 220px;
  height: 3px;
  min-width: 60px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: rgba(128, 128, 128, 0.22);
  overflow: hidden;
}
.dr-pagebar-fill {
  height: 100%;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsh-reading-ink, #22262b);
  opacity: 0.42;
  transition: width 160ms ease;
}
@media (hover: none) {
  .dr-pagebar { opacity: 0.95; }
}

/* ── 设置抽屉：从右侧滑出，浮在正文之上 ─────────────────────── */
.dr-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 8;
  width: 292px;
  max-width: 88%;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  border-left: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.14);
  border-radius: var(--dsw-radius-xl, 20px) 0 0 var(--dsw-radius-xl, 20px);
  animation: dr-drawer-in 160ms ease-out;
}
@keyframes dr-drawer-in {
  from { transform: translateX(12px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.dr-drawer-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  font-size: 12.5px;
  font-weight: 600;
}
.dr-drawer-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dr-field { display: flex; flex-direction: column; gap: 8px; }
.dr-field-label {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  letter-spacing: 0.02em;
}
.dr-field-value {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-variant-numeric: tabular-nums;
  min-width: 42px;
  text-align: right;
}
.dr-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dr-chip {
  height: 28px;
  padding: 0 11px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 12px;
  cursor: pointer;
}
.dr-chip:hover { background: var(--dsw-alias-interactive-bg-hover, #e9eaee); }
.dr-chip.is-on {
  border-color: var(--dsw-alias-brand-primary, #4a7dff);
  color: var(--dsw-alias-brand-primary, #4a7dff);
  background: rgba(74, 125, 255, 0.1);
  font-weight: 600;
}
.dr-slider-row { display: flex; align-items: center; gap: 8px; }
.dr-slider {
  flex: 1 1 auto;
  min-width: 0;
  height: 3px;
  appearance: none;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-border-l2, #e6e6ea);
  outline: none;
}
.dr-slider::-webkit-slider-thumb {
  appearance: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-brand-primary, #4a7dff);
  border: 2px solid var(--dsw-alias-bg-base, #ffffff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24);
  cursor: pointer;
}
.dr-step {
  flex: 0 0 auto;
  height: 26px;
  min-width: 32px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 11.5px;
  cursor: pointer;
}
.dr-step:hover { background: var(--dsw-alias-interactive-bg-hover, #e9eaee); }
.dr-themes { display: flex; gap: 8px; }
.dr-theme {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 4px;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.dr-theme-swatch {
  width: 100%;
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 1px solid transparent;
  font-size: 15px;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.dr-theme.is-on .dr-theme-swatch { border-color: var(--dsw-alias-brand-primary, #4a7dff); }
.dr-theme-label {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dr-theme.is-on .dr-theme-label { color: var(--dsw-alias-brand-primary, #4a7dff); font-weight: 600; }
.dr-drawer-error {
  font-size: 11.5px;
  color: var(--dsw-alias-state-error-primary, #d93025);
}
.dr-drawer-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
}

/* ── 使用说明弹窗 ────────────────────────────────────────────── */
.dr-modal-mask {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}
.dr-modal {
  width: 100%;
  max-width: 560px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2328);
  border-radius: var(--dsw-radius-xl, 20px);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}
.dr-modal-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  font-size: 13px;
  font-weight: 600;
}
.dr-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--dsw-alias-label-secondary, #5b6069);
}
.dr-modal-body p { margin: 0 0 10px; }
.dr-modal-body h4 {
  margin: 16px 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-keys { display: flex; flex-direction: column; gap: 5px; }
.dr-key-row { display: flex; align-items: baseline; gap: 10px; }
.dr-key-row kbd {
  flex: 0 0 150px;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-modal-foot {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
}

@media (prefers-reduced-motion: reduce) {
  .dr-topbar-fill { transition: none; }
}

/* 窄容器：侧栏改为覆盖在正文上，避免正文被挤到 0 宽 */
@media (max-width: 720px) {
  .dr-side {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.16);
  }
  .dr-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  /* 窄栏里列宽本身就可能小于 200px，别再给上限，否则卡片两侧留空太宽 */
  .dr-book-cell { max-width: none; }
  .dr-body { padding: 12px; }
}

/* 宽栏：列再宽也把卡片钳住（else 一本占四分之一屏，封面大得离谱），
   格子居中留白，比让封面无限变大好看 */
@media (min-width: 1100px) {
  .dr-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
  .dr-book-cell { max-width: 184px; }
}

/* ── 问 AI：划词菜单里那个按钮 + 底部提问面板 ────────────────────── */

.dr-menu-ask {
  /* 五个色板之后第一个实心按钮，视觉上把「问 AI」和「选颜色」分开 */
  margin: 0 2px;
}

.dr-ask-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 40;
}

.dr-ask {
  width: 100%;
  max-height: 72%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 14px 12px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #22262b);
  border-radius: var(--dsw-radius-xl, 20px) var(--dsw-radius-xl, 20px) 0 0;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.18);
}

.dr-ask-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dr-ask-title {
  font-size: 13px;
  font-weight: 600;
}

.dr-ask-quote {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #6b7280);
  background: var(--dsw-alias-bg-layer-2, #f5f5f4);
  border-left: 2px solid var(--dsw-alias-accent-primary, #4a7dff);
  border-radius: var(--dsw-radius-xs, 4px);
  padding: 8px 10px;
  max-height: 4.9em;
  overflow: hidden;
}

.dr-ask-input {
  min-height: 56px;
  resize: vertical;
}

.dr-ask-answer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, #f5f5f4);
}

.dr-ask-answer-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary, #6b7280);
}

.dr-ask-answer-text {
  font-size: 13px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}

.dr-ask-answer-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
}

.dr-ask-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}


/* ── 书架筛选（0.5.1） ───────────────────────────────────────── */
.dr-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 0 10px;
}
.dr-filter-select {
  width: auto;
  min-width: 122px;
  height: 34px;
  padding: 7px 10px;
  font-size: 13.5px;
}
.dr-filters-count {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  margin-left: auto;
}
.dr-filter-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 56px 20px;
  color: var(--dsw-alias-label-secondary, #5c6270);
  font-size: 13px;
  text-align: center;
}
.dr-book-taxon {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dr-book-star {
  position: absolute;
  top: 6px;
  left: 8px;
  font-size: 13px;
  line-height: 1;
  color: #d9a520;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}

/* ── 元数据编辑与导入面板里的控件（0.5.1） ───────────────────── */
.dr-textarea {
  resize: vertical;
  min-height: 68px;
  line-height: 1.6;
  font-family: inherit;
}
.dr-select {
  width: auto;
  padding: 5px 8px;
}
.dr-field-inline {
  flex-direction: row;
  align-items: center;
}
.dr-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #1f2328);
  cursor: pointer;
}

/* ── 导入面板：本地文件 / 粘贴链接 / 找书（0.5.1） ───────────── */
.dr-import {
  width: min(560px, calc(100vw - 32px));
}
.dr-import .dr-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dr-import-section {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e3e5e8);
  border-radius: var(--dsw-radius-m, 8px);
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.dr-import-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-import-hint {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dr-import-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dr-import-error {
  font-size: 11.5px;
  color: var(--dsw-alias-label-error, #c4342b);
}
.dr-import-linkbtn {
  align-self: flex-start;
  font-size: 12px;
}
.dr-candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}
.dr-candidate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-s, 6px);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
}
.dr-candidate-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-source-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 6px;
  border-top: 1px dashed var(--dsw-alias-border-l1, #e3e5e8);
}

/* 窄屏：筛选栏与导入面板都退化成单列 */
@media (max-width: 720px) {
  .dr-filters {
    gap: 6px;
  }
  .dr-filter-select {
    flex: 1 1 40%;
  }
  .dr-filters-count {
    margin-left: 0;
  }
  .dr-import {
    width: calc(100vw - 16px);
  }
  .dr-import-row {
    flex-direction: column;
    align-items: stretch;
  }
}
`

/**
 * v0.6.0 追加样式块。
 *
 * 为什么单独成一个常量：这一版加的东西彼此无关（高亮配色、菜单紧凑化、目录强调、
 * 翻页热区、搜索/笔记/问答三块面板、相对单位替换），混进上面那份 1500 行的 CSS 里
 * 以后没人找得到。集中一块 + 拼在末尾（后写覆盖先写），既好读也好回滚。
 *
 * 三条自家规矩照旧：只消费 --dsw-alias-* 语义 token 与 --dsw-radius-* 圆角 token，
 * 每个 var() 都带 fallback，不写主题分支（纸面主题除外，见 A 段的说明）。
 * 全文一律不用 oklch 色彩函数：纸面与高亮都留在 sRGB，老 WebView 也认。
 */
const CSS_V060 = `
/* ═══════════════════ A. 高亮五色跟随纸面主题 ═══════════════════
   问题：HIGHLIGHT_COLORS 的五色是固定浅色 rgba，叠在夜间纸面上会把浅灰正文洗掉，
   「划了哪一句」看得见、字却看不见。

   做法：把「填色 + 描边」提升成组件变量，亮/暗各一套。
   兜底：默认值就是 HIGHLIGHT_COLORS 里的原值 —— 变量缺失时观感与改动前完全一致。

   ⚠ 选择器说明（这里曾经想写 .dr-page[data-theme="night"]，但实测不成立）：
     · 全仓 grep：没有任何 data-theme 属性（0 处），也没有 .dr-page 这个节点。
     · 纸面主题的真实机制是：reader.js 在 .dr-reader 上内联
       --dsh-reading-paper / --dsh-reading-ink / --dsh-reading-rule，
       主题键来自 reader.js 的 THEMES：light / sepia / green / dark。
     · 所以钩子挂在 .dr-reader 上，夜间按真实键写 [data-theme="dark"]，
       再留一个 night 别名（等上层哪天改用 night 命名时不用再改样式）。
   这两条夜间规则在 .dr-reader 拿到 data-theme 之前不会匹配，等于死规则；
   死规则不进层叠、不影响任何现有渲染，但要让夜间配色真的生效，
   需要 reader.js 补一行 data-theme（不属本次改动范围）。
   ─────────────────────────────────────────────────────────────── */
.dr-reader,
.dr-root {
  /* 亮色纸面：浅底 + 深字，与 HIGHLIGHT_COLORS 的观感对齐 */
  --dsh-reading-hl-yellow: rgba(255, 214, 64, 0.38);
  --dsh-reading-hl-green: rgba(64, 200, 120, 0.34);
  --dsh-reading-hl-blue: rgba(74, 158, 255, 0.32);
  --dsh-reading-hl-pink: rgba(255, 122, 168, 0.34);
  --dsh-reading-hl-purple: rgba(168, 122, 255, 0.32);
  --dsh-reading-hl-yellow-underline: rgba(214, 168, 0, 0.85);
  --dsh-reading-hl-green-underline: rgba(24, 148, 76, 0.85);
  --dsh-reading-hl-blue-underline: rgba(28, 108, 208, 0.85);
  --dsh-reading-hl-pink-underline: rgba(206, 62, 118, 0.85);
  --dsh-reading-hl-purple-underline: rgba(118, 68, 208, 0.85);
}

/* 夜间纸面：深底 + 亮描边。
   底色的 alpha 刻意压到 0.55 上下 —— 覆盖层压在字上，太实就把 #c9cdd3 的正文盖住了；
   描边提亮到纯色，靠那一条线把「划到哪」交代清楚，而不是靠整块发光。 */
.dr-reader[data-theme="dark"],
.dr-reader[data-theme="night"],
.dr-root[data-theme="dark"],
.dr-root[data-theme="night"] {
  --dsh-reading-hl-yellow: rgba(122, 92, 0, 0.55);
  --dsh-reading-hl-green: rgba(16, 92, 56, 0.55);
  --dsh-reading-hl-blue: rgba(20, 66, 132, 0.6);
  --dsh-reading-hl-pink: rgba(122, 28, 66, 0.55);
  --dsh-reading-hl-purple: rgba(78, 44, 132, 0.55);
  --dsh-reading-hl-yellow-underline: #ffd640;
  --dsh-reading-hl-green-underline: #4ad98a;
  --dsh-reading-hl-blue-underline: #6aa9ff;
  --dsh-reading-hl-pink-underline: #ff8fbb;
  --dsh-reading-hl-purple-underline: #b493ff;
}

/* 变量优先。为什么必须 !important：划线的颜色现在是 annotate.js 用内联
   style.background / boxShadow 写的（annotate.js:755），内联样式的优先级高于任何
   类选择器，不加 !important 这条规则永远输。
   生效条件：annotate.js 给盒子补一个 dr-hl-<color> 类名（类名与 HIGHLIGHT_ORDER
   一一对应）。在那之前这些规则不匹配任何节点，是纯粹的「备好的接口」，不会改坏现有颜色。 */
.dr-hl-yellow {
  background: var(--dsh-reading-hl-yellow, rgba(255, 214, 64, 0.38)) !important;
  box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-yellow-underline, rgba(214, 168, 0, 0.85)) !important;
}
.dr-hl-green {
  background: var(--dsh-reading-hl-green, rgba(64, 200, 120, 0.34)) !important;
  box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-green-underline, rgba(24, 148, 76, 0.85)) !important;
}
.dr-hl-blue {
  background: var(--dsh-reading-hl-blue, rgba(74, 158, 255, 0.32)) !important;
  box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-blue-underline, rgba(28, 108, 208, 0.85)) !important;
}
.dr-hl-pink {
  background: var(--dsh-reading-hl-pink, rgba(255, 122, 168, 0.34)) !important;
  box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-pink-underline, rgba(206, 62, 118, 0.85)) !important;
}
.dr-hl-purple {
  background: var(--dsh-reading-hl-purple, rgba(168, 122, 255, 0.32)) !important;
  box-shadow: inset 0 -1px 0 var(--dsh-reading-hl-purple-underline, rgba(118, 68, 208, 0.85)) !important;
}

/* 划线盒子抬到 D 段翻页热区（.dr-turn-zone，z-index:1）之上：
   正文最底下两行的划线正好落在热区范围里，不提层级就点不动了。
   .dr-overlay 自己没有 z-index（不是层叠上下文），所以这里直接比大小是有效的。 */
.dr-hl { z-index: 2; }

/* ═══════════════════ B. 划词小窗更紧凑 ═══════════════════
   现状：选区菜单的节点是 .dr-menu，靠「子节点里有 5 个 .dr-swatch」认出来
   （annotate.js:886；.dr-selmenu 只出现在 app.js 的 KEEP 名单里，没有节点用它）。
   所以不能直接把 .dr-menu 收窄 —— 同一个类还挂着划线操作条（.dr-ann-menu）。
   用 :has() 精确圈住「带色板的那一个」，别的手法都会误伤。
   目标：总宽 ≤ 240px、五个色点一行、三个按钮 ≤12px 不换行。
   数字是量出来的：子项全是 flex: 0 0 auto，压不动，max-width 只是天花板，
   内容超了照样把菜单撑出去（实测 240px 上限被顶到 248px）。
   现在 5 色点(16) + 4 个按钮 + 9 个间隙(2px) 合计 ≈ 227px，留 13px 余量。 */
.dr-menu:has(> .dr-swatch) {
  max-width: 240px;
  gap: 2px;
  padding: 3px;
  border-radius: var(--dsw-radius-md, 12px);
  flex-wrap: nowrap;
}
.dr-menu:has(> .dr-swatch) > .dr-swatch {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
}
.dr-menu:has(> .dr-swatch) > .dr-menu-sep {
  height: 14px;
  margin: 0 1px;
}
.dr-menu:has(> .dr-swatch) > .dr-btn {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 5px;
  font-size: 11px;
}
.dr-menu:has(> .dr-swatch) > .dr-menu-ask {
  margin: 0;
}
/* 窄屏：一行塞不下就换行，但按钮得变宽 —— 手指点不中 22px 高的细条。 */
@media (max-width: 520px) {
  .dr-menu:has(> .dr-swatch) {
    max-width: min(240px, calc(100vw - 12px));
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .dr-menu:has(> .dr-swatch) > .dr-btn {
    flex: 1 1 auto;
    min-width: 52px;
  }
}

/* ═══════════════════ C. 目录「当前章」更醒目 ═══════════════════
   目录行是整行的按钮，光靠底色区分「现在读到哪一章」在侧栏里太弱。
   补一条 3px 左侧强调竖条（box-shadow 画，不占宽度、不改 padding 计算）
   + 稍重一点的底色，形成「选中条」的形状记忆。
   结构里没有小圆点（toc.js 的目录行只有文字 + 缩进），所以不造 .dr-toc-dot。 */
.dr-toc-row[aria-current="true"] {
  background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary, #4a7dff);
}
.dr-toc-row[aria-current="true"]:hover {
  background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
}
/* 「共 N 章 · 当前第 M 章」：说明性小字，别和章节名抢注意力 */
.dr-toc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 9px 6px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-size: 11px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

/* ═══════════════════ D. 页面底部的大翻页热区 ═══════════════════
   左右翻页条（.dr-rail）细，摸鱼式阅读时鼠标够不着。底部再给两块大热区：
   左右各 34% 宽、18% 高，静默透明，hover 才浮出 ‹ / ›。
   相对单位（%）而不是 px：热区跟视口一起缩放，缩放窗口后不会缩成一条缝。

   注意：reader.js 现在在渲染时也内联写了同一组几何值（position/bottom/left/
   width/height）和 opacity，内联优先，所以这一段主要是「hover 才浮出」的行为
   与没有内联时的兜底尺寸 —— 两边数字要保持一致（34% / 18%）。
   禁用态用的是原生 disabled 属性，不是类名，所以 :disabled 与 .is-disabled 都写。 */
.dr-turn-zone {
  position: absolute;
  bottom: 0;
  z-index: 1;
  width: 34%;
  height: 18%;
  display: flex;
  align-items: flex-end;
  padding: 0 8px 10px;
  border: 0;
  background: transparent;
  color: var(--dsh-reading-ink, #22262b);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.14s ease;
}
.dr-turn-zone-prev { left: 0; justify-content: flex-start; }
.dr-turn-zone-next { left: auto; right: 0; justify-content: flex-end; }
/* 桌面（精确指针）上把热区收窄到两侧 16%、贴边放箭头：
   34% 宽的热区在宽屏上会伸到正文右端下方，鼠标停在那里时那层淡灰底和 24px 的
   「›」正好压住正文最后几个字（用户报的就是这个）。手机上拇指够不着窄边，
   所以 34% 只在触屏（hover:none）保留。 */
@media (hover: hover) and (pointer: fine) {
  /* 桌面上干脆不要这两块热区：它们压在正文最后两行上，鼠标滑到页底时会盖住字。
     桌面翻页本来就有三条路——两侧窄边（.dr-rail）、键盘、滚轮/触控板，不缺这一条。
     触屏（hover:none）仍然保留 34% 的大热区，那是拇指唯一够得着的地方。 */
  .dr-turn-zone { display: none; }
  .dr-turn-zone { width: 16%; }
  .dr-turn-zone-next { padding-right: 2px; }
  .dr-turn-zone-prev { padding-left: 2px; }
  .dr-turn-zone:hover { background: transparent; }
  .dr-turn-zone-chevron { font-size: 18px; }
}
.dr-turn-zone:hover { background: rgba(128, 128, 128, 0.07); }
.dr-turn-zone:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: -3px;
}
.dr-turn-zone-chevron {
  font-size: 24px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.dr-turn-zone:hover .dr-turn-zone-chevron,
.dr-turn-zone:focus-visible .dr-turn-zone-chevron { opacity: 0.5; }
.dr-turn-zone-prev:hover .dr-turn-zone-chevron { transform: translateX(-2px); }
.dr-turn-zone-next:hover .dr-turn-zone-chevron { transform: translateX(2px); }
/* 翻到头/翻到第一页：热区留着位置但不可点，淡淡地退场 */
.dr-turn-zone.is-disabled,
.dr-turn-zone:disabled {
  pointer-events: none;
  cursor: default;
  opacity: 0.25;
}
/* 用户的系统设置里开了「减少动效」就别做浮出动画 */
@media (prefers-reduced-motion: reduce) {
  .dr-turn-zone,
  .dr-turn-zone-chevron { transition: none; }
}

/* ═══════════════════ E. 书内搜索面板 ═══════════════════
   结构与 client/src/search.js 对齐（类名一字未改），这里只管长相。
   面板本身是右边栏里的一张卡：竖向 flex + min-height:0，
   否则长结果列表会把整张卡撑出容器、把输入框顶出可视区。
   纯白底不跟纸面走：搜索是「工具界面」，不是正文。 */
.dr-search-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dr-search-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dr-search-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-search-close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.dr-search-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-search-close:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
.dr-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dr-search-input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
  border-radius: var(--dsw-radius-md, 12px);
  padding: 6px 9px;
}
.dr-search-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #4a7dff);
}
.dr-search-go {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 10px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-button-primary-fill, #4a7dff);
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
  font-family: inherit;
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: background 0.12s;
}
.dr-search-go:hover { background: var(--dsw-alias-button-primary-hover, #3d6ded); }
.dr-search-go:disabled { opacity: 0.45; cursor: not-allowed; }
.dr-search-go:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
.dr-search-status {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #5b6069);
}
.dr-search-status.is-error { color: var(--dsw-alias-state-error-primary, #d93025); }
/* 结果列表必须自己滚：父级是竖向 flex，不给 overflow 就撑破面板 */
.dr-side-body.dr-search-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0;
}
.dr-search-hit {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 8px 6px;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}
.dr-search-hit:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); }
.dr-search-hit[aria-selected="true"] {
  background: var(--dsw-alias-interactive-bg-active, #e8ebf2);
}
.dr-search-hit:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: -2px;
}
.dr-search-hit-chapter {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-search-hit-snippet {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #5b6069);
}
/* 命中词：强调色底、不加圆角 —— 圆角会让它在两行截断里像个小药丸，太吵 */
.dr-search-hit-snippet mark {
  background: rgba(74, 125, 255, 0.18);
  color: inherit;
  border-radius: var(--dsw-radius-none, 0);
  padding: 0 1px;
}
.dr-search-hit-pos {
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-variant-numeric: tabular-nums;
}

/* ═══════════════════ F. 笔记面板：搜索 / 筛选 / 时间线分组 ═══════════════════
   笔记一多，找一条要滚很久：先给搜索框，再给筛选 chips，最后按时间分组。
   视觉上一律比正文轻一档 —— 这是工具区，不是阅读区。 */
.dr-note-search {
  box-sizing: border-box;
  width: 100%;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 0.5px solid var(--dsw-alias-border-l3, #d9d9e0);
  border-radius: var(--dsw-radius-md, 12px);
  padding: 6px 9px;
}
.dr-note-search:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #4a7dff);
}
.dr-facet-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* 只圈 .dr-facet-chips 里的 chip：设置面板里还有一组 .dr-chip（28px、8px 圆角、
   .is-on 态），那是滑杆旁边的选择器，不该被笔记筛选的 pill 形状带跑。 */
.dr-facet-chips .dr-chip {
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  corner-shape: round;
  border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.dr-facet-chips .dr-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover, #e9eaee);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-facet-chips .dr-chip[aria-pressed="true"] {
  border-color: var(--dsw-alias-brand-primary, #4a7dff);
  background: rgba(74, 125, 255, 0.12);
  color: var(--dsw-alias-brand-primary, #4a7dff);
  font-weight: 600;
}
.dr-note-group { margin-top: 14px; }
.dr-note-group:first-child { margin-top: 4px; }
/* 分组标题：「今天 / 本周 / 更早」这种时间标签，小字距 + 大写让它在列表里像分隔符 */
.dr-note-group-head {
  margin: 0 0 4px;
  padding: 0 2px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dr-note-time {
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
/* 笔记条目：行距收紧一档，让一屏多看到两三条；左右 padding 用相对单位跟栏宽一起缩 */
.dr-note-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  box-sizing: border-box;
  padding: 6px clamp(8px, 1%, 14px);
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md, 12px);
  line-height: 1.45;
  text-align: left;
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}
.dr-note-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  border-color: var(--dsw-alias-border-l2, #e6e6ea);
}
.dr-note-item:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: -2px;
}
/* 右侧操作按钮默认藏起来：一屏十几条笔记，每条都挂三个按钮会变成一片图标墙。
   鼠标悬停或键盘聚焦到条目时才显形；触屏没有 hover，就让它常显。 */
.dr-note-item .dr-note-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.dr-note-item:hover .dr-note-actions,
.dr-note-item:focus-within .dr-note-actions { opacity: 1; }
@media (hover: none) {
  .dr-note-item .dr-note-actions { opacity: 1; transition: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dr-note-item .dr-note-actions { transition: none; }
}

/* ═══════════════════ G. 问答面板：滚动区 / 上下按钮 / 快捷键提示 ═══════════════════
   问答回答可能很长，容器必须是「自己滚」而不是「把面板撑长」；
   overscroll-behavior 防止滚到底继续滚时把整页带着跳。 */
.dr-qa-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
/* 右下角竖排两个圆按钮：不占正文宽度，浮在滚动区上；容器本身不接收事件，
   只有按钮接收，否则滚动区右下的文字会被一块透明层挡住选不了。 */
.dr-scroll-btns {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.dr-scroll-btn {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  border: 0.5px solid var(--dsw-alias-border-l2, #e6e6ea);
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.94));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, opacity 0.12s;
}
.dr-scroll-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f2f3f5);
  color: var(--dsw-alias-label-primary, #1f2328);
}
.dr-scroll-btn:disabled { opacity: 0.35; cursor: default; }
.dr-scroll-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff);
  outline-offset: 1px;
}
/* Shift+滚轮 提示：键盘键帽的观感，等宽字体 + 1px 边框 + 4px 圆角，
   让人一眼看出「这是个可以按的键」，而不是正文里的英文单词。 */
.dr-keyhint {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2, #e6e6ea);
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  color: var(--dsw-alias-label-secondary, #5b6069);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}
.dr-keyhint kbd {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
}

/* ═══════════════════ H. 测量用的固定像素 → 相对单位 ═══════════════════
   翻页条、正文留白、侧栏宽度都是「跟着视口走」的尺寸，写死 px 在放大窗口后
   会显得又窄又空。换成 clamp(min, 百分比, max)：两头都有闸，中间随窗口伸缩。
   clamp 的下界保证不塌（缩到最小也有 18px 可点、8px 留白）。 */
.dr-rail {
  width: clamp(18px, 2.4%, 40px);
}
.dr-reader-main {
  padding-left: clamp(8px, 1.2%, 24px);
  padding-right: clamp(8px, 1.2%, 24px);
}
/* 侧栏：优先用拖拽后的宽度（reader.js 内联的 --dsh-reading-side-width），
   没有就用相对宽度兜底。之前这个内联变量根本没被消费，等于白设。 */
.dr-side {
  width: var(--dsh-reading-side-width, clamp(248px, 26%, 380px));
  max-width: 100%;
}
/* 窄容器下侧栏是覆盖层（见上文 @media 720px），26% 会窄到放不下章节名，
   改用「最多 88%」的比例，同时仍受 380px 上界约束。 */
@media (max-width: 720px) {
  .dr-side {
    width: var(--dsh-reading-side-width, clamp(232px, 78%, 380px));
    max-width: 88%;
  }
}
`

/**
 * 移动端（0.7.0）：手机上真正要解决的不是「字小」，而是三件事 ——
 * ① 两侧 26px 的翻页窄边在 390px 屏上占 13%，正文被挤成细条；
 * ② 手指没有 hover，所有「鼠标划过才出现」的东西等于不存在；
 * ③ 刘海屏与底部小白条会盖住工具栏和页码行。
 * 所以这里做的是：窄屏隐藏窄边、热区放大到拇指区、工具栏压缩成图标、
 * 侧栏改成整屏抽屉、四周补 safe-area 内边距。
 */
const CSS_MOBILE = `
@media (max-width: 720px) {
  /* 窄边占地太贵：手机上用「点左三分之一 / 右三分之一」和左右滑动翻页，
     窄边整体退场（保留 DOM，键盘与读屏仍然能用）。 */
  .dr-rail { display: none; }

  /* 翻页热区：底部 42% 高、左右各 45%，中间留 10% 不接手势以免和划词抢。 */
  .dr-turn-zone { width: 45%; height: 42%; }
  .dr-turn-zone-chevron { opacity: 0.35; font-size: 20px; }

  /* 正文留白：窄屏上 44px 是奢侈，收到 18px。 */
  .dr-viewport { padding: 16px 18px !important; }

  /* 工具栏：按钮多，窄屏不换行而是横向滚动（隐藏滚动条），
     高度压到 44px、触摸目标不小于 40px —— 手指点得到比看得全重要。 */
  .dr-reader-bar {
    padding: 0 6px;
    min-height: 44px;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dr-reader-bar::-webkit-scrollbar { display: none; }
  .dr-btn, .dr-iconbtn {
    flex: 0 0 auto;
    min-width: 40px;
    min-height: 38px;
    padding: 0 10px;
    font-size: 12.5px;
  }

  /* 页码行：贴住底部小白条之上 */
  .dr-pagebar { padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px)); }

  /* 侧栏抽屉：整屏宽，从右侧滑入；顶部吃进刘海高度。 */
  .dr-side {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 20;
    width: 92% !important;
    max-width: 92% !important;
    padding-top: env(safe-area-inset-top, 0px);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
  }

  /* 划词小窗与问 AI 面板：贴底，避开小白条 */
  .dr-menu { max-width: calc(100vw - 16px); }
  .dr-ask { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
}

/* 触摸设备上，凡是「hover 才出现」的东西都要常态可见或干脆不出现。 */
@media (hover: none) {
  .dr-rail-chevron { opacity: 0.5; }
  .dr-turn-zone-chevron { opacity: 0.35; }
  .dr-turn-zone:hover { background: transparent; }
}

/* 横屏手机：高度很小，底部热区会让正文只剩一条，直接改回窄条。 */
@media (max-height: 460px) {
  .dr-turn-zone { height: 22%; }
}
`

/** AI 状态面板样式（0.8.0）。单独一段，方便一眼看出这一版加了什么。 */
export const CSS_AI = `
/* ── AI 状态与账本（0.8.0）────────────────────────────────────────
 * 用户的原话：一没网或者模型供应商出问题就莫名其妙不能用了，只能一遍遍重试。
 * 所以这里只做「说清楚」：点、色、一行字。不加动画，不抢视线。
 */
.dr-ai-dot {
  display: inline-block;
  corner-shape: round;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-quaternary, #8a8a8a);
  flex: none;
}
.dr-ai-entry { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; }
.dr-ai-entry-ok .dr-ai-dot { background: #2f9e5f; }
.dr-ai-entry-warn .dr-ai-dot { background: #d79315; }
.dr-ai-entry-fail .dr-ai-dot { background: #d24338; }
.dr-ai-entry-warn { color: #b87908; }
.dr-ai-entry-fail { color: #c0392b; }

.dr-ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
}
.dr-ai-chip:hover { background: rgba(0, 0, 0, 0.04); }
.dr-ai-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-ai-chip-ok .dr-ai-dot { background: #2f9e5f; }
.dr-ai-chip-warn .dr-ai-dot { background: #d79315; }
.dr-ai-chip-fail .dr-ai-dot { background: #d24338; }
.dr-ai-chip-fail { border-color: rgba(210, 67, 56, 0.5); color: #c0392b; }

.dr-ai-panel { display: flex; flex-direction: column; gap: 12px; padding: 2px 12px 14px; overflow: auto; }
.dr-ai-head { display: flex; flex-direction: column; gap: 5px; }

/* 模型与强度（0.8.1）：两行下拉 + 一行「实际使用」。
 * 下拉宽度铺满，因为模型名很长（provider/model），窄了只能看到一半。 */
.dr-ai-models { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.07); }
.dr-ai-field { display: flex; flex-direction: column; gap: 3px; }
.dr-ai-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #777); }
.dr-ai-effective { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #777); }

.dr-ai-headline { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
.dr-ai-hint { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #777); }
.dr-ai-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.dr-ai-section { display: flex; flex-direction: column; gap: 7px; }
.dr-ai-section-title {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #777);
}
.dr-ai-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dr-ai-check {
  display: grid;
  grid-template-columns: 14px 1fr;
  gap: 2px 6px;
  font-size: 12px;
  line-height: 1.45;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: rgba(0, 0, 0, 0.03);
}
.dr-ai-check.is-bad { background: rgba(210, 67, 56, 0.09); }
.dr-ai-check-mark { font-weight: 700; }
.dr-ai-check.is-ok .dr-ai-check-mark { color: #2f9e5f; }
.dr-ai-check.is-bad .dr-ai-check-mark { color: #c0392b; }
.dr-ai-check-title { font-weight: 600; }
.dr-ai-check-detail { grid-column: 2; color: var(--dsw-alias-label-secondary, #777); font-size: 11.5px; }
.dr-ai-check-fix { grid-column: 2; color: #b87908; font-size: 11.5px; }

.dr-ai-recent { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #777); display: flex; flex-wrap: wrap; gap: 6px; }
.dr-ai-code { font-size: 10.5px; padding: 1px 4px; border-radius: var(--dsw-radius-sm, 4px); background: rgba(0, 0, 0, 0.06); }
.dr-ai-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.dr-ai-row {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 2px 8px;
  font-size: 11.5px;
  padding: 4px 6px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: rgba(0, 0, 0, 0.02);
}
.dr-ai-row.is-bad { background: rgba(210, 67, 56, 0.07); }
.dr-ai-row-time { color: var(--dsw-alias-label-secondary, #777); font-variant-numeric: tabular-nums; }
.dr-ai-row-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-ai-row-detail { grid-column: 2; color: var(--dsw-alias-label-secondary, #777); font-size: 11px; word-break: break-word; }
.dr-ai-row.is-bad .dr-ai-row-detail { color: #c0392b; }
.dr-ai-foot { font-size: 10.5px; color: var(--dsw-alias-label-quaternary, #8a8a8a); word-break: break-all; }
`

/** 读书蒸馏面板样式（0.8.0）。 */
export const CSS_DISTILL = `
/* ── 读书蒸馏（0.8.0）────────────────────────────────────────────
 * 一章一行，行内就是「蒸 / 重蒸 / 读原文」三个动作。不做树状嵌套：
 * 一本书几十章，树一层就把面板撑爆了。
 */
.dr-distill-entry { display: inline-flex; align-items: center; gap: 5px; }
.dr-dist-panel { display: flex; flex-direction: column; gap: 10px; padding: 2px 12px 14px; overflow: auto; }
.dr-dist-head { display: flex; flex-direction: column; gap: 8px; }
.dr-dist-progress { font-size: 12px; font-weight: 600; }
.dr-dist-sub { font-weight: 400; color: var(--dsw-alias-label-secondary, #777); }
.dr-dist-failed { color: var(--dsw-alias-label-error, #c0392b); }
.dr-dist-note {
  font-size: 11.5px;
  line-height: 1.5;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: rgba(0, 0, 0, 0.04);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dr-dist-note-bad { background: rgba(210, 67, 56, 0.09); color: var(--dsw-alias-label-error, #c0392b); }
.dr-dist-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dr-dist-toast { margin: 0 12px 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #777); }
.dr-dist-skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: rgba(0, 0, 0, 0.035);
}
.dr-dist-skeleton-title { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #777); }
.dr-dist-skeleton-line { font-size: 12.5px; font-weight: 600; }
.dr-dist-skeleton-row { display: grid; grid-template-columns: 52px 1fr; gap: 6px; font-size: 11.5px; }
.dr-dist-skeleton-row > span { color: var(--dsw-alias-label-secondary, #777); }
.dr-dist-skeleton-row p { margin: 0; line-height: 1.55; }
.dr-dist-list { display: flex; flex-direction: column; gap: 6px; }
.dr-dist-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: rgba(0, 0, 0, 0.025);
}
.dr-dist-row-done { background: rgba(47, 158, 95, 0.06); }
.dr-dist-row-failed { background: rgba(210, 67, 56, 0.07); }
.dr-dist-row-head { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.dr-dist-row-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.dr-dist-badge { font-size: 10.5px; padding: 1px 5px; border-radius: var(--dsw-radius-sm, 4px); background: rgba(0, 0, 0, 0.07); }
.dr-dist-row-error { font-size: 11px; color: var(--dsw-alias-label-error, #c0392b); }
.dr-dist-detail { display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; }
.dr-dist-thesis { font-weight: 600; line-height: 1.5; }
.dr-dist-points { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; }
.dr-dist-points .is-unverified .dr-dist-point-claim { text-decoration: line-through; opacity: 0.7; }
.dr-dist-quote { display: block; margin-top: 2px; color: var(--dsw-alias-label-secondary, #777); font-style: italic; }
.dr-dist-warn { margin-left: 4px; color: var(--dsw-alias-label-error, #c0392b); }
.dr-dist-terms { margin: 0; display: flex; flex-direction: column; gap: 3px; }
.dr-dist-term { display: grid; grid-template-columns: 72px 1fr; gap: 6px; }
.dr-dist-term dt { font-weight: 600; }
.dr-dist-term dd { margin: 0; color: var(--dsw-alias-label-secondary, #777); }
.dr-dist-methods { display: flex; flex-direction: column; gap: 6px; }
.dr-dist-method {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-left: 2px solid var(--dsw-alias-brand-primary, #4a7);
  background: rgba(0, 0, 0, 0.025);
  border-radius: var(--dsw-radius-sm, 4px);
}
.dr-dist-method-name { font-weight: 600; }
.dr-dist-method-when, .dr-dist-method-check { color: var(--dsw-alias-label-secondary, #777); }
.dr-dist-steps { margin: 0; padding-left: 16px; }
.dr-dist-foot { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-quaternary, #8a8a8a); }
`


/**
 * 书架上的大按钮（0.9.0）。
 *
 * 「全部书籍 / 书源 / 导入图书」这三个是书架的入口，按基础按钮的 28px 高太挤，
 * 鼠标要瞄着点。抬到 34px，字号跟着上一档 —— 放大是为了好点，不是为了好看。
 */
export const CSS_SHELF_BUTTONS = `
.dr-btn.dr-btn-lg {
  height: 34px;
  padding: 0 14px;
  font-size: 13.5px;
}
.dr-filters-btn {
  height: 34px;
  padding: 0 14px;
  font-size: 13.5px;
  margin-left: auto;
}
@media (max-width: 720px) {
  .dr-filter-select,
  .dr-btn.dr-btn-lg,
  .dr-filters-btn { height: 40px; font-size: 14.5px; }
  .dr-filter-select { min-width: 0; flex: 1 1 130px; }
  .dr-filters-btn { margin-left: 0; flex: 1 1 auto; }
}
`

/** 阅读设置里的分组标题（0.9.0）。 */
export const CSS_SETTINGS_GROUPS = `
.dr-set-group {
  margin: 14px 0 6px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-line-tertiary, #e7e4dd);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.dr-set-group:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
`

/**
 * 书源面板（0.9.0）。
 *
 * 沿用现有弹窗与按钮的观感，不引入新颜色。列表行是「左信息右动作」的两列，
 * 名字一行、来源与作者一行、最新章节一行，扫视的时候从粗到细。
 */
export const CSS_LEGADO = `
.dr-filters-btn { margin-left: auto; }
.dr-legado-modal { align-items: center; justify-content: center; }
.dr-legado-card {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dr-tabs {
  display: flex;
  gap: 4px;
  padding: 0 16px;
  border-bottom: 1px solid var(--dsw-alias-line-tertiary, #e7e4dd);
}
.dr-tab {
  appearance: none;
  border: 0;
  background: none;
  padding: 9px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #5b6069);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.dr-tab.is-on {
  color: var(--dsw-alias-label-primary, #22262b);
  border-bottom-color: var(--dsw-alias-brand-primary, #4a7);
  font-weight: 600;
}
.dr-legado-body {
  padding: 14px 16px 18px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dr-legado-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dr-legado-row .dr-input { flex: 1 1 220px; min-width: 0; }
.dr-legado-textarea {
  width: 100%;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
}
.dr-legado-file { position: relative; overflow: hidden; cursor: pointer; }
.dr-legado-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.dr-legado-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dr-legado-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-line-tertiary, #e7e4dd);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-primary, #fff);
}
.dr-legado-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dr-legado-name { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary, #22262b); }
.dr-legado-meta {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #5b6069);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-legado-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-legado-item .dr-btn { flex: 0 0 auto; align-self: center; }
.dr-legado-failures { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #5b6069); }
.dr-legado-failures ul { margin: 6px 0 0; padding-left: 18px; }
.dr-note-ok {
  color: var(--dsw-alias-label-primary, #22262b);
  border-left: 2px solid var(--dsw-alias-brand-primary, #4a7);
  padding-left: 8px;
}
.dr-note-error {
  color: var(--dsw-alias-label-primary, #22262b);
  border-left: 2px solid #c0392b;
  padding-left: 8px;
}
@media (max-width: 720px) {
  .dr-legado-card { width: 100vw; max-height: 100vh; border-radius: var(--dsw-radius-none, 0); }
  .dr-legado-item { flex-direction: column; align-items: stretch; }
  .dr-legado-item .dr-btn { width: 100%; }
}
`

/**
 * 取整份 CSS 文本（用于测试和调试；正常渲染走 ensureStyle）。
 * 拼接顺序有语义：基础样式在前，v0.6.0 增量在后 —— 后写的规则覆盖先写的。
 * @returns {string}
 */
export function cssText() {
  return CSS + CSS_V060 + CSS_MOBILE + CSS_AI + CSS_DISTILL + CSS_SETTINGS_GROUPS + CSS_SHELF_BUTTONS + CSS_LEGADO
}

/**
 * 幂等注入父窗口样式表。
 *
 * 失败行为：不抛。`doc.head` 还不存在（脚本在 <head> 之前执行）时静默返回，
 * 调用方（apply / 组件挂载）会再调一次。样式缺失不会让插件崩，只是难看。
 *
 * @param {Document} doc 通常是 document
 */
export function ensureStyle(doc) {
  const target = doc || (typeof document !== 'undefined' ? document : null)
  if (!target || !target.head) return
  if (target.getElementById(STYLE_ID) !== null) return
  const style = target.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText()
  target.head.appendChild(style)
}
