/* ============================================================
   Spinlist — data layer (pure-JS JSON file store)
   ------------------------------------------------------------
   No native modules, nothing to compile — works on shared
   hosting (cPanel) where build tools are often unavailable.

   Data is held in memory and persisted to spinlist-data.json
   with a debounced write. Same method interface as before, so
   the rest of the app is unchanged.

   For higher scale or concurrency, swap this file for a real
   database (Postgres). The method names map 1:1. A SQLite
   implementation is kept in lib/db.sqlite.js.bak for reference.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'spinlist-data.json');

// ---- load (or initialise) ----
let store;
try {
  store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (_) {
  store = { users: [], sessions: [], processed_events: [], events_created: [], codes: [], redemptions: [] };
}
// ensure all collections exist even if an older file is loaded
for (const k of ['users', 'sessions', 'processed_events', 'events_created', 'codes', 'redemptions']) {
  if (!Array.isArray(store[k])) store[k] = [];
}

// ---- debounced persistence ----
let writeTimer = null;
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, DATA_FILE);   // atomic replace
    } catch (e) {
      console.error('Spinlist data persist error:', e.message);
    }
  }, 120);
}

const now = () => Date.now();

module.exports = {
  // ----- users -----
  createUser(u) {
    const user = {
      id: u.id, email: u.email.toLowerCase(), password_hash: u.password_hash,
      name: u.name || '', plan: 'none', sub_status: null,
      stripe_customer: null, stripe_sub: null,
      comp_until: null, comp_code: null,
      brand_logo: null, brand_color: null, brand_tagline: null,
      created_at: u.created_at,
    };
    store.users.push(user);
    persist();
    return user;
  },
  getUserByEmail(email) {
    return store.users.find(u => u.email === (email || '').toLowerCase()) || undefined;
  },
  getUserById(id) {
    return store.users.find(u => u.id === id) || undefined;
  },
  getUserByCustomer(customerId) {
    return store.users.find(u => u.stripe_customer === customerId) || undefined;
  },
  setStripeCustomer(userId, customerId) {
    const u = this.getUserById(userId); if (u) { u.stripe_customer = customerId; persist(); }
  },
  setPlan(userId, { plan, sub_status, stripe_sub }) {
    const u = this.getUserById(userId);
    if (u) { u.plan = plan; u.sub_status = sub_status ?? null; u.stripe_sub = stripe_sub ?? null; persist(); }
  },
  grantComp(userId, { plan, comp_until, comp_code }) {
    const u = this.getUserById(userId);
    if (u) { u.plan = plan; u.sub_status = 'comp'; u.comp_until = comp_until ?? null; u.comp_code = comp_code ?? null; persist(); }
  },
  expireCompIfNeeded(user) {
    const u = this.getUserById(user.id);
    if (u && u.sub_status === 'comp' && u.comp_until && now() > u.comp_until) {
      u.plan = 'none'; u.sub_status = null; u.comp_until = null; u.comp_code = null; persist();
      return true;
    }
    return false;
  },

  // ----- branding -----
  setBranding(userId, { logo, color, tagline }) {
    const u = this.getUserById(userId);
    if (u) { u.brand_logo = logo ?? null; u.brand_color = color ?? null; u.brand_tagline = tagline ?? null; persist(); }
  },
  getBranding(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    return { logo: u.brand_logo, color: u.brand_color, tagline: u.brand_tagline };
  },

  // ----- sessions -----
  createSession(s) {
    store.sessions.push({ token: s.token, user_id: s.user_id, created_at: s.created_at, expires_at: s.expires_at });
    persist();
  },
  getSession(token) {
    const s = store.sessions.find(x => x.token === token);
    if (!s) return null;
    if (now() > s.expires_at) { this.deleteSession(token); return null; }
    return s;
  },
  deleteSession(token) {
    const i = store.sessions.findIndex(x => x.token === token);
    if (i >= 0) { store.sessions.splice(i, 1); persist(); }
  },

  // ----- idempotency -----
  alreadyProcessed(eventId) {
    return store.processed_events.includes(eventId);
  },
  markProcessed(eventId) {
    if (!store.processed_events.includes(eventId)) { store.processed_events.push(eventId); persist(); }
  },

  // ----- usage / gating -----
  recordEvent(id, userId) {
    store.events_created.push({ id, user_id: userId, created_at: now() });
    persist();
  },
  countEventsThisMonth(userId) {
    const since = now() - 30 * 24 * 60 * 60 * 1000;
    return store.events_created.filter(e => e.user_id === userId && e.created_at >= since).length;
  },

  // ----- codes -----
  createCode(c) {
    const code = {
      code: (c.code || '').toUpperCase(), kind: c.kind, plan: c.plan ?? null,
      months: c.months ?? null, discount_kind: c.discount_kind ?? null,
      discount_val: c.discount_val ?? null, stripe_promo: c.stripe_promo ?? null,
      max_uses: c.max_uses ?? null, uses: 0, expires_at: c.expires_at ?? null,
      active: 1, note: c.note ?? null, created_at: c.created_at,
    };
    store.codes.push(code);
    persist();
    return code;
  },
  getCode(code) {
    return store.codes.find(c => c.code === (code || '').toUpperCase()) || undefined;
  },
  listCodes() {
    return [...store.codes].sort((a, b) => b.created_at - a.created_at);
  },
  setCodeActive(code, active) {
    const c = this.getCode(code); if (c) { c.active = active ? 1 : 0; persist(); }
  },
  incrementCodeUses(code) {
    const c = this.getCode(code); if (c) { c.uses += 1; persist(); }
  },

  // ----- redemptions -----
  hasRedeemed(code, userId) {
    const cc = (code || '').toUpperCase();
    return store.redemptions.some(r => r.code === cc && r.user_id === userId);
  },
  recordRedemption(r) {
    store.redemptions.push({ id: r.id, code: (r.code || '').toUpperCase(), user_id: r.user_id, redeemed_at: r.redeemed_at });
    persist();
  },
};
