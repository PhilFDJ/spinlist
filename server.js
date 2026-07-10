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

/* Site-level Resend for the public contact form (separate from subscribers'
   own Resend keys used for wedding invites). Set these in the environment:
     CONTACT_RESEND_KEY   — a Resend API key for the Spinlist account
     CONTACT_FROM         — verified from address, e.g. "hello@spinlist.co.uk"
     CONTACT_FROM_NAME    — optional display name, e.g. "Spinlist"
     CONTACT_TO           — where messages land, e.g. "phil@phil-freeman.co.uk"
   If CONTACT_RESEND_KEY or CONTACT_TO is missing, the contact form falls back
   to telling the user to email directly. */
const CONTACT_RESEND_KEY = process.env.CONTACT_RESEND_KEY || '';
const CONTACT_FROM = process.env.CONTACT_FROM || '';
const CONTACT_FROM_NAME = process.env.CONTACT_FROM_NAME || 'Spinlist';
const CONTACT_TO = process.env.CONTACT_TO || (process.env.ADMIN_EMAILS || '').split(',')[0].trim();

// Escape user-supplied text before putting it into an HTML email.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


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

/* Apple Music — optional fallback search source. Used only when Spotify
   returns 429 (rate limited), so guests never see a dead search at busy
   events. Catalogue search needs just a developer token, which we sign
   ourselves from your MusicKit private key. Set in the environment:
     APPLE_MUSIC_KEY        — contents of the .p8 private key file
                              (the whole -----BEGIN PRIVATE KEY----- block)
     APPLE_MUSIC_KEY_ID     — the 10-char Key ID (from the .p8 filename)
     APPLE_MUSIC_TEAM_ID    — your Apple Team ID (defaults to the app one)
     APPLE_MUSIC_STOREFRONT — catalogue storefront, defaults to 'gb'
   If APPLE_MUSIC_KEY / APPLE_MUSIC_KEY_ID are absent, the fallback is simply
   inactive and Spotify behaves exactly as before. */
function normalizeApplePem(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Unwrap escaping layers in order, because a value can arrive double-escaped
  // depending on how it was pasted/stored:
  //   \\n (backslash backslash n) -> real newline
  //   \n  (backslash n)           -> real newline
  //   \r  variants                -> dropped
  s = s.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '');
  const beginRe = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  const endRe = /-----END [A-Z ]*PRIVATE KEY-----/;
  const begin = (s.match(beginRe) || [])[0];
  const end = (s.match(endRe) || [])[0];
  if (begin && end) {
    // Rebuild a clean PEM from just the base64 body, so it decodes no matter
    // how the whitespace/escaping arrived.
    let body = s.slice(s.indexOf(begin) + begin.length, s.indexOf(end));
    body = body.replace(/\s+/g, '').replace(/\\/g, ''); // strip whitespace + stray backslashes
    const wrapped = body.match(/.{1,64}/g) || [];
    return `${begin}\n${wrapped.join('\n')}\n${end}\n`;
  }
  // No recognisable header/footer — return as-is and let it fail loudly.
  return s;
}
const APPLE_MUSIC_KEY = normalizeApplePem(process.env.APPLE_MUSIC_KEY || '');
const APPLE_MUSIC_KEY_ID = (process.env.APPLE_MUSIC_KEY_ID || '').trim();
const APPLE_MUSIC_TEAM_ID = (process.env.APPLE_MUSIC_TEAM_ID || process.env.APPLE_TEAM_ID || '3LVYMTC2X7').trim();
const APPLE_MUSIC_STOREFRONT = (process.env.APPLE_MUSIC_STOREFRONT || 'gb').toLowerCase().trim();
const APPLE_MUSIC_ENABLED = !!(APPLE_MUSIC_KEY && APPLE_MUSIC_KEY_ID);

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
app.use(express.json({ limit: '25mb' }));
app.use(auth.attachUser);

/* =========================================================
   AUTH ROUTES
   ========================================================= */
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name, weddingCode } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  // If a wedding code is supplied, this is a couple joining their DJ's wedding.
  let wedding = null;
  if (weddingCode) {
    wedding = db.getWeddingByCode(String(weddingCode).trim());
    if (!wedding) return res.status(404).json({ error: 'That wedding code wasn\'t found. Check it with your DJ.' });
  }

  const user = db.createUser({
    id: auth.newId(),
    email: email.toLowerCase(),
    password_hash: auth.hashPassword(password),
    name: name || '',
    role: wedding ? 'couple' : 'host',
    created_at: Date.now(),
  });
  if (wedding) db.linkCoupleToWedding(wedding.id, user.id);
  const token = auth.startSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
  res.json({ user: publicUser(user), wedding: wedding ? { id: wedding.id } : null });
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
    eventsLifetime: db.countEventsLifetime(req.user.id),
    branding: db.getBranding(req.user.id),
    isAdmin: isAdmin(req.user),
    compUntil: req.user.comp_until || null,
  });
});

app.get('/api/plans', (_req, res) => res.json({ plans: PLANS }));

/* Public contact form → emails us via the site Resend account.
   Rate-limited lightly per-IP to deter abuse. No login required. */
