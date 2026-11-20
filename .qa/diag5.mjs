import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PdfDocument } from '../lib/pdf.js'
import { buildFont, decodeTextBytes } from '../lib/pdftext.js'
const dir = path.join(homedir(), '.dsh-reading/dsh-reading/books/42ecc89fca427b2f')
const doc = new PdfDocument(readFileSync(path.join(dir, 'book.pdf')))
doc.load()
const res = doc.resolve(doc.pages()[0].resources)
const fonts = doc.resolve(res.get('Font'))
for (const key of ['BZ0-0','F0','F1']) {
  const fv = doc.resolve(fonts.get(key))
  const font = buildFont(doc, fv)
  console.log(key, 'codeLength', font.codeLength, 'gbk', font.gbk, 'mapSize', font.map ? font.map.size : null)
  console.log('   decode 0x21->', JSON.stringify(decodeTextBytes(font, Buffer.from([0x21]))))
  console.log('   decode B5 DA ->', JSON.stringify(decodeTextBytes(font, Buffer.from([0xB5,0xDA]))))
}
