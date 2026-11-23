// Cloudflare Worker "byoa-site" on byoa.rippling.computer. It serves site/index.html, site/llms.txt,
// site/llms-full.txt, site/art/ and site/fonts/ from the main branch, so a push that updates them (node build.mjs)
// updates the site with no redeploy. robots.txt, sitemap.xml and the IndexNow key are in this file.
const SITE = 'https://byoa.rippling.computer'
const BASE = 'https://raw.githubusercontent.com/madeyexz/byoa/main/site/'
const TYPES = { png: 'image/png', webp: 'image/webp', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8' }
// every crawler and AI agent may read every page; the sitemap tells search engines what the pages are
const FIXED = {
  '/robots.txt': [TYPES.txt, `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`],
  '/sitemap.xml': ['application/xml; charset=utf-8', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/', '/llms.txt', '/llms-full.txt'].map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join('\n')}
</urlset>
`],
  // https://www.indexnow.org: proves to Bing and other IndexNow engines that a URL submission for this host is ours
  '/29e28059ba0b5586340a36b5f331535d.txt': [TYPES.txt, '29e28059ba0b5586340a36b5f331535d'],
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (FIXED[path]) return new Response(FIXED[path][1], { headers: { 'content-type': FIXED[path][0], 'cache-control': 'public, max-age=300' } })
    // /llms.txt, /llms-full.txt, /art/<file> and /fonts/<file> are files; every other path is the page
    const asset = path.match(/^\/((?:(?:art|fonts)\/[\w.-]+|llms|llms-full)\.(\w+))$/)
    const type = asset ? TYPES[asset[2]] : 'text/html; charset=utf-8'
    if (!type) return new Response('Not found', { status: 404 })
    const r = await fetch(BASE + (asset ? asset[1] : 'index.html'), { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!r.ok) return asset ? new Response('Not found', { status: 404 }) : new Response('byoa: the page is not available now', { status: 502 })
    return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300' } })
  },
}
