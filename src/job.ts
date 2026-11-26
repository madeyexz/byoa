// One job (R5.4 to R5.10): the user's sandbox (kept, or one for the job), the credential (credential.ts), the pinned
// harness, the setup in the job's folder, and a job token for the job's MCP servers; then the harness with the task,
// read into events in one schema (R5.5). A job of a conversation (R5.9) continues the harness's own session, and a job
// takes more messages while it runs, through the harness's driver (R5.10).
import { ACCESS, JOB_TOKEN_ENV, MCP_PROTOCOL, type Access, type Plugin, type Setup } from './config.ts'
import type { Conversations } from './conversation.ts'
import { LoginError, labLogin, noCredential, planKey, type Credential } from './credential.ts'
import { sha256hex } from './crypto.ts'
import type { AgentEvent, EventReader } from './harness/events.ts'
import { HARNESSES, SETUP_PATHS, harness, harnessFiles, isLab } from './harness/index.ts'
import { MODELS_JS, type ModelInfo } from './harness/models.ts'
import type { HarnessName, Pins } from './harness/pins.ts'
import type { Harness, ModelChoice, RunHarness, Turn } from './harness/types.ts'
import type { LoginDriver } from './login.ts'
import type { UsageLimit, UsageLimits } from './limits.ts'
import { GrantError } from './mcp/grants.ts'
import { PROXY_HEADER } from './mcp/proxy.ts'
import { PLANS, isPlan, type PlanKeys, type PlanName } from './plan.ts'
import { SandboxGoneError, type Sandbox, type SandboxProvider } from './sandbox/types.ts'
import { q } from './sh.ts'
import type { Held, Slots } from './slots.ts'
import { now } from './time.ts'

/** A job waits in line (R5.8): for the user's sandbox, or for the AI login; `ahead` jobs came before it. */
export interface Waiting { for: 'sandbox' | 'login'; ahead: number }

export interface SessionOptions extends ModelChoice {
  harness: RunHarness
  setup?: Setup
  plugins?: Plugin[]
  /** The MCP servers this job gets (R2.5). Default: none. A plugin's servers are added. */
  mcp?: string[]
  /** With `sandboxPer: 'user'`: which of the user's kept sandboxes the job runs in, such as a project or conversation
   *  id. Jobs with the same key (and harness) share one sandbox, paused between them. Default: the user's one sandbox
   *  for the harness. */
  sandboxKey?: string
  /** What the agent may do (R5.6). Default `full`: every tool of the harness, with no approval. `read-only`: the
   *  job's MCP tools, and reading files; no change to a file, and no network but the job's MCP servers. In a session,
   *  it changes only the files byoa writes (Codex's MCP config): the app starts the harness with its own flags. */
  access?: Access
  /** While the job waits in line for the user's sandbox or the AI login (R5.8). */
  onWait?: (w: Waiting) => void
  /** Runs the harness with a plan that the user brought as a key (connectKey), not with the lab's login (R1.8):
   *  `'opencode-go'`, with Claude Code or Codex. The job needs a model of the plan (`model`, else createAgents'
   *  `models['opencode-go']`); listModels(user, 'opencode-go') lists them. */
  plan?: PlanName
}

export interface RunOptions extends SessionOptions {
  /** What the agent does. Several messages go to the one agent of this job, which reads them all and decides the
   *  order itself (R5.8). */
  task: string | string[]
  /** The app's id of a conversation (1 to 128 characters), such as a chat thread (R5.9). The job continues the
   *  harness's own session of the earlier jobs with this id, of this user and harness, in the conversation's kept
   *  sandbox (its `sandboxKey` is the id), with the files that they left in the job's folder. Default: none; each job
   *  starts a new session and a new job folder. */
  conversation?: string
}

