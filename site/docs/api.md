# API reference

This page is the agent skill's API reference, [skills/byoa/reference/api.md](https://byoa.rippling.computer/docs/api.md), so a coding agent and you read the same text.

This is the API in https://github.com/madeyexz/byoa today. Version 1.0.0 is on npm; conversations (`conversation`, `Job.send`, `deleteConversation`, `transcriptBytes`), `readFile` and `capabilities` are on `main` and come in the next release. The source of truth is `src/agents.ts`, `src/index.ts` and the files they import.

## Imports

| Import | What it gives |
|---|---|
| `@madeyexz/byoa` | `createAgents`, `LoginError`, `ProxyError`, `SandboxGoneError`, `memoryStore`, `storedLogin`, `cliLogin`, `harnessFiles`, `readPlugin`, `JOB_TOKEN_ENV`, `PINS`, `PACKAGES`, `ensureHarness`, `LOGIN_FILES`, `clientMetadataDocument`, `PLANS`; types `Agents` (what `createAgents` returns), `AgentsOptions`, `RunOptions`, `Job` (what `run` returns), `RunHarness`, `ConnectResult`, `Session`, `SessionOptions`, `JobToken`, `Store`, `Entry`, `Sandbox`, `SandboxProvider`, `Capabilities`, `AgentEvent`, `Usage`, `AppTools`, `AppTool`, `Access`, `Setup`, `Skill`, `Plugin`, `LoginState`, `LoginStart`, `LoginResult`, `PlanName`, `PlanState` |
| `@madeyexz/byoa/sandbox/e2b` | `e2b({ apiKey?, template?, timeoutMs? })`, `buildE2BTemplate(name?, { apiKey?, pins? })`, `e2bTemplate(pins?)`. Needs the `e2b` package. |
| `@madeyexz/byoa/sandbox/daytona` | `daytona({ apiKey?, client?, snapshot?, volume?, timeoutMs? })`. Needs `@daytona/sdk`. |
| `@madeyexz/byoa/sandbox/instabox` | `instabox({ apiKey?, apiUrl?, template?, snapshot?, timeoutMs? })`. Needs no package. No volumes: use `storedLogin()`, not `cliLogin`. |
| `@madeyexz/byoa/sandbox/local` | `localSandbox({ root?, volumes?, env? })`: folders on this computer, for tests and development only. On macOS, the Codex sign-in works in it; the Claude Code sign-in needs Linux. |
| `@madeyexz/byoa/store/postgres` | `postgresStore({ query, table? })`, `postgresSchema(table?)`, `POSTGRES_SCHEMA` |
| `@madeyexz/byoa/store/convex` | `convexTable()`, `convexFunctions(table?)`, `convexStore(ctx, fns)`. Needs `convex`. |
| `@madeyexz/byoa/node` | `toNodeListener(handler)` (a fetch handler as a `node:http` listener), `readPluginDir(dir)` |
| `@madeyexz/byoa/verify` | `verifyHarness(sandbox, harness, bin, pins?)`: checks the installed binary against the published npm package |

## createAgents(options)

```ts
interface AgentsOptions {
  app: string                 // lower-case letters, digits, -; at most 24. Names the app's sandboxes and login volumes.
  sandbox: SandboxProvider
  store: Store
  encryptionKey: string       // 32 random bytes as base64. Encrypts MCP grants and, by default, AI logins.
  proxyUrl: string            // public URL where the app serves agents.proxy; each server is at <proxyUrl>/<name>
  oauth: { redirectUrl: string; clientMetadataUrl?: string; clientName?: string }
  pins?: { claude?: string; codex?: string; grok?: string }   // default PINS; a harness left out gets its PINS version
  login?: (deps) => LoginDriver              // default storedLogin(); or cliLogin
  jobTimeoutMs?: number                      // default 30 minutes
  sandboxPer?: 'user' | 'job'                // default 'user': kept sandboxes, paused between jobs
  waitMs?: number                            // sandboxPer 'user': how long a job waits in line for its sandbox; default no limit
  models?: { claude?: ModelChoice; codex?: ModelChoice; grok?: ModelChoice; 'opencode-go'?: ModelChoice }  // each harness's default: { model?, effort? }; 'opencode-go': jobs with that plan
  grantOrigins?: Record<string, string[]>    // more exact origins for fetchWithGrant, by MCP server origin
  tools?: AppTools                           // the app's own tools: MCP server name → tool name → { description?, input?, run }
  transcriptBytes?: number                   // the most bytes of a conversation's transcript kept in the store; default 700 000; 0: none
}
```

