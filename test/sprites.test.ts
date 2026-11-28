// The Sprites adapter against Sprites itself (R5.3, R5.4, R1.4): create, run, write, destroy, and a destroyed Sprite
// is gone; a kept Sprite stops its job's processes and sleeps, and resumes with its files; a Sprite is held awake
// until its time, so a background command (the login's watcher) runs before it sleeps; one that is not kept ends at its
// time. Then V8 on Sprites. Needs SPRITES_TOKEN, and costs a little, so it runs only with BYOA_SPRITES=1
// (npm run test:sprites), not on every commit. The last check uses a stand-in for the API, and runs always.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { sprites } from '../src/sandbox/sprites.ts'
import { SandboxGoneError } from '../src/sandbox/types.ts'
import { sandboxConformance } from './helpers/conformance.ts'

const skip = !(process.env.BYOA_SPRITES && process.env.SPRITES_TOKEN) && 'set BYOA_SPRITES=1 and SPRITES_TOKEN to check the Sprites adapter'
const API = 'https://api.sprites.dev'
/** The Sprite's status at Sprites (running, warm, cold), or 'gone'. */
const status = async (id: string) => {
  const r = await fetch(`${API}/v1/sprites/${id}`, { headers: { Authorization: `Bearer ${process.env.SPRITES_TOKEN}` } })
  return r.status === 404 ? 'gone' : ((await r.json()) as any).status as string
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits until the Sprite went to sleep after `since` (its `status` can be stale; `last_warming_at` is not). */
const slept = async (id: string, since: number) => {
  for (let i = 0; i < 60; i++, await wait(5000)) {
    const r = await fetch(`${API}/v1/sprites/${id}`, { headers: { Authorization: `Bearer ${process.env.SPRITES_TOKEN}` } })
    const w = ((await r.json()) as any).last_warming_at
    if (w && Date.parse(w) >= since) return
  }
  throw new Error(`the Sprite ${id} did not sleep`)
}

test('R5.3: the Sprites adapter does what byoa needs of every provider (exit 137 at a timeout, readFile)', { skip, timeout: 10 * 60_000 }, () => sandboxConformance(sprites()))

test('Sprites adapter: create, run, write, destroy', { skip, timeout: 10 * 60_000 }, async () => {
  const p = sprites()
  const a = await p.create({ labels: { 'byoa-check': 'adapter' }, timeoutMs: 10 * 60_000 })
  try {
    assert.equal(a.home, '/home/sprite')
    assert.equal((await a.run('echo $HOME; whoami')).stdout, '/home/sprite\nsprite\n')
    assert.equal((await a.run('grep CapEff /proc/self/status')).stdout, 'CapEff:\t0000000000000000\n', 'commands run with no capabilities')
    assert.deepEqual(await a.run('printf \"no newline\"'), { exitCode: 0, stdout: 'no newline', stderr: '' })
    let streamed = '', times: number[] = []
    const t0 = Date.now()
    await a.run('printf "a\\nb\\n"; sleep 2; printf "c\\n"', { onStdout: (c) => { streamed += c; times.push(Date.now() - t0) } })
    assert.equal(streamed, 'a\nb\nc\n')
    assert.ok(times[0]! < times.at(-1)! - 1500, `output comes as it is written (${times})`)
    assert.equal((await a.run(`printf '%s' "$X"`, { env: { X: `it's "quoted" $HOME & é` } })).stdout, `it's "quoted" $HOME & é`)
    assert.equal((await a.run('cat')).exitCode, 0, 'a command that reads stdin does not wait for it')
    const big = await a.run('head -c 3000000 /dev/zero | tr "\\0" x; echo')
    assert.equal(big.stdout.length, 3_000_001)
    await a.writeFile('/home/sprite/work/deep/kept.txt', 'kept')
    assert.equal((await a.run('cat /home/sprite/work/deep/kept.txt; stat -c %U /home/sprite/work/deep/kept.txt')).stdout, 'keptsprite\n')
    await a.run('sleep 3; echo done > /tmp/bg', { background: true })
    assert.equal((await a.run('test -e /tmp/bg')).exitCode, 1, 'a background command returns at once')
    await wait(6000)
    assert.equal((await a.run('cat /tmp/bg')).stdout, 'done\n')
  } finally { await a.destroy() }
  assert.equal(await status(a.id), 'gone', 'V8: the Sprite no longer exists')
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError)
  await p.destroy(a.id)
})

