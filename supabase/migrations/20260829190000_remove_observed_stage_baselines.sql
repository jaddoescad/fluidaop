-- A snapshot's first sight of a deal is ingestion metadata, not CRM history.
-- Keep real stage-change events, but remove and permanently reject the old
-- synthetic `baseline` rows that made "first observed" look like "entered".

create or replace function private.reject_dripjobs_stage_baseline()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.event_kind = 'baseline' then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function private.reject_dripjobs_stage_baseline()
  from public, anon, authenticated;

drop trigger if exists reject_dripjobs_stage_baseline
  on public.dripjobs_pipeline_stage_events;
create trigger reject_dripjobs_stage_baseline
before insert or update on public.dripjobs_pipeline_stage_events
for each row execute function private.reject_dripjobs_stage_baseline();

delete from public.dripjobs_pipeline_stage_events
where event_kind = 'baseline';

alter table public.dripjobs_pipeline_stage_events
  drop constraint if exists dripjobs_pipeline_stage_events_no_baseline;
alter table public.dripjobs_pipeline_stage_events
  add constraint dripjobs_pipeline_stage_events_no_baseline
  check (event_kind <> 'baseline');

-- Deleting an event sets its links' FK to null. Remove the stale stage label
-- too: the activity is still safely linked to the deal, but no exact DripJobs
-- stage was proven for it.
update public.deal_activity_links
set
  stage_name = null,
  stage_evidence = 'unknown',
  updated_at = now()
where stage_event_id is null
  and (stage_name is not null or stage_evidence <> 'unknown');

-- The current sync still supplies scrape timestamps in these two columns.
-- Normalize every write from the retained, non-baseline event history so a
-- future sync cannot silently put the fake timestamp back.
create or replace function private.enforce_real_deal_stage_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_effective_at timestamptz;
  v_observed_at timestamptz;
begin
  select event.effective_at, event.observed_at
  into v_effective_at, v_observed_at
  from public.dripjobs_pipeline_stage_events event
  where event.deal_id = new.deal_id
    and event.event_kind <> 'baseline'
    and event.to_stage is not null
  order by event.effective_at desc, event.id desc
  limit 1;

  new.stage_entered_at := v_effective_at;
  new.stage_observed_at := v_observed_at;
  return new;
end;
$$;

revoke all on function private.enforce_real_deal_stage_timestamps()
  from public, anon, authenticated;

drop trigger if exists enforce_real_deal_stage_timestamps
  on public.dripjobs_sales_deals;
create trigger enforce_real_deal_stage_timestamps
before insert or update on public.dripjobs_sales_deals
for each row execute function private.enforce_real_deal_stage_timestamps();

-- Re-run the normalizer over existing deals. Baseline-only deals become null;
-- deals with an actual transition retain that transition's timestamps.
update public.dripjobs_sales_deals
set
  stage_entered_at = stage_entered_at,
  stage_observed_at = stage_observed_at;

