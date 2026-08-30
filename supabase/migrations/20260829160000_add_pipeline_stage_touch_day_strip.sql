-- A count answers "how much", never "when". Two deals both showing seven
-- touches are different deals if one was worked steadily and the other was
-- hammered in a single afternoon three weeks ago. This adds a fixed two-week
-- day strip to the stage touch stats so the card can show the shape of the
-- follow-up, with the trailing run of empty days standing in for the silence.
--
-- One cell per day, oldest first, so today is always the last element and the
-- strips line up card to card:
--   -1  the day fell before this deal entered its current stage
--    0  nothing happened
--    1  automated sends only
--    2  we reached out
--    3  they replied  (a reply outranks anything else that day)

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
  strip_day as (
    select
      day_offset,
      ((pg_catalog.now() at time zone 'America/Toronto')::date - day_offset) as on_date
    from generate_series(13, 0, -1) as day_offset
  ),
  day_level as (
    select
      strip_day.day_offset,
      case
        -- The stage window opened mid-strip: the days before it are not silence
        -- we are answerable for, so the card draws them as absent rather than empty.
        when strip_day.on_date
          < ((select stage_event.effective_at from stage_event) at time zone 'America/Toronto')::date
          then -1
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
    group by strip_day.day_offset, strip_day.on_date
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
      select coalesce(jsonb_agg(day_level.level order by day_level.day_offset desc), '[]'::jsonb)
      from day_level
    )
  )
  from touch;
$$;

comment on function private.deal_current_stage_touches(text, text) is
  'Touch counts, last-touch time and a 14-day activity strip for one deal, scoped to the stage window it is currently in.';
