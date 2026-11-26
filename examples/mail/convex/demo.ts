// The hosted demo's rules, for strangers on the public page: what the page reads (view, events) and starts (startJob),
// and the limits that keep the cost small:
// - at most MAX_SANDBOXES sandboxes at a time, sign-ins and jobs together. SIGNIN_PLACES of them only sign-ins may use,
//   because the lab's sign-in code expires; jobs wait in line, first come first served, and the page shows the line;
// - at most BUDGET_HOURS of sandbox time each day (UTC); then no new sign-in or job until the next day;
// - PER_HOUR jobs and sign-ins for each visitor each hour, one job at a time, and only the app's own task;
// - an hour after a visitor's last request, their AI logins, sandboxes and copy of the inbox are deleted (sweep).
// A visitor is a random id that the page keeps (128 bits): it is the only key to that visitor's login and mail.
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api.js'
import type { Id } from './_generated/dataModel.js'
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server.js'
import { messages, reset } from './mail.ts'

const num = (k: string, d: number) => { const n = Number(process.env[k]); return process.env[k] && Number.isFinite(n) ? n : d }
const limits = () => ({ max: num('MAX_SANDBOXES', 10), signInPlaces: num('SIGNIN_PLACES', 2), budgetHours: num('BUDGET_HOURS', 5), perHour: num('PER_HOUR', 6) })
export const LABS = ['claude', 'codex', 'grok'] as const
/** FAKE=1 also offers byoa's fake harness, with a task, to check the demo end to end with no AI plan. */
const harnesses = (): string[] => process.env.FAKE === '1' ? [...LABS, 'fake'] : [...LABS]
/** A job's time limit (byoa's jobTimeoutMs); a Node action has 10 minutes. */
export const JOB_MS = 5 * 60_000
const HOUR = 3_600_000, FORGET_MS = HOUR, STALE_SIGNIN_MS = 3 * 60_000, STALE_JOB_MS = 11 * 60_000
const BUDGET = "The demo used today's sandbox time. Come back tomorrow, or run the example yourself."

export function checkVisitor(visitor: string) {
  if (!/^[0-9a-f]{32}$/.test(visitor)) throw new ConvexError('bad visitor id')
}
const today = () => new Date().toISOString().slice(0, 10)

/** The sandboxes that run now, the jobs in line, and today's sandbox time. */
async function usage(ctx: QueryCtx) {
  const now = Date.now(), l = limits()
  const running = await ctx.db.query('jobs').withIndex('by_state', (q) => q.eq('state', 'running')).collect()
  const signins = await ctx.db.query('signins').withIndex('by_pending', (q) => q.eq('pending', true).gt('seen', now - STALE_SIGNIN_MS)).collect()
  const queued = await ctx.db.query('jobs').withIndex('by_state', (q) => q.eq('state', 'queued')).collect()
  const day = await ctx.db.query('days').withIndex('by_day', (q) => q.eq('day', today())).unique()
  const ms = (day?.ms ?? 0) + running.reduce((n, j) => n + now - (j.started ?? now), 0) + signins.reduce((n, s) => n + now - s.at, 0)
  return { ...l, used: running.length + signins.length, queued, busy: ms >= l.budgetHours * HOUR }
}

async function addUsage(ctx: MutationCtx, ms: number) {
  const d = await ctx.db.query('days').withIndex('by_day', (q) => q.eq('day', today())).unique()
  if (d) await ctx.db.patch(d._id, { ms: d.ms + Math.max(0, ms) })
  else await ctx.db.insert('days', { day: today(), ms: Math.max(0, ms) })
}

async function seen(ctx: MutationCtx, visitor: string) {
  checkVisitor(visitor)
  const r = await ctx.db.query('visitors').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).unique()
  if (r) await ctx.db.patch(r._id, { seen: Date.now() })
  else await ctx.db.insert('visitors', { visitor, at: Date.now(), seen: Date.now() })
}

/** Starts the jobs in line while places are free; a job's place is free again at endJob. */
async function pump(ctx: MutationCtx) {
  const u = await usage(ctx)
  let free = u.max - u.signInPlaces - u.used
  for (const j of u.queued) {
    if (free-- <= 0) break
    await ctx.db.patch(j._id, { state: 'running', started: Date.now() })
    await ctx.scheduler.runAfter(0, internal.agents.runJob, { job: j._id })
  }
}

