-- The deployed 20260830220000 migration had to preserve history, but its
-- pg_proc/prosrc regexp rewrite is not a maintainable function definition.
-- Establish explicit lead-named implementations and leave customer-named
-- entry points as compatibility wrappers only.

create or replace function public.fluid_lead_source_hash(source_contact public.contacts)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select md5(concat_ws(
    E'\x1f',
    coalesce(source_contact.name, ''),
    coalesce(source_contact.email, ''),
    coalesce(source_contact.phone, ''),
    coalesce(source_contact.normalized_email, ''),
    coalesce(source_contact.normalized_phone, ''),
    coalesce(source_contact.metadata, '{}'::jsonb)::text,
    coalesce(source_contact.created_at::text, ''),
    coalesce(source_contact.updated_at::text, '')
  ));
$$;

create or replace function public.fluid_customer_source_hash(source_contact public.contacts)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select public.fluid_lead_source_hash(source_contact)
$$;

create or replace function private.sync_ottawa_painters_leads_without_identity_dedupe()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run_id bigint;
  inserted_people integer := 0;
  updated_people integer := 0;
  active_roles integer := 0;
  active_identifiers integer := 0;
  changed_activity_links integer := 0;
  changed_email_links integer := 0;
  total_people integer := 0;
  source_leads integer := 0;
  source_cursor timestamptz;
  failure_message text;
