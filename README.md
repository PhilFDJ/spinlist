# Spinlist Gig Window

A small desktop app that opens your Spinlist gig window (the night's key info,
timeline and music) in a window that floats **always on top** of your DJ
software — no third-party pinning tools like WindowPin or Floaty needed.

## What it does
1. You sign in with your Spinlist email and password.
2. You pick tonight's gig (a wedding or an event) from your list.
3. It opens the gig window and keeps it floating above everything else.
   Tap another gig any time to switch.

The app shows the same gig window you already use on spinlist.co.uk — it just
gives it a native always-on-top frame. All your gig data stays on your Spinlist
account; the app only reads it to display.

## The do-not-play alarm

When a wedding has a block marked **Never play**, the gig window flashes red the
moment Music Manager reports that track coming off the deck — with the couple's
own note if they left one. A weak match asks "was that this one?" instead of
guessing, and a clean match ticks itself off.

The window polls for this every few seconds. Two settings exist purely to keep
that reliable, and both matter more than they look:

- `backgroundThrottling: false` on the gig window. Chromium treats an occluded
  window (macOS) or a minimised one (Windows) as hidden and throttles its timers
  to roughly once a minute. Without this, putting your DJ software full-screen
  over the top would silence the alarm with nothing on screen to say so.
- A `powerSaveBlocker` held only while a gig window is open. A laptop that sleeps
  at 11pm takes the alarm with it.

## Note on full-screen DJ software
If your DJ software runs in true full-screen mode, no window (native or not) can
float above it — that's an operating-system rule. Keep your DJ app in a normal
(windowed) mode and the gig window will stay visible.

## Building the installers

Installers are built automatically by GitHub Actions (see
`.github/workflows/build.yml`) whenever you publish a version tag like `v1.0.0`.
That produces Mac (.dmg/.zip) and Windows (.exe) installers and attaches them to
a GitHub release.

To build locally instead:

```
npm install
npm run dist:mac    # on a Mac
npm run dist:win    # on Windows
```

The app is unsigned, so on first launch:
- **macOS:** right-click the app → Open → Open.
- **Windows:** if SmartScreen appears, click More info → Run anyway.

## Development
```
npm install
npm start
```
Point at a different server with `SPINLIST_URL=http://localhost:3000 npm start`.
