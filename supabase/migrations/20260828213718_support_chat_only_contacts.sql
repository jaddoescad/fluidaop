-- DripJobs Chat contains Contacts that may not have a mirrored sales deal.
-- Preserve those people as canonical Fluid Contacts without inventing a deal.
create or replace function public.ensure_dripjobs_chat_contact(
  p_workspace_key text,
  p_dripjobs_contact_id text,
  p_customer_name text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_first_seen_at timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_person_id uuid;
  v_identity_id uuid;
  v_name text := nullif(btrim(p_customer_name), '');
  v_email text := nullif(btrim(coalesce(p_customer_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_customer_phone, '')), '');
  v_normalized_email text;
  v_normalized_phone text;
  v_seen_at timestamptz := coalesce(p_first_seen_at, now());
begin
  if p_workspace_key is null
     or p_workspace_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or p_dripjobs_contact_id is null
     or char_length(p_dripjobs_contact_id) not between 1 and 200
     or v_name is null
     or char_length(v_name) > 500
     or (v_email is not null and char_length(v_email) > 1000)
     or (v_phone is not null and char_length(v_phone) > 200) then
    raise exception 'Invalid DripJobs chat Contact';
  end if;

  v_normalized_email := private.fluid_normalize_email(v_email);
  v_normalized_phone := private.fluid_normalize_phone(v_phone);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'dripjobs-contact:' || p_workspace_key || ':contact:' || p_dripjobs_contact_id,
      0
    )
  );

  select source.person_id into v_person_id
  from public.person_sources source
  join public.people person
    on person.id = source.person_id
   and person.workspace_key = p_workspace_key
   and person.status = 'active'
  where source.source_system = 'dripjobs'
    and source.source_record_type = 'contact'
    and source.source_record_id = p_dripjobs_contact_id
  limit 1;

  -- Reuse Ottawa Painters' canonical Contact only when its own provider id is
  -- exact. Email and phone alone are not safe merge keys.
  if v_person_id is null then
    select source.person_id into v_person_id
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    join public.people person
      on person.id = source.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
    where contact.dripjobs_contact_id = p_dripjobs_contact_id
    limit 1;
  end if;

  if v_person_id is null then
    insert into public.people (
      workspace_key,
      display_name,
      primary_email,
      primary_phone,
      entity_type,
      status,
      created_at,
      updated_at
    ) values (
      p_workspace_key,
      v_name,
      v_email,
      v_phone,
      'person',
      'active',
      v_seen_at,
      now()
    ) returning id into v_person_id;
  end if;

  insert into public.person_sources (
    person_id,
    source_system,
    source_record_type,
    source_record_id,
    source_hash,
    source_created_at,
    source_updated_at,
    first_synced_at,
    last_synced_at
  ) values (
    v_person_id,
    'dripjobs',
    'contact',
    p_dripjobs_contact_id,
    pg_catalog.encode(extensions.digest(
      pg_catalog.concat_ws('|', p_dripjobs_contact_id, v_name, v_email, v_phone),
      'sha256'
    ), 'hex'),
    v_seen_at,
    v_seen_at,
    now(),
    now()
  )
  on conflict (source_system, source_record_type, source_record_id) do update
  set source_hash = excluded.source_hash,
      source_updated_at = greatest(public.person_sources.source_updated_at, excluded.source_updated_at),
      last_synced_at = now();

  select source.person_id into v_person_id
  from public.person_sources source
  where source.source_system = 'dripjobs'
    and source.source_record_type = 'contact'
    and source.source_record_id = p_dripjobs_contact_id;

  update public.people person
  set display_name = case
        when person.display_name ~* '^DripJobs contact ' then v_name
        else person.display_name
      end,
      primary_email = coalesce(person.primary_email, v_email),
      primary_phone = coalesce(person.primary_phone, v_phone),
      updated_at = now()
  where person.id = v_person_id;

  insert into public.person_roles (
    person_id, role_key, source_system, source_record_type, source_record_id,
    active, first_seen_at, last_seen_at
  ) values (
    v_person_id, 'lead', 'dripjobs', 'contact', p_dripjobs_contact_id,
    true, v_seen_at, v_seen_at
  )
  on conflict (person_id, role_key, source_system, source_record_type, source_record_id)
  do update
  set active = true,
      first_seen_at = least(public.person_roles.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.person_roles.last_seen_at, excluded.last_seen_at);

  if v_normalized_email is not null then
    insert into public.person_identifiers (
      person_id, kind, value, normalized_value, source_system,
      source_record_type, source_record_id, is_primary, active,
      first_seen_at, last_seen_at
    ) values (
      v_person_id, 'email', coalesce(v_email, v_normalized_email),
      v_normalized_email, 'dripjobs', 'contact', p_dripjobs_contact_id,
      true, true, v_seen_at, v_seen_at
    )
    on conflict (
      person_id, kind, source_system, source_record_type, source_record_id, normalized_value
    ) do update
    set value = excluded.value,
        is_primary = true,
        active = true,
        first_seen_at = least(public.person_identifiers.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(public.person_identifiers.last_seen_at, excluded.last_seen_at);

    insert into public.identities (
      workspace_key, kind, normalized_value, display_value, display_name,
      classification, first_seen_at, last_seen_at, updated_at
    ) values (
      p_workspace_key, 'email', v_normalized_email,
      coalesce(v_email, v_normalized_email), v_name, 'unknown',
      v_seen_at, v_seen_at, now()
    )
    on conflict (workspace_key, kind, normalized_value) do update
    set display_value = coalesce(public.identities.display_value, excluded.display_value),
        display_name = coalesce(public.identities.display_name, excluded.display_name),
        first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
        updated_at = now()
    returning id into v_identity_id;

    insert into public.person_identity_claims (
      workspace_key, person_id, identity_id, source_system, source_record_type,
      source_record_id, confidence, is_primary, active, first_seen_at,
      last_seen_at, updated_at
    ) values (
      p_workspace_key, v_person_id, v_identity_id, 'dripjobs', 'contact',
      p_dripjobs_contact_id, 1, true, true, v_seen_at, v_seen_at, now()
    )
    on conflict (
      person_id, identity_id, source_system, source_record_type, source_record_id
    ) do update
    set active = true,
        confidence = 1,
        is_primary = true,
        first_seen_at = least(public.person_identity_claims.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
        updated_at = now();
  end if;

  if v_normalized_phone is not null then
    insert into public.person_identifiers (
      person_id, kind, value, normalized_value, source_system,
      source_record_type, source_record_id, is_primary, active,
      first_seen_at, last_seen_at
    ) values (
      v_person_id, 'phone', coalesce(v_phone, v_normalized_phone),
      v_normalized_phone, 'dripjobs', 'contact', p_dripjobs_contact_id,
      true, true, v_seen_at, v_seen_at
    )
    on conflict (
      person_id, kind, source_system, source_record_type, source_record_id, normalized_value
    ) do update
    set value = excluded.value,
        is_primary = true,
        active = true,
        first_seen_at = least(public.person_identifiers.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(public.person_identifiers.last_seen_at, excluded.last_seen_at);

    insert into public.identities (
      workspace_key, kind, normalized_value, display_value, display_name,
      classification, first_seen_at, last_seen_at, updated_at
    ) values (
      p_workspace_key, 'phone', v_normalized_phone,
      coalesce(v_phone, v_normalized_phone), v_name, 'unknown',
      v_seen_at, v_seen_at, now()
    )
    on conflict (workspace_key, kind, normalized_value) do update
    set display_value = coalesce(public.identities.display_value, excluded.display_value),
        display_name = coalesce(public.identities.display_name, excluded.display_name),
        first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
        updated_at = now()
    returning id into v_identity_id;

    insert into public.person_identity_claims (
      workspace_key, person_id, identity_id, source_system, source_record_type,
      source_record_id, confidence, is_primary, active, first_seen_at,
      last_seen_at, updated_at
    ) values (
      p_workspace_key, v_person_id, v_identity_id, 'dripjobs', 'contact',
      p_dripjobs_contact_id, 1, true, true, v_seen_at, v_seen_at, now()
    )
    on conflict (
      person_id, identity_id, source_system, source_record_type, source_record_id
    ) do update
    set active = true,
        confidence = 1,
        is_primary = true,
        first_seen_at = least(public.person_identity_claims.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
        updated_at = now();
  end if;

  return v_person_id;
end;
$$;

revoke all on function public.ensure_dripjobs_chat_contact(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ensure_dripjobs_chat_contact(text, text, text, text, text, timestamptz)
  to service_role;

comment on function public.ensure_dripjobs_chat_contact(text, text, text, text, text, timestamptz) is
  'Creates or reuses the canonical Fluid Contact for an exact DripJobs chat Contact id without inventing a sales deal.';

-- Teach the existing chat importer to resolve either a mirrored deal Contact
-- or a Contact created from the DripJobs chat directory.
do $$
declare
  v_function_definition text;
  v_old text := $old$
  select
    min(deal.person_id::text)::uuid,
    count(distinct deal.person_id),
    count(distinct deal.deal_id),
    case when count(distinct deal.deal_id) = 1 then min(deal.deal_id) end
  into v_person_id, v_person_count, v_deal_count, v_only_deal_id
  from public.dripjobs_sales_deals deal
  join public.people person
    on person.id = deal.person_id
   and person.workspace_key = p_workspace_key
   and person.status = 'active'
  where deal.dripjobs_contact_id = p_dripjobs_contact_id;
$old$;
  v_new text := $new$
  select
    min(resolved.person_id::text)::uuid,
    count(distinct resolved.person_id),
    count(distinct resolved.deal_id),
    case when count(distinct resolved.deal_id) = 1 then min(resolved.deal_id) end
  into v_person_id, v_person_count, v_deal_count, v_only_deal_id
  from (
    select deal.person_id, deal.deal_id
    from public.dripjobs_sales_deals deal
    where deal.dripjobs_contact_id = p_dripjobs_contact_id
    union all
    select source.person_id, null::text as deal_id
    from public.person_sources source
    where source.source_system = 'dripjobs'
      and source.source_record_type = 'contact'
      and source.source_record_id = p_dripjobs_contact_id
  ) resolved
  join public.people person
    on person.id = resolved.person_id
   and person.workspace_key = p_workspace_key
   and person.status = 'active';
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.ingest_dripjobs_contact_chat_messages(text,text,text,text,jsonb)'::regprocedure
  ) into v_function_definition;

  if pg_catalog.strpos(v_function_definition, v_old) = 0 then
    raise exception 'Could not locate the DripJobs chat Contact resolver';
  end if;

  v_function_definition := pg_catalog.replace(v_function_definition, v_old, v_new);
  execute v_function_definition;
end;
$$;

revoke all on function public.ingest_dripjobs_contact_chat_messages(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_dripjobs_contact_chat_messages(text, text, text, text, jsonb)
  to service_role;
