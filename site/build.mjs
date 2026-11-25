// Builds byoa.rippling.computer from the repository's own files:
// - index.html, the home page: the design in template.html, with the install commands from the README's "Install"
//   section and the "Who brings what" diagram in diagrams/who.html;
// - docs/<page>.html, the docs: each Markdown file in ../docs, in docs.html. ../docs/README.md is the docs home and its
//   list of pages is the menu. A ```flow block of YAML is a flow diagram (see "Flow diagrams" in CONTRIBUTING.md), and
//   `<!-- include: ../FILE.md#section -->` puts in another file's text, so each fact has one source;
// - docs/<page>.md, the same pages as Markdown for LLMs, with each diagram as text, and llms.txt and llms-full.txt
//   (https://llmstxt.org) from them, SPEC.md, the to-do example and the agent skill;
// - sitemap.xml.
// Run from site/: npm install && node build.mjs. worker.js (the Cloudflare Worker "byoa-site") serves these files,
// art/ and fonts/ from the main branch. To see the site as the Worker serves it: node preview.mjs.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Marked } from 'marked'
import { createHighlighter } from 'shiki'
import YAML from 'yaml'

const REPO = 'https://github.com/madeyexz/byoa'
const SITE = 'https://byoa.rippling.computer'
const BLOB = `${REPO}/blob/main/`
const TREE = `${REPO}/tree/main/`
const RAW = 'https://raw.githubusercontent.com/madeyexz/byoa/main/'
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const local = (path) => readFileSync(new URL(`./${path}`, import.meta.url), 'utf8')
const write = (path, text) => { writeFileSync(new URL(`./${path}`, import.meta.url), text); console.log(`${path}: ${text.length} bytes`) }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fill = (template, slots, name) => {
  let html = template
  for (const [slot, value] of Object.entries(slots)) {
    const marker = `{{${slot}}}`
    if (!html.includes(marker)) throw new Error(`${name} has no ${marker}`)
    html = html.replaceAll(marker, () => value)
  }
  const left = html.match(/\{\{\w+\}\}/)
  if (left) throw new Error(`${name} has an unknown slot ${left[0]}`)
  return html
}

const readme = read('README.md')
const baseCss = local('base.css')
const who = local('diagrams/who.html')
const highlighter = await createHighlighter({ themes: ['vitesse-dark'], langs: ['sh', 'text', 'ts', 'js', 'json', 'sql', 'toml'] })
const code = (text, lang) => highlighter.codeToHtml(text, { lang: highlighter.getLoadedLanguages().includes(lang) ? lang : 'text', theme: 'vitesse-dark' })

// ---- the home page
const sections = Object.fromEntries(
  readme.split(/^## /m).slice(1).map((s) => {
    const i = s.indexOf('\n')
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }),
)
if (!('Install' in sections)) throw new Error('README.md has no "## Install" section')
const install = sections['Install']
const installCode = install.match(/^```[\s\S]*?^```$/m)?.[0]
if (!installCode) throw new Error('README.md\'s "## Install" section has no code block')
const pitch = readme.match(/^\*\*(.+)\*\*$/m)?.[1]
if (!pitch) throw new Error('README.md has no **pitch** line')

write('index.html', fill(local('template.html'), {
  base_css: baseCss,
  who,
  // only the commands; the README has the notes around them
  install: code(installCode.replace(/^```\w*\n|\n```$/g, ''), 'sh'),
  repo: REPO,
}, 'template.html'))

// ---- the docs
// GitHub's heading anchors, so a link such as ai-login.md#sign-out works on GitHub and on the site
const slug = (h) => h.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')
const plainText = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

// The menu: each "## " group of docs/README.md, and its list of pages: - [Title](file.md): what the page has
const index = read('docs/README.md')
const groups = index.split(/^## /m).slice(1).map((s) => ({
  name: s.slice(0, s.indexOf('\n')).trim(),
  pages: [...s.matchAll(/^- \[([^\]]+)\]\(([\w-]+)\.md\): (.+)$/gm)].map(([, title, file, about]) => ({ title, file, about })),
})).filter((g) => g.pages.length)
const PAGES = [{ title: 'Introduction', file: 'README', about: index.match(/^# .+\n\n(.+)$/m)?.[1] ?? '', group: '' },
  ...groups.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.name })))]
