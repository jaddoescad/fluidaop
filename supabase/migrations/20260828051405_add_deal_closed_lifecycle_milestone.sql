-- Closed-deal report rows are lifecycle milestones, separate from DripJobs'
-- operational sales-board stages.
alter table public.deal_milestone_events
  drop constraint deal_milestone_events_milestone_type_check;

alter table public.deal_milestone_events
  add constraint deal_milestone_events_milestone_type_check
  check (milestone_type in (
    'appointment_scheduled',
    'appointment_completed',
    'appointment_cancelled',
    'proposal_sent',
    'proposal_viewed',
    'proposal_accepted',
    'proposal_rejected',
    'deal_closed'
  ));

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
      coalesce(deal.estimated_created_at, deal.first_seen_at) as deal_created_at,
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
  )
  select public.list_dripjobs_pipeline_history(p_workspace_key, p_deal_id, p_limit)
    || coalesce((
      select jsonb_build_object(
        'dealCreatedAt', deal.deal_created_at,
        'dealCreatedEvidenceKind', deal.deal_created_evidence_kind,
        'dealCreatedLabel', deal.deal_created_label,
        'dealCreatedMethod', deal.deal_created_method,
        'dealCreatedConfidence', deal.deal_created_confidence
      ) from target_deal deal
    ), '{}'::jsonb);
$$;

revoke all on function public.list_dripjobs_deal_journey(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_dripjobs_deal_journey(text, text, integer)
  to service_role;
