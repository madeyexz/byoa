// A Convex store adapter. byoa's state is one table in the app's own Convex deployment, read and written by four
// internal functions that the app exports from one file of its `convex/` folder:
//
//   // convex/schema.ts:  defineSchema({ ...yourTables, byoa: convexTable() })
//   // convex/byoa.ts:    export const { get, put, remove, cas } = convexFunctions()
//   // in an action:      store: convexStore(ctx, internal.byoa)
//
// Each function is one Convex query or mutation, and Convex runs mutations as serializable transactions, so `cas` is
// exact across every action and HTTP action at once (R6.2). Use it from actions and HTTP actions (they have runQuery
// and runMutation); byoa makes network calls, which queries and mutations cannot.
import { defineTable, internalMutationGeneric, internalQueryGeneric, type DefaultFunctionArgs, type FunctionReference, type GenericDatabaseReader } from 'convex/server'
import { v } from 'convex/values'
import type { Entry, Store } from '../store.ts'

/** The table: put it in the app's schema, under the name given to convexFunctions (default `byoa`). */
export const convexTable = () => defineTable({ key: v.string(), value: v.string(), n: v.number() }).index('by_key', ['key'])

const find = (db: GenericDatabaseReader<any>, table: string, key: string) => db.query(table).withIndex('by_key', (q) => q.eq('key', key)).unique()
// the version names the row too, so an entry that was deleted and written again never has an old version (no ABA)
const version = (r: { _id: string; n: number }) => `${r._id}.${r.n}`

/** The four internal functions convexStore calls. Export them from one file of the app's `convex/` folder. */
export function convexFunctions(table = 'byoa') {
  return {
    get: internalQueryGeneric({
      args: { key: v.string() },
      handler: async (ctx, { key }): Promise<Entry | null> => {
        const r = await find(ctx.db, table, key)
        return r ? { value: r.value, version: version(r) } : null
      },
    }),
    put: internalMutationGeneric({
      args: { key: v.string(), value: v.string() },
      handler: async (ctx, { key, value }) => {
        const r = await find(ctx.db, table, key)
        if (r) await ctx.db.patch(r._id, { value, n: r.n + 1 })
        else await ctx.db.insert(table, { key, value, n: 1 })
        return null
      },
    }),
    remove: internalMutationGeneric({
      args: { key: v.string() },
      handler: async (ctx, { key }) => {
        const r = await find(ctx.db, table, key)
        if (r) await ctx.db.delete(r._id)
        return null
      },
    }),
    cas: internalMutationGeneric({
      args: { key: v.string(), version: v.union(v.string(), v.null()), value: v.string() },
      handler: async (ctx, { key, version: want, value }): Promise<boolean> => {
        const r = await find(ctx.db, table, key)
        if ((r ? version(r) : null) !== want) return false
        if (r) await ctx.db.patch(r._id, { value, n: r.n + 1 })
        else await ctx.db.insert(table, { key, value, n: 1 })
        return true
      },
    }),
  }
}

type Fn<T extends 'query' | 'mutation', A extends DefaultFunctionArgs, R> = FunctionReference<T, 'internal', A, R>

export interface ConvexStoreFunctions {
  get: Fn<'query', { key: string }, Entry | null>
  put: Fn<'mutation', { key: string; value: string }, null>
  remove: Fn<'mutation', { key: string }, null>
  cas: Fn<'mutation', { key: string; version: string | null; value: string }, boolean>
}

/** The store for one action or HTTP action: `ctx` is its context, `fns` the app's exported functions, such as
 *  `internal.byoa`. */
export function convexStore(
  ctx: { runQuery: (f: any, args: any) => Promise<any>; runMutation: (f: any, args: any) => Promise<any> },
  fns: ConvexStoreFunctions,
): Store {
  return {
    get: (key) => ctx.runQuery(fns.get, { key }),
    put: async (key, value) => { await ctx.runMutation(fns.put, { key, value }) },
    delete: async (key) => { await ctx.runMutation(fns.remove, { key }) },
    cas: (key, version, value) => ctx.runMutation(fns.cas, { key, version, value }),
  }
}
