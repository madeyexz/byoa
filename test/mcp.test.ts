// R2 and R3 with a local MCP server and its own OAuth server (test/helpers/mcp-server.ts).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { createAgents, memoryStore, type Store } from '../src/index.ts'
import { JobTokens } from '../src/mcp/proxy.ts'
import { localSandbox } from '../src/sandbox/local.ts'
import { fakeApi, fakeMcp, signInAsUser, type FakeApi, type FakeMcp } from './helpers/mcp-server.ts'

const KEY = randomBytes(32).toString('base64')
const PROXY = 'http://127.0.0.1:1/byoa/mcp'
const servers: (FakeMcp | FakeApi)[] = []
after(() => Promise.all(servers.map((s) => s.close())))

const agentsOn = (store: Store, extra: { clientMetadataUrl?: string; grantOrigins?: Record<string, string[]> } = {}) => createAgents({
  app: 'testapp', sandbox: localSandbox(), store, encryptionKey: KEY, proxyUrl: PROXY, grantOrigins: extra.grantOrigins,
  oauth: { redirectUrl: 'http://127.0.0.1:9/callback', clientName: 'Test app', clientMetadataUrl: extra.clientMetadataUrl },
})

async function connected(opts: Parameters<typeof fakeMcp>[0] = {}, extra: { clientMetadataUrl?: string } = {}) {
  const mcp = await fakeMcp(opts)
  servers.push(mcp)
  const store = memoryStore()
  const agents = agentsOn(store, extra)
  const r = await agents.connectMcp('alice', mcp.url, { name: 'notes' })
  assert.equal(r.connected, false)
  if (r.connected) throw new Error('unreachable')
  const back = await signInAsUser(r.signInUrl)
  assert.deepEqual(await agents.finishMcp(back), { user: 'alice', name: 'notes' })
  return { mcp, store, agents }
}

