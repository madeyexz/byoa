// The Sprites adapter (Fly.io, https://docs.fly.io/sprites). A Sprite is a Linux VM with a disk that stays: it runs
// while something uses it, and sleeps by itself about 30 s after that (warm: its processes frozen; later cold: its
// processes gone, its disk kept). It uses the Sprites HTTP and WebSocket API with the global fetch and WebSocket, so it
// needs no package (the `@fly/sprites` SDK needs Node 24).
//
// Sprites has no pause call and no time limit, so this adapter makes both, inside the Sprite, with the Tasks API
// (`/.sprite/api.sock`), which holds a Sprite awake: each sandbox is held until its time (`timeoutMs`, `setTimeout`,
// `keepAlive`), so the login's watcher (R1.4) runs before the Sprite sleeps, also when the backend died. At its time, a
// kept sandbox lets go and sleeps; one that is not kept ends: it stops its processes and deletes its home folder, and
// the next `create` deletes it at Sprites (a Sprite cannot delete itself). `pause` stops the job's processes and lets
// go. Sprites has no volumes, so `cliLogin` (R1.5) does not work here; the default `storedLogin` does.
//
// Each command runs with no Linux capabilities: a Sprite's user has some (such as CAP_SYS_ADMIN) as ambient
// capabilities, and Codex's own sandbox (bubblewrap), which `access: 'read-only'` needs (R5.6), refuses to run with them.
import { randomBytes } from 'node:crypto'
import { q } from '../sh.ts'
import { sleep } from '../time.ts'
import { SandboxGoneError, type CreateOptions, type RunOptions, type RunResult, type Sandbox, type SandboxProvider } from './types.ts'

export interface SpritesOptions {
  /** Default: the SPRITES_TOKEN environment variable (a token of your Fly.io organization). */
  token?: string
  /** Default: the SPRITES_API_URL environment variable, else https://api.sprites.dev. */
  apiUrl?: string
  /** A shell command that runs once in each new Sprite, before byoa uses it, as its user (who may use sudo). Sprites
   *  has no templates, so this is where an app adds what its jobs need, such as a clone of a repository. Each Sprite
   *  already has Node; byoa installs the pinned harness itself (R5.1). */
  init?: string
  /** Default 30 minutes: the most one job may take. */
  timeoutMs?: number
}

/** The home folder of the `sprite` user. */
const HOME = '/home/sprite'
/** byoa's Sprites are named `byoa-` and 20 hex characters: the name is the sandbox's id. */
const PREFIX = 'byoa-'
/** The label with the time (unix seconds) at which a Sprite that is not kept ends. */
const END = 'byoa-end='
/** A Task holds a Sprite for at most an hour; a longer time is held by a loop in the Sprite that renews it. Each Task
 *  lasts a minute more than the time, so the Sprite does not sleep while the loop ends it; the loop then deletes it. */
const TASK_MAX_S = 3600
const MARGIN_S = 60

/** Ends every process of the Sprite's user but this shell and the Sprite's own init (`tini` and its `tail`). */
const STOP_ALL = `for d in /proc/[0-9]*; do p=\${d#/proc/}; case "$p" in 1|$$) continue;; esac; [ -O "$d" ] || continue; [ "$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)" = 'tail -f /dev/null ' ] && continue; kill -KILL "$p" 2>/dev/null; done; true`
const TASKS = `curl -sf --unix-socket /.sprite/api.sock -H 'Content-Type: application/json'`
/** The loop that holds the Sprite until the time in ~/.byoa/hold (`<unix seconds> <kept: 1 or 0>`), one at a time.
 *  At the time, it lets go; for a Sprite that is not kept, it first stops every process and deletes the home folder. */
const HOLDER = `exec 9>>"$HOME/.byoa/hold.lock"; flock -n 9 || exit 0
while :; do
  read -r end keep < "$HOME/.byoa/hold" || { end=0; keep=1; }
  left=$(( end - $(date +%s) ))
  if [ "$left" -le 0 ]; then
    if [ "$keep" = 0 ]; then ${STOP_ALL}; cd / && find "$HOME" -mindepth 1 -delete; fi
    ${TASKS} -X DELETE http://sprite/v1/tasks/byoa >/dev/null; exit 0
  fi
  ${TASKS} -X PUT http://sprite/v1/tasks/byoa -d "{\\"expire\\": $(( left + ${MARGIN_S} < ${TASK_MAX_S} ? left + ${MARGIN_S} : ${TASK_MAX_S} ))}" >/dev/null
  sleep $(( left < 300 ? left : 300 ))
done`

