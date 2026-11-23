# byoa API reference

This is the API in https://github.com/madeyexz/byoa today (version 0.1, before version 1). It can change before version 1. The source of truth is `src/agents.ts`, `src/index.ts` and the files they import.

## Imports

| Import | What it gives |
|---|---|
| `byoa` | `createAgents`, `LoginError`, `SandboxGoneError`, `memoryStore`, `storedLogin`, `cliLogin`, `harnessFiles`, `readPlugin`, `JOB_TOKEN_ENV`, `PINS`, `PACKAGES`, `ensureHarness`, `LOGIN_FILES`, `clientMetadataDocument`; types `AgentsOptions`, `RunOptions`, `RunHarness`, `ConnectResult`, `Session`, `SessionOptions`, `JobToken`, `Store`, `Entry`, `Sandbox`, `SandboxProvider`, `AgentEvent`, `Usage`, `Setup`, `Skill`, `Plugin`, `LoginState`, `LoginStart`, `LoginResult` |
| `byoa/sandbox/e2b` | `e2b({ apiKey?, template?, timeoutMs? })`, `buildE2BTemplate(name?, { apiKey?, pins? })`, `e2bTemplate(pins?)`. Needs the `e2b` package. |
| `byoa/sandbox/daytona` | `daytona({ apiKey?, client?, snapshot?, volume?, timeoutMs? })`. Needs `@daytona/sdk`. |
| `byoa/sandbox/local` | `localSandbox({ root?, volumes?, env? })`: folders on this computer, for tests and development only. |
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
  sandboxPer?: 'user' | 'job'                // default 'user': one sandbox per user and harness, paused between jobs
  waitMs?: number                            // sandboxPer 'user': how long a job waits for the user's other job; default 10 minutes
  grantOrigins?: Record<string, string[]>    // more exact origins for fetchWithGrant, by MCP server origin
}
```

- `oauth.redirectUrl`: the app's route that calls `finishMcp`.
- `oauth.clientMetadataUrl`: an HTTPS URL where the app serves `agents.clientMetadata()` (a Client ID Metadata Document). Without it, byoa uses only Dynamic Client Registration.
- `oauth.clientName`: the name the MCP server shows on its consent page. Default: `app`.
- `sandboxPer`: `'user'` (the default): the first job of a user and harness creates the user's sandbox; byoa pauses it after each job (E2B pause, Daytona stop) and resumes it for the next, with a new job folder. One job of a user and harness at a time. A sandbox the provider no longer has is replaced by a new one. `'job'`: a new sandbox for each job, destroyed after it; jobs of one user can run at the same time.

It returns an object with the methods below.

## AI login

| Method | Returns |
|---|---|
| `connectLogin(user, 'claude' \| 'codex')` | `{ harness, url, code? }`. `url`: the lab's own sign-in page. `code`: Codex only, the code to enter on OpenAI's page. |
| `finishLogin(user, h, { code?, waitMs? })` | `{ state: 'signed-in' \| 'signed-out' \| 'expired' \| 'pending', error? }`. Claude: pass `code` (the code Anthropic's page shows). Codex: no code; `waitMs` waits that long; call again while `pending`. |
| `loginState(user, h)` | `'signed-in' \| 'signed-out' \| 'expired'` |
| `signOut(user, h)` | `void`. Also deletes the user's sandbox for `h`. |
| `deleteSandbox(user, h?)` | `void`. Deletes the user's sandbox of this app at this provider, for `h` or for every harness: call it when the app deletes the user. The login and grants stay. |

Login drivers:

- `storedLogin({ store?, encryptionKey?, waitMs? })` (default): the CLI's own login files, encrypted in the store. `store` and `encryptionKey` default to the app's. `waitMs`: how long a job waits for another job of the same user and harness to give the login back (default 10 minutes).
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

`agents.proxy` is a fetch handler (`Request` → `Response`). Serve it at `proxyUrl` and every path below it (`<proxyUrl>/<name>`). It checks the job token, adds the user's real token, and sends the request to the MCP server. It refuses a job token after the job ends. Do not put the app's session check in front of it.

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
}
```

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

`run` does not throw for job failures: it yields `error` events and then exactly one `end`. `signed-out` / `expired`: ask the user to sign in again (`loginState` says the same). `mcp`: a server is not connected, or its grant failed.

### session(user, { harness, setup?, plugins?, mcp? }): Promise<Session>

For an app that runs its own program around the unmodified harness. Throws `LoginError` when the harness is not signed in.

```ts
const s = await agents.session(userId, { harness: 'claude', mcp: ['notion'] })
try {
  await s.sandbox.run(`my-server --claude ${s.bin}`, { cwd: s.work, env: s.env })
} finally { await s.close() }   // ends the job token, takes the login out, and pauses (or destroys) the sandbox
```

`Session`: `sandbox`, `work` (the job folder with byoa's files), `harness`, `bin` (the pinned binary), `version`, `env` (login folder and `BYOA_JOB_TOKEN`), `token`, `mcp` (`[{ name, url }]` at the proxy), `missing` (servers not connected), `reportLogin('signed-in' | 'expired')`, `close()`.

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

## The fake harness

`harness: 'fake'` runs no model and needs no login. It reads the same MCP config Claude Code would. Each task line `call <server>.<tool> <json arguments>` is one MCP call through the real proxy; it shows the task's first line as one `text` event and skips the other lines. The last call's output is the `end` event's `result`. Use it with `localSandbox()` and `memoryStore()` (or the app's own store) in tests.
