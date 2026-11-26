// Grok Build: `grok agent stdio`, its Agent Client Protocol (ACP) server, under byoa's driver, so a running job takes
// more messages (R5.10). Flags checked against `grok agent --help` of 1.0.92, and the protocol against its bundled
// docs (ACP, and the `x.ai/` extensions) and its answers.
import { JOB_TOKEN_ENV, MCP_STARTUP_SEC, serverUrl, tomlString } from '../config.ts'
import { driver, driverFailure } from './driver.ts'
import { AUTH_FAILED, clip, codeOf, errorEvent, type AgentEvent, type ErrorCode, type EventReader } from './events.ts'
import { installPinned } from './install.ts'
import { PACKAGES } from './pins.ts'
import { REFRESH_WINDOW_MS, type JobArgs, type LabHarness, type ModelChoice } from './types.ts'

/** Grok's own postinstall (1.0.92) unpacks its native binary twice: beside its launcher (`bin/grok` becomes a link to
 *  `bin/grok-native`, which V11 checks) and into `$GROK_HOME/bin`, with a `config.toml` there. The second copy is for
 *  Grok's own updater, which byoa turns off, so it goes to a folder that byoa removes after the install, not into the
 *  user's `~/.grok`, where the login is. */
export const GROK_INSTALL = { env: { GROK_HOME: '/tmp/byoa-grok-install' }, after: 'rm -rf /tmp/byoa-grok-install' }

/** `-m` and `--reasoning-effort`, options of `grok agent` (1.0.92); a model's own efforts are in its `efforts` from
 *  listModels. */
const modelArgs = (o: ModelChoice): string[] => [...(o.model ? ['-m', o.model] : []), ...(o.effort ? ['--reasoning-effort', o.effort] : [])]

/** Grok's `auth.json` (1.0.92): one login for each sign-in scope, keyed by `<issuer>::<client id>`, each with its
 *  `user_id` and the time its access token ends (`expires_at`). byoa reads these two fields only. */
function logins(files: Record<string, string>): { user_id?: unknown; expires_at?: string }[] {
  try {
    const doc = JSON.parse(files['.grok/auth.json'] ?? '')
    return Object.values(doc ?? {}).filter((v): v is { user_id?: unknown; expires_at?: string } => !!v && typeof v === 'object' && !Array.isArray(v))
  } catch { return [] }
}
/** The first of the logins to end (ms since 1970), 0 when one does not say. */
const firstEnd = (files: Record<string, string>) => {
  const ends = logins(files).map((l) => Date.parse(l.expires_at ?? ''))
  return ends.length && ends.every((t) => t > 0) ? Math.min(...ends) : 0
}

/** An MCP tool, as Grok names it: `<server>__<tool>`. */
const mcpName = (n: unknown): { server: string; name: string } | undefined => {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*?)__(.+)$/.exec(String(n ?? ''))
  return m ? { server: m[1]!, name: m[2]! } : undefined
}

/** Grok 1.0.92 wraps a tool's output in its own JSON ({ type: 'MCP', ..., output: { OkayOutput: '<the text>' } }): the
 *  tool's own text, as for the other harnesses. */
const unwrap = (text: string): string => {
  let w: any
  try { w = JSON.parse(text) } catch { return text }
  const inner = w && typeof w === 'object' && w.output && typeof w.output === 'object' ? Object.values(w.output) : []
  return inner.length === 1 && typeof inner[0] === 'string' ? inner[0] : text
}
const contentText = (c: unknown): string => Array.isArray(c)
  ? c.map((x: any) => x?.content?.text ?? x?.text ?? '').join('')
  : typeof c === 'string' ? c : ''
/** Grok's own words for a login that does not work. */
const GROK_AUTH = new RegExp(`${AUTH_FAILED.source}|authentication required|unauthorized \\(401\\)`, 'i')
/** The code of a failed turn (R1.9): its text first, because Grok 1.0.92 also classes a 503 or 529 (overloaded) as
 *  `rate_limit`; then `error_kind` of turn_completed, with the kinds its binary names. Grok says no reset time. */
