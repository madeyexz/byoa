// R2.7: the app's own tools, served by the proxy with no MCP server of the app and no grant. R3.5: a job whose
// sandbox cannot reach the proxy does not start, and a server that does not answer is reported.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ProxyError, createAgents, memoryStore, type AppTools } from '../src/index.ts'
import { localSandbox } from '../src/sandbox/local.ts'
import { fakeMcp, signInAsUser } from './helpers/mcp-server.ts'
import { collect, running, testApp } from './helpers/app.ts'

const closers: (() => Promise<void>)[] = []
after(() => Promise.all(closers.map((c) => c())))

/** A to-do app's tools: the data is the app's own, by user. */
function todoTools() {
  const lists = new Map<string, string[]>()
  const of = (user: string) => lists.get(user) ?? lists.set(user, []).get(user)!
  const tools: AppTools = {
    todos: {
      add_todo: {
        description: 'Add one to-do.',
        input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        run: ({ title }, { user }) => {
          if (typeof title !== 'string' || !title) throw new Error('title: a text is needed')
          return { id: of(user).push(title), title }
        },
      },
      list_todos: { run: async (_args, { user }) => of(user) },
      count: { run: (_args, { user }) => `${of(user).length} to-dos` },
    },
  }
  return { tools, lists }
}

test('R2.7: a job calls the app\'s own tools through the proxy, for its user, with no MCP server and no grant', async () => {
  const { tools, lists } = todoTools()
  const a = await testApp({ tools }); closers.push(a.close)
  const ev = await collect(a.agents.run('ann', { harness: 'fake', mcp: ['todos'], task: 'add\ncall todos.add_todo {"title":"Buy milk"}\ncall todos.add_todo {}\ncall todos.list_todos\ncall todos.count' }))
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'end'])
  assert.deepEqual(ev[3], { type: 'tool_result', id: 'call_1', ok: true, output: '{"id":1,"title":"Buy milk"}' })
  assert.deepEqual(ev[5], { type: 'tool_result', id: 'call_2', ok: false, output: 'title: a text is needed' }, 'what run throws goes to the agent as a failed call')
  assert.deepEqual(ev[7], { type: 'tool_result', id: 'call_3', ok: true, output: '["Buy milk"]' })
  assert.deepEqual(ev[9], { type: 'tool_result', id: 'call_4', ok: true, output: '1 to-dos' }, 'a string goes to the agent as it is')
  assert.deepEqual([...lists], [['ann', ['Buy milk']]])
  // the user is the job's: another user's job gets its own list
  assert.equal((await collect(a.agents.run('bob', { harness: 'fake', mcp: ['todos'], task: 'x\ncall todos.count' }))).at(-1)!.type === 'end' && lists.get('bob')!.length, 0)
  // R2.5: only a job that names the tools gets them
  const none = await collect(a.agents.run('ann', { harness: 'fake', task: 'x\ncall todos.count' }))
  assert.deepEqual(none[3], { type: 'tool_result', id: 'call_1', ok: false, output: 'this job has no MCP server todos' })
  // the app's tools are no grant, and a grant cannot take their name
  assert.deepEqual(await a.agents.listMcp('ann'), [])
  await assert.rejects(a.agents.connectMcp('ann', 'https://mcp.example.com/mcp', { name: 'todos' }), /the app's own tools/)
  assert.equal(running(a.sandbox), 0)
})

