// byoa's store adapter for SQLite (copied from examples/todo): byoa keeps its state in this app's own database (R6.1).
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from '@madeyexz/byoa'

/** byoa's store adapter for SQLite: get, put, delete, compare-and-set. A random version per write, so a value
 *  that is deleted and written again never gets an earlier version back. */
export function sqliteStore(db: DatabaseSync): Store {
  db.exec('create table if not exists byoa (key text primary key, value text not null, version text not null)')
  return {
    async get(key) {
      const r = db.prepare('select value, version from byoa where key = ?').get(key) as { value: string; version: string } | undefined
      return r ? { value: r.value, version: r.version } : null
    },
    async put(key, value) {
      db.prepare('insert into byoa values (?, ?, ?) on conflict (key) do update set value = excluded.value, version = excluded.version').run(key, value, randomUUID())
    },
    async delete(key) { db.prepare('delete from byoa where key = ?').run(key) },
    async cas(key, version, value) {
      const r = version === null
        ? db.prepare('insert or ignore into byoa values (?, ?, ?)').run(key, value, randomUUID())
        : db.prepare('update byoa set value = ?, version = ? where key = ? and version = ?').run(value, randomUUID(), key, version)
      return r.changes === 1
    },
  }
}
