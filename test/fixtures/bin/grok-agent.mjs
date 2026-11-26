// `grok agent stdio` of the stand-in grok (test/fixtures/bin/grok): ACP on stdin and stdout, with the requests and
// notifications that grok 1.0.92 has for what byoa runs. A session keeps its messages in
// `$GROK_HOME/sessions/<the cwd, URL-encoded>/<id>/updates.jsonl`, as Grok does; `slow` in a message makes its turn take
// 2 s, and an `_x.ai/interject` during it is a message of that turn (one when no turn runs gets a turn of its own). Each
// turn ends with Grok's `turn_completed`. The task drives it as the other stand-ins: `who am I` (an MCP call through
// use_tool), `cred`, `together`, `write` (denied by a `deny = [... "Write" ...]` rule in `.grok/config.toml`, else
// approved with --always-approve, else asked for, and a refusal ends the turn), `expire`, `limit` and `busy` (a
// turn that fails as grok 1.0.92's do), `late` (the prompt's answer comes late); any other message gets one answer that
// says what the session remembers.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const home = process.env.GROK_HOME
const argv = process.argv.slice(2)
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const updates = (cwd, id) => `${home}/sessions/${encodeURIComponent(cwd)}/${id}/updates.jsonl`
const lines = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MODELS = { currentModelId: 'grok-4.7', availableModels: [
  { modelId: 'grok-4.7', name: 'Grok 4.7', description: 'Frontier', _meta: { supportsReasoningEffort: true, reasoningEfforts: [{ id: 'high', value: 'high' }, { id: 'low', value: 'low' }] } },
  { modelId: 'grok-4.5', name: 'Grok 4.5', description: null, _meta: { supportsReasoningEffort: false } },
] }

let session, cwd, how, asks = 0, running = false, turns = 0
/** The messages of the running turn, and the ones interjected into it. */
let pending = []
const asked = new Map()
/** A request to byoa (session/request_permission), and its answer. */
const ask = (method, params) => new Promise((resolve) => { const id = `g${++asks}`; asked.set(id, resolve); send({ id, method, params }) })

