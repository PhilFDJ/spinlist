# Deploying Spinlist on cPanel shared hosting

Spinlist is a Node.js app, so it needs your host's **Setup Node.js App** tool
(CloudLinux Node.js Selector + Phusion Passenger). This guide assumes that tool
exists in your cPanel. If it doesn't, see "If there's no Node.js option" at the end.

This project has already been adapted for cPanel:
- It does **not** force a port (`app.listen` is skipped under Passenger; the app
  is exported instead, which is what Passenger requires).
- An `app.js` entry point is included (Passenger's default startup file).
- The database is a plain JSON file — **no native modules to compile**, which is
  the #1 cause of failed installs on shared hosting.

## Step 1 — Check you have Node support
In cPanel, look under **Software** for **Setup Node.js App**. If it's there, continue.

## Step 2 — Upload the files
Use cPanel **File Manager** (or FTP). Create a folder *outside* `public_html`,
e.g. `spinlist`, and upload everything from this project into it **except**:
`node_modules/`, `.env`, and any `spinlist-data.json`.

(If you prefer Git: cPanel → Git Version Control → clone your repo.)

## Step 3 — Create the Node.js app
In **Setup Node.js App** → **Create Application**:
- **Node.js version:** 20 LTS (recommended).
- **Application mode:** Production.
- **Application root:** the folder you uploaded to, e.g. `spinlist`.
- **Application URL:** the domain or subdomain to serve it on
  (e.g. `app.yourdomain.com`).
- **Application startup file:** `app.js`.

Click **Create**.

## Step 4 — Add environment variables
Still in the Node.js App editor, add each variable from `.env.example` as a
key/value pair (do **not** upload a real `.env` file; cPanel injects these):

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_MARKET`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO`
- `ADMIN_EMAILS`, `CURRENCY`
- `NODE_ENV` = `production`
- `BASE_URL` = your full https URL, e.g. `https://app.yourdomain.com`

Leave `PORT` unset — Passenger handles it.

## Step 5 — Install dependencies
In the Node.js App editor click **Run NPM Install** (it reads `package.json`).
If it errors, open **Terminal** in cPanel, enter the app's virtual environment
(the editor shows the exact `source .../bin/activate` command), then run
`npm install`.

## Step 6 — Start & test
Click **Restart** (or **Start**) in the Node.js App editor, then open the
Application URL. The Spinlist home page should load. Try **Guest view →** search to
confirm the Spotify proxy works, and sign up to confirm accounts work.

## Restarting after changes
Either click **Restart** in the Node.js App editor, or create an empty file at
`<app root>/tmp/restart.txt` — Passenger restarts gracefully on the next request.

## Troubleshooting
- **503 Service Unavailable / "Incomplete response":** almost always the startup
  file or a crash. Check the app's log (set in the Node.js App editor) and make
  sure the startup file is `app.js`. Do not set a `PORT`.
- **"Cannot find module 'express'":** you didn't run NPM Install, or it failed —
  run it again from the virtual environment in Terminal.
- **App stops randomly:** shared hosts recycle idle processes; that's normal.
  Passenger wakes it on the next request (first hit may be a touch slow).
- **Hitting memory limits during install:** shared plans often cap RAM at
  512MB–1GB. Because we removed native compilation, installs are light, but if
  it still fails, contact your host or consider a small VPS.

## Persistence note (important)
Data lives in `spinlist-data.json` in the app root. On shared hosting that file
persists on your account's disk, which is fine for getting started. For anything
serious, move to a hosted **Postgres** database — the data methods in `lib/db.js`
map directly. Also keep a backup of that JSON file.

## HTTPS
Stripe and secure login cookies require HTTPS. cPanel hosts almost always provide
free SSL (AutoSSL / Let's Encrypt) — make sure it's active on your chosen domain.
Set `NODE_ENV=production` so login cookies are sent with the `Secure` flag.

## If there's no Node.js option
Some budget shared plans don't support Node at all. Two options:
1. Ask your host to enable Node.js / CloudLinux Passenger (or upgrade the plan).
2. Run Spinlist on a platform host (Render/Railway — free tiers available) and
   point a subdomain of your existing domain at it via a DNS CNAME. Your main
   website stays where it is; only the app lives elsewhere.
