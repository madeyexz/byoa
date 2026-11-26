// The hosted demo's tables. byoa keeps its own state (AI logins, job tokens, sandbox slots) in `byoa`, encrypted where
// it holds a login (R1.4). The rest is the demo's: visitors, the sign-ins and jobs that use a sandbox, the agent's
// events for the page, the visitor's copy of the sample inbox, and the sandbox time of each day.
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { convexTable } from '@madeyexz/byoa/store/convex'

export default defineSchema({
  byoa: convexTable(),
  // a visitor is a random id that the page keeps; `seen`: the last request, for the cleanup an hour later; `acts`: how
  // many requests that may start a sandbox or save a login (a job, a sign-in) the visitor made, for demo.drop
  visitors: defineTable({ visitor: v.string(), at: v.number(), seen: v.number(), acts: v.optional(v.number()) }).index('by_visitor', ['visitor']).index('by_seen', ['seen']),
  // a sign-in's sandbox runs from `at` until it ends; `seen`: the page's last check-in
  signins: defineTable({ visitor: v.string(), harness: v.string(), pending: v.boolean(), at: v.number(), seen: v.number() })
    .index('by_visitor', ['visitor', 'harness']).index('by_pending', ['pending', 'seen']),
  jobs: defineTable({
    visitor: v.string(), harness: v.string(), task: v.optional(v.string()),
    state: v.union(v.literal('queued'), v.literal('running'), v.literal('done'), v.literal('failed')),
    at: v.number(), started: v.optional(v.number()), ended: v.optional(v.number()), result: v.optional(v.string()),
  }).index('by_state', ['state', 'at']).index('by_visitor', ['visitor', 'at']),
  events: defineTable({ job: v.id('jobs'), n: v.number(), e: v.string() }).index('by_job', ['job', 'n']),
  // only the messages the agent labeled; the others have INBOX and UNREAD
  mail: defineTable({ visitor: v.string(), id: v.string(), labels: v.array(v.string()) }).index('by_visitor', ['visitor', 'id']),
  decisions: defineTable({ visitor: v.string(), id: v.string(), category: v.string(), reason: v.string(), code: v.optional(v.string()) }).index('by_visitor', ['visitor', 'id']),
  drafts: defineTable({ visitor: v.string(), id: v.string(), body: v.string() }).index('by_visitor', ['visitor', 'id']),
  days: defineTable({ day: v.string(), ms: v.number() }).index('by_day', ['day']),
})
