// The Daytona adapter. A user's sandbox is stopped between jobs and started for the next one; a sandbox for one job
// is ephemeral, deleted when it stops (R5.4). Daytona allows few volumes
// per organization, so the user's AI login (R1.4) is a subpath of one shared volume: each login is its own subpath,
// and a sandbox sees only the subpaths it mounts. Uses Daytona v0, Daytona's current platform, through the
// `@daytona/sdk` package (a peer dependency).
import { randomUUID } from 'node:crypto'
import { Daytona, DaytonaNotFoundError, type DaytonaV0Client } from '@daytona/sdk'
import type { Sandbox as DaytonaSandbox, VolumeMount } from '@daytona/sdk/v0'
import { q } from '../sh.ts'
import { SandboxGoneError, type CreateOptions, type RunOptions, type RunResult, type Sandbox, type SandboxProvider, type Volume } from './types.ts'

export interface DaytonaOptions {
  /** Default: the DAYTONA_API_KEY environment variable. */
  apiKey?: string
  /** A Daytona v0 client to use instead (`new Daytona(config).v0`), such as one with a JWT. */
  client?: DaytonaV0Client
  /** The snapshot each sandbox starts from. Default: Daytona's default snapshot. Any snapshot whose user is
   *  `daytona` and that has Node 20 or later works: byoa installs the pinned harness when it is not there (R5.1). */
  snapshot?: string
  /** The one Daytona volume that holds every login, each in its own subpath. Default `byoa`. */
  volume?: string
  /** Default 30 minutes: the most one job may take. */
  timeoutMs?: number
}

/** The home folder of the `daytona` user of Daytona's snapshots. */
const HOME = '/home/daytona'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Daytona's command logs are lines: it ends a last line that has no newline with one. So each command prints this
 *  marker, with its exit code, after its output, on stdout and on stderr, and what comes after it is Daytona's. */
const END = /\x1ebyoa-end:(\d+)\x1e/
const END_START = '\x1ebyoa-end:'

/** Passes a stream's chunks on up to the end marker, and keeps the exit code in it. It holds back only a tail that
 *  could be the start of a marker. */
function untilEnd(out: (c: string) => void) {
  let held = ''
  const u = {
    code: undefined as number | undefined,
    push(c: string) {
      if (u.code !== undefined) return
      held += c
      const m = END.exec(held)
      if (m) { u.code = Number(m[1]); if (m.index) out(held.slice(0, m.index)); held = ''; return }
      const k = held.lastIndexOf('\x1e'), tail = k < 0 ? '' : held.slice(k)
      const start = tail !== '' && (tail.length <= END_START.length ? END_START.startsWith(tail) : tail.startsWith(END_START) && /^\d*$/.test(tail.slice(END_START.length)))
      const keep = start ? tail.length : 0
      if (held.length > keep) out(held.slice(0, held.length - keep))
      held = held.slice(held.length - keep)
    },
    /** The command printed no marker (it was killed with its shell): keep all of it. */
    end() { if (u.code === undefined && held) out(held); held = '' },
  }
  return u
}

