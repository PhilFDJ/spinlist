// Postgres access + schema bootstrap.
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL.
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    -- Each subscribing agency. The email prefix + shared domain forms their sender,
    -- e.g. prefix "ldagency" -> ldagency@gigconfirm.co.uk.
    CREATE TABLE IF NOT EXISTS agencies (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,          -- display name, e.g. "LD Agency"
      email_prefix TEXT UNIQUE NOT NULL,   -- mailbox prefix, e.g. "ldagency"
      active       BOOLEAN DEFAULT true,   -- false = suspended / unpaid
      website      TEXT,
      phone        TEXT,
      logo_data    TEXT,                   -- base64 data URI of the uploaded logo
      created_at   TIMESTAMPTZ DEFAULT now()
    );

    -- Users belong to an agency; each has their own login.
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      agency_id    TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      email        TEXT UNIQUE NOT NULL,
      name         TEXT,
      pass_hash    TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS acts (
      id          TEXT PRIMARY KEY,
      agency_id   TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      email       TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS venues (
      agency_id    TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,          -- normalized lower-case key (unique per agency)
      display_name TEXT NOT NULL,
      contact_name TEXT,
      phone        TEXT,
      email        TEXT,
      address      TEXT,
      share_contact BOOLEAN DEFAULT true,  -- whether acts at this venue see its contact
      PRIMARY KEY (agency_id, name)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id          TEXT PRIMARY KEY,
      agency_id   TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      act_id      TEXT REFERENCES acts(id) ON DELETE CASCADE,
      performer_name TEXT,
      venue_key   TEXT,
      venue_text  TEXT,
      gig_date    TEXT,
      gig_time    TEXT,
      fee         TEXT,
      notes       TEXT,
      status      TEXT DEFAULT 'pending',
      responded_at TIMESTAMPTZ,
      message     TEXT,
      week_tag    TEXT,
      batch_id    TEXT,
      reminders_sent INT DEFAULT 0,
      last_reminded DATE,
      share_venue BOOLEAN DEFAULT true,     -- whether the act sees venue contact
      invited_at  TIMESTAMPTZ,              -- when the confirmation email was sent
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS batches (
      id          TEXT PRIMARY KEY,
      agency_id   TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      archived    BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    -- Per-agency cloud storage connection (OneDrive/Dropbox/Google Drive) for act uploads.
    CREATE TABLE IF NOT EXISTS storage_connections (
      agency_id     TEXT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
      provider      TEXT NOT NULL,            -- 'onedrive' (more later)
      account_name  TEXT,                     -- display name / email of the connected account
      drive_id      TEXT,                     -- resolved drive id (cached)
      refresh_token TEXT,                     -- encrypted; used to get fresh access tokens
      connected_at  TIMESTAMPTZ DEFAULT now(),
      connected_by  TEXT                      -- user id who connected it
    );

    -- Per-agency calendar connection (Google Calendar) for importing gigs.
    CREATE TABLE IF NOT EXISTS calendar_connections (
      agency_id     TEXT PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
      provider      TEXT NOT NULL DEFAULT 'google',
      account_name  TEXT,
      refresh_token TEXT,
      connected_at  TIMESTAMPTZ DEFAULT now()
    );

    -- Per-agency key/value settings.
    CREATE TABLE IF NOT EXISTS settings (
      agency_id TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      key   TEXT,
      value TEXT,
      PRIMARY KEY (agency_id, key)
    );
  `);

  // ---- migrations for existing single-tenant databases ----
  // Add agency_id columns if upgrading from the pre-multi-agency schema.
  await pool.query(`ALTER TABLE acts     ADD COLUMN IF NOT EXISTS agency_id TEXT;`);
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS website TEXT;`);
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS logo_data TEXT;`);
  // subscription + platform-admin + discount codes
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS sub_status TEXT DEFAULT 'none';`);
  await pool.query(`ALTER TABLE agencies ADD COLUMN IF NOT EXISTS trial_ends TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notifs_seen_at TIMESTAMPTZ;`);
  // "head of agency" = the person who created the agency. Backfill existing agencies by
  // marking their earliest-created user as owner (only where none is set yet).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT false;`);
  await pool.query(`
    UPDATE users u SET is_owner=true
    WHERE u.id = (
      SELECT id FROM users u2 WHERE u2.agency_id=u.agency_id ORDER BY created_at ASC, id ASC LIMIT 1
    )
    AND NOT EXISTS (SELECT 1 FROM users u3 WHERE u3.agency_id=u.agency_id AND u3.is_owner=true)
  `);
  // email delivery feedback from Resend (bounces, complaints, etc.)
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS email_status TEXT;`);
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS email_status_at TIMESTAMPTZ;`);
  // Car registration plate for an act, shown to venues in lineup emails (parking/security).
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS car_reg TEXT;`);
  // Act contact details + agent info (persistent per act, shown in the Acts contacts panel).
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS contact_name TEXT;`);
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS via_agent BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS agent_name TEXT;`);
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS agent_email TEXT;`);
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS agent_contact_name TEXT;`);
  // Stored list of stage names the act performs under (comma-separated), for import/export.
  await pool.query(`ALTER TABLE acts ADD COLUMN IF NOT EXISTS stage_names TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_events (
      id          SERIAL PRIMARY KEY,
      agency_id   TEXT,
      email       TEXT,
      type        TEXT,          -- delivered | bounced | complained | delivery_delayed
      detail      TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_codes (
      code         TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      value        INT NOT NULL,
      duration     TEXT NOT NULL,
      active       BOOLEAN DEFAULT true,
      stripe_coupon_id TEXT,
      times_used   INT DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);
  // The old single-tenant schema had a global UNIQUE on acts.email. In multi-agency,
  // the same act email can exist for different agencies, so drop that stale constraint.
  await pool.query(`ALTER TABLE acts DROP CONSTRAINT IF EXISTS acts_email_key;`);
  // Agent-booked acts may have no direct email of their own (they're reached via the agent),
  // so email must be allowed to be null.
  await pool.query(`ALTER TABLE acts ALTER COLUMN email DROP NOT NULL;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agency_id TEXT;`);
  await pool.query(`ALTER TABLE batches  ADD COLUMN IF NOT EXISTS agency_id TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS performer_name TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS batch_id TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminders_sent INT DEFAULT 0;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_reminded DATE;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS share_venue BOOLEAN DEFAULT true;`);
  // resolution of flagged gigs: note (what we did), who, and when
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolution_note TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolved_by TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adhoc_note TEXT;`);
  // When a gig is booked via an agent, the agent's contact name — used to greet them
  // in the email instead of the act's stage name.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agent_contact_name TEXT;`);
  // The act's real contact name (the person behind the stage name) — greeted in emails
  // ahead of the agent name and stage name.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS act_contact_name TEXT;`);
  // guard so the "all checks complete" summary email is sent only once per batch
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS completion_emailed BOOLEAN DEFAULT false;`);
  // Per-week news bulletin shown at the top of every act's page (on/off toggle).
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS bulletin TEXT;`);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS bulletin_on BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;`);
  // venues may still have the old single-column PK; add agency_id, backfill, then
  // fix the primary key below.
  await pool.query(`ALTER TABLE venues   ADD COLUMN IF NOT EXISTS agency_id TEXT;`);
  await pool.query(`ALTER TABLE venues   ADD COLUMN IF NOT EXISTS share_contact BOOLEAN DEFAULT true;`);
  // Parent brands (e.g. Away Resorts, Park Dean) with head-office email(s). Venues can
  // belong to a brand so their lineups can be sent to the brand's head office.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brands (
      id           TEXT PRIMARY KEY,
      agency_id    TEXT REFERENCES agencies(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      office_email TEXT,                    -- comma-separated head-office addresses
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS brand_id TEXT;`);
  // Up to 3 contacts per venue (name/role/phone). Contact #1 reuses the existing
  // contact_name/phone fields; we add a role for #1 and full sets for #2 and #3.
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_role  TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact2_name TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact2_role TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact2_phone TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact3_name TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact3_role TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact3_phone TEXT;`);
  // email per additional contact (contact #1's email reuses the existing v.email column)
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact2_email TEXT;`);
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact3_email TEXT;`);
  // Free-text notes for a venue (parking, load-in, access etc.), shown to acts.
  await pool.query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS notes TEXT;`);

  // Ensure the founding agency exists and owns all pre-existing data.
  const DEFAULT_AGENCY_ID = "ld-agency";
  await pool.query(
    `INSERT INTO agencies (id, name, email_prefix, active)
     VALUES ($1, 'LD Agency', 'ldagency', true)
     ON CONFLICT (id) DO NOTHING`, [DEFAULT_AGENCY_ID]
  );

  // Stamp any rows that predate multi-tenancy onto the founding agency.
  for (const t of ["acts", "bookings", "batches", "venues"]) {
    await pool.query(`UPDATE ${t} SET agency_id=$1 WHERE agency_id IS NULL`, [DEFAULT_AGENCY_ID]);
  }
  // Move legacy global settings (single-tenant) under the founding agency.
  await pool.query(
    `UPDATE settings SET agency_id=$1 WHERE agency_id IS NULL`, [DEFAULT_AGENCY_ID]
  ).catch(() => { /* settings may already be composite */ });

  // Repair the venues primary key: move from single-column (name) to composite
  // (agency_id, name). Guarded so it only runs when safe and never half-applies.
  //  - backfill above guarantees every row has agency_id before we touch the PK
  //  - if anything is off, we skip rather than leave the table without a usable key
  await pool.query(`
    DO $$
    DECLARE
      null_agency_count int;
      has_composite bool;
      pk_cols int;
    BEGIN
      SELECT count(*) INTO null_agency_count FROM venues WHERE agency_id IS NULL;
      SELECT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='venues' AND constraint_name='venues_pkey_composite'
      ) INTO has_composite;
      -- how many columns the current PK spans (2 = already composite on fresh install)
      SELECT count(*) INTO pk_cols
        FROM information_schema.key_column_usage k
        JOIN information_schema.table_constraints t ON t.constraint_name=k.constraint_name
        WHERE t.table_name='venues' AND t.constraint_type='PRIMARY KEY';

      IF null_agency_count = 0 AND NOT has_composite AND pk_cols < 2 THEN
        ALTER TABLE venues ALTER COLUMN agency_id SET NOT NULL;
        ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_pkey;
        ALTER TABLE venues ADD CONSTRAINT venues_pkey_composite PRIMARY KEY (agency_id, name);
      END IF;
    END $$;
  `);

  // Handle bookings created before the batch feature (unchanged behaviour).
  const orphan = (await pool.query("SELECT count(*)::int AS n FROM bookings WHERE batch_id IS NULL")).rows[0];
  if (orphan && orphan.n > 0) {
    const existing = (await pool.query("SELECT id FROM batches WHERE archived=false LIMIT 1")).rows[0];
    let id = existing?.id;
    if (!id) {
      id = "migrated_" + Date.now().toString(36);
      await pool.query(
        "INSERT INTO batches (id,agency_id,label,archived) VALUES ($1,$2,$3,false)",
        [id, DEFAULT_AGENCY_ID, "Current week"]
      );
    }
    await pool.query("UPDATE bookings SET batch_id=$1 WHERE batch_id IS NULL", [id]);
  }

  // Seed the founding platform-admin user (you). Reads a one-time email/password
  // from the environment; the password is hashed, never stored in plain text.
  const seedEmail = (process.env.SEED_USER_EMAIL || "").trim().toLowerCase();
  const seedPass = process.env.SEED_USER_PASSWORD || "";
  if (seedEmail && seedPass) {
    const exists = (await pool.query("SELECT 1 FROM users WHERE email=$1", [seedEmail])).rows[0];
    if (!exists) {
      const crypto = await import("crypto");
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(seedPass, salt, 64).toString("hex");
      await pool.query(
        "INSERT INTO users (id, agency_id, email, name, pass_hash, is_admin) VALUES ($1,$2,$3,$4,$5,true)",
        [Date.now().toString(36), DEFAULT_AGENCY_ID, seedEmail, "Phil", `${salt}:${hash}`]
      );
      console.log("Seeded platform-admin user:", seedEmail);
    } else {
      // ensure the seed account is flagged as platform admin
      await pool.query("UPDATE users SET is_admin=true WHERE email=$1", [seedEmail]);
    }
  }
  // The founding agency never needs to pay.
  await pool.query("UPDATE agencies SET sub_status='active', active=true WHERE id=$1", [DEFAULT_AGENCY_ID]);
}

