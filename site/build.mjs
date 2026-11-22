// Builds the byoa.rippling.computer page from README.md, so the page and the README stay the same.
// Run from site/: npm install && node build.mjs   → writes index.html and worker.js
// worker.js is the Cloudflare Worker "byoa-site" that serves the page on byoa.rippling.computer.
import { readFileSync, writeFileSync } from 'node:fs'
import { marked } from 'marked'

const REPO = 'https://github.com/madeyexz/byoa'
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
// relative links (SPEC.md#verification, LICENSE) point at the repository on GitHub
const md = readme.replace(/\]\((?!https?:|#)([^)]+)\)/g, `](${REPO}/blob/main/$1)`)
const body = marked.parse(md)

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>byoa: bring your own agent</title>
<meta name="description" content="An open-source library that runs your users' own Claude Code or Codex in any sandbox, with their MCPs and skills.">
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #fbfbf8; --code: #f0efe9; --line: #e2e0d8; --accent: #b4441f; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecebe6; --muted: #a3a29c; --bg: #151513; --code: #1f1f1c; --line: #33322d; --accent: #f08a5d; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 56px 24px 96px; }
  h1 { font-size: 2.4rem; line-height: 1.15; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 1.35rem; margin: 48px 0 12px; padding-top: 16px; border-top: 1px solid var(--line); }
  p, li { color: var(--fg); }
  strong { font-weight: 650; }
  a { color: var(--accent); }
  code { font: 0.88em/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.35; font-family: Menlo, "DejaVu Sans Mono", Consolas, ui-monospace, monospace; }
  footer { margin-top: 64px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
${body}
<footer><a href="${REPO}">${REPO.replace('https://', '')}</a> · built from README.md</footer>
</main>
</body>
</html>
`

writeFileSync(new URL('./index.html', import.meta.url), html)
writeFileSync(new URL('./worker.js', import.meta.url),
  `const HTML = ${JSON.stringify(html)};\nexport default { fetch: () => new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } }) };\n`)
console.log(`index.html and worker.js: ${html.length} bytes`)