export function daytona(opts: DaytonaOptions = {}): SandboxProvider {
  let client = opts.client
  const d = () => (client ??= new Daytona(opts.apiKey ? { apiKey: opts.apiKey } : {}).v0)
  const volumeName = opts.volume ?? 'byoa'
  let volumeId: string | undefined

  const wrap = (s: DaytonaSandbox): Sandbox => ({
    id: s.id,
    home: HOME,
    async run(cmd: string, o: RunOptions = {}): Promise<RunResult> {
      // A session command has no env or cwd of its own. The variables are assignments in the session's shell, so
      // they are not in any process's command line.
      const env = Object.entries(o.env ?? {}).map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`byoa daytona: bad environment variable name ${k}`)
        return `${k}=${q(v)} `
      }).join('')
      const limit = o.timeoutMs ? `timeout -s KILL ${Math.ceil(o.timeoutMs / 1000)} ` : ''
      const command = `(cd ${q(o.cwd ?? HOME)} && ${env}${limit}bash -c ${q(cmd)} < /dev/null); e=$?; printf '\\036byoa-end:%d\\036' $e; printf '\\036byoa-end:%d\\036' $e >&2; (exit $e)`
      const session = `byoa-${randomUUID()}`
      await s.process.createSession(session)
      if (o.background) {
        const { cmdId } = await s.process.executeSessionCommand(session, { command, runAsync: true })
        if (!cmdId) throw new Error('byoa daytona: the sandbox did not start the command')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      let stdout = '', stderr = ''
      const out = untilEnd((c) => { stdout += c; o.onStdout?.(c) })
      const err = untilEnd((c) => { stderr += c; o.onStderr?.(c) })
      try {
        if (!o.onStdout && !o.onStderr) {
          // nothing to stream: one request, which answers when the command ends
          const r = await s.process.executeSessionCommand(session, { command, runAsync: false }, o.timeoutMs ? Math.ceil(o.timeoutMs / 1000) + 60 : undefined)
          out.push(r.stdout ?? ''); err.push(r.stderr ?? ''); out.end(); err.end()
          const exitCode = out.code ?? r.exitCode
          if (typeof exitCode !== 'number') throw new Error('byoa daytona: the command ended with no exit code')
          return { exitCode, stdout, stderr }
        }
        const { cmdId } = await s.process.executeSessionCommand(session, { command, runAsync: true })
        if (!cmdId) throw new Error('byoa daytona: the sandbox did not start the command')
        // Daytona closes the log stream about a second after the command ends, so the command ends at its markers
        let ended!: () => void
        const markers = new Promise<void>((r) => { ended = r })
        const both = () => { if (out.code !== undefined && err.code !== undefined) ended() }
        await Promise.race([markers, s.process.getSessionCommandLogs(session, cmdId, (c) => { out.push(c); both() }, (c) => { err.push(c); both() })])
        if (out.code !== undefined) return { exitCode: out.code, stdout, stderr }
        out.end(); err.end()
        // the log stream can end just before the command's exit code is recorded
        for (let i = 0; ; i++) {
          const { exitCode } = await s.process.getSessionCommand(session, cmdId)
          if (typeof exitCode === 'number') return { exitCode, stdout, stderr }
          if (i === 100) throw new Error('byoa daytona: the command ended with no exit code')
          await sleep(100)
        }
      } finally {
        // the session ran only this command; it goes without the command waiting for it
        s.process.deleteSession(session).catch(() => {})
      }
    },
    async writeFile(path, data) {
      // the upload makes the missing parent folders itself (755, as createFolder did)
      await s.fs.uploadFile(Buffer.from(data), path)
    },
    async pause() {
      await s.stop(60)
    },
    async destroy() {
      await s.delete(60, true)
    },
  })

  /** The shared volume, created if it does not exist yet, once it is ready to mount. Two jobs may create it at
   *  once: the loser finds the winner's. */
  async function sharedVolume(): Promise<string> {
    if (volumeId) return volumeId
    let v
    try { v = await d().volume.get(volumeName, true) } catch (e) { v = await d().volume.get(volumeName).catch(() => { throw e }) }
    for (const end = Date.now() + 120_000; v.state !== 'ready'; v = await d().volume.get(volumeName)) {
      if (v.state === 'error' || Date.now() > end) throw new Error(`byoa daytona: the volume ${volumeName} is ${v.state}`)
      await sleep(1000)
    }
    return (volumeId = v.id)
  }

  const mounts = async (volumes: Volume[], at: (v: Volume) => string): Promise<VolumeMount[]> => {
    if (!volumes.length) return []
    const id = await sharedVolume()
    return volumes.map((v) => ({ volumeId: id, mountPath: at(v), subpath: v.name }))
  }

  async function create(c: CreateOptions & { mountAt?: (v: Volume) => string } = {}) {
    const minutes = Math.ceil((c.timeoutMs ?? opts.timeoutMs ?? 30 * 60_000) / 60_000)
    const s = await d().create({
      ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
      labels: c.labels,
      volumes: await mounts(c.volumes ?? [], c.mountAt ?? ((v) => `${HOME}/${v.path}`)),
      // Daytona stops the sandbox after this long with no activity, even if byoa cannot (a crash, a lost network). A
      // sandbox for one job is ephemeral: Daytona deletes it when it stops, and at the latest after this long. A kept
      // one stays stopped, with its files, until the next job starts it (Daytona archives it after 7 days stopped).
      ...(c.keep ? { ephemeral: false, ttlMinutes: 0 } : { ephemeral: true, ttlMinutes: minutes }),
      autoStopInterval: minutes,
    })
    return wrap(s)
  }

  const get = async (id: string) => {
    try { return await d().get(id) } catch (e) {
      if (e instanceof DaytonaNotFoundError) throw new SandboxGoneError(`byoa daytona: the sandbox ${id} is gone`)
      throw e
    }
  }

  return {
    name: 'daytona',
    create: (c) => create(c),
    async resume(id) {
      const s = await get(id)
      for (const end = Date.now() + 120_000; ; await sleep(1000), await s.refreshData()) {
        if (s.state === 'started') return wrap(s)
        if (s.state === 'stopped' || s.state === 'archived' || s.state === 'paused') { await s.start(120); return wrap(s) }
        if (s.state === 'error' && s.recoverable) { await s.recover(120); return wrap(s) }
        if (s.state === 'destroyed' || s.state === 'destroying' || s.state === 'error' || s.state === 'build_failed') {
          if (s.state === 'error' || s.state === 'build_failed') await s.delete(60).catch(() => {})
          throw new SandboxGoneError(`byoa daytona: the sandbox ${id} is ${s.state}`)
        }
        // starting, stopping, archiving, pausing, ...: wait for it to settle
        if (Date.now() > end) throw new Error(`byoa daytona: the sandbox ${id} is still ${s.state}`)
      }
    },
    async destroy(id) {
      try { await (await get(id)).delete(60, true) } catch (e) { if (!(e instanceof SandboxGoneError) && !(e instanceof DaytonaNotFoundError)) throw e }
    },
    /** Deletes the login's subpath: a short sandbox mounts it and deletes its files. */
    async deleteVolume(name) {
      try { await d().volume.get(volumeName) } catch (e) { if (e instanceof DaytonaNotFoundError) return; throw e }
      const s = await create({ volumes: [{ name, path: '' }], mountAt: () => `${HOME}/delete`, timeoutMs: 5 * 60_000 })
      try {
        const r = await s.run(`find ${q(`${HOME}/delete`)} -mindepth 1 -delete`)
        if (r.exitCode !== 0) throw new Error(`byoa daytona: could not delete the files of ${name}: ${r.stderr.trim()}`)
      } finally { await s.destroy() }
    },
  }
}
