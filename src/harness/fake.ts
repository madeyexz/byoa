// The fake harness (R7.2): it runs in the sandbox where Claude Code would, reads the same files byoa writes for Claude
// Code (.byoa/mcp.json with the proxy's URLs and the job token from the environment), and calls MCP tools through the
// proxy as a harness would. It runs no model, so an app tests byoa end to end with no AI plan. With the local sandbox
// (byoa/sandbox/local) it needs no sandbox provider either.
// The task drives it: each line `call <server>.<tool> <json arguments>` calls that tool. Its output is byoa's own
// event schema, one JSON object per line. In a conversation (R5.9) it keeps each task in a session file of its own
// home folder, as a real harness keeps its transcript, and says how many earlier messages it remembers.
import { MCP_PROTOCOL } from '../config.ts'
import { CLAUDE_MCP_CONFIG, claude } from './claude.ts'
import type { AgentEvent, EventReader } from './events.ts'
import type { Harness } from './types.ts'

export const FAKE_JS = String.raw`
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n')
const task = readFileSync(0, 'utf8')
const argv = process.argv.slice(2)
const flag = (f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1] }
const session = flag('--resume') ?? flag('--session-id')
let cfg = { mcpServers: {} }
try { cfg = JSON.parse(readFileSync('${CLAUDE_MCP_CONFIG}', 'utf8')) } catch {}
const expand = (s) => String(s).replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => process.env[k] ?? '')
const sessions = {}, ready = {}
let n = 0
async function rpc(server, method, params, notify) {
  const s = cfg.mcpServers[server]
  if (!s) throw new Error('this job has no MCP server ' + server)
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const [k, v] of Object.entries(s.headers || {})) headers[k] = expand(v)
  if (sessions[server]) headers['mcp-session-id'] = sessions[server]
  const id = notify ? undefined : ++n
  const r = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params ? { params } : {}) }) })
  const sid = r.headers.get('mcp-session-id')
  if (sid) sessions[server] = sid
  const text = await r.text()
  if (!r.ok) throw new Error(server + ' answered ' + r.status + ': ' + text.slice(0, 300))
  if (notify) return
  const sse = (r.headers.get('content-type') || '').includes('text/event-stream')
  const msgs = sse ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))) : [JSON.parse(text)]
  const m = msgs.find((x) => x.id === id)
  if (!m) throw new Error(server + ' gave no answer to ' + method)
  if (m.error) throw new Error(m.error.message)
  return m.result
}
const connect = (server) => ready[server] ??= (async () => {
  await rpc(server, 'initialize', { protocolVersion: '${MCP_PROTOCOL}', capabilities: {}, clientInfo: { name: 'byoa-fake', version: '1' } })
  await rpc(server, 'notifications/initialized', undefined, true)
})()
let ok = true, i = 0, last = ''
out({ type: 'text', text: 'fake harness: ' + task.trim().split('\n')[0] })
if (session) {
  const dir = process.env.BYOA_FAKE_HOME + '/sessions', file = dir + '/' + session + '.jsonl'
  let earlier = []
  if (argv.includes('--resume')) {
    try { earlier = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { out({ type: 'error', message: 'no session ' + session, code: 'harness' }); out({ type: 'end', ok: false }); process.exit(1) }
  }
  out({ type: 'session', id: session })
  out({ type: 'text', text: 'fake harness remembers ' + earlier.length + ' earlier messages' + (earlier.length ? ': ' + earlier.map((t) => t.trim().split('\n')[0]).join(' | ') : '') })
  mkdirSync(dir, { recursive: true })
  appendFileSync(file, JSON.stringify(task) + '\n')
}
for (const line of task.split('\n')) {
  const m = /^call ([a-z0-9-]+)\.([A-Za-z0-9_.-]+)(?: (.*))?$/.exec(line.trim())
  if (!m) continue
  const id = 'call_' + ++i
  let args = {}
  try { args = m[3] ? JSON.parse(m[3]) : {} } catch { out({ type: 'error', message: 'not JSON: ' + m[3], code: 'harness' }); ok = false; continue }
  out({ type: 'tool_call', id, name: m[2], server: m[1], input: args })
  try {
    await connect(m[1])
    const r = await rpc(m[1], 'tools/call', { name: m[2], arguments: args })
    last = (r.content || []).map((c) => c.text || '').join('')
    if (r.isError) ok = false
    out({ type: 'tool_result', id, ok: !r.isError, output: last })
  } catch (e) {
    ok = false
    out({ type: 'tool_result', id, ok: false, output: String(e.message) })
  }
}
out({ type: 'end', ok, result: last || 'fake answer' })
`

const TYPES = new Set(['text', 'tool_call', 'tool_result', 'permission', 'error', 'end'])

function fakeReader(): EventReader {
  let ended = false, session: string | undefined
  return {
    get session() { return session },
    line(l) {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      if (ev?.type === 'session' && typeof ev.id === 'string') { session = ev.id; return [] }
      if (!TYPES.has(ev?.type)) return []
      if (ev.type === 'end') ended = true
      return [ev as AgentEvent]
    },
    exit(code, stderr) {
      if (ended) return []
      return [{ type: 'error', message: stderr.trim().slice(-500) || `the fake harness exited with code ${code}`, code: 'harness' }, { type: 'end', ok: false }]
    },
  }
}

export const fake: Harness = {
  name: 'fake',
  home: { dir: '.byoa/fake', env: 'BYOA_FAKE_HOME' },
  env: {},
  async install(sbx) {
    const bin = `${sbx.home}/.byoa/fake.mjs`
    await sbx.writeFile(bin, FAKE_JS)
    return { bin, version: 'fake', installed: true }
  },
  command: (bin, args) => ['node', bin, ...args],
  args: (o) => o.conversation ? [o.conversation.resume ? '--resume' : '--session-id', o.conversation.session!] : [],
  modelArgs: () => [],
  reader: fakeReader,
  // the files of Claude Code, which it reads
  files: claude.files,
  conversation: { choose: true, byFolder: false, transcript: (s) => [`sessions/${s}.jsonl`] },
}
