// Grok Build: `grok -p` with `--output-format streaming-messages-json`, which prints Claude Code's stream-json shape
// (system/init, assistant, user, result). Flags checked against `grok --help` of 1.0.92.
// Differences from Claude Code: an MCP tool is called through Grok's `use_tool` meta-tool, whose input names the tool
// as `<server>__<tool>`; `result` has no `permission_denials`; an all-zero `usage` means unknown, not free; and its
// headless mode has no input format for more messages, so a running job takes none.
import { JOB_TOKEN_ENV, MCP_STARTUP_SEC, serverUrl, tomlString } from '../config.ts'
import { streamJsonReader, type AgentEvent, type EventReader } from './events.ts'
import { installPinned } from './install.ts'
import { PACKAGES } from './pins.ts'
import { REFRESH_WINDOW_MS, type JobArgs, type LabHarness, type ModelChoice } from './types.ts'

/** The built-in tools of a `read-only` job (R5.6): they read files. Grok loads a skill with its own skill tool, which
 *  runs in every permission mode, and its MCP meta-tools stay with `--tools`. No shell and no edit tool, so nothing the
 *  agent runs can change a file or open a connection. */
const READ_TOOLS = ['read_file', 'grep', 'list_dir']

/** Grok's own postinstall (1.0.92) unpacks its native binary twice: beside its launcher (`bin/grok` becomes a link to
 *  `bin/grok-native`, which V11 checks) and into `$GROK_HOME/bin`, with a `config.toml` there. The second copy is for
 *  Grok's own updater, which byoa turns off, so it goes to a folder that byoa removes after the install, not into the
 *  user's `~/.grok`, where the login is. */
export const GROK_INSTALL = { env: { GROK_HOME: '/tmp/byoa-grok-install' }, after: 'rm -rf /tmp/byoa-grok-install' }

/** `-m` and `--reasoning-effort` (`grok --help` of 1.0.92); a model's own efforts are in its `efforts` from
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

function grokReader(): EventReader {
  const inner = streamJsonReader('grok')
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
    get session() { return inner.session },
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

export const grok: LabHarness = {
  name: 'grok',
  // Grok keeps auth.json, its sessions and its settings in GROK_HOME
  home: { dir: '.grok', env: 'GROK_HOME' },
  env: { GROK_DISABLE_AUTOUPDATER: '1' },
  npm: GROK_INSTALL,
  install: (sbx, pins) => installPinned(sbx, { name: 'grok', pkg: PACKAGES.grok, pin: pins.grok, npm: GROK_INSTALL }),
  command: (bin, args) => [bin, ...args],
  args: (o: JobArgs) => [
    // --trust: Grok reads the job folder's AGENTS.md, skills and `.grok/config.toml` (the MCP servers) only in a
    // trusted folder; it is a global flag, so it comes first. The prompt comes from stdin.
    '--trust', '-p', '--output-format', 'streaming-messages-json',
    // byoa runs the pinned version (R5.1); a job keeps no memory for the next one (its own conversation is R5.9)
    '--no-auto-update', '--no-memory',
    ...(o.access === 'read-only'
      // R5.6: only the tools that read, and the MCP tools; `dontAsk` refuses every call with no allow rule. Web
      // search runs with no approval in every mode, so it is off. Not `--sandbox read-only`: on Linux grok 1.0.92
      // refuses to start under it without bubblewrap, which E2B's sandboxes do not have.
      // `MCPTool(*)`, not one rule per server: Grok calls MCP tools through `use_tool`, and a `use_tool` call that no
      // allow rule covers (the agent tried `write_file` through it) is a refusal, which in `-p` ends the whole run as
      // `cancelled`. With the rule, such a call gets an error back and the job goes on. Grok sees only the job's MCP
      // servers: byoa writes no other MCP config. Checked on E2B: no file written, no shell, the MCP call went through.
      ? ['--permission-mode', 'dontAsk', '--disable-web-search', '--tools', READ_TOOLS.join(','), '--allow', 'MCPTool(*)']
      // the sandbox is the job's alone, has no real tokens (R3.3), and is destroyed after the job (R5.4)
      : ['--permission-mode', 'bypassPermissions']),
    // R5.9: Grok saves every session, also headless. A conversation's first job names its session (`-s`, a new UUID),
    // and the next ones resume it by that id (`-r`); its docs: a UUID-shaped value is always an id, never a title
    ...(o.conversation ? (o.conversation.resume ? ['-r', o.conversation.session!] : ['-s', o.conversation.session!]) : []),
    ...o.model,
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
    mcp: (servers, o) => servers.length ? servers.map((s) =>
      `[mcp_servers.${s}]\nurl = ${tomlString(serverUrl(o.proxyUrl, s))}\nheaders = { Authorization = "Bearer \${${JOB_TOKEN_ENV}}" }\nstartup_timeout_sec = ${MCP_STARTUP_SEC}\n`).join('\n') : undefined,
  },
  // `grok -p` reads its prompt to the end of stdin, and its headless mode reads no more messages while it runs
  input: 'text',
  // its docs: `$GROK_HOME/sessions/<the cwd, URL-encoded>/<id>/` (summary.json, updates.jsonl, chat_history.jsonl, ...)
  conversation: { choose: true, byFolder: true, transcript: (s) => [`sessions/*/${s}/*`] },
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
