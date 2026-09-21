'use strict'

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// Fire-and-forget transport commands (next/prev/toggle/volup/voldn/mute)
// plus seek-to-position to the Spotify desktop app via a one-shot
// PowerShell helper. The 500ms poller picks up the resulting state change,
// so no response plumbing is needed here.

let cachedScript = null

function scriptPath() {
  if (cachedScript) return cachedScript
  const src = path.join(__dirname, 'media-cmd.ps1')
  const dst = path.join(app.getPath('userData'), 'media-cmd.ps1')
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, fs.readFileSync(src, 'utf8'), 'utf8')
  cachedScript = dst
  return dst
}

const KNOWN = ['next', 'prev', 'toggle', 'volup', 'voldn', 'mute', 'seek']

function run(action, extraArgs) {
  let file
  try {
    file = scriptPath()
  } catch (e) {
    console.error('[cmd] setup failed', e)
    return
  }
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Action', action].concat(extraArgs || []),
    { windowsHide: true, timeout: 10000 },
    (err, stdout) => {
      if (err) {
        console.error('[cmd]', action, err.message || err)
        return
      }
      try {
        const res = JSON.parse(String(stdout).trim().split('\n').pop())
        if (!res.ok) console.error('[cmd]', action, 'rejected:', res.reason)
      } catch (_) { /* unparsable output: poller will show the truth anyway */ }
    }
  )
}

function send(action) {
  if (!KNOWN.includes(action) || action === 'seek') return
  run(action)
}

function seek(ms) {
  const pos = Math.floor(Number(ms))
  if (!Number.isFinite(pos) || pos < 0) return
  run('seek', ['-PositionMs', String(pos)])
}

module.exports = { send, seek }
