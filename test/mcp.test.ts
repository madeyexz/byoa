// R2 and R3 with a local MCP server and its own OAuth server (test/helpers/mcp-server.ts).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, test } from 'node:test'
import { createAgents, memoryStore, type Store } from '../src/index.ts'
import { JobTokens } from '../src/mcp/proxy.ts'
import { localSandbox } from '../src/sandbox/local.ts'
import { fakeMcp, signInAsUser, type FakeMcp } from './helpers/mcp-server.ts'

const KEY = randomBytes(32).toString('base64')
const PROXY = 'http://127.0.0.1:1/byoa/mcp'
const servers: FakeMcp[] = []
after(() => Promise.all(servers.map((s) => s.close())))

const agentsOn = (store: Store, extra: { clientMetadataUrl?: string } = {}) => createAgents({
  app: 'testapp', sandbox: localSandbox(), store, encryptionKey: KEY, proxyUrl: PROXY,
  oauth: { redirectUrl: 'http://127.0.0.1:9/callback', clientName: 'Test app', ...extra },
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
