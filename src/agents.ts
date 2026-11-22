// createAgents: the one object an app uses. It ties together the store (R6), the sandbox provider (R5.3), the login
// driver (R1), the MCP grants and their one refresh owner (R2), the proxy (R3), the config writers (R4) and the
// harness installer (R5.1).
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { CLAUDE_MCP_CONFIG, JOB_TOKEN_ENV, SERVER_NAME, harnessFiles, type Plugin, type Setup } from './config.ts'
import { importKey, open, seal } from './crypto.ts'
import { claudeArgs, claudeReader } from './harness/claude.ts'
import { codexArgs, codexReader } from './harness/codex.ts'
import type { AgentEvent, EventReader } from './harness/events.ts'
import { FAKE_JS, fakeReader } from './harness/fake.ts'
import { ensureHarness } from './harness/install.ts'
import { PINS, type HarnessName, type Pins } from './harness/pins.ts'
import { cliLogin, type LoginDeps, type LoginDriver } from './login.ts'
import { GrantError, Grants, type Grant } from './mcp/grants.ts'
import { Provider, clientMetadataDocument, type OAuthConfig } from './mcp/oauth.ts'
import { JobTokens, mcpProxy } from './mcp/proxy.ts'
import type { Sandbox, SandboxProvider } from './sandbox/types.ts'
import { q } from './sh.ts'
import type { Store } from './store.ts'

export interface AgentsOptions {
  /** The app's own name (lower-case letters, digits, -). It is part of every login volume's name, so one app's AI
   *  login is never another app's (Lab rules). */
  app: string
  sandbox: SandboxProvider
  store: Store
  /** 32 random bytes as base64 (`openssl rand -base64 32`). byoa encrypts every MCP grant with it (R2.4). */
  encryptionKey: string
  /** The public URL where the app serves `agents.proxy`, such as https://app.example.com/byoa/mcp. Each MCP server
   *  is at `<proxyUrl>/<name>`. */
  proxyUrl: string
  oauth: { redirectUrl: string; clientMetadataUrl?: string; clientName?: string }
  pins?: Pins
  /** Another login, for an app with its own agreement with a lab (R1.5). Default: the labs' CLI sign-in. */
  login?: (deps: LoginDeps) => LoginDriver
  /** The most one job may take. Default 30 minutes. */
  jobTimeoutMs?: number
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
}

export type ConnectResult = { name: string; connected: true } | { name: string; connected: false; signInUrl: string }

const FLOW_MS = 15 * 60_000
const flowKey = (state: string) => `mcpflow/${state}`