/** A running job: its events, and `send` for one more message while it runs (R5.10). */
export interface Job extends AsyncGenerator<AgentEvent> {
  /** Gives the running agent one more message (steering). Codex and Grok Build take it into the turn that runs; Claude
   *  Code takes it when that turn ends. A turn that is not the job's last gives a `turn` event; the job ends after the
   *  turn that answers the last message. False when the job ended, or with the fake harness, which takes no message
   *  while it runs. */
  send(message: string): Promise<boolean>
}

export interface Session {
  sandbox: Sandbox
  /** The job's folder, with the files byoa writes for the harness (R4). */
  work: string
  harness: RunHarness
  /** The pinned, unmodified harness binary in the sandbox (for `fake`: the fake harness's script, run with node). */
  bin: string
  version: string
  /** The harness's flags for the job's model and effort (from SessionOptions, else createAgents' `models`), for the
   *  app's own command line. */
  args: string[]
  /** The harness's environment: its login folder, the job token (JOB_TOKEN_ENV), and for Claude Code, how long it
   *  waits for each MCP server to start (MCP_TIMEOUT). With a plan: the plan's settings, with the relay and the job
   *  token, and no lab login. */
  env: Record<string, string>
  /** The job token: each MCP server below takes it as `Authorization: Bearer`, until close. */
  token: string
  /** The MCP servers this job has, at the proxy (R3.1). */
  mcp: { name: string; url: string }[]
  /** Servers asked for that this user has not connected; the job runs without them. */
  missing: string[]
  /** Servers of this job that did not answer one MCP `initialize` from the sandbox through the proxy (R3.5), each
   *  with the reason. The harness may not have their tools. */
  failing: { name: string; message: string }[]
  /** What the harness showed of its login: `expired` when it refused it, `signed-in` when a job worked (R1.6). */
  reportLogin(state: 'signed-in' | 'expired'): Promise<void>
  /** Ends the job token (R3.4), saves the login the CLI refreshed and removes it from the sandbox (R1.4), and pauses
   *  the user's sandbox, or destroys a sandbox of one job (R5.4). */
  close(): Promise<void>
}

export interface JobToken {
  /** Send it as `Authorization: Bearer` to each server in `mcp`. */
  token: string
  job: string
  /** The MCP servers this token reaches, at the proxy. */
  mcp: { name: string; url: string }[]
  /** Servers asked for that this user has not connected. */
  missing: string[]
  /** Ends the token (R3.4). */
  close(): Promise<void>
}

/** The user's plan is used up (R1.9): byoa keeps that until it resets, and a job until then starts no sandbox. */
export class UsageLimitError extends Error {
  readonly code = 'usage-limit'
  readonly resetsAt?: number
  constructor(l: UsageLimit) {
    super(`the plan is used up until ${new Date(l.until).toISOString()}, so byoa did not start this job: ${l.message}`)
    if (l.resetsAt) this.resetsAt = l.resetsAt
  }
}

/** The job's sandbox cannot reach the MCP proxy at `proxyUrl` (R3.5), so no MCP tool of the job can work. */
export class ProxyError extends Error { readonly code = 'mcp' }

/** Runs with node in the job's sandbox, before the harness: one MCP `initialize` to each of the job's servers at the
 *  proxy, with the job token. It prints, for each server, whether the proxy answered and with which status. */