function grokCode(message: string, kind: unknown): ErrorCode {
  const code = codeOf(message, GROK_AUTH)
  if (code !== 'harness') return code
  const k = String(kind ?? '')
  if (k === 'authentication_failed' || k === 'unauthorized') return 'expired'
  if (k === 'usage_limit_reached' || k === 'free_usage_exhausted' || k === 'usage_pool_exhausted') return 'usage-limit'
  if (k === 'rate_limit' || k === 'rate_limited' || k === 'overloaded' || k === 'global_rate_limit' || k === 'concurrency_limit') return 'rate-limited'
  return 'harness'
}
const failure = (message: string, kind?: unknown): AgentEvent[] => [errorEvent(message, grokCode(message, kind)), { type: 'end', ok: false }]

/** ACP's session/update notifications (agent_message_chunk, tool_call, tool_call_update) and Grok's own: each message
 *  that it takes into a turn (`_x.ai/session/interjection`, and the driver's line for each prompt), and the end of each
 *  turn (`turn_completed`, with its stop reason and usage). Checked with 1.0.92. */
function grokReader(): EventReader {
  let ended = false, session: string | undefined, taken = 0, text = '', last = ''
  const calls = new Set<string>()
  /** The agent's text so far, as one event: at a tool call and at the end of the turn. */
  const flush = (): AgentEvent[] => {
    const t = text.trim()
    text = ''
    if (!t) return []
    last = t
    return [{ type: 'text', text: t }]
  }
  const call = (u: any): AgentEvent => {
    const input = u.rawInput ?? {}
    // use_tool, the meta-tool that calls an MCP tool: report the MCP tool itself
    const t = mcpName(input?.tool_name)
    if (t) return { type: 'tool_call', id: String(u.toolCallId), ...t, input: input?.tool_input ?? {} }
    return { type: 'tool_call', id: String(u.toolCallId), name: String(u._meta?.['x.ai/tool']?.name ?? u.title ?? 'tool'), input }
  }
  const end = (u: any): AgentEvent[] => {
    ended = true
    const out = flush()
    const n = u.usage ?? {}
    const input = Number(n.inputTokens) || 0, output = Number(n.outputTokens) || 0
    // Grok writes 0 for usage it does not know: all-zero usage is unknown, not free
    const usage = input || output ? { usage: { input, output, cached: Number(n.cachedReadTokens) || 0 } } : {}
    if (u.stop_reason === 'end_turn') return [...out, { type: 'end', ok: true, result: last, ...usage }]
    const [error] = failure(String(u.agent_result || `the turn ended: ${u.stop_reason}`), u.error_kind)
    return [...out, error!, { type: 'end', ok: false, ...usage }]
  }
  return {
    get session() { return session },
    get taken() { return taken },
    line(l): AgentEvent[] {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      const why = driverFailure(ev)
      if (why !== undefined) { ended = true; return failure(why) }
      switch (ev?.byoa) {
        case 'session': session = String(ev.id); return []
        case 'taken': taken++; ended = false; return []
        case 'denied': return [{ type: 'permission', tool: String(ev.toolCall?._meta?.['x.ai/tool']?.name ?? ev.toolCall?.title ?? 'tool'), decision: 'denied', input: ev.toolCall?.rawInput }]
      }
      const u = ev?.params?.update ?? {}
      switch (ev?.method) {
        case '_x.ai/session/interjection': taken++; ended = false; return []
        case '_x.ai/session_notification': return u.sessionUpdate === 'turn_completed' ? end(u) : []
        case 'session/update': break
        default: return []
      }
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': text += u.content?.type === 'text' ? String(u.content.text ?? '') : ''; return []
        case 'tool_call':
          calls.add(String(u.toolCallId))
          return [...flush(), call(u)]
        case 'tool_call_update': {
          const id = String(u.toolCallId)
          if (!calls.has(id) || (u.status !== 'completed' && u.status !== 'failed')) return []
          calls.delete(id)
          // the tool's text (a command's output, a file read, a refusal); an MCP call has only Grok's own JSON in rawOutput
          const raw = u.rawOutput === undefined ? '' : typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput)
          return [{ type: 'tool_result', id, ok: u.status === 'completed', output: clip(contentText(u.content) || unwrap(raw)) }]
        }
        default: return []
      }
    },
    exit(code, stderr) {
      if (ended) return []
      return failure(stderr.trim().split('\n').slice(-3).join(' ') || `grok exited with code ${code}`)
    },
  }
}

