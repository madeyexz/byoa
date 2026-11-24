// The Instabox adapter against Instabox itself (R5.3, R5.4): create, run, write, destroy, and a destroyed sandbox is
// gone at Instabox; a kept sandbox stops with its files and no processes, and starts again; one that paused itself
// resumes with no process of its job. Then V8 on Instabox. Needs INSTABOX_API_KEY, and costs a little, so it runs only
// with BYOA_INSTABOX=1 (npm run test:instabox), not on every commit. The tests make one sandbox at a time, because
// Instabox's free plan allows one; V8's two sandbox keys at once need a plan that allows three.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { instabox } from '../src/sandbox/instabox.ts'
import { SandboxGoneError } from '../src/sandbox/types.ts'

const skip = !(process.env.BYOA_INSTABOX && process.env.INSTABOX_API_KEY) && 'set BYOA_INSTABOX=1 and INSTABOX_API_KEY to check the Instabox adapter'
const API = 'https://api.instabox.sh'
const ib = async (method: string, path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(API + path, { method, headers: { 'X-API-Key': process.env.INSTABOX_API_KEY!, ...headers } })
  return { status: r.status, body: await r.json() as any }
}
/** The sandbox's state at Instabox, or 'gone'. */
const state = async (id: string) => { const r = await ib('GET', `/v1/machines/${id}`); return r.status === 404 ? 'gone' : r.body.state as string }
const op = async (method: string, path: string, headers: Record<string, string> = {}) => {
  let o = (await ib(method, path, { 'Idempotency-Key': randomUUID(), ...headers })).body
  while (o.state !== 'succeeded') { if (o.state === 'failed' || !o.id) throw new Error(JSON.stringify(o)); o = (await ib('GET', `/v1/operations/${o.id}?wait=25s`)).body }
}

test('Instabox adapter: create, run, write, destroy', { skip, timeout: 10 * 60_000 }, async () => {
  const p = instabox()
  const a = await p.create({ labels: { 'byoa-check': 'adapter' }, timeoutMs: 10 * 60_000 })
  try {
    assert.equal(a.home, '/data/home')
    assert.equal((await a.run('echo $HOME; whoami')).stdout, '/data/home\nuser\n')
    assert.deepEqual(await a.run('echo out; echo err >&2; exit 3'), { exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    assert.deepEqual(await a.run('printf "no newline"'), { exitCode: 0, stdout: 'no newline', stderr: '' })
    let streamed = '', times: number[] = []
    const t0 = Date.now()
    await a.run('printf "a\\nb\\n"; sleep 2; printf "c\\n"', { onStdout: (c) => { streamed += c; times.push(Date.now() - t0) } })
    assert.equal(streamed, 'a\nb\nc\n')
    assert.ok(times[0]! < times.at(-1)! - 1500, `output comes as it is written (${times})`)
    assert.equal((await a.run(`printf '%s' "$X"`, { env: { X: `it's "quoted" $HOME` } })).stdout, `it's "quoted" $HOME`)
    assert.equal((await a.run('pwd', { cwd: '/tmp' })).stdout, '/tmp\n')
    assert.equal((await a.run('pwd')).stdout, '/data/home\n')
    assert.equal((await a.run('cat', {})).exitCode, 0, 'a command that reads stdin does not wait for it')
    assert.equal((await a.run('sleep 30', { timeoutMs: 2000 })).exitCode, 137)
    const big = await a.run('head -c 3000000 /dev/zero | tr "\\0" x; echo')
    assert.equal(big.stdout.length, 3_000_001, 'more than the 1 MiB that one exec answer holds')
    // the file's contents are the upload's body, not in a command line or the sandbox's history
    const secret = `byoa-${randomBytes(8).toString('hex')}`
    await a.writeFile('/data/home/work/deep/kept.txt', new TextEncoder().encode(secret))
    assert.equal((await a.run('cat /data/home/work/deep/kept.txt')).stdout, secret)
    assert.equal((await a.run('stat -c %U /data/home/work/deep/kept.txt')).stdout, 'user\n')
    const history = JSON.stringify((await ib('GET', `/v1/machines/${a.id}/history`)).body)
    assert.ok(!history.includes(secret), 'no command or output of byoa is in the sandbox\'s history at Instabox')
    assert.equal((await p.resume(a.id)).id, a.id)
    await a.run('sleep 3; echo done > /tmp/bg', { background: true })
    assert.equal((await a.run('test -e /tmp/bg')).exitCode, 1, 'a background command returns at once')
    await new Promise((r) => setTimeout(r, 6000))
    assert.equal((await a.run('cat /tmp/bg')).stdout, 'done\n')
  } finally { await a.destroy() }
  assert.equal(await state(a.id), 'gone', 'V8: the sandbox no longer exists at Instabox')
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError)
  await p.destroy(a.id)
})

test('Instabox adapter: a kept sandbox stops with its files and starts again; one that paused itself resumes with no process of its job', { skip, timeout: 10 * 60_000 }, async () => {
  const p = instabox()
  const a = await p.create({ labels: { 'byoa-check': 'lifecycle' }, timeoutMs: 5 * 60_000, keep: true })
  try {
    assert.equal((await ib('GET', `/v1/machines/${a.id}`)).body.deleteAt ?? null, null, 'a kept sandbox has no delete time')
    await a.writeFile('/data/home/kept.txt', 'kept while stopped\n')
    await a.run('sleep 600', { background: true })
    await a.pause()
    assert.equal(await state(a.id), 'stopped')
    const b = await p.resume(a.id, { timeoutMs: 5 * 60_000 })
    assert.equal(b.id, a.id)
    assert.equal((await b.run('cat /data/home/kept.txt')).stdout, 'kept while stopped\n')
    assert.equal((await b.run("pgrep -f 'slee[p] 600'")).exitCode, 1, 'no process of the earlier job runs')
    assert.equal((await p.resume(a.id)).id, a.id, 'resume of a running sandbox')

    // Instabox pauses an idle sandbox itself, with its processes (as when the backend died during a job)
    await b.run('sleep 600', { background: true })
    await op('POST', `/v1/machines/${a.id}/suspend`)
    assert.equal(await state(a.id), 'suspended')
    const c = await p.resume(a.id)
    assert.equal((await c.run('cat /data/home/kept.txt')).stdout, 'kept while stopped\n')
    assert.equal((await c.run("pgrep -f 'slee[p] 600'")).exitCode, 1, 'no process of the earlier job runs')
  } finally { await p.destroy(a.id) }
  assert.equal(await state(a.id), 'gone')
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError)
  await p.destroy(a.id)

  // a sandbox of one job: Instabox deletes it at its time at the latest; destroyed, it is gone (V8)
  const j = await p.create({ labels: { 'byoa-check': 'job' }, timeoutMs: 5 * 60_000 })
  try { assert.ok((await ib('GET', `/v1/machines/${j.id}`)).body.deleteAt, 'a sandbox of one job has a delete time') } finally { await j.destroy() }
  await assert.rejects(p.resume(j.id), (e: Error) => e instanceof SandboxGoneError)
})

