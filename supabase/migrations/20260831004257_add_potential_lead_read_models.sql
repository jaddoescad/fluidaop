-- Read models for the Potential Leads column and the Signals unread badge.

/** Signals nobody has opened yet.
 *
 * Mirrors the universe of list_real_board_signals — the same workspace and the
 * same two sources — so the badge counts the cards the column can actually
 * show, and never drifts above it. */
create or replace function public.count_unread_real_board_signals(
  p_workspace_key text default 'ottawa-painters'
)
returns integer
language sql
stable
set search_path = 'pg_catalog', 'public'
as $$
  select count(*)::int
  from public.activities activity
  where activity.workspace_key = p_workspace_key
    and activity.source in ('gmail', 'quo')
    and not exists (
      select 1
      from public.signal_reads read_state
      where read_state.workspace_key = activity.workspace_key
        and read_state.activity_id = activity.id
    );
$$;

/** The Potential Leads column.
 *
 * Undecided first, then decided ones newest-first: a decision dims a card and
 * sinks it, but never removes it, so the column stays a record of what was
 * judged and not only of what is outstanding. */
create or replace function public.list_lead_candidates(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 100
)
returns jsonb
language sql
stable
set search_path = 'pg_catalog', 'public'
as $$
  with visible as (
    select
      candidate.*,
      activity.subject as signal_subject,
      activity.preview as signal_preview,
      activity.occurred_at as signal_at,
      activity.direction as signal_direction,
      activity.source as signal_source,
      activity.event_type as signal_event_type,
      activity.actor_name as signal_actor_name,
      activity.call_status as signal_call_status,
      activity.duration_seconds as signal_duration_seconds
    from public.lead_candidates candidate
    join public.activities activity on activity.id = candidate.activity_id
    where candidate.workspace_key = p_workspace_key
    order by (candidate.disposition = 'undecided') desc, candidate.created_at desc
    limit least(greatest(p_limit, 1), 500)
  )
  select jsonb_build_object(
    'undecidedCount', (
      select count(*)::int from public.lead_candidates
      where workspace_key = p_workspace_key and disposition = 'undecided'
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'activityId', item.activity_id,
        'personId', item.person_id,
        'name', item.contact_name,
        'email', item.contact_email,
        'phone', item.contact_phone,
        'channel', item.channel,
        'summary', item.summary,
        'reason', item.reason,
        'confidence', item.confidence,
        'disposition', item.disposition,
        'decidedBy', item.decided_by,
        'decidedAt', item.decided_at,
        'createdAt', item.created_at,
        'signal', jsonb_build_object(
          'subject', item.signal_subject,
          'preview', item.signal_preview,
          'occurredAt', item.signal_at,
          'direction', item.signal_direction,
          'source', item.signal_source,
          'eventType', item.signal_event_type,
          'actorName', item.signal_actor_name,
          'callStatus', item.signal_call_status,
          'durationSeconds', item.signal_duration_seconds
        )
      ) order by (item.disposition = 'undecided') desc, item.created_at desc)
      from visible item
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.count_unread_real_board_signals(text) from public, anon, authenticated;
revoke all on function public.list_lead_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.count_unread_real_board_signals(text) to service_role;
grant execute on function public.list_lead_candidates(text, integer) to service_role;
