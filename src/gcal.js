// Google Calendar import (read-only) via OAuth 2. Lets an agency pull gigs straight from
// their Google Calendars instead of uploading a CSV.
//
// Reuses a Google OAuth app. If you already set up Google Drive, you can reuse the same
// client id/secret; this just adds the calendar.readonly scope and its own redirect.
//
// Env:
//   GCAL_CLIENT_ID       - OAuth client ID (may be the same as GOOGLE_CLIENT_ID)
//   GCAL_CLIENT_SECRET   - OAuth client secret
//   GCAL_REDIRECT_URI    - callback, e.g. https://your-app-url/api/calendar/google/callback
// Falls back to GOOGLE_* if the GCAL_* ones aren't set, so one Google app can do both.

const {
  GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REDIRECT_URI,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
} = process.env;

const CLIENT_ID = GCAL_CLIENT_ID || GOOGLE_CLIENT_ID;
const CLIENT_SECRET = GCAL_CLIENT_SECRET || GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = GCAL_REDIRECT_URI;
const CONFIGURED = !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

function isConfigured() { return CONFIGURED; }

function authUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) throw new Error(`Google token exchange failed (${r.status}): ${await r.text()}`);
  return r.json();
}

async function refresh(refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: refreshToken, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) throw new Error(`Google token refresh failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return { accessToken: j.access_token, refreshToken };
}

async function getAccountInfo(accessToken) {
  // read the primary calendar's id (the user's email) for display
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Couldn't read Google Calendar (${r.status})`);
  const j = await r.json();
  return { accountName: j.id || j.summary || "Google Calendar", driveId: null };
}

// List the user's calendars (id + name).
async function listCalendars(accessToken) {
  const out = [];
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250${pageToken ? "&pageToken=" + pageToken : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`List calendars failed (${r.status})`);
    const j = await r.json();
    for (const c of j.items || []) out.push({ id: c.id, name: c.summary, primary: !!c.primary });
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Fetch events from one calendar within [timeMin, timeMax] (ISO strings).
async function listEvents(accessToken, calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken = "";
  do {
    const p = new URLSearchParams({
      timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "2500",
    });
    if (pageToken) p.set("pageToken", pageToken);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${p}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`List events failed (${r.status})`);
    const j = await r.json();
    for (const e of j.items || []) {
      if (e.status === "cancelled") continue;
      out.push({
        title: e.summary || "",
        location: e.location || "",
        start: e.start?.dateTime || e.start?.date || null,   // dateTime for timed, date for all-day
        allDay: !e.start?.dateTime,
      });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

export default { isConfigured, authUrl, exchangeCode, refresh, getAccountInfo, listCalendars, listEvents };
