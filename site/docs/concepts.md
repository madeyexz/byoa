# Concepts

**Your app brings the product. Each user brings the agent.** You build the app and pick the sandbox. Each user brings their plan and their tools. byoa runs inside your backend and runs each job in that user's own sandbox.

Think of the user's AI subscription as a battery pack, and of your app as an appliance. The user brings the battery. byoa is the plug: it connects the user's plan, and the user's tools, to the agent features of your app. Your app supplies only the place where the agent runs, the sandbox.

## Who brings what

Diagram: You build the app and import byoa. Each user signs in with their own plan and connects their tools once. Your app code calls agents.run. byoa is a library inside your app&#x27;s backend, and keeps AI logins and MCP grants in your database. Below your backend&#x27;s edge, byoa drives three things that run outside it: a new sandbox for each job at E2B or Daytona on your account, where the user&#x27;s own Claude Code or Codex runs; the AI labs, whose model calls the user&#x27;s own plan pays; and the user&#x27;s MCP servers, which get the real token from byoa&#x27;s proxy.

```text
DEVELOPER · YOU                                           END USER
┌────────────────────────────────────┐                    ┌────────────────────────────────────┐
│ builds the app                     │                    │ uses the app                       │
│ picks the sandbox provider         │                    │ has a Claude or ChatGPT plan       │
│ owns the database                  │                    │ has MCP tools and skills           │
└──────────────────┬─────────────────┘                    └──────────────────┬─────────────────┘
                   │ imports byoa             signs in on the lab&#x27;s own page │
                   │                             connects each MCP tool once │
                   ▼                                                         ▼
┌─ YOUR APP&#x27;S BACKEND · you run it ────────────────────────────────────────────────────────────┐
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
  ┃ │ E2B or Daytona,          │  │ Anthropic · OpenAI       │  │ Notion · Gmail · …       │ ┃
  ┃ │ on your account          ├─▶│ model calls, paid by     │  │ the user&#x27;s own accounts  │ ┃
  ┃ │ runs the user&#x27;s own      │  │ the user&#x27;s own plan      │  │                          │ ┃
  ┃ │ Claude Code or Codex     │  │                          │  │                          │ ┃
  ┃ └──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘ ┃
  ┃                                                                                          ┃
  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

- **You, the developer**, build the app, pick the sandbox provider (E2B, Daytona or Instabox, on your own account) and own the database. You import byoa into your app's backend.
- **The end user** uses your app. They have a Claude or ChatGPT plan, and accounts in tools such as Notion or Gmail. They sign in on the lab's own page one time, and connect each MCP tool one time.
- **byoa** is a library in your backend. It keeps the user's AI login and MCP grants in your database, encrypted with your key. For each job, it gets a sandbox at your provider and runs the user's own, unmodified Claude Code or Codex there.
- **The AI labs** (Anthropic, OpenAI) get the model calls. The user's own plan pays for them, not your API bill.
- **The MCP servers** get the real token from byoa's proxy in your backend, never from the sandbox.

## The problem

To make an app AI-native, you run a big lab's harness (Claude Code or Codex) in a sandbox, with the user's own AI plan. For each app, you must build the same connection layer again:

- the user's AI login, through the real CLI;
- the user's MCP connections and their OAuth tokens, with one refresh owner;
- the user's skills and AGENTS.md;
- the harness install and its updates;
- the code that connects all of this to one sandbox provider.

byoa is that layer, as a library, so you do not build it again for each app.

## What byoa is, and what it is not

- byoa **is** a library. It runs inside your app's own backend (Node, Bun or Convex). Cloudflare Workers support is planned.
- byoa **stores tokens in your own database**, through a store adapter.
- byoa **is not** a hosted service. We do not run a server, and we never see your users' tokens.

| | Version 1 | Later |
|---|---|---|
| Agents | Claude Code, Codex | Gemini or Antigravity, maybe |
| User plans | Claude, ChatGPT, OpenCode Go key (beta) | |
| Sandboxes | E2B, Daytona, Instabox | other providers |
| Backends | Node, Convex actions | Cloudflare Workers |
| Token stores | Convex, Postgres, or your own with get, put, delete and compare-and-set | |

## How a job runs

Your app calls `agents.run(userId, task)`. byoa takes the user's sandbox, loads the user's setup, and runs the user's own harness on the user's own plan. The [sandbox lifecycle](https://byoa.rippling.computer/docs/sandbox-lifecycle.md) has every step and every decision.

Diagram: One job, from agents.run to the end event

1. Your app calls agents.run. `agents.run(userId, { harness, task, mcp, setup })`.
2. Take the user's sandbox. By default, resume the user's kept sandbox, or create it for the first job. With `sandboxPer 'job'`, create a new one.
3. Load the setup. The pinned harness, the skills, AGENTS.md, and an MCP config that points to your proxy with a job token.
4. Copy the AI login in. From your database, decrypted in your backend. Login files: login files in.
5. Run the harness. Text, tool calls and permission requests stream back as events. MCP calls go through the proxy.
6. close() This is the end. End the job token, save the login back if the CLI changed it, remove it from the sandbox, then pause or destroy the sandbox. Login files: files removed.

The user's AI login and MCP grants stay in your database between jobs. A kept sandbox keeps the files that the app wrote there and the installed harness, but no login.

## Real tokens never go into the sandbox

The agent in the sandbox gets a short-lived job token, for one job and one user. The proxy in your backend adds the real MCP token to each request.

Diagram: How an MCP call from the sandbox gets the real token

1. The harness calls an MCP tool. Its MCP config points to your proxy, at `<proxyUrl>/<name>`, with the job token. It has no real MCP token.
2. Question: Is the job token good for this server? If yes: go on to step 3.
   - If no: Refuse the call. This is the end. The job ended, or the job did not get this server.
3. Add the real token. From your database, encrypted with your key. byoa refreshes it when it is due, with one refresh owner.
4. Send the request on to the MCP server. This is the end. The answer goes back to the harness. The real token does not.

[MCP tools and the proxy](https://byoa.rippling.computer/docs/mcp.md) has the details, and [AI login](https://byoa.rippling.computer/docs/ai-login.md) says where the user's AI login is at each step.
