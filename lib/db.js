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
  store = { users: [], sessions: [], processed_events: [], events_created: [], codes: [], redemptions: [], events: [], weddings: [], notifications: [] };
}
// ensure all collections exist even if an older file is loaded
for (const k of ['users', 'sessions', 'processed_events', 'events_created', 'codes', 'redemptions', 'events', 'weddings', 'notifications']) {
  if (!Array.isArray(store[k])) store[k] = [];
}
// Analytics is an object keyed by day ("2026-07-11"), not an array:
//   { "2026-07-11": { views: 120, pages: {"/": 80, "/pricing.html": 40}, visitors: ["hash1","hash2"] } }
// Visitor hashes are salted per-day and non-reversible, so nothing identifying is stored.
if (!store.analytics || typeof store.analytics !== 'object' || Array.isArray(store.analytics)) {
  store.analytics = {};
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

// Sort weddings by their date (soonest first); undated ones go last,
// tie-broken by most recently created.
function byWeddingDate(a, b) {
  const da = a.wedding_date, db_ = b.wedding_date;
  if (da && db_) return da - db_;        // both dated: earliest first
  if (da && !db_) return -1;             // dated before undated
  if (!da && db_) return 1;
  return (b.created_at || 0) - (a.created_at || 0);  // both undated: newest first
}

module.exports = {
  // ----- analytics -----
  // Record one page view. visitorHash is a salted, non-reversible daily hash
  // (see server.js) so we can count unique visitors without storing anything
  // identifying. Keeps 90 days, then prunes.
  recordView(dayKey, path, visitorHash) {
    if (!store.analytics[dayKey]) {
      store.analytics[dayKey] = { views: 0, pages: {}, visitors: [] };
    }
    const d = store.analytics[dayKey];
    d.views += 1;
    d.pages[path] = (d.pages[path] || 0) + 1;
    if (visitorHash && !d.visitors.includes(visitorHash)) d.visitors.push(visitorHash);

    // Prune anything older than 90 days so the file can't grow forever.
    const keys = Object.keys(store.analytics);
    if (keys.length > 90) {
      keys.sort();
      for (const k of keys.slice(0, keys.length - 90)) delete store.analytics[k];
    }
    persist();
  },
  // Return the last `days` days of stats, newest first, plus totals.
  analyticsSummary(days = 30) {
    const out = [];
    const now = new Date();
    let totalViews = 0;
    const pageTotals = {};
    const allVisitors = new Set();
    for (let i = 0; i < days; i++) {
      const dt = new Date(now);
      dt.setUTCDate(dt.getUTCDate() - i);
      const key = dt.toISOString().slice(0, 10);
      const d = store.analytics[key] || { views: 0, pages: {}, visitors: [] };
      out.push({ day: key, views: d.views, visitors: d.visitors.length });
      totalViews += d.views;
      for (const [p, n] of Object.entries(d.pages)) pageTotals[p] = (pageTotals[p] || 0) + n;
      for (const v of d.visitors) allVisitors.add(v);
    }
    const topPages = Object.entries(pageTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, views]) => ({ path, views }));
    return {
      days: out,                       // newest first
      totalViews,
      uniqueVisitors: allVisitors.size, // approx: unique per-day hashes across range
      topPages,
    };
  },
  // ----- health -----
  // Confirms the data store is readable and returns lightweight counts.
  // Throws if the store is missing/corrupt, so callers can detect DB trouble.
  health() {
    if (!store || !Array.isArray(store.users) || !Array.isArray(store.events)) {
      throw new Error('data store not initialised');
    }
    return {
      users: store.users.length,
      events: store.events.length,
      weddings: (store.weddings || []).length,
    };
  },
  // ----- users -----
  createUser(u) {
    const user = {
      id: u.id, email: u.email.toLowerCase(), password_hash: u.password_hash,
      name: u.name || '',
      role: u.role || 'host',          // 'host' (DJ) | 'couple' (wedding login) | 'subdj' (team DJ)
      parent_id: u.parent_id || null,  // for subdj: the multi-op owner who created them
      profile: u.profile || '',        // short bio
      dj_photo: u.dj_photo || null,     // /uploads/... path to DJ photo
      dj_website: u.dj_website || '',    // optional website link
      dj_website2: u.dj_website2 || '',  // optional second website link
      dj_youtube: u.dj_youtube || '',    // optional YouTube link
      plan: u.role === 'couple' ? 'couple' : (u.role === 'subdj' ? 'subdj' : 'trial'),
      sub_status: u.role === 'couple' ? 'couple' : (u.role === 'subdj' ? 'subdj' : 'trial'),
      stripe_customer: null, stripe_sub: null,
      comp_until: null, comp_code: null,
      brand_logo: null, brand_color: null, brand_tagline: null,
      spotify_export: false,            // granted via a special comp code (permanent)
      resend_api_key: u.resend_api_key || null,   // subscriber's own Resend key (write-only from UI)
      resend_from: u.resend_from || '',            // verified from-address, e.g. invites@theirdomain.com
      resend_from_name: u.resend_from_name || '',  // display name on the email
      created_at: u.created_at,
    };
    store.users.push(user);
    persist();
    return user;
  },
  // Sub-DJs created by a multi-op owner.
  listSubDjs(parentId) {
    return store.users.filter(u => u.role === 'subdj' && u.parent_id === parentId);
  },
  // Convert a managed sub-account into an independent DJ (their own 'host' account),
  // while keeping them linked to the former owner's team so assignments still work.
  convertSubToIndependent(subId) {
    const u = this.getUserById(subId);
    if (!u || u.role !== 'subdj') return null;
    const ownerId = u.parent_id;
    u.role = 'host';
    u.parent_id = null;
    // Link them to the owner's team the "linked existing account" way.
    if (ownerId) {
      const owner = this.getUserById(ownerId);
      if (owner) {
        if (!owner.team_members) owner.team_members = [];
        if (!owner.team_members.includes(subId)) owner.team_members.push(subId);
      }
    }
    persist();
    return u;
  },
  // Full team = created sub-accounts + linked existing accounts (via team_members ids).
  listTeam(ownerId) {
    const owner = this.getUserById(ownerId);
    const linkedIds = (owner && owner.team_members) || [];
    const subs = this.listSubDjs(ownerId);
    const linked = linkedIds
      .map(id => this.getUserById(id))
      .filter(u => u && u.role !== 'subdj');   // independent accounts linked in
    return [...subs, ...linked];
  },
  // Link an existing independent account to an owner's team.
  linkTeamMember(ownerId, memberId) {
    const owner = this.getUserById(ownerId);
    if (!owner) return false;
    if (!owner.team_members) owner.team_members = [];
    if (!owner.team_members.includes(memberId)) owner.team_members.push(memberId);
    persist();
    return true;
  },
  unlinkTeamMember(ownerId, memberId) {
    const owner = this.getUserById(ownerId);
    if (!owner || !owner.team_members) return false;
    owner.team_members = owner.team_members.filter(id => id !== memberId);
    persist();
    return true;
  },
  // Is this user on the owner's team (created sub OR linked)?
  isOnTeam(ownerId, memberId) {
    const m = this.getUserById(memberId);
    if (m && m.role === 'subdj' && m.parent_id === ownerId) return true;
    const owner = this.getUserById(ownerId);
    return !!(owner && owner.team_members && owner.team_members.includes(memberId));
  },
  // Owner's team-specific display override for a linked DJ (name/profile shown
  // within this owner's team, without touching the DJ's own account).
  getTeamOverride(ownerId, memberId) {
    const owner = this.getUserById(ownerId);
    return (owner && owner.team_overrides && owner.team_overrides[memberId]) || null;
  },
  setTeamOverride(ownerId, memberId, fields) {
    const owner = this.getUserById(ownerId);
    if (!owner) return null;
    if (!owner.team_overrides) owner.team_overrides = {};
    const cur = owner.team_overrides[memberId] || {};
    if (fields.name !== undefined) cur.name = fields.name;
    if (fields.profile !== undefined) cur.profile = fields.profile;
    if (fields.dj_photo !== undefined) cur.dj_photo = fields.dj_photo;
    if (fields.dj_website !== undefined) cur.dj_website = fields.dj_website;
    if (fields.dj_website2 !== undefined) cur.dj_website2 = fields.dj_website2;
    if (fields.dj_youtube !== undefined) cur.dj_youtube = fields.dj_youtube;
    owner.team_overrides[memberId] = cur;
    persist();
    return cur;
  },
  updateSubDj(id, fields) {
    const u = this.getUserById(id);
    if (!u || u.role !== 'subdj') return null;
    if (fields.name !== undefined) u.name = fields.name;
    if (fields.profile !== undefined) u.profile = fields.profile;
    if (fields.dj_photo !== undefined) u.dj_photo = fields.dj_photo;
    if (fields.dj_website !== undefined) u.dj_website = fields.dj_website;
    if (fields.dj_website2 !== undefined) u.dj_website2 = fields.dj_website2;
    if (fields.dj_youtube !== undefined) u.dj_youtube = fields.dj_youtube;
    if (fields.password_hash !== undefined) u.password_hash = fields.password_hash;
    persist();
    return u;
  },
  // Update any user's own profile (used by the owner editing their DJ profile).
  updateUserProfile(id, fields) {
    const u = this.getUserById(id);
    if (!u) return null;
    if (fields.name !== undefined) u.name = fields.name;
    if (fields.profile !== undefined) u.profile = fields.profile;
    if (fields.dj_photo !== undefined) u.dj_photo = fields.dj_photo;
    if (fields.dj_website !== undefined) u.dj_website = fields.dj_website;
    if (fields.dj_website2 !== undefined) u.dj_website2 = fields.dj_website2;
    if (fields.dj_youtube !== undefined) u.dj_youtube = fields.dj_youtube;
    persist();
    return u;
  },
  // Resolve the DJ profile to show for a job (event/wedding). Uses the assigned
  // DJ if set, else the owner. Applies the owner's team override for linked DJs.
  djProfileFor(ownerId, assignedDjId) {
    const djId = assignedDjId || ownerId;
    const u = this.getUserById(djId);
    if (!u) return null;
    let name = u.name || '', profile = u.profile || '', photo = u.dj_photo || null, website = u.dj_website || '';
    let website2 = u.dj_website2 || '', youtube = u.dj_youtube || '';
    // If this DJ is a linked member of the owner's team, the owner's override wins.
    if (djId !== ownerId && u.role !== 'subdj') {
      const ov = this.getTeamOverride(ownerId, djId);
      if (ov) {
        if (ov.name) name = ov.name;
        if (ov.profile) profile = ov.profile;
        if (ov.dj_photo) photo = ov.dj_photo;
        if (ov.dj_website) website = ov.dj_website;
        if (ov.dj_website2) website2 = ov.dj_website2;
        if (ov.dj_youtube) youtube = ov.dj_youtube;
      }
    }
    if (!name && !profile && !photo && !website && !website2 && !youtube) return null;
    return { name, profile, photo, website, website2, youtube };
  },
  deleteSubDj(id) {
    const i = store.users.findIndex(u => u.id === id && u.role === 'subdj');
    if (i === -1) return false;
    // Unassign any events/weddings first so nothing is orphaned.
    store.events.forEach(e => { if (e.assigned_dj === id) e.assigned_dj = null; });
    store.weddings.forEach(w => { if (w.assigned_dj === id) w.assigned_dj = null; });
    store.users.splice(i, 1);
    persist();
    return true;
  },
  assignEventDj(eventId, djId) {
    const e = this.getEvent(eventId);
    if (e) { e.assigned_dj = djId || null; persist(); }
    return e;
  },
  // Clear all assignments to a DJ (used when unlinking), limited to one owner's items.
  unassignAllFrom(djId, ownerId) {
    store.events.forEach(e => { if (e.assigned_dj === djId && e.host_id === ownerId) e.assigned_dj = null; });
    store.weddings.forEach(w => { if (w.assigned_dj === djId && w.host_id === ownerId) w.assigned_dj = null; });
    persist();
  },
  assignWeddingDj(weddingId, djId) {
    const w = this.getWedding(weddingId);
    if (w) { w.assigned_dj = djId || null; persist(); }
    return w;
  },
  listEventsAssignedTo(djId) {
    return store.events.filter(e => e.assigned_dj === djId).sort((a, b) => {
      const da = a.event_date, db_ = b.event_date;
      if (da && db_) return da - db_;
      if (da && !db_) return -1;
      if (!da && db_) return 1;
      return (b.created_at || 0) - (a.created_at || 0);
    });
  },
  listWeddingsAssignedTo(djId) {
    return store.weddings.filter(w => w.assigned_dj === djId).sort(byWeddingDate);
  },
  // Every wedding's linked live-requests event id — these are never shown as
  // standalone events; they only appear inside the wedding planner's live block.
  allWeddingLiveEventIds() {
    return store.weddings.map(w => w.live_event_id).filter(Boolean);
  },
  // Find the wedding that owns a given live-requests event (if any).
  getWeddingByLiveEvent(eventId) {
    return store.weddings.find(w => w.live_event_id === eventId) || null;
  },
  // Find the wedding a couple account is linked to (if any).
  getWeddingByCouple(coupleId) {
    return store.weddings.find(w => w.couple_id === coupleId) || null;
  },
  // ----- notifications (DJ sees couple activity) -----
  addNotification(userId, { type, weddingId, weddingName, text }) {
    // De-dupe: collapse repeated same-type activity on the same wedding within 5 min.
    const recent = store.notifications.find(n =>
      n.user_id === userId && n.wedding_id === weddingId && n.type === type &&
      Date.now() - n.created_at < 5 * 60 * 1000);
    if (recent) { recent.text = text; recent.created_at = Date.now(); recent.read = 0; persist(); return recent; }
    const n = { id: 'ntf_' + Math.random().toString(36).slice(2, 10), user_id: userId, type,
      wedding_id: weddingId || null, wedding_name: weddingName || '', text, read: 0, created_at: Date.now() };
    store.notifications.push(n);
    // Keep the list bounded per user (latest 100).
    const mine = store.notifications.filter(x => x.user_id === userId).sort((a, b) => a.created_at - b.created_at);
    if (mine.length > 100) { const drop = mine.slice(0, mine.length - 100).map(x => x.id); store.notifications = store.notifications.filter(x => !drop.includes(x.id)); }
    persist();
    return n;
  },
  listNotifications(userId, limit = 40) {
    return store.notifications.filter(n => n.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  },
  countUnread(userId) {
    return store.notifications.filter(n => n.user_id === userId && !n.read).length;
  },
  markNotificationsRead(userId) {
    store.notifications.forEach(n => { if (n.user_id === userId) n.read = 1; });
    persist();
  },
  // Prep tool: remember the DJ's chosen library version per song, across weddings.
  // Keyed by a normalised "title|artist" of the request; value is {title,artist} of the chosen file.
  // Prep tool: the DJ's saved music-library snapshot (title/artist/path per track),
  // so it auto-loads across devices without re-scanning.
  getPrepLibrary(userId) {
    const u = this.getUserById(userId);
    return (u && u.prep_library) ? u.prep_library : null;
  },
  setPrepLibrary(userId, lib) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (lib === null) { delete u.prep_library; }
    else {
      const tracks = Array.isArray(lib.tracks) ? lib.tracks.slice(0, 60000).map(t => {
        const o = {
          t: (t.t || t.title || '').toString().slice(0, 300),
          a: (t.a || t.artist || '').toString().slice(0, 300),
          p: (t.p || t.path || '').toString().slice(0, 1000),
        };
        if (t.v || t.video) o.v = 1;
        if (t.d || t.director) o.d = (t.d || t.director || '').toString().slice(0, 200);   // director (music videos)
        if (Number.isFinite(t.s)) o.s = t.s;        // file size (for incremental rescan)
        if (Number.isFinite(t.m)) o.m = t.m;        // last-modified time
        return o;
      }) : [];
      u.prep_library = { name: (lib.name || 'library').toString().slice(0, 200), tracks, savedAt: Date.now() };
    }
    persist();
    return u.prep_library || null;
  },
  getPrepPicks(userId) {
    const u = this.getUserById(userId);
    return (u && u.prep_picks) ? u.prep_picks : {};
  },
  setPrepPick(userId, key, chosen) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (!u.prep_picks) u.prep_picks = {};
    if (chosen === null) {
      delete u.prep_picks[key];
    } else if (chosen.manual) {
      // Manual file pick — remember enough to re-find the exact file on rescan.
      u.prep_picks[key] = {
        manual: true,
        title: (chosen.title || ''),
        artist: (chosen.artist || ''),
        name: (chosen.name || ''),
        path: (chosen.path || ''),
      };
    } else {
      u.prep_picks[key] = { title: (chosen.title || ''), artist: (chosen.artist || '') };
    }
    persist();
    return u.prep_picks;
  },
  // Daily digest opt-in (off by default). Also records when we last sent one.
  setDailyDigest(userId, on) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.daily_digest = !!on;
    persist();
    return u;
  },
  // Host's preferred guest-search source: 'spotify' (default) or 'apple'.
  // Stamped onto new events so the guest voting page searches that catalogue.
  setSearchSource(userId, source) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.search_source = source === 'apple' ? 'apple' : 'spotify';
    persist();
    return u;
  },
  markDigestSent(userId, dayKey) {
    const u = this.getUserById(userId);
    if (!u) return;
    u.digest_last_day = dayKey;   // e.g. "2026-07-05"
    persist();
  },
  // Users who opted in and haven't yet had a digest for `dayKey`.
  usersDueDigest(dayKey) {
    return store.users.filter(u => u.daily_digest && u.digest_last_day !== dayKey);
  },
  // Notifications created within [since, until) for a user.
  notificationsBetween(userId, since, until) {
    return store.notifications.filter(n => n.user_id === userId && n.created_at >= since && n.created_at < until)
      .sort((a, b) => a.created_at - b.created_at);
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

  // --- Calendar feed (iCal) token: a private, revocable key that lets a DJ
  // subscribe to their gigs in Apple/Google/Outlook calendars without logging in.
  getOrCreateCalToken(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (!u.cal_token) {
      u.cal_token = require('crypto').randomBytes(18).toString('hex'); // 36 hex chars
      persist();
    }
    return u.cal_token;
  },
  resetCalToken(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.cal_token = require('crypto').randomBytes(18).toString('hex');
    persist();
    return u.cal_token;
  },
  getUserByCalToken(token) {
    if (!token) return undefined;
    return store.users.find(u => u.cal_token === token) || undefined;
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
  // Permanently grant Spotify-export access (via a special comp code).
  grantSpotifyExport(userId) {
    const u = this.getUserById(userId);
    if (u) { u.spotify_export = true; persist(); }
  },
  // Save a subscriber's Resend email config. Key is stored as-is server-side but
  // never returned to the browser (see publicUser / resendStatus).
  setResendConfig(userId, { apiKey, from, fromName }) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (apiKey !== undefined) u.resend_api_key = apiKey || null;
    if (from !== undefined) u.resend_from = from || '';
    if (fromName !== undefined) u.resend_from_name = fromName || '';
    persist();
    return u;
  },
  clearResendConfig(userId) {
    const u = this.getUserById(userId);
    if (u) { u.resend_api_key = null; u.resend_from = ''; u.resend_from_name = ''; persist(); }
  },
  // The effective Resend config for a user (used to actually send). For a sub-DJ,
  // fall back to the parent owner's config so a team can share one setup.
  resendConfigFor(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (u.resend_api_key && u.resend_from) return { apiKey: u.resend_api_key, from: u.resend_from, fromName: u.resend_from_name || '' };
    if (u.role === 'subdj' && u.parent_id) {
      const p = this.getUserById(u.parent_id);
      if (p && p.resend_api_key && p.resend_from) return { apiKey: p.resend_api_key, from: p.resend_from, fromName: p.resend_from_name || '' };
    }
    return null;
  },
  setUserPassword(userId, password_hash) {
    const u = this.getUserById(userId);
    if (u) { u.password_hash = password_hash; persist(); }
  },
  // Permanently delete a user and clean up their data + any references to them.
  deleteUser(userId) {
    const u = this.getUserById(userId);
    if (!u) return false;
    // Their own events and weddings.
    store.events = store.events.filter(e => e.host_id !== userId);
    store.weddings = store.weddings.filter(w => w.host_id !== userId);
    // Unlink as couple / assigned DJ on anything that referenced them.
    store.weddings.forEach(w => {
      if (w.couple_id === userId) w.couple_id = null;
      if (w.assigned_dj === userId) w.assigned_dj = null;
    });
    store.events.forEach(e => { if (e.assigned_dj === userId) e.assigned_dj = null; });
    // If they were a multi-op owner, remove their sub-DJs too.
    store.users.filter(x => x.role === 'subdj' && x.parent_id === userId).forEach(sub => {
      store.events = store.events.filter(e => e.host_id !== sub.id);
      store.weddings = store.weddings.filter(w => w.host_id !== sub.id);
    });
    store.users = store.users.filter(x => !(x.role === 'subdj' && x.parent_id === userId));
    // Remove them from any owner's linked team + overrides.
    store.users.forEach(o => {
      if (Array.isArray(o.team_members)) o.team_members = o.team_members.filter(id => id !== userId);
      if (o.team_overrides && o.team_overrides[userId]) delete o.team_overrides[userId];
    });
    // Sessions + redemptions + the user record.
    if (Array.isArray(store.sessions)) store.sessions = store.sessions.filter(s => s.user_id !== userId);
    if (Array.isArray(store.redemptions)) store.redemptions = store.redemptions.filter(r => r.user_id !== userId);
    if (Array.isArray(store.events_created)) store.events_created = store.events_created.filter(x => x.user_id !== userId);
    store.users = store.users.filter(x => x.id !== userId);
    persist();
    return true;
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
      grants_spotify: c.grants_spotify ? 1 : 0,
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
  deleteCode(code) {
    const i = store.codes.findIndex(c => c.code === code);
    if (i === -1) return false;
    store.codes.splice(i, 1);
    persist();
    return true;
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
      event_date: e.event_date ?? null,
      assigned_dj: e.assigned_dj ?? null,   // multi-op: which sub-DJ is running this
      locked: e.locked ? 1 : 0,
      archived: 0,
      ask_name: e.ask_name ? 1 : 0,
      ask_nationality: e.ask_nationality ? 1 : 0,
      guests: [],                 // unique anonymous guest IDs that have voted
      tracks: {},                 // trackId -> { id, uri, title, artist, art, votes, requesters:[] }
      demo: e.demo ? 1 : 0,       // public demo event (uncapped, auto-resets)
      search_source: e.search_source === 'apple' ? 'apple' : 'spotify',  // guest search catalogue
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
      .sort((a, b) => {
        const da = a.event_date, db_ = b.event_date;
        if (da && db_) return da - db_;
        if (da && !db_) return -1;
        if (!da && db_) return 1;
        return (b.created_at || 0) - (a.created_at || 0);
      });
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
    if (fields.event_date !== undefined) e.event_date = fields.event_date;
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

  // Host adjusts a song's votes by a delta (e.g. -1 to knock one off). Unlike a
  // guest un-vote, the song is NOT auto-deleted at 0 — the host may just be
  // nudging the order — but votes never go below 0.
  adjustVotes(eventId, trackId, delta) {
    const e = this.getEvent(eventId);
    if (!e || !e.tracks[trackId]) return e;
    e.tracks[trackId].votes = Math.max(0, (e.tracks[trackId].votes || 0) + delta);
    persist();
    return e;
  },
  // Host removes a song from the leaderboard entirely (joke/dupe/inappropriate).
  removeTrack(eventId, trackId) {
    const e = this.getEvent(eventId);
    if (!e || !e.tracks[trackId]) return e;
    delete e.tracks[trackId];
    persist();
    return e;
  },
  // Host adds a song directly (a guest asked at the booth). If the song is
  // already on the list, it just adds the votes to it; otherwise it creates it.
  hostAddSong(eventId, track, votes) {
    const e = this.getEvent(eventId);
    if (!e) return null;
    const n = Math.max(1, votes || 1);
    if (e.tracks[track.id]) {
      e.tracks[track.id].votes += n;
    } else {
      e.tracks[track.id] = {
        id: track.id, uri: track.uri || null, title: track.title,
        artist: track.artist || '', art: track.art || '',
        votes: n, played: 0, addedAt: Date.now(), requesters: [], djAdded: 1,
      };
    }
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
      live_event_id: null,             // linked live-requests event (created by DJ)
      live_block_id: null,             // which block is in "live guest requests" mode
      assigned_dj: null,               // multi-op: which sub-DJ is running this
      archived: 0,
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
    return store.weddings.filter(w => w.host_id === hostId).sort(byWeddingDate);
  },
  // Link a live-requests event to a wedding.
  setWeddingLiveEvent(weddingId, eventId) {
    const w = this.getWedding(weddingId);
    if (w) { w.live_event_id = eventId || null; persist(); }
    return w;
  },
  // Set the couple's edit lock: a timestamp, 0 = explicitly cleared, null = use default.
  setWeddingLockDate(weddingId, lockTs) {
    const w = this.getWedding(weddingId);
    if (w) { w.lock_date = (lockTs === null || lockTs === undefined) ? null : lockTs; persist(); }
    return w;
  },
  // Set (or clear) which block is in live guest-requests mode.
  setWeddingLiveBlock(weddingId, blockId) {
    const w = this.getWedding(weddingId);
    if (w) { w.live_block_id = blockId || null; persist(); }
    return w;
  },
  listWeddingsByCouple(coupleId) {
    return store.weddings.filter(w => w.couple_id === coupleId).sort(byWeddingDate);
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
      played: s.played ? 1 : 0,
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
  // ----- music block templates (per DJ, max 5) -----
  // A block template = { id, name, blocks:[{name, capacity}] }
  listBlockTemplates(userId) {
    const u = this.getUserById(userId);
    return (u && Array.isArray(u.block_templates)) ? u.block_templates : [];
  },
  saveBlockTemplate(userId, tpl) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (!Array.isArray(u.block_templates)) u.block_templates = [];
    const clean = {
      id: tpl.id || ('btpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      name: (tpl.name || 'Untitled').toString().slice(0, 80),
      blocks: (Array.isArray(tpl.blocks) ? tpl.blocks : []).slice(0, 30).map(b => ({
        name: (b.name || 'Block').toString().slice(0, 60),
        capacity: Math.max(1, Math.min(parseInt(b.capacity, 10) || 1, 100)),
      })),
    };
    const idx = u.block_templates.findIndex(t => t.id === clean.id);
    if (idx >= 0) u.block_templates[idx] = clean;
    else {
      if (u.block_templates.length >= 5) return { error: 'limit' };
      u.block_templates.push(clean);
    }
    persist();
    return clean;
  },
  deleteBlockTemplate(userId, tplId) {
    const u = this.getUserById(userId);
    if (!u || !Array.isArray(u.block_templates)) return;
    u.block_templates = u.block_templates.filter(t => t.id !== tplId);
    persist();
  },
  // ----- questionnaire templates (per DJ, max 5) -----
  // A template = { id, name, questions:[{id,type:'text'|'yesno'|'choice',label,options:[...]}] }
  listTemplates(userId) {
    const u = this.getUserById(userId);
    return (u && Array.isArray(u.q_templates)) ? u.q_templates : [];
  },
  saveTemplate(userId, tpl) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (!Array.isArray(u.q_templates)) u.q_templates = [];
    const clean = {
      id: tpl.id || ('tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      name: (tpl.name || 'Untitled').toString().slice(0, 80),
      questions: (Array.isArray(tpl.questions) ? tpl.questions : []).slice(0, 60).map((q, i) => ({
        id: q.id || ('q' + (i + 1)),
        type: ['text', 'yesno', 'choice', 'multiselect', 'header'].includes(q.type) ? q.type : 'text',
        label: (q.label || '').toString().slice(0, 200),
        options: (q.type === 'choice' || q.type === 'multiselect') ? (Array.isArray(q.options) ? q.options : []).slice(0, 20).map(o => (o || '').toString().slice(0, 80)) : [],
        gigShow: !!q.gigShow,   // show this question + answer in the live gig window
      })),
    };
    const idx = u.q_templates.findIndex(t => t.id === clean.id);
    if (idx >= 0) u.q_templates[idx] = clean;
    else {
      if (u.q_templates.length >= 5) return { error: 'limit' };   // max 5 templates
      u.q_templates.push(clean);
    }
    // Propagate gig-window flags to the DJ's existing weddings. We match per
    // QUESTION by label (case-insensitive) rather than by template name, so old
    // snapshots pick up the flags even if the questionnaire name differs.
    const flagByLabel = {};
    clean.questions.forEach(q => { if (q.label) flagByLabel[q.label.trim().toLowerCase()] = !!q.gigShow; });
    store.weddings.forEach(w => {
      if (w.host_id !== userId) return;
      const q = w.questionnaire;
      if (!q || !Array.isArray(q.questions)) return;
      q.questions.forEach(wq => {
        const key = (wq.label || '').trim().toLowerCase();
        if (key && key in flagByLabel) wq.gigShow = flagByLabel[key];
      });
    });
    persist();
    return clean;
  },
  deleteTemplate(userId, tplId) {
    const u = this.getUserById(userId);
    if (!u || !Array.isArray(u.q_templates)) return;
    u.q_templates = u.q_templates.filter(t => t.id !== tplId);
    persist();
  },
  // Attach a questionnaire (snapshot of a template) to a wedding + store answers.
  setWeddingQuestionnaire(weddingId, questionnaire) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    w.questionnaire = questionnaire || null;   // {name, questions:[...]}
    if (!w.answers) w.answers = {};
    persist();
    return w;
  },
  setWeddingAnswers(weddingId, answers) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    w.answers = Object.assign({}, w.answers || {}, answers || {});
    persist();
    return w;
  },
  // Mark a single song in a block played/unplayed (DJ on the day).
  setWeddingSongPlayed(weddingId, blockId, songId, played) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    const block = (w.blocks || []).find(b => b.id === blockId);
    if (!block) return w;
    const song = (block.songs || []).find(s => s.id === songId);
    if (song) { song.played = played ? 1 : 0; persist(); }
    return w;
  },
  setWeddingArchived(id, archived) {
    const w = this.getWedding(id);
    if (w) { w.archived = archived ? 1 : 0; persist(); }
    return w;
  },
  deleteWedding(id) {
    const i = store.weddings.findIndex(w => w.id === id);
    if (i >= 0) { store.weddings.splice(i, 1); persist(); }
  },
};
