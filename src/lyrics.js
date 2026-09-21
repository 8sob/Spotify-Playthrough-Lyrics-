'use strict'

const { parseLRC } = require('./lrc')

const UA = 'LyricOverlay/2.0 (local desktop overlay)'
const TIMEOUT = 8000

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

function overlap(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size && !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / (A.size + B.size - hit || 1)
}

// { kind:'synced', lines } | { kind:'static', text } | null
function toLyrics(p) {
  if (!p || typeof p !== 'object') return null
  const synced = p.syncedLyrics
  if (typeof synced === 'string' && synced.trim()) {
    const lines = parseLRC(synced)
    if (lines.length >= 2) return { kind: 'synced', lines }
  }
  const plain = p.plainLyrics || p.unsyncedLyrics
  if (typeof plain === 'string' && plain.trim()) {
    const text = plain.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (text.length) return { kind: 'static', text }
  }
  return null
}

function scoreCandidate(c, titleW, artistW, wantSec) {
  let s =
    overlap(titleW, words(c.trackName)) * 0.5 +
    overlap(artistW, words(c.artistName)) * 0.3
  if (c.duration && wantSec) {
    const drift = Math.abs(c.duration - wantSec)
    s += Math.max(0, 1 - drift / Math.max(20, wantSec * 0.2)) * 0.2
  }
  if (c.syncedLyrics) s += 0.15
  return s
}

function pickBest(list, track, wantSec) {
  if (!Array.isArray(list) || !list.length) return null
  const titleW = words(track.title)
  const artistW = words(track.artist)
  let top = null
  let topScore = -1
  for (const c of list) {
    const s = scoreCandidate(c, titleW, artistW, wantSec)
    if (s > topScore) {
      topScore = s
      top = c
    }
  }
  return topScore >= 0.4 ? top : null
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (res.status !== 200) return null
  return res.json()
}

async function fetchLyricsFor(track) {
  const title = (track.title || '').trim()
  const artist = (track.artist || '').trim()
  if (!title) return null
  const wantSec = Math.round((track.durationMs || 0) / 1000)

  try {
    const q = new URLSearchParams({ artist_name: artist, track_name: title })
    if (track.album) q.set('album_name', track.album)
    if (wantSec) q.set('duration', String(wantSec))
    const hit = await fetchJSON(`https://lrclib.net/api/get?${q}`)
    const lyrics = toLyrics(hit)
    if (lyrics) return lyrics
  } catch (e) {
    console.error('[lyrics:get]', (e && e.message) || e)
  }

  try {
    const list = await fetchJSON(
      `https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`
    )
    const best = pickBest(list, track, wantSec)
    const lyrics = toLyrics(best)
    if (lyrics) return lyrics
  } catch (e) {
    console.error('[lyrics:search]', (e && e.message) || e)
  }

  return null
}

module.exports = { fetchLyricsFor, toLyrics, pickBest }
