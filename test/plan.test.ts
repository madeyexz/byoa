// R1.8: a plan the user brings as a key (OpenCode Go), with a stand-in for OpenCode's API (test/helpers/opencode-go.ts)
// and the stand-in CLIs (test/fixtures/bin). This checks byoa's side: the stored key and its states, the relay that
// puts the key on the harness's requests, and that the key never enters the sandbox. V20 checks it with OpenCode and
// the real CLIs.
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { after, test } from 'node:test'
import { LoginError, type AgentEvent } from '../src/index.ts'
import { fakeOpenCodeGo } from './helpers/opencode-go.ts'
import { collect, testApp } from './helpers/app.ts'

const BIN = new URL('./fixtures/bin/', import.meta.url).pathname
chmodSync(`${BIN}claude`, 0o755)
chmodSync(`${BIN}codex`, 0o755)
const env = { PATH: `${BIN}:${process.env.PATH}` }
const go = await fakeOpenCodeGo()
const closers: (() => Promise<void>)[] = [go.close]
after(() => Promise.all(closers.map((c) => c())))
const app = async (o: Parameters<typeof testApp>[0] = {}) => { const a = await testApp({ env, ...o }); closers.unshift(a.close); return a }
const PLAN = 'opencode-go' as const
/** Every text byoa gave the sandbox: each command's environment, and each file when the sandbox paused or ended. */
const error = (ev: AgentEvent[]) => ev.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>
const sandboxText = (a: Awaited<ReturnType<typeof app>>) => JSON.stringify(a.sandbox.envs) + a.sandbox.files.join('\n')

test('R1.8 / R1.6: connectKey keeps a key that OpenCode knows; its state is signed-in, no-plan or signed-out', async () => {
  const { agents, store } = await app()
  assert.equal(await agents.loginState('ann', PLAN), 'signed-out')
  const bad = await agents.connectKey('ann', PLAN, 'oc_sk_wrong')
  assert.equal(bad.state, 'signed-out')
  assert.match(bad.error!, /did not accept the key/)
  assert.equal(await agents.loginState('ann', PLAN), 'signed-out', 'a key OpenCode refuses is not kept')

  assert.deepEqual(await agents.connectKey('ann', PLAN, 'oc_sk_noplan'), { state: 'no-plan', error: 'OpenCode Go subscription required.' })
  assert.equal(await agents.loginState('ann', PLAN), 'no-plan')
  assert.deepEqual(await agents.connectKey('ann', PLAN, ' oc_sk_good\n'), { state: 'signed-in' })
  assert.equal(await agents.loginState('ann', PLAN), 'signed-in')
  const usage = go.seen.filter((s) => s.path === '/inference/go/v1/usage').at(-1)!
  assert.equal(usage.headers.authorization, 'Bearer oc_sk_good')
  assert.equal(usage.headers['user-agent'], 'byoa', 'byoa names itself, not a generic HTTP library')
  await assert.rejects(agents.connectKey('ann', PLAN, 'two words'), /one word/)

  // encrypted in the store, like a grant (R2.4)
  const all = (await Promise.all((store as any).keys().map((k: string) => store.get(k)))).map((e: any) => e.value).join('\n')
  assert.ok(!all.includes('oc_sk_good'))
  assert.equal(await agents.loginState('ann', 'claude'), 'signed-out', 'the key is not a lab login')
  await agents.signOut('ann', PLAN)
  assert.equal(await agents.loginState('ann', PLAN), 'signed-out')
})

test('R5.7: listModels of a plan lists its chat models with the user\'s key, not the free ones, with no sandbox', async () => {
  const { agents, sandbox } = await app()
  await assert.rejects(agents.listModels('ann', PLAN), (e: Error) => e instanceof LoginError)
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  assert.deepEqual(await agents.listModels('ann', PLAN), [{ id: 'kimi-k3', name: 'Kimi K3', description: 'Moonshot', isDefault: false, efforts: ['max'] }])
  assert.equal(go.seen.filter((s) => s.path === '/inference/go/v1/models').at(-1)!.headers.authorization, 'Bearer oc_sk_good')
  assert.equal(sandbox.created, 0)
})

