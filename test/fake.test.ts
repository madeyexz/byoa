// The fake harness (R7.2), end to end: a real job lifecycle in the local sandbox, MCP calls through the real proxy to
// a local MCP server with OAuth. These are the cheap versions of V5 to V8; the real checks run on a real provider.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fakeMcp, signInAsUser, type FakeMcp } from './helpers/mcp-server.ts'
import { collect, running, testApp } from './helpers/app.ts'

const closers: (() => Promise<void>)[] = []
after(() => Promise.all(closers.map((c) => c())))

async function setup(opts: Parameters<typeof fakeMcp>[0] = {}, app_: Parameters<typeof testApp>[0] = {}) {
  const mcp: FakeMcp = await fakeMcp(opts)
  const app = await testApp(app_)
  closers.push(mcp.close, app.close)
  const r = await app.agents.connectMcp('alice', mcp.url, { name: 'notes' })
  if (r.connected) throw new Error('expected a sign-in')
  await app.agents.finishMcp(await signInAsUser(r.signInUrl))
  return { mcp, ...app }
}

const TASK = 'look up who I am\ncall notes.whoami {"detail":true}\n'

test('fake harness: a job calls an MCP tool through the proxy and streams events in byoa\'s schema', async () => {
  const { agents, sandbox } = await setup()
  const ev = await collect(agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] }))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'tool_call', 'tool_result', 'end'])
  assert.deepEqual(ev[0], { type: 'start', harness: 'fake', version: 'fake', sandbox: 'local' })
  assert.deepEqual(ev[2], { type: 'tool_call', id: 'call_1', name: 'whoami', server: 'notes', input: { detail: true } })
  assert.deepEqual(ev[3], { type: 'tool_result', id: 'call_1', ok: true, output: 'you are alice ({"detail":true})' })
  assert.deepEqual(ev[4], { type: 'end', ok: true, result: 'you are alice ({"detail":true})' })
  // like V8: by default the user's sandbox is paused after the job, not gone
  assert.equal(sandbox.created, 1)
  assert.equal(sandbox.live.size, 1)
  assert.equal(running(sandbox), 0)
})

test('R5.4: the user\'s sandbox is paused after each job and resumed for the next, with a new job folder', async () => {
  const { agents, sandbox, store } = await setup()
  const s1 = await agents.session('alice', { harness: 'fake', mcp: ['notes'], setup: { skills: [{ name: 'old', files: { 'SKILL.md': 'old' } }] } })
  await s1.sandbox.writeFile(`${s1.sandbox.home}/kept.txt`, 'kept between jobs')
  await s1.close()
  assert.deepEqual([...sandbox.paused], [s1.sandbox.id])
  const s2 = await agents.session('alice', { harness: 'fake' })
  assert.equal(s2.sandbox.id, s1.sandbox.id, 'the same sandbox')
  assert.equal((await s2.sandbox.run('cat ~/kept.txt')).stdout, 'kept between jobs')
  assert.equal((await s2.sandbox.run('ls -A work work/.claude 2>&1')).stdout.includes('old'), false, 'no setup of the earlier job')
  assert.equal((await s2.sandbox.run('test -e work/.byoa/mcp.json')).exitCode, 0)
  await s2.close()
  // another user, and another harness of the same user, get sandboxes of their own
  const ev = await collect(agents.run('bob', { harness: 'fake', task: 'hi' }))
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'fake answer' })
  assert.equal(sandbox.created, 2)

  // deleted or expired at the provider: the next job gets a new sandbox, with no new sign-in
  await sandbox.destroy(s1.sandbox.id)
  assert.deepEqual((await collect(agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] }))).at(-1), { type: 'end', ok: true, result: 'you are alice ({"detail":true})' })
  assert.equal(sandbox.created, 3)

  // deleteSandbox (sign-out, delete account) removes it at the provider and in the store
  await agents.deleteSandbox('alice')
  assert.equal(sandbox.live.size, 1, 'only bob\'s is left')
  assert.ok(!store.keys().some((k) => k.startsWith('usersandbox/alice')))
})

