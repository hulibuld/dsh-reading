import { writeFileSync } from 'node:fs'
import { cssText } from '../client/src/style.js'
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html { --dsw-alias-bg-base: #1b1b1f; --dsw-alias-bg-layer-1: #232326; --dsw-alias-label-primary: #e8e8ea; --dsw-alias-border-l2: #3a3a3f; }
body { margin: 0; background: #1b1b1f; }
${cssText()}
</style></head><body>
<div class="dr-root"><div class="dr-reader" style="--dsh-reading-paper:#fcfbf8;--dsh-reading-ink:#22262b;--dsh-reading-rule:#e6e2d8">
  <div class="dr-reader-bar">
    <button class="dr-iconbtn" title="目录">☰</button>
    <button class="dr-iconbtn" title="笔记">✎</button>
    <button class="dr-iconbtn" title="搜索">⌕</button>
    <button class="dr-btn dr-btn-sm">问答</button>
    <button class="dr-iconbtn">?</button>
    <div class="dr-reader-title">测试书名</div>
  </div>
</div></div>
<script>
const out = []
for (const el of document.querySelectorAll('.dr-reader-bar button, .dr-reader-bar .dr-reader-title')) {
  const s = getComputedStyle(el)
  out.push({ text: el.textContent.trim().slice(0,4), color: s.color, bg: s.backgroundColor, bgImage: s.backgroundImage })
}
document.title = JSON.stringify(out)
window.__RESULT__ = out
</script>
</body></html>`
writeFileSync('.qa/bar-harness.html', html)
console.log('written', html.length)
