// Claude Code: `claude -p` with stream-json input and output. Flags checked against `claude --help` of 2.1.330.
// Events: system/init (with the session id), assistant (text, tool_use; an API error's kind), user (tool_result),
// rate_limit_event (the plan's limit), result (subtype, is_error, result, usage, permission_denials), one result for
// each turn.
import { JOB_TOKEN_ENV, MCP_STARTUP_SEC, serverUrl } from '../config.ts'
import { driver } from './driver.ts'
import { clip, codeOf, errorEvent, type AgentEvent, type ErrorCode, type EventReader } from './events.ts'
import { installPinned } from './install.ts'
import { PACKAGES } from './pins.ts'
import { REFRESH_WINDOW_MS, type JobArgs, type LabHarness, type ModelChoice } from './types.ts'

/** The built-in tools of a `read-only` job (R5.6): they read files, and Skill loads the job's skills. */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Skill']
/** Where the MCP config goes, relative to the job's folder. The fake harness reads it there too. */
export const CLAUDE_MCP_CONFIG = '.byoa/mcp.json'

const json = (files: Record<string, string>, p: string) => { try { return JSON.parse(files[p] ?? '') } catch { return undefined } }
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** `--model` (an alias such as `opus`, or a full name) and `--effort` (low, medium, high, xhigh, max), as `claude --help`
 *  of 2.1.330 lists them. */
const modelArgs = (o: ModelChoice): string[] => [...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : [])]

/** The MCP config: JSON, each server at the proxy with the job token from the environment (R4.3, R3.1). */
const mcpConfig = (servers: string[], o: { proxyUrl: string }) => JSON.stringify({
  mcpServers: Object.fromEntries(servers.map((s) => [s, { type: 'http', url: serverUrl(o.proxyUrl, s), headers: { Authorization: `Bearer \${${JOB_TOKEN_ENV}}` } }])),
}, null, 2) + '\n'

const mcpName = (n: string): { name: string; server?: string } => {
  const m = /^mcp__(.+?)__(.+)$/.exec(n)
  return m ? { server: m[1]!, name: m[2]! } : { name: n }
}
const textOf = (c: unknown): string => Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : String(c ?? '')

/** The code of a failed turn (R1.9) from the API error that Claude Code 2.1.330 puts on its assistant message: `error`
 *  (authentication_failed, rate_limit, overloaded, ...), and `api_error` usage_limit_reached for the account's own
 *  plan limit (a session, weekly or model limit, or a spend cap), with `api_error_params.rate_limit_info.resetsAt` (s);
 *  or a `rate_limit_event` that said `rejected`. Else the text. */
function claudeCode(api: any, rejected: any, message: string): { code: ErrorCode; resetsAt?: number } {
  const at = (i: any) => (Number(i?.resetsAt) > 0 ? Number(i.resetsAt) * 1000 : undefined)
  if (api?.api_error === 'usage_limit_reached') return { code: 'usage-limit', resetsAt: at(api.api_error_params?.rate_limit_info) ?? at(rejected) }
  if (api?.error === 'rate_limit' && rejected) return { code: 'usage-limit', resetsAt: at(rejected) }
  if (api?.error === 'authentication_failed') return { code: 'expired' }
  const code = codeOf(message)
  if (code === 'usage-limit') return { code, resetsAt: at(rejected) }
  if (code === 'harness' && (api?.error === 'rate_limit' || api?.error === 'overloaded')) return { code: 'rate-limited' }
  return { code }
}

/** Claude Code's stream-json output (system/init, assistant, user, result). Each `result` is the end of one turn. */
function claudeReader(): EventReader {
  let ended = false, session: string | undefined, taken = 0
  /** This turn's API error, and the plan's limit when the last rate_limit_event said that it refuses. */
  let api: any, rejected: any
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
        case 'rate_limit_event':
          rejected = ev.rate_limit_info?.status === 'rejected' ? ev.rate_limit_info : undefined
          break
        case 'assistant':
          if (ev.error) api = ev
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text })
            else if (c.type === 'tool_use') out.push({ type: 'tool_call', id: String(c.id), ...mcpName(String(c.name)), input: c.input ?? {} })
          }
          break
        case 'user':
          // messages of the job's input, echoed when Claude Code takes them (--replay-user-messages). Each message that
          // byoa sends is one text block; messages that wait while a turn runs come back together, as one echo with a
          // block for each (checked with 2.1.330), and get one turn.
          if (ev.isReplay) { ended = false; taken += Array.isArray(ev.message?.content) ? ev.message.content.filter((c: any) => c?.type === 'text').length || 1 : 1; break }
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
            const c = claudeCode(api, rejected, msg)
            out.push(errorEvent(msg, c.code, c.resetsAt))
          }
          api = undefined
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
      const c = claudeCode(api, rejected, msg)
      return [errorEvent(msg, c.code, c.resetsAt), { type: 'end', ok: false }]
    },
  }
}

/** The task and each later message as one stream-json line on Claude Code's stdin; it exits when its input ends. */
const CLAUDE_DRIVER = driver(String.raw`
onLine(print)
inbox((text) => cli.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'), () => cli.stdin.end())
`)