test('R1.8 / R3.3: a Claude Code job with OpenCode Go: the relay puts the key on its requests; the key never enters the sandbox', async () => {
  const a = await app()
  const { agents } = a
  assert.deepEqual(await collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi' })), [
    { type: 'error', code: 'signed-out', message: 'opencode-go is not connected for this user; call connectKey first' },
    { type: 'end', ok: false },
  ])
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const n = go.seen.length
  // no Claude sign-in: the job runs with the key alone
  const ev = await collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi' }))
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'pong', usage: { input: 0, output: 0, cached: 0 } })
  const [req, ...more] = go.seen.slice(n)
  assert.equal(more.length, 0)
  assert.equal(req!.path, '/inference/go/anthropic/v1/messages?beta=true')
  assert.equal(req!.headers.authorization, 'Bearer oc_sk_good')
  // the harness's own headers go on, as OpenCode Go wants: its user agent and its session id
  assert.equal(req!.headers['user-agent'], 'claude-cli/2.1.330 (external, sdk-cli)')
  assert.equal(req!.headers['x-claude-code-session-id'], 'claude-session-1')
  assert.match(req!.headers['x-opencode-session']!, /^ses_[\w-]+$/)
  assert.equal(JSON.parse(req!.body).model, 'kimi-k3')

  assert.ok(!sandboxText(a).includes('oc_sk_good'), 'the key is in no environment and no file of the sandbox')
  const job = a.sandbox.envs.find((e) => e.ANTHROPIC_AUTH_TOKEN)!
  assert.match(job.ANTHROPIC_AUTH_TOKEN!, /^byoa_job_/)
  assert.equal(job.ANTHROPIC_BASE_URL, `${a.proxyUrl}/_plan/opencode-go/anthropic`)
  assert.equal(job.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3', 'every model alias is the job\'s model')
  assert.match(job.CLAUDE_CONFIG_DIR!, /\/\.byoa\/plan\/claude$/, 'a config folder with no lab login')
  // R3.4: the job token of the relay ends with the job
  const after = await fetch(`${job.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${job.ANTHROPIC_AUTH_TOKEN}` }, body: '{}' })
  assert.equal(after.status, 401)
  assert.equal(go.seen.length, n + 1)
  assert.equal(await agents.loginState('ann', PLAN), 'signed-in')
})

test('R1.6: OpenCode\'s 401 makes the key expired, its 403 no-plan, and the job\'s error says so', async () => {
  const { agents } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const job = () => collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi' }))
  try {
    go.mode = '403'
    let ev = await job()
    assert.equal(error(ev).code, 'no-plan')
    assert.match(error(ev).message, /OpenCode Go subscription required/)
    assert.equal(await agents.loginState('ann', PLAN), 'no-plan')
    go.mode = '401'
    ev = await job()
    assert.equal(error(ev).code, 'expired')
    assert.deepEqual(ev.at(-1), { type: 'end', ok: false, usage: { input: 0, output: 0, cached: 0 } })
    assert.equal(await agents.loginState('ann', PLAN), 'expired')
  } finally { go.mode = 'ok' }
  // a job that works again: signed in
  assert.equal(((await job()).at(-1) as any).ok, true)
  assert.equal(await agents.loginState('ann', PLAN), 'signed-in')
})