export function createAgents(o: AgentsOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(o.app)) throw new Error('byoa: app: lower-case letters, digits and -, at most 24')
  const key = importKey(o.encryptionKey)
  key.catch(() => {}) // reported where it is used
  const oauth: OAuthConfig = { redirectUrl: o.oauth.redirectUrl, clientMetadataUrl: o.oauth.clientMetadataUrl, clientName: o.oauth.clientName ?? o.app }
  const pins = o.pins ?? PINS
  const grants = new Grants(o.store, key, oauth)
  const jobs = new JobTokens(o.store)
  const login = (o.login ?? cliLogin)({ sandbox: o.sandbox, store: o.store, app: o.app, pins })
  const timeout = o.jobTimeoutMs ?? 30 * 60_000

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
    const u = new URL(url)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw new Error('byoa: an MCP server URL must start with https://')
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

  /** Runs one job (R5.4): a new sandbox with the user's login volume, the user's setup, the harness, the job; then
   *  the job token ends and the sandbox is destroyed. Events in one schema for every harness (R5.5). */
  async function* run(user: string, r: RunOptions): AsyncGenerator<AgentEvent> {
    const h = r.harness
    const plugins = r.plugins ?? []
    const want = [...new Set([...(r.mcp ?? []), ...plugins.flatMap((p) => p.mcp.map((m) => m.name))])]
    const have = new Set((await grants.list(user)).map((g) => g.name))
    const servers = want.filter((s) => have.has(s))
    for (const s of want) if (!have.has(s)) yield { type: 'error', code: 'mcp', message: `${s} is not connected for this user; the job runs without it` }
    const setup: Setup = { agentsMd: r.setup?.agentsMd, skills: [...(r.setup?.skills ?? []), ...plugins.flatMap((p) => p.setup.skills ?? [])] }
    const files = harnessFiles(h === 'codex' ? 'codex' : 'claude', setup, { proxyUrl: o.proxyUrl, servers })

    const { token, job } = await jobs.issue(user, servers, timeout + 5 * 60_000)
    let sbx: Sandbox | undefined, cleaned = false
    const cleanup = async (): Promise<string | undefined> => {
      if (cleaned) return
      cleaned = true
      await jobs.end(job).catch(() => {})
      try { await sbx?.destroy() } catch (e) { return `the sandbox was not destroyed: ${(e as Error).message}` }
    }
    let end: AgentEvent = { type: 'end', ok: false }
    try {
      body: try {
        sbx = await o.sandbox.create({ volumes: h === 'fake' ? [] : await login.volumes(user, h), labels: { 'byoa-app': o.app, 'byoa-job': job }, timeoutMs: timeout + 60_000 })
        const work = `${sbx.home}/work`
        let cmd: string, version: string, env: Record<string, string> = {}, reader: EventReader
        if (h === 'fake') {
          await sbx.writeFile(`${sbx.home}/.byoa/fake.mjs`, FAKE_JS)
          cmd = `node ${q(`${sbx.home}/.byoa/fake.mjs`)}`
          version = 'fake'
          reader = fakeReader()
        } else {
          if (!(await login.present(sbx, user, h))) {
            await login.setState(user, h, 'signed-out')
            yield { type: 'error', code: 'signed-out', message: `${h} is not signed in for this user; call connectLogin first` }
            break body
          }
          const inst = await ensureHarness(sbx, h, pins)
          version = inst.version
          env = await login.env(sbx, user, h)
          const args = h === 'claude' ? claudeArgs({ mcpConfig: CLAUDE_MCP_CONFIG, model: r.model }) : codexArgs({ work, model: r.model })
          cmd = [inst.bin, ...args].map(q).join(' ')
          reader = h === 'claude' ? claudeReader() : codexReader()
        }
        for (const [p, text] of Object.entries(files)) await sbx.writeFile(`${work}/${p}`, text)
        await sbx.writeFile(`${work}/.byoa/task.md`, r.task)
        yield { type: 'start', harness: h, version, sandbox: o.sandbox.name }

        for await (const ev of stream(sbx, `${cmd} < .byoa/task.md`, { cwd: work, env: { ...env, [JOB_TOKEN_ENV]: token }, timeoutMs: timeout }, reader)) {
          if (ev.type === 'end') { end = ev; break }
          if (ev.type === 'error' && ev.code === 'expired' && h !== 'fake') await login.setState(user, h, 'expired')
          yield ev
        }
        if (end.type === 'end' && end.ok && h !== 'fake' && (await login.state(user, h)) !== 'signed-in') await login.setState(user, h, 'signed-in')
      } catch (e) {
        yield { type: 'error', code: e instanceof GrantError ? 'mcp' : 'sandbox', message: (e as Error).message }
      }
      const failed = await cleanup()
      if (failed) yield { type: 'error', code: 'sandbox', message: failed }
      yield end
    } finally {
      await cleanup()
    }
  }

  return {
    /** Starts the lab's own sign-in for the user (R1.1, R1.2): show `url` (and Codex's `code`) to the user. */
    connectLogin: (user: string, h: HarnessName) => login.start(user, h),
    /** Claude Code: pass the code Anthropic's page shows. Codex: call again until the state is not `pending`. */
    finishLogin: (user: string, h: HarnessName, input?: { code?: string; waitMs?: number }) => login.finish(user, h, input),
    /** `signed-in`, `signed-out` or `expired` (R1.6). */
    loginState: (user: string, h: HarnessName) => login.state(user, h),
    signOut: (user: string, h: HarnessName) => login.signOut(user, h),
    connectMcp,
    finishMcp,
    listMcp: (user: string) => grants.list(user),
    removeMcp: (user: string, name: string) => grants.remove(user, name),
    run,
    /** The MCP proxy, a fetch handler (Request → Response). Serve it at `proxyUrl` and below. */
    proxy: mcpProxy({ proxyUrl: o.proxyUrl, jobs, grants }),
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
