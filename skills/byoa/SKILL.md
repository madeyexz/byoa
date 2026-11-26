---
name: byoa
description: Adds byoa to an app, so the app runs each user's own Claude Code, Codex or Grok Build in a sandbox (E2B, Daytona, Instabox or local), on the user's own Claude, ChatGPT, Grok or OpenCode Go plan, with the user's MCP connections. Use when you add AI agent jobs to an app's backend with byoa, write its sign-in, MCP connect, proxy or callback routes, stream agents.run events to a UI, write a byoa store adapter, or test with byoa's fake harness.
---

# Add byoa to an app

byoa is a library. It runs inside the app's own backend (Node, Bun or Convex actions). It is not a hosted service. The app gives it a sandbox adapter and a store adapter. byoa then signs each user in to their own plan, keeps their MCP grants, and runs each job in that user's sandbox (or, as an option, a new sandbox for each job).

The reference app is the to-do example: https://github.com/madeyexz/byoa/tree/main/examples/todo. Its `app.ts` holds all of its byoa code: the sign-in, the app's own tools (`tools`), a chat (`conversation`), more messages while a job runs (`job.send`) and `access: 'read-only'`. Its `todos.ts` holds the tools and a SQLite store. Read both before you write the app's code, and copy their patterns.

The full API, with every option and event, is in [reference/api.md](reference/api.md). The rules every app must follow are in "Lab rules" below. Do not skip them.

## 1. Install

Install byoa from npm:

```sh
npm install @madeyexz/byoa
bun add @madeyexz/byoa
```

Also install the sandbox SDK that the app uses: `e2b` for E2B, `@daytona/sdk` for Daytona; Instabox needs none. byoa needs Node 22.18 or later, or Bun. The package is `@madeyexz/byoa`: do not write `npm install byoa` or `import ... from 'byoa'`, and do not install `byoa-sdk`, an unrelated package.

This skill describes byoa's `main` branch. npm 1.0.0 has no Grok Build, no OpenCode Go, no `conversation` and no `job.send`. When one of these is a type error, the installed byoa is older than this skill: install from GitHub with `npm install github:madeyexz/byoa` (npm builds it on install), or use only what the installed version's types have. Do not write around the missing types.

## 2. One createAgents

Make one `agents` object in the backend. Do it once per process (or once per Convex action).

```ts
import { createAgents } from '@madeyexz/byoa'
import { e2b } from '@madeyexz/byoa/sandbox/e2b'           // or: daytona from '@madeyexz/byoa/sandbox/daytona', instabox from '@madeyexz/byoa/sandbox/instabox'
import { postgresStore } from '@madeyexz/byoa/store/postgres' // or: convexStore, or the app's own Store

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

- **Store.** `postgresStore` needs its table once: run `POSTGRES_SCHEMA` (from `@madeyexz/byoa/store/postgres`). For Convex, see reference/api.md. For another database, write a `Store` with four methods: `get`, `put`, `delete`, `cas` (compare-and-set). The example's `sqliteStore` in `examples/todo/todos.ts` is one in 19 lines. A new version on every write is required, and a deleted and rewritten key must never get an old version back.
- **Sandbox.** `e2b()`, `daytona()` and `instabox()` read their API key from `E2B_API_KEY` / `DAYTONA_API_KEY` / `INSTABOX_API_KEY` when you give none. Instabox has no volumes, so use the default `storedLogin()` there, not `cliLogin`. The default E2B template is named `byoa`, and a new E2B account does not have it: the first job then fails with `404: template 'byoa' not found`. Build it one time with `buildE2BTemplate()` from `@madeyexz/byoa/sandbox/e2b`, or pass `e2b({ template: 'base' })`: byoa then installs the pinned harness in each new sandbox (about 10 seconds). `localSandbox()` from `@madeyexz/byoa/sandbox/local` is a folder on this computer. It isolates nothing: use it only for development and tests.
- **The sandbox must reach `proxyUrl`.** With E2B, Daytona or Instabox it must be a public HTTPS URL (in development, a tunnel such as `cloudflared tunnel --url http://localhost:3000`). On Daytona Tier 1 and 2, only allowed domains work, such as `*.convex.site` or `*.workers.dev`.