begin
  insert into public.customer_sync_runs (agent_key, status)
  values ('lead-sync', 'running')
  returning id into run_id;

  if not pg_try_advisory_xact_lock(hashtext('fluid:lead-sync')) then
    update public.customer_sync_runs
    set status = 'skipped',
        error = 'Another lead sync already holds the database lock.',
        finished_at = now()
    where id = run_id;

    return jsonb_build_object(
      'agentKey', 'lead-sync',
      'status', 'skipped',
      'runId', run_id
    );
  end if;

  begin
    with missing as materialized (
      select
        contact.*,
        gen_random_uuid() as person_id,
        public.fluid_lead_source_hash(contact) as source_hash
      from public.contacts contact
      left join public.person_sources source
        on source.source_system = 'ottawa-painters-admin'
       and source.source_record_type = 'contact'
       and source.source_record_id = contact.id::text
      where contact.kind = 'customer'
        and source.id is null
    ),
    new_people as (
      insert into public.people (
        id,
        workspace_key,
        display_name,
        primary_email,
        primary_phone,
        status,
        created_at,
        updated_at
      )
      select
        missing.person_id,
        'ottawa-painters',
        coalesce(nullif(btrim(missing.name), ''), 'Unnamed lead'),
        nullif(btrim(missing.email), ''),
        nullif(btrim(missing.phone), ''),
        'active',
        coalesce(missing.created_at, now()),
        now()
      from missing
      returning id
    ),
    new_sources as (
      insert into public.person_sources (
        person_id,
        source_system,
        source_record_type,
        source_record_id,
        source_hash,
        source_created_at,
        source_updated_at
      )
      select
        missing.person_id,
        'ottawa-painters-admin',
        'contact',
        missing.id::text,
        missing.source_hash,
        missing.created_at,
        missing.updated_at
      from missing
      join new_people on new_people.id = missing.person_id
      returning id
    )
    select count(*)::integer into inserted_people from new_people;

    update public.people person
    set display_name = coalesce(nullif(btrim(contact.name), ''), 'Unnamed lead'),
        primary_email = nullif(btrim(contact.email), ''),
        primary_phone = nullif(btrim(contact.phone), ''),
        status = 'active',
        updated_at = now()
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    where contact.kind = 'customer'
      and person.id = source.person_id
      and (
        person.display_name,
        person.primary_email,
        person.primary_phone,
        person.status
      ) is distinct from (
        coalesce(nullif(btrim(contact.name), ''), 'Unnamed lead'),
        nullif(btrim(contact.email), ''),
        nullif(btrim(contact.phone), ''),
        'active'
      );
    get diagnostics updated_people = row_count;

    update public.person_sources source
    set source_hash = public.fluid_lead_source_hash(contact),
        source_created_at = contact.created_at,
        source_updated_at = contact.updated_at,
        last_synced_at = now()
    from public.contacts contact
    where source.source_system = 'ottawa-painters-admin'
      and source.source_record_type = 'contact'
      and source.source_record_id = contact.id::text
      and contact.kind = 'customer';

    update public.person_roles role
    set active = false,
        last_seen_at = now()
    where role.role_key = 'lead'
      and role.source_system = 'ottawa-painters-admin'
      and role.source_record_type = 'contact'
      and role.active
      and not exists (
        select 1
        from public.contacts contact
        where contact.id::text = role.source_record_id
          and contact.kind = 'customer'
      );

    insert into public.person_roles (
      person_id,
      role_key,
      source_system,
      source_record_type,
      source_record_id,
      active,
      last_seen_at
    )
    select
      source.person_id,
      'lead',
      'ottawa-painters-admin',
      'contact',
      contact.id::text,
      true,
      now()
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    where contact.kind = 'customer'
    on conflict (person_id, role_key, source_system, source_record_type, source_record_id)
    do update set
      active = true,
      last_seen_at = excluded.last_seen_at;

    update public.person_identifiers identifier
    set active = false,
        last_seen_at = now()
    where identifier.source_system = 'ottawa-painters-admin'
      and identifier.source_record_type = 'contact'
      and identifier.active;

    insert into public.person_identifiers (
      person_id,
      kind,
      value,
      normalized_value,
      source_system,
      source_record_type,
      source_record_id,
      is_primary,
      active,
      last_seen_at
    )
    select
      source.person_id,
      'email',
      contact.email,
      contact.normalized_email,
      'ottawa-painters-admin',
      'contact',
      contact.id::text,
      true,
      true,
      now()
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    where contact.kind = 'customer'
      and nullif(btrim(contact.email), '') is not null
      and nullif(btrim(contact.normalized_email), '') is not null
    on conflict (
      person_id,
      kind,
      source_system,
      source_record_type,
      source_record_id,
      normalized_value
    )
    do update set
      value = excluded.value,
      is_primary = true,
      active = true,
      last_seen_at = excluded.last_seen_at;

    insert into public.person_identifiers (
      person_id,
      kind,
      value,
      normalized_value,
      source_system,
      source_record_type,
      source_record_id,
      is_primary,
      active,
      last_seen_at
    )
    select
      source.person_id,
      'phone',
      contact.phone,
      contact.normalized_phone,
      'ottawa-painters-admin',
      'contact',
      contact.id::text,
      true,
      true,
      now()
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    where contact.kind = 'customer'
      and nullif(btrim(contact.phone), '') is not null
      and nullif(btrim(contact.normalized_phone), '') is not null
    on conflict (
      person_id,
      kind,
      source_system,
      source_record_type,
      source_record_id,
      normalized_value
    )
    do update set
      value = excluded.value,
      is_primary = true,
      active = true,
      last_seen_at = excluded.last_seen_at;

    update public.people person
    set status = case
          when exists (
            select 1
            from public.person_roles role
            where role.person_id = person.id
              and role.active
          ) then 'active'
          else 'archived'
        end,
        updated_at = now()
    where exists (
      select 1
      from public.person_sources source
      where source.person_id = person.id
        and source.source_system = 'ottawa-painters-admin'
    )
      and person.status is distinct from case
        when exists (
          select 1
          from public.person_roles role
          where role.person_id = person.id
            and role.active
        ) then 'active'
        else 'archived'
      end;

    insert into public.activity_people (
      activity_id,
      person_id,
      relationship,
      matched_by,
      confidence
    )
    select
      activity.id,
      source.person_id,
      'counterparty',
      'contact_id',
      1
    from public.activities activity
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = activity.contact_id::text
    where activity.contact_id is not null
    on conflict (activity_id, person_id, relationship)
    do update set
      matched_by = 'contact_id',
      confidence = 1,
      updated_at = now()
    where (
      public.activity_people.matched_by,
      public.activity_people.confidence
    ) is distinct from ('contact_id', 1::numeric);
    get diagnostics changed_activity_links = row_count;

    with unique_lead_email as (
      select
        identifier.normalized_value,
        min(identifier.person_id::text)::uuid as person_id
      from public.person_identifiers identifier
      join public.person_roles role
        on role.person_id = identifier.person_id
       and role.role_key = 'lead'
       and role.active
      where identifier.kind = 'email'
        and identifier.active
        and identifier.source_system = 'ottawa-painters-admin'
      group by identifier.normalized_value
      having count(distinct identifier.person_id) = 1
    )
    insert into public.activity_people (
      activity_id,
      person_id,
      relationship,
      matched_by,
      confidence
    )
    select
      activity.id,
      unique_lead_email.person_id,
      'counterparty',
      'exact_email',
      1
    from public.activities activity
    join unique_lead_email
      on unique_lead_email.normalized_value = lower(btrim(activity.actor_email))
    where activity.contact_id is null
      and nullif(btrim(activity.actor_email), '') is not null
    on conflict (activity_id, person_id, relationship)
    do update set
      matched_by = 'exact_email',
      confidence = 1,
      updated_at = now()
    where (
      public.activity_people.matched_by,
      public.activity_people.confidence
    ) is distinct from ('exact_email', 1::numeric);
    get diagnostics changed_email_links = row_count;
    changed_activity_links := changed_activity_links + changed_email_links;

    select count(*)::integer, max(updated_at)
    into source_leads, source_cursor
    from public.contacts
    where kind = 'customer';

    select count(distinct person.id)::integer
    into total_people
    from public.people person
    join public.person_roles role
      on role.person_id = person.id
     and role.role_key = 'lead'
     and role.active
     and role.source_system = 'ottawa-painters-admin'
     and role.source_record_type = 'contact';

    select count(*)::integer
    into active_roles
    from public.person_roles
    where role_key = 'lead'
      and source_system = 'ottawa-painters-admin'
      and source_record_type = 'contact'
      and active;

    select count(*)::integer
    into active_identifiers
    from public.person_identifiers identifier
    where identifier.active
      and identifier.source_system = 'ottawa-painters-admin'
      and identifier.source_record_type = 'contact'
      and exists (
        select 1
        from public.person_roles role
        where role.person_id = identifier.person_id
          and role.role_key = 'lead'
          and role.source_system = 'ottawa-painters-admin'
          and role.source_record_type = 'contact'
          and role.active
      );

    update public.customer_sync_runs
    set status = 'succeeded',
        counts = jsonb_build_object(
          'sourceLeads', source_leads,
          'insertedPeople', inserted_people,
          'updatedPeople', updated_people,
          'activeLeadPeople', total_people,
          'activeLeadRoles', active_roles,
          'activeIdentifiers', active_identifiers,
          'changedActivityLinks', changed_activity_links
        ),
        source_max_updated_at = source_cursor,
        finished_at = now()
    where id = run_id;

    return jsonb_build_object(
      'agentKey', 'lead-sync',
      'status', 'succeeded',
      'runId', run_id,
      'sourceLeads', source_leads,
      'insertedPeople', inserted_people,
      'updatedPeople', updated_people,
      'activeLeadPeople', total_people,
      'activeLeadRoles', active_roles,
      'activeIdentifiers', active_identifiers,
      'changedActivityLinks', changed_activity_links,
      'sourceMaxUpdatedAt', source_cursor
    );
  exception when others then
    get stacked diagnostics failure_message = message_text;

    update public.customer_sync_runs
    set status = 'failed',
        error = left(failure_message, 2000),
        finished_at = now()
    where id = run_id;

    return jsonb_build_object(
      'agentKey', 'lead-sync',
      'status', 'failed',
      'runId', run_id,
      'error', left(failure_message, 2000)
    );
  end;
