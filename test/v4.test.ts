// V4 (R5.3, R2): the same user runs a job on E2B, then on Daytona. The second job uses the same MCP grant and skills,
// with no new MCP sign-in. Between the two, only the sandbox adapter changes: one store, one key, one proxy.
// BYOA_V4_PROVIDERS picks the two providers (default `e2b,daytona`; for example `e2b,instabox`), each with its key.
// The jobs use the fake harness: it calls the MCP tool through the real proxy as a harness would, so V4 needs no AI
// plan. A real sandbox must reach the proxy, so the test serves it through a Cloudflare quick tunnel (`cloudflared`
// on PATH, or BYOA_CLOUDFLARED). Needs BYOA_V4=1 and the two providers' keys (E2B_API_KEY and DAYTONA_API_KEY by
// default), and costs a little, so it runs only when asked (npm run test:v4), before a release, not on every commit. BYOA_E2B_TEMPLATE: any template with Node
// (default: E2B's `base`). Instabox sandboxes reach every public domain, so they need no relay.
// A Daytona org on Tier 1 or 2 lets its sandboxes reach only allowed domains, and the quick tunnel is not one. There,
// set BYOA_V4_RELAY to a relay on an allowed domain (such as a Convex HTTP action on *.convex.site) that sends
// `<relay>/<name>/...` to `https://<name>.trycloudflare.com/<name>/...`, path unchanged; test/relay is one. Both jobs
// then use it.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { SandboxGoneError, createAgents, memoryStore, readPlugin, type Sandbox, type SandboxProvider } from '../src/index.ts'
import { readPluginDir, toNodeListener } from '../src/node.ts'
import { q } from '../src/sh.ts'
import { daytona } from '../src/sandbox/daytona.ts'
import { e2b } from '../src/sandbox/e2b.ts'
import { instabox } from '../src/sandbox/instabox.ts'
import { collect } from './helpers/app.ts'
import { fakeMcp, signInAsUser } from './helpers/mcp-server.ts'
import { reachProxy, tunnel } from './helpers/tunnel.ts'

