// The app's own data and its own tools. Nothing here knows about byoa except two of its types: the Store interface,
// which sqliteStore implements in 20 lines, so byoa keeps its state in this app's own database (R6.1), and AppTool,
// so the agent calls the to-do functions below as the tools of an MCP server that byoa serves (R2.7).
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AppTool, Store } from '@madeyexz/byoa'

export interface Todo { id: number; title: string; done: boolean }
export type Todos = ReturnType<typeof todoList>

export function todoList(db: DatabaseSync) {
  db.exec('create table if not exists todos (id integer primary key, user text not null, title text not null, done integer not null default 0)')
  return {
    list: (user: string): Todo[] => db.prepare('select id, title, done from todos where user = ? order by id').all(user)
      .map((r: any) => ({ id: Number(r.id), title: String(r.title), done: r.done === 1 })),
    add: (user: string, title: string): Todo => {
      const r = db.prepare('insert into todos (user, title) values (?, ?)').run(user, title)
      return { id: Number(r.lastInsertRowid), title, done: false }
    },
    setDone: (user: string, id: number, done: boolean) => db.prepare('update todos set done = ? where user = ? and id = ?').run(done ? 1 : 0, user, id).changes > 0,
    remove: (user: string, id: number) => db.prepare('delete from todos where user = ? and id = ?').run(user, id).changes > 0,
  }
}

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

/** The to-do tools the agent uses. byoa gives `run` the user of the job, from the job token, so a tool never takes
 *  the user from its arguments. byoa does not check the arguments against `input`: each tool checks its own. */
export function todoTools(todos: Todos): Record<string, AppTool> {
  const id = (v: unknown) => { if (!Number.isInteger(v)) throw new Error('id: a whole number'); return v as number }
  const ID = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
  return {
    list_todos: { description: "List the user's to-dos: id, title, done.", run: (_, { user }) => todos.list(user) },
    add_todo: {
      description: 'Add a to-do.',
      input: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] },
      run: ({ title }, { user }) => {
        if (typeof title !== 'string' || !title.trim()) throw new Error('title: a text that is not empty')
        return todos.add(user, title)
      },
    },
    complete_todo: {
      description: 'Mark a to-do done (or, with done: false, not done).',
      input: { type: 'object', properties: { ...ID.properties, done: { type: 'boolean', default: true } }, required: ['id'] },
      run: (a, { user }) => {
        if (!todos.setDone(user, id(a.id), a.done !== false)) throw new Error(`no to-do ${a.id}`)
        return todos.list(user).find((t) => t.id === a.id)
      },
    },
    delete_todo: {
      description: 'Delete a to-do.',
      input: ID,
      run: (a, { user }) => { if (!todos.remove(user, id(a.id))) throw new Error(`no to-do ${a.id}`); return `deleted ${a.id}` },
    },
  }
}