interface SpriteInfo { name: string; status: string; labels?: string[] }

class SpritesError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export function sprites(opts: SpritesOptions = {}): SandboxProvider {
  const token = () => {
    const t = opts.token ?? process.env.SPRITES_TOKEN
    if (!t) throw new Error('byoa sprites: set SPRITES_TOKEN or pass token')
    return t
  }
  const base = (opts.apiUrl ?? process.env.SPRITES_API_URL ?? 'https://api.sprites.dev').replace(/\/+$/, '')
  const defaultMs = opts.timeoutMs ?? 30 * 60_000

  async function send(method: string, path: string, o: { body?: unknown; raw?: Uint8Array<ArrayBuffer>; timeoutMs?: number } = {}): Promise<Response> {
    for (let i = 0; ; i++) {
      let res: Response | undefined, err: unknown
      try {
        res = await fetch(base + path, {
          method,
          headers: { Authorization: `Bearer ${token()}`, ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(o.raw ? { 'Content-Type': 'application/octet-stream' } : {}) },
          body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
          signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
        })
      } catch (e) { err = e }
      // a lost connection or a 5xx may go away; each call here may be sent again (a create has its own name)
      if (res && (res.ok || res.status < 500)) {
        if (res.ok) return res
        throw new SpritesError(res.status, `byoa sprites: ${method} ${path.split('?')[0]}: ${res.status} ${(await res.text().catch(() => '')).trim().slice(0, 300)}`)
      }
      if (i >= 3) throw err ?? new SpritesError(res!.status, `byoa sprites: ${method} ${path.split('?')[0]}: ${res!.status}`)
      await sleep(1000 * (i + 1))
    }
  }
  const api = async <T>(method: string, path: string, o?: Parameters<typeof send>[2]) => (await (await send(method, path, o)).json()) as T
  const at = (id: string) => `/v1/sprites/${encodeURIComponent(id)}`

