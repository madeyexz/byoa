// Cloudflare Worker "byoa-site" on byoa.rippling.computer. It serves the files that build.mjs writes in site/
// (index.html, docs/, llms.txt, llms-full.txt, sitemap.xml) and site/art/ and site/fonts/, from the main branch, so a
// push that updates them (node build.mjs) updates the site with no redeploy. robots.txt and the IndexNow key are in
// this file. preview.mjs runs this Worker on the local files.
const SITE = 'https://byoa.rippling.computer'
const BASE = 'https://raw.githubusercontent.com/madeyexz/byoa/main/site/'
const TYPES = {
  html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8',
  png: 'image/png', webp: 'image/webp', woff2: 'font/woff2',
}
// every crawler and AI agent may read every page; the sitemap tells search engines what the pages are
const FIXED = {
  '/robots.txt': [TYPES.txt, `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`],
  // https://www.indexnow.org: proves to Bing and other IndexNow engines that a URL submission for this host is ours
  '/29e28059ba0b5586340a36b5f331535d.txt': [TYPES.txt, '29e28059ba0b5586340a36b5f331535d'],
}

/** The file in site/ for a path, or null: / is index.html, /docs is docs/index.html, /docs/<page> is docs/<page>.html. */
function fileOf(path) {
  if (path === '/' || path === '/index.html') return 'index.html'
  if (path === '/docs' || path === '/docs/') return 'docs/index.html'
  const page = path.match(/^\/docs\/([\w-]+)\/?$/)
  if (page) return `docs/${page[1]}.html`
  const file = path.match(/^\/((?:docs\/[\w-]+\.(?:md|json))|(?:(?:art|fonts)\/[\w.-]+)|llms\.txt|llms-full\.txt|sitemap\.xml)$/)
  return file ? file[1] : null
}
const typeOf = (file) => TYPES[file.split('.').pop()]

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (FIXED[path]) return new Response(FIXED[path][1], { headers: { 'content-type': FIXED[path][0], 'cache-control': 'public, max-age=300' } })
    // /docs/ and /docs/<page>/ have one address each
    if (path.length > 1 && path.endsWith('/') && fileOf(path)) return Response.redirect(SITE + path.slice(0, -1), 301)
    const file = fileOf(path)
    const type = file && typeOf(file)
    if (!type) return notFound()
    const r = await fetch(BASE + file, { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!r.ok) return r.status === 404 ? notFound() : new Response('byoa: the page is not available now', { status: 502 })
    return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300' } })
  },
}

function notFound() {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Not found · byoa</title><p style="font:17px system-ui;margin:80px auto;max-width:560px">This page is not on byoa's site. See <a href="/">the home page</a> or <a href="/docs">the docs</a>.</p>`,
    { status: 404, headers: { 'content-type': TYPES.html } })
}
