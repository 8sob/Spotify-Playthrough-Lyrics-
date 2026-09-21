'use strict'

// Overlay renderer: header + smooth progress + karaoke lines + dynamic tint.

const el = (id) => document.getElementById(id)
const card = el('card')
const artImg = el('art')
const artGhost = el('artGhost')
const artBox = document.querySelector('.artbox')
const wash = el('wash')
const shine = document.querySelector('.shine')
const titleEl = el('title')
const artistEl = el('artist')
const metaEl = document.querySelector('.meta')
const liveEl = el('live')
const eqEl = el('eq')
const fill = el('fill')
const knob = el('knob')
const barEl = el('bar')
const tCur = el('tCur')
const tEnd = el('tEnd')
const lyricBox = el('lyrics')
const rows = el('rows')
const statusBox = el('status')
const fsExit = el('fsExit')
const fsCtrls = el('fsCtrls')
const fsPP = el('fsPP')
const fsSize = el('fsSize')
const fsTheme = el('fsTheme')

// Karaoke sweep: fills the active line as it sings (synced lyrics only).
// Throttled to 10 Hz on a single element: no layout, tiny paint.
let sweepOn = false
let lastSweep = -1
let lastSweepT = 0

function sweep(t) {
  if (!sweepOn || activeIdx < 0 || !cur || !cur.track) return
  const now = performance.now()
  if (now - lastSweepT < 100) return
  lastSweepT = now
  const a = items[activeIdx]
  if (!a) return
  const b = items[activeIdx + 1]
  const end = b ? b.time : ((cur.track.durationMs || 0) / 1000 || a.time + 4)
  const span = Math.max(0.5, end - a.time)
  const p = Math.min(1, Math.max(0, (t - a.time) / span))
  if (Math.abs(p - lastSweep) > 0.02) {
    lastSweep = p
    const k = rows.children[activeIdx]
    if (k) k.style.setProperty('--fill', (p * 100).toFixed(1) + '%')
  }
}

const LINE_H = 30
const CENTER = 1.5 // keep active line ~1.5 rows from top
const IDLE_AFTER = 4000

let lineH = LINE_H // measured row height (fullscreen rows are taller)
function measureRow() {
  const k = rows.children[0]
  if (k) {
    const h = k.getBoundingClientRect().height
    if (h > 0) lineH = h
  }
}

let cur = null
let gotAt = 0
let items = []
let activeIdx = -1
let lastScale = -1
let lastKnobX = -1
let lastSec = -1
let barW = 0
let clockPos = 0
let clockAt = 0
let anchored = false
let raf = 0
let idleT = null
let songId = null
let builtFor = null
let staticSig = ''
let artNow = Symbol('none') // distinct from null/undefined
let themeFor = Symbol('none')
let wallSample = null

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function findLine(t) {
  let lo = 0, hi = items.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].time <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function replay(node, cls) {
  if (!node) return
  node.classList.remove(cls)
  void node.offsetWidth
  node.classList.add(cls)
}

// --- lyrics ---------------------------------------------------------------

function paint(idx) {
  const kids = rows.children
  for (let i = 0; i < kids.length; i++) {
    kids[i].style.setProperty('--d', String(idx < 0 ? 1 : Math.abs(i - idx)))
    kids[i].classList.toggle('on', i === idx)
    kids[i].classList.toggle('was', idx - i === 1)
  }
  if (idx < 0) return
  // paint() only runs on line change: start the new line empty so the
  // sweep fills it from zero instead of flashing full.
  const fresh = rows.children[idx]
  if (fresh) fresh.style.setProperty('--fill', '0%')
  lastSweep = -1
  rows.style.transform = `translateY(${-Math.max(0, (idx - CENTER + 0.5) * lineH)}px)`
}

function build(list, cls) {
  items = list
  activeIdx = -1
  lastSweep = -1
  rows.textContent = ''
  lineH = LINE_H
  requestAnimationFrame(measureRow) // rows may be taller in fullscreen
  const frag = document.createDocumentFragment()
  for (const l of list) {
    const d = document.createElement('div')
    d.className = 'row' + (cls ? ' ' + cls : '')
    const s = document.createElement('span')
    s.textContent = l.text
    d.appendChild(s)
    frag.appendChild(d)
  }
  rows.appendChild(frag)
  rows.style.transform = 'translateY(0)'
  paint(-1)
}