test('R1.8: a Codex job with OpenCode Go: a model provider for this job only, which reaches the relay with the job token', async () => {
  const a = await app({ models: { codex: { model: 'gpt-6.2-sol' }, 'opencode-go': { model: 'glm-5.3', effort: 'high' } } })
  const { agents, proxyUrl } = a
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const s = await agents.session('ann', { harness: 'codex', plan: PLAN })
  try {
    // createAgents' models['opencode-go'], not the harness's own default
    assert.deepEqual(s.args, [
      '-c', 'model_provider="opencode-go"',
      '-c', `model_providers.opencode-go={name="OpenCode Go",base_url="${proxyUrl}/_plan/opencode-go/openai/v1",env_key="BYOA_JOB_TOKEN",wire_api="responses"}`,
      '-c', 'model="glm-5.3"', '-c', 'model_reasoning_effort="high"',
    ])
    assert.equal(s.env.CODEX_HOME, `${s.sandbox.home}/.byoa/plan/codex`)
    assert.equal((await s.sandbox.run('test -d "$CODEX_HOME"', { env: s.env })).exitCode, 0)
    const call = (path: string, token = '$BYOA_JOB_TOKEN') => s.sandbox.run(`node -e "fetch('${proxyUrl}/_plan/opencode-go/' + process.argv[1], { method: 'POST', headers: { authorization: 'Bearer ' + process.argv[2], 'user-agent': 'byoa/0.171.0', 'session-id': 'codex-1', 'x-gateway-auth': 'app-secret', cookie: 'a=b' }, body: '{}' }).then(async (r) => console.log(r.status, await r.text()))" ${path} "${token}"`, { env: s.env })
    const n = go.seen.length
    assert.match((await call('openai/v1/responses')).stdout, /^200 .*pong/)
    assert.equal(go.seen[n]!.headers.authorization, 'Bearer oc_sk_good')
    assert.equal(go.seen[n]!.headers['session-id'], 'codex-1')
    // only the harness's own headers go on: not what the app's gateway added, and no cookie
    assert.equal(go.seen[n]!.headers['x-gateway-auth'], undefined)
    assert.equal(go.seen[n]!.headers.cookie, undefined)
    // the relay sends only the model APIs on, and only for a job with the plan
    assert.match((await call('v1/usage')).stdout, /^404 /)
    const other = await agents.jobToken('ann')
    assert.match((await call('openai/v1/responses', other.token)).stdout, /^403 .*does not have the plan/)
    await other.close()
    assert.equal(go.seen.length, n + 1)
  } finally { await s.close() }
  assert.ok(!sandboxText(a).includes('oc_sk_good'))
})

test('R1.8: a job with a plan needs a model and a harness that takes one', async () => {
  const { agents } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const msg = async (r: Parameters<typeof agents.run>[1]) => error(await collect(agents.run('ann', r))).message
  assert.equal(await msg({ harness: 'claude', plan: PLAN, task: 'hi' }), "byoa: a job with the plan opencode-go needs a model; listModels(user, 'opencode-go') lists them")
  assert.match(await msg({ harness: 'fake', plan: PLAN, task: 'hi' }), /^byoa: plan: opencode-go, with the harness claude or codex/)
  assert.match(await msg({ harness: 'claude', plan: 'other' as any, model: 'x', task: 'hi' }), /^byoa: plan: /)
})

