// `codex app-server` of the stand-in codex (test/fixtures/bin/codex): JSON-RPC on stdin and stdout, with the requests
// and notifications that codex-cli 0.171.0's app server has for what byoa runs. It keeps a thread's messages in a
// rollout file, as Codex does, unless the thread is ephemeral; `slow` in a message makes its turn take 2 s, and a
// turn/steer during it is a message of that turn. The task drives it as the other stand-ins: `cred`, `together`.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline'

const home = process.env.CODEX_HOME
const argv = process.argv.slice(2)
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const note = (method, params) => send({ method, params })
const rollout = (id) => `${home}/sessions/2026/11/25/rollout-2026-11-25T00-00-00-${id}.jsonl`
const lines = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let thread, params, turn, turns = 0, items = 0
/** The messages of the running turn, and the ones steered into it. */
let pending = []

async function runTurn(id) {
  note('turn/started', { threadId: thread, turn: { id, status: 'inProgress', items: [] } })
  const say = (text) => note('item/completed', { threadId: thread, turnId: id, item: { type: 'agentMessage', id: `msg_${++items}`, text } })
  const taken = []
  const take = () => {
    for (const text of pending.splice(0)) {
      taken.push(text)
      note('item/started', { threadId: thread, turnId: id, item: { type: 'userMessage', id: `u_${++items}`, content: [{ type: 'text', text }] } })
      if (!params.ephemeral) { mkdirSync(dirname(rollout(thread)), { recursive: true }); appendFileSync(rollout(thread), text.split('\n')[0] + '\n') }
    }
  }
  take()
  if (taken.some((t) => t.includes('slow'))) { await sleep(2000); take() }
  const task = taken.at(-1)
  const usage = (input, cached, output) => note('thread/tokenUsage/updated', { threadId: thread, turnId: id, tokenUsage: { last: { inputTokens: input, cachedInputTokens: cached, outputTokens: output }, total: {} } })
  if (!params.ephemeral) say(`remembers ${lines(rollout(thread)).length - taken.length}: ${taken.join(' | ')}`)
  if (task.includes('cred')) {
    const t = /"access_token":"([^"]*)"/.exec(readFileSync(`${home}/auth.json`, 'utf8'))?.[1]
    if (t) writeFileSync(`${home}/auth.json`, JSON.stringify({ tokens: { access_token: `${t}x` } }))
    say(`cred: ${t ?? 'none'}`)
  } else if (task.includes('together')) {
    // how many jobs run now: each one leaves a file in FAKE_CODEX_DIR while it runs
    const dir = process.env.FAKE_CODEX_DIR
    mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/${process.pid}`, ''); await sleep(1000)
    const n = readdirSync(dir).length; rmSync(`${dir}/${process.pid}`)
    say(`together: ${n}`)
  } else {
    note('item/started', { threadId: thread, turnId: id, item: { type: 'mcpToolCall', id: 'item_1', server: 'notes', tool: 'whoami', arguments: {}, status: 'inProgress' } })
    note('item/completed', { threadId: thread, turnId: id, item: { type: 'mcpToolCall', id: 'item_1', server: 'notes', tool: 'whoami', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'you are alice' }] } } })
    say(`args: ${argv.join(' ')}; thread: ${JSON.stringify(params)}; home: ${basename(home)}`)
    usage(10, 5, 3)
  }
  turn = undefined
  note('turn/completed', { threadId: thread, turn: { id, status: 'completed', items: [] } })
}

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  const ok = (result) => send({ id: m.id, result })
  const no = (message) => send({ id: m.id, error: { code: -32600, message } })
  switch (m.method) {
    case 'initialize': ok({ userAgent: 'codex_app_server/0.171.0' }); break
    case 'model/list':
      // in two pages, and a hidden model
      if (m.params?.cursor) ok({ data: [{ model: 'gpt-secret', displayName: 'Hidden', description: '', hidden: true, isDefault: false, supportedReasoningEfforts: [] }], nextCursor: null })
      else ok({ data: [{ model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', description: 'Fast', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'ultra', description: '' }] }], nextCursor: 'p2' })
      break
    case 'thread/start':
      params = m.params; thread = 'th1'
      ok({ thread: { id: thread } }); note('thread/started', { thread: { id: thread } })
      break
    case 'thread/resume':
      if (!lines(rollout(m.params.threadId)).length) { no(`no rollout found for thread id ${m.params.threadId}`); break }
      params = m.params; thread = m.params.threadId
      ok({ thread: { id: thread } })
      break
    case 'turn/start': {
      const id = `turn_${++turns}`
      turn = id; pending.push(m.params.input[0].text)
      ok({ turn: { id, status: 'inProgress' } })
      runTurn(id)
      break
    }
    case 'turn/steer':
      if (m.params.expectedTurnId !== turn) { no('no active turn to steer'); break }
      pending.push(m.params.input[0].text); ok({ turnId: turn })
      break
  }
}