test('V8 on Instabox: a user\'s jobs run in one kept sandbox, or in one for each sandbox key; with sandboxPer: \'job\' each job\'s sandbox is gone after it', { skip, timeout: 15 * 60_000 }, async (t) => {
  const { createAgents, memoryStore } = await import('../src/index.ts')
  const { collect } = await import('./helpers/app.ts')
  const ids: string[] = []
  const inner = instabox()
  const sandbox = { ...inner, create: async (o?: Parameters<typeof inner.create>[0]) => { const s = await inner.create(o); ids.push(s.id); return s } }
  const app = (sandboxPer: 'user' | 'job') => createAgents({
    app: 'v8check', sandbox, store: memoryStore(), encryptionKey: randomBytes(32).toString('base64'), sandboxPer,
    proxyUrl: 'http://127.0.0.1:9/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1:9/callback' }, jobTimeoutMs: 3 * 60_000,
  })
  const job = { harness: 'fake' as const, task: 'hi' }
  const ok = { type: 'end', ok: true, result: 'fake answer' }
  const gone = (id: string, why: string) => assert.rejects(inner.resume(id), (e: Error) => e instanceof SandboxGoneError, why)
  const max = (await ib('GET', '/v1/usage')).body.limits?.maxMachines ?? 1
  const user = app('user')
  try {
    // two jobs in one kept sandbox, stopped between them and after
    for (let i = 0; i < 2; i++) assert.deepEqual((await collect(user.run('alice', job))).at(-1), ok)
    assert.equal(ids.length, 1)
    assert.equal(await state(ids[0]!), 'stopped')
    // the provider no longer has it: the next job works in a new one
    await inner.destroy(ids[0]!)
    assert.deepEqual((await collect(user.run('alice', job))).at(-1), ok)
    assert.equal(ids.length, 2)
    if (max >= 3) {
      for (const key of ['project-a', 'project-b', 'project-a']) assert.deepEqual((await collect(user.run('alice', { ...job, sandboxKey: key }))).at(-1), ok)
      assert.equal(ids.length, 4, 'one sandbox for each key')
      await user.deleteSandbox('alice', { sandboxKey: 'project-a' })
      await gone(ids[2]!, 'only that key\'s sandbox is gone')
      assert.equal(await state(ids[3]!), 'stopped')
      assert.equal(await state(ids[1]!), 'stopped')
    } else {
      t.diagnostic(`this Instabox plan allows ${max} sandbox; two sandbox keys at once need 3, so one key is checked alone`)
      await user.deleteSandbox('alice')
      await gone(ids[1]!, 'deleteSandbox removes it at Instabox')
      assert.deepEqual((await collect(user.run('alice', { ...job, sandboxKey: 'project-a' }))).at(-1), ok)
      assert.equal(ids.length, 3, 'a sandbox for the key')
      await user.deleteSandbox('alice', { sandboxKey: 'project-a' })
      await gone(ids[2]!, 'the key\'s sandbox is gone')
    }
  } finally { await user.deleteSandbox('alice') }
  for (const id of ids) await gone(id, 'deleteSandbox removes them at Instabox')

  const perJob = app('job')
  const before = ids.length
  for (let i = 0; i < 2; i++) assert.deepEqual((await collect(perJob.run('alice', job))).at(-1), ok)
  assert.equal(ids.length, before + 2)
  for (const id of ids.slice(before)) await gone(id, 'V8: gone at Instabox')
})
