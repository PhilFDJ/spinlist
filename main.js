'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// The Spinlist backend base URL. Override with SPINLIST_URL env var if self-hosting.
const BASE_URL = process.env.SPINLIST_URL || 'https://www.spinlist.co.uk';

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 560,
    minHeight: 520,
    title: 'Spinlist Music Manager',
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('renderer.html');
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------------- native folder scan ---------------- */
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|aiff?|ogg|wma)$/i;
const VIDEO_RE = /\.(mp4|m4v|mov|avi|mkv)$/i;

// Recursively list media files under a directory (native fs — fast).
async function listMedia(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full); }
      else if (AUDIO_RE.test(e.name) || VIDEO_RE.test(e.name)) { out.push(full); }
    }
  }
  await walk(dir);
  return out;
}

// Read a chunk from an already-open file handle (no per-call open/close).
async function readAt(fd, start, length, fileSize) {
  const len = Math.max(0, Math.min(length, fileSize - start));
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, start);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

function decodeFrame(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0]; const body = bytes.subarray(1);
  try {
    if (enc === 1 || enc === 2) return Buffer.from(body).toString('utf16le').replace(/\u0000+$/, '').trim();
    if (enc === 3) return Buffer.from(body).toString('utf8').replace(/\u0000+$/, '').trim();
    let s = ''; for (const b of body) { if (b === 0) break; s += String.fromCharCode(b); } return s.trim();
  } catch (_) { return ''; }
}

function parseMp4Tags(buf) {
  const res = { title: '', artist: '' };
  const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  const A9 = '\u00A9';
  const wanted = { [A9 + 'nam']: 'title', [A9 + 'ART']: 'artist', 'aART': 'artist' };
  for (let i = 0; i + 8 < buf.length; i++) {
    const name = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    const which = wanted[name];
    if (!which) continue;
    const atomStart = i - 4; if (atomStart < 0) continue;
    const atomSize = u32(atomStart);
    if (atomSize < 16 || atomStart + atomSize > buf.length) continue;
    let j = i + 4; const atomEnd = atomStart + atomSize;
    while (j + 8 < atomEnd) {
      if (buf[j] === 0x64 && buf[j + 1] === 0x61 && buf[j + 2] === 0x74 && buf[j + 3] === 0x61) {
        const dataSize = u32(j - 4);
        const payloadStart = j + 4 + 8;
        const payloadEnd = Math.min(j - 4 + dataSize, atomEnd);
        if (payloadEnd > payloadStart) {
          try { const val = Buffer.from(buf.subarray(payloadStart, payloadEnd)).toString('utf8').replace(/\u0000+$/, '').trim(); if (val && !res[which]) res[which] = val; } catch (_) {}
        }
        break;
      }
      j++;
    }
  }
  return res;
}

function mp4HasVideoTrack(buf) {
  for (let i = 0; i + 16 < buf.length; i++) {
    if (buf[i] === 0x68 && buf[i + 1] === 0x64 && buf[i + 2] === 0x6c && buf[i + 3] === 0x72) {
      const h = i + 12;
      if (h + 4 <= buf.length && buf[h] === 0x76 && buf[h + 1] === 0x69 && buf[h + 2] === 0x64 && buf[h + 3] === 0x65) return true;
    }
  }
  return false;
}

// Walk the top-level MP4 boxes to find the exact offset+size of 'moov' (the metadata
// container). This lets us read ONLY the metadata region — wherever it is in the file —
// instead of blindly reading a big chunk of the tail. Reads box headers on demand.
async function findMoov(fd, fileSize) {
  let offset = 0;
  const hdr = Buffer.alloc(16);
  while (offset + 8 <= fileSize) {
    const { bytesRead } = await fd.read(hdr, 0, 16, offset);
    if (bytesRead < 8) break;
    let size = (hdr[0] << 24 | hdr[1] << 16 | hdr[2] << 8 | hdr[3]) >>> 0;
    const type = String.fromCharCode(hdr[4], hdr[5], hdr[6], hdr[7]);
    let headerLen = 8;
    if (size === 1) {
      // 64-bit size in the next 8 bytes (rare, huge files). Read low 32 bits (plenty).
      size = (hdr[12] << 24 | hdr[13] << 16 | hdr[14] << 8 | hdr[15]) >>> 0;
      headerLen = 16;
    }
    if (type === 'moov') return { offset, size };
    if (size < headerLen) break;            // malformed — stop
    offset += size;
  }
  return null;
}

