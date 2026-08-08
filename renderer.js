'use strict';
const $ = (id) => document.getElementById(id);
let GIGS = [];

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
  if (r && r.ok && r.user) {
    enterPicker(r.user);
  } else if (msg) {
    msg.textContent = '';
  }
}

function enterPicker(user) {
  $('login-who').textContent = user && (user.name || user.email) ? ('Signed in as ' + (user.name || user.email)) : 'Signed in';
  $('login-panel').classList.add('hide');
  $('picker-panel').classList.remove('hide');
  seratoPanel(true);
  pollSerato();
  loadGigs();
}

async function doLogin() {
  const email = $('email').value.trim();
  const password = $('password').value;
  const remember = $('remember-me') ? $('remember-me').checked : true;
  const msg = $('login-msg');
  if (!email || !password) { msg.className = 'msg err'; msg.textContent = 'Enter your email and password.'; return; }
  $('login-btn').disabled = true;
  msg.className = 'msg muted'; msg.textContent = 'Signing in…';
  const r = await window.spinlist.login(email, password, remember);
  $('login-btn').disabled = false;
  if (!r.ok) { msg.className = 'msg err'; msg.textContent = r.error || 'Login failed.'; return; }
  msg.className = 'msg ok'; msg.textContent = '';
  enterPicker(r.user);
}

/* ---------- gig picker ---------- */
$('refresh-btn').addEventListener('click', loadGigs);
$('signout-btn').addEventListener('click', async () => {
  try { await window.spinlist.logout(); } catch (_) {}
  $('picker-panel').classList.add('hide');
  seratoPanel(false);
  $('login-panel').classList.remove('hide');
  $('password').value = '';
  $('login-msg').textContent = '';
});
$('gig-search').addEventListener('input', renderGigs);

async function loadGigs() {
  const list = $('gig-list');
  list.innerHTML = '<p class="msg muted">Loading your gigs…</p>';
  const r = await window.spinlist.listGigs();
  GIGS = (r && r.gigs) || [];
  renderGigs();
}

function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return ''; }
}

function renderGigs() {
  const list = $('gig-list');
  const q = ($('gig-search').value || '').trim().toLowerCase();
  const items = GIGS.filter(g => !q || (g.name || '').toLowerCase().includes(q) || (g.sub || '').toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = '<p class="msg muted">' + (GIGS.length ? 'No gigs match your search.' : 'No gigs found. Create an event or wedding on spinlist.co.uk first.') + '</p>';
    return;
  }
  list.innerHTML = '';
  items.forEach(g => {
    const div = document.createElement('div');
    div.className = 'gig';
    const meta = [g.sub, fmtDate(g.date)].filter(Boolean).join(' · ');
    div.innerHTML =
      '<div style="min-width:0"><div class="n">' + escapeHtml(g.name || 'Untitled') + '</div>' +
      (meta ? '<div class="s">' + escapeHtml(meta) + '</div>' : '') + '</div>' +
      '<span class="tag ' + (g.kind === 'e' ? 'ev' : '') + '">' + (g.kind === 'e' ? 'Event' : 'Wedding') + '</span>';
    div.style.cursor = 'pointer';
    div.addEventListener('click', () => openGig(g));
    list.appendChild(div);
  });
}

async function openGig(g) {
  const msg = $('picker-msg');
  msg.className = 'msg muted';
  msg.textContent = 'Opening ' + (g.name || 'gig') + '…';
  const r = await window.spinlist.openGig(g.kind, g.id, g.name);
  if (r && r.ok) {
    msg.className = 'msg ok';
    msg.textContent = '✓ Gig window open and floating on top. Drag it beside your decks. Tap another gig to switch.';
    pollSerato();
  } else {
    msg.className = 'msg err';
    msg.textContent = 'Could not open the gig window.';
  }
}

/* ---------- Serato diagnostics ----------
   Serato's file format isn't officially documented and the field ids have moved
   between versions, so this panel exists to make a failure visible and
   reportable rather than silent. */
const LOG = [];

function seratoPanel(show) {
  const p = $('serato-panel');
  if (p) p.classList.toggle('hide', !show);
}

function setStat(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'v' + (cls ? ' ' + cls : '');
}

function shortPath(p) {
  if (!p) return '—';
  const parts = p.split(/[\\/]/);
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p;
}