/** One turn: for a prompt (m, answered at the end) or for an interjection that came when no turn ran. */
async function turn(m) {
  running = true
  const id = m ? `p${++turns}` : `interject-fallback-${++turns}`
  const update = (u) => send({ method: 'session/update', params: { sessionId: session, update: u } })
  const say = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  const file = updates(cwd, session)
  const before = lines(file)
  const taken = []
  const take = () => {
    for (const text of pending.splice(0)) { taken.push(text); mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, text.split('\n')[0] + '\n') }
  }
  if (m) pending.push(m.params.prompt.map((c) => c.text).join(''))
  take()
  if (taken.some((t) => t.includes('slow'))) { await sleep(2000); take() }
  const task = taken.at(-1)
  let stop = 'end_turn', result = null, kind = null, usage = { totalTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 }
  if (task.includes('who am I')) {
    say(`args: ${argv.join(' ')}; session: ${how}; home: ${home.split('/').at(-1)}; autoupdater off: ${process.env.GROK_DISABLE_AUTOUPDATER}; memory: ${process.env.GROK_MEMORY}`)
    // an MCP tool, called through Grok's use_tool, and its output wrapped in Grok's own JSON
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'use_tool', kind: 'other', status: 'pending', rawInput: { tool_name: 'notes__whoami', tool_input: {} } })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: JSON.stringify({ type: 'MCP', tool_name: 'whoami', server_name: 'notes', output: { OkayOutput: 'you are alice' } }) })
    say('You are alice.')
    usage = { ...usage, totalTokens: 13, inputTokens: 10, outputTokens: 3, cachedReadTokens: 5 }
  } else if (task.includes('cred')) {
    // like a token refresh: report the login it found, then replace it with a newer one
    const doc = JSON.parse(readFileSync(`${home}/auth.json`, 'utf8'))
    const [k, l] = Object.entries(doc)[0]
    say(`cred: ${l.key}`)
    writeFileSync(`${home}/auth.json`, JSON.stringify({ [k]: { ...l, key: `${l.key}x`, expires_at: new Date(Date.now() + 7 * 3600_000).toISOString() } }))
  } else if (task.includes('together')) {
    // how many jobs run now: each one leaves a file in FAKE_GROK_DIR while it runs
    const dir = process.env.FAKE_GROK_DIR
    mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/${process.pid}`, ''); await sleep(1000)
    const n = readdirSync(dir).length; rmSync(`${dir}/${process.pid}`)
    say(`together: ${n}`)
  } else if (task.includes('write')) {
    const toolCall = { toolCallId: 'w1', title: 'write_file', kind: 'edit', status: 'pending', rawInput: { path: 'x.txt' }, _meta: { toolName: 'write_file' } }
    update({ sessionUpdate: 'tool_call', ...toolCall })
    const config = existsSync(`${cwd}/.grok/config.toml`) ? readFileSync(`${cwd}/.grok/config.toml`, 'utf8') : ''
    if (/^deny = \[.*"Write"/m.test(config)) {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool `write` was not executed: Denied by permission policy: deny rule on edit' } }] })
      say('I may not write.')
    } else if (argv.includes('--always-approve') || (await ask('session/request_permission', {
      sessionId: session, toolCall, options: [{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }, { optionId: 'reject-once', name: 'No', kind: 'reject_once' }],
    })).outcome?.optionId === 'allow-once') {
      // as grok 1.0.92: the tool's text in content, and Grok's own JSON in rawOutput
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'wrote x.txt' } }], rawOutput: { type: 'Write', path: 'x.txt' } })
      say('Wrote it.')
    } else {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'User rejected the execution for tool `write`' } }] })
      stop = 'cancelled'
    }
  } else if (task.includes('expire')) {
    stop = 'error'; result = 'Unauthorized (401) from https://api.x.ai/v1/responses: the token has expired'
  } else if (task.includes('limit')) {
    // a used-up plan, in grok 1.0.92's words; its class for a 429 is rate_limit (also for 503 and 529)
    stop = 'error'; kind = 'rate_limit'; result = 'You’ve hit the rate limit for your plan. Upgrade your account or try again later.'
  } else if (task.includes('busy')) {
    stop = 'error'; kind = 'rate_limit'; result = 'Grok is temporarily overloaded. Please try again in a moment. (HTTP 503)'
  } else {
    say(`remembers ${before.length}: ${taken.join(' | ')}; session: ${how}; config: ${process.env.GROK_CONFIG ?? ''}`)
  }
  running = false
  const agent_result = stop === 'error' ? result : null
  send({ method: '_x.ai/session_notification', params: { sessionId: session, update: { sessionUpdate: 'turn_completed', prompt_id: id, stop_reason: stop, usage, agent_result, ...(kind ? { error_kind: kind } : {}) } } })
  // `late`: the answer to the prompt comes 1 s after its turn_completed, as it may when the two lines reach the driver
  // apart
  if (m && task.includes('late')) await sleep(1000)
  if (m) send({ id: m.id, ...(stop === 'error' ? { error: { code: -32603, message: 'Internal error', data: { message: agent_result } } } : { result: { stopReason: stop } }) })
  // an interjection that came as the turn ended gets a turn of its own
  if (pending.length) turn()
}

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (m.method === undefined) { asked.get(m.id)?.(m.result ?? {}); asked.delete(m.id); continue }
  const ok = (result) => send({ id: m.id, result })
  const no = (message) => send({ id: m.id, error: { code: -32603, message } })
  const signedIn = existsSync(`${home}/auth.json`)
  switch (m.method) {
    // the initialize answer of grok 1.0.92 holds the models this login may use
    case 'initialize': ok({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, _meta: { modelState: MODELS } }); break
    case 'session/new':
      if (!signedIn) { no('Authentication required'); break }
      cwd = m.params.cwd; session = `gs-${process.pid}`; how = 'new'
      ok({ sessionId: session })
      break
    case 'session/resume':
      if (!signedIn) { no('Authentication required'); break }
      if (!lines(updates(m.params.cwd, m.params.sessionId)).length) { no(`Session not found: ${m.params.sessionId}`); break }
      cwd = m.params.cwd; session = m.params.sessionId; how = 'resumed'
      ok({})
      break
    case 'session/prompt': turn(m); break
    case '_x.ai/interject':
      if (m.params.sessionId !== session) { no('session not found'); break }
      pending.push(m.params.text); ok({ result: { status: 'queued' } })
      send({ method: '_x.ai/session/interjection', params: { sessionId: session, text: m.params.text } })
      if (!running) turn()
      break
    default: send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
  }
}
