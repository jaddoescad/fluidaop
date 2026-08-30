-- Add truthful deal-origin evidence to the existing stage/touchpoint journey
-- without changing the underlying attribution contract. DripJobs currently
-- exposes relative Deal Age, so most historical creation times are estimates.
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
        when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at')
          then 'exact'
        when deal.estimated_created_at is not null then 'inferred'
        else 'observed'
      end as deal_created_evidence_kind,
      case
        when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at')
          then 'DripJobs created date'
        when deal.estimated_created_at is not null then 'Estimated from DripJobs deal age'
        else 'First seen by Fluid'
      end as deal_created_label,
      coalesce(deal.created_at_method, 'first_seen_at') as deal_created_method,
      coalesce(
        deal.created_at_confidence,
        case when deal.estimated_created_at is null then 1::numeric else 0.6::numeric end
      ) as deal_created_confidence
    from public.dripjobs_sales_deals deal
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
    where deal.deal_id = p_deal_id
  )
  select public.list_dripjobs_pipeline_history(
    p_workspace_key,
    p_deal_id,
    p_limit
  ) || coalesce((
    select jsonb_build_object(
      'dealCreatedAt', deal.deal_created_at,
      'dealCreatedEvidenceKind', deal.deal_created_evidence_kind,
      'dealCreatedLabel', deal.deal_created_label,
      'dealCreatedMethod', deal.deal_created_method,
      'dealCreatedConfidence', deal.deal_created_confidence
    )
    from target_deal deal
  ), '{}'::jsonb);
$$;

revoke all on function public.list_dripjobs_deal_journey(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_dripjobs_deal_journey(text, text, integer)
  to service_role;

comment on function public.list_dripjobs_deal_journey(text, text, integer) is
  'Returns one deal creation marker, stage windows, attributed communications, outcomes, and evidence labels for the Hermes deal chat.';
