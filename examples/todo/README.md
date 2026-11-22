# AI-native to-do list: an example app on byoa

A small to-do app. The user signs in with their own Claude or ChatGPT plan, connects their to-dos one time, and then asks the agent to change them ("add buy milk, and mark the oldest one done"). Each request is one job: byoa starts a new sandbox, runs the user's own, unmodified Claude Code or Codex in it, and destroys the sandbox after the job.

The app has no code from Bookish. It is the second app for check V2 in [SPEC.md](../../SPEC.md#verification).

## The files

| File | What it does | Lines of code |
|---|---|---|
| [app.ts](app.ts) | The backend, as one fetch handler. All of the app's byoa code is here. | 87 |
| [todos.ts](todos.ts) | The app's own data (SQLite), its MCP server with four to-do tools, and byoa's store adapter for SQLite. | 60 |
| [main.ts](main.ts) | Starts the server on Node and selects the sandbox provider. | 25 |
| [page.html](page.html) | The page: sign in, connect, ask, and the list. | 120 |
| [todo.test.ts](todo.test.ts) | Tests with byoa's fake harness. | 103 |

"Lines of code" does not count empty lines and comments. Of the backend's 172 lines, 35 in app.ts use byoa: `createAgents`, the routes that call `agents.*`, the MCP callback, and the stream of events to the page. The SQLite store adapter is 19 more; with byoa's own Postgres or Convex adapter, it is one line. The rest is the to-do app itself.

## How the app uses byoa

1. **One `createAgents`** ([app.ts](app.ts)). The app gives byoa its sandbox provider, its own database (through `sqliteStore`, 19 lines in [todos.ts](todos.ts)), an encryption key, and the URLs where it serves byoa's MCP proxy and the MCP sign-in callback. The app gives no `login` option, so byoa keeps each user's plan login (the CLI's own login files) encrypted in the app's database, and writes a copy into each job's new sandbox. After the job, byoa saves the files back when the CLI refreshed them. No sandbox volumes are needed. With `login: cliLogin`, the login stays in a volume of the user instead, and the app's database never holds it. The labs' terms restrict where these tokens may be stored: see [SPEC.md](../../SPEC.md#lab-rules), and check them for your own app.
2. **Sign in to the plan.** `agents.connectLogin(user, 'claude')` runs the real `claude auth login` in a sandbox and gives the URL of Anthropic's own sign-in page. The user signs in there and pastes the code that page shows; `agents.finishLogin` types it into the CLI. For ChatGPT, `codex login --device-auth` gives OpenAI's page and a code to enter there.
3. **Connect the to-dos, one time.** `agents.connectMcp(user, '<app>/mcp', { name: 'todos', bearer })` keeps the user's token for the app's own MCP server as an encrypted grant. The user can also connect any remote MCP server (for example Notion) with its own sign-in page; byoa does the OAuth and calls `/byoa/callback`.
4. **Ask.** `agents.run(user, { harness, task, mcp, setup: { agentsMd } })` gives a stream of events (`start`, `text`, `tool_call`, `tool_result`, `error`, `end`) in one schema for both harnesses. The app sends them to the page as they come, one JSON object for each line.
5. **The proxy.** The harness in the sandbox gets only a job token. Its MCP calls go to `agents.proxy`, which adds the user's real token and sends them to the MCP server. The real token never goes into the sandbox.

## Run it

You need Node 22.18 or later. From the root of this repository:

```sh
npm ci                                  # installs and builds byoa
cd examples/todo && npm install
BYOA_KEY=$(openssl rand -base64 32) FAKE=1 npm start
```

Open http://127.0.0.1:3000, type a name, click **Connect my to-dos**, select **Fake harness**, and ask with lines such as `call todos.add_todo {"title":"Buy milk"}`. The fake harness runs no model: each line `call <server>.<tool> <json>` is one MCP call through the real proxy.

In your own app, install byoa with `npm install github:madeyexz/byoa` instead.

### Settings

| Variable | Default | What it is |
|---|---|---|
| `BYOA_KEY` | (required) | 32 random bytes as base64. byoa encrypts the MCP grants and the plan logins with it. Keep it the same between restarts. |
| `SANDBOX` | `local` | `local`, `e2b` (needs `E2B_API_KEY`) or `daytona` (needs `DAYTONA_API_KEY`). |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | Where browsers and sandboxes reach the app. |
| `PORT` | `3000` | |
| `DB` | `.data/todo.db` | The SQLite file. |
| `FAKE` | off | `1` lets jobs use the fake harness. |

The local sandbox is a folder on your computer. It isolates nothing, so use it only on your own computer. With Claude Code or Codex in it, the harness runs on your computer with your login.

With E2B or Daytona, the sandbox must reach the proxy, so `PUBLIC_URL` must be a public HTTPS URL, for example from `cloudflared tunnel --url http://localhost:3000`. On Daytona Tier 1 and Tier 2, a sandbox reaches only [allowed domains](https://www.daytona.io/docs/en/network-limits).

## Test it

```sh
npm test         # the fake harness and the local sandbox: no plan, no sandbox provider
npm run typecheck
```

CI runs both on every commit (`.github/workflows/ci.yml`, job `example-todo`).

## What a real app changes

- **The user.** The page sends the user's name in an `x-user` header. That is a stand-in, not a sign-in: anyone can type any name. A real app reads the user from its own session.
- **The database.** SQLite in one process is enough for one server. For more servers, use byoa's Postgres or Convex store adapter, or write one for your database (four operations: get, put, delete, compare-and-set).
