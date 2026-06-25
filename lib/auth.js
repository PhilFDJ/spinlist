/* ============================================================
   Spinlist — auth helpers
   ------------------------------------------------------------
   Password hashing uses Node's built-in scrypt (no external
   crypto deps). Sessions are random tokens stored server-side
   and sent to the browser as an httpOnly cookie.
   ============================================================ */

const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, derived] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // constant-time compare
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newId() { return crypto.randomBytes(12).toString('hex'); }

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.createSession({
    token, user_id: userId,
    created_at: now,
    expires_at: now + SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  return token;
}

// Reads the session cookie and attaches req.user (or null).
function attachUser(req, _res, next) {
  const token = parseCookie(req.headers.cookie || '')['sl_session'];
  req.user = null;
  if (token) {
    const session = db.getSession(token);
    if (session) {
      const user = db.getUserById(session.user_id);
      if (user) { req.user = user; req.sessionToken = token; }
    }
  }
  next();
}

// Blocks the request if not logged in.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

function parseCookie(str) {
  return Object.fromEntries(
    str.split(';').map(p => p.trim().split('=').map(decodeURIComponent)).filter(p => p[0])
  );
}

function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  // Secure flag should be on in production (HTTPS).
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `sl_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge};${secure}`;
}
function clearCookie() {
  return 'sl_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0;';
}

module.exports = {
  hashPassword, verifyPassword, newId,
  startSession, attachUser, requireAuth,
  sessionCookie, clearCookie,
};
