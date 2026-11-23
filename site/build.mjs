// Builds the byoa.rippling.computer page: the design in template.html, with the install commands from the
// README's "Install" section, so the page and the README show the same commands. It also writes llms.txt and
// llms-full.txt, the docs for LLMs, from README.md, SPEC.md, the to-do example and the agent skill.
// Run from site/: npm install && node build.mjs   → writes index.html, llms.txt and llms-full.txt
// worker.js (the Cloudflare Worker "byoa-site") serves those files, art/ and fonts/ from the main branch.
import { readFileSync, writeFileSync } from 'node:fs'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'

const REPO = 'https://github.com/madeyexz/byoa'
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
let html = readFileSync(new URL('./template.html', import.meta.url), 'utf8')

const highlighter = await createHighlighter({ themes: ['vitesse-dark'], langs: ['sh', 'text'] })
marked.use({
  renderer: {
    code({ text, lang }) {
      return highlighter.codeToHtml(text, { lang: lang || 'text', theme: 'vitesse-dark' })
    },
  },
})

// README sections by their "## " heading
const sections = Object.fromEntries(
  readme.split(/^## /m).slice(1).map((s) => {
    const i = s.indexOf('\n')
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }),
)
const section = (name, pick = (md) => md) => {
  if (!(name in sections)) throw new Error(`README.md has no "## ${name}" section`)
  const md = pick(sections[name])
  if (!md) throw new Error(`README.md's "## ${name}" section has no part to show`)
  return marked.parse(md)
}

const slots = {
  // only the commands; the README has the notes around them
  install: section('Install', (md) => md.match(/^```[\s\S]*?^```$/m)?.[0]),
  repo: REPO,
}
for (const [name, value] of Object.entries(slots)) {
  const marker = `{{${name}}}`
  if (!html.includes(marker)) throw new Error(`template.html has no ${marker}`)
  html = html.replaceAll(marker, value)
}
const left = html.match(/\{\{\w+\}\}/)
if (left) throw new Error(`template.html has an unknown slot ${left[0]}`)

writeFileSync(new URL('./index.html', import.meta.url), html)
console.log(`index.html: ${html.length} bytes`)

// ---- llms.txt (https://llmstxt.org): an index of the docs for LLMs, and llms-full.txt with their full text.
// Both come from the repository's own Markdown, so they say what the README, SPEC.md, the example and the skill say.
const SITE = 'https://byoa.rippling.computer'
const BLOB = `${REPO}/blob/main/`
const RAW = 'https://raw.githubusercontent.com/madeyexz/byoa/main/'
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pitch = readme.match(/^\*\*(.+)\*\*$/m)?.[1]
if (!pitch) throw new Error('README.md has no **pitch** line')
// GitHub's heading anchors
const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')
// one line about each README section in llms.txt; a section with none is listed by its name only
const ABOUT = {
  'Who brings what': 'what the app developer brings, what each end user brings, and where byoa runs',
  'The problem': 'the connection layer each AI-native app builds again',
  'What byoa is, and what it is not': 'a library in your own backend, not a hosted service',
  'Why byoa': "the user's plan pays, the real agents, any sandbox, connect once",
  'How it works': 'agents.run, the MCP proxy and job tokens, and a new sandbox for each job',
  'Install': 'from GitHub until version 1; Node 22.18 or later, or Bun',
  'Agent skill': 'a skill that teaches a coding agent to add byoa to an app',
  'How it will look': 'the API: createAgents, connectLogin/finishLogin, connectMcp/finishMcp, agents.run and its events, agents.session, jobToken, importMcp, fetchWithGrant, the AI login options, Daytona and Convex',
  'Test your app without a plan or a sandbox': "the fake harness, the local sandbox and memoryStore; byoa's own tests",
  'Example app': 'the to-do example on byoa',
  'How we will verify it': 'the checks that define version 1',
  'Rules we follow': "the labs' rules that byoa and every app on it follow",
  'License': 'Apache 2.0',
}
const spec = read('SPEC.md')
const last = (re) => Math.max(...[...spec.matchAll(re)].map((m) => Number(m[1])))
const install = sections['Install']
const installCode = install.match(/^```[\s\S]*?^```$/m)[0]

