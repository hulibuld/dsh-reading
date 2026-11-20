
const name = process.argv[2]
const mod = await import(new URL('../test/' + name, import.meta.url).href)
const run = mod.default ?? mod.run
try { await run(); console.log('PASS', name) } catch (e) { console.log('FAIL', name); console.log(e.message); console.log((e.stack||'').split('\n').slice(0,6).join('\n')) }
