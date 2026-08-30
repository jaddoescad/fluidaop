-- An exact DripJobs chat-to-deal link can legitimately precede Fluid's
-- coarse, deal-age-derived creation estimate. Preserve that provider evidence
-- when the general date-window reconciler runs for the Contact.
create or replace function private.reconcile_person_deal_activity_links(
  p_workspace_key text,
  p_person_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_provider integer := 0;
  v_date_window integer := 0;
begin
  if p_workspace_key is null or p_person_id is null then
    return jsonb_build_object('personId', p_person_id, 'deleted', 0, 'provider', 0, 'dateWindow', 0);
  end if;

  delete from public.deal_activity_links link
  using public.dripjobs_sales_deals deal
  where link.workspace_key = p_workspace_key
    and link.deal_id = deal.deal_id
    and deal.person_id = p_person_id
    and link.attribution_method <> 'manual'
    and not (
      link.attribution_method = 'provider_deal_id'
      and exists (
        select 1
        from public.activities activity
        where activity.id = link.activity_id
          and activity.workspace_key = p_workspace_key
          and activity.source = 'dripjobs'
          and coalesce(
            nullif(activity.source_metadata ->> 'dripjobsDealId', ''),
            nullif(activity.source_metadata ->> 'dealId', '')
          ) = link.deal_id
      )
    );
  get diagnostics v_deleted = row_count;

  insert into public.deal_activity_links (
    workspace_key, activity_id, deal_id, stage_event_id, stage_name,
    attribution_method, stage_evidence, confidence, reason, metadata
  )
  select
    p_workspace_key, activity.id, deal.deal_id,
    case when latest_event.to_stage is not null then latest_event.id end,
    latest_event.to_stage, 'provider_deal_id',
    case when latest_event.to_stage is null then 'unknown'
      else private.stage_evidence_kind(latest_event.source, latest_event.event_kind) end,
    1,
    'The provider names this deal and the activity falls inside its date boundaries.',
    jsonb_build_object('providerDealId', deal.deal_id)
  from public.activity_people person_link
  join public.activities activity
    on activity.id = person_link.activity_id and activity.workspace_key = p_workspace_key
  join public.dripjobs_sales_deals deal
    on deal.person_id = p_person_id
   and deal.deal_id = coalesce(
     nullif(activity.source_metadata ->> 'dripjobsDealId', ''),
     nullif(activity.source_metadata ->> 'dealId', '')
   )
  left join lateral (
    select event.id, event.event_kind, event.to_stage, event.source
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key and event.deal_id = deal.deal_id
      and (event.effective_at, event.id) <= (activity.occurred_at, 9223372036854775807::bigint)
    order by event.effective_at desc, event.id desc limit 1
  ) latest_event on true
  where person_link.person_id = p_person_id
    and person_link.relationship = 'counterparty'
    and activity.occurred_at >= coalesce(deal.estimated_created_at, deal.first_seen_at)
    and activity.occurred_at < coalesce(deal.archived_at, 'infinity'::timestamptz)
  on conflict (workspace_key, activity_id, deal_id) do nothing;
  get diagnostics v_provider = row_count;

  insert into public.deal_activity_links (
    workspace_key, activity_id, deal_id, stage_event_id, stage_name,
    attribution_method, stage_evidence, confidence, reason, metadata
  )
  select
    p_workspace_key, activity.id, deal.deal_id,
    case when latest_event.to_stage is not null then latest_event.id end,
    latest_event.to_stage, 'deal_date_window',
    case when latest_event.to_stage is null then 'unknown'
      else private.stage_evidence_kind(latest_event.source, latest_event.event_kind) end,
    case
      when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at') then 1
      when deal.created_at_method = 'report_import_created_date' then 0.9
      else 0.7
    end,
    'The activity occurred after this deal started and before it ended.',
    jsonb_build_object(
      'windowStart', coalesce(deal.estimated_created_at, deal.first_seen_at),
      'windowEnd', deal.archived_at,
      'overlapAllowed', true
    )
  from public.activity_people person_link
  join public.activities activity
    on activity.id = person_link.activity_id and activity.workspace_key = p_workspace_key
  join public.dripjobs_sales_deals deal on deal.person_id = p_person_id
  left join lateral (
    select event.id, event.event_kind, event.to_stage, event.source
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key and event.deal_id = deal.deal_id
      and (event.effective_at, event.id) <= (activity.occurred_at, 9223372036854775807::bigint)
    order by event.effective_at desc, event.id desc limit 1
  ) latest_event on true
  where person_link.person_id = p_person_id
    and person_link.relationship = 'counterparty'
    and activity.occurred_at >= coalesce(deal.estimated_created_at, deal.first_seen_at)
    and activity.occurred_at < coalesce(deal.archived_at, 'infinity'::timestamptz)
  on conflict (workspace_key, activity_id, deal_id) do nothing;
  get diagnostics v_date_window = row_count;

  return jsonb_build_object(
    'personId', p_person_id,
    'deleted', v_deleted,
    'provider', v_provider,
    'dateWindow', v_date_window
  );
end;
$$;

revoke all on function private.reconcile_person_deal_activity_links(text, uuid)
  from public, anon, authenticated;
grant execute on function private.reconcile_person_deal_activity_links(text, uuid)
  to service_role;

comment on function private.reconcile_person_deal_activity_links(text, uuid) is
  'Rebuilds deterministic deal links while preserving exact provider-linked DripJobs chat evidence outside coarse date estimates.';
