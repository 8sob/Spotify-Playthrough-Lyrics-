# LyricOverlay

A small transparent overlay that sits in the corner of your screen and shows
karaoke-style synced lyrics for whatever is playing in the Spotify desktop
app. It's click-through, so it never steals clicks from your game.

## Requirements

- Windows 10 version 1809 or newer
- The Spotify desktop app (not the browser player)

No Spotify login, no Client ID, no Premium. The track comes straight from the
Windows media session; lyrics come from LRCLIB, which is free and needs no
key.

## Run it

1. Play something in the Spotify desktop app.
2. Run `LyricOverlay.exe` (portable, no install — or use the installer build).
3. Lyrics show up top-left.

> Fullscreen-exclusive games will cover the overlay, so run games in
> borderless windowed mode.

## Controls

The overlay itself ignores the mouse. A small control bar floats next to it
with previous / play-pause / next, volume up / down / mute, and a fullscreen
button.

The fullscreen button opens an opaque full-screen stage: big artwork, full
transport controls, click-to-seek progress bar, adjustable lyric size, and a
few backdrop themes. Exit button is top-right, or just stop the music and it
drops back to the overlay on its own.

## Dev setup

```bash
npm install
npm start          # real mode, needs the Spotify desktop app
npm run start:demo # demo mode, fake songs with synced lyrics, no Spotify needed
```

## Build

```bash
npm run build            # portable exe -> dist/LyricOverlay.exe
npm run build:installer  # Windows installer
```

## How it works

- `src/smtc.ps1` + `src/smtc.js` — reads the Spotify desktop app's current
  track (title, artist, playback state, position, album art) from the Windows
  media session (SMTC). No network, no account.
- `src/lyrics.js` — looks the track up on LRCLIB: exact match first, then a
  fuzzy search scored on title/artist/duration as fallback.
- `src/lrc.js` — parses the LRC timestamps into timed lines.
- `renderer/` — Electron transparent window. Progress is extrapolated between
  polls, and every time Spotify reports fresh timeline data the clock snaps
  straight to it, so the highlighted line stays on the music even when the
  media session reports stale positions.

## Troubleshooting

- **Nothing shows up** — make sure the Spotify *desktop app* is playing (not
  the web player) and that the song appears in the Windows volume/media popup.
- **Overlay hidden by a game** — switch the game to borderless windowed.
- **Wrong lyrics** — some sped-up/remix titles don't match LRCLIB exactly;
  the overlay shows the closest match it finds.
- **"Lyrics not found"** — LRCLIB simply has no timed lyrics for that track.

## Credits

- Lyrics by [LRCLIB](https://lrclib.net)
- Built with [Electron](https://www.electronjs.org)
- Typeface: Inter

## License

MIT — see [LICENSE](LICENSE).
