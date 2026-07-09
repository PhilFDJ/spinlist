'use strict';
const $ = (id) => document.getElementById(id);
let CURRENT_FOLDER = null;
let PREV = {};          // path -> saved track (for incremental rescan)
let LAST_NAME = '';
let APP_VERSION = '?';
// Show which build is running (so diagnostics are unambiguous).
window.spinlist.appVersion().then(v => { APP_VERSION = v; const el = $('app-version'); if (el) el.textContent = 'v' + v; });

function fmtTime(secs){ secs=Math.max(0,Math.round(secs)); if(secs<60) return secs+'s'; const m=Math.floor(secs/60),s=secs%60; return s?(m+'m '+s+'s'):(m+'m'); }

/* ---------- login ---------- */
$('login-btn').addEventListener('click', doLogin);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

// On launch, try a remembered session so the DJ skips the login screen.
tryRestoreSession();
async function tryRestoreSession() {
  const msg = $('login-msg');
  if (msg) { msg.className = 'msg muted'; msg.textContent = 'Checking your saved sign-in…'; }
  let r;
  try { r = await window.spinlist.restoreSession(); } catch (_) { r = { ok: false }; }
  if (r && r.ok && r.user && r.user.prepAccess) {
    enterApp(r.user);
  } else if (msg) {
    msg.textContent = '';
  }
}

function enterApp(user) {
  $('login-panel').classList.add('hide');
  $('main-panel').classList.remove('hide');
  $('who').textContent = 'Signed in as ' + (user.name || user.email) + ' · ' + (user.planName || '');
  loadSaved();
}

async function doLogin() {
  const email = $('email').value.trim();
  const password = $('password').value;
  const remember = $('remember-me') ? $('remember-me').checked : true;
  const msg = $('login-msg');
  if (!email || !password) { msg.className = 'msg err'; msg.textContent = 'Enter your email and password.'; return; }
  msg.className = 'msg muted'; msg.textContent = 'Signing in…';
  $('login-btn').disabled = true;
  const r = await window.spinlist.login(email, password, remember);
  $('login-btn').disabled = false;
  if (!r.ok) { msg.className = 'msg err'; msg.textContent = r.error || 'Login failed.'; return; }
  if (!r.user || !r.user.prepAccess) {
    msg.className = 'msg err';
    msg.textContent = 'Your plan doesn\u2019t include the music library. Upgrade to Pro or higher on spinlist.co.uk.';
    return;
  }
  msg.textContent = '';
  enterApp(r.user);
}

$('logout-btn').addEventListener('click', async () => {
  try { await window.spinlist.logout(); } catch (_) {}
  $('main-panel').classList.add('hide');
  $('login-panel').classList.remove('hide');
  $('password').value = '';
  $('login-msg').textContent = '';
});

/* ---------- load existing saved library (for incremental + summary) ---------- */
async function loadSaved() {
  const sum = $('summary');
  const r = await window.spinlist.getLibrary();
  if (r.ok && r.library && Array.isArray(r.library.tracks) && r.library.tracks.length) {
    PREV = {};
    r.library.tracks.forEach(t => {
      const path = t.p || '';
      if (path) PREV[path] = { title: t.t || '', artist: t.a || '', video: !!t.v, size: t.s || 0, mtime: t.m || 0 };
    });
    LAST_NAME = r.library.name || '';
    const vids = r.library.tracks.filter(t => t.v).length;
    sum.textContent = r.library.tracks.length.toLocaleString() + ' tracks saved to your account'
      + (vids ? ' (' + vids + ' music videos)' : '') + '. Rescan to update.';
  } else {
    sum.textContent = 'No library saved yet. Choose your music folder above to scan and sync.';
  }
}

/* ---------- folder pick + scan ---------- */
$('pick-btn').addEventListener('click', async () => {
  const folder = await window.spinlist.pickFolder();
  if (!folder) return;
  CURRENT_FOLDER = folder;
  $('folder-path').textContent = folder;
  $('rescan-btn').classList.remove('hide');
  await runScan();
});
$('rescan-btn').addEventListener('click', () => { if (CURRENT_FOLDER) runScan(); });

// Isolated speed test — pick a folder, time one file with no parallelism.
$('speedtest-btn').addEventListener('click', async () => {
  const folder = CURRENT_FOLDER || await window.spinlist.pickFolder();
  if (!folder) return;
  const box = $('timing-box'); box.style.display = 'block';
  box.value = 'Running speed test on one file…';
  const r = await window.spinlist.speedTest(folder);
  if (r.error) { box.value = 'Speed test error: ' + r.error; return; }
  box.value =
    'SPEED TEST (build v' + APP_VERSION + ' — copy this and send it):\n' +
    'test file: ' + r.file + '  (' + r.sizeMB + ' MB)  |  files in folder: ' + r.totalFiles + '\n' +
    'raw open+read one file: ' + r.rawOpenReadMs + ' ms (avg of 50)\n' +
    'full tag read one file:  ' + r.fullReadTagsMs + ' ms (avg of 50)';
  box.select();
});

