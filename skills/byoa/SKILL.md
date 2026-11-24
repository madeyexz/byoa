---
name: byoa
description: Adds byoa to an app, so the app runs each user's own Claude Code or Codex in a sandbox (E2B, Daytona, Instabox or local), on the user's own Claude or ChatGPT plan, with the user's MCP connections. Use when you add AI agent jobs to an app's backend with byoa, write its sign-in, MCP connect, proxy or callback routes, stream agents.run events to a UI, write a byoa store adapter, or test with byoa's fake harness.
---

# Add byoa to an app

byoa is a library. It runs inside the app's own backend (Node, Bun or Convex actions). It is not a hosted service. The app gives it a sandbox adapter and a store adapter. byoa then signs each user in to their own plan, keeps their MCP grants, and runs each job in that user's sandbox (or, as an option, a new sandbox for each job).

The reference app is the to-do example: https://github.com/madeyexz/byoa/tree/main/examples/todo. Its `app.ts` holds all of its byoa code. Read it before you write the app's code, and copy its patterns. One pattern is older than byoa's `tools` option: the example runs its own MCP server for its to-dos and connects it for each user with a bearer token. In a new app, give the app's own tools to `createAgents` as `tools` (section 5).

The full API, with every option and event, is in [reference/api.md](reference/api.md). The rules every app must follow are in "Lab rules" below. Do not skip them.

## 1. Install

Install byoa from npm:

```sh
npm install byoa
bun add byoa
```

Also install the sandbox SDK that the app uses: `e2b` for E2B, `@daytona/sdk` for Daytona; Instabox needs none. byoa needs Node 22.18 or later, or Bun.

## 2. One createAgents

Make one `agents` object in the backend. Do it once per process (or once per Convex action).

```ts
import { createAgents } from 'byoa'
import { e2b } from 'byoa/sandbox/e2b'              // or: daytona from 'byoa/sandbox/daytona', instabox from 'byoa/sandbox/instabox'
import { postgresStore } from 'byoa/store/postgres' // or: convexStore, or the app's own Store

const agents = createAgents({
  app: 'myapp',                                     // lower-case letters, digits, -; at most 24
  sandbox: e2b({ apiKey: process.env.E2B_API_KEY }),
  store: postgresStore({ query: (sql, args) => pool.query(sql, args) }),
  encryptionKey: process.env.BYOA_KEY!,             // openssl rand -base64 32; keep it the same between restarts
  proxyUrl: 'https://myapp.example.com/byoa/mcp',   // public HTTPS; serve agents.proxy here and below
  oauth: { redirectUrl: 'https://myapp.example.com/byoa/callback' },
  tools: { todos: todoTools },                      // the app's own tools, as functions: see section 5
})
```

- **Store.** `postgresStore` needs its table once: run `POSTGRES_SCHEMA` (from `byoa/store/postgres`). For Convex, see reference/api.md. For another database, write a `Store` with four methods: `get`, `put`, `delete`, `cas` (compare-and-set). The example's `sqliteStore` in `examples/todo/todos.ts` is one in 19 lines. A new version on every write is required, and a deleted and rewritten key must never get an old version back.
- **Sandbox.** `e2b()`, `daytona()` and `instabox()` read their API key from `E2B_API_KEY` / `DAYTONA_API_KEY` / `INSTABOX_API_KEY` when you give none. Instabox has no volumes, so use the default `storedLogin()` there, not `cliLogin`. The default E2B template is named `byoa`, and a new E2B account does not have it: the first job then fails with `404: template 'byoa' not found`. Build it one time with `buildE2BTemplate()` from `byoa/sandbox/e2b`, or pass `e2b({ template: 'base' })`: byoa then installs the pinned harness in each new sandbox (about 10 seconds). `localSandbox()` from `byoa/sandbox/local` is a folder on this computer. It isolates nothing: use it only for development and tests.
- **The sandbox must reach `proxyUrl`.** With E2B, Daytona or Instabox it must be a public HTTPS URL (in development, a tunnel such as `cloudflared tunnel --url http://localhost:3000`). On Daytona Tier 1 and 2, only allowed domains work, such as `*.convex.site` or `*.workers.dev`.

## 3. Routes the app must serve

The app serves two byoa routes, and its own API routes that call `agents.*`. All handlers are fetch handlers (`Request` → `Response`). On Node, wrap the app's handler with `toNodeListener` from `byoa/node`.

```ts
if (url.pathname.startsWith('/byoa/mcp/')) return agents.proxy(req)  // the MCP proxy: no app session check here
if (url.pathname === '/byoa/callback') {                               // the MCP server's sign-in page sends the browser here
  const p = url.searchParams
  await agents.finishMcp({ state: p.get('state') ?? '', code: p.get('code') ?? undefined, error: p.get('error') ?? undefined })
  return Response.redirect(`${publicUrl}/`, 302)
}
```

