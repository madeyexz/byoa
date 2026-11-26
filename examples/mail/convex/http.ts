// The demo's HTTP routes, at <deployment>.convex.site:
// - /byoa/mcp/<server>: byoa's proxy (R3). The job's harness calls the mail tools here with its job token; the tools
//   run in this HTTP action for the job's visitor. The proxy needs no sandbox.
// - /cancel: a page that closes ends its sign-in (navigator.sendBeacon, so no CORS preflight: a text body).
import { httpRouter } from 'convex/server'
import type { SandboxProvider } from '@madeyexz/byoa'
import { internal } from './_generated/api.js'
import { httpAction } from './_generated/server.js'
import { LABS } from './demo.ts'
import { agentsFor } from './lib.ts'

const none = (): never => { throw new Error('byoa demo: the proxy runs no sandbox') }
const noSandbox: SandboxProvider = { name: process.env.SANDBOX === 'instabox' ? 'instabox' : 'e2b', capabilities: { volumes: false }, create: none, resume: none, destroy: none, deleteVolume: none }

const http = httpRouter()
const proxy = httpAction((ctx, req) => agentsFor(ctx, noSandbox).proxy(req))
for (const method of ['GET', 'POST', 'DELETE'] as const) http.route({ pathPrefix: '/byoa/mcp/', method, handler: proxy })

http.route({
  path: '/cancel',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    try {
      const b = JSON.parse(await req.text())
      if (/^[0-9a-f]{32}$/.test(b.visitor) && LABS.includes(b.harness)) await ctx.scheduler.runAfter(0, internal.agents.cancel, { visitor: b.visitor, harness: b.harness })
    } catch {}
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } })
  }),
})

export default http
