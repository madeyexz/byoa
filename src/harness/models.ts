// The models a user's plan can use (R5.7), as each unmodified CLI lists them: Claude Code answers its `initialize`
// control request (`claude -p --input-format stream-json`) with `models`; Codex's app server answers `model/list`;
// Grok's agent mode (`grok agent stdio`, ACP) answers `initialize` with its `modelState`. Checked with Claude Code
// 2.1.330, codex-cli 0.171.0 and grok 1.0.92. The script runs with node in the job's sandbox, with the
// user's login, so each CLI lists what that login may use.

export interface ModelInfo {
  /** What `model` takes: Claude Code's alias (`default`, `opus`, ...), Codex's and Grok's model name. */
  id: string
  name: string
  description: string
  /** The model the CLI uses when the job names none. */
  isDefault: boolean
  /** What `effort` takes for this model; empty when it takes none. */
  efforts: string[]
  /** Claude Code: the full model name the alias stands for now, such as `claude-opus-5-5`. */
  resolved?: string
}

/** `node models.mjs <cli> <claude|codex|acp>` (the adapter's `models.protocol`): prints one JSON line, the CLI's own
 *  answer or `{ error }`. Each adapter reads that answer into ModelInfo. */
export const MODELS_JS = String.raw`
import { spawn } from 'node:child_process'
const [bin, h] = process.argv.slice(2)
const args = h === 'claude' ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
  : h === 'acp' ? ['--no-auto-update', 'agent', 'stdio'] : ['app-server']
const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = '', err = '', out = false
const data = []
const done = (x) => {
  if (out) return
  out = true
  console.log(JSON.stringify(x))
  // close its input and let it exit by itself, so it writes what it wants to (such as a refreshed login)
  p.stdin.end()
  const t = setTimeout(() => p.kill('SIGKILL'), 10000)
  p.on('exit', () => { clearTimeout(t); process.exit(0) })
}
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n')
setTimeout(() => done({ error: 'no answer in 60 s: ' + err.slice(-300) }), 60000).unref()
p.stderr.on('data', (c) => { err += c })
p.on('exit', (code) => done({ error: 'the CLI exited with code ' + code + ': ' + err.slice(-300) }))
p.stdout.on('data', (c) => {
  buf += c
  for (let k; (k = buf.indexOf('\n')) >= 0; ) {
    const l = buf.slice(0, k)
    buf = buf.slice(k + 1)
    let m
    try { m = JSON.parse(l) } catch { continue }
    if (h === 'claude' && m.type === 'control_response' && m.response?.request_id === 'byoa-models') {
      done(m.response.subtype === 'error' ? { error: m.response.error } : { models: m.response.response?.models ?? [] })
    }
    if (h === 'acp' && m.id === 'byoa-models') {
      if (m.error) return done({ error: m.error.message })
      const st = m.result?._meta?.modelState ?? {}
      done({ models: (st.availableModels ?? []).map((x) => ({ ...x, isDefault: x.modelId === st.currentModelId })) })
    }
    if (h === 'codex' && m.id === 'byoa-models') {
      if (m.error) return done({ error: m.error.message })
      data.push(...(m.result?.data ?? []))
      if (m.result?.nextCursor) send({ jsonrpc: '2.0', id: 'byoa-models', method: 'model/list', params: { cursor: m.result.nextCursor } })
      else done({ models: data })
    }
  }
})
if (h === 'claude') send({ type: 'control_request', request_id: 'byoa-models', request: { subtype: 'initialize' } })
else if (h === 'acp') send({ jsonrpc: '2.0', id: 'byoa-models', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
else {
  send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { clientInfo: { name: 'byoa', version: '1' } } })
  send({ jsonrpc: '2.0', method: 'initialized' })
  send({ jsonrpc: '2.0', id: 'byoa-models', method: 'model/list', params: {} })
}
`
