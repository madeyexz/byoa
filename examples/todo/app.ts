// The to-do app's backend, as one fetch handler. Everything the app does with byoa is in this file: the sign-in to
// the user's own Claude, ChatGPT or Grok plan (or the key of their OpenCode Go plan), the app's own tools, the chat
// with the agent, and the messages the user sends while the agent works.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { createAgents, type HarnessName, type Job, type RunHarness, type SandboxProvider } from '@madeyexz/byoa'
import { sqliteStore, todoList, todoTools } from './todos.ts'

const AGENTS_MD = `# To-do assistant

You manage the user's to-do list with the tools of the \`todos\` MCP server.
Read the list first. Change only what the user asks for. Then answer in one or two short sentences.
`
const PAGE = readFileSync(new URL('page.html', import.meta.url), 'utf8')

export interface TodoAppOptions {
  db: DatabaseSync
  sandbox: SandboxProvider
  /** Where browsers and sandboxes reach this app, such as https://todo.example.com. */
  publicUrl: string
  encryptionKey: string
  /** Lets a job use byoa's fake harness, which runs no model (for tests and demos). */
  fake?: boolean
}

export function todoApp(o: TodoAppOptions): (req: Request) => Promise<Response> {
  const todos = todoList(o.db)
  // No `login` option: byoa keeps each user's plan login encrypted in this app's database (with encryptionKey), and
  // writes a copy into each job's sandbox. `login: cliLogin` keeps it in a volume of the user instead.
  const agents = createAgents({
    app: 'todo',
    sandbox: o.sandbox,
    store: sqliteStore(o.db),
    encryptionKey: o.encryptionKey,
    proxyUrl: `${o.publicUrl}/byoa/mcp`,
    oauth: { redirectUrl: `${o.publicUrl}/byoa/callback`, clientName: 'byoa to-do example' },
    // the app's own tools, as functions: the proxy serves them at <proxyUrl>/todos for the user of each job, so
    // nobody connects them
    tools: { todos: todoTools(todos) },
  })
  const harnesses: RunHarness[] = [...LABS, ...(o.fake ? ['fake' as const] : [])]
  /** The jobs that run now, by the user and the job's id, so the page can send them more messages. */
  const running = new Map<string, Job>()

  async function api(user: string, route: string, b: any): Promise<Response> {
    switch (route) {
      case 'GET /api/state': return json({
        todos: todos.list(user),
        login: { ...Object.fromEntries(await Promise.all(LABS.map(async (h) => [h, await agents.loginState(user, h)]))), 'opencode-go': await agents.loginState(user, 'opencode-go') },
        mcp: await agents.listMcp(user),
        harnesses,
      })
      // The lab's own sign-in page. Claude: a URL, then the code that page shows. ChatGPT and Grok: a URL and a code to
      // enter there.
      case 'POST /api/login': return json(await agents.connectLogin(user, plan(b.harness)))
      // Claude: with the code, it finishes; with none, it only checks in. Codex, Grok: it waits up to 20 s for the user. Each
      // call keeps the sign-in alive; with no call for 2 minutes, byoa ends it.
      case 'POST /api/login/finish': return json(await agents.finishLogin(user, plan(b.harness), { code: b.code, waitMs: b.harness === 'claude' ? undefined : 20_000 }))
      // The user closed the sign-in: its sandbox ends now.
      case 'POST /api/login/cancel': return json(await agents.cancelLogin(user, plan(b.harness)) ?? {})
      // OpenCode Go: the key the user made in OpenCode's Console. byoa checks it with OpenCode and keeps it encrypted; it
      // never goes into a sandbox. Remove it with signOut.
      case 'POST /api/key': return json(await agents.connectKey(user, 'opencode-go', String(b.key ?? '')))
      case 'POST /api/key/remove': return json(await agents.signOut(user, 'opencode-go') ?? {})
      case 'GET /api/models': return json(await agents.listModels(user, 'opencode-go'))
      // One time per user: another MCP server, such as Notion, with its own sign-in page. The to-dos need none.
      case 'POST /api/connect': return json(await agents.connectMcp(user, String(b.url ?? ''), { name: String(b.name ?? '') }))
      case 'POST /api/ask': {
        if (!harnesses.includes(b.harness)) throw new Error(`harness: one of ${harnesses.join(', ')}`)
        const mcp = ['todos', ...(await agents.listMcp(user)).map((g) => g.name)]
        // with plan 'opencode-go', the harness runs on the user's Go key, with a model of that plan
        const go = b.plan === 'opencode-go' ? { plan: 'opencode-go' as const, model: String(b.model ?? '') || undefined } : {}
        // `chat`: the page's id of the chat. Each job of it continues the agent's own session, so a follow-up such as
        // "now the same for tomorrow" works. `read-only`: the agent only calls its tools and reads files.
        const job = agents.run(user, {
          harness: b.harness, task: String(b.task ?? ''), mcp, setup: { agentsMd: AGENTS_MD }, access: 'read-only',
          ...(b.chat ? { conversation: String(b.chat) } : {}), ...go,
        })
        const id = randomUUID()
        running.set(`${user}/${id}`, job)
        return ndjson(job, () => running.delete(`${user}/${id}`), { 'x-job': id })
      }
      // One more message to a job that runs now (steering): the agent takes it while it works. False when the job
      // ended (then the page asks again, as the next job of the chat) or with the fake harness.
      case 'POST /api/ask/send': {
        const job = running.get(`${user}/${String(b.job ?? '')}`)
        return json({ sent: job ? await job.send(String(b.text ?? '')) : false })
      }
      // A new chat: byoa deletes the old one's sessions, stored transcripts and kept sandboxes.
      case 'POST /api/chat/delete': return json(await agents.deleteConversation(user, String(b.chat ?? '')) ?? {})
    }
    return json({ error: 'not found' }, 404)
  }

  return async (req) => {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith('/byoa/mcp/')) return await agents.proxy(req)
      if (url.pathname === '/byoa/callback') {
        const p = url.searchParams
        await agents.finishMcp({ state: p.get('state') ?? '', code: p.get('code') ?? undefined, error: p.get('error') ?? undefined })
        return Response.redirect(`${o.publicUrl}/`, 302)
      }
      if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      // A stand-in for the app's own sign-in: the page sends the user's name. A real app reads its session here.
      // (a page that closes sends its cancel as a beacon, which has no headers: the name is in the URL)
      const user = (req.headers.get('x-user') ?? (url.pathname === '/api/login/cancel' ? url.searchParams.get('user') : null))?.trim()
      if (!user) return json({ error: 'no x-user header' }, 401)
      return await api(user, `${req.method} ${url.pathname}`, req.method === 'POST' ? await req.json() : {})
    } catch (e) {
      return json({ error: (e as Error).message }, 400)
    }
  }
}

// the labs whose own CLI sign-in the page shows
const LABS: HarnessName[] = ['claude', 'codex', 'grok']
function plan(h: unknown): HarnessName {
  if (!LABS.includes(h as HarnessName)) throw new Error(`harness: one of ${LABS.join(', ')}`)
  return h as HarnessName
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** byoa's events, one JSON object per line, as they come. A browser that goes away ends the job. */
function ndjson(job: Job, done: () => void, headers: Record<string, string>): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({
    async pull(c) {
      const n = await job.next()
      if (n.done) { done(); c.close() }
      else c.enqueue(enc.encode(JSON.stringify(n.value) + '\n'))
    },
    async cancel() { done(); await job.return(undefined) },
  }), { headers: { 'content-type': 'application/x-ndjson', ...headers } })
}
