-- Archived deals remain accessible on the sales board, grouped by the furthest
-- imported lifecycle milestone. Keyset pagination keeps the board bounded.
create or replace function public.list_archived_dripjobs_pipeline(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 60,
  p_cursor_archived_at timestamptz default null,
  p_cursor_deal_id text default null
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
    ),
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
        'stageEnteredAt', deal.stage_entered_at,
        'stageObservedAt', deal.stage_observed_at,
        'latestSignalAt', deal.latest_signal_at,
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

revoke all on function public.list_archived_dripjobs_pipeline(text, integer, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.list_archived_dripjobs_pipeline(text, integer, timestamptz, text)
  to service_role;

comment on function public.list_archived_dripjobs_pipeline(text, integer, timestamptz, text) is
  'Keyset-paginated archived DripJobs deals classified by their furthest lifecycle milestone.';
