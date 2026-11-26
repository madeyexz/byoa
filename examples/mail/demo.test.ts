// The hosted demo's rules (convex/demo.ts) on convex-test, Convex's mock backend: the limits that keep a public demo's
// sandbox cost small. The actions that run byoa (convex/agents.ts) are stand-ins here; the real ones are checked on the
// deployment.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { internalActionGeneric } from 'convex/server'
import { anyApi } from 'convex/server'
import { convexTest } from 'convex-test'
import schema from './convex/schema.ts'

const api = anyApi as any, internal = anyApi as any
const scheduled: string[] = []
const stub = (name: string) => internalActionGeneric({ handler: async (_ctx: unknown, a: any) => { scheduled.push(`${name} ${a.visitor ?? a.job}`) } })
const modules = {
  '/convex/_generated/api.js': () => import('./convex/_generated/api.js'),
  '/convex/demo.ts': () => import('./convex/demo.ts'),
  '/convex/mail.ts': () => import('./convex/mail.ts'),
  '/convex/track.ts': () => import('./convex/track.ts'),
  '/convex/agents.ts': async () => ({ runJob: stub('runJob'), cancel: stub('cancel'), forget: stub('forget') }),
}
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const view = (t: any, visitor: string) => t.query(api.demo.view, { visitor })