test('R1.4 on Sprites: a Sprite is held awake until its time, so a background watcher runs; then a kept one sleeps with its files and resumes with no process of its job', { skip, timeout: 15 * 60_000 }, async () => {
  const p = sprites()
  // the Sprite cannot sleep before its time, so it slept after this (with room for a clock that differs from ours)
  const end = Date.now() + 150_000 - 10_000
  const a = await p.create({ labels: { 'byoa-check': 'hold' }, timeoutMs: 150_000, keep: true })
  try {
    // as the stored login's watcher: it removes a file after a while, with no exec open
    await a.writeFile('/home/sprite/.codex/auth.json', '{"secret":1}')
    await a.run('for i in $(seq 1 90); do date +%s >> /home/sprite/ticks; sleep 1; done; rm -f /home/sprite/.codex/auth.json', { background: true })
    await wait(110_000)
    const ticks = (await a.run('cat /home/sprite/ticks')).stdout.trim().split('\n').map(Number)
    const gap = Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]!))
    assert.equal(ticks.length, 90, 'the watcher ran all its time')
    assert.ok(gap <= 3, `the Sprite did not sleep while it was held (longest gap ${gap} s)`)
    assert.equal((await a.run('test -e /home/sprite/.codex/auth.json')).exitCode, 1, 'the watcher removed the login file')
    // at its time, the kept Sprite lets go and sleeps
    await a.run('sleep 600', { background: true })
    await slept(a.id, end)
    const b = await p.resume(a.id, { timeoutMs: 120_000 })
    assert.equal((await b.run('wc -l < /home/sprite/ticks')).stdout.trim(), '90', 'its files stay')
    assert.equal((await b.run("pgrep -f 'slee[p] 600'")).exitCode, 1, 'no process of the earlier job runs')
    const paused = Date.now()
    await b.pause()
    await slept(a.id, paused)
  } finally { await p.destroy(a.id) }

  // a Sprite that is not kept ends at its time: its home folder is gone, and resume says so
  const j = await p.create({ labels: { 'byoa-check': 'job' }, timeoutMs: 20_000 })
  try {
    await j.writeFile('/home/sprite/.codex/auth.json', '{"secret":1}')
    await j.run('sleep 600', { background: true })
    await wait(40_000)
    assert.equal((await j.run('ls -A /home/sprite | wc -l; pgrep -f "slee[p] 600" || echo none')).stdout, '0\nnone\n')
    await assert.rejects(p.resume(j.id), (e: Error) => e instanceof SandboxGoneError)
    assert.equal(await status(j.id), 'gone')
  } finally { await p.destroy(j.id) }
})

test('V8 on Sprites: a user\'s jobs run in one kept Sprite, or in one for each sandbox key; with sandboxPer: \'job\' each job\'s Sprite is gone after it', { skip, timeout: 15 * 60_000 }, async () => {
  const { createAgents, memoryStore } = await import('../src/index.ts')
  const { collect } = await import('./helpers/app.ts')
  const ids: string[] = []
  const inner = sprites()
  const sandbox = { ...inner, create: async (o?: Parameters<typeof inner.create>[0]) => { const s = await inner.create(o); ids.push(s.id); return s } }
  const app = (sandboxPer: 'user' | 'job') => createAgents({
    app: 'v8check', sandbox, store: memoryStore(), encryptionKey: randomBytes(32).toString('base64'), sandboxPer,
    proxyUrl: 'http://127.0.0.1:9/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1:9/callback' }, jobTimeoutMs: 3 * 60_000,
  })
  const job = { harness: 'fake' as const, task: 'hi' }
  const ok = { type: 'end', ok: true, result: 'fake answer' }
  const gone = (id: string, why: string) => assert.rejects(inner.resume(id), (e: Error) => e instanceof SandboxGoneError, why)
  const user = app('user')
  try {
    for (let i = 0; i < 2; i++) assert.deepEqual((await collect(user.run('alice', job))).at(-1), ok)
    assert.equal(ids.length, 1, 'the second job resumed the first job\'s Sprite')
    await inner.destroy(ids[0]!)
    assert.deepEqual((await collect(user.run('alice', job))).at(-1), ok)
    assert.equal(ids.length, 2)
    for (const key of ['project-a', 'project-b', 'project-a']) assert.deepEqual((await collect(user.run('alice', { ...job, sandboxKey: key }))).at(-1), ok)
    assert.equal(ids.length, 4, 'one Sprite for each key')
    await user.deleteSandbox('alice', { sandboxKey: 'project-a' })
    await gone(ids[2]!, 'only that key\'s Sprite is gone')
    assert.notEqual(await status(ids[3]!), 'gone')
  } finally { await user.deleteSandbox('alice') }
  for (const id of ids.slice(1)) await gone(id, 'deleteSandbox removes them at Sprites')

  const perJob = app('job')
  for (let i = 0; i < 2; i++) assert.deepEqual((await collect(perJob.run('alice', job))).at(-1), ok)
  assert.equal(ids.length, 6)
  for (const id of ids.slice(4)) await gone(id, 'V8: gone at Sprites')
})

// With a stand-in for the Sprites API, so it runs on every commit: about one call in ten to a Sprite hangs for 11 s
// or more before it gets there.
test('Sprites adapter: a call with no answer after a second is sent again beside it, and the first answer counts', async () => {
  const seen: string[] = []
  const hung: ServerResponse[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (seen.length === 1) hung.push(res) // the first call gets no answer
    else res.writeHead(204).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const t0 = Date.now()
    await sprites({ token: 'none', apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }).destroy('byoa-00')
    const ms = Date.now() - t0
    assert.deepEqual(seen, ['DELETE /v1/sprites/byoa-00', 'DELETE /v1/sprites/byoa-00'])
    assert.ok(ms >= 900 && ms < 4000, `the second call's answer ended the wait after ${ms} ms`)
  } finally {
    for (const r of hung) r.destroy()
    server.closeAllConnections()
    server.close()
  }
})
