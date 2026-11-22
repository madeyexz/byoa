// A Postgres store adapter. Give it your own query function (for example `pool.query` from the `pg` package), and
// create the table once with POSTGRES_SCHEMA.
import type { Entry, Store } from '../store.ts'

export const POSTGRES_SCHEMA = `create table if not exists byoa_kv (
  key text primary key,
  value text not null,
  version bigint not null default 1
)`

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>

export function postgresStore(opts: { query: Query; table?: string }): Store {
  const t = opts.table ?? 'byoa_kv'
  if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error('byoa: table name: lower-case letters, digits and _')
  const q = opts.query
  return {
    async get(key): Promise<Entry | null> {
      const r = await q(`select value, version::text as version from ${t} where key = $1`, [key])
      return r.rows[0] ? { value: r.rows[0].value, version: r.rows[0].version } : null
    },
    async put(key, value) {
      await q(`insert into ${t} (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, version = ${t}.version + 1`, [key, value])
    },
    async delete(key) {
      await q(`delete from ${t} where key = $1`, [key])
    },
    async cas(key, version, value) {
      const r = version === null
        ? await q(`insert into ${t} (key, value) values ($1, $2) on conflict (key) do nothing`, [key, value])
        : await q(`update ${t} set value = $2, version = version + 1 where key = $1 and version = $3::bigint`, [key, value, version])
      return (r.rowCount ?? 0) === 1
    },
  }
}
