// Codex: `codex exec --json`, and `codex exec resume --json` for the next job of a conversation. Flags checked against
// `codex exec --help` and `codex exec resume --help` of codex-cli 0.171.0.
// Events: thread.started (the thread id), turn.started, item.started / item.completed (agent_message, mcp_tool_call,
// command_execution, ...), turn.completed (usage), turn.failed, error.
import { JOB_TOKEN_ENV, MCP_STARTUP_SEC, serverUrl, tomlString } from '../config.ts'
import { AUTH_FAILED, clip, type AgentEvent, type EventReader } from './events.ts'
import { installPinned } from './install.ts'
import { PACKAGES } from './pins.ts'
import { REFRESH_WINDOW_MS, type JobArgs, type LabHarness, type ModelChoice } from './types.ts'

const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
const auth = (files: Record<string, string>) => { try { return JSON.parse(files['.codex/auth.json'] ?? '') } catch { return undefined } }

/** `-m` and the config key `model_reasoning_effort` (low, medium, high, xhigh, max, ultra in codex-cli 0.171.0's model
 *  catalog; which ones a model takes is in its `efforts` from listModels). */
const modelArgs = (o: ModelChoice): string[] =>
  [...(o.model ? ['-m', o.model] : []), ...(o.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(o.effort)}`] : [])]

/** When the CLI refreshes: 5 minutes before the `exp` of its access token (a JWT); a token with no `exp` is refreshed
 *  8 days after the last refresh. Its access token lasts 10 days (0.171.0, login/src/auth/manager.rs). */
function refreshDue(files: Record<string, string>): number {
  const doc = auth(files)
  if (!doc) return 0
  const payload = String(doc?.tokens?.access_token ?? '').split('.')[1]
  let exp = 0
  try { exp = Number(JSON.parse(fromB64((payload ?? '').replace(/-/g, '+').replace(/_/g, '/'))).exp) * 1000 } catch {}
  if (exp > 0) return exp - REFRESH_WINDOW_MS
  const last = Date.parse(doc?.last_refresh ?? '')
  return last > 0 ? last + 8 * 24 * 3600_000 : 0
}

const out = (r: unknown): string => {
  if (typeof r === 'string') return r
  const content = (r as any)?.content
  if (Array.isArray(content)) return content.map((x: any) => x?.text ?? '').join('')
  return r === undefined ? '' : JSON.stringify(r)
}

/** `plan`: Codex knows no model of a plan, and says so at the start of each job (codex-cli 0.171.0): not an error. */
function codexReader(o: { plan?: boolean } = {}): EventReader {
  let ended = false, last = '', failed = '', session: string | undefined
  return {
    get session() { return session },
    line(l): AgentEvent[] {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      const it = ev?.item
      switch (ev?.type) {
        case 'thread.started': if (typeof ev.thread_id === 'string' && ev.thread_id) session = ev.thread_id; return []
        case 'item.started':
          if (it?.type === 'mcp_tool_call') return [{ type: 'tool_call', id: String(it.id), name: String(it.tool), server: String(it.server), input: it.arguments ?? {} }]
          if (it?.type === 'command_execution') return [{ type: 'tool_call', id: String(it.id), name: 'shell', input: { command: it.command } }]
          return []
        case 'item.completed':
          switch (it?.type) {
            case 'agent_message': last = String(it.text ?? ''); return last ? [{ type: 'text', text: last }] : []
            case 'mcp_tool_call': return [{ type: 'tool_result', id: String(it.id), ok: it.status !== 'failed' && !it.error, output: clip(it.error ? String(it.error.message ?? it.error) : out(it.result)) }]
            case 'command_execution': return [{ type: 'tool_result', id: String(it.id), ok: it.exit_code === 0, output: clip(String(it.aggregated_output ?? '')) }]
            case 'error':
              if (o.plan && /^Model metadata for .* not found/.test(String(it.message))) return []
              return [{ type: 'error', message: clip(String(it.message), 500), code: 'harness' }]
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

export const codex: LabHarness = {
  name: 'codex',
  // the Codex login (`auth.json`), its sessions and settings; CODEX_HOME's default
  home: { dir: '.codex', env: 'CODEX_HOME' },
  env: {},
  install: (sbx, pins) => installPinned(sbx, { name: 'codex', pkg: PACKAGES.codex, pin: pins.codex }),
  command: (bin, args) => [bin, ...args],
  args(o: JobArgs) {
    const resume = o.conversation?.resume
    return [
      // R5.9: a conversation's first job keeps its session (no --ephemeral), and Codex names the thread in its
      // thread.started event; the next jobs resume it (checked with 0.171.0: the resumed job sees the earlier messages,
      // also from the session file alone in a new CODEX_HOME)
      'exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check', ...(o.conversation ? [] : ['--ephemeral']),
      ...(o.access === 'read-only'
        // R5.6: Codex's own sandbox. Its shell stays, because Codex reads a skill with `cat`, but a command cannot
        // change a file or reach the network. `codex exec` never asks for approval; the job's MCP tools are approved
        // in config.toml. Checked with 0.171.0 on E2B: the skill was read, the MCP call went through, and
        // `echo x > file` and `curl` failed. `exec resume` has no --sandbox; the config key sets the same policy
        // (0.171.0: its requests report `sandbox_mode: read-only`).
        ? (resume ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only'])
        // the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4)
        : ['--dangerously-bypass-approvals-and-sandbox']),
      // Codex reads the job's `.codex/config.toml` only in a trusted project; this marks the job's folder trusted for
      // this run only (0.171.0: a dotted `projects."<dir>".trust_level` is not applied, the inline table is)
      '-c', `projects={${JSON.stringify(o.work)}={trust_level="trusted"}}`,
      ...o.model,
      ...(resume ? [o.conversation!.session!] : []),
      '-',
    ]
  },
  modelArgs,
  reader: codexReader,
  files: {
    // Codex reads `.agents/skills`
    skills: '.agents/skills',
    claudeMd: false,
    mcpPath: '.codex/config.toml',
    // TOML. With its sandbox on, Codex asks before each MCP tool call, and `codex exec` has nobody to ask: it refuses
    // the call. The job's servers are the ones the app chose for it (R2.5), so their tools need no approval.
    mcp(servers, o) {
      if (!servers.length) return undefined
      const approve = o.access === 'read-only' ? 'default_tools_approval_mode = "approve"\n' : ''
      return 'mcp_optional_startup_grace_ms = 0\n\n' + servers.map((s) =>
        `[mcp_servers.${s}]\nurl = ${tomlString(serverUrl(o.proxyUrl, s))}\nbearer_token_env_var = "${JOB_TOKEN_ENV}"\nstartup_timeout_sec = ${MCP_STARTUP_SEC}\n${approve}`).join('\n')
    },
  },
  // `codex exec` reads its prompt to the end of stdin, and takes no message while it runs
  input: 'text',
  conversation: { choose: false, byFolder: false, transcript: (s) => [`sessions/*/*/*/rollout-*-${s}.jsonl`] },
  login: {
    files: ['.codex/auth.json'],
    url: /https:\/\/auth\.openai\.com\/[^\s\x07\x1b]+/,
    signIn: 'login --device-auth',
    signOut: 'logout',
    device: true,
    refreshDue,
    facts(files) {
      const doc = auth(files)
      const last = Date.parse(doc?.last_refresh ?? '')
      const account = doc?.tokens?.account_id
      return { account: typeof account === 'string' && account ? account : undefined, fresh: last > 0 ? last : Math.max(0, refreshDue(files) + REFRESH_WINDOW_MS) }
    },
  },
  models: {
    // its app server's `model/list`
    protocol: 'codex',
    read: (raw) => raw.filter((m) => !m.hidden).map((m) => ({
      id: String(m.model ?? m.id), name: String(m.displayName ?? m.model), description: String(m.description ?? ''),
      isDefault: !!m.isDefault, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => String(e.reasoningEffort ?? e)),
    })),
  },
  // OpenCode's settings for Codex (docs/console/harnesses/codex), as `-c` overrides, so they hold for this job only:
  // a model provider with the Responses API, which reads the job token from JOB_TOKEN_ENV.
  plan: (o) => {
    const dir = `${o.home}/.byoa/plan/codex`
    return {
      dirs: [dir],
      env: { CODEX_HOME: dir },
      args: [
        '-c', 'model_provider="opencode-go"',
        '-c', `model_providers.opencode-go={name="OpenCode Go",base_url=${JSON.stringify(`${o.base}/openai/v1`)},env_key="${JOB_TOKEN_ENV}",wire_api="responses"}`,
        ...modelArgs(o),
      ],
    }
  },
  // Codex's platform packages are versions of @openai/codex (0.171.0-linux-x64)
  verify: { platformPrefix: 'codex-', platformOk: (name, version, pin) => name === PACKAGES.codex && version.startsWith(`${pin}-`) },
}