const contactHits = new Map();   // ip -> [timestamps]
function contactRateOk(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;      // 10 minutes
  const max = 5;                        // 5 messages per window
  const arr = (contactHits.get(ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  contactHits.set(ip, arr);
  return true;
}

app.get('/api/contact/status', (_req, res) => {
  res.json({ enabled: !!(CONTACT_RESEND_KEY && CONTACT_FROM && CONTACT_TO) });
});

app.post('/api/contact', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const email = String((req.body && req.body.email) || '').trim().slice(0, 120);
    const message = String((req.body && req.body.message) || '').trim().slice(0, 3000);

    if (!message) return res.status(400).json({ error: 'Please enter a message.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'That email address doesn\'t look right.' });
    }
    // Honeypot: bots fill hidden fields. If present, pretend success and drop it.
    if (req.body && req.body.website) return res.json({ ok: true });

    if (!(CONTACT_RESEND_KEY && CONTACT_FROM && CONTACT_TO)) {
      return res.status(503).json({ error: 'unconfigured' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!contactRateOk(ip)) {
      return res.status(429).json({ error: 'You\'ve sent a few messages already — please try again a little later.' });
    }

    const html =
      `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;line-height:1.5">` +
      `<p><b>New Spinlist contact message</b></p>` +
      `<p><b>Name:</b> ${escapeHtml(name || '(not given)')}<br>` +
      `<b>Email:</b> ${escapeHtml(email || '(not given)')}</p>` +
      `<p style="white-space:pre-wrap;border-left:3px solid #c6f24e;padding-left:12px">${escapeHtml(message)}</p>` +
      `</div>`;

    const result = await sendViaResend(
      { apiKey: CONTACT_RESEND_KEY, from: CONTACT_FROM, fromName: CONTACT_FROM_NAME },
      {
        to: CONTACT_TO,
        subject: `Spinlist contact: ${name || email || 'message'}`.slice(0, 120),
        html,
        replyTo: email || undefined,
      }
    );
    if (!result.ok) return res.status(502).json({ error: 'Could not send right now. Please try again, or email us directly.' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong. Please email us directly.' });
  }
});


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
      // Only drop access if the deleted subscription is the one currently on
      // file. When a user upgrades/downgrades, an OLD subscription can be
      // deleted while a NEW active one exists — deleting the old must not wipe
      // the new plan.
      if (user && (!user.stripe_sub || user.stripe_sub === sub.id)) {
        db.setPlan(user.id, { plan: 'none', sub_status: 'canceled', stripe_sub: null });
      }
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
  // Sub-DJs can only run assigned jobs, not create their own.
  if (req.user.role === 'subdj') {
    return res.status(403).json({ error: 'Your account can run assigned events but not create new ones.' });
  }
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

  // Free trial: lifetime cap on total events ever created.
  if (plan.maxEventsLifetime != null) {
    const everCreated = db.countEventsLifetime(req.user.id);
    if (everCreated >= plan.maxEventsLifetime) {
      return res.status(403).json({
        error: `Your free trial includes ${plan.maxEventsLifetime} events. Subscribe to keep creating events.`,
        upgrade: true, trialEnded: true,
      });
    }
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
    event_date: b.eventDate ? Number(b.eventDate) : null,
    locked: false,
    ask_name: !!b.askName,
    ask_nationality: !!b.askNationality,
    // Use the host's preferred search source, but only honour 'apple' when
    // Apple Music is actually configured on the server.
    search_source: (APPLE_MUSIC_ENABLED && req.user.search_source === 'apple') ? 'apple' : 'spotify',
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
  // Wedding live-requests events never show as standalone events (planner-only).
  const liveIds = new Set(db.allWeddingLiveEventIds());

  // Sub-DJs (managed accounts) see only the events assigned to them.
  if (req.user.role === 'subdj') {
    const events = db.listEventsAssignedTo(req.user.id)
      .filter(e => !liveIds.has(e.id))
      .map(e => Object.assign(summaryEvent(e), { assignedToMe: true }));
    return res.json({ events });
  }
  // Regular hosts: their own events PLUS any assigned to them — both with
  // wedding live-events filtered out.
  const own = db.listEventsByHost(req.user.id)
    .filter(e => !liveIds.has(e.id))
    .map(summaryEvent);
  const assigned = db.listEventsAssignedTo(req.user.id)
    .filter(e => e.host_id !== req.user.id && !liveIds.has(e.id))
    .map(e => Object.assign(summaryEvent(e), { assignedToMe: true }));
  res.json({ events: [...own, ...assigned] });
});

/* =========================================================
   CALENDAR FEED (iCal / .ics) — DJs subscribe to their gigs
   ========================================================= */

// Escape text for iCal per RFC 5545 (commas, semicolons, backslashes, newlines).
function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
// Format a timestamp (ms) as an all-day iCal date (YYYYMMDD) in local terms.
function icsDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function icsStamp(ms) {
  // UTC timestamp for DTSTAMP: YYYYMMDDTHHMMSSZ
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
// Fold long lines to 75 octets per RFC 5545.
function icsFold(line) {
  if (line.length <= 73) return line;
  const parts = [];
  let s = line;
  parts.push(s.slice(0, 73));
  s = s.slice(73);
  while (s.length) { parts.push(' ' + s.slice(0, 72)); s = s.slice(72); }
  return parts.join('\r\n');
}

// Build the full iCal document for a given DJ (their own + assigned gigs).
function buildCalendarForUser(user) {
  const isSub = user.role === 'subdj';
  const liveIds = new Set(db.allWeddingLiveEventIds());

  // Collect events: own + assigned (sub-DJs get assigned only).
  let events = [];
  if (isSub) {
    events = db.listEventsAssignedTo(user.id);
  } else {
    events = db.listEventsByHost(user.id)
      .concat(db.listEventsAssignedTo(user.id).filter(e => e.host_id !== user.id));
  }
  events = events.filter(e => !liveIds.has(e.id) && !e.archived && e.event_date);

  // Collect weddings similarly.
  let weddings = [];
  if (isSub) {
    weddings = db.listWeddingsAssignedTo(user.id);
  } else {
    weddings = db.listWeddingsByHost(user.id)
      .concat(db.listWeddingsAssignedTo(user.id).filter(w => w.host_id !== user.id));
  }
  weddings = weddings.filter(w => !w.archived && w.wedding_date);

  const now = Date.now();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Spinlist//DJ Diary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Spinlist Gigs',
    'X-WR-CALDESC:Your Spinlist events and weddings',
  ];

  const pushEvent = (uid, dateMs, title, desc) => {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}@spinlist.co.uk`);
    lines.push(`DTSTAMP:${icsStamp(now)}`);
    // All-day event: DTSTART date-only, DTEND next day.
    lines.push(`DTSTART;VALUE=DATE:${icsDate(dateMs)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(dateMs + 86400000)}`);
    lines.push(icsFold(`SUMMARY:${icsEscape(title)}`));
    if (desc) lines.push(icsFold(`DESCRIPTION:${icsEscape(desc)}`));
    lines.push('END:VEVENT');
  };

  for (const e of events) {
    const label = e.assigned_dj === user.id && e.host_id !== user.id ? ' (assigned)' : '';
    pushEvent(`event-${e.id}`, e.event_date,
      `${e.name || 'Event'}${label}`,
      `${e.type || 'Event'} · Spinlist\nhttps://www.spinlist.co.uk/`);
  }
  for (const w of weddings) {
    const label = w.assigned_dj === user.id && w.host_id !== user.id ? ' (assigned)' : '';
    const who = w.couple_names ? ` — ${w.couple_names}` : '';
    pushEvent(`wedding-${w.id}`, w.wedding_date,
      `${w.name || 'Wedding'}${who}${label}`,
      `Wedding · Spinlist\nhttps://www.spinlist.co.uk/`);
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Public iCal feed. Uses a private token in the URL (calendar apps aren't
// logged in), so the token must be unguessable and can be reset by the DJ.
app.get('/calendar/:token.ics', (req, res) => {
  const user = db.getUserByCalToken(req.params.token);
  if (!user) return res.status(404).type('text/plain').send('Calendar not found.');
  const ics = buildCalendarForUser(user);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="spinlist.ics"');
  res.set('Cache-Control', 'public, max-age=3600');   // calendar apps re-poll
  res.send(ics);
});

// Authenticated: get (creating if needed) this DJ's calendar feed URL.
app.get('/api/calendar/url', auth.requireAuth, (req, res) => {
  const token = db.getOrCreateCalToken(req.user.id);
  if (!token) return res.status(500).json({ error: 'Could not create calendar link.' });
  res.json({ url: `${BASE_URL}/calendar/${token}.ics` });
});

// Authenticated: reset the token (invalidates the old feed URL everywhere).
app.post('/api/calendar/reset', auth.requireAuth, (req, res) => {
  const token = db.resetCalToken(req.user.id);
  if (!token) return res.status(500).json({ error: 'Could not reset calendar link.' });
  res.json({ url: `${BASE_URL}/calendar/${token}.ics` });
});

// --- get one event (PUBLIC — guests load this by id) ---
app.get('/api/events/:id', (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  // include host branding if their plan allows it
  let branding = null;
  const host = db.getUserById(e.host_id);
  if (host && planHasBranding(host)) branding = db.getBranding(host.id);
  // The host (or assigned sub-DJ) sees requester names; guests do not.
  const isHost = req.user && canAccessEvent(req.user, e);
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

app.post('/api/weddings/:id/archive', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (w.host_id !== req.user.id) return res.status(403).json({ error: 'Not your wedding.' });
  const archived = !!(req.body || {}).archived;
  db.setWeddingArchived(w.id, archived);
  // Keep the linked live-requests event in sync so it doesn't linger on My Events.
  if (w.live_event_id && db.getEvent(w.live_event_id)) {
    db.setArchived(w.live_event_id, archived);
  }
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
  if (b.eventDate !== undefined) fields.event_date = b.eventDate ? Number(b.eventDate) : null;
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

// --- mark a song played / unplayed (host or assigned sub-DJ) ---
app.post('/api/events/:id/played', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (!canAccessEvent(req.user, e)) return res.status(403).json({ error: 'Not your event.' });
  const b = req.body || {};
  if (!b.trackId) return res.status(400).json({ error: 'trackId required.' });
  const updated = db.setPlayed(e.id, b.trackId, !!b.played);
  res.json({ event: publicEvent(updated) });
});

// --- host adjusts a song's votes (e.g. knock one off) — host/sub-DJ only ---
app.post('/api/events/:id/adjust-votes', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (!canAccessEvent(req.user, e)) return res.status(403).json({ error: 'Not your event.' });
  const b = req.body || {};
  if (!b.trackId) return res.status(400).json({ error: 'trackId required.' });
  // Only allow small nudges; default -1. Positive allowed too (undo a knock-off).
  let delta = parseInt(b.delta, 10);
  if (!Number.isFinite(delta)) delta = -1;
  delta = Math.max(-100, Math.min(100, delta));
  const updated = db.adjustVotes(e.id, b.trackId, delta);
  res.json({ event: publicEvent(updated, true) });
});

// --- host adds a song directly (guest asked at the booth) — host/sub-DJ only ---
app.post('/api/events/:id/add-song', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (!canAccessEvent(req.user, e)) return res.status(403).json({ error: 'Not your event.' });
  const b = req.body || {};
  const t = b.track;
  if (!t || !t.id || !t.title) return res.status(400).json({ error: 'A song is required.' });
  // How many votes to seed it with (default 1 — as if one person asked).
  let votes = parseInt(b.votes, 10);
  if (!Number.isFinite(votes) || votes < 1) votes = 1;
  votes = Math.min(votes, 999);
  const updated = db.hostAddSong(e.id, {
    id: t.id, uri: t.uri || null, title: t.title, artist: t.artist || '', art: t.art || '',
  }, votes);
  res.json({ event: publicEvent(updated, true) });
});

// --- host removes a song from the leaderboard entirely — host/sub-DJ only ---
app.post('/api/events/:id/remove-track', auth.requireAuth, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (!canAccessEvent(req.user, e)) return res.status(403).json({ error: 'Not your event.' });
  const b = req.body || {};
  if (!b.trackId) return res.status(400).json({ error: 'trackId required.' });
  const updated = db.removeTrack(e.id, b.trackId);
  res.json({ event: publicEvent(updated, true) });
});

// --- cast votes (PUBLIC — guests). body: { add:[track], remove:[trackId] } ---
app.post('/api/events/:id/vote', (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  const closed = e.locked || (e.deadline && Date.now() > e.deadline);
  if (closed) return res.status(403).json({ error: 'Voting is closed for this event.' });
  const b = req.body || {};

  // Enforce the host's per-event guest cap (Pro = 75, Studio = unlimited).
  // The public demo event is always uncapped so anyone can try it.
  const host = db.getUserById(e.host_id);
  const plan = (host && PLANS[host.plan]) || PLANS.none;
  const cap = e.demo ? null : plan.maxGuestsPerEvent;   // null = unlimited
  const guestId = (b.guestId || '').toString().slice(0, 64);
  // Only gate when this guest is ADDING a vote (joining in); removals are fine.
  const wantsToAdd = Array.isArray(b.add) && b.add.length > 0;
  if (guestId && wantsToAdd) {
    const reg = db.registerGuest(e.id, guestId, cap);
    if (!reg.allowed) {
      return res.status(403).json({ error: 'This event has reached its guest limit.', full: true });
    }
  }

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
    votesPer: e.votes_per, deadline: e.deadline, eventDate: e.event_date || null,
    locked: !!e.locked, hostId: e.host_id,
    searchSource: e.search_source === 'apple' ? 'apple' : 'spotify',
    dj: e.assigned_dj ? db.djProfileFor(e.host_id, e.assigned_dj) : null,
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
    eventDate: e.event_date || null,
    assignedDj: e.assigned_dj || null,
    createdAt: e.created_at,
  };
}

/* =========================================================
   WEDDING PLANNER (DJ tier) — song blocks the couple fills in
   ========================================================= */
// Default blocks a DJ starts from (they can customise per wedding).
const DEFAULT_WEDDING_BLOCKS = [
  { name: 'First Dance', capacity: 1 },
  { name: 'Cake Cutting', capacity: 1 },
  { name: "Couple's Top 15", capacity: 15 },
  { name: 'Play If Possible', capacity: 30 },
  { name: 'Last Dance', capacity: 1 },
  { name: 'Do Not Play', capacity: 5 },
];

// Which plans can create wedding plans. (Available to PRO for now.)
function planHasWeddingPlanner(user) {
  const p = PLANS[user.plan];
  return !!(p && p.weddingPlanner);   // PRO WEDDING tier (and free trial)
}
function planIsMultiOp(user) {
  const p = PLANS[user.plan];
  return !!(p && p.multiOp);          // PRO WEDDING MULTI-OP
}
// True if the user owns this event, or it's assigned to them (sub-DJ or linked DJ).
function canAccessEvent(user, e) {
  if (!e) return false;
  if (e.host_id === user.id) return true;
  if (e.assigned_dj === user.id) return true;
  // If this is a wedding's live-requests event, inherit access from that wedding
  // (so whoever can run the wedding can also manage its live requests).
  const w = db.getWeddingByLiveEvent && db.getWeddingByLiveEvent(e.id);
  if (w && canAccessWedding(user, w)) return true;
  return false;
}
// True if the user owns this wedding, the linked couple, or it's assigned to them.
function canAccessWedding(user, w) {
  if (!w) return false;
  if (w.host_id === user.id || w.couple_id === user.id) return true;
  if (w.assigned_dj === user.id) return true;
  return false;
}
// Resolve the effective couple lock date for a wedding:
//   - a positive timestamp  → explicit date the DJ set
//   - 0                     → DJ explicitly cleared it (no lock)
//   - null/undefined        → default to 14 days before the wedding date (if any)
const LOCK_DEFAULT_DAYS = 14;
function effectiveLockDate(w) {
  if (!w) return null;
  if (typeof w.lock_date === 'number') return w.lock_date === 0 ? null : w.lock_date;
  if (w.wedding_date) return w.wedding_date - LOCK_DEFAULT_DAYS * 864e5;
  return null;
}
// True if the couple's editing is locked (the effective lock date has passed). The
// DJ/host is never locked out — they can still adjust after the couple's deadline.
function coupleEditLocked(w, userId) {
  const lock = effectiveLockDate(w);
  if (!lock) return false;
  if (userId === w.host_id || userId === w.assigned_dj) return false;  // DJ always edits
  return Date.now() > lock;
}
// Fire a notification to the wedding's DJ when the COUPLE makes a change.
function notifyCoupleActivity(w, actor, type, text) {
  if (!w || !actor) return;
  if (actor.id !== w.couple_id) return;          // only couple actions notify
  const label = w.couple_names || w.name || 'A couple';
  const msg = `${label}: ${text}`;
  // Notify the owner, and also the assigned sub-DJ (if any and different), so
  // whoever is actually running the wedding hears about the couple's changes.
  db.addNotification(w.host_id, { type, weddingId: w.id, weddingName: w.name || '', text: msg });
  if (w.assigned_dj && w.assigned_dj !== w.host_id) {
    db.addNotification(w.assigned_dj, { type, weddingId: w.id, weddingName: w.name || '', text: msg });
  }
}

// Notify a DJ that they've been assigned an event or wedding.
function notifyAssignment(djId, kind, id, name, dateMs) {
  if (!djId) return;
  const when = dateMs ? ` (${new Date(dateMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})` : '';
  const text = kind === 'wedding'
    ? `You've been assigned a wedding: ${name}${when}`
    : `You've been assigned an event: ${name}${when}`;
  // weddingId carries the record id (event or wedding) for de-dupe + linking.
  db.addNotification(djId, { type: 'assignment', weddingId: id, weddingName: name, text });
}
// Sub-DJ inherits planner access from their parent owner (so they can open weddings).
function userHasPlannerAccess(user) {
  if (user.role === 'subdj' && user.parent_id) {
    const parent = db.getUserById(user.parent_id);
    return !!(parent && planHasWeddingPlanner(parent));
  }
  return planHasWeddingPlanner(user);
}

// Prep (music library + playlist export) is available to every logged-in DJ EXCEPT
// Basic (internal id 'pro'), since Basic can't export playlists. Sub-DJs inherit from
// their parent's plan. 'couple' role never gets Prep.
function userHasPrepAccess(user) {
  if (!user) return false;
  if (user.role === 'couple') return false;
  let planId = user.plan;
  if (user.role === 'subdj' && user.parent_id) {
    const parent = db.getUserById(user.parent_id);
    planId = parent ? parent.plan : user.plan;
  }
  return planId !== 'pro';   // everyone except Basic
}

// Return the wedding's questionnaire with gig-window flags resolved LIVE from
// templates (matched per-question by label). We consider BOTH the wedding owner's
// templates AND the current viewer's templates, so a sub-DJ or co-DJ who ticked
// their own copy still gets the flags. Any template flagging a label wins.
function questionnaireWithGigFlags(w, viewerId) {
  const q = w.questionnaire;
  if (!q || !Array.isArray(q.questions)) return q || null;
  const owners = [w.host_id];
  if (viewerId && viewerId !== w.host_id) owners.push(viewerId);
  // Also include the viewer's parent owner if they're a sub-DJ.
  const viewer = viewerId ? db.getUserById(viewerId) : null;
  if (viewer && viewer.role === 'subdj' && viewer.parent_id) owners.push(viewer.parent_id);
  const flagByLabel = {};
  owners.forEach(oid => (db.listTemplates(oid) || []).forEach(t => (t.questions || []).forEach(tq => {
    if (tq.label) { const k = tq.label.trim().toLowerCase(); if (tq.gigShow) flagByLabel[k] = true; else if (!(k in flagByLabel)) flagByLabel[k] = false; }
  })));
  return {
    name: q.name,
    questions: q.questions.map(qq => {
      const k = (qq.label || '').trim().toLowerCase();
      const live = flagByLabel[k] === true ? true : (k in flagByLabel ? false : !!qq.gigShow);
      return Object.assign({}, qq, { gigShow: live });
    }),
  };
}

function publicWedding(w, viewerId) {
  if (!w) return null;
  const isHost = viewerId && viewerId === w.host_id;
  const isCouple = viewerId && viewerId === w.couple_id;
  const liveEv = w.live_event_id ? db.getEvent(w.live_event_id) : null;
  return {
    id: w.id, name: w.name, coupleNames: w.couple_names, weddingDate: w.wedding_date,
    inviteCode: (isHost ? w.invite_code : undefined),   // only the DJ sees the code
    coupleJoined: !!w.couple_id,
    blocks: (w.blocks || []).map(b => ({ id: b.id, name: b.name, capacity: b.capacity, songs: (b.songs || []).map(s => ({ id: s.id, uri: s.uri, title: s.title, artist: s.artist, art: s.art, played: s.played ? 1 : 0 })) })),
    timeline: (w.timeline || []).map(t => ({ id: t.id, time: t.time, label: t.label })),
    questionnaire: questionnaireWithGigFlags(w, viewerId),
    answers: w.answers || {},
    liveBlockId: w.live_block_id || null,
    liveEventId: w.live_event_id || null,
    liveEventCode: w.live_event_id || null,   // event id doubles as the join code
    liveVotesPer: liveEv ? liveEv.votes_per : 5,
    liveAskName: liveEv ? !!liveEv.ask_name : false,
    assignedDj: w.assigned_dj || null,
    dj: db.djProfileFor(w.host_id, w.assigned_dj),
    branding: (() => {
      // The wedding owner's branding (logo/colour/tagline) — for the run-sheet PDF.
      const owner = db.getUserById(w.host_id);
      return (owner && planHasBranding(owner)) ? db.getBranding(owner.id) : null;
    })(),
    canExportSpotify: (() => {
      // DJ (host or assigned) can export if they — or the wedding owner — have Spotify.
      const viewer = db.getUserById(viewerId);
      if (!viewer) return false;
      if (viewer.id !== w.host_id && w.assigned_dj !== viewer.id) return false;
      const vp = PLANS[viewer.plan];
      if ((vp && vp.spotifyExport) || viewer.spotify_export) return true;
      const owner = db.getUserById(w.host_id);
      const op = owner && PLANS[owner.plan];
      return !!((op && op.spotifyExport) || (owner && owner.spotify_export));
    })(),
    lockDate: effectiveLockDate(w),
    lockIsDefault: (typeof w.lock_date !== 'number') && !!w.wedding_date,  // showing the 14-day default
    coupleLocked: coupleEditLocked(w, viewerId),   // true only for a locked-out couple
    canEdit: !!((isHost || isCouple) && !coupleEditLocked(w, viewerId)),
    createdAt: w.created_at,
  };
}

// DJ: create a wedding plan
app.post('/api/weddings', auth.requireAuth, (req, res) => {
  if (!planHasWeddingPlanner(req.user)) {
    return res.status(403).json({ error: 'The Wedding Planner is a PRO feature.', upgrade: true });
  }
  const b = req.body || {};
  const blocksIn = Array.isArray(b.blocks) && b.blocks.length ? b.blocks : DEFAULT_WEDDING_BLOCKS;
  const blocks = blocksIn.slice(0, 30).map((blk, i) => ({
    id: 'b' + (i + 1) + '_' + auth.newId().slice(0, 4),
    name: (blk.name || 'Block').toString().slice(0, 60),
    capacity: Math.max(1, Math.min(parseInt(blk.capacity, 10) || 1, 100)),
    songs: [],
  }));
  const wedding = db.createWedding({
    id: auth.newId().slice(0, 8),
    host_id: req.user.id,
    invite_code: auth.newId().slice(0, 6).toUpperCase(),
    name: (b.name || 'Wedding').toString().slice(0, 120),
    couple_names: (b.coupleNames || '').toString().slice(0, 120),
    wedding_date: b.weddingDate ? Number(b.weddingDate) : null,
    blocks,
    created_at: Date.now(),
  });
  // Optionally attach a questionnaire template chosen at creation.
  if (b.templateId) {
    const tpl = db.listTemplates(req.user.id).find(t => t.id === b.templateId);
    if (tpl) db.setWeddingQuestionnaire(wedding.id, { name: tpl.name, questions: tpl.questions });
  }
  res.json({ wedding: publicWedding(db.getWedding(wedding.id), req.user.id) });
});

// DJ: list my weddings
app.get('/api/weddings', auth.requireAuth, (req, res) => {
  let source;
  if (req.user.role === 'subdj') {
    source = db.listWeddingsAssignedTo(req.user.id);
  } else {
    // Own weddings + any assigned to me by a multi-op owner.
    const own = db.listWeddingsByHost(req.user.id);
    const assigned = db.listWeddingsAssignedTo(req.user.id).filter(w => w.host_id !== req.user.id);
    source = [...own, ...assigned];
  }
  const list = source.map(w => ({
    id: w.id, name: w.name, coupleNames: w.couple_names, weddingDate: w.wedding_date,
    inviteCode: w.invite_code, coupleJoined: !!w.couple_id,
    blockCount: (w.blocks || []).length,
    filledCount: (w.blocks || []).reduce((s, b) => s + ((b.songs || []).length), 0),
    archived: !!w.archived,
    assignedDj: w.assigned_dj || null,
    assignedToMe: w.assigned_dj === req.user.id && w.host_id !== req.user.id,
    createdAt: w.created_at,
  }));
  res.json({ weddings: list });
});

// Couple: list weddings I'm linked to
app.get('/api/my-weddings', auth.requireAuth, (req, res) => {
  const list = db.listWeddingsByCouple(req.user.id).map(w => publicWedding(w, req.user.id));
  res.json({ weddings: list });
});

// Get one wedding (DJ, its couple, or the assigned sub-DJ)
app.get('/api/weddings/:id', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (!canAccessWedding(req.user, w)) {
    return res.status(403).json({ error: 'Not your wedding plan.' });
  }
  res.json({ wedding: publicWedding(w, req.user.id) });
});

// Save the songs for a block (DJ or couple)
app.post('/api/weddings/:id/block/:blockId', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && req.user.id !== w.couple_id) {
    return res.status(403).json({ error: 'Not your wedding plan.' });
  }
  if (coupleEditLocked(w, req.user.id)) {
    return res.status(423).json({ error: 'Song choices are locked — the deadline set by your DJ has passed. Contact your DJ if you need a change.' });
  }
  const songs = Array.isArray((req.body || {}).songs) ? req.body.songs : [];
  const updated = db.setWeddingBlockSongs(w.id, req.params.blockId, songs);
  const blk = (updated.blocks || []).find(b => b.id === req.params.blockId);
  notifyCoupleActivity(w, req.user, 'songs', `updated songs${blk ? ' in “' + blk.name + '”' : ''}`);
  res.json({ wedding: publicWedding(updated, req.user.id) });
});

