// R6: every store adapter has the same get / put / delete / compare-and-set behavior. The Postgres adapter runs on
// PGlite, the real Postgres compiled to WebAssembly.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { memoryStore, type Store } from '../src/store.ts'
import { POSTGRES_SCHEMA, postgresStore } from '../src/store/postgres.ts'

async function pg(): Promise<Store> {
  const db = new PGlite()
  await db.exec(POSTGRES_SCHEMA)
  return postgresStore({ query: async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? 0 } } })
}

for (const [name, make] of [['memory', async () => memoryStore()], ['postgres', pg]] as const) {
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
