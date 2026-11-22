# byoa: bring your own agent

**Status: core library in progress, not on npm yet.**

byoa is an open-source library that helps you build AI-native apps fast. Your app runs the user's own Claude Code or Codex in a sandbox. The user signs in with their own ChatGPT or Claude plan, so they pay for the AI work with a plan they already have. The user connects each MCP tool (Notion, Gmail, and others) one time, and every agent run has it.

Version 1 supports two sandbox providers: E2B and Daytona. More providers come later. To change the provider, you change one adapter.

## The problem

To make an app AI-native, you run a big lab's harness (Claude Code or Codex) in a sandbox, with the user's own AI plan. For each app, you must build the same connection layer again:

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

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │ END USER                                                               │
 │ has: ChatGPT or Claude plan · Notion, Gmail, Heptabase accounts        │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 │ uses the app
 ┌───────────────────────────────▼────────────────────────────────────────┐
 │ YOUR APP   (its own backend)        calls: agents.run(userId, task)    │
 │ ╔════════════════════════════════════════════════════════════════════╗ │
 │ ║ byoa  (open source, runs inside your backend)                      ║ │
 │ ║  login flow (real claude/codex CLI) · sandbox adapters             ║ │
 │ ║  MCP OAuth + one refresh owner      · harness installer (pinned)   ║ │
 │ ║  skills / AGENTS.md / mcp.json      · MCP proxy                    ║ │
 │ ║  token store: your own database                                    ║ │
 │ ╚════════════════════════════════════════════════════════════════════╝ │
 └──────┬──────────────────────────────┬───────────────────────┬──────────┘
        │ create / resume / destroy    │ MCP calls via proxy   │ mount
 ┌──────▼─────────────────────┐ ┌──────▼──────────────┐ ┌──────▼─────────┐
 │ SANDBOX PROVIDER           │ │ MCP SERVER OWNERS   │ │ USER-OWNED     │
 │ v1: E2B · Daytona          │ │ Notion · Gmail ·    │ │ LOGIN VOLUME   │
 │ later: Modal, Vercel, ...  │ │ Heptabase · ...     │ │ ~/.claude      │
 │ ┌────────────────────────┐ │ └─────────────────────┘ │ ~/.codex       │
 │ │ HARNESS in the sandbox │ │                         └────────────────┘
 │ │ Claude Code / Codex    │─┼──── model calls on the user's plan ───┐
 │ └────────────────────────┘ │                                       │
 └────────────────────────────┘                                       │
                                               ┌──────────────────────▼──┐
                                               │ AI LABS                 │
                                               │ Anthropic · OpenAI      │
                                               └─────────────────────────┘
```

## Install

byoa is not on npm yet. Until version 1, install it from GitHub:

```sh
npm install github:madeyexz/byoa     # npm builds it on install
bun add github:madeyexz/byoa        # Bun loads its TypeScript source
```

From version 1: `npm install byoa` or `bun add byoa`. For E2B, also install `e2b`. byoa needs Node 22.18 or later, or Bun.

## How it will look

This is the API in this repository today. It can change before version 1.

```ts
import { createAgents } from 'byoa'
import { e2b } from 'byoa/sandbox/e2b'
import { postgresStore } from 'byoa/store/postgres'

const agents = createAgents({
  app: 'myapp',                                    // each app has its own login volumes
  sandbox: e2b({ apiKey }),
  store: postgresStore({ query: (sql, args) => pool.query(sql, args) }),
  encryptionKey,                                   // openssl rand -base64 32; grants are encrypted with it
  proxyUrl: 'https://myapp.example.com/byoa/mcp',  // serve agents.proxy here
  oauth: { redirectUrl: 'https://myapp.example.com/byoa/callback' },
})

const claude = await agents.connectLogin(userId, 'claude')  // { url }: Anthropic's own sign-in page
await agents.finishLogin(userId, 'claude', { code })        // the code that page shows
const codex = await agents.connectLogin(userId, 'codex')    // { url, code }: OpenAI's page and the code to enter
await agents.finishLogin(userId, 'codex', { waitMs: 60_000 })

const mcp = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
// mcp.signInUrl: the server's sign-in page; your redirectUrl route then calls agents.finishMcp({ state, code })

