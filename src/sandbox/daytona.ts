// The Daytona adapter. A sandbox is created for each job and destroyed after it (R5.4). Daytona allows few volumes
// per organization, so the user's AI login (R1.4) is a subpath of one shared volume: each login is its own subpath,
// and a sandbox sees only the subpaths it mounts. Uses Daytona v0, Daytona's current platform, through the
// `@daytona/sdk` package (a peer dependency).
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Daytona, DaytonaNotFoundError, type DaytonaV0Client } from '@daytona/sdk'
import type { Sandbox as DaytonaSandbox, VolumeMount } from '@daytona/sdk/v0'
import { q } from '../sh.ts'
import type { CreateOptions, RunOptions, RunResult, Sandbox, SandboxProvider, Volume } from './types.ts'

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
      const command = `cd ${q(o.cwd ?? HOME)} && ${env}${limit}bash -c ${q(cmd)} < /dev/null`
      const session = `byoa-${randomUUID()}`
      await s.process.createSession(session)
      const { cmdId } = await s.process.executeSessionCommand(session, { command, runAsync: true })
      if (!cmdId) throw new Error('byoa daytona: the sandbox did not start the command')
      if (o.background) return { exitCode: 0, stdout: '', stderr: '' }
      try {
        let stdout = '', stderr = ''
        await s.process.getSessionCommandLogs(session, cmdId,
          (c) => { stdout += c; o.onStdout?.(c) },
          (c) => { stderr += c; o.onStderr?.(c) })
        // the log stream can end just before the command's exit code is recorded
        for (let i = 0; ; i++) {
          const { exitCode } = await s.process.getSessionCommand(session, cmdId)
          if (typeof exitCode === 'number') return { exitCode, stdout, stderr }
          if (i === 100) throw new Error('byoa daytona: the command ended with no exit code')
          await sleep(100)
        }
      } finally {
        await s.process.deleteSession(session).catch(() => {})
      }
    },
    async writeFile(path, data) {
      await s.fs.createFolder(posix.dirname(path), '755')
      await s.fs.uploadFile(Buffer.from(data), path)
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
      // Daytona deletes the sandbox when it stops, and stops it after this long, even if byoa cannot (a crash, a
      // lost network)
      ephemeral: true,
      ttlMinutes: minutes,
      autoStopInterval: minutes,
    })
    return wrap(s)
  }

  return {
    name: 'daytona',
    create: (c) => create(c),
    async resume(id) {
      const s = await d().get(id)
      if (s.state !== 'started') throw new Error(`byoa daytona: the sandbox ${id} is ${s.state}`)
      return wrap(s)
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
