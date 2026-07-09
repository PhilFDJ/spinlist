import express from "express";
import crypto from "crypto";
import multer from "multer";
import cookieParser from "cookie-parser";
import Papa from "papaparse";
import { Resend } from "resend";
import Stripe from "stripe";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";
import path from "path";
import onedrive from "./onedrive.js";
import dropbox from "./dropbox.js";
import gdrive from "./gdrive.js";
import gcal from "./gcal.js";

// Map provider name -> module, so the storage flow is provider-agnostic.
const STORAGE_PROVIDERS = { onedrive, dropbox, gdrive };
import { pool, initDb } from "./db.js";
import { extractContacts } from "./extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---------- config from environment ----------
const {
  ADMIN_PASSWORD,
  RESEND_API_KEY,
  // The verified sending domain and this agency's mailbox prefix. Together they form
  // the send address, e.g. ldagency@gigconfirm.co.uk. Kept configurable so the
  // upcoming multi-agency version can set a different prefix per subscriber.
  SEND_DOMAIN = "gigconfirm.co.uk",
  SEND_PREFIX = "ldagency",
  MAIL_FROM,                 // optional full override, e.g. "LD Agency <ldagency@gigconfirm.co.uk>"
  APP_URL = "http://localhost:3000",
  CRON_SECRET,
  STRIPE_SECRET_KEY,          // sk_live_… or sk_test_…
  STRIPE_PRICE_ID,            // the recurring price for the monthly plan
  STRIPE_WEBHOOK_SECRET,      // whsec_… for verifying webhook calls
  PRICE_DISPLAY = "£50",      // shown on home/billing pages (just cosmetic)
  ADMIN_ALERT_EMAIL,          // where to send platform alerts (new signups). Falls back to platform admins.
  TOKEN_ENC_KEY,              // secret used to encrypt stored cloud-storage refresh tokens at rest
  PORT = 3000,
} = process.env;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const SEND_ADDRESS = `${SEND_PREFIX}@${SEND_DOMAIN}`;
// Statuses that count as "may use the app".
const ACTIVE_STATUSES = new Set(["active", "trialing"]);


// Wrapper so the rest of the app can call sendMail({from,to,subject,html,replyTo})
// uniformly. `to` may be a string or an array of addresses.
async function sendMail({ from, to, subject, html, replyTo, attachments }) {
  if (!resend) throw new Error("Email not configured (RESEND_API_KEY missing).");
  const payload = {
    from: from || MAIL_FROM || `LD Agency <${SEND_ADDRESS}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  // Resend's Node SDK (v4) expects camelCase `replyTo`. Only set it when we actually
  // have an address, so we never send an empty/blank reply-to header. We set both the
  // camelCase and snake_case forms to be safe across SDK versions.
  if (replyTo) { payload.replyTo = replyTo; payload.reply_to = replyTo; }
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  return resend.emails.send(payload);
}

// Build a CSV string from the current bookings of a batch (act, venue, date, status, notes).
function csvEscape(v) {
  const s = (v == null ? "" : String(v));
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function batchCsv(batchId, agencyId) {
  const rows = (await pool.query(
    `SELECT a.name AS act_name, bk.performer_name, a.email AS act_email,
            COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS venue,
            br.name AS group_name,
            bk.gig_date, bk.gig_time, bk.status, bk.message, bk.adhoc_note,
            bk.resolution_note, bk.responded_at
     FROM bookings bk JOIN acts a ON a.id=bk.act_id
     LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
     LEFT JOIN brands br ON br.id=v.brand_id AND br.agency_id=bk.agency_id
     WHERE bk.batch_id=$1 AND bk.agency_id=$2
     ORDER BY a.name, bk.gig_date`, [batchId, agencyId]
  )).rows;
  const header = ["Act", "Act email", "Venue", "Group", "Date", "Time", "Status", "Act message", "Our note", "Resolution note", "Responded at"];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    const status = r.status === "issue" ? "flagged" : r.status;
    lines.push([
      r.performer_name || r.act_name, r.act_email, r.venue, r.group_name, r.gig_date, r.gig_time, status,
      r.message, r.adhoc_note, r.resolution_note,
      r.responded_at ? new Date(r.responded_at).toISOString() : "",
    ].map(csvEscape).join(","));
  }
  return lines.join("\r\n");
}

// If a batch has no pending gigs left and we haven't already emailed the summary,
// send a completion CSV to the agency's team. Safe to call after any response.
async function maybeSendCompletion(batchId, agencyId) {
  if (!resend || !batchId) return;
  const batch = (await pool.query(
    "SELECT id, label, completion_emailed, archived FROM batches WHERE id=$1 AND agency_id=$2",
    [batchId, agencyId]
  )).rows[0];
  if (!batch || batch.completion_emailed || batch.archived) return;
  const counts = (await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='pending')::int AS pending,
            count(*) FILTER (WHERE status='confirmed')::int AS confirmed,
            count(*) FILTER (WHERE status='issue')::int AS flagged,
            count(*) FILTER (WHERE status='resolved')::int AS resolved
     FROM bookings WHERE batch_id=$1 AND agency_id=$2`, [batchId, agencyId]
  )).rows[0];
  if (!counts.total || counts.pending > 0) return; // not complete yet

  // claim the send atomically so concurrent responses can't double-send
  const claim = await pool.query(
    "UPDATE batches SET completion_emailed=true WHERE id=$1 AND agency_id=$2 AND completion_emailed=false",
    [batchId, agencyId]
  );
  if (!claim.rowCount) return; // someone else already sent it

  const team = (await pool.query("SELECT email FROM users WHERE agency_id=$1", [agencyId])).rows
    .map((u) => u.email).filter(Boolean);
  if (!team.length) return;

  const csv = await batchCsv(batchId, agencyId);
  const sender = await senderForAgency(agencyId);
  const label = batch.label || "this week";
  try {
    await sendMail({
      from: sender.from,
      replyTo: sender.replyTo,
      to: team,
      subject: `✅ All checks complete — ${label}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
          <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
          <p>Every act has now responded for <strong>${esc(label)}</strong>. Here's the summary:</p>
          <ul style="font-size:14px">
            <li><strong>${counts.confirmed}</strong> confirmed</li>
            <li><strong>${counts.flagged}</strong> flagged</li>
            ${counts.resolved ? `<li><strong>${counts.resolved}</strong> resolved</li>` : ""}
            <li><strong>${counts.total}</strong> gigs in total</li>
          </ul>
          <p>The full breakdown is attached as a CSV.</p>
          ${emailFooter(sender)}
        </div>`,
      attachments: [{
        filename: `gigconfirm-${(label || "week").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`,
        content: Buffer.from(csv, "utf8").toString("base64"),
      }],
    });
  } catch (e) {
    // if sending failed, un-claim so it can retry on the next response
    await pool.query("UPDATE batches SET completion_emailed=false WHERE id=$1 AND agency_id=$2", [batchId, agencyId]);
    console.error("completion email failed", e.message);
  }
}

// Each agency sends from <their prefix>@<shared domain>, e.g. ldagency@gigconfirm.co.uk,
// with the agency's display name. Also returns branding for the email templates.
// replyToEmail: if given (the logged-in user's address), replies route to that person
// so acts/venues reach whoever ran the checks, not the shared agency mailbox.
async function senderForAgency(agencyId, replyToEmail) {
  const replyTo = replyToEmail || undefined;
  try {
    const a = (await pool.query(
      "SELECT id, name, email_prefix, website, phone, (logo_data IS NOT NULL) AS has_logo FROM agencies WHERE id=$1",
      [agencyId]
    )).rows[0];
    if (a && a.email_prefix) {
      return {
        from: `${a.name} <${a.email_prefix}@${SEND_DOMAIN}>`,
        replyTo,
        logoUrl: a.has_logo ? `${APP_URL}/agency-logo/${a.id}` : `${APP_URL}/logo-email.png`,
        agencyName: a.name,
        website: a.website || "",
        phone: a.phone || "",
      };
    }
  } catch (_) { /* fall through to default */ }
  return { from: MAIL_FROM || `LD Agency <${SEND_ADDRESS}>`, replyTo,
           logoUrl: `${APP_URL}/logo-email.png`, agencyName: "GigConfirm", website: "", phone: "" };
}

// Helper: the logged-in user's email, for use as reply-to on sends they trigger.
async function userEmail(userId) {
  if (!userId) return null;
  try { return (await pool.query("SELECT email FROM users WHERE id=$1", [userId])).rows[0]?.email || null; }
  catch (_) { return null; }
}

// Shared email footer with the agency's website/phone, if set.
// Given a list of email addresses, return a map of address -> latest delivery status
// (bounced | complained | delivered | delivery_delayed) from the email_events log.
// Used to flag deliverability anywhere we show a recipient (venues, team, etc.).
async function latestEmailStatus(emails) {
  const list = [...new Set((emails || []).map((e) => (e || "").toLowerCase()).filter(Boolean))];
  if (!list.length) return {};
  const rows = (await pool.query(
    `SELECT DISTINCT ON (email) email, type
     FROM email_events
     WHERE email = ANY($1)
     ORDER BY email, created_at DESC`, [list]
  )).rows;
  const map = {};
  for (const r of rows) map[r.email] = r.type;
  return map;
}

function emailFooter(sender) {
  const bits = [];
  if (sender.website) bits.push(`<a href="${esc(sender.website)}" style="color:#888">${esc(sender.website)}</a>`);
  if (sender.phone) bits.push(esc(sender.phone));
  if (!bits.length) return "";
  return `<p style="color:#999;font-size:12px;margin-top:20px;border-top:1px solid #eee;padding-top:12px">${esc(sender.agencyName)} · ${bits.join(" · ")}</p>`;
}

// Stripe webhook must read the RAW body, so it's registered before express.json().
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send("Stripe not configured.");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("webhook signature failed", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    const obj = event.data.object;
    // Map subscription lifecycle onto the agency.
    if (event.type === "checkout.session.completed") {
      const agencyId = obj.metadata?.agencyId || obj.client_reference_id;
      if (agencyId) {
        await pool.query(
          "UPDATE agencies SET stripe_customer_id=$1, stripe_subscription_id=$2, sub_status='active', active=true WHERE id=$3",
          [obj.customer, obj.subscription, agencyId]
        );
        // bump discount usage if a promo code was used
        const code = obj.metadata?.discountCode;
        if (code) await pool.query("UPDATE discount_codes SET times_used=times_used+1 WHERE code=$1", [code]);
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const status = event.type === "customer.subscription.deleted" ? "canceled" : obj.status;
      const active = ACTIVE_STATUSES.has(status);
      await pool.query(
        "UPDATE agencies SET sub_status=$1, active=$2 WHERE stripe_subscription_id=$3",
        [status, active, obj.id]
      );
    }
    res.json({ received: true });
  } catch (e) {
    console.error("webhook handling error", e);
    res.status(500).send("handler error");
  }
});

app.use(express.json());
app.use(cookieParser());

