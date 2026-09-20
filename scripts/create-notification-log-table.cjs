/* Module 12 — the email-notifier's log. Records every notification the worker generated/dispatched.
 * Idempotent. Run: DATABASE_URL=... node scripts/create-notification-log-table.cjs */
const postgres = require('postgres');
(async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  await sql.unsafe(`create table if not exists platform.notification_log (
    notification_log_id uuid primary key, event_id uuid unique, event_type text, channel text,
    recipient text, subject text, body text, status text, error text,
    created_dt timestamptz not null default now())`);
  // Delivery-assurance columns (audit #10): retry count + last-attempt time.
  await sql.unsafe(`alter table platform.notification_log add column if not exists attempts integer not null default 0`);
  await sql.unsafe(`alter table platform.notification_log add column if not exists updated_dt timestamptz not null default now()`);
  console.log('notification_log ready (with attempts/updated_dt)');
  await sql.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
