/* Shared Spinlist central navigation.
   Drop <div id="spinlist-nav"></div> anywhere on a page and include this script.
   It fetches the current user, builds the menu (respecting plan/role gating),
   highlights the active item, and links everything as real hrefs so the menu
   works identically on every page. On index.html the SPA views are reached via
   /index.html#view and index.html reads that hash on load. */
(function () {
  'use strict';

  // Inject minimal styles once (kept self-contained so any page can use it).
  if (!document.getElementById('spinlist-nav-style')) {
    var css = document.createElement('style');
    css.id = 'spinlist-nav-style';
    css.textContent =
      '#spinlist-nav{display:flex;gap:6px;flex-wrap:wrap;background:rgba(255,255,255,.06);padding:4px;border-radius:100px}' +
      '#spinlist-nav a{border:0;background:transparent;font:inherit;font-size:.82rem;font-weight:600;padding:7px 14px;border-radius:100px;cursor:pointer;color:var(--muted,#9aa4bf);transition:.2s;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}' +
      '#spinlist-nav a:hover{color:var(--ink,#fff)}' +
      '#spinlist-nav a.active{background:var(--ink,#fff);color:var(--paper,#0a1228)}' +
      '@media(max-width:640px){#spinlist-nav a{padding:7px 10px;font-size:.74rem}}';
    document.head.appendChild(css);
  }

  function build(me) {
    var host = document.getElementById('spinlist-nav');
    if (!host) return;
    host.innerHTML = '';

    var isSubDj = me && me.user && me.user.isSubDj;
    var isCouple = me && me.user && me.user.role === 'couple';
    var multiOp = me && me.user && me.user.multiOp;
    var planner = me && me.user && me.user.weddingPlanner;

    // Each item: label, href, and a key used to detect "active" on the current page.
    var items = [];
    if (isCouple) {
      // Wedding-couple accounts live in the planner, not the DJ app.
      items.push(['Wedding Planner', '/wedding.html', 'wedding']);
      items.push(['Contact', '/contact.html', 'contact']);
    } else {
      items.push(['Home', '/index.html#home', 'home']);
      items.push(['My Events', '/index.html#events', 'events']);
      if (multiOp) items.push(['My DJs', '/team.html', 'team']);
      items.push(['Apps', '/apps.html', 'apps']);
      items.push(['Contact', '/contact.html', 'contact']);
    }

    // Work out which item matches the page we're on.
    var path = location.pathname.toLowerCase();
    var hash = (location.hash || '').replace('#', '').toLowerCase();
    var activeKey = '';
    if (path.indexOf('team.html') > -1) activeKey = 'team';
    else if (path.indexOf('wedding.html') > -1) activeKey = 'wedding';
    else if (path.indexOf('apps.html') > -1) activeKey = 'apps';
    else if (path.indexOf('contact.html') > -1) activeKey = 'contact';
    else if (path.indexOf('index.html') > -1 || path === '/' || path === '') activeKey = hash || 'home';

    items.forEach(function (it) {
      var a = document.createElement('a');
      a.textContent = it[0];
      a.href = it[1];
      if (it[2] === activeKey) a.className = 'active';
      host.appendChild(a);
    });

    // Notification bell — shown for DJs/sub-DJs (not couples), placed next to
    // the account holder's name. Rendered into #spinlist-acct if present.
    buildAcct(me);
  }

  // Renders the account holder's name + a notification bell, into an element
  // with id="spinlist-acct" (pages that want it add that element near their
  // header). Falls back gracefully if the element isn't present.
  function buildAcct(me) {
    var acct = document.getElementById('spinlist-acct');
    if (!acct || !me || !me.user) return;
    var u = me.user;
    var isCouple = u.role === 'couple';
    var name = u.name || (u.email ? u.email.split('@')[0] : 'Account');
    var plan = u.planName || u.plan || '';

    acct.innerHTML = '';
    acct.style.display = 'flex';
    acct.style.alignItems = 'center';
    acct.style.gap = '10px';

    // Bell (not for couples).
    if (!isCouple) {
      var bell = document.createElement('span');
      bell.id = 'spinlist-notif-bell';
      bell.style.cssText = 'display:none;position:relative;cursor:pointer;font-size:1.15rem;line-height:1';
      bell.innerHTML = '🔔<span id="spinlist-notif-count" style="display:none;position:absolute;top:-6px;right:-8px;background:var(--neon,#c6f24e);color:#0a1228;font-size:.62rem;font-weight:800;min-width:16px;height:16px;border-radius:9px;align-items:center;justify-content:center;padding:0 3px"></span>';
      bell.onclick = toggleNotifPanel;
      acct.appendChild(bell);
    }

    // Name + plan (stacked, so a long name+plan doesn't wrap the menu).
    var link = document.createElement('a');
    link.href = '/account.html';
    link.style.cssText = 'color:var(--ink,#fff);text-decoration:none;display:flex;flex-direction:column;align-items:flex-end;line-height:1.15;font-size:.85rem;font-weight:600';
    link.innerHTML = '<span>' + escHtml(name) + '</span>' +
      (plan ? '<span style="font-size:.7rem;font-weight:600;color:var(--muted,#9aa4bf)">' + escHtml(plan) + '</span>' : '');
    acct.appendChild(link);

    if (!isCouple) loadNotifs(true);
  }

  // ---- Notifications ----
  var NOTIFS = [], NOTIF_SEEN = 0;
  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function loadNotifs(first) {
    fetch('/api/notifications', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        NOTIFS = d.notifications || [];
        var bell = document.getElementById('spinlist-notif-bell');
        var cnt = document.getElementById('spinlist-notif-count');
        if (bell) bell.style.display = 'inline-block';
        if (cnt) {
          if (d.unread > 0) { cnt.style.display = 'flex'; cnt.textContent = d.unread > 9 ? '9+' : d.unread; }
          else cnt.style.display = 'none';
        }
        if (NOTIFS.length) NOTIF_SEEN = Math.max.apply(null, NOTIFS.map(function (n) { return n.createdAt; }));
      })
      .catch(function () {});
  }

  function toggleNotifPanel(e) {
    if (e) e.stopPropagation();
    var p = document.getElementById('spinlist-notif-panel');
    if (!p) {
      p = document.createElement('div');
      p.id = 'spinlist-notif-panel';
      p.style.cssText = 'display:none;position:fixed;top:60px;right:20px;width:340px;max-width:calc(100vw - 40px);max-height:70vh;overflow:auto;background:var(--surface,#16234a);border:1px solid var(--line,#26325a);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:300;padding:8px';
      document.body.appendChild(p);
    }
    if (p.style.display === 'block') { p.style.display = 'none'; return; }
    renderNotifPanel();
    p.style.display = 'block';
    fetch('/api/notifications/read', { method: 'POST', credentials: 'same-origin' }).then(function () {
      var c = document.getElementById('spinlist-notif-count'); if (c) c.style.display = 'none';
      NOTIFS.forEach(function (n) { n.read = true; });
    });
  }

  function renderNotifPanel() {
    var p = document.getElementById('spinlist-notif-panel'); if (!p) return;
    if (!NOTIFS.length) { p.innerHTML = '<p style="padding:16px;text-align:center;font-size:.88rem;color:var(--muted,#9aa4bf)">No activity yet.</p>'; return; }
    var ago = function (ts) { var s = (Date.now() - ts) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
    var icon = function (t) { return t === 'assignment' ? '📌' : t === 'songs' ? '🎵' : t === 'timeline' ? '🕐' : t === 'answers' ? '📋' : '🔔'; };
    p.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px 10px"><b style="font-size:.95rem;color:var(--ink,#fff)">Notifications</b></div>' +
      NOTIFS.map(function (n) {
        return '<div style="display:flex;gap:10px;padding:10px;border-radius:10px;' + (n.read ? '' : 'background:rgba(198,242,78,.1)') + '">' +
          '<span style="font-size:1.1rem">' + icon(n.type) + '</span>' +
          '<div style="flex:1;min-width:0"><div style="font-size:.86rem;color:var(--ink,#fff)">' + escHtml(n.text) + '</div>' +
          '<div style="font-size:.72rem;margin-top:2px;color:var(--muted,#9aa4bf)">' + ago(n.createdAt) + '</div></div></div>';
      }).join('');
  }

  document.addEventListener('click', function (e) {
    var p = document.getElementById('spinlist-notif-panel');
    var b = document.getElementById('spinlist-notif-bell');
    if (p && p.style.display === 'block' && !p.contains(e.target) && b && !b.contains(e.target)) p.style.display = 'none';
  });

  function load() {
    // Reuse a global if the page already fetched /api/me, else fetch it.
    if (window.__me) { build(window.__me); return; }
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) { window.__me = me; build(me); })
      .catch(function () { build(null); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
