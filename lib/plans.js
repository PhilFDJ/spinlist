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
  // 'none' is the default state for a new account: signed in, but no access
  // until they subscribe or redeem a complimentary code. Not shown as a
  // purchasable plan on the pricing page.
  none: {
    id: 'none',
    name: 'No active plan',
    priceLabel: '—',
    blurb: 'Subscribe or redeem a code to start hosting.',
    maxEventsPerMonth: 0,
    maxGuestsPerEvent: 0,
    branding: false,
    features: [],
    stripePriceEnv: null,
    purchasable: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceLabel: '£5 / mo',
    blurb: 'For regular hosts and working DJs.',
    maxEventsPerMonth: 5,
    maxGuestsPerEvent: 300,
    branding: true,
    features: [
      'Up to 5 events per month',
      'Up to 300 guests per event',
      'PDF setlist export',
      'Export to Spotify playlist',
      'Your logo, colour & tagline on share pages + PDF',
      'Custom vote deadlines & quotas',
    ],
    stripePriceEnv: 'STRIPE_PRICE_PRO',
    purchasable: true,
    popular: true,
  },
  studio: {
    id: 'studio',
    name: 'Studio',
    priceLabel: '£15 / mo',
    blurb: 'For agencies running client events at scale.',
    maxEventsPerMonth: null,     // unlimited
    maxGuestsPerEvent: null,     // unlimited
    branding: true,
    features: [
      'Unlimited events',
      'Unlimited guests',
      'Everything in Pro',
      'Client-branded share pages',
      'Priority support',
    ],
    stripePriceEnv: 'STRIPE_PRICE_STUDIO',
    purchasable: true,
  },
};
