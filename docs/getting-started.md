# Getting started

New to byoa? Read the [Overview](README.md) first. In short: byoa is a library in your app's backend. Each user signs in to their own Claude or ChatGPT plan one time, and connects each MCP tool one time. When your app has work for the AI, byoa runs that user's own Claude Code or Codex in a sandbox, with the user's tools, and streams the events back to your app. The user's plan pays for the AI, and your app pays for the sandbox.

This page takes you from `npm install` to a first agent job: one `agents` object, two routes, a sign-in and a job. A new app needs fewer than 50 lines of its own code for this. The [to-do example](../examples/todo) uses byoa in 39.

## Install

<!-- include: ../README.md#install -->

## Make one `agents` object

Make one `agents` object in your backend: once for each process, or once in each Convex action.

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
})
```

- **`app`**: lower-case letters, digits and `-`, at most 24. It names the app's sandboxes and login volumes.
- **`sandbox`**: the [sandbox provider](providers.md). To change the provider, change this one line.
- **`store`**: your own database, through a [store adapter](stores.md). For Postgres, run `POSTGRES_SCHEMA` once.
- **`encryptionKey`**: 32 random bytes as base64. Keep it the same between restarts, and keep it secret.
- **`proxyUrl`**: a public HTTPS URL. The sandbox must reach it. In development, use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

The default E2B template is named `byoa`, and a new E2B account does not have it. Build it one time with `buildE2BTemplate()`, or pass `e2b({ template: 'base' })`. See [Sandbox providers](providers.md#e2b).

## Serve two routes

byoa's handlers are fetch handlers (`Request` → `Response`). On Node, wrap your app's handler with `toNodeListener` from `@madeyexz/byoa/node`.

```ts
if (url.pathname.startsWith('/byoa/mcp/')) return agents.proxy(req)  // the MCP proxy: no app session check here
if (url.pathname === '/byoa/callback') {                               // the MCP server's sign-in page sends the browser here
  const p = url.searchParams
  await agents.finishMcp({ state: p.get('state') ?? '', code: p.get('code') ?? undefined, error: p.get('error') ?? undefined })
  return Response.redirect(`${publicUrl}/`, 302)
}
```

- The proxy checks the job token itself. Do not put your app's session check in front of it: the harness in the sandbox has no app session.
- Every other route reads the user from your app's own session. The `userId` you give byoa is your app's stable user id. Never take it from a header or a body that the browser controls.

## Sign the user in to their plan

The sign-in runs the unmodified CLI in a sandbox. The user signs in on the lab's own page. byoa gives your app only that page's URL and, for Codex, a code. See [AI login](ai-login.md) for each step.

```ts
const claude = await agents.connectLogin(userId, 'claude')  // { url }: Anthropic's own sign-in page
await agents.finishLogin(userId, 'claude', { code })        // the code that page shows
const codex = await agents.connectLogin(userId, 'codex')    // { url, code }: OpenAI's page and the code to enter
await agents.finishLogin(userId, 'codex', { waitMs: 20_000 })  // call again while the state is 'pending'
await agents.cancelLogin(userId, 'codex')                     // the user closed the sign-in: its sandbox ends now
```

The sign-in's sandbox lives only while your sign-in UI checks in: each `finishLogin` call keeps it for 2 more minutes. For Claude Code, call `finishLogin(userId, 'claude')` with no code about every 30 seconds while the user is on Anthropic's page.

A user with an OpenCode Go plan (beta) gives a key instead: `agents.connectKey(userId, 'opencode-go', key)`. See [AI login](ai-login.md#opencode-go-a-key-not-a-sign-in-beta).

## Connect an MCP tool, one time

```ts
const mcp = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
// mcp.signInUrl: the server's sign-in page; your redirectUrl route then calls agents.finishMcp({ state, code })
```

Every later job of this user can have this server. Your app's own data needs no MCP server: give its tools to `createAgents` as functions. See [MCP tools and the proxy](mcp.md).

## Run a job

```ts
for await (const event of agents.run(userId, { harness: 'claude', task, mcp: ['notion'], setup: { agentsMd, skills } })) {
  // start, text, tool_call, tool_result, permission, error, end: the same events for Claude Code and Codex
}
```

`run` does not throw when a job fails. It gives `error` events, then always one `end` event. See [Running agents](running-agents.md) for the events, what the agent may do, and jobs at the same time.

## Let a coding agent do it

<!-- include: ../README.md#agent-skill -->

## Next

- Read [Concepts](concepts.md) to learn who holds what, and where.
- Run the [to-do example](../examples/todo): an AI-native to-do list, with tests that use the fake harness.
- Test your app with no plan and no sandbox: [Testing](testing.md).
- Follow the [Lab rules](lab-rules.md). Every app on byoa must.
