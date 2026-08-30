-- The Board is becoming a focused sales workspace. Keep operational contacts and their
-- Signals in the underlying model, but only project prospective or established
-- customers into the People column.
create or replace function public.list_real_board_people(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 30,
  p_cursor_attention boolean default null,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with relevant as (
    select
      person.id,
      person.display_name,
      person.primary_email,
      person.primary_phone,
      person.entity_type,
      max(activity.occurred_at) as latest_activity_at,
      count(distinct activity.id) filter (
        where activity.occurred_at >= now() - interval '30 days'
      )::integer as recent_signal_count,
      count(distinct activity.id) filter (
        where review.status in ('pending', 'action_open')
          and review.input_revision = activity.recommendation_revision
      )::integer as pending_signal_count
    from public.people person
    join public.activity_people link on link.person_id = person.id
    join public.activities activity on activity.id = link.activity_id
      and activity.workspace_key = person.workspace_key
      and activity.source in ('gmail', 'quo')
    left join public.signal_review_states review on review.activity_id = activity.id
    where person.workspace_key = p_workspace_key
      and person.status = 'active'
      and exists (
        select 1
        from public.person_roles board_role
        where board_role.person_id = person.id
          and board_role.role_key in ('lead', 'customer')
          and board_role.active
      )
    group by person.id
    having max(activity.occurred_at) >= now() - interval '30 days'
      or count(distinct activity.id) filter (
        where review.status in ('pending', 'action_open')
          and review.input_revision = activity.recommendation_revision
      ) > 0
  ),
  candidates as (
    select relevant.*,
      relevant.pending_signal_count > 0 as needs_attention,
      coalesce(roles.value, '[]'::jsonb) as roles,
      latest.subject as latest_subject,
      latest.preview as latest_preview,
      latest.source as latest_source,
      latest.event_type as latest_event_type,
      latest.direction as latest_direction,
      latest.urgency as urgency
    from relevant
    left join lateral (
      select jsonb_agg(role.role_key order by role.role_key) as value
      from (
        select distinct role.role_key
        from public.person_roles role
        where role.person_id = relevant.id and role.active
      ) role
    ) roles on true
    left join lateral (
      select activity.subject, activity.preview, activity.source,
        activity.event_type, activity.direction, urgency_label.name as urgency
      from public.activity_people activity_link
      join public.activities activity on activity.id = activity_link.activity_id
      left join public.signal_labels urgency_assignment
        on urgency_assignment.activity_id = activity.id
        and urgency_assignment.agent_key = 'signal-triage'
        and urgency_assignment.label_kind = 'urgency'
      left join public.labels urgency_label on urgency_label.id = urgency_assignment.label_id
      where activity_link.person_id = relevant.id
        and activity.workspace_key = p_workspace_key
        and activity.source in ('gmail', 'quo')
      order by activity.occurred_at desc, activity.id desc
      limit 1
    ) latest on true
  ),
  page as (
    select * from candidates
    where p_cursor_attention is null
      or needs_attention < p_cursor_attention
      or (needs_attention = p_cursor_attention and (
        latest_activity_at < p_cursor_at
        or (latest_activity_at = p_cursor_at and id < p_cursor_id)
      ))
    order by needs_attention desc, latest_activity_at desc, id desc
    limit least(greatest(p_limit, 1), 100) + 1
  ),
  visible as (
    select * from page
    order by needs_attention desc, latest_activity_at desc, id desc
    limit least(greatest(p_limit, 1), 100)
  ),
  last_row as (
    select * from visible order by needs_attention, latest_activity_at, id limit 1
  )
  select jsonb_build_object(
    'count', (select count(*) from candidates),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'displayName', item.display_name,
        'primaryEmail', item.primary_email,
        'primaryPhone', item.primary_phone,
        'entityType', item.entity_type,
        'roles', item.roles,
        'needsAttention', item.needs_attention,
        'pendingRecommendationCount', item.pending_signal_count,
        'recentSignalCount', item.recent_signal_count,
        'latestActivityAt', item.latest_activity_at,
        'latestSignal', jsonb_build_object(
          'subject', item.latest_subject,
          'preview', item.latest_preview,
          'source', item.latest_source,
          'eventType', item.latest_event_type,
          'direction', item.latest_direction
        ),
        'urgency', item.urgency
      ) order by item.needs_attention desc, item.latest_activity_at desc, item.id desc)
      from visible item
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from page) > least(greatest(p_limit, 1), 100)
      then (select jsonb_build_object(
        'attention', needs_attention,
        'at', latest_activity_at,
        'id', id
      ) from last_row)
      else null
    end
  );
$$;

revoke all on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid)
  to service_role;

comment on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid) is
  'Lists activity-relevant leads and customers for the Board People column with cursor pagination and a total count.';