// Mark a song played/unplayed (DJ or assigned sub-DJ — used on the day)
app.post('/api/weddings/:id/played', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && w.assigned_dj !== req.user.id) {
    return res.status(403).json({ error: 'Only the DJ can mark songs played.' });
  }
  const b = req.body || {};
  const updated = db.setWeddingSongPlayed(w.id, b.blockId, b.songId, !!b.played);
  res.json({ wedding: publicWedding(updated, req.user.id) });
});

// DJ (or assigned sub-DJ): create (or return existing) a live-requests event linked to this wedding.
app.post('/api/weddings/:id/live-event', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && w.assigned_dj !== req.user.id) {
    return res.status(403).json({ error: 'Only the DJ can do this.' });
  }
  // If one already exists and is still valid, just return it.
  if (w.live_event_id && db.getEvent(w.live_event_id)) {
    return res.json({ wedding: publicWedding(w, req.user.id), eventId: w.live_event_id });
  }
  const id = auth.newId().slice(0, 6).toUpperCase();
  // The live event is always owned by the wedding's host (the account owner),
  // so it stays linked correctly even when a sub-DJ opens it.
  db.recordEvent(id, w.host_id);
  // Keep requests open through the wedding day: deadline = end of the wedding date
  // (23:59). If no date is set, leave it open indefinitely (null).
  let liveDeadline = null;
  if (w.wedding_date) {
    const d = new Date(w.wedding_date);
    d.setHours(23, 59, 59, 999);
    liveDeadline = d.getTime();
  }
  const bb = req.body || {};
  db.createEvent({
    id,
    host_id: w.host_id,
    name: (w.name || 'Wedding') + ' — Live Requests',
    type: 'Wedding',
    host: req.user.name || 'Your DJ',
    votes_per: Math.max(1, Math.min(parseInt(bb.votesPer, 10) || 5, 999)),
    deadline: liveDeadline,
    event_date: w.wedding_date || null,
    locked: false,
    ask_name: !!bb.askName,
    ask_nationality: false,
    created_at: Date.now(),
  });
  // Assign the live event to whoever is running the wedding, so it shows for them too.
  if (w.assigned_dj) db.assignEventDj(id, w.assigned_dj);
  db.setWeddingLiveEvent(w.id, id);
  res.json({ wedding: publicWedding(db.getWedding(w.id), req.user.id), eventId: id });
});

// Couple or DJ: set which block is in live guest-requests mode (or clear it).
app.post('/api/weddings/:id/live-block', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && req.user.id !== w.couple_id) {
    return res.status(403).json({ error: 'Not your wedding plan.' });
  }
  const blockId = (req.body || {}).blockId || null;
  if (blockId) {
    const block = (w.blocks || []).find(b => b.id === blockId);
    if (!block || !/play if possible/i.test(block.name || '')) {
      return res.status(400).json({ error: 'Only the "Play If Possible" block can be set to live requests.' });
    }
  }
  const updated = db.setWeddingLiveBlock(w.id, blockId);
  res.json({ wedding: publicWedding(updated, req.user.id) });
});

// Anyone viewing the plan: live leaderboard from the linked event (auto-refresh source).
app.get('/api/weddings/:id/live-leaderboard', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (!canAccessWedding(req.user, w)) {
    return res.status(403).json({ error: 'Not your wedding plan.' });
  }
  if (!w.live_event_id) return res.json({ songs: [], eventId: null });
  const ev = db.getEvent(w.live_event_id);
  if (!ev) return res.json({ songs: [], eventId: null });
  // The DJ (host) and the assigned sub-DJ see who requested; the couple does not.
  const seesNames = req.user.id === w.host_id || w.assigned_dj === req.user.id;
  const songs = Object.values(ev.tracks || {})
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 50)
    .map(t => {
      const s = { id: t.id, title: t.title, artist: t.artist, art: t.art || '', votes: t.votes, played: t.played ? 1 : 0 };
      if (seesNames) {
        s.requesters = (t.requesters || []).map(r => r.name).filter(Boolean);
      }
      return s;
    });
  res.json({ songs, eventId: w.live_event_id });
});

