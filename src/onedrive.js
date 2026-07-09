// Per-agency OneDrive integration via delegated OAuth (Microsoft Graph).
//
// Each agency's OWNER connects their own Microsoft account once; we store a refresh
// token for that agency and use it to upload their acts' media into their OneDrive.
//
// One multi-tenant app is registered (by the platform owner) and its details go in env:
//   MS_CLIENT_ID       - the registered (multi-tenant) app's Application (client) ID
//   MS_CLIENT_SECRET   - a client secret for that app
//   MS_REDIRECT_URI    - the OAuth callback, e.g. https://app.gigconfirm.co.uk/api/storage/onedrive/callback
//   MS_UPLOAD_ROOT     - (optional) top folder name, default "GigConfirm Uploads"
//
// Delegated scopes requested: Files.ReadWrite offline_access User.Read
// (offline_access is what yields a refresh token; no admin consent needed — each owner
//  approves for their own account.)

const {
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_REDIRECT_URI,
  MS_UPLOAD_ROOT = "GigConfirm Uploads",
} = process.env;

const CONFIGURED = !!(MS_CLIENT_ID && MS_CLIENT_SECRET && MS_REDIRECT_URI);
const SCOPES = "offline_access Files.ReadWrite User.Read";
const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";

function isConfigured() {
  return CONFIGURED;
}

// Build the URL we send the agency owner to, to grant access. `state` carries the
// agency id (signed by the caller) so we know who's connecting on callback.
function authUrl(state) {
  const p = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: MS_REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state,
  });
  return `${AUTH_BASE}/authorize?${p}`;
}

// Exchange an auth code for tokens (used on OAuth callback).
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    redirect_uri: MS_REDIRECT_URI,
    grant_type: "authorization_code",
    code,
  });
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status}): ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, expires_in, ... }
}

// Get a fresh access token from a stored refresh token. Returns { accessToken, refreshToken }
// (Microsoft rotates the refresh token, so callers should persist the new one).
async function refresh(refreshToken) {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    redirect_uri: MS_REDIRECT_URI,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token refresh failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return { accessToken: j.access_token, refreshToken: j.refresh_token || refreshToken };
}

// Look up the signed-in user's display name/email + their drive id (called once at connect).
async function getAccountInfo(accessToken) {
  const me = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${accessToken}` } });
  const meJson = me.ok ? await me.json() : {};
  const dr = await fetch("https://graph.microsoft.com/v1.0/me/drive", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!dr.ok) throw new Error(`Couldn't read the account's OneDrive (${dr.status}). Make sure it's a Microsoft 365 account with OneDrive.`);
  const drive = await dr.json();
  return {
    accountName: meJson.userPrincipalName || meJson.mail || meJson.displayName || "OneDrive account",
    driveId: drive.id,
  };
}

function safeName(name, fallback) {
  return (name || fallback)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

async function createFolder(accessToken, driveId, parentId, name) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  });
  if (r.status === 409) return;
  if (!r.ok) throw new Error(`Create folder "${name}" failed (${r.status})`);
}

async function itemByPath(accessToken, driveId, p) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(p)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Lookup "${p}" failed (${r.status})`);
  return r.json();
}

async function ensureActFolder(accessToken, driveId, actName) {
  const root = safeName(MS_UPLOAD_ROOT, "GigConfirm Uploads");
  const act = safeName(actName, "Unknown act");
  await createFolder(accessToken, driveId, "root", root);
  const rootItem = await itemByPath(accessToken, driveId, root);
  await createFolder(accessToken, driveId, rootItem.id, act);
  return `${root}/${act}`;
}

const SMALL_MAX = 4 * 1024 * 1024;

// Upload one file into <root>/<act>/ within the given drive.
async function uploadFile({ accessToken, driveId }, actName, fileName, buffer, contentType) {
  const folderPath = await ensureActFolder(accessToken, driveId, actName);
  const name = safeName(fileName, "upload").slice(0, 200);
  const destPath = `${folderPath}/${name}`;

  if (buffer.length <= SMALL_MAX) {
    const r = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(destPath)}:/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType || "application/octet-stream" },
      body: buffer,
    });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    return { name, folder: folderPath };
  }

  const sess = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(destPath)}:/createUploadSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
  });
  if (!sess.ok) throw new Error(`Upload session failed (${sess.status})`);
  const { uploadUrl } = await sess.json();

  const CHUNK = 5 * 1024 * 1024;
  const total = buffer.length;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    const chunk = buffer.subarray(start, end);
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${start}-${end - 1}/${total}` },
      body: chunk,
    });
    if (![200, 201, 202].includes(r.status)) throw new Error(`Chunk failed (${r.status})`);
  }
  return { name, folder: folderPath };
}

export default { isConfigured, authUrl, exchangeCode, refresh, getAccountInfo, uploadFile, safeName };
