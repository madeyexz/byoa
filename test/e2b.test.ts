// The E2B adapter against E2B itself (R5.3, R5.4, R1.4): create with a volume, run, write, destroy; a second sandbox
// sees what the first wrote in the volume; a destroyed sandbox is gone at E2B. Needs E2B_API_KEY, and costs a little,
// so it does not run on every commit. BYOA_E2B_TEMPLATE: any template with bash (default: E2B's `base`).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { Sandbox as E2BSandbox } from 'e2b'
import { e2b } from '../src/sandbox/e2b.ts'

const skip = !process.env.E2B_API_KEY && 'set E2B_API_KEY to check the E2B adapter'

test('E2B adapter: create, run, write, volume, destroy', { skip, timeout: 5 * 60_000 }, async () => {
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
