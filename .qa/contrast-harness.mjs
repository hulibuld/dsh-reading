import { writeFileSync } from 'node:fs'
import { cssText } from '../client/src/style.js'

const hostile = `
:root{
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#ffffff;
  --dsw-alias-bg-layer-3:#ffffff; --dsw-alias-brand-primary:#ffffff;
  --dsw-alias-button-primary-fill:#ffffff; --dsw-alias-button-primary-hover:#ffffff;
  /* 只把「品牌色」压成白色——这是真实主题里会出现的形态；
     文字色保持深色，因为宿主不会同时把 base 底和正文色都设成白（那是自相矛盾）。 */
}`

const html = `<!doctype html><meta charset="utf-8">
<style>${hostile}</style>
<style>${cssText()}</style>
<body style="margin:0;background:#fff">
<div class="dr-root" style="padding:20px;display:flex;gap:12px;background:#fff">
  <button class="dr-btn dr-btn-primary dr-btn-lg" id="import">导入图书</button>
  <button class="dr-btn dr-filters-btn" id="source">书源</button>
  <button class="dr-btn" id="plain">刷新</button>
</div>
<script>
const hex=c=>{const m=c.match(/rgba?\\(([^)]+)\\)/);return m?m[1].split(',').slice(0,3).map(Number):null}
const lum=p=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2])}
const ratio=(a,b)=>{const x=lum(a),y=lum(b);const hi=Math.max(x,y),lo=Math.min(x,y);return (hi+0.05)/(lo+0.05)}
const out={}
for (const id of ['import','source','plain']){
  const el=document.getElementById(id), cs=getComputedStyle(el)
  const bg=hex(cs.backgroundColor), fg=hex(cs.color)
  out[id]={bg:cs.backgroundColor,color:cs.color,image:cs.backgroundImage==='none'?'none':'HAS_IMAGE',ratio:bg&&fg?+ratio(bg,fg).toFixed(2):null}
}
const pre=document.createElement('pre'); pre.id='report'; pre.textContent=JSON.stringify(out); document.body.appendChild(pre)
</script>`

writeFileSync(new URL('./contrast-harness.html', import.meta.url), html)
console.log('written .qa/contrast-harness.html')
