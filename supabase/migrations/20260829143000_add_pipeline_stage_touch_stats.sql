-- A pipeline card needs to answer "have we worked this deal *here*?" — the
-- count of touches inside the stage the card is sitting in, not the lifetime
-- total. Outreach earned in Cold Leads says nothing about a deal that has been
-- parked in Proposal(s) Sent for three weeks, so this scopes both the count and
-- the last-touch time to the deal's current stage window.
--
-- Automated sends are counted separately: a drip sequence firing ten emails is
-- not ten touches somebody made, and folding them in would make an untouched
-- deal look worked.

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
  select jsonb_build_object(
    'outbound', count(*) filter (where touch.direction = 'outbound' and not touch.is_automated),
    'inbound', count(*) filter (where touch.direction = 'inbound' and not touch.is_automated),
    'automated', count(*) filter (where touch.is_automated),
    'lastAt', max(touch.occurred_at) filter (where not touch.is_automated),
    'lastDirection', (
      array_agg(touch.direction order by touch.occurred_at desc, touch.activity_id desc)
        filter (where not touch.is_automated)
    )[1]
  )
  from (
    select
      activity.id as activity_id,
      activity.direction,
      activity.occurred_at,
      lower(coalesce(activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
        as is_automated
    from public.deal_activity_links link
    join public.activities activity on activity.id = link.activity_id
    where link.workspace_key = p_workspace_key
      and link.deal_id = p_deal_id
      -- Links with a null stage_event_id are pre-tracking activity Fluid could
      -- not place in a stage. Equality drops them, which is the intent.
      and link.stage_event_id = (
        select event.id
        from public.dripjobs_pipeline_stage_events event
        where event.workspace_key = p_workspace_key
          and event.deal_id = p_deal_id
          and event.to_stage is not null
        order by event.effective_at desc, event.id desc
        limit 1
      )
  ) touch;
$$;

revoke all on function private.deal_current_stage_touches(text, text)
  from public, anon, authenticated;
grant execute on function private.deal_current_stage_touches(text, text)
  to service_role;

comment on function private.deal_current_stage_touches(text, text) is
  'Touch counts and last-touch time for one deal, scoped to the stage window it is currently in.';

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
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
    where deal.archived_at is null
      and (
        deal.last_active_snapshot_at = (select captured_at from latest_success)
        or (
          not exists (select 1 from latest_success)
          and deal.source_document_id = (select source_document_id from legacy_snapshot)
        )
      )
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
        'personId', deal.person_id,
        'personMatchCount', 1,
        'personMatchMethod', deal.person_match_method,
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
        'receivedAt', coalesce(deal.estimated_created_at, deal.first_seen_at),
        'latestSignalAt', activity.last_signal_at,
        'stageTouches', private.deal_current_stage_touches(p_workspace_key, deal.deal_id)
      ) order by deal.source_row_number, deal.deal_id)
      from current_deals deal
      left join public.contact_activity_stats activity
        on activity.workspace_key = p_workspace_key
       and activity.person_id = deal.person_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_current_dripjobs_pipeline(text)
  from public, anon, authenticated;
grant execute on function public.list_current_dripjobs_pipeline(text)
  to service_role;

comment on function public.list_current_dripjobs_pipeline(text) is
  'Current DripJobs pipeline with a required persisted canonical Contact and current-stage touch counts for every deal.';