- The proxy checks the job token itself. Do not put the app's own sign-in check in front of it, because the harness in the sandbox has no app session.
- `finishMcp` returns `{ user, name }`. It finds the user from the stored `state`, so the callback needs no session either.
- Every other route reads the user from the app's own session. The `userId` you pass to byoa is the app's stable user id. Never take it from a header or a body that the browser controls (the example's `x-user` header is a stand-in only).

## 4. Sign the user in to their plan

The sign-in runs the unmodified CLI in a sandbox. The user signs in on the lab's own page. byoa gives the app only that page's URL (and, for Codex, a code).

```ts
// Claude: show the URL; the user signs in and pastes the code that Anthropic's page shows
const { url } = await agents.connectLogin(userId, 'claude')
const r = await agents.finishLogin(userId, 'claude', { code })            // r.state: 'signed-in' or an error

// ChatGPT (Codex): show the URL and the code; the user enters the code on OpenAI's page
const { url, code } = await agents.connectLogin(userId, 'codex')
const r = await agents.finishLogin(userId, 'codex', { waitMs: 20_000 })  // call again while r.state === 'pending'

await agents.loginState(userId, 'claude')  // 'signed-in' | 'signed-out' | 'expired'
await agents.signOut(userId, 'claude')
```

Show `url` as a link or a QR code, so the user can sign in on another device. Keep each request short (for example `waitMs: 20_000`) and let the page call `finishLogin` again while the state is `pending`. This also works from short-lived backends such as Convex actions.

**Where the login stays.** With no `login` option, byoa keeps the CLI's own login files encrypted in the app's store (`storedLogin()`, the default). Each job gets a copy in its sandbox; after the job, byoa saves it back when the CLI refreshed it and removes it from the sandbox. One job of a user and harness holds the login at a time. Options:

- `login: storedLogin({ store: loginStore, encryptionKey: loginKey })`: a table and a key of their own.
- `login: cliLogin`: a volume of that user, behind the sandbox adapter. The app's database never holds the login. It needs a provider with volumes (E2B volumes must be turned on for the team).

Tell the developer that the labs' terms restrict where these tokens may be stored (see Lab rules), and let them choose. Do not choose for them in silence.

## 5. Connect MCP tools, one time per user

```ts
// A server with its own sign-in (MCP authorization, OAuth 2.1 with PKCE)
const c = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
if (!c.connected) return Response.json({ signInUrl: c.signInUrl })  // send the browser there; it comes back to /byoa/callback

// A server that takes a token the user pasted (or the app's own server, with this user's token)
await agents.connectMcp(userId, 'https://myapp.example.com/mcp', { name: 'todos', bearer: token })

await agents.listMcp(userId)            // [{ name, url }]
await agents.removeMcp(userId, 'notion')
```

- `name`: lower-case letters, digits and -, at most 32. The job asks for servers by this name.
- The URL must be `https://` (or `http://` on localhost). With `bearer`, byoa checks the token with one MCP `initialize` and throws if the server refuses it.
- A sign-in that is not finished in 15 minutes runs out; call `connectMcp` again.
- byoa refreshes each grant itself, with one refresh owner. Do not refresh or read the tokens in app code. To call a non-MCP API of the same service (for example an export), use `agents.fetchWithGrant(userId, name, url)`.

**The app's own tools.** Do not write an MCP server for the app's own data. Give the tools to `createAgents` as functions, and name the group in the job's `mcp`:

```ts
const todoTools = {
  add_todo: {
    description: 'Add one to-do.',
    input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },  // JSON Schema of the arguments
    run: ({ title }, { user }) => db.addTodo(user, String(title)),                             // in the backend, for the job's user
  },
  list_todos: { description: "List the user's to-dos.", run: (_args, { user }) => db.todos(user) },
}
const agents = createAgents({ ...options, tools: { todos: todoTools } })
agents.run(userId, { harness, task, mcp: ['todos'] })
```

- `agents.proxy` serves them at `<proxyUrl>/todos` and checks the job token. `user` is the user of the job; never take the user from the arguments.
- What `run` returns goes to the agent: a string as it is, other values as JSON. When it throws, the agent gets the message as a failed call. byoa does not check the arguments against `input`: check them in `run`.
- No user connects anything for them, and `listMcp` does not list them. `connectMcp` refuses their names.

## 6. Run a job and stream its events

```ts
for await (const ev of agents.run(userId, {
  harness: 'claude',                   // 'claude' | 'codex' | 'fake'
  task,                                // the user's request
  mcp: ['notion'],                     // the servers this job gets; default none
  setup: { agentsMd, skills },         // AGENTS.md (and CLAUDE.md for Claude Code); skills: [{ name, files: { 'SKILL.md': '...' } }]
  access: 'read-only',                 // what the agent may do; default 'full'
})) {
  // ev.type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'permission' | 'error' | 'end'
}
```

- The events are the same for Claude Code and Codex. The full schema is in reference/api.md.
- `run` never throws for job failures. It yields `error` events (`code`: `signed-out`, `expired`, `harness`, `sandbox` or `mcp`) and always ends with one `end` event (`ok`, `result`, `usage`). On `signed-out` or `expired`, show the sign-in again.
- A server in `mcp` that the user has not connected gives an `error` with code `mcp`, and the job runs without it.
- **The proxy check.** Before the harness starts, byoa checks from the sandbox that each of the job's servers answers through the proxy. When the sandbox cannot reach the proxy, the job does not start: an `error` with code `mcp`, then `end` with `ok: false` (`session` throws `ProxyError`). A server that does not answer gives an `error` with code `mcp`, and the job runs. Show these errors: they mean a wrong `proxyUrl`, a tunnel that ended, or a server that is down.
- **What the agent may do (`access`).** With `'full'` (the default), the agent has every tool of its harness with no approval: a shell, file changes and the network. That is for coding agents in a sandbox that is the job's alone. With `'read-only'`, the agent calls the job's MCP tools and reads files (the harness reads its skills this way: do not forbid the shell in AGENTS.md, because Codex reads a skill with `cat`); it cannot change a file or reach the network by itself. Use `'read-only'` when the agent needs only its MCP tools (a to-do list, a mail client), and always with `localSandbox()` on a user's own computer. It does not hide files: the agent can read each file its user can read. Ask the developer which one each kind of job needs.
- **The sandbox.** By default (`sandboxPer: 'user'`), each user has one sandbox of the app for each harness: the first job creates it, byoa pauses it after each job and resumes it for the next, with a new job folder. One job of a user and harness runs at a time; another waits up to `waitMs` (default 10 minutes; set it shorter on short-lived backends such as Convex actions). A sandbox the provider lost is replaced by a new one. When one user has many workspaces (projects, conversations), pass `sandboxKey` in `run` or `session`: each key gets its own kept sandbox and lease. `sandboxPer: 'job'` gives each job a new sandbox and destroys it after the job; use it when nothing may stay between jobs. With the default stored login, a user's Claude Code or Codex jobs run one after the other in every mode, also with different sandbox keys: one job of a user and harness holds the AI login at a time, and another waits for it. For many Codex agents of one user at the same time (a fleet), pass `login: storedLogin({ parallel: true })` and give each agent a `sandboxKey`: the jobs then share the login while it is not due for a refresh. Tell the developer the risk that stays (reference/api.md, `storedLogin`), and let them choose. Ask the developer which they want.
- `agents.signOut` deletes the user's sandbox for that harness. When the app deletes a user, call `agents.deleteSandbox(userId)` too; when it deletes a project that had a key, `agents.deleteSandbox(userId, { sandboxKey })`.
- If the client goes away, stop the loop (or call `return()` on the generator): byoa then closes the job token and pauses (or destroys) the sandbox. The example's `ndjson()` in `app.ts` streams the events as JSON lines and does this on `cancel`.
- To run the app's own program around the unmodified harness, use `agents.session(userId, { harness, mcp })` and call `s.close()` in a `finally`. See reference/api.md.

## 7. Test without a plan or a sandbox

Use `harness: 'fake'`, `localSandbox()` from `byoa/sandbox/local` and `memoryStore()` from `byoa`. The fake harness runs no model. Each task line `call <server>.<tool> <json>` is one MCP call through the real proxy, so a test proves the app's routes, grants and proxy end to end. With the local sandbox, `proxyUrl` can be `http://127.0.0.1:<port>/byoa/mcp`. Copy `examples/todo/todo.test.ts`. Do not offer `fake` to end users in production.

## Lab rules

Every app on byoa must follow these rules. If a request breaks one, stop and tell the developer.

- Run only the unmodified `claude` and `codex` binaries that byoa installs (pinned, and checked in byoa's own tests). Do not patch them, wrap them to change what they send, or set headers or a user agent to pretend to be another client.
- Send the user to the lab's own sign-in page, from `connectLogin`. Do not embed, proxy or copy that page, and never ask the user for a password or an API key in place of it.
- Never read, export or call the labs' APIs with the user's AI tokens. The CLI is the only client that uses them. Do not call the labs' token endpoints.
- One app's AI login is only for that app. Give each app its own `app` name and its own store. Never share a login between apps.
- Real MCP tokens never go into the sandbox. Give a job its servers with `mcp: [...]`. Never put a grant's token in `setup`, the task, environment variables or files.
- The labs' terms restrict where AI logins may be stored. Anthropic says third parties may not "collect, store, or intermediate Claude.ai credentials or session tokens" without its agreement. OpenAI says stored tokens must be "local and under the user's control", and paid or hosted apps must apply to be partners. byoa's default keeps the login in the app's database; `cliLogin` keeps it in a per-user volume. Each app checks the terms and makes its own agreements: https://github.com/madeyexz/byoa/blob/main/SPEC.md#lab-rules

## Check your work

- The app's byoa code is small: the example's backend uses byoa in 35 lines. If you write sign-in, OAuth, token refresh or sandbox code yourself, you are rebuilding byoa: use its API.
- Run the app's tests with the fake harness and the local sandbox.
- Every API name you use is in reference/api.md. If a name is not there, read the source (`src/agents.ts` in https://github.com/madeyexz/byoa) before you use it. The API can change before version 1.
