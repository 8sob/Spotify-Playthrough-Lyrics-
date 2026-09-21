'use strict'

// [mm:ss.xx] parser -> [{ time, text }] sorted by time.
const TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

function parseLRC(raw) {
  const rows = []
  if (raw == null) return rows
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(TAG)]
    if (tags.length === 0) continue
    const text = rawLine.replace(TAG, '').trim()
    if (!text) continue
    for (const m of tags) {
      const min = Number(m[1])
      const sec = Number(m[2])
      if (!Number.isFinite(min) || !Number.isFinite(sec)) continue
      const frac = m[3] || ''
      let ms = 0
      if (frac.length <= 2) ms = Number('0.' + (frac || '0')) * 100
      else ms = Number(frac)
      rows.push({ time: min * 60 + sec + ms / 1000, text })
    }
  }
  rows.sort((a, b) => a.time - b.time)
  return rows
}

module.exports = { parseLRC }