function showLines(lyrics) {
  if (builtFor !== lyrics.lines) {
    builtFor = lyrics.lines
    build(lyrics.lines)
    replay(lyricBox, 'pop')
  }
  sweepOn = true
  lyricBox.hidden = false
  statusBox.hidden = true
}

function showText(lyrics) {
  sweepOn = false
  const sig = lyrics.text.join('\n')
  if (sig !== lastStaticSig) {
    lastStaticSig = sig
    builtFor = null
    build(lyrics.text.map((t, i) => ({ time: i, text: t })), 'flat')
    replay(lyricBox, 'pop')
  }
  lyricBox.hidden = false
  statusBox.hidden = true
  liveEl.hidden = true
  eqEl.hidden = true
}

function showNote(head, sub, loading) {
  sweepOn = false
  lyricBox.hidden = true
  statusBox.hidden = false
  statusBox.classList.toggle('seek', !!loading)
  if (statusBox.dataset.sig !== head + sub) {
    statusBox.dataset.sig = head + sub
    statusBox.innerHTML = `<div class="big">${esc(head)}</div>` + (sub ? `<div>${esc(sub)}</div>` : '')
    replay(statusBox, 'pop')
  }
}

// --- chrome ----------------------------------------------------------------

function goIdle() {
  if (idleT) return
  idleT = setTimeout(() => card.classList.add('idle'), IDLE_AFTER)
}
function wake() {
  if (idleT) { clearTimeout(idleT); idleT = null }
  card.classList.remove('idle')
}

const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function measureBar() {
  // One layout read, cached; the window never resizes so this runs ~once per track.
  barW = barEl.clientWidth || 0
}

// Compositor-only progress: scaleX on the fill + translateX on the knob.
// No width/left writes, so steady playback never triggers layout or paint.
function drawBar(pct) {
  const p = Math.min(1, Math.max(0, pct / 100))
  if (Math.abs(p - lastScale) > 0.0005) {
    fill.style.transform = `scaleX(${p.toFixed(4)})`
    lastScale = p
  }
  if (barW > 0) {
    const x = Math.round(p * barW)
    if (x !== lastKnobX) {
      knob.style.transform = `translateX(${x}px)`
      lastKnobX = x
    }
  }
}

// 1 Hz text updates: negligible paint, kept out of the per-frame path.
function drawTimes(posMs, durMs) {
  const sec = Math.floor((posMs || 0) / 1000)
  if (sec !== lastSec) {
    lastSec = sec
    const t = fmtTime(posMs)
    if (tCur.textContent !== t) tCur.textContent = t
  }
  const d = fmtTime(durMs)
  if (tEnd.textContent !== d) tEnd.textContent = d
}

function freezeAtState() {
  if (!cur || !cur.track) return
  measureBar()
  const dur = cur.track.durationMs || 0
  const pos = Math.min(cur.progressMs || 0, dur || 0)
  lastScale = -1; lastKnobX = -1; lastSec = -1
  drawBar(dur ? (pos / dur) * 100 : 0)
  drawTimes(pos, dur)
  if (items.length) {
    activeIdx = findLine(pos / 1000)
    paint(activeIdx)
  }
}

function setArt(url) {
  artNow = url
  if (url !== themeFor) {
    themeFor = url
    tintFrom(url)
  }
  if (url) {
    if (artImg.getAttribute('src') !== url) {
      // One retry on transient decode failure instead of a stuck fallback.
      artImg.onerror = () => {
        artImg.onerror = null
        setTimeout(() => { if (artNow === url) artImg.src = url }, 800)
      }
      artImg.src = url
    }
    artImg.hidden = false
    artGhost.hidden = true
    artGhost.classList.remove('show')
  } else {
    artImg.hidden = true
    artImg.removeAttribute('src')
    artGhost.hidden = false
    artGhost.classList.add('show')
  }
}

