-- The first version of the day strip was a fixed fortnight ending today, which
-- meant most cards opened with a run of "before this stage" cells that read as
-- dead space. Wrong anchor. The strip belongs to the stage, so it starts on the
-- day the deal moved in and grows a cell a day from there — a card that has sat
-- untouched for three weeks is literally a longer bar than one that arrived
-- yesterday, before you read a single number.
--
-- One cell per day, entry day first, today last:
--   0  nothing happened
--   1  automated sends only
--   2  we reached out
--   3  they replied  (a reply outranks anything else that day)
--
-- Capped at 28 cells, which is what fits a 272px board column. Past that the
-- oldest days fall off the left and `daysBefore` counts what was dropped, so a
-- long-parked deal never quietly looks like a four-week-old one.

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
  with stage_event as (
    select event.id, event.effective_at
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key
      and event.deal_id = p_deal_id
      and event.to_stage is not null
    order by event.effective_at desc, event.id desc
    limit 1
  ),
  touch as (
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
      and link.stage_event_id = (select stage_event.id from stage_event)
  ),
  bounds as (
    select
      (pg_catalog.now() at time zone 'America/Toronto')::date as today,
      -- A stage event stamped in the future is clock skew, not a deal that has
      -- not started yet; clamping keeps the strip at one honest cell.
      least(
        ((select stage_event.effective_at from stage_event) at time zone 'America/Toronto')::date,
        (pg_catalog.now() at time zone 'America/Toronto')::date
      ) as entered_on
  ),
  strip_day as (
    select generated::date as on_date
    from bounds
    cross join generate_series(
      greatest(bounds.entered_on, bounds.today - 27)::timestamp,
      bounds.today::timestamp,
      interval '1 day'
    ) as generated
    -- No stage event means no window to draw. An empty strip is the honest
    -- answer; four weeks of empty cells would be an accusation.
    where bounds.entered_on is not null
  ),
  day_level as (
    select
      strip_day.on_date,
      case
        when count(touch.activity_id) filter (
          where touch.direction = 'inbound' and not touch.is_automated) > 0 then 3
        when count(touch.activity_id) filter (
          where touch.direction = 'outbound' and not touch.is_automated) > 0 then 2
        when count(touch.activity_id) filter (where touch.is_automated) > 0 then 1
        else 0
      end as level
    from strip_day
    left join touch
      on (touch.occurred_at at time zone 'America/Toronto')::date = strip_day.on_date
    group by strip_day.on_date
  )
  select jsonb_build_object(
    'outbound', count(*) filter (where touch.direction = 'outbound' and not touch.is_automated),
    'inbound', count(*) filter (where touch.direction = 'inbound' and not touch.is_automated),
    'automated', count(*) filter (where touch.is_automated),
    'lastAt', max(touch.occurred_at) filter (where not touch.is_automated),
    'lastDirection', (
      array_agg(touch.direction order by touch.occurred_at desc, touch.activity_id desc)
        filter (where not touch.is_automated)
    )[1],
    'days', (
      select coalesce(jsonb_agg(day_level.level order by day_level.on_date), '[]'::jsonb)
      from day_level
    ),
    'daysBefore', (
      select coalesce(greatest(0, (bounds.today - bounds.entered_on) - 27), 0) from bounds
    )
  )
  from touch;
$$;

comment on function private.deal_current_stage_touches(text, text) is
  'Touch counts, last-touch time and a day-per-cell activity strip anchored to the day the deal entered its current stage.';