// DJ: edit wedding details / blocks structure
app.post('/api/weddings/:id/update', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id) return res.status(403).json({ error: 'Only the DJ can edit the structure.' });
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = (b.name || 'Wedding').toString().slice(0, 120);
  if (b.coupleNames !== undefined) fields.couple_names = (b.coupleNames || '').toString().slice(0, 120);
  if (b.weddingDate !== undefined) fields.wedding_date = b.weddingDate ? Number(b.weddingDate) : null;
  if (Array.isArray(b.blocks)) {
    // preserve existing songs when a block id is kept
    fields.blocks = b.blocks.slice(0, 30).map((blk, i) => {
      const existing = (w.blocks || []).find(x => x.id === blk.id);
      return {
        id: blk.id || ('b' + (i + 1) + '_' + auth.newId().slice(0, 4)),
        name: (blk.name || 'Block').toString().slice(0, 60),
        capacity: Math.max(1, Math.min(parseInt(blk.capacity, 10) || 1, 100)),
        songs: existing ? (existing.songs || []).slice(0, Math.max(1, parseInt(blk.capacity, 10) || 1)) : [],
      };
    });
  }
  const updated = db.updateWedding(w.id, fields);
  // If the wedding date changed and a live-requests event is linked, keep its
  // deadline (end of the wedding day) in sync so requests stay open through the day.
  if (b.weddingDate !== undefined && updated.live_event_id) {
    const ev = db.getEvent(updated.live_event_id);
    if (ev) {
      let dl = null;
      if (updated.wedding_date) { const d = new Date(updated.wedding_date); d.setHours(23, 59, 59, 999); dl = d.getTime(); }
      db.updateEvent(ev.id, { deadline: dl });
    }
  }
  // Optionally switch (or remove) the questionnaire template.
  if (b.templateId !== undefined) {
    if (b.templateId) {
      const tpl = db.listTemplates(req.user.id).find(t => t.id === b.templateId);
      if (tpl) db.setWeddingQuestionnaire(w.id, { name: tpl.name, questions: tpl.questions });
    } else {
      db.setWeddingQuestionnaire(w.id, null);
    }
  }
  res.json({ wedding: publicWedding(db.getWedding(w.id), req.user.id) });
});

// Save the timeline (DJ or couple — both can edit)
app.post('/api/weddings/:id/timeline', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && req.user.id !== w.couple_id) {
    return res.status(403).json({ error: 'Not your wedding plan.' });
  }
  if (coupleEditLocked(w, req.user.id)) {
    return res.status(423).json({ error: 'Editing is locked — the deadline set by your DJ has passed. Contact your DJ if you need a change.' });
  }
  const timeline = Array.isArray((req.body || {}).timeline) ? req.body.timeline : [];
  const updated = db.setWeddingTimeline(w.id, timeline);
  notifyCoupleActivity(w, req.user, 'timeline', 'updated the timeline');
  res.json({ wedding: publicWedding(updated, req.user.id) });
});

// ----- Music block templates (DJ) -----
app.get('/api/block-templates', auth.requireAuth, (req, res) => {
  if (!planHasWeddingPlanner(req.user)) return res.status(403).json({ error: 'PRO feature.' });
  res.json({ templates: db.listBlockTemplates(req.user.id) });
});
app.post('/api/block-templates', auth.requireAuth, (req, res) => {
  if (!planHasWeddingPlanner(req.user)) return res.status(403).json({ error: 'PRO feature.' });
  const saved = db.saveBlockTemplate(req.user.id, req.body || {});
  if (saved && saved.error === 'limit') {
    return res.status(400).json({ error: 'You can have up to 5 block templates. Delete one to add another.' });
  }
  res.json({ template: saved });
});
app.delete('/api/block-templates/:id', auth.requireAuth, (req, res) => {
  db.deleteBlockTemplate(req.user.id, req.params.id);
  res.json({ ok: true });
});

// ----- Questionnaire templates (DJ) -----
// List my templates
app.get('/api/q-templates', auth.requireAuth, (req, res) => {
  if (!planHasWeddingPlanner(req.user)) return res.status(403).json({ error: 'PRO feature.' });
  res.json({ templates: db.listTemplates(req.user.id) });
});
// Create / update a template (max 5)
app.post('/api/q-templates', auth.requireAuth, (req, res) => {
  if (!planHasWeddingPlanner(req.user)) return res.status(403).json({ error: 'PRO feature.' });
  const saved = db.saveTemplate(req.user.id, req.body || {});
  if (saved && saved.error === 'limit') {
    return res.status(400).json({ error: 'You can have up to 5 templates. Delete one to add another.' });
  }
  res.json({ template: saved });
});
// Delete a template
app.delete('/api/q-templates/:id', auth.requireAuth, (req, res) => {
  db.deleteTemplate(req.user.id, req.params.id);
  res.json({ ok: true });
});

// Attach a questionnaire to a wedding (DJ) — snapshots the chosen template
app.post('/api/weddings/:id/questionnaire', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id) return res.status(403).json({ error: 'Only the DJ can set the questionnaire.' });
  const b = req.body || {};
  let questionnaire = null;
  if (b.templateId) {
    const tpl = db.listTemplates(req.user.id).find(t => t.id === b.templateId);
    if (!tpl) return res.status(404).json({ error: 'Template not found.' });
    questionnaire = { name: tpl.name, questions: tpl.questions };   // snapshot
  } else if (b.questionnaire === null) {
    questionnaire = null;   // remove
  }
  const updated = db.setWeddingQuestionnaire(w.id, questionnaire);
  res.json({ wedding: publicWedding(updated, req.user.id) });
});

// Save questionnaire answers (couple or DJ)
app.post('/api/weddings/:id/answers', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && req.user.id !== w.couple_id && w.assigned_dj !== req.user.id) {
    return res.status(403).json({ error: 'Not your wedding plan.' });
  }
  if (coupleEditLocked(w, req.user.id)) {
    return res.status(423).json({ error: 'Editing is locked — the deadline set by your DJ has passed. Contact your DJ if you need a change.' });
  }
  const answers = (req.body || {}).answers || {};
  const updated = db.setWeddingAnswers(w.id, answers);
  notifyCoupleActivity(w, req.user, 'answers', 'answered questionnaire questions');
  res.json({ wedding: publicWedding(updated, req.user.id) });
});

// DJ: delete a wedding
app.delete('/api/weddings/:id', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id) return res.status(403).json({ error: 'Not your wedding plan.' });
  db.deleteWedding(w.id);
  res.json({ ok: true });
});


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
  const kind = ['discount', 'addon'].includes(body.kind) ? body.kind : 'comp';
  const code = (body.code && String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '')) || genCode();
  if (db.getCode(code)) return res.status(409).json({ error: 'That code already exists. Try another.' });

  const max_uses = body.maxUses ? parseInt(body.maxUses, 10) : null;
  const expires_at = body.expiresInDays ? Date.now() + parseInt(body.expiresInDays, 10) * 864e5 : null;
  const note = (body.note || '').slice(0, 120);
  const base = { code, kind, plan: null, months: null, discount_kind: null, discount_val: null,
                 stripe_promo: null, max_uses, expires_at, note, created_at: Date.now(),
                 grants_spotify: !!body.grantsSpotify };

  try {
    if (kind === 'comp') {
      const plan = ['pro', 'studio', 'prowedding', 'proweddingmulti'].includes(body.plan) ? body.plan : null;
      if (!plan) return res.status(400).json({ error: 'Choose a plan for a comp code.' });
      base.plan = plan;
      base.months = body.months ? parseInt(body.months, 10) : null; // null = forever
    } else if (kind === 'addon') {
      // Spotify add-on only — no plan change. The subscriber keeps their paid plan.
      base.grants_spotify = true;
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
    if (u.plan === 'trial') {
      // Trial is active until the lifetime event cap is reached.
      const cap = (PLANS.trial && PLANS.trial.maxEventsLifetime) || 2;
      status = db.countEventsLifetime(u.id) >= cap ? 'trial-ended' : 'trial';
    } else if (u.plan && u.plan !== 'none') {
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
      id: u.id,
      email: u.email,
      name: u.name || '',
      plan: u.plan || 'none',
      planName,
      role: u.role || 'host',
      status,                       // 'paying' | 'comp' | 'active' | 'free'
      compUntil: u.comp_until || null,
      compCode: u.comp_code || null,
      // Total events on the account: hosted + assigned (de-duped), plus
      // weddings hosted + assigned. Previously only counted hosted events.
      eventsCreated: (() => {
        const hostedEv = db.listEventsByHost(u.id);
        const assignedEv = db.listEventsAssignedTo(u.id).filter(e => e.host_id !== u.id);
        const hostedWed = db.listWeddingsByHost(u.id);
        const assignedWed = db.listWeddingsAssignedTo(u.id).filter(w => w.host_id !== u.id);
        return hostedEv.length + assignedEv.length + hostedWed.length + assignedWed.length;
      })(),
      isAdmin: ADMIN_EMAILS.includes(u.email.toLowerCase()),
      createdAt: u.created_at || null,
      // For couple accounts: their wedding date + the host DJ who owns the plan.
      couple: (u.role === 'couple') ? (() => {
        const w = db.getWeddingByCouple(u.id);
        if (!w) return null;
        const host = db.getUserById(w.host_id);
        const assigned = w.assigned_dj ? db.getUserById(w.assigned_dj) : null;
        return {
          weddingName: w.name || '',
          weddingDate: w.wedding_date || null,
          coupleNames: w.couple_names || '',
          hostName: (host && host.name) || '',
          hostEmail: (host && host.email) || '',
          assignedName: assigned ? (assigned.name || assigned.email) : '',
          assignedEmail: assigned ? assigned.email : '',
        };
      })() : null,
    };
  });
  const summary = {
    total: users.length,
    paying: users.filter(u => u.status === 'paying').length,
    trial: users.filter(u => u.status === 'trial').length,
    comp: users.filter(u => u.status === 'comp').length,
    free: users.filter(u => u.status === 'free' || u.status === 'active' || u.status === 'trial-ended').length,
  };
  res.json({ users, summary });
});

// --- admin: reset a user's password ---
app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const u = db.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const pw = (req.body || {}).password || '';
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  db.setUserPassword(u.id, auth.hashPassword(pw));
  res.json({ ok: true });
});

// --- admin: delete a user ---
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (ADMIN_EMAILS.includes(u.email.toLowerCase())) {
    return res.status(400).json({ error: 'Admin accounts cannot be deleted here.' });
  }
  db.deleteUser(u.id);
  res.json({ ok: true });
});

// --- admin: make a managed sub-DJ an independent DJ (keeps them linked to the team) ---
app.post('/api/admin/users/:id/make-independent', requireAdmin, (req, res) => {
  const u = db.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.role !== 'subdj') return res.status(400).json({ error: 'That account is not a managed sub-DJ.' });
  db.convertSubToIndependent(u.id);
  res.json({ ok: true });
});

// --- admin: enable/disable a code ---
app.post('/api/admin/codes/:code/toggle', requireAdmin, (req, res) => {
  const c = db.getCode(req.params.code);
  if (!c) return res.status(404).json({ error: 'No such code.' });
  db.setCodeActive(c.code, !c.active);
  res.json({ code: db.getCode(c.code) });
});

// Admin: permanently delete a code (only when it's disabled, to avoid accidents).
app.delete('/api/admin/codes/:code', requireAdmin, (req, res) => {
  const c = db.getCode(req.params.code);
  if (!c) return res.status(404).json({ error: 'No such code.' });
  if (c.active) return res.status(400).json({ error: 'Disable the code before deleting it.' });
  db.deleteCode(c.code);
  res.json({ ok: true });
});

// =========================================================
//   MULTI-OP: sub-DJ accounts (owner manages their team)
// =========================================================
function requireMultiOp(req, res, next) {
  if (!planIsMultiOp(req.user)) return res.status(403).json({ error: 'This is a PRO WEDDING MULTI-OP feature.' });
  next();
}
function publicSubDj(u, ownerId) {
  const linked = u.role !== 'subdj' && u.id !== ownerId;
  // For linked DJs, the owner may set a team-specific display name/bio that
  // overrides the DJ's own account values (without changing their account).
  const ov = linked ? db.getTeamOverride(ownerId, u.id) : null;
  return {
    id: u.id, email: u.email,
    name: (ov && ov.name) || u.name || '',
    profile: (ov && ov.profile) || u.profile || '',
    photo: (ov && ov.dj_photo) || u.dj_photo || null,
    website: (ov && ov.dj_website) || u.dj_website || '',
    website2: (ov && ov.dj_website2) || u.dj_website2 || '',
    youtube: (ov && ov.dj_youtube) || u.dj_youtube || '',
    ownName: u.name || '',                    // their account's own name (for reference)
    hasOverride: !!ov,
    linked,
    isMe: u.id === ownerId,                    // the owner themselves
    createdAt: u.created_at,
  };
}

