# GigConfirm

Weekly gig confirmation system. Upload a bookings CSV and a venue-contacts CSV;
registered acts get an instant **web push** to confirm with one tap; unregistered
acts get an **email invite** to set up notifications. You watch confirmations land
live on a password-protected dashboard.

## What you get

- **Admin dashboard** (`/dashboard.html`) — password-gated. Upload both CSVs, see every
  booking's status update in real time, resend invites, clear the week.
- **Act page** (`/act/`) — a PWA acts add to their home screen. Receives pushes,
  shows the gig + venue contact, has Call / Text venue buttons, and Confirm / Flag.
- **Backend** — Node + Express + Postgres, web push via VAPID, email via Resend.

## The act flow

1. You upload bookings. Each booking row has the act's email.
2. If the act has never registered a device → they get an **email invite**.
3. They tap the link, tap "Turn on notifications", add to home screen. Registered.
4. Every future upload pushes them straight to their phone — no more email needed.
5. They tap **Confirm I'm good** (or **Flag a problem**) → you see it on the dashboard.

## Deploy to Render (one-time setup)

### 1. Generate your push keys (locally)
```
npm install
npm run genkeys
```
Copy the two printed values (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`).

### 2. Get a Resend API key
Sign up at resend.com, create an API key. To start, you can send from
`onboarding@resend.dev` (their shared test sender). For real use, verify your own
domain in Resend and set `MAIL_FROM` to something like `GigConfirm <gigs@yourdomain.com>`
so invites don't land in spam.

### 3. Push this repo to GitHub, then on Render
- **New > Blueprint**, point it at your repo. `render.yaml` provisions the web
  service **and** the Postgres database together.
- After it creates, open the **gigconfirm** service > **Environment** and fill in the
  secret values (the ones marked `sync: false`):
  - `ADMIN_PASSWORD` — your dashboard password
  - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — from step 1
  - `RESEND_API_KEY` — from step 2
  - `MAIL_FROM` — your sender
  - `APP_URL` — your live URL, e.g. `https://gigconfirm.onrender.com`
    (set this *after* the first deploy gives you the URL, then redeploy)

### 4. Done
- Admin: `https://YOUR-APP.onrender.com/dashboard.html`
- Acts get their personal link by email automatically.

## Costs (as of mid-2026, verify on render.com)

The blueprint uses Render's **Starter** plans (~$7/mo web + ~$7/mo Postgres ≈ $14/mo).
This is deliberate:
- Free web services sleep after 15 min — a sleeping server can't reliably send pushes.
- Free Postgres is deleted after 30 days — you'd lose all device registrations monthly.

To trial it for free first, change both `plan: starter` lines in `render.yaml` to
`plan: free`. Just know the limits above apply.

Resend's free tier covers a few thousand emails/month, which is plenty here since
email is only used for first-time onboarding.

## CSV formats

**Bookings** (column names matched loosely — "Artist"/"Performer"/"Band" all read as act):
```
act,email,venue,date,time,fee,notes
The Reverbs,band@example.com,The Anchor,Fri 11 Jul,9pm,£250,Bring own PA
```

**Venue contacts** (venue name must match the bookings file):
```
venue,contact,phone,email,address
The Anchor,Jo Davies,07700 900123,jo@anchor.example,12 Quay St
```

## Local development
```
npm install
cp .env.example .env      # fill in values; point DATABASE_URL at a local Postgres
npm run genkeys           # paste keys into .env
npm run dev
```

## Notes & limits

- A registration is tied to the specific phone/browser. New phone → tap the link again.
- iPhone requires the page be **added to the home screen** before web push works (iOS 16.4+).
- Admin sessions are held in memory, so a server restart signs you out — just log back in.
- Pushes here fire on upload. If you'd rather schedule them (e.g. every Monday 9am),
  Render Cron Jobs can hit an endpoint on a schedule — easy to add later.
