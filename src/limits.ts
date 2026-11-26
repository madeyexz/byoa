// A plan that is used up (R1.9). When a job ends with `usage-limit`, byoa keeps that in the store, by user and by
// harness (a lab login: one account of one lab) or by plan (OpenCode Go: one key for both harnesses), until the plan
// resets: `resetsAt` when the tool said, else LIMIT_HOLD_MS. Until then a job ends at once with the same error and
// starts no sandbox, and `usageLimit` tells the app before it runs one. A new sign-in, a new key and a sign-out end
// it; so does the next job that works.
import { keys } from './keys.ts'
import { update, type Store } from './store.ts'
import { now } from './time.ts'

/** How long a used-up plan holds when the tool did not say when it resets (Grok Build says no time). */
export const LIMIT_HOLD_MS = 15 * 60_000

/** `message`: the tool's own words. `resetsAt`: when the plan resets (ms since 1970), when the tool said. `until`:
 *  when byoa starts this user's jobs of this harness or plan again (`resetsAt`, else LIMIT_HOLD_MS after the error). */
export interface UsageLimit { message: string; resetsAt?: number; until: number }
interface Kept extends UsageLimit { at: number }
/** What `clear` with a limit leaves: the store has no compare-and-delete, so an empty value, which `get` reads as none. */
const CLEARED = ''

export function usageLimits(store: Store) {
  const key = keys.usageLimit
  return {
    /** The kept limit, also one that has ended (`until` is past), and its store version. */
    async get(user: string, name: string): Promise<(Kept & { version: string }) | undefined> {
      const e = await store.get(key(user, name))
      if (!e || e.value === CLEARED) return undefined
      try { return { ...(JSON.parse(e.value) as Kept), version: e.version } } catch { return undefined }
    },
    async set(user: string, name: string, o: { message: string; resetsAt?: number }) {
      const t = now()
      // a reset time that has passed says nothing about now (Claude Code's record of a refusal is never updated)
      const resetsAt = o.resetsAt !== undefined && o.resetsAt > t ? o.resetsAt : undefined
      const kept: Kept = { message: o.message, ...(resetsAt ? { resetsAt } : {}), until: resetsAt ?? t + LIMIT_HOLD_MS, at: t }
      // another job kept a later reset meanwhile (another of the plan's limits): that one holds (spec/tla/UsageLimit.tla)
      await update(store, key(user, name), (v) => {
        let old: Kept | undefined
        try { old = v ? JSON.parse(v) as Kept : undefined } catch {}
        return JSON.stringify(old && old.until > kept.until ? { message: o.message, ...(old.resetsAt ? { resetsAt: old.resetsAt } : {}), until: old.until, at: t } : kept)
      })
    },
    /** Ends the kept limit. With `held` (a job that worked): only the limit that job read before it ran, not one that
     *  another job kept while it ran (spec/tla/UsageLimit.tla). */
    async clear(user: string, name: string, held?: { version: string }) {
      if (held) await store.cas(key(user, name), held.version, CLEARED)
      else await store.delete(key(user, name))
    },
  }
}

export type UsageLimits = ReturnType<typeof usageLimits>
