// Connecting a user's MCP servers (R2.1, R2.2), finishing their sign-in, moving grants in, and the app's own requests
// with a grant (R2.6). Only the grants, the store and the app's key: no sandbox.
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { MCP_PROTOCOL, SERVER_NAME } from '../config.ts'
import { open, seal } from '../crypto.ts'
import { keys } from '../keys.ts'
import type { Store } from '../store.ts'
import { GrantError, type Grant, type Grants } from './grants.ts'
import { Provider, type OAuthConfig } from './oauth.ts'

export type ConnectResult = { name: string; connected: true } | { name: string; connected: false; signInUrl: string }

const FLOW_MS = 15 * 60_000
export const secure = (u: URL) => u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))

/** `s` when it is an exact origin that may get a token, such as https://api.example.com. */
export function exactOrigin(s: string): string {
  let u: URL | undefined
  try { u = new URL(s) } catch {}
  if (!u || u.origin !== s || !secure(u) || u.hostname.includes('*')) throw new Error(`byoa: grantOrigins: ${JSON.stringify(s)} is not an origin such as https://api.example.com`)
  return s
}

export function mcpConnections(o: { app: string; store: Store; key: Promise<CryptoKey>; oauth: OAuthConfig; grants: Grants; grantOrigins?: Record<string, string[]>; isTools: (name: string) => boolean }) {
  const { store, key, oauth, grants } = o
  const grantOrigins = new Map(Object.entries(o.grantOrigins ?? {}).map(([mcp, extra]) => [exactOrigin(mcp), extra.map(exactOrigin)]))

  /** One MCP `initialize`, to see whether the server answers and whether it wants a token. */
  async function probe(url: string, token?: string): Promise<'ok' | 'unauthorized' | string> {
    try {
      const r = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: o.app, version: '1' } } }),
      })
      const text = await r.text()
      if (r.status === 401 || r.status === 403) return 'unauthorized'
      if (!r.ok) return `the server answered ${r.status}`
      if (!/"result"/.test(text)) return 'not an MCP server'
      return 'ok'
    } catch (e) { return `no answer: ${(e as Error).message}` }
  }

  /** Connects an MCP server for the user (R2.1, R2.2): with `bearer`, a token the user pasted; else MCP
   *  authorization, which returns the server's sign-in page when it has one. */
  async function connectMcp(user: string, url: string, opts: { name: string; bearer?: string }): Promise<ConnectResult> {
    const name = opts.name
    if (!SERVER_NAME.test(name)) throw new Error('byoa: name: lower-case letters, digits and -, at most 32')
    if (o.isTools(name)) throw new Error(`byoa: ${name} is the name of the app's own tools; connect the server with another name`)
    const u = new URL(url)
    if (!secure(u)) throw new Error('byoa: an MCP server URL must start with https://')
    if (opts.bearer !== undefined) {
      const bearer = opts.bearer.trim()
      if (!bearer || /\s/.test(bearer)) throw new Error('byoa: the token must be one word')
      const p = await probe(u.href, bearer)
      if (p !== 'ok') throw new Error(p === 'unauthorized' ? 'byoa: the server did not accept the token' : `byoa: ${p}`)
      await grants.save(user, { name, url: u.href, bearer })
      return { name, connected: true }
    }
    const p = await probe(u.href)
    if (p === 'ok') { await grants.save(user, { name, url: u.href }); return { name, connected: true } }
    if (p !== 'unauthorized') throw new Error(`byoa: ${p}`)
    const prov = new Provider(oauth)
    if ((await auth(prov, { serverUrl: u.href })) === 'AUTHORIZED') {
      await grants.save(user, { name, url: u.href, oauth: prov.s })
      return { name, connected: true }
    }
    if (!prov.url) throw new Error('byoa: the server gave no sign-in page')
    const k = keys.mcpFlow(prov.id)
    await store.put(k, await seal(await key, JSON.stringify({ user, name, url: u.href, s: prov.s, until: Date.now() + FLOW_MS }), k))
    return { name, connected: false, signInUrl: prov.url.href }
  }

  /** The server's sign-in page sent the browser back to `oauth.redirectUrl` with `code` and `state`. */
  async function finishMcp(params: { state: string; code?: string; error?: string }): Promise<{ user: string; name: string }> {
    const k = keys.mcpFlow(params.state)
    const e = await store.get(k)
    if (!e || !/^[A-Za-z0-9_-]+$/.test(params.state)) throw new Error('byoa: this sign-in is not known, or it ran out')
    await store.delete(k)
    const f = JSON.parse(await open(await key, e.value, k)) as { user: string; name: string; url: string; s: Provider['s']; until: number }
    if (f.until < Date.now()) throw new Error('byoa: this sign-in ran out; connect again')
    if (params.error || !params.code) throw new Error(`byoa: the server did not sign in (${params.error ?? 'no code'})`)
    const prov = new Provider(oauth, f.s)
    if ((await auth(prov, { serverUrl: f.url, authorizationCode: params.code })) !== 'AUTHORIZED' || !prov.s.tokens) throw new Error('byoa: the server did not sign in')
    prov.s.verifier = undefined
    await grants.save(f.user, { name: f.name, url: f.url, oauth: prov.s } satisfies Grant)
    return { user: f.user, name: f.name }
  }

  /** Saves an MCP authorization grant that the user made elsewhere (R2.1), as finishMcp does: for an app that moves its
   *  existing grants into byoa. `oauth` is the MCP SDK's state (`client`, `tokens`, and `at`, when the tokens were
   *  saved). Move each grant, never copy it: the old holder must delete its copy, so the grant keeps one refresh
   *  owner (R2.3). */
  async function importMcp(user: string, g: { name: string; url: string; oauth: Provider['s'] }): Promise<{ name: string }> {
    if (!SERVER_NAME.test(g.name)) throw new Error('byoa: name: lower-case letters, digits and -, at most 32')
    if (o.isTools(g.name)) throw new Error(`byoa: ${g.name} is the name of the app's own tools; import the grant with another name`)
    const u = new URL(g.url)
    if (!secure(u)) throw new Error('byoa: an MCP server URL must start with https://')
    if (typeof g.oauth?.tokens?.access_token !== 'string' || !g.oauth.client?.client_id) throw new Error('byoa: importMcp needs the grant\'s client and tokens')
    const { client, tokens, at, discovery } = g.oauth
    await grants.save(user, { name: g.name, url: u.href, oauth: { client, tokens, at: at ?? Date.now(), ...(discovery ? { discovery } : {}) } })
    return { name: g.name }
  }

  /** A request from the app's backend with the user's grant (R2.6), for an API next to the MCP endpoint that is not
   *  MCP, such as an export. byoa adds the current token, refreshed by the one refresh owner (R2.3), and sends it only
   *  to the origin of the grant's MCP server, which has the token already, and to the origins that `grantOrigins`
   *  gives for that origin. It does not follow redirects. The app gets the response, never the token. */
  async function fetchWithGrant(user: string, name: string, url: string | URL, init: RequestInit = {}): Promise<Response> {
    const g = (await grants.list(user)).find((x) => x.name === name)
    if (!g) throw new GrantError('not-connected', `${name} is not connected`)
    const req = new Request(url, init)
    const origin = new URL(g.url).origin
    const allowed = [origin, ...(grantOrigins.get(origin) ?? [])]
    if (!allowed.includes(new URL(req.url).origin)) throw new Error(`byoa: fetchWithGrant: the ${name} grant goes only to ${allowed.join(', ')}`)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const send = (token: string) => {
      const h = new Headers(req.headers)
      if (token) h.set('authorization', `Bearer ${token}`)
      else h.delete('authorization')
      return fetch(req.url, { method: req.method, headers: h, body, redirect: 'manual', signal: req.signal })
    }
    let t = await grants.accessToken(user, name)
    let res = await send(t.token)
    if (res.status === 401 && t.oauth) {
      // the server refused the token before it ran out: one refresh (shared with the proxy's), then once more
      await res.body?.cancel()
      t = await grants.accessToken(user, name, t.token)
      res = await send(t.token)
    }
    return res
  }

  return { connectMcp, finishMcp, importMcp, fetchWithGrant }
}