function drawHead(track) {
  if (titleEl.textContent !== (track.title || '')) titleEl.textContent = track.title || ''
  const sub = track.artist || ''
  const full = track.album && track.album !== sub ? (sub ? `${sub} — ${track.album}` : track.album) : sub
  if (artistEl.textContent !== full) artistEl.textContent = full
  // undefined = heartbeat, leave art alone. null/string = explicit change.
  if (track.albumArt !== undefined && track.albumArt !== artNow) setArt(track.albumArt || null)
}

function fail(msg) {
  halt()
  wake()
  card.classList.remove('paused', 'playing')
  titleEl.textContent = ''
  artistEl.textContent = ''
  setArt(null)
  liveEl.hidden = true
  eqEl.hidden = true
  lastScale = -1; lastKnobX = -1; lastSec = -1
  drawBar(0)
  drawTimes(0, 0)
  items = []
  rows.textContent = ''
  builtFor = null
  staticSig = ''
  songId = null
  showNote('Something went wrong', msg)
}

// --- tint -------------------------------------------------------------------

const css = (r, g, b) => `rgb(${r},${g},${b})`
const cssA = (r, g, b, a) => `rgba(${r},${g},${b},${a})`
const blend = (c, t, f) => [0, 1, 2].map((i) => Math.round(c[i] + (t[i] - c[i]) * f))
const W = [255, 255, 255]
const K = [0, 0, 0]

function sample(img, size) {
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const x = c.getContext('2d', { willReadFrequently: true })
  x.clearRect(0, 0, size, size)
  x.drawImage(img, 0, 0, size, size)
  const { data } = x.getImageData(0, 0, size, size)
  const px = []
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    px.push([data[i], data[i + 1], data[i + 2]])
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
  }
  return n ? { px, avg: [r / n, g / n, b / n] } : null
}

function applyTint(s) {
  let accent = null, top = 0
  for (const p of s.px) {
    const mx = Math.max(...p), mn = Math.min(...p)
    const sat = mx ? (mx - mn) / mx : 0
    const lum = (p[0] + p[1] + p[2]) / 3
    const v = sat + (lum >= 70 && lum <= 230 ? 0.45 : -0.4)
    if (v > top) { top = v; accent = p }
  }
  if (!accent || top < 0.85) return false
  const st = document.documentElement.style
  const hi = blend(accent, W, 0.45)
  const deep = blend(accent, K, 0.55)
  const soft = blend(accent, W, 0.15)
  const live = blend(accent, W, 0.45)
  const bg = blend(s.avg, K, 0.9)
  const A = accent
  st.setProperty('--accent', css(...A))
  st.setProperty('--accent-hi', css(...hi))
  st.setProperty('--accent-deep', css(...deep))
  st.setProperty('--ember', css(...soft))
  st.setProperty('--glow', cssA(...A, 0.5))
  st.setProperty('--soft', cssA(...A, 0.13))
  st.setProperty('--softer', cssA(...deep, 0.1))
  st.setProperty('--halo', cssA(...A, 0.06))
  st.setProperty('--top', cssA(...A, 0.07))
  st.setProperty('--artglow', cssA(...A, 0.1))
  st.setProperty('--barglow', cssA(...A, 0.34))
  st.setProperty('--livetx', cssA(...live, 0.55))
  st.setProperty('--on-bg', `linear-gradient(90deg,${cssA(...A, 0.17)},${cssA(...deep, 0.07)} 60%,transparent)`)
  st.setProperty('--on-shadow', `0 0 18px ${cssA(...A, 0.5)}, 0 0 42px ${cssA(...A, 0.16)}`)
  st.setProperty('--ghost-bg', `linear-gradient(135deg,${css(...deep)},${css(...bg)})`)
  st.setProperty('--glass', cssA(...bg, 0.85))
  return true
}

function tintFrom(url) {
  if (!url) {
    wash.style.backgroundImage = 'none'
    themeFor = null
    if (wallSample) applyTint(wallSample)
    return
  }
  const img = new Image()
  img.onload = () => {
    try {
      const s = sample(img, 32)
      if (!(s && applyTint(s)) && wallSample) applyTint(wallSample)
    } catch { if (wallSample) applyTint(wallSample) }
    try {
      // Pre-blurred static bitmap: no runtime filter() cost.
      const c = document.createElement('canvas')
      c.width = 64; c.height = 64
      const x = c.getContext('2d')
      x.filter = 'blur(6px) saturate(1.5) brightness(0.5)'
      x.drawImage(img, -8, -8, 80, 80)
      wash.style.backgroundImage = `url("${c.toDataURL('image/jpeg', 0.75)}")`
    } catch { wash.style.backgroundImage = `url("${url}")` }
    replay(wash, 'fade')
  }
  img.onerror = () => {
    wash.style.backgroundImage = 'none'
    if (wallSample) applyTint(wallSample)
  }
  img.src = url
}

