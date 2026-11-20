import { LibraryStore } from '../lib/store.js'
import { createHandler, API_PREFIX } from '../lib/routes.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'))
const store = new LibraryStore({ libraryDir, logger: { warn: (...a) => console.log('WARN', ...a) } })
const handler = createHandler({ store, logger: { warn: (...a) => console.log('WARN', ...a), error: (...a) => console.log('ERR', ...a) } })
const res = { statusCode: 0, headers: {}, body: null,
  writeHead(s, h) { this.statusCode = s; this.headers = h ?? {} },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v },
  end(c) { this.body = Buffer.from(String(c ?? ''), 'utf8') } }
await handler({ method: 'POST', url: API_PREFIX + '/thread.list', body: {} }, res)
console.log('STATUS', res.statusCode, res.body.toString('utf8').slice(0, 500))
await fs.rm(libraryDir, { recursive: true, force: true })
