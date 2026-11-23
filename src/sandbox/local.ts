// A sandbox in a temporary folder on this machine, for tests and development only: it does not isolate anything.
// Each sandbox gets its own home folder; a volume is a folder under `volumes` that a symbolic link puts at its path.
// A paused sandbox keeps its folder, and its processes are stopped.
// With the fake harness, an app can test byoa end to end with no sandbox provider and no AI plan (R7.2).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SandboxGoneError, type CreateOptions, type RunOptions, type RunResult, type Sandbox, type SandboxProvider } from './types.ts'

export function localSandbox(opts: { root?: string; volumes?: string; env?: Record<string, string> } = {}): SandboxProvider & { live: Set<string>; paused: Set<string> } {
  const root = opts.root ?? join(tmpdir(), 'byoa-local')
  const volumes = opts.volumes ?? join(root, 'volumes')
  /** The sandboxes that exist, running or paused; and the paused ones. */
  const live = new Set<string>(), paused = new Set<string>()
  const background = new Map<string, number[]>()
  const foreground = new Map<string, Set<ReturnType<typeof spawn>>>()
  mkdirSync(root, { recursive: true })
  const stopBackground = (id: string) => {
    for (const pid of background.get(id) ?? []) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    background.delete(id)
    for (const p of foreground.get(id) ?? []) p.kill('SIGKILL')
    foreground.delete(id)
  }
  const usable = (id: string) => {
    if (!live.has(id)) return new Error(`byoa local sandbox: ${id} was destroyed`)
    if (paused.has(id)) return new Error(`byoa local sandbox: ${id} is paused`)
  }
  const destroy = (id: string) => {
    live.delete(id)
    paused.delete(id)
    stopBackground(id)
    rmSync(id, { recursive: true, force: true })
  }

  const open = (id: string): Sandbox => {
    const home = join(id, 'home', 'user')
    return {
      id,
      home,
      run(cmd: string, o: RunOptions = {}): Promise<RunResult> {
        const bad = usable(id)
        if (bad) return Promise.reject(bad)
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...opts.env, HOME: home, ...o.env }
        if (o.background) {
          const b = spawn('bash', ['-c', cmd], { cwd: o.cwd ?? home, env, stdio: 'ignore', detached: true })
          b.unref()
          if (b.pid) background.set(id, [...(background.get(id) ?? []), b.pid])
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
        }
        const p = spawn('bash', ['-c', cmd], { cwd: o.cwd ?? home, env, stdio: ['ignore', 'pipe', 'pipe'] })
        if (!foreground.has(id)) foreground.set(id, new Set())
        foreground.get(id)!.add(p)
        let stdout = '', stderr = ''
        p.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; o.onStdout?.(d) })
        p.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; o.onStderr?.(d) })
        const t = o.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), o.timeoutMs) : undefined
        return new Promise((res, rej) => {
          p.on('error', rej)
          p.on('close', (code) => { clearTimeout(t); foreground.get(id)?.delete(p); res({ exitCode: code ?? 137, stdout, stderr }) })
        })
      },
      async writeFile(path, data) {
        const bad = usable(id)
        if (bad) throw bad
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, data)
      },
      async pause() {
        if (!live.has(id)) throw new Error(`byoa local sandbox: ${id} was destroyed`)
        paused.add(id)
        stopBackground(id)
      },
      async destroy() { destroy(id) },
    }
  }

  return {
    name: 'local',
    live,
    paused,
    async create(c: CreateOptions = {}) {
      const id = mkdtempSync(join(root, 'sbx-'))
      live.add(id)
      const s = open(id)
      mkdirSync(s.home, { recursive: true })
      for (const v of c.volumes ?? []) {
        const dir = join(volumes, v.name)
        mkdirSync(dir, { recursive: true })
        const at = join(s.home, v.path)
        mkdirSync(dirname(at), { recursive: true })
        symlinkSync(dir, at)
      }
      return s
    },
    async resume(id) {
      if (!live.has(id) || !existsSync(id)) throw new SandboxGoneError(`byoa local sandbox: no sandbox ${id}`)
      paused.delete(id)
      return open(id)
    },
    async destroy(id) { destroy(id) },
    async deleteVolume(name) {
      rmSync(join(volumes, name), { recursive: true, force: true })
    },
  }
}
