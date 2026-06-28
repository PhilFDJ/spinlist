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
  store = { users: [], sessions: [], processed_events: [], events_created: [], codes: [], redemptions: [], events: [], weddings: [] };
}
// ensure all collections exist even if an older file is loaded
for (const k of ['users', 'sessions', 'processed_events', 'events_created', 'codes', 'redemptions', 'events', 'weddings']) {
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
      name: u.name || '',
      role: u.role || 'host',          // 'host' (DJ) or 'couple' (wedding login)
      plan: u.role === 'couple' ? 'couple' : 'trial',
      sub_status: u.role === 'couple' ? 'couple' : 'trial',
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
  listAllUsers() {
    return [...store.users].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  },
  // Store a DJ's Spotify OAuth tokens (for playlist export).
  setSpotifyAuth(userId, { accessToken, refreshToken, expiresAt, spotifyUserId }) {
    const u = this.getUserById(userId);
    if (!u) return;
    u.spotify_access = accessToken ?? null;
    u.spotify_refresh = refreshToken ?? u.spotify_refresh ?? null;  // refresh may not be re-sent
    u.spotify_expires = expiresAt ?? null;
    u.spotify_user_id = spotifyUserId ?? u.spotify_user_id ?? null;
    persist();
  },
  clearSpotifyAuth(userId) {
    const u = this.getUserById(userId);
    if (!u) return;
    u.spotify_access = null; u.spotify_refresh = null; u.spotify_expires = null; u.spotify_user_id = null;
    persist();
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
  // Total events ever created (persists even if events are deleted) — used for
  // the free-trial lifetime cap so deleting an event can't refund a trial slot.
  countEventsLifetime(userId) {
    return store.events_created.filter(e => e.user_id === userId).length;
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

  // ----- events (server-stored, the real source of truth) -----
  createEvent(e) {
    const event = {
      id: e.id,
      host_id: e.host_id,
      name: e.name || 'Untitled Event',
      type: e.type || 'Event',
      host: e.host || 'Your host',
      votes_per: e.votes_per ?? 5,
      deadline: e.deadline ?? null,
      locked: e.locked ? 1 : 0,
      archived: 0,
      ask_name: e.ask_name ? 1 : 0,
      ask_nationality: e.ask_nationality ? 1 : 0,
      guests: [],                 // unique anonymous guest IDs that have voted
      tracks: {},                 // trackId -> { id, uri, title, artist, art, votes, requesters:[] }
      created_at: e.created_at || Date.now(),
    };
    store.events.push(event);
    persist();
    return event;
  },
  getEvent(id) {
    return store.events.find(e => e.id === id) || undefined;
  },
  listEventsByHost(hostId) {
    return store.events
      .filter(e => e.host_id === hostId)
      .sort((a, b) => b.created_at - a.created_at);
  },
  setArchived(id, archived) {
    const e = this.getEvent(id);
    if (e) { e.archived = archived ? 1 : 0; persist(); }
    return e;
  },
  // Update editable event fields (not the id/share link or vote tallies).
  updateEvent(id, fields) {
    const e = this.getEvent(id);
    if (!e) return null;
    if (fields.name !== undefined) e.name = fields.name;
    if (fields.type !== undefined) e.type = fields.type;
    if (fields.host !== undefined) e.host = fields.host;
    if (fields.votes_per !== undefined) e.votes_per = fields.votes_per;
    if (fields.deadline !== undefined) e.deadline = fields.deadline;
    if (fields.ask_name !== undefined) e.ask_name = fields.ask_name ? 1 : 0;
    if (fields.ask_nationality !== undefined) e.ask_nationality = fields.ask_nationality ? 1 : 0;
    persist();
    return e;
  },
  setEventLocked(id, locked) {
    const e = this.getEvent(id);
    if (e) { e.locked = locked ? 1 : 0; persist(); }
    return e;
  },
  deleteEvent(id) {
    const i = store.events.findIndex(e => e.id === id);
    if (i >= 0) { store.events.splice(i, 1); persist(); }
  },
  // Returns true if this guest is allowed to participate (already counted, or
  // there's room under the cap). Registers a new guest if there's room.
  // maxGuests = null means unlimited.
  registerGuest(eventId, guestId, maxGuests) {
    const e = this.getEvent(eventId);
    if (!e || !guestId) return { allowed: true, count: e ? (e.guests || []).length : 0 };
    if (!e.guests) e.guests = [];
    if (e.guests.includes(guestId)) return { allowed: true, count: e.guests.length };
    if (maxGuests != null && e.guests.length >= maxGuests) {
      return { allowed: false, count: e.guests.length, full: true };
    }
    e.guests.push(guestId);
    persist();
    return { allowed: true, count: e.guests.length };
  },
  guestCount(eventId) {
    const e = this.getEvent(eventId);
    return e && e.guests ? e.guests.length : 0;
  },
  // Apply a guest's vote changes. `add` = array of track objects to +1,
  // `remove` = array of trackIds to -1. `guest` = { name, nationality } (optional).
  // Returns the updated event.
  applyVotes(id, { add = [], remove = [], guest = null }) {
    const e = this.getEvent(id);
    if (!e) return null;
    for (const t of add) {
      if (!e.tracks[t.id]) {
        e.tracks[t.id] = { id: t.id, uri: t.uri || null, title: t.title, artist: t.artist, art: t.art || '', votes: 0, played: 0, addedAt: Date.now(), requesters: [] };
      }
      if (!e.tracks[t.id].requesters) e.tracks[t.id].requesters = [];
      e.tracks[t.id].votes += 1;
      // Record who requested it, if they gave a name/nationality.
      if (guest && (guest.name || guest.nationality)) {
        e.tracks[t.id].requesters.push({
          name: (guest.name || '').toString().slice(0, 40),
          nationality: (guest.nationality || '').toString().slice(0, 40),
          at: Date.now(),
        });
      }
    }
    for (const tid of remove) {
      if (e.tracks[tid]) {
        e.tracks[tid].votes -= 1;
        if (e.tracks[tid].votes <= 0) delete e.tracks[tid];
      }
    }
    persist();
    return e;
  },
  // Mark a track played / unplayed (host action).
  setPlayed(eventId, trackId, played) {
    const e = this.getEvent(eventId);
    if (!e || !e.tracks[trackId]) return e;
    e.tracks[trackId].played = played ? 1 : 0;
    persist();
    return e;
  },

  // ----- weddings (DJ wedding-planner tier) -----
  // A wedding = { id, host_id, couple_id, invite_code, name, couple_names,
  //   wedding_date, blocks:[{id,name,capacity,songs:[{id,uri,title,artist,art}]}],
  //   timeline:[{id,time,label}], created_at }
  createWedding(w) {
    const wedding = {
      id: w.id,
      host_id: w.host_id,
      couple_id: null,                 // set when a couple joins via the code
      invite_code: w.invite_code,
      name: w.name || 'Wedding',
      couple_names: w.couple_names || '',
      wedding_date: w.wedding_date || null,
      blocks: Array.isArray(w.blocks) ? w.blocks : [],
      timeline: Array.isArray(w.timeline) ? w.timeline : [],
      created_at: w.created_at || Date.now(),
    };
    store.weddings.push(wedding);
    persist();
    return wedding;
  },
  getWedding(id) {
    return store.weddings.find(w => w.id === id) || undefined;
  },
  getWeddingByCode(code) {
    const c = (code || '').toUpperCase();
    return store.weddings.find(w => (w.invite_code || '').toUpperCase() === c) || undefined;
  },
  listWeddingsByHost(hostId) {
    return store.weddings.filter(w => w.host_id === hostId).sort((a, b) => b.created_at - a.created_at);
  },
  listWeddingsByCouple(coupleId) {
    return store.weddings.filter(w => w.couple_id === coupleId).sort((a, b) => b.created_at - a.created_at);
  },
  linkCoupleToWedding(weddingId, coupleId) {
    const w = this.getWedding(weddingId);
    if (w) { w.couple_id = coupleId; persist(); }
    return w;
  },
  updateWedding(id, fields) {
    const w = this.getWedding(id);
    if (!w) return null;
    if (fields.name !== undefined) w.name = fields.name;
    if (fields.couple_names !== undefined) w.couple_names = fields.couple_names;
    if (fields.wedding_date !== undefined) w.wedding_date = fields.wedding_date;
    if (fields.blocks !== undefined) w.blocks = fields.blocks;
    persist();
    return w;
  },
  // Save the song selections for a single block (couple or host editing).
  setWeddingBlockSongs(weddingId, blockId, songs) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    const block = (w.blocks || []).find(b => b.id === blockId);
    if (!block) return w;
    const cap = block.capacity || 0;
    block.songs = (Array.isArray(songs) ? songs : []).slice(0, cap).map(s => ({
      id: s.id, uri: s.uri || null, title: s.title, artist: s.artist, art: s.art || '',
    }));
    persist();
    return w;
  },
  // Save the whole timeline (DJ or couple editing).
  setWeddingTimeline(weddingId, timeline) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    w.timeline = (Array.isArray(timeline) ? timeline : []).slice(0, 60).map((t, i) => ({
      id: t.id || ('tl' + (i + 1)),
      time: (t.time || '').toString().slice(0, 20),
      label: (t.label || '').toString().slice(0, 120),
    }));
    persist();
    return w;
  },
  deleteWedding(id) {
    const i = store.weddings.findIndex(w => w.id === id);
    if (i >= 0) { store.weddings.splice(i, 1); persist(); }
  },
};
