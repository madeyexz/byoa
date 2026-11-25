// V20 (R1.8, R1.6, R5.7, R5.8): OpenCode Go with the real Claude Code and Codex, on E2B, with a real Go key. The same
// task runs with both harnesses through the relay; jobs run at the same time; a job gets the model it names; a key
// that OpenCode refuses is `expired`. The relay is in agents.proxy here, served through a Cloudflare quick tunnel
// (`cloudflared` on PATH, or BYOA_CLOUDFLARED), and this process keeps every request the relay sends to OpenCode.
// Needs BYOA_V20=1, OPENCODE_GO_API_KEY (a Console API key of a workspace with Go) and E2B_API_KEY; it uses a little
// of the plan and of E2B, so it runs before a release, not on every commit. Optional: OPENCODE_NOPLAN_API_KEY, a key of
// a workspace with no Go plan, for `no-plan`; BYOA_V20_MODELS, two models (default `kimi-k3.1-pro,glm-5.3-flash`);
// BYOA_E2B_TEMPLATE (default `byoa`). Every sandbox is a job's own (`sandboxPer: 'job'`), and is gone after it.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { Sandbox as E2BSandbox } from 'e2b'
import { createAgents, memoryStore, type AgentEvent, type Sandbox, type SandboxProvider } from '../src/index.ts'
import { importKey, seal } from '../src/crypto.ts'
import { toNodeListener } from '../src/node.ts'
import { e2b } from '../src/sandbox/e2b.ts'
import { q } from '../src/sh.ts'
import { collect } from './helpers/app.ts'
import { reachProxy, tunnel } from './helpers/tunnel.ts'

const KEY = process.env.OPENCODE_GO_API_KEY
const NOPLAN = process.env.OPENCODE_NOPLAN_API_KEY
const skip = !(process.env.BYOA_V20 && KEY && process.env.E2B_API_KEY) && 'set BYOA_V20=1, OPENCODE_GO_API_KEY and E2B_API_KEY to run V20'
const [MODEL, MODEL_B] = (process.env.BYOA_V20_MODELS ?? 'kimi-k3.1-pro,glm-5.3-flash').split(',') as [string, string]
const APP = `v20-${randomBytes(3).toString('hex')}`
const PLAN = 'opencode-go' as const
const encryptionKey = randomBytes(32).toString('base64')

/** The requests the relay sent to OpenCode, and OpenCode's status. */
const sent: { path: string; model?: string; status: number; headers: Record<string, string> }[] = []
/** The text of each sandbox, read just before it is destroyed: every process's environment and command line, and every
 *  small file of its home and /tmp (not the installed harness). */
const dumps: string[] = []
const realFetch = globalThis.fetch
let agents: ReturnType<typeof createAgents>, closeAll = async () => {}
const store = memoryStore()

function watched(p: SandboxProvider, hosts: () => string): SandboxProvider {
  const dump = (s: Sandbox) => s.run(`(cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline; find ${q(s.home)} /tmp -xdev -type f -size -2M -not -path '*/.byoa/harness/*' -not -path '*/.npm/*' -not -path '*/.cache/*' -exec cat {} +) 2>/dev/null | tr '\\0' '\\n'`, { timeoutMs: 120_000 }).then((r) => { dumps.push(r.stdout) })
  const wrap = (s: Sandbox): Sandbox => ({ ...s, run: (c, o) => s.run(c, o), writeFile: (f, d) => s.writeFile(f, d), pause: () => s.pause(), destroy: async () => { await dump(s); await s.destroy() } })
  return {
    ...p, create: async (o) => {
      const s = await p.create(o)
      await s.run(`echo ${q(hosts())} | sudo tee -a /etc/hosts`)
      return wrap(s)
    },
    resume: (id, o) => p.resume(id, o).then(wrap),
  }
}

