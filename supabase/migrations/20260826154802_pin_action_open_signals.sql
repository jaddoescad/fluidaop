-- Keep Signals with an accepted Action visible and sort them by the moment the
-- user created the Action. The rank is part of the cursor so pagination remains
-- deterministic across the action-open and chronological sections.

drop function if exists public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint);

create function public.list_real_board_signals(
  p_workspace_key text default 'ottawa-painters',
  p_contact_id uuid default null,
  p_view text default 'all',
  p_limit integer default 30,
  p_cursor_at timestamptz default null,
  p_cursor_id bigint default null,
  p_cursor_action_open boolean default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with enriched as (
    select
      activity.*,
      contact.value as contact,
      coalesce(labels.value, '[]'::jsonb) as labels,
      coalesce(review.status, 'settled') as review_status,
      review.resolution as review_resolution,
      review.updated_at as review_updated_at,
      coalesce(review.pending_recommendation_count, 0) as pending_recommendation_count,
      coalesce(review.status = 'action_open', false) as action_open,
      case
        when review.status = 'action_open' then coalesce(review.updated_at, activity.occurred_at)
        else activity.occurred_at
      end as board_sort_at
    from public.activities activity
    left join public.signal_review_states review
      on review.activity_id = activity.id
      and review.input_revision = activity.recommendation_revision
    left join lateral (
      select jsonb_build_object(
        'id', person.id,
        'displayName', person.display_name,
        'primaryEmail', person.primary_email,
        'primaryPhone', person.primary_phone
      ) as value
      from public.activity_people link
      join public.people person on person.id = link.person_id and person.status = 'active'
      where link.activity_id = activity.id
      order by case link.relationship when 'counterparty' then 0 when 'customer' then 1 else 2 end,
        link.confidence desc, person.updated_at desc
      limit 1
    ) contact on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'kind', assignment.label_kind,
        'key', label.key,
        'name', label.name,
        'color', label.color,
        'confidence', assignment.confidence
      ) order by assignment.label_kind) as value
      from public.signal_labels assignment
      join public.labels label on label.id = assignment.label_id
      where assignment.activity_id = activity.id
        and assignment.agent_key = 'signal-triage'
    ) labels on true
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and (p_contact_id is null or exists (
        select 1 from public.activity_people selected_link
        where selected_link.activity_id = activity.id
          and selected_link.person_id = p_contact_id
      ))
  ),
  candidates as (
    select *
    from enriched
    where (p_view = 'all' or (
      p_view = 'needs_you'
      and (
        action_open
        or (review_status = 'pending' and pending_recommendation_count > 0)
      )
    ))
      and (
        p_cursor_at is null
        or (case when action_open then 1 else 0 end) <
          (case when coalesce(p_cursor_action_open, false) then 1 else 0 end)
        or (
          action_open = coalesce(p_cursor_action_open, false)
          and board_sort_at < p_cursor_at
        )
        or (
          action_open = coalesce(p_cursor_action_open, false)
          and board_sort_at = p_cursor_at
          and id < p_cursor_id
        )
      )
    order by action_open desc, board_sort_at desc, id desc
    limit least(greatest(p_limit, 1), 100) + 1
  ),
  visible as (
    select * from candidates
    order by action_open desc, board_sort_at desc, id desc
    limit least(greatest(p_limit, 1), 100)
  ),
  last_row as (
    select * from visible
    order by action_open, board_sort_at, id
    limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'source', item.source,
        'eventType', item.event_type,
        'direction', item.direction,
        'actorName', item.actor_name,
        'actorEmail', item.actor_email,
        'actorPhone', item.actor_phone,
        'subject', item.subject,
        'preview', item.preview,
        'occurredAt', item.occurred_at,
        'threadId', item.external_thread_id,
        'hasAttachments', item.has_attachments,
        'attachmentCount', item.attachment_count,
        'isAutomated', lower(coalesce(item.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes'),
        'contact', item.contact,
        'labels', item.labels,
        'actionOpen', item.action_open,
        'boardSortAt', item.board_sort_at,
        'review', jsonb_build_object(
          'status', item.review_status,
          'resolution', item.review_resolution,
          'pendingRecommendationCount', item.pending_recommendation_count,
          'updatedAt', item.review_updated_at
        )
      ) order by item.action_open desc, item.board_sort_at desc, item.id desc)
      from visible item
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from candidates) > least(greatest(p_limit, 1), 100)
      then (select jsonb_build_object(
        'actionOpen', action_open,
        'at', board_sort_at,
        'id', id
      ) from last_row)
      else null
    end
  );
$$;

revoke all on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint, boolean)
  to service_role;

comment on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint, boolean) is
  'Returns external Signals with action-open priority and stable ranked cursor pagination.';
