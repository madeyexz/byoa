// The mail app's backend, as one fetch handler. The user's own Claude Code, Codex or Grok Build triages their Gmail inbox
// in a sandbox. The agent gets the tools of this app (byoa's `tools`), so it can read mail, add one label to each message,
// and save reply drafts, and nothing else: it cannot delete, send, or forward. /api/undo removes the labels and drafts.
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { createAgents, type AgentEvent, type RunHarness, type SandboxProvider } from '@madeyexz/byoa'
import { gmail, GmailExpired, type GoogleOptions } from './gmail.ts'
import { sqliteStore } from './store.ts'
import { AGENTS_MD, CATEGORIES, TOOLS, TRIAGED, type Category } from './triage.ts'

export { CATEGORIES, TRIAGED }

export interface MailAppOptions {
  db: DatabaseSync
  sandbox: SandboxProvider
  /** Where the browser reaches this app, such as https://mail.example.com. */
  publicUrl: string
  /** Where the job's sandbox reaches byoa's proxy. Default: `${publicUrl}/byoa/mcp`. */
  proxyUrl?: string
  encryptionKey: string
  google: Omit<GoogleOptions, 'redirectUrl'>
  /** Messages a job looks at, at most. Default 25. */
  max?: number
  /** Also take spam out of the inbox (Gmail's archive: the message stays in All Mail; /api/undo puts it back). */
  archiveSpam?: boolean
  /** Lets a job use byoa's fake harness, which runs no model (for tests). */
  fake?: boolean
}

