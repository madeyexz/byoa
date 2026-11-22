// R1 and the Claude Code and Codex job paths, with stand-in CLIs (test/fixtures/bin) that print what the real ones
// print. This checks byoa's own side: the sign-in through a terminal and a FIFO, the stored login and the login
// volume, the login state, and the event schema. It does not prove the real CLIs work; V3 and V11 do.
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { after, test } from 'node:test'
import { cliLogin, memoryStore } from '../src/index.ts'
import { localSandbox } from '../src/sandbox/local.ts'
import { collect, testApp } from './helpers/app.ts'

const BIN = new URL('./fixtures/bin/', import.meta.url).pathname
chmodSync(`${BIN}claude`, 0o755)
chmodSync(`${BIN}codex`, 0o755)
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
  assert.equal(sandbox.live.size, 0, 'the sign-in sandbox is gone; the volume stays')

  // with cliLogin, the login is in the volume only, not in the app's database
  const stored = (await Promise.all((store as ReturnType<typeof memoryStore>).keys().map((k) => store.get(k)))).map((e) => e!.value).join('\n')
  assert.ok(!stored.includes('lab-secret'))

  const ev = await collect(agents.run('ann', { harness: 'claude', task: 'who am I?' }))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'tool_call', 'tool_result', 'text', 'end'])
  assert.deepEqual(ev[0], { type: 'start', harness: 'claude', version: '2.1.330', sandbox: 'local' })
  const args = (ev[1] as { text: string }).text
  assert.match(args, /^args: -p --output-format stream-json --verbose --mcp-config \.byoa\/mcp\.json --strict-mcp-config --permission-mode bypassPermissions --no-session-persistence; config: \.claude; autoupdater: 1$/)
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
  assert.match(text, /^args: exec --json --skip-git-repo-check --ephemeral --dangerously-bypass-approvals-and-sandbox -c projects=\{".+\/work"=\{trust_level="trusted"\}\} -; home: \.codex$/)
  assert.deepEqual(ev[4], { type: 'end', ok: true, result: text, usage: { input: 10, output: 3, cached: 5 } })
})

test('Lab rules: with cliLogin, the same user in two apps has two login volumes, so one app\'s AI login is never another\'s', async () => {
  const deps = { sandbox: localSandbox(), store: memoryStore(), pins: { claude: '1', codex: '1' }, encryptionKey: 'unused' }
  const a = await cliLogin({ ...deps, app: 'bookish' }).volumes('u1', 'claude')
  const b = await cliLogin({ ...deps, app: 'margins' }).volumes('u1', 'claude')
  assert.notEqual(a[0].name, b[0].name)
  assert.equal(a[0].path, '.claude')
  assert.ok(!a[0].name.includes('u1'), 'the volume name does not show the user id')
})

test('R1.4: by default the login is encrypted in the app\'s store, each job gets a copy, and what the CLI refreshed is saved', async () => {
  const { existsSync, readdirSync } = await import('node:fs')
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
  assert.equal(a.sandbox.live.size, 0)

  await a.agents.signOut('dee', 'claude')
  assert.equal(await a.agents.loginState('dee', 'claude'), 'signed-out')
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
