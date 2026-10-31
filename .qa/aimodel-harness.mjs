import { writeFileSync } from 'node:fs'
import { cssText } from '../client/src/style.js'

const html = `<!doctype html><meta charset="utf-8">
<style>${cssText()}</style>
<body style="margin:0;background:#fcfbf8">
<div class="dr">
  <div class="dr-head" style="display:flex;align-items:center;gap:10px;padding:14px 18px">
    <div class="dr-head-title">书架</div>
    <div class="dr-head-sub">6 本</div>
    <div class="dr-grow" style="flex:1"></div>
    <div class="dr-aimodel-bar is-compact">
      <span class="dr-aimodel-label">分析模型</span>
      <select class="dr-select dr-aimodel-select"><option>跟随当前会话</option></select>
      <select class="dr-select dr-aimodel-select dr-aimodel-effort"><option>高</option></select>
      <span class="dr-aimodel-note">实际使用：raccoon/v4（你选的）</span>
    </div>
    <button class="dr-btn">刷新</button>
    <button class="dr-btn dr-btn-primary">导入图书</button>
  </div>
</div>
<script>
const out = {};
const head = document.querySelector('.dr-head');
const bar = document.querySelector('.dr-aimodel-bar');
out.headWidth = +head.getBoundingClientRect().width.toFixed(1);
out.barWidth = +bar.getBoundingClientRect().width.toFixed(1);
const sel = document.querySelector('.dr-aimodel-select').getBoundingClientRect();
out.firstSelect = [+sel.width.toFixed(1), +sel.height.toFixed(1)];
out.headHeight = +head.getBoundingClientRect().height.toFixed(1);
out.layout = head.getBoundingClientRect().height > 70 ? 'wrapped' : 'one-line';
let over = false;
const kids=[...head.children].map(e=>e.getBoundingClientRect());
for (let i=1;i<kids.length;i++) if (kids[i].left + 0.5 < kids[i-1].left) over = true;
out.backwards = over ? 'YES' : 'no';
const pre=document.createElement('pre'); pre.id='report'; pre.textContent=JSON.stringify(out);
document.body.appendChild(pre);
</script>
`
writeFileSync(new URL('./aimodel-harness.html', import.meta.url), html)
console.log('written')