end;
$$;

-- Compatibility only. The executable implementation above contains no
-- pg_proc source rewriting and assigns the canonical lead role explicitly.
create or replace function private.sync_ottawa_painters_customers_without_identity_dedupe()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.sync_ottawa_painters_leads_without_identity_dedupe()
$$;

-- Consolidate the two historical duplicate-customer passes into one lead pass.
-- It moves deal ownership before deleting the duplicate, so the RESTRICT FK is
-- preserved without a preparatory function whose role filter can drift.
create or replace function private.merge_exact_duplicate_lead_people()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  duplicate record;
  loser_snapshot jsonb;
  merged_people integer := 0;
  merged_groups integer := 0;
  moved_deals integer := 0;
  moved_for_person integer := 0;
  current_group_key text;
begin
  for duplicate in
    with eligible as (
      select
        person.id,
        person.workspace_key,
        person.entity_type,
        person.display_name,
        person.created_at,
        regexp_replace(
          lower(regexp_replace(btrim(person.display_name), '\s+', ' ', 'g')),
          '[[:space:].…]+$', '', 'g'
        ) normalized_name,
        private.fluid_normalize_email(person.primary_email) normalized_email,
        private.fluid_normalize_phone(person.primary_phone) normalized_phone
      from public.people person
      where person.status = 'active'
        and private.fluid_normalize_email(person.primary_email) is not null
        and private.fluid_normalize_phone(person.primary_phone) is not null
        and exists (
          select 1
          from public.person_roles role
          where role.person_id = person.id
            and role.role_key = 'lead'
            and role.active
        )
    ),
    ranked as (
      select
        eligible.*,
        first_value(eligible.id) over (
          partition by eligible.workspace_key, eligible.entity_type,
            eligible.normalized_name, eligible.normalized_email, eligible.normalized_phone
          order by eligible.created_at, eligible.id
        ) survivor_person_id,
        row_number() over (
          partition by eligible.workspace_key, eligible.entity_type,
            eligible.normalized_name, eligible.normalized_email, eligible.normalized_phone
          order by eligible.created_at, eligible.id
        ) duplicate_rank
      from eligible
    )
    select
      ranked.id loser_person_id,
      ranked.survivor_person_id,
      ranked.workspace_key,
      pg_catalog.concat_ws(
        '|', ranked.workspace_key, ranked.entity_type, ranked.normalized_name,
        ranked.normalized_email, ranked.normalized_phone
      ) identity_key
    from ranked
    where ranked.duplicate_rank > 1
    order by identity_key, ranked.created_at, ranked.id
  loop
    if current_group_key is distinct from duplicate.identity_key then
      merged_groups := merged_groups + 1;
      current_group_key := duplicate.identity_key;
    end if;

    perform 1
    from public.people person
    where person.id in (duplicate.survivor_person_id, duplicate.loser_person_id)
    order by person.id
    for update;

    select to_jsonb(person) || jsonb_build_object(
      'sources', coalesce((
        select jsonb_agg(to_jsonb(source) order by source.id)
        from public.person_sources source
        where source.person_id = person.id
      ), '[]'::jsonb),
      'roles', coalesce((
        select jsonb_agg(to_jsonb(role) order by role.role_key, role.source_record_id)
        from public.person_roles role
        where role.person_id = person.id
      ), '[]'::jsonb),
      'identifiers', coalesce((
        select jsonb_agg(to_jsonb(identifier) order by identifier.id)
        from public.person_identifiers identifier
        where identifier.person_id = person.id
      ), '[]'::jsonb)
    )
    into loser_snapshot
    from public.people person
    where person.id = duplicate.loser_person_id;

    if loser_snapshot is null then
      continue;
    end if;

    insert into private.person_merge_audit (
      loser_person_id, survivor_person_id, workspace_key, reason,
      identity_key, loser_snapshot
    ) values (
      duplicate.loser_person_id,
      duplicate.survivor_person_id,
      duplicate.workspace_key,
      'exact-lead-name-email-phone-normalized-trailing-punctuation',
      duplicate.identity_key,
      loser_snapshot
    )
    on conflict (loser_person_id) do nothing;

    update public.person_sources
    set person_id = duplicate.survivor_person_id,
        last_synced_at = now()
    where person_id = duplicate.loser_person_id;

    update public.dripjobs_sales_deals
    set person_id = duplicate.survivor_person_id,
        person_match_method = 'manual',
        person_linked_at = now()
    where person_id = duplicate.loser_person_id;
    get diagnostics moved_for_person = row_count;
    moved_deals := moved_deals + moved_for_person;

    insert into public.person_identifiers (
      person_id, kind, value, normalized_value, source_system,
      source_record_type, source_record_id, is_primary, active,
      first_seen_at, last_seen_at
    )
    select
      duplicate.survivor_person_id, identifier.kind, identifier.value,
      identifier.normalized_value, identifier.source_system,
      identifier.source_record_type, identifier.source_record_id,
      identifier.is_primary, identifier.active,
      identifier.first_seen_at, identifier.last_seen_at
    from public.person_identifiers identifier
    where identifier.person_id = duplicate.loser_person_id
    on conflict (
      person_id, kind, source_system, source_record_type,
      source_record_id, normalized_value
    ) do update set
      value = excluded.value,
      is_primary = public.person_identifiers.is_primary or excluded.is_primary,
      active = public.person_identifiers.active or excluded.active,
      first_seen_at = least(public.person_identifiers.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.person_identifiers.last_seen_at, excluded.last_seen_at);

    delete from public.person_identifiers
    where person_id = duplicate.loser_person_id;

    insert into public.person_roles (
      person_id, role_key, source_system, source_record_type, source_record_id,
      active, first_seen_at, last_seen_at
    )
    select
      duplicate.survivor_person_id, role.role_key, role.source_system,
      role.source_record_type, role.source_record_id, role.active,
      role.first_seen_at, role.last_seen_at
    from public.person_roles role
    where role.person_id = duplicate.loser_person_id
    on conflict (
      person_id, role_key, source_system, source_record_type, source_record_id
    ) do update set
      active = public.person_roles.active or excluded.active,
      first_seen_at = least(public.person_roles.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.person_roles.last_seen_at, excluded.last_seen_at);

    delete from public.person_roles
    where person_id = duplicate.loser_person_id;

    insert into public.person_identity_claims (
      workspace_key, person_id, identity_id, source_system, source_record_type,
      source_record_id, confidence, is_primary, active, first_seen_at,
      last_seen_at, created_at, updated_at
    )
    select
      claim.workspace_key, duplicate.survivor_person_id, claim.identity_id,
      claim.source_system, claim.source_record_type, claim.source_record_id,
      claim.confidence, claim.is_primary, claim.active, claim.first_seen_at,
      claim.last_seen_at, claim.created_at, now()
    from public.person_identity_claims claim
    where claim.person_id = duplicate.loser_person_id
    on conflict (
      person_id, identity_id, source_system, source_record_type, source_record_id
    ) do update set
      confidence = greatest(public.person_identity_claims.confidence, excluded.confidence),
      is_primary = public.person_identity_claims.is_primary or excluded.is_primary,
      active = public.person_identity_claims.active or excluded.active,
      first_seen_at = least(public.person_identity_claims.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
      updated_at = now();

    delete from public.person_identity_claims
    where person_id = duplicate.loser_person_id;

    insert into public.activity_people (
      activity_id, person_id, relationship, matched_by, confidence,
      created_at, updated_at
    )
    select
      link.activity_id, duplicate.survivor_person_id, link.relationship,
      link.matched_by, link.confidence, link.created_at, now()
    from public.activity_people link
    where link.person_id = duplicate.loser_person_id
    on conflict (activity_id, person_id, relationship) do update set
      matched_by = case
        when public.activity_people.confidence >= excluded.confidence
          then public.activity_people.matched_by
        else excluded.matched_by
      end,
      confidence = greatest(public.activity_people.confidence, excluded.confidence),
      created_at = least(public.activity_people.created_at, excluded.created_at),
      updated_at = now();

    delete from public.activity_people
    where person_id = duplicate.loser_person_id;

    update public.action_instances
    set person_id = duplicate.survivor_person_id,
        updated_at = now()
    where person_id = duplicate.loser_person_id;

    update public.contact_suggestions
    set resolved_person_id = duplicate.survivor_person_id,
        updated_at = now()
    where resolved_person_id = duplicate.loser_person_id;

    update public.operational_cases
    set person_id = duplicate.survivor_person_id,
        updated_at = now()
    where person_id = duplicate.loser_person_id;

    update public.signal_triage_decisions
    set person_id = duplicate.survivor_person_id
    where person_id = duplicate.loser_person_id;

    update public.people
    set updated_at = now()
    where id = duplicate.survivor_person_id;

    delete from public.people
    where id = duplicate.loser_person_id;

    merged_people := merged_people + 1;
  end loop;

  return jsonb_build_object(
    'mergedGroups', merged_groups,
    'mergedPeople', merged_people,
    'movedDeals', moved_deals
  );
end;
$$;

create or replace function private.merge_exact_duplicate_customer_people()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.merge_exact_duplicate_lead_people()
$$;

create or replace function private.merge_duplicate_crm_contacts()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.merge_exact_duplicate_lead_people()
$$;

create or replace function private.reconcile_lead_identity_graph()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.reconcile_customer_identity_graph()
$$;

create or replace function private.read_lead_sync_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sourceLeads', (
      select count(*)::integer
      from public.contacts contact
      where contact.kind = 'customer'
    ),
    'sourceMaxUpdatedAt', (
      select max(contact.updated_at)
      from public.contacts contact
      where contact.kind = 'customer'
    ),
    'syncedLeads', (
      select count(distinct role.person_id)::integer
      from public.person_roles role
      where role.role_key = 'lead'
        and role.source_system = 'ottawa-painters-admin'
        and role.source_record_type = 'contact'
        and role.active
    ),
    'pendingLeads', (
      select count(*)::integer
      from public.contacts contact
      left join public.person_sources source
        on source.source_system = 'ottawa-painters-admin'
       and source.source_record_type = 'contact'
       and source.source_record_id = contact.id::text
      where contact.kind = 'customer'
        and (
          source.id is null
          or source.source_hash is distinct from public.fluid_lead_source_hash(contact)
          or not exists (
            select 1
            from public.person_roles role
            where role.person_id = source.person_id
              and role.role_key = 'lead'
              and role.source_system = 'ottawa-painters-admin'
              and role.source_record_type = 'contact'
              and role.source_record_id = contact.id::text
              and role.active
          )
        )
    ),
    'staleLeadRoles', (
      select count(*)::integer
      from public.person_roles role
      where role.role_key = 'lead'
        and role.source_system = 'ottawa-painters-admin'
        and role.source_record_type = 'contact'
        and role.active
        and not exists (
          select 1
          from public.contacts contact
          where contact.id::text = role.source_record_id
            and contact.kind = 'customer'
        )
    )
  )
