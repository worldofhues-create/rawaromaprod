-- HAND-WRITTEN from scripts/create-notification-log-table.cjs (schema portion; that script has
-- no data-seed step).
-- @target: main

create table if not exists platform.notification_log (
  notification_log_id uuid primary key, event_id uuid unique, event_type text, channel text,
  recipient text, subject text, body text, status text, error text,
  created_dt timestamptz not null default now()
);
-- Delivery-assurance columns (audit #10): retry count + last-attempt time.
alter table platform.notification_log add column if not exists attempts integer not null default 0;
alter table platform.notification_log add column if not exists updated_dt timestamptz not null default now();
