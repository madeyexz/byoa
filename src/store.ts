// The store adapter (R6): the only place byoa keeps state, in the app's own database. Four operations, so an app can
// write one for any database. byoa keeps there: MCP grants (encrypted, R2.4), the job tokens the proxy accepts (only
// their hashes), the user's AI login (the CLI's own files, encrypted, R1.4) and its login state, and pending MCP
// sign-ins.

/** A stored value and its version. The version changes on every write; compare-and-set compares it. */
export interface Entry {
  value: string
  version: string
}

/** What byoa needs of an adapter (spec/tla/Store.tla): each call takes effect at one instant, and a `get` answers the
 *  latest write: no read replica and no cache, or a line can serve a later job first and update() can lose an index
 *  entry. A version never repeats for a key, also after a delete (no per-row counter). A write that throws should not
 *  have written; never send a write again after an error (a lease taken by a write whose answer was lost stays until
 *  it runs out). */
export interface Store {
  get(key: string): Promise<Entry | null>
  /** Writes the value whatever is there now. */
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /** Writes the value only if the entry still has `version` (`null`: only if there is no entry). True if it wrote.
   *  The one refresh owner of each grant (R2.3) depends on this. */
  cas(key: string, version: string | null, value: string): Promise<boolean>
}

/** Changes one entry with compare-and-set (R6.2), again until no other writer came between: `f` gets the value now
 *  (undefined when there is none) and returns the next one, or undefined to leave it as it is. Every lease, line and
 *  index of byoa changes its entry through this. Returns the value before the change. */
export async function update(store: Store, key: string, f: (now: string | undefined) => string | undefined): Promise<string | undefined> {
  for (;;) {
    const e = await store.get(key)
    const next = f(e?.value)
    if (next === undefined || next === e?.value) return e?.value
    if (await store.cas(key, e?.version ?? null, next)) return e?.value
  }
}

/** A store in this process's memory: for tests, and for one-process apps that accept losing state on restart. */
export function memoryStore(): Store & { readonly size: number; keys(): string[] } {
  const data = new Map<string, Entry>()
  let n = 0
  return {
    get size() { return data.size },
    keys: () => [...data.keys()],
    async get(key) { return data.get(key) ?? null },
    async put(key, value) { data.set(key, { value, version: String(++n) }) },
    async delete(key) { data.delete(key) },
    async cas(key, version, value) {
      const cur = data.get(key)
      if ((cur?.version ?? null) !== version) return false
      data.set(key, { value, version: String(++n) })
      return true
    },
  }
}