if (window.overlay && window.overlay.getTheme) {
  window.overlay.getTheme().then((d) => {
    if (!d) return
    const img = new Image()
    img.onload = () => {
      try {
        const s = sample(img, 32)
        if (s) {
          wallSample = s
          if (!themeFor || themeFor === null) applyTint(s)
        }
      } catch { /* keep defaults */ }
    }
    img.src = d
  }).catch(() => {})
}

// --- loop --------------------------------------------------------------------

function anchorMs() {
  const a = (cur && cur.updatedAt) || gotAt
  return Date.now() - a > 3000 ? gotAt : a
}

function targetMs() {
  const t = cur.track
  let p = cur.progressMs || 0
  const extra = Date.now() - anchorMs()
  if (extra > 0) p += extra
  return Math.min(p, t.durationMs || p)
}

let lastStamp = 0 // updatedAt of the timeline our clock is anchored to

function frame() {
  if (!cur || !cur.track || !cur.isPlaying) { raf = 0; return }
  raf = 0
  const now = performance.now()
  const want = targetMs()
  if (anchored) {
    clockPos = want
    clockAt = now
    anchored = false
    lastStamp = cur.updatedAt || 0
  } else {
    clockPos += now - clockAt
    clockAt = now
    const d = want - clockPos
    // Fresh timeline info from Spotify just arrived (new updatedAt): trust
    // real corrections immediately instead of easing toward them for half
    // a second. Small diffs still ease so sub-second SMTC jitter never
    // makes the highlight flicker.
    const stamp = cur.updatedAt || 0
    const fresh = stamp !== lastStamp
    lastStamp = stamp
    if (d > 2000 || d < -2000) clockPos = want
    else if (fresh && (d > 400 || d < -400)) clockPos = want
    else clockPos += d * 0.15
    const cap = cur.track.durationMs || 0
    if (clockPos < 0) clockPos = 0
    if (cap && clockPos > cap) clockPos = cap
  }
  const durMs = cur.track.durationMs || 0
  drawBar(durMs ? (clockPos / durMs) * 100 : 0)
  drawTimes(clockPos, durMs)
  if (items.length) {
    const nowT = clockPos / 1000
    let i = findLine(nowT)
    if (i < activeIdx && items[activeIdx] && nowT > items[activeIdx].time - 0.2) i = activeIdx
    if (i !== activeIdx) {
      activeIdx = i
      paint(i)
    }
    sweep(nowT)
  }
  raf = requestAnimationFrame(frame)
}

function spin() {
  if (raf) return
  if (!cur || !cur.track || !cur.isPlaying) return
  anchored = true
  raf = requestAnimationFrame(frame)
}

function halt() {
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
}

// --- entry --------------------------------------------------------------------

window.addEventListener('load', measureBar)
window.addEventListener('resize', () => { measureBar(); measureRow() })

if (fsExit) {
  fsExit.addEventListener('click', () => {
    if (window.overlay && window.overlay.exitFS) window.overlay.exitFS()
  })
}

if (fsCtrls) {
  fsCtrls.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]')
    if (b && window.overlay && window.overlay.cmd) window.overlay.cmd(b.dataset.cmd)
  })
}

// Click the progress bar to seek (only reachable in fullscreen: the corner
// overlay is click-through). Optimistic jump; the poller confirms <500ms.
barEl.addEventListener('click', (e) => {
  if (!cur || !cur.track || !cur.track.durationMs) return
  const r = barEl.getBoundingClientRect()
  if (!r.width) return
  const ms = Math.round(
    Math.min(cur.track.durationMs, Math.max(0, ((e.clientX - r.left) / r.width) * cur.track.durationMs))
  )
  if (window.overlay && window.overlay.cmd) window.overlay.cmd('seek', ms)
  clockPos = ms
  lastSweep = -1
  drawBar((ms / cur.track.durationMs) * 100)
  drawTimes(ms, cur.track.durationMs)
})

