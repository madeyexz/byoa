# Sandbox providers

Each sandbox provider is one adapter with one interface. Version 1 has E2B, Daytona and Instabox, and a local sandbox for development and tests. To change the provider, change the adapter that you give `createAgents`:

```ts
import { e2b } from '@madeyexz/byoa/sandbox/e2b'
const agents = createAgents({ ...options, sandbox: e2b({ apiKey }) })   // or daytona({ apiKey }), instabox({ apiKey })
```

`e2b()`, `daytona()` and `instabox()` read their API key from `E2B_API_KEY`, `DAYTONA_API_KEY` or `INSTABOX_API_KEY` when you give none. The sandbox must reach your `proxyUrl`. [Sandbox lifecycle](sandbox-lifecycle.md#how-each-provider-pauses-and-times-out) compares how each provider pauses and times out.

| | E2B | Daytona | Instabox | Local |
|---|---|---|---|---|
| Import | `@madeyexz/byoa/sandbox/e2b` | `@madeyexz/byoa/sandbox/daytona` | `@madeyexz/byoa/sandbox/instabox` | `@madeyexz/byoa/sandbox/local` |
| Package to install | `e2b` | `@daytona/sdk` | none | none |
| Between jobs, a kept sandbox is | paused | stopped | stopped | a folder |
| Volumes for `cliLogin` | yes, when volumes are on for your team | one shared volume, a subpath for each login | none: use `storedLogin()` | folders |
| A sign-in with no check-in ends | 2 min after the last `finishLogin` | 2 min after the last `finishLogin` | after 15 min (no keepAlive) | 2 min after the last `finishLogin` |
| Network | every public domain | Tier 1 and 2: allowed domains only | every public domain | this computer |

## E2B

Use `e2b({ apiKey?, template?, timeoutMs? })`. It needs the `e2b` package.

- The default template is named `byoa`, and a new E2B account does not have it: the first job then fails with `404: template 'byoa' not found`. Build it one time for each pin change with `buildE2BTemplate()`, or pass `e2b({ template: 'base' })`. Any template with Node 20 or later works: byoa then installs the pinned harness in each new sandbox (about 10 seconds).
- `pause` takes a snapshot of the files only where the team can (`mode: 'filesystem'`), else a full one after it ends the sandbox's processes. E2B keeps a paused sandbox with no time limit.
- A kept sandbox that times out (a crash, a lost network) is paused, not killed. When byoa resumes a sandbox that paused itself, it ends any old process first.

## Daytona

Use `daytona({ apiKey?, client?, snapshot?, volume?, timeoutMs? })`. It needs `@daytona/sdk`.

- `pause` stops the sandbox, and `resume` starts it, also from archived (more slowly). A kept sandbox is not ephemeral and has no time to live; Daytona archives it after 7 days stopped. A sandbox for one job is ephemeral: Daytona deletes it when it stops, and at the latest after its time.
- Daytona allows 100 volumes for each organization, so with `cliLogin` the adapter keeps every user's AI login in its own subpath of one shared volume (`byoa` by default). A sandbox mounts only that user's subpath.
- On Daytona Tier 1 and Tier 2, a sandbox can reach only [allowed domains](https://www.daytona.io/docs/en/network-limits), so serve `agents.proxy` on one of them (for example `*.convex.site`), or use Tier 3 or higher. `*.workers.dev` is on Daytona's list but does not work: a Worker's address has two labels below it (`<worker>.<account>.workers.dev`), and Daytona does not resolve those.

## Instabox

Use `instabox({ apiKey?, apiUrl?, template?, snapshot?, timeoutMs? })`. It calls Instabox's HTTP API itself, so it needs no package.

- Each sandbox starts from the `agent-browser` template (Node 22, user `user`, home `/data/home`), or from a snapshot that you name (`snapshot`).
- byoa stops the user's sandbox after each job (not Instabox's pause), so the next job starts it again with its files and no process of the last one. A sandbox that paused itself (idle for 30 minutes, or at the plan's longest run) is booted again. A sandbox for one job is deleted after it, and at the latest at its `timeoutMs`.
- byoa gives a sandbox none of your account's Vault items or org Secrets, and leaves its commands out of Instabox's command history, which would otherwise keep their output (and so the AI login that byoa reads back).
- Instabox has no volumes, so `cliLogin` does not work there; the default stored login does. Instabox sandboxes reach every public domain, so a tunnel works for `proxyUrl`.
- On the free plan, a workspace has one sandbox in all, also when it is stopped (so one user with one kept sandbox, or one job), and three starts a minute (byoa waits when Instabox answers 429). A run starts with 2 hours before Instabox pauses the sandbox, and grows to 8 hours at most while the sandbox is in use ([limits](https://instabox.sh/docs/account/limits)).

## The local sandbox

`localSandbox({ root?, volumes?, env? })` is folders on this computer. It isolates nothing: use it only for development and tests, and with `access: 'read-only'` for a harness on a user's own computer. On macOS, the Codex sign-in works in it; the Claude Code sign-in needs Linux.

## Write an adapter

An adapter implements one interface ([src/sandbox/types.ts](../src/sandbox/types.ts)): create (with volumes), resume, run a command, write a file, pause, destroy, delete a volume, and optionally read a file, set a running sandbox's time again (`Sandbox.setTimeout`), `capabilities`, and keepAlive (a new end time for a sandbox that is not kept: byoa uses it to end a sign-in 2 minutes after the app's last check-in).

```ts
interface SandboxProvider {
  readonly name: string
  readonly capabilities?: { volumes: boolean }  // optional; false: create refuses a volume, and createAgents refuses cliLogin
  create(opts?: { volumes?: { name: string; path: string }[]; labels?: Record<string, string>; timeoutMs?: number; keep?: boolean }): Promise<Sandbox>
  resume(id: string, opts?: { timeoutMs?: number }): Promise<Sandbox>  // starts a paused one; throws SandboxGoneError when it is gone
  destroy(id: string): Promise<void>                                   // by id, running or paused
  deleteVolume(name: string): Promise<void>
  keepAlive?(id: string, ms: number): Promise<void>  // optional: a sandbox that is not kept ends ms from now (the sign-in's check-ins)
}
```

- `keep: true` is a sandbox that byoa keeps for the user. When it times out, the provider must pause it instead of deleting it, and no process of that job may run when it resumes.
- A provider with no volumes refuses `create` with volumes, and says `capabilities: { volumes: false }`.
- `run` resolves for a non-zero exit code, and with exit code 137 for a command that runs out of its `timeoutMs`; it does not throw.
- `Sandbox.readFile(path)` (optional) reads a file through the provider's file API, or gives null. byoa reads the login files and a conversation's transcript with it; without it, byoa reads them as base64 on a command's output, which a provider may keep in its command history.
- `Sandbox.setTimeout(ms)` (optional) sets the provider's time of a running sandbox again, `ms` from now, as `timeoutMs` at create: then a kept sandbox pauses, and another one ends. byoa calls it when a job has the user's AI login, so the time the job waited in line for the login does not count.
- `test/helpers/conformance.ts` in byoa's repository checks what byoa needs of an adapter: run it on yours, as `test/fake.test.ts` does for the local one.
- The [API reference](api.md#sandbox-adapter) has the `Sandbox` interface.
