// A small MCP server with its own OAuth 2.1 authorization server, for tests: protected resource metadata, server
// metadata, Dynamic Client Registration, an authorize endpoint that signs in at once, a token endpoint with PKCE
// and rotating refresh tokens (an old refresh token stops working, as at real servers), and a /mcp endpoint with one
// tool. It counts what it sees, so tests can check how byoa uses it.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeMcp {
  base: string
  url: string
  /** Refresh requests the token endpoint got, and the ones it refused. */
  refreshes: number
  refused: number
  registrations: number
  /** Every Authorization header the /mcp endpoint got. */
  seen: string[]
  /** Every access and refresh token the server ever issued: the real tokens that must never reach a sandbox. */
  issued: string[]
  clientIds: string[]
  /** Makes every access token issued so far stop working, as if it ran out early. */
  expireAccess(): void
  close(): Promise<void>
}

export async function fakeMcp(opts: { cimd?: boolean; expiresIn?: number; tokenDelayMs?: number } = {}): Promise<FakeMcp> {
  const access = new Set<string>(), refresh = new Map<string, string>(), codes = new Map<string, { challenge: string; client: string }>()
  const s: FakeMcp = { base: '', url: '', refreshes: 0, refused: 0, registrations: 0, seen: [], issued: [], clientIds: [], expireAccess: () => access.clear(), close: async () => {} }
  const tok = (p: string) => { const t = `${p}_${randomBytes(18).toString('base64url')}`; s.issued.push(t); return t }
  const tokens = (client: string) => {
    const a = tok('real_access'), r = tok('real_refresh')
    access.add(a); refresh.set(r, client)
    return { access_token: a, refresh_token: r, token_type: 'Bearer', expires_in: opts.expiresIn ?? 3600 }
  }
  const body = async (req: IncomingMessage) => { let b = ''; for await (const c of req) b += c; return b }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, s.base)
    const json = (status: number, o: unknown, h: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)) }
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: s.url, authorization_servers: [s.base] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, {
      issuer: s.base, authorization_endpoint: `${s.base}/authorize`, token_endpoint: `${s.base}/token`, registration_endpoint: `${s.base}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], ...(opts.cimd ? { client_id_metadata_document_supported: true } : {}),
    })
    if (u.pathname === '/register' && req.method === 'POST') {
      s.registrations++
      return json(201, { ...JSON.parse(await body(req)), client_id: `dcr-client-${s.registrations}` })
    }
    if (u.pathname === '/authorize') {
      const code = randomBytes(12).toString('base64url')
      const client = u.searchParams.get('client_id')!
      s.clientIds.push(client)
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, client })
      const back = new URL(u.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', u.searchParams.get('state')!)
      res.writeHead(302, { location: back.href }); return res.end()
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(await body(req))
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code')!)
        codes.delete(f.get('code')!)
        const ok = c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge
        return ok ? json(200, tokens(c!.client)) : json(400, { error: 'invalid_grant' })
      }
      if (f.get('grant_type') === 'refresh_token') {
        s.refreshes++
        await new Promise((r) => setTimeout(r, opts.tokenDelayMs ?? 0))
        const client = refresh.get(f.get('refresh_token')!)
        if (!client) { s.refused++; return json(400, { error: 'invalid_grant', error_description: 'refresh token was used already or revoked' }) }
        refresh.delete(f.get('refresh_token')!) // rotation: each refresh token works once
        return json(200, tokens(client))
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (u.pathname === '/export') {
      // an API next to the MCP endpoint that is not MCP, with the same token (fetchWithGrant)
      const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      return t && access.has(t) ? json(200, { highlights: ['one'], q: u.searchParams.get('q') }) : json(401, { error: 'invalid_token' })
    }
    if (u.pathname === '/mcp') {
      const auth = req.headers.authorization ?? ''
      s.seen.push(auth)
      const t = /^Bearer (.+)$/.exec(auth)?.[1]
      if (!t || !access.has(t)) return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp"` })
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      const m = JSON.parse(await body(req))
      if (m.id === undefined) { res.writeHead(202); return res.end() }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] }
        : m.method === 'tools/call' && m.params?.name === 'whoami' ? { content: [{ type: 'text', text: `you are alice (${JSON.stringify(m.params.arguments ?? {})})` }] }
        : undefined
      return json(200, result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } }, { 'mcp-session-id': 'session-1' })
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  s.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  s.url = `${s.base}/mcp`
  s.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  return s
}

/** Follows the sign-in page to its redirect, as the user's browser would, and returns the code and state. */
export async function signInAsUser(signInUrl: string): Promise<{ code: string; state: string }> {
  const r = await fetch(signInUrl, { redirect: 'manual' })
  const back = new URL(r.headers.get('location')!)
  return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! }
}