## 3. Routes the app must serve

The app serves two byoa routes, and its own API routes that call `agents.*`. All handlers are fetch handlers (`Request` → `Response`). On Node, wrap the app's handler with `toNodeListener` from `@madeyexz/byoa/node`.

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

The sign-in runs the unmodified CLI in a sandbox. The user signs in on the lab's own page. byoa gives the app only that page's URL (and, for Codex and Grok Build, a code).

```ts
// Claude: show the URL; the user signs in and pastes the code that Anthropic's page shows
const { url } = await agents.connectLogin(userId, 'claude')
const r = await agents.finishLogin(userId, 'claude', { code })            // r.state: 'signed-in' or an error

// ChatGPT (Codex): show the URL and the code; the user enters the code on OpenAI's page
const { url, code } = await agents.connectLogin(userId, 'codex')
const r = await agents.finishLogin(userId, 'codex', { waitMs: 20_000 })  // call again while r.state === 'pending'

// Grok (Grok Build, for SuperGrok and X Premium+): the same as Codex, on xAI's page
const { url, code } = await agents.connectLogin(userId, 'grok')
const r = await agents.finishLogin(userId, 'grok', { waitMs: 20_000 })

await agents.cancelLogin(userId, 'codex')  // the user closed the sign-in: its sandbox ends now
await agents.loginState(userId, 'claude')  // 'signed-in' | 'signed-out' | 'expired'
await agents.signOut(userId, 'claude')
```

Show `url` as a link or a QR code, so the user can sign in on another device. Keep each request short (for example `waitMs: 20_000`) and let the page call `finishLogin` again while the state is `pending`. This also works from short-lived backends such as Convex actions. The sign-in's sandbox lives only while the page checks in: each `finishLogin` keeps it 2 more minutes. For Claude, have the page call `finishLogin(userId, 'claude')` with no code every 30 seconds while the user is on Anthropic's page. When the user closes the sign-in, call `cancelLogin`. Copy the example's `page.html`.

**Where the login stays.** With no `login` option, byoa keeps the CLI's own login files encrypted in the app's store (`storedLogin()`, the default). Each job gets a copy in its sandbox; after the job, byoa saves it back when the CLI refreshed it and removes it from the sandbox. A user's jobs in different sandboxes share the login, for every harness. Options:

- `login: storedLogin({ store: loginStore, encryptionKey: loginKey })`: a table and a key of their own.
- `login: cliLogin`: a volume of that user, behind the sandbox adapter. The app's database never holds the login. It needs a provider with volumes (E2B volumes must be turned on for the team).

Tell the developer that the labs' terms restrict where these tokens may be stored (see Lab rules), and let them choose. Do not choose for them in silence.

**OpenCode Go (beta; a key, not a sign-in).** No real Go key has run it yet: tell the developer it is in beta. A user with an OpenCode Go plan runs Claude Code or Codex on it with an API key that they create in OpenCode's Console (`oc_sk_…`). The app takes the key one time (a password field; never in a URL or a log) and gives it to byoa:

```ts
const r = await agents.connectKey(userId, 'opencode-go', key)  // r.state: 'signed-in', or 'no-plan' (no Go plan yet); with r.error when OpenCode refused it
await agents.loginState(userId, 'opencode-go')                // 'signed-in' | 'signed-out' | 'expired' | 'no-plan'
await agents.signOut(userId, 'opencode-go')                   // deletes the key
```