before(async () => {
  if (skip) return
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const res = await realFetch(input, init)
    if (u.startsWith('https://opencode.ai/inference/go/') && /\/(anthropic|openai)\//.test(u)) {
      let model: string | undefined
      try { model = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)).model } catch {}
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => { if (k !== 'authorization') headers[k] = v })
      sent.push({ path: u.slice('https://opencode.ai/inference/go'.length), model, status: res.status, headers })
    }
    return res
  }) as typeof fetch
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  const server = createServer(toNodeListener((r) => handler(r)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const t = await tunnel((server.address() as AddressInfo).port)
  const proxyUrl = `${t.url}/byoa/mcp`
  agents = createAgents({
    app: APP, sandbox: watched(e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'byoa' }), () => hosts), store, encryptionKey, proxyUrl,
    oauth: { redirectUrl: `${t.url}/callback` }, sandboxPer: 'job', jobTimeoutMs: 15 * 60_000,
    tools: { notes: { whoami: { description: 'Who the user is.', run: (_a, { user }) => `you are ${user}` } } },
  })
  handler = agents.proxy
  const hosts = await reachProxy(proxyUrl)
  closeAll = async () => { t.close(); server.closeAllConnections(); server.close() }
})

after(async () => {
  if (skip) return
  globalThis.fetch = realFetch
  await closeAll()
  // no sandbox of this run stays at E2B
  const left = await E2BSandbox.list({ query: { metadata: { 'byoa-app': APP } } }).nextItems()
  for (const s of left) await E2BSandbox.kill(s.sandboxId)
  assert.deepEqual(left.map((s) => s.sandboxId), [], 'no sandbox of V20 is left at E2B')
})

const error = (ev: AgentEvent[]) => ev.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }> | undefined
const end = (ev: AgentEvent[]) => ev.at(-1) as Extract<AgentEvent, { type: 'end' }>
const TASK = 'Call the tool whoami of the MCP server notes. Then, with a shell command, write exactly what it returned to the file answer.txt in the current folder. Reply with only the content of answer.txt.'

test('V20: connectKey with a real Go key, and with one OpenCode refuses; listModels with no sandbox', { skip, timeout: 120_000 }, async () => {
  assert.deepEqual(await agents.connectKey('ann', PLAN, KEY!), { state: 'signed-in' })
  const bad = await agents.connectKey('bob', PLAN, 'oc_sk_byoa_v20_not_a_key')
  console.log('refused key:', bad)
  assert.equal(bad.state, 'signed-out')
  const models = await agents.listModels('ann', PLAN)
  console.log('models:', models.map((m) => `${m.id} [${m.efforts.join('/')}]`).join(', '))
  for (const m of [MODEL, MODEL_B]) assert.ok(models.some((x) => x.id === m), `${m} is a Go model`)
  assert.ok(!models.some((m) => m.id.endsWith('-free')))
})

for (const harness of ['claude', 'codex'] as const) {
  test(`V20 (V3): the same task with ${harness} and the Go key, with an app tool, on E2B; the key is never in the sandbox`, { skip, timeout: 15 * 60_000 }, async () => {
    const n = sent.length, d = dumps.length
    const ev = await collect(agents.run('ann', { harness, plan: PLAN, model: MODEL, task: TASK, mcp: ['notes'] }))
    console.log(harness, JSON.stringify(ev).slice(0, 3000))
    assert.equal(error(ev), undefined)
    assert.equal(end(ev).ok, true)
    assert.match(end(ev).result ?? '', /you are ann/)
    assert.ok(ev.some((e) => e.type === 'tool_call' && e.name === 'whoami' && e.server === 'notes'))
    const mine = sent.slice(n)
    console.log(harness, 'relay requests:', mine.map((s) => `${s.path} ${s.model} ${s.status} ua=${s.headers['user-agent']} session=${s.headers['x-claude-code-session-id'] ?? s.headers['session-id'] ?? '-'}`))
    assert.ok(mine.length > 0 && mine.every((s) => s.status === 200))
    assert.ok(mine.every((s) => s.model === MODEL))
    assert.ok(mine.every((s) => s.headers['user-agent']?.startsWith(harness === 'claude' ? 'claude-cli/' : 'codex_exec/')))
    assert.equal(dumps.length, d + 1)
    assert.ok(dumps[d]!.includes('byoa_job_'), 'the dump has the job token: it reads the environment')
    assert.ok(!dumps[d]!.includes(KEY!), 'V5: the key is in no file, environment or command line of the sandbox')
    assert.equal(await agents.loginState('ann', PLAN), 'signed-in')
  })
}

