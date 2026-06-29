# Spinlist

Event song-voting app. Hosts create an event, share a link or QR code, guests
search **live Spotify** and vote, and at the deadline the DJ gets a ranked **PDF**
plus a **Spotify playlist** export.

**Hosts pay. Guests are always free and never sign in.**
There is no free host tier — new accounts must subscribe (Pro/Studio) or redeem a
complimentary code before they can create events.

## Project layout

```
spinlist-backend/
├─ server.js              Express: auth, billing, codes, branding, gating, Spotify search
├─ lib/
│  ├─ db.js               SQLite store (users, sessions, codes, redemptions, usage)
│  ├─ auth.js             scrypt password hashing + session cookies
│  └─ plans.js            Pro / Studio limits — single source of truth
├─ public/
│  ├─ index.html          The app (create / host / guest), dark-blue theme
│  ├─ pricing.html        Plans + signup/login + Stripe Checkout + redeem box
│  ├─ account.html        Plan, usage, comp status, branding editor, redeem
│  └─ admin.html          Create & manage complimentary / discount codes
├─ .env.example
└─ package.json
```

## Setup

```bash
cd spinlist-backend
cp .env.example .env      # fill in Spotify + Stripe + admin values
npm install
npm start                 # http://localhost:3000
```

### 1. Spotify (song search)
Create an app at https://developer.spotify.com/dashboard (choose **Web API**),
put the Client ID/Secret in `.env`. Since the Feb 2026 API changes, Development
Mode requires the app owner to hold Spotify **Premium**; for a live product apply
for **Extended Quota Mode**.

### 2. Stripe (subscriptions + discount codes)
1. Test keys from https://dashboard.stripe.com/apikeys → `STRIPE_SECRET_KEY`.
2. Create two recurring **Prices** (Pro, Studio); paste IDs into
   `STRIPE_PRICE_PRO` / `STRIPE_PRICE_STUDIO`.
3. Webhook for local dev:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```
   Put the `whsec_...` into `STRIPE_WEBHOOK_SECRET`. In production add an endpoint
   at `https://yourdomain/api/stripe/webhook` subscribed to:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`.

Billing is optional to boot: with no Stripe key the app still runs; comp codes
work, paid checkout and discount codes return a "not configured" notice.

### 3. Admin (codes)
Set `ADMIN_EMAILS` to a comma-separated list of accounts allowed to manage codes.
Those users see **/admin.html**. Everyone else is blocked from the admin API.

## How access works

- **Sign up / log in** (email + password, scrypt-hashed, httpOnly session cookie)
  creates an account with **no plan**.
- **Plans** (`lib/plans.js`): Pro = 20 events/mo, 300 guests; Studio = unlimited.
  Both include custom branding.
- **Gating is server-side.** `POST /api/events` checks the plan/usage before
  issuing an event ID, so limits can't be bypassed in the browser.
- **Stripe webhook** is the source of truth for paid plans: provisions on
  subscription events, drops to `none` on cancellation. Signature-verified
  against the raw body and idempotent (handled event IDs are logged).

## Complimentary & discount codes

Generated and managed by admins at **/admin.html**; redeemed by any signed-in
user on the pricing or account page.

- **Comp codes** grant a free plan (Pro or Studio), per-code, for N months or
  forever. Support max-uses, expiry date, and a private note. One redemption per
  user. Expired comps automatically revert the account to no-access.
- **Discount codes** create a matching Stripe coupon + promotion code, applied
  automatically at checkout (Stripe tracks the redemptions).

## Branding (Pro & Studio)

Hosts upload a logo (PNG/JPG/WebP/SVG, ≤2 MB), pick an accent colour, and set a
tagline. These appear on the guest voting page and the exported PDF. Logos are
validated server-side and stored under `/uploads`.

## Pricing is a placeholder

Numbers in `lib/plans.js` and labels on the pricing page are examples. Set real
prices in Stripe and update the labels. Pricing, refunds, and terms are
business/legal decisions this scaffold doesn't make for you.

## Still to build (next steps)

- **Shared vote storage** so all guests + host see one live tally (votes are
  currently per-browser). The accounts/DB layer here is the foundation.
- **Spotify playlist export** via the DJ Authorization Code login (track URIs are
  already captured on each voted song).
- Email verification + password reset.

## Don't commit secrets

`.gitignore` excludes `.env`, the SQLite files, `node_modules/`, and `uploads/`.
Set environment variables in your host's dashboard for production.
