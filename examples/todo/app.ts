// The to-do app's backend, as one fetch handler. Everything the app does with byoa is in this file: the sign-in to
// the user's own Claude or ChatGPT plan (or the key of their OpenCode Go plan), the MCP connections, and the agent job.
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { createAgents, type AgentEvent, type RunHarness, type SandboxProvider } from '@madeyexz/byoa'
import { sqliteStore, todoList, todoMcp } from './todos.ts'

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
  /** Where this backend reaches itself. Default: publicUrl. */
  localUrl?: string
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
  })
  const harnesses: RunHarness[] = ['claude', 'codex', ...(o.fake ? ['fake' as const] : [])]

  async function api(user: string, route: string, b: any): Promise<Response> {
    switch (route) {
      case 'GET /api/state': return json({
        todos: todos.list(user),
        login: { claude: await agents.loginState(user, 'claude'), codex: await agents.loginState(user, 'codex'), 'opencode-go': await agents.loginState(user, 'opencode-go') },
        mcp: await agents.listMcp(user),
        harnesses,
      })
      // The lab's own sign-in page. Claude: a URL, then the code that page shows. ChatGPT: a URL and a code to enter.
      case 'POST /api/login': return json(await agents.connectLogin(user, plan(b.harness)))
      // Claude: with the code, it finishes; with none, it only checks in. Codex: it waits up to 20 s for the user. Each
      // call keeps the sign-in alive; with no call for 2 minutes, byoa ends it.
      case 'POST /api/login/finish': return json(await agents.finishLogin(user, plan(b.harness), { code: b.code, waitMs: b.harness === 'codex' ? 20_000 : undefined }))
      // The user closed the sign-in: its sandbox ends now.
      case 'POST /api/login/cancel': return json(await agents.cancelLogin(user, plan(b.harness)) ?? {})
      // OpenCode Go: the key the user made in OpenCode's Console. byoa checks it with OpenCode and keeps it encrypted; it
      // never goes into a sandbox. Remove it with signOut.
      case 'POST /api/key': return json(await agents.connectKey(user, 'opencode-go', String(b.key ?? '')))
      case 'POST /api/key/remove': return json(await agents.signOut(user, 'opencode-go') ?? {})
      case 'GET /api/models': return json(await agents.listModels(user, 'opencode-go'))
      // One time per user: the app's own to-do server with this user's token, or any MCP server with its own sign-in.
      case 'POST /api/connect': return json(b.url
        ? await agents.connectMcp(user, String(b.url), { name: String(b.name) })
        : await agents.connectMcp(user, `${o.localUrl ?? o.publicUrl}/mcp`, { name: 'todos', bearer: todos.tokenFor(user) }))
      case 'POST /api/ask': {
        if (!harnesses.includes(b.harness)) throw new Error(`harness: one of ${harnesses.join(', ')}`)
        const mcp = (await agents.listMcp(user)).map((g) => g.name)
        // with plan 'opencode-go', the harness runs on the user's Go key, with a model of that plan
        const go = b.plan === 'opencode-go' ? { plan: 'opencode-go' as const, model: String(b.model ?? '') || undefined } : {}
        return ndjson(agents.run(user, { harness: b.harness, task: String(b.task ?? ''), mcp, setup: { agentsMd: AGENTS_MD }, ...go }))
      }
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
      if (url.pathname === '/mcp') {
        const user = todos.userOf(/^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '')
        return user ? await todoMcp(req, todos, user) : json({ error: 'unauthorized' }, 401)
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

function plan(h: unknown): 'claude' | 'codex' {
  if (h !== 'claude' && h !== 'codex') throw new Error('harness: claude or codex')
  return h
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