const CHECK_JS = String.raw`
const servers = JSON.parse(process.env.BYOA_CHECK)
const auth = { authorization: 'Bearer ' + process.env.${JOB_TOKEN_ENV} }
const one = async (s, n = 0) => {
  try {
    const r = await fetch(s.url, {
      method: 'POST', signal: AbortSignal.timeout(70000),
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '${MCP_PROTOCOL}', capabilities: {}, clientInfo: { name: 'byoa-check', version: '1' } } }),
    })
    // the proxy's own header; or, behind a relay that drops headers, an MCP answer (JSON-RPC, or a stream of them)
    let proxy = r.headers.get('${PROXY_HEADER}') === '1', message = ''
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) { proxy = true; await r.body?.cancel() }
    else {
      const text = await r.text()
      try { const m = JSON.parse(text); if (m?.jsonrpc === '2.0') proxy = true; message = m?.error?.message || '' } catch {}
    }
    const sid = r.ok && r.headers.get('mcp-session-id')
    if (sid) await fetch(s.url, { method: 'DELETE', signal: AbortSignal.timeout(5000), headers: { ...auth, 'mcp-session-id': sid } }).then((d) => d.body?.cancel(), () => {})
    return { name: s.name, proxy, status: r.status, message: r.ok ? '' : message }
  } catch (e) {
    // no answer at all (not a timeout): a name lookup or a connection can fail one time in a new sandbox, so try 3 times
    if (n < 2 && e?.name !== 'TimeoutError') { await new Promise((r) => setTimeout(r, 1000 * (n + 1))); return one(s, n + 1) }
    return { name: s.name, proxy: false, status: 0, message: String(e?.cause?.message || e?.message || e) }
  }
}
console.log(JSON.stringify(await Promise.all(servers.map((s) => one(s)))))
`

/** How long a job waits for the harness to exit after its last event. The CLI still writes files after it printed its
 *  result (Claude Code 2.1.330 exits about 0.6 s later, and may write its login files then), so the job's login is
 *  saved and removed, and its lease given back, only after the CLI ended (R1.4). */
const EXIT_WAIT_MS = 10_000
/** How often a job saves what the CLI changed in its login while it runs (R1.4). */
const CHECKPOINT_MS = 60_000
/** How often a job renews the lease of its kept sandbox, and the sandbox's time, until its harness starts (R5.4, R5.8):
 *  the wait for the AI login has no limit, the lease runs out the job timeout and 5 minutes after it was last renewed,
 *  and the provider pauses or ends the sandbox when its time runs out. */
const SLOT_RENEW_MS = 60_000

/** One task, or several messages to one agent (R5.8): the agent gets them all at once and decides the order. */
export function taskText(task: string | string[]): string {
  if (typeof task === 'string') return task
  if (!task.length) throw new Error('byoa: task: at least one message')
  if (task.length === 1) return task[0]!
  return `You have ${task.length} messages from the user. Read them all first, then decide the order to do them in, and do each one.\n\n` +
    task.map((m, i) => `## Message ${i + 1}\n\n${m}`).join('\n\n') + '\n'
}

export interface JobDeps {
  app: string
  proxyUrl: string
  sandbox: SandboxProvider
  login: LoginDriver
  plans: PlanKeys
  pins: Pins
  models?: Partial<Record<HarnessName | PlanName, ModelChoice>>
  timeout: number
  /** `sandboxPer: 'user'`. */
  keep: boolean
  slots: Slots
  conversations: Conversations
  limits: UsageLimits
  jobToken(user: string, r: { mcp?: string[] }, plan?: PlanName): Promise<JobToken>
  serversOf(user: string): Promise<Set<string>>
}

const validKey = (s: unknown) => typeof s === 'string' && s.length >= 1 && s.length <= 128