const llms = `# byoa

> ${pitch}

byoa is an open-source library (Apache 2.0). It runs inside the app's own backend; it is not a hosted service. ${install.split('\n')[0]}

${installCode}

## Docs

${Object.keys(sections).map((h) => `- [README: ${h}](${BLOB}README.md#${slug(h)})${ABOUT[h] ? `: ${ABOUT[h]}` : ''}`).join('\n')}
- [SPEC.md](${RAW}SPEC.md): the version 1 requirements (R1 to R${last(/^### R(\d+)\./gm)}) and the checks (V1 to V${last(/^\| V(\d+) \|/gm)})
- [SPEC.md: Lab rules](${BLOB}SPEC.md#lab-rules): what Anthropic's and OpenAI's terms allow, and what byoa and each app must do
- [Full docs](${SITE}/llms-full.txt): the README, SPEC.md, the example and the skill in one file

## Example

- [examples/todo](${RAW}examples/todo/README.md): an AI-native to-do list on byoa; its backend uses byoa in 35 lines
- [examples/todo/app.ts](${RAW}examples/todo/app.ts): all of the example's byoa code, as one fetch handler

## Agent skill

- [skills/byoa/SKILL.md](${RAW}skills/byoa/SKILL.md): teaches a coding agent (Claude Code, Codex, Amp and others) to add byoa to an app
- [skills/byoa/reference/api.md](${RAW}skills/byoa/reference/api.md): the API reference: every method, option and event

## Optional

- [CONTRIBUTING.md](${RAW}CONTRIBUTING.md): how to work on byoa
- [Source](${REPO}): the repository
`

/** A Markdown file as text for an LLM: images as their alt text, no HTML tags, links that work outside the repo. */
function plain(md, path) {
  const base = BLOB + path.replace(/[^/]*$/, '')
  return md
    .replace(/<div align="center">[\s\S]*?<\/div>\n*/g, '')                       // the README's links and badges
    .replace(/<picture>[\s\S]*?<img alt="([^"]*)"[\s\S]*?<\/picture>/g, (_, alt) => `Image: ${alt}`)
    .replace(/<img alt="([^"]*)"[^>]*>/g, (_, alt) => alt ? `Image: ${alt}` : '')
    .replace(/<h3>(.*?)<\/h3>/g, '\n### $1\n')
    .replace(/<summary>(.*?)<\/summary>/g, '$1\n')
    .replace(/<\/?(?:a|table|tr|td|details)\b[^>]*>/g, '')
    .replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, link) => `](${new URL(link, base).href})`)
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
const FULL = [
  ['README.md'],
  ['SPEC.md'],
  ['skills/byoa/SKILL.md'],
  ['skills/byoa/reference/api.md'],
  ['examples/todo/README.md'],
  ['examples/todo/app.ts', 'ts'],
]
const full = `# byoa: the full docs

> ${pitch}

This file has the full text of byoa's docs, for LLMs: ${FULL.map(([p]) => p).join(', ')}, from ${REPO} (branch main). The index is ${SITE}/llms.txt.

${FULL.map(([p, lang]) => {
  const text = read(p)
  return `---\n\nSource: ${BLOB}${p}\n\n${lang ? `\`\`\`${lang}\n${text.trim()}\n\`\`\`` : plain(text, p)}`
}).join('\n\n')}
`
for (const [name, text] of [['llms.txt', llms], ['llms-full.txt', full]]) {
  writeFileSync(new URL(`./${name}`, import.meta.url), text)
  console.log(`${name}: ${text.length} bytes`)
}