create or replace function public.list_archived_dripjobs_pipeline(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 60,
  p_cursor_archived_at timestamptz default null,
  p_cursor_deal_id text default null,
  p_received_month date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with deal_signal_stats as (
    select link.deal_id, max(activity.occurred_at) as latest_signal_at
    from public.deal_activity_links link
    join public.activities activity on activity.id = link.activity_id
    group by link.deal_id
  ),
  eligible as (
    select deal.*, activity.latest_signal_at
    from public.dripjobs_sales_deals deal
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
    left join deal_signal_stats activity on activity.deal_id = deal.deal_id
    where deal.archived_at is not null
      and (
        p_received_month is null
        or (
          coalesce(deal.estimated_created_at, deal.first_seen_at) >= (p_received_month::timestamp at time zone 'America/Toronto')
          and coalesce(deal.estimated_created_at, deal.first_seen_at) < ((p_received_month + interval '1 month')::timestamp at time zone 'America/Toronto')
        )
      )
      and (
        p_cursor_archived_at is null
        or (
          p_cursor_deal_id like 'signal:%'
          and (
            activity.latest_signal_at is null
            or (activity.latest_signal_at, deal.deal_id)
              < (p_cursor_archived_at, substring(p_cursor_deal_id from 8))
          )
        )
        or (
          p_cursor_deal_id like 'archive:%'
          and activity.latest_signal_at is null
          and (deal.archived_at, deal.deal_id)
            < (p_cursor_archived_at, substring(p_cursor_deal_id from 9))
        )
      )
    order by
      (activity.latest_signal_at is not null) desc,
      activity.latest_signal_at desc nulls last,
      case when activity.latest_signal_at is null then deal.archived_at end desc,
      deal.deal_id desc
    limit least(greatest(p_limit, 1), 100) + 1
  ),
  classified as (
    select
      deal.*,
      case
        when exists (
          select 1
          from public.deal_milestone_events milestone
          where milestone.deal_id = deal.deal_id
            and milestone.milestone_type in ('deal_closed', 'proposal_accepted')
        ) then case when exists (
          select 1
          from public.deal_milestone_events appointment
          where appointment.deal_id = deal.deal_id
            and appointment.milestone_type = 'appointment_scheduled'
        ) then 'closed_with_appointment' else 'closed_without_appointment' end
        when exists (
          select 1
          from public.deal_milestone_events milestone
          where milestone.deal_id = deal.deal_id
            and milestone.milestone_type = 'proposal_sent'
        ) then 'proposal_sent'
        when exists (
          select 1
          from public.deal_milestone_events milestone
          where milestone.deal_id = deal.deal_id
            and milestone.milestone_type = 'appointment_scheduled'
        ) then 'estimate_scheduled'
        else 'cold_lead'
      end as archive_bucket
    from eligible deal
  ),
  page as (
    select *
    from classified
    order by
      (latest_signal_at is not null) desc,
      latest_signal_at desc nulls last,
      case when latest_signal_at is null then archived_at end desc,
      deal_id desc
    limit least(greatest(p_limit, 1), 100)
  ),
  last_row as (
    select archived_at, latest_signal_at, deal_id
    from page
    order by
      (latest_signal_at is not null) desc,
      latest_signal_at desc nulls last,
      case when latest_signal_at is null then archived_at end desc,
      deal_id desc
    offset least(greatest(p_limit, 1), 100) - 1
    limit 1
  ),
  all_classified as (
    select case
      when exists (
        select 1 from public.deal_milestone_events milestone
        where milestone.deal_id = deal.deal_id
          and milestone.milestone_type in ('deal_closed', 'proposal_accepted')
      ) then case when exists (
        select 1 from public.deal_milestone_events appointment
        where appointment.deal_id = deal.deal_id
          and appointment.milestone_type = 'appointment_scheduled'
      ) then 'closed_with_appointment' else 'closed_without_appointment' end
      when exists (
        select 1 from public.deal_milestone_events milestone
        where milestone.deal_id = deal.deal_id and milestone.milestone_type = 'proposal_sent'
      ) then 'proposal_sent'
      when exists (
        select 1 from public.deal_milestone_events milestone
        where milestone.deal_id = deal.deal_id and milestone.milestone_type = 'appointment_scheduled'
      ) then 'estimate_scheduled'
      else 'cold_lead'
    end as archive_bucket
    from public.dripjobs_sales_deals deal
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
    where deal.archived_at is not null
      and (
        p_received_month is null
        or (
          coalesce(deal.estimated_created_at, deal.first_seen_at) >= (p_received_month::timestamp at time zone 'America/Toronto')
          and coalesce(deal.estimated_created_at, deal.first_seen_at) < ((p_received_month + interval '1 month')::timestamp at time zone 'America/Toronto')
        )
      )
  )
  select jsonb_build_object(
    'count', (
      select count(*)
      from public.dripjobs_sales_deals deal
      join public.people person
        on person.id = deal.person_id
       and person.workspace_key = p_workspace_key
       and person.status = 'active'
      where deal.archived_at is not null
        and (
          p_received_month is null
          or (
            coalesce(deal.estimated_created_at, deal.first_seen_at) >= (p_received_month::timestamp at time zone 'America/Toronto')
            and coalesce(deal.estimated_created_at, deal.first_seen_at) < ((p_received_month + interval '1 month')::timestamp at time zone 'America/Toronto')
          )
        )
    ),
    'monthCounts', coalesce((
      select jsonb_object_agg(month_key, month_count order by month_key desc)
      from (
        select
          to_char(coalesce(deal.estimated_created_at, deal.first_seen_at) at time zone 'America/Toronto', 'YYYY-MM') as month_key,
          count(*) as month_count
        from public.dripjobs_sales_deals deal
        join public.people person
          on person.id = deal.person_id
         and person.workspace_key = p_workspace_key
         and person.status = 'active'
        where deal.archived_at is not null
        group by 1
      ) months
    ), '{}'::jsonb),
    'bucketCounts', jsonb_build_object(
      'cold_lead', (select count(*) from all_classified where archive_bucket = 'cold_lead'),
      'estimate_scheduled', (select count(*) from all_classified where archive_bucket = 'estimate_scheduled'),
      'proposal_sent', (select count(*) from all_classified where archive_bucket = 'proposal_sent')
      , 'closed_with_appointment', (select count(*) from all_classified where archive_bucket = 'closed_with_appointment')
      , 'closed_without_appointment', (select count(*) from all_classified where archive_bucket = 'closed_without_appointment')
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', deal.deal_id,
        'dripjobsContactId', deal.dripjobs_contact_id,
        'personId', deal.person_id,
        'personMatchCount', 1,
        'customerName', deal.customer_name,
        'email', deal.email,
        'phone', deal.phone,
        'dealName', deal.deal_name,
        'stage', deal.deal_stage,
        'status', deal.sales_status,
        'label', deal.label,
        'source', deal.raw_source,
        'amountCents', deal.deal_amount_cents,
        'lastChange', deal.last_change,
        'dealAge', deal.deal_age,
        'salesperson', deal.salesperson,
        'capturedAt', deal.captured_at,
        'receivedAt', coalesce(deal.estimated_created_at, deal.first_seen_at),
        'stageEnteredAt', deal.stage_entered_at,
        'stageObservedAt', deal.stage_observed_at,
        'latestSignalAt', deal.latest_signal_at,
        'stageTouches', private.deal_current_stage_touches(p_workspace_key, deal.deal_id),
        'archived', true,
        'archivedAt', deal.archived_at,
        'archiveBucket', deal.archive_bucket
      ) order by
        (deal.latest_signal_at is not null) desc,
        deal.latest_signal_at desc nulls last,
        case when deal.latest_signal_at is null then deal.archived_at end desc,
        deal.deal_id desc)
      from page deal
    ), '[]'::jsonb),
    'nextCursor', case
      when (select count(*) from eligible) > least(greatest(p_limit, 1), 100)
      then (select jsonb_build_object(
        'at', coalesce(latest_signal_at, archived_at),
        'id', case
          when latest_signal_at is not null then 'signal:' || deal_id
          else 'archive:' || deal_id
        end
      ) from last_row)
      else null
    end
  );
$$;

revoke all on function public.list_archived_dripjobs_pipeline(text, integer, timestamptz, text, date)
  from public, anon, authenticated;
grant execute on function public.list_archived_dripjobs_pipeline(text, integer, timestamptz, text, date)
  to service_role;

comment on function public.list_archived_dripjobs_pipeline(text, integer, timestamptz, text, date) is
  'Keyset-paginated archived DripJobs deals with final-stage touch counts, optionally filtered by lead-received month.';
