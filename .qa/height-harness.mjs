import { writeFileSync } from 'node:fs'
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;background:#1b1b1f}
#outer{width:820px}
#viewport{height:600px;padding:40px;overflow:hidden;background:#fcfbf8}
#frame{width:100%;height:100%;border:0;display:block;background:#fff}
</style></head>
<body>
<div id="outer">
  <div id="viewport"><iframe id="frame" srcdoc="<body style='margin:0;font:16px/1.8 serif'><p>测试正文</p></body>"></iframe></div>
</div>
<script>
const frame = document.getElementById('frame')
const viewport = document.getElementById('viewport')
const cs = getComputedStyle(viewport)
window.__MEASURE__ = {
  frameClient: frame.clientHeight,
  frameRect: frame.getBoundingClientRect().height,
  viewportClient: viewport.clientHeight,
  viewportRect: viewport.getBoundingClientRect().height,
  paddingTop: cs.paddingTop,
  paddingBottom: cs.paddingBottom,
  oldColumnHeight: Math.max(frame.clientHeight, frame.getBoundingClientRect().height, viewport.clientHeight, viewport.getBoundingClientRect().height),
  newColumnHeight: frame.clientHeight || frame.getBoundingClientRect().height,
}
</script>
</body></html>`
writeFileSync('.qa/height-harness.html', html)
console.log('written')
