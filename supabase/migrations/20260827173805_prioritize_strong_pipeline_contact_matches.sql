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
  deal_signal_matches as (
    select deal.deal_id, activity.id as activity_id, activity.occurred_at
    from current_deals deal
    join public.activities activity
      on activity.workspace_key = p_workspace_key
     and deal.normalized_email is not null
     and deal.normalized_email <> ''
     and private.fluid_normalize_email(activity.actor_email) = deal.normalized_email

    union all

    select deal.deal_id, activity.id as activity_id, activity.occurred_at
    from current_deals deal
    join public.activities activity
      on activity.workspace_key = p_workspace_key
     and deal.normalized_phone is not null
     and deal.normalized_phone <> ''
     and private.fluid_normalize_phone(activity.actor_phone)
       = private.fluid_normalize_phone(deal.normalized_phone)
  ),
  deal_signal_stats as (
    select match.deal_id, max(match.occurred_at) as last_signal_at
    from deal_signal_matches match
    group by match.deal_id
  ),
  person_identifier_matches as (
    select deal.deal_id, person.id as person_id, 'email'::text as identifier_kind
    from current_deals deal
    join public.people person
      on person.workspace_key = p_workspace_key
     and person.status = 'active'
     and deal.normalized_email is not null
     and deal.normalized_email <> ''
     and lower(btrim(coalesce(person.primary_email, ''))) = deal.normalized_email

    union all

    select deal.deal_id, person.id as person_id, 'phone'::text as identifier_kind
    from current_deals deal
    join public.people person
      on person.workspace_key = p_workspace_key
     and person.status = 'active'
     and deal.normalized_phone is not null
     and deal.normalized_phone <> ''
     and regexp_replace(coalesce(person.primary_phone, ''), '[^0-9]', '', 'g') = deal.normalized_phone

    union all

    select deal.deal_id, person.id as person_id, 'email'::text as identifier_kind
    from current_deals deal
    join public.person_identifiers identifier
      on identifier.active
     and identifier.kind = 'email'
     and deal.normalized_email is not null
     and deal.normalized_email <> ''
     and identifier.normalized_value = deal.normalized_email
    join public.people person
      on person.id = identifier.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'

    union all

    select deal.deal_id, person.id as person_id, 'phone'::text as identifier_kind
    from current_deals deal
    join public.person_identifiers identifier
      on identifier.active
     and identifier.kind = 'phone'
     and deal.normalized_phone is not null
     and deal.normalized_phone <> ''
     and regexp_replace(identifier.normalized_value, '[^0-9]', '', 'g') = deal.normalized_phone
    join public.people person
      on person.id = identifier.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
  ),
  person_match_strengths as (
    select
      match.deal_id,
      match.person_id,
      count(distinct match.identifier_kind)::integer as match_strength,
      case when
        regexp_replace(lower(btrim(person.display_name)), '[[:space:].…]+$', '', 'g')
          = regexp_replace(lower(btrim(deal.customer_name)), '[[:space:].…]+$', '', 'g')
        then 1 else 0
      end as name_match_strength,
      regexp_replace(lower(btrim(person.display_name)), '[[:space:].…]+$', '', 'g') as person_name_key,
      person.created_at as person_created_at
    from person_identifier_matches match
    join current_deals deal using (deal_id)
    join public.people person on person.id = match.person_id
    group by
      match.deal_id,
      match.person_id,
      person.display_name,
      person.created_at,
      deal.customer_name
  ),
  identifier_ranked_person_matches as (
    select
      match.*,
      max(match.match_strength) over (partition by match.deal_id) as best_match_strength
    from person_match_strengths match
  ),
  strongest_identifier_matches as (
    select match.*
    from identifier_ranked_person_matches match
    where match.match_strength = match.best_match_strength
  ),
  name_ranked_person_matches as (
    select
      match.*,
      max(match.name_match_strength) over (partition by match.deal_id) as best_name_match_strength
    from strongest_identifier_matches match
  ),
  best_person_matches as (
    select match.*
    from name_ranked_person_matches match
    where match.name_match_strength = match.best_name_match_strength
  ),
  deduplicated_person_matches as (
    select
      match.*,
      row_number() over (
        partition by
          match.deal_id,
          case
            when match.match_strength = 2 then match.person_name_key
            else match.person_id::text
          end
        order by match.person_created_at, match.person_id
      ) as duplicate_rank
    from best_person_matches match
  ),
  resolved_people as (
    select
      match.deal_id,
      case when count(*) = 1 then (array_agg(match.person_id))[1] end as person_id,
      count(*)::integer as match_count
    from deduplicated_person_matches match
    where match.duplicate_rank = 1
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
        'latestSignalAt', greatest(activity.last_signal_at, deal_activity.last_signal_at)
      ) order by deal.source_row_number, deal.deal_id)
      from current_deals deal
      left join resolved_people resolved using (deal_id)
      left join public.contact_activity_stats activity
        on activity.workspace_key = p_workspace_key
       and activity.person_id = resolved.person_id
      left join deal_signal_stats deal_activity using (deal_id)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_current_dripjobs_pipeline(text)
  from public, anon, authenticated;
grant execute on function public.list_current_dripjobs_pipeline(text)
  to service_role;

comment on function public.list_current_dripjobs_pipeline(text) is
  'Returns the current DripJobs pipeline, preferring stronger identity evidence, collapsing exact duplicate candidates, and retaining the latest signal on the deal identifiers.';