test('V20 (R5.7): a job gets the model and effort it names', { skip, timeout: 15 * 60_000 }, async () => {
  for (const harness of ['claude', 'codex'] as const) {
    const n = sent.length
    const ev = await collect(agents.run('ann', { harness, plan: PLAN, model: MODEL_B, effort: 'high', task: 'Reply with the one word: pong' }))
    assert.equal(end(ev).ok, true, JSON.stringify(ev))
    const mine = sent.slice(n)
    assert.ok(mine.length > 0 && mine.every((s) => s.model === MODEL_B), JSON.stringify(mine.map((s) => s.model)))
  }
})

test('V20 (R5.8): one user\'s jobs with the Go key run at the same time, with both harnesses', { skip, timeout: 15 * 60_000 }, async () => {
  const t0 = Date.now()
  const runs = (['codex', 'codex', 'claude'] as const).map(async (harness) => {
    const ev: AgentEvent[] = []
    let started = 0
    for await (const e of agents.run('ann', { harness, plan: PLAN, model: MODEL, task: 'Run the shell command `sleep 20`, then reply with the one word: done' })) {
      if (e.type === 'start') started = Date.now() - t0
      ev.push(e)
    }
    return { harness, ok: end(ev).ok, started, ended: Date.now() - t0, result: end(ev).result }
  })
  const res = await Promise.all(runs)
  console.log('parallel:', res)
  assert.ok(res.every((r) => r.ok))
  assert.ok(Math.max(...res.map((r) => r.started)) < Math.min(...res.map((r) => r.ended)), 'every job started before the first one ended')
})

test('V20 (R1.6): a key that OpenCode refuses in a job is expired; a free model is refused without no-plan', { skip, timeout: 15 * 60_000 }, async () => {
  // a key that worked and was revoked: stored as connectKey stores it
  await store.put('aikey/carl/opencode-go', await seal(await importKey(encryptionKey), 'oc_sk_byoa_v20_revoked', 'aikey/carl/opencode-go'))
  const ev = await collect(agents.run('carl', { harness: 'claude', plan: PLAN, model: MODEL, task: 'Reply with: pong' }))
  console.log('401 job:', JSON.stringify(ev))
  assert.equal(end(ev).ok, false)
  assert.equal(await agents.loginState('carl', PLAN), 'expired')
  assert.equal(sent.at(-1)!.status, 401)

  const free = await collect(agents.run('ann', { harness: 'codex', plan: PLAN, model: 'beam-free', task: 'Reply with: pong' }))
  console.log('free model job:', JSON.stringify(free), sent.at(-1))
  assert.equal(end(free).ok, false)
  assert.equal(await agents.loginState('ann', PLAN), 'signed-in', 'a refused free model is not a missing plan')
})

test('V20 (R1.6): a key of a workspace with no Go plan is no-plan', { skip: skip || (!NOPLAN && 'set OPENCODE_NOPLAN_API_KEY for no-plan'), timeout: 15 * 60_000 }, async () => {
  const r = await agents.connectKey('dana', PLAN, NOPLAN!)
  console.log('no-plan key:', r)
  assert.equal(r.state, 'no-plan')
  const ev = await collect(agents.run('dana', { harness: 'codex', plan: PLAN, model: MODEL, task: 'Reply with: pong' }))
  console.log('no-plan job:', JSON.stringify(ev))
  assert.equal(error(ev)?.code, 'no-plan')
  assert.equal(await agents.loginState('dana', PLAN), 'no-plan')
})