// Diagnostic: read where scan time is going, mid-scan, into a copyable box.
$('timing-btn').addEventListener('click', async () => {
  const t = await window.spinlist.timingNow();
  const box = $('timing-box');
  box.style.display = 'block';
  if (!t) { box.value = 'No scan running right now — press Choose folder / Rescan, wait ~30s, then tap this.'; return; }
  const perFile = t.perFileMs;
  const projected = t.total && t.read ? Math.round((t.scanMs / t.read) * t.total / 1000) : 0;
  box.value =
    'SCAN TIMING (build v' + APP_VERSION + ' — copy this and send it):\n' +
    'files found: ' + t.total + '  |  read so far: ' + t.read + '  |  reused: ' + t.reused + '\n' +
    'finding files: ' + (t.enumMs/1000).toFixed(1) + 's\n' +
    'reading so far: ' + (t.scanMs/1000).toFixed(1) + 's  (' + perFile + ' ms per file)\n' +
    '  - of that, stat: ' + (t.statMs/1000).toFixed(1) + 's,  tag reads: ' + (t.tagMs/1000).toFixed(1) + 's\n' +
    'projected total for all ' + t.total + ' files: ~' + projected + 's (' + (projected/60).toFixed(1) + ' min)';
  box.select();
});

let scanStart = 0;
window.spinlist.onScanTiming((t) => {
  // Show a plain-English breakdown of where scan time went (helps diagnose slow scans).
  const line = `Scan timing — files: ${t.total}, read: ${t.read}, reused: ${t.reused} · `
    + `finding files: ${(t.enumMs/1000).toFixed(1)}s · reading tags: ${(t.scanMs/1000).toFixed(1)}s `
    + `(${t.perFileMs}ms/file) · stat: ${(t.statMs/1000).toFixed(1)}s · tags: ${(t.tagMs/1000).toFixed(1)}s`;
  const el = $('save-msg');
  if (el) { el.className = 'msg muted'; el.textContent = line; }
  console.log(line);
});

window.spinlist.onScanProgress(({ done, total, reused, read, counting }) => {
  if (counting) { $('scan-stat').textContent = 'Finding your music files…'; $('bar').querySelector('i').style.width = '0%'; return; }
  const pct = total ? Math.round(done / total * 100) : 0;
  $('bar').querySelector('i').style.width = pct + '%';
  const elapsed = (Date.now() - scanStart) / 1000;
  const readRate = read / Math.max(0.001, elapsed);
  const frac = read / Math.max(1, done);
  const remaining = (total - done) * frac;
  const eta = readRate > 0 ? Math.round(remaining / readRate) : 0;
  $('scan-stat').textContent = done.toLocaleString() + ' / ' + total.toLocaleString() + ' files'
    + (reused ? '  ·  ' + reused.toLocaleString() + ' unchanged' : '')
    + (eta > 2 && read > 20 ? '  ·  ~' + fmtTime(eta) + ' left' : '');
});

async function runScan() {
  const saveMsg = $('save-msg');
  saveMsg.className = 'msg muted'; saveMsg.textContent = '';
  $('bar').classList.remove('hide');
  $('timing-btn').classList.remove('hide');   // let the user read timing mid-scan
  $('pick-btn').disabled = true; $('rescan-btn').disabled = true;
  scanStart = Date.now();
  const { lib, total, reused, read } = await window.spinlist.scanFolder(CURRENT_FOLDER, PREV);
  $('timing-btn').classList.add('hide');
  $('scan-stat').textContent = lib.length.toLocaleString() + ' tracks'
    + (reused ? ' (' + reused.toLocaleString() + ' unchanged, ' + read.toLocaleString() + ' newly read)' : '');
  // sync to account
  saveMsg.className = 'msg muted'; saveMsg.textContent = 'Saving to your Spinlist account…';
  const name = CURRENT_FOLDER.split(/[\\/]/).pop() || 'library';
  const r = await window.spinlist.saveLibrary(name, lib);
  $('pick-btn').disabled = false; $('rescan-btn').disabled = false;
  $('bar').classList.add('hide');
  if (r.ok) {
    saveMsg.className = 'msg ok';
    saveMsg.textContent = '\u2713 Synced ' + (r.count || lib.length).toLocaleString() + ' tracks to your Spinlist account.';
    // refresh PREV so the next rescan is incremental
    PREV = {};
    lib.forEach(t => { PREV[t.path] = { title: t.title, artist: t.artist, video: t.video, size: t.size, mtime: t.mtime }; });
    await loadSaved();
  } else {
    saveMsg.className = 'msg err';
    saveMsg.textContent = 'Not synced: ' + (r.error || 'unknown error') + '. Your scan is complete — try Rescan to sync again.';
  }
}
