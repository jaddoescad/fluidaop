create or replace function public.get_real_board_summary(
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'signalsToday', (
      select count(*)
      from public.activities activity
      where activity.workspace_key = p_workspace_key
        and activity.source in ('gmail', 'quo')
        and (activity.occurred_at at time zone 'America/Toronto')::date =
          (now() at time zone 'America/Toronto')::date
    ),
    'actionsOpen', (
      select count(*)
      from public.work_items item
      where item.workspace_key = p_workspace_key
        and item.created_by_user_at is not null
        and item.status = 'open'
        and item.due_at is null
    ),
    'remindersDue', (
      select count(*)
      from public.work_items item
      where item.workspace_key = p_workspace_key
        and item.created_by_user_at is not null
        and item.status in ('open', 'waiting')
        and item.due_at is not null
        and item.due_at <= now()
    )
  );
$$;

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
      count(distinct recommendation.activity_id) filter (
        where recommendation.status = 'pending' and not recommendation.is_shadow
      )::integer as pending_recommendation_count
    from public.people person
    join public.activity_people link on link.person_id = person.id
    join public.activities activity on activity.id = link.activity_id
      and activity.workspace_key = person.workspace_key
      and activity.source in ('gmail', 'quo')
    left join public.signal_recommendations recommendation
      on recommendation.activity_id = activity.id
      and recommendation.input_revision = activity.recommendation_revision
      and recommendation.workspace_key = activity.workspace_key
    where person.workspace_key = p_workspace_key
      and person.status = 'active'
    group by person.id
    having max(activity.occurred_at) >= now() - interval '30 days'
      or count(distinct recommendation.activity_id) filter (
        where recommendation.status = 'pending' and not recommendation.is_shadow
      ) > 0
  ),
  candidates as (
    select relevant.*,
      relevant.pending_recommendation_count > 0 as needs_attention,
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
        activity.event_type, activity.direction,
        urgency_label.name as urgency
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
    select *
    from candidates
    where p_cursor_attention is null
      or needs_attention < p_cursor_attention
      or (
        needs_attention = p_cursor_attention
        and (
          latest_activity_at < p_cursor_at
          or (latest_activity_at = p_cursor_at and id < p_cursor_id)
        )
      )
    order by needs_attention desc, latest_activity_at desc, id desc
    limit least(greatest(p_limit, 1), 100) + 1
  ),
  visible as (
    select * from page
    order by needs_attention desc, latest_activity_at desc, id desc
    limit least(greatest(p_limit, 1), 100)
  ),
  last_row as (
    select * from visible
    order by needs_attention, latest_activity_at, id
    limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'displayName', item.display_name,
        'primaryEmail', item.primary_email,
        'primaryPhone', item.primary_phone,
        'entityType', item.entity_type,
        'roles', item.roles,
        'needsAttention', item.needs_attention,
        'pendingRecommendationCount', item.pending_recommendation_count,
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

create or replace function public.list_real_board_signals(
  p_workspace_key text default 'ottawa-painters',
  p_contact_id uuid default null,
  p_view text default 'all',
  p_limit integer default 30,
  p_cursor_at timestamptz default null,
  p_cursor_id bigint default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with candidates as (
    select
      activity.*,
      contact.value as contact,
      coalesce(labels.value, '[]'::jsonb) as labels,
      coalesce(review.status, 'settled') as review_status,
      review.resolution as review_resolution,
      coalesce(review.pending_recommendation_count, 0) as pending_recommendation_count
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
      and (p_view = 'all' or (
        p_view = 'needs_you'
        and review.status = 'pending'
        and review.pending_recommendation_count > 0
      ))
      and (
        p_cursor_at is null
        or activity.occurred_at < p_cursor_at
        or (activity.occurred_at = p_cursor_at and activity.id < p_cursor_id)
      )
    order by activity.occurred_at desc, activity.id desc
    limit least(greatest(p_limit, 1), 100) + 1
  ),
  visible as (
    select * from candidates
    order by occurred_at desc, id desc
    limit least(greatest(p_limit, 1), 100)
  ),
  last_row as (
    select * from visible order by occurred_at, id limit 1
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
        'review', jsonb_build_object(
          'status', item.review_status,
          'resolution', item.review_resolution,
          'pendingRecommendationCount', item.pending_recommendation_count
        )
      ) order by item.occurred_at desc, item.id desc)
      from visible item
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from candidates) > least(greatest(p_limit, 1), 100)
      then (select jsonb_build_object('at', occurred_at, 'id', id) from last_row)
      else null
    end
  );
$$;

