begin;

do $$
declare
  workspace constant text := 'identity-resolution-test';
  contact_first_person uuid := gen_random_uuid();
  signal_first_person uuid := gen_random_uuid();
  shared_person_a uuid := gen_random_uuid();
  shared_person_b uuid := gen_random_uuid();
  contact_first_activity bigint;
  signal_first_activity bigint;
  shared_activity bigint;
  resolution jsonb;
  health jsonb;
begin
  -- Contact first, Signal later: the activity resolver must create the
  -- canonical identity, discover the existing person identifier, and link in
  -- the same transaction despite different phone formatting.
  insert into public.people (
    id, workspace_key, display_name, primary_phone, status
  ) values (
    contact_first_person,
    workspace,
    'Identity Contact First',
    '(613) 555-9001',
    'active'
  );

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values (
    contact_first_person,
    'phone',
    '(613) 555-9001',
    '6135559001',
    'identity-test',
    'contact',
    'contact-first',
    true,
    true
  );

  insert into public.activities (
    workspace_key, source, account_phone, external_id, event_type,
    direction, actor_phone, subject, preview, occurred_at
  ) values (
    workspace,
    'quo',
    '+16135559999',
    'identity-contact-first',
    'message.received',
    'inbound',
    '+16135559001',
    'Text message',
    'Contact-first ordering test',
    '2026-08-27T18:00:00Z'
  ) returning id into contact_first_activity;

  if not exists (
    select 1
    from public.activity_people link
    where link.activity_id = contact_first_activity
      and link.person_id = contact_first_person
      and link.relationship = 'counterparty'
      and link.matched_by = 'exact_identity'
  ) then
    raise exception 'contact-first Signal was not linked immediately';
  end if;

  if private.activity_identity_resolution(contact_first_activity) is not null then
    raise exception 'resolved contact-first Signal still reports identity drift';
  end if;

  -- Signal first, Contact later: lead reconciliation must create any
  -- missing canonical identity/claim and replay the already-stored Signal.
  insert into public.activities (
    workspace_key, source, account_phone, external_id, event_type,
    direction, actor_phone, subject, preview, occurred_at
  ) values (
    workspace,
    'quo',
    '+16135559999',
    'identity-signal-first',
    'message.received',
    'inbound',
    '+16135559002',
    'Text message',
    'Signal-first ordering test',
    '2026-08-27T18:01:00Z'
  ) returning id into signal_first_activity;

  resolution := private.activity_identity_resolution(signal_first_activity);
  if resolution->>'status' <> 'unresolved' then
    raise exception 'unclaimed Signal did not report unresolved identity: %', resolution;
  end if;

  insert into public.people (
    id, workspace_key, display_name, primary_phone, status
  ) values (
    signal_first_person,
    workspace,
    'Identity Signal First',
    '6135559002',
    'active'
  );

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values (
    signal_first_person,
    'phone',
    '6135559002',
    '6135559002',
    'identity-test',
    'contact',
    'signal-first',
    true,
    true
  );

  perform private.ensure_person_identifier_identities(workspace);
  perform private.reconcile_lead_identity_graph();

  if not exists (
    select 1
    from public.activity_people link
    where link.activity_id = signal_first_activity
      and link.person_id = signal_first_person
      and link.relationship = 'counterparty'
      and link.matched_by = 'exact_identity'
  ) then
    raise exception 'signal-first Signal was not linked by reconciliation';
  end if;

  -- Shared identifiers remain explicit conflicts; deterministic resolution
  -- must never choose either person by row order.
  insert into public.people (
    id, workspace_key, display_name, primary_phone, status
  ) values
    (shared_person_a, workspace, 'Identity Shared A', '6135559003', 'active'),
    (shared_person_b, workspace, 'Identity Shared B', '(613) 555-9003', 'active');

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values
    (
      shared_person_a, 'phone', '6135559003', '6135559003',
      'identity-test', 'contact', 'shared-a', true, true
    ),
    (
      shared_person_b, 'phone', '(613) 555-9003', '6135559003',
      'identity-test', 'contact', 'shared-b', true, true
    );

  insert into public.activities (
    workspace_key, source, account_phone, external_id, event_type,
    direction, actor_phone, subject, preview, occurred_at
  ) values (
    workspace,
    'quo',
    '+16135559999',
    'identity-shared-phone',
    'message.received',
    'inbound',
    '+16135559003',
    'Text message',
    'Shared phone conflict test',
    '2026-08-27T18:02:00Z'
  ) returning id into shared_activity;

  if exists (
    select 1
    from public.activity_people link
    where link.activity_id = shared_activity
      and link.relationship = 'counterparty'
  ) then
    raise exception 'shared phone was resolved to an arbitrary Contact';
  end if;

  resolution := private.activity_identity_resolution(shared_activity);
  if resolution->>'status' <> 'conflict' then
    raise exception 'shared phone did not report an identity conflict: %', resolution;
  end if;

  health := private.read_identity_resolution_health(workspace);
  if (health->>'driftCount')::integer <> 0 then
    raise exception 'identity invariants still report drift after reconciliation: %', health;
  end if;
end;
$$;

rollback;
