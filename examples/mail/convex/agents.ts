'use node'
// The demo's byoa calls that need a sandbox, as Node actions (the sandbox SDKs need Node): the sign-in on the lab's own
// page, the triage job, sign-out, and forgetting a visitor. demo.ts decides whether each may run.
// SANDBOX (default e2b): `e2b` (E2B_API_KEY) or `instabox` (INSTABOX_API_KEY). Instabox's free plan allows one sandbox
// in all, so the demo needs a paid Instabox plan; E2B's free plan runs 10 at a time.
import { e2b } from '@madeyexz/byoa/sandbox/e2b'
import { instabox } from '@madeyexz/byoa/sandbox/instabox'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api.js'
import type { Doc } from './_generated/dataModel.js'
import { action, internalAction, type ActionCtx } from './_generated/server.js'
import { checkVisitor, LABS } from './demo.ts'
import { agentsFor, triage } from './lib.ts'

const sandbox = () => process.env.SANDBOX === 'instabox' ? instabox({ snapshot: process.env.INSTABOX_SNAPSHOT || undefined }) : e2b()
const agents = (ctx: ActionCtx) => agentsFor(ctx, sandbox())
const lab = v.union(v.literal('claude'), v.literal('codex'), v.literal('grok'))
const track = (ctx: ActionCtx, visitor: string, event: string, properties: Record<string, unknown>) =>
  ctx.scheduler.runAfter(0, internal.track.send, { visitor, event, properties })

/** Starts the CLI's own sign-in in a sandbox: the lab's page, and for Codex and Grok the code to enter there. */
export const login = action({
  args: { visitor: v.string(), harness: lab },
  handler: async (ctx, a): Promise<{ url: string; code?: string }> => {
    checkVisitor(a.visitor)
    const r: { error?: string } = await ctx.runMutation(internal.demo.beginSignin, a)
    if (r.error) throw new ConvexError(r.error)
    try {
      const s = await agents(ctx).connectLogin(a.visitor, a.harness)
      await track(ctx, a.visitor, 'demo_signin_started', { harness: a.harness, ok: true })
      return { url: s.url, code: s.code }
    } catch (e) {
      await ctx.runMutation(internal.demo.endSignin, a)
      await track(ctx, a.visitor, 'demo_signin_started', { harness: a.harness, ok: false })
      throw new ConvexError(`The sign-in did not start: ${(e as Error).message}`)
    }
  },
})

/** Claude: with the code from Anthropic's page it finishes; with none, it only checks in (the page does that every 30 s).
 *  Codex and Grok: waits up to 20 s for the visitor; the page calls again while it says `pending`. */
export const finishLogin = action({
  args: { visitor: v.string(), harness: lab, code: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ state: string; error?: string }> => {
    checkVisitor(a.visitor)
    await ctx.runMutation(internal.demo.seenSignin, { visitor: a.visitor, harness: a.harness })
    const r = await agents(ctx).finishLogin(a.visitor, a.harness, { code: a.code, waitMs: a.harness === 'claude' ? undefined : 20_000 })
    if (r.state !== 'pending') {
      await ctx.runMutation(internal.demo.endSignin, { visitor: a.visitor, harness: a.harness })
      await track(ctx, a.visitor, 'demo_signin_finished', { harness: a.harness, state: r.state })
    }
    return r
  },
})

async function endLogin(ctx: ActionCtx, a: { visitor: string; harness: (typeof LABS)[number] }) {
  checkVisitor(a.visitor)
  await agents(ctx).cancelLogin(a.visitor, a.harness)
  await ctx.runMutation(internal.demo.endSignin, a)
}
/** The visitor closed the sign-in: its sandbox ends now. */
export const cancelLogin = action({ args: { visitor: v.string(), harness: lab }, handler: endLogin })
/** The same, for a sign-in that the page left (demo.sweep, http.ts /cancel). */
export const cancel = internalAction({ args: { visitor: v.string(), harness: lab }, handler: endLogin })

/** The visitor's sign-in state for each lab. */
export const logins = action({
  args: { visitor: v.string() },
  handler: async (ctx, { visitor }): Promise<Record<(typeof LABS)[number], string>> => {
    checkVisitor(visitor)
    const ag = agents(ctx)
    return Object.fromEntries(await Promise.all(LABS.map(async (h) => [h, await ag.loginState(visitor, h)]))) as Record<(typeof LABS)[number], string>
  },
})