function renderLog() {
  const el = $('s-log');
  if (!el) return;
  if (!LOG.length) { el.textContent = 'Nothing yet.'; return; }
  el.innerHTML = LOG.slice(0, 60).map(e => {
    const t = new Date(e.at).toLocaleTimeString();
    let body;
    if (e.kind === 'banned') {
      body = '<span class="ban">⛔ ' + escapeHtml(e.title || '') + '</span> matched “' +
             escapeHtml(e.matched || '') + '” — alarm sent';
    } else if (e.kind === 'waiting') {
      body = '▸ ' + escapeHtml(e.title || '') + ' — waiting ' + e.seconds + 's before ticking it off';
    } else if (e.kind === 'reported') {
      body = (e.error ? '⚠ ' : '<span class="ok">✓</span> ') + escapeHtml(e.title || '') +
             ' — ' + (e.error ? escapeHtml(e.error) : (e.verdict || '?') + (e.marked ? ', ticked' : ', not ticked'));
    } else if (e.kind === 'track') {
      body = '♫ ' + escapeHtml(e.title || '(no title)') +
             (e.artist ? ' — ' + escapeHtml(e.artist) : '') +
             (e.fromFilename ? ' <span class="t">(title taken from the filename — untagged)</span>' : '');
    } else if (e.kind === 'session') {
      body = '<span class="t">Following ' + escapeHtml(shortPath(e.file)) + '</span>';
    } else if (e.kind === 'gig') {
      body = '<span class="t">Gig: ' + escapeHtml(e.title || '') + ' — ' + e.banned +
             ' banned track(s), from ' + escapeHtml(e.source || '') + '</span>';
    } else {
      body = '<span class="t">' + escapeHtml(e.kind) + '</span>';
    }
    return '<div class="l"><span class="t">' + t + '</span> ' + body + '</div>';
  }).join('');
}

function applyStatus(s) {
  if (!s) return;
  const w = s.watching || {};
  const found = !!w.dir;
  setStat('s-dir', found ? shortPath(w.dir) : 'not found', found ? 'good' : 'bad');
  setStat('s-file', w.file ? shortPath(w.file) : (found ? 'waiting for Serato to open a session' : '—'));
  setStat('s-seen', String(w.entriesSeen || 0));
  setStat('s-err', w.lastError || 'none', w.lastError ? 'bad' : '');
  const b = s.banList || {};
  const srcWord = b.source === 'server' ? 'downloaded' : b.source === 'disk' ? 'from this computer (offline)' : 'none';
  setStat('s-ban', b.count ? b.count + ' track(s), ' + srcWord : 'none', b.count ? 'good' : '');
  const nf = $('s-nofolder');
  if (nf) nf.classList.toggle('hide', found);
}

async function pollSerato() {
  try {
    const s = await window.spinlist.seratoStatus();
    applyStatus(s);
  } catch (e) {}
}

if (window.spinlist.onSeratoEvent) {
  window.spinlist.onSeratoEvent(e => { LOG.unshift(e); renderLog(); pollSerato(); });
}
if (window.spinlist.onSeratoStatus) {
  window.spinlist.onSeratoStatus(() => pollSerato());
}

const folderBtn = $('s-folder-btn');
if (folderBtn) folderBtn.addEventListener('click', async () => {
  const v = ($('s-folder').value || '').trim();
  if (!v) return;
  await window.spinlist.setSeratoFolder(v);
  pollSerato();
});

const testBtn = $('s-test-btn');
if (testBtn) testBtn.addEventListener('click', async () => {
  const v = ($('s-test').value || '').trim();
  if (!v) return;
  const r = await window.spinlist.testTrack(v, '');
  const msg = $('picker-msg');
  if (msg) {
    msg.className = 'msg ' + (r && r.ok ? (r.banned ? 'err' : 'muted') : 'err');
    msg.textContent = !r || !r.ok ? (r && r.error) || 'Open a gig first.'
      : r.banned ? '⛔ On the do-not-play list — the gig window should be flashing red.'
                 : 'Not on the do-not-play list. It will be ticked off after the wait if it is in the plan.';
  }
});

const refreshBanBtn = $('s-refresh-btn');
if (refreshBanBtn) refreshBanBtn.addEventListener('click', async () => {
  await window.spinlist.refreshBanList();
  pollSerato();
});

setInterval(pollSerato, 5000);

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
