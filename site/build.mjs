// Builds the byoa.rippling.computer page: the design in template.html, with the first code block of the
// README's "How it will look" section, so the page and the README show the same code.
// Run from site/: npm install && node build.mjs   → writes index.html
// worker.js (the Cloudflare Worker "byoa-site") serves that file, art/ and fonts/ from the main branch.
import { readFileSync, writeFileSync } from 'node:fs'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'

const REPO = 'https://github.com/madeyexz/byoa'
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
let html = readFileSync(new URL('./template.html', import.meta.url), 'utf8')

const highlighter = await createHighlighter({ themes: ['vitesse-dark'], langs: ['ts', 'text'] })
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
  // only the main example; the README has the notes and the other examples
  code: section('How it will look', (md) => md.match(/^```[\s\S]*?^```$/m)?.[0]),
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
