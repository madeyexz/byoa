# byoa: bring your own agent

**Status: spec only. No code yet.**

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

## How it will look

This is a sketch. The API can change.

```ts
import { createAgents } from 'byoa'
import { e2b } from 'byoa/sandbox/e2b'
import { convexStore } from 'byoa/store/convex'

const agents = createAgents({ sandbox: e2b({ apiKey }), store: convexStore(ctx) })

await agents.connectLogin(userId, 'claude')                     // real claude CLI sign-in
await agents.connectLogin(userId, 'codex')                      // real codex CLI, device auth
await agents.connectMcp(userId, 'https://mcp.notion.com/mcp')   // OAuth, one refresh owner
const run = await agents.run(userId, { harness: 'claude', task, skills: ['./skills'] })
```

To change the provider, change `e2b(...)` to `daytona(...)`.

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
