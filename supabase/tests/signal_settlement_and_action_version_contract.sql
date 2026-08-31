begin;

do $$
declare
  definition_id uuid;
  definition_version integer;
  current_definition_version integer;
  definition_updated_at timestamptz;
  noop_updated_at timestamptz;
  version_activity_id bigint;
  version_recommendation_id uuid := gen_random_uuid();
  action_activity_id bigint;
  action_recommendation_id uuid := gen_random_uuid();
  action_instance_id uuid := gen_random_uuid();
  detail jsonb;
  recommendation jsonb;
  settlement jsonb;
  blocked boolean := false;
begin
  select definition.id, definition.version, definition.updated_at
  into strict definition_id, definition_version, definition_updated_at
  from public.action_definitions definition
  where definition.workspace_key = 'ottawa-painters'
    and definition.key = 'draft-email-to-customer'
    and definition.enabled;

  update public.action_definitions
  set name = name,
      description = description,
      enabled = enabled,
      configuration = configuration,
      version = version + 1,
      updated_at = now()
  where id = definition_id
  returning version, updated_at
  into current_definition_version, noop_updated_at;

  if current_definition_version <> definition_version
     or noop_updated_at is distinct from definition_updated_at then
    raise exception 'no-op Action definition write changed its version or timestamp';
  end if;

  insert into public.activities (
    workspace_key,
    source,
    account_email,
    external_id,
    external_thread_id,
    event_type,
    direction,
    actor_name,
    actor_email,
    from_email,
    subject,
    preview,
    body_text,
    occurred_at
  ) values (
    'ottawa-painters',
    'gmail',
    'signal-contract@fluid.invalid',
    'signal-version-contract',
    'signal-version-contract-thread',
    'email.received',
    'inbound',
    'Version Contract Lead',
    'version-contract@example.invalid',
    'version-contract@example.invalid',
    'Version contract',
    'Please send a reply.',
    'Please send a reply.',
    now()
  ) returning id into version_activity_id;

  insert into public.signal_recommendations (
    id,
    workspace_key,
    activity_id,
    input_revision,
    recommendation_kind,
    intent_key,
    label,
    reason,
    confidence,
    capability_key,
    fingerprint,
    display_order,
    is_shadow,
    action_definition_id,
    action_definition_version
  ) values (
    version_recommendation_id,
    'ottawa-painters',
    version_activity_id,
    1,
    'action',
    'reply',
    'Draft reply',
    'A current inbound email is eligible for a reply draft.',
    1,
    'draft-email-to-customer',
    repeat('a', 64),
    1,
    false,
    definition_id,
    definition_version
  );

  update public.signal_review_states
  set pending_recommendation_count = 1,
      updated_at = now()
  where activity_id = version_activity_id;

  detail := public.get_real_board_signal(
    'ottawa-painters', version_activity_id, 1, null, null
  );
  recommendation := detail -> 'recommendations' -> 0;

  if recommendation->>'id' <> version_recommendation_id::text
     or not (recommendation->>'available')::boolean
     or (recommendation->>'locked')::boolean
     or (recommendation->>'actionDefinitionVersion')::integer <> definition_version
     or (recommendation->>'currentActionDefinitionVersion')::integer <> definition_version then
    raise exception 'current Action definition was not presented as available: %', recommendation;
  end if;

  update public.action_definitions
  set description = description || ' Contract version change.',
      version = version + 1,
      updated_at = now()
  where id = definition_id
  returning version into current_definition_version;

  if current_definition_version <> definition_version + 1 then
    raise exception 'material Action definition change did not increment exactly once';
  end if;

  detail := public.get_real_board_signal(
    'ottawa-painters', version_activity_id, 1, null, null
  );
  recommendation := detail -> 'recommendations' -> 0;

  if (recommendation->>'available')::boolean
     or not (recommendation->>'locked')::boolean
     or recommendation->>'unavailableReason' <> 'definition_version_changed'
     or (recommendation->>'actionDefinitionVersion')::integer <> definition_version
     or (recommendation->>'currentActionDefinitionVersion')::integer <> current_definition_version then
    raise exception 'version-drift recommendation remained actionable: %', recommendation;
  end if;

  settlement := public.settle_signal_recommendations(
    'ottawa-painters', version_activity_id, 'no_action', 'contract-test'
  );
  if settlement->>'status' <> 'settled'
     or (settlement->>'idempotent')::boolean then
    raise exception 'pending Signal did not settle normally: %', settlement;
  end if;

  settlement := public.settle_signal_recommendations(
    'ottawa-painters', version_activity_id, 'no_action', 'contract-test'
  );
  if not (settlement->>'idempotent')::boolean then
    raise exception 'repeated no-action settlement was not idempotent: %', settlement;
  end if;

  insert into public.activities (
    workspace_key,
    source,
    account_email,
    external_id,
    external_thread_id,
    event_type,
    direction,
    actor_name,
    actor_email,
    from_email,
    subject,
    preview,
    body_text,
    occurred_at
  ) values (
    'ottawa-painters',
    'gmail',
    'signal-contract@fluid.invalid',
    'signal-action-open-contract',
    'signal-action-open-contract-thread',
    'email.received',
    'inbound',
    'Open Action Lead',
    'open-action@example.invalid',
    'open-action@example.invalid',
    'Open Action contract',
    'Keep this Action open.',
    'Keep this Action open.',
    now()
  ) returning id into action_activity_id;

  insert into public.signal_recommendations (
    id,
    workspace_key,
    activity_id,
    input_revision,
    recommendation_kind,
    intent_key,
    label,
    reason,
    confidence,
    capability_key,
    fingerprint,
    display_order,
    status,
    is_shadow,
    action_definition_id,
    action_definition_version,
    accepted_at
  ) values (
    action_recommendation_id,
    'ottawa-painters',
    action_activity_id,
    1,
    'action',
    'reply',
    'Draft reply',
    'This recommendation already owns an open Action.',
    1,
    'draft-email-to-customer',
    repeat('b', 64),
    1,
    'accepted',
    false,
    definition_id,
    current_definition_version,
    now()
  );

  insert into public.action_instances (
    id,
    workspace_key,
    action_definition_id,
    action_definition_version,
    recommendation_id,
    source_activity_id,
    source_revision,
    status,
    execution_mode,
    title,
    reason,
    recipient_email,
    subject,
    created_by
  ) values (
    action_instance_id,
    'ottawa-painters',
    definition_id,
    current_definition_version,
    action_recommendation_id,
    action_activity_id,
    1,
    'drafting',
    'simulation',
    'Draft reply',
    'This Action must remain open.',
    'open-action@example.invalid',
    'Re: Open Action contract',
    'contract-test'
  );

  update public.signal_review_states
  set status = 'action_open',
      resolution = 'action_created',
      pending_recommendation_count = 0,
      reviewed_by = 'contract-test',
      reviewed_at = now(),
      updated_at = now()
  where activity_id = action_activity_id;

  begin
    perform public.settle_signal_recommendations(
      'ottawa-painters', action_activity_id, 'no_action', 'contract-test'
    );
  exception when others then
    if sqlerrm <> 'signal has an open Action and cannot be settled' then
      raise;
    end if;
    blocked := true;
  end;

  if not blocked then
    raise exception 'action_open Signal was incorrectly settled';
  end if;

  if not exists (
    select 1
    from public.signal_review_states
    where activity_id = action_activity_id
      and status = 'action_open'
      and resolution = 'action_created'
  ) or not exists (
    select 1
    from public.action_instances
    where id = action_instance_id
      and status = 'drafting'
  ) then
    raise exception 'failed settlement mutated the open Action contract';
  end if;
end;
$$;

rollback;
