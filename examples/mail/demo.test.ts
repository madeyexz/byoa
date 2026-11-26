// The hosted demo's rules (convex/demo.ts) on convex-test, Convex's mock backend: the limits that keep a public demo's
// sandbox cost small. The actions that run byoa (convex/agents.ts) are stand-ins here; the real ones are checked on the
// deployment.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { internalActionGeneric, internalMutationGeneric } from 'convex/server'
import { v } from 'convex/values'
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
    // a signed-in login is a stored login (ailogin/) and its state (login/)
    for (const k of [`${A}/claude`, `${A}/codex`, `${B}/claude`]) {
      await ctx.db.insert('byoa', { key: `ailogin/${k}`, value: 'sealed login files', n: 1 })
      await ctx.db.insert('byoa', { key: `login/${k}`, value: 'signed-in', n: 1 })
    }
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

// ---- found with the TLA+ model spec/tla/Demo.tla (V22)

const visitorRow = (t: any, visitor: string) => t.run(async (ctx: any) => ctx.db.query('visitors').withIndex('by_visitor', (q: any) => q.eq('visitor', visitor)).unique())
const ago = (t: any, visitor: string, ms: number) => t.run(async (ctx: any) => {
  const r = await ctx.db.query('visitors').withIndex('by_visitor', (q: any) => q.eq('visitor', visitor)).unique()
  await ctx.db.patch(r._id, { seen: Date.now() - ms })
})

test('the sweep never starts the job of a visitor it forgets, and waits while their job runs (Demo_main_queue)', async () => {
  process.env.MAX_SANDBOXES = '3'
  process.env.SIGNIN_PLACES = '1'
  scheduled.length = 0
  const t = convexTest(schema, modules)
  const C = 'c'.repeat(32)
  // two job places: B's job and C's job run, A's waits in line
  const b = await t.mutation(api.demo.startJob, { visitor: B, harness: 'codex' })
  const c = await t.mutation(api.demo.startJob, { visitor: C, harness: 'codex' })
  const a = await t.mutation(api.demo.startJob, { visitor: A, harness: 'codex' })
  assert.equal((await view(t, A)).job.state, 'queued')
  // an hour later: B's action died 12 minutes ago (STALE_JOB_MS is 11), C's job runs, and all three left the page
  await t.run(async (ctx: any) => { await ctx.db.patch(b.job, { started: Date.now() - 12 * 60_000 }) })
  for (const v of [A, B, C]) await ago(t, v, 61 * 60_000)
  await t.mutation(internal.demo.sweep, {})
  await t.finishAllScheduledFunctions(() => {})
  // A is forgotten: A's job, which waited in line for the hour, must not start in B's place (its sandbox would
  // start after the forget deleted A's sandboxes, and no visitors row would lead to it)
  assert.ok(scheduled.includes(`forget ${A}`))
  assert.ok(!scheduled.includes(`runJob ${a.job}`), "the sweep started the job of a visitor that it forgets")
  assert.equal((await t.query(internal.demo.job, { job: a.job })).state, 'failed')
  // C's job runs: C is forgotten after it ends, not while it runs
  assert.ok(!scheduled.includes(`forget ${C}`), 'the sweep forgets a visitor whose job runs')
  await t.mutation(internal.demo.endJob, { job: c.job, ok: true })
  await t.mutation(internal.demo.sweep, {})
  await t.finishAllScheduledFunctions(() => {})
  assert.ok(scheduled.includes(`forget ${C}`))
})

test("a forget keeps the rows of a visitor who came back while it ran (Demo_main_return)", async () => {
  process.env.MAX_SANDBOXES = '3'
  process.env.SIGNIN_PLACES = '1'
  process.env.BYOA_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.CONVEX_SITE_URL = 'https://example.convex.site'
  scheduled.length = 0
  // the real forget (convex/agents.ts) with byoa; runJob is a stand-in
  const t = convexTest(schema, {
    ...modules,
    '/convex/agents.ts': async () => ({ ...(await import('./convex/agents.ts')), runJob: stub('runJob') }),
    '/convex/byoa.ts': () => import('./convex/byoa.ts'),
  })
  await t.mutation(api.demo.touch, { visitor: A })
  await ago(t, A, 61 * 60_000)
  await t.mutation(internal.demo.sweep, {})
  // A comes back before the forget action runs, and starts a job
  const a = await t.mutation(api.demo.startJob, { visitor: A, harness: 'codex' })
  await t.finishAllScheduledFunctions(() => {})
  assert.equal((await t.query(internal.demo.job, { job: a.job }))?.state, 'running')
  // A's job runs (its sandbox may start after the forget's deleteSandbox): A's row must stay, so that the sweep
  // forgets A an hour after this request and deletes that sandbox
  assert.ok(await visitorRow(t, A), "the forget deleted the row of a visitor whose job runs: nothing deletes that job's sandbox")
})

test('a visitor whose job has waited in line for over an hour cannot start a second one (Demo_main_onejob)', async () => {
  process.env.MAX_SANDBOXES = '2'
  process.env.SIGNIN_PLACES = '1'
  const t = convexTest(schema, modules)
  await t.mutation(api.demo.startJob, { visitor: B, harness: 'codex' })
  const a = await t.mutation(api.demo.startJob, { visitor: A, harness: 'codex' })
  assert.equal((await view(t, A)).job.state, 'queued')
  // A keeps the page open (touch) while the line is long: A's job has waited 61 minutes
  await t.run(async (ctx: any) => { await ctx.db.patch(a.job, { at: Date.now() - 61 * 60_000 }) })
  const r = await t.mutation(api.demo.startJob, { visitor: A, harness: 'codex' })
  assert.match(r.error ?? 'a second job', /not ended/)
})

