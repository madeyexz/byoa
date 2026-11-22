// V11: the installed claude and codex are the labs' published packages, file for file (Lab rules). The real installer
// (ensureHarness) installs the pinned versions from npm into a sandbox; verifyHarness compares every installed file
// with the tarball npm publishes, after checking that tarball against the registry's integrity hash.
// It downloads about 600 MB, so it runs only with BYOA_V11=1 (CI runs it on every commit). BYOA_V11_E2B=1 runs it in
// an E2B sandbox (needs E2B_API_KEY) instead of the local one.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ensureHarness } from '../src/harness/install.ts'
import { PINS } from '../src/harness/pins.ts'
import type { Sandbox } from '../src/sandbox/types.ts'
import { localSandbox } from '../src/sandbox/local.ts'
import { verifyHarness } from '../src/verify.ts'

const skip = !process.env.BYOA_V11 && 'set BYOA_V11=1 (downloads about 600 MB)'
let sbx: Sandbox
before(async () => {
  if (skip) return
  if (process.env.BYOA_V11_E2B) {
    const { e2b } = await import('../src/sandbox/e2b.ts')
    // a plain Node template: byoa installs the harness itself
    sbx = await e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'base' }).create({ labels: { 'byoa-check': 'v11' } })
  } else {
    sbx = await localSandbox({ root: mkdtempSync(join(tmpdir(), 'byoa-v11-')) }).create()
  }
})
after(async () => { await sbx?.destroy() })

for (const h of ['claude', 'codex'] as const) {
  test(`V11: the installed ${h} is ${h === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'}@${PINS[h]} as published`, { skip, timeout: 15 * 60_000 }, async () => {
    const inst = await ensureHarness(sbx, h)
    assert.equal(inst.version, PINS[h])
    const r = await verifyHarness(sbx, h, inst.bin)
    console.log(JSON.stringify({ ...r, problems: r.problems.slice(0, 5) }))
    assert.deepEqual(r.problems, [])
    assert.ok(r.ok && r.files > 2)
    // the next job finds the pinned version and installs nothing
    assert.equal((await ensureHarness(sbx, h)).installed, false)
  })
}

test('V11: a changed file is found', { skip, timeout: 15 * 60_000 }, async () => {
  const inst = await ensureHarness(sbx, 'codex')
  // codex's launcher script; one byte more
  await sbx.run(`echo >> "$(readlink -f '${inst.bin}')"`)
  const r = await verifyHarness(sbx, 'codex', inst.bin)
  assert.equal(r.ok, false)
  assert.deepEqual(r.problems, [`@openai/codex@${PINS.codex}: bin/codex.js differs from the published file`])
})
