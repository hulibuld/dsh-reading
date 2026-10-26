/**
 * style-qa.js —— 问答历史侧栏（QaSidebar）与「问 AI」面板精修的样式表。
 *
 * 为什么单独一个文件、不并进 style.js：
 *   1. style.js 是「整面板」的样式，改它会让 client_build 的模块断言跟着动；
 *   2. 问答侧栏是本次新增的独立部件，单独一个 <style> 注入失败也只丢这一块，
 *      不会把书架/正文的样式一起带塌；
 *   3. 施工图 docs/10-0.4.0-施工图.md §8.4 规定：新增 CSS 一律不引用 `--dsw-*` token，
 *      用固定中性色，避免 token 白名单测试失败。放在独立文件里最容易守住这条。
 *
 * 类名：主体是 .dr-qa*（记录行）与 .dr-ask*（面板精修），布局复用
 * .dr-side / .dr-side-head / .dr-side-body / .dr-state / .dr-btn 等 style.js 已有类。
 * 这里**不**再定侧栏宽度：宽度由 app.js 的 SIDE_WIDTH 决定。
 *
 * 深色主题：侧栏和面板都在父窗口里，文字颜色一律继承（currentColor），
 * 分隔线/底色用半透明黑或半透明白，深色面板下不会出现「黑字黑底」。
 */

/** <style> 元素的 id。重复注入时靠它去重，插件重载不会叠出两份样式。 */
export const QA_STYLE_ID = 'dsh-reading-qa'

/**
 * 问答侧栏 + 问 AI 面板的样式文本。
 *
 * 只写父窗口里的部件，不碰正文 iframe（铁律：正文只注入那一个 <style>）。
 * 所有颜色都是固定值或半透明叠加，不引用任何设计 token。
 */
export const cssTextQa = `
/* ── 问答记录侧栏 ───────────────────────────────────────────── */

.dr-qa-search-row {
  flex: 0 0 auto;
  padding: 8px 10px 6px;
}

.dr-qa-search {
  width: 100%;
  box-sizing: border-box;
  font-size: 12px;
}

.dr-qa-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px 10px;
}

.dr-qa-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 10px;
  border-radius: 10px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.07);
  color: inherit;
}

.dr-qa-item:hover {
  background: rgba(0, 0, 0, 0.035);
}

/* 引用原句：两行截断 + 左侧竖线，和问题正文一眼分开 */
.dr-qa-quote {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 2px 0 2px 8px;
  border: 0;
  border-left: 2px solid rgba(120, 120, 130, 0.45);
  background: transparent;
  color: inherit;
  opacity: 0.82;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}

.dr-qa-quote-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.dr-qa-question {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.dr-qa-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  line-height: 1.4;
  opacity: 0.62;
}

.dr-qa-chapter {
  max-width: 12em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dr-qa-dot {
  opacity: 0.6;
}

/* 展开后的完整回答：保留换行，最多 40vh，自己滚 */
.dr-qa-answer {
  max-height: 40vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dr-qa-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

/* ── 工具栏「问答」入口与条数徽标（常驻、一次点击可达） ────── */

.dr-qa-entry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dr-qa-entry[aria-pressed='true'] {
  background: rgba(0, 0, 0, 0.08);
}

.dr-qa-entry .dr-toc-badge {
  display: inline-block;
  min-width: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: rgba(120, 120, 130, 0.22);
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  opacity: 0.9;
}

/* ── 「问 AI」面板精修 ─────────────────────────────────────── */

.dr-ask {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(78vh, 640px);
}

.dr-ask-round {
  margin-left: 2px;
}

/* 引用原文：默认两行，可展开 */
.dr-ask-quote {
  position: relative;
  flex: 0 0 auto;
  padding-right: 4px;
  overflow: hidden;
}

.dr-ask-quote.is-collapsed {
  max-height: 3.1em;
}

.dr-ask-quote.is-collapsed .dr-ask-quote-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.dr-ask-quote-text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.dr-ask-quote-more {
  margin-top: 2px;
  font-size: 11.5px;
}

.dr-ask-quote-empty {
  opacity: 0.66;
  font-size: 11.5px;
}

/* 上下文胶囊：书名 · 章节名 */
.dr-ask-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.78;
}

.dr-ask-chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dr-ask-sep {
  opacity: 0.5;
}

/* 多轮追问：每一轮一张卡，整块自己滚 */
.dr-ask-turns {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 40vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.dr-ask-turn-question {
  margin-bottom: 2px;
  font-size: 11.5px;
  line-height: 1.45;
  opacity: 0.68;
  overflow-wrap: anywhere;
}

/* 回答：自己滚，不再把面板顶出屏幕 */
.dr-ask-answer {
  flex: 0 1 auto;
  max-height: 38vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.dr-ask-answer-text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* 加载骨架 */
.dr-ask-loading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.035);
}

.dr-ask-skeleton {
  display: block;
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.07) 0%, rgba(0, 0, 0, 0.13) 50%, rgba(0, 0, 0, 0.07) 100%);
  background-size: 200% 100%;
  animation: dr-qa-shimmer 1.3s ease-in-out infinite;
}

.dr-ask-skeleton-short {
  width: 62%;
}

.dr-ask-loading-text {
  font-size: 11px;
  opacity: 0.68;
}

@keyframes dr-qa-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 错误：中文人话 + 重试 */
.dr-ask-error {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(196, 62, 62, 0.08);
}

.dr-ask-error-hint {
  font-size: 11px;
  opacity: 0.72;
}

.dr-ask-notice {
  font-size: 11.5px;
  color: #1f7a4d;
}

.dr-ask-hint {
  font-size: 10.5px;
  line-height: 1.4;
  opacity: 0.56;
}

.dr-ask-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding-top: 2px;
}

/* 窄屏：面板贴边、按钮不挤成一条线 */
@media (max-width: 560px) {
  .dr-ask {
    max-height: 88vh;
  }

  .dr-ask-quote.is-collapsed {
    max-height: 2.7em;
  }

  .dr-ask-answer {
    max-height: 30vh;
  }

  .dr-ask-actions .dr-btn {
    flex: 1 1 auto;
  }
}

/* 尊重系统「减少动态效果」 */
@media (prefers-reduced-motion: reduce) {
  .dr-ask-skeleton {
    animation: none;
  }
}
`

/**
 * 把问答复用样式注入到宿主文档。幂等：已有同 id 的 <style> 就直接返回。
 *
 * 只操作宿主页面（不是书籍 iframe）：正文文档里仍然只允许那一个阅读样式。
 *
 * @param {Document} doc    通常是宿主页面 document
 * @returns {boolean}       true = 本次真的注入了；false = 已存在 / 无 document
 */
export function ensureQaStyle(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false
  const head = doc.head || doc.documentElement
  if (!head || typeof head.appendChild !== 'function') return false
  if (typeof doc.getElementById === 'function' && doc.getElementById(QA_STYLE_ID)) return false
  const style = doc.createElement('style')
  style.id = QA_STYLE_ID
  style.textContent = cssTextQa
  head.appendChild(style)
  return true
}
