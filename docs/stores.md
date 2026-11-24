# Stores and Convex

byoa keeps its state in your own database, through a store adapter: MCP grants, AI logins (by default), login states, sandbox slots and leases. Grants and AI logins are encrypted with your `encryptionKey`.

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

The version must change on every write, and a key that is deleted and written again must never get an earlier version back. The one refresh owner of each grant, the login lease and the sandbox slots depend on `cas`. The to-do example's `sqliteStore` in [examples/todo/todos.ts](../examples/todo/todos.ts) is one in 19 lines.

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

A Convex action has a time limit, so set `waitMs` shorter than the default 10 minutes. On Daytona Tier 1 and 2, `*.convex.site` is an allowed domain for the proxy.

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

To keep each login in a volume of that user and app instead, behind the sandbox adapter, pass `login: cliLogin` (from `@madeyexz/byoa`). Your database then never holds the login. This needs a provider with volumes; see [AI login](ai-login.md#where-the-login-stays-between-jobs).

## Tests

Use `memoryStore()` from `@madeyexz/byoa`. See [Testing](testing.md).
