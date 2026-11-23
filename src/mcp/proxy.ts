// The MCP proxy (R3). It runs in the app's backend, at the app's `proxyUrl`. The harness in the sandbox gets only a
// short-lived job token for one job and one user (R3.1); the proxy checks it, puts the user's real token on the
// request, and sends it to the MCP server (R3.2). No real token goes into the sandbox (R3.3). A job token stops
// working when its job ends (R3.4), and at the latest when its time runs out.
import { randomToken, sha256 } from '../crypto.ts'
import { SERVER_NAME } from '../config.ts'
import type { Store } from '../store.ts'
import { GrantError, type Grants } from './grants.ts'
import { serveTools, type AppTools } from './tools.ts'

export interface JobRecord { user: string; job: string; servers: string[]; until: number }

const tokenKey = (hash: string) => `job/${hash}`
const jobKey = (job: string) => `jobid/${job}`

/** Only the hash of a job token is stored, so a copy of the database gives no working token. */
export class JobTokens {
  private readonly store: Store
  constructor(store: Store) { this.store = store }

  async issue(user: string, servers: string[], ttlMs: number): Promise<{ token: string; job: string }> {
    const token = `byoa_job_${randomToken(32)}`, job = randomToken(12), hash = await sha256(token)
    await this.store.put(tokenKey(hash), JSON.stringify({ user, job, servers, until: Date.now() + ttlMs } satisfies JobRecord))
    await this.store.put(jobKey(job), hash)
    return { token, job }
  }

  async check(token: string): Promise<JobRecord | null> {
    const e = await this.store.get(tokenKey(await sha256(token)))
    if (!e) return null
    const r = JSON.parse(e.value) as JobRecord
    if (r.until > Date.now()) return r
    // its time ran out (a TTL, or a job that crashed before close): remove it, so the store does not keep it forever
    await this.end(r.job)
    return null
  }

  async end(job: string) {
    const e = await this.store.get(jobKey(job))
    if (e) await this.store.delete(tokenKey(e.value))
    await this.store.delete(jobKey(job))
  }
}

/** Request headers the proxy sends on. Every other header stays behind: the job token, cookies, and anything a
 *  harness adds. */
const UP = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
/** Response headers the proxy sends back. Not `www-authenticate`: it names the MCP server's sign-in, and a harness
 *  that followed it would get a real token of its own into the sandbox. */
const DOWN = ['content-type', 'mcp-session-id', 'cache-control']

/** On every answer of the proxy. A job's check from its sandbox (agents.ts) knows from it that the request reached
 *  the proxy, and not something else at that address, such as the error page of a tunnel that ended. */
export const PROXY_HEADER = 'x-byoa-proxy'
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }), { status, headers: { 'content-type': 'application/json', [PROXY_HEADER]: '1' } })

/** A fetch handler for requests to `<proxyUrl>/<server>`. */
export function mcpProxy(o: { proxyUrl: string; jobs: JobTokens; grants: Grants; tools?: AppTools }): (req: Request) => Promise<Response> {
  const base = new URL(o.proxyUrl).pathname.replace(/\/+$/, '')
  return async (req) => {
    const path = new URL(req.url).pathname
    const name = path.startsWith(base + '/') ? path.slice(base.length + 1) : ''
    if (!SERVER_NAME.test(name)) return fail(404, 'no such MCP server')
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
    const job = m ? await o.jobs.check(m[1]!) : null
    if (!job) return fail(401, 'the job token is not valid (the job ended, or it is not a job token)')
    if (!job.servers.includes(name)) return fail(403, `this job does not have the MCP server ${name}`)
    // the app's own tools (tools.ts): they run here, for the job's user, with no token and no other server
    const tools = o.tools && Object.prototype.hasOwnProperty.call(o.tools, name) ? o.tools[name] : undefined
    if (tools) {
      const res = await serveTools(name, tools, req, { user: job.user, job: job.job })
      res.headers.set(PROXY_HEADER, '1')
      return res
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const send = (url: string, token: string) => {
      const h = new Headers()
      for (const k of UP) { const v = req.headers.get(k); if (v !== null) h.set(k, v) }
      if (token) h.set('authorization', `Bearer ${token}`)
      return fetch(url, { method: req.method, headers: h, body, redirect: 'manual', signal: req.signal })
    }
    let res: Response
    try {
      let t = await o.grants.accessToken(job.user, name)
      res = await send(t.url, t.token)
      if (res.status === 401 && t.oauth) {
        // the server refused the token before it ran out: one refresh (shared with every other job), then once more
        await res.body?.cancel()
        t = await o.grants.accessToken(job.user, name, t.token)
        res = await send(t.url, t.token)
      }
    } catch (e) {
      if (e instanceof GrantError) return fail(403, e.message)
      return fail(502, `the MCP server ${name} did not answer`)
    }
    if (res.status === 401) { await res.body?.cancel(); return fail(403, `${name} did not accept the user's sign-in; connect it again`) }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); return fail(502, `the MCP server ${name} sent a redirect`) }
    const h = new Headers({ [PROXY_HEADER]: '1' })
    for (const k of DOWN) { const v = res.headers.get(k); if (v !== null) h.set(k, v) }
    return new Response(res.body, { status: res.status, headers: h })
  }
}