// Owner: list my team — the owner's own DJ profile first, then created sub-DJs + linked accounts.
app.get('/api/team', auth.requireAuth, requireMultiOp, (req, res) => {
  const me = publicSubDj(req.user, req.user.id);
  const others = db.listTeam(req.user.id).map(u => publicSubDj(u, req.user.id));
  res.json({ djs: [me, ...others] });
});

// Owner: add a DJ — links an existing account by email, or creates a new sub-account.
app.post('/api/team', auth.requireAuth, requireMultiOp, (req, res) => {
  const b = req.body || {};
  const email = (b.email || '').trim().toLowerCase();
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });

  const existing = db.getUserByEmail(email);
  if (existing) {
    // Linking an existing account into the team.
    if (existing.id === req.user.id) return res.status(400).json({ error: "That's your own account." });
    if (existing.role === 'couple') return res.status(400).json({ error: 'That email belongs to a wedding-couple login.' });
    if (existing.role === 'subdj') return res.status(409).json({ error: 'That DJ is already a managed sub-account.' });
    if (db.isOnTeam(req.user.id, existing.id)) return res.status(409).json({ error: 'That DJ is already on your team.' });
    db.linkTeamMember(req.user.id, existing.id);
    return res.json({ dj: publicSubDj(existing, req.user.id), linked: true });
  }

  // No existing account → create a managed sub-account (needs a temp password).
  const password = (b.password || '').toString();
  if (password.length < 6) return res.status(400).json({ error: 'No account exists for that email — set a temporary password (min 6 characters) to create one.' });
  const dj = db.createUser({
    id: auth.newId(),
    email,
    password_hash: auth.hashPassword(password),
    name: (b.name || '').slice(0, 80),
    role: 'subdj',
    parent_id: req.user.id,
    profile: (b.profile || '').slice(0, 2000),
    created_at: Date.now(),
  });
  res.json({ dj: publicSubDj(dj, req.user.id), linked: false });
});

// Owner: update a DJ profile (sub-account, own profile, or linked-DJ team override).
// Accepts an optional photo upload + website link.
app.post('/api/team/:id', auth.requireAuth, requireMultiOp, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    const website = (b.website || '').trim().slice(0, 200);
    const website2 = (b.website2 || '').trim().slice(0, 200);
    const youtube = (b.youtube || '').trim().slice(0, 200);
    const photoPath = req.file ? '/uploads/' + req.file.filename : undefined;

    // Owner editing their own profile.
    if (req.params.id === req.user.id) {
      const fields = {};
      if (b.name !== undefined) fields.name = (b.name || '').slice(0, 80);
      if (b.profile !== undefined) fields.profile = (b.profile || '').slice(0, 2000);
      if (b.website !== undefined) fields.dj_website = website;
      if (b.website2 !== undefined) fields.dj_website2 = website2;
      if (b.youtube !== undefined) fields.dj_youtube = youtube;
      if (photoPath) { if (req.user.dj_photo) safeUnlink(req.user.dj_photo); fields.dj_photo = photoPath; }
      db.updateUserProfile(req.user.id, fields);
      return res.json({ dj: publicSubDj(db.getUserById(req.user.id), req.user.id) });
    }
    const dj = db.getUserById(req.params.id);
    if (!dj) return res.status(404).json({ error: 'DJ not found.' });

    // Managed sub-account created by this owner: edit their account directly.
    if (dj.role === 'subdj' && dj.parent_id === req.user.id) {
      const fields = {};
      if (b.name !== undefined) fields.name = (b.name || '').slice(0, 80);
      if (b.profile !== undefined) fields.profile = (b.profile || '').slice(0, 2000);
      if (b.website !== undefined) fields.dj_website = website;
      if (b.website2 !== undefined) fields.dj_website2 = website2;
      if (b.youtube !== undefined) fields.dj_youtube = youtube;
      if (photoPath) { if (dj.dj_photo) safeUnlink(dj.dj_photo); fields.dj_photo = photoPath; }
      if (b.password) {
        if (b.password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        fields.password_hash = auth.hashPassword(b.password);
      }
      db.updateSubDj(dj.id, fields);
      return res.json({ dj: publicSubDj(db.getUserById(dj.id), req.user.id) });
    }

    // Linked independent account: store a team-specific display override only.
    if (db.isOnTeam(req.user.id, dj.id)) {
      const fields = {};
      if (b.name !== undefined) fields.name = (b.name || '').slice(0, 80);
      if (b.profile !== undefined) fields.profile = (b.profile || '').slice(0, 2000);
      if (b.website !== undefined) fields.dj_website = website;
      if (b.website2 !== undefined) fields.dj_website2 = website2;
      if (b.youtube !== undefined) fields.dj_youtube = youtube;
      if (photoPath) {
        const prev = db.getTeamOverride(req.user.id, dj.id);
        if (prev && prev.dj_photo) safeUnlink(prev.dj_photo);
        fields.dj_photo = photoPath;
      }
      db.setTeamOverride(req.user.id, dj.id, fields);
      return res.json({ dj: publicSubDj(db.getUserById(dj.id), req.user.id) });
    }

    return res.status(404).json({ error: 'DJ not found.' });
  });
});

// Owner: delete a sub-DJ
// Owner: remove a DJ — deletes a managed sub-account, or unlinks a linked account.
app.delete('/api/team/:id', auth.requireAuth, requireMultiOp, (req, res) => {
  const dj = db.getUserById(req.params.id);
  if (!dj) return res.status(404).json({ error: 'DJ not found.' });
  if (dj.role === 'subdj' && dj.parent_id === req.user.id) {
    db.deleteSubDj(dj.id);   // also unassigns their jobs
    return res.json({ ok: true, removed: 'deleted' });
  }
  if (db.isOnTeam(req.user.id, dj.id)) {
    // Linked account: unlink and unassign their jobs (but keep their account).
    db.unlinkTeamMember(req.user.id, dj.id);
    db.unassignAllFrom(dj.id, req.user.id);
    return res.json({ ok: true, removed: 'unlinked' });
  }
  return res.status(404).json({ error: 'DJ not found.' });
});

// Owner: assign (or unassign) an event to one of my team DJs
app.post('/api/events/:id/assign', auth.requireAuth, requireMultiOp, (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e || e.host_id !== req.user.id) return res.status(404).json({ error: 'Event not found.' });
  const djId = (req.body || {}).djId || null;
  // Owner can assign to a team DJ, or to themselves.
  if (djId && djId !== req.user.id && !db.isOnTeam(req.user.id, djId)) return res.status(400).json({ error: 'Pick one of your DJs.' });
  const prev = e.assigned_dj || null;
  db.assignEventDj(e.id, djId);
  // Notify the newly-assigned DJ (not the owner assigning to themselves, and
  // only when it actually changed to a different DJ).
  if (djId && djId !== req.user.id && djId !== prev) {
    notifyAssignment(djId, 'event', e.id, e.name || 'an event', e.event_date);
  }
  res.json({ ok: true, assignedDj: djId });
});

// Owner: assign (or unassign) a wedding to one of my team DJs
app.post('/api/weddings/:id/assign', auth.requireAuth, requireMultiOp, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w || w.host_id !== req.user.id) return res.status(404).json({ error: 'Wedding not found.' });
  const djId = (req.body || {}).djId || null;
  if (djId && djId !== req.user.id && !db.isOnTeam(req.user.id, djId)) return res.status(400).json({ error: 'Pick one of your DJs.' });
  const prev = w.assigned_dj || null;
  db.assignWeddingDj(w.id, djId);
  // Keep the linked live-requests event assigned to the same DJ, so they can run it.
  if (w.live_event_id && db.getEvent(w.live_event_id)) db.assignEventDj(w.live_event_id, djId);
  if (djId && djId !== req.user.id && djId !== prev) {
    notifyAssignment(djId, 'wedding', w.id, w.couple_names || w.name || 'a wedding', w.wedding_date);
  }
  res.json({ ok: true, assignedDj: djId });
});

// DJ/host or assigned DJ: set (or clear) the couple's edit lock date.
app.post('/api/weddings/:id/lock-date', auth.requireAuth, (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && w.assigned_dj !== req.user.id) {
    return res.status(403).json({ error: 'Only the DJ can set the lock date.' });
  }
  const raw = (req.body || {}).lockDate;
  let lock;
  if (raw === null || raw === '' || raw === undefined) {
    lock = 0;                 // explicitly cleared — overrides the 14-day default
  } else {
    const ts = new Date(raw).getTime();
    if (isNaN(ts)) return res.status(400).json({ error: 'Invalid date.' });
    lock = ts;
  }
  db.setWeddingLockDate(w.id, lock);
  res.json({ wedding: publicWedding(db.getWedding(w.id), req.user.id) });
});


/* =========================================================
   NOTIFICATIONS (DJ sees couple activity)
   ========================================================= */

app.get('/api/notifications', auth.requireAuth, (req, res) => {
  res.json({
    notifications: db.listNotifications(req.user.id).map(n => ({
      id: n.id, type: n.type, weddingId: n.wedding_id, weddingName: n.wedding_name,
      text: n.text, read: !!n.read, createdAt: n.created_at,
    })),
    unread: db.countUnread(req.user.id),
  });
});
app.post('/api/notifications/read', auth.requireAuth, (req, res) => {
  db.markNotificationsRead(req.user.id);
  res.json({ ok: true });
});

// Toggle the daily digest email (opt-in, off by default).
app.post('/api/notifications/digest', auth.requireAuth, (req, res) => {
  const on = !!(req.body || {}).on;
  db.setDailyDigest(req.user.id, on);
  res.json({ ok: true, dailyDigest: on });
});

// Set the host's preferred guest-search source for NEW events.
// Only 'apple' when Apple Music is configured; otherwise always 'spotify'.
app.post('/api/search-source', auth.requireAuth, (req, res) => {
  let source = ((req.body || {}).source || 'spotify').toString();
  if (source === 'apple' && !APPLE_MUSIC_ENABLED) source = 'spotify';
  db.setSearchSource(req.user.id, source);
  res.json({ ok: true, searchSource: source, appleAvailable: APPLE_MUSIC_ENABLED });
});

// Apple Music developer token for MusicKit JS (browser-side "Add to Apple
// Music"). This is the DEVELOPER token only (signed from our .p8) — it does
// NOT grant library access. The host still authorises in Apple's own popup,
// and needs an Apple Music subscription to actually save a playlist.
app.get('/api/apple/dev-token', auth.requireAuth, (req, res) => {
  if (!APPLE_MUSIC_ENABLED) return res.status(404).json({ error: 'Apple Music not configured' });
  try {
    res.json({ token: getAppleDevToken(), storefront: APPLE_MUSIC_STOREFRONT });
  } catch (e) {
    res.status(500).json({ error: 'Could not create Apple token' });
  }
});

// Guard: Prep endpoints require prep access (everyone except Basic).
function requirePrep(req, res, next) {
  if (!userHasPrepAccess(req.user)) return res.status(403).json({ error: 'Your plan doesn\u2019t include the music library. Upgrade to use Prep.' });
  next();
}

// Prep tool: the DJ's remembered "go-to version" per song (across all weddings).
app.get('/api/prep/picks', auth.requireAuth, requirePrep, (req, res) => {
  res.json({ picks: db.getPrepPicks(req.user.id) });
});
app.post('/api/prep/picks', auth.requireAuth, requirePrep, (req, res) => {
  const { key, chosen } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key required' });
  const picks = db.setPrepPick(req.user.id, key, chosen || null);
  res.json({ ok: true, picks });
});

// Prep tool: saved music-library snapshot (auto-loads across devices).
app.get('/api/prep/library', auth.requireAuth, requirePrep, (req, res) => {
  res.json({ library: db.getPrepLibrary(req.user.id) });
});
app.post('/api/prep/library', auth.requireAuth, requirePrep, (req, res) => {
  const lib = (req.body || {}).library;
  if (!lib || !Array.isArray(lib.tracks)) return res.status(400).json({ error: 'library.tracks required' });
  const saved = db.setPrepLibrary(req.user.id, lib);
  res.json({ ok: true, count: saved ? saved.tracks.length : 0 });
});
app.delete('/api/prep/library', auth.requireAuth, requirePrep, (req, res) => {
  db.setPrepLibrary(req.user.id, null);
  res.json({ ok: true });
});

