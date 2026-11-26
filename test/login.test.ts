// R1 and the Claude Code, Codex and Grok Build job paths, with stand-in CLIs (test/fixtures/bin) that print what the real ones
// print. This checks byoa's own side: the sign-in through a terminal and a FIFO, the stored login and the login
// volume, the login state, and the event schema. It does not prove the real CLIs work; V3 and V11 do.
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { after, test } from 'node:test'
import { cliLogin, memoryStore, type RunOptions } from '../src/index.ts'
import { localSandbox } from '../src/sandbox/local.ts'
import { collect, running, testApp } from './helpers/app.ts'

const BIN = new URL('./fixtures/bin/', import.meta.url).pathname
chmodSync(`${BIN}claude`, 0o755)
chmodSync(`${BIN}codex`, 0o755)
chmodSync(`${BIN}grok`, 0o755)
const env = { PATH: `${BIN}:${process.env.PATH}` }
const closers: (() => Promise<void>)[] = []
after(() => Promise.all(closers.map((c) => c())))
const app = async () => { const a = await testApp({ env }); closers.push(a.close); return a }

test('R1.1 / R1.5: Claude Code sign-in: the page as data, the code typed into the real CLI; with cliLogin, the login in the user\'s volume', async () => {
  const a = await testApp({ env, login: cliLogin }); closers.push(a.close)
  const { agents, store, sandbox } = a
  assert.equal(await agents.loginState('ann', 'claude'), 'signed-out')
  assert.deepEqual(await collect(agents.run('ann', { harness: 'claude', task: 'hi' })), [
    { type: 'error', code: 'signed-out', message: 'claude is not signed in for this user; call connectLogin first' },
    { type: 'end', ok: false },
  ])

  const s = await agents.connectLogin('ann', 'claude')
  assert.deepEqual(s, { harness: 'claude', url: 'https://claude.ai/oauth/authorize?code=true&client_id=test-client&response_type=code&state=xyz' })
  assert.deepEqual(await agents.finishLogin('ann', 'claude', { code: 'wrong' }), { state: 'signed-out', error: "Couldn't log in: invalid code" })
  await agents.connectLogin('ann', 'claude')
  assert.deepEqual(await agents.finishLogin('ann', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  assert.equal(await agents.loginState('ann', 'claude'), 'signed-in')
  assert.equal(running(sandbox), 0, 'the sign-in sandbox is gone; the volume stays')

  // with cliLogin, the login is in the volume only, not in the app's database
  const stored = (await Promise.all((store as ReturnType<typeof memoryStore>).keys().map((k) => store.get(k)))).map((e) => e!.value).join('\n')
  assert.ok(!stored.includes('lab-secret'))

  const ev = await collect(agents.run('ann', { harness: 'claude', task: 'who am I?' }))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'tool_call', 'tool_result', 'text', 'end'])
  assert.deepEqual(ev[0], { type: 'start', harness: 'claude', version: '2.1.330', sandbox: 'local' })
  const args = (ev[1] as { text: string }).text
  assert.match(args, /^args: -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --mcp-config \.byoa\/mcp\.json --strict-mcp-config --permission-mode bypassPermissions --no-session-persistence; config: \.claude; autoupdater: 1; mcp timeout: 60000$/)
  assert.deepEqual(ev[2], { type: 'tool_call', id: 't1', name: 'whoami', server: 'notes', input: {} })
  assert.deepEqual(ev[3], { type: 'tool_result', id: 't1', ok: true, output: 'you are alice' })
  assert.deepEqual(ev[5], { type: 'end', ok: true, result: 'You are alice.', usage: { input: 15, output: 3, cached: 5, costUsd: 0.01 } })

  // R1.6: a login the lab refuses is reported as expired
  const ex = await collect(agents.run('ann', { harness: 'claude', task: 'expire now' }))
  assert.deepEqual(ex.slice(-2), [{ type: 'error', code: 'expired', message: 'OAuth token has expired. Please run /login' }, { type: 'end', ok: false, usage: { input: 0, output: 0, cached: 0 } }])
  assert.equal(await agents.loginState('ann', 'claude'), 'expired')

  await agents.signOut('ann', 'claude')
  assert.equal(await agents.loginState('ann', 'claude'), 'signed-out')
  assert.equal((await collect(agents.run('ann', { harness: 'claude', task: 'hi' })))[0].type, 'error')
})

test('R1.2: Codex device sign-in: the page and the code as data; then the same event schema as Claude Code (R5.5)', async () => {
  const { agents } = await app()
  assert.deepEqual(await agents.connectLogin('cy', 'codex'), { harness: 'codex', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' })
  assert.deepEqual(await agents.finishLogin('cy', 'codex'), { state: 'pending' })
  assert.deepEqual(await agents.finishLogin('cy', 'codex', { waitMs: 10_000 }), { state: 'signed-in' })

  const ev = await collect(agents.run('cy', { harness: 'codex', task: 'who am I?' }))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'tool_call', 'tool_result', 'text', 'end'])
  assert.deepEqual(ev[1], { type: 'tool_call', id: 'item_1', name: 'whoami', server: 'notes', input: {} })
  assert.deepEqual(ev[2], { type: 'tool_result', id: 'item_1', ok: true, output: 'you are alice' })
  const text = (ev[3] as { text: string }).text
  // the app server's flags, and the thread the driver started: no sandbox of Codex's own, no approvals, kept by no one
  assert.match(text, /^args: -c projects=\{"(.+\/work)"=\{trust_level="trusted"\}\}; thread: \{"cwd":"\1","sandbox":"danger-full-access","approvalPolicy":"never","ephemeral":true\}; home: \.codex$/)
  assert.deepEqual(ev[4], { type: 'end', ok: true, result: text, usage: { input: 10, output: 3, cached: 5 } })
})

test('Lab rules: with cliLogin, the same user in two apps has two login volumes, so one app\'s AI login is never another\'s', async () => {
  const deps = { sandbox: localSandbox(), store: memoryStore(), pins: { claude: '1', codex: '1', grok: '1' }, encryptionKey: 'unused' }
  const a = await cliLogin({ ...deps, app: 'bookish' }).volumes('u1', 'claude')
  const b = await cliLogin({ ...deps, app: 'margins' }).volumes('u1', 'claude')
  assert.notEqual(a[0].name, b[0].name)
  assert.equal(a[0].path, '.claude')
  assert.ok(!a[0].name.includes('u1'), 'the volume name does not show the user id')
})

