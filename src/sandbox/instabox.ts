// The Instabox adapter. A user's sandbox is stopped between jobs and started for the next one; a sandbox for one job
// is deleted after it, and Instabox deletes it at the latest when its time is up (R5.4). It uses Instabox's HTTP API
// (https://instabox.sh/docs/api-reference/introduction) with the global fetch, so it needs no package. The SDK
// (`@insforge/instabox-sdk`) cannot leave a streamed command out of the sandbox's history, and Instabox keeps each
// command's output in that history at its control plane. byoa reads the user's login files (R1.4) with the file API
// (readFile), never on a command's stdout.
// Instabox has no volumes, so `cliLogin` (R1.5) does not work here; the default `storedLogin` does.
import { randomUUID } from 'node:crypto'
import { q } from '../sh.ts'
import { sleep } from '../time.ts'
import { SandboxGoneError, type CreateOptions, type RunOptions, type RunResult, type Sandbox, type SandboxProvider } from './types.ts'

export interface InstaboxOptions {
  /** Default: the INSTABOX_API_KEY environment variable. The key needs the scopes `machines:write` and
   *  `machines:delete`. */
  apiKey?: string
  /** Default: the INSTABOX_API_URL environment variable, else https://api.instabox.sh. */
  apiUrl?: string
  /** The template each sandbox starts from. Default `agent-browser`, which has Node 22 (the free plan creates from
   *  `agent-browser`, `android` and `ci` only). byoa installs the pinned harness when it is not there (R5.1). */
  template?: string
  /** A snapshot of yours (`sn_...`) to start from instead of a template, such as one with the pinned harness. */
  snapshot?: string
  /** Default 30 minutes: the most one job may take. A sandbox for one job is deleted after this long. */
  timeoutMs?: number
}

/** The home folder of the sandbox user (`user`) of Instabox's Linux templates, on the sandbox's persistent disk. */
const HOME = '/data/home'
/** The most one exec may run at Instabox. A longer command runs detached and is followed by one exec after another. */
const EXEC_S = 600

interface Machine { id: string; state: string }
interface Operation { id: string; state: string; machineId?: string; error?: { code?: string; message?: string } }
interface Exit { exitCode: number; timedOut?: boolean; signal?: string }

class InstaboxError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs?: number
  constructor(status: number, code: string, message: string, retryAfterMs?: number) { super(message); this.status = status; this.code = code; this.retryAfterMs = retryAfterMs }
}

