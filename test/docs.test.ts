// V12: the README, the docs (docs/) and the agent skill (skills/byoa) name only the API that byoa has (R7.3). An agent that reads the
// skill writes the names it finds there, so a renamed method or export must fail here, not in the agent's app.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { createAgents, memoryStore, type SandboxProvider } from '../src/index.ts'

const ROOT = new URL('../', import.meta.url)
const DOCS = ['README.md', 'skills/byoa/SKILL.md', 'skills/byoa/reference/api.md',
  ...readdirSync(new URL('docs/', ROOT)).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]
const text = (p: string) => readFileSync(new URL(p, ROOT), 'utf8')
const pkg: { name: string; version: string; files: string[]; exports: Record<string, { bun: string }> } = JSON.parse(text('package.json'))
/** The package name, such as `@madeyexz/byoa`, as a regular expression with the subpath after it. */
const SPEC = `${pkg.name.replace(/[/]/g, '\\/')}(?:\\/[\\w/]+)?`

/** The source file of an import specifier such as `@madeyexz/byoa/sandbox/e2b`. */
const module = (spec: string) => import(new URL(pkg.exports[spec === pkg.name ? '.' : `.${spec.slice(pkg.name.length)}`]!.bun, ROOT).href)

test('every agents.* method in the README, the docs and the skill is one that createAgents returns', () => {
  const agents = createAgents({
    app: 'docs', sandbox: {} as SandboxProvider, store: memoryStore(), encryptionKey: randomBytes(32).toString('base64'),
    proxyUrl: 'http://127.0.0.1/byoa/mcp', oauth: { redirectUrl: 'http://127.0.0.1/byoa/callback' },
  })
  const names = new Set<string>()
  for (const p of DOCS) for (const m of text(p).matchAll(/(?<![\w/-])agents\.(\w+)/g)) names.add(m[1]!)
  // the method tables of the API reference: | `connectLogin(user, ...)` | ...
  for (const m of text('skills/byoa/reference/api.md').matchAll(/^\| `(\w+)\(/gm)) names.add(m[1]!)
  assert.ok(names.size > 10)
  assert.deepEqual([...names].filter((n) => !(n in agents)), [])
})

test('every name the README, the docs and the skill import from byoa is exported there', async () => {
  const want = new Map<string, Set<string>>()
  const add = (spec: string, name: string) => { if (!want.has(spec)) want.set(spec, new Set()); want.get(spec)!.add(name) }
  for (const p of DOCS) {
    for (const m of text(p).matchAll(new RegExp(`^import \\{([^}]+)\\} from '(${SPEC})'`, 'gm'))) {
      for (const n of m[1]!.split(',')) if (n.trim() && !n.trim().startsWith('type ')) add(m[2]!, n.trim())
    }
  }
  // the Imports table of the API reference: | `@madeyexz/byoa/sandbox/e2b` | `e2b({ ... })`, `buildE2BTemplate(...)`. Needs ...
  for (const m of text('skills/byoa/reference/api.md').matchAll(new RegExp(`^\\| \`(${SPEC})\` \\| (.+?)(?:\\. |; types|\\|)`, 'gm'))) {
    for (const n of m[2]!.matchAll(/`(\w+)[(`]/g)) add(m[1]!, n[1]!)
  }
  assert.ok(want.size >= 7, [...want.keys()].join(', '))
  const missing: string[] = []
  for (const [spec, names] of want) {
    const mod = await module(spec)
    for (const n of names) if (!(n in mod)) missing.push(`${spec}: ${n}`)
  }
  assert.deepEqual(missing, [])
})

// `npx skills experimental_sync` links the skill from node_modules, so it must ship in the package, and an agent reads its
// version from metadata.version. A release that bumps package.json must bump the skill and the pinned install in the
// README and in Getting started too.
test('the skill ships in the package, with the package version in its metadata and in each pinned install', () => {
  assert.ok(pkg.files.includes('skills'), 'package.json files')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text('skills/byoa/SKILL.md'))?.[1] ?? ''
  assert.equal(/^metadata:\n(?: {2}.*\n)*? {2}version: "([^"]+)"$/m.exec(front)?.[1], pkg.version)
  for (const p of ['README.md', 'docs/getting-started.md'])
    assert.deepEqual([...text(p).matchAll(/npx skills add madeyexz\/byoa@(\S+)/g)].map((m) => m[1]), [`v${pkg.version}`], p)
})
