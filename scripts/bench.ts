// The benchmark: how long byoa adds to one job, apart from the model's time, on a real sandbox provider. It runs
// byoa's own adapters and times each step of each job:
//
//   sandbox    create, or resume the user's sandbox
//   cli        find or install the pinned harness (the fake harness: write its script)
//   login      write the stored AI login into the sandbox, and read it back after the job (R1.4)
//   setup      write the skills, AGENTS.md, the MCP config and the task (R4)
//   harness    the harness's run; for the fake harness, node's start and one MCP call through the proxy (R3)
//   teardown   pause or destroy the sandbox
//   byoa       the rest: the store, the job token, byoa's own code
//
// and the job's time to first output (run() called → the harness's first event). Modes:
//
//   --harness fake (default)   agents.run with the fake harness (R7.2), which calls one MCP tool through the real
//                              proxy: no AI plan. The proxy is served here through a Cloudflare quick tunnel
//                              (`cloudflared` on PATH, or BYOA_CLOUDFLARED); with --relay, through a relay such as
//                              test/relay, for a Daytona org whose sandboxes reach only allowed domains.
//   --harness claude|codex     agents.session with the real, pinned CLI and a stored login that is not a real one:
//                              the install, the login copy and `<cli> --version` as the CLI's start, then close. No
//                              model runs, so no plan is needed.
//   --baseline                 the provider alone, as sandbox benchmarks measure it: create to the first
//                              `echo ok` (time to interactive), a warm `echo ok`, destroy, and with --per user
//                              pause and resume.
//
// --per user|job: the lifecycle (`sandboxPer`; default `user`, as in byoa). With `user`, each of --runs users runs
// --jobs jobs: the first creates the user's sandbox (cold), the others resume it (warm). byoa deletes each user's
// sandboxes at the end.
//
//   E2B_API_KEY=... node scripts/bench.ts --provider e2b --runs 20 --per job
//   DAYTONA_API_KEY=... node scripts/bench.ts --provider daytona --runs 10 --jobs 4 --relay https://<deployment>.convex.site
//
// It prints medians and p95 (nearest rank) per step; --out keeps every sample as JSON. It costs a little at the
// provider, so run it by hand, not in CI.
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createAgents, memoryStore, readPlugin, type AgentEvent, type HarnessName, type Sandbox, type SandboxProvider } from '../src/index.ts'
import { importKey, seal } from '../src/crypto.ts'
import { LOGIN_FILES } from '../src/login-stored.ts'
import { readPluginDir, toNodeListener } from '../src/node.ts'
import { q } from '../src/sh.ts'
import { fakeMcp, signInAsUser } from '../test/helpers/mcp-server.ts'
import { reachProxy, tunnel } from '../test/helpers/tunnel.ts'

