-- Migration: 2026-11-16-prom-2-rest-rule (PROM-2, LD-85). The storefront prints "Every batch rests 45
-- days between QC 1 and QC 2"; the owner: "it has to be true". Before this, the rest applied only to a
-- formula someone had switched on, a batch could skip it through HOLD or REWORK, and one admin could
-- release early. Now:
--
--   platform.policy maceration.rest   the branch rule, as data on the Rules screen. v1 is the owner's
--                                     default (45 days, every batch, no maximum, early release by a
--                                     second person). The kernel's registry default supplies the same
--                                     value where no version is in force, so a branch is never without it.
--   production.maceration_run         the rule each run was opened under (days, version, source), the
--                                     early-release request and its approver (never the same person:
--                                     the constraint below, not only the service), and on close the
--                                     days actually rested. max_days becomes nullable: "No maximum set"
--                                     is null, never an invented number.
--
-- ADDITIVE + IDEMPOTENT. Existing runs keep every value they had; their rule columns stay null and the
-- record they send on close says rule_version 0 with their own minimum.
-- Rollback: scripts/migrations/rollback/2026-11-16-prom-2-rest-rule.down.sql

-- @target: main

alter table production.maceration_run alter column max_days drop not null;
alter table production.maceration_run add column if not exists rule_days integer check (rule_days between 1 and 365);
alter table production.maceration_run add column if not exists rule_version integer check (rule_version >= 0);
alter table production.maceration_run add column if not exists rule_source varchar(20) check (rule_source in ('policy', 'registry_default'));
alter table production.maceration_run add column if not exists early_release_requested_at timestamptz;
alter table production.maceration_run add column if not exists early_release_reason_code varchar(40);
alter table production.maceration_run add column if not exists early_release_approved_by uuid;
alter table production.maceration_run add column if not exists days_rested integer check (days_rested >= 0);
alter table production.maceration_run add column if not exists rest_short boolean;

-- Stop, second person, held by the database too: the approver is never the person who asked.
alter table production.maceration_run drop constraint if exists maceration_run_two_people_chk;
alter table production.maceration_run add constraint maceration_run_two_people_chk
  check (early_release_approved_by is null or early_release_by is null or early_release_approved_by <> early_release_by);

insert into platform.policy (policy_key, title, description) values
  ('maceration.rest', 'Rest between QC 1 and QC 2', 'Every batch rests this many days after QC 1 before QC 2 may release it. A formula may rest longer; a shorter rest for one batch is an early release, approved by a second person.')
on conflict (policy_key) do nothing;

insert into platform.policy_version (policy_key, version, body, reason, created_by) values
  ('maceration.rest', 1, '{"rules":[],"hasDefault":true,"defaultValue":{"minDays":45,"maxDays":null,"appliesTo":"every_batch","earlyRelease":"second_person"}}',
   'Owner LD-85, 13 Nov 2026: every batch rests 45 days between QC 1 and QC 2; no maximum set', 'system')
on conflict (policy_key, version) do nothing;
