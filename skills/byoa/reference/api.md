# byoa API reference

This is the API in https://github.com/madeyexz/byoa today (version 0.1, before version 1). It can change before version 1. The source of truth is `src/agents.ts`, `src/index.ts` and the files they import.

## Imports

| Import | What it gives |
|---|---|
| `byoa` | `createAgents`, `LoginError`, `ProxyError`, `SandboxGoneError`, `memoryStore`, `storedLogin`, `cliLogin`, `harnessFiles`, `readPlugin`, `JOB_TOKEN_ENV`, `PINS`, `PACKAGES`, `ensureHarness`, `LOGIN_FILES`, `clientMetadataDocument`; types `AgentsOptions`, `RunOptions`, `RunHarness`, `ConnectResult`, `Session`, `SessionOptions`, `JobToken`, `Store`, `Entry`, `Sandbox`, `SandboxProvider`, `AgentEvent`, `Usage`, `AppTools`, `AppTool`, `Access`, `Setup`, `Skill`, `Plugin`, `LoginState`, `LoginStart`, `LoginResult` |
| `byoa/sandbox/e2b` | `e2b({ apiKey?, template?, timeoutMs? })`, `buildE2BTemplate(name?, { apiKey?, pins? })`, `e2bTemplate(pins?)`. Needs the `e2b` package. |
| `byoa/sandbox/daytona` | `daytona({ apiKey?, client?, snapshot?, volume?, timeoutMs? })`. Needs `@daytona/sdk`. |
| `byoa/sandbox/instabox` | `instabox({ apiKey?, apiUrl?, template?, snapshot?, timeoutMs? })`. Needs no package. No volumes: use `storedLogin()`, not `cliLogin`. |
| `byoa/sandbox/local` | `localSandbox({ root?, volumes?, env? })`: folders on this computer, for tests and development only. On macOS, the Codex sign-in works in it; the Claude Code sign-in needs Linux. |
| `byoa/store/postgres` | `postgresStore({ query, table? })`, `postgresSchema(table?)`, `POSTGRES_SCHEMA` |
| `byoa/store/convex` | `convexTable()`, `convexFunctions(table?)`, `convexStore(ctx, fns)`. Needs `convex`. |
| `byoa/node` | `toNodeListener(handler)` (a fetch handler as a `node:http` listener), `readPluginDir(dir)` |
| `byoa/verify` | `verifyHarness(sandbox, harness, bin, pins?)`: checks the installed binary against the published npm package |

## createAgents(options)

```ts
interface AgentsOptions {
  app: string                 // lower-case letters, digits, -; at most 24. Names the app's sandboxes and login volumes.
  sandbox: SandboxProvider
  store: Store
  encryptionKey: string       // 32 random bytes as base64. Encrypts MCP grants and, by default, AI logins.
  proxyUrl: string            // public URL where the app serves agents.proxy; each server is at <proxyUrl>/<name>
  oauth: { redirectUrl: string; clientMetadataUrl?: string; clientName?: string }
  pins?: { claude: string; codex: string }   // default PINS
  login?: (deps) => LoginDriver              // default storedLogin(); or cliLogin
  jobTimeoutMs?: number                      // default 30 minutes
  sandboxPer?: 'user' | 'job'                // default 'user': kept sandboxes, paused between jobs
  waitMs?: number                            // sandboxPer 'user': how long a job waits for another job of its sandbox; default 10 minutes
  grantOrigins?: Record<string, string[]>    // more exact origins for fetchWithGrant, by MCP server origin
  tools?: AppTools                           // the app's own tools: MCP server name → tool name → { description?, input?, run }
}
```

- `oauth.redirectUrl`: the app's route that calls `finishMcp`.
- `oauth.clientMetadataUrl`: an HTTPS URL where the app serves `agents.clientMetadata()` (a Client ID Metadata Document). Without it, byoa uses only Dynamic Client Registration.
- `oauth.clientName`: the name the MCP server shows on its consent page. Default: `app`.
- `sandboxPer`: `'user'` (the default): the first job of a user and harness creates the user's sandbox; byoa pauses it after each job (E2B pause, Daytona and Instabox stop) and resumes it for the next, with a new job folder. One job of a user and harness at a time. A job's `sandboxKey` (in `run` and `session`) gives the user one kept sandbox, with its own lease, for each key. A sandbox the provider no longer has is replaced by a new one. `'job'`: a new sandbox for each job, destroyed after it. With the default `storedLogin()`, one job of a user and harness holds the AI login at a time, so the user's Claude Code or Codex jobs run one after the other in both modes, also with different sandbox keys; `storedLogin({ parallel: true })` lets a user's Codex jobs run at the same time.

