// The harness installer (R5.1, R5.2). Each job checks the harness in its sandbox: the template's copy, or a copy an
// earlier job of the user installed, when it is the pinned version; else the pinned version from npm, installed into
// the sandbox's home folder. So a new pin reaches every user at their next job, also from an old template or in a
// sandbox that byoa keeps between jobs.
// It installs the labs' own npm packages, unchanged (Lab rules); `@madeyexz/byoa/verify` checks that (V11).
import type { Sandbox } from '../sandbox/types.ts'
import { q } from '../sh.ts'
import { PINS, npmSpec, type HarnessName, type Pins } from './pins.ts'

export interface Installed { bin: string; version: string; installed: boolean }

const versionOf = (s: string) => /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(s)?.[1]

export async function ensureHarness(sbx: Sandbox, h: HarnessName, pins: Pins = PINS): Promise<Installed> {
  const want = pins[h]
  const prefix = `${sbx.home}/.byoa/harness/${h}-${want}`
  const own = `${prefix}/bin/${h}`
  const find = async () => {
    const r = await sbx.run(`for b in ${q(own)} "$(command -v ${h})"; do [ -n "$b" ] && [ -x "$b" ] && echo "$b	$("$b" --version 2>/dev/null | head -1)"; done; true`)
    for (const line of r.stdout.split('\n')) {
      const [bin, v] = line.split('\t')
      if (bin && versionOf(v ?? '') === want) return { bin, version: want }
    }
  }
  const have = await find()
  if (have) return { ...have, installed: false }
  const r = await sbx.run(`npm install -g --prefix ${q(prefix)} --no-audit --no-fund --loglevel=error ${q(npmSpec(h, pins))}`, { timeoutMs: 10 * 60_000 })
  if (r.exitCode !== 0) throw new Error(`byoa: could not install ${npmSpec(h, pins)}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
  const now = await find()
  if (!now || now.bin !== own) throw new Error(`byoa: installed ${npmSpec(h, pins)}, but ${own} does not report version ${want}`)
  return { ...now, installed: true }
}
