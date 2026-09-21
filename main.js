'use strict'

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const DEMO = process.argv.includes('--demo')
const SMOKE = process.argv.includes('--smoke')
const shotArg = process.argv.indexOf('--shot')
const SHOT = shotArg !== -1 ? process.argv[shotArg + 1] : null
const fsShotArg = process.argv.indexOf('--fstest')
const FSTEST = fsShotArg !== -1 ? (process.argv[fsShotArg + 1] || null) : null

const smtc = require('./src/smtc')
const mediacmd = require('./src/cmd')
const { fetchLyricsFor } = require('./src/lyrics')
const { parseLRC } = require('./src/lrc')

let demoMode = false

let win = null
let timer = null
let pill = null // tiny floating "Fullscreen" button (the overlay itself is click-through)
let isFS = false
let lastTrack = false

// Overlay geometry: pill position is derived from this.
const OVER = { x: 24, y: 24, w: 640, h: 340, margin: 30, cardW: 580, cardH: 280 }

const lyricCache = new Map()
const artCache = new Map()
const fetching = new Set() // track keys with a lyrics request in flight

let showingId = null
let sentKey = null
let sentPlaying = null
let sentLyrics = null
let sentStamp = 0
let sentArtFor = null

const push = (s) => {
  if (win && !win.isDestroyed()) win.webContents.send('overlay-state', s)
  lastTrack = !!(s && s.track)
  // The pill only makes sense while a track is showing and we're windowed.
  if (pill && !pill.isDestroyed()) {
    if (isFS || !lastTrack) pill.hide()
    else if (!pill.isVisible()) pill.showInactive()
  }
}

function setMode(on) {
  isFS = !!on
  if (win && !win.isDestroyed()) {
    if (isFS) {
      // Opaque window level first: a transparent fullscreen window flickers
      // through DWM during the transition.
      try { win.setBackgroundColor('#06060c') } catch (_) { /* ignore */ }
      win.setFullScreen(true)
      win.setIgnoreMouseEvents(false) // take clicks: it's a full takeover, exit via UI
    } else {
      win.setFullScreen(false)
      try { win.setBackgroundColor('#00000000') } catch (_) { /* ignore */ }
      win.setIgnoreMouseEvents(true)
      // Belt and braces: the click-through flag has been observed lost
      // after a fullscreen cycle on some systems. Re-assert once the
      // restore settles; harmless when already applied.
      setTimeout(() => {
        try {
          if (!isFS && win && !win.isDestroyed()) win.setIgnoreMouseEvents(true)
        } catch (_) { /* ignore */ }
      }, 400)
    }
    win.webContents.send('overlay-mode', isFS)
  }
  if (pill && !pill.isDestroyed()) {
    if (isFS || !lastTrack) pill.hide()
    else if (!pill.isVisible()) pill.showInactive()
  }
}