// Resend delivery-event webhook (bounces, complaints, deliveries). Records the event
// and flags the affected act so the dashboard can warn about undeliverable addresses.
// Registered after express.json() is fine — we read req.body as parsed JSON here.
app.post("/api/resend-webhook", async (req, res) => {
  try {
    const evt = req.body || {};
    const type = (evt.type || "").replace(/^email\./, ""); // bounced | delivered | complained | delivery_delayed
    const recipients = Array.isArray(evt.data?.to) ? evt.data.to : (evt.data?.to ? [evt.data.to] : []);
    const detail = evt.data?.bounce?.message || evt.data?.bounce?.subType || null;
    for (const addr of recipients) {
      const email = (addr || "").toLowerCase();
      if (!email) continue;

      // Figure out which agency this address belongs to. Check acts first, then
      // venues (whose email field may hold several comma/semicolon addresses), then
      // users. This lets bounces for venue and team emails be attributed correctly.
      let agencyId = null;
      const act = (await pool.query("SELECT agency_id FROM acts WHERE lower(email)=$1", [email])).rows[0];
      if (act) agencyId = act.agency_id;
      if (!agencyId) {
        const venue = (await pool.query(
          `SELECT agency_id FROM venues
           WHERE email IS NOT NULL AND position($1 in lower(email)) > 0 LIMIT 1`, [email]
        )).rows[0];
        if (venue) agencyId = venue.agency_id;
      }
      if (!agencyId) {
        const user = (await pool.query("SELECT agency_id FROM users WHERE lower(email)=$1", [email])).rows[0];
        if (user) agencyId = user.agency_id;
      }

      await pool.query(
        "INSERT INTO email_events (agency_id, email, type, detail) VALUES ($1,$2,$3,$4)",
        [agencyId, email, type, detail]
      );

      // Update the act's rolling email status if this address is an act.
      if (act) {
        if (type === "bounced" || type === "complained") {
          await pool.query("UPDATE acts SET email_status=$1, email_status_at=now() WHERE lower(email)=$2 AND agency_id=$3",
            [type, email, act.agency_id]);
        } else if (type === "delivered") {
          await pool.query("UPDATE acts SET email_status='delivered', email_status_at=now() WHERE lower(email)=$1 AND agency_id=$2 AND (email_status IS NULL OR email_status <> 'complained')",
            [email, act.agency_id]);
        }
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error("resend webhook error", e);
    res.status(200).json({ received: true }); // 200 so Resend doesn't hammer retries
  }
});

// ---------- helpers ----------
const normKey = (s) => (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
const norm = (s) => (s || "").toString().trim();
const esc = (s) => (s || "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Strip decorative words so "Blue Dolphin Holiday Park" and "Blue Dolphin" match.
// Used only for fuzzy matching, never as the stored key.
const VENUE_FILLER = /\b(holiday|park|parks|resort|resorts|country|village|hp|haven|the|hotel|spa|leisure|caravan|centre|center|parcs|club|estates|complex|coastal|of|at|on|sea)\b/g;
function fuzzyVenue(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(VENUE_FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Resolve a booking's venue text to an EXISTING stored venue, tolerating naming
// differences. Returns the stored venue's exact key, or null if no safe match.
// Strategy: exact key → fuzzy-equal → one side's words fully contained in the other.
async function resolveVenueKey(venueText, storedList) {
  const exactKey = normKey(venueText);
  if (!venueText) return null;
  // storedList is always supplied by callers (already agency-scoped). Never query
  // all venues here — that would ignore agency boundaries.
  const stored = storedList || [];
  // 1. exact
  if (stored.some((v) => v.name === exactKey)) return exactKey;
  // 2. fuzzy-equal — but if MORE THAN ONE stored venue is fuzzy-equal, it's
  //    ambiguous (e.g. two "Golden Sands"), so refuse rather than guess wrong.
  const fb = fuzzyVenue(venueText);
  if (!fb) return null;
  const fuzzyHits = stored.filter((v) => fuzzyVenue(v.display_name) === fb);
  if (fuzzyHits.length === 1) return fuzzyHits[0].name;
  if (fuzzyHits.length > 1) return null; // ambiguous → leave for manual assignment
  // 3. subset (all words of one appear in the other) with a distinctive shared
  //    word — again, only if exactly one stored venue qualifies.
  const bt = new Set(fb.split(" ").filter(Boolean));
  const subsetHits = [];
  for (const v of stored) {
    const ct = new Set(fuzzyVenue(v.display_name).split(" ").filter(Boolean));
    if (!bt.size || !ct.size) continue;
    const inter = [...bt].filter((w) => ct.has(w));
    const subset = inter.length === bt.size || inter.length === ct.size;
    const distinctive = inter.some((w) => w.length >= 3);
    if (subset && distinctive) subsetHits.push(v.name);
  }
  if (subsetHits.length === 1) return subsetHits[0];
  return null; // none, or ambiguous
}

// Booking-system exports are often Windows/Latin-1, not UTF-8, so "£" arrives as a
// stray byte. Decode as UTF-8 first; if that produces replacement chars, fall back to Latin-1.
function decodeCsv(buffer) {
  if (!buffer) return undefined;
  const asUtf8 = buffer.toString("utf8");
  if (asUtf8.includes("\uFFFD")) {
    return buffer.toString("latin1");
  }
  return asUtf8;
}

// Parse a decoded CSV string robustly: strip a BOM, skip any leading title rows
// (some exports put a sheet title on line 1 above the real headers), and let Papa
// auto-detect the delimiter (handles Excel exports using ";" or tabs).
function parseCsv(text) {
  if (!text) return [];
  let clean = text.replace(/^\uFEFF/, "");

  // Find the real header line: the first line that contains a column we recognise.
  // This skips a stray title row like "gig confirm sheet" sitting above the headers.
  const lines = clean.split(/\r?\n/);
  const headerHints = ["act", "venue", "email", "date"];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const low = lines[i].toLowerCase();
    const hits = headerHints.filter((h) => low.includes(h)).length;
    if (hits >= 2) { headerIdx = i; break; }
  }
  if (headerIdx > 0) clean = lines.slice(headerIdx).join("\n");

  const res = Papa.parse(clean, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return res.data;
}

function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const hit = keys.find((k) => normKey(k) === normKey(c));
    if (hit) return norm(row[hit]);
  }
  for (const c of candidates) {
    const hit = keys.find((k) => normKey(k).includes(normKey(c)));
    if (hit) return norm(row[hit]);
  }
  return "";
}

// ---------- auth: per-user login, agency-scoped sessions ----------
// Encrypt/decrypt cloud-storage refresh tokens at rest (AES-256-GCM). The key is
// derived from TOKEN_ENC_KEY (or CRON_SECRET as a fallback) so tokens are never stored
// in plaintext.
const _encKey = crypto.createHash("sha256").update(String(TOKEN_ENC_KEY || CRON_SECRET || "gigconfirm-fallback-key")).digest();
function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", _encKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}
function decryptToken(blob) {
  const [ivh, tagh, dh] = String(blob).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", _encKey, Buffer.from(ivh, "hex"));
  decipher.setAuthTag(Buffer.from(tagh, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dh, "hex")), decipher.final()]).toString("utf8");
}

// Password hashing with Node's built-in scrypt (no extra dependency).
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Sessions map a random token -> { userId, agencyId }. Kept in memory; on restart
// users simply log in again.
const sessions = new Map();
function makeToken() { return nanoid(40); }

// Look up the current session from the cookie. Returns { userId, agencyId } or null.
function sessionFor(req) {
  const t = req.cookies?.gc_admin;
  return (t && sessions.get(t)) || null;
}

// Gate for all admin routes. Also attaches req.agencyId / req.userId for scoping.
function requireAdmin(req, res, next) {
  const s = sessionFor(req);
  if (s) {
    req.agencyId = s.agencyId;
    req.userId = s.userId;
    req.isAdmin = !!s.isAdmin;
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not signed in." });
  return res.redirect("/login.html");
}

// Gate for platform-admin-only routes (discount management, etc.).
function requirePlatformAdmin(req, res, next) {
  const s = sessionFor(req);
  if (s && s.isAdmin) { req.agencyId = s.agencyId; req.userId = s.userId; req.isAdmin = true; return next(); }
  return res.status(403).json({ error: "Admin only." });
}

app.post("/api/login", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const password = req.body?.password || "";
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  const user = (await pool.query(
    `SELECT u.*, a.active AS agency_active, a.sub_status FROM users u
     JOIN agencies a ON a.id = u.agency_id WHERE u.email=$1`, [email]
  )).rows[0];
  if (!user || !verifyPassword(password, user.pass_hash)) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  // We allow login even when the subscription is inactive — the dashboard will send
  // them to the billing page. This lets a lapsed agency log in to pay again.
  const t = makeToken();
  sessions.set(t, { userId: user.id, agencyId: user.agency_id, isAdmin: !!user.is_admin });
  res.cookie("gc_admin", t, { httpOnly: true, sameSite: "lax", secure: APP_URL.startsWith("https"), maxAge: 7 * 864e5 });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const t = req.cookies?.gc_admin;
  if (t) sessions.delete(t);
  res.clearCookie("gc_admin");
  res.json({ ok: true });
});

// ---------- public signup (Stage C) ----------
// Prefixes that can't be taken (system/role addresses, and the founding agency).
const RESERVED_PREFIXES = new Set([
  "admin", "administrator", "info", "hello", "support", "help", "noreply", "no-reply",
  "postmaster", "webmaster", "billing", "sales", "contact", "team", "root", "gigs",
  "gigconfirm", "mail", "email", "test", "ldagency",
]);

function normalisePrefix(raw) {
  return (raw || "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
}
function prefixError(prefix) {
  if (!prefix) return "Choose an email prefix.";
  if (prefix.length < 3) return "Prefix must be at least 3 characters.";
  if (prefix.length > 30) return "Prefix must be 30 characters or fewer.";
  if (!/^[a-z0-9-]+$/.test(prefix)) return "Use only lowercase letters, numbers and hyphens.";
  if (/^-|-$/.test(prefix)) return "Prefix can't start or end with a hyphen.";
  if (RESERVED_PREFIXES.has(prefix)) return "That prefix isn't available.";
  return null;
}

// Live availability check for the signup form.
app.get("/api/check-prefix", async (req, res) => {
  const prefix = normalisePrefix(req.query.prefix);
  const err = prefixError(prefix);
  if (err) return res.json({ available: false, reason: err, prefix });
  const taken = (await pool.query("SELECT 1 FROM agencies WHERE email_prefix=$1", [prefix])).rows[0];
  res.json({ available: !taken, reason: taken ? "That prefix is already taken." : null, prefix });
});

app.post("/api/signup", async (req, res) => {
  try {
    const agencyName = (req.body?.agencyName || "").trim();
    const prefix = normalisePrefix(req.body?.prefix);
    const userName = (req.body?.userName || "").trim();
    const email = (req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password || "";

    if (!agencyName) return res.status(400).json({ error: "Enter your agency name." });
    const pErr = prefixError(prefix);
    if (pErr) return res.status(400).json({ error: pErr });
    if (!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    // uniqueness checks
    if ((await pool.query("SELECT 1 FROM agencies WHERE email_prefix=$1", [prefix])).rows[0])
      return res.status(409).json({ error: "That email prefix is already taken." });
    if ((await pool.query("SELECT 1 FROM users WHERE email=$1", [email])).rows[0])
      return res.status(409).json({ error: "That email is already registered." });

    const agencyId = nanoid(16);
    await pool.query(
      "INSERT INTO agencies (id, name, email_prefix, active) VALUES ($1,$2,$3,true)",
      [agencyId, agencyName, prefix]
    );
    const userId = nanoid(16);
    await pool.query(
      "INSERT INTO users (id, agency_id, email, name, pass_hash, is_owner) VALUES ($1,$2,$3,$4,$5,true)",
      [userId, agencyId, email, userName || null, hashPassword(password)]
    );
    // start them with an active week so the dashboard has somewhere to put a first upload
    await pool.query(
      "INSERT INTO batches (id, agency_id, label, archived) VALUES ($1,$2,$3,false)",
      [nanoid(16), agencyId, "Current week"]
    );

    // log them straight in
    const t = makeToken();
    sessions.set(t, { userId, agencyId });
    res.cookie("gc_admin", t, { httpOnly: true, sameSite: "lax", secure: APP_URL.startsWith("https"), maxAge: 7 * 864e5 });
    res.json({ ok: true });

    // Alert the platform admin that a new agency has signed up (best-effort — never
    // blocks or fails the signup itself).
    notifyNewAgency({ agencyName, prefix, userName, email }).catch((e) =>
      console.error("new-agency alert failed", e.message)
    );
  } catch (e) {
    console.error("signup failed", e);
    res.status(500).json({ error: "Couldn't complete signup: " + e.message });
  }
});

// Public contact form — emails the platform owner. No auth (it's a public page), but
// lightly rate-limited per-process to deter abuse.
const contactHits = [];
app.post("/api/contact", async (req, res) => {
  try {
    const name = (req.body?.name || "").toString().trim().slice(0, 120);
    const from = (req.body?.email || "").toString().trim().slice(0, 160);
    const agency = (req.body?.agency || "").toString().trim().slice(0, 160);
    const message = (req.body?.message || "").toString().trim().slice(0, 4000);
    if (!name || !from || !message) return res.status(400).json({ error: "Please fill in your name, email and message." });
    if (!/\S+@\S+\.\S+/.test(from)) return res.status(400).json({ error: "That email doesn't look valid." });

    // simple rolling rate limit: max 5 messages per 10 minutes per process
    const now = Date.now();
    while (contactHits.length && now - contactHits[0] > 600000) contactHits.shift();
    if (contactHits.length >= 5) return res.status(429).json({ error: "Too many messages just now — please try again shortly." });
    contactHits.push(now);

    if (!resend) return res.status(500).json({ error: "Messaging isn't configured right now." });
    const to = ADMIN_ALERT_EMAIL ? ADMIN_ALERT_EMAIL.split(",").map((s) => s.trim()).filter(Boolean) : ["phil@phil-freeman.co.uk"];
    await sendMail({
      from: MAIL_FROM || `GigConfirm <${SEND_ADDRESS}>`,
      to,
      replyTo: from,     // so you can reply straight to the sender
      subject: `Contact form: ${name}${agency ? " (" + agency + ")" : ""}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
          <h2 style="margin:0 0 10px">New message via GigConfirm</h2>
          <table style="border-collapse:collapse;font-size:14px;margin-bottom:12px">
            <tr><td style="padding:4px 12px 4px 0;color:#667"><b>Name</b></td><td style="padding:4px 0">${esc(name)}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#667"><b>Email</b></td><td style="padding:4px 0">${esc(from)}</td></tr>
            ${agency ? `<tr><td style="padding:4px 12px 4px 0;color:#667"><b>Agency</b></td><td style="padding:4px 0">${esc(agency)}</td></tr>` : ""}
          </table>
          <div style="white-space:pre-wrap;background:#f4f7fa;border-radius:8px;padding:12px 14px;font-size:14px">${esc(message)}</div>
          <p style="margin:14px 0 0;color:#889;font-size:12px">Reply to this email to respond directly to ${esc(name)}.</p>
        </div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("contact form failed", e);
    res.status(500).json({ error: "Couldn't send your message. Please email phil@phil-freeman.co.uk directly." });
  }
});

// Email the platform admin(s) when a new agency joins.
async function notifyNewAgency({ agencyName, prefix, userName, email }) {
  if (!resend) return;
  // Recipients: the ADMIN_ALERT_EMAIL override if set, otherwise every platform admin.
  let recipients = [];
  if (ADMIN_ALERT_EMAIL) {
    recipients = ADMIN_ALERT_EMAIL.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    recipients = (await pool.query("SELECT email FROM users WHERE is_admin=true")).rows.map((r) => r.email).filter(Boolean);
  }
  if (!recipients.length) return;
  await sendMail({
    from: MAIL_FROM || `GigConfirm <${SEND_ADDRESS}>`,
    to: recipients,
    subject: `New agency signed up: ${agencyName}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
        <h2 style="margin:0 0 10px">New agency on GigConfirm 🎉</h2>
        <p style="margin:0 0 12px">A new agency just signed up:</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0;color:#667"><b>Agency</b></td><td style="padding:4px 0">${esc(agencyName)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#667"><b>Email prefix</b></td><td style="padding:4px 0">${esc(prefix)}@${esc(SEND_DOMAIN)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#667"><b>Owner</b></td><td style="padding:4px 0">${esc(userName || "—")}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#667"><b>Login email</b></td><td style="padding:4px 0">${esc(email)}</td></tr>
        </table>
        <p style="margin:14px 0 0;color:#889;font-size:12px">Sent automatically by GigConfirm.</p>
      </div>`,
  });
}

// Who am I — used by the dashboard to show the logged-in user & agency.
app.get("/api/me", requireAdmin, async (req, res) => {
  const u = (await pool.query(
    `SELECT u.name, u.email, u.is_admin, u.is_owner, u.notifs_seen_at, a.name AS agency_name, a.email_prefix,
            a.sub_status, a.active, a.id AS agency_id, (a.logo_data IS NOT NULL) AS has_logo
     FROM users u JOIN agencies a ON a.id=u.agency_id WHERE u.id=$1`, [req.userId]
  )).rows[0] || {};
  const hasBookings = (await pool.query("SELECT 1 FROM bookings WHERE agency_id=$1 LIMIT 1", [req.agencyId])).rows[0];
  u.isNew = !hasBookings;
  u.needsSubscription = !(ACTIVE_STATUSES.has(u.sub_status) || u.active === true);
  res.json(u);
});

// Public config for the marketing/billing pages (no auth).
app.get("/api/public-config", (req, res) => {
  res.json({ price: PRICE_DISPLAY, billingEnabled: !!(stripe && STRIPE_PRICE_ID) });
});

// ---------- notifications ----------
// Gathers things needing attention for this agency: bounced emails, flagged gigs,
// and billing problems. Anything newer than the user's notifs_seen_at is "unread".
app.get("/api/notifications", requireAdmin, async (req, res) => {
  const items = [];

  // 1) bounced / spam-complaint emails for this agency (last 30 days). Include the
  // bounce detail/reason and identify what kind of recipient the address is.
  const bounces = (await pool.query(
    `SELECT DISTINCT ON (ee.email) ee.email, ee.type, ee.detail, ee.created_at,
            (SELECT a.name FROM acts a WHERE lower(a.email)=ee.email AND a.agency_id=$1 LIMIT 1) AS act_name,
            (SELECT v.display_name FROM venues v WHERE v.agency_id=$1 AND v.email IS NOT NULL
               AND position(ee.email in lower(v.email))>0 LIMIT 1) AS venue_name,
            (SELECT u.name FROM users u WHERE lower(u.email)=ee.email AND u.agency_id=$1 LIMIT 1) AS user_name
     FROM email_events ee
     WHERE ee.agency_id=$1 AND ee.type IN ('bounced','complained')
       AND ee.created_at > now() - interval '30 days'
     ORDER BY ee.email, ee.created_at DESC`, [req.agencyId]
  )).rows;
  for (const b of bounces) {
    // describe who the address belongs to
    let who = b.email;
    if (b.act_name) who = `${b.act_name} (act · ${b.email})`;
    else if (b.venue_name) who = `${b.venue_name} (venue · ${b.email})`;
    else if (b.user_name) who = `${b.user_name} (team · ${b.email})`;
    const verb = b.type === "complained" ? "was marked as spam" : "bounced";
    items.push({
      type: "bounce",
      at: b.created_at,
      text: `Email to ${who} ${verb}`,
      detail: b.detail || (b.type === "complained"
        ? "The recipient's mail provider flagged this as spam."
        : "The address may be wrong, full, or no longer exist."),
      target: b.venue_name ? "venues" : "acts",
    });
  }

  // 2) gigs an act flagged as an issue, in the current (non-archived) batch
  const flagged = (await pool.query(
    `SELECT bk.id, bk.responded_at, bk.message, a.name AS act_name,
            COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS venue
     FROM bookings bk
     JOIN acts a ON a.id=bk.act_id
     LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
     LEFT JOIN batches ba ON ba.id=bk.batch_id
     WHERE bk.agency_id=$1 AND bk.status='issue' AND COALESCE(ba.archived,false)=false
     ORDER BY bk.responded_at DESC NULLS LAST`, [req.agencyId]
  )).rows;
  for (const f of flagged) {
    items.push({
      type: "issue",
      at: f.responded_at || new Date(0).toISOString(),
      text: `${f.act_name} flagged an issue with ${f.venue || "a gig"}`,
      detail: f.message ? `“${f.message}”` : "No message left — you may want to check with them.",
      target: "bookings",
    });
  }

  // 3) billing alerts for this agency. Uses a stable timestamp (the agency's created
  // time) so it doesn't count as "new" on every refresh once read.
  const ag = (await pool.query("SELECT sub_status, created_at FROM agencies WHERE id=$1", [req.agencyId])).rows[0];
  if (ag && (ag.sub_status === "past_due" || ag.sub_status === "canceled")) {
    items.push({
      type: "billing",
      at: ag.created_at || new Date(0).toISOString(),
      text: ag.sub_status === "past_due"
        ? "Your last subscription payment failed."
        : "Your subscription is cancelled.",
      detail: ag.sub_status === "past_due"
        ? "Please update your billing to keep sending confirmations."
        : "Resubscribe to keep sending confirmations.",
      target: "billing",
    });
  }

  // sort newest first
  items.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  // A "mark all read" records notifs_seen_at = now. Items at or before that marker are
  // treated as dismissed and excluded, so they don't reappear on refresh. Only things
  // that happen *after* the last dismissal show up.
  const u = (await pool.query("SELECT notifs_seen_at FROM users WHERE id=$1", [req.userId])).rows[0];
  const seenAt = u?.notifs_seen_at ? new Date(u.notifs_seen_at) : null;
  const visible = seenAt ? items.filter((i) => new Date(i.at || 0) > seenAt) : items;
  const unread = visible.length;

  res.json({ items: visible, unread });
});

// Mark notifications as seen (updates the last-seen marker to now).
app.post("/api/notifications/seen", requireAdmin, async (req, res) => {
  await pool.query("UPDATE users SET notifs_seen_at=now() WHERE id=$1", [req.userId]);
  res.json({ ok: true });
});

// ---------- billing (Stripe) ----------
// Start a checkout for the monthly plan, optionally with a discount code.
app.post("/api/create-checkout", requireAdmin, async (req, res) => {
  try {
    if (!stripe || !STRIPE_PRICE_ID) return res.status(500).json({ error: "Billing isn't configured yet." });
    const agency = (await pool.query("SELECT * FROM agencies WHERE id=$1", [req.agencyId])).rows[0];
    const codeStr = (req.body?.code || "").trim().toUpperCase();

    // resolve a discount code -> Stripe coupon
    let discounts;
    let usedCode = null;
    if (codeStr) {
      const dc = (await pool.query("SELECT * FROM discount_codes WHERE code=$1 AND active=true", [codeStr])).rows[0];
      if (!dc) return res.status(400).json({ error: "That discount code isn't valid." });
      const couponId = await ensureStripeCoupon(dc);
      discounts = [{ coupon: couponId }];
      usedCode = dc.code;
    }

    // ensure a Stripe customer exists for this agency
    let customerId = agency.stripe_customer_id;
    if (!customerId) {
      const c = await stripe.customers.create({ name: agency.name, metadata: { agencyId: agency.id } });
      customerId = c.id;
      await pool.query("UPDATE agencies SET stripe_customer_id=$1 WHERE id=$2", [customerId, agency.id]);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      discounts,
      client_reference_id: agency.id,
      metadata: { agencyId: agency.id, discountCode: usedCode || "" },
      subscription_data: { metadata: { agencyId: agency.id } },
      success_url: `${APP_URL}/dashboard.html?sub=success`,
      cancel_url: `${APP_URL}/billing.html?sub=cancelled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    res.status(500).json({ error: e.message });
  }
});

// Open Stripe's billing portal so they can manage/cancel their subscription.
app.post("/api/billing-portal", requireAdmin, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Billing isn't configured." });
    const agency = (await pool.query("SELECT stripe_customer_id FROM agencies WHERE id=$1", [req.agencyId])).rows[0];
    if (!agency?.stripe_customer_id) return res.status(400).json({ error: "No billing account yet." });
    const portal = await stripe.billingPortal.sessions.create({
      customer: agency.stripe_customer_id,
      return_url: `${APP_URL}/dashboard.html`,
    });
    res.json({ url: portal.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Validate a discount code for the signup/billing page (shows the effect).
app.get("/api/check-code", async (req, res) => {
  const code = (req.query.code || "").toString().trim().toUpperCase();
  if (!code) return res.json({ valid: false });
  const dc = (await pool.query("SELECT code, kind, value, duration FROM discount_codes WHERE code=$1 AND active=true", [code])).rows[0];
  if (!dc) return res.json({ valid: false, reason: "Not a valid code." });
  const desc = dc.kind === "percent" ? `${dc.value}% off` : `£${(dc.value/100).toFixed(2)} off`;
  res.json({ valid: true, description: desc + (dc.duration === "forever" ? " (ongoing)" : " (first payment)") });
});

// Create the Stripe coupon for a discount code if it doesn't have one yet.
async function ensureStripeCoupon(dc) {
  if (dc.stripe_coupon_id) return dc.stripe_coupon_id;
  const params = { duration: dc.duration === "forever" ? "forever" : "once" };
  if (dc.kind === "percent") params.percent_off = dc.value;
  else { params.amount_off = dc.value; params.currency = "gbp"; }
  const coupon = await stripe.coupons.create(params);
  await pool.query("UPDATE discount_codes SET stripe_coupon_id=$1 WHERE code=$2", [coupon.id, dc.code]);
  return coupon.id;
}

// ---------- discount codes (platform admin) ----------
app.get("/api/discounts", requirePlatformAdmin, async (req, res) => {
  const rows = (await pool.query("SELECT code, kind, value, duration, active, times_used FROM discount_codes ORDER BY created_at DESC")).rows;
  res.json({ codes: rows });
});

app.post("/api/discounts", requirePlatformAdmin, async (req, res) => {
  try {
    const code = (req.body?.code || "").trim().toUpperCase();
    const kind = req.body?.kind === "amount" ? "amount" : "percent";
    const duration = req.body?.duration === "forever" ? "forever" : "once";
    let value = parseInt(req.body?.value, 10);
    if (!/^[A-Z0-9]{3,40}$/.test(code)) return res.status(400).json({ error: "Code must be 3–40 letters/numbers." });
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: "Enter a positive value." });
    if (kind === "percent" && value > 100) return res.status(400).json({ error: "Percent can't exceed 100." });
    const exists = (await pool.query("SELECT 1 FROM discount_codes WHERE code=$1", [code])).rows[0];
    if (exists) return res.status(409).json({ error: "That code already exists." });
    await pool.query(
      "INSERT INTO discount_codes (code, kind, value, duration, active) VALUES ($1,$2,$3,$4,true)",
      [code, kind, value, duration]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/discounts/toggle", requirePlatformAdmin, async (req, res) => {
  const code = (req.body?.code || "").trim().toUpperCase();
  await pool.query("UPDATE discount_codes SET active = NOT active WHERE code=$1", [code]);
  res.json({ ok: true });
});

app.post("/api/discounts/delete", requirePlatformAdmin, async (req, res) => {
  const code = (req.body?.code || "").trim().toUpperCase();
  await pool.query("DELETE FROM discount_codes WHERE code=$1", [code]);
  res.json({ ok: true });
});

// ---------- subscribers overview (platform admin) ----------
app.get("/api/subscribers", requirePlatformAdmin, async (req, res) => {
  const agencies = (await pool.query(
    `SELECT a.id, a.name, a.email_prefix, a.sub_status, a.active, a.created_at,
            (SELECT count(*)::int FROM users u WHERE u.agency_id=a.id) AS user_count,
            (SELECT count(*)::int FROM bookings b WHERE b.agency_id=a.id) AS booking_count
     FROM agencies a ORDER BY a.created_at DESC`
  )).rows;
  const users = (await pool.query(
    "SELECT id, agency_id, name, email, is_admin FROM users ORDER BY created_at"
  )).rows;
  const statusMap = await latestEmailStatus(users.map((u) => u.email));
  for (const u of users) u.email_status = statusMap[(u.email || "").toLowerCase()] || null;
  // nest users under their agency
  const byAgency = {};
  for (const u of users) (byAgency[u.agency_id] ||= []).push(u);
  for (const a of agencies) a.users = byAgency[a.id] || [];
  res.json({ agencies });
});

// Reset a user's password to a fresh random one and email it to them.
app.post("/api/reset-user-password", requirePlatformAdmin, async (req, res) => {
  try {
    const userId = (req.body?.userId || "").toString();
    const user = (await pool.query(
      `SELECT u.id, u.email, u.name, u.agency_id, a.name AS agency_name
       FROM users u JOIN agencies a ON a.id=u.agency_id WHERE u.id=$1`, [userId]
    )).rows[0];
    if (!user) return res.status(404).json({ error: "No such user." });

    // generate a readable temporary password
    const newPass = "gc-" + nanoid(10);
    await pool.query("UPDATE users SET pass_hash=$1 WHERE id=$2", [hashPassword(newPass), userId]);

    let emailed = false, emailError = null;
    if (resend) {
      try {
        const sender = await senderForAgency(user.agency_id);
        await sendMail({
          from: sender.from,
          replyTo: sender.replyTo,
          to: user.email,
          subject: `Your GigConfirm password has been reset`,
          html: `
            <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
              <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
              <p>Hi${user.name ? " " + esc(user.name) : ""},</p>
              <p>Your GigConfirm password has been reset. Here are your updated login details:</p>
              <div style="background:#f5f3ee;border-radius:10px;padding:14px 16px;margin:14px 0">
                <div><strong>Email:</strong> ${esc(user.email)}</div>
                <div><strong>New password:</strong> ${esc(newPass)}</div>
              </div>
              <p style="text-align:center;margin:24px 0">
                <a href="${APP_URL}/login.html" style="background:#25d366;color:#0b1220;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">Sign in</a>
              </p>
              <p style="color:#666;font-size:13px">Please change it after signing in, under "Team &amp; account".</p>
              ${emailFooter(sender)}
            </div>
          `,
        });
        emailed = true;
      } catch (e) { emailError = e.message; console.error("reset email failed", e.message); }
    }
    // return the new password too, so the admin can pass it on if email failed
    res.json({ ok: true, emailed, emailError, newPass });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Permanently delete a whole agency and everything belonging to it (platform admin).
// Requires the exact agency name as confirmation. The founding agency can't be deleted.
app.post("/api/delete-agency", requirePlatformAdmin, async (req, res) => {
  const agencyId = (req.body?.agencyId || "").toString();
  const confirmName = (req.body?.confirmName || "").toString().trim();
  if (agencyId === "ld-agency") return res.status(400).json({ error: "The founding agency can't be deleted." });

  const agency = (await pool.query("SELECT id, name FROM agencies WHERE id=$1", [agencyId])).rows[0];
  if (!agency) return res.status(404).json({ error: "No such agency." });
  if (confirmName !== agency.name) {
    return res.status(400).json({ error: "The name you typed doesn't match. Deletion cancelled." });
  }
  // Guard against deleting your own agency (you're operating as platform admin).
  if (agencyId === req.agencyId) return res.status(400).json({ error: "You can't delete the agency you're signed in under." });

  // Cancel any live Stripe subscription first, so they aren't billed after deletion.
  try {
    const sub = (await pool.query("SELECT stripe_subscription_id FROM agencies WHERE id=$1", [agencyId])).rows[0];
    if (stripe && sub?.stripe_subscription_id) {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id).catch((e) => console.error("stripe cancel on delete failed", e.message));
    }
  } catch (e) { console.error("stripe cancel lookup failed", e.message); }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Only delete from tables that actually have an agency_id column on THIS database
    // (older DBs may differ). Anything with an ON DELETE CASCADE FK is also cleaned up
    // automatically when the agency row goes, so this is belt-and-braces.
    const candidates = ["bookings", "batches", "acts", "venues", "settings", "email_events", "users"];
    for (const t of candidates) {
      const hasCol = (await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='agency_id' LIMIT 1`, [t]
      )).rows[0];
      if (hasCol) await client.query(`DELETE FROM ${t} WHERE agency_id=$1`, [agencyId]);
    }
    await client.query("DELETE FROM agencies WHERE id=$1", [agencyId]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("delete-agency failed", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Diagnostic: show the most recent email delivery events recorded (platform admin).
// Lets us confirm whether Resend webhooks are actually landing and being stored.
// Diagnostic: show stored performer_name per booking for an act, so we can confirm
// whether per-gig stage names were captured from the CSV (platform admin only).
app.get("/api/debug-performer", requirePlatformAdmin, async (req, res) => {
  const act = (req.query.act || "").toString();
  const rows = (await pool.query(
    `SELECT bk.id, bk.performer_name, a.name AS account_name,
            COALESCE(NULLIF(bk.venue_text,''), '') AS venue, bk.gig_date, bk.created_at
     FROM bookings bk JOIN acts a ON a.id=bk.act_id
     WHERE bk.act_id=$1 AND bk.agency_id=$2
     ORDER BY bk.created_at DESC LIMIT 50`, [act, req.agencyId]
  )).rows;
  res.json({ act, bookings: rows });
});

app.get("/api/email-events", requirePlatformAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT email, type, agency_id, detail, created_at
     FROM email_events ORDER BY created_at DESC LIMIT 50`
  )).rows;
  const total = (await pool.query("SELECT count(*)::int AS n FROM email_events")).rows[0].n;
  res.json({ total, recent: rows });
});

// ---------- team / user management (within the agency) ----------
app.get("/api/users", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    "SELECT id, name, email, created_at FROM users WHERE agency_id=$1 ORDER BY created_at", [req.agencyId]
  )).rows;
  const statusMap = await latestEmailStatus(rows.map((u) => u.email));
  for (const u of rows) u.email_status = statusMap[(u.email || "").toLowerCase()] || null;
  res.json({ users: rows, me: req.userId });
});

app.post("/api/add-user", requireAdmin, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    const email = (req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password || "";
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const exists = (await pool.query("SELECT 1 FROM users WHERE email=$1", [email])).rows[0];
    if (exists) return res.status(409).json({ error: "That email is already in use." });
    await pool.query(
      "INSERT INTO users (id, agency_id, email, name, pass_hash) VALUES ($1,$2,$3,$4,$5)",
      [nanoid(16), req.agencyId, email, name || null, hashPassword(password)]
    );

    // Email the new member their login details (best-effort — don't fail the add if
    // the email can't be sent; just report it back so the admin can share manually).
    let invited = false, inviteError = null;
    if (resend) {
      try {
        const sender = await senderForAgency(req.agencyId);
        const loginUrl = `${APP_URL}/login.html`;
        await sendMail({
          from: sender.from,
          replyTo: sender.replyTo,
          to: email,
          subject: `You've been added to ${sender.agencyName} on GigConfirm`,
          html: `
            <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
              <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
              <p>Hi${name ? " " + esc(name) : ""},</p>
              <p>You've been added to <strong>${esc(sender.agencyName)}</strong>'s GigConfirm account, so you can manage gig confirmations for the agency.</p>
              <p>Here are your login details:</p>
              <div style="background:#f5f3ee;border-radius:10px;padding:14px 16px;margin:14px 0">
                <div><strong>Email:</strong> ${esc(email)}</div>
                <div><strong>Password:</strong> ${esc(password)}</div>
              </div>
              <p style="text-align:center;margin:24px 0">
                <a href="${loginUrl}" style="background:#25d366;color:#0b1220;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">Sign in to GigConfirm</a>
              </p>
              <p style="color:#666;font-size:13px">For your security, please change your password after signing in — you can do it under "Team &amp; account".</p>
              ${emailFooter(sender)}
            </div>
          `,
        });
        invited = true;
      } catch (e) {
        inviteError = e.message;
        console.error("invite email failed for", email, e.message);
      }
    }
    res.json({ ok: true, invited, inviteError });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/delete-user", requireAdmin, async (req, res) => {
  const id = (req.body?.id || "").toString();
  if (id === req.userId) return res.status(400).json({ error: "You can't delete your own account." });
  // count remaining users so an agency can't be left with none
  const n = (await pool.query("SELECT count(*)::int AS n FROM users WHERE agency_id=$1", [req.agencyId])).rows[0].n;
  if (n <= 1) return res.status(400).json({ error: "An agency must keep at least one user." });
  await pool.query("DELETE FROM users WHERE id=$1 AND agency_id=$2", [id, req.agencyId]);
  res.json({ ok: true });
});

// Change your own password.
app.post("/api/change-password", requireAdmin, async (req, res) => {
  const current = req.body?.current || "";
  const next = req.body?.next || "";
  if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  const u = (await pool.query("SELECT pass_hash FROM users WHERE id=$1", [req.userId])).rows[0];
  if (!u || !verifyPassword(current, u.pass_hash)) return res.status(403).json({ error: "Current password is wrong." });
  await pool.query("UPDATE users SET pass_hash=$1 WHERE id=$2", [hashPassword(next), req.userId]);
  res.json({ ok: true });
});

// ---------- agency branding (logo, website, phone) ----------
app.get("/api/agency", requireAdmin, async (req, res) => {
  const a = (await pool.query(
    "SELECT id, name, email_prefix, website, phone, (logo_data IS NOT NULL) AS has_logo FROM agencies WHERE id=$1",
    [req.agencyId]
  )).rows[0];
  res.json(a || {});
});

app.post("/api/agency", requireAdmin, async (req, res) => {
  const website = (req.body?.website || "").trim().slice(0, 200);
  const phone = (req.body?.phone || "").trim().slice(0, 40);
  await pool.query("UPDATE agencies SET website=$1, phone=$2 WHERE id=$3", [website, phone, req.agencyId]);
  res.json({ ok: true });
});

// Upload a logo image (stored in the DB as a data URI so it survives redeploys).
app.post("/api/agency-logo", requireAdmin, upload.single("logo"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: "No image received." });
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.mimetype)) {
      return res.status(400).json({ error: "Please upload a PNG, JPG, GIF or WebP image." });
    }
    if (f.buffer.length > 500 * 1024) {
      return res.status(400).json({ error: "Image is too large — please use one under 500 KB." });
    }
    const dataUri = `data:${f.mimetype};base64,${f.buffer.toString("base64")}`;
    await pool.query("UPDATE agencies SET logo_data=$1 WHERE id=$2", [dataUri, req.agencyId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve an agency's logo publicly (emails link here). No auth: it's just a logo,
// and email clients can't send cookies anyway.
app.get("/agency-logo/:id", async (req, res) => {
  const row = (await pool.query("SELECT logo_data FROM agencies WHERE id=$1", [req.params.id])).rows[0];
  if (!row || !row.logo_data) {
    // fall back to the default GigConfirm/LD logo
    return res.redirect("/logo.png");
  }
  const m = row.logo_data.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return res.redirect("/logo.png");
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(Buffer.from(m[2], "base64"));
});




// ---------- CSV upload + match (admin) ----------
// Import venue rows (from a parsed contacts CSV) into the venues table, upserting by
// name. Reads up to 3 contacts (name/role/phone/email each) plus address. Returns a count.
async function importVenueRows(agencyId, crows) {
  let count = 0;
  const touchedKeys = new Set();   // normalized venue keys present/created from this file
  // Preload this agency's groups (brands) so we can match/create by name.
  const brandRows = (await pool.query("SELECT id, name, office_email FROM brands WHERE agency_id=$1", [agencyId])).rows;
  const brandByName = new Map(brandRows.map((b) => [normKey(b.name), b]));
  let groupsCreated = 0, renamed = 0;

  for (const r of crows) {
    const display = pick(r, ["venue", "location", "place"]);
    if (!display) continue;
    const newKey = normKey(display);
    // Optional hidden identity column (from the export) so we can track renames.
    const oldKey = normKey(pick(r, ["venue key", "venuekey", "key", "id"]));

    // Resolve the venue's group / parent company (create it if new; update its
    // head-office email if the file provides one).
    const groupName = pick(r, ["group", "parent company", "parent", "brand", "venue group"]);
    const groupEmail = pick(r, ["head office email", "office email", "group email", "head office"]);
    let brandId = null;
    if (groupName) {
      const key = normKey(groupName);
      let brand = brandByName.get(key);
      if (!brand) {
        const newId = nanoid(16);
        await pool.query("INSERT INTO brands (id, agency_id, name, office_email) VALUES ($1,$2,$3,$4)",
          [newId, agencyId, groupName, groupEmail || null]);
        brand = { id: newId, name: groupName, office_email: groupEmail || null };
        brandByName.set(key, brand);
        groupsCreated++;
      } else if (groupEmail && groupEmail !== brand.office_email) {
        await pool.query("UPDATE brands SET office_email=$1 WHERE id=$2 AND agency_id=$3", [groupEmail, brand.id, agencyId]);
        brand.office_email = groupEmail;
      }
      brandId = brand.id;
    }

    // Rename handling: if the file carries an old key that differs from the new name, and
    // that old venue exists, rename it (and re-point its bookings) before upserting.
    if (oldKey && oldKey !== newKey) {
      const oldV = (await pool.query("SELECT name FROM venues WHERE name=$1 AND agency_id=$2", [oldKey, agencyId])).rows[0];
      if (oldV) {
        // avoid clashing with an existing venue already at the new key
        const clash = (await pool.query("SELECT 1 FROM venues WHERE name=$1 AND agency_id=$2", [newKey, agencyId])).rows[0];
        if (!clash) {
          await pool.query("UPDATE venues SET name=$1, display_name=$2 WHERE name=$3 AND agency_id=$4", [newKey, display, oldKey, agencyId]);
          await pool.query("UPDATE bookings SET venue_key=$1 WHERE venue_key=$2 AND agency_id=$3", [newKey, oldKey, agencyId]);
          renamed++;
        }
      }
    }

    await pool.query(
      `INSERT INTO venues (agency_id, name, display_name,
         contact_name, contact_role, phone, email,
         contact2_name, contact2_role, contact2_phone, contact2_email,
         contact3_name, contact3_role, contact3_phone, contact3_email,
         address, brand_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (agency_id, name) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         contact_name=EXCLUDED.contact_name, contact_role=EXCLUDED.contact_role,
         phone=EXCLUDED.phone, email=EXCLUDED.email,
         contact2_name=EXCLUDED.contact2_name, contact2_role=EXCLUDED.contact2_role,
         contact2_phone=EXCLUDED.contact2_phone, contact2_email=EXCLUDED.contact2_email,
         contact3_name=EXCLUDED.contact3_name, contact3_role=EXCLUDED.contact3_role,
         contact3_phone=EXCLUDED.contact3_phone, contact3_email=EXCLUDED.contact3_email,
         address=EXCLUDED.address,
         brand_id=COALESCE(EXCLUDED.brand_id, venues.brand_id),
         notes=EXCLUDED.notes`,
      [agencyId, normKey(display), display,
       pick(r, ["contact 1 name", "contact1 name", "contact name", "contact", "manager", "name"]) || null,
       pick(r, ["contact 1 role", "contact1 role", "contact role", "role 1", "role"]) || null,
       pick(r, ["contact 1 phone", "contact1 phone", "phone", "mobile", "tel", "number", "phone 1"]) || null,
       pick(r, ["contact 1 email", "contact1 email", "email", "email 1"]) || null,
       pick(r, ["contact 2 name", "contact2 name", "contact 2", "name 2"]) || null,
       pick(r, ["contact 2 role", "contact2 role", "role 2"]) || null,
       pick(r, ["contact 2 phone", "contact2 phone", "phone 2", "mobile 2"]) || null,
       pick(r, ["contact 2 email", "contact2 email", "email 2"]) || null,
       pick(r, ["contact 3 name", "contact3 name", "contact 3", "name 3"]) || null,
       pick(r, ["contact 3 role", "contact3 role", "role 3"]) || null,
       pick(r, ["contact 3 phone", "contact3 phone", "phone 3", "mobile 3"]) || null,
       pick(r, ["contact 3 email", "contact3 email", "email 3"]) || null,
       pick(r, ["address", "addr", "postcode"]) || null,
       brandId,
       pick(r, ["notes", "note", "venue notes"]) || null]
    );
    touchedKeys.add(newKey);
    count++;
  }
  return { count, groupsCreated, renamed, touchedKeys };
}

// Standalone venue import — restore/update venue details from a CSV WITHOUT running a
// check-off. Accepts the same columns as the export, so an exported file round-trips.
app.post("/api/import-venues", requireAdmin, upload.single("contacts"), async (req, res) => {
  try {
    // Restore is destructive (overwrites venue details, can delete groups), so it's
    // restricted to the agency head and requires their password every time.
    const password = (req.body?.password || "").toString();
    const me = (await pool.query(
      "SELECT is_owner, pass_hash FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId]
    )).rows[0];
    if (!me || !me.is_owner) {
      return res.status(403).json({ error: "Only the agency's head can restore venues from a file." });
    }
    if (!password || !verifyPassword(password, me.pass_hash)) {
      return res.status(403).json({ error: "Password incorrect." });
    }

    const csv = decodeCsv(req.file?.buffer);
    if (!csv) return res.status(400).json({ error: "No venue file received." });
    const crows = parseCsv(csv);
    if (!crows.length) return res.status(400).json({ error: "That file has no rows we could read." });
    const withVenue = crows.filter((r) => pick(r, ["venue", "location", "place"]));
    if (!withVenue.length) return res.status(400).json({ error: "No 'venue' column found. Make sure there's a Venue/Location/Place column." });

    const confirmDelete = req.body?.confirmDelete === "true" || req.body?.confirmDelete === true;

    // ----- work out what a full sync would DELETE (groups + venues) -----

    // Groups mentioned in the CSV
    const csvGroupNames = new Set();
    let fileHasGroupColumn = false;
    for (const r of crows) {
      const gn = pick(r, ["group", "parent company", "parent", "brand", "venue group"]);
      const hasCol = Object.keys(r).some((k) => ["group", "parent company", "parent", "brand", "venue group"].includes(normKey(k)));
      if (hasCol) fileHasGroupColumn = true;
      if (gn) csvGroupNames.add(normKey(gn));
    }
    const existingBrands = (await pool.query("SELECT id, name FROM brands WHERE agency_id=$1", [req.agencyId])).rows;
    const brandsToDelete = fileHasGroupColumn ? existingBrands.filter((b) => !csvGroupNames.has(normKey(b.name))) : [];

    // Venues represented by the CSV: final names, plus any old keys being renamed
    // (so a renamed venue isn't mistaken for a deletion).
    const csvVenueKeys = new Set();
    for (const r of crows) {
      const display = pick(r, ["venue", "location", "place"]);
      if (!display) continue;
      csvVenueKeys.add(normKey(display));
      const oldKey = normKey(pick(r, ["venue key", "venuekey", "key", "id"]));
      if (oldKey) csvVenueKeys.add(oldKey);   // its old identity maps into this file too
    }
    const existingVenues = (await pool.query("SELECT name, display_name FROM venues WHERE agency_id=$1", [req.agencyId])).rows;
    const venuesToDelete = existingVenues.filter((v) => !csvVenueKeys.has(normKey(v.name)));

    const anyDeletions = brandsToDelete.length + venuesToDelete.length > 0;

    // Preview step: if anything would be deleted and we haven't been told to proceed,
    // return the lists and make NO changes yet.
    if (anyDeletions && !confirmDelete) {
      return res.json({
        ok: true, needsConfirm: true,
        deleteCount: brandsToDelete.length,
        deleteNames: brandsToDelete.map((b) => b.name),
        venueDeleteCount: venuesToDelete.length,
        venueDeleteNames: venuesToDelete.map((v) => v.display_name),
      });
    }

    // Proceed: import (handles renames + re-linking), then delete what's missing.
    const result = await importVenueRows(req.agencyId, crows);

    let groupsDeleted = 0, venuesDeleted = 0;
    if (confirmDelete) {
      // Delete venues not represented in the file. Their bookings keep the venue_text
      // name; if another venue of the same display name exists, bookings re-link to it.
      for (const v of venuesToDelete) {
        // don't delete something the import just (re)created/renamed into
        if (result.touchedKeys && result.touchedKeys.has(normKey(v.name))) continue;
        // try to re-link this venue's bookings to a same-named surviving venue
        const survivor = (await pool.query(
          "SELECT name FROM venues WHERE agency_id=$1 AND lower(display_name)=lower($2) AND name<>$3 LIMIT 1",
          [req.agencyId, v.display_name, v.name]
        )).rows[0];
        if (survivor) {
          await pool.query("UPDATE bookings SET venue_key=$1 WHERE venue_key=$2 AND agency_id=$3", [survivor.name, v.name, req.agencyId]);
        }
        await pool.query("DELETE FROM venues WHERE name=$1 AND agency_id=$2", [v.name, req.agencyId]);
        venuesDeleted++;
      }
      // Delete groups not named in the file (unassign their venues first).
      if (brandsToDelete.length) {
        const ids = brandsToDelete.map((b) => b.id);
        await pool.query("UPDATE venues SET brand_id=NULL WHERE brand_id = ANY($1) AND agency_id=$2", [ids, req.agencyId]);
        await pool.query("DELETE FROM brands WHERE id = ANY($1) AND agency_id=$2", [ids, req.agencyId]);
        groupsDeleted = ids.length;
      }
    }
    res.json({ ok: true, imported: result.count, renamed: result.renamed || 0,
               groupsCreated: result.groupsCreated, groupsDeleted, venuesDeleted });
  } catch (e) {
    console.error("import-venues failed", e);
    res.status(500).json({ error: e.message });
  }
});

app.post(
  "/api/upload",
  requireAdmin,
  upload.fields([{ name: "bookings" }, { name: "contacts" }]),
  async (req, res) => {
    try {
      const weekTag = new Date().toISOString().slice(0, 10);
      const bookingsFile = req.files?.bookings?.[0];
      const debug = {
        fileName: bookingsFile?.originalname || null,
        sizeBytes: bookingsFile?.buffer?.length || 0,
        firstBytes: bookingsFile?.buffer ? [...bookingsFile.buffer.slice(0, 12)] : [],
        preview: bookingsFile?.buffer ? decodeCsv(bookingsFile.buffer).slice(0, 200) : "",
      };
      const bookingsCsv = decodeCsv(bookingsFile?.buffer);
      const contactsCsv = decodeCsv(req.files?.contacts?.[0]?.buffer);
      if (!bookingsCsv) return res.status(400).json({ error: "No bookings file received." });

      // A new upload starts a new active batch. Archive whatever was active before,
      // so the dashboard shows only this week while old weeks stay in History.
      const label = (req.body?.label || "").trim() || ("Week of " + weekTag);
      await pool.query("UPDATE batches SET archived=true WHERE archived=false AND agency_id=$1", [req.agencyId]);
      const batchId = nanoid(16);
      await pool.query("INSERT INTO batches (id,agency_id,label,archived) VALUES ($1,$2,$3,false)", [batchId, req.agencyId, label]);

      // Auto-remove this agency's batches (and their bookings) older than ~6 months.
      await pool.query("DELETE FROM batches WHERE agency_id=$1 AND created_at < now() - interval '6 months'", [req.agencyId]);
      await pool.query("DELETE FROM bookings WHERE agency_id=$1 AND batch_id NOT IN (SELECT id FROM batches WHERE agency_id=$1)", [req.agencyId]);

      // --- venues first ---
      if (contactsCsv) {
        const crows = parseCsv(contactsCsv);
        await importVenueRows(req.agencyId, crows);
      }

      // --- bookings ---
      const brows = parseCsv(bookingsCsv);
      const summary = { created: 0, emailed: 0, emailFailed: 0, unmatchedVenues: new Set(),
                        rowsSeen: brows.length, headers: brows[0] ? Object.keys(brows[0]) : [],
                        skippedNoEmail: 0 };
      const actsWithGigs = new Map();
      // Load venues once so fuzzy matching doesn't hit the DB per row.
      const storedVenues = (await pool.query("SELECT name, display_name, share_contact FROM venues WHERE agency_id=$1", [req.agencyId])).rows;

      for (const r of brows) {
        const actName = pick(r, ["act", "artist", "performer", "band", "name"]);
        let actEmail = pick(r, ["act email", "email"]).toLowerCase();
        const venueText = pick(r, ["venue", "location", "place"]);
        if (!actName) continue;

        // If the act has no direct email, fall back to their booking agent's email.
        const agentEmail = pick(r, ["act agent email", "agent email"]).toLowerCase();
        const agentName = pick(r, ["act's agent", "agent", "acts agent"]);
        // A named agent contact to greet in the email instead of the act (used when
        // the act is represented by another agency).
        const agentContactName = pick(r, ["act agent contact name", "agent contact name", "agent contact", "agent name"]);
        // The act's real contact name (person behind the stage name) — greeted first.
        const actContactName = pick(r, ["act contact name", "act contact", "contact name"]);
        let bookedViaAgent = false;
        if (!actEmail && agentEmail) {
          actEmail = agentEmail;
          bookedViaAgent = true;
        }
        if (!actEmail) { summary.skippedNoEmail++; continue; }

        // upsert act (scoped to this agency — the same email may exist for another)
        let act = (await pool.query("SELECT * FROM acts WHERE email=$1 AND agency_id=$2", [actEmail, req.agencyId])).rows[0];
        let isNew = false;
        if (!act) {
          const id = nanoid(16);
          act = (await pool.query(
            "INSERT INTO acts (id,agency_id,name,email) VALUES ($1,$2,$3,$4) RETURNING *",
            [id, req.agencyId, actName, actEmail]
          )).rows[0];
          isNew = true;
        }

        // Match this booking's venue to a stored one, tolerating naming differences.
        const matchedKey = await resolveVenueKey(venueText, storedVenues);
        const venueKey = matchedKey || normKey(venueText);
        if (venueText && !matchedKey) summary.unmatchedVenues.add(venueText);
        // inherit the venue's "share contact" default (true if venue unknown)
        const matchedVenue = storedVenues.find((v) => v.name === venueKey);
        const shareVenue = matchedVenue ? matchedVenue.share_contact !== false : true;

        // "Performance" holds the set details (e.g. "1 x 45", "Speed Quiz") — show it as notes.
        const performance = pick(r, ["performance", "set", "type"]);
        const extraNotes = pick(r, ["notes", "note", "details"]);
        const combinedNotes = [performance, extraNotes].filter(Boolean).join(" — ");

        const bookingId = nanoid(16);
        await pool.query(
          `INSERT INTO bookings (id,agency_id,act_id,performer_name,venue_key,venue_text,gig_date,gig_time,fee,notes,week_tag,batch_id,share_venue,agent_contact_name,act_contact_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [bookingId, req.agencyId, act.id, actName, venueKey, venueText,
           pick(r, ["date", "gig date", "day"]),
           pick(r, ["time", "start", "set time", "load in"]),
           null,                       // fee deliberately not shown to the act
           combinedNotes,
           weekTag, batchId, shareVenue,
           (bookedViaAgent && agentContactName) ? agentContactName : (agentContactName || null),
           actContactName || null]
        );
        summary.created++;
        // Track which acts got bookings this upload, so we email each one once afterwards.
        actsWithGigs.set(act.id, (actsWithGigs.get(act.id) || 0) + 1);
      }
      // NOTE: we no longer email acts automatically here. The dashboard now shows a
      // review step so the user can choose who sees venue contact before sending.
      res.json({
        ...summary,
        batchId,
        unmatchedVenues: [...summary.unmatchedVenues],
        debug,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Upload failed: " + e.message });
    }
  }
);

// Review list for the active (or given) batch: one row per act to be emailed, with
// how many gigs, whether any of their gigs have venue contact available, and the
// Review the active (or given) batch, grouped by VENUE. Each venue shows how many
// acts/gigs are booked there and whether acts should see its contact details.
app.get("/api/review", requireAdmin, async (req, res) => {
  const batchId = req.query.batchId;
  const batch = batchId
    ? (await pool.query("SELECT id,label FROM batches WHERE id=$1 AND agency_id=$2", [batchId, req.agencyId])).rows[0]
    : (await pool.query("SELECT id,label FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1", [req.agencyId])).rows[0];
  if (!batch) return res.json({ venues: [], batch: null, actCount: 0 });

  const venues = (await pool.query(
    `SELECT COALESCE(v.name, bk.venue_key, lower(bk.venue_text)) AS venue_key,
            COALESCE(v.display_name, bk.venue_text) AS venue_name,
            count(*)::int AS gigs,
            count(DISTINCT bk.act_id)::int AS acts,
            bool_or(v.phone IS NOT NULL OR v.email IS NOT NULL OR v.contact_name IS NOT NULL) AS has_venue_contact,
            -- current effective choice: use the booking flag (already defaulted from venue)
            bool_and(bk.share_venue) AS share_venue,
            bool_or(bk.invited_at IS NOT NULL) AS already_sent
     FROM bookings bk
     LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id
     WHERE bk.batch_id=$1 AND bk.agency_id=$2
     GROUP BY 1,2
     ORDER BY venue_name`, [batch.id, req.agencyId]
  )).rows;

  const actCount = (await pool.query(
    "SELECT count(DISTINCT act_id)::int AS n FROM bookings WHERE batch_id=$1 AND agency_id=$2", [batch.id, req.agencyId]
  )).rows[0].n;

  // Act-grouped view: each act with their individual gigs (for the review-by-act UI).
  const gigRows = (await pool.query(
    `SELECT bk.id, bk.act_id, a.name AS act_name, a.email AS act_email,
            bk.performer_name, bk.gig_date, bk.gig_time, bk.status, bk.adhoc_note,
            bk.agent_contact_name, bk.act_contact_name,
            COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS venue,
            COALESCE(v.name, bk.venue_key, lower(bk.venue_text)) AS venue_key,
            bk.share_venue,
            (v.phone IS NOT NULL OR v.email IS NOT NULL OR v.contact_name IS NOT NULL) AS has_venue_contact,
            bk.invited_at IS NOT NULL AS already_sent
     FROM bookings bk
     JOIN acts a ON a.id=bk.act_id
     LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
     WHERE bk.batch_id=$1 AND bk.agency_id=$2
     ORDER BY a.name, bk.gig_date`, [batch.id, req.agencyId]
  )).rows;
  // sort each act's gigs by real date, group by act
  const actMap = new Map();
  for (const g of gigRows) {
    if (!actMap.has(g.act_id)) actMap.set(g.act_id, { act_id: g.act_id, act_name: g.act_name, act_email: g.act_email, adhoc_note: g.adhoc_note || "", agent_contact_name: g.agent_contact_name || "", act_contact_name: g.act_contact_name || "", gigs: [] });
    actMap.get(g.act_id).gigs.push(g);
  }
  const acts = [...actMap.values()];
  for (const a of acts) a.gigs.sort((x, y) => {
    const dx = parseGigDate(x.gig_date), dy = parseGigDate(y.gig_date);
    if (dx && dy) return dx - dy; if (dx) return -1; if (dy) return 1; return 0;
  });

  res.json({ venues, acts, batch, actCount });
});

// Apply per-VENUE "share contact" choices, then email one confirmation per act.
app.post("/api/send-confirmations", requireAdmin, async (req, res) => {
  try {
    if (!resend) return res.status(500).json({ error: "Email not configured." });
    const batchId = (req.body?.batchId || "").toString();
    const choices = req.body?.choices || {};   // { venueKey: shareBool }
    const notes = req.body?.notes || {};       // { actId: adhoc note text }
    const blockedGigs = Array.isArray(req.body?.blockedGigs) ? req.body.blockedGigs.map(String) : []; // gig ids to flag instead of send
    const saveDefault = req.body?.saveDefault !== false; // also store choice on the venue
    const onlyUnsent = req.body?.onlyUnsent !== false;
    const batch = (await pool.query("SELECT id FROM batches WHERE id=$1 AND agency_id=$2", [batchId, req.agencyId])).rows[0];
    if (!batch) return res.status(404).json({ error: "No such week." });

    // Any gig the user unticked is flagged as an issue (needs attention) and won't be
    // included in the confirmation email.
    let flaggedCount = 0;
    if (blockedGigs.length) {
      const r = await pool.query(
        `UPDATE bookings SET status='issue', message=COALESCE(message,'Held back before sending'), responded_at=now()
         WHERE agency_id=$1 AND batch_id=$2 AND id = ANY($3::text[])`,
        [req.agencyId, batchId, blockedGigs]
      );
      flaggedCount = r.rowCount || 0;
    }

    // Apply each venue's choice to this batch's bookings at that venue, and optionally
    // save it as the venue's default for future weeks.
    for (const [venueKey, share] of Object.entries(choices)) {
      await pool.query(
        "UPDATE bookings SET share_venue=$1 WHERE batch_id=$2 AND agency_id=$3 AND COALESCE(venue_key, lower(venue_text))=$4",
        [!!share, batchId, req.agencyId, venueKey]
      );
      if (saveDefault) {
        await pool.query(
          "UPDATE venues SET share_contact=$1 WHERE agency_id=$2 AND name=$3",
          [!!share, req.agencyId, venueKey]
        );
      }
    }

    // Save any per-gig ad-hoc notes onto the specific booking.
    for (const [gigId, note] of Object.entries(notes)) {
      await pool.query(
        "UPDATE bookings SET adhoc_note=$1 WHERE id=$2 AND batch_id=$3 AND agency_id=$4",
        [(note || "").toString().slice(0, 500) || null, gigId, batchId, req.agencyId]
      );
    }

    // One email per act — counting only gigs that are NOT blocked/flagged.
    const acts = (await pool.query(
      `SELECT bk.act_id, a.name, a.email, a.agency_id, a.via_agent, a.agent_email,
              count(*) FILTER (WHERE bk.status <> 'issue')::int AS gigs,
              array_agg(DISTINCT bk.performer_name) FILTER (
                WHERE bk.performer_name IS NOT NULL AND bk.performer_name <> '' AND bk.status <> 'issue'
              ) AS stage_names,
              (array_agg(bk.agent_contact_name) FILTER (
                WHERE bk.agent_contact_name IS NOT NULL AND bk.agent_contact_name <> ''
              ))[1] AS agent_contact_name,
              (array_agg(bk.act_contact_name) FILTER (
                WHERE bk.act_contact_name IS NOT NULL AND bk.act_contact_name <> ''
              ))[1] AS act_contact_name,
              json_agg(json_build_object('venue', COALESCE(NULLIF(bk.venue_text,''), bk.venue_key), 'note', bk.adhoc_note))
                FILTER (WHERE bk.adhoc_note IS NOT NULL AND bk.adhoc_note <> '' AND bk.status <> 'issue') AS notes,
              bool_or(bk.invited_at IS NOT NULL) AS already_sent
       FROM bookings bk JOIN acts a ON a.id=bk.act_id
       WHERE bk.batch_id=$1 AND bk.agency_id=$2
       GROUP BY bk.act_id, a.name, a.email, a.agency_id, a.via_agent, a.agent_email`, [batchId, req.agencyId]
    )).rows;

    const sender = await senderForAgency(req.agencyId, await userEmail(req.userId));
    let emailed = 0, failed = 0, skipped = 0;
    for (const a of acts) {
      // Who receives the check: the act's own email, or the agent's email when the act is
      // booked via an agent and has no direct email of their own.
      const recipient = (a.email && a.email.trim()) ? a.email.trim()
        : (a.via_agent && a.agent_email ? a.agent_email.trim() : "");
      if (!recipient) { skipped++; continue; }
      if (a.gigs < 1) { skipped++; continue; }          // all their gigs were blocked
      if (onlyUnsent && a.already_sent) { skipped++; continue; }
      try {
        // Greeting precedence: the act's real contact name, then the agent contact
        // (if repped by another agency), then the stage name(s) they're booked under.
        const names = a.act_contact_name
          ? [a.act_contact_name]
          : (a.agent_contact_name
              ? [a.agent_contact_name]
              : ((a.stage_names && a.stage_names.length) ? a.stage_names : [a.name]));
        await sendConfirmEmail({ id: a.act_id, name: a.name, email: recipient, agency_id: a.agency_id, greetNames: names }, a.gigs, sender, a.notes || []);
        // only mark the non-flagged gigs as invited
        await pool.query("UPDATE bookings SET invited_at=now() WHERE batch_id=$1 AND act_id=$2 AND agency_id=$3 AND status <> 'issue'", [batchId, a.act_id, req.agencyId]);
        emailed++;
      } catch (e) {
        console.error("confirm email failed for", recipient, e.message);
        failed++;
      }
    }
    res.json({ emailed, failed, skipped, flagged: flaggedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---------- contact extraction from Excel/Word/PDF (admin) ----------
// Step 1: extract candidates and return them for on-screen review (saves nothing).
app.post("/api/extract-contacts", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received." });
    const result = await extractContacts(req.file);

    // Compare each extracted contact against what's already stored, so the UI can
    // show only new + changed venues and flag exactly which fields differ.
    const existingRows = (await pool.query(
      "SELECT name, display_name, contact_name, phone, email, address FROM venues"
    )).rows;
    const existing = new Map(existingRows.map((v) => [v.name, v]));
    const same = (a, b) => (a || "").trim() === (b || "").trim();

    let counts = { new: 0, changed: 0, unchanged: 0 };
    const contacts = (result.contacts || []).map((c) => {
      const key = (c.venue || "").toLowerCase().replace(/\s+/g, " ");
      const prev = existing.get(key);
      if (!prev) { counts.new++; return { ...c, _status: "new" }; }
      const fields = ["contact", "phone", "email", "address"];
      const prevMap = { contact: prev.contact_name, phone: prev.phone, email: prev.email, address: prev.address };
      const diffs = {};
      let changed = false;
      for (const f of fields) {
        if (!same(c[f], prevMap[f])) { diffs[f] = prevMap[f] || ""; changed = true; }
      }
      // venue display name change (same key, different capitalisation/wording)
      if (!same(c.venue, prev.display_name)) { diffs.venue = prev.display_name || ""; changed = true; }
      if (changed) { counts.changed++; return { ...c, _status: "changed", _old: diffs }; }
      counts.unchanged++;
      return { ...c, _status: "unchanged" };
    });

    // Venues stored but NOT present in this file — candidates for deletion if the
    // admin chooses to treat the file as the complete list.
    const fileKeys = new Set(
      (result.contacts || [])
        .map((c) => (c.venue || "").toLowerCase().replace(/\s+/g, " "))
        .filter(Boolean)
    );
    const missing = existingRows
      .filter((v) => !fileKeys.has(v.name))
      .map((v) => v.display_name);

    let note = "";
    if (result.warning === "scanned") {
      note = "This PDF looks like a scan (an image of a page), so no text could be read. You'll need to type these contacts in, or send a Word/Excel version.";
    } else if (result.warning === "unsupported") {
      note = "Unsupported file type. Use CSV, Excel (.xlsx), Word (.docx) or PDF.";
    } else if (!result.contacts.length) {
      note = "No contact details could be found in that file. Check it actually contains venue contacts, or add them by hand.";
    } else if (result.kind === "word" || result.kind === "pdf") {
      note = "These were read from a document, so please check each row carefully before saving — names and venues are best-guess.";
    }
    res.json({ contacts, kind: result.kind, note, counts, missing });
  } catch (e) {
    console.error("extract failed", e);
    res.status(500).json({ error: "Couldn't read that file: " + e.message });
  }
});

// Step 2: save the reviewed/edited contacts as venues.
// Save a venue contact from the review step, keyed to the exact venue_key the
// current bookings use, so it immediately links to them. Creates or updates the venue.
app.post("/api/review-add-contact", requireAdmin, async (req, res) => {
  try {
    const venueKey = (req.body?.venueKey || "").trim();
    const venueName = (req.body?.venue || "").trim() || venueKey;
    if (!venueKey) return res.status(400).json({ error: "Missing venue." });
    await pool.query(
      `INSERT INTO venues (agency_id, name, display_name, contact_name, phone, email, address, share_contact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (agency_id, name) DO UPDATE SET
         display_name=EXCLUDED.display_name, contact_name=EXCLUDED.contact_name,
         phone=EXCLUDED.phone, email=EXCLUDED.email, address=EXCLUDED.address,
         share_contact=true`,
      [req.agencyId, venueKey, venueName,
       (req.body?.contact || "").trim(), (req.body?.phone || "").trim(),
       (req.body?.email || "").trim(), (req.body?.address || "").trim()]
    );
    // make sure the current batch's bookings for this venue share the contact
    await pool.query(
      "UPDATE bookings SET share_venue=true WHERE agency_id=$1 AND venue_key=$2",
      [req.agencyId, venueKey]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/save-contacts", requireAdmin, async (req, res) => {
  try {
    const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    let saved = 0;
    for (const c of contacts) {
      const display = (c.venue || "").trim();
      if (!display) continue; // a venue name is required to key on
      const share = c.share_contact === false ? false : true; // default share
      await pool.query(
        `INSERT INTO venues (agency_id, name, display_name, contact_name, phone, email, address, share_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (agency_id, name) DO UPDATE SET
           display_name=EXCLUDED.display_name, contact_name=EXCLUDED.contact_name,
           phone=EXCLUDED.phone, email=EXCLUDED.email, address=EXCLUDED.address,
           share_contact=EXCLUDED.share_contact`,
        [req.agencyId, display.toLowerCase().replace(/\s+/g, " "), display,
         (c.contact || "").trim(), (c.phone || "").trim(),
         (c.email || "").trim(), (c.address || "").trim(), share]
      );
      saved++;
    }
    res.json({ saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all saved venue contacts, with a count of how many bookings reference each.
// ---------- brands (parent groups with head-office emails) ----------
app.get("/api/brands", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT b.id, b.name, b.office_email,
            (SELECT count(*)::int FROM venues v WHERE v.brand_id=b.id AND v.agency_id=b.agency_id) AS venue_count
     FROM brands b WHERE b.agency_id=$1 ORDER BY b.name`, [req.agencyId]
  )).rows;
  res.json({ brands: rows });
});

app.post("/api/brand", requireAdmin, async (req, res) => {
  const id = (req.body?.id || "").toString();
  const name = (req.body?.name || "").trim().slice(0, 120);
  const officeEmail = (req.body?.office_email || "").trim().slice(0, 500);
  if (!name) return res.status(400).json({ error: "Brand name is required." });
  if (id) {
    const existing = (await pool.query("SELECT id FROM brands WHERE id=$1 AND agency_id=$2", [id, req.agencyId])).rows[0];
    if (!existing) return res.status(404).json({ error: "No such brand." });
    await pool.query("UPDATE brands SET name=$1, office_email=$2 WHERE id=$3 AND agency_id=$4",
      [name, officeEmail || null, id, req.agencyId]);
    return res.json({ ok: true, id });
  }
  const newId = nanoid(16);
  await pool.query("INSERT INTO brands (id, agency_id, name, office_email) VALUES ($1,$2,$3,$4)",
    [newId, req.agencyId, name, officeEmail || null]);
  res.json({ ok: true, id: newId });
});

app.post("/api/delete-brand", requireAdmin, async (req, res) => {
  const id = (req.body?.id || "").toString();
  // unassign venues from this brand, then remove it
  await pool.query("UPDATE venues SET brand_id=NULL WHERE brand_id=$1 AND agency_id=$2", [id, req.agencyId]);
  await pool.query("DELETE FROM brands WHERE id=$1 AND agency_id=$2", [id, req.agencyId]);
  res.json({ ok: true });
});

app.get("/api/venues", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT v.name, v.display_name, v.contact_name, v.phone, v.email, v.address, v.share_contact, v.brand_id,
            v.contact_role, v.contact2_name, v.contact2_role, v.contact2_phone, v.contact2_email,
            v.contact3_name, v.contact3_role, v.contact3_phone, v.contact3_email, v.notes,
            (SELECT count(*)::int FROM bookings b WHERE b.venue_key = v.name AND b.agency_id=v.agency_id) AS booking_count
     FROM venues v WHERE v.agency_id=$1 ORDER BY v.display_name`, [req.agencyId]
  )).rows;
  // flag deliverability: a venue email field may hold several comma/semicolon addresses
  const allAddrs = [];
  for (const v of rows) (v.email || "").split(/[,;]+/).forEach((e) => { const t = e.trim().toLowerCase(); if (t) allAddrs.push(t); });
  const statusMap = await latestEmailStatus(allAddrs);
  for (const v of rows) {
    const addrs = (v.email || "").split(/[,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    v.email_status = addrs.map((a) => statusMap[a]).find((s) => s === "bounced" || s === "complained") ||
                     (addrs.some((a) => statusMap[a] === "delivered") ? "delivered" : null);
  }
  res.json({ venues: rows });
});

// Update one venue (identified by its current key). Handles a venue rename safely.
app.post("/api/update-venue", requireAdmin, async (req, res) => {
  try {
    const { key, venue, contact, phone, email, address } = req.body || {};
    const share = req.body?.share_contact === false ? false : true;
    const brandId = req.body?.brand_id ? req.body.brand_id.toString() : null;
    const display = (venue || "").trim();
    if (!key || !display) return res.status(400).json({ error: "Missing venue name." });
    const newKey = display.toLowerCase().replace(/\s+/g, " ");
    if (newKey !== key) {
      const clash = (await pool.query("SELECT 1 FROM venues WHERE name=$1 AND agency_id=$2", [newKey, req.agencyId])).rows[0];
      if (clash) return res.status(409).json({ error: "Another venue already has that name." });
    }
    await pool.query(
      `UPDATE venues SET name=$1, display_name=$2, contact_name=$3, phone=$4, email=$5, address=$6, share_contact=$7, brand_id=$8,
              contact_role=$9, contact2_name=$10, contact2_role=$11, contact2_phone=$12, contact2_email=$13,
              contact3_name=$14, contact3_role=$15, contact3_phone=$16, contact3_email=$17, notes=$18
       WHERE name=$19 AND agency_id=$20`,
      [newKey, display, (contact || "").trim(), (phone || "").trim(),
       (email || "").trim(), (address || "").trim(), share, brandId,
       (req.body?.contact_role || "").trim() || null,
       (req.body?.contact2_name || "").trim() || null, (req.body?.contact2_role || "").trim() || null, (req.body?.contact2_phone || "").trim() || null, (req.body?.contact2_email || "").trim() || null,
       (req.body?.contact3_name || "").trim() || null, (req.body?.contact3_role || "").trim() || null, (req.body?.contact3_phone || "").trim() || null, (req.body?.contact3_email || "").trim() || null,
       (req.body?.notes || "").trim() || null,
       key, req.agencyId]
    );
    if (newKey !== key) {
      await pool.query("UPDATE bookings SET venue_key=$1 WHERE venue_key=$2 AND agency_id=$3", [newKey, key, req.agencyId]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete one venue contact.
app.post("/api/delete-venue", requireAdmin, async (req, res) => {
  try {
    const key = (req.body?.key || "").trim();
    if (!key) return res.status(400).json({ error: "Missing venue." });
    await pool.query("DELETE FROM venues WHERE name=$1 AND agency_id=$2", [key, req.agencyId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export all venue contacts as a CSV download (re-imports cleanly).
// Export all acts to CSV (full record). The hidden "act email" is the key for re-import.
// Remove every act that has no bookings attached. Owner-only + password. Useful for
// resetting after a messy import before re-importing cleanly. Acts WITH bookings are
// never touched, so nothing with gig history is lost. Two-step: returns a count to
// confirm, then deletes when confirm=true.
app.post("/api/clear-empty-acts", requireAdmin, async (req, res) => {
  try {
    const password = (req.body?.password || "").toString();
    const me = (await pool.query("SELECT is_owner, pass_hash FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
    if (!me || !me.is_owner) return res.status(403).json({ error: "Only the agency head can do this." });
    if (!password || !verifyPassword(password, me.pass_hash)) return res.status(403).json({ error: "Password incorrect." });

    const empties = (await pool.query(
      `SELECT a.id, a.name FROM acts a
       WHERE a.agency_id=$1
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.act_id=a.id)`, [req.agencyId]
    )).rows;

    const confirm = req.body?.confirm === "true" || req.body?.confirm === true;
    if (!confirm) {
      return res.json({ ok: true, needsConfirm: true, count: empties.length });
    }
    if (empties.length) {
      await pool.query("DELETE FROM acts WHERE id = ANY($1) AND agency_id=$2", [empties.map((a) => a.id), req.agencyId]);
    }
    res.json({ ok: true, deleted: empties.length });
  } catch (e) {
    console.error("clear-empty-acts failed", e);
    res.status(500).json({ error: e.message });
  }
});

// Demo reset — wipes ALL venues, acts and bookings for the agency so a fresh demo set can
// be imported. Restricted to the platform owner account and password-confirmed. Two-step:
// returns counts to confirm, then wipes when confirm=true.
app.post("/api/demo-reset", requireAdmin, async (req, res) => {
  try {
    const me = (await pool.query("SELECT email, is_owner, pass_hash FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
    // gate strictly to the platform owner account
    if (!me || (me.email || "").toLowerCase() !== "phil@phil-freeman.co.uk") {
      return res.status(403).json({ error: "This is only available on the demo account." });
    }
    const password = (req.body?.password || "").toString();
    if (!password || !verifyPassword(password, me.pass_hash)) return res.status(403).json({ error: "Password incorrect." });

    const counts = {
      venues: (await pool.query("SELECT count(*)::int c FROM venues WHERE agency_id=$1", [req.agencyId])).rows[0].c,
      acts: (await pool.query("SELECT count(*)::int c FROM acts WHERE agency_id=$1", [req.agencyId])).rows[0].c,
      bookings: (await pool.query("SELECT count(*)::int c FROM bookings WHERE agency_id=$1", [req.agencyId])).rows[0].c,
    };

    const confirm = req.body?.confirm === "true" || req.body?.confirm === true;
    if (!confirm) return res.json({ ok: true, needsConfirm: true, counts });

    // wipe bookings first (they reference acts), then acts, venues, and their batches/brands
    await pool.query("DELETE FROM bookings WHERE agency_id=$1", [req.agencyId]);
    await pool.query("DELETE FROM acts WHERE agency_id=$1", [req.agencyId]);
    await pool.query("DELETE FROM venues WHERE agency_id=$1", [req.agencyId]);
    await pool.query("DELETE FROM batches WHERE agency_id=$1", [req.agencyId]);
    await pool.query("DELETE FROM brands WHERE agency_id=$1", [req.agencyId]);
    res.json({ ok: true, wiped: counts });
  } catch (e) {
    console.error("demo-reset failed", e);
    res.status(500).json({ error: e.message });
  }
});

// Whether the demo controls should show (only on the platform owner demo account).
app.get("/api/demo-enabled", requireAdmin, async (req, res) => {
  const me = (await pool.query("SELECT email FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
  res.json({ enabled: !!me && (me.email || "").toLowerCase() === "phil@phil-freeman.co.uk" });
});

app.get("/api/export-acts", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT a.name, a.email, a.phone, a.contact_name, a.via_agent, a.agent_name, a.agent_email, a.car_reg,
            a.stage_names,
            (SELECT string_agg(DISTINCT bk.performer_name, ', ')
             FROM bookings bk
             WHERE bk.act_id = a.id AND bk.performer_name IS NOT NULL AND bk.performer_name <> ''
               AND lower(bk.performer_name) <> lower(a.name)) AS booked_names
     FROM acts a WHERE a.agency_id=$1 ORDER BY a.name`, [req.agencyId]
  )).rows;
  const esc = (v) => {
    const s = (v == null ? "" : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // Merge the stored stage-names list with any distinct performer names from bookings.
  const mergeStage = (stored, booked) => {
    const set = new Set();
    for (const part of [stored, booked]) {
      (part || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((n) => set.add(n));
    }
    return [...set].join(", ");
  };
  const header = "actual name,stage names,email,phone,contact name,booked via agent,agent name,agent email,car reg";
  const body = rows.map((r) =>
    [r.name, mergeStage(r.stage_names, r.booked_names), r.email, r.phone, r.contact_name,
     r.via_agent ? "yes" : "", r.agent_name, r.agent_email, r.car_reg].map(esc).join(",")
  ).join("\n");
  const csv = "\uFEFF" + header + "\n" + body;
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="acts_${date}.csv"`);
  res.send(csv);
});

// Import / restore acts from CSV. Upserts by email (the stable key). Owner-only +
// password, mirroring venue restore. Optional full-sync deletes acts not in the file
// (only after on-screen confirm, and never deletes an act that has bookings).
app.post("/api/import-acts", requireAdmin, upload.single("acts"), async (req, res) => {
  try {
    const password = (req.body?.password || "").toString();
    const me = (await pool.query("SELECT is_owner, pass_hash FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
    if (!me || !me.is_owner) return res.status(403).json({ error: "Only the agency head can import acts." });
    if (!password || !verifyPassword(password, me.pass_hash)) return res.status(403).json({ error: "Password incorrect." });

    const csv = decodeCsv(req.file?.buffer);
    if (!csv) return res.status(400).json({ error: "No acts file received." });
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(400).json({ error: "That file has no rows we could read." });

    // Map each row to act fields. Header matching covers GigConfirm's own export AND common
    // booking-system exports (e.g. "Act" = stage name, "Act Contact Name" = real person,
    // "Act's agent" = agent, "Act Mob" = phone).
    const validEmail = (e) => e && /\S+@\S+\.\S+/.test(e);
    const mapped = rows.map((r) => {
      const email = pick(r, ["act email", "email", "e-mail", "act e-mail"]).toLowerCase();
      const agent_email = pick(r, ["act agent email", "agent email", "agent e-mail"]).toLowerCase();
      let via_agent = /^(y|yes|true|1)$/i.test(pick(r, ["booked via agent", "via agent", "agent?"]) || "");

      // The main name shown everywhere. In a booking-system export the "Act" column is the
      // stage/performing name — use that as the main name if there's no explicit "actual name".
      const actCol = pick(r, ["actual name", "act name", "act", "name", "performer", "artist"]);
      // The real person behind the act.
      const contact_name = pick(r, ["act contact name", "contact name", "contact", "real name"]);
      // Stage names: an explicit column if present, otherwise the "Act" value itself is the
      // stage name they perform under.
      const stageCol = pick(r, ["stage names", "stage name", "stagenames", "stage_names", "performing names", "performs as", "performer names", "aka", "also known as", "other names"]);
      const stage_names = stageCol || actCol || "";

      const agent_name = pick(r, ["act's agent", "acts agent", "agent name", "agent", "agency"]);
      const agent_contact = pick(r, ["act agent contact name", "agent contact name", "agent contact"]);

      // agent-booked: explicit flag, OR an agent email present, OR an agent company named
      if (!validEmail(email) && (validEmail(agent_email) || agent_name)) via_agent = true;

      return {
        name: actCol,
        stage_names,
        email,
        phone: pick(r, ["act mob", "mobile", "act mobile", "phone", "tel", "number", "act phone"]),
        contact_name,
        via_agent,
        agent_name,
        agent_contact,
        agent_email,
        car_reg: pick(r, ["car reg", "car registration", "reg", "registration"]).toUpperCase(),
      };
    }).filter((a) => a.name || a.email || a.agent_email);
    if (!mapped.length) return res.status(400).json({ error: "No act names or emails found. Make sure there's an 'Act'/'name', 'email', or 'agent email' column." });

    // DEDUPE: booking-system exports repeat an act once per booking. Collapse to unique acts,
    // keyed by act email → else agent email → else the act name (lowercased). Merge stage
    // names across duplicates, and keep the first non-empty value for every other field.
    const dedupeKey = (a) => (validEmail(a.email) ? "e:" + a.email
      : validEmail(a.agent_email) ? "g:" + a.agent_email + "|" + (a.name || "").toLowerCase()
      : "n:" + (a.name || "").toLowerCase());
    const byKey = new Map();
    for (const a of mapped) {
      const k = dedupeKey(a);
      if (!byKey.has(k)) { byKey.set(k, { ...a, _stageSet: new Set() }); }
      const acc = byKey.get(k);
      // accumulate stage names from every duplicate row
      for (const s of (a.stage_names || "").split(",").map((x) => x.trim()).filter(Boolean)) acc._stageSet.add(s);
      // fill any blank field from later rows
      for (const f of ["name", "email", "phone", "contact_name", "agent_name", "agent_contact", "agent_email", "car_reg"]) {
        if (!acc[f] && a[f]) acc[f] = a[f];
      }
      if (a.via_agent) acc.via_agent = true;
    }
    const usable = [...byKey.values()].map((a) => {
      // final stage_names string: merged set, but drop it if it's identical to the name only
      const list = [...a._stageSet];
      a.stage_names = list.join(", ");
      delete a._stageSet;
      return a;
    });

    // A row is importable if it has EITHER a valid act email OR (booked via agent + a valid
    // agent email). The agent email becomes the matching/sending route when act email is blank.
    const importable = usable.filter((a) => validEmail(a.email) || (a.via_agent && validEmail(a.agent_email)));

    const confirmDelete = req.body?.confirmDelete === "true" || req.body?.confirmDelete === true;

    // A row's identity for matching: the act email if it has one, else the agent email.
    const keyOf = (a) => (validEmail(a.email) ? a.email : a.agent_email);

    // full-sync preview: existing acts (matched by act email OR agent email) not in the
    // file, with no bookings, are deletable.
    const keysInFile = new Set(importable.map(keyOf).filter(Boolean));
    const existing = (await pool.query(
      `SELECT a.id, a.name, a.email, a.agent_email,
              (SELECT count(*)::int FROM bookings b WHERE b.act_id=a.id) AS bc
       FROM acts a WHERE a.agency_id=$1`, [req.agencyId]
    )).rows;
    const existKey = (a) => (validEmail(a.email) ? a.email.toLowerCase() : (a.agent_email || "").toLowerCase());
    const deletable = existing.filter((a) => existKey(a) && !keysInFile.has(existKey(a)) && a.bc === 0);

    if (deletable.length && !confirmDelete) {
      return res.json({
        ok: true, needsConfirm: true,
        deleteCount: deletable.length,
        deleteNames: deletable.map((a) => a.name || a.email || a.agent_email),
      });
    }

    // Merge two comma-separated stage-name lists, case-insensitive dedupe, keep first spelling.
    const mergeStageNames = (existing, incoming) => {
      const seen = new Set(); const out = [];
      for (const part of [existing, incoming]) {
        for (const raw of (part || "").split(",")) {
          const s = raw.trim(); if (!s) continue;
          const k = s.toLowerCase();
          if (!seen.has(k)) { seen.add(k); out.push(s); }
        }
      }
      return out.join(", ");
    };

    // upsert each act. Match by act email when present, otherwise by agent email (agent-
    // booked acts keep a blank act email and are reached via the agent).
    let created = 0, updated = 0;
    for (const a of importable) {
      const hasActEmail = validEmail(a.email);
      const existingAct = hasActEmail
        ? (await pool.query("SELECT id, stage_names FROM acts WHERE email=$1 AND agency_id=$2", [a.email, req.agencyId])).rows[0]
        : (await pool.query("SELECT id, stage_names FROM acts WHERE (email IS NULL OR email='') AND agent_email=$1 AND agency_id=$2", [a.agent_email, req.agencyId])).rows[0];
      if (existingAct) {
        const mergedStage = mergeStageNames(existingAct.stage_names, a.stage_names) || null;
        await pool.query(
          `UPDATE acts SET name=COALESCE(NULLIF($1,''),name), phone=$2, contact_name=$3,
                 via_agent=$4, agent_name=$5, agent_email=$6, car_reg=$7, stage_names=$8, agent_contact_name=$9
           WHERE id=$10 AND agency_id=$11`,
          [a.name, a.phone || null, a.contact_name || null, a.via_agent, a.agent_name || null, a.agent_email || null, a.car_reg || null, mergedStage, a.agent_contact || null, existingAct.id, req.agencyId]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO acts (id, agency_id, name, email, phone, contact_name, via_agent, agent_name, agent_email, car_reg, stage_names, agent_contact_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [nanoid(16), req.agencyId, a.name || (hasActEmail ? a.email : (a.agent_name || a.agent_email)), hasActEmail ? a.email : null,
           a.phone || null, a.contact_name || null, a.via_agent, a.agent_name || null, a.agent_email || null, a.car_reg || null, a.stage_names || null, a.agent_contact || null]
        );
        created++;
      }
    }

    let deleted = 0;
    if (confirmDelete && deletable.length) {
      const ids = deletable.map((a) => a.id);
      await pool.query("DELETE FROM acts WHERE id = ANY($1) AND agency_id=$2", [ids, req.agencyId]);
      deleted = ids.length;
    }
    const skipped = usable.length - importable.length;
    res.json({ ok: true, created, updated, deleted, skipped });
  } catch (e) {
    console.error("import-acts failed", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/export-contacts", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT v.name AS venue_key, v.display_name,
            v.contact_name, v.contact_role, v.phone, v.email,
            v.contact2_name, v.contact2_role, v.contact2_phone, v.contact2_email,
            v.contact3_name, v.contact3_role, v.contact3_phone, v.contact3_email,
            v.address, v.notes, b.name AS group_name, b.office_email AS group_office_email
     FROM venues v
     LEFT JOIN brands b ON b.id = v.brand_id AND b.agency_id = v.agency_id
     WHERE v.agency_id=$1 ORDER BY v.display_name`,
    [req.agencyId]
  )).rows;
  const esc = (v) => {
    const s = (v == null ? "" : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = "venue key,venue," +
    "contact 1 name,contact 1 role,contact 1 phone,contact 1 email," +
    "contact 2 name,contact 2 role,contact 2 phone,contact 2 email," +
    "contact 3 name,contact 3 role,contact 3 phone,contact 3 email," +
    "address,notes,group,head office email";
  const body = rows.map((r) =>
    [r.venue_key, r.display_name,
     r.contact_name, r.contact_role, r.phone, r.email,
     r.contact2_name, r.contact2_role, r.contact2_phone, r.contact2_email,
     r.contact3_name, r.contact3_role, r.contact3_phone, r.contact3_email,
     r.address, r.notes, r.group_name, r.group_office_email].map(esc).join(",")
  ).join("\n");
  const csv = "\uFEFF" + header + "\n" + body; // BOM so Excel reads UTF-8 correctly
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="venue_contacts_${date}.csv"`);
  res.send(csv);
});

// Delete venues whose keys are NOT in the supplied list (used by the "complete list"
// sync option, only after the admin has confirmed on screen).
app.post("/api/delete-missing", requireAdmin, async (req, res) => {
  try {
    const keep = Array.isArray(req.body?.keepKeys) ? req.body.keepKeys.filter(Boolean) : [];
    const all = (await pool.query("SELECT name FROM venues WHERE agency_id=$1", [req.agencyId])).rows.map((r) => r.name);
    const keepSet = new Set(keep);
    const toDelete = all.filter((n) => !keepSet.has(n));
    for (const n of toDelete) {
      await pool.query("DELETE FROM venues WHERE name=$1 AND agency_id=$2", [n, req.agencyId]);
    }
    res.json({ deleted: toDelete.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- acts management (admin) ----------
app.get("/api/acts", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT a.id, a.name, a.email, a.email_status, a.email_status_at, a.car_reg,
            a.contact_name, a.phone, a.via_agent, a.agent_name, a.agent_email, a.stage_names,
            (SELECT count(*)::int FROM bookings b WHERE b.act_id = a.id) AS booking_count,
            (SELECT array_agg(DISTINCT b.performer_name)
               FROM bookings b
              WHERE b.act_id = a.id AND b.performer_name IS NOT NULL AND b.performer_name <> ''
            ) AS performed_as
     FROM acts a WHERE a.agency_id=$1 ORDER BY a.name`, [req.agencyId]
  )).rows;
  res.json({ acts: rows });
});

app.post("/api/update-act", requireAdmin, async (req, res) => {
  try {
    const { id, name, email } = req.body || {};
    const nm = (name || "").trim();
    const em = (email || "").trim().toLowerCase();
    if (!id || !nm) return res.status(400).json({ error: "A name is required." });
    // Email is optional (agent-booked acts are reached via the agent). If present, don't
    // let two acts collide on the same email.
    if (em) {
      const clash = (await pool.query("SELECT 1 FROM acts WHERE email=$1 AND id<>$2 AND agency_id=$3", [em, id, req.agencyId])).rows[0];
      if (clash) return res.status(409).json({ error: "Another act already uses that email." });
    }

    // Build an update from whichever fields were supplied (name always; email set to null
    // when blank; the rest only when present, so a simple save doesn't wipe contact details).
    const sets = ["name=$1", "email=$2"];
    const vals = [nm, em || null];
    let n = 3;
    const opt = (key, col, transform) => {
      if (req.body?.[key] !== undefined) {
        const v = (req.body[key] || "").toString().trim();
        sets.push(`${col}=$${n++}`);
        vals.push(transform ? transform(v) : (v || null));
      }
    };
    opt("car_reg", "car_reg", (v) => v.slice(0, 20).toUpperCase() || null);
    opt("contact_name", "contact_name");
    opt("phone", "phone");
    opt("stage_names", "stage_names");
    opt("agent_name", "agent_name");
    opt("agent_email", "agent_email", (v) => v.toLowerCase() || null);
    if (req.body?.via_agent !== undefined) {
      sets.push(`via_agent=$${n++}`);
      vals.push(req.body.via_agent === true || req.body.via_agent === "true");
    }
    vals.push(id, req.agencyId);
    await pool.query(`UPDATE acts SET ${sets.join(", ")} WHERE id=$${n++} AND agency_id=$${n++}`, vals);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/delete-act", requireAdmin, async (req, res) => {
  try {
    const id = (req.body?.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing act." });
    // bookings reference acts with ON DELETE CASCADE, so this removes their bookings too
    await pool.query("DELETE FROM acts WHERE id=$1 AND agency_id=$2", [id, req.agencyId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function sendConfirmEmail(act, gigCount, sender, notesList) {
  const link = `${APP_URL}/act/?act=${act.id}`;
  const plural = gigCount === 1 ? "a gig" : `${gigCount} gigs`;
  sender = sender || await senderForAgency(act.agency_id);
  // Greeting: list every stage name they're booked under this week, e.g.
  // "DJ Sparkle", "DJ Sparkle & The Sparkler", "A, B & C". Each name is escaped.
  const names = (Array.isArray(act.greetNames) && act.greetNames.length ? act.greetNames : [act.name])
    .filter(Boolean).map(esc);
  let greetHtml;
  if (names.length <= 1) greetHtml = names[0] || esc(act.name);
  else greetHtml = `${names.slice(0, -1).join(", ")} &amp; ${names[names.length - 1]}`;
  let noteHtml = "";
  const list = Array.isArray(notesList) ? notesList.filter(n => n && n.note && n.note.trim()) : [];
  if (list.length) {
    const items = list.map(n => `<li style="margin-bottom:4px"><strong>${esc(n.venue || "")}:</strong> ${esc(n.note.trim()).replace(/\n/g, "<br>")}</li>`).join("");
    noteHtml = `<div style="background:#fff8ec;border-left:4px solid #e8a13a;border-radius:8px;padding:12px 14px;margin:14px 0"><strong>Notes from us:</strong><ul style="margin:8px 0 0;padding-left:18px">${items}</ul></div>`;
  }
  await sendMail({
    from: sender.from,
    replyTo: sender.replyTo,
    to: act.email,
    subject: `Please confirm ${plural} for next week`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
        <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
        <p>Hi ${greetHtml},</p>
        <p>You're booked for <strong>${plural}</strong> next week. Please tap the button below to
           review the details and confirm you're all good. You'll also find the venue contact there.</p>
        ${noteHtml}
        <p style="text-align:center;margin:28px 0">
          <a href="${link}" style="background:#e8a13a;color:#14130f;padding:14px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">Review &amp; confirm my gigs</a>
        </p>
        <p style="color:#666;font-size:13px">If the button doesn't work, paste this into your browser:<br>${link}</p>
        <p style="color:#999;font-size:12px;margin-top:24px">Thanks!</p>
        ${emailFooter(sender)}
      </div>
    `,
  });
}

// ---------- daily reminders for still-pending future gigs ----------

// Parse booking date strings like "Wed 3 Jun 2026" into a Date (UTC midnight).
function parseGigDate(s) {
  if (!s) return null;
  const t = s.replace(/^[A-Za-z]{3,}\s+/, "").trim();
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return null;
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const mon = months[m[2].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Date.UTC(+m[3], mon, +m[1]));
}

async function sendReminderEmail(act, gigCount, sender) {
  const link = `${APP_URL}/act/?act=${act.id}`;
  const plural = gigCount === 1 ? "a gig that's" : `${gigCount} gigs that are`;
  sender = sender || await senderForAgency(act.agency_id);
  const greet = esc(act.name || "there");
  await sendMail({
    from: sender.from,
    replyTo: sender.replyTo,
    to: act.email,
    subject: `Reminder: please confirm your upcoming ${gigCount === 1 ? "gig" : "gigs"}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
        <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
        <p>Hi ${greet},</p>
        <p>Just a quick reminder — you have <strong>${plural}</strong> still awaiting confirmation.
           Please tap below to review and confirm.</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${link}" style="background:#e8a13a;color:#14130f;padding:14px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">Review &amp; confirm</a>
        </p>
        <p style="color:#666;font-size:13px">If the button doesn't work, paste this into your browser:<br>${link}</p>
        ${emailFooter(sender)}
      </div>
    `,
  });
}

// Find acts with pending FUTURE gigs and send each one reminder (once per day).
// If agencyId is given, only that agency is processed (manual button); otherwise all
// agencies are processed (nightly cron), each using its own sender address.
async function runReminders(agencyId, replyToEmail) {
  if (!resend) return { error: "Email not configured." };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  const params = [todayStr];
  let agencyFilter = "";
  if (agencyId) { params.push(agencyId); agencyFilter = " AND bk.agency_id = $2"; }

  const rows = (await pool.query(
    `SELECT bk.id, bk.gig_date, bk.act_id, bk.agency_id, a.name AS act_name, a.email AS act_email,
            a.via_agent, a.agent_email,
            bk.act_contact_name, bk.agent_contact_name, bk.performer_name
     FROM bookings bk JOIN acts a ON a.id = bk.act_id
     LEFT JOIN batches ba ON ba.id = bk.batch_id
     WHERE bk.status = 'pending'
       AND COALESCE(ba.archived, false) = false
       AND (bk.last_reminded IS NULL OR bk.last_reminded < $1)${agencyFilter}`, params
  )).rows;

  const future = rows.filter((r) => {
    const d = parseGigDate(r.gig_date);
    return d && d >= today;
  });

  // group by (agency, act) so each act/agent gets ONE reminder from their agency.
  // Greeting precedence matches the confirmation email: act contact > agent > stage/name.
  const byKey = new Map();
  for (const r of future) {
    const k = r.agency_id + "|" + r.act_id;
    if (!byKey.has(k)) {
      const greetName = r.act_contact_name || r.agent_contact_name || r.performer_name || r.act_name;
      const recipient = (r.act_email && r.act_email.trim()) ? r.act_email.trim()
        : (r.via_agent && r.agent_email ? r.agent_email.trim() : "");
      byKey.set(k, { agencyId: r.agency_id, act: { id: r.act_id, name: greetName, email: recipient }, ids: [] });
    }
    byKey.get(k).ids.push(r.id);
  }

  let emailed = 0, failed = 0, gigs = 0, skipped = 0;
  for (const { agencyId: aid, act, ids } of byKey.values()) {
    if (!act.email) { skipped++; continue; }   // no act email and not reachable via agent
    try {
      const sender = await senderForAgency(aid, replyToEmail);
      await sendReminderEmail(act, ids.length, sender);
      emailed++; gigs += ids.length;
      await pool.query(
        `UPDATE bookings SET last_reminded=$1, reminders_sent=reminders_sent+1 WHERE id = ANY($2)`,
        [todayStr, ids]
      );
    } catch (e) {
      failed++;
      console.error("reminder failed for", act.email, e.message);
    }
  }
  // Breakdown of why the scanned pending gigs weren't all emailed, to aid diagnosis.
  const unparseable = rows.filter((r) => !parseGigDate(r.gig_date)).length;
  const pastDated = rows.filter((r) => { const d = parseGigDate(r.gig_date); return d && d < today; }).length;
  return { acts: emailed, gigs, failed, skipped,
           scanned: rows.length, futureCount: future.length, groups: byKey.size,
           emailConfigured: !!resend, unparseableDates: unparseable, pastDated };
}

// Cron endpoint — called by Render Cron Job. Protected by a secret, not the admin cookie.
// Diagnostic: show why pending gigs are / aren't eligible for reminders (platform admin).
app.get("/api/debug-reminders", requireAdmin, async (req, res) => {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const rows = (await pool.query(
    `SELECT bk.id, bk.gig_date, bk.status, bk.last_reminded, a.email AS act_email,
            COALESCE(ba.archived,false) AS archived
     FROM bookings bk JOIN acts a ON a.id=bk.act_id
     LEFT JOIN batches ba ON ba.id=bk.batch_id
     WHERE bk.agency_id=$1 ORDER BY bk.created_at DESC LIMIT 50`, [req.agencyId]
  )).rows;
  const out = rows.map((r) => {
    const d = parseGigDate(r.gig_date);
    return {
      gig_date_raw: r.gig_date,
      parsed: d ? d.toISOString().slice(0, 10) : "COULD NOT PARSE",
      is_future: d ? (d >= today) : false,
      status: r.status,
      archived: r.archived,
      already_reminded_today: r.last_reminded ? (r.last_reminded >= todayStr) : false,
      has_email: !!r.act_email,
    };
  });
  res.json({ today: todayStr, emailConfigured: !!resend, gigs: out });
});

// Dry-run the reminder query (no emails sent) and report the exact counts at each
// stage, scoped to this agency — the definitive "why zero" check.
// Diagnostic: for one act, show each gig's venue linkage, share flag and resolved address.
app.get("/api/debug-act-venue", requireAdmin, async (req, res) => {
  const act = (req.query.act || "").toString();
  const rows = (await pool.query(
    `SELECT bk.id, bk.venue_text, bk.venue_key, bk.share_venue,
            v.name AS matched_venue, v.display_name, v.address AS venue_address
     FROM bookings bk
     LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id
     WHERE bk.act_id=$1 AND bk.agency_id=$2
     ORDER BY bk.created_at DESC LIMIT 20`, [act, req.agencyId]
  )).rows;
  res.json({ act, gigs: rows.map((r) => ({
    venue_text: r.venue_text,
    venue_key: r.venue_key,
    share_venue: r.share_venue,
    matched_a_saved_venue: !!r.matched_venue,
    venue_has_address: !!r.venue_address,
    address_would_show: !!(r.share_venue && r.venue_address),
  })) });
});

app.get("/api/debug-reminders-run", requireAdmin, async (req, res) => {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const rows = (await pool.query(
    `SELECT bk.id, bk.gig_date, bk.act_id, a.email AS act_email
     FROM bookings bk JOIN acts a ON a.id = bk.act_id
     LEFT JOIN batches ba ON ba.id = bk.batch_id
     WHERE bk.status = 'pending'
       AND COALESCE(ba.archived, false) = false
       AND (bk.last_reminded IS NULL OR bk.last_reminded < $1)
       AND bk.agency_id = $2`, [todayStr, req.agencyId]
  )).rows;
  const future = rows.filter((r) => { const d = parseGigDate(r.gig_date); return d && d >= today; });
  const acts = new Set(future.map((r) => r.act_id));
  res.json({
    today: todayStr,
    emailConfigured: !!resend,
    pendingUnremindedScanned: rows.length,
    futureEligible: future.length,
    distinctActsToEmail: acts.size,
    sampleDates: rows.slice(0, 5).map((r) => r.gig_date),
  });
});

app.post("/api/run-reminders", async (req, res) => {
  const provided = req.get("x-cron-secret") || req.query.secret;
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(403).json({ error: "Forbidden." });
  const result = await runReminders();     // all agencies
  res.json(result);
});

// Manual trigger from the dashboard — this agency only.
app.post("/api/send-reminders-now", requireAdmin, async (req, res) => {
  const result = await runReminders(req.agencyId, await userEmail(req.userId));
  res.json(result);
});

// Weekly team digest: emails each agency's team members a list of acts/gigs still
// unconfirmed for the current (non-archived) week. Only future-dated pending gigs.
async function runWeeklyDigest(agencyId) {
  if (!resend) return { error: "Email not configured." };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);

  // agencies to process
  const agencies = agencyId
    ? (await pool.query("SELECT id FROM agencies WHERE id=$1", [agencyId])).rows
    : (await pool.query("SELECT id FROM agencies WHERE active=true").catch(() => ({ rows: [] }))).rows;

  let sent = 0;
  for (const ag of agencies) {
    const aid = ag.id;
    // pending gigs in the current active batch
    const rows = (await pool.query(
      `SELECT a.name AS act_name, a.email AS act_email, bk.performer_name, bk.gig_date, bk.gig_time,
              COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS venue
       FROM bookings bk
       JOIN acts a ON a.id=bk.act_id
       LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
       LEFT JOIN batches ba ON ba.id=bk.batch_id
       WHERE bk.agency_id=$1 AND bk.status='pending' AND COALESCE(ba.archived,false)=false`,
      [aid]
    )).rows;

    // keep only future-dated gigs
    const pending = rows.filter((r) => { const d = parseGigDate(r.gig_date); return d && d >= today; });
    if (!pending.length) continue; // only send if something's outstanding

    // team recipients
    const team = (await pool.query("SELECT email FROM users WHERE agency_id=$1", [aid])).rows.map((u) => u.email).filter(Boolean);
    if (!team.length) continue;

    // build the list, grouped by act
    const byAct = new Map();
    for (const p of pending) {
      const key = p.act_name + "|" + p.act_email;
      if (!byAct.has(key)) byAct.set(key, { name: p.performer_name || p.act_name, email: p.act_email, gigs: [] });
      byAct.get(key).gigs.push({ venue: p.venue, when: [p.gig_date, p.gig_time].filter(Boolean).join(" · ") });
    }

    const sender = await senderForAgency(aid);
    const rowsHtml = [...byAct.values()].map((a) => {
      const gigLines = a.gigs.map((g) => `<div style="color:#555;font-size:13px">• ${esc(g.venue || "")}${g.when ? " — " + esc(g.when) : ""}</div>`).join("");
      return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee"><strong>${esc(a.name)}</strong><br><span style="color:#888;font-size:12px">${esc(a.email || "")}</span></td><td style="padding:8px 12px;border-bottom:1px solid #eee">${gigLines}</td></tr>`;
    }).join("");

    try {
      await sendMail({
        from: sender.from,
        replyTo: sender.replyTo,
        to: team,
        subject: `${pending.length} gig${pending.length === 1 ? "" : "s"} still unconfirmed`,
        html: `
          <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
            <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
            <p>Here's this week's outstanding confirmations — <strong>${byAct.size} act${byAct.size === 1 ? "" : "s"}</strong> still to confirm <strong>${pending.length} gig${pending.length === 1 ? "" : "s"}</strong>:</p>
            <table style="border-collapse:collapse;width:100%;margin:12px 0">
              <thead><tr><th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd">Act</th><th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd">Unconfirmed gigs</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
            <p style="color:#666;font-size:13px">You may want to chase these before the weekend. Reminders are also sent to acts automatically each morning.</p>
            ${emailFooter(sender)}
          </div>`,
      });
      sent++;
    } catch (e) {
      console.error("weekly digest failed for agency", aid, e.message);
    }
  }
  return { sent };
}

// Cron endpoint for the weekly digest. Protected by the shared secret.
// Render cron runs in UTC; to hit 10am UK time year-round (handling BST/GMT), the
// cron fires at both 09:00 and 10:00 UTC on Wednesday and this guard runs the digest
// only when it's actually 10am in London. Pass ?force=1 to bypass (manual/testing).
app.post("/api/run-weekly-digest", async (req, res) => {
  const provided = req.get("x-cron-secret") || req.query.secret;
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(403).json({ error: "Forbidden." });
  if (!req.query.force) {
    const londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date()));
    if (londonHour !== 10) return res.json({ skipped: true, reason: `Not 10am in London (currently ${londonHour}:00).` });
  }
  const result = await runWeeklyDigest();
  res.json(result);
});

// Manual trigger from the dashboard — this agency's team only.
app.post("/api/send-digest-now", requireAdmin, async (req, res) => {
  const result = await runWeeklyDigest(req.agencyId);
  res.json(result);
});

// ---------- per-agency cloud storage (OneDrive) ----------

// Get a usable access token + drive id for an agency, refreshing and persisting the
// rotated refresh token. Returns null if the agency has no (working) connection.
async function agencyStorage(agencyId) {
  const row = (await pool.query("SELECT provider, refresh_token, drive_id, account_name FROM storage_connections WHERE agency_id=$1", [agencyId])).rows[0];
  if (!row || !row.refresh_token) return null;
  const mod = STORAGE_PROVIDERS[row.provider];
  if (!mod) return null;
  try {
    const { accessToken, refreshToken } = await mod.refresh(decryptToken(row.refresh_token));
    // persist rotated refresh token (OneDrive rotates; Dropbox returns the same one)
    await pool.query("UPDATE storage_connections SET refresh_token=$1 WHERE agency_id=$2", [encryptToken(refreshToken), agencyId]);
    return { provider: row.provider, mod, accessToken, driveId: row.drive_id, accountName: row.account_name };
  } catch (e) {
    console.error("storage refresh failed for", agencyId, e.message);
    return null;
  }
}

// Owner starts the connect flow for a provider — redirect to its consent screen.
app.get("/api/storage/:provider/connect", requireAdmin, async (req, res) => {
  const mod = STORAGE_PROVIDERS[req.params.provider];
  if (!mod) return res.status(404).send("Unknown provider.");
  if (!mod.isConfigured()) return res.status(503).send("That storage provider isn't configured on the server yet.");
  const me = (await pool.query("SELECT is_owner FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
  if (!me || !me.is_owner) return res.status(403).send("Only the agency head can connect storage.");
  // signed state carries provider + agency id + nonce, so the callback is trustworthy
  const payload = `${req.params.provider}.${req.agencyId}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", _encKey).update(payload).digest("hex").slice(0, 32);
  const state = `${payload}.${sig}`;
  res.redirect(mod.authUrl(state));
});

// Provider redirects back here with a code; we store the agency's tokens.
app.get("/api/storage/:provider/callback", async (req, res) => {
  try {
    const mod = STORAGE_PROVIDERS[req.params.provider];
    if (!mod) return res.status(404).send("Unknown provider.");
    const { code, state, error, error_description } = req.query;
    if (error) return res.send(`<p>Connection cancelled: ${esc(error_description || error)}. You can close this window.</p>`);
    if (!code || !state) return res.status(400).send("Missing code/state.");
    const [provider, agencyId, ts, sig] = String(state).split(".");
    if (provider !== req.params.provider) return res.status(400).send("Provider mismatch.");
    const expect = crypto.createHmac("sha256", _encKey).update(`${provider}.${agencyId}.${ts}`).digest("hex").slice(0, 32);
    if (sig !== expect) return res.status(400).send("Invalid state.");

    const tokens = await mod.exchangeCode(code);
    if (!tokens.refresh_token) return res.status(400).send("No refresh token returned — please try again.");
    const info = await mod.getAccountInfo(tokens.access_token);
    await pool.query(
      `INSERT INTO storage_connections (agency_id, provider, account_name, drive_id, refresh_token, connected_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (agency_id) DO UPDATE SET provider=EXCLUDED.provider, account_name=EXCLUDED.account_name,
         drive_id=EXCLUDED.drive_id, refresh_token=EXCLUDED.refresh_token, connected_at=now()`,
      [agencyId, provider, info.accountName, info.driveId, encryptToken(tokens.refresh_token)]
    );
    const label = provider === "dropbox" ? "Dropbox" : provider === "gdrive" ? "Google Drive" : "OneDrive";
    res.send(`<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✓ ${label} connected</h2>
      <p>Connected as <b>${esc(info.accountName)}</b>. Your acts can now upload photos and videos, and they'll appear in your ${label} under "GigConfirm Uploads".</p>
      <p>You can close this window and return to GigConfirm.</p>
      <script>setTimeout(()=>{window.close&&window.close();},2500)</script></body>`);
  } catch (e) {
    console.error("storage callback failed", e);
    res.status(500).send("Couldn't complete the connection. Please try again.");
  }
});

// Status for the settings UI.
app.get("/api/storage/status", requireAdmin, async (req, res) => {
  const row = (await pool.query("SELECT provider, account_name, connected_at FROM storage_connections WHERE agency_id=$1", [req.agencyId])).rows[0];
  // which providers are configured on the server (so the UI shows the right buttons)
  const available = Object.entries(STORAGE_PROVIDERS).filter(([, m]) => m.isConfigured()).map(([k]) => k);
  res.json({
    serverConfigured: available.length > 0,
    available,
    connected: !!row,
    provider: row?.provider || null,
    accountName: row?.account_name || null,
    connectedAt: row?.connected_at || null,
  });
});

// Disconnect (owner-only).
app.post("/api/storage/disconnect", requireAdmin, async (req, res) => {
  const me = (await pool.query("SELECT is_owner FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
  if (!me || !me.is_owner) return res.status(403).json({ error: "Only the agency head can disconnect storage." });
  await pool.query("DELETE FROM storage_connections WHERE agency_id=$1", [req.agencyId]);
  res.json({ ok: true });
});

// ---------- Google Calendar import ----------

// Get a working access token for the agency's calendar connection.
async function agencyCalendar(agencyId) {
  const row = (await pool.query("SELECT refresh_token, account_name FROM calendar_connections WHERE agency_id=$1", [agencyId])).rows[0];
  if (!row || !row.refresh_token) return null;
  try {
    const { accessToken } = await gcal.refresh(decryptToken(row.refresh_token));
    return { accessToken, accountName: row.account_name };
  } catch (e) {
    console.error("calendar refresh failed for", agencyId, e.message);
    return null;
  }
}

app.get("/api/calendar/status", requireAdmin, async (req, res) => {
  const row = (await pool.query("SELECT account_name, connected_at FROM calendar_connections WHERE agency_id=$1", [req.agencyId])).rows[0];
  res.json({ serverConfigured: gcal.isConfigured(), connected: !!row, accountName: row?.account_name || null });
});

app.get("/api/calendar/google/connect", requireAdmin, async (req, res) => {
  if (!gcal.isConfigured()) return res.status(503).send("Calendar import isn't configured on the server yet.");
  const me = (await pool.query("SELECT is_owner FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
  if (!me || !me.is_owner) return res.status(403).send("Only the agency head can connect a calendar.");
  const payload = `${req.agencyId}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", _encKey).update(payload).digest("hex").slice(0, 32);
  res.redirect(gcal.authUrl(`${payload}.${sig}`));
});

app.get("/api/calendar/google/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.send(`<p>Connection cancelled. You can close this window.</p>`);
    if (!code || !state) return res.status(400).send("Missing code/state.");
    const [agencyId, ts, sig] = String(state).split(".");
    const expect = crypto.createHmac("sha256", _encKey).update(`${agencyId}.${ts}`).digest("hex").slice(0, 32);
    if (sig !== expect) return res.status(400).send("Invalid state.");
    const tokens = await gcal.exchangeCode(code);
    if (!tokens.refresh_token) return res.status(400).send("No refresh token returned — please try again.");
    const info = await gcal.getAccountInfo(tokens.access_token);
    await pool.query(
      `INSERT INTO calendar_connections (agency_id, provider, account_name, refresh_token, connected_at)
       VALUES ($1,'google',$2,$3,now())
       ON CONFLICT (agency_id) DO UPDATE SET account_name=EXCLUDED.account_name, refresh_token=EXCLUDED.refresh_token, connected_at=now()`,
      [agencyId, info.accountName, encryptToken(tokens.refresh_token)]
    );
    res.send(`<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✓ Google Calendar connected</h2><p>Connected as <b>${esc(info.accountName)}</b>. You can now import gigs from your calendars. Close this window to return to GigConfirm.</p>
      <script>setTimeout(()=>{window.close&&window.close();},2200)</script></body>`);
  } catch (e) {
    console.error("calendar callback failed", e);
    res.status(500).send("Couldn't complete the connection. Please try again.");
  }
});

app.post("/api/calendar/disconnect", requireAdmin, async (req, res) => {
  const me = (await pool.query("SELECT is_owner FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId])).rows[0];
  if (!me || !me.is_owner) return res.status(403).json({ error: "Only the agency head can disconnect." });
  await pool.query("DELETE FROM calendar_connections WHERE agency_id=$1", [req.agencyId]);
  res.json({ ok: true });
});

// List the connected account's calendars (for choosing which to import from).
app.get("/api/calendar/list", requireAdmin, async (req, res) => {
  try {
    const cal = await agencyCalendar(req.agencyId);
    if (!cal) return res.status(400).json({ error: "No calendar connected." });
    const cals = await gcal.listCalendars(cal.accessToken);
    res.json({ calendars: cals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse an event into { act, venue } using the "Act @ Venue" title convention. For a
// per-act calendar, the calendar name is the act if the title has no "@".
// Clean a venue string taken from a calendar title. Booking titles often tack on extra
// info after the venue — fee, set length, notes — e.g. "The Crown - £150 - 2x45".
// That must not pollute the venue name (matching) or be shown to the act. We keep only
// the venue portion: the text up to the first separator (dash/pipe/bullet) or fee marker.
function cleanCalVenue(raw) {
  let v = (raw || "").trim();
  if (!v) return "";

  // Booking-system titles append lots of admin after the venue name. Cut at the FIRST
  // strong "the venue name has ended" marker. These are far more reliable than guessing
  // at dashes — many real venue names contain " - " (e.g. "Mercure Hotel - Northampton").
  const markers = [
    /\(\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\s*\)/,   // UK postcode in brackets, e.g. (NN1 2TA)
    /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/,          // bare UK postcode, e.g. NN1 2TA
    /\(\s*form(erly|ally)\b/i,                        // "(formerly ..." / "(formally ..."
    /\(\s*(was|aka|previously|old)\b/i,               // other bracketed asides
    /\bfee\b\s*[:£$€]?/i,                             // "Fee £" / "Fee:"
    /[£$€]\s?\d/,                                     // a currency amount anywhere
    /\bbooking\s*type\b/i,
    /\btimes?\s*:/i,
    /\barrival\b\s*\d/i,
    /\b(setup|set up|bandcall|soundcheck|get[- ]?in|load[- ]?in|finish)\b\s*[:\d]/i,
    /\bspot\b\s*:/i,
    /\bnotes?\s*:/i,
    /\(\s*NPU\s*\)/i,                                 // booking-system code seen in titles
  ];
  let cut = v.length;
  for (const re of markers) {
    const m = v.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  v = v.slice(0, cut).trim();

  // tidy any trailing punctuation / dangling bracket left behind
  v = v.replace(/[\s,;:\-–—(]+$/, "").trim();
  return v;
}

function parseCalEvent(title, calendarName, isPrimaryOrMaster) {
  let act = "", venue = "";
  const at = title.indexOf("@");
  if (at >= 0) {
    act = title.slice(0, at).trim();
    venue = title.slice(at + 1).trim();
  } else {
    // no "@": treat the whole title as the venue, act = calendar name
    venue = title.trim();
    act = "";
  }
  // per-act calendar: prefer the calendar name as the act if the title didn't give one
  if (!act && calendarName) act = calendarName.trim();
  venue = cleanCalVenue(venue);
  // Pull the "Spot:" value from the title — the performance/set detail (e.g. "AS REQD").
  // Take everything after "Spot:" up to the next "; Field:" style marker or the end.
  let performance = "";
  const spotMatch = title.match(/\bspot\s*:\s*(.+)$/i);
  if (spotMatch) {
    performance = spotMatch[1]
      .split(/;\s*[A-Za-z][\w ]*:/)[0]   // stop at a following "Something:" field
      .replace(/[\s;,-]+$/, "")
      .trim();
  }
  return { act, venue, performance };
}

// Convert an event start (ISO dateTime or date) into GigConfirm's "Fri 18 Jul 2026" + time.
function calDateParts(start, allDay) {
  const d = new Date(start);
  if (isNaN(d)) return { date: "", time: "" };
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const date = `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  let time = "";
  if (!allDay) {
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? "pm" : "am"; const h12 = ((h + 11) % 12) + 1;
    time = m ? `${h12}:${String(m).padStart(2,"0")}${ap}` : `${h12}${ap}`;
  }
  return { date, time };
}

// Preview: fetch events in the range from the chosen calendars, parse, and match acts.
app.post("/api/calendar/preview", requireAdmin, async (req, res) => {
  try {
    const cal = await agencyCalendar(req.agencyId);
    if (!cal) return res.status(400).json({ error: "No calendar connected." });
    const calendarIds = Array.isArray(req.body?.calendarIds) ? req.body.calendarIds : [];
    const from = (req.body?.from || "").toString();
    const to = (req.body?.to || "").toString();
    if (!calendarIds.length) return res.status(400).json({ error: "Pick at least one calendar." });
    if (!from || !to) return res.status(400).json({ error: "Pick a date range." });
    const timeMin = new Date(from + "T00:00:00Z").toISOString();
    const timeMax = new Date(to + "T23:59:59Z").toISOString();

    // map calendar id -> name (for per-act calendars)
    const allCals = await gcal.listCalendars(cal.accessToken);
    const nameById = new Map(allCals.map((c) => [c.id, c.name]));

    // Load acts for matching. An act can perform under several names (its main name, its
    // stored stage names, its real/contact name, and names seen in past bookings). Index
    // ALL of them → the act's reachable email, so a calendar event using any of an act's
    // names still finds the right address. For agent-booked acts with no direct email, use
    // the agent email (that's how they're reached).
    const acts = (await pool.query(
      `SELECT a.name, a.email, a.contact_name, a.stage_names, a.via_agent, a.agent_email,
              (SELECT array_agg(DISTINCT b.performer_name) FROM bookings b
                WHERE b.act_id=a.id AND b.performer_name IS NOT NULL AND b.performer_name<>'') AS performed_as
       FROM acts a WHERE a.agency_id=$1`, [req.agencyId]
    )).rows;
    const validEmail = (e) => e && /\S+@\S+\.\S+/.test(e);
    const actByName = new Map();
    for (const a of acts) {
      const reach = validEmail(a.email) ? a.email : (a.via_agent && validEmail(a.agent_email) ? a.agent_email : "");
      if (!reach) continue;                       // no way to reach this act — skip indexing
      const names = [a.name, a.contact_name, ...String(a.stage_names || "").split(","), ...(Array.isArray(a.performed_as) ? a.performed_as : [])];
      for (const nm of names) {
        const key = (nm || "").trim().toLowerCase();
        if (key && !actByName.has(key)) actByName.set(key, reach);   // first act to claim a name wins
      }
    }

    const items = [];
    for (const cid of calendarIds) {
      const events = await gcal.listEvents(cal.accessToken, cid, timeMin, timeMax);
      for (const e of events) {
        const { act, venue, performance } = parseCalEvent(e.title, nameById.get(cid), false);
        const { date, time } = calDateParts(e.start, e.allDay);
        const matchedEmail = act ? (actByName.get(act.toLowerCase()) || "") : "";
        items.push({
          act, venue, date, time, performance,
          rawTitle: e.title,
          matched: !!matchedEmail,
          email: matchedEmail,
          issue: !act ? "No act name" : (!venue ? "No venue" : (!date ? "No date" : "")),
        });
      }
    }
    res.json({ ok: true, items });
  } catch (e) {
    console.error("calendar preview failed", e);
    res.status(500).json({ error: e.message });
  }
});

// Apply: create the gigs from a reviewed list. Each item: {act,email,venue,date,time}.
// mode: "new" starts a fresh week, "current" adds to the active week.
app.post("/api/calendar/apply", requireAdmin, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const mode = (req.body?.mode || "current").toString();
    if (!items.length) return res.status(400).json({ error: "Nothing to import." });

    // resolve target batch
    const typedLabel = (req.body?.label || "").toString().trim();
    let batch;
    if (mode === "new") {
      const label = typedLabel || ("Week of " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
      batch = (await pool.query("INSERT INTO batches (id, agency_id, label) VALUES ($1,$2,$3) RETURNING id",
        [nanoid(16), req.agencyId, label])).rows[0];
    } else {
      batch = (await pool.query("SELECT id FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1", [req.agencyId])).rows[0];
      if (!batch) {
        batch = (await pool.query("INSERT INTO batches (id, agency_id, label) VALUES ($1,$2,$3) RETURNING id",
          [nanoid(16), req.agencyId, typedLabel || "Imported gigs"])).rows[0];
      } else if (typedLabel) {
        // if adding to the current week and a name was typed, update the label to match
        await pool.query("UPDATE batches SET label=$1 WHERE id=$2", [typedLabel, batch.id]);
      }
    }
    const weekTag = new Date().toISOString().slice(0, 10);
    const storedVenues = (await pool.query("SELECT name, display_name, share_contact FROM venues WHERE agency_id=$1", [req.agencyId])).rows;

    let created = 0, skipped = 0;
    for (const it of items) {
      const email = (it.email || "").trim().toLowerCase();
      const actName = (it.act || "").trim();
      const venueText = (it.venue || "").trim();
      const date = (it.date || "").trim();
      if (!email || !/\S+@\S+\.\S+/.test(email) || !actName || !venueText || !date) { skipped++; continue; }

      // upsert act by email
      let a = (await pool.query("SELECT id FROM acts WHERE email=$1 AND agency_id=$2", [email, req.agencyId])).rows[0];
      if (!a) a = (await pool.query("INSERT INTO acts (id,agency_id,name,email) VALUES ($1,$2,$3,$4) RETURNING id",
        [nanoid(16), req.agencyId, actName, email])).rows[0];

      const matchedKey = await resolveVenueKey(venueText, storedVenues);
      const venueKey = matchedKey || normKey(venueText);
      const mv = storedVenues.find((v) => v.name === venueKey);
      const shareVenue = mv ? mv.share_contact !== false : true;
      // store the matched venue's proper name if we linked one; else the cleaned text
      const venueToStore = mv ? mv.display_name : venueText;
      const perf = (it.performance || "").trim() || null;   // the "Spot:" performance detail

      await pool.query(
        `INSERT INTO bookings (id,agency_id,act_id,performer_name,venue_key,venue_text,gig_date,gig_time,notes,week_tag,batch_id,share_venue,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
        [nanoid(16), req.agencyId, a.id, actName, venueKey, venueToStore, date, (it.time || "").trim() || null, perf, weekTag, batch.id, shareVenue]
      );
      created++;
    }
    res.json({ ok: true, created, skipped, batchId: batch.id });
  } catch (e) {
    console.error("calendar apply failed", e);
    res.status(500).json({ error: e.message });
  }
});

// Does THIS act's agency have uploads available? (used by the act page)
app.get("/api/upload-enabled", async (req, res) => {
  try {
    const actId = (req.query.act || "").toString();
    if (!actId) return res.json({ enabled: false });
    const act = (await pool.query("SELECT agency_id FROM acts WHERE id=$1", [actId])).rows[0];
    if (!act) return res.json({ enabled: false });
    const conn = (await pool.query("SELECT 1 FROM storage_connections WHERE agency_id=$1", [act.agency_id])).rows[0];
    res.json({ enabled: !!conn });
  } catch (_) {
    res.json({ enabled: false });
  }
});

// Act media upload → the act's agency's connected OneDrive, into a per-act folder.
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.post("/api/act-media", mediaUpload.array("files", 12), async (req, res) => {
  try {
    const actId = (req.query.act || req.body?.act || "").toString();
    if (!actId) return res.status(400).json({ error: "Missing act." });
    const act = (await pool.query("SELECT id, name, agency_id FROM acts WHERE id=$1", [actId])).rows[0];
    if (!act) return res.status(404).json({ error: "Act not found." });

    const store = await agencyStorage(act.agency_id);
    if (!store) return res.status(503).json({ error: "Uploads aren't available for this agency." });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files received." });
    const okType = (m) => /^image\//.test(m) || /^video\//.test(m);
    if (files.find((f) => !okType(f.mimetype))) return res.status(400).json({ error: "Only photos and videos can be uploaded." });

    let uploaded = 0;
    for (const f of files) {
      await store.mod.uploadFile(store, act.name, f.originalname, f.buffer, f.mimetype);
      uploaded++;
    }
    res.json({ ok: true, uploaded });
  } catch (e) {
    console.error("act-media upload failed", e);
    res.status(500).json({ error: "Upload failed. Please try again." });
  }
});

app.get("/api/my-gigs", async (req, res) => {
  const { act, b } = req.query;
  let rows;
  if (b) {
    rows = (await pool.query(
      `SELECT bk.*, 
              COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS display_name,
              CASE WHEN bk.share_venue THEN v.contact_name ELSE NULL END AS contact_name,
              CASE WHEN bk.share_venue THEN v.contact_role ELSE NULL END AS contact_role,
              CASE WHEN bk.share_venue THEN v.contact2_name ELSE NULL END AS contact2_name,
              CASE WHEN bk.share_venue THEN v.contact2_role ELSE NULL END AS contact2_role,
              CASE WHEN bk.share_venue THEN v.contact2_phone ELSE NULL END AS contact2_phone,
              CASE WHEN bk.share_venue THEN v.contact3_name ELSE NULL END AS contact3_name,
              CASE WHEN bk.share_venue THEN v.contact3_role ELSE NULL END AS contact3_role,
              CASE WHEN bk.share_venue THEN v.contact3_phone ELSE NULL END AS contact3_phone,
              CASE WHEN bk.share_venue THEN v.contact2_email ELSE NULL END AS contact2_email,
              CASE WHEN bk.share_venue THEN v.contact3_email ELSE NULL END AS contact3_email,
              CASE WHEN bk.share_venue THEN v.notes ELSE NULL END AS venue_notes,
              CASE WHEN bk.share_venue THEN v.phone ELSE NULL END AS phone,
              CASE WHEN bk.share_venue THEN v.email ELSE NULL END AS venue_email,
              v.address AS address
       FROM bookings bk LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id WHERE bk.id=$1`, [b])).rows;
  } else if (act) {
    rows = (await pool.query(
      `SELECT bk.*, a.name AS act_name,
              COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS display_name,
              CASE WHEN bk.share_venue THEN v.contact_name ELSE NULL END AS contact_name,
              CASE WHEN bk.share_venue THEN v.contact_role ELSE NULL END AS contact_role,
              CASE WHEN bk.share_venue THEN v.contact2_name ELSE NULL END AS contact2_name,
              CASE WHEN bk.share_venue THEN v.contact2_role ELSE NULL END AS contact2_role,
              CASE WHEN bk.share_venue THEN v.contact2_phone ELSE NULL END AS contact2_phone,
              CASE WHEN bk.share_venue THEN v.contact3_name ELSE NULL END AS contact3_name,
              CASE WHEN bk.share_venue THEN v.contact3_role ELSE NULL END AS contact3_role,
              CASE WHEN bk.share_venue THEN v.contact3_phone ELSE NULL END AS contact3_phone,
              CASE WHEN bk.share_venue THEN v.contact2_email ELSE NULL END AS contact2_email,
              CASE WHEN bk.share_venue THEN v.contact3_email ELSE NULL END AS contact3_email,
              CASE WHEN bk.share_venue THEN v.notes ELSE NULL END AS venue_notes,
              CASE WHEN bk.share_venue THEN v.phone ELSE NULL END AS phone,
              CASE WHEN bk.share_venue THEN v.email ELSE NULL END AS venue_email,
              v.address AS address
       FROM bookings bk
       JOIN acts a ON a.id = bk.act_id
       LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id
       LEFT JOIN batches ba ON ba.id = bk.batch_id
       WHERE bk.act_id=$1 AND COALESCE(ba.archived, false) = false
       ORDER BY bk.gig_date, bk.created_at DESC`, [act])).rows;

    // Previous check-offs: gigs this act CONFIRMED in the last 14 days, even if the
    // week is now archived. Read-only, shown separately for reference.
    const previous = (await pool.query(
      `SELECT bk.id, bk.performer_name, bk.gig_date, bk.gig_time, bk.status, bk.responded_at,
              COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS display_name,
              CASE WHEN bk.share_venue THEN v.contact_name ELSE NULL END AS contact_name,
              CASE WHEN bk.share_venue THEN v.contact_role ELSE NULL END AS contact_role,
              CASE WHEN bk.share_venue THEN v.contact2_name ELSE NULL END AS contact2_name,
              CASE WHEN bk.share_venue THEN v.contact2_role ELSE NULL END AS contact2_role,
              CASE WHEN bk.share_venue THEN v.contact2_phone ELSE NULL END AS contact2_phone,
              CASE WHEN bk.share_venue THEN v.contact3_name ELSE NULL END AS contact3_name,
              CASE WHEN bk.share_venue THEN v.contact3_role ELSE NULL END AS contact3_role,
              CASE WHEN bk.share_venue THEN v.contact3_phone ELSE NULL END AS contact3_phone,
              CASE WHEN bk.share_venue THEN v.contact2_email ELSE NULL END AS contact2_email,
              CASE WHEN bk.share_venue THEN v.contact3_email ELSE NULL END AS contact3_email,
              CASE WHEN bk.share_venue THEN v.notes ELSE NULL END AS venue_notes,
              CASE WHEN bk.share_venue THEN v.phone ELSE NULL END AS phone,
              CASE WHEN bk.share_venue THEN v.email ELSE NULL END AS venue_email,
              v.address AS address
       FROM bookings bk
       LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id
       LEFT JOIN batches ba ON ba.id = bk.batch_id
       WHERE bk.act_id=$1
         AND COALESCE(ba.archived, false) = true
         AND bk.status = 'confirmed'
         AND bk.responded_at IS NOT NULL
         AND bk.responded_at >= now() - interval '14 days'
       ORDER BY bk.responded_at DESC`, [act])).rows;
    res.locals.previous = previous;
  } else {
    return res.status(400).json({ error: "Need an act or booking reference." });
  }
  // gig_date is free text ("Wed 3 Jun 2026"), so sort by the actual parsed date;
  // anything unparseable falls to the end but keeps a stable order.
  rows.sort((a, b) => {
    const da = parseGigDate(a.gig_date), db = parseGigDate(b.gig_date);
    if (da && db) return da - db;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return 0;
  });
  // Attach the agency's branding (name, logo, phone) so the act's page can show who
  // the booking is from and how to reach them.
  let agency = null;
  const agencyId = rows[0]?.agency_id || res.locals.previous?.[0]?.agency_id;
  if (agencyId) {
    const s = await senderForAgency(agencyId);
    agency = { name: s.agencyName, logoUrl: s.logoUrl, website: s.website, phone: s.phone };
  }
  // The act's saved car registration (per-act), so their page can show/edit it.
  let actId = act || rows[0]?.act_id || null;
  let carReg = "";
  if (actId) {
    const ar = (await pool.query("SELECT car_reg FROM acts WHERE id=$1", [actId])).rows[0];
    carReg = ar?.car_reg || "";
  }
  // Current week's news bulletin (only if switched on), shown at the top of the page.
  let bulletin = "";
  if (agencyId) {
    const bt = (await pool.query(
      "SELECT bulletin, bulletin_on FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1",
      [agencyId]
    )).rows[0];
    if (bt && bt.bulletin_on && bt.bulletin) bulletin = bt.bulletin;
  }
  res.json({ gigs: rows, previous: res.locals.previous || [], agency, actId, carReg, bulletin });
});

// act confirms / flags a gig
// Resolve a flagged gig: record what was done (notes) and mark it completed.
// Manually confirm a gig when the act contacted us directly (call/text). Records who
// did it and when, in the booking's message, so there's a clear audit trail.
// Add a one-off gig by hand (last-minute bookings / swaps) to the current week.
// Optionally email the act their check straight away.
app.post("/api/add-gig", requireAdmin, async (req, res) => {
  try {
    const actName = (req.body?.actName || "").trim();
    const actEmail = (req.body?.actEmail || "").trim().toLowerCase();
    const venueText = (req.body?.venue || "").trim();
    let gigDate = (req.body?.date || "").trim();
    // The date picker sends YYYY-MM-DD; store it in the same style as CSV gigs
    // ("Fri 18 Jul 2026") so it displays and sorts consistently everywhere.
    const iso = gigDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
      const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      gigDate = `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    const gigTime = (req.body?.time || "").trim();
    const notes = (req.body?.notes || "").trim();
    const emailNow = req.body?.emailNow === true || req.body?.emailNow === "true";
    if (!actName || !actEmail) return res.status(400).json({ error: "Act name and email are required." });
    if (!/\S+@\S+\.\S+/.test(actEmail)) return res.status(400).json({ error: "That act email doesn't look valid." });
    if (!venueText) return res.status(400).json({ error: "Venue is required." });
    if (!gigDate) return res.status(400).json({ error: "Date is required." });

    // current active week
    const active = (await pool.query(
      "SELECT id FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1",
      [req.agencyId]
    )).rows[0];
    if (!active) return res.status(400).json({ error: "No active week — upload or start a week first." });
    const weekTag = new Date().toISOString().slice(0, 10);

    // upsert the act by email (scoped to this agency)
    let act = (await pool.query("SELECT * FROM acts WHERE email=$1 AND agency_id=$2", [actEmail, req.agencyId])).rows[0];
    if (!act) {
      const id = nanoid(16);
      act = (await pool.query(
        "INSERT INTO acts (id,agency_id,name,email) VALUES ($1,$2,$3,$4) RETURNING *",
        [id, req.agencyId, actName, actEmail]
      )).rows[0];
    }

    // match the venue to a saved one if possible (so contacts/address flow through)
    const storedVenues = (await pool.query("SELECT name, share_contact FROM venues WHERE agency_id=$1", [req.agencyId])).rows;
    const matchedKey = await resolveVenueKey(venueText, storedVenues);
    const venueKey = matchedKey || normKey(venueText);
    const matchedVenue = storedVenues.find((v) => v.name === venueKey);
    const shareVenue = matchedVenue ? matchedVenue.share_contact !== false : true;

    const bookingId = nanoid(16);
    await pool.query(
      `INSERT INTO bookings (id,agency_id,act_id,performer_name,venue_key,venue_text,gig_date,gig_time,notes,week_tag,batch_id,share_venue,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
      [bookingId, req.agencyId, act.id, actName, venueKey, venueText, gigDate, gigTime, notes || null, weekTag, active.id, shareVenue]
    );

    let emailed = false;
    if (emailNow) {
      try {
        const sender = await senderForAgency(req.agencyId, await userEmail(req.userId));
        await sendConfirmEmail({ id: act.id, name: act.name, email: act.email, agency_id: req.agencyId, greetNames: [actName] }, 1, sender, []);
        await pool.query("UPDATE bookings SET invited_at=now() WHERE id=$1", [bookingId]);
        emailed = true;
      } catch (e) {
        // gig is still added; report the email failure
        return res.json({ ok: true, added: true, emailed: false, emailError: e.message });
      }
    }
    res.json({ ok: true, added: true, emailed });
  } catch (e) {
    console.error("add-gig failed", e);
    res.status(500).json({ error: e.message });
  }
});

// Set (or clear) the greeting name used for an act across their current-week bookings —
// stored as the act contact name (the top-priority greeting override).
app.post("/api/set-agent-contact", requireAdmin, async (req, res) => {
  try {
    const actId = (req.body?.actId || "").toString();
    const name = (req.body?.name || "").toString().trim().slice(0, 120);
    const active = (await pool.query(
      "SELECT id FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1",
      [req.agencyId]
    )).rows[0];
    if (!active) return res.status(400).json({ error: "No active week." });
    await pool.query(
      "UPDATE bookings SET act_contact_name=$1 WHERE act_id=$2 AND batch_id=$3 AND agency_id=$4",
      [name || null, actId, active.id, req.agencyId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/manual-check", requireAdmin, async (req, res) => {
  try {
    const bookingId = (req.body?.bookingId || "").toString();
    const who = (await userEmail(req.userId)) || "a team member";
    const bk = (await pool.query("SELECT id, status FROM bookings WHERE id=$1 AND agency_id=$2", [bookingId, req.agencyId])).rows[0];
    if (!bk) return res.status(404).json({ error: "No such gig." });
    const stamp = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const note = `Manually checked off by ${who.split("@")[0]} on ${stamp} (act contacted us directly)`;
    await pool.query(
      "UPDATE bookings SET status='confirmed', message=$1, responded_at=now() WHERE id=$2 AND agency_id=$3",
      [note, bookingId, req.agencyId]
    );
    // if this was the last pending gig, the completion summary can now fire
    const full = (await pool.query("SELECT batch_id, agency_id FROM bookings WHERE id=$1", [bookingId])).rows[0];
    if (full) { try { await maybeSendCompletion(full.batch_id, full.agency_id); } catch (_) {} }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/resolve-gig", requireAdmin, async (req, res) => {
  try {
    const bookingId = (req.body?.bookingId || "").toString();
    const note = (req.body?.note || "").trim();
    const who = (await userEmail(req.userId)) || "";
    const bk = (await pool.query("SELECT id FROM bookings WHERE id=$1 AND agency_id=$2", [bookingId, req.agencyId])).rows[0];
    if (!bk) return res.status(404).json({ error: "No such gig." });
    await pool.query(
      "UPDATE bookings SET status='resolved', resolution_note=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND agency_id=$4",
      [note || null, who, bookingId, req.agencyId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The act can set their own car registration from their check-off page (no login;
// identified by their act id, same as the respond/my-gigs flow).
app.post("/api/set-car-reg", async (req, res) => {
  try {
    const actId = (req.body?.actId || "").toString();
    const reg = (req.body?.carReg || "").toString().trim().slice(0, 20).toUpperCase();
    if (!actId) return res.status(400).json({ error: "Missing act." });
    const ok = (await pool.query("SELECT id FROM acts WHERE id=$1", [actId])).rows[0];
    if (!ok) return res.status(404).json({ error: "No such act." });
    await pool.query("UPDATE acts SET car_reg=$1 WHERE id=$2", [reg || null, actId]);
    res.json({ ok: true, carReg: reg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/respond", async (req, res) => {
  const { bookingId, status, message } = req.body || {};
  if (!["confirmed", "issue"].includes(status)) return res.status(400).json({ error: "Bad status." });
  await pool.query(
    "UPDATE bookings SET status=$1, message=$2, responded_at=now() WHERE id=$3",
    [status, message || null, bookingId]
  );
  res.json({ ok: true });

  // After responding, check whether this was the last pending gig in the batch and,
  // if so, email the team the completion CSV (best-effort, after the response is sent).
  try {
    const bk = (await pool.query("SELECT batch_id, agency_id FROM bookings WHERE id=$1", [bookingId])).rows[0];
    if (bk) await maybeSendCompletion(bk.batch_id, bk.agency_id);
  } catch (e) { console.error("completion check failed", e.message); }

  // If the act flagged a problem, notify the agency's team (best-effort, after
  // responding so the act's page never waits on it).
  if (status === "issue") {
    try {
      if (!resend) return;
      const b = (await pool.query(
        `SELECT bk.agency_id, bk.performer_name, bk.gig_date, bk.gig_time, bk.message,
                a.name AS act_name, a.email AS act_email,
                COALESCE(NULLIF(bk.venue_text,''), v.display_name) AS venue
         FROM bookings bk
         JOIN acts a ON a.id=bk.act_id
         LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
         WHERE bk.id=$1`, [bookingId]
      )).rows[0];
      if (!b) return;
      const team = (await pool.query("SELECT email FROM users WHERE agency_id=$1", [b.agency_id])).rows
        .map((u) => u.email).filter(Boolean);
      if (!team.length) return;
      const sender = await senderForAgency(b.agency_id);
      const when = [b.gig_date, b.gig_time].filter(Boolean).join(" · ");
      await sendMail({
        from: sender.from,
        replyTo: b.act_email || sender.replyTo,
        to: team,
        subject: `⚠ ${b.performer_name || b.act_name} flagged an issue`,
        html: `
          <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#222">
            <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
            <p><strong>${esc(b.performer_name || b.act_name)}</strong> has flagged a problem with a gig:</p>
            <div style="background:#fdf3f1;border-left:4px solid #e2614b;border-radius:8px;padding:12px 14px;margin:12px 0">
              <div><strong>Venue:</strong> ${esc(b.venue || "—")}</div>
              <div><strong>When:</strong> ${esc(when || "—")}</div>
              ${b.message ? `<div style="margin-top:8px"><strong>Their message:</strong><br>“${esc(b.message)}”</div>` : `<div style="margin-top:8px;color:#888">No message was left.</div>`}
            </div>
            <p style="font-size:13px">You can reply directly to this email to reach ${esc(b.act_name)}${b.act_email ? ` (${esc(b.act_email)})` : ""}, or check the dashboard.</p>
            ${emailFooter(sender)}
          </div>`,
      });
    } catch (e) {
      console.error("issue-notify email failed", e.message);
    }
  }
});

// ---------- admin dashboard data ----------
// Get / set the current week's news bulletin (shown on every act's page).
app.get("/api/bulletin", requireAdmin, async (req, res) => {
  const b = (await pool.query(
    "SELECT bulletin, bulletin_on FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1",
    [req.agencyId]
  )).rows[0];
  res.json({ bulletin: b?.bulletin || "", bulletin_on: !!b?.bulletin_on });
});

app.post("/api/bulletin", requireAdmin, async (req, res) => {
  const text = (req.body?.bulletin || "").toString().slice(0, 1000);
  const on = req.body?.bulletin_on === true || req.body?.bulletin_on === "true";
  const active = (await pool.query(
    "SELECT id FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1",
    [req.agencyId]
  )).rows[0];
  if (!active) return res.status(400).json({ error: "No active week to post a bulletin to." });
  await pool.query("UPDATE batches SET bulletin=$1, bulletin_on=$2 WHERE id=$3 AND agency_id=$4",
    [text.trim() || null, on, active.id, req.agencyId]);
  res.json({ ok: true });
});

app.get("/api/dashboard", requireAdmin, async (req, res) => {
  const active = (await pool.query("SELECT id,label FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1", [req.agencyId])).rows[0];
  const rows = active ? (await pool.query(
    `SELECT bk.*, a.name AS act_name, a.email AS act_email, a.email_status,
            v.display_name, v.contact_name, v.phone, v.email AS venue_email, v.address
     FROM bookings bk
     JOIN acts a ON a.id = bk.act_id
     LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id
     WHERE bk.batch_id = $1 AND bk.agency_id = $2
     ORDER BY bk.gig_date, bk.created_at DESC`, [active.id, req.agencyId]
  )).rows : [];
  res.json({ bookings: rows, activeLabel: active?.label || null });
});

// ---------- venue lineups (FYI emails to venues) ----------
// Group the active week's bookings by venue, listing the acts at each.
app.get("/api/venue-lineups", requireAdmin, async (req, res) => {
  const active = (await pool.query("SELECT id,label FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1", [req.agencyId])).rows[0];
  if (!active) return res.json({ venues: [], activeLabel: null });
  const rows = (await pool.query(
    `SELECT bk.performer_name, a.name AS act_name, a.car_reg, bk.gig_date, bk.gig_time, bk.notes,
            COALESCE(v.display_name, bk.venue_text) AS venue,
            v.email AS venue_email, v.contact2_email, v.contact3_email,
            v.name AS venue_key, bk.venue_text, v.brand_id,
            br.name AS brand_name, br.office_email AS brand_office_email
     FROM bookings bk JOIN acts a ON a.id = bk.act_id
     LEFT JOIN venues v ON v.name = bk.venue_key AND v.agency_id = bk.agency_id
     LEFT JOIN brands br ON br.id = v.brand_id AND br.agency_id = bk.agency_id
     WHERE bk.batch_id = $1 AND bk.agency_id = $2
     ORDER BY venue, bk.gig_date`, [active.id, req.agencyId]
  )).rows;

  // group by venue display name
  const map = new Map();
  const brandMap = new Map();  // brand_id -> {id,name,office_email,venueCount}
  for (const r of rows) {
    const name = r.venue || "(no venue)";
    if (!map.has(name)) {
      // combine all three contact emails into one recipient list for this venue
      const emails = [r.venue_email, r.contact2_email, r.contact3_email]
        .filter((e) => e && e.trim()).join(", ");
      map.set(name, { venue: name, venue_key: r.venue_key, email: emails, brand_id: r.brand_id || null, brand_name: r.brand_name || null, acts: [] });
    }
    map.get(name).acts.push({
      act: r.performer_name || r.act_name,
      date: r.gig_date, time: r.gig_time, notes: r.notes, car_reg: r.car_reg || "",
    });
    if (r.brand_id && !brandMap.has(r.brand_id)) {
      brandMap.set(r.brand_id, { id: r.brand_id, name: r.brand_name, office_email: r.brand_office_email || "", venues: new Set() });
    }
    if (r.brand_id) brandMap.get(r.brand_id).venues.add(name);
  }
  const venues = [...map.values()];
  const brands = [...brandMap.values()].map((b) => ({ id: b.id, name: b.name, office_email: b.office_email, venue_count: b.venues.size }));

  // flag deliverability for each venue's email (may hold several addresses)
  const allAddrs = [];
  for (const v of venues) (v.email || "").split(/[,;]+/).forEach((e) => { const t = e.trim().toLowerCase(); if (t) allAddrs.push(t); });
  const statusMap = await latestEmailStatus(allAddrs);
  for (const v of venues) {
    const addrs = (v.email || "").split(/[,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    v.email_status = addrs.map((a) => statusMap[a]).find((s) => s === "bounced" || s === "complained") ||
                     (addrs.some((a) => statusMap[a] === "delivered") ? "delivered" : null);
  }

  res.json({ venues, brands, activeLabel: active.label });
});

// Send one venue their lineup (FYI only — no confirm link). Emails every address in
// the venue's email field (comma/semicolon separated), plus any extra typed in.
app.post("/api/send-venue-lineup", requireAdmin, async (req, res) => {
  try {
    if (!resend) return res.status(500).json({ error: "Email not configured." });
    const { venue, acts, emails, weekLabel, brandName } = req.body || {};
    const recipients = (emails || "")
      .split(/[,;]+/).map((e) => e.trim()).filter((e) => /\S+@\S+\.\S+/.test(e));
    if (!recipients.length) return res.status(400).json({ error: "No valid email address for this venue." });
    if (!Array.isArray(acts) || !acts.length) return res.status(400).json({ error: "No acts to list." });
    const venueLabel = brandName ? `${venue} (${brandName})` : venue;

    const rowsHtml = acts.map((a) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(a.date || "")}${a.time ? " · " + esc(a.time) : ""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee"><strong>${esc(a.act || "")}</strong></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">${a.car_reg ? `<span style="font-family:monospace;background:#f0f0f0;padding:1px 6px;border-radius:4px">${esc(a.car_reg)}</span>` : ""}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">${esc(a.notes || "")}</td>
      </tr>`).join("");

    const sender = await senderForAgency(req.agencyId, await userEmail(req.userId));
    await sendMail({
      from: sender.from,
      replyTo: sender.replyTo,
      to: recipients,
      subject: `Your entertainment lineup${weekLabel ? " — " + weekLabel : ""}: ${venue}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
          <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
          <p>Hi,</p>
          <p>Here's the entertainment booked for <strong>${esc(venueLabel)}</strong>${weekLabel ? " (" + esc(weekLabel) + ")" : ""}. This is for your information — no action needed.</p>
          <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
            <thead><tr>
              <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #333">Date</th>
              <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #333">Act</th>
              <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #333">Car reg</th>
              <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #333">Details</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="color:#999;font-size:12px">Sent for your information only.</p>
          ${emailFooter(sender)}
        </div>`,
    });
    res.json({ ok: true, sentTo: recipients.length });
  } catch (e) {
    console.error("venue lineup failed", e);
    res.status(500).json({ error: e.message });
  }
});

// Send a whole brand's lineup to its head office: one email listing every venue of that
// brand in the current active week, grouped by venue, to the brand's office_email(s).
app.post("/api/send-brand-lineup", requireAdmin, async (req, res) => {
  try {
    if (!resend) return res.status(500).json({ error: "Email not configured." });
    const brandId = (req.body?.brandId || "").toString();
    const brand = (await pool.query("SELECT id, name, office_email FROM brands WHERE id=$1 AND agency_id=$2", [brandId, req.agencyId])).rows[0];
    if (!brand) return res.status(404).json({ error: "No such brand." });
    const recipients = (brand.office_email || "")
      .split(/[,;]+/).map((e) => e.trim()).filter((e) => /\S+@\S+\.\S+/.test(e));
    if (!recipients.length) return res.status(400).json({ error: "This brand has no head-office email set. Add one in Team & account → Brands." });

    const active = (await pool.query("SELECT id,label FROM batches WHERE archived=false AND agency_id=$1 ORDER BY created_at DESC LIMIT 1", [req.agencyId])).rows[0];
    if (!active) return res.status(400).json({ error: "No active week to send." });

    const rows = (await pool.query(
      `SELECT COALESCE(v.display_name, bk.venue_text) AS venue,
              bk.performer_name, a.name AS act_name, a.car_reg, bk.gig_date, bk.gig_time, bk.notes
       FROM bookings bk JOIN acts a ON a.id=bk.act_id
       JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
       WHERE bk.batch_id=$1 AND bk.agency_id=$2 AND v.brand_id=$3
       ORDER BY venue, bk.gig_date`, [active.id, req.agencyId, brandId]
    )).rows;
    if (!rows.length) return res.status(400).json({ error: "No gigs for this brand in the current week." });

    // group by venue
    const byVenue = new Map();
    for (const r of rows) {
      const vn = r.venue || "(no venue)";
      if (!byVenue.has(vn)) byVenue.set(vn, []);
      byVenue.get(vn).push(r);
    }
    const sections = [...byVenue.entries()].map(([vn, acts]) => {
      const rowsHtml = acts.map((a) => `
        <tr>
          <td style="padding:7px 12px;border-bottom:1px solid #eee">${esc(a.gig_date || "")}${a.gig_time ? " · " + esc(a.gig_time) : ""}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #eee"><strong>${esc(a.performer_name || a.act_name || "")}</strong></td>
          <td style="padding:7px 12px;border-bottom:1px solid #eee;color:#555">${a.car_reg ? `<span style="font-family:monospace;background:#f0f0f0;padding:1px 6px;border-radius:4px">${esc(a.car_reg)}</span>` : ""}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #eee;color:#555">${esc(a.notes || "")}</td>
        </tr>`).join("");
      return `<h3 style="margin:20px 0 6px">${esc(vn)}</h3>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          <thead><tr>
            <th style="text-align:left;padding:7px 12px;border-bottom:2px solid #333">Date</th>
            <th style="text-align:left;padding:7px 12px;border-bottom:2px solid #333">Act</th>
            <th style="text-align:left;padding:7px 12px;border-bottom:2px solid #333">Car reg</th>
            <th style="text-align:left;padding:7px 12px;border-bottom:2px solid #333">Details</th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>`;
    }).join("");

    const sender = await senderForAgency(req.agencyId, await userEmail(req.userId));
    await sendMail({
      from: sender.from,
      replyTo: sender.replyTo,
      to: recipients,
      subject: `Entertainment lineup — ${brand.name}${active.label ? " — " + active.label : ""}`,
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
          <div style="text-align:center;margin-bottom:12px"><img src="${sender.logoUrl}" alt="${esc(sender.agencyName)}" style="max-width:200px;max-height:64px;height:auto;width:auto"></div>
          <p>Hi,</p>
          <p>Here's the entertainment booked across your <strong>${esc(brand.name)}</strong> venues${active.label ? " for " + esc(active.label) : ""}. This is for your information — no action needed.</p>
          ${sections}
          <p style="color:#999;font-size:12px;margin-top:20px">Sent for your information only.</p>
          ${emailFooter(sender)}
        </div>`,
    });
    res.json({ ok: true, sentTo: recipients.length, venues: byVenue.size });
  } catch (e) {
    console.error("brand lineup failed", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- history / archive (admin) ----------
// List all batches with their status tallies.
app.get("/api/batches", requireAdmin, async (req, res) => {
  const rows = (await pool.query(
    `SELECT b.id, b.label, b.archived, b.created_at,
            count(bk.*)::int AS total,
            count(bk.*) FILTER (WHERE bk.status='confirmed')::int AS confirmed,
            count(bk.*) FILTER (WHERE bk.status='pending')::int AS pending,
            count(bk.*) FILTER (WHERE bk.status='issue')::int AS issue,
            count(bk.*) FILTER (WHERE bk.status='resolved')::int AS resolved
     FROM batches b LEFT JOIN bookings bk ON bk.batch_id = b.id
     WHERE b.agency_id=$1
     GROUP BY b.id ORDER BY b.created_at DESC`, [req.agencyId]
  )).rows;
  res.json({ batches: rows });
});

// One batch's bookings + a response timeline.
app.get("/api/batch", requireAdmin, async (req, res) => {
  const id = (req.query.id || "").toString();
  const batch = (await pool.query("SELECT * FROM batches WHERE id=$1 AND agency_id=$2", [id, req.agencyId])).rows[0];
  if (!batch) return res.status(404).json({ error: "No such week." });
  const bookings = (await pool.query(
    `SELECT bk.*, a.name AS act_name, a.email AS act_email, v.display_name
     FROM bookings bk JOIN acts a ON a.id=bk.act_id
     LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
     WHERE bk.batch_id=$1 AND bk.agency_id=$2 ORDER BY bk.gig_date, bk.created_at`, [id, req.agencyId])).rows;
  const timeline = (await pool.query(
    `SELECT bk.performer_name, COALESCE(v.display_name,bk.venue_text) AS venue,
            bk.status, bk.responded_at, bk.message
     FROM bookings bk LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
     WHERE bk.batch_id=$1 AND bk.agency_id=$2 AND bk.responded_at IS NOT NULL
     ORDER BY bk.responded_at DESC`, [id, req.agencyId])).rows;
  res.json({ batch, bookings, timeline });
});

// Delete one archived week. Restricted to the agency head (owner), who must re-enter
// their password to confirm this destructive action.
app.post("/api/delete-batch", requireAdmin, async (req, res) => {
  const id = (req.body?.id || "").toString();
  const password = (req.body?.password || "").toString();

  // Must be the agency owner (the person who created the agency).
  const me = (await pool.query(
    "SELECT is_owner, pass_hash FROM users WHERE id=$1 AND agency_id=$2", [req.userId, req.agencyId]
  )).rows[0];
  if (!me || !me.is_owner) {
    return res.status(403).json({ error: "Only the agency's head can delete archived weeks." });
  }
  if (!password || !verifyPassword(password, me.pass_hash)) {
    return res.status(403).json({ error: "Password incorrect." });
  }
  // Only allow deleting weeks that are actually archived.
  const batch = (await pool.query("SELECT archived FROM batches WHERE id=$1 AND agency_id=$2", [id, req.agencyId])).rows[0];
  if (!batch) return res.status(404).json({ error: "No such week." });
  if (!batch.archived) return res.status(400).json({ error: "Only archived weeks can be deleted." });

  await pool.query("DELETE FROM bookings WHERE batch_id=$1 AND agency_id=$2", [id, req.agencyId]);
  await pool.query("DELETE FROM batches WHERE id=$1 AND agency_id=$2", [id, req.agencyId]);
  res.json({ ok: true });
});

// Export one week's check status as CSV.
app.get("/api/export-status", requireAdmin, async (req, res) => {
  const id = (req.query.id || "").toString();
  const batch = (await pool.query("SELECT * FROM batches WHERE id=$1 AND agency_id=$2", [id, req.agencyId])).rows[0];
  if (!batch) return res.status(404).send("No such week.");
  const rows = (await pool.query(
    `SELECT bk.performer_name, a.name AS act_name, a.email AS act_email,
            COALESCE(v.display_name,bk.venue_text) AS venue, br.name AS group_name,
            bk.gig_date, bk.gig_time,
            bk.status, bk.responded_at, bk.message
     FROM bookings bk JOIN acts a ON a.id=bk.act_id
     LEFT JOIN venues v ON v.name=bk.venue_key AND v.agency_id=bk.agency_id
     LEFT JOIN brands br ON br.id=v.brand_id AND br.agency_id=bk.agency_id
     WHERE bk.batch_id=$1 AND bk.agency_id=$2 ORDER BY bk.gig_date, performer_name`, [id, req.agencyId])).rows;
  const esc = (v) => { const s = (v == null ? "" : String(v)); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = "act,recipient_email,venue,group,date,time,status,responded_at,message";
  const body = rows.map((r) => [
    r.performer_name || r.act_name, r.act_email, r.venue, r.group_name, r.gig_date, r.gig_time,
    r.status, r.responded_at ? new Date(r.responded_at).toISOString() : "", r.message,
  ].map(esc).join(",")).join("\n");
  const csv = "\uFEFF" + header + "\n" + body;
  const safe = (batch.label || "week").replace(/[^a-z0-9]+/gi, "_");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="status_${safe}.csv"`);
  res.send(csv);
});

// resend an invite to one act (admin) — counts only this check-off's gigs
app.post("/api/resend-invite", requireAdmin, async (req, res) => {
  const act = (await pool.query("SELECT * FROM acts WHERE id=$1 AND agency_id=$2", [req.body?.actId, req.agencyId])).rows[0];
  if (!act) return res.status(404).json({ error: "No such act." });
  if (!resend) return res.status(500).json({ error: "Email not configured." });
  // count only gigs in the current (non-archived) batch, so the email total matches
  // this check-off and ignores archived weeks
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
     FROM bookings bk
     LEFT JOIN batches ba ON ba.id = bk.batch_id
     WHERE bk.act_id=$1 AND bk.agency_id=$2 AND COALESCE(ba.archived,false)=false`,
    [act.id, req.agencyId]
  );
  const sender = await senderForAgency(req.agencyId, await userEmail(req.userId));
  await sendConfirmEmail(act, rows[0]?.n || 1, sender);
  res.json({ ok: true });
});

// Archive the current week (keeps it in History rather than deleting).
app.post("/api/clear-week", requireAdmin, async (req, res) => {
  await pool.query("UPDATE batches SET archived=true WHERE archived=false AND agency_id=$1", [req.agencyId]);
  res.json({ ok: true });
});

// ---------- static files ----------
app.use("/act", express.static(path.join(__dirname, "..", "public", "act")));
app.get("/dashboard.html", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "dashboard.html")));
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- boot ----------
initDb()
  .then(() => app.listen(PORT, () => console.log(`GigConfirm running on ${PORT}`)))
  .catch((e) => { console.error("DB init failed", e); process.exit(1); });
