import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PdfDocument } from '../lib/pdf.js'
const dir = path.join(homedir(), '.dsh-reading/dsh-reading/books/42ecc89fca427b2f')
const doc = new PdfDocument(readFileSync(path.join(dir, 'book.pdf')))
doc.load()
const res = doc.resolve(doc.pages()[0].resources)
const fonts = doc.resolve(res.get('Font'))
for (const key of ['F0','F1','F2','F8','BZ0-0']) {
  const f = doc.resolve(fonts.get(key))
  const enc = doc.resolve(f.get('Encoding'))
  const df = doc.resolve(f.get('DescendantFonts'))
  const first = Array.isArray(df) ? doc.resolve(df[0]) : null
  const csi = first ? doc.resolve(first.get('CIDSystemInfo')) : null
  console.log(key, 'Encoding=', JSON.stringify(enc)?.slice(0,120))
  if (csi) console.log('   CIDSystemInfo', JSON.stringify({ reg: doc.resolve(csi.get('Registry')), ord: doc.resolve(csi.get('Ordering')), sup: doc.resolve(csi.get('Supplement')) }))
  if (first) console.log('   Desc:', JSON.stringify(doc.resolve(first.get('Subtype'))), 'CIDToGIDMap=', JSON.stringify(doc.resolve(first.get('CIDToGIDMap'))))
}
