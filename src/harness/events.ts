// One event schema for every harness (R5.5). Each harness's own output (Claude Code's stream-json, Codex's
// `exec --json`, Grok's streaming-messages-json) is read into these events, so the app's code does not change with the harness.

export interface Usage { input: number; output: number; cached?: number; costUsd?: number }

export type AgentEvent =
  | { type: 'start'; harness: string; version: string; sandbox: string }
  | { type: 'text'; text: string }
  /** `server`: the MCP server, for an MCP tool; `name` is then the tool's own name. */
  | { type: 'tool_call'; id: string; name: string; server?: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  /** A tool the harness asked to use and was not allowed to. */
  | { type: 'permission'; tool: string; decision: 'denied'; input?: unknown }
  /** `code`: `signed-out` or `expired` when the harness has no working login; then `loginState` says so too.
   *  `no-plan`: a job with a plan (`plan: 'opencode-go'`) whose key's workspace has no Go plan. */
  | { type: 'error'; message: string; code?: 'signed-out' | 'expired' | 'no-plan' | 'harness' | 'sandbox' | 'mcp' }
  | { type: 'end'; ok: boolean; result?: string; usage?: Usage }

/** A harness's output, one line at a time, into events. */
export interface EventReader {
  line(text: string): AgentEvent[]
  /** The process ended: the last events, such as `end` when the harness gave none. */
  exit(code: number, stderr: string): AgentEvent[]
}

/** Text that says the harness's own login does not work (it ran out, or was revoked). */
export const AUTH_FAILED = /invalid api key|please run \/login|oauth token (?:has )?expired|token (?:has )?expired|refresh token (?:was )?revoked|not logged in|not signed in|sign in again|log ?in again|401 unauthorized|unauthorized: 401/i

export const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s)
