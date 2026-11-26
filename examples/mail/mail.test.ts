// The mail app end to end with byoa's fake harness and a fake Gmail: no AI plan, no Google account, no sandbox
// provider. A job's tool calls go from the (local) sandbox through byoa's proxy to the app's mail tools, which call
// the fake Gmail API. The test checks what Gmail ends with: labels only, and undo puts everything back.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { toNodeListener } from '@madeyexz/byoa/node'
import { localSandbox } from '@madeyexz/byoa/sandbox/local'
import { mailApp, TRIAGED } from './app.ts'

const servers: ReturnType<typeof createServer>[] = []
after(() => { for (const s of servers) { s.closeAllConnections(); s.close() } })

async function serve(h: (r: Request) => Promise<Response>) {
  const s = createServer(toNodeListener(h))
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

/** A fake Google: the token endpoint and the part of the Gmail API that the app uses. */
async function fakeGoogle() {
  const g = {
    refreshOk: true,
    refreshes: 0,
    labels: [{ id: 'INBOX', name: 'INBOX' }] as { id: string; name: string }[],
    messages: new Map<string, { labels: Set<string>; headers: Record<string, string>; snippet: string; body: string }>(),
    deleted: 0,
    drafts: new Map<string, { threadId: string; raw: string }>(),
  }
  const add = (id: string, headers: Record<string, string>, body: string) =>
    g.messages.set(id, { labels: new Set(['INBOX', 'UNREAD']), headers, snippet: body.slice(0, 80), body })
  add('m1', { From: 'PayPal <service@paypa1-secure.top>', Subject: 'Your account is limited', 'Authentication-Results': 'mx.google.com; spf=fail dkim=none dmarc=fail' }, 'Verify now at http://paypa1-secure.top or lose access.')
  add('m2', { From: 'GitHub <noreply@github.com>', Subject: 'Your GitHub launch code', 'Authentication-Results': 'mx.google.com; spf=pass dkim=pass dmarc=pass' }, 'Here is your code: 482913')
  add('m3', { From: 'Ana <ana@example.com>', 'Reply-To': 'Ana Home <ana@home.example>', Subject: 'Lunch Friday?', 'Message-ID': '<ana-1@example.com>', 'Authentication-Results': 'spf=pass dkim=pass dmarc=pass' }, 'Are you free on Friday?')
  g.messages.set('s1', { labels: new Set(['SENT']), headers: { To: 'bob@example.com', Subject: 'Re: plans' }, snippet: '', body: 'sounds good! -ian' })
  const msg = (id: string) => {
    const m = g.messages.get(id)!
    return {
      id, threadId: id, snippet: m.snippet, labelIds: [...m.labels],
      payload: { mimeType: 'text/plain', headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(m.body).toString('base64url') } },
    }
  }
  const url = await serve(async (req) => {
    const u = new URL(req.url), p = u.pathname.replace('/gmail/v1/users/me', '')
    if (u.pathname === '/token') {
      const f = new URLSearchParams(await req.text())
      g.refreshes++
      if (f.get('grant_type') === 'refresh_token' && (!g.refreshOk || f.get('refresh_token') !== 'refresh-1')) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({ access_token: 'access-1', expires_in: 3600 })
    }
    if (req.headers.get('authorization') !== 'Bearer access-1') return new Response('no', { status: 401 })
    if (p === '/profile') return Response.json({ emailAddress: 'me@example.com' })
    if (p === '/labels' && req.method === 'GET') return Response.json({ labels: g.labels })
    if (p === '/labels') { const b = await req.json() as any; const l = { id: `L${g.labels.length}`, name: b.name }; g.labels.push(l); return Response.json(l) }
    if (p === '/drafts') { const b = await req.json() as any; const id = `d${g.drafts.size + 1}`; g.drafts.set(id, { threadId: b.message.threadId, raw: Buffer.from(b.message.raw, 'base64url').toString() }); return Response.json({ id }) }
    const d = /^\/drafts\/([^/]+)$/.exec(p)
    if (d && req.method === 'DELETE') return g.drafts.delete(d[1]!) ? new Response(null, { status: 204 }) : new Response('no', { status: 404 })
    if (p === '/messages') {
      const lid = u.searchParams.get('labelIds') ?? (u.searchParams.get('q') === 'in:sent' ? 'SENT' : 'INBOX')
      return Response.json({ messages: [...g.messages].filter(([, m]) => m.labels.has(lid)).map(([id]) => ({ id })) })
    }
    if (p === '/messages/batchModify') {
      const b = await req.json() as any
      for (const id of b.ids) { const m = g.messages.get(id)!; b.addLabelIds.forEach((l: string) => m.labels.add(l)); b.removeLabelIds.forEach((l: string) => m.labels.delete(l)) }
      return new Response(null, { status: 204 })
    }
    const m = /^\/messages\/([^/]+)$/.exec(p)
    if (m && req.method === 'GET') return Response.json(msg(decodeURIComponent(m[1]!)))
    if (m) g.deleted++
    return new Response('not found', { status: 404 })
  })
  const names = (id: string) => [...g.messages.get(id)!.labels].map((l) => g.labels.find((x) => x.id === l)?.name ?? l).sort()
  return { g, url, names }
}

