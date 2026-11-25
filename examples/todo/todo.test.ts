// The to-do app end to end with byoa's fake harness: no AI plan and no sandbox provider. A job's MCP calls go from
// the (local) sandbox through byoa's proxy to the app's own to-do server.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { toNodeListener } from '@madeyexz/byoa/node'
import { localSandbox } from '@madeyexz/byoa/sandbox/local'
import { todoApp } from './app.ts'
import { sqliteStore } from './todos.ts'

const servers: ReturnType<typeof createServer>[] = []
after(() => { for (const s of servers) { s.closeAllConnections(); s.close() } })

async function start() {
  const db = new DatabaseSync(':memory:')
  const sandbox = localSandbox({ root: mkdtempSync(join(tmpdir(), 'todo-test-')) })
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  const server = createServer(toNodeListener((r) => handler(r)))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  handler = todoApp({ db, sandbox, publicUrl: url, encryptionKey: randomBytes(32).toString('base64'), fake: true })
  const send = (user: string, method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return {
    db, sandbox, url,
    state: async (user: string) => (await send(user, 'GET', '/api/state')).json(),
    connect: async (user: string) => (await send(user, 'POST', '/api/connect', {})).json(),
    /** The job's events. */
    ask: async (user: string, harness: string, task: string) => {
      const r = await send(user, 'POST', '/api/ask', { harness, task })
      assert.equal(r.status, 200, await r.clone().text())
      return (await r.text()).trim().split('\n').map((l) => JSON.parse(l))
    },
    send,
  }
}

test('a user connects their to-dos once; then each job changes them through byoa in the user\'s sandbox', async () => {
  const app = await start()
  assert.deepEqual((await app.state('alice')).mcp, [])
  assert.deepEqual(await app.connect('alice'), { name: 'todos', connected: true })

  const ev = await app.ask('alice', 'fake', [
    'add two to-dos and finish the first',
    'call todos.add_todo {"title":"Buy milk"}',
    'call todos.add_todo {"title":"Call mom"}',
    'call todos.complete_todo {"id":1}',
    'call todos.list_todos {}',
  ].join('\n'))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', ...Array(4).fill(['tool_call', 'tool_result']).flat(), 'end'])
  assert.deepEqual(ev[2], { type: 'tool_call', id: 'call_1', name: 'add_todo', server: 'todos', input: { title: 'Buy milk' } })
  const list = [{ id: 1, title: 'Buy milk', done: true }, { id: 2, title: 'Call mom', done: false }]
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: JSON.stringify(list) })
  assert.deepEqual((await app.state('alice')).todos, list)
  assert.deepEqual([...app.sandbox.paused], [...app.sandbox.live], 'the user\'s one sandbox is paused after the job')
  assert.equal(app.sandbox.live.size, 1)

  // the next job resumes it, with no new connection
  const again = await app.ask('alice', 'fake', 'call todos.delete_todo {"id":2}')
  assert.deepEqual(again.at(-1), { type: 'end', ok: true, result: '"deleted 2"' })
  assert.deepEqual((await app.state('alice')).todos, [list[0]])
})

test('each user reaches only their own to-dos, and only after they connect them', async () => {
  const app = await start()
  await app.connect('alice')
  await app.ask('alice', 'fake', 'call todos.add_todo {"title":"Alice\'s to-do"}')

  const before = await app.ask('bob', 'fake', 'call todos.list_todos {}')
  assert.deepEqual(before.find((e) => e.type === 'tool_result'), { type: 'tool_result', id: 'call_1', ok: false, output: 'this job has no MCP server todos' })

  await app.connect('bob')
  const ev = await app.ask('bob', 'fake', 'call todos.list_todos {}\ncall todos.complete_todo {"id":1}')
  assert.deepEqual(ev.filter((e) => e.type === 'tool_result').map((e) => [e.ok, e.output]), [[true, '[]'], [false, '"no to-do 1"']])
  assert.deepEqual((await app.state('alice')).todos, [{ id: 1, title: "Alice's to-do", done: false }])

  // the to-do server itself takes only a user's own token, which stays in the app's database
  const init = (token: string) => fetch(`${app.url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  }).then((r) => r.status)
  const token = (app.db.prepare("select token from tokens where user = 'alice'").get() as { token: string }).token
  assert.equal(await init(token), 200)
  assert.equal(await init('todo_not-a-token'), 401)
})

test('Claude Code with no sign-in: the job ends with signed-out, and the state says so', async () => {
  const app = await start()
  const ev = await app.ask('alice', 'claude', 'add buy milk')
  assert.deepEqual(ev.map((e) => [e.type, e.code]), [['error', 'signed-out'], ['end', undefined]])
  assert.equal(ev.at(-1).ok, false)
  assert.deepEqual((await app.state('alice')).login, { claude: 'signed-out', codex: 'signed-out', 'opencode-go': 'signed-out' })
  assert.deepEqual([...app.sandbox.paused], [...app.sandbox.live], 'no sandbox runs')
  const bad = await app.send('alice', 'POST', '/api/ask', { harness: 'gpt', task: 'x' })
  assert.equal(bad.status, 400)
})

test('sqliteStore: compare-and-set writes only over the version it read, also after a delete', async () => {
  const s = sqliteStore(new DatabaseSync(':memory:'))
  assert.equal(await s.get('k'), null)
  assert.equal(await s.cas('k', null, 'a'), true)
  assert.equal(await s.cas('k', null, 'b'), false, 'there is an entry now')
  const v1 = (await s.get('k'))!.version
  await s.put('k', 'b')
  assert.equal(await s.cas('k', v1, 'c'), false, 'put changed the version')
  const v2 = (await s.get('k'))!.version
  assert.equal(await s.cas('k', v2, 'c'), true)
  const v3 = (await s.get('k'))!.version
  await s.delete('k')
  await s.put('k', 'd')
  assert.equal(await s.cas('k', v3, 'e'), false, 'a version from before the delete')
  assert.equal((await s.get('k'))!.value, 'd')
})
