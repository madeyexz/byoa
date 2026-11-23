// The Daytona adapter against Daytona itself (R5.3, R5.4): create, run, write, destroy, and a destroyed sandbox is
// gone at Daytona; a kept sandbox stops with its files and starts again. Needs DAYTONA_API_KEY, and costs a little, so
// it does not run on every commit.
// With BYOA_DAYTONA_VOLUMES=1 too, it also checks volumes (cliLogin, R1.5): a second sandbox sees what the first wrote
// in the login, and another login's subpath is not there. That needs a key with the volume permissions.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { Daytona } from '@daytona/sdk'
import { daytona } from '../src/sandbox/daytona.ts'
import { SandboxGoneError } from '../src/sandbox/types.ts'

const skip = !process.env.DAYTONA_API_KEY && 'set DAYTONA_API_KEY to check the Daytona adapter'
const skipVolumes = skip || (!process.env.BYOA_DAYTONA_VOLUMES && 'set BYOA_DAYTONA_VOLUMES=1 and DAYTONA_API_KEY to check Daytona volumes')

test('Daytona adapter: create, run, write, destroy', { skip, timeout: 10 * 60_000 }, async () => {
  const p = daytona()
  const a = await p.create({ labels: { 'byoa-check': 'adapter' }, timeoutMs: 5 * 60_000 })
  try {
    assert.equal(a.home, '/home/daytona')
    assert.equal((await a.run('echo $HOME; whoami')).stdout, '/home/daytona\ndaytona\n')
    assert.deepEqual(await a.run('echo out; echo err >&2; exit 3'), { exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    let streamed = ''
    await a.run('printf "a\\nb\\n"; sleep 1; printf "c\\n"', { onStdout: (c) => { streamed += c } })
    assert.equal(streamed, 'a\nb\nc\n')
    assert.equal((await a.run(`printf '%s' "$X"`, { env: { X: `it's "quoted" $HOME` } })).stdout, `it's "quoted" $HOME`)
    assert.equal((await a.run('pwd', { cwd: '/tmp' })).stdout, '/tmp\n')
    assert.equal((await a.run('pwd')).stdout, '/home/daytona\n')
    assert.equal((await a.run('cat', {})).exitCode, 0, 'a command that reads stdin does not wait for it')
    assert.equal((await a.run('sleep 30', { timeoutMs: 2000 })).exitCode, 137)
    await a.writeFile('/home/daytona/work/deep/kept.txt', new TextEncoder().encode('written by byoa'))
    assert.equal((await a.run('cat /home/daytona/work/deep/kept.txt')).stdout, 'written by byoa')
    assert.equal((await a.run('stat -c %U /home/daytona/work/deep/kept.txt')).stdout, 'daytona\n')
    assert.equal((await p.resume(a.id)).id, a.id)
    await a.run('sleep 3; echo done > /tmp/bg', { background: true })
    assert.equal((await a.run('test -e /tmp/bg')).exitCode, 1, 'a background command returns at once')
    await new Promise((r) => setTimeout(r, 6000))
    assert.equal((await a.run('cat /tmp/bg')).stdout, 'done\n')
  } finally { await a.destroy() }
  await assert.rejects(new Daytona().v0.get(a.id), 'V8: the sandbox no longer exists at Daytona')
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError)
})

test('Daytona adapter: a kept sandbox stops with its files and starts again; destroy deletes it', { skip, timeout: 10 * 60_000 }, async () => {
  const p = daytona()
  const a = await p.create({ labels: { 'byoa-check': 'lifecycle' }, timeoutMs: 5 * 60_000, keep: true })
  try {
    assert.equal((await a.run('echo $HOME')).stdout, '/home/daytona\n')
    await a.writeFile('/home/daytona/kept.txt', 'kept while stopped\n')
    await a.run('sleep 600', { background: true })
    await a.pause()
    assert.equal((await new Daytona().v0.get(a.id)).state, 'stopped')
    const b = await p.resume(a.id, { timeoutMs: 5 * 60_000 })
    assert.equal(b.id, a.id)
    assert.equal((await b.run('cat /home/daytona/kept.txt')).stdout, 'kept while stopped\n')
    assert.equal((await b.run("pgrep -f 'slee[p] 600'")).exitCode, 1, 'no process of the earlier job runs')
    assert.equal((await p.resume(a.id)).id, a.id, 'resume of a running sandbox')
  } finally { await p.destroy(a.id) }
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError)
  await p.destroy(a.id)

  // a sandbox of one job: destroyed, it is gone (V8)
  const c = await p.create({ labels: { 'byoa-check': 'job' }, timeoutMs: 5 * 60_000 })
  await c.destroy()
  await assert.rejects(p.resume(c.id), (e: Error) => e instanceof SandboxGoneError)
})

