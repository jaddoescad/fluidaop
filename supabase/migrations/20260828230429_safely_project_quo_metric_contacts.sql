-- Metrics evidence already identifies the external actor phone deterministically.
-- Project that evidence directly only when the phone belongs to exactly one
-- active canonical person and the activity has no existing counterparty.
-- Existing contact/deal links remain authoritative and shared phones are never
-- guessed.

create or replace function private.resolve_quo_metric_contact_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_person_count integer;
begin
  if new.activity_id is null or new.actor_phone is null then
    return new;
  end if;

  if exists (
    select 1
    from public.activity_people link
    where link.activity_id = new.activity_id
      and link.relationship = 'counterparty'
  ) then
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

  insert into public.activity_people (
    activity_id,
    person_id,
    relationship,
    matched_by,
    confidence,
    updated_at
  ) values (
    new.activity_id,
    v_person_id,
    'counterparty',
    'exact_phone',
    1,
    now()
  )
  on conflict (activity_id, person_id, relationship) do update
  set matched_by = 'exact_phone',
      confidence = 1,
      updated_at = now();

  return new;
end;
$$;

revoke all on function private.resolve_quo_metric_contact_link()
  from public, anon, authenticated;

-- Re-run the trigger only for the remaining rows that have one safe match.
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