/** ACP (R5.10): one session, new or resumed (R5.9), and session/prompt for the task. A message that comes while a turn
 *  runs goes to Grok's `x.ai/interject` extension (`_x.ai/interject` on the wire, as ACP names extensions), which Grok's
 *  own TUI uses to steer: Grok gives it to the agent at its next step, or, when the turn ended meanwhile, runs a turn
 *  for it. One that comes after starts the next turn. A turn runs from the prompt or the interjection Grok took until
 *  its `turn_completed`. Grok asks for permission only in a read-only job (the rules in `.grok/config.toml` deny the
 *  tools that change files, so it seldom does), and the driver refuses: Grok then ends the turn. */
const GROK_DRIVER = driver(String.raw`
let session, running = false, interjecting = 0
const r = rpc((m, l) => {
  if (m.method === 'session/request_permission') {
    const no = (m.params?.options ?? []).find((x) => x.kind === 'reject_once')
    print({ byoa: 'denied', toolCall: m.params?.toolCall })
    return r.answer(m.id, { outcome: no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } })
  }
  if (m.id !== undefined) return r.refuse(m.id, 'byoa answers no request')
  if (m.method === '_x.ai/session/interjection') { interjecting--; running = true }
  if (m.method === '_x.ai/session_notification' && m.params?.update?.sessionUpdate === 'turn_completed') running = false
  print(l)
})
let chain = (async () => {
  await r.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const o = { cwd: setup.cwd, mcpServers: [] }
  if (setup.resume) await r.call('session/resume', { ...o, sessionId: setup.resume })
  session = setup.resume ?? (await r.call('session/new', o)).sessionId
  print({ byoa: 'session', id: session })
})()
const say = async (text) => {
  // an interjection that Grok has not taken yet still gets a turn: the next message goes with it
  if (running || interjecting) { interjecting++; await r.call('_x.ai/interject', { sessionId: session, text }); return }
  running = true
  print({ byoa: 'taken' })
  // its turn_completed ends the turn; an answer with an error and no turn_completed is a turn that did not start
  r.call('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] }).catch((e) => { if (running) fail(e) })
}
inbox((text) => { chain = chain.then(() => say(text)).catch(fail) }, () => { chain = chain.then(close) })
`)

/** R5.6, read-only: rules for the project `.grok/config.toml`, which Grok reads in a trusted folder. Grok runs the
 *  tools that read with no prompt (read_file, list_dir, grep, its skill tool, web_search); these deny the shell (its
 *  read-only commands include mkdir and touch), file changes and web_fetch, and allow the job's MCP tools. A denied
 *  call is an error for the model, and the turn goes on. Checked with 1.0.92 over ACP. */
const READ_ONLY_RULES = '[permission]\ndeny = ["Bash", "Write", "Edit", "WebFetch"]\nallow = ["MCPTool(*)"]\n'
/** R5.6, read-only: web_search through `GROK_CONFIG`, the config overlay for an ACP client, which may set its domains:
 *  only a domain that does not exist. Its `disable_web_search` is not one of the overlay's settings. */
const NO_WEB_SEARCH = JSON.stringify({ toolset: { web_search: { allowed_domains: ['byoa.invalid'] } } })

