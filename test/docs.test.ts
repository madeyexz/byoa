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

// The README's price table shows what the home page's price bars show (site/build.mjs, priceBars), from the cost tables of
// docs/faq.md: 100 tasks, the frontier models and the smaller ones at API prices, and byoa on the first sandbox provider.
test('the README price table and its task have the numbers of the FAQ cost tables', () => {
  const faq = text('docs/faq.md'), readme = text('README.md')
  const num = (s: string) => Number(s.replace(/,/g, ''))
  const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`)
  const [, uncached, cached, output] = /^\| Model \| Kind \| ([\d,]+) uncached input \| ([\d,]+) cached input \| ([\d,]+) output \|/m.exec(faq)!.map(num)
  const minutes = num(/^\| Provider \|.*\| One task \(([\d.]+) minutes\) \|$/m.exec(faq)![1]!)
  const [, cpu, gib] = /^\*\*The sandbox,\*\* (\d+) vCPU and (\d+) GiB/m.exec(faq)!
  const models = [...faq.matchAll(/^\| ([^|(]+?) \(\$([\d.]+) in, \$([\d.]+) cached, \$([\d.]+) out\) \| (\w[\w, -]*?) \|/gm)]
    .map((m) => ({ name: m[1]!, frontier: m[5]!.startsWith('frontier'), n: 100 * (uncached! * num(m[2]!) + cached! * num(m[3]!) + output! * num(m[4]!)) / 1e6 }))
    .sort((a, b) => a.n - b.n)
  const box = /^\| (\w+) \([^)]*\) \| \$[\d.]+ \| \$[\d.]+ \| \$([\d.]+) \|/m.exec(faq)!
  const row = (label: string, list: typeof models) => `| ${label} (${list.length > 1 ? `${list[0]!.name} to ${list.at(-1)!.name}` : list[0]!.name}) | ${usd(list[0]!.n)}${list.length > 1 ? `–${usd(list.at(-1)!.n)}` : ''} |`
  const table = [
    '| How your app gets the AI | Each user pays a month |', '|---|---|',
    row('Frontier models at API rates', models.filter((m) => m.frontier)),
    row('Cheaper models at API rates', models.filter((m) => !m.frontier)),
    `| **byoa, on the user's own plan** (the sandbox on ${box[1]}) | **${usd((100 * num(box[2]!) * minutes) / 60)}** + their plan |`,
  ].join('\n')
  assert.ok(readme.includes(`for 100 small agent tasks:\n\n${table}\n`), `README.md should have this table:\n${table}`)
  const task = `One task is about ${(uncached! + cached!).toLocaleString('en-US')} input tokens (${Math.round((100 * cached!) / (uncached! + cached!))}% cached) and ${output!.toLocaleString('en-US')} output tokens, and ${minutes} minutes of a sandbox with ${cpu} vCPU and ${gib} GiB.`
  assert.ok(readme.includes(task), `README.md should say: ${task}`)
})
