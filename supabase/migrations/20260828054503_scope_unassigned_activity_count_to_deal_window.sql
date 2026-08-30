-- The old warning counted every unassigned activity for the Contact. Scope it
-- to the selected deal's own date window so earlier/later jobs do not create a
-- false warning in this chat.
create or replace function public.list_dripjobs_deal_journey(
  p_workspace_key text,
  p_deal_id text,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with target_deal as (
    select
      deal.person_id,
      coalesce(deal.estimated_created_at, deal.first_seen_at) as deal_created_at,
      deal.archived_at as deal_ended_at,
      case
        when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at') then 'exact'
        when deal.estimated_created_at is not null then 'inferred'
        else 'observed'
      end as deal_created_evidence_kind,
      case
        when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at') then 'DripJobs created date'
        when deal.created_at_method = 'report_import_created_date' then 'Imported DripJobs lead date'
        when deal.estimated_created_at is not null then 'Estimated from DripJobs deal age'
        else 'First seen by Fluid'
      end as deal_created_label,
      coalesce(deal.created_at_method, 'first_seen_at') as deal_created_method,
      coalesce(deal.created_at_confidence, case when deal.estimated_created_at is null then 1::numeric else 0.6::numeric end) as deal_created_confidence
    from public.dripjobs_sales_deals deal
    join public.people person on person.id = deal.person_id and person.workspace_key = p_workspace_key
    where deal.deal_id = p_deal_id
  ),
  scoped_unassigned as (
    select count(distinct activity.id) as activity_count
    from target_deal deal
    join public.activity_people person_link
      on person_link.person_id = deal.person_id and person_link.relationship = 'counterparty'
    join public.activities activity
      on activity.id = person_link.activity_id and activity.workspace_key = p_workspace_key
    where activity.occurred_at >= deal.deal_created_at
      and activity.occurred_at < coalesce(deal.deal_ended_at, 'infinity'::timestamptz)
      and not exists (
        select 1 from public.deal_activity_links assigned
        where assigned.workspace_key = p_workspace_key
          and assigned.activity_id = activity.id
          and assigned.deal_id = p_deal_id
      )
  ),
  journey as (
    select public.list_dripjobs_pipeline_history(p_workspace_key, p_deal_id, p_limit)
      || coalesce((
        select jsonb_build_object(
          'dealCreatedAt', deal.deal_created_at,
          'dealCreatedEvidenceKind', deal.deal_created_evidence_kind,
          'dealCreatedLabel', deal.deal_created_label,
          'dealCreatedMethod', deal.deal_created_method,
          'dealCreatedConfidence', deal.deal_created_confidence
        ) from target_deal deal
      ), '{}'::jsonb) as value
  )
  select jsonb_set(
    journey.value,
    '{attribution,unassignedActivityCount}',
    to_jsonb(coalesce((select activity_count from scoped_unassigned), 0)),
    true
  ) from journey;
$$;

revoke all on function public.list_dripjobs_deal_journey(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_dripjobs_deal_journey(text, text, integer)
  to service_role;
