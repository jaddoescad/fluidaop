-- Quo Metrics rows can repair activities whose exact customer phone was known
-- to Fluid but had not yet been projected through the identity-claim layer.
-- Only a single active canonical person is accepted; shared-number conflicts
-- and unknown callers remain deliberately unresolved.

create or replace function private.resolve_quo_metric_contact_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_person_count integer;
  v_identity_id uuid;
begin
  if new.activity_id is null or new.actor_phone is null then
    return new;
  end if;

  select count(distinct identifier.person_id), min(identifier.person_id::text)::uuid
  into v_person_count, v_person_id
  from public.person_identifiers identifier
  join public.people person
    on person.id = identifier.person_id
   and person.workspace_key = new.workspace_key
   and person.status = 'active'
  where identifier.kind = 'phone'
    and identifier.active
    and identifier.normalized_value = private.fluid_normalize_phone(new.actor_phone);

  if v_person_count <> 1 or v_person_id is null then
    return new;
  end if;

  select identity.id into v_identity_id
  from public.activity_identities activity_identity
  join public.identities identity
    on identity.id = activity_identity.identity_id
   and identity.workspace_key = new.workspace_key
   and identity.kind = 'phone'
   and identity.normalized_value = private.fluid_normalize_phone(new.actor_phone)
  where activity_identity.activity_id = new.activity_id
    and activity_identity.relationship = 'actor'
  order by identity.id
  limit 1;

  if v_identity_id is null then
    return new;
  end if;

  insert into public.person_identity_claims (
    workspace_key,
    person_id,
    identity_id,
    source_system,
    source_record_type,
    source_record_id,
    confidence,
    is_primary,
    active,
    last_seen_at,
    updated_at
  ) values (
    new.workspace_key,
    v_person_id,
    v_identity_id,
    'quo-metrics',
    'activity',
    new.event_key,
    1,
    false,
    true,
    new.occurred_at,
    now()
  )
  on conflict (
    person_id,
    identity_id,
    source_system,
    source_record_type,
    source_record_id
  ) do update set
    active = true,
    confidence = 1,
    last_seen_at = greatest(
      public.person_identity_claims.last_seen_at,
      excluded.last_seen_at
    ),
    updated_at = now();

  perform private.resolve_activity_identity(new.activity_id);
  return new;
end;
$$;

revoke all on function private.resolve_quo_metric_contact_link()
  from public, anon, authenticated;

drop trigger if exists quo_metric_evidence_resolve_contact_insert
  on public.quo_metric_activity_evidence;
create trigger quo_metric_evidence_resolve_contact_insert
after insert on public.quo_metric_activity_evidence
for each row execute function private.resolve_quo_metric_contact_link();

drop trigger if exists quo_metric_evidence_resolve_contact_update
  on public.quo_metric_activity_evidence;
create trigger quo_metric_evidence_resolve_contact_update
after update of activity_id, actor_phone on public.quo_metric_activity_evidence
for each row
when (new.activity_id is not null)
execute function private.resolve_quo_metric_contact_link();

-- Fire the safe exact-phone resolver only for currently unlinked rows that
-- have exactly one known active person. The activity_people trigger performs
-- deal-window attribution after each successful resolution.
update public.quo_metric_activity_evidence evidence
set activity_id = evidence.activity_id
where evidence.workspace_key = 'ottawa-painters'
  and evidence.activity_id is not null
  and not exists (
    select 1
    from public.activity_people link
    where link.activity_id = evidence.activity_id
      and link.relationship = 'counterparty'
  )
  and 1 = (
    select count(distinct identifier.person_id)
    from public.person_identifiers identifier
    join public.people person
      on person.id = identifier.person_id
     and person.workspace_key = evidence.workspace_key
     and person.status = 'active'
    where identifier.kind = 'phone'
      and identifier.active
      and identifier.normalized_value = private.fluid_normalize_phone(evidence.actor_phone)
  );
