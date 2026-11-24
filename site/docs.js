// The docs pages' script (build.mjs puts it in each page): lays out the flow diagrams, switches their tabs, searches
// the docs (search.json, which build.mjs writes), opens the menu on a phone, and marks the heading in view.
{
  // ---- flow diagrams: each .flow-draw has its nodes as JSON (build.mjs, flowHtml). Without this script, the page
  // shows the same steps as a list.
  const NS = 'http://www.w3.org/2000/svg'
  function body(n) {
    return `<div class="nt">${n.t}</div>${n.d ? `<div class="nd">${n.d}</div>` : ''}${n.m && n.k !== 'dec' ? `<div class="nm">${n.m}</div>` : ''}`
  }
  function draw(el, key) {
    const nodes = JSON.parse(el.dataset.nodes)
    const W = el.clientWidth
    if (!W) return
    // on a phone, the list of steps (build.mjs) reads better than a drawing with no room for its side column
    const flow = el.closest('.flow')
    flow.classList.toggle('drawn', W >= 520)
    if (W < 520) { el.innerHTML = ''; el.style.height = '0px'; return }
    el.innerHTML = ''
    const gap = W < 680 ? 32 : 56
    const mainW = Math.round((W - gap) * 0.56)
    const sideX = mainW + gap, sideW = W - sideX, cx = mainW / 2
    const dw = Math.min(mainW, 340)
    const VG = 30, P = {}
    const mk = (n, w, cls) => {
      const d = document.createElement('div')
      d.className = `node ${cls}`
      d.innerHTML = body(n)
      d.style.width = w + 'px'
      el.appendChild(d)
      return d
    }
    let y = 0, files = false
    for (const n of nodes) {
      if (n.f !== undefined) files = n.f
      n._files = files
      let h
      if (n.k === 'dec') {
        const tw = Math.round(dw * 0.56)
        const d = mk(n, tw, 'dt')
        const th = d.offsetHeight
        h = Math.max(64, Math.ceil(th * 2 + 14))
        const x = (mainW - dw) / 2
        d.style.left = x + (dw - tw) / 2 + 'px'
        d.style.top = y + (h - th) / 2 + 'px'
        P[n.id] = { x, y, w: dw, h, dec: true }
      } else {
        const d = mk(n, mainW, n.k)
        h = d.offsetHeight
        d.style.left = '0px'
        d.style.top = y + 'px'
        P[n.id] = { x: 0, y, w: mainW, h }
      }
      let bottom = y + h
      if (n.side) {
        const s = n.side
        const d = mk(s, sideW, s.k)
        const sh = d.offsetHeight
        const top = n.k === 'dec' ? y + h / 2 - 18 : y
        d.style.left = sideX + 'px'
        d.style.top = top + 'px'
        P[s.id] = { x: sideX, y: top, w: sideW, h: sh }
        bottom = Math.max(bottom, top + sh)
      }
      y = bottom + VG
    }
    const H = y - VG
    el.style.height = H + 'px'

    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('width', W)
    svg.setAttribute('height', H)
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML = `<defs>
      <marker id="${key}-a" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="ah"/></marker>
      <marker id="${key}-b" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L8,4 L0,8 z" class="ah on"/></marker></defs>`
    el.insertBefore(svg, el.firstChild)
    const add = (tag, attrs, text) => {
      const e = document.createElementNS(NS, tag)
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
      if (text) e.textContent = text
      svg.appendChild(e)
      return e
    }
    const path = (d, cls = '') => add('path', { d, class: `e ${cls}`, 'marker-end': `url(#${key}-${cls.includes('on') ? 'b' : 'a'})` })
    const label = (x, y, s, anchor = 'start') => add('text', { x, y, class: 'lbl', 'text-anchor': anchor }, s)

    nodes.forEach((n, i) => {
      const p = P[n.id]
      if (p.dec) add('polygon', { class: 'dia', points: `${p.x},${p.y + p.h / 2} ${p.x + p.w / 2},${p.y} ${p.x + p.w},${p.y + p.h / 2} ${p.x + p.w / 2},${p.y + p.h}` })
      const m = nodes[i + 1]
      if (m && n.k !== 'end') {
        const q = P[m.id]
        path(`M${cx},${p.y + p.h} V${q.y}`, n._files ? 'on' : '')
        if (n.down) label(cx + 8, p.y + p.h + 14, n.down)
      }
      const midY = p.y + p.h / 2
      if (n.right && P[n.right.to]) {
        const t = P[n.right.to], tx = t.x + t.w / 2
        path(`M${p.x + p.w},${midY} H${tx} V${t.y}`)
        label(p.x + p.w + 6, midY - 6, n.right.label)
      }
      if (n.side) {
        const s = n.side, sp = P[s.id]
        if (n.k === 'dec') {
          path(`M${p.x + p.w},${midY} H${sideX}`)
          label(p.x + p.w + 6, midY - 6, s.label)
        } else {
          // no label here: the gap is too narrow, and the side node's title says when it happens
          path(`M${mainW},${sp.y + 18} H${sideX}`, `dash ${n._files ? 'on' : ''}`)
        }
        const sx = sp.x + sp.w / 2
        if (s.back && P[s.back]) {
          const t = P[s.back], ty = t.y + t.h / 2
          path(`M${sx},${sp.y} V${ty} H${t.x + t.w}`)
          if (s.backLabel) label(sx + 6, (sp.y + ty) / 2 + 4, s.backLabel)
        }
        if (s.join && P[s.join]) {
          const t = P[s.join], jy = t.y - 14
          path(`M${sx},${sp.y + sp.h} V${jy} H${cx}`)
        }
      }
    })
  }
  const flows = [...document.querySelectorAll('.flow')]
  const drawAll = () => flows.forEach((f, i) => f.querySelectorAll('.tabp:not([hidden]) .flow-draw').forEach((el) => draw(el, `f${i}`)))
  for (const [i, f] of flows.entries()) {
    f.querySelector('.seg')?.addEventListener('click', (e) => {
      const b = e.target.closest('button')
      if (!b) return
      for (const x of f.querySelectorAll('.seg button')) x.setAttribute('aria-selected', String(x === b))
      for (const p of f.querySelectorAll('.tabp')) p.hidden = p.dataset.tab !== b.dataset.tab
      f.querySelectorAll('.tabp:not([hidden]) .flow-draw').forEach((el) => draw(el, `f${i}`))
    })
  }
  let lastW = 0
  new ResizeObserver(() => { const w = document.querySelector('article')?.clientWidth; if (w && w !== lastW) { lastW = w; drawAll() } }).observe(document.body)
  document.fonts?.ready.then(() => { lastW = 0; drawAll() })

  // ---- the menu on a phone
  const menu = document.querySelector('nav.top .menu')
  menu?.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open')
    menu.setAttribute('aria-expanded', String(open))
  })

  // ---- the heading in view, in "On this page"
  const toc = [...document.querySelectorAll('.toc a[href^="#"]')]
  if (toc.length) {
    const heads = toc.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean)
    const mark = () => {
      let cur = heads[0]
      for (const h of heads) if (h.getBoundingClientRect().top < 120) cur = h
      for (const a of toc) a.classList.toggle('on', a.hash === `#${cur?.id}`)
    }
    addEventListener('scroll', mark, { passive: true })
    mark()
  }

  // ---- search: search.json has one entry for each section of each page
  const input = document.querySelector('.search input')
  const box = document.querySelector('.search .results')
  let index, sel = -1
  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean)
  function snippet(text, ws) {
    const low = text.toLowerCase()
    const at = Math.max(0, ...ws.map((w) => low.indexOf(w)).filter((i) => i >= 0).slice(0, 1))
    const from = Math.max(0, at - 50)
    let s = escape((from ? '…' : '') + text.slice(from, from + 170) + (from + 170 < text.length ? '…' : ''))
    for (const w of ws) s = s.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>')
    return s
  }
  async function search() {
    const ws = words(input.value)
    if (!ws.length) { box.hidden = true; return }
    index ??= await fetch('/docs/search.json').then((r) => r.json()).catch(() => [])
    const hits = index.map((e) => {
      const head = `${e.page} ${e.head}`.toLowerCase(), text = e.text.toLowerCase()
      let score = 0
      for (const w of ws) {
        if (head.includes(w)) score += 10
        else if (text.includes(w)) score += 1
        else return null
      }
      return { e, score }
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12)
    sel = -1
    box.innerHTML = hits.length
      ? hits.map(({ e }) => `<a href="${e.url}"><b>${escape(e.head === e.page ? e.page : `${e.page} · ${e.head}`)}</b><span>${snippet(e.text, ws)}</span></a>`).join('')
      : '<div class="none">Nothing in the docs has these words.</div>'
    box.hidden = false
  }
  input.addEventListener('input', search)
  input.addEventListener('focus', () => { if (input.value) search() })
  input.addEventListener('keydown', (e) => {
    const links = [...box.querySelectorAll('a')]
    if (e.key === 'Escape') { input.value = ''; box.hidden = true; input.blur() }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && links.length) {
      e.preventDefault()
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
      links.forEach((a, i) => a.classList.toggle('sel', i === sel))
      links[sel].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && links.length) location.href = links[Math.max(sel, 0)].href
  })
  addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) { e.preventDefault(); input.focus() }
  })
  addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true })
}
