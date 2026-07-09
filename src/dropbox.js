// Per-agency Dropbox integration via OAuth 2 (with refresh tokens).
//
// Each agency's OWNER connects their own Dropbox once; we store a refresh token and use
// it to upload their acts' media into their Dropbox.
//
// One app is registered (by the platform owner) in the Dropbox App Console; details go in env:
//   DROPBOX_CLIENT_ID       - the app key
//   DROPBOX_CLIENT_SECRET   - the app secret
//   DROPBOX_REDIRECT_URI    - OAuth callback, e.g. https://your-app-url/api/storage/dropbox/callback
//   DROPBOX_UPLOAD_ROOT     - (optional) top folder, default "GigConfirm Uploads"
//
// token_access_type=offline yields a refresh token so we can upload later without the
// owner being present.

const {
  DROPBOX_CLIENT_ID,
  DROPBOX_CLIENT_SECRET,
  DROPBOX_REDIRECT_URI,
  DROPBOX_UPLOAD_ROOT = "GigConfirm Uploads",
} = process.env;

const CONFIGURED = !!(DROPBOX_CLIENT_ID && DROPBOX_CLIENT_SECRET && DROPBOX_REDIRECT_URI);

function isConfigured() {
  return CONFIGURED;
}

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: DROPBOX_CLIENT_ID,
    response_type: "code",
    redirect_uri: DROPBOX_REDIRECT_URI,
    token_access_type: "offline",   // gives us a refresh token
    state,
  });
  return `https://www.dropbox.com/oauth2/authorize?${p}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: DROPBOX_CLIENT_ID,
    client_secret: DROPBOX_CLIENT_SECRET,
    redirect_uri: DROPBOX_REDIRECT_URI,
  });
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Dropbox token exchange failed (${r.status}): ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, account_id, ... }
}

// Dropbox refresh tokens don't rotate, so we return the same one back for storage.
async function refresh(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: DROPBOX_CLIENT_ID,
    client_secret: DROPBOX_CLIENT_SECRET,
  });
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Dropbox token refresh failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return { accessToken: j.access_token, refreshToken };
}

async function getAccountInfo(accessToken) {
  const r = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Couldn't read Dropbox account (${r.status})`);
  const j = await r.json();
  return {
    accountName: (j.email || (j.name && j.name.display_name) || "Dropbox account"),
    driveId: null,   // Dropbox has no separate drive id; paths are account-relative
  };
}

// Dropbox path segment safety: forbid the reserved characters and control chars.
function safeName(name, fallback) {
  return (name || fallback)
    .replace(/[\\/:?*<>"|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

const SMALL_MAX = 140 * 1024 * 1024; // Dropbox simple upload allows up to 150MB; keep margin

// Upload one file into /<root>/<act>/<file>. Dropbox auto-creates parent folders.
async function uploadFile({ accessToken }, actName, fileName, buffer /*, contentType */) {
  const root = safeName(DROPBOX_UPLOAD_ROOT, "GigConfirm Uploads");
  const act = safeName(actName, "Unknown act");
  const name = safeName(fileName, "upload").slice(0, 200);
  const dropboxPath = `/${root}/${act}/${name}`;

  if (buffer.length <= SMALL_MAX) {
    const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath, mode: "add", autorename: true, mute: true }),
      },
      body: buffer,
    });
    if (!r.ok) throw new Error(`Dropbox upload failed (${r.status}): ${await r.text()}`);
    return { name, folder: `${root}/${act}` };
  }

  // large file: upload session in chunks
  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  // start
  const startRes = await fetch("https://content.dropboxapi.com/2/files/upload_session/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ close: false }),
    },
    body: buffer.subarray(0, Math.min(CHUNK, buffer.length)),
  });
  if (!startRes.ok) throw new Error(`Dropbox session start failed (${startRes.status})`);
  const { session_id } = await startRes.json();
  offset = Math.min(CHUNK, buffer.length);

  while (offset < buffer.length) {
    const end = Math.min(offset + CHUNK, buffer.length);
    const isLast = end >= buffer.length;
    if (!isLast) {
      const r = await fetch("https://content.dropboxapi.com/2/files/upload_session/append_v2", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({ cursor: { session_id, offset }, close: false }),
        },
        body: buffer.subarray(offset, end),
      });
      if (!r.ok) throw new Error(`Dropbox append failed (${r.status})`);
      offset = end;
    } else {
      const r = await fetch("https://content.dropboxapi.com/2/files/upload_session/finish", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            cursor: { session_id, offset },
            commit: { path: dropboxPath, mode: "add", autorename: true, mute: true },
          }),
        },
        body: buffer.subarray(offset, end),
      });
      if (!r.ok) throw new Error(`Dropbox finish failed (${r.status})`);
      offset = end;
    }
  }
  return { name, folder: `${root}/${act}` };
}

export default { isConfigured, authUrl, exchangeCode, refresh, getAccountInfo, uploadFile, safeName };
