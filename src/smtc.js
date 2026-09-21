'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// Watches the Spotify SMTC session via a PowerShell child process.
// snapshot: { title, artist, album, status, positionMs, durationMs, updatedAt, art? }

let proc = null
let buf = ''
let snapshot = null
let retry = null
let dead = true

function scriptPath() {
  const src = path.join(__dirname, 'smtc.ps1')
  const dst = path.join(app.getPath('userData'), 'smtc.ps1')
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, fs.readFileSync(src, 'utf8'), 'utf8')
  return dst
}

function handleLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (!msg || typeof msg !== 'object') return
  if (msg.none === true) snapshot = null
  else if (msg.error) console.error('[smtc]', msg.error)
  else if (msg.title) snapshot = msg
}

function start() {
  if (proc) return
  dead = false
  let file
  try { file = scriptPath() } catch (e) {
    console.error('[smtc] setup failed', e)
    return
  }
  proc = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { windowsHide: true })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    buf += chunk
    // Never let a newline-free garbage stream grow the buffer forever.
    if (buf.length > 1048576) buf = buf.slice(-262144)
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) handleLine(line)
    }
  })
  proc.stderr.on('data', (c) => {
    const m = String(c).trim()
    if (m) console.error('[smtc]', m)
  })
  proc.on('error', (e) => console.error('[smtc] spawn failed', e))
  proc.on('exit', () => {
    proc = null
    if (!dead) {
      if (retry) clearTimeout(retry)
      retry = setTimeout(start, 2000)
    }
  })
}

function stop() {
  dead = true
  if (retry) { clearTimeout(retry); retry = null }
  if (proc) {
    proc.removeAllListeners('exit')
    try { proc.kill() } catch { /* gone */ }
    proc = null
  }
}

module.exports = { start, stop, latest: () => snapshot }