/** One job that demo.pump started: the agent's events go to the events table, where the page reads them. */
export const runJob = internalAction({
  args: { job: v.id('jobs') },
  handler: async (ctx, { job }): Promise<void> => {
    const j: Doc<'jobs'> | null = await ctx.runQuery(internal.demo.job, { job })
    if (!j || j.state !== 'running') return
    let n = 0, ok = false, labeled = 0, result: string | undefined
    try {
      for await (const e of triage(agents(ctx), j.visitor, j.harness as never, j.task)) {
        await ctx.runMutation(internal.demo.event, { job, n: n++, e: JSON.stringify(e) })
        if (e.type === 'tool_call' && e.name === 'label_message') labeled++
        if (e.type === 'end') { ok = e.ok; result = e.result }
      }
    } catch (e) {
      result = (e as Error).message
      await ctx.runMutation(internal.demo.event, { job, n: n++, e: JSON.stringify({ type: 'error', message: result }) })
    } finally {
      await ctx.runMutation(internal.demo.endJob, { job, ok, result: result?.slice(0, 4000) })
    }
    await track(ctx, j.visitor, 'demo_job', { harness: j.harness, ok, labeled, waitedSeconds: Math.round(((j.started ?? j.at) - j.at) / 1000), seconds: Math.round((Date.now() - (j.started ?? j.at)) / 1000) })
  },
})

/** Sign-out and Delete my data end the visitor's sandboxes, so they refuse while the visitor's job is in line or runs
 *  (for sign-out, a job of that lab). A job ends within JOB_MS. */
/** Throws while the visitor's job (of `harness`) waits or runs; else returns the visitor's `acts` (demo.drop). */
async function noJob(ctx: ActionCtx, visitor: string, harness?: (typeof LABS)[number]): Promise<number> {
  const r: { error?: string; acts?: number } = await ctx.runQuery(internal.demo.idle, { visitor, harness })
  if (r.error) throw new ConvexError(r.error)
  return r.acts ?? 0
}

/** The visitor's "Sign out" of one lab: byoa's signOut, which signs out with the CLI, deletes the stored login and
 *  that lab's sandbox. */
export const signOut = action({
  args: { visitor: v.string(), harness: lab },
  handler: async (ctx, a): Promise<void> => {
    checkVisitor(a.visitor)
    await noJob(ctx, a.visitor, a.harness)
    await agents(ctx).signOut(a.visitor, a.harness)
  },
})

/** Signs out each AI login with the CLI, ends a sign-in that has not finished, deletes the visitor's sandboxes, then
 *  their rows (demo.drop). `quiet`: go on after an error, for the sweep, which does not run again for this visitor. */
async function forgetVisitor(ctx: ActionCtx, visitor: string, quiet: boolean, acts: number) {
  const ag = agents(ctx), step = (p: Promise<unknown>) => quiet ? p.catch(() => {}) : p
  for (const h of LABS) {
    await step(ag.cancelLogin(visitor, h))
    // also when the state says signed-out: a sign-in that finishes now saves its login before it sets its state.
    // byoa's signOut starts a sandbox only when a login is stored
    await step(ag.signOut(visitor, h))
  }
  await step(ag.deleteSandbox(visitor))
  const dropped: boolean = await ctx.runMutation(internal.demo.drop, { visitor, acts })
  if (!dropped && !quiet) throw new ConvexError('You started a job or a sign-in while the demo deleted your data, so some of it may stay. Try again.')
}

/** The visitor's "Delete my data": the same as the sweep's forget, now. The page then forgets its visitor id. */
export const deleteData = action({
  args: { visitor: v.string() },
  handler: async (ctx, { visitor }): Promise<void> => {
    checkVisitor(visitor)
    await forgetVisitor(ctx, visitor, false, await noJob(ctx, visitor))
  },
})

/** An hour after the visitor's last request (demo.sweep). */
export const forget = internalAction({
  args: { visitor: v.string(), acts: v.number() },
  handler: (ctx, { visitor, acts }) => forgetVisitor(ctx, visitor, true, acts),
})
