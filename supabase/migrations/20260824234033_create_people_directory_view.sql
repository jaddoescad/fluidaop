create view public.people_directory
with (security_invoker = true)
as
with active_roles as (
  select
    role.person_id,
    array_agg(distinct role.role_key order by role.role_key) as roles
  from public.person_roles role
  where role.active
  group by role.person_id
),
source_summary as (
  select
    source.person_id,
    min(source.source_system) as source_system,
    min(source.source_record_id) as source_record_id,
    max(source.last_synced_at) as last_synced_at
  from public.person_sources source
  group by source.person_id
),
activity_summary as (
  select
    link.person_id,
    count(distinct link.activity_id)::integer as linked_signal_count,
    max(activity.occurred_at) as last_signal_at
  from public.activity_people link
  join public.activities activity on activity.id = link.activity_id
  group by link.person_id
)
select
  person.id,
  person.display_name,
  person.primary_email,
  person.primary_phone,
  person.status,
  coalesce(active_roles.roles, array[]::text[]) as roles,
  source_summary.source_system,
  source_summary.source_record_id,
  source_summary.last_synced_at,
  coalesce(activity_summary.linked_signal_count, 0) as linked_signal_count,
  activity_summary.last_signal_at,
  person.created_at,
  person.updated_at
from public.people person
left join active_roles on active_roles.person_id = person.id
left join source_summary on source_summary.person_id = person.id
left join activity_summary on activity_summary.person_id = person.id;

revoke all on table public.people_directory from public, anon, authenticated;
grant select on table public.people_directory to service_role;

comment on view public.people_directory is
  'Server-only paginated directory projection for Fluid People. It exposes only canonical fields, roles, source provenance, and aggregate signal linkage.';
