// createAgents: the one object an app uses. It makes the parts and returns the API: the store (R6), the sandbox
// provider (R5.3), the login driver (R1), the MCP grants and their one refresh owner (R2, mcp/), the proxy (R3), the
// user's kept sandboxes (slots.ts), conversations (conversation.ts) and jobs (job.ts). Each harness is one adapter in
// harness/.
import { SERVER_NAME, serverUrl } from './config.ts'
import { conversations } from './conversation.ts'
import { importKey } from './crypto.ts'
import { isLab } from './harness/index.ts'
import { PINS, type HarnessName, type Pins } from './harness/pins.ts'
import type { ModelChoice, RunHarness } from './harness/types.ts'
import { jobs, type JobToken } from './job.ts'
import { storedLogin } from './login-stored.ts'
import type { LoginDeps, LoginDriver } from './login.ts'
import { mcpConnections } from './mcp/connect.ts'
import { Grants } from './mcp/grants.ts'
import { clientMetadataDocument, type OAuthConfig } from './mcp/oauth.ts'
import { JobTokens, mcpProxy } from './mcp/proxy.ts'
import { checkTools, type AppTools } from './mcp/tools.ts'
import { PLANS, RELAY_PREFIX, isPlan, planKeys, type PlanName, type PlanState } from './plan.ts'
import type { SandboxProvider } from './sandbox/types.ts'
import { slots } from './slots.ts'
import type { Store } from './store.ts'

export { LoginError } from './credential.ts'
export { ProxyError, taskText, type Job, type JobToken, type RunOptions, type Session, type SessionOptions, type Waiting } from './job.ts'
export type { ConnectResult } from './mcp/connect.ts'
export type { ModelChoice, RunHarness } from './harness/types.ts'

export interface AgentsOptions {
  /** The app's own name (lower-case letters, digits, -). It names this app's sandboxes, and every login volume of
   *  cliLogin, so one app's AI login is never another app's (Lab rules). */
  app: string
  sandbox: SandboxProvider
  store: Store
  /** 32 random bytes as base64 (openssl rand -base64 32). byoa encrypts every MCP grant (R2.4), every conversation's
   *  transcript (R5.9) and, by default, every AI login (R1.4) with it. */
  encryptionKey: string
  /** The public URL where the app serves `agents.proxy`, such as https://app.example.com/byoa/mcp. Each MCP server
   *  is at `<proxyUrl>/<name>`. */
  proxyUrl: string
  oauth: { redirectUrl: string; clientMetadataUrl?: string; clientName?: string }
  /** The harness versions (R5.1). Default: PINS; a harness that you leave out gets its PINS version. */
  pins?: Partial<Pins>
  /** Where the AI login stays (R1.5). Default: storedLogin(), encrypted in `store` (R1.4). `cliLogin`: in a volume
   *  of the user, through the sandbox adapter. */
  login?: (deps: LoginDeps) => LoginDriver
  /** The most one job may take. Default 30 minutes. */
  jobTimeoutMs?: number
  /** Where jobs run (R5.4). `user` (the default): byoa keeps the user's sandbox, pauses it after each job and resumes
   *  it for the next one. Each user has one for each harness, or one for each `sandboxKey` (such as a project) or
   *  `conversation` that a job names; one job of a sandbox runs at a time, and another waits. `job`: a new sandbox
   *  for each job, destroyed after it. */
  sandboxPer?: 'user' | 'job'
  /** With `sandboxPer: 'user'`: how long a job waits in line for the jobs before it in the same sandbox. Default: no
   *  limit; jobs of one sandbox run one after the other, in the order they came (R5.8). */
  waitMs?: number
  /** The model and effort of each harness when a job names none (R5.7), such as `{ claude: { model: 'opus' }, codex:
   *  { model: 'gpt-6.2-sol', effort: 'high' } }`. Default: the CLI's own. `listModels` lists what a user's plan has.
   *  `'opencode-go'`: for the jobs with that plan, of both harnesses, such as `{ model: 'kimi-k3.1-pro' }`. */
  models?: Partial<Record<HarnessName | PlanName, ModelChoice>>
  /** More origins that fetchWithGrant may send a grant's token to (R2.6), by the origin of the grant's MCP server:
   *  `{ 'https://margin.rippling.computer': ['https://helpful-tern-930.convex.site'] }`. Only for an API of that same
   *  service that takes the same token. Each key and value is an exact origin (https, or http on localhost): no path,
   *  no wildcard. */
  grantOrigins?: Record<string, string[]>
  /** The app's own tools (R2.7), as functions in this backend: MCP server name → tool name → tool. A job gets a group
   *  by its name in `mcp`. The proxy serves them at `<proxyUrl>/<name>` and gives `run` the user of the job, so the
   *  app writes no MCP server and connects nothing for each user. */
  tools?: AppTools
  /** The most bytes of one conversation's transcript that byoa keeps in the store, encrypted, so the conversation
   *  goes on when the provider loses its sandbox (R5.9). Default 700 000, below a Convex document's 1 MiB; 0 keeps
   *  none. A conversation with a larger transcript lives only in its sandbox. */
  transcriptBytes?: number
}

