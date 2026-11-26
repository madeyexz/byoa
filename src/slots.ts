// The user's kept sandboxes (R5.4): a slot for each user, harness and sandbox key at one provider, with the provider's
// id of the sandbox and the lease of the job that uses it. One job of a slot runs at a time; the others wait in line
// (R5.8). A lease left by a job that never ended runs out after the job timeout and 5 minutes. A store cannot list its
// keys, so an index lists each user's slots.
import { randomToken } from './crypto.ts'
import type { RunHarness } from './harness/types.ts'
import { keys } from './keys.ts'
import { inLine } from './queue.ts'
import type { SandboxProvider } from './sandbox/types.ts'
import { update, type Store } from './store.ts'
import { now } from './time.ts'

interface Slot { sandbox?: string; holder?: string; until: number }
type Indexed = [RunHarness, string]
/** A slot that a job holds: its store key, the job's lease, and the sandbox it had. */
export interface Held { k: string; holder: string; sandbox?: string }

export function slots(store: Store, provider: SandboxProvider, o: { leaseMs: number; waitMs?: number }) {
  const changeIndex = (user: string, f: (list: Indexed[]) => Indexed[]) =>
    update(store, keys.slots(user, provider.name), (v) => JSON.stringify(f(v ? JSON.parse(v) : [])))

  /** Changes the slot while `s.holder` holds it: the sandbox it has now, and a lease (`until`), or 0 to give it back.
   *  False when it does not hold it (deleteSandbox removed it meanwhile). Set and renew try again while the holder
   *  holds it, so a renew of the job's own heartbeat between the read and the write does not make it fail. */
  async function set(s: Pick<Held, 'k' | 'holder'>, sandbox: string | undefined, until: number): Promise<boolean> {
    for (;;) {
      const e = await store.get(s.k)
      if (!e || (JSON.parse(e.value) as Slot).holder !== s.holder) return false
      if (await store.cas(s.k, e.version, JSON.stringify({ sandbox, ...(until ? { holder: s.holder } : {}), until } satisfies Slot))) return true
    }
  }

  return {
    /** Takes the user's sandbox of this harness and key, in line after the jobs that came first (R5.8). */
    async take(user: string, h: RunHarness, key: string, onWait?: (ahead: number) => void): Promise<Held> {
      const k = keys.slot(user, provider.name, h, key), holder = randomToken(12)
      const index = () => changeIndex(user, (l) => l.some(([x, y]) => x === h && y === key) ? l : [...l, [h, key]])
      const mine = () => store.get(k).then((a) => !!a && (JSON.parse(a.value) as Slot).holder === holder, () => false)
      /** The slot that this take's last compare-and-set wrote, or may have written. */
      let tried: Slot | undefined
      return inLine(store, keys.slotLine(user, provider.name, h, key), async () => {
        const e = await store.get(k)
        // a new slot is in the index before it exists, so a backend that dies cannot leave one that no index lists;
        // and again after, in case a remove took it out of the index meanwhile (spec/tla/Index.tla)
        if (!e) await index()
        const cur: Slot = e ? JSON.parse(e.value) : { until: 0 }
        // a cas can write and still answer an error (the network failed after the commit), or false (the app's query
        // function sent it again): then the slot names this holder, and the job holds it. When the read after it fails
        // too, the next call of this function finds it (spec/tla/Store.tla)
        const held = cur.holder === holder && cur.until >= now()
        if (!held) {
          if (cur.until >= now()) return undefined
          tried = { sandbox: cur.sandbox, holder, until: now() + o.leaseMs }
          if (!(await store.cas(k, e?.version ?? null, JSON.stringify(tried)).catch(() => false)) && !(await mine())) return undefined
        }
        if (!e || held) await index()
        return { k, holder, sandbox: cur.sandbox }
      }, { until: o.waitMs === undefined ? undefined : now() + o.waitMs, onWait },
      () => new Error(`byoa: another job of this user still holds the ${h} sandbox${key ? ` ${JSON.stringify(key)}` : ''}; try again when it ends`))
        // the job does not get the slot (waitMs passed, or the store failed): a lease that it may have written goes back
        .catch(async (err) => { if (tried) await set({ k, holder }, tried.sandbox, 0).catch(() => {}); throw err })
    },

    set,

    /** Moves the end of `s.holder`'s lease to `until`, and keeps the sandbox the slot has. False when it does not hold
     *  the slot. */
    async renew(s: Held, until: number): Promise<boolean> {
      for (;;) {
        const e = await store.get(s.k)
        const cur = e && (JSON.parse(e.value) as Slot)
        if (!cur || cur.holder !== s.holder) return false
        if (await store.cas(s.k, e.version, JSON.stringify({ ...cur, until } satisfies Slot))) return true
      }
    },

    /** Deletes the user's kept sandboxes at this provider: all of them, or those of one harness or one key. */
    async remove(user: string, which: { harness?: RunHarness; key?: string } = {}) {
      const match = ([h, key]: Indexed) => (which.harness === undefined || h === which.harness) && (which.key === undefined || key === which.key)
      const e = await store.get(keys.slots(user, provider.name))
      const list: Indexed[] = (e ? JSON.parse(e.value) as Indexed[] : []).filter(match)
      for (const [h, key] of list) {
        const k = keys.slot(user, provider.name, h, key)
        const s = await store.get(k)
        const id = s && (JSON.parse(s.value) as Slot).sandbox
        if (id) await provider.destroy(id)
        await store.delete(k)
      }
      await changeIndex(user, (l) => l.filter((x) => !list.some((y) => y[0] === x[0] && y[1] === x[1])))
      // a job that started meanwhile wrote its slot again: it goes back in the index, so the next remove finds it
      const back: Indexed[] = []
      for (const [h, key] of list) if (await store.get(keys.slot(user, provider.name, h, key))) back.push([h, key])
      if (back.length) await changeIndex(user, (l) => [...l, ...back.filter((x) => !l.some((y) => y[0] === x[0] && y[1] === x[1]))])
    },
  }
}

export type Slots = ReturnType<typeof slots>