/* =========================================================
   RESEND EMAIL (subscriber connects their own Resend key)
   ========================================================= */
// Send an email through a user's own Resend account. Returns {ok} or {error}.
async function sendViaResend(cfg, { to, subject, html, replyTo }) {
  const from = cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from;
  const body = { from, to: [to], subject, html };
  if (replyTo) body.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = 'Resend rejected the email.';
    try { const e = await r.json(); if (e && e.message) msg = e.message; } catch (_) {}
    if (r.status === 401 || r.status === 403) msg = 'Resend key rejected — check the key and that your domain is verified.';
    return { ok: false, error: msg };
  }
  return { ok: true };
}
// Only wedding-tier subscribers (and their sub-DJs) can use email invites.
function requireEmailTier(req, res, next) {
  if (!userHasPlannerAccess(req.user)) {
    return res.status(403).json({ error: 'Email invites are available on the PRO WEDDING tiers.' });
  }
  next();
}

// Status of the caller's Resend connection (never returns the key itself).
app.get('/api/resend/status', auth.requireAuth, (req, res) => {
  const u = req.user;
  const key = u.resend_api_key || '';
  res.json({
    connected: !!(u.resend_api_key && u.resend_from),
    from: u.resend_from || '',
    fromName: u.resend_from_name || '',
    hint: key ? ('re_••••' + key.slice(-4)) : '',
    inherited: !u.resend_api_key && !!db.resendConfigFor(u.id),   // using parent's setup
  });
});

// Save/update the caller's Resend config.
app.post('/api/resend/config', auth.requireAuth, requireEmailTier, (req, res) => {
  const b = req.body || {};
  const from = (b.from || '').trim().slice(0, 160);
  const fromName = (b.fromName || '').trim().slice(0, 80);
  const apiKey = (b.apiKey || '').trim();
  if (from && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
    return res.status(400).json({ error: 'Enter a valid from-address (e.g. invites@yourdomain.com).' });
  }
  // Only overwrite the key if a new one was supplied (so they can edit from-name without re-pasting).
  const patch = { from, fromName };
  if (apiKey) {
    if (!/^re_/.test(apiKey)) return res.status(400).json({ error: 'That does not look like a Resend key (should start with re_).' });
    patch.apiKey = apiKey;
  }
  db.setResendConfig(req.user.id, patch);
  res.json({ ok: true });
});

// Disconnect Resend.
app.delete('/api/resend/config', auth.requireAuth, (req, res) => {
  db.clearResendConfig(req.user.id);
  res.json({ ok: true });
});

// Send a test email to the caller's own login email.
app.post('/api/resend/test', auth.requireAuth, requireEmailTier, async (req, res) => {
  const cfg = db.resendConfigFor(req.user.id);
  if (!cfg) return res.status(400).json({ error: 'Connect Resend first (key + verified from-address).' });
  const out = await sendViaResend(cfg, {
    to: req.user.email,
    subject: 'Spinlist test email ✓',
    html: '<p>This is a test from Spinlist. Your Resend email is set up correctly.</p>',
  });
  if (!out.ok) return res.status(502).json({ error: out.error });
  res.json({ ok: true });
});

// Email a wedding invite to the couple, via the DJ's Resend account.
app.post('/api/weddings/:id/email-invite', auth.requireAuth, requireEmailTier, async (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  if (req.user.id !== w.host_id && w.assigned_dj !== req.user.id) {
    return res.status(403).json({ error: 'Only the DJ can send this invite.' });
  }
  const to = (req.body || {}).to && String(req.body.to).trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter the couple’s email address.' });
  const cfg = db.resendConfigFor(req.user.id);
  if (!cfg) return res.status(400).json({ error: 'Connect Resend first.', needsSetup: true });

  const link = `${BASE_URL}/wedding.html?code=${encodeURIComponent(w.invite_code)}`;
  const djName = escapeHtml(req.user.name || cfg.fromName || 'Your DJ');
  const lockLine = w.lock_date === 0 ? '' : (() => {
    const lock = (typeof w.lock_date === 'number') ? w.lock_date : (w.wedding_date ? w.wedding_date - 14 * 864e5 : null);
    return lock ? `<p>Please finish your choices by <b>${new Date(lock).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</b> so we can prepare your music.</p>` : '';
  })();
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2>You're invited to plan your wedding music 🎵</h2>
      <p>${djName} has invited you to choose your songs on Spinlist.</p>
      <p><a href="${link}" style="display:inline-block;background:#1b2440;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Open your wedding planner →</a></p>
      <p style="color:#555;font-size:14px">Or go to spinlist.co.uk/wedding.html and enter code <b>${escapeHtml(w.invite_code)}</b>.</p>
      ${lockLine}
    </div>`;
  const out = await sendViaResend(cfg, { to, subject: 'Plan your wedding music with ' + (req.user.name || 'your DJ'), html, replyTo: req.user.email });
  if (!out.ok) return res.status(502).json({ error: out.error });
  res.json({ ok: true });
});

// Email a sub-DJ their login invite, via the owner's Resend account.
app.post('/api/team/:id/email-invite', auth.requireAuth, requireEmailTier, async (req, res) => {
  const dj = db.getUserById(req.params.id);
  if (!dj || dj.role !== 'subdj' || dj.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'DJ not found.' });
  }
  const cfg = db.resendConfigFor(req.user.id);
  if (!cfg) return res.status(400).json({ error: 'Connect Resend first.', needsSetup: true });
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2>You've been added as a DJ on Spinlist</h2>
      <p>Sign in to see the events and weddings assigned to you.</p>
      <p><b>Login page:</b> <a href="${BASE_URL}">${BASE_URL}</a><br><b>Email:</b> ${escapeHtml(dj.email)}</p>
      <p style="color:#555;font-size:14px">Use the password you were given when your account was set up. If you don't have it, ask ${escapeHtml(req.user.name || 'your organiser')} for a reset.</p>
    </div>`;
  const out = await sendViaResend(cfg, { to: dj.email, subject: 'Your Spinlist DJ login', html, replyTo: req.user.email });
  if (!out.ok) return res.status(502).json({ error: out.error });
  res.json({ ok: true });
});

/* =========================================================
   DAILY DIGEST — one round-up email per opted-in DJ per day
   ========================================================= */
// Send window (server local time). Configurable later via env DIGEST_HOUR (0-23).
const DIGEST_HOUR = Number.isFinite(+process.env.DIGEST_HOUR) ? Math.max(0, Math.min(23, +process.env.DIGEST_HOUR)) : 8;

function dayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function digestHtml(name, items) {
  const rows = items.map(n => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#1a1f2e">${escapeHtml(n.text)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:12px;color:#8b93a7;white-space:nowrap;text-align:right">${new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
    </tr>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#0d1220;padding:20px 24px;border-radius:12px 12px 0 0">
        <span style="color:#c1ff2f;font-weight:800;font-size:18px">Spinlist</span>
        <span style="color:#fff;font-weight:600;font-size:15px"> · Daily round-up</span>
      </div>
      <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:22px 24px">
        <p style="font-size:15px;color:#1a1f2e;margin:0 0 4px">Hi ${escapeHtml(name || 'there')},</p>
        <p style="font-size:14px;color:#555;margin:0 0 16px">Here's what your couples got up to yesterday — ${items.length} update${items.length === 1 ? '' : 's'}.</p>
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        <p style="margin:20px 0 0"><a href="${BASE_URL}/wedding.html" style="display:inline-block;background:#c1ff2f;color:#0a1228;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Open your planner</a></p>
        <p style="font-size:12px;color:#8b93a7;margin:18px 0 0">You're getting this because you turned on the daily round-up in your account. You can switch it off any time under Account.</p>
      </div>
    </div>`;
}

async function sendDailyDigests() {
  const today = dayKey();
  const now = new Date();
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); // midnight today
  const since = until - 864e5;                                                        // midnight yesterday
  const due = db.usersDueDigest(today);
  for (const u of due) {
    try {
      const items = db.notificationsBetween(u.id, since, until);
      // Mark as processed for today regardless, so we never double-send.
      db.markDigestSent(u.id, today);
      if (!items.length) continue;                 // nothing happened yesterday — skip the email
      const cfg = db.resendConfigFor(u.id);
      if (!cfg) continue;                          // no email set up — silently skip
      await sendViaResend(cfg, {
        to: u.email,
        subject: `Spinlist round-up · ${items.length} update${items.length === 1 ? '' : 's'} from your couples`,
        html: digestHtml(u.name, items),
        replyTo: u.email,
      });
    } catch (e) { /* keep going through the rest */ }
  }
}

// Check every 15 minutes; fire the batch once we're at/after the send hour for a new day.
let _lastDigestDay = null;
setInterval(() => {
  const now = new Date();
  const today = dayKey(now);
  if (now.getHours() >= DIGEST_HOUR && _lastDigestDay !== today) {
    _lastDigestDay = today;
    sendDailyDigests();
  }
}, 15 * 60 * 1000);


app.post('/api/redeem', auth.requireAuth, (req, res) => {
  const c = db.getCode((req.body || {}).code);
  if (!c || !c.active) return res.status(404).json({ error: 'That code is not valid.' });
  if (c.expires_at && Date.now() > c.expires_at) return res.status(410).json({ error: 'That code has expired.' });
  if (c.max_uses !== null && c.uses >= c.max_uses) return res.status(409).json({ error: 'That code has been fully used.' });
  if (db.hasRedeemed(c.code, req.user.id)) return res.status(409).json({ error: 'You have already redeemed this code.' });

  if (c.kind === 'comp') {
    const compUntil = c.months ? Date.now() + c.months * 30 * 864e5 : null; // null = forever
    db.grantComp(req.user.id, { plan: c.plan, comp_until: compUntil, comp_code: c.code });
    if (c.grants_spotify) db.grantSpotifyExport(req.user.id);   // permanent perk
    db.incrementCodeUses(c.code);
    db.recordRedemption({ id: auth.newId(), code: c.code, user_id: req.user.id, redeemed_at: Date.now() });
    const planLabel = (PLANS[c.plan] && PLANS[c.plan].name) || c.plan.toUpperCase();
    return res.json({
      type: 'comp',
      plan: c.plan,
      until: compUntil,
      message: `Complimentary ${planLabel} access unlocked${c.months ? ` for ${c.months} month(s)` : ' — no expiry'}${c.grants_spotify ? ' · Spotify export enabled' : ''}.`,
    });
  }

  // Spotify add-on only — grant the perk, no plan change.
  if (c.kind === 'addon') {
    db.grantSpotifyExport(req.user.id);
    db.incrementCodeUses(c.code);
    db.recordRedemption({ id: auth.newId(), code: c.code, user_id: req.user.id, redeemed_at: Date.now() });
    return res.json({
      type: 'addon',
      message: 'Spotify export has been added to your account.',
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
    return res.status(403).json({ error: 'Custom branding is available on the BASIC and PRO plans.', upgrade: true });
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
   SPOTIFY PLAYLIST EXPORT (OAuth Authorization Code flow)
   ---------------------------------------------------------
   The DJ logs into THEIR Spotify, we store their tokens, then
   create a playlist in their account from the event's voted
   tracks. Studio plan only.
   ========================================================= */
const SPOTIFY_REDIRECT = `${BASE_URL}/api/spotify/callback`;
const SPOTIFY_SCOPE = 'playlist-modify-public playlist-modify-private';
// short-lived state -> userId, to tie the callback back to the signed-in host
const spotifyStates = new Map();

// Step 1: start the OAuth handshake (host must be signed in + Studio).
app.get('/api/spotify/connect', auth.requireAuth, (req, res) => {
  const plan = PLANS[req.user.plan];
  if (!plan || !plan.spotifyExport) {
    return res.status(403).json({ error: 'Spotify export is a PRO feature.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  spotifyStates.set(state, { userId: req.user.id, at: Date.now() });
  // clean up old states (10 min)
  for (const [k, v] of spotifyStates) if (Date.now() - v.at > 600000) spotifyStates.delete(k);
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', SPOTIFY_REDIRECT);
  url.searchParams.set('scope', SPOTIFY_SCOPE);
  url.searchParams.set('state', state);
  res.json({ url: url.toString() });
});

// Step 2: Spotify redirects back here with a code.
app.get('/api/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/account.html?spotify=denied');
  const entry = state && spotifyStates.get(state);
  if (!entry) return res.redirect('/account.html?spotify=invalid');
  spotifyStates.delete(state);
  try {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code.toString(),
        redirect_uri: SPOTIFY_REDIRECT,
      }),
    });
    if (!r.ok) return res.redirect('/account.html?spotify=failed');
    const t = await r.json();
    // fetch the user's Spotify id (needed for some calls / display)
    let spotifyUserId = null;
    try {
      const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${t.access_token}` } });
      if (me.ok) spotifyUserId = (await me.json()).id;
    } catch (_) {}
    db.setSpotifyAuth(entry.userId, {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      spotifyUserId,
    });
    res.redirect('/account.html?spotify=connected');
  } catch (e) {
    res.redirect('/account.html?spotify=failed');
  }
});