const onDisk = readdirSync(new URL('../docs/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
for (const f of onDisk) if (!PAGES.some((p) => p.file === f)) throw new Error(`docs/${f}.md is not in the list of pages in docs/README.md`)
for (const p of PAGES) if (!onDisk.includes(p.file)) throw new Error(`docs/README.md lists ${p.file}.md, which is not in docs/`)
const pageUrl = (file) => (file === 'README' ? '/docs' : `/docs/${file}`)
const mdUrl = (file) => `/docs/${file === 'README' ? 'index' : file}.md`

/** A link in docs/*.md, relative to docs/, as a URL on the site (html) or a URL for an LLM (md). */
function resolveLink(href, kind) {
  if (/^([a-z]+:|#|\/)/i.test(href)) return href
  const [path, hash = ''] = href.split('#')
  const repoPath = new URL(path, 'file:///r/docs/').pathname.slice(3) // relative to the repository root
  const anchor = hash ? `#${hash}` : ''
  const page = repoPath.match(/^docs\/([\w-]+)\.md$/)?.[1]
  if (page) return (kind === 'md' ? SITE + mdUrl(page) : pageUrl(page)) + anchor
  // files whose text is a docs page
  const into = { 'skills/byoa/reference/api.md': 'api', 'SECURITY.md': 'security' }[repoPath]
  if (into) return (kind === 'md' ? SITE + mdUrl(into) : pageUrl(into)) + anchor
  if (repoPath === 'README.md' && !hash) return kind === 'md' ? `${SITE}/llms.txt` : '/'
  return (/(^|\/)[^/.]+\/?$/.test(repoPath) ? TREE : BLOB) + repoPath.replace(/\/$/, '') + anchor
}

/** Markdown links in `md`, written relative to `from` (a path from the repository root), made relative to docs/. */
function rebase(md, from) {
  const dir = new URL('.', `file:///r/${from}`)
  return md.replace(/\]\((?![a-z]+:|#|\/)([^)\s]+)\)/gi, (_, link) => {
    const [path, hash] = link.split('#')
    const abs = new URL(path, dir).pathname.slice(3)
    const rel = abs.startsWith('docs/') ? abs.slice(5) : `../${abs}`
    return `](${rel}${hash ? `#${hash}` : ''})`
  })
}

/** `<!-- include: ../FILE.md -->` or `<!-- include: ../FILE.md#section-anchor -->`: that file's text (without its
 * "# " title) or that section's text (without its heading), with its links made relative to docs/. */
function includes(md) {
  return md.replace(/^<!-- include: (\S+?)(?:#([\w-]+))? -->$/gm, (_, path, anchor) => {
    const from = new URL(path, 'file:///r/docs/').pathname.slice(3)
    let text = read(from)
    if (anchor) {
      const parts = text.split(/^(?=#{1,6} )/m)
      const i = parts.findIndex((p) => slug(p.match(/^#+ (.+)/)?.[1] ?? '') === anchor)
      if (i < 0) throw new Error(`${from} has no section #${anchor}`)
      const level = parts[i].match(/^#+/)[0].length
      let end = i + 1
      while (end < parts.length && parts[end].match(/^#+/)[0].length > level) end++
      text = parts.slice(i, end).join('').replace(/^.+\n/, '')
    } else text = text.replace(/^# .+\n/, '')
    return rebase(text.trim(), from)
  })
}

// ---- flow diagrams: a ```flow block of YAML
// nodes: a list. Each node has one of step, if (a question), end or warn, as its title, and may have:
//   text: more words. time: a time limit, or a list of them. files: in, out or removed: the user's login files in the
//   sandbox from this node on (the line is blue while they are in). id: a name for back, join and goto.
//   then: the label of the way down from an if (default "yes"). side: a node to the right, with label (the label of the
//   line to it), and back (a node id it goes back to, with back-label) or join (a node id it goes on to).
//   goto: { to: id, label }: a line from an if to a side node of a later node.
// Or tabs: a list of { tab: its name, text, nodes }. title: what the whole diagram shows, for screen readers and LLMs.
const FILES = { in: 'login files in', out: 'no login files', removed: 'files removed' }
function flowSpec(src) {
  const spec = YAML.parse(src)
  const tabs = spec.tabs ?? [{ nodes: spec.nodes }]
  let n = 0
  const node = (x, where) => {
    const k = ['step', 'if', 'end', 'warn'].find((k) => k in x)
    if (!k) throw new Error(`a flow node needs step, if, end or warn: ${JSON.stringify(x)}`)
    const o = { id: String(x.id ?? `n${n++}`), k: k === 'if' ? 'dec' : k, title: String(x[k]), text: x.text ? String(x.text) : '', time: [].concat(x.time ?? []).map(String) }
    if (x.files) { if (!FILES[x.files]) throw new Error(`files is in, out or removed: ${where}`); o.files = x.files }
    if (k === 'if') o.down = String(x.then ?? 'yes')
    if (x.side) o.side = { ...node(x.side, where), label: String(x.side.label ?? ''), back: x.side.back, backLabel: x.side['back-label'], join: x.side.join }
    if (x.goto) o.goto = { to: String(x.goto.to), label: String(x.goto.label ?? '') }
    return o
  }
  return { title: spec.title ? String(spec.title) : '', tabs: tabs.map((t, i) => ({ tab: t.tab ? String(t.tab) : '', text: t.text ? String(t.text) : '', nodes: (t.nodes ?? []).map((x) => node(x, `tab ${i + 1}`)) })) }
}
function flowHtml(src, inline) {
  const spec = flowSpec(src)
  const chips = (o) => (o.files ? `<span class="f-${o.files}">${FILES[o.files]}</span>` : '') + o.time.map((t) => `<span class="tb">${inline(t)}</span>`).join('')
  const data = (o) => ({
    id: o.id, k: o.k, t: inline(o.title), d: o.text ? inline(o.text) : '', m: chips(o), ...(o.files ? { f: o.files === 'in' } : {}),
    ...(o.down ? { down: o.down } : {}), ...(o.goto ? { right: { to: o.goto.to, label: o.goto.label } } : {}),
    ...(o.side ? { side: { ...data(o.side), label: o.side.label, back: o.side.back, backLabel: o.side.backLabel, join: o.side.join } } : {}),
  })
  // without JavaScript, on a phone, and for screen readers: the same steps as a list
  const side = (s) => `<ul><li><i>${esc(s.label || 'then')}</i><b>${inline(s.title)}</b>${s.text ? inline(s.text) : ''}${chips(s) ? ` <span class="nm">${chips(s)}</span>` : ''}${s.back ? ` Then ${esc(s.backLabel ?? 'go back')}.` : ''}</li></ul>`
  const list = (nodes) => {
    let on = false
    return nodes.map((o) => {
      if (o.files) on = o.files === 'in'
      return `<li class="k-${o.k}${on && o.k !== 'end' ? ' on' : ''}"><b>${inline(o.title)}</b>${o.text ? inline(o.text) : ''}${chips(o) ? ` <span class="nm">${chips(o)}</span>` : ''}${o.side ? side(o.side) : ''}</li>`
    }).join('')
  }
  const all = spec.tabs.flatMap((t) => t.nodes.flatMap((o) => (o.side ? [o, o.side] : [o])))
  const usesFiles = all.some((o) => o.files)
  // the legend has only the keys this diagram uses
  const legend = [usesFiles && '<span class="lg on">login files in the sandbox</span><span class="lg">no login files</span>',
    all.some((o) => o.k === 'dec') && '<span class="lg dia">a question</span>', all.some((o) => o.time.length) && '<span class="lg tb">time limit</span>'].filter(Boolean).join('')
  const tabs = spec.tabs.length > 1
    ? `<div class="seg" role="tablist">${spec.tabs.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${i}">${inline(t.tab)}</button>`).join('')}</div>` : ''
  return `<figure class="flow"${spec.title ? ` aria-label="${esc(spec.title)}"` : ''}>
${legend ? `<div class="legend">${legend}</div>` : ''}
${tabs}${spec.tabs.map((t, i) => `<div class="tabp" data-tab="${i}"${i ? ' hidden' : ''}>${t.text ? `<p class="tabnote">${inline(t.text)}</p>` : ''}<ol class="flow-list">${list(t.nodes)}</ol><div class="flow-draw" data-nodes="${esc(JSON.stringify(t.nodes.map(data)))}"></div></div>`).join('')}
</figure>`
}
/** A flow as Markdown text, for LLMs and the .md pages. */
function flowText(src) {
  const spec = flowSpec(src)
  const ids = new Map()
  const out = []
  if (spec.title) out.push(`Diagram: ${spec.title}`)
  for (const t of spec.tabs) {
    t.nodes.forEach((o, i) => ids.set(o.id, `step ${i + 1}`))
    if (t.tab) out.push('', `${t.tab}${t.text ? `: ${t.text}` : ''}`)
    out.push('')
    const sentence = (s) => (/[.?!:)]$/.test(s) ? s : `${s}.`)
    const one = (o) => [
      o.k === 'dec' ? `Question: ${o.title}` : o.k === 'end' ? `${sentence(o.title)} This is the end.` : o.k === 'warn' ? `Warning: ${o.title}` : o.title,
      o.text, o.time.length ? `Time limit: ${o.time.join('; ')}` : '', o.files ? `Login files: ${FILES[o.files]}` : '',
    ].filter(Boolean).map(sentence).join(' ')
    t.nodes.forEach((o, i) => {
      out.push(`${i + 1}. ${one(o)}${o.k === 'dec' ? ` If ${o.down}: go on to step ${i + 2}.` : ''}${o.goto ? ` If ${o.goto.label}: see "${t.nodes.find((x) => x.side?.id === o.goto.to)?.side.title}" below.` : ''}`)
      if (o.side) {
        const s = o.side
        out.push(`   - ${s.label ? `If ${s.label}` : 'Then'}: ${one(s)}${s.back ? ` Then ${s.backLabel ?? 'back'}: back to ${ids.get(s.back)}.` : ''}${s.join ? ` Then go on to ${ids.get(s.join)}.` : ''}`)
      }
    })
  }
  return out.join('\n')
}

// The ASCII text of the "Who brings what" diagram: its wide version without the colours
const whoText = plainText(who.match(/<pre class="ascii wide"[^>]*>([\s\S]*?)<\/pre>/)[1])
const whoAlt = plainText(who.match(/aria-label="([^"]*)"/)[1])
// `<!-- diagram: who -->` and the image on the line after it (for GitHub): the diagram of the home page
const DIAGRAM = /^<!-- diagram: who -->\n(?:!\[[^\]]*\]\([^)]*\)\n)?/m

let page // the page that the renderer is on: its headings
const md = new Marked({
  renderer: {
    code({ text, lang }) {
      if (lang === 'flow') return flowHtml(text, (s) => md.parseInline(String(s)))
      return `<div class="code">${code(text, lang)}</div>`
    },
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens)
      let id = slug(plainText(html))
      for (let i = 1; page.ids.has(id); i++) id = `${slug(plainText(html))}-${i}`
      page.ids.add(id)
      page.heads.push({ depth, id })
      if (depth === 2) page.toc.push({ id, html })
      if (depth === 1) return `<h1>${html}</h1>\n`
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>\n`
    },
    link({ href, title, tokens }) {
      const url = resolveLink(href, 'html')
      return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}${/^https?:/.test(url) && !url.startsWith(SITE) ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`
    },
    table(token) {
      return `<div class="tbl">${this.constructor.prototype.table.call(this, token)}</div>`
    },
  },
})

/** "the list: what it has" → "The list: what it has." */
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.?!]$/.test(s) ? '' : '.')

/** Type parameters such as AsyncGenerator<AgentEvent> outside code, as text: Markdown would take them for HTML tags. */
const escapeTypes = (text) => text.split(/(^```[\s\S]*?^```$|`[^`\n]*`)/m).map((part, i) => (i % 2 ? part : part.replace(/<([A-Z]\w*(?:\[\])?)>/g, '&lt;$1&gt;'))).join('')

/** A docs page as Markdown for LLMs: its includes, each diagram as text, and links that work outside the site. */
function pageMarkdown(text) {
  return text
    .replace(DIAGRAM, () => `Diagram: ${whoAlt}\n\n\`\`\`text\n${whoText.replace(/\n$/, '')}\n\`\`\`\n`)
    .replace(/^```flow\n([\s\S]*?)^```$/gm, (_, src) => flowText(src))
    .split(/(^```[\s\S]*?^```$)/m)
    .map((part, i) => (i % 2 ? part : part.replace(/\]\(([^)\s]+)\)/g, (_, link) => `](${resolveLink(link, 'md')})`)))
    .join('')
    .replace(/^<!--.*-->\n/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const docsTemplate = local('docs.html')
const docsJs = local('docs.js')
rmSync(new URL('./docs/', import.meta.url), { recursive: true, force: true })
mkdirSync(new URL('./docs/', import.meta.url))
const markdown = {}
const search = [] // search.json: one entry for each section of each page, for the search box (docs.js)
for (const [i, p] of PAGES.entries()) {
  const source = includes(read(`docs/${p.file}.md`))
  markdown[p.file] = pageMarkdown(source)
  page = { ids: new Set(), toc: [], heads: [] }
  const title = source.match(/^# (.+)$/m)?.[1]
  if (!title) throw new Error(`docs/${p.file}.md has no "# " title`)
  // under the title, as a lead: what the page has, from its line in the list of pages (docs/README.md)
  // no lead on the docs home, and on Getting started, whose first paragraph says it
  const lead = ['README', 'getting-started'].includes(p.file) ? '' : `<p class="lead">${md.parseInline(sentence(p.about))}</p>\n`
  const content = md.parse(escapeTypes(source).replace(DIAGRAM, '\n@@who@@\n\n'))
    .replace('<p>@@who@@</p>', `<figure class="diagram strings">${who}</figure>`)
    .replace('</h1>\n', () => `</h1>\n${lead}`)
  const nav = groups.map((g) => `<div class="ng">${esc(g.name)}</div><ul>${g.pages.map((x) => `<li><a href="${pageUrl(x.file)}"${x.file === p.file ? ' aria-current="page"' : ''}>${esc(x.title)}</a></li>`).join('')}</ul>`).join('')
  const navAll = `<ul><li><a href="/docs"${p.file === 'README' ? ' aria-current="page"' : ''}>Introduction</a></li></ul>${nav}`
  const prev = PAGES[i - 1], next = PAGES[i + 1]
  const pn = [prev && `<a class="prev" href="${pageUrl(prev.file)}"><span>Previous</span>${esc(prev.title)}</a>`, next && `<a class="next" href="${pageUrl(next.file)}"><span>Next</span>${esc(next.title)}</a>`].filter(Boolean).join('')
  const plainTitle = plainText(md.parseInline(title))
  const html = fill(docsTemplate, {
    base_css: baseCss,
    title: esc(p.file === 'README' ? 'byoa docs' : `${plainTitle} · byoa docs`),
    description: esc(plainText(md.parseInline(p.about))),
    url: SITE + pageUrl(p.file),
    md: mdUrl(p.file),
    nav: navAll,
    kick: esc(p.group || 'Docs'),
    content,
    toc: page.toc.length > 1 ? `<div class="toc-h">On this page</div><ul>${page.toc.map((h) => `<li><a href="#${h.id}">${h.html.replace(/<a [^>]*>|<\/a>/g, '')}</a></li>`).join('')}</ul>` : '',
    pn,
    source: `${BLOB}docs/${p.file}.md`,
    repo: REPO,
    docs_js: docsJs,
  }, 'docs.html')
  const name = p.file === 'README' ? 'index' : p.file
  writeFileSync(new URL(`./docs/${name}.html`, import.meta.url), html)
  writeFileSync(new URL(`./docs/${name}.md`, import.meta.url), `${markdown[p.file]}\n`)
  // the sections of the page, as the page shows them: the ids of its headings, and its text without Markdown
  const ids = page.heads.filter((h) => h.depth === 2 || h.depth === 3).map((h) => h.id)
  let n = 0
  for (const part of markdown[p.file].replace(/^```[\s\S]*?^```$/gm, ' ').split(/^(?=#{1,3} )/m)) {
    const head = part.match(/^(#{1,3}) (.+)/)
    const text = part.replace(/^.*\n/, head ? '' : '$&').replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*|]/g, '').replace(/^[#>]+ ?/gm, '').replace(/\s+/g, ' ').trim()
    const depth = head?.[1].length ?? 1
    const id = depth > 1 ? ids[n++] : ''
    search.push({ page: plainTitle, head: head ? plainText(md.parseInline(escapeTypes(head[2]))) : plainTitle, url: pageUrl(p.file) + (id ? `#${id}` : ''), text: text.slice(0, 1500) })
  }
}
write('docs/search.json', JSON.stringify(search))
console.log(`docs/: ${PAGES.length} pages`)

// ---- llms.txt: an index of the docs for LLMs, and llms-full.txt with their full text
const spec = read('SPEC.md')
const last = (re) => Math.max(...[...spec.matchAll(re)].map((m) => Number(m[1])))
const llms = `# byoa

> ${pitch}

byoa is an open-source library (Apache 2.0). It runs inside the app's own backend; it is not a hosted service. ${install.split('\n')[0]}

${installCode}

${groups.map((g) => `## ${g.name}\n\n${g.pages.map((p) => `- [${p.title}](${SITE}${mdUrl(p.file)}): ${p.about}`).join('\n')}`).join('\n\n')}

## Spec

- [SPEC.md](${RAW}SPEC.md): the version 1 requirements (R1 to R${last(/^### R(\d+)\./gm)}) and the checks (V1 to V${last(/^\| V(\d+) \|/gm)})
- [Full docs](${SITE}/llms-full.txt): the docs, SPEC.md, the example and the skill in one file

## Example

- [examples/todo](${RAW}examples/todo/README.md): an AI-native to-do list on byoa; its backend uses byoa in 35 lines
- [examples/todo/app.ts](${RAW}examples/todo/app.ts): all of the example's byoa code, as one fetch handler

## Agent skill

- [skills/byoa/SKILL.md](${RAW}skills/byoa/SKILL.md): teaches a coding agent (Claude Code, Codex, Amp and others) to add byoa to an app

## Optional

- [Docs home](${SITE}${mdUrl('README')}): the list of docs pages
- [CONTRIBUTING.md](${RAW}CONTRIBUTING.md): how to work on byoa
- [Source](${REPO}): the repository
`

/** A Markdown file of the repository as text for an LLM: links that work outside the repository. */
function plain(text, path) {
  const base = BLOB + path.replace(/[^/]*$/, '')
  return text.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, link) => `](${new URL(link, base).href})`).trim()
}
const FULL = [
  ...PAGES.map((p) => [`docs/${p.file}.md`, `${SITE}${pageUrl(p.file)}`, markdown[p.file]]),
  ['SPEC.md'],
  ['skills/byoa/SKILL.md'],
  ['examples/todo/README.md'],
  ['examples/todo/app.ts', '', '', 'ts'],
]
const full = `# byoa: the full docs

> ${pitch}

This file has the full text of byoa's docs, for LLMs: the docs pages (${SITE}/docs), SPEC.md, the agent skill and the to-do example, from ${REPO} (branch main). The index is ${SITE}/llms.txt.

${FULL.map(([p, url, text, lang]) => {
  const body = text ?? (lang ? `\`\`\`${lang}\n${read(p).trim()}\n\`\`\`` : plain(read(p), p))
  return `---\n\nSource: ${url || BLOB + p}\n\n${text || body}`
}).join('\n\n')}
`
write('llms.txt', llms)
write('llms-full.txt', full)

// ---- sitemap.xml: the pages for search engines
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/', ...PAGES.map((p) => pageUrl(p.file)), '/llms.txt', '/llms-full.txt'].map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n')}
</urlset>
`)
