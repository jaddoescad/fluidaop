-- Preserve raw provider content while making body_text the canonical current
-- message used by Fluid and Hermes.
alter table public.activities
  add column raw_body_text text,
  add column quoted_text text,
  add column signature_text text,
  add column has_quoted_content boolean not null default false,
  add column content_parser_version text,
  add column content_parse_method text,
  add column content_parse_confidence numeric(5,4),
  add column content_parsed_at timestamptz;

alter table public.activities
  add constraint activities_content_parser_version_check
    check (content_parser_version is null or char_length(content_parser_version) between 1 and 100),
  add constraint activities_content_parse_method_check
    check (content_parse_method is null or char_length(content_parse_method) between 1 and 100),
  add constraint activities_content_parse_confidence_check
    check (content_parse_confidence is null or content_parse_confidence between 0 and 1);

comment on column public.activities.body_text is
  'Canonical current message text used by Fluid and agents. Quoted history and signatures are excluded when parsing is available.';
comment on column public.activities.raw_body_text is
  'Bounded immutable provider body retained server-side for audit and parser upgrades.';
comment on column public.activities.quoted_text is
  'Quoted reply content separated by the versioned ingestion parser; collapsed by default in user interfaces.';

-- A pending Signal may legitimately have zero recommendations. Hermes proposes
-- work; it never decides that a human does not need to review the Signal.
alter table public.signal_review_states
  alter column status set default 'pending',
  drop constraint signal_review_states_resolution_check,
  drop constraint signal_review_states_consistency_check;

alter table public.signal_review_states
  add constraint signal_review_states_resolution_check
    check (resolution is null or resolution in (
      'no_action', 'none_required', 'shadow_only', 'action_created', 'performed_external'
    )),
  add constraint signal_review_states_consistency_check
    check (
      (status = 'pending' and resolution is null and reviewed_at is null)
      or
      (status = 'action_open' and resolution = 'action_created' and pending_recommendation_count = 0 and reviewed_at is not null)
      or
      (status = 'settled' and resolution is not null and pending_recommendation_count = 0 and reviewed_at is not null)
    );

create or replace function private.enforce_human_signal_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
begin
  -- Legacy recommender paths use none_required/shadow_only to auto-settle.
  -- Convert those writes to pending unless a real outbound provider event
  -- proves that a person performed the reply.
  if new.status = 'settled' and new.resolution in ('none_required', 'shadow_only') then
    select * into v_activity from public.activities where id = new.activity_id;
    if found and (
      v_activity.direction = 'outbound'
      or private.signal_has_later_outbound(v_activity.id)
    ) then
      new.resolution := 'performed_external';
      new.pending_recommendation_count := 0;
      new.reviewed_by := coalesce(new.reviewed_by, 'provider:outbound');
      new.reviewed_at := coalesce(new.reviewed_at, now());
    else
      new.status := 'pending';
      new.resolution := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists signal_review_states_require_human_decision
  on public.signal_review_states;
create trigger signal_review_states_require_human_decision
before insert or update of status, resolution, pending_recommendation_count,
  reviewed_by, reviewed_at
on public.signal_review_states
for each row execute function private.enforce_human_signal_review();

create or replace function private.ensure_signal_review_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_performed boolean;
begin
  if new.source not in ('gmail', 'quo') then return new; end if;
  v_performed := new.direction = 'outbound'
    or private.signal_has_later_outbound(new.id);

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    new.workspace_key, new.id, new.recommendation_revision,
    case when v_performed then 'settled' else 'pending' end,
    case when v_performed then 'performed_external' else null end,
    0,
    case when v_performed then 'provider:outbound' else null end,
    case when v_performed then now() else null end,
    now()
  ) on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = excluded.status,
      resolution = excluded.resolution,
      pending_recommendation_count = excluded.pending_recommendation_count,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at
  where coalesce(public.signal_review_states.resolution, '') not in ('no_action', 'action_created')
    and (
      public.signal_review_states.input_revision <> excluded.input_revision
      or (
        public.signal_review_states.status = 'settled'
        and public.signal_review_states.resolution in ('none_required', 'shadow_only')
      )
    );
  return new;
end;
$$;

drop trigger if exists activities_ensure_signal_review_state on public.activities;
create trigger activities_ensure_signal_review_state
after insert or update of recommendation_revision, direction, source, workspace_key
on public.activities
for each row execute function private.ensure_signal_review_state();

-- Give every historical Signal an explicit review state. For the current
-- operational window, real later outbound evidence counts as performed.
-- Older inbound history is conservatively left pending rather than guessed.
-- Explicit human dismissals and accepted Actions remain untouched below.
with activity_review as materialized (
  select activity.*,
    case
      when activity.direction = 'outbound' then true
      when activity.occurred_at >= now() - interval '30 days'
        then private.signal_has_later_outbound(activity.id)
      else false
    end as performed
  from public.activities activity
  where activity.workspace_key = 'ottawa-painters'
    and activity.source in ('gmail', 'quo')
)
insert into public.signal_review_states (
  workspace_key, activity_id, input_revision, status, resolution,
  pending_recommendation_count, reviewed_by, reviewed_at, updated_at
)
select
  activity.workspace_key,
  activity.id,
  activity.recommendation_revision,
  case when activity.performed then 'settled' else 'pending' end,
  case when activity.performed then 'performed_external' else null end,
  coalesce(recommendations.pending_count, 0),
  case when activity.performed then 'provider:outbound' else null end,
  case when activity.performed then now() else null end,
  now()