// Disconnect Spotify.
app.post('/api/spotify/disconnect', auth.requireAuth, (req, res) => {
  db.clearSpotifyAuth(req.user.id);
  res.json({ ok: true });
});

// Whether the current host has Spotify connected.
app.get('/api/spotify/status', auth.requireAuth, (req, res) => {
  const u = db.getUserById(req.user.id);
  res.json({ connected: !!(u && u.spotify_refresh), spotifyUserId: u && u.spotify_user_id });
});

// Get a valid access token for a user, refreshing if needed.
async function getUserSpotifyToken(userId) {
  const u = db.getUserById(userId);
  if (!u || !u.spotify_refresh) return null;
  if (u.spotify_access && Date.now() < (u.spotify_expires || 0) - 30000) return u.spotify_access;
  // refresh
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: u.spotify_refresh }),
  });
  if (!r.ok) return null;
  const t = await r.json();
  db.setSpotifyAuth(userId, {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,   // may be undefined; db keeps the old one
    expiresAt: Date.now() + t.expires_in * 1000,
  });
  return t.access_token;
}

// Step 3: create a playlist in the DJ's account from an event's tracks.
app.post('/api/events/:id/export-spotify', auth.requireAuth, async (req, res) => {
  const e = db.getEvent(req.params.id);
  if (!e) return res.status(404).json({ error: 'Event not found.' });
  if (e.host_id !== req.user.id) return res.status(403).json({ error: 'Not your event.' });
  const plan = PLANS[req.user.plan];
  const hasSpotify = (plan && plan.spotifyExport) || req.user.spotify_export;
  if (!hasSpotify) return res.status(403).json({ error: 'Spotify export is not enabled on your account.' });

  const token = await getUserSpotifyToken(req.user.id);
  if (!token) return res.status(401).json({ error: 'Connect your Spotify account first.', needsAuth: true });

  // Collect track URIs (top voted first), skipping any without a Spotify URI.
  const uris = Object.values(e.tracks || {})
    .sort((a, b) => b.votes - a.votes)
    .map(t => t.uri)
    .filter(u => typeof u === 'string' && u.startsWith('spotify:track:'));
  if (!uris.length) return res.status(400).json({ error: 'No Spotify tracks to export yet.' });

  try {
    // Create the playlist on the current user (POST /me/playlists — the
    // per-user endpoint was removed in Feb 2026).
    const makeP = await fetch('https://api.spotify.com/v1/me/playlists', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${e.name} — Spinlist`,
        description: `Crowd-voted setlist from ${e.name}, built with Spinlist.`,
        public: true,
      }),
    });
    if (!makeP.ok) {
      const errTxt = await makeP.text();
      console.error('Spotify create playlist failed:', makeP.status, errTxt);
      if (makeP.status === 401) return res.status(401).json({ error: 'Spotify session expired — reconnect.', needsAuth: true });
      return res.status(502).json({ error: 'Could not create the playlist on Spotify.' });
    }
    const playlist = await makeP.json();

    // Add tracks in batches of 100 (API max per request).
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      const add = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: batch }),
      });
      if (!add.ok) {
        const errTxt = await add.text();
        console.error('Spotify add tracks failed:', add.status, errTxt);
        return res.status(502).json({ error: 'Playlist created, but adding some tracks failed.', url: playlist.external_urls?.spotify });
      }
    }
    res.json({ ok: true, url: playlist.external_urls?.spotify, count: uris.length });
  } catch (err) {
    console.error('export-spotify error:', err.message);
    res.status(500).json({ error: 'Spotify export failed.' });
  }
});

// Export a single wedding block to its own Spotify playlist.
app.post('/api/weddings/:id/blocks/:blockId/export-spotify', auth.requireAuth, async (req, res) => {
  const w = db.getWedding(req.params.id);
  if (!w) return res.status(404).json({ error: 'Wedding not found.' });
  // The DJ host or the assigned DJ can export (not the couple).
  if (req.user.id !== w.host_id && w.assigned_dj !== req.user.id) {
    return res.status(403).json({ error: 'Only the DJ can export to Spotify.' });
  }
  // Spotify access: the exporter's plan/perk, OR the wedding owner's (so an
  // assigned DJ inherits the owner's Spotify entitlement).
  const plan = PLANS[req.user.plan];
  let hasSpotify = (plan && plan.spotifyExport) || req.user.spotify_export;
  if (!hasSpotify) {
    const owner = db.getUserById(w.host_id);
    const op = owner && PLANS[owner.plan];
    hasSpotify = (op && op.spotifyExport) || (owner && owner.spotify_export);
  }
  if (!hasSpotify) return res.status(403).json({ error: 'Spotify export is not enabled on your account.' });

  const block = (w.blocks || []).find(b => b.id === req.params.blockId);
  if (!block) return res.status(404).json({ error: 'Block not found.' });

  const uris = (block.songs || [])
    .map(s => s.uri)
    .filter(u => typeof u === 'string' && u.startsWith('spotify:track:'));
  if (!uris.length) return res.status(400).json({ error: 'No Spotify tracks in this block yet.' });

  const token = await getUserSpotifyToken(req.user.id);
  if (!token) return res.status(401).json({ error: 'Connect your Spotify account first.', needsAuth: true });

  try {
    const makeP = await fetch('https://api.spotify.com/v1/me/playlists', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${w.name || 'Wedding'} — ${block.name}`,
        description: `${block.name} for ${w.name || 'the wedding'}, built with Spinlist.`,
        public: false,
      }),
    });
    if (!makeP.ok) {
      const errTxt = await makeP.text();
      console.error('Spotify create playlist failed:', makeP.status, errTxt);
      if (makeP.status === 401) return res.status(401).json({ error: 'Spotify session expired — reconnect.', needsAuth: true });
      return res.status(502).json({ error: 'Could not create the playlist on Spotify.' });
    }
    const playlist = await makeP.json();

    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      const add = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: batch }),
      });
      if (!add.ok) {
        const errTxt = await add.text();
        console.error('Spotify add tracks failed:', add.status, errTxt);
        return res.status(502).json({ error: 'Playlist created, but adding some tracks failed.', url: playlist.external_urls?.spotify });
      }
    }
    res.json({ ok: true, url: playlist.external_urls?.spotify, count: uris.length, block: block.name });
  } catch (err) {
    console.error('wedding block export-spotify error:', err.message);
    res.status(500).json({ error: 'Spotify export failed.' });
  }
});

/* =========================================================
   SPOTIFY SEARCH PROXY (unchanged)
   ========================================================= */
let cachedToken = null;

/* Short-lived in-memory cache of search results. At a busy event many guests
   type the same songs; caching means Spotify sees one request per unique query
   per window instead of hundreds, keeping us under its rate limit. */
const searchCache = new Map();       // key -> { value, expiresAt }
const SEARCH_CACHE_MS = 60_000;      // reuse identical searches for 60s
const SEARCH_CACHE_MAX = 2000;       // cap entries so memory stays bounded

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

/* ---- Apple Music fallback ------------------------------------------------
   A developer token is a JWT signed with your MusicKit private key (ES256).
   We sign it ourselves with Node's crypto (no extra dependency) and cache it.
   Apple lets tokens live up to 6 months; we use a shorter life and refresh. */