byoa keeps the key encrypted in the store. It never goes into the sandbox: `agents.proxy` relays the harness's model requests to OpenCode and adds the key there, so the same proxy route serves it (do not filter paths below `proxyUrl`). Jobs pass `plan: 'opencode-go'` and a `model` (section 6). Tell the developer that OpenCode's terms do not clearly allow an app to run a user's key for them (see Lab rules), and let them choose.

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
  harness: 'claude',                   // 'claude' | 'codex' | 'grok' | 'fake'
  task,                                // the user's request
  mcp: ['notion'],                     // the servers this job gets; default none
  setup: { agentsMd, skills },         // AGENTS.md (and CLAUDE.md for Claude Code); skills: [{ name, files: { 'SKILL.md': '...' } }]
  access: 'read-only',                 // what the agent may do; default 'full'
  model: 'opus', effort: 'high',       // optional; default createAgents({ models }), else the CLI's own
  // plan: 'opencode-go',              // optional: the user's OpenCode Go key in place of the lab login; then model is a Go model
})) {
  // ev.type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'permission' | 'error' | 'turn' | 'end'
}
```

- The events are the same for every harness. The full schema is in reference/api.md.
- `run` never throws for job failures. It yields `error` events (`code`: `signed-out`, `expired`, `no-plan`, `usage-limit`, `rate-limited`, `harness`, `sandbox`, `mcp` or `conversation`) and always ends with one `end` event (`ok`, `result`, `usage`). On `signed-out` or `expired`, show the sign-in again (for `plan: 'opencode-go'`, ask for a new key); on `no-plan`, tell the user that the key's workspace has no Go plan.
- **A used-up plan.** `usage-limit`: the user's plan is used up (a 5-hour, weekly or other limit); `resetsAt` (ms since 1970) is when it resets, when the tool said (Claude Code, Codex, OpenCode Go; not Grok Build). Show it to the user. byoa keeps it until then (15 minutes when the tool gave no time): a job of that user and harness ends at once with the same error and starts no sandbox. `agents.usageLimit(userId, harness)` (or `'opencode-go'`) says so before a job, with no sandbox: check it before you show a chat input or start a job. A new sign-in, a new key or a sign-out ends it. `rate-limited`: the lab refused for now (too many requests, overloaded); try again in a moment. Do not match the error's text: use the code.
- A server in `mcp` that the user has not connected gives an `error` with code `mcp`, and the job runs without it.
- **The proxy check.** Before the harness starts, byoa checks from the sandbox that each of the job's servers answers through the proxy. When the sandbox cannot reach the proxy, the job does not start: an `error` with code `mcp`, then `end` with `ok: false` (`session` throws `ProxyError`). A server that does not answer gives an `error` with code `mcp`, and the job runs. Show these errors: they mean a wrong `proxyUrl`, a tunnel that ended, or a server that is down.
- **What the agent may do (`access`).** With `'full'` (the default), the agent has every tool of its harness with no approval: a shell, file changes and the network. That is for coding agents in a sandbox that is the job's alone. With `'read-only'`, the agent calls the job's MCP tools and reads files (the harness reads its skills this way: do not forbid the shell in AGENTS.md, because Codex reads a skill with `cat`); it cannot change a file or reach the network by itself. Use `'read-only'` when the agent needs only its MCP tools (a to-do list, a mail client), and always with `localSandbox()` on a user's own computer. Apart from Codex's home folder (its login), it does not hide files: the agent can read each file its user can read. Ask the developer which one each kind of job needs.
- **The sandbox.** By default (`sandboxPer: 'user'`), each user has one sandbox of the app for each harness: the first job creates it, byoa pauses it after each job and resumes it for the next, with a new job folder. One job of a user and harness runs at a time; the others wait in line, in the order they came, with no limit unless `waitMs` sets one (set it on short-lived backends such as Convex actions). A sandbox the provider lost is replaced by a new one. When one user has many workspaces (projects, conversations), pass `sandboxKey` in `run` or `session`: each key gets its own kept sandbox and lease. `sandboxPer: 'job'` gives each job a new sandbox and destroys it after the job; use it when nothing may stay between jobs.
- **Conversations.** For a chat, pass the chat's id as `conversation` in each `run` of it (one harness per conversation). The job continues the harness's own session of the earlier jobs, in the conversation's own kept sandbox, whose `~/work` stays; `start` says `resumed`, `end` names the `session`. byoa keeps the transcript encrypted in the store (up to `transcriptBytes`), so a lost sandbox does not lose the conversation; when it is too large, the next job gives an `error` with code `conversation` and starts again. Call `agents.deleteConversation(userId, chatId)` when the user deletes the chat. A job with no `conversation` remembers nothing of earlier jobs, and its `~/work` is new.
- **More messages to a running job (steering).** `run` returns a `Job`; `job.send(text)` gives the running agent one more message, with every harness. Codex and Grok Build take it into the turn that runs; Claude Code after that turn. Each turn before the last gives a `turn` event, and `send` returns false once the job ended: then send it as the next job of the conversation. The recipe below puts both together.
- **Many agents of one user.** Three ways, which an app can mix; ask the developer which they want:
  1. A queue: jobs of one sandbox run one after the other. `onWait: ({ for, ahead })` tells the app how many are ahead.
  2. Several messages to one agent: `task: ['first', 'second']`. The agent reads them all and decides the order.
  3. Several sandboxes at once: a `sandboxKey` for each agent, or `sandboxPer: 'job'`. The jobs share the user's login and run at the same time, for every harness. Tell the developer the risk that stays with a shared login (reference/api.md, `storedLogin`); `storedLogin({ parallel: false })` turns sharing off.
- **Models.** `agents.listModels(userId, harness)` lists what the user's plan can use (`id`, `efforts`); pass `model` and `effort` in `run`, or defaults in `createAgents({ models })`. Each call starts a sandbox, so keep the list for a while. With `plan: 'opencode-go'`, a job needs a model of the plan: `agents.listModels(userId, 'opencode-go')` lists them from OpenCode's API with no sandbox, and `createAgents({ models: { 'opencode-go': { model } } })` sets the default.
- `agents.signOut` deletes the user's sandbox for that harness. When the app deletes a user, call `agents.deleteSandbox(userId)` too; when it deletes a project that had a key, `agents.deleteSandbox(userId, { sandboxKey })`.
- If the client goes away, stop the loop (or call `return()` on the generator): byoa then closes the job token and pauses (or destroys) the sandbox. The example's `ndjson()` in `app.ts` streams the events as JSON lines and does this on `cancel`.
- To run the app's own program around the unmodified harness, use `agents.session(userId, { harness, mcp })` and call `s.close()` in a `finally`. See reference/api.md.

### A chat with the agent

A chat is the most common feature: each message of the user is one job of one `conversation`, and a message that comes while a job runs goes to that job. The routes, as in the example's `app.ts`:

```ts
const running = new Map<string, Job>()          // the jobs that run now; import { type Job } from '@madeyexz/byoa'

