create table public.people (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) > 0),
  primary_email text,
  primary_phone text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.person_sources (
  id bigint generated always as identity primary key,
  person_id uuid not null references public.people(id) on delete cascade,
  source_system text not null,
  source_record_type text not null,
  source_record_id text not null,
  source_hash text not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  first_synced_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  unique (source_system, source_record_type, source_record_id)
);

create table public.person_identifiers (
  id bigint generated always as identity primary key,
  person_id uuid not null references public.people(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone')),
  value text not null,
  normalized_value text not null,
  source_system text not null,
  source_record_type text not null,
  source_record_id text not null,
  is_primary boolean not null default false,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (
    person_id,
    kind,
    source_system,
    source_record_type,
    source_record_id,
    normalized_value
  )
);

create table public.person_roles (
  person_id uuid not null references public.people(id) on delete cascade,
  role_key text not null check (role_key in ('customer', 'employee', 'painter', 'applicant', 'contractor', 'supplier')),
  source_system text not null,
  source_record_type text not null,
  source_record_id text not null,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (person_id, role_key, source_system, source_record_type, source_record_id)
);

create table public.activity_people (
  activity_id bigint not null references public.activities(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  relationship text not null check (relationship in ('counterparty', 'sender', 'recipient', 'mentioned', 'customer')),
  matched_by text not null check (matched_by in ('contact_id', 'exact_email', 'manual')),
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (activity_id, person_id, relationship)
);

create table public.customer_sync_runs (
  id bigint generated always as identity primary key,
  agent_key text not null default 'customer-sync',
  status text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  counts jsonb not null default '{}'::jsonb,
  source_max_updated_at timestamptz,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index people_status_name_idx
  on public.people (status, display_name, id);

create index person_sources_person_idx
  on public.person_sources (person_id, source_system, source_record_type);

create index person_identifiers_lookup_idx
  on public.person_identifiers (kind, normalized_value, person_id)
  where active;

create index person_roles_active_idx
  on public.person_roles (role_key, person_id)
  where active;

create index activity_people_person_idx
  on public.activity_people (person_id, activity_id desc);

create index customer_sync_runs_recent_idx
  on public.customer_sync_runs (agent_key, started_at desc, id desc);

alter table public.people enable row level security;
alter table public.person_sources enable row level security;
alter table public.person_identifiers enable row level security;
alter table public.person_roles enable row level security;
alter table public.activity_people enable row level security;
alter table public.customer_sync_runs enable row level security;

revoke all on table public.people from anon, authenticated;
revoke all on table public.person_sources from anon, authenticated;
revoke all on table public.person_identifiers from anon, authenticated;
revoke all on table public.person_roles from anon, authenticated;
revoke all on table public.activity_people from anon, authenticated;
revoke all on table public.customer_sync_runs from anon, authenticated;

grant all on table public.people to service_role;
grant all on table public.person_sources to service_role;
grant all on table public.person_identifiers to service_role;
grant all on table public.person_roles to service_role;
grant all on table public.activity_people to service_role;
grant all on table public.customer_sync_runs to service_role;
grant usage, select on sequence public.person_sources_id_seq to service_role;
grant usage, select on sequence public.person_identifiers_id_seq to service_role;
grant usage, select on sequence public.customer_sync_runs_id_seq to service_role;

comment on table public.people is
  'Canonical Fluid people. Source records map through person_sources; duplicate emails or phones do not merge people automatically.';
comment on table public.person_sources is
  'Stable mapping from an external or operational source record to one canonical Fluid person.';
comment on table public.person_identifiers is
  'Email and phone identifiers. Values are intentionally not globally unique because real businesses can contain shared identifiers.';
comment on table public.person_roles is
  'A person may hold several roles at once, each supported by source evidence.';
comment on table public.activity_people is
  'Evidence-backed links between Fluid signals and people.';
comment on table public.customer_sync_runs is
  'Auditable executions of the deterministic Ottawa Painters customer sync.';

create or replace function public.fluid_customer_source_hash(source_contact public.contacts)
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

create or replace function public.sync_ottawa_painters_customers()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
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
  source_customers integer := 0;
  source_cursor timestamptz;
  failure_message text;
begin
  insert into public.customer_sync_runs (status)
  values ('running')
  returning id into run_id;

  if not pg_try_advisory_xact_lock(hashtext('fluid:customer-sync')) then
    update public.customer_sync_runs
    set status = 'skipped',
        error = 'Another customer sync already holds the database lock.',
        finished_at = now()
    where id = run_id;

    return jsonb_build_object(
      'agentKey', 'customer-sync',
      'status', 'skipped',
      'runId', run_id
    );
  end if;

  begin
    with missing as materialized (
      select
        c.*,
        gen_random_uuid() as person_id,
        public.fluid_customer_source_hash(c) as source_hash
      from public.contacts c
      left join public.person_sources source
        on source.source_system = 'ottawa-painters-admin'
       and source.source_record_type = 'contact'
       and source.source_record_id = c.id::text
      where c.kind = 'customer'
        and source.id is null
    ),
    new_people as (
      insert into public.people (
        id,
        display_name,
        primary_email,
        primary_phone,
        status,
        created_at,
        updated_at
      )
      select
        missing.person_id,
        coalesce(nullif(btrim(missing.name), ''), 'Unnamed customer'),
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
    set display_name = coalesce(nullif(btrim(contact.name), ''), 'Unnamed customer'),
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
        coalesce(nullif(btrim(contact.name), ''), 'Unnamed customer'),
        nullif(btrim(contact.email), ''),
        nullif(btrim(contact.phone), ''),
        'active'
      );
    get diagnostics updated_people = row_count;

    update public.person_sources source
    set source_hash = public.fluid_customer_source_hash(contact),
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
    where role.role_key = 'customer'
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
      'customer',
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

    with unique_customer_email as (
      select
        identifier.normalized_value,
        min(identifier.person_id::text)::uuid as person_id
      from public.person_identifiers identifier
      join public.person_roles role
        on role.person_id = identifier.person_id
       and role.role_key = 'customer'
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
      unique_customer_email.person_id,
      'counterparty',
      'exact_email',
      1
    from public.activities activity
    join unique_customer_email
      on unique_customer_email.normalized_value = lower(btrim(activity.actor_email))
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
    into source_customers, source_cursor
    from public.contacts
    where kind = 'customer';

    select count(distinct person.id)::integer
    into total_people
    from public.people person
    join public.person_roles role
      on role.person_id = person.id
     and role.role_key = 'customer'
     and role.active;

    select count(*)::integer
    into active_roles
    from public.person_roles
    where role_key = 'customer'
      and active;

    select count(*)::integer
    into active_identifiers
    from public.person_identifiers identifier
    join public.person_roles role
      on role.person_id = identifier.person_id
     and role.role_key = 'customer'
     and role.active
    where identifier.active;

    update public.customer_sync_runs
    set status = 'succeeded',
        counts = jsonb_build_object(
          'sourceCustomers', source_customers,
          'insertedPeople', inserted_people,
          'updatedPeople', updated_people,
          'activeCustomerPeople', total_people,
          'activeCustomerRoles', active_roles,
          'activeIdentifiers', active_identifiers,
          'changedActivityLinks', changed_activity_links
        ),
        source_max_updated_at = source_cursor,
        finished_at = now()
    where id = run_id;

    return jsonb_build_object(
      'agentKey', 'customer-sync',
      'status', 'succeeded',
      'runId', run_id,
      'sourceCustomers', source_customers,
      'insertedPeople', inserted_people,
      'updatedPeople', updated_people,
      'activeCustomerPeople', total_people,
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
      'agentKey', 'customer-sync',
      'status', 'failed',
      'runId', run_id,
      'error', left(failure_message, 2000)
    );
  end;
end;
$$;

create or replace function public.read_customer_sync_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  source_customers integer;
  synced_customers integer;
  pending_customers integer;
  stale_customer_roles integer;
  linked_activities integer;
  source_cursor timestamptz;
  last_run jsonb;
begin
  select count(*)::integer, max(updated_at)
  into source_customers, source_cursor
  from public.contacts
  where kind = 'customer';

  select count(*)::integer
  into synced_customers
  from public.person_roles role
  where role.role_key = 'customer'
    and role.active;

  select count(*)::integer
  into pending_customers
  from public.contacts contact
  left join public.person_sources source
    on source.source_system = 'ottawa-painters-admin'
   and source.source_record_type = 'contact'
   and source.source_record_id = contact.id::text
  where contact.kind = 'customer'
    and (
      source.id is null
      or source.source_hash is distinct from public.fluid_customer_source_hash(contact)
    );

  select count(*)::integer
  into stale_customer_roles
  from public.person_roles role
  where role.role_key = 'customer'
    and role.source_system = 'ottawa-painters-admin'
    and role.source_record_type = 'contact'
    and role.active
    and not exists (
      select 1
      from public.contacts contact
      where contact.id::text = role.source_record_id
        and contact.kind = 'customer'
    );

  select count(*)::integer
  into linked_activities
  from public.activity_people
  where relationship = 'counterparty';

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
  where run.agent_key = 'customer-sync'
  order by run.started_at desc, run.id desc
  limit 1;

  return jsonb_build_object(
    'agentKey', 'customer-sync',
    'sourceSystem', 'ottawa-painters-admin',
    'sourceCustomers', source_customers,
    'syncedCustomers', synced_customers,
    'pendingCustomers', pending_customers,
    'staleCustomerRoles', stale_customer_roles,
    'linkedActivities', linked_activities,
    'sourceMaxUpdatedAt', source_cursor,
    'needsSync', pending_customers > 0 or stale_customer_roles > 0,
    'lastRun', last_run,
    'checkedAt', now()
  );
end;
$$;

revoke all on function public.fluid_customer_source_hash(public.contacts) from public, anon, authenticated;
revoke all on function public.sync_ottawa_painters_customers() from public, anon, authenticated;
revoke all on function public.read_customer_sync_status() from public, anon, authenticated;

grant execute on function public.fluid_customer_source_hash(public.contacts) to service_role;
grant execute on function public.sync_ottawa_painters_customers() to service_role;
grant execute on function public.read_customer_sync_status() to service_role;
