# AI-native to-do list: an example app on byoa

A small to-do app. The user signs in with their own Claude, ChatGPT or Grok (SuperGrok, X Premium+) plan (or saves the key of their OpenCode Go plan), and then chats with the agent about their to-dos ("add buy milk, and mark the oldest one done", then "now the same for tomorrow"). Each message is one job of the chat: byoa resumes the chat's sandbox (or creates it for the first job), continues the user's own, unmodified Claude Code, Codex or Grok Build session in it, and pauses the sandbox after the job. While the agent works, the user can send it one more message.

The app has no code from Bookish. It is the second app for check V2 in [SPEC.md](../../SPEC.md#verification).

## The files

| File | What it does | Lines of code |
|---|---|---|
| [app.ts](app.ts) | The backend, as one fetch handler. All of the app's byoa code is here. | 100 |
| [todos.ts](todos.ts) | The app's own data (SQLite), its four to-do tools, and byoa's store adapter for SQLite. | 65 |
| [main.ts](main.ts) | Starts the server on Node and selects the sandbox provider. | 24 |
| [page.html](page.html) | The page: sign in, the chat, the list and more tools, styled after shadcn/ui, with no build step. | 365 |
| [todo.test.ts](todo.test.ts) | Tests with byoa's fake harness. | 108 |

"Lines of code" does not count empty lines and comments. Of the backend's 189 lines, 49 in app.ts use byoa: `createAgents`, the routes that call `agents.*`, the chat and its messages while a job runs, the MCP callback, and the stream of events to the page. The SQLite store adapter is 19 more; with byoa's own Postgres or Convex adapter, it is one line. The rest is the to-do app itself.

## How the app uses byoa

1. **One `createAgents`** ([app.ts](app.ts)). The app gives byoa its sandbox provider, its own database (through `sqliteStore`, 19 lines in [todos.ts](todos.ts)), an encryption key, and the URLs where it serves byoa's MCP proxy and the MCP sign-in callback. The app gives no `login` option, so byoa keeps each user's plan login (the CLI's own login files) encrypted in the app's database, and writes a copy into each job's sandbox. After the job, byoa saves the files back when the CLI refreshed them, and removes them from the sandbox. No sandbox volumes are needed. With `login: cliLogin`, the login stays in a volume of the user instead, and the app's database never holds it. The labs' terms restrict where these tokens may be stored: see [SPEC.md](../../SPEC.md#lab-rules), and check them for your own app.
2. **Sign in to the plan.** `agents.connectLogin(user, 'claude')` runs the real `claude auth login` in a sandbox and gives the URL of Anthropic's own sign-in page. The user signs in there and pastes the code that page shows; `agents.finishLogin` types it into the CLI. For ChatGPT, `codex login --device-auth` gives OpenAI's page and a code to enter there; for Grok, `grok login --device-auth` gives xAI's page and a code. For OpenCode Go, the user makes an API key in OpenCode's Console and saves it on the page: `agents.connectKey(user, 'opencode-go', key)` checks it with OpenCode and keeps it encrypted, and a job with `plan: 'opencode-go'` and a model from `agents.listModels(user, 'opencode-go')` runs Claude Code or Codex on it. The key never goes into the sandbox.
3. **The app's own tools.** The four to-do tools are functions in [todos.ts](todos.ts), given to `createAgents({ tools: { todos } })`. `agents.proxy` serves them at `<proxyUrl>/todos` to each job that names `todos` in `mcp`, and gives each tool the user of the job, from the job token. So the app writes no MCP server, keeps no token for it, and the user connects nothing. The user can also connect any remote MCP server (for example Notion) with its own sign-in page: `agents.connectMcp`, then byoa does the OAuth and calls `/byoa/callback`.
4. **Chat.** `agents.run(user, { harness, task, mcp, setup: { agentsMd }, access: 'read-only', conversation: chat })` gives a stream of events (`start`, `text`, `tool_call`, `tool_result`, `error`, `turn`, `end`) in one schema for every harness. The app sends them to the page as they come, one JSON object for each line. `conversation` is the page's id of the chat, so each job continues the harness's own session of the chat (`start` says `resumed`). **New chat** calls `agents.deleteConversation`. `access: 'read-only'`: the agent calls its tools and reads files, and cannot change a file or reach the network by itself.
5. **One more message while the agent works.** `run` returns a `Job`. The app keeps the running jobs by an id that it sends to the page (the `x-job` header), and `POST /api/ask/send` calls `job.send(text)`. A turn that is not the last gives a `turn` event. `send` returns false when the job ended, or with the fake harness, which takes no message while it runs.
6. **The proxy.** The harness in the sandbox gets only a job token. Its MCP calls go to `agents.proxy`, which runs the app's tools, or adds the user's real token and sends the call to the MCP server. The real token never goes into the sandbox.

## Run it

You need Node 22.18 or later. From the root of this repository:

```sh
npm ci                                  # installs and builds byoa
cd examples/todo && npm install
BYOA_KEY=$(openssl rand -base64 32) FAKE=1 npm start
```

Open http://127.0.0.1:3000, type a name, select **Fake harness**, and ask with lines such as `call todos.add_todo {"title":"Buy milk"}`. The fake harness runs no model: each line `call <server>.<tool> <json>` is one MCP call through the real proxy. Ask again in the same chat, and it says how many earlier messages it remembers.

In your own app, install byoa with `npm install @madeyexz/byoa` instead.

### Settings

| Variable | Default | What it is |
|---|---|---|
| `BYOA_KEY` | (required) | 32 random bytes as base64. byoa encrypts the MCP grants, the plan logins and the chats' transcripts with it. Keep it the same between restarts. |
| `SANDBOX` | `local` | `local`, `e2b` (needs `E2B_API_KEY`) or `daytona` (needs `DAYTONA_API_KEY`). |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | Where browsers and sandboxes reach the app. |
| `PORT` | `3000` | |
| `DB` | `.data/todo.db` | The SQLite file. |
| `FAKE` | off | `1` lets jobs use the fake harness. |

The local sandbox is a folder on your computer. It isolates nothing, so use it only on your own computer. With Claude Code, Codex or Grok Build in it, the harness runs on your computer with your login.

With E2B or Daytona, the sandbox must reach the proxy, so `PUBLIC_URL` must be a public HTTPS URL, for example from `cloudflared tunnel --url http://localhost:3000`. On Daytona Tier 1 and Tier 2, a sandbox reaches only [allowed domains](https://www.daytona.io/docs/en/network-limits).

## Test it

```sh
npm test         # the fake harness and the local sandbox: no plan, no sandbox provider (steering needs a real harness)
npm run typecheck
```

CI runs both on every commit (`.github/workflows/ci.yml`, job `example-todo`).

## What a real app changes

- **The user.** The page sends the user's name in an `x-user` header. That is a stand-in, not a sign-in: anyone can type any name. A real app reads the user from its own session.
- **The database.** SQLite in one process is enough for one server. For more servers, use byoa's Postgres or Convex store adapter, or write one for your database (four operations: get, put, delete, compare-and-set).