// POST /api/ask { chat, task }: one message of the user. The page makes the chat id one time (crypto.randomUUID())
const job = agents.run(userId, { harness, task, conversation: chat, mcp: ['todos'], setup: { agentsMd }, access: 'read-only' })
const id = crypto.randomUUID()
running.set(`${userId}/${id}`, job)
// stream the events to the page with the job's id (the example's ndjson(), with an `x-job` header), and remove the
// job from `running` when the stream ends or the browser goes away

// POST /api/ask/send { job, text }: a message while the agent works
const j = running.get(`${userId}/${body.job}`)
return Response.json({ sent: j ? await j.send(body.text) : false })   // false: the job ended; send it as a new /api/ask

// POST /api/chat/delete { chat }: the user deletes the chat or starts a new one
await agents.deleteConversation(userId, chat)
```

What the page does with each event:

| Event | The page |
| --- | --- |
| `start` with `resumed: false` | A new session. When the chat had earlier messages, its history is gone (the provider lost the sandbox, and the transcript was larger than `transcriptBytes`): an `error` with code `conversation` comes first. Say so. |
| `text`, `tool_call`, `tool_result` | Show them as they come. Refresh the app's data after a `tool_result` that changed it. |
| `turn` | One answer ended, and the agent goes on with the message the user sent while it worked. Keep the input open. |
| `end` | The job ended. `ok: false` follows an `error`. Close the input for `send`, so the next message is a new job. |
| `error` `signed-out` or `expired` | Show the sign-in again (for `plan: 'opencode-go'`, ask for a new key). |
| `error` `usage-limit` | The user's plan is used up. Show when it resets (`resetsAt`, else the message), and keep the input closed until then (`agents.usageLimit`). |
| `error` `rate-limited` | The lab refused for now. Say so, and let the user try again in a moment. |
| `error` `harness` | The CLI failed. Show the message. |

- Key `running` by the user too, and read the user from the session, so one user cannot send to another user's job.
- `running` is in this process's memory. With more than one backend process, `send` must reach the process that runs the job (sticky sessions, or one process for jobs).
- One conversation is one harness's session. When the user changes the harness, start a new chat id.

## 7. Test without a plan or a sandbox

Use `harness: 'fake'`, `localSandbox()` from `@madeyexz/byoa/sandbox/local` and `memoryStore()` from `@madeyexz/byoa`. The fake harness runs no model. Each task line `call <server>.<tool> <json>` is one MCP call through the real proxy, so a test proves the app's routes, grants and proxy end to end. With the local sandbox, `proxyUrl` can be `http://127.0.0.1:<port>/byoa/mcp`. Copy `examples/todo/todo.test.ts`. A conversation works with the fake harness: in each job of one, it says `fake harness remembers N earlier messages`, so a test can check that a chat goes on and that a deleted chat starts again. Steering does not: the fake harness takes no message while it runs, so `job.send` returns false. Do not write a test that expects `send` to work with `fake`. Do not offer `fake` to end users in production.