- `tools`: the app's own tools, as functions in the backend. `{ todos: { add_todo: { description, input, run } } }` is an MCP server `todos` with one tool. `input`: the JSON Schema of the arguments (an object schema; default: no arguments). `run(args, { user, job })` runs for the user of the job; what it returns goes to the agent (a string as it is, other values as JSON), and what it throws goes to the agent as a failed call. byoa does not check the arguments against `input`. A job gets the server by its name in `mcp`; the proxy serves it at `<proxyUrl>/<name>`. Server names: lower-case letters, digits and -, at most 32; tool names: letters, digits, _ and -, at most 64. `listMcp` does not list them, and `connectMcp` refuses their names.

It returns an object with the methods below.

## AI login

| Method | Returns |
|---|---|
| `connectLogin(user, 'claude' \| 'codex')` | `{ harness, url, code? }`. `url`: the lab's own sign-in page. `code`: Codex only, the code to enter on OpenAI's page. |
| `finishLogin(user, h, { code?, waitMs? })` | `{ state: 'signed-in' \| 'signed-out' \| 'expired' \| 'pending', error? }`. Claude: pass `code` (the code Anthropic's page shows). Codex: no code; `waitMs` waits that long; call again while `pending`. |
| `loginState(user, h)` | `'signed-in' \| 'signed-out' \| 'expired'` |
| `signOut(user, h)` | `void`. Also deletes the user's sandbox for `h`. |
| `deleteSandbox(user, { harness?, sandboxKey? }?)` | `void`. Deletes the user's kept sandboxes of this app at this provider: all of them (when the app deletes the user), or those of one harness or one sandbox key (when it deletes a project). The login and grants stay. |

Login drivers:

- `storedLogin({ store?, encryptionKey?, waitMs?, parallel? })` (default): the CLI's own login files, encrypted in the store. `store` and `encryptionKey` default to the app's. One job of a user and harness holds the login at a time, and another waits for it. `waitMs`: how long a job waits for the login (default 10 minutes). `parallel: true`: the Codex jobs of one user share the login, each with a copy in its own sandbox, while Codex will not refresh it before the job's time runs out (byoa reads the time the access token ends from the login files: Codex refreshes 5 minutes before it, and its token lasts 10 days). When it is due for a refresh, one job holds it alone: it waits for the other jobs, and the jobs after it wait for it. The risk that stays: Codex also refreshes when OpenAI answers 401 to a token that has not run out; two sandboxes that get that answer at the same time both refresh, one fails, and the user may have to sign in again. Claude Code jobs always run one at a time.
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

`agents.proxy` is a fetch handler (`Request` → `Response`). Serve it at `proxyUrl` and every path below it (`<proxyUrl>/<name>`). It checks the job token, adds the user's real token, and sends the request to the MCP server; for the app's own `tools`, it calls the tool's `run`. It refuses a job token after the job ends. Do not put the app's session check in front of it. Each of its answers has the header `x-byoa-proxy: 1`.

## Jobs

### run(user, options): AsyncGenerator<AgentEvent>

```ts
interface RunOptions {
  harness: 'claude' | 'codex' | 'fake'
  task: string
  setup?: { agentsMd?: string; skills?: { name: string; files: Record<string, string> }[] }  // files must have 'SKILL.md'
  plugins?: Plugin[]          // from readPlugin(readPluginDir(dir)); their skills and MCP servers are added
  mcp?: string[]              // the connected servers this job gets; default none
  model?: string
  sandboxKey?: string         // sandboxPer 'user': which of the user's kept sandboxes; default the user's one for the harness
  access?: 'full' | 'read-only'  // what the agent may do; default 'full'
}
```

- `mcp`: names of the user's connected servers and of the app's own `tools`.
- `access`: `'full'`: every tool of the harness with no approval (Codex: `--dangerously-bypass-approvals-and-sandbox`; Claude Code: `--permission-mode bypassPermissions`), for a sandbox that is the job's alone. `'read-only'`: the job's MCP tools, and reading files, so the harness reads its skills and AGENTS.md; no change to a file, and no network but the job's MCP servers. Codex: `--sandbox read-only` (its shell stays, because it reads a skill with `cat`; a command cannot write or open a connection), with the job's MCP tools approved in its `config.toml`. Claude Code: `--permission-mode dontAsk` with the tools `Read`, `Glob`, `Grep`, `Skill` and the job's MCP servers; each tool it refuses is a `permission` event. It does not hide files: the agent can read each file its user can read.
- Before the harness starts, byoa sends one MCP `initialize` from the sandbox to each of the job's servers, through the proxy. When no request reaches the proxy, the job does not start: an `error` event with code `mcp`, then `end` with `ok: false`. A server that does not answer gives an `error` event with code `mcp`, and the job runs.

Each run: the user's sandbox (resumed, or created for the first job; with `sandboxPer: 'job'`, a new one), the user's login, the pinned harness, the setup files in a new job folder, the task; then the login is taken out and the sandbox is paused (or destroyed). Stop the loop (or call `return()`) to end a job early; byoa still cleans up.

### Events (one schema for both harnesses)

```ts
type AgentEvent =
  | { type: 'start'; harness: string; version: string; sandbox: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; server?: string; input: unknown }   // server: the MCP server
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  | { type: 'permission'; tool: string; decision: 'denied'; input?: unknown }
  | { type: 'error'; message: string; code?: 'signed-out' | 'expired' | 'harness' | 'sandbox' | 'mcp' }
  | { type: 'end'; ok: boolean; result?: string; usage?: { input: number; output: number; cached?: number; costUsd?: number } }
```

`run` does not throw for job failures: it yields `error` events and then exactly one `end`. `signed-out` / `expired`: ask the user to sign in again (`loginState` says the same). `mcp`: a server is not connected, its grant failed, it did not answer through the proxy, or the sandbox cannot reach the proxy (then the job did not start).

### session(user, { harness, setup?, plugins?, mcp?, sandboxKey?, access? }): Promise<Session>

For an app that runs its own program around the unmodified harness. Throws `LoginError` when the harness is not signed in, and `ProxyError` when the sandbox cannot reach the proxy. The app starts the harness itself, so `access` changes only the files byoa writes (Codex's MCP config).

```ts
const s = await agents.session(userId, { harness: 'claude', mcp: ['notion'] })
try {
  await s.sandbox.run(`my-server --claude ${s.bin}`, { cwd: s.work, env: s.env })
} finally { await s.close() }   // ends the job token, takes the login out, and pauses (or destroys) the sandbox
```

`Session`: `sandbox`, `work` (the job folder with byoa's files), `harness`, `bin` (the pinned binary), `version`, `env` (login folder and `BYOA_JOB_TOKEN`), `token`, `mcp` (`[{ name, url }]` at the proxy), `missing` (servers not connected), `failing` (`[{ name, message }]`: servers that did not answer through the proxy), `reportLogin('signed-in' | 'expired')`, `close()`.

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
- Tests: `memoryStore()` from `byoa`.

## Sandbox adapter

```ts
interface SandboxProvider {
  readonly name: string
  create(opts?: { volumes?: { name: string; path: string }[]; labels?: Record<string, string>; timeoutMs?: number; keep?: boolean }): Promise<Sandbox>
  resume(id: string, opts?: { timeoutMs?: number }): Promise<Sandbox>  // starts a paused one; throws SandboxGoneError when it is gone
  destroy(id: string): Promise<void>                                   // by id, running or paused
  deleteVolume(name: string): Promise<void>
}
interface Sandbox {
  readonly id: string
  readonly home: string
  run(cmd: string, opts?: { cwd?; env?; timeoutMs?; onStdout?; onStderr?; background? }): Promise<{ exitCode; stdout; stderr }>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  pause(): Promise<void>      // keeps the files; resume starts it again
  destroy(): Promise<void>
}
```

- `keep: true`: a sandbox byoa keeps for the user. When it times out, the provider pauses it instead of deleting it.
- E2B: `pause` takes a snapshot of the files only where the team can (`mode: 'filesystem'`), else a full one after it ends the sandbox's processes. E2B keeps a paused sandbox with no time limit.
- E2B: the default template is `byoa`; build it once per pin change with `buildE2BTemplate()`. Any template with Node 20 or later works (byoa installs the pinned harness when it is missing, more slowly).
- Daytona: `pause` stops the sandbox; `resume` starts it (also from archived, more slowly). A kept sandbox is not ephemeral and has no time to live; Daytona archives it after 7 days stopped.
- Daytona: with `cliLogin`, every user's login is a subpath of one shared volume (`byoa` by default). On Tier 1 and 2 a sandbox reaches only allowed domains, so serve the proxy on one (for example `*.convex.site`, `*.workers.dev`).
- Instabox: `pause` stops the sandbox; `resume` starts it, and a sandbox that paused itself (idle for 30 minutes, or at the plan's longest run) is booted again, so no process of an earlier job runs. A kept sandbox has no time limit, and Instabox keeps it until it is deleted; a sandbox for one job is deleted after it, and at the latest at its `timeoutMs`. The home folder is `/data/home`. A sandbox gets none of the account's Vault items or org Secrets, and no command is in Instabox's command history. Sandboxes reach every public domain. `create` with volumes throws. The free plan allows one sandbox at a time and three starts a minute; the adapter waits for a start when Instabox answers 429.

## The fake harness

`harness: 'fake'` runs no model and needs no login. It reads the same MCP config Claude Code would. Each task line `call <server>.<tool> <json arguments>` is one MCP call through the real proxy; it shows the task's first line as one `text` event and skips the other lines. The last call's output is the `end` event's `result`. Use it with `localSandbox()` and `memoryStore()` (or the app's own store) in tests.