async function readTags(filePath) {
  const out = { title: '', artist: '', video: false, size: 0, mtimeMs: 0 };
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const st = await fd.stat();                 // stat via the open handle — no second path lookup
    out.size = st.size; out.mtimeMs = st.mtimeMs;
    const size = st.size;
    // One modest head read — most ID3v2 and MP4 tags live in the first ~16KB.
    let head = await readAt(fd, 0, Math.min(16 * 1024, size), size);
    // MP3 / ID3v2
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      if (10 + tagSize > head.length) head = await readAt(fd, 0, Math.min(10 + tagSize, 512 * 1024), size);
      const end = Math.min(10 + tagSize, head.length);
      let i = 10;
      while (i + 10 < end) {
        const id = String.fromCharCode(head[i], head[i + 1], head[i + 2], head[i + 3]);
        const fsz = (head[i + 4] << 24) | (head[i + 5] << 16) | (head[i + 6] << 8) | head[i + 7];
        if (fsz <= 0 || i + 10 + fsz > head.length) break;
        if (id === 'TIT2' || id === 'TPE1' || id === 'TT2' || id === 'TP1') {
          const val = decodeFrame(head.subarray(i + 10, i + 10 + fsz));
          if (id[1] === 'I' || id === 'TT2') out.title = out.title || val; else out.artist = out.artist || val;
        }
        i += 10 + fsz;
      }
    }
    // MP4 / M4A / video — read the REAL tags wherever they live, without a slow blind tail read.
    const isMp4 = head.length > 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
    if (isMp4) {
      if (mp4HasVideoTrack(head)) out.video = true;
      // Tags in the head already? (moov-at-front files.)
      const t = parseMp4Tags(head);
      out.title = out.title || t.title; out.artist = out.artist || t.artist;
      if (!out.title || !out.artist || !out.video) {
        // Jump straight to moov (metadata) wherever it is — one targeted read of just that region.
        const moov = await findMoov(fd, size);
        if (moov) {
          const cap = Math.min(moov.size, 4 * 1024 * 1024);   // read up to 4MB of moov (plenty for tags)
          const buf = await readAt(fd, moov.offset, cap, size);
          if (!out.video && mp4HasVideoTrack(buf)) out.video = true;
          const mt = parseMp4Tags(buf);
          out.title = out.title || mt.title; out.artist = out.artist || mt.artist;
        }
      }
    }
    // ID3v1 tail — ONLY if we still need something and it's an MP3-ish file (skip the extra read otherwise).
    if ((!out.title || !out.artist) && !isMp4) {
      const tail = await readAt(fd, Math.max(0, size - 128), 128, size);
      if (tail.length >= 128 && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) {
        const rd = (s, e) => { let str = ''; for (let k = s; k < e; k++) { if (tail[k] === 0) break; str += String.fromCharCode(tail[k]); } return str.trim(); };
        out.title = out.title || rd(3, 33); out.artist = out.artist || rd(33, 63);
      }
    }
  } catch (_) {}
  finally { if (fd) { try { await fd.close(); } catch (_) {} } }
  if (/\.(m4v|mov|avi|mkv)$/i.test(filePath)) out.video = true; // unambiguous video ext
  // A large .mp4 is almost certainly a music video, not an audio file.
  if (!out.video && /\.mp4$/i.test(filePath) && size > 40 * 1024 * 1024) out.video = true;
  return out;
}

/* ---------------- IPC: folder picker + scan ---------------- */
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// Live scan stats — readable at any time via the 'scan-timing-now' handler (for the diagnostic button).
let SCAN = null;