test('R1.4: by default the login is encrypted in the app\'s store, each job gets a copy, and what the CLI refreshed is saved', async () => {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const a = await app()

  await a.agents.connectLogin('dee', 'claude')
  assert.deepEqual(await a.agents.finishLogin('dee', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  assert.ok(!existsSync(join(a.root, 'volumes')) || readdirSync(join(a.root, 'volumes')).length === 0, 'no login volume')
  const stored = async () => (await Promise.all(a.store.keys().map((k) => a.store.get(k)))).map((e) => e!.value).join('\n')
  assert.ok(a.store.keys().some((k) => k.startsWith('ailogin/')))
  assert.ok(!(await stored()).includes('lab-secret'), 'the login is encrypted in the store')

  const result = async () => (await collect(a.agents.run('dee', { harness: 'claude', task: 'cred' }))).at(-1)
  assert.deepEqual(await result(), { type: 'end', ok: true, result: 'cred: lab-secret-claude', usage: { input: 0, output: 0, cached: 0 } })
  assert.equal(((await result()) as { result: string }).result, 'cred: lab-secret-claudex', 'the next job gets the login the CLI refreshed')
  // two jobs at once: one holds the login at a time, so neither refresh is lost
  const both = (await Promise.all([result(), result()])).map((e) => (e as { result: string }).result).sort()
  assert.deepEqual(both, ['cred: lab-secret-claudexx', 'cred: lab-secret-claudexxx'])
  // all four jobs ran in the user's one sandbox, which is paused now, and its copy of the login was removed
  assert.equal(running(a.sandbox), 0)
  const [kept] = [...a.sandbox.paused]
  assert.equal(a.sandbox.paused.size, 1)
  const inSandbox = readdirSync(kept!, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8')).join('\n')
  assert.ok(!inSandbox.includes('lab-secret'), 'no login file in the paused sandbox')
  assert.ok(!inSandbox.includes('lab-account'), 'no backup of the CLI\'s account file in the paused sandbox')

  await a.agents.signOut('dee', 'claude')
  assert.equal(await a.agents.loginState('dee', 'claude'), 'signed-out')
  assert.equal(a.sandbox.live.size, 0, 'sign-out deletes the user\'s sandbox')
  assert.ok(!a.store.keys().some((k) => k.startsWith('ailogin/')))
  assert.equal((await collect(a.agents.run('dee', { harness: 'claude', task: 'cred' })))[0]!.type, 'error')
})

test('R1.4: the stored login works the same for Codex, also with a store and key of its own', async () => {
  const { randomBytes } = await import('node:crypto')
  const { storedLogin } = await import('../src/index.ts')
  const own = memoryStore()
  const a = await testApp({ env, login: storedLogin({ store: own, encryptionKey: randomBytes(32).toString('base64') }) }); closers.push(a.close)
  await a.agents.connectLogin('eve', 'codex')
  assert.deepEqual(await a.agents.finishLogin('eve', 'codex', { waitMs: 10_000 }), { state: 'signed-in' })
  const ev = await collect(a.agents.run('eve', { harness: 'codex', task: 'cred' }))
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'cred: lab-secret-codex', usage: { input: 0, output: 0, cached: 0 } })
  assert.ok(own.keys().some((k) => k.startsWith('ailogin/')) && !a.store.keys().some((k) => k.startsWith('ailogin/')), 'in the login\'s own store')
})

test('R1.4 / R5.8: by default, the jobs of one user share a login that is not due for a refresh, and hold alone a login that is', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { storedLogin } = await import('../src/index.ts')
  let h: 'codex' | 'claude' = 'codex'
  const signedIn = async (endsInSec: number, login?: ReturnType<typeof storedLogin>) => {
    const dir = mkdtempSync(join(tmpdir(), 'byoa-together-'))
    const ends = { FAKE_CODEX_EXP: String(Math.floor(Date.now() / 1000) + endsInSec), FAKE_CLAUDE_EXP: String(Date.now() + endsInSec * 1000) }
    const a = await testApp({ env: { ...env, ...ends, FAKE_CODEX_DIR: dir, FAKE_CLAUDE_DIR: dir }, ...(login ? { login } : {}) }); closers.push(a.close)
    await a.agents.connectLogin('fay', h)
    assert.deepEqual(await a.agents.finishLogin('fay', h, h === 'claude' ? { code: 'good-code', waitMs: 10_000 } : { waitMs: 10_000 }), { state: 'signed-in' })
    return a
  }
  // three agents of one user, each on its own machine (a sandbox key), started together; each job takes 1 s
  const together = async (a: Awaited<ReturnType<typeof signedIn>>) => {
    const ends = await Promise.all(['a', 'b', 'c'].map(async (key) => (await collect(a.agents.run('fay', { harness: h, task: 'together', sandboxKey: key }))).at(-1) as { ok: boolean; result: string }))
    assert.ok(ends.every((e) => e.ok), JSON.stringify(ends))
    assert.equal(running(a.sandbox), 0)
    assert.equal(a.sandbox.paused.size, 3, 'one kept sandbox for each key')
    const lease = JSON.parse((await a.store.get(`ailoginlease/fay/${h}`))!.value)
    assert.deepEqual([lease.alone, Object.keys(lease.shared ?? {})], [undefined, []], 'every job gave the login back')
    return Math.max(...ends.map((e) => Number(e.result.replace('together: ', ''))))
  }
  // the access token ends in 10 days (as Codex's does): the CLI will not refresh it during these jobs
  assert.equal(await together(await signedIn(10 * 24 * 3600)), 3, 'the three jobs ran at the same time')
  // it ends in 20 minutes, before a job's time runs out: the CLI of one of the jobs can refresh it, so one at a time
  assert.equal(await together(await signedIn(20 * 60)), 1)
  // parallel: false: one job holds the login at a time, and the others wait their turn
  assert.equal(await together(await signedIn(10 * 24 * 3600, storedLogin({ parallel: false }))), 1)
  // Claude Code the same: its access token lasts 8 hours, and it also refreshes 5 minutes before the end
  h = 'claude'
  assert.equal(await together(await signedIn(8 * 3600)), 3, 'the three Claude Code jobs ran at the same time')
  assert.equal(await together(await signedIn(20 * 60)), 1)
})

