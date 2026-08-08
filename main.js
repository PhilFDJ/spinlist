'use strict';
const { app, BrowserWindow, ipcMain, session, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { SeratoWatcher, candidateDirs } = require('./serato.js');

const BASE_URL = process.env.SPINLIST_URL || 'https://www.spinlist.co.uk';

let mainWin = null;
let gigWin = null;
let sleepBlocker = null;   // stops the Mac napping mid-set

/* ---------------- Serato watching ----------------
   Nothing here talks to Serato's software. It reads the history file Serato
   writes anyway, which is the only route available — there is no official API.

   Two jobs, and they need opposite handling:

     THE BAN ALARM fires the instant a track loads, checked against a list held
     on this machine. It must work when the venue wifi doesn't, because that's
     exactly when you can't look it up.

     THE PLAY TICK waits. Serato's file records loads and ejects, not play time,
     so a track loaded and pulled straight back looks identical to one played in
     full. Without the wait, every quick audition ticks a song off and the run
     sheet stops being worth reading.
   ---------------------------------------------------- */
const DWELL_MS = 45 * 1000;

let watcher = null;
let GIG = null;              // { kind, id, title }
let BAN_LIST = [];           // cached locally so the alarm survives a dead network
let banSource = 'none';      // 'server' | 'disk' | 'none'
let pending = null;          // { track, timer } — the dwell timer
let lastEvent = null;        // for the diagnostics panel

function prefsPath(name) {
  return path.join(app.getPath('userData'), name);
}

function settings() {
  try { return JSON.parse(fs.readFileSync(prefsPath('settings.json'), 'utf8')); }
  catch (e) { return {}; }
}
function saveSettings(patch) {
  const s = Object.assign(settings(), patch);
  try { fs.writeFileSync(prefsPath('settings.json'), JSON.stringify(s, null, 2)); } catch (e) {}
  return s;
}

async function cookieHeader() {
  const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/* Mirrors normaliseTrack() on the server. The two must agree, or a track the
   server would flag gets past the local check and vice versa. */
function normaliseTrack(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring|with)\b.*$/g, ' ')
    .replace(/\b(radio|extended|club|original|dirty|clean|explicit|instrumental)\s+(edit|mix|version)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/^\s*the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Loose on purpose: a false alarm costs a glance, a missed ban costs you the
   banned song at the wedding. */
function localBanHit(track) {
  const t = normaliseTrack(track.title);
  if (!t) return null;
  const isrc = (track.isrc || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  for (const s of BAN_LIST) {
    const si = (s.isrc || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (isrc && si && isrc === si) return s;
    if (normaliseTrack(s.title) === t) return s;
  }
  return null;
}

async function loadBanList(weddingId) {
  const cache = prefsPath('noplay-' + weddingId + '.json');
  try {
    const r = await fetch(`${BASE_URL}/api/weddings/${encodeURIComponent(weddingId)}/noplay`,
      { headers: { Cookie: await cookieHeader() } });
    if (r.ok) {
      const d = await r.json();
      BAN_LIST = (d && d.songs) || [];
      banSource = 'server';
      try { fs.writeFileSync(cache, JSON.stringify(d)); } catch (e) {}
      return;
    }
  } catch (e) { /* offline — fall through to the cached copy */ }
  try {
    const d = JSON.parse(fs.readFileSync(cache, 'utf8'));
    BAN_LIST = (d && d.songs) || [];
    banSource = 'disk';
  } catch (e) { BAN_LIST = []; banSource = 'none'; }
}

/* Shows the alarm in the gig window WITHOUT waiting for the server, so it works
   with no network at all. gig.html renders the same banner from its own polling;
   this just gets there first. */
function alarmLocally(payload) {
  if (gigWin && !gigWin.isDestroyed()) {
    const js = `(function(){ try{
      if (typeof showNowPlaying === 'function') { showNowPlaying(${JSON.stringify(payload)}); return true; }
    }catch(e){} return false; })()`;
    gigWin.webContents.executeJavaScript(js).then(ok => {
      if (!ok) nativeAlarm(payload);
    }).catch(() => nativeAlarm(payload));
    try { gigWin.flashFrame(true); gigWin.showInactive(); } catch (e) {}
  } else {
    nativeAlarm(payload);
  }
}

/* If the gig window isn't open or the page has changed, a silent failure is the
   worst outcome — so fall back to something the OS will show regardless. */
function nativeAlarm(payload) {
  try {
    if (!Notification.isSupported()) return;
    const t = (payload.played && payload.played.title) || 'That track';
    new Notification({
      title: '⛔ Do not play',
      body: t + (payload.song && payload.song.note_couple ? ' — ' + payload.song.note_couple : ''),
      urgency: 'critical',
    }).show();
  } catch (e) {}
}

async function reportTrack(track, opts) {
  if (!GIG || GIG.kind !== 'w') return null;
  try {
    const r = await fetch(`${BASE_URL}/api/weddings/${encodeURIComponent(GIG.id)}/now-playing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await cookieHeader() },
      body: JSON.stringify({
        title: track.title || '', artist: track.artist || '',
        isrc: track.isrc || '', mark: !!(opts && opts.mark),
      }),
    });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    return await r.json();
  } catch (e) { return { error: 'offline' }; }
}

function noteEvent(kind, detail) {
  lastEvent = Object.assign({ kind, at: Date.now() }, detail);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('serato-event', lastEvent);
  }
}

function onSeratoTrack(track) {
  noteEvent('track', { title: track.title, artist: track.artist,
                       fromFilename: !!track.titleFromFilename });

  // The ban check happens first and immediately, on the local list.
  const banned = localBanHit(track);
  if (banned) {
    const payload = {
      verdict: 'noplay', confidence: 'local', marked: false,
      block: { id: null, name: banned.block || 'Do not play' },
      song: { id: null, title: banned.title, artist: banned.artist,
              note_couple: banned.note_couple || '', note_dj: '' },
      played: { title: track.title || '', artist: track.artist || '' },
      at: Date.now(),
    };
    alarmLocally(payload);
    noteEvent('banned', { title: track.title, matched: banned.title, source: banSource });
    reportTrack(track, { mark: false });     // best effort, for the record
    return;
  }

  /* Not banned: wait before calling it played. If another track arrives first,
     this one was an audition and the timer is dropped. */
  if (pending && pending.timer) clearTimeout(pending.timer);
  pending = {
    track,
    timer: setTimeout(async () => {
      const res = await reportTrack(track, { mark: true });
      noteEvent('reported', {
        title: track.title,
        verdict: res && res.verdict, marked: !!(res && res.marked),
        error: res && res.error,
      });
      pending = null;
    }, DWELL_MS),
  };
  noteEvent('waiting', { title: track.title, seconds: Math.round(DWELL_MS / 1000) });
}

function startWatcher() {
  if (watcher) return;
  watcher = new SeratoWatcher({ folder: settings().seratoFolder || null });
  watcher.on('track', onSeratoTrack);
  watcher.on('status', st => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('serato-status', st);
  });
  watcher.on('session', s => noteEvent('session', { file: s.file }));
  watcher.start();
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 520,
    title: 'Spinlist Gig Window',
    backgroundColor: '#0a1228',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile('renderer.html');
  mainWin.on('closed', () => { mainWin = null; });
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------------- Login ----------------
   We log in through the SHARED Electron session, so the auth cookie is stored
   in the session and automatically sent when the gig window loads gig.html. */
ipcMain.handle('login', async (evt, { email, password, remember }) => {
  try {
    const r = await fetch(BASE_URL + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (data && data.error) || 'Login failed' };
    // Persist the returned auth cookie into Electron's default session so the
    // gig window (which loads a real page from the site) is authenticated.
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const url = BASE_URL;
      try {
        // When "remember" is on, set an explicit expiry so Electron keeps the
        // cookie on disk across restarts; otherwise it's a session cookie that
        // disappears when the app quits.
        const cookieSpec = {
          url, name, value,
          domain: new URL(BASE_URL).hostname,
          path: '/', httpOnly: true, secure: BASE_URL.startsWith('https'),
        };
        if (remember) cookieSpec.expirationDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
        await session.defaultSession.cookies.set(cookieSpec);
      } catch (e) { /* non-fatal; the fetch below re-checks auth */ }
    }
    return { ok: true, user: data.user };
  } catch (e) {
    return { ok: false, error: 'Could not reach Spinlist. Check your connection.' };
  }
});

// On launch, check whether a remembered session cookie is still valid so the
// DJ can skip the login screen.
ipcMain.handle('restore-session', async () => {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
    if (!cookies || !cookies.length) return { ok: false };
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const r = await fetch(BASE_URL + '/api/me', { headers: { Cookie: cookieHeader } });
    if (!r.ok) return { ok: false };
    const data = await r.json().catch(() => ({}));
    if (!data || !data.user) return { ok: false };
    return { ok: true, user: data.user };
  } catch (e) { return { ok: false, offline: true }; }
});

// Log out: tell the server and clear the stored cookie(s).
ipcMain.handle('logout', async () => {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    await fetch(BASE_URL + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookieHeader } });
  } catch (_) {}
  try {
    const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
    for (const c of cookies) {
      await session.defaultSession.cookies.remove(BASE_URL, c.name);
    }
  } catch (_) {}
  return { ok: true };
});

// Fetch the DJ's weddings + events for the picker (uses the session cookie).
ipcMain.handle('list-gigs', async () => {
  async function getJSON(pathname) {
    try {
      const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const r = await fetch(BASE_URL + pathname, { headers: { Cookie: cookieHeader } });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }
  const [w, e] = await Promise.all([getJSON('/api/weddings'), getJSON('/api/my-events')]);
  const weddings = (w && w.weddings || []).filter(x => !x.archived)
    .map(x => ({ kind: 'w', id: x.id, name: x.name, sub: x.coupleNames || '', date: x.weddingDate || null }));
  const events = (e && e.events || []).filter(x => !x.archived)
    .map(x => ({ kind: 'e', id: x.id, name: x.name, sub: x.type || '', date: x.eventDate || null }));
  return { ok: true, gigs: [...weddings, ...events] };
});

// Open (or re-point) the always-on-top gig window at the chosen gig.
ipcMain.handle('open-gig', async (evt, { kind, id, title }) => {
  const url = BASE_URL + '/gig.html?' + (kind === 'e' ? 'e=' : 'w=') + encodeURIComponent(id);

  /* Remember which gig we're on and pull its ban list down NOW, while there's
     probably still a connection — not at the moment the alarm is needed. */
  GIG = { kind, id, title };
  if (pending && pending.timer) { clearTimeout(pending.timer); pending = null; }
  if (kind === 'w') {
    await loadBanList(id);
    noteEvent('gig', { title, banned: BAN_LIST.length, source: banSource });
    startWatcher();
  } else {
    BAN_LIST = []; banSource = 'none';
    noteEvent('gig', { title, banned: 0, source: 'n/a — events have no do-not-play list' });
  }

  if (gigWin && !gigWin.isDestroyed()) {
    gigWin.loadURL(url);
    gigWin.setAlwaysOnTop(true, 'screen-saver');
    gigWin.show();
    gigWin.focus();
    return { ok: true };
  }
  gigWin = new BrowserWindow({
    width: 400,
    height: 620,
    minWidth: 300,
    minHeight: 360,
    title: 'Gig · ' + (title || 'Spinlist'),
    backgroundColor: '#070b16',
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      /* The gig window polls for the do-not-play alarm every few seconds.
         Chromium treats an occluded window (macOS) or a minimised one (Windows)
         as hidden and throttles its timers to roughly once a minute — so if the
         DJ software goes full screen over the top, or the window gets
         minimised, the alarm would go quiet with nothing on screen to say so.
         Set at creation rather than toggled later, which is a known source of
         render desync when the window is already hidden. */
      backgroundThrottling: false,
    },
  });
  // 'screen-saver' level floats above most full-screen-ish app windows.
  gigWin.setAlwaysOnTop(true, 'screen-saver');
  // Show on all workspaces (macOS) so it stays visible as you switch spaces.
  try { gigWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  gigWin.loadURL(url);
  startSleepBlocker();
  gigWin.on('closed', () => { gigWin = null; stopSleepBlocker(); });
  return { ok: true };
});

/* A laptop that goes to sleep at 11pm takes the alarm with it. Held only while
   a gig window is actually open, so the app isn't keeping the machine awake all
   week for nothing. */
function startSleepBlocker() {
  try {
    if (sleepBlocker !== null && powerSaveBlocker.isStarted(sleepBlocker)) return;
    sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  } catch (e) { /* not fatal — the window still works */ }
}
function stopSleepBlocker() {
  try {
    if (sleepBlocker !== null && powerSaveBlocker.isStarted(sleepBlocker)) {
      powerSaveBlocker.stop(sleepBlocker);
    }
  } catch (e) {}
  sleepBlocker = null;
}
app.on('before-quit', stopSleepBlocker);

/* Everything the diagnostics panel needs. Serato's file format isn't officially
   documented and the field ids have moved between versions, so being able to see
   exactly what was read matters more here than in most places. */
ipcMain.handle('serato-status', async () => ({
  ok: true,
  watching: watcher ? watcher.status() : { running: false, searched: candidateDirs() },
  gig: GIG,
  banList: { count: BAN_LIST.length, source: banSource,
             titles: BAN_LIST.slice(0, 20).map(s => s.title) },
  dwellSeconds: Math.round(DWELL_MS / 1000),
  lastEvent,
  pending: pending ? pending.track.title : null,
}));

ipcMain.handle('set-serato-folder', async (evt, folder) => {
  saveSettings({ seratoFolder: folder || null });
  if (watcher) watcher.setFolder(folder || null);
  else startWatcher();
  return { ok: true, status: watcher ? watcher.status() : null };
});

ipcMain.handle('refresh-ban-list', async () => {
  if (!GIG || GIG.kind !== 'w') return { ok: false, error: 'Open a wedding first.' };
  await loadBanList(GIG.id);
  return { ok: true, count: BAN_LIST.length, source: banSource };
});

/* Fires the whole chain with a made-up track, so the alarm can be proved working
   without waiting for a real gig — or without Serato installed at all. */
ipcMain.handle('test-track', async (evt, { title, artist }) => {
  if (!GIG) return { ok: false, error: 'Open a gig first.' };
  onSeratoTrack({ title: title || '', artist: artist || '', isrc: '' });
  return { ok: true, banned: !!localBanHit({ title, artist }) };
});

// Toggle always-on-top from the main window (in case the DJ wants it off).
ipcMain.handle('set-on-top', async (evt, on) => {
  if (gigWin && !gigWin.isDestroyed()) {
    gigWin.setAlwaysOnTop(!!on, 'screen-saver');
    return { ok: true, on: !!on };
  }
  return { ok: false };
});
