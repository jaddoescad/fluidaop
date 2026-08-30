create or replace function public.list_current_dripjobs_pipeline(
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with latest_success as (
    select run.captured_at, run.finished_at
    from public.dripjobs_pipeline_sync_runs run
    where run.workspace_key = p_workspace_key
      and run.status = 'succeeded'
    order by run.captured_at desc, run.finished_at desc nulls last
    limit 1
  ),
  legacy_snapshot as (
    select deal.source_document_id, max(deal.captured_at) as captured_at
    from public.dripjobs_sales_deals deal
    where deal.source_view = 'active'
    group by deal.source_document_id
    order by max(deal.captured_at) desc, deal.source_document_id desc
    limit 1
  ),
  current_deals as (
    select deal.*
    from public.dripjobs_sales_deals deal
    where deal.archived_at is null
      and (
        deal.last_active_snapshot_at = (select captured_at from latest_success)
        or (
          not exists (select 1 from latest_success)
          and deal.source_document_id = (select source_document_id from legacy_snapshot)
        )
      )
  ),
  person_matches as (
    select distinct deal.deal_id, person.id as person_id
    from current_deals deal
    join public.people person
      on person.workspace_key = p_workspace_key
     and person.status = 'active'
     and (
       (
         deal.normalized_email is not null
         and deal.normalized_email <> ''
         and lower(btrim(coalesce(person.primary_email, ''))) = deal.normalized_email
       )
       or (
         deal.normalized_phone is not null
         and deal.normalized_phone <> ''
         and regexp_replace(coalesce(person.primary_phone, ''), '[^0-9]', '', 'g') = deal.normalized_phone
       )
       or exists (
         select 1
         from public.person_identifiers identifier
         where identifier.person_id = person.id
           and identifier.active
           and (
             (identifier.kind = 'email' and identifier.normalized_value = deal.normalized_email)
             or (
               identifier.kind = 'phone'
               and regexp_replace(identifier.normalized_value, '[^0-9]', '', 'g') = deal.normalized_phone
             )
           )
       )
     )
  ),
  resolved_people as (
    select
      match.deal_id,
      case when count(*) = 1 then (array_agg(match.person_id))[1] end as person_id,
      count(*)::integer as match_count
    from person_matches match
    group by match.deal_id
  ),
  sync_state as (
    select
      success.captured_at,
      success.finished_at,
      case
        when success.finished_at is null then 'missing'
        when success.finished_at < now() - interval '72 hours' then 'unhealthy'
        when success.finished_at < now() - interval '36 hours' then 'stale'
        else 'healthy'
      end as status
    from latest_success success
  )
  select jsonb_build_object(
    'count', (select count(*) from current_deals),
    'capturedAt', coalesce(
      (select captured_at from latest_success),
      (select captured_at from legacy_snapshot)
    ),
    'sync', jsonb_build_object(
      'cadence', 'daily',
      'lastSucceededAt', (select finished_at from sync_state),
      'status', coalesce((select status from sync_state), 'missing'),
      'stale', coalesce((select status in ('stale', 'unhealthy') from sync_state), true),
      'unhealthy', coalesce((select status = 'unhealthy' from sync_state), false)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', deal.deal_id,
        'dripjobsContactId', deal.dripjobs_contact_id,
        'personId', resolved.person_id,
        'personMatchCount', coalesce(resolved.match_count, 0),
        'customerName', deal.customer_name,
        'email', deal.email,
        'phone', deal.phone,
        'dealName', deal.deal_name,
        'stage', deal.deal_stage,
        'stageEnteredAt', deal.stage_entered_at,
        'stageObservedAt', deal.stage_observed_at,
        'status', deal.sales_status,
        'label', deal.label,
        'source', deal.raw_source,
        'amountCents', deal.deal_amount_cents,
        'lastChange', deal.last_change,
        'dealAge', deal.deal_age,
        'salesperson', deal.salesperson,
        'capturedAt', deal.captured_at,
        'latestSignalAt', activity.last_signal_at
      ) order by deal.source_row_number, deal.deal_id)
      from current_deals deal
      left join resolved_people resolved using (deal_id)
      left join public.contact_activity_stats activity
        on activity.workspace_key = p_workspace_key
       and activity.person_id = resolved.person_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_current_dripjobs_pipeline(text)
  from public, anon, authenticated;
grant execute on function public.list_current_dripjobs_pipeline(text)
  to service_role;

comment on function public.list_current_dripjobs_pipeline(text) is
  'Returns the current DripJobs pipeline with resolved contacts, sync health, stage timing, and each contact latest customer signal time.';
