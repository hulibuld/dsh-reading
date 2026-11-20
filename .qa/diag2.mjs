import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PdfDocument } from '../lib/pdf.js'
import { parseToUnicode } from '../lib/pdftext.js'
const dir = path.join(homedir(), '.dsh-reading/dsh-reading/books/42ecc89fca427b2f')
const doc = new PdfDocument(readFileSync(path.join(dir, 'book.pdf')))
doc.load()
const page = doc.pages()[0]
const res = doc.resolve(page.resources)
const fonts = doc.resolve(res.get('Font'))
const fontVal = doc.resolve(fonts.get('BZ0-0'))
const cmapBytes = doc.stream(doc.resolve(fontVal.get('ToUnicode')))
console.log('cmap len', cmapBytes?.length)
console.log(cmapBytes.subarray(0, 400).toString('latin1').replace(/\n/g, ' | '))
const parsed = parseToUnicode(cmapBytes)
console.log('map size', parsed.size, 'first', [...parsed.entries()].slice(0, 6))
const content = doc.pageContent(page)
const off = content.indexOf(Buffer.from('Tf'))
console.log('content head', content.subarray(0, 300).toString('latin1').replace(/\n/g, ' | '))
