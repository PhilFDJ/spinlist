/* Spinlist page-view tracker — tiny, privacy-friendly, fire-and-forget.
   Sends one beacon per page load to /api/track. No cookies, no personal data;
   the server counts unique visitors via a salted hash that rotates daily.
   Deliberately silent: analytics must never break or slow down a page. */
(function () {
  'use strict';
  try {
    // Don't count the admin dashboard, or local development.
    var path = location.pathname || '/';
    if (path.indexOf('/admin') === 0) return;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;

    var body = JSON.stringify({ path: path });

    // sendBeacon survives page navigation and doesn't block anything.
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () { /* ignore */ });
    }
  } catch (_) { /* never surface analytics errors */ }
})();
