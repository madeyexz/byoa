# Getting started

New to byoa? Read the [Introduction](https://byoa.rippling.computer/docs/index.md) first. In short: byoa is a library in your app's backend. Each user signs in to their own Claude, ChatGPT or Grok plan one time, and connects each MCP tool one time. When your app has work for the AI, byoa runs that user's own Claude Code, Codex or Grok Build in a sandbox, with the user's tools, and streams the events back to your app. The user's plan pays for the AI, and your app pays for the sandbox.

This page takes you from `npm install` to a first agent job: one `agents` object, two routes, a sign-in and a job. A new app needs fewer than 50 lines of its own code for this. The [to-do example](https://github.com/madeyexz/byoa/tree/main/examples/todo), a chat with the agent, uses byoa in 49.

## Install

Install byoa from npm. Its package is `@madeyexz/byoa`, because npm does not allow the name `byoa`:

```sh
npm install @madeyexz/byoa
bun add @madeyexz/byoa
```

Also install the sandbox SDK that your app uses: `e2b` for E2B, `@daytona/sdk` for Daytona. Instabox and the local sandbox need none. byoa needs Node 22.18 or later, or Bun. To use the newest commit on `main` before it is released, install from GitHub: `npm install github:madeyexz/byoa`.

## Get a sandbox API key

Your app pays for the sandboxes, so your app needs its own account and API key at one sandbox provider. Make an account, make a key, and put the key in your backend's environment. Do not send the key to the browser.

- **E2B**: [sign up](https://console.e2b.dev/sign-up), then copy a key from [API keys](https://console.e2b.dev/?tab=keys). byoa reads `E2B_API_KEY`. The free plan gives $100 of credit one time and runs 10 sandboxes at a time; a paused sandbox does not count. A sandbox runs for 1 hour at most before it must pause, so one job can take at most 1 hour ([billing and limits](https://e2b.dev/docs/billing)).
- **Daytona**: [sign up](https://app.daytona.io), then make a key in [API keys](https://app.daytona.io/dashboard/keys). byoa reads `DAYTONA_API_KEY`. A new account gets $200 of compute ([pricing](https://www.daytona.io/pricing)). On Tier 1 and 2, a sandbox can reach only [allowed domains](https://www.daytona.io/docs/en/network-limits).
- **Instabox**: [sign up](https://dashboard.instabox.sh), then make a key in [API keys](https://dashboard.instabox.sh/dashboard/api-keys). byoa reads `INSTABOX_API_KEY`. The free plan has 1 sandbox in all, also when it is stopped, so it is enough for 1 user's kept sandbox or 1 job ([limits](https://instabox.sh/docs/account/limits)).

```sh
export E2B_API_KEY=e2b_...
```

- With the variable set, `e2b()`, `daytona()` and `instabox()` read the key themselves. To give the key from somewhere else, such as your secret store, pass it: `e2b({ apiKey })`.
- A Daytona key needs `write:sandboxes` and `delete:sandboxes`, and for `cliLogin` also `read:volumes`, `write:volumes` and `delete:volumes`. An Instabox key needs `machines:write` and `machines:delete`.
- For development and tests, `localSandbox()` needs no key. It isolates nothing. See [Testing](https://byoa.rippling.computer/docs/testing.md).

You need no AI key. Each user signs in to their own Claude, ChatGPT or Grok plan, and that plan pays for the AI. To compare the providers, see [Sandbox providers](https://byoa.rippling.computer/docs/providers.md).

## Make one `agents` object

Make one `agents` object in your backend: once for each process, or once in each Convex action.

```ts
import { createAgents } from '@madeyexz/byoa'
import { e2b } from '@madeyexz/byoa/sandbox/e2b'
import { postgresStore } from '@madeyexz/byoa/store/postgres'

const agents = createAgents({
  app: 'myapp',                                    // one app's AI logins are only this app's
  sandbox: e2b(),                                  // reads E2B_API_KEY
  store: postgresStore({ query: (sql, args) => pool.query(sql, args) }),
  encryptionKey,                                   // openssl rand -base64 32; grants and AI logins are encrypted with it
  proxyUrl: 'https://myapp.example.com/byoa/mcp',  // serve agents.proxy here
  oauth: { redirectUrl: 'https://myapp.example.com/byoa/callback' },
})
```

- **`app`**: lower-case letters, digits and `-`, at most 24. It names the app's sandboxes and login volumes.
- **`sandbox`**: the [sandbox provider](https://byoa.rippling.computer/docs/providers.md). To change the provider, change this one line.
- **`store`**: your own database, through a [store adapter](https://byoa.rippling.computer/docs/stores.md). For Postgres, run `POSTGRES_SCHEMA` once.
- **`encryptionKey`**: 32 random bytes as base64. Keep it the same between restarts, and keep it secret.
- **`proxyUrl`**: a public HTTPS URL. The sandbox must reach it. In development, use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

The default E2B template is named `byoa`, and a new E2B account does not have it. Build it one time with `buildE2BTemplate()`, or pass `e2b({ template: 'base' })`. See [Sandbox providers](https://byoa.rippling.computer/docs/providers.md#e2b).

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

The sign-in runs the unmodified CLI in a sandbox. The user signs in on the lab's own page. byoa gives your app only that page's URL and, for Codex and Grok Build, a code. See [AI login](https://byoa.rippling.computer/docs/ai-login.md) for each step.

```ts
const claude = await agents.connectLogin(userId, 'claude')  // { url }: Anthropic's own sign-in page
await agents.finishLogin(userId, 'claude', { code })        // the code that page shows
const codex = await agents.connectLogin(userId, 'codex')    // { url, code }: OpenAI's page and the code to enter
await agents.finishLogin(userId, 'codex', { waitMs: 20_000 })  // call again while the state is 'pending'
await agents.cancelLogin(userId, 'codex')                     // the user closed the sign-in: its sandbox ends now
const grok = await agents.connectLogin(userId, 'grok')      // { url, code }: xAI's page and the code; finish as for Codex
```

The sign-in's sandbox lives only while your sign-in UI checks in: each `finishLogin` call keeps it for 2 more minutes. For Claude Code, call `finishLogin(userId, 'claude')` with no code about every 30 seconds while the user is on Anthropic's page.

A user with an OpenCode Go plan (beta) gives a key instead: `agents.connectKey(userId, 'opencode-go', key)`. See [AI login](https://byoa.rippling.computer/docs/ai-login.md#opencode-go-a-key-not-a-sign-in-beta).

## Connect an MCP tool, one time

```ts
const mcp = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
// mcp.signInUrl: the server's sign-in page; your redirectUrl route then calls agents.finishMcp({ state, code })
```

Every later job of this user can have this server. Your app's own data needs no MCP server: give its tools to `createAgents` as functions. See [MCP tools and the proxy](https://byoa.rippling.computer/docs/mcp.md).

## Run a job

```ts
for await (const event of agents.run(userId, { harness: 'claude', task, mcp: ['notion'], setup: { agentsMd, skills } })) {
  // start, text, tool_call, tool_result, permission, error, end: the same events for every harness
}
```

`run` does not throw when a job fails. It gives `error` events, then always one `end` event. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md) for the events, what the agent may do, and jobs at the same time.

## Let a coding agent do it

[skills/byoa](https://github.com/madeyexz/byoa/tree/main/skills/byoa) is a skill in the [Agent Skills](https://agentskills.io) format. It teaches a coding agent (Claude Code, Codex, Amp and others) to add byoa to an app: the install, `createAgents` with a store and a sandbox adapter, the sign-in, the MCP connections and their routes, `agents.run` and its events, and the lab rules. Its `metadata.version` is the `version` in byoa's package.json next to it.

The npm package has the skill in it (from 1.1.0). After you install byoa, link the skill of the installed version into your app's repository for Claude Code, Codex, Amp, Cursor and others, so it always matches the package:

```sh
npx skills experimental_sync -y
```

`experimental_sync` is a preview command of the [skills](https://github.com/vercel-labs/skills) CLI. Without it, or with byoa 1.0.0, install the skill of one release from its tag (here 1.1.0; use the tag of your version), or the skill of `main`:

- one release: `npx skills add madeyexz/byoa@v1.1.0 --skill byoa`
- `main`: `npx skills add madeyexz/byoa`, or for Amp `amp skill add madeyexz/byoa/skills/byoa`

For LLMs, the site also serves the docs as [llms.txt](https://byoa.rippling.computer/llms.txt) (an index) and [llms-full.txt](https://byoa.rippling.computer/llms-full.txt) (the docs, SPEC.md, the example and the skill in one file), and each docs page as Markdown (add `.md` to its address).

## Next

- Read the [Overview](https://byoa.rippling.computer/docs/concepts.md) to learn who holds what, and where.
- Try the [live demo](https://byoa.rippling.computer/demo): sign in with your own Claude, ChatGPT or Grok plan, and your own agent triages a sample inbox.
- Run the [to-do example](https://github.com/madeyexz/byoa/tree/main/examples/todo): an AI-native to-do list, with tests that use the fake harness.
- Test your app with no plan and no sandbox: [Testing](https://byoa.rippling.computer/docs/testing.md).
- Follow the [Lab rules](https://byoa.rippling.computer/docs/lab-rules.md). Every app on byoa must.
