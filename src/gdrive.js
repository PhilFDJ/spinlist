// Per-agency Google Drive integration via OAuth 2 (with refresh tokens).
//
// Each agency's OWNER connects their own Google account once; we store a refresh token and
// use it to upload their acts' media into their Google Drive, in a "GigConfirm Uploads"
// folder with a subfolder per act.
//
// One app is registered (by the platform owner) in Google Cloud Console; details go in env:
//   GOOGLE_CLIENT_ID       - OAuth client ID
//   GOOGLE_CLIENT_SECRET   - OAuth client secret
//   GOOGLE_REDIRECT_URI    - OAuth callback, e.g. https://your-app-url/api/storage/gdrive/callback
//   GOOGLE_UPLOAD_ROOT     - (optional) top folder, default "GigConfirm Uploads"
//
// Uses the narrow `drive.file` scope: the app can only see/manage files it creates, which
// is all we need (upload-only) and is much easier to get verified by Google.

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_UPLOAD_ROOT = "GigConfirm Uploads",
} = process.env;

const CONFIGURED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
const SCOPE = "https://www.googleapis.com/auth/drive.file";

function isConfigured() {
  return CONFIGURED;
}

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",       // yields a refresh token
    prompt: "consent",            // ensure a refresh token is returned each time
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Google token exchange failed (${r.status}): ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, expires_in, ... }
}

// Google refresh tokens don't rotate, so we return the same one back for storage.
async function refresh(refreshToken) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Google token refresh failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return { accessToken: j.access_token, refreshToken };
}

async function getAccountInfo(accessToken) {
  // drive.file scope doesn't grant profile; read the Drive "about" for the user's email.
  const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Couldn't read Google account (${r.status})`);
  const j = await r.json();
  const u = j.user || {};
  return { accountName: u.emailAddress || u.displayName || "Google account", driveId: null };
}

function safeName(name, fallback) {
  return (name || fallback).replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

// Find a folder by name under a parent (or root); returns its id or null.
async function findFolder(accessToken, name, parentId) {
  const safe = name.replace(/'/g, "\\'");
  const parent = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safe}' and ${parent} and trashed=false`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Drive folder lookup failed (${r.status})`);
  const j = await r.json();
  return (j.files && j.files[0] && j.files[0].id) || null;
}

async function createFolder(accessToken, name, parentId) {
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!r.ok) throw new Error(`Create Drive folder "${name}" failed (${r.status})`);
  return (await r.json()).id;
}

async function ensureFolder(accessToken, name, parentId) {
  return (await findFolder(accessToken, name, parentId)) || (await createFolder(accessToken, name, parentId));
}

// Upload one file into <root>/<act>/ using a multipart upload.
async function uploadFile({ accessToken }, actName, fileName, buffer, contentType) {
  const rootId = await ensureFolder(accessToken, safeName(GOOGLE_UPLOAD_ROOT, "GigConfirm Uploads"), null);
  const actId = await ensureFolder(accessToken, safeName(actName, "Unknown act"), rootId);
  const name = safeName(fileName, "upload").slice(0, 200);

  const boundary = "gigconfirm" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: [actId] });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType || "application/octet-stream"}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, buffer, tail]);

  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!r.ok) throw new Error(`Google Drive upload failed (${r.status}): ${await r.text()}`);
  return { name, folder: `${safeName(GOOGLE_UPLOAD_ROOT, "GigConfirm Uploads")}/${safeName(actName, "Unknown act")}` };
}

export default { isConfigured, authUrl, exchangeCode, refresh, getAccountInfo, uploadFile, safeName };
