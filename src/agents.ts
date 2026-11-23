// createAgents: the one object an app uses. It ties together the store (R6), the sandbox provider (R5.3), the login
// driver (R1), the MCP grants and their one refresh owner (R2), the proxy (R3), the config writers (R4) and the
// harness installer (R5.1).
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { ACCESS, CLAUDE_MCP_CONFIG, JOB_TOKEN_ENV, SERVER_NAME, harnessFiles, serverUrl, type Access, type Plugin, type Setup } from './config.ts'
import { importKey, open, randomToken, seal, sha256hex } from './crypto.ts'
import { claudeArgs, claudeReader } from './harness/claude.ts'
import { codexArgs, codexReader } from './harness/codex.ts'
import type { AgentEvent, EventReader } from './harness/events.ts'
import { FAKE_JS, fakeReader } from './harness/fake.ts'
import { ensureHarness } from './harness/install.ts'
import { PINS, type HarnessName, type Pins } from './harness/pins.ts'
import { storedLogin } from './login-stored.ts'
import type { LoginDeps, LoginDriver } from './login.ts'
import { GrantError, Grants, type Grant } from './mcp/grants.ts'
import { Provider, clientMetadataDocument, type OAuthConfig } from './mcp/oauth.ts'
import { JobTokens, PROXY_HEADER, mcpProxy } from './mcp/proxy.ts'
import { checkTools, type AppTools } from './mcp/tools.ts'
import { SandboxGoneError, type Sandbox, type SandboxProvider } from './sandbox/types.ts'
import { q } from './sh.ts'
import type { Store } from './store.ts'

export interface AgentsOptions {
  /** The app's own name (lower-case letters, digits, -). It names this app's sandboxes, and every login volume of
   *  cliLogin, so one app's AI login is never another app's (Lab rules). */
  app: string
  sandbox: SandboxProvider
  store: Store
  /** 32 random bytes as base64 (`openssl rand -base64 32`). byoa encrypts every MCP grant (R2.4) and, by default,
   *  every AI login (R1.4) with it. */
  encryptionKey: string
  /** The public URL where the app serves `agents.proxy`, such as https://app.example.com/byoa/mcp. Each MCP server
   *  is at `<proxyUrl>/<name>`. */
  proxyUrl: string
  oauth: { redirectUrl: string; clientMetadataUrl?: string; clientName?: string }
  pins?: Pins
  /** Where the AI login stays (R1.5). Default: storedLogin(), encrypted in `store` (R1.4). `cliLogin`: in a volume
   *  of the user, through the sandbox adapter. */
  login?: (deps: LoginDeps) => LoginDriver
  /** The most one job may take. Default 30 minutes. */
  jobTimeoutMs?: number
  /** Where jobs run (R5.4). `user` (the default): byoa keeps the user's sandbox, pauses it after each job and resumes
   *  it for the next one. Each user has one for each harness, or one for each `sandboxKey` that a job names (such as a
   *  project or a conversation); one job of a sandbox runs at a time, and another waits. `job`: a new sandbox for each
   *  job, destroyed after it. */
  sandboxPer?: 'user' | 'job'
  /** With `sandboxPer: 'user'`: how long a job waits for another job of the same sandbox to end. Default 10 minutes. */
  waitMs?: number
  /** More origins that fetchWithGrant may send a grant's token to (R2.6), by the origin of the grant's MCP server:
   *  `{ 'https://margin.rippling.computer': ['https://helpful-tern-930.convex.site'] }`. Only for an API of that same
   *  service that takes the same token. Each key and value is an exact origin (https, or http on localhost): no path,
   *  no wildcard. */
  grantOrigins?: Record<string, string[]>
  /** The app's own tools (R2.7), as functions in this backend: MCP server name → tool name → tool. A job gets a group
   *  by its name in `mcp`. The proxy serves them at `<proxyUrl>/<name>` and gives `run` the user of the job, so the
   *  app writes no MCP server and connects nothing for each user. */
  tools?: AppTools
}

export type RunHarness = HarnessName | 'fake'

