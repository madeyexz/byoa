// A line of waiting jobs in the store (R5.8): first come, first served, for a user's kept sandbox and for a user's AI
// login. A waiting job keeps a ticket in the line and renews it while it waits, so the ticket of a backend that died
// runs out and the line goes on. Only the first ticket tries to take what it waits for, so no job that came later
// takes it first. Only compare-and-set (R6), so it works on every store.
import { randomToken } from './crypto.ts'
import type { Store } from './store.ts'

/** A ticket runs out this long after the job last renewed it. */
const TICKET_MS = 30_000
const POLL_MS = 500
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Ticket { id: string; until: number }
const live = (value: string | undefined): Ticket[] => {
  const now = Date.now()
  return (value ? JSON.parse(value) as Ticket[] : []).filter((t) => t.until > now)
}

export interface Wait {
  /** When the job stops waiting and fails. Default: no limit. */
  until?: number
  /** How many jobs are ahead of this one, each time that changes. */
  onWait?: (ahead: number) => void
}

/** Calls `take` until it returns something, in the order the jobs came. `take` returns undefined while what it waits
 *  for is held. `timeout` is the error when `w.until` passes. */
export async function inLine<T>(store: Store, key: string, take: () => Promise<T | undefined>, w: Wait, timeout: () => Error): Promise<T> {
  const me = randomToken(12)
  let mine: Ticket | undefined, told = -1
  try {
    for (;;) {
      const e = await store.get(key)
      const line = live(e?.value)
      const at = mine ? line.findIndex((t) => t.id === me) : -1
      const ahead = at < 0 ? line.length : at
      if (ahead === 0) {
        const got = await take()
        if (got !== undefined) return got
      }
      if (w.until !== undefined && Date.now() > w.until) throw timeout()
      // join the line, or renew the ticket when half its time is gone
      if (at < 0 || mine!.until - Date.now() < TICKET_MS / 2) {
        mine = { id: me, until: Date.now() + TICKET_MS }
        const next = at < 0 ? [...line, mine] : line.map((t) => (t.id === me ? mine! : t))
        if (!(await store.cas(key, e?.version ?? null, JSON.stringify(next)))) continue
      }
      if (ahead !== told) { told = ahead; w.onWait?.(ahead) }
      await sleep(POLL_MS)
    }
  } finally {
    if (mine) await leave(store, key, me).catch(() => {})
  }
}

async function leave(store: Store, key: string, id: string) {
  for (;;) {
    const e = await store.get(key)
    if (!e) return
    const line = live(e.value)
    const next = line.filter((t) => t.id !== id)
    if (next.length === JSON.parse(e.value).length && next.length === line.length) return
    if (await store.cas(key, e.version, JSON.stringify(next))) return
  }
}
