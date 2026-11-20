import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PdfDocument } from '../lib/pdf.js'
import { buildFont } from '../lib/pdftext.js'
const dir = path.join(homedir(), '.dsh-reading/dsh-reading/books/42ecc89fca427b2f')
const doc = new PdfDocument(readFileSync(path.join(dir, 'book.pdf')))
doc.load()
const fonts = doc.resolve(doc.resolve(doc.pages()[0].resources).get('Font'))
const font = buildFont(doc, doc.resolve(fonts.get('BZ0-0')))
console.log('map?', !!font.map, 'size', font.map?.size, 'get(33)=', font.map?.get(33), 'keys sample', [...(font.map?.keys()||[])].slice(0,5))
console.log('encoding', font.encoding, 'codeLength', font.codeLength, 'usable', font.usable)