for await (const event of agents.run(userId, { harness: 'claude', task, mcp: ['notion'], setup: { agentsMd, skills } })) {
  // start, text, tool_call, tool_result, permission, error, end: the same events for Claude Code and Codex
}
```

An app that runs its own program around the unmodified harness (for example its own server, which starts `claude` or `codex` itself) opens the job with `agents.session` instead. It gets the same sandbox, login, pinned harness and job token, and runs its own command:

```ts
const s = await agents.session(userId, { harness: 'claude', mcp: ['notion'] })
try {
  // s.bin: the pinned claude binary; s.env: its login folder and the job token; s.mcp: [{ name, url }] at the proxy
  await s.sandbox.run(`my-server --claude ${s.bin}`, { env: s.env })
} finally { await s.close() }  // ends the job token and destroys the sandbox
```

A program outside byoa's sandboxes, such as a harness on the user's own computer, gets a job token with no sandbox: `const t = await agents.jobToken(userId, { mcp: ['notion'] })` gives `t.token` and `t.mcp` (the proxy URLs), with the same rules as a job's token, until `t.close()`.

To move an MCP grant that the user already made elsewhere into byoa, call `agents.importMcp(userId, { name, url, oauth })` with the MCP SDK's state (`client`, `tokens`, `at`). Delete the old copy, so the grant keeps one refresh owner.

Each job runs in a new sandbox, and byoa destroys the sandbox after the job. The user's AI login stays in a volume of that user and app. The MCP config in the sandbox points to `agents.proxy`, with a token for that one job. The real MCP tokens stay in your database.

To change the provider, change `e2b(...)` to another adapter. An adapter implements one interface ([src/sandbox/types.ts](src/sandbox/types.ts)): create (with volumes), resume, run a command, write a file, destroy.

For Daytona, use `daytona({ apiKey })` from `byoa/sandbox/daytona` (it needs `@daytona/sdk`). Daytona allows 100 volumes per organization, so the adapter keeps every user's AI login in its own subpath of one shared volume (`byoa` by default). A sandbox mounts only that user's subpath. On Daytona Tier 1 and Tier 2, a sandbox can reach only [allowed domains](https://www.daytona.io/docs/en/network-limits), so serve `agents.proxy` on one of them (for example `*.convex.site` or `*.workers.dev`), or use Tier 3 or higher.

### Convex

In a Convex app, byoa's state is one table and four internal functions in your deployment (`byoa/store/convex`). Call byoa from actions and HTTP actions, which can make network calls; serve `agents.proxy` from an HTTP action.

```ts
// convex/schema.ts
import { convexTable } from 'byoa/store/convex'
export default defineSchema({ ...yourTables, byoa: convexTable() })

// convex/byoa.ts
import { convexFunctions } from 'byoa/store/convex'
export const { get, put, remove, cas } = convexFunctions()

// in an action or HTTP action
import { convexStore } from 'byoa/store/convex'
const agents = createAgents({ ...options, store: convexStore(ctx, internal.byoa) })
```

## Test your app without a plan or a sandbox

Use `harness: 'fake'`, `localSandbox()` from `byoa/sandbox/local` and `memoryStore()`. The fake harness runs no model. It calls MCP tools through the real proxy: each task line `call <server>.<tool> <json>` is one call.

To test byoa itself: `npm test` (V10, the fake-harness tests and the unit tests), and `npm run test:v11` (V11; it downloads about 600 MB). CI runs both on every commit. With `DAYTONA_API_KEY` set, `npm test` also checks the Daytona adapter against Daytona; with `E2B_API_KEY` too, it runs V4 ([test/v4.test.ts](test/v4.test.ts)), which needs `cloudflared` to give the proxy a public URL. `npm run test:e2b` checks the E2B adapter against E2B; it needs `E2B_API_KEY` and an E2B team with volumes turned on.

## How we will verify it

We call version 1 done only when all of these checks pass. The full list is in [SPEC.md](SPEC.md#verification).

1. **Two apps use it.** An existing app moves its own login, connector and sandbox code to byoa. A second app uses byoa with no copied code.
2. **Two harnesses work.** One user runs the same task with Claude Code and with Codex, each on that user's own plan.
3. **Two providers work.** The same user, with the same MCP grants and skills, runs a job on E2B and then on Daytona. Only the adapter changes.
4. **Tokens stay out of the sandbox.** A test searches the sandbox's environment, files and process list for each real MCP token after a job. It must find none.
5. **One refresh owner.** Two jobs run at the same time and both need a token refresh. The provider sees one refresh request, and no grant is revoked.
6. **Sandboxes are disposable.** The library destroys the sandbox after a job. The next job starts in a new sandbox, and the user does not sign in to an MCP server again.

## Rules we follow

- We run the real, unmodified `claude` and `codex` binaries. We never pretend to be another client.
- The user signs in through Anthropic's or OpenAI's own sign-in page.
- One app's AI login is used only by that app.
- Each app signs its own agreements with the labs when it needs them. See [SPEC.md](SPEC.md#lab-rules).

## License

Apache License 2.0. See [LICENSE](LICENSE).
