// The visitor's copy of the sample inbox. The agent's tools (lib.ts) read and label it through these internal
// functions, from byoa's proxy in http.ts; the page reads it with demo.view. Nothing here deletes or sends mail.
import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server.js'
import { CATEGORIES, TRIAGED, type Category } from '../triage.ts'
import { DEMO_EMAIL, SAMPLE } from './sample.ts'

const UNTOUCHED = ['INBOX', 'UNREAD']

/** Every sample message with the visitor's labels, decision and draft, newest first. */
export async function messages(ctx: QueryCtx, visitor: string) {
  const at = (await ctx.db.query('visitors').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).unique())?.at ?? Date.now()
  const labels = new Map((await ctx.db.query('mail').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).collect()).map((r) => [r.id, r.labels]))
  const decisions = new Map((await ctx.db.query('decisions').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).collect()).map((r) => [r.id, r]))
  const drafts = new Map((await ctx.db.query('drafts').withIndex('by_visitor', (q) => q.eq('visitor', visitor)).collect()).map((r) => [r.id, r.body]))
  return SAMPLE.map((s, i) => {
    const id = `m${i + 1}`, d = decisions.get(id)
    return {
      id, from: s.from, replyTo: s.replyTo, to: DEMO_EMAIL, subject: s.subject, date: new Date(at - s.hoursAgo * 3_600_000).toISOString(),
      snippet: s.body.slice(0, 100), body: s.body, auth: s.auth, unsubscribe: !!s.unsubscribe, gmailCategory: s.tab,
      labels: labels.get(id) ?? UNTOUCHED,
      decision: d ? { category: d.category, reason: d.reason, code: d.code } : undefined,
      draft: drafts.get(id),
    }
  })
}

const find = async (ctx: QueryCtx, visitor: string, id: string) => {
  const m = (await messages(ctx, visitor)).find((x) => x.id === id)
  if (!m) throw new ConvexError(`no message ${id}`)
  return m
}

/** list_inbox: the inbox messages that are not triaged yet. */
export const inbox = internalQuery({
  args: { visitor: v.string() },
  handler: async (ctx, { visitor }) => (await messages(ctx, visitor)).filter((m) => m.labels.includes('INBOX') && !m.labels.includes(TRIAGED))
    .map(({ id, from, replyTo, to, subject, date, snippet, auth, unsubscribe, gmailCategory }) => ({ id, from, replyTo, to, subject, date, snippet, auth, unsubscribe, gmailCategory })),
})

/** read_message: one message with its text. */
export const message = internalQuery({
  args: { visitor: v.string(), id: v.string() },
  handler: async (ctx, { visitor, id }) => {
    const { labels: _, decision: __, draft: ___, ...m } = await find(ctx, visitor, id)
    return m
  },
})

/** label_message: one category label and AI/Triaged, and the decision the page shows. */
export const label = internalMutation({
  args: { visitor: v.string(), id: v.string(), category: v.string(), reason: v.string(), code: v.optional(v.string()) },
  handler: async (ctx, a) => {
    if (!(a.category in CATEGORIES)) throw new ConvexError(`category: one of ${Object.keys(CATEGORIES).join(', ')}`)
    const m = await find(ctx, a.visitor, a.id)
    const name = CATEGORIES[a.category as Category]
    const labels = [...new Set([...m.labels.filter((l) => !Object.values(CATEGORIES).includes(l as never)), name, TRIAGED])]
    const row = await ctx.db.query('mail').withIndex('by_visitor', (q) => q.eq('visitor', a.visitor).eq('id', a.id)).unique()
    if (row) await ctx.db.patch(row._id, { labels })
    else await ctx.db.insert('mail', { visitor: a.visitor, id: a.id, labels })
    const d = { category: a.category, reason: a.reason.slice(0, 200), code: a.code?.slice(0, 40) || undefined }
    const old = await ctx.db.query('decisions').withIndex('by_visitor', (q) => q.eq('visitor', a.visitor).eq('id', a.id)).unique()
    if (old) await ctx.db.patch(old._id, d)
    else await ctx.db.insert('decisions', { visitor: a.visitor, id: a.id, ...d })
    return `labeled ${name}`
  },
})

/** save_draft: a reply draft. It is never sent. */
export const draft = internalMutation({
  args: { visitor: v.string(), id: v.string(), body: v.string() },
  handler: async (ctx, { visitor, id, body }) => {
    await find(ctx, visitor, id)
    const text = body.trim().slice(0, 8000)
    if (!text) throw new ConvexError('body is empty')
    const old = await ctx.db.query('drafts').withIndex('by_visitor', (q) => q.eq('visitor', visitor).eq('id', id)).unique()
    if (old) await ctx.db.patch(old._id, { body: text })
    else await ctx.db.insert('drafts', { visitor, id, body: text })
    return 'saved the draft (not sent)'
  },
})

/** Removes the agent's labels, decisions and drafts: the inbox is as it was. */
export async function reset(ctx: { db: any }, visitor: string) {
  for (const t of ['mail', 'decisions', 'drafts'] as const) {
    for (const r of await ctx.db.query(t).withIndex('by_visitor', (q: any) => q.eq('visitor', visitor)).collect()) await ctx.db.delete(r._id)
  }
}