test('R5.4: with sandboxKey, a user has many kept sandboxes: one for each key, each with its own lease', async () => {
  const { agents, sandbox, store } = await setup()
  const a1 = await agents.session('alice', { harness: 'fake', sandboxKey: 'project-a' })
  // another key runs at the same time, in a sandbox of its own; so does the user's sandbox with no key
  const b1 = await agents.session('alice', { harness: 'fake', sandboxKey: 'project-b' })
  const d1 = await agents.session('alice', { harness: 'fake' })
  assert.equal(new Set([a1.sandbox.id, b1.sandbox.id, d1.sandbox.id]).size, 3)
  await a1.sandbox.writeFile(`${a1.sandbox.home}/notes.txt`, 'a')
  for (const s of [a1, b1, d1]) await s.close()
  assert.equal(running(sandbox), 0)
  assert.equal(sandbox.paused.size, 3)
  // the same key resumes the same sandbox, also from run
  const a2 = await agents.session('alice', { harness: 'fake', sandboxKey: 'project-a' })
  assert.equal(a2.sandbox.id, a1.sandbox.id)
  assert.equal((await a2.sandbox.run('cat ~/notes.txt')).stdout, 'a')
  await a2.close()
  assert.deepEqual((await collect(agents.run('alice', { harness: 'fake', task: 'hi', sandboxKey: 'project-b' }))).at(-1), { type: 'end', ok: true, result: 'fake answer' })
  assert.equal(sandbox.created, 3)
  // another user's key of the same name is another sandbox
  await collect(agents.run('bob', { harness: 'fake', task: 'hi', sandboxKey: 'project-a' }))
  assert.equal(sandbox.created, 4)

  // deleteSandbox with a key deletes only that one; with no key, all of the user's
  await agents.deleteSandbox('alice', { sandboxKey: 'project-a' })
  assert.ok(!sandbox.live.has(a1.sandbox.id) && sandbox.live.has(b1.sandbox.id) && sandbox.live.has(d1.sandbox.id))
  await agents.deleteSandbox('alice')
  assert.equal(sandbox.live.size, 1, 'only bob\'s is left')
  assert.ok(!store.keys().some((k) => k.startsWith('usersandbox/alice')))
  assert.deepEqual(JSON.parse((await store.get('usersandboxes/alice/local'))?.value ?? '[]'), [])

  // a key needs a kept sandbox
  const perJob = (await testApp({ sandboxPer: 'job' })); closers.push(perJob.close)
  await assert.rejects(perJob.agents.session('alice', { harness: 'fake', sandboxKey: 'x' }), /sandboxKey needs sandboxPer: 'user'/)
  assert.equal(perJob.sandbox.created, 0)
})

test('R5.4: one job of a user and harness at a time: a second job waits for the first, in the same sandbox', async () => {
  const { agents, sandbox } = await setup()
  const s1 = await agents.session('alice', { harness: 'fake' })
  let second: string | undefined
  const p = agents.session('alice', { harness: 'fake' }).then((s) => { second = s.sandbox.id; return s })
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(second, undefined, 'the second job waits')
  await s1.close()
  const s2 = await p
  assert.equal(second, s1.sandbox.id)
  await s2.close()
  assert.equal(sandbox.created, 1)
})

test('R5.4: with waitMs, a job that cannot get the user\'s sandbox in time fails, and the first job is not touched', async () => {
  const { agents } = await setup({}, { waitMs: 300 })
  const s1 = await agents.session('alice', { harness: 'fake' })
  const ev = await collect(agents.run('alice', { harness: 'fake', task: 'hi' }))
  assert.deepEqual(ev, [{ type: 'error', code: 'sandbox', message: 'byoa: another job of this user still holds the fake sandbox; try again when it ends' }, { type: 'end', ok: false }])
  assert.equal((await s1.sandbox.run('echo ok')).stdout, 'ok\n')
  await s1.close()
})

test('R5.4: sandboxPer: \'job\' gives each job a new sandbox and destroys it after the job (like V8)', async () => {
  const { agents, sandbox, store } = await setup({}, { sandboxPer: 'job' })
  for (let i = 0; i < 2; i++) {
    const ev = await collect(agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] }))
    assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'you are alice ({"detail":true})' })
    assert.equal(sandbox.live.size, 0)
  }
  assert.equal(sandbox.created, 2)
  assert.ok(!store.keys().some((k) => k.startsWith('usersandbox/')))
})

