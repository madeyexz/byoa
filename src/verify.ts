// V11: the harness that runs is the labs' own package, unchanged (Lab rules). For each installed package, every file
// must have the same SHA-256 as the same file in the tarball the lab published on npm, and each tarball must match
// the integrity hash the registry publishes. Node only (it streams the tarballs through node:zlib).
import { createHash } from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { PACKAGES, PINS, type HarnessName, type Pins } from './harness/pins.ts'
import type { Sandbox } from './sandbox/types.ts'
import { q } from './sh.ts'

export interface VerifyResult {
  harness: HarnessName
  ok: boolean
  /** The packages checked, as name@version. */
  packages: string[]
  /** Files compared. */
  files: number
  problems: string[]
}

const REGISTRY = 'https://registry.npmjs.org'

/** path in the package (without the tarball's top folder) → SHA-256, hex. Throws if the tarball does not match the
 *  registry's integrity hash. */
export async function publishedFiles(name: string, version: string): Promise<Map<string, string>> {
  const meta = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`)
  if (!meta.ok) throw new Error(`byoa: npm has no ${name}@${version} (${meta.status})`)
  const { tarball, integrity } = ((await meta.json()) as { dist: { tarball: string; integrity: string } }).dist
  const [alg, want] = integrity.split(/-(.*)/s)
  if (alg !== 'sha512' || !want) throw new Error(`byoa: ${name}@${version}: unexpected integrity ${integrity}`)
  const res = await fetch(tarball)
  if (!res.ok || !res.body) throw new Error(`byoa: could not download ${tarball} (${res.status})`)
  const whole = createHash('sha512')
  const files = new Map<string, string>()
  await pipeline(
    Readable.fromWeb(res.body as any),
    new Transform({ transform(c, _e, cb) { whole.update(c); cb(null, c) } }),
    createGunzip(),
    tarHashes(files),
  )
  if (whole.digest('base64') !== want) throw new Error(`byoa: ${tarball} does not match the registry's integrity hash`)
  return files
}

/** A tar reader that keeps only each regular file's SHA-256. */
function tarHashes(files: Map<string, string>): Writable {
  let head = Buffer.alloc(0), remain = 0, pad = 0, done = false
  let kind: 'file' | 'meta' | 'skip' = 'skip', path = '', next = ''
  let hash = createHash('sha256'), meta: Buffer[] = []
  const strip = (p: string) => p.replace(/^\.?\/?[^/]+\//, '')
  const str = (b: Buffer, a: number, z: number) => b.subarray(a, z).toString('utf8').replace(/\0.*$/s, '')
  const endEntry = () => {
    if (kind === 'file') files.set(strip(path), hash.digest('hex'))
    if (kind === 'meta') {
      const m = Buffer.concat(meta).toString('utf8')
      if (path === 'L') next = m.replace(/\0.*$/s, '')
      else { const p = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(m); if (p) next = p[1]! }
    }
  }
  const header = (h: Buffer) => {
    if (h.every((x) => x === 0)) { done = true; return }
    const type = String.fromCharCode(h[156] || 48)
    const size = parseInt(str(h, 124, 136).trim() || '0', 8)
    const prefix = str(h, 257, 263).startsWith('ustar') ? str(h, 345, 500) : ''
    const name = next || (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100))
    if (type === 'x' || type === 'L') { kind = 'meta'; path = type === 'L' ? 'L' : 'x'; meta = [] }
    else { next = ''; path = name; kind = type === '0' || type === '7' ? 'file' : 'skip'; hash = createHash('sha256') }
    remain = size
    pad = (512 - (size % 512)) % 512
    if (remain === 0) endEntry()
  }
  return new Writable({
    write(chunk: Buffer, _e, cb) {
      let off = 0
      while (off < chunk.length && !done) {
        if (remain > 0) {
          const n = Math.min(remain, chunk.length - off), part = chunk.subarray(off, off + n)
          if (kind === 'file') hash.update(part)
          else if (kind === 'meta') meta.push(Buffer.from(part))
          off += n; remain -= n
          if (remain === 0) endEntry()
        } else if (pad > 0) {
          const n = Math.min(pad, chunk.length - off)
          off += n; pad -= n
        } else {
          const n = Math.min(512 - head.length, chunk.length - off)
          head = Buffer.concat([head, chunk.subarray(off, off + n)])
          off += n
          if (head.length === 512) { header(head); head = Buffer.alloc(0) }
        }
      }
      cb()
    },
  })
}

/** The npm package of the native binary for each harness, by package folder name prefix. */
const PLATFORM_PREFIX: Record<HarnessName, string> = { claude: 'claude-code-', codex: 'codex-' }

