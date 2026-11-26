// The app's own Gmail access. Nothing here knows about byoa: the backend signs the user in to Google (OAuth, scope
// gmail.modify), keeps the refresh token encrypted in its own SQLite, and calls the Gmail API. The agent never gets a
// Google token; it gets only the tools in app.ts, which can read mail and add labels, and nothing else.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

export interface GoogleOptions {
  clientId: string
  clientSecret: string
  /** The app's route that finishes the Google sign-in, such as https://mail.example.com/google/callback. */
  redirectUrl: string
  /** For tests: other origins for Google's endpoints. */
  endpoints?: { auth?: string; token?: string; api?: string }
}

export interface MessageSummary {
  id: string; threadId: string; messageId?: string; from: string; replyTo?: string; to: string; subject: string; date: string
  snippet: string
  /** The receiving server's SPF, DKIM and DMARC results, such as "spf=pass dkim=pass dmarc=pass". */
  auth: string
  unsubscribe: boolean
  /** Gmail's own tab, such as promotions or social. */
  gmailCategory?: string
  labels: string[]
}

export class GmailExpired extends Error {}

export function gmail(db: DatabaseSync, encryptionKey: string, o: GoogleOptions) {
  const authUrl = o.endpoints?.auth ?? 'https://accounts.google.com/o/oauth2/v2/auth'
  const tokenUrl = o.endpoints?.token ?? 'https://oauth2.googleapis.com/token'
  const api = (o.endpoints?.api ?? 'https://gmail.googleapis.com') + '/gmail/v1/users/me'
  const key = Buffer.from(encryptionKey, 'base64')
  db.exec('create table if not exists google (user text primary key, refresh text not null, email text, expired integer not null default 0)')
  const pending = new Map<string, string>()
  const access = new Map<string, { token: string; until: number }>()

  const seal = (s: string) => {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(Buffer.from('google-refresh'))
    return Buffer.concat([iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()]).toString('base64')
  }
  const open = (s: string) => {
    const b = Buffer.from(s, 'base64'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
    d.setAAD(Buffer.from('google-refresh'))
    d.setAuthTag(b.subarray(-16))
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8')
  }
  const row = (user: string) => db.prepare('select refresh, email, expired from google where user = ?').get(user) as { refresh: string; email: string | null; expired: number } | undefined

  async function token(user: string): Promise<string> {
    const a = access.get(user)
    if (a && a.until > Date.now()) return a.token
    const r = row(user)
    if (!r || r.expired) throw new GmailExpired('Gmail is not connected, or its sign-in expired: connect it again')
    const res = await fetch(tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: open(r.refresh), client_id: o.clientId, client_secret: o.clientSecret }) })
    const j = await res.json() as any
    if (j.error === 'invalid_grant') {
      // A Google app in testing mode: a refresh token lasts 7 days. The user signs in again.
      db.prepare('update google set expired = 1 where user = ?').run(user)
      throw new GmailExpired('The Gmail sign-in expired: connect it again')
    }
    if (!res.ok) throw new Error(`Google token: ${res.status} ${j.error ?? ''}`)
    access.set(user, { token: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 })
    return j.access_token
  }

  async function call(user: string, path: string, init?: { method?: string; body?: unknown }): Promise<any> {
    const res = await fetch(api + path, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${await token(user)}`, ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    })
    if (!res.ok) throw new Error(`Gmail ${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return res.status === 204 ? null : res.json()
  }

  /** Label name → id; creates the labels that are missing. */
  async function labelIds(user: string, names: string[]): Promise<Record<string, string>> {
    const have: Record<string, string> = Object.fromEntries(((await call(user, '/labels')).labels ?? []).map((l: any) => [l.name, l.id]))
    for (const n of names) {
      if (!have[n]) have[n] = (await call(user, '/labels', { method: 'POST', body: { name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' } })).id
    }
    return have
  }

  return {
    state(user: string): 'connected' | 'expired' | 'not-connected' {
      const r = row(user)
      return !r ? 'not-connected' : r.expired ? 'expired' : 'connected'
    },
    email: (user: string) => row(user)?.email ?? undefined,
    users: () => (db.prepare('select user from google where expired = 0').all() as { user: string }[]).map((r) => r.user),
    /** Google's own sign-in page. */
    signInUrl(user: string): string {
      const state = randomBytes(16).toString('hex')
      pending.set(state, user)
      return `${authUrl}?${new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirectUrl, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state })}`
    },
    async finish(state: string, code: string): Promise<string> {
      const user = pending.get(state)
      pending.delete(state)
      if (!user) throw new Error('unknown or used sign-in state')
      const res = await fetch(tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: o.redirectUrl, client_id: o.clientId, client_secret: o.clientSecret }) })
      const j = await res.json() as any
      if (!res.ok || !j.refresh_token) throw new Error(`Google sign-in: ${j.error ?? res.status} ${j.error_description ?? ''}`)
      this.connect(user, j.refresh_token)
      access.set(user, { token: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 })
      return user
    },
    /** Keeps a refresh token that the user got elsewhere (such as Google's OAuth Playground). */
    connect(user: string, refreshToken: string) {
      db.prepare('insert into google (user, refresh) values (?, ?) on conflict (user) do update set refresh = excluded.refresh, expired = 0').run(user, seal(refreshToken))
      access.delete(user)
    },
    async profile(user: string) {
      const p = await call(user, '/profile')
      db.prepare('update google set email = ? where user = ?').run(p.emailAddress, user)
      return p.emailAddress as string
    },
    /** Inbox messages of the last `days` days that have none of `skipLabels`, newest first. */
    async inbox(user: string, o: { max: number; days: number; skipLabels: string[] }): Promise<MessageSummary[]> {
      const ids = await labelIds(user, o.skipLabels)
      const skip = new Set(o.skipLabels.map((n) => ids[n]))
      const out: MessageSummary[] = []
      let page: string | undefined
      do {
        const l = await call(user, `/messages?${new URLSearchParams({ q: `in:inbox newer_than:${o.days}d`, maxResults: '50', ...(page ? { pageToken: page } : {}) })}`)
        for (const m of l.messages ?? []) {
          if (out.length >= o.max) break
          const s = summary(await call(user, `/messages/${m.id}?format=metadata&${['From', 'To', 'Reply-To', 'Subject', 'Date', 'Authentication-Results', 'List-Unsubscribe'].map((h) => `metadataHeaders=${h}`).join('&')}`))
          if (!s.labels.some((x) => skip.has(x))) out.push(s)
        }
        page = l.nextPageToken
      } while (page && out.length < o.max)
      return out
    },
    async message(user: string, id: string) {
      const m = await call(user, `/messages/${encodeURIComponent(id)}?format=full`)
      return { ...summary(m), body: bodyText(m.payload).slice(0, 6000) }
    },
    /** Adds and removes labels by name (creating them when missing). Nothing here deletes or trashes mail. */
    async relabel(user: string, ids: string[], add: string[], remove: string[]) {
      const l = await labelIds(user, add.filter((n) => n !== 'INBOX'))
      const id = (n: string) => n === 'INBOX' ? 'INBOX' : l[n]
      await call(user, '/messages/batchModify', { method: 'POST', body: { ids, addLabelIds: add.map(id), removeLabelIds: remove.map(id).filter(Boolean) } })
    },
    /** Saves a reply to the message as a draft in the same thread. It is not sent: the user sends it from Gmail. */
    async draftReply(user: string, id: string, body: string): Promise<string> {
      const m = await this.message(user, id)
      const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`
      const word = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
      const raw = [
        `To: ${m.replyTo || m.from}`, `Subject: ${word(subject)}`,
        ...(m.messageId ? [`In-Reply-To: ${m.messageId}`, `References: ${m.messageId}`] : []),
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
        Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n'),
      ].join('\r\n')
      const d = await call(user, '/drafts', { method: 'POST', body: { message: { threadId: m.threadId, raw: Buffer.from(raw).toString('base64url') } } })
      return d.id
    },
    /** Deletes a draft that this app saved (undo). */
    async deleteDraft(user: string, draftId: string) {
      await call(user, `/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch((e) => { if (!/ 404 /.test(e.message)) throw e })
    },
    /** The text of the user's last sent messages, so a draft sounds like them. */
    async sent(user: string, n: number) {
      const l = await call(user, `/messages?${new URLSearchParams({ q: 'in:sent', maxResults: String(n) })}`)
      return Promise.all((l.messages ?? []).map(async (x: any) => { const m = await this.message(user, x.id); return { to: m.to, subject: m.subject, body: m.body.slice(0, 1500) } }))
    },
    /** The ids of the messages that have this label. */
    async withLabel(user: string, name: string): Promise<string[]> {
      const l = (await labelIds(user, [name]))[name]!
      const out: string[] = []
      let page: string | undefined
      do {
        const r = await call(user, `/messages?${new URLSearchParams({ labelIds: l, maxResults: '500', ...(page ? { pageToken: page } : {}) })}`)
        out.push(...(r.messages ?? []).map((m: any) => m.id))
        page = r.nextPageToken
      } while (page)
      return out
    },
  }
}
export type Gmail = ReturnType<typeof gmail>

function summary(m: any): MessageSummary {
  const h = (n: string) => (m.payload?.headers ?? []).find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value as string | undefined
  const ar = h('Authentication-Results') ?? ''
  const auth = ['spf', 'dkim', 'dmarc'].map((k) => new RegExp(`\\b${k}=(\\w+)`).exec(ar)?.[0]).filter(Boolean).join(' ')
  const labels: string[] = m.labelIds ?? []
  return {
    id: m.id, threadId: m.threadId, messageId: h('Message-ID'), from: h('From') ?? '', replyTo: h('Reply-To'), to: h('To') ?? '', subject: h('Subject') ?? '', date: h('Date') ?? '',
    snippet: decode(m.snippet ?? ''), auth: auth || 'none', unsubscribe: Boolean(h('List-Unsubscribe')),
    gmailCategory: labels.find((l) => l.startsWith('CATEGORY_'))?.slice(9).toLowerCase(), labels,
  }
}

/** The text of a message: its text/plain part, else its HTML without tags. */
function bodyText(p: any): string {
  const parts: any[] = []
  const walk = (x: any) => { if (!x) return; parts.push(x); (x.parts ?? []).forEach(walk) }
  walk(p)
  const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const plain = parts.find((x) => x.mimeType === 'text/plain' && x.body?.data)
  if (plain) return b64(plain.body.data).trim()
  const html = parts.find((x) => x.mimeType === 'text/html' && x.body?.data)
  if (!html) return ''
  return decode(b64(html.body.data).replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, ' [link: $1] ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function decode(s: string) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