$$;

create or replace function public.sync_ottawa_painters_leads()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sync_result jsonb;
  merge_result jsonb;
  identity_seed_result jsonb;
  reconciliation_result jsonb;
  status_result jsonb;
begin
  sync_result := private.sync_ottawa_painters_leads_without_identity_dedupe();

  if sync_result->>'status' <> 'succeeded' then
    return sync_result;
  end if;

  merge_result := private.merge_exact_duplicate_lead_people();
  identity_seed_result := private.ensure_person_identifier_identities('ottawa-painters');
  reconciliation_result := private.reconcile_lead_identity_graph();
  status_result := private.read_lead_sync_counts();

  return sync_result || jsonb_build_object(
    'identityDeduplication', merge_result,
    'identitySeeding', identity_seed_result,
    'identityReconciliation', reconciliation_result,
    'syncedLeads', status_result -> 'syncedLeads',
    'pendingLeads', status_result -> 'pendingLeads',
    'staleLeadRoles', status_result -> 'staleLeadRoles'
  );
end;
$$;

create or replace function public.sync_ottawa_painters_customers()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.sync_ottawa_painters_leads()
$$;

-- The preceding vocabulary migration removes the old customer-role rows.
-- Reconstruct the equivalent lead-role evidence from the durable source map
-- so status is correct before the first scheduled sync runs.
insert into public.person_roles (
  person_id,
  role_key,
  source_system,
  source_record_type,
  source_record_id,
  active,
  last_seen_at
)
select
  source.person_id,
  'lead',
  'ottawa-painters-admin',
  'contact',
  contact.id::text,
  true,
  now()
