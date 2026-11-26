// R6: every store adapter has the same get / put / delete / compare-and-set behavior. The Postgres adapter runs on
// PGlite, the real Postgres compiled to WebAssembly; the Convex adapter on convex-test, Convex's own mock backend, with
// the functions and table exactly as an app exports them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { memoryStore, type Store } from '../src/store.ts'
import { POSTGRES_SCHEMA, postgresStore } from '../src/store/postgres.ts'
import { anyApi, defineSchema } from 'convex/server'
import { convexTest } from 'convex-test'
import { convexFunctions, convexStore, convexTable } from '../src/store/convex.ts'
import { keys } from '../src/keys.ts'
import type { SandboxProvider } from '../src/sandbox/types.ts'
import { slots } from '../src/slots.ts'
import { clock, now } from '../src/time.ts'

async function pg(): Promise<Store> {
  const db = new PGlite()
  await db.exec(POSTGRES_SCHEMA)
  return postgresStore({ query: async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? 0 } } })
}

async function convex(): Promise<Store> {
  const t = convexTest(defineSchema({ byoa: convexTable() }), {
    '/convex/_generated/api.js': async () => ({}),
    '/convex/byoa.ts': async () => convexFunctions(),
  })
  return convexStore({ runQuery: t.query, runMutation: t.mutation }, anyApi.byoa as any)
}

for (const [name, make] of [['memory', async () => memoryStore()], ['postgres', pg], ['convex', convex]] as const) {
  test(`store ${name}: get, put, delete`, async () => {
    const s = await make()
    assert.equal(await s.get('a'), null)
    await s.put('a', 'one')
    const e = await s.get('a')
    assert.equal(e?.value, 'one')
    await s.put('a', 'two')
    const f = await s.get('a')
    assert.equal(f?.value, 'two')
    assert.notEqual(f?.version, e?.version)
    await s.delete('a')
    assert.equal(await s.get('a'), null)
    await s.delete('a') // deleting nothing is fine
  })

  test(`store ${name}: compare-and-set writes only on the version it read`, async () => {
    const s = await make()
    assert.equal(await s.cas('k', null, 'first'), true)
    assert.equal(await s.cas('k', null, 'again'), false, 'null means: only if there is no entry')
    const e = (await s.get('k'))!
    assert.equal(await s.cas('k', e.version, 'second'), true)
    assert.equal(await s.cas('k', e.version, 'stale'), false, 'an old version must not write')
    assert.equal((await s.get('k'))!.value, 'second')
    await s.delete('k')
    assert.equal(await s.cas('k', e.version, 'gone'), false, 'a deleted entry has no version')
    // deleted and written again: a version read before the delete must not match the new entry (no ABA)
    await s.put('k', 'new')
    assert.equal(await s.cas('k', e.version, 'stale'), false, 'an entry written again has a new version')
    assert.equal((await s.get('k'))!.value, 'new')
  })

  test(`store ${name}: of many writers with one version, exactly one wins`, async () => {
    const s = await make()
    await s.put('race', '0')
    const v = (await s.get('race'))!.version
    const won = await Promise.all(Array.from({ length: 10 }, (_, i) => s.cas('race', v, String(i + 1))))
    assert.equal(won.filter(Boolean).length, 1)
    assert.equal((await s.get('race'))!.value, String(won.indexOf(true) + 1))
  })
}

// A lost answer (spec/tla/Store.tla, Store_lease_*): the store wrote, but the caller got an error (the network failed
// after the commit), or the app's query function sent the write again and answered what the second one did (false).
// The job's take must still hold the slot, else its lease blocks the slot until it runs out (the job timeout + 5 min).
for (const lost of ['an error', 'false from a second send'] as const) {
  test(`slots.take: a cas that wrote but answered ${lost} still takes the slot`, async () => {
    const k = keys.slot('u', 'p', 'codex', '')
    const mem = memoryStore()
    let armed = true
    const store: Store = {
      get: (key) => mem.get(key), put: (key, v) => mem.put(key, v), delete: (key) => mem.delete(key),
      async cas(key, version, value) {
        const wrote = await mem.cas(key, version, value)
        if (!armed || key !== k || !wrote) return wrote
        armed = false
        if (lost === 'an error') throw new Error('connection reset')
        return mem.cas(key, version, value)
      },
    }
    const sl = slots(store, { name: 'p' } as SandboxProvider, { leaseMs: 60_000, waitMs: 1_500 })
    const held = await sl.take('u', 'codex', '')
    assert.equal(JSON.parse((await mem.get(k))!.value).holder, held.holder)
  })
}

// The job's heartbeat renews its slot every minute while the job starts (job.ts), also while set writes the new
// sandbox: a renew that writes between set's read and its write must not make set fail, or the job ends, destroys the
// new sandbox and never gives the slot back (spec/tla/Store.tla, Store_lease_main_beat).
for (const until of ['a new sandbox', 'the slot given back'] as const) {
  test(`slots.set with ${until}, while a renew of the same holder writes`, async () => {
    const mem = memoryStore()
    const sl = slots(mem, { name: 'p' } as SandboxProvider, { leaseMs: 60_000 })
    const held = await sl.take('u', 'codex', '')
    const t = until === 'a new sandbox' ? now() + 120_000 : 0
    // the renew reads first and writes first: set read the slot before that write
    const [, set] = await Promise.all([sl.renew(held, now() + 90_000), sl.set(held, 'sbx-new', t)])
    assert.equal(set, true)
    assert.deepEqual(JSON.parse((await mem.get(keys.slot('u', 'p', 'codex', '')))!.value), { sandbox: 'sbx-new', ...(t ? { holder: held.holder } : {}), until: t })
  })
}

// A lost answer of take's cas, and the read after it fails too (the network is still down), or the job gives up
// (waitMs) right after: the job holds the slot, or leaves no lease (Store_lease_main_getfail, _fixed_getfail).
for (const then of ['the next read works', 'the job gives up'] as const) {
  test(`slots.take: a cas that wrote but answered an error, and a read after it that failed, then ${then}: the job holds the slot or leaves no lease`, async () => {
    const k = keys.slot('u', 'p', 'codex', '')
    const mem = memoryStore()
    let armed = true, failGets = 0
    const real = clock.now
    const store: Store = {
      async get(key) { if (key === k && failGets > 0) { failGets--; throw new Error('connection refused') } return mem.get(key) },
      put: (key, v) => mem.put(key, v), delete: (key) => mem.delete(key),
      async cas(key, version, value) {
        const wrote = await mem.cas(key, version, value)
        if (!armed || key !== k || !wrote) return wrote
        armed = false
        failGets = 1
        if (then === 'the job gives up') { const t = real() + 5_000; clock.now = () => t }
        throw new Error('connection reset')
      },
    }
    try {
      const sl = slots(store, { name: 'p' } as SandboxProvider, { leaseMs: 60_000, waitMs: 1_500 })
      const held = await sl.take('u', 'codex', '').catch(() => undefined)
      const slot = JSON.parse((await mem.get(k))!.value)
      if (then === 'the next read works') assert.equal(slot.holder, held?.holder, 'the job holds the slot')
      else assert.ok(!held && slot.holder === undefined, `no lease of a job that did not get the slot: ${JSON.stringify(slot)}`)
    } finally { clock.now = real }
  })
}
