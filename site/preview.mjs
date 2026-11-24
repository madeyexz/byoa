// Runs worker.js on this computer, on the files that build.mjs wrote here instead of the main branch, to see the
// site as the Worker will serve it before a push. Run from site/ after `node build.mjs`: node preview.mjs (PORT, default 8787)
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import worker from './worker.js'

const BASE = 'https://raw.githubusercontent.com/madeyexz/byoa/main/site/'
const origFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (typeof url !== 'string' || !url.startsWith(BASE)) return origFetch(url, init)
  try { return new Response(await readFile(new URL(`./${url.slice(BASE.length)}`, import.meta.url))) } catch { return new Response('', { status: 404 }) }
}
const port = Number(process.env.PORT ?? 8787)
createServer(async (req, res) => {
  const r = await worker.fetch(new Request(new URL(req.url ?? '/', `http://127.0.0.1:${port}`)))
  const headers = Object.fromEntries(r.headers)
  if (headers.location) headers.location = headers.location.replace('https://byoa.rippling.computer', '')
  res.writeHead(r.status, { ...headers, 'cache-control': 'no-store' })
  res.end(Buffer.from(await r.arrayBuffer()))
}).listen(port, () => console.log(`byoa site: http://127.0.0.1:${port}`))
