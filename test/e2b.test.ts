// The E2B adapter against E2B itself (R5.3, R5.4, R1.5): a kept sandbox pauses with its files and no processes, and
// resumes; a destroyed one is gone at E2B, and resume says so. With a volume, a second sandbox sees what the first
// wrote in it. Needs E2B_API_KEY, and costs a little, so it runs only with BYOA_E2B=1 (npm run test:e2b), not on every
// commit; the volume test also needs BYOA_E2B_VOLUMES=1 and a team with volumes turned on. BYOA_E2B_TEMPLATE: any
// template with bash (default: E2B's `base`).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { Sandbox as E2BSandbox } from 'e2b'
import { e2b } from '../src/sandbox/e2b.ts'
import { SandboxGoneError } from '../src/sandbox/types.ts'
import { sandboxConformance } from './helpers/conformance.ts'

const skip = !(process.env.BYOA_E2B && process.env.E2B_API_KEY) && 'set BYOA_E2B=1 and E2B_API_KEY to check the E2B adapter'
const skipVolumes = skip || (!process.env.BYOA_E2B_VOLUMES && 'set BYOA_E2B_VOLUMES=1 for a team with E2B volumes')

test('R5.3: the E2B adapter does what byoa needs of every provider (exit 137 at a timeout, readFile)', { skip, timeout: 5 * 60_000 }, () => sandboxConformance(e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' })))

test('E2B adapter: a kept sandbox pauses with its files and no processes, resumes, and is gone after destroy', { skip, timeout: 5 * 60_000 }, async () => {
  const p = e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' })
  const a = await p.create({ labels: { 'byoa-check': 'lifecycle' }, timeoutMs: 120_000, keep: true })
  try {
    assert.equal(a.home, '/home/user')
    assert.deepEqual(await a.run('echo out; echo err >&2; exit 3'), { exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    await a.writeFile('/home/user/kept.txt', 'kept while paused')
    await a.run('sleep 600', { background: true })
    await a.pause()
    assert.equal((await E2BSandbox.getInfo(a.id)).state, 'paused')
    const b = await p.resume(a.id, { timeoutMs: 120_000 })
    assert.equal(b.id, a.id)
    assert.equal((await b.run('cat /home/user/kept.txt')).stdout, 'kept while paused')
    assert.equal((await b.run("pgrep -f 'slee[p] 600'")).exitCode, 1, 'no process of the earlier job runs')
    assert.equal((await p.resume(a.id)).id, a.id, 'resume of a running sandbox')
  } finally { await p.destroy(a.id) }
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError, 'V8: gone at E2B, and resume says so')
  await p.destroy(a.id)
})

test('E2B adapter: a kept sandbox that times out is paused, not killed, and resumes with no process of its job', { skip, timeout: 5 * 60_000 }, async () => {
  const p = e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' })
  const a = await p.create({ labels: { 'byoa-check': 'timeout' }, timeoutMs: 5_000, keep: true })
  try {
    await a.writeFile('/home/user/kept.txt', 'kept')
    await a.run('sleep 600', { background: true })
    for (let i = 0; (await E2BSandbox.getInfo(a.id)).state !== 'paused'; i++) {
      if (i === 60) throw new Error('the sandbox did not pause at its timeout')
      await new Promise((r) => setTimeout(r, 2000))
    }
    const b = await p.resume(a.id, { timeoutMs: 120_000 })
    assert.equal((await b.run('cat /home/user/kept.txt')).stdout, 'kept')
    assert.equal((await b.run("pgrep -f 'slee[p] 600'")).exitCode, 1)
  } finally { await p.destroy(a.id) }
})

test('E2B adapter: create, run, write, volume, destroy', { skip: skipVolumes, timeout: 5 * 60_000 }, async () => {
  const p = e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' })
  const vol = `byoa-check-${randomBytes(6).toString('hex')}`
  try {
    const a = await p.create({ volumes: [{ name: vol, path: '.claude' }], labels: { 'byoa-check': 'adapter' }, timeoutMs: 120_000 })
    assert.equal(a.home, '/home/user')
    const r = await a.run('echo out; echo err >&2; exit 3')
    assert.deepEqual(r, { exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    let streamed = ''
    await a.run('printf "a\\nb\\n"', { onStdout: (c) => { streamed += c }, env: { X: 'y' } })
    assert.equal(streamed, 'a\nb\n')
    assert.equal((await a.run('echo $X', { env: { X: 'from-env' } })).stdout, 'from-env\n')
    await a.writeFile('/home/user/.claude/kept.txt', 'kept in the volume')
    await a.writeFile('/home/user/work/gone.txt', new TextEncoder().encode('gone with the sandbox'))
    assert.equal((await a.run('cat /home/user/work/gone.txt')).stdout, 'gone with the sandbox')
    assert.equal((await p.resume(a.id)).id, a.id)
    await a.destroy()
    await assert.rejects(E2BSandbox.connect(a.id), 'V8: the sandbox no longer exists at E2B')

    const b = await p.create({ volumes: [{ name: vol, path: '.claude' }], timeoutMs: 120_000 })
    try {
      assert.equal((await b.run('cat /home/user/.claude/kept.txt')).stdout, 'kept in the volume')
      assert.equal((await b.run('test -e /home/user/work/gone.txt')).exitCode, 1)
    } finally { await b.destroy() }
  } finally {
    await p.deleteVolume(vol)
  }
})

test('V8 on E2B: by default a user\'s jobs run in one sandbox, paused between jobs, or in one for each sandbox key; with sandboxPer: \'job\' each job\'s sandbox is gone after it', { skip, timeout: 10 * 60_000 }, async () => {
  const { createAgents, memoryStore } = await import('../src/index.ts')
  const { collect } = await import('./helpers/app.ts')
  const ids: string[] = []
  const inner = e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' })
  const sandbox = { ...inner, create: async (o?: Parameters<typeof inner.create>[0]) => { const s = await inner.create(o); ids.push(s.id); return s } }
  const app = (sandboxPer: 'user' | 'job') => createAgents({
    app: 'v8check', sandbox, store: memoryStore(), encryptionKey: randomBytes(32).toString('base64'), sandboxPer,
    proxyUrl: 'http://127.0.0.1:9/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1:9/callback' }, jobTimeoutMs: 3 * 60_000,
  })
  const job = { harness: 'fake' as const, task: 'hi' }
  const user = app('user')
  try {
    for (let i = 0; i < 2; i++) assert.deepEqual((await collect(user.run('alice', job))).at(-1), { type: 'end', ok: true, result: 'fake answer' })
    assert.equal(ids.length, 1, 'the second job resumed the first job\'s sandbox')
    assert.equal((await E2BSandbox.getInfo(ids[0]!)).state, 'paused')
    // the provider lost it: the next job gets a new one
    await inner.destroy(ids[0]!)
    assert.deepEqual((await collect(user.run('alice', job))).at(-1), { type: 'end', ok: true, result: 'fake answer' })
    assert.equal(ids.length, 2)
    // many kept sandboxes: one for each sandbox key, each paused between its jobs
    for (const key of ['project-a', 'project-b', 'project-a']) assert.deepEqual((await collect(user.run('alice', { ...job, sandboxKey: key }))).at(-1), { type: 'end', ok: true, result: 'fake answer' })
    assert.equal(ids.length, 4, 'project-a\'s second job resumed its sandbox')
    for (const id of ids.slice(1)) assert.equal((await E2BSandbox.getInfo(id)).state, 'paused')
    await user.deleteSandbox('alice', { sandboxKey: 'project-a' })
    await assert.rejects(inner.resume(ids[2]!), (e: Error) => e instanceof SandboxGoneError, 'only that key\'s sandbox is gone')
    assert.equal((await E2BSandbox.getInfo(ids[3]!)).state, 'paused')
  } finally { await user.deleteSandbox('alice') }
  for (const id of ids.slice(1)) await assert.rejects(inner.resume(id), (e: Error) => e instanceof SandboxGoneError, 'deleteSandbox removes them at E2B')

  const perJob = app('job')
  for (let i = 0; i < 2; i++) assert.deepEqual((await collect(perJob.run('alice', job))).at(-1), { type: 'end', ok: true, result: 'fake answer' })
  assert.equal(ids.length, 6)
  for (const id of ids.slice(4)) await assert.rejects(inner.resume(id), (e: Error) => e instanceof SandboxGoneError, 'V8: gone at E2B')
})