export function instabox(opts: InstaboxOptions = {}): SandboxProvider {
  const apiKey = () => {
    const k = opts.apiKey ?? process.env.INSTABOX_API_KEY
    if (!k) throw new Error('byoa instabox: set INSTABOX_API_KEY or pass apiKey')
    return k
  }
  const base = (opts.apiUrl ?? process.env.INSTABOX_API_URL ?? 'https://api.instabox.sh').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://')

  async function send(method: string, path: string, o: { body?: unknown; raw?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>; accept?: string; signal?: AbortSignal } = {}) {
    const headers: Record<string, string> = { 'X-API-Key': apiKey(), Accept: o.accept ?? 'application/json', ...o.headers }
    if (o.body !== undefined) headers['Content-Type'] = 'application/json'
    if (o.raw) headers['Content-Type'] = 'application/octet-stream'
    const res = await fetch(base + path, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)), signal: o.signal ?? AbortSignal.timeout(60_000) })
    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } }
      const after = Number(res.headers.get('retry-after'))
      throw new InstaboxError(res.status, e.error?.code ?? '', `byoa instabox: ${method} ${path.split('?')[0]}: ${res.status} ${e.error?.message ?? res.statusText}`, after > 0 ? Math.min(after, 60) * 1000 : undefined)
    }
    return res
  }
  const api = async <T>(method: string, path: string, o?: Parameters<typeof send>[2]) => (await (await send(method, path, o)).json()) as T

  /** A lifecycle call (create, start, stop, resume, delete): it needs an idempotency key, so a retry after a lost
   *  answer or a 5xx does the change once. Resolves when its operation succeeded. */
  async function change(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Operation> {
    const key = randomUUID()
    let op!: Operation
    for (let i = 0, end = Date.now() + 3 * 60_000; ; i++) {
      try { op = await api<Operation>(method, path, { body, headers: { 'Idempotency-Key': key, ...headers } }); break } catch (e) {
        // a plan allows few starts a minute (the free plan 3, and a create counts): wait for the next minute
        if (e instanceof InstaboxError && e.status === 429 && Date.now() < end) { await sleep(e.retryAfterMs ?? 15_000); continue }
        if (i >= 3 || (e instanceof InstaboxError && e.status < 500)) throw e
        await sleep(1000 * (i + 1))
      }
    }
    for (const end = Date.now() + 10 * 60_000; op.state !== 'succeeded'; op = await api<Operation>('GET', `/v1/operations/${op.id}?wait=25s`)) {
      if (op.state === 'failed') throw new Error(`byoa instabox: ${method} ${path}: ${op.error?.message ?? op.error?.code ?? 'failed'}`)
      if (Date.now() > end) throw new Error(`byoa instabox: ${method} ${path} did not end in 10 minutes`)
    }
    return op
  }

  /** One exec, its output streamed (server-sent events) and left out of the sandbox's history. */
  async function exec(id: string, body: Record<string, unknown>, out: (c: string) => void, err: (c: string) => void): Promise<Exit | undefined> {
    const res = await send('POST', `/v1/machines/${id}/exec`, {
      body: { ...body, noHistory: true }, accept: 'text/event-stream', signal: AbortSignal.timeout((EXEC_S + 60) * 1000),
    })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = '', event = '', data = ''
    try {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }))
        if (done) return undefined
        buf += value
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '')
          else if (line === '' && data) {
            const d = JSON.parse(data)
            if (event === 'stdout' && d.data) out(d.data)
            else if (event === 'stderr' && d.data) err(d.data)
            else if (event === 'exit') return d as Exit
            else if (event === 'error') throw new InstaboxError(500, d.error?.code ?? '', `byoa instabox: exec: ${d.error?.message ?? data}`)
            event = ''; data = ''
          }
        }
      }
    } finally { reader.cancel().catch(() => {}) }
  }

  const wrap = (id: string): Sandbox => ({
    id,
    home: HOME,
    async run(cmd: string, o: RunOptions = {}): Promise<RunResult> {
      for (const k of Object.keys(o.env ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`byoa instabox: bad environment variable name ${k}`)
      const limit = o.timeoutMs ? `timeout -s KILL ${Math.ceil(o.timeoutMs / 1000)} ` : ''
      const job = `cd ${q(o.cwd ?? HOME)} && ${limit}bash -c ${q(cmd)}`
      // Instabox passes `envs` as exported variables, not in any command line, and the detached command inherits them
      const env = o.env && Object.keys(o.env).length ? { envs: o.env } : {}
      if (o.background) {
        const r = await exec(id, { cmd: `setsid -f bash -c ${q(job)} </dev/null >/dev/null 2>&1`, timeoutSeconds: 60, ...env }, () => {}, () => {})
        if (r?.exitCode !== 0) throw new Error('byoa instabox: the sandbox did not start the command')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      // An exec may run 10 minutes at most, and a job takes longer. So the command runs detached, with its stdout,
      // stderr and exit code in files, and an exec follows the files; when Instabox ends it at 10 minutes, the next
      // one goes on from the bytes that came.
      const d = `/tmp/byoa-run-${randomUUID()}`
      // `kill -USR2 $$`: the files are gone (the sandbox restarted), or the command did not start. Instabox reports
      // the signal, so no exit code of the command is taken for it.
      const follow = (o1: number, o2: number) => `d=${q(d)}; o=${o1}; e=${o2}; f=
while :; do
  [ -e "$d/code" ] && f=1
  n=$(stat -c %s "$d/out") || kill -USR2 $$; [ "$n" -gt "$o" ] && { tail -c +$((o + 1)) "$d/out" | head -c $((n - o)); o=$n; }
  n=$(stat -c %s "$d/err") || kill -USR2 $$; [ "$n" -gt "$e" ] && { tail -c +$((e + 1)) "$d/err" | head -c $((n - e)) >&2; e=$n; }
  [ -n "$f" ] && { c=$(cat "$d/code"); rm -rf "$d"; exit "$c"; }
  sleep 0.05
done`
      const detached = `(${job}) </dev/null >${q(`${d}/out`)} 2>${q(`${d}/err`)}; echo $? > ${q(`${d}/c`)} && mv ${q(`${d}/c`)} ${q(`${d}/code`)}`
      const start = `{ mkdir -m 700 ${q(d)} && : > ${q(`${d}/out`)} && : > ${q(`${d}/err`)} && setsid -f bash -c ${q(detached)} </dev/null >/dev/null 2>&1; } || kill -USR2 $$\n`
      let stdout = '', stderr = '', outBytes = 0, errBytes = 0, failed = 0
      for (let i = 0; ; i++) {
        let r: Exit | undefined
        try {
          r = await exec(id, { cmd: (i === 0 ? start : '') + follow(outBytes, errBytes), timeoutSeconds: EXEC_S, ...env },
            (c) => { stdout += c; outBytes += Buffer.byteLength(c); o.onStdout?.(c) },
            (c) => { stderr += c; errBytes += Buffer.byteLength(c); o.onStderr?.(c) })
        } catch (e) {
          // a refusal (the sandbox is not running, a bad request) does not go away; a lost connection or a 5xx may
          if ((e instanceof InstaboxError && e.status < 500) || ++failed > 5) throw e
          await sleep(1000 * failed)
          continue
        }
        if (r?.signal === 'USR2') throw new Error('byoa instabox: the command did not start, or its output is gone (the sandbox restarted)')
        // the follower ended by itself: its exit code is the command's
        if (r && !r.timedOut && !r.signal) return { exitCode: r.exitCode, stdout, stderr }
        // Instabox ended the follower at its limit, or the stream ended early: follow on from the bytes that came
        failed = 0
        if (i === 1000) throw new Error('byoa instabox: the command did not end')
      }
    },
    async writeFile(path, data) {
      // the bytes are the request's body: one upload, as the sandbox user, atomic, with its parent folders
      await send('PUT', `/v1/machines/${id}/files?path=${encodeURIComponent(path)}&parents=true`, {
        raw: typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data), signal: AbortSignal.timeout(10 * 60_000),
      })
    },
    async readFile(path) {
      // the file's raw bytes (GET /v1/machines/{id}/files/content); 404 when it is not there
      try {
        const r = await send('GET', `/v1/machines/${id}/files/content?path=${encodeURIComponent(path)}`, { accept: 'application/octet-stream', signal: AbortSignal.timeout(10 * 60_000) })
        return new Uint8Array(await r.arrayBuffer())
      } catch (e) {
        if (e instanceof InstaboxError && e.status === 404) return null
        throw e
      }
    },
    async pause() {
      // a stop, not Instabox's pause: no process and no memory of this job is kept for the next one
      await change('POST', `/v1/machines/${id}/stop`)
    },
    async destroy() { await destroy(id) },
  })

  const get = async (id: string) => {
    try { return await api<Machine>('GET', `/v1/machines/${id}`) } catch (e) {
      if (e instanceof InstaboxError && e.status === 404) throw new SandboxGoneError(`byoa instabox: the sandbox ${id} is gone`)
      throw e
    }
  }

  async function destroy(id: string) {
    for (let i = 0; ; i++) {
      try { await change('DELETE', `/v1/machines/${id}`, undefined, { 'X-Confirm-Delete': id }); return } catch (e) {
        if (e instanceof InstaboxError && e.status === 404) return
        // another change of the sandbox is running: it ends soon
        if (!(e instanceof InstaboxError && e.code === 'operation_conflict') || i === 30) throw e
        await sleep(2000)
      }
    }
  }

  return {
    name: 'instabox',
    capabilities: { volumes: false },
    async create(c: CreateOptions = {}) {
      if (c.volumes?.length) throw new Error('byoa instabox: Instabox has no volumes; use storedLogin, not cliLogin')
      const seconds = Math.ceil((c.timeoutMs ?? opts.timeoutMs ?? 30 * 60_000) / 1000)
      const op = await change('POST', '/v1/machines', {
        ...(opts.snapshot ? { snapshotId: opts.snapshot } : { templateId: opts.template ?? 'agent-browser' }),
        // the sandbox is the app's user's: none of the account's Vault items or org Secrets go into it
        vault: false, secrets: [],
        ...(c.labels ? { metadata: c.labels } : {}),
        // Instabox has no lifetime timeout. A sandbox for one job is deleted after its time, whatever its state, so it
        // cannot outlive a backend that died. A kept one pauses itself when it is idle (30 minutes by default), and
        // `resume` then ends its processes.
        ...(c.keep ? {} : { deleteAfterSeconds: Math.min(Math.max(seconds, 60), 86_400) }),
      })
      return wrap(op.machineId!)
    },
    async resume(id) {
      for (const end = Date.now() + 120_000; ; await sleep(1000)) {
        const m = await get(id)
        if (m.state === 'running') return wrap(id)
        if (m.state === 'stopped') { await change('POST', `/v1/machines/${id}/start`); return wrap(id) }
        if (m.state === 'suspended') {
          // it paused itself (idle, or its longest run on the plan), with the processes of a job: boot it again
          await change('POST', `/v1/machines/${id}/resume`)
          await change('POST', `/v1/machines/${id}/stop`)
          await change('POST', `/v1/machines/${id}/start`)
          return wrap(id)
        }
        if (m.state === 'deleting' || m.state === 'deleted' || m.state === 'error') {
          if (m.state === 'error') await destroy(id).catch(() => {})
          throw new SandboxGoneError(`byoa instabox: the sandbox ${id} is ${m.state}`)
        }
        // creating, starting, stopping, suspending, resuming: wait for it to settle
        if (Date.now() > end) throw new Error(`byoa instabox: the sandbox ${id} is still ${m.state}`)
      }
    },
    destroy,
    // no keepAlive: Instabox sets a sandbox's delete time (deleteAfterSeconds) only when it creates it
    /** Instabox has no volumes, so there is none to delete. */
    async deleteVolume() {},
  }
}
