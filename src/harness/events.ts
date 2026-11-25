// One event schema for every harness (R5.5). Each harness's own output (Claude Code's stream-json, Codex's
// `exec --json`, Grok's streaming-messages-json) is read into these events, so the app's code does not change with the harness.

export interface Usage { input: number; output: number; cached?: number; costUsd?: number }

export type AgentEvent =
  /** `conversation`: the app's id of the conversation this job continues (R5.9); `resumed`: the harness continued an
   *  earlier session of it (false for its first job, or when its history was lost). */
  | { type: 'start'; harness: string; version: string; sandbox: string; conversation?: string; resumed?: boolean }
  | { type: 'text'; text: string }
  /** `server`: the MCP server, for an MCP tool; `name` is then the tool's own name. */
  | { type: 'tool_call'; id: string; name: string; server?: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  /** A tool the harness asked to use and was not allowed to. */
  | { type: 'permission'; tool: string; decision: 'denied'; input?: unknown }
  /** `code`: `signed-out` or `expired` when the harness has no working login; then `loginState` says so too.
   *  `no-plan`: a job with a plan (`plan: 'opencode-go'`) whose key's workspace has no Go plan. `conversation`: the
   *  history of the conversation was lost, and the job starts a new one. */
  | { type: 'error'; message: string; code?: 'signed-out' | 'expired' | 'no-plan' | 'harness' | 'sandbox' | 'mcp' | 'conversation' }
  /** One turn ended, and the agent goes on with a message that the app sent while the job ran (`job.send`, R5.10).
   *  The last turn is the `end` event. */
  | { type: 'turn'; ok: boolean; result?: string; usage?: Usage }
  /** `session`: the harness's own session id, in a job of a conversation (R5.9). */
  | { type: 'end'; ok: boolean; result?: string; usage?: Usage; session?: string }

/** A harness's output, one line at a time, into events. */
export interface EventReader {
  line(text: string): AgentEvent[]
  /** The process ended: the last events, such as `end` when the harness gave none. */
  exit(code: number, stderr: string): AgentEvent[]
  /** The harness's own session id, once its output named it. */
  readonly session?: string
  /** With stream-json input: how many of the job's messages the harness has taken. */
  readonly taken?: number
}

/** Text that says the harness's own login does not work (it ran out, or was revoked). */
export const AUTH_FAILED = /invalid api key|please run \/login|oauth token (?:has )?expired|token (?:has )?expired|refresh token (?:was )?revoked|not logged in|not signed in|sign in again|log ?in again|401 unauthorized|unauthorized: 401/i

export const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s)

const mcpName = (n: string): { name: string; server?: string } => {
  const m = /^mcp__(.+?)__(.+)$/.exec(n)
  return m ? { server: m[1]!, name: m[2]! } : { name: n }
}
const textOf = (c: unknown): string => Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : String(c ?? '')

/** Claude Code's stream-json output (system/init, assistant, user, result), which Grok Build prints too. `name`: the
 *  CLI, in the message when it exits with no result. Each `result` is the end of one turn. */
export function streamJsonReader(name: string): EventReader {
  let ended = false, session: string | undefined, taken = 0
  return {
    get session() { return session },
    get taken() { return taken },
    line(l) {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      const out: AgentEvent[] = []
      switch (ev?.type) {
        case 'system':
          if (ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id) session = ev.session_id
          break
        case 'assistant':
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text })
            else if (c.type === 'tool_use') out.push({ type: 'tool_call', id: String(c.id), ...mcpName(String(c.name)), input: c.input ?? {} })
          }
          break
        case 'user':
          // messages of the job's input, echoed when the harness takes them (Claude Code's --replay-user-messages). Each
          // message that byoa sends is one text block; messages that wait while a turn runs come back together, as one
          // echo with a block for each (checked with 2.1.330), and get one turn.
          if (ev.isReplay) { taken += Array.isArray(ev.message?.content) ? ev.message.content.filter((c: any) => c?.type === 'text').length || 1 : 1; break }
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
            const msg = String(ev.result || ev.subtype || `${name} failed`)
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
      const msg = stderr.trim().split('\n').slice(-3).join(' ') || `${name} exited with code ${code}`
      return [{ type: 'error', message: clip(msg, 500), code: AUTH_FAILED.test(msg) ? 'expired' : 'harness' }, { type: 'end', ok: false }]
    },
  }
}