test('jobs wait in line behind sign-ins, one job a visitor, the daily budget stops new work, and visitors are forgotten', async () => {
  process.env.MAX_SANDBOXES = '3'
  process.env.SIGNIN_PLACES = '2'
  delete process.env.POSTHOG_KEY
  const t = convexTest(schema, modules)

  // one sign-in's sandbox runs: of 3 places, 2 are for sign-ins only, so jobs have none
  assert.deepEqual(await t.mutation(internal.demo.beginSignin, { visitor: A, harness: 'claude' }), {})
  const a = await t.mutation(api.demo.startJob, { visitor: A, harness: 'codex', task: 'ignored' })
  const b = await t.mutation(api.demo.startJob, { visitor: B, harness: 'grok' })
  assert.equal((await view(t, A)).job.state, 'queued')
  assert.deepEqual([(await view(t, B)).job.state, (await view(t, B)).job.ahead], ['queued', 1])
  // a visitor has one job at a time, and only the app's own task
  assert.match((await t.mutation(api.demo.startJob, { visitor: A, harness: 'codex' })).error, /not ended/)
  assert.equal((await t.query(internal.demo.job, { job: a.job })).task, undefined)
  assert.match((await t.mutation(api.demo.startJob, { visitor: A, harness: 'fake' })).error, /harness/)

  // the sign-in ends: one place for jobs, the first in line takes it
  await t.mutation(internal.demo.endSignin, { visitor: A, harness: 'claude' })
  assert.equal((await view(t, A)).job.state, 'running')
  assert.deepEqual([(await view(t, B)).job.state, (await view(t, B)).job.ahead], ['queued', 0])
  assert.equal((await view(t, A)).load.sandboxes, 1)
  // a sign-in still gets one of its own places while jobs wait
  assert.deepEqual(await t.mutation(internal.demo.beginSignin, { visitor: B, harness: 'codex' }), {})
  await t.mutation(internal.demo.endSignin, { visitor: B, harness: 'codex' })
  await t.mutation(internal.demo.endJob, { job: a.job, ok: true, result: 'done' })
  assert.equal((await view(t, B)).job.state, 'running')

  // today's sandbox time is used up: no new sign-in or job
  await t.run(async (ctx: any) => {
    const d = await ctx.db.query('days').withIndex('by_day', (q: any) => q.eq('day', new Date().toISOString().slice(0, 10))).unique()
    await ctx.db.patch(d._id, { ms: 5 * 3_600_000 })
  })
  assert.match((await t.mutation(api.demo.startJob, { visitor: A, harness: 'claude' })).error, /today's sandbox time/)
  assert.match((await t.mutation(internal.demo.beginSignin, { visitor: A, harness: 'grok' })).error ?? '', /today's sandbox time/)

  // an hour after A's last request, the sweep forgets A (and only A)
  await t.run(async (ctx: any) => {
    const r = await ctx.db.query('visitors').withIndex('by_visitor', (q: any) => q.eq('visitor', A)).unique()
    await ctx.db.patch(r._id, { seen: Date.now() - 2 * 3_600_000 })
  })
  await t.mutation(internal.demo.sweep, {})
  await t.finishAllScheduledFunctions(() => {})
  assert.ok(scheduled.includes(`forget ${A}`))
  assert.ok(!scheduled.includes(`forget ${B}`))
})

test("sign-out and Delete my data wait for the visitor's job, then delete only that visitor's login and data", async () => {
  // the real actions (convex/agents.ts) with byoa: no stored login file and no sandbox here, so none starts
  process.env.BYOA_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.CONVEX_SITE_URL = 'https://example.convex.site'
  const t = convexTest(schema, {
    ...modules,
    '/convex/agents.ts': () => import('./convex/agents.ts'),
    '/convex/byoa.ts': () => import('./convex/byoa.ts'),
  })
  const rows = (table: string, visitor: string) => t.run(async (ctx: any) => (await ctx.db.query(table).collect()).filter((r: any) => r.visitor === visitor).length)
  const logins = (visitor: string) => t.action(api.agents.logins, { visitor })
  await t.run(async (ctx: any) => {
    for (const k of [`login/${A}/claude`, `login/${A}/codex`, `login/${B}/claude`]) await ctx.db.insert('byoa', { key: k, value: 'signed-in', n: 1 })
  })
  for (const v of [A, B]) {
    await t.mutation(api.demo.touch, { visitor: v })
    await t.mutation(internal.mail.label, { visitor: v, id: 'm1', category: 'spam', reason: 'x' })
    await t.mutation(internal.mail.draft, { visitor: v, id: 'm3', body: 'Sure.' })
  }
  assert.deepEqual(await t.mutation(internal.demo.beginSignin, { visitor: A, harness: 'grok' }), {})
  const job = await t.run(async (ctx: any) => {
    const job = await ctx.db.insert('jobs', { visitor: A, harness: 'codex', state: 'running', at: Date.now(), started: Date.now() })
    await ctx.db.insert('events', { job, n: 0, e: '{"type":"start"}' })
    return job
  })

  // while A's Codex job runs: A may sign out of Claude, not of Codex, and may not delete their data yet
  await t.action(api.agents.signOut, { visitor: A, harness: 'claude' })
  assert.deepEqual(await logins(A), { claude: 'signed-out', codex: 'signed-in', grok: 'signed-out' })
  await assert.rejects(t.action(api.agents.signOut, { visitor: A, harness: 'codex' }), /not ended/)
  await assert.rejects(t.action(api.agents.deleteData, { visitor: A }), /not ended/)
  assert.equal(await rows('drafts', A), 1)
  await assert.rejects(t.action(api.agents.deleteData, { visitor: 'A'.repeat(32) }), /bad visitor id/)

  // the job ends: Delete my data signs A out of every lab and deletes all of A's rows, the sign-in that had not
  // finished too, at once
  await t.mutation(internal.demo.endJob, { job, ok: true })
  await t.action(api.agents.deleteData, { visitor: A })
  assert.deepEqual(await logins(A), { claude: 'signed-out', codex: 'signed-out', grok: 'signed-out' })
  for (const table of ['visitors', 'signins', 'jobs', 'mail', 'decisions', 'drafts']) assert.equal(await rows(table, A), 0, table)
  assert.equal(await t.run(async (ctx: any) => (await ctx.db.query('events').collect()).length), 0)
  assert.equal((await view(t, A)).load.sandboxes, 0)
  // B keeps everything
  assert.deepEqual(await logins(B), { claude: 'signed-in', codex: 'signed-out', grok: 'signed-out' })
  for (const table of ['visitors', 'mail', 'decisions', 'drafts']) assert.equal(await rows(table, B), 1, table)
})

test("the agent's tools change only the visitor's own copy of the inbox, and undo puts it back", async () => {
  const t = convexTest(schema, modules)
  assert.equal(await t.mutation(internal.mail.label, { visitor: A, id: 'm1', category: 'spam', reason: 'look-alike domain' }), 'labeled AI/Spam')
  await t.mutation(internal.mail.draft, { visitor: A, id: 'm3', body: 'Sure. - Alex' })
  await assert.rejects(t.mutation(internal.mail.label, { visitor: A, id: 'm2', category: 'trash', reason: 'x' }), /category/)
  assert.deepEqual((await t.query(internal.mail.inbox, { visitor: A })).map((m: any) => m.id).slice(0, 2), ['m2', 'm3'])
  assert.equal((await t.query(internal.mail.inbox, { visitor: B })).length, 12)
  const m = (await view(t, A)).messages
  assert.deepEqual([m[0].decision.category, m[0].labels.sort(), m[2].draft], ['spam', ['AI/Spam', 'AI/Triaged', 'INBOX', 'UNREAD'], 'Sure. - Alex'])
  await t.mutation(api.demo.undo, { visitor: A })
  assert.equal((await view(t, A)).messages.filter((x: any) => x.decision || x.draft).length, 0)
})
