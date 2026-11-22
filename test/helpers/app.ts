// A test app: createAgents on a local sandbox and a memory store, with the MCP proxy served over node:http. The
// sandbox provider is watched: it keeps the environment of every command, and before each sandbox is destroyed it
// keeps the text of every file in it, so tests can search them for real tokens.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createAgents, memoryStore, type AgentEvent, type AgentsOptions, type Sandbox, type SandboxProvider } from '../../src/index.ts'
import { toNodeListener } from '../../src/node.ts'
import { localSandbox } from '../../src/sandbox/local.ts'

export interface Watched extends SandboxProvider { envs: Record<string, string>[]; files: string[]; created: number; live: Set<string> }

export function watched(inner: ReturnType<typeof localSandbox>): Watched {
  const w: Watched = {
    name: inner.name, envs: [], files: [], created: 0, live: inner.live,
    resume: (id) => inner.resume(id).then(wrap),
    deleteVolume: (n) => inner.deleteVolume(n),
    create: async (o) => { w.created++; return wrap(await inner.create(o)) },
  }
  function wrap(s: Sandbox): Sandbox {
    return {
      id: s.id, home: s.home, writeFile: (p, d) => s.writeFile(p, d),
      run: (cmd, o) => { w.envs.push({ ...o?.env }); return s.run(cmd, o) },
      destroy: async () => {
        for (const e of readdirSync(s.id, { recursive: true, withFileTypes: true })) {
          if (e.isFile()) { try { w.files.push(readFileSync(join(e.parentPath, e.name), 'utf8')) } catch {} }
        }
        await s.destroy()
      },
    }
  }
  return w
}

export async function testApp(o: Partial<AgentsOptions> & { env?: Record<string, string> } = {}) {
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  const server = createServer(toNodeListener((r) => handler(r)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/byoa/mcp`
  // a root of its own, so login volumes of other tests and earlier runs are not here
  const root = mkdtempSync(join(tmpdir(), 'byoa-test-'))
  const sandbox = watched(localSandbox({ root, env: o.env }))
  const store = memoryStore()
  const agents = createAgents({
    app: 'testapp', sandbox, store, encryptionKey: randomBytes(32).toString('base64'), proxyUrl,
    oauth: { redirectUrl: 'http://127.0.0.1:9/callback', clientName: 'Test app' }, ...o,
  })
  handler = agents.proxy
  return { agents, sandbox, store, root, proxyUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

export async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
