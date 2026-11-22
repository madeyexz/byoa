#!/usr/bin/env bash
# Captures the README's images from the built page (index.html), so the README and the page look the same.
# Run from site/ after `node build.mjs`:  ./readme-art.sh   → writes ../.github/readme/*.png
# Needs agent-browser (preinstalled in Amp orbs), python3 and ImageMagick.
# Each image is captured at 2x, in light (the page) and dark (the same page on navy) where GitHub shows both.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../.github/readme
PORT=8765
mkdir -p "$OUT"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER; agent-browser close >/dev/null 2>&1 || true' EXIT
sleep 1

ab() { agent-browser "$@" >/dev/null; }

# For the README: no animation, no nav or buttons, no section headings (the README has its own), a shorter hero.
README_CSS='
  *, *::before, *::after { animation: none !important; transition: none !important; }
  nav.top, .hero .cta, .hero .note, .swipe, .end .cta, .end p { display: none !important; }
  .hero .frame { min-height: 0; padding: 84px 24px 176px; }
  #who .ascii-wrap { padding: 36px 28px 40px; }
  .life { margin-top: 0; }
  .life > .kick, .life > h3, .life > .sub { display: none; }
  body { background: var(--paper); }
'
# The dark version: the page's palette on the navy of its closing band.
DARK_CSS='
  :root { --paper: #0f1124; --paper2: #151833; --card: #161a36; --rule: #2a2f57; --rule2: #3c4274;
    --ink: #f3f1ea; --ink2: #c9cadc; --muted: #9195b6; --dim: #6b6f90; --peri2: #232a5c; }
  .badge.plan, .hot + text, .d-ct.k { color: #141418; fill: #141418; }
  .kick, .steps .n, .d-lbl.c, .d-code { color: var(--peri); fill: var(--peri); }
  .ascii .x, .ascii .o, .ascii .bn, .ascii .bs { color: var(--peri); }
  .ascii .p, .d-fl.tom { color: var(--tomato); fill: var(--tomato); }
  .d-box.store { fill: #12352a; }
  .d-fl.but { fill: var(--butter); }
'

# shot <file> <selector>: one element at 2x. (agent-browser's element screenshot is blank below the first
# screen, so scroll the element to the top, take the screen and crop it.)
shot() {
  local box
  box=$(agent-browser eval "(() => { const e = document.querySelector('$2'); e.scrollIntoView({ block: 'start', behavior: 'instant' });
    const b = e.getBoundingClientRect(), r = devicePixelRatio; return [b.width, b.height, b.x, b.y].map((v) => Math.round(v * r)).join(' ') })()" | tr -d '"')
  set -- "$1" $box
  ab screenshot /tmp/readme-art-screen.png
  magick /tmp/readme-art-screen.png -crop "$2x$3+$4+$5" +repage "$OUT/$1.png"
  echo "$OUT/$1.png"
}

page() { # page <theme>: open the page at 1200 x 1000, 2x, with the README styles
  ab open "http://127.0.0.1:$PORT/index.html"
  ab set viewport 1200 1000 2
  local css="$README_CSS"
  [ "$1" = dark ] && css="$css$DARK_CSS"
  printf '%s' "$css" | node -e '
    const css = require("fs").readFileSync(0, "utf8")
    process.stdout.write(`const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.append(s);
      const w = document.createElement("div"); w.id = "readme-banner"; const h = document.querySelector("header.hero");
      h.before(w); w.append(h, document.querySelector("section.targets")); document.fonts.ready.then(() => true)`)
  ' | agent-browser eval --stdin >/dev/null
  ab wait 800
}

for theme in light dark; do
  page "$theme"
  shot "banner-$theme" '#readme-banner'
  shot "who-$theme" '#who .ascii-wrap'
  shot "how-$theme" '#how .diagram'
  shot "tokens-$theme" '#tokens .diagram'
  shot "lifecycle-$theme" '#tokens .life'
  shot "scope-$theme" '#scope .scope'
done

# The same in both themes: the illustrated "Why" panels and the closing band.
page light
ab set viewport 1600 1100 2   # wider, so the panels' cards have the room they have on the page
for row in plan agents sandbox connect; do shot "why-$row" "#why-$row .panel"; done
shot end '.end'

# The social preview: 1280 x 640 at 2x (GitHub: Settings → General → Social preview)
ab set viewport 1280 640 2
agent-browser eval --stdin >/dev/null <<'JS'
document.head.append(Object.assign(document.createElement('style'), { textContent: `
  .hero .frame { min-height: 640px; padding: 40px 24px 110px; }
  .hero .eyebrow { font-size: 15px; }
  .hero h1 { font-size: 112px; margin: 22px 0 26px; }
  .hero .lead { font-size: 25px; max-width: 760px; margin-bottom: 0; }
  #readme-banner .targets { display: none; }
` }))
// the page's og:description: shorter than its lead
document.querySelector('.hero .lead').textContent = document.querySelector('meta[property="og:description"]').content
JS
ab eval "scrollTo({ top: 0, behavior: 'instant' })"
ab wait 500
ab screenshot "$OUT/social-preview.png"
echo "$OUT/social-preview.png"

# Smaller files, same pixels
for f in "$OUT"/*.png; do magick "$f" -strip -define png:compression-level=9 "$f"; done
