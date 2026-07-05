# Spinlist Music Manager — desktop app

A small Mac/Windows app that scans a DJ's music library **natively** (fast, no browser
limits) and syncs the track list to their Spinlist account. Once synced, the Spinlist
wedding planner's **Prep** tool uses that library to match songs and export playlists —
no re-scanning in the browser.

This is the fast alternative to the in-browser folder scan, and the answer to Safari
being slow: the app uses Node's native file access instead of a browser file API.

Only the **track list** (title, artist, file path, size, modified-date, video flag) is
sent to Spinlist. The actual music files never leave the computer.

---

## What's here

| File | Purpose |
|------|---------|
| `main.js` | Electron main process — native folder scan, tag reading (MP3 ID3 + MP4/M4A atoms), and calls to the Spinlist API |
| `preload.js` | Secure bridge between the UI and the main process |
| `renderer.html` / `renderer.js` | The app window UI (sign in → choose folder → scan → sync) |
| `package.json` | Dependencies + build config (electron-builder) for Mac, Windows, Linux |
| `assets/` | App icons (you supply `icon.icns` for Mac, `icon.ico` for Windows — see below) |

---

## Run it locally (to try it before building installers)

You need **Node.js 18+** installed (https://nodejs.org).

```bash
cd spinlist-desktop
npm install          # downloads Electron + build tools (~200MB, one time)
npm start            # launches the app
```

Sign in with a Spinlist email/password (must be a plan that includes Prep — i.e. not
Basic). Choose your music folder; it scans and syncs. Test a rescan to confirm it only
re-reads changed files.

> By default the app talks to `https://www.spinlist.co.uk`. To point at a different
> backend (e.g. for testing), set an environment variable before launching:
> `SPINLIST_URL=https://staging.example.com npm start`

---

## Build the installers

The finished `.dmg` (Mac) and `.exe` (Windows) **must be built on each platform** —
Electron compiles per-OS. You can't build a Mac app on Windows or vice-versa (without
extra CI setup).

### Mac (build on a Mac)
```bash
npm run dist:mac
```
Output appears in `dist/`: a `.dmg` installer and a `.zip`.

### Windows (build on a Windows PC)
```bash
npm run dist:win
```
Output appears in `dist/`: an NSIS `.exe` installer.

### Both / Linux
```bash
npm run dist        # builds for the current platform
```

---

## Icons (before building)

Put your app icons in `assets/`:
- `assets/icon.icns` — macOS (1024×1024 source, converted to .icns)
- `assets/icon.ico` — Windows (256×256 .ico)

Quick way to make them from a PNG:
- Mac `.icns`: use an app like Image2icon, or `iconutil` from a set of PNGs.
- Windows `.ico`: any online PNG→ICO converter, or ImageMagick:
  `magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico`

If you skip icons, the app still builds and runs — it just uses Electron's default icon.

---

## Signing & distribution (important, real-world step)

To hand the app to other DJs without scary warnings, it needs to be **code-signed**:

- **macOS:** requires an Apple Developer account (~£79/$99 per year). The app must be
  signed and **notarised** by Apple, or users see "cannot be opened because Apple cannot
  check it for malicious software." electron-builder can notarise automatically once you
  add your Apple credentials — see https://www.electron.build/code-signing
- **Windows:** unsigned `.exe`s trigger a SmartScreen "unknown publisher" warning. A
  Windows code-signing certificate (from a CA) removes it. Optional but recommended for
  a public download.

For **just yourself / a few trusted DJs**, you can skip signing — you'll click through a
one-time "open anyway" warning (Mac: right-click → Open; Windows: More info → Run anyway).

Host the finished installers wherever you like (your site, GitHub Releases, Dropbox).
When you have download URLs, tell me and I'll wire a **"Download the desktop app"**
section into the Spinlist account page next to the web option.

---

## How it fits with the web version

Both use the **same** Spinlist account and the **same** saved library:
- Scan in the **desktop app** (fast) → it syncs to your account.
- Open **Prep in a wedding** on the website → it auto-loads that library and matches songs.

DJs can use whichever they prefer. The desktop app is the recommended way to do the
initial scan of a large library (especially on Mac/Safari).