test('fake harness: no real token is in the sandbox\'s files or environment (like V5), and the job token fails after the job (like V6)', async () => {
  const { agents, sandbox, mcp, proxyUrl } = await setup()
  const ev = await collect(agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] }))
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'you are alice ({"detail":true})' })
  assert.ok(mcp.issued.length >= 2)
  const everything = [...sandbox.files, ...sandbox.envs.map((e) => JSON.stringify(e))].join('\n')
  for (const t of mcp.issued) assert.ok(!everything.includes(t), 'a real token reached the sandbox')
  assert.ok(sandbox.files.some((f) => f.includes(`${proxyUrl}/notes`)), 'the sandbox\'s MCP config points to the proxy')
  const jobToken = sandbox.envs.map((e) => e.BYOA_JOB_TOKEN).find(Boolean)!
  assert.match(jobToken, /^byoa_job_/)
  const r = await fetch(`${proxyUrl}/notes`, { method: 'POST', headers: { authorization: `Bearer ${jobToken}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  assert.equal(r.status, 401)
})

test('fake harness: two jobs at once with an expired access token cause one refresh, and both succeed (like V7)', async () => {
  // a sandbox for each job, so the two jobs of one user run at the same time
  const { agents, mcp } = await setup({ tokenDelayMs: 200 }, { sandboxPer: 'job' })
  mcp.expireAccess()
  const [a, b] = await Promise.all([1, 2].map(() => collect(agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] }))))
  for (const ev of [a, b]) assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'you are alice ({"detail":true})' })
  assert.equal(mcp.refreshes, 1)
  assert.equal(mcp.refused, 0)
})

test('fake harness: a job gets only the MCP servers the app names (R2.5)', async () => {
  const { agents } = await setup()
  const none = await collect(agents.run('alice', { harness: 'fake', task: TASK }))
  const res = none.find((e) => e.type === 'tool_result')
  assert.deepEqual(res, { type: 'tool_result', id: 'call_1', ok: false, output: 'this job has no MCP server notes' })
  const missing = await collect(agents.run('alice', { harness: 'fake', task: 'hi', mcp: ['gmail'] }))
  assert.deepEqual(missing[0], { type: 'error', code: 'mcp', message: 'gmail is not connected for this user; the job runs without it' })
  assert.deepEqual(missing.at(-1), { type: 'end', ok: true, result: 'fake answer' })
})

test('fake harness: a consumer that stops reading early still ends the job and pauses the sandbox', async () => {
  const { agents, sandbox } = await setup()
  for await (const e of agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] })) if (e.type === 'text') break
  assert.equal(running(sandbox), 0)
  // and the user's next job does not wait for it
  assert.deepEqual((await collect(agents.run('alice', { harness: 'fake', task: 'hi' }))).at(-1), { type: 'end', ok: true, result: 'fake answer' })
})

test('session: an app runs its own program in the job\'s sandbox, its MCP calls go through the proxy, and close ends both', async () => {
  const { agents, sandbox, mcp } = await setup()
  const s = await agents.session('alice', { harness: 'fake', mcp: ['notes', 'gmail'] })
  assert.deepEqual(s.mcp.map((m) => m.name), ['notes'])
  assert.deepEqual(s.missing, ['gmail'])
  // the app's own program: here a curl to the proxy with the job token, as an app's core that starts the CLI would
  const call = (env: Record<string, string>) => s.sandbox.run(`curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $BYOA_JOB_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' ${s.mcp[0]!.url}`, { env })
  assert.equal((await call(s.env)).stdout, '200')
  assert.equal((await call({ BYOA_JOB_TOKEN: 'byoa_job_not-a-token' })).stdout, '401')
  const everything = [...sandbox.envs.map((e) => JSON.stringify(e))].join('\n')
  for (const t of mcp.issued) assert.ok(!everything.includes(t), 'a real token reached the sandbox')
  await s.close()
  assert.equal(running(sandbox), 0)
  const r = await fetch(s.mcp[0]!.url, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  assert.equal(r.status, 401, 'the job token ends with the session')
})

test('session: a harness with no login throws LoginError, leaves no running sandbox, and the login state says signed-out', async () => {
  const { agents, sandbox } = await setup()
  await assert.rejects(agents.session('alice', { harness: 'claude' }), (e: Error) => e.name === 'Error' && (e as { code?: string }).code === 'signed-out')
  assert.equal(running(sandbox), 0)
  assert.equal(await agents.loginState('alice', 'claude'), 'signed-out')
})

test('jobToken: a token with no sandbox reaches only its user\'s named servers, and stops after close and after its time', async () => {
  const { agents, mcp, store } = await setup()
  const init = (url: string, token: string) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) }).then(async (r) => { await r.body?.cancel(); return r.status })
  const t = await agents.jobToken('alice', { mcp: ['notes', 'gmail'] })
  assert.deepEqual(t.mcp.map((m) => m.name), ['notes'])
  assert.deepEqual(t.missing, ['gmail'])
  assert.match(t.token, /^byoa_job_/)
  assert.ok(!mcp.issued.includes(t.token))
  const url = t.mcp[0]!.url
  assert.equal(await init(url, t.token), 200)
  const unnamed = await agents.jobToken('alice', {})
  assert.equal(await init(url, unnamed.token), 403, 'a server the token was not given')
  const bob = await agents.jobToken('bob', { mcp: ['notes'] })
  assert.deepEqual(bob.missing, ['notes'])
  assert.equal(await init(url, bob.token), 403, 'another user\'s grant')
  await t.close()
  assert.equal(await init(url, t.token), 401, 'refused after close (R3.4)')
  const short = await agents.jobToken('alice', { mcp: ['notes'], ttlMs: 300 })
  assert.equal(await init(url, short.token), 200)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(await init(url, short.token), 401, 'refused after its time')
  assert.equal(await store.get(`jobid/${short.job}`), null, 'and removed from the store')
})