// Scan a folder. `prev` is a map of path -> {title,artist,video,size,mtime} for incremental reuse.
ipcMain.handle('scan-folder', async (evt, { folder, prev }) => {
  win.webContents.send('scan-progress', { done: 0, total: 0, reused: 0, read: 0, counting: true });
  const tEnum0 = Date.now();
  const files = await listMedia(folder);
  const enumMs = Date.now() - tEnum0;
  const total = files.length;
  const prevMap = prev || {};
  const lib = [];
  let done = 0, reused = 0, read = 0;
  const CONC = 64;   // internal SSDs handle high parallelism well
  let statMs = 0, tagMs = 0;   // cumulative timing to find the bottleneck
  const tScanStart = Date.now();
  SCAN = { get done(){return done;}, get read(){return read;}, get reused(){return reused;},
           total, enumMs, get statMs(){return statMs;}, get tagMs(){return tagMs;}, tScanStart };
  const send = () => win.webContents.send('scan-progress', { done, total, reused, read });
  send();   // show the total straight away
  const hasPrev = prevMap && Object.keys(prevMap).length > 0;
  async function handle(fp) {
    try {
      const isVidExt = /\.(m4v|mov|avi|mkv)$/i.test(fp);
      // INCREMENTAL: only when we have a previous library — a cheap stat lets us skip unchanged files.
      if (hasPrev) {
        const ts = Date.now();
        const st = await fsp.stat(fp);
        statMs += Date.now() - ts;
        const p = prevMap[fp];
        if (p && p.size === st.size && p.mtime === st.mtimeMs) {
          lib.push({ title: p.title, artist: p.artist, path: fp, video: !!p.video, size: st.size, mtime: st.mtimeMs });
          reused++; done++; if (done % 100 === 0) send(); return;
        }
      }
      // Open once — readTags now also returns size + mtime from the open handle (no separate stat).
      const tt = Date.now();
      const tags = await readTags(fp);
      tagMs += Date.now() - tt;
      read++;
      let title = (tags.title || '').trim(), artist = (tags.artist || '').trim();
      if (!title) {
        const base = path.basename(fp).replace(/\.[^.]+$/, '');
        const parts = base.split(' - ');
        if (parts.length >= 2) { artist = artist || parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
        else title = base.trim();
      }
      lib.push({ title, artist, path: fp, video: !!tags.video || isVidExt, size: tags.size, mtime: tags.mtimeMs });
      done++; if (done % 100 === 0) send();
    } catch (_) { done++; }
  }
  const tScan0 = Date.now();
  for (let i = 0; i < files.length; i += CONC) {
    await Promise.all(files.slice(i, i + CONC).map(handle));
  }
  const scanMs = Date.now() - tScan0;
  SCAN = null;
  // Report where the time went so we can diagnose slow scans.
  win.webContents.send('scan-timing', {
    total, read, reused, enumMs, scanMs,
    statMs: Math.round(statMs), tagMs: Math.round(tagMs),
    perFileMs: read ? +(scanMs / read).toFixed(1) : 0
  });
  send();
  return { lib, total, reused, read };
});

// Live timing snapshot — called by the "Show timing so far" button mid-scan.
ipcMain.handle('timing-now', async () => {
  if (!SCAN) return null;
  const scanMs = Date.now() - SCAN.tScanStart;
  return {
    total: SCAN.total, read: SCAN.read, reused: SCAN.reused, done: SCAN.done,
    enumMs: SCAN.enumMs, scanMs,
    statMs: Math.round(SCAN.statMs), tagMs: Math.round(SCAN.tagMs),
    perFileMs: SCAN.read ? +(scanMs / SCAN.read).toFixed(1) : 0
  };
});

ipcMain.handle('app-version', async () => { try { return app.getVersion(); } catch (_) { return '?'; } });

// Isolated speed test: pick ONE folder, grab the first media file, and time
// (a) opening+reading it 50x, and (b) a full readTags 50x. Zero parallelism —
// this tells us the raw per-file cost with no ambiguity.
ipcMain.handle('speed-test', async (evt, folder) => {
  try {
    const files = await listMedia(folder);
    if (!files.length) return { error: 'No media files found in that folder.' };
    const fp = files[0];
    const st = await fsp.stat(fp);
    // (a) raw open + small read, 50 times
    let t0 = Date.now();
    for (let k = 0; k < 50; k++) {
      const fd = await fsp.open(fp, 'r');
      const buf = Buffer.alloc(16384);
      await fd.read(buf, 0, 16384, 0);
      await fd.close();
    }
    const rawMs = (Date.now() - t0) / 50;
    // (b) full readTags, 50 times
    t0 = Date.now();
    for (let k = 0; k < 50; k++) { await readTags(fp); }
    const tagMs = (Date.now() - t0) / 50;
    return { file: path.basename(fp), sizeMB: +(st.size/1024/1024).toFixed(1),
             rawOpenReadMs: +rawMs.toFixed(1), fullReadTagsMs: +tagMs.toFixed(1), totalFiles: files.length };
  } catch (e) { return { error: String(e && e.message || e) }; }
});

/* ---------------- IPC: talk to Spinlist backend ---------------- */
// We use Electron's net via fetch (Node 18+ global fetch is available in main).
let SESSION_COOKIE = '';

// Where we remember the session (only when the DJ ticks "Remember me").
// Electron's userData folder is per-user and app-private.
function sessionFile() { return path.join(app.getPath('userData'), 'session.json'); }
function saveSessionToDisk() {
  try { fs.writeFileSync(sessionFile(), JSON.stringify({ cookie: SESSION_COOKIE }), { mode: 0o600 }); } catch (_) {}
}
function clearSessionOnDisk() {
  try { fs.unlinkSync(sessionFile()); } catch (_) {}
}
function readSessionFromDisk() {
  try { const d = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); return (d && d.cookie) || ''; } catch (_) { return ''; }
}