export type Agents = ReturnType<typeof createAgents>

export function createAgents(o: AgentsOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(o.app)) throw new Error('byoa: app: lower-case letters, digits and -, at most 24')
  if (!['user', 'job'].includes(o.sandboxPer ?? 'user')) throw new Error("byoa: sandboxPer: 'user' or 'job'")
  const key = importKey(o.encryptionKey)
  key.catch(() => {}) // reported where it is used
  const oauth: OAuthConfig = { redirectUrl: o.oauth.redirectUrl, clientMetadataUrl: o.oauth.clientMetadataUrl, clientName: o.oauth.clientName ?? o.app }
  const pins: Pins = { ...PINS, ...o.pins }
  const timeout = o.jobTimeoutMs ?? 30 * 60_000
  const keep = (o.sandboxPer ?? 'user') === 'user'
  const grants = new Grants(o.store, key, oauth)
  const tokens = new JobTokens(o.store)
  const plans = planKeys(o.store, key)
  const login = (o.login ?? storedLogin())({ sandbox: o.sandbox, store: o.store, app: o.app, pins, encryptionKey: o.encryptionKey, jobTimeoutMs: o.jobTimeoutMs })
  const sandboxes = slots(o.store, o.sandbox, { leaseMs: timeout + 5 * 60_000, waitMs: o.waitMs })
  const convs = conversations(o.store, key, { maxBytes: o.transcriptBytes ?? 700_000 })
  const tools: AppTools = o.tools ?? {}
  for (const [name, group] of Object.entries(tools)) {
    if (!SERVER_NAME.test(name)) throw new Error(`byoa: tools: server name ${JSON.stringify(name)}: lower-case letters, digits and -, at most 32`)
    checkTools(name, group)
  }
  const isTools = (name: string) => Object.prototype.hasOwnProperty.call(tools, name)
  /** The names a job can ask for in `mcp`: the user's connected servers, and the app's own tools. */
  const serversOf = async (user: string) => new Set([...(await grants.list(user)).map((g) => g.name), ...Object.keys(tools)])
  const mcp = mcpConnections({ app: o.app, store: o.store, key, oauth, grants, grantOrigins: o.grantOrigins, isTools })

  /** A job token for these servers, refused after close (R3.4) and after `ttlMs`. `plan`: the relay takes it for that
   *  plan (R1.8); jobs only. */
  async function issue(user: string, r: { mcp?: string[]; ttlMs?: number }, plan?: PlanName): Promise<JobToken> {
    const want = [...new Set(r.mcp ?? [])]
    const have = await serversOf(user)
    const servers = want.filter((s) => have.has(s))
    const { token, job } = await tokens.issue(user, servers, r.ttlMs ?? timeout + 5 * 60_000, plan)
    let closed = false
    return {
      token, job,
      mcp: servers.map((name) => ({ name, url: serverUrl(o.proxyUrl, name) })),
      missing: want.filter((s) => !have.has(s)),
      async close() { if (!closed) { closed = true; await tokens.end(job) } },
    }
  }

  const job = jobs({ app: o.app, proxyUrl: o.proxyUrl, sandbox: o.sandbox, login, plans, pins, models: o.models, timeout, keep, slots: sandboxes, conversations: convs, jobToken: issue, serversOf })

  /** Deletes the user's kept sandboxes of this app at this provider (R5.4): all of them, or those of one harness or one
   *  sandbox key. For sign-out, when the app deletes the user, and when it deletes a project or conversation that had
   *  a sandbox key. A job that runs in one of them ends. The AI login, the MCP grants and the conversations stay. */
  const deleteSandbox = (user: string, which: { harness?: RunHarness; sandboxKey?: string } = {}) =>
    sandboxes.remove(user, { harness: which.harness, key: which.sandboxKey })

  return {
    /** Starts the lab's own sign-in for the user (R1.1, R1.2): show `url` (and Codex's `code`) to the user. */
    connectLogin: (user: string, h: HarnessName) => login.start(user, h),
    /** Claude Code: pass the code Anthropic's page shows. Codex: call again until the state is not `pending`. With no
     *  code (Claude Code) and no wait, it only checks in: the sign-in sandbox lives while the app's sign-in UI calls it
     *  at least every 2 minutes, and ends 2 minutes after the last call (R1.7). */
    finishLogin: (user: string, h: HarnessName, input?: { code?: string; waitMs?: number }) => login.finish(user, h, input),
    /** Ends a sign-in that has not finished, and its sandbox, at once: call it when the user closes the sign-in. */
    cancelLogin: (user: string, h: HarnessName) => login.cancel(user, h),
    /** Keeps the user's key of a plan (R1.8): `'opencode-go'`, an OpenCode Console API key (`oc_sk_…`). byoa checks it
     *  with OpenCode first: `signed-in`; `no-plan` (kept: its workspace has no Go plan yet); or, when OpenCode refuses
     *  it, the state before with an `error`, and the key is not kept. */
    connectKey: (user: string, plan: PlanName, apiKey: string): Promise<{ state: PlanState; error?: string }> => {
      if (!isPlan(plan)) throw new Error(`byoa: plan: ${PLANS.join(', ')}`)
      return plans.connect(user, plan, apiKey)
    },
    /** `signed-in`, `signed-out` or `expired` (R1.6); for a plan's key also `no-plan`. */
    loginState: (user: string, h: HarnessName | PlanName): Promise<PlanState> => isPlan(h) ? plans.state(user, h) : login.state(user, h),
    /** Signs the user out with the CLI, deletes the stored login (or the login volume), and deletes the user's
     *  sandboxes of this harness. For a plan: deletes the user's key; the relay refuses the jobs that run with it. */
    signOut: async (user: string, h: HarnessName | PlanName) => {
      if (isPlan(h)) return plans.remove(user, h)
      if (!isLab(h)) throw new Error(`byoa: signOut: a harness or a plan`)
      await deleteSandbox(user, { harness: h }); await login.signOut(user, h)
    },
    deleteSandbox,
    /** Deletes a conversation of the user (R5.9): its sessions and transcripts in the store, of every harness, and its
     *  kept sandboxes. With no id: all of the user's conversations, such as when the app deletes the user. */
    deleteConversation: async (user: string, conversation?: string) => {
      const gone = await convs.remove(user, conversation)
      const ids = conversation === undefined ? [...new Set(gone.map(([, c]) => c))] : [conversation]
      for (const id of ids) await deleteSandbox(user, { sandboxKey: id })
    },
    connectMcp: mcp.connectMcp,
    importMcp: mcp.importMcp,
    finishMcp: mcp.finishMcp,
    fetchWithGrant: mcp.fetchWithGrant,
    listMcp: (user: string) => grants.list(user),
    removeMcp: (user: string, name: string) => grants.remove(user, name),
    run: job.run,
    /** Opens one job (R5.4) for an app that runs its own program around the unmodified harness (Bookish runs its own
     *  core, which starts `claude`, `codex` or `grok`): the user's sandbox (or, with `sandboxPer: 'job'`, a new one)
     *  with the user's AI login, the pinned harness, the user's setup in a new `work` folder, and a job token for the
     *  MCP servers this job gets. `close` ends the job token, saves the login and removes it from the sandbox, and
     *  pauses the sandbox (or destroys it); call it in a `finally`. Throws LoginError when the harness is not signed
     *  in. */
    session: job.session,
    listModels: job.listModels,
    /** A job token with no sandbox (R3), for an app's own program that runs a harness somewhere else, such as on the
     *  user's own computer. The same rules as a job's token: one user, only the servers named that this user has
     *  connected, refused after `close` (R3.4) and after `ttlMs` (default: the job timeout and 5 minutes). */
    jobToken: (user: string, r: { mcp?: string[]; ttlMs?: number } = {}, /** @internal */ plan?: PlanName) => issue(user, r, plan),
    /** The MCP proxy, a fetch handler (Request → Response). Serve it at `proxyUrl` and below. */
    proxy: mcpProxy({ proxyUrl: o.proxyUrl, jobs: tokens, grants, tools, relay: { prefix: RELAY_PREFIX, handle: plans.relay } }),
    /** The Client ID Metadata Document to serve at `oauth.clientMetadataUrl`. */
    clientMetadata: () => clientMetadataDocument(oauth),
  }
}
