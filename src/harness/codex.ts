// Codex: `codex exec --json`. Flags checked against `codex exec --help` of codex-cli 0.171.0.
// Events: thread.started, turn.started, item.started / item.completed (agent_message, mcp_tool_call,
// command_execution, ...), turn.completed (usage), turn.failed, error.
import type { Access } from '../config.ts'
import { AUTH_FAILED, clip, type AgentEvent, type EventReader } from './events.ts'

/** The Codex login (`auth.json`) lives here, the user's login volume (R1.4); CODEX_HOME's default. */
export const CODEX_DIR = '.codex'

/** `work`: the job's folder. Codex reads the job's `.codex/config.toml` only in a trusted project; this marks the job's
 *  folder trusted for this run only (checked with 0.171.0: a dotted `projects."<dir>".trust_level` is not applied,
 *  the inline table is). */
export function codexArgs(o: { work: string; model?: string; effort?: string; access?: Access }): string[] {
  return [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral',
    ...(o.access === 'read-only'
      // R5.6: Codex's own sandbox. Its shell stays, because Codex reads a skill with `cat`, but a command cannot
      // change a file or reach the network. `codex exec` never asks for approval; the job's MCP tools are approved
      // in config.toml (config.ts). Checked with 0.171.0 on E2B: the skill was read, the MCP call went through, and
      // `echo x > file` and `curl` failed.
      ? ['--sandbox', 'read-only']
      // the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4)
      : ['--dangerously-bypass-approvals-and-sandbox']),
    '-c', `projects={${JSON.stringify(o.work)}={trust_level="trusted"}}`,
    ...codexModelArgs(o),
    '-',
  ]
}

/** `-m` and the config key `model_reasoning_effort` (low, medium, high, xhigh, max, ultra in codex-cli 0.171.0's model
 *  catalog; which ones a model takes is in its `efforts` from listModels). */
export const codexModelArgs = (o: { model?: string; effort?: string }): string[] =>
  [...(o.model ? ['-m', o.model] : []), ...(o.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(o.effort)}`] : [])]

const out = (r: unknown): string => {
  if (typeof r === 'string') return r
  const content = (r as any)?.content
  if (Array.isArray(content)) return content.map((x: any) => x?.text ?? '').join('')
  return r === undefined ? '' : JSON.stringify(r)
}

export function codexReader(): EventReader {
  let ended = false, last = '', failed = ''
  return {
    line(l) {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      const it = ev?.item
      switch (ev?.type) {
        case 'item.started':
          if (it?.type === 'mcp_tool_call') return [{ type: 'tool_call', id: String(it.id), name: String(it.tool), server: String(it.server), input: it.arguments ?? {} }]
          if (it?.type === 'command_execution') return [{ type: 'tool_call', id: String(it.id), name: 'shell', input: { command: it.command } }]
          return []
        case 'item.completed':
          switch (it?.type) {
            case 'agent_message': last = String(it.text ?? ''); return last ? [{ type: 'text', text: last }] : []
            case 'mcp_tool_call': return [{ type: 'tool_result', id: String(it.id), ok: it.status !== 'failed' && !it.error, output: clip(it.error ? String(it.error.message ?? it.error) : out(it.result)) }]
            case 'command_execution': return [{ type: 'tool_result', id: String(it.id), ok: it.exit_code === 0, output: clip(String(it.aggregated_output ?? '')) }]
            case 'error': return [{ type: 'error', message: clip(String(it.message), 500), code: 'harness' }]
            default: return []
          }
        case 'turn.completed': {
          ended = true
          const u = ev.usage ?? {}
          return [{ type: 'end', ok: true, result: last, usage: { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cached: Number(u.cached_input_tokens) || 0 } }]
        }
        case 'turn.failed': {
          ended = true
          const msg = String(ev.error?.message || failed || 'Codex failed')
          return [{ type: 'error', message: clip(msg, 500), code: AUTH_FAILED.test(msg) ? 'expired' : 'harness' }, { type: 'end', ok: false }]
        }
        case 'error': failed = String(ev.message ?? ''); return []
        default: return []
      }
    },
    exit(code, stderr) {
      if (ended) return []
      const msg = failed || stderr.trim().split('\n').slice(-3).join(' ') || `codex exited with code ${code}`
      return [{ type: 'error', message: clip(msg, 500), code: AUTH_FAILED.test(msg) ? 'expired' : 'harness' }, { type: 'end', ok: false }]
    },
  }
}
