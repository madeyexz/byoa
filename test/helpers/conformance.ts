// What byoa needs of every sandbox provider (R5.3), as one check that each adapter's test runs: exit codes and output,
// a command that runs out of its time (exit 137, not a throw), writeFile and readFile, pause and resume with the files
// and no process of the job, and SandboxGoneError after destroy. A provider of an app's own runs it the same way.
import assert from 'node:assert/strict'
import { SandboxGoneError, type SandboxProvider } from '../../src/sandbox/types.ts'

export async function sandboxConformance(p: SandboxProvider, o: { timeoutMs?: number } = {}) {
  const a = await p.create({ labels: { 'byoa-check': 'conformance' }, timeoutMs: o.timeoutMs ?? 120_000, keep: true })
  try {
    assert.deepEqual(await a.run('echo out; echo err >&2; exit 3'), { exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
    assert.equal((await a.run('pwd', { cwd: '/tmp' })).stdout, '/tmp\n')
    assert.equal((await a.run('echo $X', { env: { X: 'from env' } })).stdout, 'from env\n')
    const t0 = Date.now()
    assert.equal((await a.run('sleep 30', { timeoutMs: 2_000 })).exitCode, 137, 'a command that runs out of its time')
    assert.ok(Date.now() - t0 < 20_000)
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 10])
    await a.writeFile(`${a.home}/dir/kept.bin`, bytes)
    if (a.readFile) {
      assert.deepEqual(await a.readFile(`${a.home}/dir/kept.bin`), bytes)
      assert.equal(await a.readFile(`${a.home}/dir/none`), null)
    }
    await a.run('sleep 600', { background: true })
    await a.pause()
    const b = await p.resume(a.id, { timeoutMs: o.timeoutMs ?? 120_000 })
    assert.equal(b.id, a.id)
    assert.equal((await b.run(`od -An -tu1 ${a.home}/dir/kept.bin | tr -s ' '`)).stdout.trim(), '0 1 2 250 255 10')
    assert.equal((await b.run("pgrep -f 'slee[p] 600'")).exitCode, 1, 'no process of the earlier job runs')
  } finally { await p.destroy(a.id) }
  await assert.rejects(p.resume(a.id), (e: Error) => e instanceof SandboxGoneError)
  await p.destroy(a.id)
}