const { values: a } = parseArgs({
  options: {
    provider: { type: 'string', default: 'e2b' },
    harness: { type: 'string', default: 'fake' },
    per: { type: 'string', default: 'user' },
    runs: { type: 'string', default: '10' },
    jobs: { type: 'string', default: '1' },
    template: { type: 'string' },
    relay: { type: 'string' },
    baseline: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
})
const runs = Number(a.runs), jobsPerUser = a.per === 'user' ? Number(a.jobs) : 1
const harness = a.harness as 'fake' | HarnessName
const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures')

async function provider(): Promise<SandboxProvider> {
  if (a.provider === 'e2b') return (await import('../src/sandbox/e2b.ts')).e2b(a.template ? { template: a.template } : {})
  if (a.provider === 'daytona') return (await import('../src/sandbox/daytona.ts')).daytona(a.template ? { snapshot: a.template } : {})
  throw new Error('--provider e2b or daytona')
}

// ---- timing --------------------------------------------------------------------------------------------------------

type Step = 'sandbox' | 'cli' | 'login' | 'setup' | 'teardown' | 'other'
interface Span { step: Step; what: string; ms: number }
// the harness's command: its start, and its first and last output. byoa ends the job at the harness's `end` event,
// before the command's exit reaches it, so the harness step ends at its last output.
let spans: Span[] = [], hStart: number | undefined, firstOut: number | undefined, lastOut: number | undefined, excluded = 0
const now = () => performance.now()

/** Marks the CLI's start in --harness claude|codex. */
const START = ' # the harness starts'
const loginPaths = Object.values(LOGIN_FILES).flat()
function stepOfRun(cmd: string): Step | 'harness' {
  if (cmd.includes('.byoa/task.md') || cmd.endsWith(START)) return 'harness'
  if (cmd.includes('npm install') || cmd.includes('--version')) return 'cli'
  if (loginPaths.some((p) => cmd.includes(p))) return 'login'
  if (cmd.includes('/work')) return 'setup'
  return 'other'
}
function stepOfFile(path: string): Step {
  if (loginPaths.some((p) => path.endsWith(p))) return 'login'
  if (path.endsWith('.byoa/fake.mjs')) return 'cli'
  if (path.includes('/work/')) return 'setup'
  return 'other'
}
async function timed<T>(step: Step, what: string, f: () => Promise<T>): Promise<T> {
  const t = now()
  try { return await f() } finally { spans.push({ step, what, ms: now() - t }) }
}

/** The provider, with each step timed. `hosts`: a line for each new sandbox's /etc/hosts (not timed), because about
 *  one lookup of a new tunnel's name in four fails in E2B sandboxes. */
function watched(p: SandboxProvider, hosts: () => string): SandboxProvider {
  const wrap = (s: Sandbox): Sandbox => {
    return {
      id: s.id, home: s.home,
      run: (cmd, o) => {
        const step = stepOfRun(cmd)
        if (step !== 'harness') return timed(step, cmd.slice(0, 60), () => s.run(cmd, o))
        hStart = now()
        return s.run(cmd, { ...o, onStdout: (c) => { firstOut ??= now(); lastOut = now(); o?.onStdout?.(c) } })
      },
      writeFile: (path, d) => timed(stepOfFile(path), path, () => s.writeFile(path, d)),
      pause: () => timed('teardown', 'pause', () => s.pause()),
      destroy: () => timed('teardown', 'destroy', () => s.destroy()),
    }
  }
  return {
    name: p.name,
    deleteVolume: (n) => p.deleteVolume(n),
    destroy: (id) => p.destroy(id),
    resume: (id, o) => timed('sandbox', 'resume', () => p.resume(id, o)).then(wrap),
    create: async (o) => {
      const s = await timed('sandbox', 'create', () => p.create(o))
      const t = now()
      if (hosts()) {
        const r = await s.run(`echo ${q(hosts())} | sudo tee -a /etc/hosts >/dev/null`)
        if (r.exitCode !== 0) throw new Error(`could not write /etc/hosts: ${r.stderr}`)
      }
      excluded += now() - t
      return wrap(s)
    },
  }
}

// ---- statistics ----------------------------------------------------------------------------------------------------

const rank = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.max(0, Math.ceil(p * s.length) - 1)]! }
const fmt = (ms: number) => ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
function table(rows: Record<string, number>[], title: string) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  console.log(`\n${title} (n=${rows.length})\n| | median | p95 | min | max |\n|---|---|---|---|---|`)
  for (const k of keys) {
    const xs = rows.map((r) => r[k]).filter((x): x is number => typeof x === 'number')
    if (xs.length) console.log(`| ${k} | ${fmt(rank(xs, 0.5))} | ${fmt(rank(xs, 0.95))} | ${fmt(Math.min(...xs))} | ${fmt(Math.max(...xs))} |`)
  }
}

// ---- modes ---------------------------------------------------------------------------------------------------------

async function baseline() {
  const p = await provider()
  const rows: Record<string, number>[] = []
  for (let i = 0; i < runs; i++) {
    const r: Record<string, number> = {}
    let t = now()
    const s = await p.create({ labels: { 'byoa-app': 'bench' }, timeoutMs: 10 * 60_000, keep: a.per === 'user' })
    r.create = now() - t
    await s.run('echo ok')
    r['time to interactive (create + first echo ok)'] = now() - t
    t = now(); await s.run('echo ok'); r['warm echo ok'] = now() - t
    // every harness byoa runs is a node program (the fake harness too): its first start in a new sandbox
    t = now(); await s.run('node -e 0'); r['first node start'] = now() - t
    t = now(); await s.run('node -e 0'); r['second node start'] = now() - t
    if (a.per === 'user') {
      t = now(); await s.pause(); r.pause = now() - t
      t = now(); const back = await p.resume(s.id, { timeoutMs: 10 * 60_000 }); r.resume = now() - t
      await back.run('echo ok'); r['resume + first echo ok'] = now() - t
      t = now(); await back.run('node -e 0'); r['node start after resume'] = now() - t
      t = now(); await back.destroy(); r.destroy = now() - t
    } else { t = now(); await s.destroy(); r.destroy = now() - t }
    rows.push(r)
    process.stderr.write('.')
  }
  return { title: `${p.name} baseline${a.per === 'user' ? ' (kept sandbox)' : ''}`, rows }
}