-- Cards use the strongest real boundary available:
--   1. a retained stage-change/reactivation event;
--   2. a reached lifecycle milestone;
--   3. the imported DripJobs lead-created date.
-- Snapshot first-observed time is never a boundary.
create or replace function private.deal_current_stage_touches(
  p_workspace_key text,
  p_deal_id text
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with deal as (
    select
      sales.deal_id,
      sales.deal_stage,
      coalesce(sales.estimated_created_at, sales.first_seen_at) as received_at
    from public.dripjobs_sales_deals sales
    join public.people person
      on person.id = sales.person_id
     and person.workspace_key = p_workspace_key
    where sales.deal_id = p_deal_id
  ),
  real_stage_event as (
    select event.effective_at, event.source, event.event_kind
    from public.dripjobs_pipeline_stage_events event
    join deal on deal.deal_id = event.deal_id
    where event.workspace_key = p_workspace_key
      and event.event_kind in ('stage_changed', 'reactivated')
      and event.to_stage = deal.deal_stage
    order by event.effective_at desc, event.id desc
    limit 1
  ),
  milestone_bounds as (
    select
      max(milestone.occurred_at) filter (
        where milestone.milestone_type in ('appointment_scheduled', 'appointment_completed')
      ) as appointment_at,
      max(milestone.occurred_at) filter (
        where milestone.milestone_type = 'proposal_sent'
      ) as proposal_at,
      max(milestone.occurred_at) filter (
        where milestone.milestone_type in ('deal_closed', 'proposal_accepted')
      ) as closed_at
    from deal
    left join public.deal_milestone_events milestone
      on milestone.workspace_key = p_workspace_key
     and milestone.deal_id = deal.deal_id
     and milestone.occurred_at >= deal.received_at
     and milestone.occurred_at <= pg_catalog.now()
  ),
  lifecycle_boundary as (
    select
      case
        when bounds.closed_at is not null then 'deal_closed'
        when bounds.proposal_at is not null then 'proposal_sent'
        when bounds.appointment_at is not null then 'appointment_scheduled'
        else 'lead_received'
      end as phase,
      case
        when bounds.closed_at is not null then 'Deal closed'
        when bounds.proposal_at is not null then 'Proposal sent'
        when bounds.appointment_at is not null then 'Appointment scheduled'
        else 'Lead received'
      end as phase_label,
      coalesce(bounds.closed_at, bounds.proposal_at, bounds.appointment_at, deal.received_at) as phase_started_at
    from deal
    cross join milestone_bounds bounds
  ),
  boundary as (
    select
      case when stage_event.effective_at is not null then 'dripjobs_stage' else lifecycle.phase end as phase,
      case when stage_event.effective_at is not null then deal.deal_stage else lifecycle.phase_label end as phase_label,
      least(
        pg_catalog.now(),
        greatest(
          deal.received_at,
          coalesce(stage_event.effective_at, lifecycle.phase_started_at)
        )
      ) as phase_started_at,
      case
        when stage_event.source in ('api', 'webhook', 'zapier') then 'exact'
        when stage_event.effective_at is not null then 'observed'
        when lifecycle.phase = 'lead_received' then 'inferred'
        else 'inferred'
      end as evidence_kind
    from deal
    cross join lifecycle_boundary lifecycle
    left join real_stage_event stage_event on true
  ),
  touch as (
    select
      activity.id as activity_id,
      activity.direction,
      activity.occurred_at,
      lower(coalesce(activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
        as is_automated,
      activity.source = 'dripjobs'
        and activity.direction = 'inbound'
        and btrim(coalesce(nullif(activity.body_text, ''), activity.preview, ''))
          ~* '^(loved|liked|disliked|laughed at|emphasized|questioned)[[:space:]]+[“"].+[”"]$'
        as is_reaction
    from public.deal_activity_links link
    join public.activities activity on activity.id = link.activity_id
    cross join boundary
    where link.workspace_key = p_workspace_key
      and link.deal_id = p_deal_id
      and activity.occurred_at >= boundary.phase_started_at
  ),
  bounds as (
    select
      (pg_catalog.now() at time zone 'America/Toronto')::date as today,
      (boundary.phase_started_at at time zone 'America/Toronto')::date as entered_on
    from boundary
  ),
  strip_day as (
    select generated::date as on_date
    from bounds
    cross join generate_series(
      greatest(bounds.entered_on, bounds.today - 15)::timestamp,
      bounds.today::timestamp,
      interval '1 day'
    ) as generated
  ),
  day_level as (
    select
      strip_day.on_date,
      case
        when count(touch.activity_id) filter (
          where touch.direction = 'inbound'
            and not touch.is_automated
            and not touch.is_reaction
        ) > 0 then 3
        when count(touch.activity_id) filter (
          where touch.direction = 'outbound'
            and not touch.is_automated
            and not touch.is_reaction
        ) > 0 then 2
        when count(touch.activity_id) filter (where touch.is_automated) > 0 then 1
        else 0
      end as level
    from strip_day
    left join touch
      on (touch.occurred_at at time zone 'America/Toronto')::date = strip_day.on_date
    group by strip_day.on_date
  )
  select jsonb_build_object(
    'outbound', count(*) filter (
      where touch.direction = 'outbound' and not touch.is_automated and not touch.is_reaction
    ),
    'inbound', count(*) filter (
      where touch.direction = 'inbound' and not touch.is_automated and not touch.is_reaction
    ),
    'automated', count(*) filter (where touch.is_automated),
    'reactions', count(*) filter (where touch.is_reaction),
    'lastAt', max(touch.occurred_at) filter (
      where not touch.is_automated and not touch.is_reaction
    ),
    'lastDirection', (
      array_agg(touch.direction order by touch.occurred_at desc, touch.activity_id desc)
        filter (where not touch.is_automated and not touch.is_reaction)
    )[1],
    'phase', (select boundary.phase from boundary),
    'phaseLabel', (select boundary.phase_label from boundary),
    'phaseStartedAt', (select boundary.phase_started_at from boundary),
    'evidenceKind', (select boundary.evidence_kind from boundary),
    'days', (
      select coalesce(jsonb_agg(day_level.level order by day_level.on_date), '[]'::jsonb)
      from day_level
    ),
    'daysBefore', (
      select coalesce(greatest(0, (bounds.today - bounds.entered_on) - 15), 0)
      from bounds
    )
  )
  from touch;
$$;

revoke all on function private.deal_current_stage_touches(text, text)
  from public, anon, authenticated;
grant execute on function private.deal_current_stage_touches(text, text)
  to service_role;

comment on function private.deal_current_stage_touches(text, text) is
  'Current-phase touch counts and day strip. Uses real stage changes, then lifecycle milestones, then the DripJobs lead-created date; never snapshot first-observed baselines.';
