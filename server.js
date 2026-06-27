/* ============================================================
   Spinlist — server
   ------------------------------------------------------------
   Adds to the original Spotify search proxy:
     • Email/password accounts (hosts = subscribers)
     • Stripe Checkout for Pro/Studio subscriptions
     • Stripe webhook -> provisions/revokes plan access
     • Customer portal for managing/cancelling
     • Server-side gating on event creation by plan

   Guests never sign in. Only hosts subscribe.

   Run:  cp .env.example .env  (fill it in) ; npm install ; npm start
   ============================================================ */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config();

const db = require('./lib/db');
const auth = require('./lib/auth');
const PLANS = require('./lib/plans');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

/* ---------- logo uploads ---------- */
// Stored on disk and served statically. On hosts with an ephemeral filesystem
// (e.g. Render's free/standard instances), uploads must live on the SAME
// persistent disk as the data file, or they vanish on redeploy. We derive the
// upload dir from UPLOAD_DIR if set, else from the data file's directory, else
// a local ./uploads for dev.
const UPLOAD_DIR = process.env.UPLOAD_DIR
  || (process.env.DATA_FILE ? path.join(path.dirname(process.env.DATA_FILE), 'uploads') : path.join(__dirname, 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = ALLOWED_LOGO_TYPES[file.mimetype] || 'bin';
      cb(null, `logo_${req.user.id}_${crypto.randomBytes(6).toString('hex')}.${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },   // 2 MB cap
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_LOGO_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error('Unsupported file type. Use PNG, JPG, WebP, or SVG.'));
  },
});

/* ---------- Spotify config ---------- */
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_MARKET = process.env.SPOTIFY_MARKET || 'GB';
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n  Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. See .env.example.\n');
  process.exit(1);
}

/* ---------- Stripe config (optional until you add keys) ---------- */
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
let stripe = null;
if (STRIPE_SECRET) {
  // Let the installed Stripe SDK use its own pinned default API version.
  // (Hard-coding a date string here can break if it doesn't match the SDK.)
  stripe = require('stripe')(STRIPE_SECRET);
} else {
  console.warn('  [warn] STRIPE_SECRET_KEY not set — billing routes will return a setup notice.\n');
}

/* ---------- admin config ----------
   Only these accounts can create/manage complimentary & discount codes.
   Comma-separated list in .env, e.g. ADMIN_EMAILS=you@x.com,partner@x.com */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isAdmin(user) { return !!user && ADMIN_EMAILS.includes(user.email.toLowerCase()); }
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only.' });
  next();
}

/* ============================================================
   IMPORTANT: the Stripe webhook needs the RAW body for signature
   verification, so it is mounted BEFORE express.json().
   ============================================================ */
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency: Stripe guarantees at-least-once delivery.
    if (db.alreadyProcessed(event.id)) return res.json({ received: true, duplicate: true });

    try {
      handleStripeEvent(event);
      db.markProcessed(event.id);
    } catch (err) {
      console.error('Webhook handler error:', err.message);
      return res.status(500).end(); // let Stripe retry
    }
    res.json({ received: true });
  }
);

/* ---------- normal middleware (after webhook) ---------- */
app.use(express.json());
app.use(auth.attachUser);

/* =========================================================
   AUTH ROUTES
   ========================================================= */
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const user = db.createUser({
    id: auth.newId(),
    email: email.toLowerCase(),
    password_hash: auth.hashPassword(password),
    name: name || '',
    created_at: Date.now(),
  });
  const token = auth.startSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email && db.getUserByEmail(email);
  if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  const token = auth.startSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.sessionToken) db.deleteSession(req.sessionToken);
  res.setHeader('Set-Cookie', auth.clearCookie());
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  // lazily drop expired comp access before reporting state
  if (db.expireCompIfNeeded(req.user)) req.user = db.getUserById(req.user.id);
  res.json({
    user: publicUser(req.user),
    plan: PLANS[req.user.plan] || PLANS.none,
    eventsThisMonth: db.countEventsThisMonth(req.user.id),
    branding: db.getBranding(req.user.id),
    isAdmin: isAdmin(req.user),
    compUntil: req.user.comp_until || null,
  });
});

app.get('/api/plans', (_req, res) => res.json({ plans: PLANS }));

/* =========================================================
   BILLING ROUTES (Stripe Checkout + Portal)
   ========================================================= */
app.post('/api/billing/checkout', auth.requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured yet (no Stripe key).' });
  const planId = (req.body || {}).plan;
  const plan = PLANS[planId];
  if (!plan || !plan.stripePriceEnv) return res.status(400).json({ error: 'Pick a paid plan.' });
  const priceId = process.env[plan.stripePriceEnv];
  if (!priceId) return res.status(500).json({ error: `Missing ${plan.stripePriceEnv} in environment.` });

  try {
    // Reuse an existing Stripe customer if we have one — but verify it still
    // exists in the CURRENT Stripe environment. A customer saved while testing
    // in live mode won't exist in a sandbox (and vice versa), so we recreate.
    let customerId = req.user.stripe_customer;
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if (!existing || existing.deleted) customerId = null;
      } catch (e) {
        customerId = null;   // not found in this environment
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email, metadata: { userId: req.user.id } });
      customerId = customer.id;
      db.setStripeCustomer(req.user.id, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, plan: plan.id },
      subscription_data: { metadata: { userId: req.user.id, plan: plan.id } },
      allow_promotion_codes: true,
      success_url: `${BASE_URL}/?checkout=success`,
      cancel_url: `${BASE_URL}/pricing.html?checkout=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err.message);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// Customer portal: lets a subscriber update card / cancel.
app.post('/api/billing/portal', auth.requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured yet.' });
  if (!req.user.stripe_customer) return res.status(400).json({ error: 'No subscription on file.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer,
      return_url: `${BASE_URL}/account.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('portal error:', err.message);
    res.status(500).json({ error: 'Could not open billing portal.' });
  }
});

/* ---------- webhook event handling ---------- */
function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      const userId = s.metadata?.userId || s.client_reference_id;
      if (userId && s.customer) db.setStripeCustomer(userId, s.customer);
      // Set the plan here too — checkout completion is a reliable "they paid"
      // signal. The subscription.* events below also set it (idempotent), but
      // this guarantees the upgrade even if those events are delayed/missing.
      if (userId && s.mode === 'subscription') {
        const user = db.getUserById(userId);
        const planId = s.metadata?.plan || 'pro';
        if (user) db.setPlan(user.id, { plan: planId, sub_status: 'active', stripe_sub: s.subscription || null });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const user = resolveUser(sub);
      if (!user) break;
      const planId = sub.metadata?.plan || planFromPrice(sub) || 'pro';
      const active = ['active', 'trialing'].includes(sub.status);
      db.setPlan(user.id, {
        plan: active ? planId : 'none',
        sub_status: sub.status,
        stripe_sub: sub.id,
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const user = resolveUser(sub);
      if (user) db.setPlan(user.id, { plan: 'none', sub_status: 'canceled', stripe_sub: null });
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const user = inv.customer && db.getUserByCustomer(inv.customer);
      if (user) db.setPlan(user.id, { plan: user.plan, sub_status: 'past_due', stripe_sub: user.stripe_sub });
      break;
    }
    default:
      // ignore the rest
      break;
  }
}
function resolveUser(sub) {
  if (sub.metadata?.userId) return db.getUserById(sub.metadata.userId);
  if (sub.customer) return db.getUserByCustomer(sub.customer);
  return null;
}
function planFromPrice(sub) {
  const priceId = sub.items?.data?.[0]?.price?.id;
  for (const p of Object.values(PLANS)) {
    if (p.stripePriceEnv && process.env[p.stripePriceEnv] === priceId) return p.id;
  }
  return null;
}

/* =========================================================
   EVENT CREATION — gated by plan (server-side enforcement)
   ========================================================= */
app.post('/api/events', auth.requireAuth, (req, res) => {
  // drop expired comp access first
  if (db.expireCompIfNeeded(req.user)) req.user = db.getUserById(req.user.id);

  const plan = PLANS[req.user.plan] || PLANS.none;

  // no active plan at all → must subscribe or redeem a code
  if (req.user.plan === 'none' || plan.maxEventsPerMonth === 0) {
    return res.status(403).json({
      error: 'You need an active plan to create events. Subscribe or redeem a complimentary code.',
      upgrade: true,
    });
  }

  const used = db.countEventsThisMonth(req.user.id);
  if (plan.maxEventsPerMonth !== null && used >= plan.maxEventsPerMonth) {
    return res.status(403).json({
      error: `Your ${plan.name} plan allows ${plan.maxEventsPerMonth} event(s) per month. Upgrade to create more.`,
      upgrade: true,
    });
  }

  const b = req.body || {};
  const id = auth.newId().slice(0, 6).toUpperCase();
  db.recordEvent(id, req.user.id);                 // usage counter
  const event = db.createEvent({                   // the real stored event
    id,
    host_id: req.user.id,
    name: (b.name || 'Untitled Event').toString().slice(0, 120),
    type: (b.type || 'Event').toString().slice(0, 40),
    host: (b.host || req.user.name || 'Your host').toString().slice(0, 80),
    votes_per: Math.max(1, Math.min(parseInt(b.votesPer, 10) || 5, 999)),
    deadline: b.deadline ? Number(b.deadline) : null,
    locked: false,
    ask_name: !!b.askName,
    ask_nationality: !!b.askNationality,
    created_at: Date.now(),
  });
  res.json({
    eventId: id,
    hostId: req.user.id,
    maxGuests: plan.maxGuestsPerEvent,
    plan: plan.id,
    event: publicEvent(event),
  });
});

// --- list my events (host dashboard) ---
app.get('/api/my-events', auth.requireAuth, (req, res) => {
  const events = db.listEventsByHost(req.user.id).map(summaryEvent);
  res.json({ events });
});

// --- get one event (PUBLIC — guests load this by id) ---
app.get('/api/events/:id', (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  // include host branding if their plan allows it
  let branding = null;
  const host = db.getUserById(e.host_id);
  if (host && planHasBranding(host)) branding = db.getBranding(host.id);
  // The host sees requester names; guests do not.
  const isHost = req.user && req.user.id === e.host_id;
  res.json({ event: publicEvent(e, isHost), branding });
});

// --- lock / unlock voting (host only, own event) ---
app.post('/api/events/:id/lock', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (e.host_id !== req.user.id) return res.status(403).json({ error: 'Not your event.' });
  const updated = db.setEventLocked(e.id, !!(req.body || {}).locked);
  res.json({ event: publicEvent(updated) });
});

// --- archive / unarchive an event (host only) ---
app.post('/api/events/:id/archive', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (e.host_id !== req.user.id) return res.status(403).json({ error: 'Not your event.' });
  db.setArchived(e.id, !!(req.body || {}).archived);
  res.json({ ok: true });
});

// --- edit an event's details (host only). Share link/id never change. ---
app.post('/api/events/:id/update', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (e.host_id !== req.user.id) return res.status(403).json({ error: 'Not your event.' });
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = (b.name || 'Untitled Event').toString().slice(0, 120);
  if (b.type !== undefined) fields.type = (b.type || 'Event').toString().slice(0, 40);
  if (b.host !== undefined) fields.host = (b.host || 'Your host').toString().slice(0, 80);
  if (b.votesPer !== undefined) fields.votes_per = Math.max(1, Math.min(parseInt(b.votesPer, 10) || 5, 999));
  if (b.deadline !== undefined) fields.deadline = b.deadline ? Number(b.deadline) : null;
  if (b.askName !== undefined) fields.ask_name = !!b.askName;
  if (b.askNationality !== undefined) fields.ask_nationality = !!b.askNationality;
  const updated = db.updateEvent(e.id, fields);
  res.json({ event: publicEvent(updated, true) });
});

// --- delete an event (host only) ---
app.delete('/api/events/:id', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (e.host_id !== req.user.id) return res.status(403).json({ error: 'Not your event.' });
  db.deleteEvent(e.id);
  res.json({ ok: true });
});

// --- mark a song played / unplayed (host only) ---
app.post('/api/events/:id/played', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (e.host_id !== req.user.id) return res.status(403).json({ error: 'Not your event.' });
  const b = req.body || {};
  if (!b.trackId) return res.status(400).json({ error: 'trackId required.' });
  const updated = db.setPlayed(e.id, b.trackId, !!b.played);
  res.json({ event: publicEvent(updated) });
});

// --- cast votes (PUBLIC — guests). body: { add:[track], remove:[trackId] } ---
app.post('/api/events/:id/vote', (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  const closed = e.locked || (e.deadline && Date.now() > e.deadline);
  if (closed) return res.status(403).json({ error: 'Voting is closed for this event.' });
  const b = req.body || {};
  // Don't allow new votes on a song that's already been played.
  const add = Array.isArray(b.add) ? b.add.filter(t => t && t.id && t.title && !(e.tracks[t.id] && e.tracks[t.id].played)).slice(0, 50) : [];
  const remove = Array.isArray(b.remove) ? b.remove.filter(x => typeof x === 'string').slice(0, 50) : [];
  const guest = (b.guest && typeof b.guest === 'object') ? { name: b.guest.name, nationality: b.guest.nationality } : null;
  const updated = db.applyVotes(e.id, { add, remove, guest });
  res.json({ event: publicEvent(updated) });
});

// Shape an event for public/guest consumption (full track list).
function publicEvent(e, hostView) {
  if (!e) return null;
  return {
    id: e.id, name: e.name, type: e.type, host: e.host,
    votesPer: e.votes_per, deadline: e.deadline,
    locked: !!e.locked, hostId: e.host_id,
    askName: !!e.ask_name, askNationality: !!e.ask_nationality,
    tracks: Object.values(e.tracks || {})
      .map(t => {
        const base = { id: t.id, uri: t.uri, title: t.title, artist: t.artist, art: t.art, votes: t.votes, played: !!t.played, addedAt: t.addedAt || 0 };
        // Requester names are private to the host — only attach in host view.
        if (hostView) base.requesters = (t.requesters || []).map(r => ({ name: r.name, nationality: r.nationality }));
        return base;
      })
      .sort((a, b) => b.votes - a.votes),
  };
}
// Compact shape for the host's event list.
function summaryEvent(e) {
  const closed = e.locked || (e.deadline && Date.now() > e.deadline);
  const tracks = Object.values(e.tracks || {});
  return {
    id: e.id, name: e.name, type: e.type, host: e.host,
    locked: !!e.locked, closed: !!closed, archived: !!e.archived,
    songCount: tracks.length,
    voteCount: tracks.reduce((s, t) => s + t.votes, 0),
    createdAt: e.created_at,
  };
}

/* =========================================================
   COMPLIMENTARY & DISCOUNT CODES
   ---------------------------------------------------------
   - Comp codes grant a free plan (pro/studio) for N months or forever.
   - Discount codes are backed by a Stripe coupon + promotion code, so the
     discount is applied automatically at checkout and Stripe tracks it.
   Admins (ADMIN_EMAILS) create/list/disable; any signed-in user redeems.
   ========================================================= */
function genCode(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

// --- admin: create a code ---
app.post('/api/admin/codes', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const kind = body.kind === 'discount' ? 'discount' : 'comp';
  const code = (body.code && String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '')) || genCode();
  if (db.getCode(code)) return res.status(409).json({ error: 'That code already exists. Try another.' });

  const max_uses = body.maxUses ? parseInt(body.maxUses, 10) : null;
  const expires_at = body.expiresInDays ? Date.now() + parseInt(body.expiresInDays, 10) * 864e5 : null;
  const note = (body.note || '').slice(0, 120);
  const base = { code, kind, plan: null, months: null, discount_kind: null, discount_val: null,
                 stripe_promo: null, max_uses, expires_at, note, created_at: Date.now() };

  try {
    if (kind === 'comp') {
      const plan = ['pro', 'studio'].includes(body.plan) ? body.plan : null;
      if (!plan) return res.status(400).json({ error: 'Choose a plan (pro or studio) for a comp code.' });
      base.plan = plan;
      base.months = body.months ? parseInt(body.months, 10) : null; // null = forever
    } else {
      // discount: build a Stripe coupon + promotion code
      if (!stripe) return res.status(503).json({ error: 'Discount codes need Stripe configured.' });
      const dkind = body.discountKind === 'amount' ? 'amount' : 'percent';
      const dval = parseInt(body.discountVal, 10);
      if (!dval || dval <= 0) return res.status(400).json({ error: 'Enter a discount value.' });
      const coupon = await stripe.coupons.create(
        dkind === 'percent'
          ? { percent_off: Math.min(dval, 100), duration: 'once', name: note || `Spinlist ${dval}% off` }
          : { amount_off: dval, currency: (process.env.CURRENCY || 'gbp'), duration: 'once', name: note || `Spinlist discount` }
      );
      const promo = await stripe.promotionCodes.create({
        coupon: coupon.id, code,
        max_redemptions: max_uses || undefined,
        expires_at: expires_at ? Math.floor(expires_at / 1000) : undefined,
      });
      base.discount_kind = dkind;
      base.discount_val = dval;
      base.stripe_promo = promo.id;
    }
    res.json({ code: db.createCode(base) });
  } catch (err) {
    console.error('create code error:', err.message);
    res.status(500).json({ error: 'Could not create code: ' + err.message });
  }
});

// --- admin: list codes ---
app.get('/api/admin/codes', requireAdmin, (_req, res) => {
  res.json({ codes: db.listCodes() });
});

// --- admin: list all registered hosts + their subscription status ---
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const now = Date.now();
  const users = db.listAllUsers().map(u => {
    // Classify the account's billing status.
    let status = 'free';            // signed up, no plan
    if (u.plan && u.plan !== 'none') {
      if (u.sub_status === 'comp') {
        status = (u.comp_until && now > u.comp_until) ? 'free' : 'comp';
      } else if (u.sub_status === 'active' || u.stripe_sub) {
        status = 'paying';
      } else {
        status = 'active';          // has a plan, non-Stripe (e.g. legacy/manual)
      }
    }
    const planName = (PLANS[u.plan] && PLANS[u.plan].name) || 'None';
    return {
      email: u.email,
      name: u.name || '',
      plan: u.plan || 'none',
      planName,
      status,                       // 'paying' | 'comp' | 'active' | 'free'
      compUntil: u.comp_until || null,
      compCode: u.comp_code || null,
      eventsCreated: db.listEventsByHost(u.id).length,
      isAdmin: ADMIN_EMAILS.includes(u.email.toLowerCase()),
      createdAt: u.created_at || null,
    };
  });
  const summary = {
    total: users.length,
    paying: users.filter(u => u.status === 'paying').length,
    comp: users.filter(u => u.status === 'comp').length,
    free: users.filter(u => u.status === 'free' || u.status === 'active').length,
  };
  res.json({ users, summary });
});

// --- admin: enable/disable a code ---
app.post('/api/admin/codes/:code/toggle', requireAdmin, (req, res) => {
  const c = db.getCode(req.params.code);
  if (!c) return res.status(404).json({ error: 'No such code.' });
  db.setCodeActive(c.code, !c.active);
  res.json({ code: db.getCode(c.code) });
});

// --- user: redeem a code ---
app.post('/api/redeem', auth.requireAuth, (req, res) => {
  const c = db.getCode((req.body || {}).code);
  if (!c || !c.active) return res.status(404).json({ error: 'That code is not valid.' });
  if (c.expires_at && Date.now() > c.expires_at) return res.status(410).json({ error: 'That code has expired.' });
  if (c.max_uses !== null && c.uses >= c.max_uses) return res.status(409).json({ error: 'That code has been fully used.' });
  if (db.hasRedeemed(c.code, req.user.id)) return res.status(409).json({ error: 'You have already redeemed this code.' });

  if (c.kind === 'comp') {
    const compUntil = c.months ? Date.now() + c.months * 30 * 864e5 : null; // null = forever
    db.grantComp(req.user.id, { plan: c.plan, comp_until: compUntil, comp_code: c.code });
    db.incrementCodeUses(c.code);
    db.recordRedemption({ id: auth.newId(), code: c.code, user_id: req.user.id, redeemed_at: Date.now() });
    return res.json({
      type: 'comp',
      plan: c.plan,
      until: compUntil,
      message: `Complimentary ${c.plan.toUpperCase()} access unlocked${c.months ? ` for ${c.months} month(s)` : ' — no expiry'}.`,
    });
  }

  // discount: don't consume here — Stripe records the redemption at checkout.
  // We just tell the front-end the code is valid and to use it at checkout.
  return res.json({
    type: 'discount',
    code: c.code,
    discountKind: c.discount_kind,
    discountVal: c.discount_val,
    message: 'Discount code accepted — it will be applied at checkout.',
  });
});
/* =========================================================
   HOST BRANDING (Pro & Studio) — logo, accent colour, tagline
   ========================================================= */
function planHasBranding(user) {
  return !!(PLANS[user.plan] && PLANS[user.plan].branding);
}
const HEX = /^#[0-9a-fA-F]{6}$/;

// Save branding. Logo is optional on each save (colour/tagline can change alone).
app.post('/api/branding', auth.requireAuth, (req, res) => {
  if (!planHasBranding(req.user)) {
    return res.status(403).json({ error: 'Custom branding is available on the Pro and Studio plans.', upgrade: true });
  }
  // Run multer only for this request so non-Pro hosts never write files.
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const color = (req.body.color || '').trim();
    const tagline = (req.body.tagline || '').trim().slice(0, 80);
    if (color && !HEX.test(color)) return res.status(400).json({ error: 'Colour must be a hex value like #1d4ed8.' });

    const current = db.getBranding(req.user.id) || {};
    let logoPath = current.logo || null;

    if (req.file) {
      // delete the previous logo file if we're replacing it
      if (current.logo) safeUnlink(current.logo);
      logoPath = '/uploads/' + req.file.filename;
    }

    db.setBranding(req.user.id, { logo: logoPath, color: color || null, tagline: tagline || null });
    res.json({ branding: db.getBranding(req.user.id) });
  });
});

// Clear branding (and remove the logo file).
app.delete('/api/branding', auth.requireAuth, (req, res) => {
  const current = db.getBranding(req.user.id);
  if (current?.logo) safeUnlink(current.logo);
  db.setBranding(req.user.id, { logo: null, color: null, tagline: null });
  res.json({ branding: { logo: null, color: null, tagline: null } });
});

// Public: the guest voting page fetches the host's branding by event host id.
// Only returns branding if that host's plan still includes it.
app.get('/api/branding/:userId', (req, res) => {
  const u = db.getUserById(req.params.userId);
  if (!u || !planHasBranding(u)) return res.json({ branding: null });
  res.json({ branding: db.getBranding(u.id) });
});

function safeUnlink(publicPath) {
  try {
    // stored paths look like "/uploads/<filename>" — resolve to the real dir
    const filename = path.basename(publicPath || '');
    if (!filename) return;
    const f = path.join(UPLOAD_DIR, filename);
    if (f.startsWith(UPLOAD_DIR) && fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) { /* ignore */ }
}

/* =========================================================
   SPOTIFY SEARCH PROXY (unchanged)
   ========================================================= */
let cachedToken = null;
async function getAppToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) return cachedToken.value;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!r.ok) throw new Error(`Token request failed (${r.status})`);
  const data = await r.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ tracks: [] });
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 10); // Spotify caps at 10
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const token = await getAppToken();
    const url = new URL('https://api.spotify.com/v1/search');
    url.searchParams.set('q', q);
    url.searchParams.set('type', 'track');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('market', SPOTIFY_MARKET);
    let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) { cachedToken = null; const t2 = await getAppToken(); r = await fetch(url, { headers: { Authorization: `Bearer ${t2}` } }); }
    if (!r.ok) return res.status(r.status).json({ error: 'Spotify search failed' });
    res.json(shapeResults(await r.json()));
  } catch (err) {
    console.error('search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});
function shapeResults(json) {
  const items = json?.tracks?.items || [];
  return {
    tracks: items.map(t => ({
      id: t.id, uri: t.uri, title: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      album: t.album?.name || '',
      art: t.album?.images?.slice(-1)[0]?.url || '',
      durationMs: t.duration_ms, explicit: t.explicit,
    })),
    next: json?.tracks?.next || null,
  };
}

/* ---------- helpers + static ---------- */
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, plan: u.plan, sub_status: u.sub_status };
}
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, stripe: !!stripe }));

/* ----------------------------------------------------------------
   Startup mode.
   - Normal server (VPS, Render, local): call app.listen().
   - cPanel / Phusion Passenger: Passenger manages the port itself
     and CRASHES if we call app.listen(), so we export the app and
     let Passenger serve it. We detect Passenger via its env markers.
---------------------------------------------------------------- */
const underPassenger = !!(process.env.PASSENGER_BASE_URI || process.env.PASSENGER_APP_ENV ||
  (typeof PhusionPassenger !== 'undefined'));

if (underPassenger) {
  module.exports = app;
} else {
  app.listen(PORT, () => console.log(`\n  Spinlist running → ${BASE_URL}\n`));
}
