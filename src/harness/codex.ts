// Codex: `codex app-server`, the JSON-RPC server that OpenAI's own clients use, under byoa's driver, so a running job
// takes more messages (R5.10). Flags checked against `codex app-server --help` of codex-cli 0.171.0, and the protocol
// against its `codex app-server generate-json-schema`.
import { JOB_TOKEN_ENV, MCP_STARTUP_SEC, serverUrl, tomlString } from '../config.ts'
import { driver, driverFailure } from './driver.ts'
import { clip, codeOf, errorEvent, type AgentEvent, type ErrorCode, type EventReader } from './events.ts'
import { installPinned } from './install.ts'
import { PACKAGES } from './pins.ts'
import { REFRESH_WINDOW_MS, type JobArgs, type LabHarness, type ModelChoice } from './types.ts'

const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
const auth = (files: Record<string, string>) => { try { return JSON.parse(files['.codex/auth.json'] ?? '') } catch { return undefined } }

/** The config keys `model` and `model_reasoning_effort` (low, medium, high, xhigh, max, ultra in codex-cli 0.171.0's
 *  model catalog; which ones a model takes is in its `efforts` from listModels). `-c` works for every Codex command. */
const modelArgs = (o: ModelChoice): string[] =>
  [...(o.model ? ['-c', `model=${JSON.stringify(o.model)}`] : []), ...(o.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(o.effort)}`] : [])]

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
  return r === undefined || r === null ? '' : JSON.stringify(r)
}
/** The code of a failure (R1.9): Codex's own `codexErrorInfo` (0.171.0, protocol/src/error.rs), else its text.
 *  usageLimitExceeded is a used-up plan (and a ChatGPT workspace out of credits or over its spend cap);
 *  rateLimitExceeded, serverOverloaded and the capacity codes are for now; unauthorized is a refresh that failed. An
 *  HTTP failure names its status. */
function codexCode(info: unknown, message: string): ErrorCode {
  if (info === 'usageLimitExceeded') return 'usage-limit'
  if (info === 'rateLimitExceeded' || info === 'serverOverloaded' || info === 'policyCapacityUnavailable' || info === 'flexUnavailable') return 'rate-limited'
  if (info === 'unauthorized') return 'expired'
  const status = info && typeof info === 'object' ? Number((Object.values(info)[0] as any)?.httpStatusCode) : 0
  if (status === 401) return 'expired'
  if (status === 429) return 'rate-limited'
  return codeOf(message)
}
/** When a used-up plan resets (ms since 1970): the latest of the windows that are used up, in the last rate limits
 *  Codex sent (`account/rateLimits/updated`, which it sends from the refused response's headers before the error). */
const resetOf = (limits: any): number | undefined => {
  const ends = [limits?.primary, limits?.secondary].filter((w) => w && Number(w.usedPercent) >= 100 && Number(w.resetsAt) > 0).map((w) => Number(w.resetsAt) * 1000)
  return ends.length ? Math.max(...ends) : undefined
}
const failure = (message: string, info?: unknown, limits?: unknown): AgentEvent[] => {
  const code = codexCode(info, message)
  return [errorEvent(message, code, code === 'usage-limit' ? resetOf(limits) : undefined), { type: 'end', ok: false }]
}

/** The app server's notifications (codex-cli 0.171.0, `codex app-server generate-json-schema`): thread/started (the
 *  thread id), item/started and item/completed (userMessage, agentMessage, mcpToolCall, commandExecution, ...),
 *  thread/tokenUsage/updated (the tokens of each model call, `last`), account/rateLimits/updated (the plan's windows),
 *  error (with `codexErrorInfo`), and turn/completed, one for each turn. */
function codexReader(): EventReader {
  let ended = false, last = '', failed = '', info: unknown, limits: any, session: string | undefined, taken = 0
  let usage = { input: 0, output: 0, cached: 0 }
  return {
    get session() { return session },
    get taken() { return taken },
    line(l): AgentEvent[] {
      let ev: any
      try { ev = JSON.parse(l) } catch { return [] }
      const why = driverFailure(ev)
      if (why !== undefined) { ended = true; return failure(why) }
      const p = ev?.params ?? {}, it = p.item
      switch (ev?.method) {
        case 'thread/started': if (typeof p.thread?.id === 'string' && p.thread.id) session = p.thread.id; return []
        // `ended`: the last turn has ended; a driver can start another one (R5.10)
        case 'turn/started': ended = false; return []
        case 'item/started':
          switch (it?.type) {
            // each message of the job, when Codex takes it into a turn: the task, a steer, or a new turn (R5.10)
            case 'userMessage': taken++; return []
            case 'mcpToolCall': return [{ type: 'tool_call', id: String(it.id), name: String(it.tool), server: String(it.server), input: it.arguments ?? {} }]
            case 'commandExecution': return [{ type: 'tool_call', id: String(it.id), name: 'shell', input: { command: it.command } }]
            default: return []
          }
        case 'item/completed':
          switch (it?.type) {
            case 'agentMessage': last = String(it.text ?? ''); return last ? [{ type: 'text', text: last }] : []
            case 'mcpToolCall': return [{ type: 'tool_result', id: String(it.id), ok: it.status !== 'failed' && !it.error, output: clip(it.error ? String(it.error.message ?? it.error) : out(it.result)) }]
            case 'commandExecution': return [{ type: 'tool_result', id: String(it.id), ok: it.exitCode === 0, output: clip(String(it.aggregatedOutput ?? '')) }]
            default: return []
          }
        case 'thread/tokenUsage/updated': {
          const u = p.tokenUsage?.last ?? {}
          usage = { input: usage.input + (Number(u.inputTokens) || 0), output: usage.output + (Number(u.outputTokens) || 0), cached: usage.cached + (Number(u.cachedInputTokens) || 0) }
          return []
        }
        // a sparse update: its values go on top of the last ones
        case 'account/rateLimits/updated': if (p.rateLimits) limits = { ...limits, ...Object.fromEntries(Object.entries(p.rateLimits).filter(([, v]) => v != null)) }; return []
        // an error that Codex retries is not the turn's end
        case 'error': if (!p.willRetry) { failed = String(p.error?.message ?? ''); info = p.error?.codexErrorInfo ?? info }; return []
        case 'turn/completed': {
          const t = p.turn ?? {}, u = usage
          usage = { input: 0, output: 0, cached: 0 }
          ended = true
          if (t.status === 'completed') return [{ type: 'end', ok: true, result: last, usage: u }]
          return failure(String(t.error?.message || failed || `the turn ${t.status ?? 'failed'}`), t.error?.codexErrorInfo ?? info, limits)
        }
        default: return []
      }
    },
    exit(code, stderr) {
      if (ended) return []
      return failure(failed || stderr.trim().split('\n').slice(-3).join(' ') || `codex exited with code ${code}`, info, limits)
    },
  }
}

/** Codex's app server (R5.10): one thread, new or resumed (R5.9), and a turn for the task. A message that comes while a
 *  turn runs steers it (`turn/steer`, which needs the running turn's id); one that comes after starts the next turn.
 *  The approval policy is `never`, so the server asks the driver nothing. Checked with 0.171.0: a steered message is a
 *  userMessage item of the running turn, and the model answers both. */
const CODEX_DRIVER = driver(String.raw`
let thread, turn
const r = rpc((m, l) => {
  if (m.id !== undefined) return r.refuse(m.id, 'byoa answers no request')
  if (m.method === 'turn/started') turn = m.params.turn.id
  if (m.method === 'turn/completed') turn = undefined
  print(l)
})
let chain = (async () => {
  await r.call('initialize', { clientInfo: { name: 'byoa', version: '1' } })
  r.notify('initialized')
  // R5.6 read-only: Codex's own permission profile, extended from its :read-only, with no network and with CODEX_HOME,
  // which holds the login, denied to each command, so the agent cannot read the login. A profile needs no sandbox
  // mode: Codex ignores default_permissions when one is given.
  const home = process.env.CODEX_HOME
  const readOnly = { default_permissions: 'byoa-read-only', permissions: { 'byoa-read-only': { extends: ':read-only', filesystem: { [home]: 'deny' }, network: { enabled: false } } } }
  const o = setup.readOnly ? { cwd: setup.cwd, approvalPolicy: 'never', config: readOnly } : { cwd: setup.cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' }
  thread = (setup.resume ? await r.call('thread/resume', { ...o, threadId: setup.resume }) : await r.call('thread/start', { ...o, ephemeral: setup.ephemeral })).thread.id
})()
const say = async (text) => {
  const input = [{ type: 'text', text }]
  if (turn) {
    try { await r.call('turn/steer', { threadId: thread, expectedTurnId: turn, input }); return } catch {}
    // the turn ended meanwhile: the message starts the next one
  }
  turn = (await r.call('turn/start', { threadId: thread, input })).turn.id
}
inbox((text) => { chain = chain.then(() => say(text)).catch(fail) }, () => { chain = chain.then(close) })
`)

export const codex: LabHarness = {
  name: 'codex',
  // the Codex login (`auth.json`), its sessions and settings; CODEX_HOME's default
  home: { dir: '.codex', env: 'CODEX_HOME' },
  env: {},
  install: (sbx, pins) => installPinned(sbx, { name: 'codex', pkg: PACKAGES.codex, pin: pins.codex }),
  command: (bin, args) => [bin, ...args],
  args: (o: JobArgs) => [
    'app-server',
    // Codex reads the job's `.codex/config.toml` only in a trusted project; this marks the job's folder trusted for
    // this run only (0.171.0: a dotted `projects."<dir>".trust_level` is not applied, the inline table is)
    '-c', `projects={${JSON.stringify(o.work)}={trust_level="trusted"}}`,
    ...o.model,
  ],
  modelArgs,
  reader: codexReader,
  files: {
    // Codex reads `.agents/skills`
    skills: '.agents/skills',
    claudeMd: false,
    mcpPath: '.codex/config.toml',
    // TOML. With its sandbox on, Codex asks before each MCP tool call, and with the approval policy `never` nobody is
    // asked: it refuses the call. The job's servers are the ones the app chose for it (R2.5), so their tools need no approval.
    mcp(servers, o) {
      if (!servers.length) return undefined
      const approve = o.access === 'read-only' ? 'default_tools_approval_mode = "approve"\n' : ''
      return 'mcp_optional_startup_grace_ms = 0\n\n' + servers.map((s) =>
        `[mcp_servers.${s}]\nurl = ${tomlString(serverUrl(o.proxyUrl, s))}\nbearer_token_env_var = "${JOB_TOKEN_ENV}"\nstartup_timeout_sec = ${MCP_STARTUP_SEC}\n${approve}`).join('\n')
    },
  },
  driver: {
    js: CODEX_DRIVER,
    setup: (o) => ({
      cwd: o.work,
      // R5.6: Codex's own sandbox, with the driver's permission profile. Its shell stays, because Codex reads a skill
      // with `cat`, but a command cannot change a file, reach the network or read CODEX_HOME (the login); the job's MCP
      // tools are approved in config.toml. Checked with 0.171.0 on E2B: the skill was read, the MCP call went through,
      // and `echo x > file`, `curl` and `cat $CODEX_HOME/auth.json` failed. With `full`, no sandbox: the sandbox is the
      // job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4).
      readOnly: o.access === 'read-only',
      // R5.9: a conversation's first job keeps its thread (not ephemeral), which Codex names in thread/started; the
      // next jobs resume it (checked with 0.171.0: also from the rollout file alone, in a new CODEX_HOME)
      ephemeral: !o.conversation,
      ...(o.conversation?.resume ? { resume: o.conversation.session } : {}),
    }),
  },
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