export const grok: LabHarness = {
  name: 'grok',
  // Grok keeps auth.json, its sessions and its settings in GROK_HOME
  home: { dir: '.grok', env: 'GROK_HOME' },
  env: { GROK_DISABLE_AUTOUPDATER: '1' },
  // a job keeps no memory of Grok's own for the next one (its conversation is R5.9)
  jobEnv: { GROK_MEMORY: '0' },
  npm: GROK_INSTALL,
  install: (sbx, pins) => installPinned(sbx, { name: 'grok', pkg: PACKAGES.grok, pin: pins.grok, npm: GROK_INSTALL }),
  command: (bin, args) => [bin, ...args],
  args: (o: JobArgs) => [
    // --trust: Grok reads the job folder's AGENTS.md, skills and `.grok/config.toml` (the MCP servers) only in a
    // trusted folder. It and --no-auto-update (byoa runs the pinned version, R5.1) are global flags, so they come first.
    '--trust', '--no-auto-update', 'agent',
    // `full`: no tool asks for permission; the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed
    // after the job (R5.4). `read-only`: READ_ONLY_RULES and NO_WEB_SEARCH.
    ...(o.access === 'read-only' ? [] : ['--always-approve']),
    ...o.model,
    'stdio',
  ],
  modelArgs,
  reader: grokReader,
  files: {
    // Grok reads `.agents/skills` (only in a trusted folder: it runs with --trust)
    skills: '.agents/skills',
    claudeMd: false,
    mcpPath: '.grok/config.toml',
    // a project `.grok/config.toml`, read in a trusted folder. Grok expands `${VAR}` in a server's headers, and waits
    // `startup_timeout_sec` for it to start (its own default is 30). Checked with grok 1.0.92.
    mcp(servers, o) {
      const toml = [...servers.map((s) =>
        `[mcp_servers.${s}]\nurl = ${tomlString(serverUrl(o.proxyUrl, s))}\nheaders = { Authorization = "Bearer \${${JOB_TOKEN_ENV}}" }\nstartup_timeout_sec = ${MCP_STARTUP_SEC}\n`),
      ...(o.access === 'read-only' ? [READ_ONLY_RULES] : [])]
      return toml.length ? toml.join('\n') : undefined
    },
  },
  driver: {
    js: GROK_DRIVER,
    setup: (o) => ({
      cwd: o.work,
      ...(o.conversation?.resume ? { resume: o.conversation.session } : {}),
      ...(o.access === 'read-only' ? { env: { GROK_CONFIG: NO_WEB_SEARCH } } : {}),
    }),
  },
  // ACP's session/new names the session. Its docs: `$GROK_HOME/sessions/<the cwd, URL-encoded>/<id>/` (summary.json,
  // updates.jsonl, chat_history.jsonl, ...); session/resume continues it, with no replay of its history.
  conversation: { choose: false, byFolder: true, transcript: (s) => [`sessions/*/${s}/*`] },
  login: {
    files: ['.grok/auth.json'],
    // grok 1.0.92: https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH, then the code again on its own line
    url: /https:\/\/accounts\.x\.ai\/[^\s\x07\x1b]+/,
    signIn: 'login --device-auth',
    signOut: 'logout',
    device: true,
    // grok 1.0.92 refreshes 5 minutes before (GROK_AUTH_EARLY_INVALIDATION_SECS); its access token lasts 6 hours
    // (checked on E2B with a real login: not at 10 minutes before, yes at 4, with a new refresh token)
    refreshDue: (files) => { const t = firstEnd(files); return t ? t - REFRESH_WINDOW_MS : 0 },
    // the account is `user_id`, and a refresh moves `expires_at`
    facts(files) {
      const ids = [...new Set(logins(files).map((l) => (typeof l.user_id === 'string' && l.user_id ? l.user_id : undefined)))]
      return { account: ids.length && ids.every(Boolean) ? ids.sort().join(',') : undefined, fresh: firstEnd(files) }
    },
  },
  models: {
    // its agent mode (`grok agent stdio`, ACP) answers `initialize` with its `modelState`
    protocol: 'acp',
    read: (raw) => raw.map((m) => ({
      id: String(m.modelId), name: String(m.name ?? m.modelId), description: String(m.description ?? ''), isDefault: !!m.isDefault,
      efforts: m._meta?.supportsReasoningEffort === false ? [] : (m._meta?.reasoningEfforts ?? []).map((e: any) => String(e.value ?? e.id ?? e)),
    })),
  },
  // Grok's platform packages are @xai-official/grok-linux-x64@<pin>
  verify: { platformPrefix: 'grok-', platformOk: (name, version, pin) => name.startsWith(`${PACKAGES.grok}-`) && version === pin },
}