async function jobs() {
  const mcp = await fakeMcp()
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  const server = createServer(toNodeListener((r) => handler(r)))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const t = harness === 'fake' ? await tunnel((server.address() as AddressInfo).port) : undefined
  let hosts = ''
  const relay = a.relay?.replace(/\/+$/, '')
  const proxyUrl = !t ? 'https://proxy.invalid/byoa/mcp' : relay ? `${relay}/${new URL(t.url).hostname.split('.')[0]}/byoa/mcp` : `${t.url}/byoa/mcp`
  const store = memoryStore()
  const encryptionKey = randomBytes(32).toString('base64')
  const sandbox = watched(await provider(), () => hosts)
  if (a.per !== 'user' && a.per !== 'job') throw new Error('--per user or job')
  const agents = createAgents({ app: 'bench', sandbox, store, encryptionKey, proxyUrl, oauth: { redirectUrl: 'http://127.0.0.1:9/callback' }, sandboxPer: a.per })
  handler = agents.proxy
  const setup = { ...readPlugin(readPluginDir(join(FIXTURES, 'sample-plugin'))).setup, agentsMd: readFileSync(join(FIXTURES, 'AGENTS.md'), 'utf8') }
  const rows: Record<string, number>[] = []
  try {
    if (t) hosts = await reachProxy(proxyUrl)
    for (let u = 0; u < runs; u++) {
      const user = `user-${u}`
      if (harness === 'fake') {
        const c = await agents.connectMcp(user, mcp.url, { name: 'notes' })
        if (!c.connected) await agents.finishMcp(await signInAsUser(c.signInUrl))
      } else {
        // a stored login that is not a real one, sealed as storedLogin seals it: the CLI starts, no model runs
        const k = `ailogin/${encodeURIComponent(user)}/${harness}`
        const files = Object.fromEntries(LOGIN_FILES[harness].map((p) => [p, '{}']))
        await store.put(k, await seal(await importKey(encryptionKey), JSON.stringify(files), k))
      }
      try {
        for (let j = 0; j < jobsPerUser; j++) {
          spans = []; hStart = firstOut = lastOut = undefined; excluded = 0
          const t0 = now()
          let tStart = 0, tFirst = 0, tCall = 0, mcpMs = 0, ok = false
          if (harness === 'fake') {
            for await (const ev of agents.run(user, { harness: 'fake', task: 'look up who I am\ncall notes.whoami {"via":"byoa"}\n', mcp: ['notes'], setup }) as AsyncIterable<AgentEvent>) {
              if (ev.type === 'start') tStart = now()
              else if (ev.type === 'text' && !tFirst) tFirst = now()
              else if (ev.type === 'tool_call') tCall = now()
              else if (ev.type === 'tool_result') { mcpMs = now() - tCall; ok = ev.ok }
              else if (ev.type === 'error') console.error(`\n${user} job ${j}: ${ev.message}`)
              else if (ev.type === 'end') ok &&= ev.ok
            }
          } else {
            const s = await agents.session(user, { harness, setup })
            tStart = now()
            try {
              const r = await s.sandbox.run(`${q(s.bin)} --version${START}`, { env: s.env })
              // here the job waits for the command's exit, so the harness step ends there
              tFirst = firstOut ?? now(); lastOut = now()
              ok = r.exitCode === 0 && r.stdout.includes(s.version)
            } finally { await s.close() }
          }
          const total = now() - t0 - excluded
          if (!ok) { console.error(`\n${user} job ${j} failed`); continue }
          const by = (st: Step) => spans.filter((x) => x.step === st).reduce((n, x) => n + x.ms, 0)
          const r: Record<string, number> = {
            'time to first output': tFirst - t0 - excluded,
            'ready (run → start event)': tStart - t0 - excluded,
            sandbox: by('sandbox'), cli: by('cli'), login: by('login'), setup: by('setup'),
            harness: hStart && lastOut ? lastOut - hStart : 0,
            'harness start → first output': hStart && firstOut ? firstOut - hStart : 0,
            ...(harness === 'fake' ? { 'MCP call through the proxy': mcpMs } : {}),
            teardown: by('teardown'),
            byoa: total - (hStart && lastOut ? lastOut - hStart : 0) - ['sandbox', 'cli', 'login', 'setup', 'teardown', 'other'].reduce((n, st) => n + by(st as Step), 0),
            'other sandbox calls': by('other'),
            'total job': total,
            'after the harness ends': lastOut ? t0 + excluded + total - lastOut : 0,
          }
          rows.push({ ...r, cold: j === 0 ? 1 : 0 })
          process.stderr.write(j === 0 ? 'c' : 'w')
        }
      } finally {
        await agents.deleteSandbox(user).catch((e) => console.error(`\ncould not delete ${user}'s sandbox: ${(e as Error).message}`))
      }
    }
  } finally {
    t?.close()
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
    await mcp.close()
  }
  return { title: `${sandbox.name} ${harness} job, sandboxPer ${a.per}`, rows }
}

const res = a.baseline ? await baseline() : await jobs()
process.stderr.write('\n')
const strip = (rs: Record<string, number>[]) => rs.map(({ cold: _, ...r }) => r)
if (jobsPerUser > 1) {
  table(strip(res.rows.filter((r) => r.cold)), `${res.title}: first job of each user (cold)`)
  table(strip(res.rows.filter((r) => !r.cold)), `${res.title}: later jobs (warm)`)
} else table(strip(res.rows), res.title)
if (a.out) writeFileSync(a.out, JSON.stringify({ args: a, title: res.title, at: new Date().toISOString(), rows: res.rows }, null, 2))
process.exit(0)