- `oauth.redirectUrl`: the app's route that calls `finishMcp`.
- `oauth.clientMetadataUrl`: an HTTPS URL where the app serves `agents.clientMetadata()` (a Client ID Metadata Document). Without it, byoa uses only Dynamic Client Registration.
- `oauth.clientName`: the name the MCP server shows on its consent page. Default: `app`.
- `sandboxPer`: `'user'` (the default): the first job of a user and harness creates the user's sandbox; byoa pauses it after each job (E2B pause, Daytona and Instabox stop) and resumes it for the next, with a new job folder. One job of a user and harness at a time; the others wait in line, in the order they came. A job's `sandboxKey` (in `run` and `session`) gives the user one kept sandbox, with its own lease, for each key. A sandbox the provider no longer has is replaced by a new one. `'job'`: a new sandbox for each job, destroyed after it. With the default `storedLogin()`, a user's jobs in different sandboxes run at the same time with one login, for every harness.
- `models`: the model and effort a job of each harness gets when it names none. Default: the CLI's own. See `listModels`.
- `transcriptBytes`: after each job of a conversation, byoa keeps a copy of the harness's session files (its transcript), encrypted in the store, when they are at most this large, so the conversation goes on when the provider loses its sandbox. Default 700 000 bytes, below a Convex document's 1 MiB. A larger transcript lives only in the conversation's sandbox.

- `tools`: the app's own tools, as functions in the backend. `{ todos: { add_todo: { description, input, run } } }` is an MCP server `todos` with one tool. `input`: the JSON Schema of the arguments (an object schema; default: no arguments). `run(args, { user, job })` runs for the user of the job; what it returns goes to the agent (a string as it is, other values as JSON), and what it throws goes to the agent as a failed call. byoa does not check the arguments against `input`. A job gets the server by its name in `mcp`; the proxy serves it at `<proxyUrl>/<name>`. Server names: lower-case letters, digits and -, at most 32; tool names: letters, digits, _ and -, at most 64. `listMcp` does not list them, and `connectMcp` refuses their names.

It returns an object with the methods below.

## AI login