from public.contacts contact
join public.person_sources source
  on source.source_system = 'ottawa-painters-admin'
 and source.source_record_type = 'contact'
 and source.source_record_id = contact.id::text
where contact.kind = 'customer'
on conflict (person_id, role_key, source_system, source_record_type, source_record_id)
do update set
  active = true,
  last_seen_at = excluded.last_seen_at;

create or replace function public.read_lead_sync_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_leads integer;
  synced_leads integer;
  pending_leads integer;
  stale_lead_roles integer;
  linked_activities integer;
  source_cursor timestamptz;
  last_run jsonb;
  identity_health jsonb;
  sync_counts jsonb;
begin
  sync_counts := private.read_lead_sync_counts();
  source_leads := coalesce((sync_counts ->> 'sourceLeads')::integer, 0);
  source_cursor := (sync_counts ->> 'sourceMaxUpdatedAt')::timestamptz;
  synced_leads := coalesce((sync_counts ->> 'syncedLeads')::integer, 0);
  pending_leads := coalesce((sync_counts ->> 'pendingLeads')::integer, 0);
  stale_lead_roles := coalesce((sync_counts ->> 'staleLeadRoles')::integer, 0);

  select count(*)::integer
  into linked_activities
  from public.activity_people
  where relationship = 'counterparty';

  identity_health := private.read_identity_resolution_health('ottawa-painters');

  select jsonb_build_object(
    'id', run.id,
    'status', run.status,
    'counts', run.counts,
    'error', run.error,
    'startedAt', run.started_at,
    'finishedAt', run.finished_at
  )
  into last_run
  from public.customer_sync_runs run
  where run.agent_key in ('lead-sync', 'customer-sync')
  order by run.started_at desc, run.id desc
  limit 1;

  return jsonb_build_object(
    'agentKey', 'lead-sync',
    'sourceSystem', 'ottawa-painters-admin',
    'sourceLeads', source_leads,
    'syncedLeads', synced_leads,
    'pendingLeads', pending_leads,
    'staleLeadRoles', stale_lead_roles,
    'linkedActivities', linked_activities,
    'sourceMaxUpdatedAt', source_cursor,
    'identityHealth', identity_health,
    'needsSync',
      pending_leads > 0
      or stale_lead_roles > 0
      or coalesce((identity_health->>'driftCount')::integer, 0) > 0,
    'lastRun', last_run,
    'checkedAt', now()
  );
