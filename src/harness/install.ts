// The harness installer (R5.1, R5.2). Each job checks the harness in its sandbox: the template's copy, or a copy an
// earlier job of the user installed, when it is the pinned version; else the pinned version from npm, installed into
// the sandbox's home folder. So a new pin reaches every user at their next job, also from an old template or in a
// sandbox that byoa keeps between jobs.
// It installs the labs' own npm packages, unchanged (Lab rules); `@madeyexz/byoa/verify` checks that (V11). Each
// harness adapter gives its package and what its install needs (harness/grok.ts); harness/index.ts has ensureHarness.
import type { Sandbox } from '../sandbox/types.ts'
import { q } from '../sh.ts'

export interface Installed { bin: string; version: string; installed: boolean }

/** `npm`: more environment for the install, and a command after it (Grok's postinstall, harness/grok.ts). */
export interface NpmPackage { name: string; pkg: string; pin: string; npm?: { env: Record<string, string>; after: string } }

const versionOf = (s: string) => /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(s)?.[1]

export async function installPinned(sbx: Sandbox, p: NpmPackage): Promise<Installed> {
  const spec = `${p.pkg}@${p.pin}`
  const prefix = `${sbx.home}/.byoa/harness/${p.name}-${p.pin}`
  const own = `${prefix}/bin/${p.name}`
  const find = async () => {
    const r = await sbx.run(`for b in ${q(own)} "$(command -v ${p.name})"; do [ -n "$b" ] && [ -x "$b" ] && echo "$b	$("$b" --version 2>/dev/null | head -1)"; done; true`)
    for (const line of r.stdout.split('\n')) {
      const [bin, v] = line.split('\t')
      if (bin && versionOf(v ?? '') === p.pin) return { bin, version: p.pin }
    }
  }
  const have = await find()
  if (have) return { ...have, installed: false }
  const r = await sbx.run(`npm install -g --prefix ${q(prefix)} --no-audit --no-fund --loglevel=error ${q(spec)}${p.npm ? ` && ${p.npm.after}` : ''}`,
    { timeoutMs: 10 * 60_000, ...(p.npm ? { env: p.npm.env } : {}) })
  if (r.exitCode !== 0) throw new Error(`byoa: could not install ${spec}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
  const now = await find()
  if (!now || now.bin !== own) throw new Error(`byoa: installed ${spec}, but ${own} does not report version ${p.pin}`)
  return { ...now, installed: true }
}