test('R2.7: the tools answer a real MCP client (the MCP SDK\'s), and only with a job token that has them', async () => {
  const { tools } = todoTools()
  const a = await testApp({ tools }); closers.push(a.close)
  const t = await a.agents.jobToken('cy', { mcp: ['todos', 'gmail'] })
  assert.deepEqual([t.mcp.map((m) => m.name), t.missing], [['todos'], ['gmail']])
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(t.mcp[0]!.url), { requestInit: { headers: { authorization: `Bearer ${t.token}` } } }))
  assert.deepEqual(client.getServerVersion(), { name: 'todos', version: '1' })
  const list = await client.listTools()
  assert.deepEqual(list.tools.map((x) => x.name), ['add_todo', 'list_todos', 'count'])
  assert.deepEqual(list.tools[0], { name: 'add_todo', description: 'Add one to-do.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } })
  assert.deepEqual(list.tools[1]!.inputSchema, { type: 'object', properties: {} })
  assert.deepEqual((await client.callTool({ name: 'add_todo', arguments: { title: 'Call the bank' } })).content, [{ type: 'text', text: '{"id":1,"title":"Call the bank"}' }])
  assert.equal((await client.callTool({ name: 'add_todo', arguments: {} })).isError, true)
  await assert.rejects(client.callTool({ name: 'toString', arguments: {} }), /todos has no tool "toString"/)
  await client.close()

  const post = (token: string, server = 'todos') => fetch(`${a.proxyUrl}/${server}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  assert.equal((await post((await a.agents.jobToken('cy', {})).token)).status, 403, 'a job that was not given the tools')
  assert.equal((await post('byoa_job_made_up')).status, 401)
  await t.close()
  assert.equal((await post(t.token)).status, 401, 'R3.4: the job token ended')
})

test('R2.7: createAgents refuses tools with a name a harness does not take', () => {
  const { tools } = todoTools()
  const make = (t: AppTools) => () => createAgents({ app: 'testapp', sandbox: localSandbox(), store: memoryStore(), encryptionKey: 'unused', proxyUrl: 'http://127.0.0.1:1/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1:9/callback' }, tools: t })
  assert.throws(make({ Todos: tools.todos! }), /tools: server name "Todos"/)
  assert.throws(make({ todos: { 'add todo': { run: () => 1 } } }), /tool name "add todo"/)
  assert.throws(make({ todos: { add: {} as never } }), /tools\.todos\.add has no run function/)
})

test('R3.5: a job whose sandbox cannot reach the proxy does not start, and ends with an error', async () => {
  const { tools } = todoTools()
  // nothing listens at the proxy's address
  const dead = await testApp({ tools, proxyUrl: 'http://127.0.0.1:1/byoa/mcp' }); closers.push(dead.close)
  const ev = await collect(dead.agents.run('ann', { harness: 'fake', mcp: ['todos'], task: 'x\ncall todos.count' }))
  assert.deepEqual(ev.map((e) => e.type), ['error', 'end'])
  assert.equal((ev[0] as { code: string }).code, 'mcp')
  assert.match((ev[0] as { message: string }).message, /^byoa: the sandbox cannot reach the MCP proxy at http:\/\/127\.0\.0\.1:1\/byoa\/mcp \(.+\); the job did not start/)
  assert.deepEqual(ev[1], { type: 'end', ok: false })
  assert.equal(running(dead.sandbox), 0)
  await assert.rejects(dead.agents.session('ann', { harness: 'fake', mcp: ['todos'] }), ProxyError)
  assert.equal(running(dead.sandbox), 0)
  // a job with no MCP server needs no proxy
  assert.deepEqual((await collect(dead.agents.run('ann', { harness: 'fake', task: 'x' }))).at(-1), { type: 'end', ok: true, result: 'fake answer' })

  // something else answers at the proxy's address, such as the page of a tunnel that ended
  const other = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>not found</h1>'))
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise((r) => { other.closeAllConnections(); other.close(() => r()) }))
  const wrong = await testApp({ tools, proxyUrl: `http://127.0.0.1:${(other.address() as AddressInfo).port}/byoa/mcp` }); closers.push(wrong.close)
  const ev2 = await collect(wrong.agents.run('ann', { harness: 'fake', mcp: ['todos'], task: 'x\ncall todos.count' }))
  assert.deepEqual(ev2.map((e) => e.type), ['error', 'end'])
  assert.match((ev2[0] as { message: string }).message, /an answer with status 200 that is not the proxy's/)
})

test('R3.5: a server of the job that does not answer through the proxy is an error event, and the job runs', async () => {
  const { tools } = todoTools()
  const mcp = await fakeMcp()
  const a = await testApp({ tools }); closers.push(a.close)
  const r = await a.agents.connectMcp('ann', mcp.url, { name: 'notes' })
  if (r.connected) throw new Error('expected a sign-in')
  await a.agents.finishMcp(await signInAsUser(r.signInUrl))
  const s = await a.agents.session('ann', { harness: 'fake', mcp: ['notes', 'todos'] })
  assert.deepEqual(s.failing, [])
  await s.close()
  await mcp.close() // the user's MCP server is down now
  const ev = await collect(a.agents.run('ann', { harness: 'fake', mcp: ['notes', 'todos'], task: 'x\ncall todos.count' }))
  assert.deepEqual(ev.map((e) => e.type), ['error', 'start', 'text', 'tool_call', 'tool_result', 'end'])
  assert.deepEqual(ev[0], { type: 'error', code: 'mcp', message: 'notes does not answer through the proxy (the MCP server notes did not answer); the job may not have its tools' })
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: '0 to-dos' })
})