end;
$$;

create or replace function public.read_customer_sync_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.read_lead_sync_status()
$$;

-- Restore the single supported v1 Action. The three unused placeholder
-- definitions remain retired, and no historical recommendation/instance rows
-- are recreated.
insert into public.action_definitions (
  workspace_key,
  key,
  name,
  description,
  handler_key,
  enabled,
  execution_mode,
  requires_confirmation,
  configuration,
  version,
  built_in
) values (
  'ottawa-painters',
  'draft-email-to-customer',
  'Draft email to customer',
  'Draft a reply to a current inbound Gmail message for review. Sending remains a simulation.',
  'draft-email-reply',
  true,
  'simulation',
  true,
  jsonb_build_object('tone', 'clear, warm, and concise', 'signatureMode', 'none'),
  1,
  true
)
on conflict (workspace_key, key) do update
set version = public.action_definitions.version + 1,
    name = excluded.name,
    description = excluded.description,
    handler_key = excluded.handler_key,
    enabled = excluded.enabled,
    execution_mode = excluded.execution_mode,
    requires_confirmation = excluded.requires_confirmation,
    configuration = excluded.configuration,
    built_in = excluded.built_in,
    updated_at = now()
where (
  public.action_definitions.name,
  public.action_definitions.description,
  public.action_definitions.handler_key,
  public.action_definitions.enabled,
  public.action_definitions.execution_mode,
  public.action_definitions.requires_confirmation,
  public.action_definitions.configuration,
  public.action_definitions.built_in
) is distinct from (
  excluded.name,
  excluded.description,
  excluded.handler_key,
  excluded.enabled,
  excluded.execution_mode,
  excluded.requires_confirmation,
  excluded.configuration,
  excluded.built_in
);

