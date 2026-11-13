-- Rollback for 2026-11-16-prom-2-rest-rule (PROM-2). Drops the rule each run was opened under, the
-- early-release request and approver, and the days rested: export maceration_run first if wanted (the
-- maceration_event log keeps the request, approval and close lines). A run with no maximum gets its
-- own required days as the maximum, which the old code needs. The maceration.rest policy, its versions,
-- decisions and overrides are removed; the code that reads it must be rolled back with this.

-- @target: main

alter table production.maceration_run drop constraint if exists maceration_run_two_people_chk;
update production.maceration_run set max_days = min_days + extend_days where max_days is null;
alter table production.maceration_run alter column max_days set not null;
alter table production.maceration_run drop column if exists rule_days;
alter table production.maceration_run drop column if exists rule_version;
alter table production.maceration_run drop column if exists rule_source;
alter table production.maceration_run drop column if exists early_release_requested_at;
alter table production.maceration_run drop column if exists early_release_reason_code;
alter table production.maceration_run drop column if exists early_release_approved_by;
alter table production.maceration_run drop column if exists days_rested;
alter table production.maceration_run drop column if exists rest_short;
delete from platform.policy_decision where policy_key = 'maceration.rest';
delete from platform.policy_override where policy_key = 'maceration.rest';
delete from platform.policy_version where policy_key = 'maceration.rest';
delete from platform.policy where policy_key = 'maceration.rest';
delete from public.schema_migrations where id like '2026-11-16-prom-2-rest-rule%';
