// Cloudflare Worker "byoa-site" on byoa.rippling.computer. It serves site/index.html, site/llms.txt,
// site/llms-full.txt, site/art/ and site/fonts/ from the main branch, so a push that updates them (node build.mjs)
// updates the site with no redeploy.
const BASE = 'https://raw.githubusercontent.com/madeyexz/byoa/main/site/'
const TYPES = { png: 'image/png', webp: 'image/webp', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8' }

export default {
  async fetch(request) {
    // /llms.txt, /llms-full.txt, /art/<file> and /fonts/<file> are files; every other path is the page
    const asset = new URL(request.url).pathname.match(/^\/((?:(?:art|fonts)\/[\w.-]+|llms|llms-full)\.(\w+))$/)
    const type = asset ? TYPES[asset[2]] : 'text/html; charset=utf-8'
    if (!type) return new Response('Not found', { status: 404 })
    const r = await fetch(BASE + (asset ? asset[1] : 'index.html'), { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!r.ok) return asset ? new Response('Not found', { status: 404 }) : new Response('byoa: the page is not available now', { status: 502 })
    return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300' } })
  },
}