export interface RunOptions {
  harness: RunHarness
  task: string
  setup?: Setup
  plugins?: Plugin[]
  /** The MCP servers (names given to connectMcp) this job gets (R2.5). Default: none. A plugin's servers are added. */
  mcp?: string[]
  model?: string
  /** With `sandboxPer: 'user'`: which of the user's kept sandboxes the job runs in, such as a project or conversation
   *  id. Jobs with the same key (and harness) share one sandbox, paused between them. Default: the user's one sandbox
   *  for the harness. */
  sandboxKey?: string
  /** What the agent may do (R5.6). Default `full`: every tool of the harness, with no approval. `read-only`: the
   *  job's MCP tools, and reading files; no change to a file, and no network but the job's MCP servers. */
  access?: Access
}

export interface SessionOptions {
  harness: RunHarness
  setup?: Setup
  plugins?: Plugin[]
  /** The MCP servers this job gets (R2.5). Default: none. A plugin's servers are added. */
  mcp?: string[]
  /** As in RunOptions. */
  sandboxKey?: string
  /** As in RunOptions. Here it changes only the files byoa writes (Codex's MCP config): the app starts the harness
   *  itself, with its own flags. */
  access?: Access
}

export interface Session {
  sandbox: Sandbox
  /** The job's folder, with the files byoa writes for the harness (R4). */
  work: string
  harness: RunHarness
  /** The pinned, unmodified harness binary in the sandbox (for `fake`: the fake harness's script, run with node). */
  bin: string
  version: string
  /** The harness's environment: its login folder and the job token (JOB_TOKEN_ENV). */
  env: Record<string, string>
  /** The job token: each MCP server below takes it as `Authorization: Bearer`, until close. */
  token: string
  /** The MCP servers this job has, at the proxy (R3.1). */
  mcp: { name: string; url: string }[]
  /** Servers asked for that this user has not connected; the job runs without them. */
  missing: string[]
  /** Servers of this job that did not answer one MCP `initialize` from the sandbox through the proxy (R3.5), each
   *  with the reason. The harness may not have their tools. */
  failing: { name: string; message: string }[]
  /** What the harness showed of its login: `expired` when it refused it, `signed-in` when a job worked (R1.6). */
  reportLogin(state: 'signed-in' | 'expired'): Promise<void>
  /** Ends the job token (R3.4), saves the login the CLI refreshed and removes it from the sandbox (R1.4), and pauses
   *  the user's sandbox, or destroys a sandbox of one job (R5.4). */
  close(): Promise<void>
}

export interface JobToken {
  /** Send it as `Authorization: Bearer` to each server in `mcp`. */
  token: string
  job: string
  /** The MCP servers this token reaches, at the proxy. */
  mcp: { name: string; url: string }[]
  /** Servers asked for that this user has not connected. */
  missing: string[]
  /** Ends the token (R3.4). */
  close(): Promise<void>
}

/** The harness has no login for this user. */
export class LoginError extends Error { readonly code = 'signed-out' }

/** The job's sandbox cannot reach the MCP proxy at `proxyUrl` (R3.5), so no MCP tool of the job can work. */
export class ProxyError extends Error { readonly code = 'mcp' }

/** Runs with node in the job's sandbox, before the harness: one MCP `initialize` to each of the job's servers at the
 *  proxy, with the job token. It prints, for each server, whether the proxy answered and with which status. */
const CHECK_JS = String.raw`
const servers = JSON.parse(process.env.BYOA_CHECK)
const auth = { authorization: 'Bearer ' + process.env.${JOB_TOKEN_ENV} }
const one = async (s, n = 0) => {
  try {
    const r = await fetch(s.url, {
      method: 'POST', signal: AbortSignal.timeout(70000),
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'byoa-check', version: '1' } } }),
    })
    // the proxy's own header; or, behind a relay that drops headers, an MCP answer (JSON-RPC, or a stream of them)
    let proxy = r.headers.get('${PROXY_HEADER}') === '1', message = ''
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) { proxy = true; await r.body?.cancel() }
    else {
      const text = await r.text()
      try { const m = JSON.parse(text); if (m?.jsonrpc === '2.0') proxy = true; message = m?.error?.message || '' } catch {}
    }
    const sid = r.ok && r.headers.get('mcp-session-id')
    if (sid) await fetch(s.url, { method: 'DELETE', signal: AbortSignal.timeout(5000), headers: { ...auth, 'mcp-session-id': sid } }).then((d) => d.body?.cancel(), () => {})
    return { name: s.name, proxy, status: r.status, message: r.ok ? '' : message }
  } catch (e) {
    // no answer at all (not a timeout): a name lookup or a connection can fail one time in a new sandbox, so try 3 times
    if (n < 2 && e?.name !== 'TimeoutError') { await new Promise((r) => setTimeout(r, 1000 * (n + 1))); return one(s, n + 1) }
    return { name: s.name, proxy: false, status: 0, message: String(e?.cause?.message || e?.message || e) }
  }
}
console.log(JSON.stringify(await Promise.all(servers.map((s) => one(s)))))
`