async function start() {
  const google = await fakeGoogle()
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  const url = await serve((r) => handler(r))
  const app = mailApp({
    db: new DatabaseSync(':memory:'),
    sandbox: localSandbox({ root: mkdtempSync(join(tmpdir(), 'mail-test-')) }),
    publicUrl: url,
    encryptionKey: randomBytes(32).toString('base64'),
    google: { clientId: 'cid', clientSecret: 'secret', endpoints: { token: `${google.url}/token`, api: google.url } },
    archiveSpam: true,
    fake: true,
  })
  handler = app.handler
  const send = (method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, headers: { 'x-user': 'ian', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const triage = async (lines: string[]) => {
    const r = await send('POST', '/api/triage', { harness: 'fake', task: ['triage', ...lines].join('\n') })
    assert.equal(r.status, 200, await r.clone().text())
    return (await r.text()).trim().split('\n').map((l) => JSON.parse(l))
  }
  return { app, google, send, triage }
}

test('the agent labels each message and drafts a reply through the app\'s tools; spam leaves the inbox; undo puts it all back', async () => {
  const { app, google: { g, names }, send, triage } = await start()
  app.mail.connect('ian', 'refresh-1')
  assert.equal(await app.mail.profile('ian'), 'me@example.com')

  const ev = await triage([
    'call mail.list_inbox {}',
    'call mail.label_message {"id":"m1","category":"spam","reason":"look-alike PayPal domain, dmarc fail"}',
    'call mail.label_message {"id":"m2","category":"sign-in","reason":"GitHub sign-in code","code":"482913"}',
    'call mail.label_message {"id":"m3","category":"needs-reply","reason":"Ana asks about lunch"}',
    'call mail.my_sent_mail {}',
    'call mail.save_draft {"id":"m3","body":"Friday works, see you then! -ian"}',
  ])
  const list = JSON.parse(ev.find((e) => e.type === 'tool_result')!.output)
  assert.deepEqual(list.map((m: any) => [m.id, m.auth]), [['m1', 'spf=fail dkim=none dmarc=fail'], ['m2', 'spf=pass dkim=pass dmarc=pass'], ['m3', 'spf=pass dkim=pass dmarc=pass']])
  const sent = JSON.parse(ev.filter((e) => e.type === 'tool_result')[4].output)
  assert.deepEqual(sent, [{ to: 'bob@example.com', subject: 'Re: plans', body: 'sounds good! -ian' }])
  assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'saved draft d1 (not sent)' })
  // A reply in Ana's thread, to her Reply-To address, that Gmail does not send.
  const draft = g.drafts.get('d1')!
  assert.equal(draft.threadId, 'm3')
  assert.match(draft.raw, /^To: Ana Home <ana@home\.example>\r\nSubject: Re: Lunch Friday\?\r\nIn-Reply-To: <ana-1@example\.com>\r\n/)
  assert.equal(Buffer.from(draft.raw.split('\r\n\r\n')[1]!, 'base64').toString(), 'Friday works, see you then! -ian')

  assert.deepEqual(names('m1'), ['AI/Spam', TRIAGED, 'UNREAD'])
  assert.deepEqual(names('m2'), ['AI/Sign-in', TRIAGED, 'INBOX', 'UNREAD'])
  assert.deepEqual(names('m3'), ['AI/Needs reply', TRIAGED, 'INBOX', 'UNREAD'])
  const s = await (await send('GET', '/api/state')).json()
  assert.deepEqual(s.decisions.map((d: any) => [d.id, d.category, d.code, d.archived, d.draft]).sort(), [['m1', 'spam', null, 1, null], ['m2', 'sign-in', '482913', 0, null], ['m3', 'needs-reply', null, 0, 'Friday works, see you then! -ian']])

  // The next job sees only mail that is not triaged yet.
  g.messages.set('m4', { labels: new Set(['INBOX']), headers: { From: 'Shop <orders@shop.example>', Subject: 'Order shipped' }, snippet: 'Shipped', body: 'Shipped' })
  const ev2 = await triage(['call mail.list_inbox {}'])
  assert.deepEqual(JSON.parse(ev2.at(-1).result).map((m: any) => m.id), ['m4'])

  assert.deepEqual(await (await send('POST', '/api/undo')).json(), { unlabeled: 3, backInInbox: 1, draftsDeleted: 1 })
  assert.equal(g.drafts.size, 0)
  for (const id of ['m1', 'm2', 'm3']) assert.deepEqual(names(id), ['INBOX', 'UNREAD'])
  assert.equal(g.deleted, 0)
})

test('the agent cannot use a category the app does not have, and an expired Google sign-in asks the user to connect again', async () => {
  const { app, google: { g, names }, send, triage } = await start()
  app.mail.connect('ian', 'refresh-1')
  const ev = await triage(['call mail.label_message {"id":"m1","category":"trash","reason":"x"}'])
  assert.equal(ev.find((e) => e.type === 'tool_result').ok, false)
  assert.deepEqual(names('m1'), ['INBOX', 'UNREAD'])

  // A Google app in testing mode: the refresh token ends after 7 days.
  app.mail.connect('ian', 'refresh-1')   // forgets the access token
  g.refreshOk = false
  const ev2 = await triage(['call mail.list_inbox {}'])
  assert.match(ev2.find((e) => e.type === 'tool_result').output, /expired: connect it again/)
  assert.equal((await (await send('GET', '/api/state')).json()).gmail, 'expired')
  assert.equal((await send('POST', '/api/triage', { harness: 'fake', task: 'x' })).status, 400)
})

