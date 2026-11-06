-- Rollback for 2026-11-07-pfd-intelligence (lane pf-d). DESTRUCTIVE for rows written since: approved
-- and dismissed cover suggestions (their reasoning and rule version), recurring-order flags, the
-- downgrade targets and reblend rules, and every QC review decision (the genealogy rows those
-- decisions wrote stay in inventory.batch_genealogy_history). Export them first. floor_job.source
-- is dropped, so a suggested job then ranks like a customer order.

-- @target: main

drop table if exists quality.batch_review_decision;
drop table if exists production.formula_reblend_rule;
drop table if exists production.product_downgrade_target;
drop table if exists production.cover_order_flag;
drop table if exists production.cover_suggestion;
alter table production.floor_job drop constraint if exists floor_job_source_chk;
alter table production.floor_job drop column if exists cover_suggestion_id;
alter table production.floor_job drop column if exists source;
delete from public.schema_migrations where id like '2026-11-07-pfd-intelligence%';
