# Stores and Convex

byoa keeps its state in your own database, through a store adapter: MCP grants, AI logins (by default), login states, sandbox slots and leases, and conversations (the harness's session id and a copy of its transcript). Grants, AI logins and conversations are encrypted with your `encryptionKey`.

## The store adapter

A store is four methods. byoa ships one for Postgres, one for Convex and one in memory for tests. For another database, write your own.

```ts
interface Entry { value: string; version: string }
interface Store {
  get(key: string): Promise<Entry | null>
  put(key: string, value: string): Promise<void>                        // writes whatever is there
  delete(key: string): Promise<void>
  cas(key: string, version: string | null, value: string): Promise<boolean>  // null: only if no entry; true if it wrote
}
```

The version must change on every write, and a key that is deleted and written again must never get an earlier version back. The one refresh owner of each grant, the login lease and the sandbox slots depend on `cas`. The to-do example's `sqliteStore` in [examples/todo/todos.ts](https://github.com/madeyexz/byoa/blob/main/examples/todo/todos.ts) is one in 19 lines.

## The keys byoa writes

Every key is in one file, [src/keys.ts](https://github.com/madeyexz/byoa/blob/main/src/keys.ts). The values marked sealed are encrypted with your `encryptionKey`, with the key as associated data; the others hold no secret. `<user>` and the sandbox key are URL-encoded.

| Key | What it holds |
|---|---|
| `grant/<user>/<name>` | sealed: one MCP grant |
| `grants/<user>` | the names and URLs of the user's grants |
| `lease/<user>/<name>` | the lease of the one refresh of a grant |
| `mcpflow/<state>` | sealed: an MCP sign-in that has not come back yet |
| `job/<hash>`, `jobid/<job>` | a job token, by its hash, and its hash by the job id |
| `login/<user>/<h>`, `loginjob/<user>/<h>` | the state of a lab login; a sign-in that runs now |
| `ailogin/<user>/<h>` | sealed: the CLI's own login files |
| `ailoginlease/…`, `ailoginline/…`, `ailoginloan/…` | who holds the login, the jobs that wait for it, and the sandboxes that have a copy |
| `aikey/<user>/<plan>`, `aikeystate/<user>/<plan>` | sealed: a plan's key; its state |
| `usersandbox/<user>/<provider>/<h>/<key>` (and `…/line`) | a kept sandbox: its id and the lease of its job; the jobs that wait for it |
| `usersandboxes/<user>/<provider>` | the user's kept sandboxes |
| `conversation/<user>/<h>/<id>` | sealed: a conversation's session id and its transcript (at most `transcriptBytes`) |
| `conversations/<user>` | the user's conversations |

A conversation's transcript can be large: with the default `transcriptBytes` (700 000) one entry stays below a Convex document's 1 MiB. Postgres has no such limit.

## Postgres

```ts
import { postgresStore, POSTGRES_SCHEMA } from '@madeyexz/byoa/store/postgres'

await pool.query(POSTGRES_SCHEMA)  // once; or postgresSchema('my_table')
const store = postgresStore({ query: (sql, args) => pool.query(sql, args) })
```

## Convex

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

A Convex action has a time limit, and a job waits in line with no limit by default, so set `waitMs` shorter than the action's limit. On Daytona Tier 1 and 2, `*.convex.site` is an allowed domain for the proxy.

## A table of its own for the AI logins

To keep the logins in a table of their own, with a key of their own, so that you can give them their own access rules and backups:

```ts
import { createAgents, storedLogin } from '@madeyexz/byoa'

// Convex: convex/schema.ts has  byoaLogin: convexTable(),  and convex/byoaLogin.ts has
//   export const { get, put, remove, cas } = convexFunctions('byoaLogin')
const loginStore = convexStore(ctx, internal.byoaLogin)
// Postgres: run postgresSchema('byoa_ai_login') once
const loginStore = postgresStore({ query, table: 'byoa_ai_login' })

const agents = createAgents({ ...options, login: storedLogin({ store: loginStore, encryptionKey: loginKey }) })
```

To keep each login in a volume of that user and app instead, behind the sandbox adapter, pass `login: cliLogin` (from `@madeyexz/byoa`). Your database then never holds the login. This needs a provider with volumes; see [AI login](https://byoa.rippling.computer/docs/ai-login.md#where-the-login-stays-between-jobs).

## Tests

Use `memoryStore()` from `@madeyexz/byoa`. See [Testing](https://byoa.rippling.computer/docs/testing.md).
