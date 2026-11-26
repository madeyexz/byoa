// Cloudflare Worker "byoa-site" on byoa.rippling.computer. It serves the files that build.mjs writes in site/
// (index.html, demo.html, docs/, llms.txt, llms-full.txt, sitemap.xml) and site/art/ and site/fonts/ (/favicon.ico is
// art/favicon.png), from the main branch, so a push that updates them (node build.mjs) updates the site with no
// redeploy. robots.txt and the IndexNow key are in this file, and so are the PostHog counts of the Markdown routes.
// preview.mjs runs this Worker on the local files.
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

/** The file in site/ for a path, or null: / is index.html, /demo is demo.html, /docs is docs/index.html, /docs/<page> is
 *  docs/<page>.html. */
function fileOf(path) {
  if (path === '/' || path === '/index.html') return 'index.html'
  if (path === '/demo' || path === '/demo/') return 'demo.html'
  if (path === '/docs' || path === '/docs/') return 'docs/index.html'
  if (path === '/favicon.ico') return 'art/favicon.png'
  const page = path.match(/^\/docs\/([\w-]+)\/?$/)
  if (page) return `docs/${page[1]}.html`
  const file = path.match(/^\/((?:docs\/[\w-]+\.(?:md|json))|(?:(?:art|fonts)\/[\w.-]+)|llms\.txt|llms-full\.txt|sitemap\.xml)$/)
  return file ? file[1] : null
}
const typeOf = (file) => TYPES[file.split('.').pop()]
// /docs/<page>.md is a copy of /docs/<page> for LLMs: search engines should index and rank the page, not the copy
const canonicalOf = (file) => file.match(/^docs\/([\w-]+)\.md$/) && `${SITE}/docs${file === 'docs/index.md' ? '' : `/${file.slice(5, -3)}`}`

// PostHog project "rippling.computer": the HTML pages count their visits in the browser (posthog.html); the Markdown
// copies and llms.txt are read by agents and tools that run no script, so this Worker counts them as "markdown_view"
// after it answers. The token is the project's public key, which only sends events.
const POSTHOG = { host: 'https://us.i.posthog.com', token: 'phc_qW3LAJYe9hsyC9y8CjKcMJPsuxtr5Lc7S3fVWFeYagVL' }
const counted = (file) => /\.md$|^llms(-full)?\.txt$/.test(file)

function count(request, url) {
  return fetch(`${POSTHOG.host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG.token,
      event: 'markdown_view',
      distinct_id: crypto.randomUUID(),
      properties: {
        $process_person_profile: false,
        $current_url: url.href, $host: url.host, $pathname: url.pathname,
        $raw_user_agent: request.headers.get('user-agent') ?? '', $referrer: request.headers.get('referer') ?? '$direct',
        // the reader's country from Cloudflare, so PostHog does not look up the Worker's own address
        $geoip_disable: true, country: request.cf?.country ?? null,
      },
    }),
  }).catch(() => {})
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname
    if (FIXED[path]) return new Response(FIXED[path][1], { headers: { 'content-type': FIXED[path][0], 'cache-control': 'public, max-age=300' } })
    // /docs/ and /docs/<page>/ have one address each
    if (path.length > 1 && path.endsWith('/') && fileOf(path)) return Response.redirect(SITE + path.slice(0, -1), 301)
    const file = fileOf(path)
    const type = file && typeOf(file)
    if (!type) return notFound()
    const r = await fetch(BASE + file, { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!r.ok) return r.status === 404 ? notFound() : new Response('byoa: the page is not available now', { status: 502 })
    // not the docs page's own "Copy page" fetch (sec-fetch-dest: empty); the page counts that click itself
    if (counted(file) && url.host === new URL(SITE).host && request.headers.get('sec-fetch-dest') !== 'empty') ctx.waitUntil(count(request, url))
    const headers = { 'content-type': type, 'cache-control': 'public, max-age=300' }
    // GitHub's ETag, so crawlers can ask whether a page changed (Bing reads it as a freshness signal)
    const etag = r.headers.get('etag')
    if (etag) headers.etag = etag
    const canonical = canonicalOf(file)
    if (canonical) headers.link = `<${canonical}>; rel="canonical"`
    if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return new Response(r.body, { headers })
  },
}

function notFound() {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Not found · byoa</title><p style="font:17px system-ui;margin:80px auto;max-width:560px">This page is not on byoa's site. See <a href="/">the home page</a> or <a href="/docs">the docs</a>.</p>`,
    { status: 404, headers: { 'content-type': TYPES.html } })
}
