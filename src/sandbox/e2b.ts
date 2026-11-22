// The E2B adapter. A sandbox is created for each job and destroyed after it (R5.4); the user's AI login lives in an
// E2B volume that is mounted into each of their sandboxes (R1.4). Needs the `e2b` package (a peer dependency).
import { CommandExitError, Sandbox as E2BSandbox, Template, Volume } from 'e2b'
import { PINS, npmSpec, type Pins } from '../harness/pins.ts'
import type { CreateOptions, RunOptions, Sandbox, SandboxProvider } from './types.ts'

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
        ...(Object.keys(volumeMounts).length ? { volumeMounts } : {}),
      })
      return wrap(s)
    },
    async resume(id) {
      return wrap(await E2BSandbox.connect(id, conn))
    },
    async deleteVolume(name) {
      const v = (await Volume.list(conn)).find((x) => x.name === name)
      if (v) await Volume.destroy(v.volumeId, conn)
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