## Lab rules

Every app on byoa must follow these rules. If a request breaks one, stop and tell the developer.

- Run only the unmodified `claude`, `codex` and `grok` binaries that byoa installs (pinned, and checked in byoa's own tests). Do not patch them, wrap them to change what they send, or set headers or a user agent to pretend to be another client.
- Send the user to the lab's own sign-in page, from `connectLogin`. Do not embed, proxy or copy that page, and never ask the user for a password or an API key in place of it. The one key byoa takes is an OpenCode Go key, with `connectKey`, which OpenCode's Console makes for this.
- For OpenCode Go, never use OpenCode's Console CLI sign-in (`npx @opencode/console`): it has OpenCode's own client ID. OpenCode's terms say "only for your own internal use, and not on behalf of or for the benefit of any third party", so it is not clearly allowed for an app: tell the developer to ask OpenCode (help@anoma.ly) first.
- Never read, export or call the labs' APIs with the user's AI tokens. The CLI is the only client that uses them. Do not call the labs' token endpoints.
- One app's AI login is only for that app. Give each app its own `app` name and its own store. Never share a login between apps.
- Real MCP tokens never go into the sandbox. Give a job its servers with `mcp: [...]`. Never put a grant's token in `setup`, the task, environment variables or files.
- The labs' terms restrict where AI logins may be stored. Anthropic says third parties may not "collect, store, or intermediate Claude.ai credentials or session tokens" without its agreement. OpenAI says stored tokens must be "local and under the user's control", and paid or hosted apps must apply to be partners. xAI's terms forbid sharing an account and "unauthorized automated" access, and say nothing about an app that runs Grok Build for its users. byoa's default keeps the login in the app's database; `cliLogin` keeps it in a per-user volume. Each app checks the terms and makes its own agreements: https://github.com/madeyexz/byoa/blob/main/SPEC.md#lab-rules

## Check your work

- The app's byoa code is small: the example's backend, a chat with sign-in, tools and steering, uses byoa in 49 lines. If you write sign-in, OAuth, token refresh or sandbox code yourself, you are rebuilding byoa: use its API.
- Run the app's tests with the fake harness and the local sandbox.
- Every API name you use is in reference/api.md. If a name is not there, read the source (`src/agents.ts` and `src/job.ts` in https://github.com/madeyexz/byoa) before you use it.
