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
      if (!isSubDj) items.push(['Create', '/index.html#create', 'create']);
      items.push(['My Events', '/index.html#events', 'events']);
      items.push(['Host', '/index.html#dashboard', 'dashboard']);
      if (multiOp) items.push(['My DJs', '/team.html', 'team']);
      if (planner) items.push(['Wedding Planner', '/wedding.html', 'wedding']);
      items.push(['Contact', '/contact.html', 'contact']);
    }

    // Work out which item matches the page we're on.
    var path = location.pathname.toLowerCase();
    var hash = (location.hash || '').replace('#', '').toLowerCase();
    var activeKey = '';
    if (path.indexOf('team.html') > -1) activeKey = 'team';
    else if (path.indexOf('wedding.html') > -1) activeKey = 'wedding';
    else if (path.indexOf('contact.html') > -1) activeKey = 'contact';
    else if (path.indexOf('index.html') > -1 || path === '/' || path === '') activeKey = hash || 'home';

    items.forEach(function (it) {
      var a = document.createElement('a');
      a.textContent = it[0];
      a.href = it[1];
      if (it[2] === activeKey) a.className = 'active';
      host.appendChild(a);
    });
  }

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