test('R1.8 / R5.8: jobs with a plan need no lease: one user\'s jobs in two sandboxes run at the same time', async () => {
  const { agents } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  go.delayMs = 1500
  go.maxInFlight = 0
  try {
    const evs = await Promise.all(['a', 'b'].map((k) => collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi', sandboxKey: k }))))
    for (const ev of evs) assert.equal((ev.at(-1) as any).ok, true)
    assert.equal(go.maxInFlight, 2)
  } finally { go.delayMs = 0 }
})

test('R1.9 / V23: OpenCode\'s 429 with a used-up limit is usage-limit, with the meter\'s reset; the plan holds for both harnesses', async () => {
  const { agents, sandbox } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const job = (harness: 'claude' | 'codex' = 'claude') => collect(agents.run('ann', { harness, plan: PLAN, model: 'kimi-k3', task: 'hi' }))
  try {
    // a 429 while no limit is used up: for now, kept nowhere
    go.mode = '429-busy'
    assert.equal(error(await job()).code, 'rate-limited')
    assert.equal(await agents.usageLimit('ann', PLAN), undefined)
    // the weekly limit is used up: the relay asked the usage meter, with the user's key
    go.mode = '429'
    const n = go.seen.length
    const e = error(await job())
    assert.equal(e.code, 'usage-limit')
    assert.equal(e.resetsAt, Date.parse('2100-01-04T00:00:00.000Z'), 'the used-up meter\'s reset, not the 5-hour one\'s')
    const meter = go.seen.slice(n).find((s) => s.path === '/inference/go/v1/usage')!
    assert.equal(meter.headers.authorization, 'Bearer oc_sk_good')
    assert.equal((await agents.usageLimit('ann', PLAN))!.until, e.resetsAt)
  } finally { go.mode = 'ok' }
  // until then, a job of either harness with the plan ends at once: no sandbox, no request to OpenCode
  const created = sandbox.created, seen = go.seen.length
  for (const h of ['claude', 'codex'] as const) assert.deepEqual((await job(h)).map((x) => x.type === 'error' ? x.code : x.type), ['usage-limit', 'end'])
  assert.equal(sandbox.created, created)
  assert.equal(go.seen.length, seen)
  assert.equal(await agents.usageLimit('ann', 'claude'), undefined, 'the plan\'s limit is not the Claude login\'s')
  // a new key ends it
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  assert.equal(await agents.usageLimit('ann', PLAN), undefined)
  assert.equal(((await job()).at(-1) as any).ok, true)
})

/** Holds OpenCode's answer to the next model request, after OpenCode gave it, until `release`: the relay reads it
 *  then. `at`: OpenCode has answered. */
function holdNextAnswer() {
  const real = globalThis.fetch
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const at = new Promise<void>((r) => { reached = r })
  let taken = false
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const res = await real(input, init)
    if (!taken && /\/inference\/go\/(?:anthropic|openai)\//.test(u)) { taken = true; reached(); await gate }
    return res
  }) as typeof fetch
  return { at, release, restore: () => { globalThis.fetch = real } }
}

test('R1.6: a new key is signed-in, also when OpenCode\'s 401 to the old key comes to the relay after it', { todo: 'open: spec/tla PlanKey_newkey' }, async () => {
  // spec/tla/PlanKey.tla (PlanKey_newkey): a job's request with the old key, which OpenCode no longer takes; while
  // its 401 comes back, the user connects a new key; then the relay sets `expired`, over the new key's state
  const { agents } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const hold = holdNextAnswer()
  try {
    go.mode = '401' // the user revoked the key in OpenCode's Console
    const job = collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi' }))
    await hold.at
    go.mode = 'ok'
    // the user's new key (the stand-in knows one good key: for byoa, each connectKey is a new key)
    assert.deepEqual(await agents.connectKey('ann', PLAN, 'oc_sk_good'), { state: 'signed-in' })
    hold.release()
    assert.equal(error(await job).code, 'expired')
  } finally { hold.restore(); go.mode = 'ok' }
  assert.equal(await agents.loginState('ann', PLAN), 'signed-in', 'the old key\'s 401 is not the new key\'s state')
})

test('R1.6: a job that worked before another job\'s 401 does not make the key signed-in again', { todo: 'open: spec/tla PlanKey_report' }, async () => {
  // spec/tla/PlanKey.tla (PlanKey_report): job 1's request works; then OpenCode refuses the key (401) to job 2, and the
  // key is expired; then job 1 ends well, and its report sets signed-in over the newer answer
  const { agents } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const hold = holdNextAnswer()
  try {
    const first = collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi', sandboxKey: 'a' }))
    await hold.at
    go.mode = '401'
    assert.equal(error(await collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi', sandboxKey: 'b' }))).code, 'expired')
    assert.equal(await agents.loginState('ann', PLAN), 'expired')
    hold.release()
    assert.equal(((await first).at(-1) as { ok: boolean }).ok, true)
  } finally { hold.restore(); go.mode = 'ok' }
  assert.equal(await agents.loginState('ann', PLAN), 'expired', 'OpenCode refused the key after job 1\'s last answer')
})

test('R1.9: a new key ends the hold, also when the relay finds the old key\'s plan used up after it', { todo: 'open: spec/tla UsageLimit_newkey' }, async () => {
  // spec/tla/UsageLimit.tla (UsageLimit_newkey): a job's request with the old key gets OpenCode's 429; while it comes
  // back, the user connects a new key, which ends the hold; then the relay asks the usage meter with the old key and
  // keeps the old plan's limit for the new key
  const { agents } = await app()
  await agents.connectKey('ann', PLAN, 'oc_sk_good')
  const hold = holdNextAnswer()
  try {
    go.mode = '429'
    const job = collect(agents.run('ann', { harness: 'claude', plan: PLAN, model: 'kimi-k3', task: 'hi' }))
    await hold.at
    go.mode = 'ok'
    assert.deepEqual(await agents.connectKey('ann', PLAN, 'oc_sk_good'), { state: 'signed-in' })
    go.mode = '429' // the old key's plan, which the relay's usage meter asks about
    hold.release()
    assert.equal(error(await job).code, 'usage-limit')
  } finally { hold.restore(); go.mode = 'ok' }
  assert.equal(await agents.usageLimit('ann', PLAN), undefined, 'the old key\'s used-up plan is not the new key\'s')
})