// ---- what the page reads and does

/** The page keeps its visitor alive with this (on load, and every few minutes while it is open). */
export const touch = mutation({ args: { visitor: v.string() }, handler: (ctx, { visitor }) => seen(ctx, visitor) })

/** The inbox with the agent's labels and drafts, the visitor's last job and its place in line, and the demo's load. */
export const view = query({
  args: { visitor: v.string() },
  handler: async (ctx, { visitor }) => {
    checkVisitor(visitor)
    const u = await usage(ctx)
    const job = await ctx.db.query('jobs').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).order('desc').first()
    return {
      messages: await messages(ctx, visitor),
      job: job && { id: job._id, harness: job.harness, state: job.state, result: job.result, ahead: job.state === 'queued' ? u.queued.filter((j) => j.at < job.at).length : 0 },
      load: { sandboxes: u.used, max: u.max, queued: u.queued.length, busy: u.busy },
      harnesses: harnesses(),
    }
  },
})

/** The agent's events of one job of the visitor, in order: byoa's event schema. */
export const events = query({
  args: { visitor: v.string(), job: v.id('jobs') },
  handler: async (ctx, a) => {
    const j = await ctx.db.get(a.job)
    if (!j || j.visitor !== a.visitor) return []
    return (await ctx.db.query('events').withIndex('by_job', (q) => q.eq('job', a.job)).collect()).map((r) => JSON.parse(r.e))
  },
})

/** Puts a triage job in line. Returns the job, or why the demo refused it. */
export const startJob = mutation({
  args: { visitor: v.string(), harness: v.string(), task: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ job: Id<'jobs'> } | { error: string }> => {
    await seen(ctx, a.visitor)
    if (!harnesses().includes(a.harness)) return { error: `harness: one of ${harnesses().join(', ')}` }
    const u = await usage(ctx)
    if (u.busy) return refused(ctx, a.visitor, 'job', BUDGET)
    const mine = await ctx.db.query('jobs').withIndex('by_visitor', (q) => q.eq('visitor', a.visitor).gt('at', Date.now() - HOUR)).collect()
    if (mine.some((j) => j.state === 'queued' || j.state === 'running')) return { error: 'Your last job has not ended yet.' }
    if (mine.length >= u.perHour) return refused(ctx, a.visitor, 'job', 'Too many jobs this hour. Try again later.')
    // only the app's own task; the fake harness needs its `call` lines
    const job = await ctx.db.insert('jobs', { visitor: a.visitor, harness: a.harness, task: a.harness === 'fake' ? a.task : undefined, state: 'queued', at: Date.now() })
    await pump(ctx)
    return { job }
  },
})

/** Undo: the inbox as it was. */
export const undo = mutation({
  args: { visitor: v.string() },
  handler: async (ctx, { visitor }) => { await seen(ctx, visitor); await reset(ctx, visitor) },
})

async function refused(ctx: MutationCtx, visitor: string, route: string, error: string) {
  await ctx.scheduler.runAfter(0, internal.track.send, { visitor, event: 'demo_refused', properties: { route, error } })
  return { error }
}

// ---- for the actions (agents.ts)

export const job = internalQuery({ args: { job: v.id('jobs') }, handler: (ctx, { job }) => ctx.db.get(job) })

export const event = internalMutation({
  args: { job: v.id('jobs'), n: v.number(), e: v.string() },
  handler: async (ctx, a) => { await ctx.db.insert('events', a) },
})

export const endJob = internalMutation({
  args: { job: v.id('jobs'), ok: v.boolean(), result: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const j = await ctx.db.get(a.job)
    if (!j || j.state !== 'running') return
    await ctx.db.patch(a.job, { state: a.ok ? 'done' : 'failed', ended: Date.now(), result: a.result })
    await addUsage(ctx, Date.now() - (j.started ?? Date.now()))
    await pump(ctx)
  },
})

const pendingSignin = (ctx: QueryCtx, visitor: string, harness: string) =>
  ctx.db.query('signins').withIndex('by_visitor', (q) => q.eq('visitor', visitor).eq('harness', harness)).filter((q) => q.eq(q.field('pending'), true)).first()

