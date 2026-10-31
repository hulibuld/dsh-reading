import { writeFileSync } from 'node:fs'
const { cssText } = await import('../client/src/style.js')

const book = (i, title, author, pct) => `
  <div class="dr-book-cell">
    <button type="button" class="dr-book">
      <span class="dr-cover"><span class="dr-cover-fallback">${title.slice(0, 6)}</span></span>
      <span class="dr-book-title">${title}</span>
      <span class="dr-book-meta">${author}</span>
      <span class="dr-progress"><span class="dr-progress-fill" style="width:${pct}%"></span></span>
      <span class="dr-book-pct">已读 ${pct}%</span>
    </button>
    <button type="button" class="dr-book-edit" title="编辑">✎</button>
  </div>`

const books = [
  ['TED 胶囊书：演讲的力量', '克里斯·安德森', 12],
  ['Deep Work', 'Cal Newport', 3],
  ['拉康十讲', '吴琼', 41],
  ['没有封面的书', '艾伦·莱特曼、布莱恩·R·利特尔', 0],
  ['人生进阶指南', '陈先锐', 2],
  ['Francesco Petrarca', 'Francesco Petrarca', 93],
]

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>书架几何</title>
<style>${cssText()}
body{margin:0;background:#f7f7f9;font-family:-apple-system,"PingFang SC",sans-serif}
#report{position:sticky;top:0;z-index:99;padding:8px 12px;background:#101014;color:#eee;
font:11.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;max-height:34vh;overflow:auto}
#shelf{padding:16px}
</style></head><body>
<pre id="report">measuring…</pre>
<div id="shelf"><div class="dr-root"><div class="dr-shelf">
  <div class="dr-head" style="display:flex;align-items:center;gap:8px;padding:14px 18px 0">
    <div class="dr-head-title" style="font-size:15px;font-weight:650">书架</div>
    <div class="dr-head-sub" style="font-size:11.5px;color:#8a8f98">6 本</div>
    <div class="dr-grow" style="flex:1 1 auto"></div>
    <button type="button" class="dr-btn">刷新</button>
    <button type="button" class="dr-btn dr-btn-primary dr-btn-lg">导入图书</button>
  </div>
  <div class="dr-filters">
    <button type="button" class="dr-btn dr-btn-lg dr-filters-btn">书源</button>
    <div class="dr-filters-right">
      <span class="dr-filters-count">6 / 6 本</span>
      <select class="dr-input dr-select dr-filter-select" aria-label="筛选方式"><option>全部书籍</option></select>
      <select class="dr-input dr-select dr-filter-select" aria-label="筛选值"><option>全部</option></select>
    </div>
  </div>
  <div class="dr-grid">${books.map(([t, a, p]) => book(0, t, a, p)).join('')}</div>
</div></div></div>
<div class="dr-modal-mask" id="mask">
  <div class="dr-modal dr-legado-card">
    <header class="dr-modal-head"><div><h2>书源</h2><div class="dr-legado-sub-head">用自己的书源搜书、把书加进书架。插件不带源。</div></div><div class="dr-grow"></div><button class="dr-iconbtn" aria-label="关闭">×</button></header>
    <div class="dr-tabs"><button class="dr-tab is-on">搜索</button><button class="dr-tab">书源（3）</button></div>
    <div class="dr-legado-body">
      <div class="dr-legado-row">
        <input class="dr-input" type="search" placeholder="书名或作者，比如「三体」">
        <button type="button" class="dr-btn dr-btn-primary">搜索</button>
      </div>
      <ul class="dr-legado-list">
        <li class="dr-legado-item"><div class="dr-legado-main"><div class="dr-legado-name">三体</div>
          <div class="dr-legado-meta">刘慈欣 · 某某书源</div><div class="dr-legado-sub">最新：第 78 章</div></div>
          <button type="button" class="dr-btn">加入书架</button></li>
      </ul>
    </div>
  </div>
</div>
<script>
if (location.search.includes('nomask')) document.getElementById('mask').style.display='none'
const r = []
const cell = document.querySelector('.dr-book-cell')
const grid = document.querySelector('.dr-grid')
const cards = [...document.querySelectorAll('.dr-book-cell')]
const widths = cards.map(c => +c.getBoundingClientRect().width.toFixed(1))
const covers = [...document.querySelectorAll('.dr-cover')].map(c => +c.getBoundingClientRect().height.toFixed(1))
const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
let overlap = 0
for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
  const a = cards[i].getBoundingClientRect(), b = cards[j].getBoundingClientRect()
  if (a.right > b.left + 0.5 && b.right > a.left + 0.5 && a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5) overlap++
}
const modal = document.querySelector('#mask .dr-modal').getBoundingClientRect()
const mask = document.getElementById('mask').getBoundingClientRect()
const filters = document.querySelector('.dr-filters').getBoundingClientRect()
const firstCard = cards[0].getBoundingClientRect()
const head = document.querySelector('.dr-head').getBoundingClientRect()
const srcBtn = document.querySelector('.dr-filters-btn').getBoundingClientRect()
const rightGroup = document.querySelector('.dr-filters-right').getBoundingClientRect()
const shelf = document.querySelector('.dr-shelf').getBoundingClientRect()
r.push('grid cols  : ' + cols)
r.push('card width : ' + widths.join(' | '))
r.push('cover h    : ' + covers.join(' | '))
r.push('overlaps   : ' + overlap)
r.push('filter 底  : ' + filters.bottom.toFixed(1) + ' · 首卡顶 : ' + firstCard.top.toFixed(1) + ' · 间距 ' + (firstCard.top - filters.bottom).toFixed(1))
r.push('dialog     : left ' + modal.left.toFixed(1) + ' top ' + modal.top.toFixed(1) + ' w ' + modal.width.toFixed(1) + ' h ' + modal.height.toFixed(1))
r.push('mask       : ' + mask.width.toFixed(0) + 'x' + mask.height.toFixed(0))
r.push('dialog 居中: ' + (Math.abs((modal.left + modal.right) / 2 - (mask.left + mask.right) / 2) < 2 ? 'PASS' : 'FAIL'))
r.push('dialog 在屏: ' + (modal.top >= mask.top - 1 && modal.bottom <= mask.bottom + 1 ? 'PASS' : 'FAIL'))
r.push('页头→书源键: ' + (srcBtn.top - head.bottom).toFixed(1) + 'px（按钮顶到页头底）')
r.push('筛选栏→首卡: ' + (firstCard.top - srcBtn.bottom).toFixed(1) + 'px')
r.push('书源左缘  : ' + (srcBtn.left - shelf.left).toFixed(1) + 'px（应≈内边距）')
r.push('右组右缘  : ' + (shelf.right - rightGroup.right).toFixed(1) + 'px（应≈内边距）')
r.push('靠左/靠右  : ' + ((srcBtn.left < rightGroup.left - 100 && shelf.right - rightGroup.right < 20) ? 'PASS' : 'FAIL'))
document.getElementById('report').textContent = r.join('\\n')
document.title = 'ready'
</script></body></html>`

writeFileSync(new URL('./shelf-harness-090.html', import.meta.url), html)
console.log('harness written')
