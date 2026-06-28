/* ============================================================
   Spinlist — plan definitions (single source of truth)
   ------------------------------------------------------------
   Hosts pay; guests are always free. Limits below are enforced
   server-side in server.js. Pricing numbers are placeholders —
   set your real prices in the Stripe Dashboard and put the
   resulting Price IDs in your .env.

   maxEventsPerMonth / maxGuestsPerEvent of null = unlimited.
   ============================================================ */

module.exports = {
  // 'none' is a fully-expired state: had a trial/plan, now no access.
  none: {
    id: 'none',
    name: 'No active plan',
    priceLabel: '—',
    blurb: 'Subscribe or redeem a code to start hosting.',
    maxEventsPerMonth: 0,
    maxGuestsPerEvent: 0,
    branding: false,
    spotifyExport: false,
    features: [],
    stripePriceEnv: null,
    purchasable: false,
  },
  // 'couple' is a free login type for wedding couples invited by a DJ. They
  // don't host events or pay — they fill in their wedding song plan.
  couple: {
    id: 'couple',
    name: 'Wedding couple',
    priceLabel: 'Free',
    blurb: 'Plan your wedding songs with your DJ.',
    maxEventsPerMonth: 0,
    maxGuestsPerEvent: 0,
    branding: false,
    spotifyExport: false,
    features: [],
    stripePriceEnv: null,
    purchasable: false,
  },
  // 'trial' is the default for brand-new accounts: full features, but a
  // LIFETIME cap of 2 events. After 2 events they must subscribe. No card
  // required to start. Counted by total events ever created (see server.js).
  trial: {
    id: 'trial',
    name: 'Free trial',
    priceLabel: 'Free',
    blurb: 'Try Spinlist free — 2 events, all features.',
    maxEventsPerMonth: null,      // not month-limited; the lifetime cap is what matters
    maxEventsLifetime: 2,         // total events allowed during the trial
    maxGuestsPerEvent: null,      // full features during trial
    branding: true,
    spotifyExport: true,
    features: [
      '2 free events',
      'All features unlocked',
      'No card required',
    ],
    stripePriceEnv: null,
    purchasable: false,
  },
  // NOTE: internal id stays 'pro' (used in DB + STRIPE_PRICE_PRO env). Only the
  // DISPLAY name changed to BASIC. So STRIPE_PRICE_PRO = the £5 "BASIC" plan.
  pro: {
    id: 'pro',
    name: 'BASIC',
    priceLabel: '£5 / mo',
    blurb: 'For regular hosts and working DJs.',
    maxEventsPerMonth: 5,
    maxGuestsPerEvent: 75,
    branding: true,
    spotifyExport: false,
    features: [
      'Up to 5 events per month',
      'Up to 75 guests per event',
      'PDF setlist export',
      'Your logo, colour & tagline on share pages + PDF',
      'Custom vote deadlines & quotas',
    ],
    stripePriceEnv: 'STRIPE_PRICE_PRO',
    purchasable: true,
    popular: true,
  },
  // NOTE: internal id stays 'studio' (used in DB + STRIPE_PRICE_STUDIO env).
  // Only the DISPLAY name changed to PRO. So STRIPE_PRICE_STUDIO = the £15 "PRO" plan.
  studio: {
    id: 'studio',
    name: 'PRO',
    priceLabel: '£15 / mo',
    blurb: 'For agencies running client events at scale.',
    maxEventsPerMonth: null,     // unlimited
    maxGuestsPerEvent: null,     // unlimited
    branding: true,
    spotifyExport: true,
    features: [
      'Unlimited events',
      'Unlimited guests',
      'Everything in BASIC',
      'Export to Spotify playlist',
      'Client-branded share pages',
      'Priority support',
    ],
    stripePriceEnv: 'STRIPE_PRICE_STUDIO',
    purchasable: true,
  },
};