function makeWindow() {
  win = new BrowserWindow({
    width: OVER.w,
    height: OVER.h,
    x: OVER.x,
    y: OVER.y,
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.setIgnoreMouseEvents(true)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// Small clickable pill floating just above the credit (bottom-right).
// Separate window because the overlay itself must stay click-through for games.
function makePill() {
  const W = 268, H = 40
  pill = new BrowserWindow({
    width: W,
    height: H,
    x: OVER.x + OVER.margin + OVER.cardW - W - 10,
    y: OVER.y + OVER.margin + OVER.cardH - 22 - H - 8,
    transparent: true,
    frame: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  pill.setIgnoreMouseEvents(false)
  pill.loadFile(path.join(__dirname, 'renderer', 'pill.html'))
  pill.hide() // shown by push() once a track is actually showing
}

function wallpaperDataUrl() {
  try {
    const out = execSync('reg query "HKCU\\Control Panel\\Desktop" /v WallPaper', {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = out.match(/WallPaper\s+REG_SZ\s+(.*)/i)
    if (!m) return null
    const img = nativeImage.createFromPath(m[1].trim())
    if (img.isEmpty()) return null
    return img.resize({ width: 48, height: 27 }).toDataURL()
  } catch { return null }
}

const idOf = (s) => `${s.title}\u0000${s.artist || ''}\u0000${s.album || ''}`

function toTrack(snap, key, withArt) {
  return {
    trackId: key,
    title: snap.title,
    artist: snap.artist || '',
    album: snap.album || '',
    albumArt: withArt ? (artCache.get(key) || null) : undefined,
    durationMs: snap.durationMs || 0,
    progressMs: snap.positionMs || 0,
    updatedAt: snap.updatedAt || 0,
    isPlaying: snap.status === 'Playing'
  }
}

function emit(track, lyrics) {
  showingId = track.trackId
  sentKey = track.trackId
  sentPlaying = track.isPlaying
  sentLyrics = lyrics
  sentStamp = track.updatedAt || 0
  if (track.albumArt !== undefined) sentArtFor = track.trackId
  push({
    track,
    isPlaying: track.isPlaying,
    lyrics: lyrics || null,
    progressMs: track.progressMs,
    updatedAt: track.updatedAt || 0,
    error: null
  })
}

function emitEmpty() {
  if (isFS) setMode(false) // nothing to show fullscreen: drop back to overlay
  showingId = null
  sentKey = null
  sentPlaying = null
  sentLyrics = null
  sentStamp = 0
  sentArtFor = null
  push({ track: null, isPlaying: false, lyrics: null, progressMs: 0, updatedAt: 0, error: null })
}

function isAd(title) {
  return /^advertisement$/i.test(String(title || '').trim())
}

async function tick() {
  const snap = smtc.latest()
  if (!snap || !snap.title || isAd(snap.title)) {
    if (sentKey !== null) emitEmpty()
    return
  }
  const key = idOf(snap)
  if (snap.art) {
    artCache.set(key, snap.art)
    if (artCache.size > 20) artCache.delete(artCache.keys().next().value)
  }

  const playing = snap.status === 'Playing'
  const lyrics = lyricCache.get(key) || null
  const stamp = snap.updatedAt || 0
  const artDue = artCache.has(key) && sentArtFor !== key

  const changed =
    key !== sentKey ||
    playing !== sentPlaying ||
    !Object.is(lyrics, sentLyrics) ||
    stamp !== sentStamp ||
    artDue
  if (!changed) return

  emit(toTrack(snap, key, key !== sentKey || artDue), lyrics)

  // In-flight guard: tick() runs every 500ms but a fetch can take seconds.
  // Without this, each tick fires another request for the same track.
  if (!lyricCache.has(key) && !fetching.has(key)) {
    fetching.add(key)
    try {
      const got = await fetchLyricsFor({
        title: snap.title,
        artist: snap.artist || '',
        album: snap.album || '',
        durationMs: snap.durationMs || 0
      })
      const value = got || { kind: 'none' }
      lyricCache.set(key, value)
      if (lyricCache.size > 40) lyricCache.delete(lyricCache.keys().next().value)
      if (showingId === key) {
        const fresh = smtc.latest()
        if (fresh && fresh.title && idOf(fresh) === key) {
          if (fresh.art) artCache.set(key, fresh.art)
          emit(toTrack(fresh, key, sentArtFor !== key), value)
        } else {
          emit(toTrack(snap, key, false), value)
        }
      }
    } catch (e) {
      console.error('[lyrics]', e)
      if (!lyricCache.has(key)) {
        lyricCache.set(key, { kind: 'none' })
        if (showingId === key) emit(toTrack(snap, key, false), { kind: 'none' })
      }
    } finally {
      fetching.delete(key)
    }
  }
}

function runReal() {
  smtc.start()
  tick().catch((e) => console.error('[tick]', e))
  if (timer) clearInterval(timer)
  timer = setInterval(() => tick().catch((e) => console.error('[tick]', e)), 250)
}

// --- demo (no Spotify needed) -----------------------------------------------

function svgArt(c1, c2, c3) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="${c1}"/><stop offset="0.5" stop-color="${c2}"/>` +
    `<stop offset="1" stop-color="${c3}"/></linearGradient></defs>` +
    '<rect width="128" height="128" rx="28" fill="url(#g)"/>' +
    '<circle cx="64" cy="62" r="34" fill="none" stroke="#fff" stroke-width="7" opacity=".85"/>' +
    '<circle cx="64" cy="62" r="14" fill="#fff"/></svg>')
}

// Playthrough setlist: synced karaoke, delayed (loading state), static
// unsynced, and a track with no lyrics — every overlay state on display.
const DEMO_SONGS = [
  {
    title: 'Neon Streets', artist: 'Demo Drive', album: 'Demo Playthrough', durationMs: 26000,
    art: svgArt('#FF6B2C', '#E63946', '#6b1d12'),
    lrc: '[00:00.00]Sunrise bleeding through the blinds\n[00:03.20]Another city in our minds\n[00:06.40]We were diamonds, we were gold\n[00:09.60]Running faster than the lights unfold\n[00:12.80]Neon streets and hollow hearts\n[00:16.00]Two kids waiting for the stars\n[00:19.20]Hold the feeling, let it burn\n[00:22.40]Every lesson that we learn'
  },
  {
    title: 'Glass Orbit', artist: 'Nightwave', album: 'Demo Playthrough', durationMs: 20000,
    art: svgArt('#8B5CF6', '#EC4899', '#3b0764'),
    delayMs: 2500, // lyrics arrive late: showcases the searching state
    lrc: '[00:00.00]Glass orbit spinning slow\n[00:02.60]Where the satellite shadows go\n[00:05.20]You and me beyond the sky\n[00:07.80]Weightless, watching worlds go by\n[00:10.40]Reflections in a silver sea\n[00:13.00]Everything we used to be\n[00:15.60]Break the gravity, we soar\n[00:18.20]We don\u2019t need the floor anymore'
  },
  {
    title: 'Static Bloom', artist: 'Paper Gardens', album: 'Demo Playthrough', durationMs: 18000,
    art: svgArt('#14B8A6', '#0EA5E9', '#083344'),
    static: ['Petals on the pavement,', 'morning coming through the blinds,', 'every static moment blooms', 'when the signal finds you.']
  },
  {
    title: 'Silent Frequency', artist: 'Null Set', album: 'Demo Playthrough', durationMs: 14000,
    art: svgArt('#F59E0B', '#EF4444', '#451a03'),
    none: true // no lyrics anywhere: showcases the empty state
  }
]

// Demo transport: the playthrough can be driven like a real player
// (prev / play-pause / next) via the same overlay-cmd channel.
let demoCtl = null

function runDemo() {
  let i = 0
  let pos = 0
  let held = false // end-of-song pause
  let pausedMid = false // user paused mid-song via transport
  let pending = null // delayed-lyrics timer for the current song

  const lyricsFor = (idx) => {
    const s = DEMO_SONGS[idx]
    if (s.none) return { kind: 'none' }
    if (s.static) return { kind: 'static', text: s.static }
    return { kind: 'synced', lines: parseLRC(s.lrc) }
  }
  const playing = () => !held && !pausedMid
  const track = (withArt) => ({
    trackId: 'demo-' + i,
    title: DEMO_SONGS[i].title,
    artist: DEMO_SONGS[i].artist,
    album: DEMO_SONGS[i].album,
    albumArt: withArt ? DEMO_SONGS[i].art : undefined,
    durationMs: DEMO_SONGS[i].durationMs,
    progressMs: pos,
    updatedAt: Date.now(),
    isPlaying: playing()
  })
  const stateFor = (p, withArt, lyrics) => ({
    track: track(withArt), isPlaying: p, lyrics,
    progressMs: pos, updatedAt: Date.now(), error: null
  })

  const startSong = () => {
    if (pending) { clearTimeout(pending); pending = null }
    pausedMid = false
    const delay = DEMO_SONGS[i].delayMs || 0
    if (delay > 0) {
      // Searching state first, lines pop in when "found".
      push(stateFor(true, true, null))
      pending = setTimeout(() => {
        pending = null
        if (playing() && DEMO_SONGS[i].delayMs) push(stateFor(true, false, lyricsFor(i)))
      }, delay)
    } else {
      push(stateFor(true, true, lyricsFor(i)))
    }
  }

  const jump = (dir) => {
    if (pending) { clearTimeout(pending); pending = null }
    i = (i + dir + DEMO_SONGS.length) % DEMO_SONGS.length
    pos = 0
    held = false
    startSong()
  }

  demoCtl = {
    next() { jump(1) },
    prev() { jump(-1) },
    toggle() {
      if (pending) { clearTimeout(pending); pending = null }
      if (held) { jump(1); return } // ended song: resume means next song
      pausedMid = !pausedMid
      push(stateFor(playing(), false, lyricsFor(i)))
    },
    seek(ms) {
      const at = Math.floor(Number(ms))
      if (!Number.isFinite(at) || at < 0) return
      if (pending) { clearTimeout(pending); pending = null }
      held = false
      pausedMid = false
      pos = Math.min(at, DEMO_SONGS[i].durationMs)
      push(stateFor(playing(), false, lyricsFor(i)))
    }
  }

  startSong()

  setInterval(() => {
    if (held) {
      jump(1)
      return
    }
    if (pausedMid || pending) return // frozen or searching: hold the frame
    pos += 1000
    if (pos >= DEMO_SONGS[i].durationMs) {
      pos = DEMO_SONGS[i].durationMs
      held = true
      if (pending) { clearTimeout(pending); pending = null }
      push(stateFor(false, false, lyricsFor(i)))
      return
    }
    push(stateFor(true, false, lyricsFor(i)))
  }, 1000)
}

app.whenReady().then(() => {
  ipcMain.handle('overlay-theme', () => wallpaperDataUrl())
  ipcMain.handle('overlay-fs', (_e, what) => {
    if (what === 'enter') setMode(true)
    else if (what === 'exit') setMode(false)
    return isFS
  })
  // Renderer asks on boot: one-shot mode pushes can land before the page
  // has registered its listener (slow boot) and would otherwise be lost.
  ipcMain.handle('overlay-mode-get', () => isFS)
  ipcMain.handle('overlay-cmd', (_e, action, value) => {
    if (!['next', 'prev', 'toggle', 'volup', 'voldn', 'mute', 'seek'].includes(action)) return false
    if (demoMode && demoCtl) {
      if (action === 'seek') demoCtl.seek(value)
      else if (['next', 'prev', 'toggle'].includes(action)) demoCtl[action]()
      // volume keys intentionally do nothing in demo (never touch real mixer)
    } else if (action === 'seek') mediacmd.seek(value)
    else mediacmd.send(action)
    return true
  })
  makeWindow()
  makePill()
  try { win.setAlwaysOnTop(true, 'screen-saver') } catch { win.setAlwaysOnTop(true) }

  if (DEMO || SMOKE || SHOT || FSTEST) { demoMode = true; runDemo() }
  else runReal()

  if (SMOKE) {
    win.webContents.on('did-finish-load', () => {
      console.log('[smoke] loaded')
      setTimeout(() => { console.log('[smoke] ok'); app.quit() }, 1500)
    })
  }
  if (SHOT) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(SHOT, img.toPNG())
        console.log('[shot] saved ' + SHOT)
      } catch (e) { console.error('[shot] failed', e) }
      app.quit()
    }, 12300)
  }
  if (FSTEST) {
    // Visual QA for the fullscreen stage: enter FS, capture it, exit again
    // (proves the round trip), capture that too, then quit.
    setTimeout(() => setMode(true), 5000)
    const grab = async (file) => {
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(file, img.toPNG())
        console.log('[fstest] saved ' + file)
      } catch (e) { console.error('[fstest] failed', e) }
    }
    setTimeout(() => grab(FSTEST.replace(/(\.png)?$/, '-fs$1') || FSTEST), 8000)
    setTimeout(() => setMode(false), 8500)
    setTimeout(async () => { await grab(FSTEST); app.quit() }, 9500)
  }
})

app.on('will-quit', () => {
  if (timer) clearInterval(timer)
  smtc.stop()
})
app.on('window-all-closed', () => app.quit())