export function jobs(d: JobDeps) {
  /** The job's credential: the user's lab login, a plan's key, or none for the fake harness. */
  function credentialOf(user: string, r: SessionOptions, x: Harness): Credential {
    const choice = { ...(r.plan ? d.models?.[r.plan] : isLab(x.name) ? d.models?.[x.name] : {}), ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) }
    if (r.plan !== undefined) {
      if (!isPlan(r.plan) || !x.plan) throw new Error(`byoa: plan: ${PLANS.join(', ')}, with the harness ${Object.values(HARNESSES).filter((h) => h.plan).map((h) => h.name).join(' or ')}`)
      if (!choice.model) throw new Error(`byoa: a job with the plan ${r.plan} needs a model; listModels(user, '${r.plan}') lists them`)
      return planKey(d.plans, d.login, d.limits, user, r.plan, { ...x, plan: x.plan }, { proxyUrl: d.proxyUrl, model: choice.model, effort: choice.effort })
    }
    return isLab(x.name) ? labLogin(d.login, user, HARNESSES[x.name], choice) : noCredential(x)
  }

  /** Opens one job. `keepWork`: a job of a conversation keeps what the earlier jobs left in the job's folder. */
  async function open(user: string, r: SessionOptions, o: { keepWork?: boolean } = {}): Promise<{ s: Session; x: Harness; cred: Credential }> {
    const h = r.harness
    const x = harness(h)
    if (r.sandboxKey !== undefined && (!d.keep || !validKey(r.sandboxKey))) {
      throw new Error(d.keep ? 'byoa: sandboxKey: a string of 1 to 128 characters' : "byoa: sandboxKey needs sandboxPer: 'user'")
    }
    if (r.access !== undefined && !ACCESS.includes(r.access)) throw new Error("byoa: access: 'full' or 'read-only'")
    const cred = credentialOf(user, r, x)
    // a plan's key is in the store: no sandbox is needed to know that it is not there
    await cred.ready()
    const key = r.sandboxKey ?? ''
    const plugins = r.plugins ?? []
    const t = await d.jobToken(user, { mcp: [...(r.mcp ?? []), ...plugins.flatMap((p) => p.mcp.map((m) => m.name))] }, r.plan)
    let sbx: Sandbox | undefined, slot: Held | undefined, closed = false
    let tick: ReturnType<typeof setInterval> | undefined, beat: ReturnType<typeof setInterval> | undefined, saving: Promise<void> = Promise.resolve()
    /** The kept sandbox stays this job's until the job timeout and 5 minutes from now (false: deleteSandbox took it). */
    const renew = () => slot ? d.slots.renew(slot, now() + d.timeout + 5 * 60_000).catch(() => false) : Promise.resolve(false)
    const close = async () => {
      if (closed) return
      closed = true
      clearInterval(tick)
      clearInterval(beat)
      await saving
      await t.close().catch(() => {})
      // the credential saves what the CLI changed, removes its files and gives its lease back, before the sandbox
      // pauses or goes. A kept sandbox whose login could not be removed is destroyed instead.
      const released = !sbx || (await cred.release(sbx).then(() => true, () => false))
      if (!slot) return sbx?.destroy()
      try {
        if (sbx && released) await sbx.pause()
        else if (sbx) { await sbx.destroy(); slot.sandbox = undefined }
      } finally {
        await d.slots.set(slot, slot.sandbox, 0)
      }
    }
    try {
      const setup: Setup = { agentsMd: r.setup?.agentsMd, skills: [...(r.setup?.skills ?? []), ...plugins.flatMap((p) => p.setup.skills ?? [])] }
      const files = harnessFiles(h, setup, { proxyUrl: d.proxyUrl, servers: t.mcp.map((m) => m.name), access: r.access })
      // until the harness starts, the setup and the wait for the AI login may take longer than the lease of the kept
      // sandbox and than the sandbox's own time: both are set again every minute (the sandbox's time to one minute more
      // than the job timeout + 60 s, so the login's watcher still runs first if this backend dies before setTimeout)
      beat = setInterval(() => { void renew(); void sbx?.setTimeout?.(d.timeout + 60_000 + SLOT_RENEW_MS).catch(() => {}) }, SLOT_RENEW_MS)
      beat.unref?.()
      if (d.keep) {
        slot = await d.slots.take(user, h, key, (ahead) => r.onWait?.({ for: 'sandbox', ahead }))
        if (slot.sandbox) {
          try { sbx = await d.sandbox.resume(slot.sandbox, { timeoutMs: d.timeout + 60_000 }) } catch (e) {
            // deleted or expired at the provider: the user gets a new one
            if (!(e instanceof SandboxGoneError)) throw e
          }
        }
      }
      if (!sbx) {
        const labels: Record<string, string> = slot
          ? { 'byoa-app': d.app, 'byoa-harness': h, 'byoa-user': (await sha256hex(user)).slice(0, 24), ...(key ? { 'byoa-key': (await sha256hex(key)).slice(0, 24) } : {}) }
          : { 'byoa-app': d.app, 'byoa-job': t.job }
        sbx = await d.sandbox.create({ volumes: await cred.volumes(), labels, timeoutMs: d.timeout + 60_000, keep: !!slot })
        if (slot) {
          slot.sandbox = sbx.id
          if (!(await d.slots.set(slot, sbx.id, now() + d.timeout + 5 * 60_000))) {
            slot = undefined
            throw new Error('byoa: the user\'s sandbox was deleted while this job started')
          }
        }
      }
      const work = `${sbx.home}/work`
      // each job's folder is new, also in a kept sandbox: no skills, MCP config or task of an earlier job. A job of a
      // conversation keeps the files the agent left there, and gets only byoa's own setup new (R5.9).
      if (o.keepWork) await sbx.run(`mkdir -p ${q(work)} && cd ${q(work)} && rm -rf ${SETUP_PATHS.map(q).join(' ')}`)
      else if (slot) await sbx.run(`rm -rf ${q(work)} && mkdir -p ${q(work)}`)
      await cred.check(sbx)
      // before the harness and the login: a job whose sandbox cannot reach the proxy must not start (R3.5)
      const failing = await checkServers(sbx, t)
      const { bin, version } = await x.install(sbx, d.pins)
      // the login leaves the sandbox before the provider pauses or ends it (it does at timeout + 1 min)
      const loaded = await cred.load(sbx, { token: t.token, job: { deadline: now() + d.timeout + 45_000, onWait: (ahead) => r.onWait?.({ for: 'login', ahead }) } })
      // the harness starts now, after the wait for the login: the sandbox's time and the lease of the kept sandbox start
      // again, so the harness gets its whole time and the login's watcher runs before the provider pauses the sandbox
      clearInterval(beat)
      await sbx.setTimeout?.(d.timeout + 60_000)
      await renew()
      const box = sbx
      if (cred.checkpoint) {
        // saves what the CLI changed in its login every minute, so a backend that dies loses at most that (R1.4)
        tick = setInterval(() => { saving = saving.then(() => cred.checkpoint!(box)).catch(() => {}) }, CHECKPOINT_MS)
        tick.unref?.()
      }
      for (const [p, text] of Object.entries(files)) await sbx.writeFile(`${work}/${p}`, text)
      const s: Session = {
        sandbox: box, work, harness: h, bin, version, token: t.token, args: loaded.args,
        env: { ...loaded.env, [JOB_TOKEN_ENV]: t.token },
        mcp: t.mcp, missing: t.missing, failing, close,
        reportLogin: (state) => cred.report(state),
      }
      return { s, x, cred }
    } catch (e) {
      await close().catch(() => {})
      throw e
    }
  }

  /** One MCP `initialize` from the job's sandbox to each of the job's servers, through the proxy (R3.5). A harness
   *  that cannot reach a server only leaves its tools out and still ends well (checked with Codex 0.171.0), so byoa
   *  finds out first. Throws ProxyError when no request reached the proxy; returns the servers that did not answer. */
  async function checkServers(sbx: Sandbox, t: JobToken): Promise<Session['failing']> {
    if (!t.mcp.length) return []
    const file = `${sbx.home}/.byoa/check.mjs`
    await sbx.writeFile(file, CHECK_JS)
    const r = await sbx.run(`node ${q(file)}`, { env: { BYOA_CHECK: JSON.stringify(t.mcp), [JOB_TOKEN_ENV]: t.token }, timeoutMs: 90_000 })
    let res: { name: string; proxy: boolean; status: number; message: string }[]
    // a sandbox that cannot run the check (no node on its PATH) is not a reason to stop a job
    try { res = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') } catch { return [] }
    const bad = res.filter((x) => !x.proxy || x.status < 200 || x.status >= 300)
    if (res.every((x) => !x.proxy)) {
      const x = res[0]!
      throw new ProxyError(`byoa: the sandbox cannot reach the MCP proxy at ${d.proxyUrl} (${x.message || `an answer with status ${x.status} that is not the proxy's`}); the job did not start. Serve agents.proxy at proxyUrl, at an address the sandbox can reach`)
    }
    return bad.map((x) => ({ name: x.name, message: x.proxy ? x.message || `the proxy answered ${x.status}` : `no answer from the proxy (${x.message || x.status})` }))
  }

  async function missingOf(user: string, r: SessionOptions) {
    const want = [...new Set([...(r.mcp ?? []), ...(r.plugins ?? []).flatMap((p) => p.mcp.map((m) => m.name))])]
    const have = await d.serversOf(user)
    return want.filter((s) => !have.has(s))
  }

  /** Runs one job (R5.4): a session, the harness with the task, then close (the sandbox pauses, or goes). Events in one
   *  schema for every harness (R5.5). */
  function run(user: string, r: RunOptions): Job {
    let x0: Harness | undefined
    try { x0 = harness(r.harness) } catch {}
    const steer = !!x0?.driver
    /** The job's messages to the harness: the task first (R5.10). */
    const messages: string[] = []
    let inbox: { sbx: Sandbox; dir: string } | undefined, ended = false, writing: Promise<void> = Promise.resolve()
    const write = (n: number) => {
      const b = inbox!
      writing = writing.then(async () => {
        await b.sbx.writeFile(`${b.dir}/${n}.json`, JSON.stringify(messages[n]))
        await b.sbx.writeFile(`${b.dir}/${n}.ok`, '')
      }).catch(() => {})
      return writing
    }

    async function* events(): AsyncGenerator<AgentEvent> {
      const h = r.harness
      let s: Session | undefined
      let end: AgentEvent = { type: 'end', ok: false }
      let held: UsageLimit | undefined
      try {
        for (const m of await missingOf(user, r)) yield { type: 'error', code: 'mcp', message: `${m} is not connected for this user; the job runs without it` }
        try {
          const conv = r.conversation
          if (conv !== undefined && !validKey(conv)) throw new Error('byoa: conversation: a string of 1 to 128 characters')
          if (conv !== undefined && r.sandboxKey !== undefined && r.sandboxKey !== conv) throw new Error('byoa: a job of a conversation runs in its own kept sandbox: give no sandboxKey, or the conversation id')
          const task = taskText(r.task)
          // R1.9: a plan that a job found used up stays so until it resets; until then no sandbox starts
          const limitName = r.plan !== undefined ? (isPlan(r.plan) ? r.plan : undefined) : isLab(r.harness) ? r.harness : undefined
          held = limitName === undefined ? undefined : await d.limits.get(user, limitName)
          if (held && held.until > now()) throw new UsageLimitError(held)
          const opened = await open(user, conv !== undefined && d.keep ? { ...r, sandboxKey: conv } : r, { keepWork: conv !== undefined })
          s = opened.s
          const { x, cred } = opened
          for (const f of s.failing) yield { type: 'error', code: 'mcp', message: `${f.name} does not answer through the proxy (${f.message}); the job may not have its tools` }
          // R5.9: the session to resume, or a new one; the harness's home folder holds its sessions
          const home = s.env[x.home.env]!
          let turn: Turn | undefined, turns = 0
          if (conv !== undefined) {
            const b = await d.conversations.begin(user, x, conv, s.sandbox, home, s.work)
            turn = b.turn
            turns = b.turns
            if (b.lost) yield { type: 'error', code: 'conversation', message: `the history of the conversation ${conv} is gone (the provider lost its sandbox, and its transcript was too large to keep); this job starts it again` }
          }
          // the model and effort flags come from s.args: the job's own, else the app's default (R5.7)
          const jobArgs = { work: s.work, access: r.access, servers: s.mcp.map((m) => m.name), model: s.args, conversation: turn }
          const line = x.command(s.bin, x.args(jobArgs))
          const reader: EventReader = x.reader()
          let cmd: string
          if (x.driver) {
            // the driver starts the harness and gives it the task, then each message the app sends while the job runs
            // (R5.10), from the job's inbox (harness/driver.ts)
            inbox = { sbx: s.sandbox, dir: `${s.work}/.byoa/in` }
            const js = `${s.work}/.byoa/driver.mjs`
            await s.sandbox.writeFile(js, x.driver.js)
            messages.unshift(task)
            for (let i = 0; i < messages.length; i++) await write(i)
            cmd = ['node', js, inbox.dir, JSON.stringify(x.driver.setup(jobArgs)), ...line].map(q).join(' ')
          } else {
            await s.sandbox.writeFile(`${s.work}/.byoa/task.md`, task)
            cmd = `${line.map(q).join(' ')} < .byoa/task.md`
          }
          yield { type: 'start', harness: h, version: s.version, sandbox: d.sandbox.name, ...(conv !== undefined ? { conversation: conv, resumed: turn!.resume } : {}) }

          for await (let ev of stream(s.sandbox, cmd, { cwd: s.work, env: s.env, timeoutMs: d.timeout }, reader)) {
            ev = await cred.event(ev)
            if (ev.type === 'end') {
              // R5.10: a message is still to come, so this was one turn; the job ends after the turn that answers the
              // last one, and the driver then ends the harness
              if (steer && !ended && messages.length > (reader.taken ?? 0)) {
                yield { type: 'turn', ok: ev.ok, ...(ev.result !== undefined ? { result: ev.result } : {}), ...(ev.usage ? { usage: ev.usage } : {}) }
                continue
              }
              ended = true
              if (inbox) { await writing; await inbox.sbx.writeFile(`${inbox.dir}/end`, '').catch(() => {}) }
              end = ev
              break
            }
            if (ev.type === 'error' && ev.code === 'expired') await s.reportLogin('expired')
            if (ev.type === 'error' && ev.code === 'usage-limit') await d.limits.set(user, r.plan ?? r.harness, ev)
            yield ev
          }
          ended = true
          if (conv !== undefined) {
            const session = await d.conversations.finish(user, x, conv, s.sandbox, home, s.work, turn!, turns, reader.session)
            if (session && end.type === 'end') end = { ...end, session }
          }
          if (end.type === 'end' && end.ok) {
            await s.reportLogin('signed-in')
            // the plan reset: a limit that ended goes
            if (held) await d.limits.clear(user, r.plan ?? r.harness)
          }
        } catch (e) {
          if (e instanceof LoginError) yield { type: 'error', code: 'signed-out', message: e.message }
          else if (e instanceof UsageLimitError) yield { type: 'error', code: 'usage-limit', message: e.message, ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}) }
          else yield { type: 'error', code: e instanceof GrantError || e instanceof ProxyError ? 'mcp' : 'sandbox', message: (e as Error).message }
        }
        ended = true
        if (s) {
          const failed = await s.close().then(() => undefined, (e) => `the sandbox was not ${d.keep ? 'paused' : 'destroyed'}: ${(e as Error).message}`)
          if (failed) yield { type: 'error', code: 'sandbox', message: failed }
        }
        yield end
      } finally {
        ended = true
        await s?.close().catch(() => {})
      }
    }

    return Object.assign(events(), {
      async send(message: string) {
        if (!steer || ended || typeof message !== 'string' || !message) return false
        messages.push(message)
        if (inbox) await write(messages.length - 1)
        return true
      },
    })
  }

  /** The models the user's plan can use with this harness (R5.7), as the unmodified CLI lists them with the user's
   *  login, in a new sandbox that is destroyed after. A list waits for the user's other jobs of that harness that
   *  hold the login alone. Each call starts a sandbox: keep the list for a while. */
  async function listModels(user: string, h: HarnessName | PlanName): Promise<ModelInfo[]> {
    if (isPlan(h)) {
      // a plan's models come from its API, with the user's key: no sandbox
      const apiKey = await d.plans.get(user, h)
      if (!apiKey) throw new LoginError(`${h} is not connected for this user; call connectKey first`)
      return d.plans.models(apiKey)
    }
    if (!isLab(h)) throw new Error(`byoa: listModels: ${[...Object.keys(HARNESSES), ...PLANS].join(', ')}`)
    const x = HARNESSES[h]
    const sbx = await d.sandbox.create({ volumes: await d.login.volumes(user, h), labels: { 'byoa-app': d.app, 'byoa-models': h }, timeoutMs: 10 * 60_000 })
    try {
      await labLogin(d.login, user, x, {}).check(sbx)
      const { bin } = await x.install(sbx, d.pins)
      const env = await d.login.env(sbx, user, h, { deadline: now() + 9 * 60_000 })
      await sbx.setTimeout?.(10 * 60_000)
      const file = `${sbx.home}/.byoa/models.mjs`
      await sbx.writeFile(file, MODELS_JS)
      const r = await sbx.run(`node ${q(file)} ${q(bin)} ${x.models.protocol}`, { env, cwd: sbx.home, timeoutMs: 120_000 })
      let out: { models?: any[]; error?: string }
      try { out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') } catch { throw new Error(`byoa: ${h} did not list its models: ${(r.stderr || r.stdout).trim().slice(-300)}`) }
      if (!out.models) throw new Error(`byoa: ${h} did not list its models: ${out.error}`)
      return x.models.read(out.models)
    } finally {
      await d.login.release?.(sbx, user, h).catch(() => {})
      await sbx.destroy().catch(() => {})
    }
  }

  return { session: async (user: string, r: SessionOptions): Promise<Session> => (await open(user, r)).s, run, listModels }
}

