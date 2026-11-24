// Claude Code: `claude -p` with stream-json output. Flags checked against `claude --help` of 2.1.330.
// Events: system/init, assistant (text, tool_use), user (tool_result), result (subtype, is_error, result, usage,
// permission_denials).
import type { Access } from '../config.ts'
import { AUTH_FAILED, clip, type AgentEvent, type EventReader } from './events.ts'

/** The Claude Code login lives in this folder, which is the user's login volume (R1.4). With CLAUDE_CONFIG_DIR set,
 *  Claude Code keeps both `.credentials.json` and `.claude.json` there. */
export const CLAUDE_DIR = '.claude'

/** The built-in tools of a `read-only` job (R5.6): they read files, and Skill loads the job's skills. */
const CLAUDE_READ_TOOLS = ['Read', 'Glob', 'Grep', 'Skill']

/** `servers`: the job's MCP servers, whose tools a `read-only` job may call. */
export function claudeArgs(o: { mcpConfig: string; model?: string; effort?: string; access?: Access; servers?: string[] }): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--mcp-config', o.mcpConfig, '--strict-mcp-config',
    ...(o.access === 'read-only'
      // R5.6: only the tools that read, and the job's MCP tools; `dontAsk` refuses every other tool, and Claude Code
      // reports each refusal (a `permission` event). Not `--restricted`: it leaves out the job's own skills.
      // Checked with 2.1.330: its `init` event lists these tools and the job's skill, and no Bash, Edit or Write.
      ? ['--permission-mode', 'dontAsk', '--tools', CLAUDE_READ_TOOLS.join(','), '--allowedTools', [...CLAUDE_READ_TOOLS, ...(o.servers ?? []).map((s) => `mcp__${s}`)].join(',')]
      // the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4)
      : ['--permission-mode', 'bypassPermissions']),
    '--no-session-persistence',
    ...claudeModelArgs(o),
  ]
}

/** `--model` (an alias such as `opus`, or a full name) and `--effort` (low, medium, high, xhigh, max), as `claude --help`
 *  of 2.1.330 lists them. */
export const claudeModelArgs = (o: { model?: string; effort?: string }): string[] =>
  [...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : [])]

const mcpName = (n: string): { name: string; server?: string } => {
  const m = /^mcp__(.+?)__(.+)$/.exec(n)
  return m ? { server: m[1]!, name: m[2]! } : { name: n }
}
const textOf = (c: unknown): string => Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : String(c ?? '')

export function claudeReader(): EventReader {
  let ended = false
  return {
    line(l) {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      const out: AgentEvent[] = []
      switch (ev?.type) {
        case 'assistant':
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text })
            else if (c.type === 'tool_use') out.push({ type: 'tool_call', id: String(c.id), ...mcpName(String(c.name)), input: c.input ?? {} })
          }
          break
        case 'user':
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_result') out.push({ type: 'tool_result', id: String(c.tool_use_id), ok: !c.is_error, output: clip(textOf(c.content)) })
          }
          break
        case 'result': {
          for (const d of ev.permission_denials ?? []) out.push({ type: 'permission', tool: String(d.tool_name), decision: 'denied', input: d.tool_input })
          const ok = ev.subtype === 'success' && !ev.is_error
          const u = ev.usage ?? {}
          const cached = Number(u.cache_read_input_tokens) || 0
          if (!ok) {
            const msg = String(ev.result || ev.subtype || 'Claude Code failed')
            out.push({ type: 'error', message: clip(msg, 500), code: AUTH_FAILED.test(msg) ? 'expired' : 'harness' })
          }
          out.push({
            type: 'end', ok, ...(ok && typeof ev.result === 'string' ? { result: ev.result } : {}),
            usage: { input: (Number(u.input_tokens) || 0) + cached + (Number(u.cache_creation_input_tokens) || 0), output: Number(u.output_tokens) || 0, cached, ...(typeof ev.total_cost_usd === 'number' ? { costUsd: ev.total_cost_usd } : {}) },
          })
          ended = true
          break
        }
      }
      return out
    },
    exit(code, stderr) {
      if (ended) return []
      const msg = stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`
      return [{ type: 'error', message: clip(msg, 500), code: AUTH_FAILED.test(msg) ? 'expired' : 'harness' }, { type: 'end', ok: false }]
    },
  }
}
