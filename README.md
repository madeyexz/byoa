<a href="https://byoa.rippling.computer">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/banner-dark.png">
  <img alt="byoa: your users bring their own agent. byoa lets your app run each user's own Claude Code or Codex, on their plan and with their tools, in any sandbox, from inside your own backend. Version 1 targets: Claude Code, Codex, E2B, Daytona, Instabox, Node and Convex. Cloudflare Workers is planned." src=".github/readme/banner-light.png">
</picture>
</a>

<div align="center">

[Website](https://byoa.rippling.computer) · [Spec](SPEC.md) · [Example app](examples/todo) · [Agent skill](skills/byoa) · [llms.txt](https://byoa.rippling.computer/llms.txt) · [Contributing](CONTRIBUTING.md)

[![CI](https://github.com/madeyexz/byoa/actions/workflows/ci.yml/badge.svg)](https://github.com/madeyexz/byoa/actions/workflows/ci.yml)
![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-2f4cff?style=flat-square)
![Agents: Claude Code · Codex · Grok Build](https://img.shields.io/badge/agents-Claude_Code_%C2%B7_Codex_%C2%B7_Grok_Build-9db6ff?style=flat-square)
![Sandboxes: E2B · Daytona · Instabox](https://img.shields.io/badge/sandboxes-E2B_%C2%B7_Daytona_%C2%B7_Instabox-ffc93c?style=flat-square)
![Not a hosted service](https://img.shields.io/badge/a_library-not_a_hosted_service-ff5a36?style=flat-square)

</div>

# byoa: bring your own agent

**byoa lets your app run each user's own Claude Code, Codex or Grok Build, on their plan and with their tools, in any sandbox, from inside your own backend.**

byoa is an open-source library that helps you build AI-native apps fast. Your app runs the user's own Claude Code, Codex or Grok Build in a sandbox. The user signs in with their own ChatGPT, Claude or Grok plan, or gives the key of their OpenCode Go plan, so they pay for the AI work with a plan they already have. The user connects each MCP tool (Notion, Gmail, and others) one time, and every agent run has it.

Version 1 supports three sandbox providers: E2B, Daytona and Instabox. More providers come later. To change the provider, you change one adapter.

## Who brings what

**Your app brings the product. Each user brings the agent.** You build the app and pick the sandbox. Each user brings their plan and their tools. byoa runs inside your backend and runs each job in that user's own sandbox.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/who-dark.png">
  <img alt="Who brings what: you, the developer, build the app, pick the sandbox provider and own the database, and import byoa into your app's backend. The end user uses the app, signs in on the lab's own page and connects each MCP tool once. Your app code calls agents.run on byoa, which keeps AI logins and MCP grants in your database. byoa's box reaches past your backend's edge: outside it, byoa creates, runs and destroys a sandbox for each job at E2B or Daytona on your account, where the user's own Claude Code or Codex runs; the AI labs get the model calls, paid by the user's own plan; and the user's MCP servers get the real token from byoa's proxy." src=".github/readme/who-light.png">
</picture>

<details>
<summary>The same diagram as text</summary>

```text
DEVELOPER · YOU                                           END USER
┌────────────────────────────────────┐                    ┌────────────────────────────────────┐
│ builds the app                     │                    │ uses the app                       │
│ picks the sandbox provider         │                    │ has a Claude, ChatGPT or Grok plan │
│ owns the database                  │                    │ has MCP tools and skills           │
└──────────────────┬─────────────────┘                    └──────────────────┬─────────────────┘
                   │ imports byoa             signs in on the lab's own page │
                   │                             connects each MCP tool once │
                   ▼                                                         ▼
┌─ YOUR APP'S BACKEND · you run it ────────────────────────────────────────────────────────────┐
│  your app code                                            your database                      │
│        │ agents.run(userId, task)                               ▲ AI logins, MCP grants      │
│        ▼                                                        │                            │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ byoa · open source, Apache 2.0                                                           ┃ │
│ ┃   AI login · harness            skills · AGENTS.md            MCP OAuth · proxy          ┃ │
│ ┃              │                                                           │               ┃ │
└─╂┄┄┄┄┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄┄ ▲ your backend · outside it ▼ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╂─┘
  ┃              │ create · run · destroy                         real token │               ┃
  ┃              ▼                                                           ▼               ┃
  ┃ ┌─ SANDBOX ────────────────┐  ┌─ AI LABS ────────────────┐  ┌─ MCP SERVERS ────────────┐ ┃
  ┃ │ E2B or Daytona,          │  │ Anthropic · OpenAI · xAI │  │ Notion · Gmail · …       │ ┃
  ┃ │ on your account          ├─▶│ model calls, paid by     │  │ the user's own accounts  │ ┃
  ┃ │ runs the user's own      │  │ the user's own plan      │  │                          │ ┃
  ┃ │ Claude Code, Codex or    │  │                          │  │                          │ ┃
  ┃ │ Grok Build               │  │                          │  │                          │ ┃
  ┃ └──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘ ┃
  ┃                                                                                          ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

</details>

## The problem

To make an app AI-native, you run a big lab's harness (Claude Code, Codex or Grok Build) in a sandbox, with the user's own AI plan. For each app, you must build the same connection layer again:

- the user's AI login, through the real CLI;
- the user's MCP connections and their OAuth tokens, with one refresh owner;
- the user's skills and AGENTS.md;
- the harness install and its updates;
- the code that connects all of this to one sandbox provider.

byoa is that layer, as a library, so you do not build it again for each app.


## What byoa is, and what it is not

- byoa **is** a library. It runs inside your app's own backend (Node or Convex). Cloudflare Workers support is planned.
- byoa **stores tokens in your own database**, through a store adapter.
- byoa **is not** a hosted service. We do not run a server, and we never see your users' tokens.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/scope-dark.png">
  <img alt="What version 1 covers. Agents: Claude Code and Codex (v1), Gemini or Antigravity maybe later. User plans: Claude and ChatGPT (v1). Sandboxes: E2B, Daytona and Instabox (v1), other providers planned. Backends: Node and Convex actions (v1), Cloudflare Workers planned. Token stores: Convex and Postgres (v1), or your own with get, put, delete and compare-and-set." src=".github/readme/scope-light.png">
</picture>

## Why byoa

<table>
<tr>
<td width="50%" valign="top">
<img alt="" src=".github/readme/why-plan.png">
<h3>The user's plan pays.</h3>
Each user signs in with their own Claude, ChatGPT or Grok plan, on Anthropic's, OpenAI's or xAI's own sign-in page. The agent work runs on that plan, not on your API bill.
</td>
<td width="50%" valign="top">
<img alt="" src=".github/readme/why-agents.png">
<h3>The real agents.</h3>
Your app runs the real, unmodified Claude Code, Codex and Grok Build. Users get the full harness, with their tools and skills.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img alt="" src=".github/readme/why-sandbox.png">
<h3>Any sandbox.</h3>
Each sandbox provider is one adapter with one interface. E2B, Daytona and Instabox come first. To change the provider, you change one line.
</td>
<td width="50%" valign="top">
<img alt="" src=".github/readme/why-connect.png">
<h3>Connect once.</h3>
The user connects each MCP tool one time. Every agent run has it. The real tokens never go into the sandbox.
</td>
</tr>
</table>

## How it works

byoa sits in your backend, between your users and their agents. Your app calls `agents.run(userId, task)`. byoa starts or resumes the user's sandbox, loads the user's setup, and runs the user's own harness on the user's own plan.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/how-dark.png">
  <img alt="Architecture: the end user, with a Claude or ChatGPT plan and Notion, Gmail and Heptabase accounts, uses your app. byoa runs inside your app's own backend: sandbox adapters (E2B, Daytona), the AI login flow (the real claude and codex CLI), a pinned harness installer, MCP OAuth with one refresh owner, skills and config, one event stream for both harnesses, the token store and the MCP proxy. It creates, runs and destroys the sandbox, where the unmodified Claude Code or Codex calls the AI labs on the user's own plan. As an option, the user's login is a volume mounted into the sandbox (cliLogin) instead of in the database. MCP calls go through the proxy to the MCP servers." src=".github/readme/how-light.png">
</picture>

### Real tokens never go into the sandbox

The agent in the sandbox gets a short-lived job token. The proxy in your backend adds the real MCP token to each request.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/tokens-dark.png">
  <img alt="Token flow: the harness in the sandbox has an mcp.json that points to your proxy, with a job token for one job and one user, and no real MCP token. The MCP proxy in your backend checks the job token, adds the real token from the token store (your database, your key), sends the request on to the MCP server, and refuses the job token after the job ends." src=".github/readme/tokens-light.png">
</picture>

### The sandbox of each job

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/readme/lifecycle-dark.png">
  <img alt="Lifecycle: 1. Create: byoa starts a sandbox at your provider. 2. Load the setup: pinned harness, skills, AGENTS.md and MCP config. 3. Run the job: text, tool calls and permission requests stream back as events. 4. Destroy: byoa destroys the sandbox at the provider. The user's AI login and MCP grants stay between jobs." src=".github/readme/lifecycle-light.png">
</picture>

The picture shows `sandboxPer: 'job'`. By default, step 1 resumes the user's sandbox from the last job (or creates it for the first job), and step 4 pauses it.

## Install

Install byoa from npm. Its package is `@madeyexz/byoa`, because npm does not allow the name `byoa`:

```sh
npm install @madeyexz/byoa
bun add @madeyexz/byoa
```

Also install the sandbox SDK that your app uses: `e2b` for E2B, `@daytona/sdk` for Daytona. Instabox and the local sandbox need none. byoa needs Node 22.18 or later, or Bun. To use the newest commit on `main` before it is released, install from GitHub: `npm install github:madeyexz/byoa`.

## Agent skill

[skills/byoa](skills/byoa) is a skill in the [Agent Skills](https://agentskills.io) format. It teaches a coding agent (Claude Code, Codex, Amp and others) to add byoa to an app: the install, `createAgents` with a store and a sandbox adapter, the sign-in, the MCP connections and their routes, `agents.run` and its events, and the lab rules. To install it in your app's repository:

```sh
npx skills add madeyexz/byoa              # Claude Code, Codex, Cursor and others
amp skill add madeyexz/byoa/skills/byoa   # Amp
```

For LLMs, the site also serves the docs as [llms.txt](https://byoa.rippling.computer/llms.txt) (an index) and [llms-full.txt](https://byoa.rippling.computer/llms-full.txt) (the README, SPEC.md, the example and the skill in one file).

## How it will look

This is the API in this repository today. It can change before version 1.

```ts
import { createAgents } from '@madeyexz/byoa'
import { e2b } from '@madeyexz/byoa/sandbox/e2b'
import { postgresStore } from '@madeyexz/byoa/store/postgres'

const agents = createAgents({
  app: 'myapp',                                    // one app's AI logins are only this app's
  sandbox: e2b({ apiKey }),
  store: postgresStore({ query: (sql, args) => pool.query(sql, args) }),
  encryptionKey,                                   // openssl rand -base64 32; grants and AI logins are encrypted with it
  proxyUrl: 'https://myapp.example.com/byoa/mcp',  // serve agents.proxy here
  oauth: { redirectUrl: 'https://myapp.example.com/byoa/callback' },
  tools: { todos: { add_todo: { description: 'Add one to-do.', input, run: ({ title }, { user }) => db.addTodo(user, title) } } },  // your app's own tools
  models: { claude: { model: 'opus' }, codex: { effort: 'high' } },  // optional: each harness's default model and effort
})

const claude = await agents.connectLogin(userId, 'claude')  // { url }: Anthropic's own sign-in page
await agents.finishLogin(userId, 'claude', { code })        // the code that page shows
const codex = await agents.connectLogin(userId, 'codex')    // { url, code }: OpenAI's page and the code to enter
await agents.finishLogin(userId, 'codex', { waitMs: 20_000 }) // call again while it says 'pending'
await agents.cancelLogin(userId, 'codex')                   // the user closed the sign-in: its sandbox ends now
const grok = await agents.connectLogin(userId, 'grok')      // { url, code }: xAI's page and the code; finish as for Codex

const mcp = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
// mcp.signInUrl: the server's sign-in page; your redirectUrl route then calls agents.finishMcp({ state, code })

for await (const event of agents.run(userId, { harness: 'claude', task, mcp: ['notion', 'todos'], setup: { agentsMd, skills } })) {
  // start, text, tool_call, tool_result, permission, error, end: the same events for every harness
}
```

The sign-in runs the CLI in a sandbox of its own, which lives only while your sign-in UI checks in: each `finishLogin` call keeps it for 2 more minutes (Claude Code: with no code, the call only checks in; Codex and Grok Build: each call waits up to `waitMs` for the user). When the user closes the sign-in, call `cancelLogin`, and its sandbox ends at once; when your UI stops calling, it ends 2 minutes after the last call, on E2B and Daytona. Instabox cannot change a sandbox's time after it starts, so there a sign-in that is left ends after 15 minutes, as long as Codex's device code lasts, unless you call `cancelLogin`. `signOut` cancels a sign-in that has not finished too.

### Models and effort

`run(userId, { harness, task, model, effort })` runs the harness with that model and effort: Claude Code's `--model` (an alias such as `opus`, or a full name) and `--effort` (`low` to `max`), Codex's `-m` and `model_reasoning_effort`, Grok Build's `-m` and `--reasoning-effort`. Without them, a job gets the harness's default from `createAgents({ models })`, else the CLI's own. `agents.listModels(userId, harness)` lists the models that user's plan can use, as the CLI lists them with the user's login: `[{ id, name, description, isDefault, efforts, resolved? }]`, where `id` is what `model` takes and `efforts` what `effort` takes. Each call starts a sandbox, so keep the list for a while.

```ts
const models = await agents.listModels(userId, 'codex')   // [{ id: 'gpt-6.2-sol', isDefault: true, efforts: ['low', ...] }, ...]
agents.run(userId, { harness: 'codex', task, model: models[0].id, effort: 'high' })
```

An app that runs its own program around the unmodified harness (for example its own server, which starts `claude`, `codex` or `grok` itself) opens the job with `agents.session` instead. It gets the same sandbox, login, pinned harness and job token, and runs its own command:

```ts
const s = await agents.session(userId, { harness: 'claude', mcp: ['notion'] })
try {
  // s.bin: the pinned claude binary; s.env: its login folder, the job token and its MCP start timeout; s.mcp: [{ name, url }] at the proxy
  await s.sandbox.run(`my-server --claude ${s.bin}`, { env: s.env })
} finally { await s.close() }  // ends the job token, takes the AI login out, and pauses the user's sandbox
```

A program outside byoa's sandboxes, such as a harness on the user's own computer, gets a job token with no sandbox: `const t = await agents.jobToken(userId, { mcp: ['notion'] })` gives `t.token` and `t.mcp` (the proxy URLs), with the same rules as a job's token, until `t.close()`.

To move an MCP grant that the user already made elsewhere into byoa, call `agents.importMcp(userId, { name, url, oauth })` with the MCP SDK's state (`client`, `tokens`, `at`). Delete the old copy, so the grant keeps one refresh owner.

Some MCP servers have an API next to the MCP endpoint that is not MCP, such as an export. Your backend calls it with the user's grant through `agents.fetchWithGrant(userId, 'tasks', 'https://mcp.example.com/export')`: byoa adds the current token, refreshed by the one refresh owner, and gives you the response. By default, it sends the token only to the origin of that grant's MCP server. It does not follow redirects, and never gives you the token.

When the service's API is on another origin than its MCP server, name that origin in your own configuration, for the MCP server's origin. Only grants of that MCP server can go there, and only to that exact origin:

```ts
const agents = createAgents({
  ...options,
  // Margins' MCP server is on margin.rippling.computer; its export is on its Convex site
  grantOrigins: { 'https://margin.rippling.computer': ['https://helpful-tern-930.convex.site'] },
})
const r = await agents.fetchWithGrant(userId, 'margins', 'https://helpful-tern-930.convex.site/ext/export')
```

### Your app's own tools

Give your app's own tools to `createAgents` as functions (`tools`): MCP server name → tool name → `{ description, input, run }`. `input` is the JSON Schema of the arguments. A job gets them by the server's name in `mcp`, as it gets a connected server. The harness calls them through `agents.proxy`, which checks the job token and calls `run(args, { user, job })` in your backend, for the user of that job. So you write no MCP server, keep no token for it, and connect nothing for each user. What `run` returns goes to the agent (a string as it is, other values as JSON); when it throws, the agent gets the message as a failed call. byoa does not check the arguments against `input`: check them in `run`.

```ts
const agents = createAgents({
  ...options,
  tools: {
    todos: {
      add_todo: {
        description: 'Add one to-do.',
        input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        run: ({ title }, { user }) => db.addTodo(user, String(title)),
      },
      list_todos: { description: "List the user's to-dos.", run: (_args, { user }) => db.todos(user) },
    },
  },
})
agents.run(userId, { harness: 'codex', task, mcp: ['todos'] })
```

### What the agent may do

By default (`access: 'full'`), the agent has every tool of its harness, with no approval: a shell, file changes and the network. This is for a sandbox that is the job's alone. An app whose agent must only use its MCP tools, such as a to-do list or a mail client, gives the job `access: 'read-only'`:

```ts
agents.run(userId, { harness: 'codex', task, mcp: ['mail'], setup: { skills }, access: 'read-only' })
```

The agent can then call the job's MCP tools and read files, so the harness can still read its skills and AGENTS.md. It cannot change a file or reach the network by itself. byoa only sets each CLI's own options: Codex runs in its own `read-only` sandbox, Claude Code gets only its tools that read, and so does Grok Build, with its web search off. `read-only` does not hide files: the agent can read each file that its user can read. Use it always with `localSandbox()` on a user's own computer, where the sandbox isolates nothing.

### When the proxy is down

Before the harness starts, byoa checks from the job's sandbox that each MCP server of the job answers through `agents.proxy`. When the sandbox cannot reach the proxy (a wrong `proxyUrl`, a tunnel that ended, a firewall), the job does not start: `run` gives an `error` event with code `mcp` and ends with `ok: false`, and `session` throws `ProxyError`. A server that does not answer gives an `error` event with code `mcp`, and the job runs. Without this check, a harness that cannot reach a server leaves its tools out and still ends well.

### The sandbox of a user

By default, each user has one sandbox of your app for each harness. The first job creates it. After each job, byoa pauses it (E2B pauses it; Daytona and Instabox stop it), and the next job resumes it, so files that the app wrote there and the installed harness stay. Each job gets a new job folder (`s.work`) with its own setup. One job of a user and harness runs at a time; the others wait in line and run in the order they came (`waitMs`: how long a job waits before it fails; default no limit). `onWait` tells the app how many jobs are ahead. When the provider no longer has the sandbox, the next job creates a new one.

An app where one user has many workspaces, such as projects or conversations, gives each job a `sandboxKey`. Each key has its own kept sandbox and its own lease, so jobs with different keys run at the same time. For a new sandbox for each job, destroyed after it, set `sandboxPer: 'job'`.

### Many agents of one user

An app chooses how one user's agents run, and can mix the three ways:

```ts
// 1. A queue: jobs of one sandbox run one after the other, in the order they came
agents.run(userId, { harness: 'claude', task, onWait: ({ ahead }) => show(`${ahead} jobs before yours`) })

// 2. Several messages to one agent, which reads them all and decides the order itself
agents.run(userId, { harness: 'codex', task: ['water the plants', 'call mom', 'plan the week'] })

// 3. Several sandboxes at once: a sandbox key for each agent (or sandboxPer: 'job')
const jobs = projects.map((p) => agents.run(userId, { harness: 'codex', task, sandboxKey: p.id }))  // read each stream; they run together
```

Jobs of one user in different sandboxes run at the same time with one sign-in, for every harness (see AI login below).

Either way, the user's AI login stays encrypted in your database, and each job gets a copy, which byoa takes out of the sandbox after the job (see AI login below). The MCP config in the sandbox points to `agents.proxy`, with a token for that one job. The real MCP tokens stay in your database. `agents.signOut` deletes the user's sandbox for that harness; when you delete a user, call `agents.deleteSandbox(userId)`, which deletes all of their sandboxes of your app at that provider, and when you delete a project, `agents.deleteSandbox(userId, { sandboxKey: projectId })`.

To change the provider, change `e2b(...)` to another adapter. An adapter implements one interface ([src/sandbox/types.ts](src/sandbox/types.ts)): create (with volumes), resume, run a command, write a file, pause, destroy, and optionally keepAlive (a new end time for a sandbox that is not kept).

For Daytona, use `daytona({ apiKey })` from `@madeyexz/byoa/sandbox/daytona` (it needs `@daytona/sdk`). Daytona allows 100 volumes per organization, so with `cliLogin` the adapter keeps every user's AI login in its own subpath of one shared volume (`byoa` by default). A sandbox mounts only that user's subpath. On Daytona Tier 1 and Tier 2, a sandbox can reach only [allowed domains](https://www.daytona.io/docs/en/network-limits), so serve `agents.proxy` on one of them (for example `*.convex.site`), or use Tier 3 or higher. `*.workers.dev` is on Daytona's list but does not work: a Worker's address has two labels below it (`<worker>.<account>.workers.dev`), and Daytona does not resolve those.

For Instabox, use `instabox({ apiKey })` from `@madeyexz/byoa/sandbox/instabox`. It calls Instabox's HTTP API itself, so it needs no package. Each sandbox starts from the `agent-browser` template (Node 22, user `user`, home `/data/home`), or from a snapshot you name (`snapshot`). byoa stops the user's sandbox after each job, so the next job starts it again with its files and no process of the last one; a sandbox for one job is deleted after it, and Instabox deletes it at the latest when the job's time is up. byoa gives a sandbox none of your account's Vault items or org Secrets, and leaves its commands out of Instabox's command history, which would otherwise keep their output (and so the AI login that byoa reads back). Instabox has no volumes, so `cliLogin` does not work there; the default stored login does. Instabox sandboxes reach every public domain, so a tunnel works for `proxyUrl`. On the free plan, a workspace has one sandbox at a time (so one user with one kept sandbox, or one job), three starts a minute (byoa waits when it gets there), and a run of 2 hours at most before Instabox pauses the sandbox.

### AI login

By default, byoa keeps each user's Claude, ChatGPT or Grok plan login in your own database, encrypted with your `encryptionKey`, through the store adapter. The sign-in is the unmodified CLI, on the lab's own page. When it ends, byoa keeps the CLI's own login files. Each job writes them into its sandbox. After the job, byoa saves them back when the CLI refreshed them, and removes them from the sandbox, also from the user's sandbox that it keeps, so your database has the only copy between jobs. During the job it saves a refresh every minute or so. When your backend dies during a job, a watcher in the sandbox removes the files before the provider pauses it, and the next job in that sandbox saves a login that the dead job's CLI refreshed. byoa saves files from a sandbox only when they are the same account's login and not older than the stored one. byoa never calls the labs' token endpoints itself. So the sandbox provider needs no volumes.

The CLIs rotate their refresh tokens, so two sandboxes must not refresh one login. By default, the jobs of one user and harness share the login, each with a copy in its own sandbox (a `sandboxKey` for each, or `sandboxPer: 'job'`), and run at the same time. The CLIs refresh their login 5 minutes before the access token ends; Codex's token lasts 10 days, Claude Code's 8 hours, Grok Build's 6 hours. byoa reads that time from the login files, and nothing else in them. When the login is due for a refresh before a job's time runs out, one job holds it alone: it waits for the user's other jobs to end, its CLI refreshes the login, byoa saves it, and the next jobs share it again. One risk stays: the CLIs also refresh when the lab answers 401 to a token that has not run out, and two sandboxes that get that answer at the same time both refresh; one of them fails, and the user may have to sign in again. To hold the login one job at a time instead, pass `login: storedLogin({ parallel: false })`.

The labs' published terms restrict where these tokens may be stored: Anthropic's say developers may not "collect, store, or intermediate Claude.ai credentials or session tokens", and OpenAI's say stored tokens must be "local and under the user's control, not in a remote or managed environment" (see [SPEC.md](SPEC.md#lab-rules)). Check them for your app.

To keep the logins in a table of their own, with a key of their own, so you can give them their own access rules and backups:

```ts
import { createAgents, storedLogin } from '@madeyexz/byoa'

// Convex: convex/schema.ts has  byoaLogin: convexTable(),  and convex/byoaLogin.ts has
//   export const { get, put, remove, cas } = convexFunctions('byoaLogin')
const loginStore = convexStore(ctx, internal.byoaLogin)
// Postgres: run postgresSchema('byoa_ai_login') once
const loginStore = postgresStore({ query, table: 'byoa_ai_login' })

const agents = createAgents({ ...options, login: storedLogin({ store: loginStore, encryptionKey: loginKey }) })
```

To keep each login in a volume of that user and app instead, behind the sandbox adapter, pass `login: cliLogin` (from `@madeyexz/byoa`). Your database then never holds the login. This needs a provider with volumes; on E2B, volumes must be turned on for your team.

### OpenCode Go (beta)

**Beta.** No real OpenCode Go key has run this yet. byoa's tests use a stand-in for OpenCode's API, and the real Claude Code and Codex were checked only against that stand-in, locally and on E2B. The real check (V20 in [SPEC.md](SPEC.md#verification)) has not run.

A user with an [OpenCode Go](https://opencode.ai/docs/console/go) plan (from $10 a month, for models such as Kimi, GLM, DeepSeek, Qwen and MiniMax) can run Claude Code or Codex on it, in place of a Claude or ChatGPT plan. OpenCode Go is a plan, not a harness: the job still runs the unmodified `claude` or `codex`. The user creates an API key in OpenCode's Console (`oc_sk_…`), and your app gives it to byoa one time:

```ts
const r = await agents.connectKey(userId, 'opencode-go', key)   // { state: 'signed-in' }; or 'no-plan', or an error
const models = await agents.listModels(userId, 'opencode-go')    // the plan's models, from OpenCode's API: no sandbox
agents.run(userId, { harness: 'codex', plan: 'opencode-go', model: 'kimi-k3.1-pro', task })
```

byoa checks the key with OpenCode and keeps it encrypted in your database, as it keeps MCP grants. The key never goes into the sandbox. The harness sends its model requests with the job token to `agents.proxy` (at `<proxyUrl>/_plan/opencode-go/…`), and the proxy adds the key and sends them on to OpenCode, with the harness's own user agent and session id, as OpenCode asks. Only the model APIs go through, and only during the job: the agent can make model calls with the job token, as its harness does, and the token stops working when the job ends. Claude Code gets OpenCode's documented `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, Codex a model provider for this job only, each in a config folder with no lab login. A job with a plan needs a model of the plan: `model`, or `createAgents({ models: { 'opencode-go': { model } } })`. The free models (`…-free`) are not in the list: OpenCode serves them only to its own client.

`loginState(userId, 'opencode-go')` is `signed-in`; `expired` when OpenCode refuses the key (a revoked or expired key cannot be renewed: the user makes a new one); or `no-plan` when the key's workspace has no Go plan. A job that gets one of these from OpenCode gives an `error` event with that code. A key does not rotate, so a user's jobs with it run at the same time, with no lease. `signOut(userId, 'opencode-go')` deletes the key.

OpenCode's terms say the user uses its services "only for your own internal use, and not on behalf of or for the benefit of any third party". A job with the user's own key for the user's own task is arguably that, but it is not clearly allowed: ask OpenCode (help@anoma.ly) before your app offers it. See [SPEC.md](SPEC.md#lab-rules).

### Convex

In a Convex app, byoa's state is one table and four internal functions in your deployment (`@madeyexz/byoa/store/convex`). Call byoa from actions and HTTP actions, which can make network calls; serve `agents.proxy` from an HTTP action.

```ts
// convex/schema.ts
import { convexTable } from '@madeyexz/byoa/store/convex'
export default defineSchema({ ...yourTables, byoa: convexTable() })

// convex/byoa.ts
import { convexFunctions } from '@madeyexz/byoa/store/convex'
export const { get, put, remove, cas } = convexFunctions()

// in an action or HTTP action
import { convexStore } from '@madeyexz/byoa/store/convex'
const agents = createAgents({ ...options, store: convexStore(ctx, internal.byoa) })
```

## Test your app without a plan or a sandbox

Use `harness: 'fake'`, `localSandbox()` from `@madeyexz/byoa/sandbox/local` and `memoryStore()`. The fake harness runs no model. It calls MCP tools through the real proxy: each task line `call <server>.<tool> <json>` is one call.

To test byoa itself: `npm test` (V10, V12, the fake-harness tests and the unit tests), and `npm run test:v11` (V11; it downloads about 600 MB). CI runs both on every commit. With `DAYTONA_API_KEY` set, `npm test` also checks the Daytona adapter against Daytona (with `BYOA_DAYTONA_VOLUMES=1` too, also its volumes; that needs a key with the volume permissions); with `E2B_API_KEY` too, it runs V4 ([test/v4.test.ts](test/v4.test.ts)), which needs `cloudflared` to give the proxy a public URL. On a Daytona org on Tier 1 or 2, also set `BYOA_V4_RELAY` to a relay on an allowed domain, such as [test/relay](test/relay/convex/http.ts) deployed to a temporary Convex project. `npm run test:e2b` checks the E2B adapter against E2B and runs V8 there (a user's jobs in one paused and resumed sandbox, and `sandboxPer: 'job'`); it needs `E2B_API_KEY`, and with `BYOA_E2B_VOLUMES=1` also checks volumes, for an E2B team with volumes turned on. `npm run test:instabox` does the same on Instabox; it needs `INSTABOX_API_KEY`. `BYOA_V4_PROVIDERS=e2b,instabox` runs V4 on E2B and Instabox. `npm run test:v20` runs V20, OpenCode Go with the real Claude Code and Codex on E2B; it needs `OPENCODE_GO_API_KEY` (a Console API key of a workspace with Go), `E2B_API_KEY` and `cloudflared`.

## Example app

[examples/todo](examples/todo) is an AI-native to-do list on byoa: the user signs in with their own plan, connects their to-dos one time, and asks Claude Code, Codex or Grok Build to change them. Its backend uses byoa in 39 lines. Its tests use the fake harness, and CI runs them on every commit.

## How we will verify it

We call version 1 done only when all of these checks pass. The full list is in [SPEC.md](SPEC.md#verification).

1. **Two apps use it.** An existing app moves its own login, connector and sandbox code to byoa. A second app uses byoa with no copied code.
2. **Every harness works.** One user runs the same task with Claude Code, with Codex and with Grok Build, each on that user's own plan.
3. **Two providers work.** The same user, with the same MCP grants and skills, runs a job on E2B and then on Daytona or Instabox. Only the adapter changes.
4. **Tokens stay out of the sandbox.** A test searches the sandbox's environment, files and process list for each real MCP token after a job. It must find none.
5. **One refresh owner.** Two jobs run at the same time (one sandbox for each job) and both need a token refresh. The provider sees one refresh request, and no grant is revoked.
6. **The sandbox lifecycle works.** By default, a user's next job resumes the sandbox that was paused after the last one; when the provider lost it, the next job gets a new one. With `sandboxPer: 'job'`, the library destroys the sandbox after a job. In neither case does the user sign in to an MCP server again.

## Rules we follow

- We run the real, unmodified `claude`, `codex` and `grok` binaries. We never pretend to be another client.
- The user signs in through Anthropic's, OpenAI's or xAI's own sign-in page.
- One app's AI login is used only by that app.
- For OpenCode Go, byoa uses only the user's own key, with OpenCode's documented API and the harness's own user agent, never OpenCode's Console CLI sign-in. OpenCode's terms do not clearly allow an app to run it for its users; each app asks OpenCode first.
- The labs' terms restrict where an AI login may be stored. byoa keeps it in your database by default, so each app checks those terms and signs its own agreements with the labs. See [SPEC.md](SPEC.md#lab-rules).

## License

Apache License 2.0. See [LICENSE](LICENSE).

<a href="https://byoa.rippling.computer"><img alt="Bring your own agent." src=".github/readme/end.png"></a>