  /** One command over the exec WebSocket: stdout and stderr as they come, then the exit code. */
  function exec(id: string, script: string, o: RunOptions): Promise<RunResult> {
    const url = new URL(`${base.replace(/^http/, 'ws')}${at(id)}/exec`)
    // the command starts only when the socket is open and sends it a byte: Sprites keeps only about the last 64 KB of
    // output from before a client attaches, so a fast command's first bytes were lost. Then its stdin ends.
    for (const a of ['bash', '-c', `head -c 1 >/dev/null; ${script}`]) url.searchParams.append('cmd', a)
    url.searchParams.set('path', 'bash')
    url.searchParams.set('stdin', 'true')
    for (const [k, v] of Object.entries(o.env ?? {})) url.searchParams.append('env', `${k}=${v}`)
    return new Promise((resolve, reject) => {
      // Node's WebSocket (undici) takes headers in its second argument
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token()}` } } as unknown as string[])
      ws.binaryType = 'arraybuffer'
      ws.addEventListener('open', () => { ws.send(new Uint8Array([0, 10])); ws.send(new Uint8Array([4])) })
      const dec = [new TextDecoder(), new TextDecoder()]
      let stdout = '', stderr = '', done = false
      const out = (c: string) => { if (c) { stdout += c; o.onStdout?.(c) } }
      const err = (c: string) => { if (c) { stderr += c; o.onStderr?.(c) } }
      const end = (exitCode: number) => {
        if (done) return
        done = true
        clearTimeout(guard)
        out(dec[0]!.decode()); err(dec[1]!.decode())
        resolve({ exitCode, stdout, stderr })
        ws.close()
      }
      // `timeout -s KILL` ends the command at its time; this ends the wait if the Sprite does not answer after it
      const guard = o.timeoutMs ? setTimeout(() => end(137), o.timeoutMs + 60_000) : undefined
      ws.addEventListener('message', (e: MessageEvent) => {
        if (typeof e.data === 'string') {
          let m: { type?: string; exit_code?: number; error?: string } | undefined
          try { m = JSON.parse(e.data) } catch {}
          if (m?.type === 'exit') end(Number(m.exit_code))
          else if (m?.type === 'error' && !done) { done = true; clearTimeout(guard); reject(new Error(`byoa sprites: ${m.error ?? 'the command failed'} (Sprite ${id})`)); ws.close() }
          return
        }
        const d = new Uint8Array(e.data as ArrayBuffer)
        if (d[0] === 1) out(dec[0]!.decode(d.subarray(1), { stream: true }))
        else if (d[0] === 2) err(dec[1]!.decode(d.subarray(1), { stream: true }))
        else if (d[0] === 3) end(d[1] ?? 0)
      })
      ws.addEventListener('error', () => { if (!done) { done = true; clearTimeout(guard); reject(new Error(`byoa sprites: the command's connection to the Sprite ${id} failed`)) } })
      ws.addEventListener('close', (e: CloseEvent) => {
        if (!done) { done = true; clearTimeout(guard); reject(new Error(`byoa sprites: the connection to the Sprite ${id} closed before the command ended (${e.code})`)) }
      })
    })
  }

  /** Holds the Sprite awake for `ms` from now (a shorter time than before counts too); then it sleeps, or, when it is
   *  not kept, ends. */
  async function hold(id: string, ms: number, kept: boolean) {
    const s = Math.max(1, Math.ceil(ms / 1000))
    const r = await exec(id, `mkdir -p ~/.byoa && echo "$(( $(date +%s) + ${s} )) ${kept ? 1 : 0}" > ~/.byoa/hold.new && mv ~/.byoa/hold.new ~/.byoa/hold \
&& ${TASKS} -X PUT http://sprite/v1/tasks/byoa -d '{"expire": ${Math.min(s + MARGIN_S, TASK_MAX_S)}}' >/dev/null \
&& setsid -f bash -c ${q(HOLDER)} </dev/null >/dev/null 2>&1`, {})
    if (r.exitCode !== 0) throw new Error(`byoa sprites: could not hold the Sprite ${id} awake: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  }

  /** A Sprite that is not kept has its end time in a label, so the next create can delete it. */
  async function setEnd(info: SpriteInfo, ms: number) {
    const labels = [...(info.labels ?? []).filter((l) => !l.startsWith(END)), `${END}${Math.ceil((Date.now() + ms) / 1000)}`]
    await send('PUT', at(info.name), { body: { labels } })
  }
  const endOf = (info: SpriteInfo) => { const l = info.labels?.find((x) => x.startsWith(END)); return l ? Number(l.slice(END.length)) * 1000 : undefined }

  const get = async (id: string) => {
    try { return await api<SpriteInfo>('GET', at(id)) } catch (e) {
      if (e instanceof SpritesError && e.status === 404) throw new SandboxGoneError(`byoa sprites: the sandbox ${id} is gone`)
      throw e
    }
  }

  async function destroy(id: string) {
    try { await send('DELETE', at(id)) } catch (e) { if (!(e instanceof SpritesError && e.status === 404)) throw e }
  }

  /** Deletes byoa's Sprites that are not kept and whose time ran out (they already ended themselves), at most once a
   *  minute, so that one whose backend died does not stay. */
  let swept = 0
  async function sweep() {
    if (Date.now() - swept < 60_000) return
    swept = Date.now()
    let token: string | undefined
    do {
      const r = await api<{ sprites?: SpriteInfo[]; has_more?: boolean; next_continuation_token?: string }>('GET', `/v1/sprites?prefix=${PREFIX}&max_results=500${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`)
      for (const s of r.sprites ?? []) { const e = endOf(s); if (e && e < Date.now() - 60_000) await destroy(s.name) }
      token = r.has_more ? r.next_continuation_token : undefined
    } while (token)
  }

  const wrap = (id: string, kept: boolean): Sandbox => ({
    id,
    home: HOME,
    async run(cmd: string, o: RunOptions = {}): Promise<RunResult> {
      for (const k of Object.keys(o.env ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`byoa sprites: bad environment variable name ${k}`)
      // --preserve-status: a Sprite's `timeout` (uutils, Ubuntu 26.04) answers 124 for a command it killed, GNU's 137
      const limit = o.timeoutMs ? `timeout --preserve-status -s KILL ${Math.ceil(o.timeoutMs / 1000)} ` : ''
      const job = `cd ${q(o.cwd ?? HOME)} && exec setpriv --inh-caps=-all --ambient-caps=-all -- ${limit}bash -c ${q(cmd)}`
      if (o.background) {
        const r = await exec(id, `setsid -f bash -c ${q(job)} </dev/null >/dev/null 2>&1`, { env: o.env })
        if (r.exitCode !== 0) throw new Error('byoa sprites: the Sprite did not start the command')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return exec(id, job, o)
    },
    async writeFile(path, data) {
      await send('PUT', `${at(id)}/fs/write?path=${encodeURIComponent(path)}&mkdir=true`, {
        raw: typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data), timeoutMs: 10 * 60_000,
      })
    },
    async readFile(path) {
      try {
        return new Uint8Array(await (await send('GET', `${at(id)}/fs/read?path=${encodeURIComponent(path)}`, { timeoutMs: 10 * 60_000 })).arrayBuffer())
      } catch (e) {
        if (e instanceof SpritesError && e.status === 404) return null
        throw e
      }
    },
    async pause() {
      // no process of this job is kept for the next one, and the Sprite sleeps about 30 s after this
      await exec(id, `${STOP_ALL}; rm -f ~/.byoa/hold; ${TASKS} -X DELETE http://sprite/v1/tasks/byoa >/dev/null; true`, {})
    },
    async setTimeout(ms) {
      await hold(id, ms, kept)
      if (!kept) await setEnd(await get(id), ms)
    },
    async destroy() { await destroy(id) },
  })

  return {
    name: 'sprites',
    capabilities: { volumes: false },
    async create(c: CreateOptions = {}) {
      if (c.volumes?.length) throw new Error('byoa sprites: Sprites has no volumes; use storedLogin, not cliLogin')
      await sweep().catch(() => {})
      const ms = c.timeoutMs ?? defaultMs
      const name = PREFIX + randomBytes(10).toString('hex')
      const labels = [...Object.entries(c.labels ?? {}).map(([k, v]) => `${k}=${v}`), ...(c.keep ? [] : [`${END}${Math.ceil((Date.now() + ms) / 1000)}`])]
      try { await send('POST', '/v1/sprites', { body: { name, labels } }) } catch (e) {
        // a create sent again after a lost answer finds the Sprite it made
        if (!(e instanceof SpritesError && e.status === 409)) throw e
      }
      try {
        await hold(name, ms, !!c.keep)
        if (opts.init) {
          const r = await exec(name, `cd ${HOME} && ${opts.init}`, {})
          if (r.exitCode !== 0) throw new Error(`byoa sprites: init failed (${r.exitCode}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
        }
      } catch (e) {
        await destroy(name).catch(() => {})
        throw e
      }
      return wrap(name, !!c.keep)
    },
    async resume(id, r = {}) {
      const info = await get(id)
      const end = endOf(info)
      // a Sprite that is not kept has ended at its time, as at any other provider
      if (end && end <= Date.now()) { await destroy(id); throw new SandboxGoneError(`byoa sprites: the sandbox ${id} ended at its time`) }
      // its time ran out (byoa paused it, or the backend died during a job and it slept by itself): no process of that
      // job runs on. Sprites' `status` can be stale, so the Sprite's own hold time says it.
      await exec(id, `read -r end keep < ~/.byoa/hold 2>/dev/null || end=0; [ \"$end\" -gt \"$(date +%s)\" ] || { ${STOP_ALL}; }`, {})
      const ms = r.timeoutMs ?? defaultMs
      await hold(id, ms, !end)
      if (end) await setEnd(info, ms)
      return wrap(id, !end)
    },
    destroy,
    /** Sprites has no volumes, so there is none to delete. */
    async deleteVolume() {},
    /** The Sprite ends `ms` from now; a shorter time than before counts too. */
    async keepAlive(id, ms) {
      const info = await get(id)
      await hold(id, ms, !endOf(info))
      if (endOf(info)) await setEnd(info, ms)
    },
  }
}
