// The fake harness (R7.2), end to end: a real job lifecycle in the local sandbox, MCP calls through the real proxy to
// a local MCP server with OAuth. These are the cheap versions of V5 to V8; the real checks run on a real provider.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fakeMcp, signInAsUser, type FakeMcp } from './helpers/mcp-server.ts'
import { collect, testApp } from './helpers/app.ts'

const closers: (() => Promise<void>)[] = []
after(() => Promise.all(closers.map((c) => c())))

async function setup(opts: Parameters<typeof fakeMcp>[0] = {}) {
  const mcp: FakeMcp = await fakeMcp(opts)
  const app = await testApp()
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
  // like V8: the sandbox is gone after the job
  assert.equal(sandbox.created, 1)
  assert.equal(sandbox.live.size, 0)
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
  const { agents, mcp } = await setup({ tokenDelayMs: 200 })
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

test('fake harness: a consumer that stops reading early still ends the job and destroys the sandbox', async () => {
  const { agents, sandbox } = await setup()
  for await (const e of agents.run('alice', { harness: 'fake', task: TASK, mcp: ['notes'] })) if (e.type === 'text') break
  assert.equal(sandbox.live.size, 0)
})
