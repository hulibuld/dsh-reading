import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PdfDocument } from '../lib/pdf.js'
const dir = path.join(homedir(), '.dsh-reading/dsh-reading/books/42ecc89fca427b2f')
const doc = new PdfDocument(readFileSync(path.join(dir, 'book.pdf')))
doc.load()
const page = doc.pages()[0]
function walk(res, depth, tag) {
  const fonts = doc.resolve(res.get('Font'))
  if (fonts && typeof fonts.forEach === 'function') {
    fonts.forEach((val, key) => {
      const f = doc.resolve(val)
      console.log(`${' '.repeat(depth)}${tag}/${key}: sub=${JSON.stringify(doc.resolve(f.get('Subtype')))?.slice(0,40)} toUni=${!!f.get('ToUnicode')}`)
    })
  }
  const xo = doc.resolve(res.get('XObject'))
  if (xo && typeof xo.forEach === 'function' && depth < 3) {
    xo.forEach((val, key) => {
      const x = doc.resolve(val)
      const st = doc.resolve(x.get('Subtype'))
      console.log(`${' '.repeat(depth)}${tag}/XObject ${key} sub=${st?.v ?? st?.name ?? st}`)
      const r2 = doc.resolve(x.get('Resources'))
      if (r2 && typeof r2.get === 'function') walk(r2, depth + 2, `${tag}.${key}`)
    })
  }
}
const res = doc.resolve(page.resources)
walk(res, 0, 'p1')