function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
let appleTokenCache = null;
function getAppleDevToken() {
  if (!APPLE_MUSIC_ENABLED) throw new Error('Apple Music not configured');
  if (appleTokenCache && Date.now() < appleTokenCache.expiresAt - 60_000) return appleTokenCache.value;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 12;          // 12 hours
  const header = { alg: 'ES256', kid: APPLE_MUSIC_KEY_ID };
  const payload = { iss: APPLE_MUSIC_TEAM_ID, iat, exp };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // ES256 = ECDSA P-256 SHA-256; Node returns DER, JWT needs raw R||S (64 bytes).
  const der = crypto.sign('SHA256', Buffer.from(signingInput),
    { key: APPLE_MUSIC_KEY, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${base64url(der)}`;
  appleTokenCache = { value: jwt, expiresAt: exp * 1000 };
  return jwt;
}

// Shape Apple Music results to the same structure as Spotify results.
function shapeAppleResults(json) {
  const items = (json && json.results && json.results.songs && json.results.songs.data) || [];
  return {
    source: 'apple',
    tracks: items.map(s => {
      const a = s.attributes || {};
      let art = '';
      if (a.artwork && a.artwork.url) {
        art = a.artwork.url.replace('{w}', '200').replace('{h}', '200');
      }
      return {
        id: s.id,
        uri: a.url || '',                 // Apple has no spotify: URI; use the web URL
        title: a.name || '',
        artist: a.artistName || '',
        album: a.albumName || '',
        art,
        durationMs: a.durationInMillis || 0,
        isrc: a.isrc || '',               // ISRC lets us cross-reference to Spotify later
        appleUrl: a.url || '',
      };
    }),
  };
}

async function searchAppleMusic(q, limit) {
  const token = getAppleDevToken();
  const url = new URL(`https://api.music.apple.com/v1/catalog/${APPLE_MUSIC_STOREFRONT}/search`);
  url.searchParams.set('term', q);
  url.searchParams.set('types', 'songs');
  url.searchParams.set('limit', String(Math.min(limit || 10, 25)));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Apple search failed (${r.status})`);
  return shapeAppleResults(await r.json());
}

/* Diagnostic: check whether Apple Music search is actually working, without
   needing Spotify to be rate-limited first. Reports config state and does a
   live test search. Handy for confirming the key is set up correctly. */
app.get('/api/search/apple-test', requireAdmin, async (req, res) => {
  // A healthy pkcs8 EC private key normalises to ~230-260 chars of PEM.
  // Reporting length + a hash (not the key) tells us if Render has the full
  // value and whether it changed, without ever exposing the secret.
  const rawEnv = process.env.APPLE_MUSIC_KEY || '';
  // Show the exact character codes of the first stretch of the raw value so we
  // can see precisely how it's escaped (real newline=10, backslash=92, etc.)
  // without ever revealing key material — the header text isn't secret.
  const rawHead = rawEnv.slice(0, 45);
  const rawHeadCodes = Array.from(rawHead).map(c => c.charCodeAt(0)).join(',');
  const rawHeadShown = JSON.stringify(rawHead);
  const bodyOnly = APPLE_MUSIC_KEY
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const status = {
    configured: APPLE_MUSIC_ENABLED,
    hasKey: !!APPLE_MUSIC_KEY,
    keyLooksValid: /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(APPLE_MUSIC_KEY),
    hasKeyId: !!APPLE_MUSIC_KEY_ID,
    keyIdLength: APPLE_MUSIC_KEY_ID.length,      // should be 10
    teamId: APPLE_MUSIC_TEAM_ID ? APPLE_MUSIC_TEAM_ID.slice(0, 4) + '…' : '(none)',
    storefront: APPLE_MUSIC_STOREFRONT,
    rawEnvLength: rawEnv.length,                 // what Render stores, before normalise
    normalisedLength: APPLE_MUSIC_KEY.length,    // after our cleanup
    keyBodyLength: bodyOnly.length,              // just the base64 (healthy ~200+)
    keyFingerprint: crypto.createHash('sha256').update(APPLE_MUSIC_KEY).digest('hex').slice(0, 12),
    hasBackslashN: rawEnv.includes('\\n'),
    hasRealNewlines: rawEnv.includes('\n'),
    rawHeadShown,
    rawHeadCodes,
  };
  if (!APPLE_MUSIC_ENABLED) {
    return res.status(200).json({ ok: false, step: 'config', message: 'Apple Music is not configured — APPLE_MUSIC_KEY and APPLE_MUSIC_KEY_ID must both be set.', status });
  }
  // Step 1: can we sign a token?
  let token;
  try {
    token = getAppleDevToken();
  } catch (e) {
    return res.status(200).json({ ok: false, step: 'sign-token', message: 'Could not sign a developer token from the key. This usually means the key text is wrong or incomplete.', error: e.message, status });
  }
  // Step 2: can we actually search?
  try {
    const result = await searchAppleMusic(req.query.q ? String(req.query.q) : 'test', 3);
    return res.status(200).json({ ok: true, step: 'done', message: 'Apple Music is working.', sampleCount: result.tracks.length, sample: result.tracks.slice(0, 3).map(t => `${t.title} — ${t.artist}`), status });
  } catch (e) {
    // Common: 401 = bad key/keyId/teamId mismatch; 403 = key not enabled for MusicKit
    let hint = '';
    if (/\(401\)/.test(e.message)) hint = 'A 401 usually means the Key ID, Team ID, or the key itself don\'t match. Double-check the Key ID matches this exact .p8 file, and the Team ID is 3LVYMTC2X7.';
    else if (/\(403\)/.test(e.message)) hint = 'A 403 usually means the key isn\'t enabled for MusicKit, or the MusicKit identifier wasn\'t set up. Check the key has MusicKit ticked in your Apple account.';
    return res.status(200).json({ ok: false, step: 'search', message: 'Signed a token, but the Apple search request failed.', error: e.message, hint, status });
  }
});

/* ----------------------------------------------------------------
   HEALTH CHECK
   /api/health reports the status of each subsystem so you can see at a
   glance (via /status) whether search, the fallback and the database are
   healthy — rather than finding out mid-gig. Safe to call publicly: it
   exposes only up/down status and coarse counts, no secrets or user data.
---------------------------------------------------------------- */
let healthCache = { at: 0, body: null };
app.get('/api/health', async (req, res) => {
  // Cache for 20s so repeated polling doesn't hammer Spotify.
  if (healthCache.body && Date.now() - healthCache.at < 20_000) {
    return res.json({ ...healthCache.body, cached: true });
  }
  const checks = {};
  let ok = true;

  // 1) Server — if this responds at all, the process is up.
  checks.server = { status: 'up' };

  // 2) Database / data store — readable?
  try {
    const s = db.health();
    checks.database = { status: 'up', users: s.users, events: s.events, weddings: s.weddings };
  } catch (e) {
    checks.database = { status: 'down', error: 'store unavailable' };
    ok = false;
  }

  // 3) Spotify search — reflect REAL guest-search behaviour, not just the
  //    token endpoint. If searches were throttled in the last 3 minutes, show
  //    degraded even if a token still fetches fine.
  const THROTTLE_WINDOW = 3 * 60 * 1000;
  const recentlyThrottled = searchHealth.lastSpotifyThrottleAt &&
    (Date.now() - searchHealth.lastSpotifyThrottleAt < THROTTLE_WINDOW);
  try {
    await getAppToken();
    if (recentlyThrottled) {
      checks.spotify = { status: 'degraded', note: 'searches being rate limited' };
    } else {
      checks.spotify = { status: 'up' };
    }
  } catch (e) {
    const m = (e && e.message) || '';
    checks.spotify = /429/.test(m) ? { status: 'degraded', note: 'rate limited' } : { status: 'down' };
    if (checks.spotify.status === 'down') ok = false;
  }

  // 4) Apple Music fallback — configured, and is it ACTIVELY covering right now?
  if (!APPLE_MUSIC_ENABLED) {
    checks.appleFallback = { status: 'off' };
  } else {
    const activelyCovering = searchHealth.lastAppleFallbackAt &&
      (Date.now() - searchHealth.lastAppleFallbackAt < THROTTLE_WINDOW);
    checks.appleFallback = activelyCovering
      ? { status: 'active', note: 'covering for Spotify' }
      : { status: 'configured' };
  }

  // 5) Demo event — present?
  checks.demo = { status: db.getEvent('DEMO') ? 'up' : 'missing' };

  const body = {
    ok,
    status: ok ? 'healthy' : 'problem',
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  };
  healthCache = { at: Date.now(), body };
  res.status(ok ? 200 : 503).json(body);
});

// Live search-health tracking, so the status page reflects what's ACTUALLY
// happening on real guest searches — not just whether a token can be fetched.
const searchHealth = {
  lastSpotifyThrottleAt: 0,   // last time a real search got a 429
  lastAppleFallbackAt: 0,     // last time Apple actually served a result
  lastSpotifyOkAt: 0,         // last successful Spotify search
};

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ tracks: [] });
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 10); // Spotify caps at 10
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const source = (req.query.source || '').toString() === 'apple' ? 'apple' : 'spotify';

  // Serve identical searches from a short-lived cache so a busy event
  // (many guests searching the same songs) doesn't hammer the source and
  // trip its rate limit. Key on the normalised query + paging + source.
  const cacheKey = `${source}|${q.toLowerCase()}|${limit}|${offset}`;
  const now = Date.now();
  const hit = searchCache.get(cacheKey);
  if (hit && now < hit.expiresAt) {
    return res.json(hit.value);
  }

  // If this event prefers Apple, search Apple first. Fall back to Spotify
  // if Apple isn't configured or the search fails, so guests are never stuck.
  if (source === 'apple' && APPLE_MUSIC_ENABLED) {
    try {
      const apple = await tryAppleFallback(q, limit, cacheKey, now);
      if (apple) return res.json(apple);
    } catch (_) { /* fall through to Spotify */ }
  }

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
    if (r.status === 429) {
      // Spotify is rate-limiting us. First try to keep search alive:
      //   1. serve a stale cached result for this query if we have one, else
      //   2. fall back to Apple Music (if configured), else
      //   3. ask the guest to wait a moment.
      searchHealth.lastSpotifyThrottleAt = Date.now();   // real throttling, right now
      const retryAfter = parseInt(r.headers.get('retry-after') || '2', 10);
      if (hit) return res.json(hit.value);
      const viaApple = await tryAppleFallback(q, limit, cacheKey, now);
      if (viaApple) { searchHealth.lastAppleFallbackAt = Date.now(); return res.json(viaApple); }
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Busy right now — please wait a moment and try again.', retryAfter });
    }
    if (!r.ok) return res.status(r.status).json({ error: 'Spotify search failed' });
    const shaped = shapeResults(await r.json());
    searchHealth.lastSpotifyOkAt = Date.now();            // Spotify is serving searches
    // Cache successful results for a short window.
    cacheSearch(cacheKey, shaped, now);
    res.json(shaped);
  } catch (err) {
    // Spotify unreachable (network/timeout). Try Apple Music before giving up.
    console.error('search error:', err.message);
    const viaApple = await tryAppleFallback(q, limit, cacheKey, Date.now());
    if (viaApple) { searchHealth.lastAppleFallbackAt = Date.now(); return res.json(viaApple); }
    res.status(500).json({ error: 'Search failed' });
  }
});

// Store a result in the short-lived cache, trimming if it grows too large.
function cacheSearch(cacheKey, shaped, now) {
  searchCache.set(cacheKey, { value: shaped, expiresAt: now + SEARCH_CACHE_MS });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const drop = Math.ceil(SEARCH_CACHE_MAX * 0.1);
    let i = 0;
    for (const k of searchCache.keys()) { searchCache.delete(k); if (++i >= drop) break; }
  }
}

// Attempt an Apple Music search as a fallback. Returns the shaped result
// (also caching it) or null if Apple isn't configured or the search fails.
async function tryAppleFallback(q, limit, cacheKey, now) {
  if (!APPLE_MUSIC_ENABLED) return null;
  try {
    const shaped = await searchAppleMusic(q, limit);
    cacheSearch(cacheKey, shaped, now);
    console.log('search: served via Apple Music fallback');
    return shaped;
  } catch (e) {
    console.error('apple fallback failed:', e.message);
    return null;
  }
}
function shapeResults(json) {
  const items = json?.tracks?.items || [];
  return {
    source: 'spotify',
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
  const p = PLANS[u.plan];
  return { id: u.id, email: u.email, name: u.name, plan: u.plan, planName: (p && p.name) || '', sub_status: u.sub_status, role: u.role || 'host', weddingPlanner: userHasPlannerAccess(u), multiOp: planIsMultiOp(u), isSubDj: u.role === 'subdj', spotifyExport: !!u.spotify_export || u.plan === 'studio', branding: planHasBranding(u), emailInvites: userHasPlannerAccess(u), dailyDigest: !!u.daily_digest, prepAccess: userHasPrepAccess(u), searchSource: u.search_source === 'apple' ? 'apple' : 'spotify', appleSearchAvailable: APPLE_MUSIC_ENABLED };
}
// Shareable public demo — a clean URL for socials/marketing that drops
// anyone straight into the live guest voting experience.
app.get('/demo', (req, res) => res.redirect('/#vote/DEMO'));

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
/* ----------------------------------------------------------------
   PUBLIC DEMO EVENT
   A permanent, shareable event at /#vote/DEMO so anyone (no login) can
   try the guest experience: search Spotify for real, vote, and watch the
   leaderboard move. It resets hourly back to a seeded state so it never
   fills up with junk. Great for socials/marketing.
---------------------------------------------------------------- */
const DEMO_EVENT_ID = 'DEMO';
const DEMO_SEED = [
  { title: 'Dancing Queen', artist: 'ABBA', votes: 42 },
  { title: 'Mr. Brightside', artist: 'The Killers', votes: 37 },
  { title: 'Uptown Funk', artist: 'Mark Ronson ft. Bruno Mars', votes: 33 },
  { title: 'Sweet Caroline', artist: 'Neil Diamond', votes: 29 },
  { title: "Don't Stop Me Now", artist: 'Queen', votes: 24 },
  { title: 'Blinding Lights', artist: 'The Weeknd', votes: 21 },
  { title: 'September', artist: 'Earth, Wind & Fire', votes: 18 },
  { title: 'I Wanna Dance with Somebody', artist: 'Whitney Houston', votes: 15 },
];

function buildDemoEvent() {
  try {
    const existing = db.getEvent(DEMO_EVENT_ID);
    if (existing) db.deleteEvent && db.deleteEvent(DEMO_EVENT_ID);
  } catch (_) {}
  const ev = db.createEvent({
    id: DEMO_EVENT_ID,
    host_id: 'demo',
    name: "Sam's 30th Birthday",
    type: 'Birthday',
    host: 'DJ Marco',
    votes_per: 5,
    deadline: null,        // never closes
    event_date: null,
    locked: false,
    ask_name: false,
    ask_nationality: false,
    created_at: Date.now(),
    demo: true,
  });
  // Seed the leaderboard (no Spotify URIs — guests add real ones by voting).
  try {
    const e = db.getEvent(DEMO_EVENT_ID);
    if (e) {
      e.tracks = {};
      DEMO_SEED.forEach((s, i) => {
        e.tracks['demoseed' + i] = {
          id: 'demoseed' + i, uri: null, title: s.title, artist: s.artist,
          art: '', votes: s.votes, played: 0, addedAt: Date.now() - (i * 1000), requesters: [],
        };
      });
    }
  } catch (_) {}
}

function ensureDemoEvent() {
  if (!db.getEvent(DEMO_EVENT_ID)) buildDemoEvent();
}

// Reset hourly so the demo stays clean for the next visitor.
ensureDemoEvent();
setInterval(buildDemoEvent, 60 * 60 * 1000);

const underPassenger = !!(process.env.PASSENGER_BASE_URI || process.env.PASSENGER_APP_ENV ||
  (typeof PhusionPassenger !== 'undefined'));

if (underPassenger) {
  module.exports = app;
} else {
  app.listen(PORT, () => console.log(`\n  Spinlist running → ${BASE_URL}\n`));
}
