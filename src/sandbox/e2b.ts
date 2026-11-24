// The E2B adapter. A user's sandbox is paused between jobs and resumed for the next one; a sandbox for one job is
// killed after it (R5.4). With cliLogin, the user's AI login lives in an E2B volume that is mounted into the sandbox
// (R1.5). Needs the `e2b` package (a peer dependency).
import { CommandExitError, NotFoundError, Sandbox as E2BSandbox, Template, Volume } from 'e2b'
import { PINS, npmSpec, type Pins } from '../harness/pins.ts'
import { SandboxGoneError, type CreateOptions, type RunOptions, type Sandbox, type SandboxProvider } from './types.ts'

export interface E2BOptions {
  /** Default: the E2B_API_KEY environment variable. */
  apiKey?: string
  /** The template each sandbox starts from. Default `byoa`; build it with `buildE2BTemplate`. Any template with
   *  Node 20 or later works: byoa installs the pinned harness in a sandbox whose template does not have it (R5.1). */
  template?: string
  /** Default 30 minutes: the most one job may take. */
  timeoutMs?: number
}

const HOME = '/home/user'
/** Ends every process of the sandbox's user but this shell. */
const STOP_ALL = 'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] || { [ -O "$d" ] && kill -KILL "$p" 2>/dev/null; }; done; true'

export function e2b(opts: E2BOptions = {}): SandboxProvider {
  const conn = { ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) }
  const template = opts.template ?? 'byoa'

  const wrap = (s: E2BSandbox): Sandbox => ({
    id: s.sandboxId,
    home: HOME,
    async run(cmd: string, o: RunOptions = {}) {
      const base = { cwd: o.cwd, envs: o.env, onStdout: o.onStdout, onStderr: o.onStderr, timeoutMs: o.timeoutMs ?? 0 }
      if (o.background) {
        await s.commands.run(cmd, { ...base, background: true })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      try {
        const r = await s.commands.run(cmd, base)
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      } catch (e) {
        if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr }
        throw e
      }
    },
    async writeFile(path, data) {
      await s.files.write(path, typeof data === 'string' ? data : data.slice().buffer)
    },
    async pause() {
      // only the files: the next job reboots the sandbox, as on Daytona. A team that cannot take a snapshot with no
      // memory gets a full one.
      try { await s.pause({ mode: 'filesystem' }) } catch {
        // a full snapshot keeps the processes: end them first, so no harness of this job runs in the next one
        await s.commands.run(STOP_ALL)
        await s.pause()
      }
    },
    async destroy() {
      await s.kill()
    },
  })

  /** The volume, created if it does not exist yet. Two jobs may create it at once: the loser finds the winner's. */
  async function volume(name: string) {
    const find = async () => (await Volume.list(conn)).find((v) => v.name === name)
    if (await find()) return name
    try { await Volume.create(name, conn) } catch (e) { if (!(await find())) throw e }
    return name
  }

  return {
    name: 'e2b',
    async create(c: CreateOptions = {}) {
      const volumeMounts: Record<string, string> = {}
      for (const v of c.volumes ?? []) volumeMounts[`${HOME}/${v.path}`] = await volume(v.name)
      const s = await E2BSandbox.create(template, {
        ...conn,
        metadata: c.labels,
        timeoutMs: c.timeoutMs ?? opts.timeoutMs ?? 30 * 60_000,
        // a kept sandbox that times out (a crash, a lost network) is paused, not killed
        ...(c.keep ? { lifecycle: { onTimeout: 'pause' as const, autoResume: false } } : {}),
        ...(Object.keys(volumeMounts).length ? { volumeMounts } : {}),
      })
      return wrap(s)
    },
    async resume(id, r = {}) {
      try {
        const paused = (await E2BSandbox.getInfo(id, conn)).state === 'paused'
        const s = await E2BSandbox.connect(id, { ...conn, ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}) })
        // a sandbox that paused itself at its timeout (the backend died during a job) kept its processes in memory
        if (paused) await s.commands.run(STOP_ALL)
        return wrap(s)
      } catch (e) {
        if (e instanceof NotFoundError) throw new SandboxGoneError(`byoa e2b: the sandbox ${id} is gone`)
        throw e
      }
    },
    async destroy(id) {
      await E2BSandbox.kill(id, conn)
    },
    async deleteVolume(name) {
      const v = (await Volume.list(conn)).find((x) => x.name === name)
      if (v) await Volume.destroy(v.volumeId, conn)
    },
    /** E2B ends the sandbox `ms` from now; a shorter time than before counts too. */
    async keepAlive(id, ms) {
      try { await E2BSandbox.setTimeout(id, ms, conn) } catch (e) {
        if (e instanceof NotFoundError) throw new SandboxGoneError(`byoa e2b: the sandbox ${id} is gone`)
        throw e
      }
    },
  }
}

/** The E2B template: Node, util-linux (`script`, for the sign-in's terminal), and the pinned, unmodified harnesses
 *  from npm. Build it once per pin change with `buildE2BTemplate()`; a sandbox from an older template still gets the
 *  new pin, installed when its job starts (R5.2), only more slowly. */
export function e2bTemplate(pins: Pins = PINS) {
  return Template()
    .fromNodeImage('22')
    .aptInstall(['bsdutils', 'ca-certificates'])
    .runCmd(`npm install -g ${npmSpec('claude', pins)} ${npmSpec('codex', pins)}`, { user: 'root' })
    .runCmd('mkdir -p /home/user/work /home/user/.byoa')
}

export async function buildE2BTemplate(name = 'byoa', opts: { apiKey?: string; pins?: Pins } = {}) {
  return Template.build(e2bTemplate(opts.pins), name, { ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) })
}
