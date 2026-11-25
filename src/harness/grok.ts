// Grok Build: `grok -p` with `--output-format streaming-messages-json`, which prints Claude Code's stream-json shape
// (system/init, assistant, user, result). Flags checked against `grok --help` of 1.0.92.
// Differences from Claude Code: an MCP tool is called through Grok's `use_tool` meta-tool, whose input names the tool
// as `<server>__<tool>`; `result` has no `permission_denials`; and an all-zero `usage` means unknown, not free.
import type { Access } from '../config.ts'
import { claudeReader } from './claude.ts'
import type { AgentEvent, EventReader } from './events.ts'

/** The Grok login (`auth.json`) lives here, the user's login volume (R1.4); GROK_HOME's default. */
export const GROK_DIR = '.grok'

/** The built-in tools of a `read-only` job (R5.6): they read files. Grok loads a skill with its own skill tool, which
 *  runs in every permission mode, and its MCP meta-tools stay with `--tools`. No shell and no edit tool, so nothing the
 *  agent runs can change a file or open a connection. */
const GROK_READ_TOOLS = ['read_file', 'grep', 'list_dir']

export function grokArgs(o: { model?: string; effort?: string; access?: Access }): string[] {
  return [
    // --trust: Grok reads the job folder's AGENTS.md, skills and `.grok/config.toml` (the MCP servers) only in a
    // trusted folder; it is a global flag, so it comes first. The prompt comes from stdin.
    '--trust', '-p', '--output-format', 'streaming-messages-json',
    // byoa runs the pinned version (R5.1); a job keeps no memory for the next one
    '--no-auto-update', '--no-memory',
    ...(o.access === 'read-only'
      // R5.6: only the tools that read, and the MCP tools; `dontAsk` refuses every call with no allow rule. Web
      // search runs with no approval in every mode, so it is off. Not `--sandbox read-only`: on Linux grok 1.0.92
      // refuses to start under it without bubblewrap, which E2B's sandboxes do not have.
      // `MCPTool(*)`, not one rule per server: Grok calls MCP tools through `use_tool`, and a `use_tool` call that no
      // allow rule covers (the agent tried `write_file` through it) is a refusal, which in `-p` ends the whole run as
      // `cancelled`. With the rule, such a call gets an error back and the job goes on. Grok sees only the job's MCP
      // servers: byoa writes no other MCP config. Checked on E2B: no file written, no shell, the MCP call went through.
      ? ['--permission-mode', 'dontAsk', '--disable-web-search', '--tools', GROK_READ_TOOLS.join(','), '--allow', 'MCPTool(*)']
      // the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4)
      : ['--permission-mode', 'bypassPermissions']),
    ...grokModelArgs(o),
  ]
}

/** `-m` and `--reasoning-effort` (`grok --help` of 1.0.92); a model's own efforts are in its `efforts` from
 *  listModels. */
export const grokModelArgs = (o: { model?: string; effort?: string }): string[] =>
  [...(o.model ? ['-m', o.model] : []), ...(o.effort ? ['--reasoning-effort', o.effort] : [])]

/** An MCP tool, as Grok names it: `<server>__<tool>`. */
const mcpName = (n: unknown): { server: string; name: string } | undefined => {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*?)__(.+)$/.exec(String(n ?? ''))
  return m ? { server: m[1]!, name: m[2]! } : undefined
}

export function grokReader(): EventReader {
  const inner = claudeReader('grok')
  const fix = (evs: AgentEvent[]): AgentEvent[] => evs.flatMap((e): AgentEvent[] => {
    if (e.type === 'tool_call') {
      const input = e.input as any
      // the meta-tool that calls an MCP tool: report the MCP tool itself
      if (e.name === 'use_tool' && !e.server) {
        const t = mcpName(input?.tool_name)
        if (t) return [{ type: 'tool_call', id: e.id, ...t, input: input?.tool_input ?? {} }]
      }
      const t = !e.server && mcpName(e.name)
      if (t) return [{ ...e, ...t }]
    }
    // Grok 1.0.92 wraps a tool's output in its own JSON ({ type: 'MCP', ..., output: { OkayOutput: '<the text>' } }):
    // the event has the tool's own text, as for the other harnesses
    if (e.type === 'tool_result') {
      let w: any
      try { w = JSON.parse(e.output) } catch {}
      const inner = w && typeof w === 'object' && w.output && typeof w.output === 'object' ? Object.values(w.output) : []
      if (inner.length === 1 && typeof inner[0] === 'string') return [{ ...e, output: inner[0] }]
    }
    // Grok writes 0 for usage it does not know (its docs: read all-zero usage as unknown)
    if (e.type === 'end' && e.usage && !e.usage.input && !e.usage.output) {
      const { usage: _, ...rest } = e
      return [rest]
    }
    return [e]
  })
  return {
    line: (l) => {
      // Grok's `result` of a failed run carries its message in `errors`, not in `result`
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      if (ev?.type === 'result' && ev.subtype !== 'success' && !ev.result && Array.isArray(ev.errors) && ev.errors.length) {
        return fix(inner.line(JSON.stringify({ ...ev, result: ev.errors.join(' ') })))
      }
      return fix(inner.line(l))
    },
    exit: (code, stderr) => fix(inner.exit(code, stderr)),
  }
}
