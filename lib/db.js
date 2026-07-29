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
for (const k of ['users', 'sessions', 'processed_events', 'events_created', 'codes', 'redemptions', 'events', 'weddings', 'notifications', 'clients', 'bookings', 'products', 'quotes', 'custom_fields', 'templates', 'contracts']) {
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
  recordView(dayKey, path, visitorHash, hour) {
    if (!store.analytics[dayKey]) {
      store.analytics[dayKey] = { views: 0, pages: {}, visitors: [], hours: {} };
    }
    const d = store.analytics[dayKey];
    d.views += 1;
    d.pages[path] = (d.pages[path] || 0) + 1;
    if (visitorHash && !d.visitors.includes(visitorHash)) d.visitors.push(visitorHash);
    // Hour of day (0-23), so we can show peak times.
    if (!d.hours) d.hours = {};
    if (typeof hour === 'number' && hour >= 0 && hour <= 23) {
      d.hours[hour] = (d.hours[hour] || 0) + 1;
    }

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
    const hourTotals = new Array(24).fill(0);   // views by hour of day, summed over the range
    for (let i = 0; i < days; i++) {
      const dt = new Date(now);
      dt.setUTCDate(dt.getUTCDate() - i);
      const key = dt.toISOString().slice(0, 10);
      const d = store.analytics[key] || { views: 0, pages: {}, visitors: [], hours: {} };
      out.push({ day: key, views: d.views, visitors: d.visitors.length });
      totalViews += d.views;
      for (const [p, n] of Object.entries(d.pages)) pageTotals[p] = (pageTotals[p] || 0) + n;
      for (const v of d.visitors) allVisitors.add(v);
      for (const [h, n] of Object.entries(d.hours || {})) {
        const hi = parseInt(h, 10);
        if (hi >= 0 && hi <= 23) hourTotals[hi] += n;
      }
    }
    const topPages = Object.entries(pageTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, views]) => ({ path, views }));
    // The busiest hour, so we can call out the peak in plain language.
    let peakHour = null;
    const maxHour = Math.max(...hourTotals);
    if (maxHour > 0) peakHour = hourTotals.indexOf(maxHour);
    return {
      days: out,                       // newest first
      totalViews,
      uniqueVisitors: allVisitors.size,
      topPages,
      hours: hourTotals,               // [0..23] view counts
      peakHour,                        // 0-23, or null if no data
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
    return store.weddings.find(w => this.isCoupleMember(w, coupleId)) || null;
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
        // Keep the director and video flag — for a music video these drive the
        // display ("director - title") and the 🎬 marker.
        director: (chosen.director || ''),
        video: !!chosen.video,
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
  /* How many votes each guest gets when a wedding's guest requests are opened.
     Set by the DJ, applied whoever opens it — the couple shouldn't be tuning
     vote mechanics, but they can still open requests themselves. */
  setWeddingVotesPer(userId, votes) {
    const u = this.getUserById(userId);
    if (!u) return null;
    const n = parseInt(votes, 10);
    u.wedding_votes_per = (Number.isFinite(n) && n >= 1 && n <= 999) ? n : 3;
    persist();
    return u;
  },
  // Turn the Bookings (CRM) add-on on or off for a DJ.
  setCrmAccess(userId, on) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.crm_access = !!on;
    persist();
    return u;
  },
  /* The DJ's own Stripe account id, so client payments go directly to them.
     Storing only the account id — we never hold their keys or their money. */
  setStripeConnect(userId, accountId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (accountId) u.stripe_connect_id = String(accountId).slice(0, 80);
    else delete u.stripe_connect_id;
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
    // CRM data belongs to the DJ — remove it with the account rather than
    // leaving client names and contact details orphaned in the file.
    if (Array.isArray(store.clients)) store.clients = store.clients.filter(c => c.owner_id !== userId);
    if (Array.isArray(store.bookings)) store.bookings = store.bookings.filter(b => b.owner_id !== userId);
    // Unlink as couple / assigned DJ on anything that referenced them.
    store.weddings.forEach(w => {
      if (w.couple_id === userId) w.couple_id = (Array.isArray(w.couple_ids) ? w.couple_ids.filter(id => id !== userId)[0] : null) || null;
      if (Array.isArray(w.couple_ids)) w.couple_ids = w.couple_ids.filter(id => id !== userId);
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
  /* Apply a guest's votes, enforcing the per-guest vote cap ON THE SERVER.

     This used to be browser-only, which meant a guest could simply refresh the
     page (resetting the in-memory count) and vote again — and at a gig people
     reload constantly, so caps were routinely blown. We now track each guest's
     voted track ids against the event and reject anything over the limit.

     `guestId` identifies the browser; `votesPer` is the event's limit (>=999
     means unlimited). Returns the updated event plus what was actually applied. */
  applyVotes(id, { add = [], remove = [], guest = null, guestId = '', votesPer = 0 }) {
    const e = this.getEvent(id);
    if (!e) return null;
    if (!e.guestVotes) e.guestVotes = {};   // guestId -> [trackId,...]

    const unlimited = !votesPer || votesPer >= 999;
    const mine = guestId ? (e.guestVotes[guestId] || []) : null;

    // --- removals first, so freeing a vote lets them re-spend it in the same call ---
    for (const tid of remove) {
      if (mine) {
        const i = mine.indexOf(tid);
        if (i === -1) continue;            // they didn't vote for this — ignore
        mine.splice(i, 1);
      }
      if (e.tracks[tid]) {
        e.tracks[tid].votes -= 1;
        if (e.tracks[tid].votes <= 0) delete e.tracks[tid];
      }
    }

    // --- adds, capped ---
    const applied = [];
    let rejected = 0;
    for (const t of add) {
      if (mine) {
        if (mine.includes(t.id)) { rejected++; continue; }             // already voted for it
        if (!unlimited && mine.length >= votesPer) { rejected++; continue; }  // out of votes
      }
      if (!e.tracks[t.id]) {
        // isrc: the universal recording ID. Apple search provides it; we keep it
        // so an Apple-sourced track can still be matched to Spotify at export.
        e.tracks[t.id] = { id: t.id, uri: t.uri || null, isrc: t.isrc || '', title: t.title, artist: t.artist, art: t.art || '', votes: 0, played: 0, addedAt: Date.now(), requesters: [] };
      }
      if (!e.tracks[t.id].requesters) e.tracks[t.id].requesters = [];
      e.tracks[t.id].votes += 1;
      if (mine) mine.push(t.id);
      applied.push(t.id);
      // Record who requested it, if they gave a name/nationality.
      if (guest && (guest.name || guest.nationality)) {
        e.tracks[t.id].requesters.push({
          name: (guest.name || '').toString().slice(0, 40),
          nationality: (guest.nationality || '').toString().slice(0, 40),
          at: Date.now(),
        });
      }
    }

    if (guestId) {
      if (mine.length) e.guestVotes[guestId] = mine;
      else delete e.guestVotes[guestId];
    }
    persist();
    e._applied = applied;
    e._rejected = rejected;
    e._myVotes = mine ? mine.slice() : [];
    return e;
  },
  // What has this guest already voted for? Lets a returning/refreshing guest get
  // their real remaining votes back, instead of a fresh (wrong) allocation.
  guestVotesFor(eventId, guestId) {
    const e = this.getEvent(eventId);
    if (!e || !guestId || !e.guestVotes) return [];
    return (e.guestVotes[guestId] || []).slice();
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
        id: track.id, uri: track.uri || null, isrc: track.isrc || '', title: track.title,
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
    return store.weddings.filter(w => this.isCoupleMember(w, coupleId)).sort(byWeddingDate);
  },
  linkCoupleToWedding(weddingId, coupleId) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    if (!Array.isArray(w.couple_ids)) w.couple_ids = w.couple_id ? [w.couple_id] : [];
    // First to join becomes the primary couple_id (kept for backwards-compat).
    if (!w.couple_id) w.couple_id = coupleId;
    if (!w.couple_ids.includes(coupleId)) w.couple_ids.push(coupleId);
    // Cap to a sensible number of members (couple + planner or two).
    if (w.couple_ids.length > 5) w.couple_ids = w.couple_ids.slice(0, 5);
    persist();
    return w;
  },
  // Is this user one of the wedding's couple members? Handles both the legacy
  // single couple_id and the newer couple_ids list.
  isCoupleMember(w, userId) {
    if (!w || !userId) return false;
    if (w.couple_id === userId) return true;
    return Array.isArray(w.couple_ids) && w.couple_ids.includes(userId);
  },
  weddingCoupleMembers(w) {
    if (!w) return [];
    const ids = Array.isArray(w.couple_ids) && w.couple_ids.length
      ? w.couple_ids.slice()
      : (w.couple_id ? [w.couple_id] : []);
    return ids.map(id => {
      const u = this.getUserById(id);
      return u ? { id: u.id, name: u.name || '', email: u.email } : null;
    }).filter(Boolean);
  },
  /* ---- Wedding history (audit log) ----
     Who changed what, and when. Both the DJ and the couple edit a wedding, so
     when something looks wrong ("who deleted the first dance?") there needs to
     be a record. Capped per wedding so it can't grow without bound. */
  addWeddingHistory(weddingId, { actorId, actorName, actorRole, action, detail }) {
    const w = this.getWedding(weddingId);
    if (!w) return null;
    if (!Array.isArray(w.history)) w.history = [];
    w.history.push({
      at: Date.now(),
      actorId: actorId || '',
      actorName: (actorName || 'Someone').toString().slice(0, 60),
      actorRole: actorRole || 'dj',                  // 'dj' | 'couple' | 'subdj'
      action: (action || '').toString().slice(0, 40),   // e.g. 'songs', 'timeline'
      detail: (detail || '').toString().slice(0, 200),
    });
    // Keep the most recent 300 entries per wedding.
    if (w.history.length > 300) w.history = w.history.slice(-300);
    persist();
    return w;
  },
  getWeddingHistory(weddingId) {
    const w = this.getWedding(weddingId);
    if (!w || !Array.isArray(w.history)) return [];
    return w.history.slice().reverse();      // newest first
  },

  /* ---- Login / activity tracking ----
     last_login  = the last time they actually signed in with a password.
     last_seen   = the last time they used the app at all. These differ because a
     session cookie keeps someone signed in for weeks — so a stale last_login
     doesn't mean they're inactive. last_seen is throttled to one write an hour
     so it doesn't hammer the data file on every request. */
  recordLogin(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    u.last_login = Date.now();
    u.last_seen = Date.now();
    u.login_count = (u.login_count || 0) + 1;
    persist();
    return u;
  },
  touchSeen(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    const now = Date.now();
    if (u.last_seen && now - u.last_seen < 60 * 60 * 1000) return u;   // throttle: max 1/hour
    u.last_seen = now;
    persist();
    return u;
  },

  /* ================= CRM: clients & bookings =================
     A BOOKING is the central object — it stands alone (a party, a corporate
     gig) and can optionally link to a Spinlist wedding or event. A CLIENT is
     whoever is paying. Both belong to a DJ (owner_id), so a multi-op agency's
     sub-DJs never see each other's books.

     Money is stored in PENCE as integers. Storing currency as a float invites
     rounding errors — 0.1 + 0.2 famously isn't 0.3 — which is unacceptable on
     invoices. */
  createClient(ownerId, c) {
    if (!store.clients) store.clients = [];
    const client = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      owner_id: ownerId,
      name: (c.name || '').toString().slice(0, 120),
      email: (c.email || '').toString().slice(0, 160),
      phone: (c.phone || '').toString().slice(0, 40),
      notes: (c.notes || '').toString().slice(0, 4000),
      created_at: Date.now(),
    };
    store.clients.push(client);
    persist();
    return client;
  },
  listClients(ownerId) {
    return (store.clients || [])
      .filter(c => c.owner_id === ownerId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },
  getClient(id) { return (store.clients || []).find(c => c.id === id) || null; },
  updateClient(id, fields) {
    const c = this.getClient(id);
    if (!c) return null;
    for (const k of ['name', 'email', 'phone', 'notes']) {
      if (fields[k] !== undefined) c[k] = (fields[k] || '').toString().slice(0, k === 'notes' ? 4000 : 160);
    }
    persist();
    return c;
  },
  deleteClient(id) {
    if (!store.clients) return false;
    const before = store.clients.length;
    store.clients = store.clients.filter(c => c.id !== id);
    // Don't orphan bookings — unlink instead of deleting someone's history.
    (store.bookings || []).forEach(b => { if (b.client_id === id) b.client_id = null; });
    persist();
    return store.clients.length < before;
  },

  /* ---- Contacts on a booking ----
     A job isn't one "client". A wedding typically has two partners, whoever is
     actually paying, and the venue — and quotes, contracts and emails need to
     merge their details in ({{partner_a.first_name}}, {{venue.address}}).

     Roles are deliberately few. Tave ships 29 because it serves photographers,
     videographers and planners across every event type; carrying all of those
     would make every form daunting for coverage that goes unused. */
  bookingRoles() {
    return [
      { key: 'primary_contact', label: 'Primary contact' },
      { key: 'partner_a',       label: 'Partner A' },
      { key: 'partner_b',       label: 'Partner B' },
      { key: 'venue',           label: 'Venue' },
    ];
  },
  setBookingContact(bookingId, role, details) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    const allowed = this.bookingRoles().map(r => r.key);
    if (!allowed.includes(role)) return b;
    if (!b.contacts || typeof b.contacts !== 'object') b.contacts = {};
    const d = details || {};
    const empty = !['name', 'email', 'phone', 'address', 'company']
      .some(k => (d[k] || '').toString().trim());
    if (empty) {
      delete b.contacts[role];               // clearing every field removes the contact
    } else {
      b.contacts[role] = {
        name: (d.name || '').toString().slice(0, 120),
        first_name: (d.name || '').toString().trim().split(/\s+/)[0] || '',
        email: (d.email || '').toString().slice(0, 160),
        phone: (d.phone || '').toString().slice(0, 40),
        address: (d.address || '').toString().slice(0, 300),
        company: (d.company || '').toString().slice(0, 160),
      };
    }
    persist();
    return b;
  },

  /* ---- Sessions ----
     A job is rarely one block of time. A wedding might be setup at 2pm, the
     ceremony at 4, the main event 8-midnight, with a photo booth running
     alongside — all on ONE booking, each with its own times.

     `blocks` decides whether a session makes you unavailable. Setup and the
     main event do; a photo booth someone else runs doesn't, and a long-term
     dancefloor hire would otherwise block weeks of calendar for kit sitting in
     a venue. */
  sessionTypes() {
    return [
      'Setup', 'Wedding Ceremony', 'Wedding Reception', 'Main Event',
      'Session', 'Photo Booth running', 'Mayhem Bingo Show', 'Drone Services',
      'Long-term dancefloor hire', 'Venue Walkthrough', 'Consultation',
      'Meeting', 'Call', 'Unavailable',
    ];
  },
  addSession(bookingId, s) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    if (!Array.isArray(b.sessions)) b.sessions = [];
    if (b.sessions.length >= 30) return b;
    b.sessions.push({
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: (s.type || 'Main Event').toString().slice(0, 60),
      starts_at: s.starts_at || null,
      ends_at: s.ends_at || null,
      note: (s.note || '').toString().slice(0, 300),
      // Default to blocking: safer to over-block and correct it than to be
      // double-booked because a session quietly didn't count.
      blocks: s.blocks === false ? false : true,
    });
    b.sessions.sort((x, y) => (x.starts_at || 0) - (y.starts_at || 0));
    persist();
    return b;
  },
  updateSession(bookingId, sessionId, fields) {
    const b = this.getBooking(bookingId);
    if (!b || !Array.isArray(b.sessions)) return null;
    const s = b.sessions.find(x => x.id === sessionId);
    if (!s) return b;
    if (fields.type !== undefined) s.type = (fields.type || '').toString().slice(0, 60);
    if (fields.starts_at !== undefined) s.starts_at = fields.starts_at || null;
    if (fields.ends_at !== undefined) s.ends_at = fields.ends_at || null;
    if (fields.note !== undefined) s.note = (fields.note || '').toString().slice(0, 300);
    if (fields.blocks !== undefined) s.blocks = !!fields.blocks;
    b.sessions.sort((x, y) => (x.starts_at || 0) - (y.starts_at || 0));
    persist();
    return b;
  },
  removeSession(bookingId, sessionId) {
    const b = this.getBooking(bookingId);
    if (!b || !Array.isArray(b.sessions)) return null;
    b.sessions = b.sessions.filter(s => s.id !== sessionId);
    persist();
    return b;
  },
  /* Every session that blocks availability in a window — this is what answers
     "am I free?". Spans are handled properly: a session running 10pm-2am, or a
     multi-day hire, counts on every day it touches. */
  busySessions(ownerId, fromTs, toTs) {
    const out = [];
    for (const b of (store.bookings || [])) {
      if (b.owner_id !== ownerId) continue;
      if (b.status === 'lost') continue;          // a lost enquiry isn't a commitment
      for (const s of (b.sessions || [])) {
        if (!s.blocks || !s.starts_at) continue;
        const start = s.starts_at;
        const end = s.ends_at || s.starts_at;
        if (end < fromTs || start > toTs) continue;   // no overlap
        out.push({
          booking_id: b.id, booking_title: b.title, status: b.status,
          session_id: s.id, type: s.type, starts_at: start, ends_at: end,
        });
      }
    }
    return out.sort((a, b) => a.starts_at - b.starts_at);
  },

  /* ---- Costs ----
     A job has money going OUT as well as in: a sub-DJ's fee, photo booth hire,
     kit rental. Without these, "£950 booked in" is misleading when the real
     margin is £400 — and that's exactly the figure that needs to be right. */
  addCost(bookingId, c) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    if (!Array.isArray(b.costs)) b.costs = [];
    const amount = parseInt(c.amount_pence, 10);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    b.costs.push({
      id: 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: (c.label || 'Cost').toString().slice(0, 120),
      amount_pence: amount,
      paid: !!c.paid,
      note: (c.note || '').toString().slice(0, 200),
      at: Date.now(),
    });
    persist();
    return b;
  },
  updateCost(bookingId, costId, fields) {
    const b = this.getBooking(bookingId);
    if (!b || !Array.isArray(b.costs)) return null;
    const c = b.costs.find(x => x.id === costId);
    if (!c) return b;
    if (fields.label !== undefined) c.label = (fields.label || '').toString().slice(0, 120);
    if (fields.note !== undefined) c.note = (fields.note || '').toString().slice(0, 200);
    if (fields.paid !== undefined) c.paid = !!fields.paid;
    if (fields.amount_pence !== undefined) {
      const n = parseInt(fields.amount_pence, 10);
      if (Number.isFinite(n) && n > 0) c.amount_pence = n;
    }
    persist();
    return b;
  },
  removeCost(bookingId, costId) {
    const b = this.getBooking(bookingId);
    if (!b || !Array.isArray(b.costs)) return null;
    b.costs = b.costs.filter(c => c.id !== costId);
    persist();
    return b;
  },

  /* ---- Custom fields ----
     Every DJ tracks different things — mileage, PO numbers, what3words, a
     sub-DJ's fee. Rather than hardcoding one person's list, each DJ defines
     their own fields and types. Values live on the booking and are available
     as merge tokens ({{custom.what_3_words}}).

     A money field is stored in PENCE like all other currency here. */
  fieldTypes() { return ['text', 'textarea', 'money', 'number', 'date', 'time', 'address', 'dropdown', 'checkbox']; },

  createField(ownerId, f) {
    if (!store.custom_fields) store.custom_fields = [];
    // The key is how the field is referenced in templates, so it must be stable
    // and safe: lowercase, underscores, no punctuation.
    let key = (f.key || f.name || '').toString().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!key) return null;
    // Keys must be unique per DJ or one field would overwrite another's value.
    const existing = (store.custom_fields || []).filter(x => x.owner_id === ownerId);
    if (existing.some(x => x.key === key)) {
      let n = 2;
      while (existing.some(x => x.key === `${key}_${n}`)) n++;
      key = `${key}_${n}`;
    }
    const field = {
      id: 'cf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      owner_id: ownerId,
      key,
      name: (f.name || key).toString().slice(0, 120),
      type: this.fieldTypes().includes(f.type) ? f.type : 'text',
      options: Array.isArray(f.options) ? f.options.slice(0, 30).map(o => (o || '').toString().slice(0, 80)) : [],
      // Fields are INTERNAL until explicitly published. Defaulting the other way
      // would put things like fee_to_dj on a public enquiry form the moment they
      // were created — a new field should never leak by omission.
      public: !!f.public,
      sort: parseInt(f.sort, 10) || 0,
      created_at: Date.now(),
    };
    store.custom_fields.push(field);
    persist();
    return field;
  },
  listFields(ownerId) {
    return (store.custom_fields || [])
      .filter(f => f.owner_id === ownerId)
      .sort((a, b) => (a.sort - b.sort) || a.created_at - b.created_at);
  },
  /* Fields safe to render on, and accept from, the public enquiry form.
     Anything not explicitly published is invisible to clients AND rejected on
     submission — hiding a field in the UI is not a control. */
  listPublicFields(ownerId) {
    return this.listFields(ownerId).filter(f => f.public === true);
  },
  getField(id) { return (store.custom_fields || []).find(f => f.id === id) || null; },
  updateField(id, fields) {
    const f = this.getField(id);
    if (!f) return null;
    // The key is deliberately NOT editable: templates and stored values
    // reference it, so changing it would silently break existing documents.
    if (fields.name !== undefined) f.name = (fields.name || '').toString().slice(0, 120);
    if (fields.type !== undefined && this.fieldTypes().includes(fields.type)) f.type = fields.type;
    if (fields.public !== undefined) f.public = !!fields.public;
    if (Array.isArray(fields.options)) f.options = fields.options.slice(0, 30).map(o => (o || '').toString().slice(0, 80));
    if (fields.sort !== undefined) f.sort = parseInt(fields.sort, 10) || 0;
    persist();
    return f;
  },
  deleteField(id) {
    const f = this.getField(id);
    if (!f) return false;
    store.custom_fields = (store.custom_fields || []).filter(x => x.id !== id);
    // Values stay on their bookings — deleting a definition shouldn't erase
    // data already recorded against past jobs.
    persist();
    return true;
  },
  setBookingField(bookingId, key, value) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    if (!b.custom || typeof b.custom !== 'object') b.custom = {};
    if (value === null || value === undefined || value === '') delete b.custom[key];
    else b.custom[key] = typeof value === 'boolean' ? value : String(value).slice(0, 2000);
    persist();
    return b;
  },

  /* Each DJ gets a stable, unguessable token for their public enquiry form, so
     the form can be embedded without exposing an account id. Created on first
     use rather than for every account. */
  getEnquiryToken(userId) {
    const u = this.getUserById(userId);
    if (!u) return null;
    if (!u.enquiry_token) {
      u.enquiry_token = require('crypto').randomBytes(12).toString('hex');
      persist();
    }
    return u.enquiry_token;
  },
  getUserByEnquiryToken(token) {
    if (!token) return null;
    return (store.users || []).find(u => u.enquiry_token === token) || null;
  },
  // Flag a booking as an unreviewed enquiry, so new ones stand out.
  markEnquiryNew(bookingId) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    b.is_new_enquiry = true;
    b.enquired_at = Date.now();
    persist();
    return b;
  },
  markEnquirySeen(bookingId) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    b.is_new_enquiry = false;
    persist();
    return b;
  },

  /* ---- Templates (contracts & questionnaires) ----
     Every DJ has their own terms, and different terms for a wedding versus a
     corporate job — so these are user-defined, not built in.

     A contract is a list of SECTIONS (heading + body) rather than free-form
     rich text. Deliberately: an editor's HTML is messy and can render
     differently between the screen a client signs on and the PDF you archive.
     For a document that may be scrutinised later, what they saw and what you
     kept must be provably the same. Sections give predictable rendering while
     still looking professional.

     Bodies may contain merge tokens ({{venue.address}}) and simple markup:
     **bold**, and lines beginning "- " become bullets. */
  templateKinds() { return ['contract', 'questionnaire']; },

  /* ---- Enquiry form layout ----
     A form is ONE ORDERED LIST of items, so the DJ decides what's asked and in
     what order. Three kinds:

       core     - maps onto a real booking column (name, event date, venue…).
                  Can be relabelled, reordered, hidden or made required, but not
                  invented: the key has meaning on the booking record.
       field    - an account-wide custom field, answer merges into contracts.
       question - belongs to this form only, answer recorded on the lead.
       heading  - a section title, so a long form can be broken up.

     name and email are locked visible and required. They aren't decoration:
     an enquiry nobody can reply to isn't a lead, and the submit route rejects
     it anyway. */
  formCoreKeys() {
    return {
      name:       { label: 'Your name',            type: 'text',     locked: true },
      email:      { label: 'Email',                type: 'email',    locked: true },
      phone:      { label: 'Phone',                type: 'tel' },
      event_type: { label: 'What kind of event?',  type: 'select' },
      event_date: { label: 'Date',                 type: 'date' },
      venue:      { label: 'Venue',                type: 'venue' },
      partners:   { label: 'Names of the couple',  type: 'partners' },
      message:    { label: 'Tell us about your event', type: 'textarea' },
    };
  },
  defaultEventTypes() {
    return ['Wedding', 'Corporate event', 'Birthday party', 'Anniversary',
            'Christmas party', 'School prom', 'Other'];
  },
  _cleanFormItems(items) {
    const core = this.formCoreKeys();
    const qTypes = ['text', 'textarea', 'dropdown', 'checkbox', 'date', 'time', 'address', 'number'];
    const seen = {};
    const out = (Array.isArray(items) ? items : []).slice(0, 120).map(it => {
      const kind = ['core', 'field', 'question', 'heading'].includes(it.kind) ? it.kind : null;
      if (!kind) return null;
      const label = (it.label || '').toString().slice(0, 300);

      if (kind === 'heading') return label ? { kind, label } : null;

      if (kind === 'core') {
        const key = (it.key || '').toString();
        if (!core[key] || seen['c' + key]) return null;
        seen['c' + key] = 1;
        const locked = !!core[key].locked;
        const item = {
          kind, key,
          label: label || core[key].label,
          show: locked ? true : it.show !== false,
          required: locked ? true : !!it.required,
        };
        if (key === 'event_type') {
          item.options = Array.isArray(it.options) && it.options.length
            ? it.options.slice(0, 40).map(o => String(o).slice(0, 80))
            : this.defaultEventTypes();
        }
        return item;
      }

      const key = (it.key || '').toString().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      if (!key || seen[kind + key]) return null;
      seen[kind + key] = 1;

      if (kind === 'field') return { kind, key, label, required: !!it.required };

      return {
        kind, key,
        label: label || key,
        type: qTypes.includes(it.type) ? it.type : 'text',
        options: it.type === 'dropdown'
          ? (Array.isArray(it.options) ? it.options.slice(0, 30).map(o => String(o).slice(0, 80)) : [])
          : [],
        required: !!it.required,
      };
    }).filter(Boolean);

    // name and email cannot be dropped, however the list arrived.
    ['email', 'name'].forEach(k => {
      if (!out.some(i => i.kind === 'core' && i.key === k)) {
        out.unshift({ kind: 'core', key: k, label: core[k].label, show: true, required: true });
      }
    });
    return out;
  },
  /* Built for forms that predate the ordered list, from whatever they had. */
  defaultFormItems(t) {
    const core = this.formCoreKeys();
    const items = Object.keys(core).map(key => ({
      kind: 'core', key, label: core[key].label,
      show: true, required: !!core[key].locked,
      options: key === 'event_type' ? this.defaultEventTypes() : undefined,
    }));
    (Array.isArray(t && t.form_fields) ? t.form_fields : []).forEach(key => {
      items.push({ kind: 'field', key, label: '', required: false });
    });
    (Array.isArray(t && t.questions) ? t.questions : []).forEach(q => {
      items.push({ kind: 'question', key: q.key, label: q.label, type: q.type,
                   options: q.options, required: q.required });
    });
    return this._cleanFormItems(items);
  },
  /* The layout to render, migrating older templates on read rather than needing
     a migration pass over the data file. */
  formItems(t) {
    if (!t) return [];
    return Array.isArray(t.form_items) && t.form_items.length
      ? this._cleanFormItems(t.form_items)
      : this.defaultFormItems(t);
  },

  createTemplate(ownerId, t) {
    if (!store.templates) store.templates = [];
    const kind = this.templateKinds().includes(t.kind) ? t.kind : 'contract';
    const tpl = {
      id: 'tp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      owner_id: ownerId,
      kind,
      name: (t.name || (kind === 'contract' ? 'Contract' : 'Questionnaire')).toString().slice(0, 120),
      // Which job types this suits — so the right contract is offered for a
      // wedding versus a corporate booking. Empty means "any".
      applies_to: Array.isArray(t.applies_to) ? t.applies_to.slice(0, 12).map(x => String(x).slice(0, 40)) : [],
      sections: this._cleanSections(t.sections),
      questions: kind === 'questionnaire' ? this._cleanQuestions(t.questions) : [],
      /* A questionnaire doubles as a public enquiry form. Each one gets its own
         token so a DJ running several brands can embed a different form on each
         site, while every submission lands in the same pipeline. */
      form_fields: Array.isArray(t.form_fields) ? t.form_fields.slice(0, 40).map(x => String(x).slice(0, 40)) : [],
      intro: (t.intro || '').toString().slice(0, 1200),
      thanks: (t.thanks || '').toString().slice(0, 1200),
      form_active: t.form_active === undefined ? true : !!t.form_active,
      form_items: Array.isArray(t.form_items) ? this._cleanFormItems(t.form_items) : [],
      form_token: null,
      is_default: !!t.is_default,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    store.templates.push(tpl);
    persist();
    return tpl;
  },
  _cleanSections(sections) {
    return (Array.isArray(sections) ? sections : []).slice(0, 60).map(s => ({
      id: s.id || ('sec' + Math.random().toString(36).slice(2, 8)),
      heading: (s.heading || '').toString().slice(0, 200),
      body: (s.body || '').toString().slice(0, 8000),
    }));
  },
  _cleanQuestions(questions) {
    const types = ['text', 'textarea', 'dropdown', 'checkbox', 'date', 'time', 'address', 'number'];
    return (Array.isArray(questions) ? questions : []).slice(0, 80).map(q => ({
      id: q.id || ('qq' + Math.random().toString(36).slice(2, 8)),
      key: (q.key || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40),
      label: (q.label || '').toString().slice(0, 300),
      type: types.includes(q.type) ? q.type : 'text',
      options: Array.isArray(q.options) ? q.options.slice(0, 30).map(o => String(o).slice(0, 80)) : [],
      required: !!q.required,
    }));
  },
  // NOTE: named listCrmTemplates, NOT listTemplates. The wedding planner
  // defines its own listTemplates() further down this same object literal, and
  // a duplicate key silently wins — which sent every CRM lookup to the
  // planner's q_templates instead of store.templates. Keep these names distinct.
  listCrmTemplates(ownerId, kind) {
    return (store.templates || [])
      .filter(t => t.owner_id === ownerId && (!kind || t.kind === kind))
      .sort((a, b) => (b.is_default - a.is_default) || (a.name || '').localeCompare(b.name || ''));
  },
  getTemplate(id) { return (store.templates || []).find(t => t.id === id) || null; },
  /* Minted on first use rather than at creation, so templates made before this
     existed pick one up the moment their embed code is asked for. */
  ensureFormToken(id) {
    const t = this.getTemplate(id);
    if (!t) return null;
    if (!t.form_token) {
      t.form_token = require('crypto').randomBytes(12).toString('hex');
      persist();
    }
    return t.form_token;
  },
  getTemplateByFormToken(token) {
    if (!token) return null;
    return (store.templates || []).find(t => t.form_token === token) || null;
  },
  /* The answers a lead gave, SNAPSHOTTED with their questions. The questions
     are stored alongside the answers rather than referenced, for the same
     reason a contract freezes its wording at issue: edit the form next month
     and last month's lead must still read back correctly. It also means the
     booking screen can render answers without needing a field definition. */
  setBookingEnquiry(bookingId, snapshot) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    b.enquiry = {
      form_id: (snapshot && snapshot.form_id) || null,
      form_name: (snapshot && snapshot.form_name) || '',
      at: Date.now(),
      questions: (Array.isArray(snapshot && snapshot.questions) ? snapshot.questions : [])
        .slice(0, 80)
        .map(q => ({
          label: (q.label || '').toString().slice(0, 300),
          type: (q.type || 'text').toString().slice(0, 20),
          answer: q.answer === true ? true
                : q.answer === false ? false
                : (q.answer === null || q.answer === undefined) ? ''
                : String(q.answer).slice(0, 2000),
        })),
    };
    persist();
    return b;
  },
  /* Which brand's form an enquiry arrived through. One pipeline, but the origin
     is never guessed at afterwards. */
  setBookingSource(bookingId, form) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    b.source_form_id = (form && form.id) || null;
    b.source_form_name = (form && form.name) || '';
    persist();
    return b;
  },
  updateTemplate(id, fields) {
    const t = this.getTemplate(id);
    if (!t) return null;
    if (fields.name !== undefined) t.name = (fields.name || '').toString().slice(0, 120);
    if (Array.isArray(fields.applies_to)) t.applies_to = fields.applies_to.slice(0, 12).map(x => String(x).slice(0, 40));
    if (fields.sections !== undefined) t.sections = this._cleanSections(fields.sections);
    if (fields.form_fields !== undefined) {
      t.form_fields = Array.isArray(fields.form_fields)
        ? fields.form_fields.slice(0, 40).map(x => String(x).slice(0, 40)) : [];
    }
    if (fields.intro !== undefined) t.intro = (fields.intro || '').toString().slice(0, 1200);
    if (fields.thanks !== undefined) t.thanks = (fields.thanks || '').toString().slice(0, 1200);
    if (fields.form_active !== undefined) t.form_active = !!fields.form_active;
    if (fields.form_items !== undefined) t.form_items = this._cleanFormItems(fields.form_items);
    if (fields.questions !== undefined) t.questions = this._cleanQuestions(fields.questions);
    if (fields.is_default !== undefined) {
      t.is_default = !!fields.is_default;
      // Only one default per kind, or "which one?" becomes ambiguous.
      if (t.is_default) {
        (store.templates || []).forEach(o => {
          if (o.owner_id === t.owner_id && o.kind === t.kind && o.id !== t.id) o.is_default = false;
        });
      }
    }
    t.updated_at = Date.now();
    persist();
    return t;
  },
  // Named deleteCrmTemplate for the same reason as above — the planner's
  // deleteTemplate(userId, tplId) was overwriting this one, so the CRM was
  // passing a template ID where a user ID was expected and deleting nothing.
  deleteCrmTemplate(id) {
    if (!store.templates) return false;
    const n = store.templates.length;
    store.templates = store.templates.filter(t => t.id !== id);
    persist();
    return store.templates.length < n;
  },

  /* ---- Contracts (issued, and signed) ----
     A contract is a SNAPSHOT: when it's issued, the rendered sections are
     frozen onto the record rather than referencing the template. If the DJ
     later edits their terms, a contract already signed must still show exactly
     what was agreed — anything else would be rewriting an agreed document.

     Once signed, nothing about it can change. The signature record keeps the
     time, the signer's name and their IP, which is what makes it evidence
     rather than a decoration. */
  createContract(ownerId, c) {
    if (!store.contracts) store.contracts = [];
    const contract = {
      id: 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      owner_id: ownerId,
      booking_id: c.booking_id || null,
      quote_id: c.quote_id || null,
      template_id: c.template_id || null,
      token: require('crypto').randomBytes(16).toString('hex'),
      title: (c.title || 'Agreement').toString().slice(0, 200),
      // Frozen at issue — see above.
      sections: (Array.isArray(c.sections) ? c.sections : []).slice(0, 60).map(s => ({
        heading: (s.heading || '').toString().slice(0, 200),
        body_html: (s.body_html || '').toString().slice(0, 20000),
      })),
      status: 'sent',                 // sent → signed | void
      signed_at: null,
      signature: null,                // { name, typed, ip, user_agent, at }
      created_at: Date.now(),
    };
    store.contracts.push(contract);
    persist();
    return contract;
  },
  listContracts(ownerId, bookingId) {
    return (store.contracts || [])
      .filter(c => c.owner_id === ownerId && (!bookingId || c.booking_id === bookingId))
      .sort((a, b) => b.created_at - a.created_at);
  },
  getContract(id) { return (store.contracts || []).find(c => c.id === id) || null; },
  getContractByToken(token) {
    if (!token) return null;
    return (store.contracts || []).find(c => c.token === token) || null;
  },
  signContract(id, sig) {
    const c = this.getContract(id);
    if (!c) return null;
    // A signed contract is final. Re-signing would make it unclear which
    // signature applies, so it's refused rather than silently overwritten.
    if (c.status === 'signed') return c;
    c.status = 'signed';
    c.signed_at = Date.now();
    c.signature = {
      name: (sig.name || '').toString().slice(0, 120),
      typed: (sig.typed || '').toString().slice(0, 120),
      ip: (sig.ip || '').toString().slice(0, 60),
      user_agent: (sig.user_agent || '').toString().slice(0, 300),
      at: Date.now(),
    };
    persist();
    return c;
  },
  voidContract(id) {
    const c = this.getContract(id);
    if (!c) return null;
    if (c.status === 'signed') return c;   // can't void something already agreed
    c.status = 'void';
    persist();
    return c;
  },

  createBooking(ownerId, b) {
    if (!store.bookings) store.bookings = [];
    const booking = {
      id: 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      owner_id: ownerId,
      client_id: b.client_id || null,
      title: (b.title || 'Untitled booking').toString().slice(0, 160),
      type: (b.type || 'Wedding').toString().slice(0, 40),
      event_date: b.event_date || null,          // ms timestamp
      venue: (b.venue || '').toString().slice(0, 200),
      // enquiry → quoted → confirmed → completed → lost
      status: ['enquiry', 'quoted', 'confirmed', 'completed', 'lost'].includes(b.status) ? b.status : 'enquiry',
      fee_pence: Number.isFinite(parseInt(b.fee_pence, 10)) ? Math.max(0, parseInt(b.fee_pence, 10)) : 0,
      deposit_pence: Number.isFinite(parseInt(b.deposit_pence, 10)) ? Math.max(0, parseInt(b.deposit_pence, 10)) : 0,
      notes: (b.notes || '').toString().slice(0, 4000),
      wedding_id: b.wedding_id || null,          // optional link to a Spinlist wedding
      event_id: b.event_id || null,              // or a live event
      contacts: {},                              // role -> { name, email, phone, address, company }
      sessions: [],                              // [{ id, type, starts_at, ends_at, blocks }]
      costs: [],                                 // money OUT: sub-DJ fee, photo booth hire…
      custom: {},                                // custom field key -> value
      payments: [],                              // [{ id, amount_pence, at, method, note }]
      created_at: Date.now(),
    };
    store.bookings.push(booking);
    persist();
    return booking;
  },
  listBookings(ownerId) {
    return (store.bookings || [])
      .filter(b => b.owner_id === ownerId)
      .sort((a, b) => {
        // Dated bookings first, soonest at the top; undated at the end.
        if (a.event_date && b.event_date) return a.event_date - b.event_date;
        if (a.event_date) return -1;
        if (b.event_date) return 1;
        return b.created_at - a.created_at;
      });
  },
  getBooking(id) { return (store.bookings || []).find(b => b.id === id) || null; },
  updateBooking(id, fields) {
    const b = this.getBooking(id);
    if (!b) return null;
    if (fields.title !== undefined) b.title = (fields.title || '').toString().slice(0, 160);
    if (fields.type !== undefined) b.type = (fields.type || '').toString().slice(0, 40);
    if (fields.venue !== undefined) b.venue = (fields.venue || '').toString().slice(0, 200);
    if (fields.notes !== undefined) b.notes = (fields.notes || '').toString().slice(0, 4000);
    if (fields.event_date !== undefined) b.event_date = fields.event_date || null;
    if (fields.client_id !== undefined) b.client_id = fields.client_id || null;
    if (fields.wedding_id !== undefined) b.wedding_id = fields.wedding_id || null;
    if (fields.status !== undefined && ['enquiry', 'quoted', 'confirmed', 'completed', 'lost'].includes(fields.status)) b.status = fields.status;
    for (const k of ['fee_pence', 'deposit_pence']) {
      if (fields[k] !== undefined) {
        const n = parseInt(fields[k], 10);
        b[k] = Number.isFinite(n) ? Math.max(0, n) : 0;
      }
    }
    persist();
    return b;
  },
  deleteBooking(id) {
    if (!store.bookings) return false;
    const before = store.bookings.length;
    store.bookings = store.bookings.filter(b => b.id !== id);
    persist();
    return store.bookings.length < before;
  },
  // Record money received against a booking.
  addPayment(bookingId, p) {
    const b = this.getBooking(bookingId);
    if (!b) return null;
    if (!Array.isArray(b.payments)) b.payments = [];
    const amount = parseInt(p.amount_pence, 10);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    b.payments.push({
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      amount_pence: amount,
      at: p.at || Date.now(),
      method: (p.method || 'manual').toString().slice(0, 30),
      note: (p.note || '').toString().slice(0, 200),
    });
    persist();
    return b;
  },
  removePayment(bookingId, paymentId) {
    const b = this.getBooking(bookingId);
    if (!b || !Array.isArray(b.payments)) return null;
    b.payments = b.payments.filter(p => p.id !== paymentId);
    persist();
    return b;
  },

  /* ---- Products (packages) ----
     Presets so a quote is a couple of clicks. The price is copied onto the
     quote when it's added, so editing a product later never changes a quote
     already sent — that would be rewriting history a client has agreed to. */
  createProduct(ownerId, p) {
    if (!store.products) store.products = [];
    const prod = {
      id: 'pr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      owner_id: ownerId,
      name: (p.name || 'Package').toString().slice(0, 120),
      description: (p.description || '').toString().slice(0, 2000),
      price_pence: Math.max(0, parseInt(p.price_pence, 10) || 0),
      image: (p.image || '').toString().slice(0, 300),
      active: p.active === false ? false : true,
      created_at: Date.now(),
    };
    store.products.push(prod);
    persist();
    return prod;
  },
  listProducts(ownerId) {
    return (store.products || []).filter(p => p.owner_id === ownerId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  },
  getProduct(id) { return (store.products || []).find(p => p.id === id) || null; },
  updateProduct(id, fields) {
    const p = this.getProduct(id);
    if (!p) return null;
    if (fields.name !== undefined) p.name = (fields.name || '').toString().slice(0, 120);
    if (fields.description !== undefined) p.description = (fields.description || '').toString().slice(0, 2000);
    if (fields.price_pence !== undefined) p.price_pence = Math.max(0, parseInt(fields.price_pence, 10) || 0);
    if (fields.active !== undefined) p.active = !!fields.active;
    if (fields.image !== undefined) p.image = (fields.image || '').toString().slice(0, 300);
    persist();
    return p;
  },
  deleteProduct(id) {
    if (!store.products) return false;
    const n = store.products.length;
    store.products = store.products.filter(p => p.id !== id);
    persist();
    return store.products.length < n;
  },

  /* ---- Quotes ----
     A quote belongs to a booking and is what the client actually sees. Once
     SENT it's effectively an offer, so the line items and totals are frozen
     copies rather than live references.

     Status: draft → sent → accepted | declined | expired
     The public token is how a client opens it without an account — clients
     will not create logins to accept a quote. */
  createQuote(ownerId, q) {
    if (!store.quotes) store.quotes = [];
    const items = (Array.isArray(q.items) ? q.items : []).slice(0, 40).map(it => ({
      name: (it.name || '').toString().slice(0, 160),
      description: (it.description || '').toString().slice(0, 1000),
      qty: Math.max(1, parseInt(it.qty, 10) || 1),
      unit_pence: Math.max(0, parseInt(it.unit_pence, 10) || 0),
      image: (it.image || '').toString().slice(0, 300),
    }));
    const subtotal = items.reduce((s, it) => s + it.qty * it.unit_pence, 0);
    const quote = {
      id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      owner_id: ownerId,
      booking_id: q.booking_id || null,
      token: require('crypto').randomBytes(16).toString('hex'),   // public link
      items,
      subtotal_pence: subtotal,
      total_pence: subtotal,
      // Payment terms: a deposit (percent OR fixed) and when the balance is due.
      deposit_type: q.deposit_type === 'fixed' ? 'fixed' : 'percent',
      deposit_value: Math.max(0, parseInt(q.deposit_value, 10) || 0),   // percent, or pence if fixed
      balance_days_before: Math.max(0, parseInt(q.balance_days_before, 10) || 28),
      message: (q.message || '').toString().slice(0, 4000),
      status: 'draft',
      expires_at: q.expires_at || (Date.now() + 30 * 864e5),
      sent_at: null,
      responded_at: null,
      created_at: Date.now(),
    };
    store.quotes.push(quote);
    persist();
    return quote;
  },
  listQuotes(ownerId, bookingId) {
    return (store.quotes || [])
      .filter(q => q.owner_id === ownerId && (!bookingId || q.booking_id === bookingId))
      .sort((a, b) => b.created_at - a.created_at);
  },
  getQuote(id) { return (store.quotes || []).find(q => q.id === id) || null; },
  getQuoteByToken(token) {
    if (!token) return null;
    return (store.quotes || []).find(q => q.token === token) || null;
  },
  updateQuote(id, fields) {
    const q = this.getQuote(id);
    if (!q) return null;
    // A sent quote is an offer the client may already be reading — don't let
    // the figures change underneath them.
    if (q.status !== 'draft') return q;
    if (Array.isArray(fields.items)) {
      q.items = fields.items.slice(0, 40).map(it => ({
        name: (it.name || '').toString().slice(0, 160),
        description: (it.description || '').toString().slice(0, 1000),
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        unit_pence: Math.max(0, parseInt(it.unit_pence, 10) || 0),
        image: (it.image || '').toString().slice(0, 300),
      }));
      q.subtotal_pence = q.items.reduce((s, it) => s + it.qty * it.unit_pence, 0);
      q.total_pence = q.subtotal_pence;
    }
    if (fields.deposit_type !== undefined) q.deposit_type = fields.deposit_type === 'fixed' ? 'fixed' : 'percent';
    if (fields.deposit_value !== undefined) q.deposit_value = Math.max(0, parseInt(fields.deposit_value, 10) || 0);
    if (fields.balance_days_before !== undefined) q.balance_days_before = Math.max(0, parseInt(fields.balance_days_before, 10) || 28);
    if (fields.message !== undefined) q.message = (fields.message || '').toString().slice(0, 4000);
    if (fields.expires_at !== undefined) q.expires_at = fields.expires_at || null;
    persist();
    return q;
  },
  setQuoteStatus(id, status, at) {
    const q = this.getQuote(id);
    if (!q) return null;
    if (!['draft', 'sent', 'accepted', 'declined', 'expired'].includes(status)) return q;
    q.status = status;
    if (status === 'sent') q.sent_at = at || Date.now();
    if (status === 'accepted' || status === 'declined') q.responded_at = at || Date.now();
    persist();
    return q;
  },
  deleteQuote(id) {
    if (!store.quotes) return false;
    const n = store.quotes.length;
    store.quotes = store.quotes.filter(q => q.id !== id);
    persist();
    return store.quotes.length < n;
  },

  updateWedding(id, fields) {
    const w = this.getWedding(id);
    if (!w) return null;
    if (fields.name !== undefined) w.name = fields.name;
    if (fields.couple_names !== undefined) w.couple_names = fields.couple_names;
    if (fields.wedding_date !== undefined) w.wedding_date = fields.wedding_date;
    if (fields.photo !== undefined) w.photo = fields.photo;   // /uploads/... or null to clear
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
      // Free-text detail for the moment — e.g. "lights down, Dad speaks first".
      note: (t.note || '').toString().slice(0, 500),
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