create or replace function public.get_real_board_signal(
  p_workspace_key text,
  p_activity_id bigint,
  p_history_limit integer default 30,
  p_history_cursor_at timestamptz default null,
  p_history_cursor_id bigint default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with selected as (
    select activity.*,
      contact.value as contact,
      coalesce(labels.value, '[]'::jsonb) as labels,
      jsonb_build_object(
        'status', coalesce(review.status, 'settled'),
        'resolution', review.resolution,
        'pendingRecommendationCount', coalesce(review.pending_recommendation_count, 0),
        'reviewedBy', review.reviewed_by,
        'reviewedAt', review.reviewed_at
      ) as review
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
        'confidence', assignment.confidence,
        'reason', assignment.reason
      ) order by assignment.label_kind) as value
      from public.signal_labels assignment
      join public.labels label on label.id = assignment.label_id
      where assignment.activity_id = activity.id
        and assignment.agent_key = 'signal-triage'
    ) labels on true
    where activity.workspace_key = p_workspace_key
      and activity.id = p_activity_id
      and activity.source in ('gmail', 'quo')
  ),
  history_candidates as (
    select history.*
    from selected current
    join public.activities history on history.workspace_key = current.workspace_key
      and history.source in ('gmail', 'quo')
      and history.id <> current.id
      and (
        (
          current.external_thread_id is not null
          and history.source = current.source
          and history.account_key = current.account_key
          and history.external_thread_id = current.external_thread_id
        )
        or exists (
          select 1
          from public.activity_people current_link
          join public.activity_people history_link on history_link.person_id = current_link.person_id
          where current_link.activity_id = current.id
            and history_link.activity_id = history.id
        )
      )
    where p_history_cursor_at is null
      or history.occurred_at < p_history_cursor_at
      or (history.occurred_at = p_history_cursor_at and history.id < p_history_cursor_id)
    order by history.occurred_at desc, history.id desc
    limit least(greatest(p_history_limit, 1), 100) + 1
  ),
  history_visible as (
    select * from history_candidates
    order by occurred_at desc, id desc
    limit least(greatest(p_history_limit, 1), 100)
  ),
  history_last as (
    select * from history_visible order by occurred_at, id limit 1
  )
  select case when not exists (select 1 from selected) then null else jsonb_build_object(
    'signal', (
      select jsonb_build_object(
        'id', signal.id,
        'source', signal.source,
        'eventType', signal.event_type,
        'direction', signal.direction,
        'actorName', signal.actor_name,
        'actorEmail', signal.actor_email,
        'actorPhone', signal.actor_phone,
        'subject', signal.subject,
        'preview', signal.preview,
        'bodyText', signal.body_text,
        'occurredAt', signal.occurred_at,
        'threadId', signal.external_thread_id,
        'hasAttachments', signal.has_attachments,
        'attachmentCount', signal.attachment_count,
        'callStatus', signal.call_status,
        'durationSeconds', signal.duration_seconds,
        'isAutomated', lower(coalesce(signal.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes'),
        'contact', signal.contact,
        'labels', signal.labels,
        'review', signal.review
      ) from selected signal
    ),
    'recommendations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recommendation.id,
        'kind', recommendation.recommendation_kind,
        'label', recommendation.label,
        'reason', recommendation.reason,
        'confidence', recommendation.confidence,
        'capabilityKey', recommendation.capability_key,
        'evidence', recommendation.evidence,
        'prerequisites', recommendation.prerequisites,
        'locked', true
      ) order by recommendation.display_order)
      from public.signal_recommendations recommendation
      join selected signal on signal.id = recommendation.activity_id
      where recommendation.input_revision = signal.recommendation_revision
        and recommendation.status = 'pending'
        and not recommendation.is_shadow
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'attachmentKey', attachment.attachment_key,
        'filename', attachment.filename,
        'mimeType', attachment.mime_type,
        'status', attachment.extraction_status,
        'extractedText', attachment.extracted_text
      ) order by attachment.updated_at desc)
      from public.signal_attachment_evidence attachment
      join selected signal on signal.id = attachment.activity_id
      where attachment.agent_key = 'signal-triage'
    ), '[]'::jsonb),
    'transcript', (
      select jsonb_build_object(
        'status', transcript.status,
        'text', transcript.transcript_text,
        'dialogue', transcript.dialogue,
        'updatedAt', transcript.updated_at
      )
      from public.activity_call_transcripts transcript
      join selected signal on signal.id = transcript.activity_id
    ),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', history.id,
        'source', history.source,
        'eventType', history.event_type,
        'direction', history.direction,
        'actorName', history.actor_name,
        'actorEmail', history.actor_email,
        'actorPhone', history.actor_phone,
        'subject', history.subject,
        'preview', history.preview,
        'occurredAt', history.occurred_at,
        'hasAttachments', history.has_attachments,
        'attachmentCount', history.attachment_count
      ) order by history.occurred_at desc, history.id desc)
      from history_visible history
    ), '[]'::jsonb),
    'historyNextCursor', case
      when (select count(*) from history_candidates) > least(greatest(p_history_limit, 1), 100)
      then (select jsonb_build_object('at', occurred_at, 'id', id) from history_last)
      else null
    end
  ) end;
$$;

revoke all on function public.get_real_board_summary(text)
from public, anon, authenticated;
revoke all on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid)
from public, anon, authenticated;
revoke all on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint)
from public, anon, authenticated;
revoke all on function public.get_real_board_signal(text, bigint, integer, timestamptz, bigint)
from public, anon, authenticated;

grant execute on function public.get_real_board_summary(text) to service_role;
grant execute on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid) to service_role;
grant execute on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint) to service_role;
grant execute on function public.get_real_board_signal(text, bigint, integer, timestamptz, bigint) to service_role;

comment on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid) is
  'Server-only stable cursor feed for the fixed People column. It includes relevant Contacts, never seeded mock people.';
comment on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint) is
  'Server-only Gmail and Quo Signal feed. Slack is deliberately excluded.';