const PROVIDERS: Record<string, { key: string; make: () => SandboxProvider }> = {
  e2b: { key: 'E2B_API_KEY', make: () => e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' }) },
  daytona: { key: 'DAYTONA_API_KEY', make: () => daytona() },
  instabox: { key: 'INSTABOX_API_KEY', make: () => instabox() },
}
const names = (process.env.BYOA_V4_PROVIDERS ?? 'e2b,daytona').split(',').map((n) => n.trim())
for (const n of names) if (!PROVIDERS[n]) throw new Error(`BYOA_V4_PROVIDERS: no provider ${n}`)
const [first, second] = names as [string, string]
const skip = (!process.env.BYOA_V4 || names.some((n) => !process.env[PROVIDERS[n]!.key])) && `set BYOA_V4=1, ${names.map((n) => PROVIDERS[n]!.key).join(' and ')} to run V4`
const FIXTURES = join(import.meta.dirname, 'fixtures')
/** The files of the job's folder that come from the setup, which must be the same in both providers. */
const SETUP_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/skills/summarize/SKILL.md', '.claude/skills/summarize/references/checklist.md']

/** Keeps the setup files of each job's sandbox, read in the sandbox before it pauses or is destroyed, and each
 *  sandbox's id.
 *  `hosts`: a line for the sandbox's /etc/hosts. In E2B sandboxes about one lookup of the tunnel's name in four
 *  fails (no answer, or an IPv6 address the sandbox has no route to), and the fake harness does not retry. */
function kept(p: SandboxProvider, hosts?: () => string) {
  const k = { ids: [] as string[], files: [] as Record<string, string>[] }
  const wrap = (s: Sandbox): Sandbox => {
    const keep = async () => {
      const files: Record<string, string> = {}
      for (const f of SETUP_FILES) files[f] = (await s.run(`cat ${s.home}/work/${f}`)).stdout
      k.files.push(files)
    }
    return {
      id: s.id, home: s.home, run: (c, o) => s.run(c, o), writeFile: (f, d) => s.writeFile(f, d), ...(s.readFile ? { readFile: (f: string) => s.readFile!(f) } : {}),
      async pause() { await keep(); await s.pause() },
      async destroy() { await keep(); await s.destroy() },
    }
  }
  const provider: SandboxProvider = {
    name: p.name, capabilities: p.capabilities, deleteVolume: (n) => p.deleteVolume(n), destroy: (id) => p.destroy(id), resume: (id, o) => p.resume(id, o).then(wrap),
    create: async (o) => {
      const s = await p.create(o)
      k.ids.push(s.id)
      if (hosts) {
        const r = await s.run(`echo ${q(hosts())} | sudo tee -a /etc/hosts`)
        if (r.exitCode !== 0) throw new Error(`could not write /etc/hosts: ${r.stderr}`)
      }
      return wrap(s)
    },
  }
  return { provider, ...k }
}

test(`V4: a job on ${first}, then on ${second}, with the same MCP grant and skills and no new MCP sign-in`, { skip, timeout: 20 * 60_000 }, async () => {
  const mcp = await fakeMcp()
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  const server = createServer(toNodeListener((r) => handler(r)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  let t: Awaited<ReturnType<typeof tunnel>> | undefined
  // the user's sandboxes stay paused at each provider until deleted, also when an assertion fails
  let cleanup = async () => {}
  try {
    t = await tunnel((server.address() as AddressInfo).port)
    const relay = process.env.BYOA_V4_RELAY?.replace(/\/+$/, '')
    const proxyUrl = relay ? `${relay}/${new URL(t.url).hostname.split('.')[0]}/byoa/mcp` : `${t.url}/byoa/mcp`
    let hosts = ''

    const store = memoryStore()
    const app = { app: 'v4check', store, encryptionKey: randomBytes(32).toString('base64'), proxyUrl, oauth: { redirectUrl: 'http://127.0.0.1:9/callback' } }
    const onA = kept(PROVIDERS[first]!.make(), () => hosts)
    const onB = kept(PROVIDERS[second]!.make(), () => hosts)
    const agentsA = createAgents({ ...app, sandbox: onA.provider })
    const agentsB = createAgents({ ...app, sandbox: onB.provider })
    cleanup = () => Promise.all([agentsA, agentsB].map((a) => a.deleteSandbox('alice'))).then(() => {})
    // the proxy keeps its state in the store, so one served proxy is the same for both
    handler = agentsA.proxy
    // the tunnel's name needs a moment to resolve; the proxy must be served first
    hosts = await reachProxy(proxyUrl)

    const c = await agentsA.connectMcp('alice', mcp.url, { name: 'notes' })
    assert.equal(c.connected, false)
    if (!c.connected) await agentsA.finishMcp(await signInAsUser(c.signInUrl))
    const setup = { ...readPlugin(readPluginDir(join(FIXTURES, 'sample-plugin'))).setup, agentsMd: readFileSync(join(FIXTURES, 'AGENTS.md'), 'utf8') }
    const job = { harness: 'fake' as const, task: 'look up who I am\ncall notes.whoami {"via":"byoa"}\n', mcp: ['notes'], setup }

    for (const [agents, name] of [[agentsA, first], [agentsB, second]] as const) {
      const ev = await collect(agents.run('alice', job))
      assert.deepEqual(ev[0], { type: 'start', harness: 'fake', version: 'fake', sandbox: name })
      assert.deepEqual(ev.find((e) => e.type === 'tool_result'), { type: 'tool_result', id: 'call_1', ok: true, output: 'you are alice ({"via":"byoa"})' }, `${name}: the MCP call through the proxy`)
      assert.deepEqual(ev.at(-1), { type: 'end', ok: true, result: 'you are alice ({"via":"byoa"})' })
    }

    // one sign-in at the MCP server, for both jobs; and the grant still works
    assert.equal(mcp.registrations, 1)
    assert.equal(mcp.clientIds.length, 1)
    assert.deepEqual((await agentsB.listMcp('alice')).map((g) => g.name), ['notes'])
    // the same skills and AGENTS.md in both sandboxes, byte for byte the files V10 expects
    const expected = Object.fromEntries(SETUP_FILES.map((f) => [f, readFileSync(join(FIXTURES, 'expected', 'claude', f), 'utf8')]))
    assert.deepEqual(onA.files, [expected])
    assert.deepEqual(onB.files, [expected])
    // each provider has the user's one sandbox, paused; deleteSandbox removes it there
    assert.equal(onA.ids.length, 1)
    assert.equal(onB.ids.length, 1)
    await cleanup()
    await assert.rejects(PROVIDERS[first]!.make().resume(onA.ids[0]!), (e: Error) => e instanceof SandboxGoneError)
    await assert.rejects(PROVIDERS[second]!.make().resume(onB.ids[0]!), (e: Error) => e instanceof SandboxGoneError)
  } finally {
    await cleanup().catch(() => {})
    t?.close()
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
    await mcp.close()
  }
})