comment on table public.customer_sync_runs is
  'Legacy-named audit ledger for deterministic Ottawa Painters lead sync runs.';
comment on function public.sync_ottawa_painters_leads() is
  'Synchronizes source lead contacts, merges proven duplicates, seeds identities, and reconciles activity links.';
comment on function public.sync_ottawa_painters_customers() is
  'Deprecated compatibility wrapper for sync_ottawa_painters_leads().';
comment on function public.read_lead_sync_status() is
  'Returns canonical lead-sync status and identity drift health.';
comment on function public.read_customer_sync_status() is
  'Deprecated compatibility wrapper for read_lead_sync_status().';
comment on function private.read_lead_sync_counts() is
  'Canonical source-mapped lead counts shared by the sync response and status RPC.';

revoke all on function public.fluid_lead_source_hash(public.contacts)
  from public, anon, authenticated;
revoke all on function public.fluid_customer_source_hash(public.contacts)
  from public, anon, authenticated;
revoke all on function private.sync_ottawa_painters_leads_without_identity_dedupe()
  from public, anon, authenticated;
revoke all on function private.sync_ottawa_painters_customers_without_identity_dedupe()
  from public, anon, authenticated;
revoke all on function private.merge_exact_duplicate_lead_people()
  from public, anon, authenticated;