| Method | Returns |
|---|---|
| `connectLogin(user, 'claude' \| 'codex' \| 'grok')` | `{ harness, url, code? }`. `url`: the lab's own sign-in page. `code`: Codex and Grok, the code to enter on OpenAI's or xAI's page. |
| `finishLogin(user, h, { code?, waitMs? })` | `{ state: 'signed-in' \| 'signed-out' \| 'expired' \| 'pending', error? }`. Claude: pass `code` (the code Anthropic's page shows); with no code, it only checks in and says `pending`. Codex and Grok: no code; `waitMs` waits that long; call again while `pending`. Each call keeps the sign-in's sandbox alive for 2 more minutes; with no call for 2 minutes it ends (on E2B and Daytona; Instabox ends it after 15 minutes). A sign-in lasts 15 minutes at most. |
| `cancelLogin(user, h)` | `void`. Ends a sign-in that has not finished, and its sandbox, at once. Call it when the user closes the sign-in. |
| `loginState(user, h)` | `'signed-in' \| 'signed-out' \| 'expired'`. With `h` `'opencode-go'`, also `'no-plan'`. |
| `signOut(user, h)` | `void`. Also deletes the user's sandbox for `h`, and cancels a sign-in that has not finished. With `h` `'opencode-go'`: deletes the user's key only; the proxy refuses the requests of jobs that still run with it. |
| `connectKey(user, 'opencode-go', key)` | `{ state, error? }`. Beta: OpenCode Go is not yet checked with a real Go key. Keeps the user's OpenCode Console API key (`oc_sk_…`), encrypted in the store, after it checks the key with OpenCode's usage meter: `'signed-in'`; `'no-plan'` (kept: its workspace has no Go plan yet; jobs work once it has one); or, when OpenCode refuses the key (401: wrong, revoked or expired), the state before and an `error`, and the key is not kept. Throws on another answer. |
| `deleteSandbox(user, { harness?, sandboxKey? }?)` | `void`. Deletes the user's kept sandboxes of this app at this provider: all of them (when the app deletes the user), or those of one harness or one sandbox key (when it deletes a project). The login, the grants and the conversations' stored transcripts stay. |
| `deleteConversation(user, conversation?)` | `void`. Deletes a conversation (or, with no id, all of the user's): its session ids and stored transcripts, and its kept sandbox. The next job with that id starts a new conversation. Call it when the user deletes a chat, and when the app deletes the user. |

Login drivers:

- `storedLogin({ store?, encryptionKey?, waitMs?, parallel? })` (default): the CLI's own login files, encrypted in the store. `store` and `encryptionKey` default to the app's. During a job byoa saves a refresh every minute or so; when the backend dies during a job, a watcher in the sandbox removes the files before the provider pauses it, and the next job in that sandbox saves a login that the dead job's CLI refreshed. It saves files from a sandbox only of the same account and not older than the stored login. `waitMs`: how long a job waits in line for the login (default no limit). `parallel` (default true): the jobs of one user and harness share the login, each with a copy in its own sandbox, while the CLI will not refresh it before the job's time runs out (byoa reads the time the access token ends from the login files: the CLIs refresh 5 minutes before it; Codex's token lasts 10 days, Claude Code's 8 hours, Grok's 6 hours). When it is due for a refresh, one job holds it alone: it waits for the other jobs, and the jobs after it wait for it. The risk that stays: the CLIs also refresh when the lab answers 401 to a token that has not run out; two sandboxes that get that answer at the same time both refresh, one fails, and the user may have to sign in again. `parallel: false`: one job of a user and harness holds the login at a time.
- `cliLogin`: the login stays in a volume of the user, mounted through the sandbox adapter. Needs a provider with volumes.

## MCP connections

| Method | Returns |
|---|---|
| `connectMcp(user, url, { name, bearer? })` | `{ name, connected: true }` or `{ name, connected: false, signInUrl }`. Send the browser to `signInUrl`. |
| `finishMcp({ state, code?, error? })` | `{ user, name }`. Call it in the `oauth.redirectUrl` route with the query parameters. |
| `listMcp(user)` | `[{ name, url }]` |
| `removeMcp(user, name)` | `void` |
| `importMcp(user, { name, url, oauth })` | `{ name }`. Moves a grant made elsewhere into byoa; `oauth` is the MCP SDK's state (`client`, `tokens`, `at`). Delete the old copy, so the grant keeps one refresh owner. |
| `fetchWithGrant(user, name, url, init?)` | `Response`. A request with the grant's current token, only to the origin of the grant's MCP server (and `grantOrigins` for it). No redirects. The app never gets the token. |
| `clientMetadata()` | The Client ID Metadata Document to serve at `oauth.clientMetadataUrl`. |

`name`: lower-case letters, digits and -, at most 32. `url`: `https://`, or `http://` on localhost.

## The proxy

`agents.proxy` is a fetch handler (`Request` → `Response`). Serve it at `proxyUrl` and every path below it (`<proxyUrl>/<name>`). It checks the job token, adds the user's real token, and sends the request to the MCP server; for the app's own `tools`, it calls the tool's `run`. It refuses a job token after the job ends. Do not put the app's session check in front of it. Each of its MCP answers has the header `x-byoa-proxy: 1`.

It is also the relay of a job with `plan: 'opencode-go'`, at `<proxyUrl>/_plan/opencode-go/anthropic/v1/…` and `…/openai/v1/…`: it checks the job token (of a job with that plan), adds the user's key, and streams the request to `https://opencode.ai/inference/go/…` and the answer back, with only the harness's own headers (its user agent, session id, API version and betas; it adds `x-opencode-session` when there is none). It sends on no other header, so a header that the app's own gateway adds stays behind, and no other path. OpenCode's 401 makes the key `expired`, its 403 "OpenCode Go subscription required" `no-plan`.

## Jobs

### run(user, options): Job

```ts
interface RunOptions {
  harness: 'claude' | 'codex' | 'grok' | 'fake'
  task: string | string[]     // several messages: one agent gets them all and decides the order
  setup?: { agentsMd?: string; skills?: { name: string; files: Record<string, string> }[] }  // files must have 'SKILL.md'
  plugins?: Plugin[]          // from readPlugin(readPluginDir(dir)); their skills and MCP servers are added
  mcp?: string[]              // the connected servers this job gets; default none
  model?: string              // Claude Code: an alias (opus, sonnet, ...) or a full name; Codex, Grok: a model name. Default: createAgents' models, else the CLI's
  effort?: string             // Claude Code --effort (low ... max); Codex model_reasoning_effort; Grok --reasoning-effort. Each model's own are in listModels
  onWait?: (w: { for: 'sandbox' | 'login'; ahead: number }) => void  // while the job waits in line
  sandboxKey?: string         // sandboxPer 'user': which of the user's kept sandboxes; default the user's one for the harness
  access?: 'full' | 'read-only'  // what the agent may do; default 'full'
  plan?: 'opencode-go'        // the user's OpenCode Go key (connectKey) in place of the lab login, with claude or codex
  conversation?: string       // the app's id of a conversation (1 to 128 characters): the job continues the harness's session of it
}

interface Job extends AsyncGenerator<AgentEvent> {
  send(message: string): Promise<boolean>  // one more message to the running agent; Claude Code only
}
```

- `conversation`: the job continues the harness's own session of the jobs before it with the same id, so the agent has their messages. The conversation has its own kept sandbox (the id is its `sandboxKey`; give no other one), and its job folder stays from job to job: byoa replaces only its own files there (the skills, AGENTS.md, the MCP config, the task). Claude Code: the first job gets `--session-id <a new UUID>`, the next ones `--resume <id>`. Codex: the first job runs without `--ephemeral` and names its thread in `thread.started`; the next ones are `codex exec resume <thread id>` (with `access: 'read-only'`, `-c sandbox_mode="read-only"`, as `exec resume` has no `--sandbox`). Grok: `-s <a new UUID>`, then `-r <id>`. Jobs of one conversation run one at a time, in the order they came. After each job byoa keeps the session id and, up to `transcriptBytes`, a copy of the session's files, encrypted in the store; when the provider lost the sandbox, the next job writes them into its new one (Claude Code and Grok keep sessions by the job folder's path, which is the same at one provider; Codex by date). When there is no copy, the job starts the conversation again and says so in an `error` with code `conversation`. With `sandboxPer: 'job'`, each job of a conversation has a new sandbox and a new job folder, and resumes only from the stored copy. Not with `session()`.
- `send` (steering): Claude Code reads its input as stream-json lines, so a running Claude Code job takes more messages. A message that comes during a turn waits for it; then the agent answers it in the same session. Each turn that is not the last gives a `turn` event; the job ends (`end`) after the turn that answers the last message. `send` returns false after the end. Codex (`exec`) and Grok (`-p`) read their whole task before they start and read no input while they run, so `send` returns false for them, and for the fake harness: send the message as the next job of the conversation.

- `plan`: the harness runs with the user's OpenCode Go plan, through the proxy's relay; the key never enters the sandbox. The job needs a model of the plan (`model`, else `models['opencode-go']` of createAgents; `listModels(user, 'opencode-go')` lists them), else `run` gives an `error` (code `sandbox`). Claude Code gets `ANTHROPIC_BASE_URL` (the relay), `ANTHROPIC_AUTH_TOKEN` (the job token), every model alias set to the job's model, and a `CLAUDE_CONFIG_DIR` of its own with no Claude login; Codex gets `-c` overrides for a model provider `opencode-go` (`wire_api = "responses"`, `env_key = "BYOA_JOB_TOKEN"`) and a `CODEX_HOME` of its own. The user's jobs with a key need no lease, so jobs in different sandboxes run at the same time. With no key, `run` gives an `error` with code `signed-out`.
- `mcp`: names of the user's connected servers and of the app's own `tools`.
- `access`: `'full'`: every tool of the harness with no approval (Codex: `--dangerously-bypass-approvals-and-sandbox`; Claude Code and Grok: `--permission-mode bypassPermissions`), for a sandbox that is the job's alone. `'read-only'`: the job's MCP tools, and reading files, so the harness reads its skills and AGENTS.md; no change to a file, and no network but the job's MCP servers. Codex: `--sandbox read-only` (its shell stays, because it reads a skill with `cat`; a command cannot write or open a connection), with the job's MCP tools approved in its `config.toml`. Claude Code: `--permission-mode dontAsk` with the tools `Read`, `Glob`, `Grep`, `Skill` and the job's MCP servers; each tool it refuses is a `permission` event. Grok: `--permission-mode dontAsk --disable-web-search` with the tools `read_file`, `grep`, `list_dir` (it loads skills with its own skill tool) and `--allow MCPTool(*)` (Grok sees only the job's MCP servers; a call to a tool it does not have then gets an error, where a refusal would end the job). It does not hide files: the agent can read each file its user can read.
- Before the harness starts, byoa sends one MCP `initialize` from the sandbox to each of the job's servers, through the proxy. When no request reaches the proxy, the job does not start: an `error` event with code `mcp`, then `end` with `ok: false`. A server that does not answer gives an `error` event with code `mcp`, and the job runs.

Each run: the user's sandbox (resumed, or created for the first job; with `sandboxPer: 'job'`, a new one), the user's login, the pinned harness, the setup files in a new job folder (in a conversation, the conversation's folder), the task; then the login is taken out, a conversation's transcript is kept, and the sandbox is paused (or destroyed). Stop the loop (or call `return()`) to end a job early; byoa still cleans up.

### Events (one schema for every harness)

```ts
type AgentEvent =
  | { type: 'start'; harness: string; version: string; sandbox: string; conversation?: string; resumed?: boolean }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; server?: string; input: unknown }   // server: the MCP server
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  | { type: 'permission'; tool: string; decision: 'denied'; input?: unknown }
  | { type: 'error'; message: string; code?: 'signed-out' | 'expired' | 'no-plan' | 'harness' | 'sandbox' | 'mcp' | 'conversation' }
  | { type: 'turn'; ok: boolean; result?: string; usage?: Usage }     // one turn of a job that has more messages (send)
  | { type: 'end'; ok: boolean; result?: string; usage?: Usage; session?: string }  // session: the harness's session id, in a conversation
// Usage: { input: number; output: number; cached?: number; costUsd?: number }
```

`run` does not throw for job failures: it yields `error` events and then exactly one `end`. `signed-out` / `expired`: ask the user to sign in again, or for a new key with `plan: 'opencode-go'` (`loginState` says the same). `no-plan`: the key's workspace has no OpenCode Go plan. `mcp`: a server is not connected, its grant failed, it did not answer through the proxy, or the sandbox cannot reach the proxy (then the job did not start). `conversation`: the conversation's history is gone (the provider lost its sandbox, and its transcript was larger than `transcriptBytes`); the job runs, as the first of a new session. In `start`, `resumed` is true when the harness continued an earlier session of the conversation.

### listModels(user, h | 'opencode-go'): Promise<ModelInfo[]>

The models the user's plan can use with `h`, as the unmodified CLI lists them with the user's login (Claude Code: its `initialize` answer; Codex: its app server's `model/list`; Grok: the `initialize` answer of `grok agent stdio`), in a new sandbox that is destroyed after. `ModelInfo`: `{ id, name, description, isDefault, efforts, resolved? }`; `id` is what `model` takes, `efforts` what `effort` takes, `resolved` (Claude Code) the full model name of an alias. Each call starts a sandbox, so keep the list for a while. A Claude Code list waits for the user's running Claude Code jobs. Throws `LoginError` when `h` is not signed in.

With `h` `'opencode-go'`: the plan's chat models, from `https://opencode.ai/inference/go/v1/models` with the user's key, in the backend (no sandbox). The free models are left out: OpenCode serves them only to its own client. `efforts` are the model's own, as OpenCode lists them; Claude Code's `--effort` takes `low` to `max`. `isDefault` is false for each: a job names its model. Throws `LoginError` when the user has no key.

### session(user, { harness, setup?, plugins?, mcp?, sandboxKey?, access?, model?, effort?, onWait?, plan? }): Promise<Session>

For an app that runs its own program around the unmodified harness. It also takes `plan`, as `run` does; `args` then has the plan's flags. Throws `LoginError` when the harness is not signed in (or the user has no key of the plan), and `ProxyError` when the sandbox cannot reach the proxy. The app starts the harness itself, so `access` changes only the files byoa writes (Codex's MCP config).

```ts
const s = await agents.session(userId, { harness: 'claude', mcp: ['notion'] })
try {
  await s.sandbox.run(`my-server --claude ${s.bin}`, { cwd: s.work, env: s.env })
} finally { await s.close() }   // ends the job token, takes the login out, and pauses (or destroys) the sandbox
```

`Session`: `sandbox`, `work` (the job folder with byoa's files), `harness`, `bin` (the pinned binary), `version`, `args` (the harness flags for the job's model and effort, for the app's own command line), `env` (login folder, `BYOA_JOB_TOKEN`, and for Claude Code `MCP_TIMEOUT`; with a plan, the plan's settings above), `token`, `mcp` (`[{ name, url }]` at the proxy), `missing` (servers not connected), `failing` (`[{ name, message }]`: servers that did not answer through the proxy), `reportLogin('signed-in' | 'expired')`, `close()`.

### jobToken(user, { mcp?, ttlMs? }): Promise<JobToken>

A job token with no sandbox, for a harness outside byoa's sandboxes (such as on the user's own computer). `{ token, job, mcp, missing, close() }`. Send `token` as `Authorization: Bearer` to each `mcp[].url`.

## Store adapter

```ts
interface Entry { value: string; version: string }
interface Store {
  get(key: string): Promise<Entry | null>
  put(key: string, value: string): Promise<void>                        // writes whatever is there
  delete(key: string): Promise<void>
  cas(key: string, version: string | null, value: string): Promise<boolean>  // null: only if no entry; true if it wrote
}
```

The version must change on every write, and a key that is deleted and written again must never get an earlier version back. The one refresh owner of each grant depends on `cas`.

- Postgres: run `POSTGRES_SCHEMA` once (or `postgresSchema('my_table')`), then `postgresStore({ query: (sql, args) => pool.query(sql, args) })`.
- Convex: `convex/schema.ts` has `byoa: convexTable()`; `convex/byoa.ts` has `export const { get, put, remove, cas } = convexFunctions()`; in an action or HTTP action, `store: convexStore(ctx, internal.byoa)`. Call byoa only from actions and HTTP actions, and serve `agents.proxy` from an HTTP action.
- Tests: `memoryStore()` from `@madeyexz/byoa`.

## Sandbox adapter

```ts
interface SandboxProvider {
  readonly name: string
  readonly capabilities?: { volumes: boolean }  // optional; false: create refuses a volume, and createAgents refuses cliLogin
  create(opts?: { volumes?: { name: string; path: string }[]; labels?: Record<string, string>; timeoutMs?: number; keep?: boolean }): Promise<Sandbox>
  resume(id: string, opts?: { timeoutMs?: number }): Promise<Sandbox>  // starts a paused one; throws SandboxGoneError when it is gone
  destroy(id: string): Promise<void>                                   // by id, running or paused
  deleteVolume(name: string): Promise<void>
  keepAlive?(id: string, ms: number): Promise<void>  // optional: a sandbox that is not kept ends ms from now (the sign-in's check-ins)
}
interface Sandbox {
  readonly id: string
  readonly home: string
  run(cmd: string, opts?: { cwd?; env?; timeoutMs?; onStdout?; onStderr?; background? }): Promise<{ exitCode; stdout; stderr }>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  readFile?(path: string): Promise<Uint8Array | null>  // optional; null when it is not there
  pause(): Promise<void>      // keeps the files; resume starts it again
  destroy(): Promise<void>
}
```

- `keep: true`: a sandbox byoa keeps for the user. When it times out, the provider pauses it instead of deleting it.
- `run`: a command that exits with a non-zero code resolves; one that runs out of its `timeoutMs` resolves with exit code 137.
- `readFile`: byoa reads the user's login files and a conversation's transcript with it. Without it, byoa reads a file as base64 on a command's stdout, which a provider may keep in its command history. E2B, Daytona, Instabox and the local provider have it.
- An adapter of the app's own can check itself with the conformance check in byoa's tests (`test/helpers/conformance.ts`).
- E2B: `pause` takes a snapshot of the files only where the team can (`mode: 'filesystem'`), else a full one after it ends the sandbox's processes. E2B keeps a paused sandbox with no time limit.
- E2B: the default template is `byoa`; build it once per pin change with `buildE2BTemplate()`. Any template with Node 20 or later works (byoa installs the pinned harness when it is missing, more slowly).
- Daytona: `pause` stops the sandbox; `resume` starts it (also from archived, more slowly). A kept sandbox is not ephemeral and has no time to live; Daytona archives it after 7 days stopped.
- Daytona: with `cliLogin`, every user's login is a subpath of one shared volume (`byoa` by default). On Tier 1 and 2 a sandbox reaches only allowed domains, so serve the proxy on one (for example `*.convex.site`, `*.workers.dev`).
- Instabox: `pause` stops the sandbox; `resume` starts it, and a sandbox that paused itself (idle for 30 minutes, or at the plan's longest run) is booted again, so no process of an earlier job runs. A kept sandbox has no time limit, and Instabox keeps it until it is deleted; a sandbox for one job is deleted after it, and at the latest at its `timeoutMs`. The home folder is `/data/home`. A sandbox gets none of the account's Vault items or org Secrets, and no command is in Instabox's command history. Sandboxes reach every public domain. `create` with volumes throws. The free plan allows one sandbox at a time and three starts a minute; the adapter waits for a start when Instabox answers 429.

## The fake harness

`harness: 'fake'` runs no model and needs no login. It reads the same MCP config Claude Code would. Each task line `call <server>.<tool> <json arguments>` is one MCP call through the real proxy; it shows the task's first line as one `text` event and skips the other lines. The last call's output is the `end` event's `result`. In a conversation it keeps each task in a session file and says, in a `text` event, how many earlier messages it remembers (`fake harness remembers 1 earlier messages: <first line>`), so an app tests its conversations with no model. Use it with `localSandbox()` and `memoryStore()` (or the app's own store) in tests.
