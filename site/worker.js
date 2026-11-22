// Cloudflare Worker "byoa-site" on byoa.rippling.computer. It serves site/index.html from the main branch,
// so a push that updates index.html (node build.mjs) updates the page with no redeploy.
const PAGE = 'https://raw.githubusercontent.com/madeyexz/byoa/main/site/index.html'

export default {
  async fetch() {
    const r = await fetch(PAGE, { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!r.ok) return new Response('byoa: the page is not available now', { status: 502 })
    return new Response(r.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } })
  },
}