test('Daytona adapter: login volumes', { skip: skipVolumes, timeout: 10 * 60_000 }, async () => {
  const p = daytona()
  const login = `byoa-check-${randomBytes(6).toString('hex')}`, other = `${login}-other`
  // cleanup must not hide the error that ended the test
  const cleanup = () => Promise.all([login, other].map((v) => p.deleteVolume(v).catch(() => {})))
  try {
    const a = await p.create({ volumes: [{ name: login, path: '.claude' }, { name: other, path: '.codex' }], timeoutMs: 5 * 60_000 })
    try {
      await a.writeFile('/home/daytona/.claude/kept.txt', 'kept in the volume')
      assert.equal((await a.run('stat -c %U /home/daytona/.claude/kept.txt')).stdout, 'daytona\n')
      // what the harnesses do with their login folder: atomic replace by rename, append, a lock
      const fs = await a.run('cd ~/.claude && echo 1 > t.tmp && mv t.tmp t.json && echo 2 >> t.json && cat t.json && mkdir lock && rmdir lock && rm t.json')
      assert.deepEqual(fs, { exitCode: 0, stdout: '1\n2\n', stderr: '' })
      await a.writeFile('/home/daytona/.codex/other.txt', 'another login')
    } finally { await a.destroy() }

    const b = await p.create({ volumes: [{ name: login, path: '.claude' }], timeoutMs: 5 * 60_000 })
    try {
      assert.equal((await b.run('cat /home/daytona/.claude/kept.txt')).stdout, 'kept in the volume')
      assert.equal((await b.run('ls -A /home/daytona/.claude; test -e /home/daytona/.codex')).stdout, 'kept.txt\n', 'only this login is mounted')
    } finally { await b.destroy() }

    await p.deleteVolume(login)
    const c = await p.create({ volumes: [{ name: login, path: '.claude' }, { name: other, path: '.codex' }], timeoutMs: 5 * 60_000 })
    try {
      assert.equal((await c.run('ls -A /home/daytona/.claude; cat /home/daytona/.codex/other.txt')).stdout, 'another login', 'deleteVolume deletes only that login')
    } finally { await c.destroy() }
  } finally {
    await cleanup()
  }
})

test('V8 on Daytona: a user\'s jobs run in one kept sandbox, or in one for each sandbox key; with sandboxPer: \'job\' each job\'s sandbox is gone after it', { skip, timeout: 10 * 60_000 }, async () => {
  const { createAgents, memoryStore } = await import('../src/index.ts')
  const { collect } = await import('./helpers/app.ts')
  const ids: string[] = []
  const inner = daytona()
  const sandbox = { ...inner, create: async (o?: Parameters<typeof inner.create>[0]) => { const s = await inner.create(o); ids.push(s.id); return s } }
  const app = (sandboxPer: 'user' | 'job') => createAgents({
    app: 'v8check', sandbox, store: memoryStore(), encryptionKey: randomBytes(32).toString('base64'), sandboxPer,
    proxyUrl: 'http://127.0.0.1:9/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1:9/callback' }, jobTimeoutMs: 3 * 60_000,
  })
  const job = { harness: 'fake' as const, task: 'hi' }
  const ok = { type: 'end', ok: true, result: 'fake answer' }
  const user = app('user')
  const state = async (id: string) => (await new Daytona().v0.get(id)).state
  try {
    for (const key of [undefined, undefined, 'project-a', 'project-b', 'project-a']) assert.deepEqual((await collect(user.run('alice', { ...job, sandboxKey: key }))).at(-1), ok)
    assert.equal(ids.length, 3, 'one sandbox with no key, and one for each key')
    for (const id of ids) assert.equal(await state(id), 'stopped')
    await user.deleteSandbox('alice', { sandboxKey: 'project-a' })
    await assert.rejects(inner.resume(ids[1]!), (e: Error) => e instanceof SandboxGoneError, 'only that key\'s sandbox is gone')
    assert.equal(await state(ids[2]!), 'stopped')
  } finally { await user.deleteSandbox('alice') }
  for (const id of ids) await assert.rejects(inner.resume(id), (e: Error) => e instanceof SandboxGoneError, 'deleteSandbox removes them at Daytona')

  const perJob = app('job')
  for (let i = 0; i < 2; i++) assert.deepEqual((await collect(perJob.run('alice', job))).at(-1), ok)
  assert.equal(ids.length, 5)
  for (const id of ids.slice(3)) await assert.rejects(inner.resume(id), (e: Error) => e instanceof SandboxGoneError, 'V8: gone at Daytona')
})
