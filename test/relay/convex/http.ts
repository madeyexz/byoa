// A relay for V4 (test/v4.test.ts) on a Daytona org whose sandboxes reach only allowed domains (Tier 1 and 2), where
// *.convex.site is allowed and the test's quick tunnel is not. `/<name>/...` goes to
// `https://<name>.trycloudflare.com/<name>/...`, path unchanged, and nothing else.
// Deploy it to a temporary Convex project, run V4 with BYOA_V4_RELAY=https://<deployment>.convex.site, then delete
// the project:  cd test/relay && CONVEX_DEPLOY_KEY=... npx convex deploy -y
import { httpActionGeneric, httpRouter } from 'convex/server'

const relay = httpActionGeneric(async (_ctx, req) => {
  const u = new URL(req.url)
  const name = u.pathname.split('/')[1] ?? ''
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) return new Response('not found', { status: 404 })
  const headers = new Headers(req.headers)
  for (const h of ['host', 'content-length', 'connection']) headers.delete(h)
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
  const res = await fetch(`https://${name}.trycloudflare.com${u.pathname}${u.search}`, { method: req.method, headers, body })
  const out = new Headers(res.headers)
  for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) out.delete(h)
  return new Response(await res.arrayBuffer(), { status: res.status, headers: out })
})

const http = httpRouter()
for (const method of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'] as const) http.route({ pathPrefix: '/', method, handler: relay })
export default http