/** Takes a place for a sign-in's sandbox, or says why not. */
export const beginSignin = internalMutation({
  args: { visitor: v.string(), harness: v.string() },
  handler: async (ctx, a): Promise<{ error?: string }> => {
    await seen(ctx, a.visitor)
    const u = await usage(ctx)
    if (u.busy) return refused(ctx, a.visitor, 'login', BUDGET)
    const recent = await ctx.db.query('signins').withIndex('by_visitor', (q) => q.eq('visitor', a.visitor)).filter((q) => q.gt(q.field('at'), Date.now() - HOUR)).collect()
    if (recent.length >= u.perHour) return refused(ctx, a.visitor, 'login', 'Too many sign-ins this hour. Try again later.')
    const old = await pendingSignin(ctx, a.visitor, a.harness)
    if (old) await end(ctx, old)
    else if (u.used >= u.max) return refused(ctx, a.visitor, 'login', 'Too many people are signing in right now. Try again in a minute.')
    await ctx.db.insert('signins', { visitor: a.visitor, harness: a.harness, pending: true, at: Date.now(), seen: Date.now() })
    return {}
  },
})

export const seenSignin = internalMutation({
  args: { visitor: v.string(), harness: v.string() },
  handler: async (ctx, a) => {
    await seen(ctx, a.visitor)
    const s = await pendingSignin(ctx, a.visitor, a.harness)
    if (s) await ctx.db.patch(s._id, { seen: Date.now() })
  },
})

async function end(ctx: MutationCtx, s: { _id: Id<'signins'>; at: number; seen: number }, at = Date.now()) {
  await ctx.db.patch(s._id, { pending: false })
  await addUsage(ctx, at - s.at)
}

export const endSignin = internalMutation({
  args: { visitor: v.string(), harness: v.string() },
  handler: async (ctx, a) => {
    const s = await pendingSignin(ctx, a.visitor, a.harness)
    if (s) { await end(ctx, s); await pump(ctx) }
  },
})

/** Every minute (crons.ts): ends sign-ins the page left, fails jobs whose action died, forgets visitors after an
 *  hour, and starts the jobs in line. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    for (const s of await ctx.db.query('signins').withIndex('by_pending', (q) => q.eq('pending', true).lt('seen', now - STALE_SIGNIN_MS)).collect()) {
      // byoa ends a sign-in's sandbox 2 minutes after the last check-in; cancel it now in case the provider keeps it
      await end(ctx, s, Math.min(now, s.seen + 2 * 60_000))
      await ctx.scheduler.runAfter(0, internal.agents.cancel, { visitor: s.visitor, harness: s.harness as (typeof LABS)[number] })
    }
    for (const j of await ctx.db.query('jobs').withIndex('by_state', (q) => q.eq('state', 'running')).collect()) {
      if ((j.started ?? now) > now - STALE_JOB_MS) continue
      await ctx.db.patch(j._id, { state: 'failed', ended: now, result: 'The job ran out of time.' })
      await addUsage(ctx, JOB_MS)
    }
    for (const r of await ctx.db.query('visitors').withIndex('by_seen', (q) => q.lt('seen', now - FORGET_MS)).take(20)) {
      // not again for 10 minutes, while the action runs (it deletes the visitor at the end)
      await ctx.db.patch(r._id, { seen: now - FORGET_MS + 10 * 60_000 })
      await ctx.scheduler.runAfter(0, internal.agents.forget, { visitor: r.visitor })
    }
    await pump(ctx)
  },
})

/** The last step of forgetting a visitor: their rows. The AI logins and sandboxes are gone already (agents.forget). */
export const drop = internalMutation({
  args: { visitor: v.string() },
  handler: async (ctx, { visitor }) => {
    await reset(ctx, visitor)
    for (const j of await ctx.db.query('jobs').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).collect()) {
      for (const e of await ctx.db.query('events').withIndex('by_job', (q) => q.eq('job', j._id)).collect()) await ctx.db.delete(e._id)
      if (j.state !== 'running' && j.state !== 'queued') await ctx.db.delete(j._id)
    }
    for (const s of await ctx.db.query('signins').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).collect()) if (!s.pending) await ctx.db.delete(s._id)
    const r = await ctx.db.query('visitors').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).unique()
    if (r) await ctx.db.delete(r._id)
  },
})