export function mailApp(o: MailAppOptions) {
  const mail = gmail(o.db, o.encryptionKey, { ...o.google, redirectUrl: `${o.publicUrl}/google/callback` })
  o.db.exec(`create table if not exists decisions (user text not null, id text not null, category text not null, reason text not null,
    code text, subject text, sender text, archived integer not null, at integer not null, primary key (user, id))`)
  o.db.exec(`create table if not exists drafts (user text not null, draft text not null, id text not null, body text not null,
    at integer not null, primary key (user, draft))`)
  const max = o.max ?? 25
  const harnesses: RunHarness[] = [...LABS, ...(o.fake ? ['fake' as const] : [])]

  const agents = createAgents({
    app: 'mail',
    sandbox: o.sandbox,
    store: sqliteStore(o.db),
    encryptionKey: o.encryptionKey,
    proxyUrl: o.proxyUrl ?? `${o.publicUrl}/byoa/mcp`,
    oauth: { redirectUrl: `${o.publicUrl}/byoa/callback`, clientName: 'byoa mail' },
    tools: {
      mail: {
        list_inbox: {
          ...TOOLS.list_inbox,
          run: async (_a, { user }) => (await mail.inbox(user, { max, days: 7, skipLabels: [TRIAGED] })).map(({ labels: _, threadId: __, ...m }) => m),
        },
        read_message: {
          ...TOOLS.read_message,
          run: async ({ id }, { user }) => { const { labels: _, ...m } = await mail.message(user, String(id)); return m },
        },
        label_message: {
          ...TOOLS.label_message,
          run: async (a, { user }) => {
            const category = String(a.category) as Category
            if (!(category in CATEGORIES)) throw new Error(`category: one of ${Object.keys(CATEGORIES).join(', ')}`)
            const m = await mail.message(user, String(a.id))
            const archive = category === 'spam' && o.archiveSpam === true && m.labels.includes('INBOX')
            await mail.relabel(user, [m.id], [CATEGORIES[category], TRIAGED], archive ? ['INBOX'] : [])
            o.db.prepare(`insert into decisions values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (user, id) do update set category = excluded.category,
              reason = excluded.reason, code = excluded.code, archived = max(decisions.archived, excluded.archived), at = excluded.at`)
              .run(user, m.id, category, String(a.reason ?? '').slice(0, 200), a.code ? String(a.code).slice(0, 40) : null, m.subject, m.from, archive ? 1 : 0, Date.now())
            return `labeled ${CATEGORIES[category]}${archive ? ', and archived' : ''}`
          },
        },
        my_sent_mail: {
          ...TOOLS.my_sent_mail,
          run: async (_a, { user }) => mail.sent(user, 10),
        },
        save_draft: {
          ...TOOLS.save_draft,
          run: async (a, { user }) => {
            const body = String(a.body ?? '').trim()
            if (!body) throw new Error('body is empty')
            const draft = await mail.draftReply(user, String(a.id), body.slice(0, 8000))
            o.db.prepare('insert into drafts values (?, ?, ?, ?, ?)').run(user, draft, String(a.id), body.slice(0, 8000), Date.now())
            return `saved draft ${draft} (not sent)`
          },
        },
      },
    },
  })

  /** One triage job for the user. Needs no one at the page: a timer can start it (main.ts). */
  function triage(user: string, harness: RunHarness, task = 'Triage my inbox.'): AsyncGenerator<AgentEvent> {
    return agents.run(user, { harness, task, mcp: ['mail'], access: 'read-only', setup: { agentsMd: AGENTS_MD } })
  }

  /** Removes every label and draft this app added, and puts archived spam back in the inbox. */
  async function undo(user: string) {
    const ids = await mail.withLabel(user, TRIAGED)
    const archived = (o.db.prepare('select id from decisions where user = ? and archived = 1').all(user) as { id: string }[]).map((r) => r.id)
    for (let i = 0; i < ids.length; i += 500) await mail.relabel(user, ids.slice(i, i + 500), [], [TRIAGED, ...Object.values(CATEGORIES)])
    if (archived.length) await mail.relabel(user, archived, ['INBOX'], [])
    const drafts = (o.db.prepare('select draft from drafts where user = ?').all(user) as { draft: string }[]).map((r) => r.draft)
    for (const d of drafts) await mail.deleteDraft(user, d)
    o.db.prepare('delete from decisions where user = ?').run(user)
    o.db.prepare('delete from drafts where user = ?').run(user)
    return { unlabeled: ids.length, backInInbox: archived.length, draftsDeleted: drafts.length }
  }

  async function api(user: string, route: string, b: any): Promise<Response> {
    switch (route) {
      case 'GET /api/state': return json({
        gmail: mail.state(user), email: mail.email(user),
        login: Object.fromEntries(await Promise.all(LABS.map(async (h) => [h, await agents.loginState(user, h)]))),
        harnesses,
        decisions: o.db.prepare(`select d.id, category, reason, code, subject, sender, archived, d.at, (select body from drafts r where r.user = d.user
          and r.id = d.id order by r.at desc limit 1) as draft from decisions d where d.user = ? order by d.at desc limit 200`).all(user),
      })
      case 'POST /api/login': return json(await agents.connectLogin(user, plan(b.harness)))
      // Claude: with the code, it finishes. Codex and Grok: it waits up to 20 s for the user to enter the code.
      case 'POST /api/login/finish': return json(await agents.finishLogin(user, plan(b.harness), { code: b.code, waitMs: b.harness === 'claude' ? undefined : 20_000 }))
      // The user closed the sign-in: its sandbox ends now.
      case 'POST /api/login/cancel': return json(await agents.cancelLogin(user, plan(b.harness)) ?? {})
      case 'POST /api/gmail': return json({ url: mail.signInUrl(user) })
      case 'POST /api/triage': {
        if (!harnesses.includes(b.harness)) throw new Error(`harness: one of ${harnesses.join(', ')}`)
        if (mail.state(user) !== 'connected') throw new Error('connect Gmail first')
        return ndjson(triage(user, b.harness, b.task || undefined))
      }
      case 'POST /api/undo': return json(await undo(user))
    }
    return json({ error: 'not found' }, 404)
  }

  const page = readFileSync(new URL('page.html', import.meta.url), 'utf8')
  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith('/byoa/mcp/')) return await agents.proxy(req)
      if (url.pathname === '/google/callback') {
        const p = url.searchParams
        if (p.get('error')) throw new Error(`Google sign-in: ${p.get('error')}`)
        const user = await mail.finish(p.get('state') ?? '', p.get('code') ?? '')
        await mail.profile(user)
        return Response.redirect(`${o.publicUrl}/`, 302)
      }
      if (url.pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      // A stand-in for the app's own sign-in: the page sends the user's name. A real app reads its session here.
      const user = req.headers.get('x-user')?.trim()
      if (!user) return json({ error: 'no x-user header' }, 401)
      return await api(user, `${req.method} ${url.pathname}`, req.method === 'POST' ? JSON.parse((await req.text()) || '{}') : {})
    } catch (e) {
      return json({ error: (e as Error).message, ...(e instanceof GmailExpired ? { gmail: 'expired' } : {}) }, 400)
    }
  }

  return { handler, triage, undo, mail, agents }
}

// the labs whose own CLI sign-in the page shows
const LABS = ['claude', 'codex', 'grok'] as const
function plan(h: unknown): (typeof LABS)[number] {
  if (!LABS.includes(h as never)) throw new Error(`harness: one of ${LABS.join(', ')}`)
  return h as (typeof LABS)[number]
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** byoa's events, one JSON object per line, as they come. A browser that goes away ends the job. */
function ndjson(events: AsyncGenerator<AgentEvent>): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({
    async pull(c) {
      const n = await events.next()
      if (n.done) c.close()
      else c.enqueue(enc.encode(JSON.stringify(n.value) + '\n'))
    },
    async cancel() { await events.return(undefined) },
  }), { headers: { 'content-type': 'application/x-ndjson' } })
}
