import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PdfDocument } from '../lib/pdf.js'
const dir = path.join(homedir(), '.dsh-reading/dsh-reading/books/42ecc89fca427b2f')
const doc = new PdfDocument(readFileSync(path.join(dir, 'book.pdf')))
doc.load()
const pages = doc.pages()
const page = pages[0]
const res = doc.resolve(page.resources)
const fonts = doc.resolve(res.get('Font'))
fonts.forEach((val, key) => {
  const font = doc.resolve(val)
  const g = (o, k) => (o && typeof o.get === 'function' ? doc.resolve(o.get(k)) : undefined)
  const desc = g(font, 'FontDescriptor')
  console.log('---', key)
  console.log('  Subtype', JSON.stringify(g(font, 'Subtype')))
  console.log('  BaseFont', JSON.stringify(g(font, 'BaseFont')))
  console.log('  Encoding', JSON.stringify(g(font, 'Encoding'))?.slice(0, 200))
  console.log('  ToUnicode?', !!font.get('ToUnicode'), ' DescendantFonts?', !!font.get('DescendantFonts'))
  const df = g(font, 'DescendantFonts')
  const first = Array.isArray(df) ? doc.resolve(df[0]) : null
  if (first) console.log('  Desc[0] Subtype', JSON.stringify(g(first, 'Subtype')), 'CIDToGIDMap', JSON.stringify(g(first, 'CIDToGIDMap')))
})
const content = doc.pageContent(page)
console.log('content bytes', content.length)
console.log('head', content.subarray(0, 200).toString('latin1').replace(/\n/g, ' | '))