const call = (proxy: (r: Request) => Promise<Response>, token: string | undefined, server = 'notes', body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) =>
  proxy(new Request(`${PROXY}/${server}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }))

test('R2.1: a server without Client ID Metadata Document support gets Dynamic Client Registration', async () => {
  const { mcp, store, agents } = await connected({}, { clientMetadataUrl: 'https://app.example.com/oauth/client.json' })
  assert.equal(mcp.registrations, 1)
  assert.equal(mcp.clientIds[0], 'dcr-client-1')
  assert.deepEqual(await agents.listMcp('alice'), [{ name: 'notes', url: mcp.url }])
  // R2.4: the store holds the grant encrypted: no token in it as text
  const all = (await Promise.all((store as ReturnType<typeof memoryStore>).keys().map((k) => store.get(k)))).map((e) => e!.value).join('\n')
  for (const t of mcp.issued) assert.ok(!all.includes(t), 'a real token is in the store as plain text')
})

test('R2.1: a server that supports Client ID Metadata Documents gets the app\'s document URL, and no registration', async () => {
  const { mcp, agents } = await connected({ cimd: true }, { clientMetadataUrl: 'https://app.example.com/oauth/client.json' })
  assert.equal(mcp.registrations, 0)
  assert.equal(mcp.clientIds[0], 'https://app.example.com/oauth/client.json')
  assert.equal(agents.clientMetadata().client_id, 'https://app.example.com/oauth/client.json')
  assert.deepEqual(agents.clientMetadata().redirect_uris, ['http://127.0.0.1:9/callback'])
})

test('R2.2: a pasted bearer token is checked, then used', async () => {
  const { mcp, agents } = await connected()
  await assert.rejects(agents.connectMcp('bob', mcp.url, { name: 'pasted', bearer: 'not-a-token' }), /did not accept the token/)
  const real = mcp.issued.find((t) => t.startsWith('real_access'))!
  assert.deepEqual(await agents.connectMcp('bob', mcp.url, { name: 'pasted', bearer: real }), { name: 'pasted', connected: true })
})

test('R2.1: a server with no sign-in is connected at once, and the proxy sends its requests on with no token', async () => {
  const seen: (string | undefined)[] = []
  const server = createServer(async (req, res) => {
    seen.push(req.headers.authorization)
    let b = ''
    for await (const c of req) b += c
    const m = JSON.parse(b)
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'open', version: '1' } } : { content: [{ type: 'text', text: 'an open answer' }] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const store = memoryStore(), agents = agentsOn(store)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    assert.deepEqual(await agents.connectMcp('alice', url, { name: 'open' }), { name: 'open', connected: true })
    const { token } = await new JobTokens(store).issue('alice', ['open'], 60_000)
    const r = await call(agents.proxy, token, 'open')
    assert.equal(r.status, 200)
    assert.match(JSON.stringify(await r.json()), /an open answer/)
    // connectMcp's first request and the job's call: byoa has no token for this server, and the job token stays behind
    assert.deepEqual(seen, [undefined, undefined])
    assert.equal((await call(agents.proxy, 'byoa_job_made_up', 'open')).status, 401, 'the proxy still checks the job token')
  } finally { server.closeAllConnections(); server.close() }
})

test('R3: the proxy checks the job token, sends only the real token on, and refuses a job token after its job', async () => {
  const { mcp, store, agents } = await connected()
  const jobs = new JobTokens(store)
  const probes = mcp.seen.length // connectMcp's first request, with no token
  assert.equal((await call(agents.proxy, undefined)).status, 401)
  assert.equal((await call(agents.proxy, 'byoa_job_made_up')).status, 401)
  const { token, job } = await jobs.issue('alice', ['notes'], 60_000)
  const ok = await call(agents.proxy, token)
  assert.equal(ok.status, 200)
  assert.match(JSON.stringify(await ok.json()), /you are alice/)
  assert.equal((await call(agents.proxy, token, 'other')).status, 403, 'a server the job was not given')
  // the MCP server saw only real tokens, never the job token
  const viaProxy = mcp.seen.slice(probes)
  assert.ok(viaProxy.length > 0 && viaProxy.every((h) => h.startsWith('Bearer real_access_')), viaProxy.join(', '))
  await jobs.end(job)
  assert.equal((await call(agents.proxy, token)).status, 401, 'R3.4: the job ended')
  // a job token of another user does not reach alice's grant
  const bob = await jobs.issue('bob', ['notes'], 60_000)
  assert.equal((await call(agents.proxy, bob.token)).status, 403)
})

test('R3: the proxy does not pass on the MCP server\'s sign-in challenge', async () => {
  const { mcp, store, agents } = await connected()
  const { token } = await new JobTokens(store).issue('alice', ['notes'], 60_000)
  mcp.expireAccess()
  // the proxy refreshes once and retries; this time the server takes the new token
  const r = await call(agents.proxy, token)
  assert.equal(r.status, 200)
  assert.equal(mcp.refreshes, 1)
  assert.equal(r.headers.get('www-authenticate'), null)
})

test('R2.3 / R6.2: two backends that share one store refresh an expired grant once, and both requests succeed', async () => {
  // tokens live 1 s, so after 0.6 s byoa sees them as about to run out; the token endpoint is slow, to widen the race
  const { mcp, store } = await connected({ expiresIn: 1, tokenDelayMs: 300 })
  const a = agentsOn(store), b = agentsOn(store) // two processes, one database
  const jobs = new JobTokens(store)
  const [j1, j2] = await Promise.all([jobs.issue('alice', ['notes'], 60_000), jobs.issue('alice', ['notes'], 60_000)])
  await new Promise((r) => setTimeout(r, 600))
  const before = mcp.refreshes
  const rs = await Promise.all([call(a.proxy, j1.token), call(b.proxy, j2.token), call(a.proxy, j1.token), call(b.proxy, j2.token)])
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200])
  assert.equal(mcp.refreshes - before, 1, 'one refresh request for four requests in two processes')
  assert.equal(mcp.refused, 0, 'no refresh token was used twice')
})

test('R2: a refresh token the server no longer takes asks the user to connect again', async () => {
  const { mcp, store, agents } = await connected({ expiresIn: 1 })
  const { token } = await new JobTokens(store).issue('alice', ['notes'], 60_000)
  // another client used the refresh token (or the user revoked it at the server)
  const g = (await import('../src/mcp/grants.ts'))
  const grants = new g.Grants(store, (await import('../src/crypto.ts')).importKey(KEY), { redirectUrl: 'http://127.0.0.1:9/callback', clientName: 'x' })
  const rt = (await grants.read('alice', 'notes'))!.grant.oauth!.tokens!.refresh_token!
  await fetch(`${mcp.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }) })
  mcp.expireAccess()
  await new Promise((r) => setTimeout(r, 600))
  const r = await call(agents.proxy, token)
  assert.equal(r.status, 403)
  assert.match(JSON.stringify(await r.json()), /connect it again/)
  assert.equal((await grants.read('alice', 'notes'))!.grant.needsSignIn, true)
})

test('R2.6: fetchWithGrant sends the grant only to its server\'s origin, and refreshes it through the one owner', async () => {
  const { mcp, store, agents } = await connected()
  const r = await agents.fetchWithGrant('alice', 'notes', `${mcp.base}/export?q=x`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { highlights: ['one'], q: 'x' })
  const other = `http://localhost:${new URL(mcp.base).port}/export` // the same server, but another origin
  await assert.rejects(agents.fetchWithGrant('alice', 'notes', other), /goes only to/)
  await assert.rejects(agents.fetchWithGrant('alice', 'gmail', `${mcp.base}/export`), /not connected/)
  // the server refuses the token: a backend request and a job's MCP call at once cause one refresh
  mcp.expireAccess()
  const { token } = await new JobTokens(store).issue('alice', ['notes'], 60_000)
  const [e, m] = await Promise.all([agents.fetchWithGrant('alice', 'notes', `${mcp.base}/export`), call(agents.proxy, token)])
  assert.equal(e.status, 200)
  assert.equal(m.status, 200)
  assert.equal(mcp.refreshes, 1)
})