export const claude: LabHarness = {
  name: 'claude',
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps both `.credentials.json` and `.claude.json` there, and its sessions
  // under `projects/`
  home: { dir: '.claude', env: 'CLAUDE_CONFIG_DIR' },
  env: { DISABLE_AUTOUPDATER: '1' },
  // Claude Code has no MCP start timeout in its config, only this variable (config.ts, MCP_STARTUP_SEC)
  jobEnv: { MCP_TIMEOUT: String(MCP_STARTUP_SEC * 1000) },
  install: (sbx, pins) => installPinned(sbx, { name: 'claude', pkg: PACKAGES.claude, pin: pins.claude }),
  command: (bin, args) => [bin, ...args],
  args: (o: JobArgs) => [
    // stream-json input: the task is the first message, and the app may send more while the job runs (R5.10). Claude
    // Code echoes each message when it takes it (--replay-user-messages), so byoa knows when it has taken them all, and
    // ends its input then; it exits when its input ends (checked with 2.1.330: a message sent during a turn gets its
    // own turn, with the first one in its history).
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--mcp-config', CLAUDE_MCP_CONFIG, '--strict-mcp-config',
    ...(o.access === 'read-only'
      // R5.6: only the tools that read, and the job's MCP tools; `dontAsk` refuses every other tool, and Claude Code
      // reports each refusal (a `permission` event). Not `--restricted`: it leaves out the job's own skills.
      // Checked with 2.1.330: its `init` event lists these tools and the job's skill, and no Bash, Edit or Write.
      ? ['--permission-mode', 'dontAsk', '--tools', READ_TOOLS.join(','), '--allowedTools', [...READ_TOOLS, ...o.servers.map((s) => `mcp__${s}`)].join(',')]
      // the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4)
      : ['--permission-mode', 'bypassPermissions']),
    // R5.9: a conversation's first job names its session, and the next ones resume it (checked with 2.1.330: the
    // session keeps its id, and a resumed job sees the earlier messages). A job of no conversation keeps no session.
    ...(!o.conversation ? ['--no-session-persistence'] : o.conversation.resume ? ['--resume', o.conversation.session!] : ['--session-id', o.conversation.session!]),
    ...o.model,
  ],
  modelArgs,
  reader: claudeReader,
  files: { skills: '.claude/skills', claudeMd: true, mcpPath: CLAUDE_MCP_CONFIG, mcp: mcpConfig },
  driver: { js: CLAUDE_DRIVER, setup: () => ({}) },
  // the transcript is `projects/<the cwd, with each other character as ->/<id>.jsonl`, and a folder of the same name
  // for its subagents; a transcript copied into another config folder resumes there (checked with 2.1.330)
  conversation: { choose: true, byFolder: true, transcript: (s) => [`projects/*/${s}.jsonl`, `projects/*/${s}/*`] },
  login: {
    files: ['.claude/.credentials.json', '.claude/.claude.json'],
    // Claude Code 2.1.330 writes a backup of `.claude.json` (the account: email, organization, plan; no token) at each
    // start
    copies: ['.claude/backups/.claude.json.backup.*'],
    url: /https:\/\/claude\.(?:com|ai)\/[^\s\x07\x1b]+/,
    signIn: 'auth login',
    signOut: 'auth logout',
    device: false,
    // Claude Code 2.1.330 refreshes when now + 300000 >= expiresAt; its access token lasts 8 hours (checked on E2B with
    // a real login: not at 10 minutes before, yes at 4)
    refreshDue(files) {
      const at = Number(json(files, '.claude/.credentials.json')?.claudeAiOauth?.expiresAt)
      return at > 0 ? at - REFRESH_WINDOW_MS : 0
    },
    // the account in .credentials.json counts first, as Claude Code 2.1.330 writes it there too
    facts(files) {
      const at = Number(json(files, '.claude/.credentials.json')?.claudeAiOauth?.expiresAt)
      return { account: str(json(files, '.claude/.credentials.json')?.claudeAiOauth?.accountUuid) ?? str(json(files, '.claude/.claude.json')?.oauthAccount?.accountUuid), fresh: at > 0 ? at : 0 }
    },
  },
  models: {
    // the answer to its `initialize` control request (claude -p --input-format stream-json)
    protocol: 'claude',
    read: (raw) => raw.map((m) => ({
      id: String(m.value), name: String(m.displayName ?? m.value), description: String(m.description ?? ''),
      isDefault: m.value === 'default', efforts: m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? []).map(String),
      ...(m.resolvedModel ? { resolved: String(m.resolvedModel) } : {}),
    })),
  },
  // OpenCode's settings for Claude Code (docs/console/harnesses/claude-code): ANTHROPIC_BASE_URL with no /v1/messages,
  // and ANTHROPIC_AUTH_TOKEN, which Claude Code sends as `Authorization: Bearer`. Every model alias is the job's model,
  // so a background request of Claude Code (a small model) does not ask for a Claude model the plan does not have.
  plan: (o) => {
    const dir = `${o.home}/.byoa/plan/claude`
    return {
      dirs: [dir],
      env: {
        CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_BASE_URL: `${o.base}/anthropic`, ANTHROPIC_AUTH_TOKEN: o.token,
        ANTHROPIC_DEFAULT_OPUS_MODEL: o.model, ANTHROPIC_DEFAULT_SONNET_MODEL: o.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: o.model,
        ANTHROPIC_SMALL_FAST_MODEL: o.model, CLAUDE_CODE_SUBAGENT_MODEL: o.model,
      },
      args: modelArgs(o),
    }
  },
  // Claude Code's platform packages have their own names (@anthropic-ai/claude-code-linux-x64@<pin>)
  verify: { platformPrefix: 'claude-code-', platformOk: (name, version, pin) => name.startsWith(`${PACKAGES.claude}-`) && version === pin },
}
