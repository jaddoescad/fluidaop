-- Settlement is a state transition from pending review, not an unconditional
-- overwrite. In particular, an open Action must remain action_open until the
-- Action lifecycle itself closes it.
create or replace function public.settle_signal_recommendations(
  p_workspace_key text,
  p_activity_id bigint,
  p_resolution text,
  p_reviewer text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_activity public.activities%rowtype;
  v_state public.signal_review_states%rowtype;
  v_state_found boolean;
  v_dismissed integer := 0;
  v_now timestamptz := now();
begin
  if p_resolution <> 'no_action' then
    raise exception 'invalid signal resolution';
  end if;
  if p_reviewer is null or char_length(btrim(p_reviewer)) not between 1 and 200 then
    raise exception 'invalid reviewer';
  end if;

  select * into v_activity
  from public.activities
  where id = p_activity_id
    and workspace_key = p_workspace_key
  for update;
  if not found then
    raise exception 'signal was not found';
  end if;

  select * into v_state
  from public.signal_review_states
  where activity_id = p_activity_id
  for update;
  v_state_found := found;

  -- accept_signal_action_recommendation takes the same activity lock first,
  -- so this check and the review-state transition are serialized with Action
  -- creation. Keep the data check even when review state has drifted.
  if exists (
    select 1
    from public.action_instances action
    where action.workspace_key = p_workspace_key
      and action.source_activity_id = p_activity_id
      and action.status not in ('completed_external', 'dismissed')
  ) then
    raise exception 'signal has an open Action and cannot be settled';
  end if;

  if v_state_found
    and v_state.status = 'settled'
    and v_state.resolution = 'no_action'
    and v_state.input_revision = v_activity.recommendation_revision
  then
    return jsonb_build_object(
      'activityId', p_activity_id,
      'status', 'settled',
      'resolution', 'no_action',
      'dismissed', 0,
      'idempotent', true
    );
  end if;

  if not v_state_found
    or v_state.input_revision <> v_activity.recommendation_revision
    or v_state.status <> 'pending'
  then
    raise exception 'signal is not pending review';
  end if;

  update public.signal_recommendations
  set status = 'dismissed',
      dismissed_at = v_now,
      updated_at = v_now
  where workspace_key = p_workspace_key
    and activity_id = p_activity_id
    and input_revision = v_activity.recommendation_revision
    and status = 'pending'
    and not is_shadow;
  get diagnostics v_dismissed = row_count;

  update public.signal_review_states
  set status = 'settled',
      resolution = 'no_action',
      pending_recommendation_count = 0,
      reviewed_by = left(btrim(p_reviewer), 200),
      reviewed_at = v_now,
      updated_at = v_now
  where activity_id = p_activity_id
    and input_revision = v_activity.recommendation_revision
    and status = 'pending';

  if not found then
    raise exception 'signal review state changed concurrently';
  end if;

  return jsonb_build_object(
    'activityId', p_activity_id,
    'status', 'settled',
    'resolution', 'no_action',
    'dismissed', v_dismissed,
    'idempotent', false
  );
end;
$$;

comment on function public.settle_signal_recommendations(text, bigint, text, text) is
  'Settles only the current pending review; refuses to overwrite action_open or another terminal state.';

-- Definition versions describe material behavior/configuration changes. A
-- no-op Save must not invalidate every pending recommendation.
create or replace function private.enforce_action_definition_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if row(
    new.id,
    new.workspace_key,
    new.key,
    new.name,
    new.description,
    new.handler_key,
    new.enabled,
    new.execution_mode,
    new.requires_confirmation,
    new.configuration,
    new.built_in
  ) is not distinct from row(
    old.id,
    old.workspace_key,
    old.key,
    old.name,
    old.description,
    old.handler_key,
    old.enabled,
    old.execution_mode,
    old.requires_confirmation,
    old.configuration,
    old.built_in
  ) then
    new.version := old.version;
    new.updated_at := old.updated_at;
  else
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists action_definitions_enforce_material_version
  on public.action_definitions;
create trigger action_definitions_enforce_material_version
before update on public.action_definitions
for each row execute function private.enforce_action_definition_version();

comment on function private.enforce_action_definition_version() is
  'Preserves version and updated_at for no-op writes; increments exactly once for material Action-definition changes.';

-- Preserve the mature detail query and decorate only its recommendation
-- contract. The public signature remains stable for the Edge API.
alter function public.get_real_board_signal(
  text, bigint, integer, timestamptz, bigint
) rename to get_real_board_signal_without_action_availability;

alter function public.get_real_board_signal_without_action_availability(
  text, bigint, integer, timestamptz, bigint
) set schema private;

create function public.get_real_board_signal(
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
  with base as materialized (
    select private.get_real_board_signal_without_action_availability(
      p_workspace_key,
      p_activity_id,
      p_history_limit,
      p_history_cursor_at,
      p_history_cursor_id
    ) as payload
  ), recommendation_items as (
    select item.value, item.ordinality
    from base
    cross join lateral jsonb_array_elements(
      coalesce(base.payload -> 'recommendations', '[]'::jsonb)
    ) with ordinality as item(value, ordinality)
  ), resolved as (
    select
      item.value,
      item.ordinality,
      recommendation.action_definition_version as stored_version,
      definition.key as definition_key,
      definition.version as current_version,
      case
        when recommendation.id is null then 'recommendation_missing'
        when recommendation.status <> 'pending'
          or recommendation.is_shadow
          or recommendation.input_revision <> activity.recommendation_revision
          then 'recommendation_not_current'
        when definition.id is null then 'definition_missing'
        when not definition.enabled then 'definition_disabled'
        when definition.handler_key <> 'draft-email-reply' then 'handler_unavailable'
        when definition.version <> recommendation.action_definition_version then 'definition_version_changed'
        else null
      end as unavailable_reason
    from recommendation_items item
    left join public.signal_recommendations recommendation
      on recommendation.id = (item.value ->> 'id')::uuid
     and recommendation.workspace_key = p_workspace_key
     and recommendation.activity_id = p_activity_id
    left join public.activities activity
      on activity.id = recommendation.activity_id
     and activity.workspace_key = recommendation.workspace_key
    left join public.action_definitions definition
      on definition.id = recommendation.action_definition_id
     and definition.workspace_key = recommendation.workspace_key
  ), decorated as (
    select
      resolved.value || jsonb_build_object(
        'actionDefinitionKey', resolved.definition_key,
        'actionDefinitionVersion', resolved.stored_version,
        'currentActionDefinitionVersion', resolved.current_version,
        'available', resolved.unavailable_reason is null,
        'locked', resolved.unavailable_reason is not null,
        'unavailableReason', resolved.unavailable_reason
      ) as value,
      resolved.ordinality
    from resolved
  )
  select case
    when base.payload is null then null
    else jsonb_set(
      base.payload,
      '{recommendations}',
      coalesce(
        (select jsonb_agg(decorated.value order by decorated.ordinality) from decorated),
        '[]'::jsonb
      ),
      true
    )
  end
  from base
$$;

comment on function private.get_real_board_signal_without_action_availability(
  text, bigint, integer, timestamptz, bigint
) is 'Internal base Signal detail query; the public wrapper adds current Action-definition availability.';
comment on function public.get_real_board_signal(
  text, bigint, integer, timestamptz, bigint
) is 'Returns Signal detail with Action availability gated by enabled handler and exact stored/current definition version.';

revoke all on function public.settle_signal_recommendations(text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function private.enforce_action_definition_version()
  from public, anon, authenticated;
revoke all on function private.get_real_board_signal_without_action_availability(
  text, bigint, integer, timestamptz, bigint
) from public, anon, authenticated;
revoke all on function public.get_real_board_signal(
  text, bigint, integer, timestamptz, bigint
) from public, anon, authenticated;

grant execute on function public.settle_signal_recommendations(text, bigint, text, text)
  to service_role;
grant execute on function private.get_real_board_signal_without_action_availability(
  text, bigint, integer, timestamptz, bigint
) to service_role;
grant execute on function public.get_real_board_signal(
  text, bigint, integer, timestamptz, bigint
) to service_role;
