# Testing

## Test your app without a plan or a sandbox

Use `harness: 'fake'`, `localSandbox()` from `@madeyexz/byoa/sandbox/local` and `memoryStore()` from `@madeyexz/byoa`. The fake harness runs no model and needs no login. It reads the same MCP config Claude Code would, and calls MCP tools through the real proxy: each task line `call <server>.<tool> <json>` is one call. So a test proves your app's routes, grants and proxy end to end.

```ts
import { createAgents, memoryStore } from '@madeyexz/byoa'
import { localSandbox } from '@madeyexz/byoa/sandbox/local'

// serve agents.proxy at http://127.0.0.1:3000/byoa/mcp, as in Getting started
const agents = createAgents({
  app: 'myapp-test', sandbox: localSandbox(), store: memoryStore(), encryptionKey,
  proxyUrl: 'http://127.0.0.1:3000/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1:3000/byoa/callback' },
  tools: { todos: todoTools },
})
for await (const ev of agents.run('u1', { harness: 'fake', task: 'call todos.add_todo {"title":"milk"}', mcp: ['todos'] })) {
  if (ev.type === 'end') assert.ok(ev.ok)
}
```

- The fake harness shows the task's first line as one `text` event and skips the other lines. The last call's output is the `end` event's `result`.
- In a `conversation`, the fake harness keeps each task in a session file and says how many earlier messages it remembers (`fake harness remembers 1 earlier messages: <first line>`), so you test your app's conversations with no model.
- With the local sandbox, `proxyUrl` can be `http://127.0.0.1:<port>/byoa/mcp`.
- Copy [examples/todo/todo.test.ts](https://github.com/madeyexz/byoa/blob/main/examples/todo/todo.test.ts). Do not offer `fake` to end users in production.

## Test byoa itself

- `npm test` runs V10, V12, the fake-harness tests and the unit tests. `npm run test:v11` runs V11; it downloads about 600 MB. CI runs both on every commit.
- `npm test` never starts a paid sandbox, also when the providers' keys are set: each paid check needs its own flag. `npm run test:daytona` checks the Daytona adapter against Daytona and runs V8 there. It needs `DAYTONA_API_KEY`, and with `BYOA_DAYTONA_VOLUMES=1` also checks its volumes; that needs a key with the volume permissions. `npm run test:v4` runs V4 ([test/v4.test.ts](https://github.com/madeyexz/byoa/blob/main/test/v4.test.ts)) with `E2B_API_KEY` and `DAYTONA_API_KEY`; it needs `cloudflared` to give the proxy a public URL. On a Daytona org on Tier 1 or 2, also set `BYOA_V4_RELAY` to a relay on an allowed domain, such as [test/relay](https://github.com/madeyexz/byoa/blob/main/test/relay/convex/http.ts) deployed to a temporary Convex project.
- `npm run test:e2b` checks the E2B adapter against E2B and runs V8 there (a user's jobs in one paused and resumed sandbox, and `sandboxPer: 'job'`). It needs `E2B_API_KEY`, and with `BYOA_E2B_VOLUMES=1` also checks volumes, for an E2B team with volumes turned on.
- `npm run test:instabox` does the same on Instabox. It needs `INSTABOX_API_KEY`. `BYOA_V4_PROVIDERS=e2b,instabox` runs V4 on E2B and Instabox.
- Each of these adapter tests first runs the conformance check, [test/helpers/conformance.ts](https://github.com/madeyexz/byoa/blob/main/test/helpers/conformance.ts); `npm test` runs it on the local sandbox.
- `node scripts/v21.ts` runs V21 (conversations and steering with real logins on E2B) in steps, because a person signs in: `login claude|codex|grok`, then `check`, then `cleanup`, which signs out and deletes the sandboxes. It needs `E2B_API_KEY`.

- `spec/tla/check.sh` runs V22: TLC checks the TLA+ models of the job lifecycle, the login lease, the sign-in, the store and its adapters, steering, the MCP grant's refresh, job tokens, plan keys, the usage-limit hold and the hosted demo ([spec/tla](https://github.com/madeyexz/byoa/blob/main/spec/tla/README.md)). It needs Java 11 or later, and downloads TLC the first time. `TLA_SET=fast spec/tla/check.sh` runs the fast set (about 15 minutes); the whole set takes hours. No CI runs them: run them by hand when a protocol or its model changes.

The checks V1 to V22 are in [SPEC.md](https://github.com/madeyexz/byoa/blob/main/SPEC.md#verification).
