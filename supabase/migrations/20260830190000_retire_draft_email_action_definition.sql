-- Remove the last built-in action definition and everything that depends on it.
-- Both foreign keys into action_definitions are RESTRICT, so instances and
-- recommendations must go first; action_events and action_execution_jobs
-- cascade from action_instances.
with doomed as (
  select id from public.action_definitions
  where workspace_key = 'ottawa-painters' and key = 'draft-email-to-customer'
)
delete from public.action_instances
where action_definition_id in (select id from doomed);

with doomed as (
  select id from public.action_definitions
  where workspace_key = 'ottawa-painters' and key = 'draft-email-to-customer'
)
delete from public.signal_recommendations
where action_definition_id in (select id from doomed);

delete from public.action_definitions
where workspace_key = 'ottawa-painters' and key = 'draft-email-to-customer';
