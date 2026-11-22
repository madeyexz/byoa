// A Postgres store adapter. Give it your own query function (for example `pool.query` from the `pg` package), and
// create the table once with POSTGRES_SCHEMA (or postgresSchema(table) for another table name).
import type { Entry, Store } from '../store.ts'

/** Every version comes from one sequence, so an entry that is deleted and written again never gets a version that
 *  an earlier entry had: compare-and-set with a version read before the delete fails (no ABA). */
export function postgresSchema(table = 'byoa_kv') {
  name(table)
  return `create sequence if not exists ${table}_version;
create table if not exists ${table} (
  key text primary key,
  value text not null,
  version bigint not null default nextval('${table}_version')
)`
}
export const POSTGRES_SCHEMA = postgresSchema()

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>

function name(t: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error('byoa: table name: lower-case letters, digits and _')
}

export function postgresStore(opts: { query: Query; table?: string }): Store {
  const t = opts.table ?? 'byoa_kv'
  name(t)
  const q = opts.query, next = `nextval('${t}_version')`
  return {
    async get(key): Promise<Entry | null> {
      const r = await q(`select value, version::text as version from ${t} where key = $1`, [key])
      return r.rows[0] ? { value: r.rows[0].value, version: r.rows[0].version } : null
    },
    async put(key, value) {
      await q(`insert into ${t} (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, version = ${next}`, [key, value])
    },
    async delete(key) {
      await q(`delete from ${t} where key = $1`, [key])
    },
    async cas(key, version, value) {
      const r = version === null
        ? await q(`insert into ${t} (key, value) values ($1, $2) on conflict (key) do nothing`, [key, value])
        : await q(`update ${t} set value = $2, version = ${next} where key = $1 and version = $3::bigint`, [key, value, version])
      return (r.rowCount ?? 0) === 1
    },
  }
}