revoke all on function private.merge_exact_duplicate_customer_people()
  from public, anon, authenticated;
revoke all on function private.merge_duplicate_crm_contacts()
  from public, anon, authenticated;
revoke all on function private.reconcile_lead_identity_graph()
  from public, anon, authenticated;
revoke all on function private.read_lead_sync_counts()
  from public, anon, authenticated;
revoke all on function public.sync_ottawa_painters_leads()
  from public, anon, authenticated;
revoke all on function public.sync_ottawa_painters_customers()
  from public, anon, authenticated;
revoke all on function public.read_lead_sync_status()
  from public, anon, authenticated;
revoke all on function public.read_customer_sync_status()
  from public, anon, authenticated;

grant execute on function public.fluid_lead_source_hash(public.contacts) to service_role;
grant execute on function public.fluid_customer_source_hash(public.contacts) to service_role;
grant execute on function private.sync_ottawa_painters_leads_without_identity_dedupe() to service_role;
grant execute on function private.sync_ottawa_painters_customers_without_identity_dedupe() to service_role;
grant execute on function private.merge_exact_duplicate_lead_people() to service_role;
grant execute on function private.merge_exact_duplicate_customer_people() to service_role;
grant execute on function private.merge_duplicate_crm_contacts() to service_role;
grant execute on function private.reconcile_lead_identity_graph() to service_role;
grant execute on function private.read_lead_sync_counts() to service_role;
grant execute on function public.sync_ottawa_painters_leads() to service_role;
grant execute on function public.sync_ottawa_painters_customers() to service_role;
grant execute on function public.read_lead_sync_status() to service_role;
grant execute on function public.read_customer_sync_status() to service_role;