test('R1.4: when a login is due, byoa reads only the time its access token ends', async () => {
  const { refreshDue } = await import('../src/login-stored.ts')
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
  const min = 60_000
  assert.equal(refreshDue('codex', { '.codex/auth.json': JSON.stringify({ tokens: { access_token: jwt({ exp: 2_000_000_000 }) }, last_refresh: '2020-01-01T00:00:00Z' }) }), 2_000_000_000_000 - 5 * min)
  // a token with no end time: Codex refreshes it 8 days after the last refresh
  assert.equal(refreshDue('codex', { '.codex/auth.json': JSON.stringify({ tokens: { access_token: 'opaque' }, last_refresh: '2026-11-23T00:00:00Z' }) }), Date.parse('2026-12-01T00:00:00Z'))
  // Claude Code refreshes 5 minutes before expiresAt too (checked on E2B with a real login)
  assert.equal(refreshDue('claude', { '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: 1_900_000_000_000 } }) }), 1_900_000_000_000 - 5 * min)
  // files that do not say: 0, so one job holds the login at a time
  assert.equal(refreshDue('codex', { '.codex/auth.json': '{"tokens":{"access_token":"lab-secret-codex"}}' }), 0)
  assert.equal(refreshDue('codex', { '.codex/auth.json': 'not json' }), 0)
  assert.equal(refreshDue('claude', { '.claude/.credentials.json': '{"claudeAiOauth":{"accessToken":"x"}}' }), 0)
})

test('R5.6: access read-only starts each CLI with its own limits, and the job\'s MCP tools stay', async () => {
  const { codex } = await import('../src/harness/codex.ts')
  const { claude } = await import('../src/harness/claude.ts')
  const { harnessFiles } = await import('../src/harness/index.ts')
  const { grok } = await import('../src/harness/grok.ts')
  // Codex: its own sandbox for the thread, with a permission profile (the shell stays, to read skills), and the job's MCP
  // tools approved in its config
  assert.equal(codex.driver!.setup({ work: '/w', access: 'read-only', servers: [], model: [] }).readOnly, true)
  const o = { proxyUrl: 'https://app.example.com/byoa/mcp', servers: ['todos'] }
  const toml = harnessFiles('codex', {}, { ...o, access: 'read-only' })['.codex/config.toml']!
  assert.equal(toml, harnessFiles('codex', {}, o)['.codex/config.toml'] + 'default_tools_approval_mode = "approve"\n')
  assert.equal(harnessFiles('codex', {}, { ...o, access: 'full' })['.codex/config.toml'], harnessFiles('codex', {}, o)['.codex/config.toml'])
  // Claude Code: only the tools that read, and the job's MCP servers
  assert.deepEqual(claude.args({ work: '/w', access: 'read-only', servers: ['todos', 'notion'], model: [] }).slice(10), ['--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep,Skill', '--allowedTools', 'Read,Glob,Grep,Skill,mcp__todos,mcp__notion', '--no-session-persistence'])

  const a = await app()
  await a.agents.connectLogin('gus', 'codex')
  assert.deepEqual(await a.agents.finishLogin('gus', 'codex', { waitMs: 10_000 }), { state: 'signed-in' })
  const text = (await collect(a.agents.run('gus', { harness: 'codex', task: 'who am I?', access: 'read-only' }))).find((e) => e.type === 'text') as { text: string }
  // read-only, no network, and the login's folder (CODEX_HOME) denied to each command; no sandbox mode, which would
  // make Codex ignore the profile
  assert.match(text.text, /"approvalPolicy":"never","config":\{"default_permissions":"byoa-read-only","permissions":\{"byoa-read-only":\{"extends":":read-only","filesystem":\{"\/[^"]+\/\.codex":"deny"\},"network":\{"enabled":false\}\}\}\}/)
  assert.doesNotMatch(text.text, /"sandbox"/)
  // Grok Build: no --always-approve; its project config denies the shell, file changes and web_fetch, and allows MCP
  assert.ok(!grok.args({ work: '/w', access: 'read-only', servers: [], model: [] }).includes('--always-approve'))
  assert.equal(harnessFiles('grok', {}, { ...o, access: 'read-only' })['.grok/config.toml'], harnessFiles('grok', {}, o)['.grok/config.toml'] + '\n[permission]\ndeny = ["Bash", "Write", "Edit", "WebFetch"]\nallow = ["MCPTool(*)"]\n')
  await a.agents.connectLogin('gus', 'grok')
  assert.deepEqual(await a.agents.finishLogin('gus', 'grok', { waitMs: 10_000 }), { state: 'signed-in' })
  const write = async (access: 'full' | 'read-only') => {
    const ev = await collect(a.agents.run('gus', { harness: 'grok', task: 'write a file', access }))
    return [(ev.find((e) => e.type === 'tool_result') as { output: string }).output, (ev.at(-1) as { result?: string }).result]
  }
  assert.deepEqual(await write('read-only'), ['Tool `write` was not executed: Denied by permission policy: deny rule on edit', 'I may not write.'], 'denied by the rule, and the turn goes on')
  assert.deepEqual(await write('full'), ['wrote x.txt', 'Wrote it.'], 'the tool\'s text, not Grok\'s JSON')
  const bad = await collect(a.agents.run('gus', { harness: 'codex', task: 'x', access: 'none' as never }))
  assert.deepEqual(bad, [{ type: 'error', code: 'sandbox', message: "byoa: access: 'full' or 'read-only'" }, { type: 'end', ok: false }])
})

test('R1.4: a backend that dies during a job: the next job in that kept sandbox saves the login its CLI refreshed, unless the user signed in again', async () => {
  const { randomBytes } = await import('node:crypto')
  const { createAgents } = await import('../src/index.ts')
  const encryptionKey = randomBytes(32).toString('base64')
  const a = await testApp({ env, encryptionKey }); closers.push(a.close)
  await a.agents.connectLogin('gus', 'claude')
  assert.deepEqual(await a.agents.finishLogin('gus', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  // a second backend of the same app, after the first one died
  const b = createAgents({ app: 'testapp', sandbox: a.sandbox, store: a.store, encryptionKey, proxyUrl: a.proxyUrl, oauth: { redirectUrl: 'http://127.0.0.1:9/callback' } })
  const crash = async (token?: string) => {
    const s = await a.agents.session('gus', { harness: 'claude' })
    // the CLI refreshed its login, then the backend died: close() never runs; the leases ran out
    if (token) await s.sandbox.writeFile(`${s.sandbox.home}/.claude/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: token } }))
    await a.store.delete('ailoginlease/gus/claude')
    const k = 'usersandbox/gus/local/claude/'
    await a.store.put(k, JSON.stringify({ ...JSON.parse((await a.store.get(k))!.value), holder: undefined, until: 0 }))
  }
  const cred = async () => ((await collect(b.run('gus', { harness: 'claude', task: 'cred' }))).at(-1) as { result: string }).result

  await crash('refreshed-by-dead-job')
  assert.equal(await cred(), 'cred: refreshed-by-dead-job', 'the refresh the dead job left is used, not the older stored copy')
  assert.equal(await cred(), 'cred: refreshed-by-dead-jobx', 'and was saved')
  assert.ok(!a.store.keys().some((k) => k.startsWith('ailoginloan/')), 'no loan after a job closed')

  // the user signed in again after the crash: the store moved on, so what the dead job left is not saved
  await crash('stale')
  await b.connectLogin('gus', 'claude')
  await b.finishLogin('gus', 'claude', { code: 'good-code' })
  assert.equal(await cred(), 'cred: lab-secret-claude')
  await b.deleteSandbox('gus')
})

test('R5.4 / R1.4: a job that waits in line for the AI login keeps its sandbox, and its time starts when it has the login', async () => {
  // spec/tla/JobTiming.tla found these: the sandbox's lease ran out while its job still waited for the login, and the
  // next job of that sandbox key took the sandbox while the first one ran in it; and the login's watcher and the
  // provider's time counted the wait, so the watcher removed the login while the harness ran
  const { clock } = await import('../src/time.ts')
  const { storedLogin } = await import('../src/index.ts')
  const a = await testApp({ env, login: storedLogin({ parallel: false }), waitMs: 2_000 }); closers.push(a.close)
  // each sandbox's time as the provider was told (Sandbox.setTimeout), and when each login watcher runs
  const timeouts: number[] = [], watchers: number[] = []
  const create = a.sandbox.create
  a.sandbox.create = async (o) => {
    const s = await create(o)
    const run = s.run
    s.run = (cmd, ro) => { const m = /^sleep (\d+); \[/.exec(cmd); if (m) watchers.push(clock.now() + Number(m[1]) * 1000); return run(cmd, ro) }
    s.setTimeout = async (ms) => { timeouts.push(clock.now() + ms) }
    return s
  }
  await a.agents.connectLogin('kim', 'claude')
  assert.deepEqual(await a.agents.finishLogin('kim', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  const real = clock.now
  // job 1 (sandbox key `a`) holds the login; job 2 (key `b`) has its sandbox and waits in line for the login
  const first = await a.agents.session('kim', { harness: 'claude', sandboxKey: 'a' })
  let inLine!: () => void
  const waiting = new Promise<void>((r) => { inLine = r })
  const second = a.agents.session('kim', { harness: 'claude', sandboxKey: 'b', onWait: (w) => { if (w.for === 'login') inLine() } })
  await waiting
  let third: Promise<unknown> | undefined
  try {
    // job 1 runs for its whole time: then job 2 takes the login, 36 minutes after it took its sandbox
    clock.now = () => real() + 36 * 60_000
    await first.close()
    const s2 = await second
    // job 2 has its whole time from now: the provider's time is set again, and the watcher runs after the harness's time
    const t = clock.now(), timeout = 30 * 60_000
    assert.ok(Math.abs(timeouts.at(-1)! - (t + timeout + 60_000)) < 5_000, `the sandbox's time: ${(timeouts.at(-1)! - t) / 1000} s`)
    assert.ok(Math.abs(watchers.at(-1)! - (t + timeout + 45_000)) < 5_000, `the watcher: ${(watchers.at(-1)! - t) / 1000} s`)
    try {
      // job 3 of key `b` waits for job 2's sandbox, and gives up after waitMs
      const waits: string[] = []
      third = collect(a.agents.run('kim', { harness: 'claude', sandboxKey: 'b', task: 'hi', onWait: (w) => { waits.push(w.for) } }))
      let t: ReturnType<typeof setInterval> | undefined
      const took = new Promise<'took'>((r) => { t = setInterval(() => { if (waits.includes('login')) r('took') }, 50) })
      const ev = await Promise.race([third, took]).finally(() => clearInterval(t))
      assert.notEqual(ev, 'took', 'job 3 took the sandbox that job 2 runs in')
      assert.match((ev as { message: string }[])[0]!.message, /still holds the claude sandbox "b"/)
    } finally { await s2.close() }
  } finally {
    await third
    clock.now = real
  }
  await a.agents.deleteSandbox('kim')
})

/** spec/tla/JobTiming.tla: job 1 (sandbox key `a`) holds the login alone; job 2 (key `b`) has its sandbox and waits in
 *  line for the login `minutes` minutes, while the job's intervals (the beat) run as time goes. The provider is a
 *  stand-in for E2B's timer: a sandbox whose time ran out pauses, and a call to it then fails. */
async function waitForLogin(t: import('node:test').TestContext, minutes: number) {
  const { clock } = await import('../src/time.ts')
  const { storedLogin } = await import('../src/index.ts')
  const a = await testApp({ env, login: storedLogin({ parallel: false }) }); closers.push(a.close)
  const out = { paused: [] as string[], late: [] as string[] }
  const create = a.sandbox.create
  let timed = false
  a.sandbox.create = async (o) => {
    const s = await create(o)
    // job 1's sandbox has no timer here: it closes after the time a real one would have
    if (!timed) return s
    let end = clock.now() + o!.timeoutMs!
    const due = async () => {
      if (clock.now() < end) return
      if (!out.paused.includes(s.id)) { out.paused.push(s.id); await s.pause() }
      throw new Error(`stand-in: the sandbox ${s.id} paused at its time`)
    }
    const { run, writeFile } = s
    s.run = async (cmd, ro) => {
      await due()
      // the login's watcher: it must run before the provider pauses the sandbox, also if this backend dies now
      const m = /^sleep (\d+); \[/.exec(cmd)
      if (m && clock.now() + Number(m[1]) * 1000 >= end) out.late.push(`the watcher runs ${(clock.now() + Number(m[1]) * 1000 - end) / 1000} s after the sandbox's time`)
      return run(cmd, ro)
    }
    s.writeFile = async (p, d) => { await due(); return writeFile(p, d) }
    s.setTimeout = async (ms) => { await due(); end = clock.now() + ms }
    return s
  }
  await a.agents.connectLogin('kim', 'claude')
  assert.deepEqual(await a.agents.finishLogin('kim', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  t.mock.timers.enable({ apis: ['setInterval'] })
  const real = clock.now
  const first = await a.agents.session('kim', { harness: 'claude', sandboxKey: 'a' })
  timed = true
  let inLine!: () => void
  const waiting = new Promise<void>((r) => { inLine = r })
  const second = a.agents.session('kim', { harness: 'claude', sandboxKey: 'b', onWait: (w) => { if (w.for === 'login') inLine() } })
  second.catch(() => {})
  await waiting
  try {
    for (let i = 1; i <= minutes; i++) {
      clock.now = () => real() + i * 60_000
      t.mock.timers.tick(60_000)
      await new Promise((r) => setTimeout(r, 20))
    }
    await first.close()
    const s2 = await second.catch((e: Error) => e)
    if (!(s2 instanceof Error)) await s2.close()
    return { ...out, error: s2 instanceof Error ? s2.message : undefined }
  } finally {
    clock.now = real
    await a.agents.deleteSandbox('kim')
  }
}

test('R5.8 / R5.4: a job that waits in line for the AI login longer than its sandbox\'s time keeps its sandbox', async (t) => {
  // spec/tla/JobTiming.tla found it (JobTiming_main_wait): the sandbox's time (jobTimeoutMs + 60 s from its create or
  // resume) ran out while its job still waited for the login, so E2B paused it, load could not write the login, the
  // job failed, and close destroyed the user's kept sandbox
  const r = await waitForLogin(t, 34)
  assert.equal(r.error, undefined, 'the job that waited 34 minutes for the login starts')
  assert.deepEqual(r.paused, [], 'no sandbox paused while its job waited')
})

test('R1.4: the login\'s watcher runs before the provider would pause the sandbox, also before the job sets the sandbox\'s time again', async (t) => {
  // spec/tla/JobTiming.tla found it (JobTiming_main_settime): after a wait of 2 minutes, the sandbox's time still was the
  // one of its create (jobTimeoutMs + 60 s), and the watcher's the wait's later (jobTimeoutMs + 45 s from the login);
  // a backend that died before job.ts's setTimeout left the login in the sandbox that E2B then paused
  const r = await waitForLogin(t, 2)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.late, [])
})

test('R1.4: the login\'s watcher runs before the provider would pause the sandbox, also when load runs before the first beat', async (t) => {
  // spec/tla/JobTiming.tla found it (JobTiming_main_firstbeat): the beat first sets the sandbox's time 60 s after the job
  // began, but create and resume gave it only jobTimeoutMs + 60 s. A setup of 20 s (checkServers, install) put the
  // watcher at load + jobTimeoutMs + 45 s, after the sandbox's time; a backend that died before setTimeout left the
  // login in the sandbox that E2B then paused
  const { clock } = await import('../src/time.ts')
  const a = await app()
  await a.agents.connectLogin('max', 'claude')
  assert.deepEqual(await a.agents.finishLogin('max', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  t.mock.timers.enable({ apis: ['setInterval'] })
  const real = clock.now, late: string[] = []
  const create = a.sandbox.create
  a.sandbox.create = async (o) => {
    const s = await create(o)
    const end = clock.now() + o!.timeoutMs!
    const run = s.run
    s.run = (cmd, ro) => {
      // the setup takes 20 s, less than the beat's first minute
      if (cmd.startsWith('rm -rf ')) { const at = clock.now() + 20_000; clock.now = () => at }
      const m = /^sleep (\d+); \[/.exec(cmd)
      if (m && clock.now() + Number(m[1]) * 1000 >= end) late.push(`the watcher runs ${(clock.now() + Number(m[1]) * 1000 - end) / 1000} s after the sandbox's time`)
      return run(cmd, ro)
    }
    return s
  }
  try {
    const s = await a.agents.session('max', { harness: 'claude' })
    await s.close()
  } finally { clock.now = real }
  assert.deepEqual(late, [])
  await a.agents.deleteSandbox('max')
})

test('R1.4: a backend that dies while load writes the login into the sandbox leaves no login there once the watcher ran', async () => {
  // spec/tla/JobTiming.tla found it (JobTiming_main_load): load wrote the login files, and only then started the
  // watcher; a backend that died in between left them in the sandbox that the provider later paused
  const a = await app()
  await a.agents.connectLogin('lou', 'claude')
  assert.deepEqual(await a.agents.finishLogin('lou', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  const seen: string[] = []
  const create = a.sandbox.create
  a.sandbox.create = async (o) => {
    const s = await create(o)
    const run = s.run
    // the backend dies at the chmod after the files are written: that call never returns
    s.run = (cmd, ro) => { seen.push(cmd); return cmd.startsWith('chmod 600') ? new Promise(() => {}) : run(cmd, ro) }
    return s
  }
  void a.agents.session('lou', { harness: 'claude' })
  for (let i = 0; i < 200 && !seen.some((c) => c.startsWith('chmod 600')); i++) await new Promise((r) => setTimeout(r, 25))
  assert.ok(seen.some((c) => c.startsWith('chmod 600')), 'load wrote the files')
  assert.ok(seen.some((c) => /^sleep \d+; \[/.test(c)), 'the watcher already runs in the sandbox')
})

test('R1.4: byoa saves a login from a sandbox only when it is the same account and not older', async () => {
  const { accept } = await import('../src/login-stored.ts')
  const codex = (account: string, last: string, t = 'a') => ({ '.codex/auth.json': JSON.stringify({ tokens: { access_token: t, account_id: account }, last_refresh: last }) })
  const claude = (account: string, expiresAt: number, t = 'a') => ({
    '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: t, expiresAt } }),
    '.claude/.claude.json': JSON.stringify({ oauthAccount: { accountUuid: account } }),
  })
  assert.equal(accept('codex', codex('acc-1', '2026-11-20T00:00:00Z'), codex('acc-1', '2026-11-24T00:00:00Z', 'b')), true, 'refreshed')
  assert.equal(accept('codex', codex('acc-1', '2026-11-20T00:00:00Z'), codex('acc-2', '2026-11-24T00:00:00Z', 'b')), false, 'another account')
  assert.equal(accept('codex', codex('acc-1', '2026-11-24T00:00:00Z'), codex('acc-1', '2026-11-20T00:00:00Z', 'b')), false, 'older')
  assert.equal(accept('codex', codex('acc-1', '2026-11-20T00:00:00Z'), codex('acc-1', '2026-11-20T00:00:00Z')), false, 'unchanged')
  assert.equal(accept('codex', codex('acc-1', '2026-11-20T00:00:00Z'), {}), false, 'no files')
  assert.equal(accept('claude', claude('u-1', 1000), claude('u-1', 2000, 'b')), true)
  assert.equal(accept('claude', claude('u-1', 1000), claude('u-2', 2000, 'b')), false)
  assert.equal(accept('claude', claude('u-1', 2000), claude('u-1', 1000, 'b')), false)
  // the account in .credentials.json counts first, as Claude Code 2.1.330 writes it there too
  const moved = { ...claude('u-1', 2000, 'b'), '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'b', expiresAt: 2000, accountUuid: 'u-2' } }) }
  assert.equal(accept('claude', claude('u-1', 1000), moved), false)
})

test('R1.7: cancelLogin ends a sign-in and its sandbox at once; signOut does too', async () => {
  const { agents, sandbox } = await app()
  await agents.connectLogin('hal', 'claude')
  assert.equal(running(sandbox), 1)
  assert.deepEqual(await agents.finishLogin('hal', 'claude'), { state: 'pending' }, 'a check-in with no code')
  await agents.cancelLogin('hal', 'claude')
  assert.equal(running(sandbox), 0)
  assert.deepEqual(await agents.finishLogin('hal', 'claude', { code: 'good-code' }), { state: 'signed-out', error: 'no sign-in is in progress' })
  await agents.connectLogin('hal', 'claude')
  await agents.signOut('hal', 'claude')
  assert.equal(running(sandbox), 0)
})

test('R1.7: a cancelLogin while connectLogin creates its sandbox ends that sandbox', async () => {
  // spec/tla/SignIn.tla found it: cancelLogin found no sign-in yet, and connectLogin went on with its sandbox
  const { agents, sandbox } = await app()
  const create = sandbox.create
  let cancelled = false
  sandbox.create = async (o) => {
    const s = await create(o)
    if (o?.labels?.['byoa-login'] && !cancelled) { cancelled = true; await agents.cancelLogin('ida', 'claude') }
    return s
  }
  const r = await agents.connectLogin('ida', 'claude').then((v) => v, (e: Error) => e)
  assert.ok(cancelled)
  assert.equal(running(sandbox), 0, 'the sign-in sandbox is gone once connectLogin returns')
  assert.match((r as Error).message, /cancelled/)
  assert.deepEqual(await agents.finishLogin('ida', 'claude'), { state: 'signed-out', error: 'no sign-in is in progress' })
})

test('R1.7: two connectLogin at once leave one sign-in, and cancelLogin ends it and both sandboxes', async () => {
  // spec/tla/SignIn.tla found it: the second connectLogin's entry hid the first one's sandbox from cancelLogin
  const { agents, sandbox } = await app()
  const create = sandbox.create
  let second: Promise<unknown> | undefined
  sandbox.create = async (o) => {
    const s = await create(o)
    if (o?.labels?.['byoa-login'] && !second) { second = agents.connectLogin('uma', 'claude'); await second }
    return s
  }
  const first = await agents.connectLogin('uma', 'claude').then((v) => v, (e: Error) => e)
  assert.equal(typeof (await second as { url: string }).url, 'string', 'the second connectLogin shows its page')
  await agents.cancelLogin('uma', 'claude')
  assert.equal(running(sandbox), 0, `no sign-in sandbox after cancelLogin (the first connectLogin: ${first instanceof Error ? first.message : 'returned'})`)
})

for (const login of ['storedLogin', 'cliLogin'] as const) {
  test(`R1.6: a signOut while finishLogin saves the login wins (${login})`, async () => {
    // spec/tla/SignIn.tla found it: finishLogin read the login, signOut ran, and then finishLogin saved it
    const a = await testApp({ env, ...(login === 'cliLogin' ? { login: cliLogin } : {}) }); closers.push(a.close)
    await a.agents.connectLogin('ola', 'claude')
    const resume = a.sandbox.resume
    let out = false
    a.sandbox.resume = async (id, o) => {
      const s = await resume(id, o)
      // finishLogin found the CLI's login in this sandbox (cliLogin), or read it to save it (storedLogin): signOut runs
      // to its end before finishLogin goes on
      const run = s.run.bind(s), readFile = s.readFile!.bind(s)
      const signOut = async () => { if (!out) { out = true; await a.agents.signOut('ola', 'claude') } }
      s.run = async (cmd, ro) => { const r = await run(cmd, ro); if (login === 'cliLogin' && cmd.startsWith('test -s ')) await signOut(); return r }
      s.readFile = async (p) => { const r = await readFile(p); if (p.endsWith('/.claude/.claude.json')) await signOut(); return r }
      return s
    }
    await a.agents.finishLogin('ola', 'claude', { code: 'good-code' })
    assert.ok(out)
    assert.equal(await a.agents.loginState('ola', 'claude'), 'signed-out', 'signed out after signOut returned')
    assert.equal((await collect(a.agents.run('ola', { harness: 'claude', task: 'cred' })))[0]!.type, 'error', 'no job runs with the login')
    assert.ok(!(await Promise.all(a.store.keys().filter((k) => k.startsWith('ailogin/')).map((k) => a.store.get(k)))).some((e) => e?.value), 'no login stored')
    assert.equal(running(a.sandbox), 0)
  })
}

test('R5.7: a job runs the model and effort it names, else the app\'s default for the harness', async () => {
  const a = await testApp({ env, models: { claude: { model: 'opus' }, codex: { model: 'gpt-6.2-sol', effort: 'high' } } }); closers.push(a.close)
  for (const h of ['claude', 'codex'] as const) {
    await a.agents.connectLogin('ivy', h)
    await a.agents.finishLogin('ivy', h, h === 'claude' ? { code: 'good-code' } : { waitMs: 10_000 })
  }
  const args = async (r: Partial<RunOptions> & { harness: 'claude' | 'codex' }) => {
    const t = (await collect(a.agents.run('ivy', { task: 'hi', ...r }))).find((e) => e.type === 'text' && e.text.startsWith('args: ')) as { text: string }
    return t.text.slice(6).split(';')[0]
  }
  assert.match(await args({ harness: 'claude' }), / --model opus$/)
  assert.match(await args({ harness: 'claude', effort: 'max' }), / --model opus --effort max$/)
  assert.match(await args({ harness: 'claude', model: 'haiku' }), / --model haiku$/)
  assert.match(await args({ harness: 'codex' }), / -c model="gpt-6\.2-sol" -c model_reasoning_effort="high"$/)
  assert.match(await args({ harness: 'codex', model: 'gpt-5.5', effort: 'low' }), / -c model="gpt-5\.5" -c model_reasoning_effort="low"$/)
})

test('R5.7: listModels lists what the user\'s plan has, as each CLI lists it with the user\'s login', async () => {
  const { agents, sandbox } = await app()
  await assert.rejects(agents.listModels('jo', 'claude'), /not signed in/)
  await agents.connectLogin('jo', 'claude')
  await agents.finishLogin('jo', 'claude', { code: 'good-code' })
  assert.deepEqual(await agents.listModels('jo', 'claude'), [
    { id: 'default', name: 'Default (recommended)', description: 'Sonnet 5.5', isDefault: true, efforts: ['low', 'medium', 'high'] },
    { id: 'opus', name: 'Opus', description: 'Opus 5.5', isDefault: false, efforts: ['low', 'high', 'max'], resolved: 'claude-opus-5-5' },
    { id: 'haiku', name: 'Haiku', description: 'Haiku 5.5', isDefault: false, efforts: [] },
  ])
  await agents.connectLogin('jo', 'codex')
  await agents.finishLogin('jo', 'codex', { waitMs: 10_000 })
  assert.deepEqual(await agents.listModels('jo', 'codex'), [
    { id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', description: 'Fast', isDefault: true, efforts: ['low', 'ultra'] },
  ], 'both pages, without the hidden model')
  assert.equal(running(sandbox), 0, 'its sandbox is gone')
})

test('R1.2: Grok Build device sign-in: xAI\'s page and the code as data; a job\'s MCP call through use_tool is the MCP tool itself (R5.5)', async () => {
  const { agents, sandbox } = await app()
  assert.deepEqual(await agents.connectLogin('gil', 'grok'), { harness: 'grok', url: 'https://accounts.x.ai/oauth2/device?user_code=WXYZ-2345', code: 'WXYZ-2345' })
  assert.deepEqual(await agents.finishLogin('gil', 'grok'), { state: 'pending' })
  assert.deepEqual(await agents.finishLogin('gil', 'grok', { waitMs: 10_000 }), { state: 'signed-in' })
  const ev = await collect(agents.run('gil', { harness: 'grok', task: 'who am I?', model: 'grok-4.5', effort: 'low' }))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'tool_call', 'tool_result', 'text', 'end'])
  assert.equal((ev[1] as { text: string }).text, 'args: --trust --no-auto-update agent --always-approve -m grok-4.5 --reasoning-effort low stdio; session: new; home: .grok; autoupdater off: 1; memory: 0')
  assert.deepEqual(ev[2], { type: 'tool_call', id: 't1', server: 'notes', name: 'whoami', input: {} })
  assert.deepEqual(ev[3], { type: 'tool_result', id: 't1', ok: true, output: 'you are alice' }, 'the tool\'s own text, not Grok\'s wrapper')
  assert.deepEqual(ev[5], { type: 'end', ok: true, result: 'You are alice.', usage: { input: 10, output: 3, cached: 5 } })
  // R1.6: a login that xAI refuses during a turn is reported as expired
  const ex = await collect(agents.run('gil', { harness: 'grok', task: 'expire now' }))
  assert.deepEqual(ex.slice(-2).map((e) => e.type === 'error' ? e.code : e.type), ['expired', 'end'])
  assert.equal(await agents.loginState('gil', 'grok'), 'expired')
  await agents.connectLogin('gil', 'grok')
  await agents.finishLogin('gil', 'grok', { waitMs: 10_000 })
  // the login was saved and refreshed as for the other harnesses
  assert.equal(((await collect(agents.run('gil', { harness: 'grok', task: 'cred' }))).at(-1) as { result: string }).result, 'cred: lab-secret-grok')
  assert.equal(((await collect(agents.run('gil', { harness: 'grok', task: 'cred' }))).at(-1) as { result: string }).result, 'cred: lab-secret-grokx')
  assert.equal(running(sandbox), 0)
  assert.deepEqual(await agents.listModels('gil', 'grok'), [
    { id: 'grok-4.7', name: 'Grok 4.7', description: 'Frontier', isDefault: true, efforts: ['high', 'low'] },
    { id: 'grok-4.5', name: 'Grok 4.5', description: '', isDefault: false, efforts: [] },
  ])
  await agents.signOut('gil', 'grok')
  assert.equal(await agents.loginState('gil', 'grok'), 'signed-out')
})

test('R1.4: Grok\'s login: when it is due, whose it is', async () => {
  const { refreshDue, accept } = await import('../src/login-stored.ts')
  // the shape of grok 1.0.92's auth.json (seen with a real login): one entry for each sign-in scope
  const grok = (user: string, expiresAt: string, t = 'a') => ({ '.grok/auth.json': JSON.stringify({ 'https://auth.x.ai::c': { key: t, user_id: user, refresh_token: `r-${t}`, expires_at: expiresAt } }) })
  assert.equal(refreshDue('grok', grok('u-1', '2026-11-25T15:02:54.845984658Z')), Date.parse('2026-11-25T15:02:54.845Z') - 5 * 60_000)
  assert.equal(refreshDue('grok', { '.grok/auth.json': '{"x":{"key":"a"}}' }), 0, 'no expires_at: one job at a time')
  assert.equal(accept('grok', grok('u-1', '2026-11-25T15:00:00Z'), grok('u-1', '2026-11-25T21:00:00Z', 'b')), true, 'refreshed')
  assert.equal(accept('grok', grok('u-1', '2026-11-25T15:00:00Z'), grok('u-2', '2026-11-25T21:00:00Z', 'b')), false, 'another account')
  assert.equal(accept('grok', grok('u-1', '2026-11-25T21:00:00Z'), grok('u-1', '2026-11-25T15:00:00Z', 'b')), false, 'older')
})

test('R1.4 / R5.8: Grok jobs of one user share a login that is not due for a refresh', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const together = async (endsInMin: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'byoa-together-'))
    const a = await testApp({ env: { ...env, FAKE_GROK_DIR: dir, FAKE_GROK_EXP: new Date(Date.now() + endsInMin * 60_000).toISOString() } }); closers.push(a.close)
    await a.agents.connectLogin('hoa', 'grok')
    assert.deepEqual(await a.agents.finishLogin('hoa', 'grok', { waitMs: 10_000 }), { state: 'signed-in' })
    const ends = await Promise.all(['a', 'b', 'c'].map(async (key) => (await collect(a.agents.run('hoa', { harness: 'grok', task: 'together', sandboxKey: key }))).at(-1) as { ok: boolean; result: string }))
    assert.ok(ends.every((e) => e.ok), JSON.stringify(ends))
    return Math.max(...ends.map((e) => Number(e.result.replace('together: ', ''))))
  }
  // Grok's access token lasts 6 hours: the CLI will not refresh it during these jobs
  assert.equal(await together(6 * 60), 3, 'the three jobs ran at the same time')
  assert.equal(await together(20), 1, 'due before a job\'s time runs out: one at a time')
})

test('R5.9: a conversation with each harness: the first job names or reads the session, the next ones resume it', async () => {
  const { agents, sandbox } = await app()
  for (const h of ['claude', 'codex', 'grok'] as const) {
    await agents.connectLogin('kim', h)
    assert.deepEqual(await agents.finishLogin('kim', h, h === 'claude' ? { code: 'good-code' } : { waitMs: 10_000 }), { state: 'signed-in' })
  }
  const say = (harness: 'claude' | 'codex' | 'grok', task: string, conversation = `${harness}-1`) => collect(agents.run('kim', { harness, task, conversation }))
  const texts = (ev: Awaited<ReturnType<typeof say>>) => ev.flatMap((e) => e.type === 'text' ? [e.text] : [])
  const end = (ev: Awaited<ReturnType<typeof say>>) => ev.at(-1) as { ok: boolean; session?: string }

  // Claude Code: byoa names the session (--session-id), then resumes it (--resume)
  const c1 = await say('claude', 'my name is Kim')
  const sid = end(c1).session!
  assert.match(sid, /^[0-9a-f-]{36}$/)
  assert.ok(texts(c1).some((t) => t.includes(`--session-id ${sid}`) && !t.includes('--no-session-persistence')), texts(c1).join('\n'))
  const c2 = await say('claude', 'what is my name?')
  assert.deepEqual(c2[0], { type: 'start', harness: 'claude', version: '2.1.330', sandbox: 'local', conversation: 'claude-1', resumed: true })
  assert.ok(texts(c2).includes('remembers 1: my name is Kim|'))
  assert.ok(texts(c2).some((t) => t.includes(`--resume ${sid}`)))
  assert.equal(end(c2).session, sid)

  // Codex: it names the thread in thread/started, and keeps it (not ephemeral); the next job resumes it (thread/resume)
  const x1 = await say('codex', 'my name is Kim')
  assert.equal(end(x1).session, 'th1')
  assert.ok(texts(x1).some((t) => t.includes('"ephemeral":false')), texts(x1).join('\n'))
  const x2 = await say('codex', 'what is my name?')
  assert.ok(texts(x2).includes('remembers 1: what is my name?'), texts(x2).join('\n'))
  assert.ok(texts(x2).some((t) => t.includes('"threadId":"th1"')), texts(x2).join('\n'))
  // Codex keeps its sessions by date, not by folder: a lost sandbox gets the transcript from the store
  const kept = [...sandbox.live]
  for (const id of kept) await sandbox.destroy(id)
  const x3 = await say('codex', 'and now?')
  assert.deepEqual(x3.filter((e) => e.type === 'error'), [])
  assert.ok(texts(x3).includes('remembers 2: and now?'), texts(x3).join('\n'))

  // Grok Build: session/new names the session, and the next job resumes it (session/resume)
  const g1 = await say('grok', 'my name is Kim')
  const gid = end(g1).session!
  assert.ok(gid)
  assert.ok(texts(g1).some((t) => t.startsWith('remembers 0: my name is Kim; session: new')), texts(g1).join('\n'))
  const g2 = await say('grok', 'what is my name?')
  assert.ok(texts(g2).some((t) => t.startsWith('remembers 1: what is my name?; session: resumed')), texts(g2).join('\n'))
  assert.equal(end(g2).session, gid)
  assert.equal(running(sandbox), 0)
})

test('R5.10: a running Claude Code job takes more messages: each one waits for the turn before it, and the job ends after the last', async () => {
  const { agents } = await app()
  await agents.connectLogin('lee', 'claude')
  await agents.finishLogin('lee', 'claude', { code: 'good-code' })
  const job = agents.run('lee', { harness: 'claude', task: 'slow first', conversation: 'c' })
  const ev: Awaited<ReturnType<typeof collect>> = []
  for await (const e of job) {
    ev.push(e)
    if (e.type === 'start') assert.equal(await job.send('and a second one'), true)
  }
  assert.equal(await job.send('too late'), false, 'the job ended')
  const types = ev.map((e) => e.type)
  assert.equal(types.filter((t) => t === 'turn').length, 1, types.join(' '))
  assert.equal(types.at(-1), 'end')
  assert.ok(types.indexOf('turn') < types.lastIndexOf('text'), 'the second turn comes after the first one')
  assert.ok(ev.some((e) => e.type === 'text' && e.text === 'remembers 1: slow first|'), 'the second message is a turn of the same session')
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'You are alice.', usage: { input: 15, output: 3, cached: 5, costUsd: 0.01 }, session: (ev.at(-1) as { session: string }).session })

  // a CLI that ends with no result, while its input is still open, ends the job at once
  const t0 = Date.now()
  const crash = await collect(agents.run('lee', { harness: 'claude', task: 'crash' }))
  assert.ok(Date.now() - t0 < 15_000, `ended in ${Date.now() - t0} ms`)
  assert.deepEqual(crash.at(-1), { type: 'end', ok: false })
  assert.ok(crash.some((e) => e.type === 'error' && e.message.includes('boom')), JSON.stringify(crash))
})

for (const h of ['codex', 'grok'] as const) {
  test(`R5.10: a running ${h} job takes a message into the turn that runs (steering), and ends after it`, async () => {
    const { agents } = await app()
    await agents.connectLogin('mo', h)
    await agents.finishLogin('mo', h, { waitMs: 10_000 })
    const job = agents.run('mo', { harness: h, task: 'slow first', conversation: 'c' })
    const ev: Awaited<ReturnType<typeof collect>> = []
    for await (const e of job) {
      ev.push(e)
      if (e.type === 'start') assert.equal(await job.send('and a second one'), true)
    }
    assert.equal(await job.send('too late'), false, 'the job ended')
    const types = ev.map((e) => e.type)
    assert.deepEqual(types.filter((t) => t === 'turn' || t === 'end'), ['end'], types.join(' '))
    assert.ok(ev.some((e) => e.type === 'text' && e.text.startsWith('remembers 0: slow first | and a second one')), JSON.stringify(ev))
    assert.equal((ev.at(-1) as { ok: boolean }).ok, true)
  })
}

for (const h of ['claude', 'codex', 'grok'] as const) {
  // spec/tla/Steer.tla (Steer_main_*): the reader reads the CLI's output while the app is still on an earlier event,
  // so when the job handles the end of the first turn, the reader may have counted the next message already
  test(`R5.10: a ${h} job whose app reads its events slowly still answers the message it sent before it ends`, async () => {
    const { agents } = await app()
    await agents.connectLogin('sam', h)
    await agents.finishLogin('sam', h, h === 'claude' ? { code: 'good-code' } : { waitMs: 10_000 })
    const job = agents.run('sam', { harness: h, task: 'first', conversation: 'c' })
    const ev: Awaited<ReturnType<typeof collect>> = []
    for await (const e of job) {
      ev.push(e)
      // an app that stores each event before it reads the next one: both turns run meanwhile (the CLI starts when
      // the app reads past `start`)
      if (e.type === 'start') assert.equal(await job.send('and a second one'), true)
      if (e.type === 'text' && ev.filter((x) => x.type === 'text').length === 1) await new Promise((r) => setTimeout(r, 2000))
    }
    const types = ev.map((e) => e.type)
    assert.deepEqual(types.filter((t) => t === 'turn' || t === 'end'), ['turn', 'end'], types.join(' '))
    assert.ok(ev.slice(types.indexOf('turn')).some((e) => e.type === 'text' && /remembers 1: /.test(e.text)), JSON.stringify(ev))
  })
}

// spec/tla/Steer.tla (Steer_main_grok_fail): Grok answers the prompt of a failed turn with an error after its
// turn_completed; when that answer reaches the driver after the next turn started, the driver took it for a turn
// that did not start, and failed the job
test('R5.10: a grok job goes on with the next message after a failed turn, also when the failed prompt is answered late', async () => {
  const { agents } = await app()
  await agents.connectLogin('ray', 'grok')
  await agents.finishLogin('ray', 'grok', { waitMs: 10_000 })
  const job = agents.run('ray', { harness: 'grok', task: 'busy late', conversation: 'c' })
  const ev: Awaited<ReturnType<typeof collect>> = []
  for await (const e of job) {
    ev.push(e)
    // the first turn failed: the app sends the next message, whose turn runs when the late answer comes
    if (e.type === 'error' && e.code === 'rate-limited' && ev.filter((x) => x.type === 'error').length === 1) assert.equal(await job.send('slow second'), true)
  }
  const types = ev.map((e) => e.type)
  assert.deepEqual(types.filter((t) => t === 'turn' || t === 'end'), ['turn', 'end'], JSON.stringify(ev))
  assert.ok(ev.some((e) => e.type === 'text' && e.text.startsWith('remembers 1: slow second')), JSON.stringify(ev))
  assert.equal((ev.at(-1) as { ok: boolean }).ok, true, JSON.stringify(ev))
})

test('R1.9 / V23: a used-up plan is usage-limit, with its reset when the CLI says; until then a job starts no sandbox', async () => {
  const { clock } = await import('../src/time.ts')
  const { agents, sandbox } = await app()
  const err = (ev: Awaited<ReturnType<typeof collect>>) => ev.find((e) => e.type === 'error') as Extract<typeof ev[number], { type: 'error' }>
  await agents.connectLogin('lia', 'claude')
  await agents.finishLogin('lia', 'claude', { code: 'good-code' })
  await agents.connectLogin('lia', 'codex')
  await agents.finishLogin('lia', 'codex', { waitMs: 10_000 })
  await agents.connectLogin('lia', 'grok')
  await agents.finishLogin('lia', 'grok', { waitMs: 10_000 })
  // 2100-01-01, the stand-ins' reset; Codex's is its used-up 5-hour window, not its weekly one at 40%
  const RESET = 4102444800_000
  const limited = { claude: /You've hit your session limit/, codex: /You’ve hit your usage limit/, grok: /hit the rate limit for your plan/ }
  for (const h of ['claude', 'codex', 'grok'] as const) {
    assert.equal(await agents.usageLimit('lia', h), undefined)
    const e = err(await collect(agents.run('lia', { harness: h, task: 'limit now' })))
    assert.equal(e.code, 'usage-limit', h)
    assert.match(e.message, limited[h])
    // Grok Build says no reset time; Grok's own class (rate_limit) would say rate-limited, its words say the plan
    assert.equal(e.resetsAt, h === 'grok' ? undefined : RESET, h)
    const l = (await agents.usageLimit('lia', h))!
    assert.equal(l.until, h === 'grok' ? l.until : RESET)
    if (h === 'grok') assert.ok(Math.abs(l.until - Date.now() - 15 * 60_000) < 60_000, 'no reset time: 15 minutes')
    // the next job ends at once: the same code, and no sandbox resumed or created
    const created = sandbox.created, cmds = sandbox.envs.length
    const next = await collect(agents.run('lia', { harness: h, task: 'who am I?' }))
    assert.deepEqual(next.map((x) => x.type === 'error' ? x.code : x.type), ['usage-limit', 'end'])
    assert.equal(err(next).resetsAt, h === 'grok' ? undefined : RESET)
    assert.match(err(next).message, /byoa did not start this job/)
    assert.equal(sandbox.created, created)
    assert.equal(sandbox.envs.length, cmds, 'no command ran in a sandbox')
    assert.equal(await agents.loginState('lia', h), 'signed-in', 'a used-up plan is still signed in')
  }
  // the hold ends at its time, and the next job that works removes it
  const real = clock.now
  try {
    clock.now = () => real() + 16 * 60_000
    assert.equal(await agents.usageLimit('lia', 'grok'), undefined)
    assert.equal((await collect(agents.run('lia', { harness: 'grok', task: 'hello' }))).at(-1)!.type === 'end', true)
  } finally { clock.now = real }
  assert.equal(await agents.usageLimit('lia', 'grok'), undefined, 'a job that worked removed the hold')
  // one harness's limit is not another's, and a new sign-in (maybe another account) ends it
  assert.ok(await agents.usageLimit('lia', 'claude'))
  await agents.connectLogin('lia', 'claude')
  await agents.finishLogin('lia', 'claude', { code: 'good-code' })
  assert.equal(await agents.usageLimit('lia', 'claude'), undefined)
  await agents.signOut('lia', 'codex')
  assert.equal(await agents.usageLimit('lia', 'codex'), undefined)

  // R1.9: a lab that refuses for now is rate-limited, kept nowhere; Codex's unauthorized is a login that does not work
  const codes = [
    ['claude', 'busy'], ['grok', 'busy'],
  ] as const
  for (const [h, task] of codes) {
    const e = err(await collect(agents.run('lia', { harness: h, task })))
    assert.equal(e.code, 'rate-limited', h)
    assert.equal(e.resetsAt, undefined)
    assert.equal(await agents.usageLimit('lia', h), undefined)
  }
  await agents.connectLogin('lia', 'codex')
  await agents.finishLogin('lia', 'codex', { waitMs: 10_000 })
  assert.equal(err(await collect(agents.run('lia', { harness: 'codex', task: 'busy' }))).code, 'rate-limited')
  assert.equal(err(await collect(agents.run('lia', { harness: 'codex', task: 'refused' }))).code, 'expired')
  assert.equal(await agents.loginState('lia', 'codex'), 'expired')
})

/** A login that is not due for hours, so the jobs of one user share it and run at the same time. */
const sharing = async () => { const a = await testApp({ env: { ...env, FAKE_CLAUDE_EXP: String(Date.now() + 10 * 3600_000) } }); closers.push(a.close); return a }
const errOf = (ev: Awaited<ReturnType<typeof collect>>) => ev.find((e) => e.type === 'error') as Extract<typeof ev[number], { type: 'error' }>

test('R1.9: a job that worked ends only the hold it read, not one that another job set while it ran', async () => {
  // spec/tla/UsageLimit.tla (UsageLimit_main_clear): a job read a hold that had ended and ran; meanwhile another job
  // found the plan used up and kept that; then the first job ended well and deleted the new hold
  const { keys } = await import('../src/keys.ts')
  const { agents, store, sandbox } = await sharing()
  await agents.connectLogin('ola', 'claude')
  await agents.finishLogin('ola', 'claude', { code: 'good-code' })
  // a hold that ended a minute ago
  await store.put(keys.usageLimit('ola', 'claude'), JSON.stringify({ message: 'old', until: Date.now() - 60_000, at: Date.now() - 16 * 60_000 }))
  const first = agents.run('ola', { harness: 'claude', task: 'hi', sandboxKey: 'a' })
  const evs = [(await first.next()).value]
  assert.equal(evs[0].type, 'start', 'job 1 read the hold that ended, and runs')
  const e = (await collect(agents.run('ola', { harness: 'claude', task: 'limit now', sandboxKey: 'b' }))).find((x) => x.type === 'error')
  assert.equal(e?.type === 'error' && e.code, 'usage-limit')
  assert.ok(await agents.usageLimit('ola', 'claude'), 'job 2 kept the used-up plan')
  for await (const ev of first) evs.push(ev)
  assert.equal((evs.at(-1) as { ok: boolean }).ok, true)
  assert.ok(await agents.usageLimit('ola', 'claude'), 'job 1 worked before job 2 found the plan used up: the hold stays')
  const created = sandbox.created
  assert.equal(errOf(await collect(agents.run('ola', { harness: 'claude', task: 'hi' }))).code, 'usage-limit')
  assert.equal(sandbox.created, created, 'the next job starts no sandbox')
})

test('R1.9: a new sign-in ends the hold, also when a job of the old sign-in finds its plan used up after it', { todo: 'open: spec/tla UsageLimit_signin' }, async () => {
  // spec/tla/UsageLimit.tla (UsageLimit_signin): job 1 has the old login in its sandbox; the user signs in again
  // (maybe another account), which ends the hold; then job 1's CLI finds the old account's plan used up, and byoa
  // keeps that for the new sign-in
  const { agents, sandbox } = await sharing()
  await agents.connectLogin('pia', 'claude')
  await agents.finishLogin('pia', 'claude', { code: 'good-code' })
  const first = agents.run('pia', { harness: 'claude', task: 'limit now', sandboxKey: 'a' })
  assert.equal((await first.next()).value.type, 'start')
  await agents.connectLogin('pia', 'claude')
  assert.deepEqual(await agents.finishLogin('pia', 'claude', { code: 'good-code' }), { state: 'signed-in' })
  assert.equal(errOf(await collect(first)).code, 'usage-limit')
  assert.equal(await agents.usageLimit('pia', 'claude'), undefined, 'the old sign-in\'s used-up plan is not the new one\'s')
  const created = sandbox.created
  assert.equal((await collect(agents.run('pia', { harness: 'claude', task: 'hi' }))).at(-1)!.type === 'end' && sandbox.created > created, true, 'a job of the new sign-in runs')
})

test('R3.1 / R3.4: a job that waits in line keeps its job token for its whole time', async () => {
  // spec/tla/Tokens.tla (Tokens_main_wait): the job token's time (the job timeout + 5 minutes) started when the job
  // began, before its wait in line for the sandbox or the AI login; a job that waited longer than 5 minutes lost its
  // MCP servers and its plan's relay before its time ended
  const { clock } = await import('../src/time.ts')
  const { storedLogin } = await import('../src/index.ts')
  const a = await testApp({ env, login: storedLogin({ parallel: false }) }); closers.push(a.close)
  await a.agents.connectLogin('uma', 'claude')
  await a.agents.finishLogin('uma', 'claude', { code: 'good-code' })
  const real = clock.now
  const first = await a.agents.session('uma', { harness: 'claude', sandboxKey: 'a' })
  let inLine!: () => void
  const waiting = new Promise<void>((r) => { inLine = r })
  const second = a.agents.session('uma', { harness: 'claude', sandboxKey: 'b', onWait: (w) => { if (w.for === 'login') inLine() } })
  await waiting
  // the proxy checked the token when it answers anything but 401 (here 403: the job has no server `notes`)
  const proxy = (token: string) => fetch(`${a.proxyUrl}/notes`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' }).then((r) => r.status)
  try {
    clock.now = () => real() + 36 * 60_000
    await first.close()
    const s2 = await second
    assert.equal(await proxy(s2.token), 403, 'the token works when the harness starts')
    clock.now = () => real() + (36 + 29) * 60_000
    assert.equal(await proxy(s2.token), 403, 'the token works until the job\'s time ends')
    await s2.close()
    assert.equal(await proxy(s2.token), 401, 'R3.4: refused after the job')
  } finally { clock.now = real }
  await a.agents.deleteSandbox('uma')
})

test('R1.9: a new sign-in does not end a hold that a job of that new sign-in kept', { todo: 'open: spec/tla UsageLimit_signin_lost' }, async () => {
  // spec/tla/UsageLimit.tla (UsageLimit_signin_lost): finishLogin saves the new login, then ends the hold; a job that
  // starts in between runs with the new login, finds its plan used up and keeps that; then finishLogin's clear
  // deletes it, and the next job starts a sandbox on the used-up plan
  const { keys } = await import('../src/keys.ts')
  const a = await sharing()
  const { agents, store, sandbox } = a
  const del = store.delete.bind(store)
  let gate: Promise<void> | undefined, release!: () => void, reached!: () => void
  const at = new Promise<void>((r) => { reached = r })
  store.delete = async (k) => { if (gate && k === keys.usageLimit('ria', 'claude')) { reached(); await gate } return del(k) }
  await agents.connectLogin('ria', 'claude')
  await agents.finishLogin('ria', 'claude', { code: 'good-code' })
  await agents.connectLogin('ria', 'claude')
  gate = new Promise<void>((r) => { release = r })
  const signIn = agents.finishLogin('ria', 'claude', { code: 'good-code' })
  await at // the new login is saved; the clear has not run yet
  assert.equal(errOf(await collect(agents.run('ria', { harness: 'claude', task: 'limit now' }))).code, 'usage-limit')
  release()
  assert.deepEqual(await signIn, { state: 'signed-in' })
  assert.ok(await agents.usageLimit('ria', 'claude'), 'the new sign-in\'s plan is used up: the hold stays')
  const created = sandbox.created
  assert.equal(errOf(await collect(agents.run('ria', { harness: 'claude', task: 'hi' }))).code, 'usage-limit')
  assert.equal(sandbox.created, created)
})

test('R1.9: a used-up plan holds until its latest reset, also when a job keeps an earlier one after it', async () => {
  // spec/tla/UsageLimit.tla (UsageLimit_main_stale): a plan job read the limit its relay kept (credential.ts event)
  // and keeps it again (job.ts) after another job's relay kept a later reset (the plan's weekly limit, after its
  // 5-hour one): the hold ended at the earlier reset, and the next job ran on the used-up plan
  const { usageLimits } = await import('../src/limits.ts')
  const limits = usageLimits(memoryStore())
  const hour = Date.now() + 3600_000, week = Date.now() + 7 * 24 * 3600_000
  await limits.set('sia', 'opencode-go', { message: 'the weekly limit', resetsAt: week })
  await limits.set('sia', 'opencode-go', { message: 'the 5-hour limit', resetsAt: hour })
  assert.equal((await limits.get('sia', 'opencode-go'))!.until, week)
  // a hold that ended says nothing: the new one replaces it
  const { clock } = await import('../src/time.ts')
  const real = clock.now
  try {
    clock.now = () => week + 1
    await limits.set('sia', 'opencode-go', { message: 'no time' })
    assert.equal((await limits.get('sia', 'opencode-go'))!.until, week + 1 + 15 * 60_000)
  } finally { clock.now = real }
})
