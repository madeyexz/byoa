// The models a user's plan can use (R5.7), as each unmodified CLI lists them: Claude Code answers its `initialize`
// control request (`claude -p --input-format stream-json`) with `models`; Codex's app server answers `model/list`.
// Both checked with Claude Code 2.1.330 and codex-cli 0.171.0. The script runs with node in the job's sandbox, with the
// user's login, so each CLI lists what that login may use.

export interface ModelInfo {
  /** What `model` takes: Claude Code's alias (`default`, `opus`, ...), Codex's model name. */
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

/** `node models.mjs <cli> <claude|codex>`: prints one JSON line, the CLI's own answer or `{ error }`. */
export const MODELS_JS = String.raw`
import { spawn } from 'node:child_process'
const [bin, h] = process.argv.slice(2)
const args = h === 'claude' ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'] : ['app-server']
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
    if (h === 'codex' && m.id === 'byoa-models') {
      if (m.error) return done({ error: m.error.message })
      data.push(...(m.result?.data ?? []))
      if (m.result?.nextCursor) send({ jsonrpc: '2.0', id: 'byoa-models', method: 'model/list', params: { cursor: m.result.nextCursor } })
      else done({ models: data })
    }
  }
})
if (h === 'claude') send({ type: 'control_request', request_id: 'byoa-models', request: { subtype: 'initialize' } })
else {
  send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { clientInfo: { name: 'byoa', version: '1' } } })
  send({ jsonrpc: '2.0', method: 'initialized' })
  send({ jsonrpc: '2.0', id: 'byoa-models', method: 'model/list', params: {} })
}
`

/** The CLI's answer, in one shape for both harnesses. */
export function readModels(h: 'claude' | 'codex', raw: any[]): ModelInfo[] {
  if (h === 'claude') {
    return raw.map((m) => ({
      id: String(m.value), name: String(m.displayName ?? m.value), description: String(m.description ?? ''),
      isDefault: m.value === 'default', efforts: m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? []).map(String),
      ...(m.resolvedModel ? { resolved: String(m.resolvedModel) } : {}),
    }))
  }
  return raw.filter((m) => !m.hidden).map((m) => ({
    id: String(m.model ?? m.id), name: String(m.displayName ?? m.model), description: String(m.description ?? ''),
    isDefault: !!m.isDefault, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => String(e.reasoningEffort ?? e)),
  }))
}