/** Checks the harness that `bin` (the path ensureHarness returned) runs, in the sandbox. */
export async function verifyHarness(sbx: Sandbox, h: HarnessName, bin: string, pins: Pins = PINS): Promise<VerifyResult> {
  const scope = PACKAGES[h].split('/')[0]
  const hashes = `find . -path ./node_modules -prune -o -type f -print0 | xargs -0 -r sha256sum`
  const r = await sbx.run([
    `root=$(cd "$(dirname "$(readlink -f ${q(bin)})")/.." && pwd) || exit 1`,
    `echo "== package $root"; node -p 'const p=require(process.argv[1]); p.name+"@"+p.version' "$root/package.json"; (cd "$root" && ${hashes})`,
    `for d in "$root/node_modules/${scope}/${PLATFORM_PREFIX[h]}"* "$(dirname "$root")/${PLATFORM_PREFIX[h]}"*; do`,
    `  [ -f "$d/package.json" ] || continue`,
    `  echo "== platform $d"; node -p 'const p=require(process.argv[1]); p.name+"@"+p.version' "$d/package.json"; (cd "$d" && ${hashes})`,
    `done`,
  ].join('\n'), { timeoutMs: 5 * 60_000 })
  const problems: string[] = []
  if (r.exitCode !== 0) return { harness: h, ok: false, packages: [], files: 0, problems: [`could not read the installed files: ${r.stderr.trim()}`] }

  type Pkg = { role: 'package' | 'platform'; spec: string; files: Map<string, string> }
  const pkgs: Pkg[] = []
  for (const part of r.stdout.split(/^== /m).slice(1)) {
    const [head, spec, ...lines] = part.split('\n')
    const files = new Map<string, string>()
    for (const l of lines) { const m = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(l); if (m) files.set(m[2]!, m[1]!) }
    pkgs.push({ role: head!.startsWith('package') ? 'package' : 'platform', spec: (spec ?? '').trim(), files })
  }
  const main = pkgs.find((p) => p.role === 'package')
  const plats = pkgs.filter((p) => p.role === 'platform')
  const wantMain = `${PACKAGES[h]}@${pins[h]}`
  if (main?.spec !== wantMain) problems.push(`the binary is from ${main?.spec ?? 'no package'}, not ${wantMain}`)
  // older npm (10.1 in E2B's base template) installs every native package of the platform (glibc and musl); each one
  // must be the published one
  if (plats.length === 0) problems.push('found no native package for this platform')
  if (problems.length) return { harness: h, ok: false, packages: pkgs.map((p) => p.spec), files: 0, problems }

  let files = 0
  const compare = (label: string, installed: Map<string, string>, published: Map<string, string>, replaced: Record<string, string> = {}) => {
    for (const [p, want] of published) {
      const expect = replaced[p] ?? want
      const got = installed.get(p)
      files++
      if (!got) problems.push(`${label}: ${p} is missing`)
      else if (got !== expect) problems.push(`${label}: ${p} differs from the published file`)
    }
    for (const p of installed.keys()) if (!published.has(p)) problems.push(`${label}: ${p} is not in the published package`)
  }
  const pubMain = await publishedFiles(PACKAGES[h], pins[h])
  const nativeClaude = new Set<string>()
  for (const plat of plats) {
    const at = plat.spec.lastIndexOf('@')
    const [platName, platVersion] = [plat.spec.slice(0, at), plat.spec.slice(at + 1)]
    // Claude Code's platform packages have their own names; Codex's are versions of @openai/codex (0.171.0-linux-x64)
    const platOk = h === 'claude' ? platName.startsWith(`${PACKAGES.claude}-`) && platVersion === pins.claude : platName === PACKAGES.codex && platVersion.startsWith(`${pins.codex}-`)
    if (!platOk) { problems.push(`the native package ${plat.spec} is not one of ${wantMain}`); continue }
    const pubPlat = await publishedFiles(platName, platVersion)
    compare(plat.spec, plat.files, pubPlat)
    if (pubPlat.has('claude')) nativeClaude.add(pubPlat.get('claude')!)
  }
  // Claude Code's own postinstall copies the native binary over its placeholder bin/claude.exe: it must be the
  // binary of one of the published native packages
  const exe = main!.files.get('bin/claude.exe')
  const replaced: Record<string, string> = h === 'claude' && exe && nativeClaude.has(exe) ? { 'bin/claude.exe': exe } : {}
  if (h === 'claude' && !replaced['bin/claude.exe']) problems.push(`${main!.spec}: bin/claude.exe is not the binary of a published native package`)
  compare(main!.spec, main!.files, pubMain, replaced)
  return { harness: h, ok: problems.length === 0, packages: pkgs.map((p) => p.spec), files, problems }
}