ipcMain.handle('login', async (evt, { email, password, remember }) => {
  try {
    const r = await fetch(BASE_URL + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) SESSION_COOKIE = setCookie.split(';')[0];
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (data && data.error) || 'Login failed' };
    // Persist the session only if the DJ asked us to remember it.
    if (remember && SESSION_COOKIE) saveSessionToDisk(); else clearSessionOnDisk();
    return { ok: true, user: data.user };
  } catch (e) { return { ok: false, error: 'Could not reach Spinlist. Check your connection.' }; }
});

// Try to restore a remembered session on launch. Validates it against the
// server; if it's expired/invalid, we clear it and the user logs in normally.
ipcMain.handle('restore-session', async () => {
  const cookie = readSessionFromDisk();
  if (!cookie) return { ok: false };
  SESSION_COOKIE = cookie;
  try {
    const r = await fetch(BASE_URL + '/api/me', { headers: { Cookie: SESSION_COOKIE } });
    if (!r.ok) { SESSION_COOKIE = ''; clearSessionOnDisk(); return { ok: false }; }
    const data = await r.json().catch(() => ({}));
    if (!data || !data.user) { SESSION_COOKIE = ''; clearSessionOnDisk(); return { ok: false }; }
    return { ok: true, user: data.user };
  } catch (e) {
    // Network error — keep the cookie (might be offline), but report not-restored.
    return { ok: false, offline: true };
  }
});

// Log out: tell the server, wipe the in-memory + on-disk session.
ipcMain.handle('logout', async () => {
  try { await fetch(BASE_URL + '/api/auth/logout', { method: 'POST', headers: { Cookie: SESSION_COOKIE } }); } catch (_) {}
  SESSION_COOKIE = '';
  clearSessionOnDisk();
  return { ok: true };
});

ipcMain.handle('get-library', async () => {
  try {
    const r = await fetch(BASE_URL + '/api/prep/library', { headers: { Cookie: SESSION_COOKIE } });
    if (!r.ok) return { ok: false, error: 'Could not load saved library (' + r.status + ')' };
    const d = await r.json();
    return { ok: true, library: d.library };
  } catch (e) { return { ok: false, error: 'Network error' }; }
});

ipcMain.handle('save-library', async (evt, { name, lib }) => {
  try {
    const tracks = lib.map(t => {
      const o = { t: t.title, a: t.artist, p: t.path };
      if (t.video) o.v = 1;
      if (Number.isFinite(t.size)) o.s = t.size;
      if (Number.isFinite(t.mtime)) o.m = t.mtime;
      return o;
    });
    const r = await fetch(BASE_URL + '/api/prep/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: SESSION_COOKIE },
      body: JSON.stringify({ library: { name: name || 'library', tracks } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (d && d.error) || ('Save failed (' + r.status + ')') };
    return { ok: true, count: d.count };
  } catch (e) { return { ok: false, error: 'Network error while saving' }; }
});
