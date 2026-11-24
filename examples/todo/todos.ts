// The app's own data and its own MCP server. Nothing here knows about byoa except the Store interface, which
// sqliteStore implements in 20 lines, so byoa keeps its state in this app's own database (R6.1).
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Store } from '@madeyexz/byoa'
import { z } from 'zod'

export interface Todo { id: number; title: string; done: boolean }
export type Todos = ReturnType<typeof todoList>

export function todoList(db: DatabaseSync) {
  db.exec('create table if not exists todos (id integer primary key, user text not null, title text not null, done integer not null default 0)')
  db.exec('create table if not exists tokens (token text primary key, user text not null unique)')
  return {
    /** The user's token for the app's own MCP server. byoa keeps it as that user's grant and puts it on each call
     *  at the proxy; the sandbox never sees it. */
    tokenFor: (user: string): string => {
      db.prepare('insert or ignore into tokens values (?, ?)').run(`todo_${randomUUID()}`, user)
      return String((db.prepare('select token from tokens where user = ?').get(user) as { token: string }).token)
    },
    userOf: (token: string) => (db.prepare('select user from tokens where token = ?').get(token) as { user: string } | undefined)?.user,
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

/** The to-do tools the agent uses, as an MCP server for one user (a fetch handler, stateless). */
export async function todoMcp(req: Request, todos: Todos, user: string): Promise<Response> {
  const s = new McpServer({ name: 'todos', version: '1.0.0' })
  const show = (x: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(x) }], isError })
  s.registerTool('list_todos', { description: "List the user's to-dos: id, title, done." }, async () => show(todos.list(user)))
  s.registerTool('add_todo', { description: 'Add a to-do.', inputSchema: { title: z.string().min(1) } },
    async ({ title }) => show(todos.add(user, title)))
  s.registerTool('complete_todo', { description: 'Mark a to-do done (or, with done: false, not done).', inputSchema: { id: z.number().int(), done: z.boolean().default(true) } },
    async ({ id, done }) => todos.setDone(user, id, done) ? show(todos.list(user).find((t) => t.id === id)) : show(`no to-do ${id}`, true))
  s.registerTool('delete_todo', { description: 'Delete a to-do.', inputSchema: { id: z.number().int() } },
    async ({ id }) => todos.remove(user, id) ? show(`deleted ${id}`) : show(`no to-do ${id}`, true))
  const t = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await s.connect(t)
  return t.handleRequest(req)
}