from activity_review activity
left join lateral (
  select count(*)::smallint as pending_count
  from public.signal_recommendations recommendation
  where recommendation.activity_id = activity.id
    and recommendation.input_revision = activity.recommendation_revision
    and recommendation.status = 'pending'
    and not recommendation.is_shadow
) recommendations on true
on conflict (activity_id) do update
set workspace_key = excluded.workspace_key,
    input_revision = excluded.input_revision,
    status = excluded.status,
    resolution = excluded.resolution,
    pending_recommendation_count = excluded.pending_recommendation_count,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    updated_at = excluded.updated_at
where coalesce(public.signal_review_states.resolution, '') not in ('no_action', 'action_created')
  and (
    public.signal_review_states.input_revision <> excluded.input_revision
    or (
      public.signal_review_states.status = 'settled'
      and public.signal_review_states.resolution in ('none_required', 'shadow_only')
    )
  );

-- People attention is driven by unresolved Signals, not by whether Hermes
-- happened to produce a recommendation.
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

-- Keep the existing action-open priority, but include every pending Signal in
-- needs-you even when Hermes returned zero recommendations.
create or replace function public.list_real_board_signals(
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
      case when review.status = 'action_open'
        then coalesce(review.updated_at, activity.occurred_at)
        else activity.occurred_at end as board_sort_at
    from public.activities activity
    left join public.signal_review_states review
      on review.activity_id = activity.id
      and review.input_revision = activity.recommendation_revision
    left join lateral (
      select jsonb_build_object(
        'id', person.id, 'displayName', person.display_name,
        'primaryEmail', person.primary_email, 'primaryPhone', person.primary_phone
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
        'kind', assignment.label_kind, 'key', label.key,
        'name', label.name, 'color', label.color, 'confidence', assignment.confidence
      ) order by assignment.label_kind) as value
      from public.signal_labels assignment
      join public.labels label on label.id = assignment.label_id
      where assignment.activity_id = activity.id and assignment.agent_key = 'signal-triage'
    ) labels on true
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and (p_contact_id is null or exists (
        select 1 from public.activity_people selected_link
        where selected_link.activity_id = activity.id and selected_link.person_id = p_contact_id
      ))
  ),
  candidates as (
    select * from enriched
    where (p_view = 'all' or (
      p_view = 'needs_you' and (action_open or review_status = 'pending')
    ))
      and (
        p_cursor_at is null
        or (case when action_open then 1 else 0 end) <
          (case when coalesce(p_cursor_action_open, false) then 1 else 0 end)
        or (action_open = coalesce(p_cursor_action_open, false) and board_sort_at < p_cursor_at)
        or (action_open = coalesce(p_cursor_action_open, false) and board_sort_at = p_cursor_at and id < p_cursor_id)
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
    select * from visible order by action_open, board_sort_at, id limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id, 'source', item.source, 'eventType', item.event_type,
        'direction', item.direction, 'actorName', item.actor_name,
        'actorEmail', item.actor_email, 'actorPhone', item.actor_phone,
        'subject', item.subject, 'preview', item.preview,
        'occurredAt', item.occurred_at, 'threadId', item.external_thread_id,
        'hasAttachments', item.has_attachments, 'attachmentCount', item.attachment_count,
        'isAutomated', lower(coalesce(item.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes'),
        'contact', item.contact, 'labels', item.labels,
        'actionOpen', item.action_open, 'boardSortAt', item.board_sort_at,
        'review', jsonb_build_object(
          'status', item.review_status, 'resolution', item.review_resolution,
          'pendingRecommendationCount', item.pending_recommendation_count,
          'updatedAt', item.review_updated_at
        )
      ) order by item.action_open desc, item.board_sort_at desc, item.id desc)
      from visible item
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from candidates) > least(greatest(p_limit, 1), 100)
      then (select jsonb_build_object('actionOpen', action_open, 'at', board_sort_at, 'id', id) from last_row)
      else null end
  );
$$;

revoke all on function private.enforce_human_signal_review()
  from public, anon, authenticated;
revoke all on function private.ensure_signal_review_state()
  from public, anon, authenticated;
grant execute on function private.enforce_human_signal_review(), private.ensure_signal_review_state()
  to service_role;

revoke all on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.list_real_board_people(text, integer, boolean, timestamptz, uuid)
  to service_role;

revoke all on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.list_real_board_signals(text, uuid, text, integer, timestamptz, bigint, boolean)
  to service_role;