// Lyric size cycler + backdrop theme cycler (fullscreen stage only).
const FS_SIZES = ['', 'fs-lg', 'fs-xl']
let fsSizeIx = 0
if (fsSize) {
  fsSize.addEventListener('click', () => {
    fsSizeIx = (fsSizeIx + 1) % FS_SIZES.length
    document.body.classList.remove('fs-lg', 'fs-xl')
    if (FS_SIZES[fsSizeIx]) document.body.classList.add(FS_SIZES[fsSizeIx])
    requestAnimationFrame(() => { measureBar(); measureRow(); anchored = true })
  })
}
const FS_BGS = ['', 'midnight', 'aurora']
let fsBgIx = 0
if (fsTheme) {
  fsTheme.addEventListener('click', () => {
    fsBgIx = (fsBgIx + 1) % FS_BGS.length
    if (FS_BGS[fsBgIx]) document.body.dataset.bg = FS_BGS[fsBgIx]
    else delete document.body.dataset.bg
  })
}

function applyMode(on) {
  document.body.classList.toggle('fs', !!on)
  if (fsExit) fsExit.hidden = !on
  if (fsCtrls) fsCtrls.hidden = !on
  // Layout changes underneath us and Windows animates the fullscreen
  // transition (~300ms), so re-measure repeatedly until it settles.
  // Otherwise the knob and lyric scroll lock onto mid-transition sizes.
  const resync = () => {
    measureBar()
    measureRow()
    anchored = true
  }
  requestAnimationFrame(resync)
  setTimeout(resync, 350)
  setTimeout(resync, 800)
}

if (window.overlay && window.overlay.onMode) {
  window.overlay.onMode(applyMode)
  // One-shot pushes can beat page load on slow boots: ask for the truth.
  if (window.overlay.getMode) {
    window.overlay.getMode().then((on) => { if (on) applyMode(true) }).catch(() => {})
  }
}

if (!window.overlay || !window.overlay.onState) {
  document.body.innerHTML =
    '<div style="color:#f4eeea;font:12px system-ui;padding:20px">' +
    'Overlay bridge missing — restart the app.</div>'
} else window.overlay.onState((s) => {
  cur = s
  gotAt = Date.now()
  if (s.error) { fail(s.error); return }
  if (!s.track) {
    halt()
    card.classList.remove('paused', 'playing')
    goIdle()
    return
  }
  wake()
  card.classList.remove('idle')
  card.classList.toggle('paused', !s.isPlaying)
  card.classList.toggle('playing', s.isPlaying)
  drawHead(s.track)
  liveEl.hidden = !s.isPlaying
  eqEl.hidden = !s.isPlaying
  if (fsPP && fsPP.dataset.playing !== String(s.isPlaying)) {
    fsPP.dataset.playing = String(s.isPlaying)
    fsPP.innerHTML = s.isPlaying ? '&#10074;&#10074;' : '&#9654;'
  }

  if (s.track.trackId !== songId) {
    songId = s.track.trackId
    builtFor = null
    items = []
    activeIdx = -1
    anchored = true
    lastScale = -1; lastKnobX = -1; lastSec = -1
    rows.textContent = ''
    rows.style.transform = 'translateY(0)'
    replay(metaEl, 'swap')
    measureBar()
    if (tEnd.textContent !== fmtTime(s.track.durationMs)) tEnd.textContent = fmtTime(s.track.durationMs)
    replay(artBox, 'swap')
    replay(shine, 'swap')
  }

  const L = s.lyrics
  if (L && L.kind === 'synced' && L.lines && L.lines.length) showLines(L)
  else if (L && L.kind === 'static' && L.text && L.text.length) showText(L)
  else if (!L) showNote('Searching for lyrics', 'Matching this track…', true)
  else {
    liveEl.hidden = true
    eqEl.hidden = true
    showNote('Lyrics not found', 'No timed lyrics available for this track.')
  }

  if (s.isPlaying) spin()
  else { halt(); freezeAtState() }
})