export type ConnectResult = { name: string; connected: true } | { name: string; connected: false; signInUrl: string }

const FLOW_MS = 15 * 60_000
const flowKey = (state: string) => `mcpflow/${state}`
/** A kept sandbox of the user at one provider, for one harness and sandbox key ('' for none) (R5.4): its id there, and
 *  the lease of the job that uses it. The index lists the user's slots, because a store cannot list its keys. */
const enc = encodeURIComponent
const slotKey = (user: string, provider: string, h: RunHarness, key: string) => `usersandbox/${enc(user)}/${provider}/${h}/${enc(key)}`
const indexKey = (user: string, provider: string) => `usersandboxes/${enc(user)}/${provider}`
interface Slot { sandbox?: string; holder?: string; until: number }
type Indexed = [RunHarness, string]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const secure = (u: URL) => u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))

/** `s` when it is an exact origin that may get a token, such as https://api.example.com. */
function exactOrigin(s: string): string {
  let u: URL | undefined
  try { u = new URL(s) } catch {}
  if (!u || u.origin !== s || !secure(u) || u.hostname.includes('*')) throw new Error(`byoa: grantOrigins: ${JSON.stringify(s)} is not an origin such as https://api.example.com`)
  return s
}

export function createAgents(o: AgentsOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(o.app)) throw new Error('byoa: app: lower-case letters, digits and -, at most 24')
  const key = importKey(o.encryptionKey)
  key.catch(() => {}) // reported where it is used
  const oauth: OAuthConfig = { redirectUrl: o.oauth.redirectUrl, clientMetadataUrl: o.oauth.clientMetadataUrl, clientName: o.oauth.clientName ?? o.app }
  const pins = o.pins ?? PINS
  const grants = new Grants(o.store, key, oauth)
  const jobs = new JobTokens(o.store)
  const login = (o.login ?? storedLogin())({ sandbox: o.sandbox, store: o.store, app: o.app, pins, encryptionKey: o.encryptionKey, jobTimeoutMs: o.jobTimeoutMs })
  const timeout = o.jobTimeoutMs ?? 30 * 60_000
  const keep = (o.sandboxPer ?? 'user') === 'user'
  if (!['user', 'job'].includes(o.sandboxPer ?? 'user')) throw new Error("byoa: sandboxPer: 'user' or 'job'")
  const waitMs = o.waitMs ?? 10 * 60_000
  const grantOrigins = new Map(Object.entries(o.grantOrigins ?? {}).map(([mcp, extra]) => [exactOrigin(mcp), extra.map(exactOrigin)]))
  const tools: AppTools = o.tools ?? {}
  for (const [name, group] of Object.entries(tools)) {
    if (!SERVER_NAME.test(name)) throw new Error(`byoa: tools: server name ${JSON.stringify(name)}: lower-case letters, digits and -, at most 32`)
    checkTools(name, group)
  }
  const isTools = (name: string) => Object.prototype.hasOwnProperty.call(tools, name)
  /** The names a job can ask for in `mcp`: the user's connected servers, and the app's own tools. */
  const serversOf = async (user: string) => new Set([...(await grants.list(user)).map((g) => g.name), ...Object.keys(tools)])

  /** One MCP `initialize`, to see whether the server answers and whether it wants a token. */
  async function probe(url: string, token?: string): Promise<'ok' | 'unauthorized' | string> {
    try {
      const r = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: o.app, version: '1' } } }),
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
    if (isTools(name)) throw new Error(`byoa: ${name} is the name of the app's own tools; connect the server with another name`)
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
    const k = flowKey(prov.id)
    await o.store.put(k, await seal(await key, JSON.stringify({ user, name, url: u.href, s: prov.s, until: Date.now() + FLOW_MS }), k))
    return { name, connected: false, signInUrl: prov.url.href }
  }

  /** The server's sign-in page sent the browser back to `oauth.redirectUrl` with `code` and `state`. */
  async function finishMcp(params: { state: string; code?: string; error?: string }): Promise<{ user: string; name: string }> {
    const k = flowKey(params.state)
    const e = await o.store.get(k)
    if (!e || !/^[A-Za-z0-9_-]+$/.test(params.state)) throw new Error('byoa: this sign-in is not known, or it ran out')
    await o.store.delete(k)
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
    if (isTools(g.name)) throw new Error(`byoa: ${g.name} is the name of the app's own tools; import the grant with another name`)
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

  /** A job token with no sandbox (R3), for an app's own program that runs a harness somewhere else, such as on the
   *  user's own computer. The same rules as a job's token: one user, only the servers named that this user has
   *  connected, refused after `close` (R3.4) and after `ttlMs` (default: the job timeout and 5 minutes). */
  async function jobToken(user: string, r: { mcp?: string[]; ttlMs?: number } = {}): Promise<JobToken> {
    const want = [...new Set(r.mcp ?? [])]
    const have = await serversOf(user)
    const servers = want.filter((s) => have.has(s))
    const { token, job } = await jobs.issue(user, servers, r.ttlMs ?? timeout + 5 * 60_000)
    let closed = false
    return {
      token, job,
      mcp: servers.map((name) => ({ name, url: serverUrl(o.proxyUrl, name) })),
      missing: want.filter((s) => !have.has(s)),
      async close() { if (!closed) { closed = true; await jobs.end(job) } },
    }
  }

  /** Changes the user's index of slots with compare-and-set. */
  async function changeIndex(user: string, f: (list: Indexed[]) => Indexed[]) {
    const k = indexKey(user, o.sandbox.name)
    for (;;) {
      const e = await o.store.get(k)
      const now: Indexed[] = e ? JSON.parse(e.value) : []
      const next = f(now)
      if (JSON.stringify(next) === JSON.stringify(now)) return now
      if (await o.store.cas(k, e?.version ?? null, JSON.stringify(next))) return now
    }
  }

  /** Takes one of the user's kept sandboxes, with compare-and-set: a job waits while another job of the same sandbox
   *  holds it. A lease left by a job that never ended runs out after the job timeout and 5 minutes. */
  async function takeSlot(user: string, h: RunHarness, key: string): Promise<{ k: string; holder: string; sandbox?: string }> {
    const k = slotKey(user, o.sandbox.name, h, key), holder = randomToken(12)
    for (const end = Date.now() + waitMs; ;) {
      const e = await o.store.get(k)
      if (!e) await changeIndex(user, (l) => l.some(([x, y]) => x === h && y === key) ? l : [...l, [h, key]])
      const cur: Slot = e ? JSON.parse(e.value) : { until: 0 }
      if (cur.until < Date.now() && (await o.store.cas(k, e?.version ?? null, JSON.stringify({ sandbox: cur.sandbox, holder, until: Date.now() + timeout + 5 * 60_000 })))) return { k, holder, sandbox: cur.sandbox }
      if (Date.now() > end) throw new Error(`byoa: another job of this user still holds the ${h} sandbox${key ? ` ${JSON.stringify(key)}` : ''}; try again when it ends`)
      await sleep(500)
    }
  }
  /** Changes the slot while `holder` holds it. False when it does not (deleteSandbox removed it meanwhile). */
  async function setSlot(k: string, holder: string, next: Slot): Promise<boolean> {
    const e = await o.store.get(k)
    if (!e || (JSON.parse(e.value) as Slot).holder !== holder) return false
    return o.store.cas(k, e.version, JSON.stringify(next))
  }

  /** Deletes the user's kept sandboxes of this app at this provider (R5.4): all of them, or those of one harness or one
   *  sandbox key. For sign-out, when the app deletes the user, and when it deletes a project or conversation that had
   *  a sandbox key. A job that runs in one of them ends. The AI login and the MCP grants stay. */
  async function deleteSandbox(user: string, which: { harness?: RunHarness; sandboxKey?: string } = {}) {
    const match = ([h, key]: Indexed) => (which.harness === undefined || h === which.harness) && (which.sandboxKey === undefined || key === which.sandboxKey)
    const e = await o.store.get(indexKey(user, o.sandbox.name))
    const list: Indexed[] = (e ? JSON.parse(e.value) as Indexed[] : []).filter(match)
    for (const [h, key] of list) {
      const k = slotKey(user, o.sandbox.name, h, key)
      const s = await o.store.get(k)
      const id = s && (JSON.parse(s.value) as Slot).sandbox
      if (id) await o.sandbox.destroy(id)
      await o.store.delete(k)
    }
    await changeIndex(user, (l) => l.filter((x) => !list.some((y) => y[0] === x[0] && y[1] === x[1])))
  }

  /** Opens one job (R5.4) for an app that runs its own program around the unmodified harness (Bookish runs its own
   *  core, which starts `claude` or `codex`): the user's sandbox (or, with `sandboxPer: 'job'`, a new one) with the
   *  user's AI login, the pinned harness, the user's setup in a new `work` folder, and a job token for the MCP
   *  servers this job gets. `close` ends the job token, saves the login and removes it from the sandbox, and pauses
   *  the sandbox (or destroys it); call it in a `finally`. Throws LoginError when the harness is not signed in. */
  async function session(user: string, r: SessionOptions): Promise<Session> {
    const h = r.harness
    if (r.sandboxKey !== undefined && (!keep || typeof r.sandboxKey !== 'string' || !r.sandboxKey || r.sandboxKey.length > 128)) {
      throw new Error(keep ? 'byoa: sandboxKey: a string of 1 to 128 characters' : "byoa: sandboxKey needs sandboxPer: 'user'")
    }
    if (r.access !== undefined && !ACCESS.includes(r.access)) throw new Error("byoa: access: 'full' or 'read-only'")
    const key = r.sandboxKey ?? ''
    const plugins = r.plugins ?? []
    const t = await jobToken(user, { mcp: [...(r.mcp ?? []), ...plugins.flatMap((p) => p.mcp.map((m) => m.name))] })
    const { token, job } = t
    let sbx: Sandbox | undefined, slot: { k: string; holder: string; sandbox?: string } | undefined, closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await t.close().catch(() => {})
      // the stored login (the default) saves what the CLI changed, removes its files and gives its lease back, before
      // the sandbox pauses or goes. A kept sandbox whose login could not be removed is destroyed instead.
      const released = !sbx || h === 'fake' || (await (login.release?.(sbx, user, h) ?? Promise.resolve()).then(() => true, () => false))
      if (!slot) return sbx?.destroy()
      try {
        if (sbx && released) await sbx.pause()
        else if (sbx) { await sbx.destroy(); slot.sandbox = undefined }
      } finally {
        await setSlot(slot.k, slot.holder, { sandbox: slot.sandbox, until: 0 })
      }
    }
    try {
      const setup: Setup = { agentsMd: r.setup?.agentsMd, skills: [...(r.setup?.skills ?? []), ...plugins.flatMap((p) => p.setup.skills ?? [])] }
      const files = harnessFiles(h === 'codex' ? 'codex' : 'claude', setup, { proxyUrl: o.proxyUrl, servers: t.mcp.map((m) => m.name), access: r.access })
      if (keep) {
        slot = await takeSlot(user, h, key)
        if (slot.sandbox) {
          try { sbx = await o.sandbox.resume(slot.sandbox, { timeoutMs: timeout + 60_000 }) } catch (e) {
            // deleted or expired at the provider: the user gets a new one
            if (!(e instanceof SandboxGoneError)) throw e
          }
        }
      }
      if (!sbx) {
        const labels: Record<string, string> = slot
          ? { 'byoa-app': o.app, 'byoa-harness': h, 'byoa-user': (await sha256hex(user)).slice(0, 24), ...(key ? { 'byoa-key': (await sha256hex(key)).slice(0, 24) } : {}) }
          : { 'byoa-app': o.app, 'byoa-job': job }
        sbx = await o.sandbox.create({ volumes: h === 'fake' ? [] : await login.volumes(user, h), labels, timeoutMs: timeout + 60_000, keep: !!slot })
        if (slot) {
          slot.sandbox = sbx.id
          if (!(await setSlot(slot.k, slot.holder, { sandbox: sbx.id, holder: slot.holder, until: Date.now() + timeout + 5 * 60_000 }))) {
            slot = undefined
            throw new Error('byoa: the user\'s sandbox was deleted while this job started')
          }
        }
      }
      const work = `${sbx.home}/work`
      // each job's folder is new, also in a kept sandbox: no skills, MCP config or task of an earlier job
      if (slot) await sbx.run(`rm -rf ${q(work)} && mkdir -p ${q(work)}`)
      let bin: string, version: string, env: Record<string, string> = {}
      if (h !== 'fake' && !(await login.present(sbx, user, h))) {
        await login.setState(user, h, 'signed-out')
        throw new LoginError(`${h} is not signed in for this user; call connectLogin first`)
      }
      // before the harness and the login: a job whose sandbox cannot reach the proxy must not start (R3.5)
      const failing = await checkServers(sbx, t)
      if (h === 'fake') {
        bin = `${sbx.home}/.byoa/fake.mjs`
        await sbx.writeFile(bin, FAKE_JS)
        version = 'fake'
      } else {
        const inst = await ensureHarness(sbx, h, pins)
        bin = inst.bin
        version = inst.version
        env = await login.env(sbx, user, h)
      }
      for (const [p, text] of Object.entries(files)) await sbx.writeFile(`${work}/${p}`, text)
      const box = sbx
      return {
        sandbox: box, work, harness: h, bin, version, token,
        env: { ...env, [JOB_TOKEN_ENV]: token },
        mcp: t.mcp,
        missing: t.missing,
        failing,
        close,
        async reportLogin(state) {
          if (h === 'fake') return
          if (state === 'expired' || (await login.state(user, h)) !== state) await login.setState(user, h, state)
        },
      }
    } catch (e) {
      await close().catch(() => {})
      throw e
    }
  }

  /** One MCP `initialize` from the job's sandbox to each of the job's servers, through the proxy (R3.5). A harness
   *  that cannot reach a server only leaves its tools out and still ends well (checked with Codex 0.171.0), so byoa
   *  finds out first. Throws ProxyError when no request reached the proxy; returns the servers that did not answer. */
  async function checkServers(sbx: Sandbox, t: JobToken): Promise<Session['failing']> {
    if (!t.mcp.length) return []
    const file = `${sbx.home}/.byoa/check.mjs`
    await sbx.writeFile(file, CHECK_JS)
    const r = await sbx.run(`node ${q(file)}`, { env: { BYOA_CHECK: JSON.stringify(t.mcp), [JOB_TOKEN_ENV]: t.token }, timeoutMs: 90_000 })
    let res: { name: string; proxy: boolean; status: number; message: string }[]
    // a sandbox that cannot run the check (no node on its PATH) is not a reason to stop a job
    try { res = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') } catch { return [] }
    const bad = res.filter((x) => !x.proxy || x.status < 200 || x.status >= 300)
    if (res.every((x) => !x.proxy)) {
      const x = res[0]!
      throw new ProxyError(`byoa: the sandbox cannot reach the MCP proxy at ${o.proxyUrl} (${x.message || `an answer with status ${x.status} that is not the proxy's`}); the job did not start. Serve agents.proxy at proxyUrl, at an address the sandbox can reach`)
    }
    return bad.map((x) => ({ name: x.name, message: x.proxy ? x.message || `the proxy answered ${x.status}` : `no answer from the proxy (${x.message || x.status})` }))
  }

  /** Runs one job (R5.4): a session, the harness with the task, then close (the sandbox pauses, or goes). Events in one schema for every harness
   *  (R5.5). */
  async function* run(user: string, r: RunOptions): AsyncGenerator<AgentEvent> {
    const h = r.harness
    let s: Session | undefined
    let end: AgentEvent = { type: 'end', ok: false }
    try {
      for (const m of await missingOf(user, r)) yield { type: 'error', code: 'mcp', message: `${m} is not connected for this user; the job runs without it` }
      try {
        s = await session(user, r)
        for (const f of s.failing) yield { type: 'error', code: 'mcp', message: `${f.name} does not answer through the proxy (${f.message}); the job may not have its tools` }
        let cmd: string, reader: EventReader
        if (h === 'fake') { cmd = `node ${q(s.bin)}`; reader = fakeReader() }
        else {
          const args = h === 'claude' ? claudeArgs({ mcpConfig: CLAUDE_MCP_CONFIG, model: r.model, access: r.access, servers: s.mcp.map((m) => m.name) }) : codexArgs({ work: s.work, model: r.model, access: r.access })
          cmd = [s.bin, ...args].map(q).join(' ')
          reader = h === 'claude' ? claudeReader() : codexReader()
        }
        await s.sandbox.writeFile(`${s.work}/.byoa/task.md`, r.task)
        yield { type: 'start', harness: h, version: s.version, sandbox: o.sandbox.name }

        for await (const ev of stream(s.sandbox, `${cmd} < .byoa/task.md`, { cwd: s.work, env: s.env, timeoutMs: timeout }, reader)) {
          if (ev.type === 'end') { end = ev; break }
          if (ev.type === 'error' && ev.code === 'expired') await s.reportLogin('expired')
          yield ev
        }
        if (end.type === 'end' && end.ok) await s.reportLogin('signed-in')
      } catch (e) {
        if (e instanceof LoginError) yield { type: 'error', code: 'signed-out', message: e.message }
        else yield { type: 'error', code: e instanceof GrantError || e instanceof ProxyError ? 'mcp' : 'sandbox', message: (e as Error).message }
      }
      if (s) {
        const failed = await s.close().then(() => undefined, (e) => `the sandbox was not ${keep ? 'paused' : 'destroyed'}: ${(e as Error).message}`)
        if (failed) yield { type: 'error', code: 'sandbox', message: failed }
      }
      yield end
    } finally {
      await s?.close().catch(() => {})
    }
  }

  async function missingOf(user: string, r: SessionOptions) {
    const want = [...new Set([...(r.mcp ?? []), ...(r.plugins ?? []).flatMap((p) => p.mcp.map((m) => m.name))])]
    const have = await serversOf(user)
    return want.filter((s) => !have.has(s))
  }

  return {
    /** Starts the lab's own sign-in for the user (R1.1, R1.2): show `url` (and Codex's `code`) to the user. */
    connectLogin: (user: string, h: HarnessName) => login.start(user, h),
    /** Claude Code: pass the code Anthropic's page shows. Codex: call again until the state is not `pending`. */
    finishLogin: (user: string, h: HarnessName, input?: { code?: string; waitMs?: number }) => login.finish(user, h, input),
    /** `signed-in`, `signed-out` or `expired` (R1.6). */
    loginState: (user: string, h: HarnessName) => login.state(user, h),
    /** Signs the user out with the CLI, deletes the stored login (or the login volume), and deletes the user's
     *  sandbox for this harness. */
    signOut: async (user: string, h: HarnessName) => { await deleteSandbox(user, { harness: h }); await login.signOut(user, h) },
    deleteSandbox,
    connectMcp,
    importMcp,
    finishMcp,
    fetchWithGrant,
    listMcp: (user: string) => grants.list(user),
    removeMcp: (user: string, name: string) => grants.remove(user, name),
    run,
    session,
    jobToken,
    /** The MCP proxy, a fetch handler (Request → Response). Serve it at `proxyUrl` and below. */
    proxy: mcpProxy({ proxyUrl: o.proxyUrl, jobs, grants, tools }),
    /** The Client ID Metadata Document to serve at `oauth.clientMetadataUrl`. */
    clientMetadata: () => clientMetadataDocument(oauth),
  }
}

/** Runs the command and turns its output, line by line, into events as they come. */
async function* stream(sbx: Sandbox, cmd: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }, reader: EventReader): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = []
  let wake: (() => void) | undefined, done = false, buf = ''
  const push = (evs: AgentEvent[]) => { if (evs.length) { queue.push(...evs); wake?.(); wake = undefined } }
  const lines = (chunk: string) => {
    buf += chunk
    let k
    while ((k = buf.indexOf('\n')) >= 0) { push(reader.line(buf.slice(0, k))); buf = buf.slice(k + 1) }
  }
  sbx.run(cmd, { ...opts, onStdout: lines })
    .then((res) => { if (buf) push(reader.line(buf)); push(reader.exit(res.exitCode, res.stderr)) },
      (e) => push([{ type: 'error', code: 'sandbox', message: (e as Error).message }, { type: 'end', ok: false }]))
    .finally(() => { done = true; wake?.() })
  for (;;) {
    if (queue.length) { yield queue.shift()!; continue }
    if (done) return
    await new Promise<void>((r) => { wake = r })
  }
}