/** Ends every process that runs in the job's folder: the harness and what it started. */
const stopJob = (work: string) => `for d in /proc/[0-9]*; do [ "$(readlink "$d/cwd" 2>/dev/null)" = ${q(work)} ] && kill -KILL "\${d#/proc/}" 2>/dev/null; done; true`

/** Runs the command and turns its output, line by line, into events as they come. When the reader stops early (the
 *  harness gave its end event, or the app stopped the job), it waits for the command to exit: after an end event up to
 *  EXIT_WAIT_MS, then it ends the job's processes. So no harness of the job runs when the job closes. */
async function* stream(sbx: Sandbox, cmd: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }, reader: EventReader): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = []
  let wake: (() => void) | undefined, done = false, ended = false, buf = ''
  const push = (evs: AgentEvent[]) => { if (evs.length) { queue.push(...evs); wake?.(); wake = undefined } }
  const lines = (chunk: string) => {
    buf += chunk
    let k
    while ((k = buf.indexOf('\n')) >= 0) { push(reader.line(buf.slice(0, k))); buf = buf.slice(k + 1) }
  }
  const exited = sbx.run(cmd, { ...opts, onStdout: lines })
    .then((res) => { if (buf) push(reader.line(buf)); push(reader.exit(res.exitCode, res.stderr)) },
      (e) => push([{ type: 'error', code: 'sandbox', message: (e as Error).message }, { type: 'end', ok: false }]))
    .finally(() => { done = true; wake?.() })
  const within = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); exited.then(() => { clearTimeout(t); r() }) })
  try {
    for (;;) {
      if (queue.length) {
        const ev = queue.shift()!
        if (ev.type === 'end') ended = true
        yield ev
        continue
      }
      if (done) return
      await new Promise<void>((r) => { wake = r })
    }
  } finally {
    if (!done && ended) await within(EXIT_WAIT_MS)
    if (!done) {
      await sbx.run(stopJob(opts.cwd), { timeoutMs: 30_000 }).catch(() => {})
      await within(5_000)
    }
  }
}