test('a new sign-in takes a place only when one is free, also when an old sign-in of that lab is still pending (Demo_main_old)', async () => {
  process.env.MAX_SANDBOXES = '1'
  process.env.SIGNIN_PLACES = '0'
  const t = convexTest(schema, modules)
  assert.deepEqual(await t.mutation(internal.demo.beginSignin, { visitor: A, harness: 'claude' }), {})
  // A's page stopped checking in 3.5 minutes ago: the sign-in no longer counts, and the sweep has not ended it yet
  await t.run(async (ctx: any) => {
    const s = await ctx.db.query('signins').withIndex('by_visitor', (q: any) => q.eq('visitor', A).eq('harness', 'claude')).unique()
    await ctx.db.patch(s._id, { seen: Date.now() - 3.5 * 60_000 })
  })
  // B's job takes the one place
  await t.mutation(api.demo.startJob, { visitor: B, harness: 'codex' })
  assert.equal((await view(t, B)).job.state, 'running')
  assert.equal((await view(t, A)).load.sandboxes, 1)
  // A starts that sign-in again: no place is free
  const r = await t.mutation(internal.demo.beginSignin, { visitor: A, harness: 'claude' })
  assert.match(r.error ?? 'a second sandbox', /Too many people/)
})

test('Delete my data deletes a stored login whose state is not saved yet (Demo_main_delete)', async () => {
  process.env.BYOA_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.CONVEX_SITE_URL = 'https://example.convex.site'
  const t = convexTest(schema, {
    ...modules,
    '/convex/agents.ts': () => import('./convex/agents.ts'),
    '/convex/byoa.ts': () => import('./convex/byoa.ts'),
  })
  await t.mutation(api.demo.touch, { visitor: A })
  // finishLogin of A's Claude sign-in has saved the login (login-stored.ts signedIn) and has not yet set its state
  // (login.ts 208-209), when A's other tab runs Delete my data
  await t.run(async (ctx: any) => { await ctx.db.insert('byoa', { key: `ailogin/${A}/claude`, value: 'sealed login files', n: 1 }) })
  await t.action(api.agents.deleteData, { visitor: A })
  const left = await t.run(async (ctx: any) => (await ctx.db.query('byoa').collect()).filter((r: any) => r.key.startsWith('ailogin/')).map((r: any) => r.key))
  assert.deepEqual(left, [], 'a login stays after Delete my data returned')
})

test("Delete my data works while the page keeps the visitor alive, and leaves no byoa row of the visitor (Demo_main_touch)", async () => {
  process.env.BYOA_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.CONVEX_SITE_URL = 'https://example.convex.site'
  // byoa's put, as convexFunctions has it, and the page's touch (every 5 minutes, demo.html) at each of the forget's
  // puts: the touch commits while Delete my data runs, between two of its byoa calls
  const put = internalMutationGeneric({
    args: { key: v.string(), value: v.string() },
    handler: async (ctx: any, { key, value }: { key: string; value: string }) => {
      const r = await ctx.db.query('byoa').withIndex('by_key', (q: any) => q.eq('key', key)).unique()
      if (r) await ctx.db.patch(r._id, { value, n: r.n + 1 })
      else await ctx.db.insert('byoa', { key, value, n: 1 })
      const me = await ctx.db.query('visitors').withIndex('by_visitor', (q: any) => q.eq('visitor', A)).unique()
      if (me) await ctx.db.patch(me._id, { seen: me.seen + 1 })
      return null
    },
  })
  const t = convexTest(schema, {
    ...modules,
    '/convex/agents.ts': () => import('./convex/agents.ts'),
    '/convex/byoa.ts': async () => ({ ...(await import('./convex/byoa.ts')), put }),
  })
  await t.mutation(api.demo.touch, { visitor: A })
  // what byoa keeps of A after a sign-in and a job: the login's state, the sign-in's ended entry, and the login's
  // lease and line (keys.ts); none holds the login itself
  await t.run(async (ctx: any) => {
    for (const [k, value] of [[`login/${A}/claude`, 'signed-in'], [`loginjob/${A}/claude`, '{}'], [`ailoginlease/${A}/claude`, '{}'], [`ailoginline/${A}/claude`, '[]'], [`login/${B}/claude`, 'signed-in']]) {
      await ctx.db.insert('byoa', { key: k, value, n: 1 })
    }
  })
  await t.action(api.agents.deleteData, { visitor: A })
  assert.equal(await visitorRow(t, A), null)
  const left = await t.run(async (ctx: any) => (await ctx.db.query('byoa').collect()).map((r: any) => r.key).filter((k: string) => k.includes(A)))
  assert.deepEqual(left, [], `byoa rows of the visitor stay after Delete my data: ${left.join(', ')}`)
  assert.equal((await t.run(async (ctx: any) => ctx.db.query('byoa').withIndex('by_key', (q: any) => q.eq('key', `login/${B}/claude`)).unique()))?.value, 'signed-in')
})