test('R2.6: fetchWithGrant sends the grant to another origin only when the app gave it for that MCP server', async () => {
  const { mcp, store, agents } = await connected()
  const api = await fakeApi(mcp)
  servers.push(api)
  const exportUrl = `${api.origin}/ext/export`
  // no grantOrigins: the token stays at the MCP server's origin, and the API gets no request at all
  await assert.rejects(agents.fetchWithGrant('alice', 'notes', exportUrl), /goes only to/)
  // grantOrigins for another MCP server's origin do not reach this grant
  const elsewhere = agentsOn(store, { grantOrigins: { 'https://other.example.com': [api.origin] } })
  await assert.rejects(elsewhere.fetchWithGrant('alice', 'notes', exportUrl), /goes only to/)
  assert.equal(api.seen.length, 0)

  const withApi = agentsOn(store, { grantOrigins: { [mcp.base]: [api.origin] } })
  const r = await withApi.fetchWithGrant('alice', 'notes', exportUrl)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { highlights: ['web'] })
  // a refused token is refreshed by the one owner, then sent again to the same allowed origin
  mcp.expireAccess()
  assert.equal((await withApi.fetchWithGrant('alice', 'notes', exportUrl)).status, 200)
  assert.equal(mcp.refreshes, 1)
  assert.ok(api.seen.every((x) => x.host === new URL(api.origin).host && x.auth?.startsWith('Bearer real_access_')), JSON.stringify(api.seen))

  // still only that exact origin: the same server under another host name gets nothing
  const before = api.seen.length
  await assert.rejects(withApi.fetchWithGrant('alice', 'notes', `http://localhost:${new URL(api.origin).port}/ext/export`), /goes only to/)
  // a redirect from the allowed origin comes back to the app, and is not followed
  const moved = await withApi.fetchWithGrant('alice', 'notes', `${api.origin}/moved?to=${encodeURIComponent(`http://localhost:${new URL(api.origin).port}/ext/export`)}`)
  assert.equal(moved.status, 302)
  assert.deepEqual(api.seen.slice(before).map((x) => x.path), ['/moved'])
})

test('R2.6: grantOrigins takes only exact origins', () => {
  const mcpOrigin = 'https://margin.example.com'
  for (const bad of ['https://api.example.com/ext', 'https://*.convex.site', 'http://api.example.com', 'api.example.com', 'https://API.example.com', 'https://api.example.com/'])
    assert.throws(() => agentsOn(memoryStore(), { grantOrigins: { [mcpOrigin]: [bad] } }), /grantOrigins/, bad)
  assert.throws(() => agentsOn(memoryStore(), { grantOrigins: { 'https://margin.example.com/mcp': ['https://api.example.com'] } }), /grantOrigins/)
  agentsOn(memoryStore(), { grantOrigins: { [mcpOrigin]: ['https://helpful-tern-930.convex.site', 'http://127.0.0.1:8080'] } })
})

test('R2: importMcp moves an existing grant into byoa; the proxy uses it and refreshes it', async () => {
  const { mcp, store: oldStore } = await connected()
  const g = await import('../src/mcp/grants.ts')
  const old = new g.Grants(oldStore, (await import('../src/crypto.ts')).importKey(KEY), { redirectUrl: 'http://127.0.0.1:9/callback', clientName: 'x' })
  const grant = (await old.read('alice', 'notes'))!.grant
  const store = memoryStore()
  const agents = agentsOn(store)
  await assert.rejects(agents.importMcp('alice', { name: 'notes', url: mcp.url, oauth: {} }), /client and tokens/)
  assert.deepEqual(await agents.importMcp('alice', { name: 'notes', url: mcp.url, oauth: { ...grant.oauth!, verifier: 'left over' } }), { name: 'notes' })
  await old.remove('alice', 'notes') // moved, not copied: one refresh owner
  assert.deepEqual(await agents.listMcp('alice'), [{ name: 'notes', url: mcp.url }])
  const { token } = await new JobTokens(store).issue('alice', ['notes'], 60_000)
  assert.equal((await call(agents.proxy, token)).status, 200)
  mcp.expireAccess()
  assert.equal((await call(agents.proxy, token)).status, 200)
  assert.equal(mcp.refreshes, 1)
})
