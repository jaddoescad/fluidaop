-- Persist the canonical Contact for every DripJobs deal. The CRM used to
-- recompute this relationship from email/phone claims every time the board
-- loaded, which made a valid deal non-interactive whenever its Contact mirror
-- had not synced yet. Source mirrors remain source mirrors; public.people is
-- the canonical Contact directory.

alter table public.dripjobs_sales_deals
  add column person_id uuid,
  add column person_match_method text,
  add column person_linked_at timestamptz;

alter table public.dripjobs_sales_deals
  add constraint dripjobs_sales_deals_person_id_fkey
  foreign key (person_id) references public.people(id) on delete restrict,
  add constraint dripjobs_sales_deals_person_match_method_check
  check (person_match_method in (
    'dripjobs_source',
    'source_contact',
    'source_lead',
    'exact_identity',
    'created_from_deal',
    'manual'
  ));

create index dripjobs_sales_deals_person_pipeline_idx
  on public.dripjobs_sales_deals (person_id, archived_at, deal_stage, stage_entered_at desc);

comment on column public.dripjobs_sales_deals.person_id is
  'Required canonical Fluid Contact. One Contact may own many DripJobs deals.';
comment on column public.dripjobs_sales_deals.person_match_method is
  'Auditable evidence used to attach this deal to its canonical Contact.';

create or replace function private.attach_dripjobs_deal_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_key text := 'ottawa-painters';
  v_person_id uuid;
  v_match_method text;
  v_candidate_count integer := 0;
  v_source_record_type text;
  v_source_record_id text;
  v_normalized_email text;
  v_normalized_phone text;
  v_identity_id uuid;
  v_seen_at timestamptz := coalesce(new.last_seen_at, new.captured_at, now());
begin
  if tg_op = 'UPDATE' then
    if new.dripjobs_contact_id is distinct from old.dripjobs_contact_id
      or new.lead_id is distinct from old.lead_id then
      new.person_id := null;
      new.person_match_method := null;
    end if;
  end if;

  v_source_record_type := case
    when nullif(btrim(coalesce(new.dripjobs_contact_id, '')), '') is null then 'deal'
    else 'contact'
  end;
  v_source_record_id := coalesce(
    nullif(btrim(coalesce(new.dripjobs_contact_id, '')), ''),
    new.deal_id
  );
  v_normalized_email := private.fluid_normalize_email(
    coalesce(new.normalized_email, new.email)
  );
  v_normalized_phone := private.fluid_normalize_phone(
    coalesce(new.normalized_phone, new.phone)
  );

  -- A stable source id must never race into two canonical Contacts.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'dripjobs-contact:' || v_workspace_key || ':' || v_source_record_type || ':' || v_source_record_id,
      0
    )
  );

  -- Preserve an explicit/manual assignment while it still points at an active
  -- Contact in the same workspace.
  if new.person_id is not null then
    select person.id into v_person_id
    from public.people person
    where person.id = new.person_id
      and person.workspace_key = v_workspace_key
      and person.status = 'active';
    if v_person_id is not null then
      v_match_method := coalesce(new.person_match_method, 'manual');
    end if;
  end if;

  -- First preference: a prior DripJobs source mapping. This makes every later
  -- deal for the same DripJobs Contact deterministic.
  if v_person_id is null then
    select source.person_id into v_person_id
    from public.person_sources source
    join public.people person
      on person.id = source.person_id
     and person.workspace_key = v_workspace_key
     and person.status = 'active'
    where source.source_system = 'dripjobs'
      and source.source_record_type = v_source_record_type
      and source.source_record_id = v_source_record_id
    limit 1;
    if v_person_id is not null then v_match_method := 'dripjobs_source'; end if;
  end if;

  -- Existing Fluid mirrors provide stronger evidence than an email/phone
  -- guess. contacts.dripjobs_contact_id is unique.
  if v_person_id is null and new.dripjobs_contact_id is not null then
    select source.person_id into v_person_id
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    join public.people person
      on person.id = source.person_id
     and person.workspace_key = v_workspace_key
     and person.status = 'active'
    where contact.dripjobs_contact_id = new.dripjobs_contact_id
    limit 1;
    if v_person_id is not null then v_match_method := 'source_contact'; end if;
  end if;

  if v_person_id is null and new.lead_id is not null then
    select source.person_id into v_person_id
    from public.leads lead
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = lead.contact_id::text
    join public.people person
      on person.id = source.person_id
     and person.workspace_key = v_workspace_key
     and person.status = 'active'
    where lead.id = new.lead_id
    limit 1;
    if v_person_id is not null then v_match_method := 'source_lead'; end if;
  end if;

  -- Exact identities are useful evidence but are not globally unique in the
  -- real world. Only accept the single strongest candidate; shared household
  -- or business identifiers never get guessed.
  if v_person_id is null and (v_normalized_email is not null or v_normalized_phone is not null) then
    with matches as (
      select
        claim.person_id,
        count(distinct identity.kind)::integer as strength,
        case when regexp_replace(lower(btrim(person.display_name)), '[[:space:].…]+$', '', 'g')
          = regexp_replace(lower(btrim(new.customer_name)), '[[:space:].…]+$', '', 'g')
          then 1 else 0 end as name_strength
      from public.identities identity
      join public.person_identity_claims claim
        on claim.identity_id = identity.id
       and claim.active
      join public.people person
        on person.id = claim.person_id
       and person.workspace_key = v_workspace_key
       and person.status = 'active'
      where identity.workspace_key = v_workspace_key
        and not identity.ignored
        and identity.classification <> 'system'
        and (
          (identity.kind = 'email' and identity.normalized_value = v_normalized_email)
          or (identity.kind = 'phone' and identity.normalized_value = v_normalized_phone)
        )
      group by claim.person_id, person.display_name
    ), strongest as (
      select match.*
      from matches match
      where match.strength = (select max(candidate.strength) from matches candidate)
    ), best_named as (
      select match.*
      from strongest match
      where match.name_strength = (select max(candidate.name_strength) from strongest candidate)
    )
    select count(*), min(person_id::text)::uuid
    into v_candidate_count, v_person_id
    from best_named;

    if v_candidate_count = 1 then
      v_match_method := 'exact_identity';
    else
      v_person_id := null;
    end if;
  end if;

  -- A DripJobs Contact is legitimate source evidence by itself. Creating a
  -- canonical Contact is safer than merging two people because they share a
  -- phone or inbox.
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
      v_workspace_key,
      btrim(new.customer_name),
      nullif(btrim(coalesce(new.email, '')), ''),
      nullif(btrim(coalesce(new.phone, '')), ''),
      'person',
      'active',
      coalesce(new.first_seen_at, now()),
      now()
    ) returning id into v_person_id;
    v_match_method := 'created_from_deal';
  end if;

  -- Persist stable source evidence so the next deal for this Contact never
  -- needs identity inference.
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
    v_source_record_type,
    v_source_record_id,
    pg_catalog.encode(extensions.digest(
      pg_catalog.concat_ws('|', new.customer_name, new.email, new.phone, new.deal_id),
      'sha256'
    ), 'hex'),
    new.first_seen_at,
    new.last_seen_at,
    now(),
    now()
  )
  on conflict (source_system, source_record_type, source_record_id) do update
  set source_hash = excluded.source_hash,
      source_updated_at = excluded.source_updated_at,
      last_synced_at = now();

  -- The conflict target above is intentionally immutable. Re-read it in case
  -- a pre-existing source mapping won the advisory-locked lookup.
  select source.person_id into v_person_id
  from public.person_sources source
  where source.source_system = 'dripjobs'
    and source.source_record_type = v_source_record_type
    and source.source_record_id = v_source_record_id;

  update public.people person
  set primary_email = coalesce(person.primary_email, nullif(btrim(coalesce(new.email, '')), '')),
      primary_phone = coalesce(person.primary_phone, nullif(btrim(coalesce(new.phone, '')), '')),
      updated_at = now()
  where person.id = v_person_id
    and (
      (person.primary_email is null and nullif(btrim(coalesce(new.email, '')), '') is not null)
      or (person.primary_phone is null and nullif(btrim(coalesce(new.phone, '')), '') is not null)
    );

  if v_normalized_email is not null then
    insert into public.person_identifiers (
      person_id, kind, value, normalized_value, source_system,
      source_record_type, source_record_id, is_primary, active,
      first_seen_at, last_seen_at
    ) values (
      v_person_id, 'email', coalesce(nullif(btrim(new.email), ''), v_normalized_email),
      v_normalized_email, 'dripjobs', v_source_record_type, v_source_record_id,
      true, true, coalesce(new.first_seen_at, v_seen_at), v_seen_at
    )
    on conflict (
      person_id, kind, source_system, source_record_type, source_record_id, normalized_value
    ) do update
    set value = excluded.value,
        is_primary = true,
        active = true,
        last_seen_at = greatest(public.person_identifiers.last_seen_at, excluded.last_seen_at);

    insert into public.identities (
      workspace_key, kind, normalized_value, display_value, display_name,
      classification, first_seen_at, last_seen_at, updated_at
    ) values (
      v_workspace_key, 'email', v_normalized_email,
      coalesce(nullif(btrim(new.email), ''), v_normalized_email),
      btrim(new.customer_name), 'unknown', coalesce(new.first_seen_at, v_seen_at), v_seen_at, now()
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
      v_workspace_key, v_person_id, v_identity_id, 'dripjobs', v_source_record_type,
      v_source_record_id, 1, true, true, coalesce(new.first_seen_at, v_seen_at),
      v_seen_at, now()
    )
    on conflict (
      person_id, identity_id, source_system, source_record_type, source_record_id
    ) do update
    set active = true,
        confidence = 1,
        is_primary = true,
        last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
        updated_at = now();
  end if;

  if v_normalized_phone is not null then
    insert into public.person_identifiers (
      person_id, kind, value, normalized_value, source_system,
      source_record_type, source_record_id, is_primary, active,
      first_seen_at, last_seen_at
    ) values (
      v_person_id, 'phone', coalesce(nullif(btrim(new.phone), ''), v_normalized_phone),
      v_normalized_phone, 'dripjobs', v_source_record_type, v_source_record_id,
      true, true, coalesce(new.first_seen_at, v_seen_at), v_seen_at
    )
    on conflict (
      person_id, kind, source_system, source_record_type, source_record_id, normalized_value
    ) do update
    set value = excluded.value,
        is_primary = true,
        active = true,
        last_seen_at = greatest(public.person_identifiers.last_seen_at, excluded.last_seen_at);

    insert into public.identities (
      workspace_key, kind, normalized_value, display_value, display_name,
      classification, first_seen_at, last_seen_at, updated_at
    ) values (
      v_workspace_key, 'phone', v_normalized_phone,
      coalesce(nullif(btrim(new.phone), ''), v_normalized_phone),
      btrim(new.customer_name), 'unknown', coalesce(new.first_seen_at, v_seen_at), v_seen_at, now()
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
      v_workspace_key, v_person_id, v_identity_id, 'dripjobs', v_source_record_type,
      v_source_record_id, 1, true, true, coalesce(new.first_seen_at, v_seen_at),
      v_seen_at, now()
    )
    on conflict (
      person_id, identity_id, source_system, source_record_type, source_record_id
    ) do update
    set active = true,
        confidence = 1,
        is_primary = true,
        last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
        updated_at = now();
  end if;

  insert into public.person_roles (
    person_id, role_key, source_system, source_record_type, source_record_id,
    active, first_seen_at, last_seen_at
  ) values (
    v_person_id, 'lead', 'dripjobs', 'deal', new.deal_id,
    true, coalesce(new.first_seen_at, v_seen_at), v_seen_at
  )
  on conflict (person_id, role_key, source_system, source_record_type, source_record_id)
  do update
  set active = true,
      last_seen_at = greatest(public.person_roles.last_seen_at, excluded.last_seen_at);

  new.person_id := v_person_id;
  new.person_match_method := coalesce(v_match_method, 'dripjobs_source');
  new.person_linked_at := now();
  return new;
end;
$$;

revoke all on function private.attach_dripjobs_deal_contact()
  from public, anon, authenticated;
grant execute on function private.attach_dripjobs_deal_contact()
  to service_role;

create trigger dripjobs_sales_deals_attach_contact
before insert or update of
  person_id,
  dripjobs_contact_id,
  lead_id,
  customer_name,
  email,
  phone,
  normalized_email,
  normalized_phone
on public.dripjobs_sales_deals
for each row execute function private.attach_dripjobs_deal_contact();

-- Trigger the deterministic resolver for every historical deal. This also
-- creates the missing Alberto Contact and stable DripJobs source mapping.
update public.dripjobs_sales_deals
set person_id = person_id;

do $$
begin
  if exists (select 1 from public.dripjobs_sales_deals where person_id is null) then
    raise exception 'Every DripJobs deal must resolve to a canonical Contact';
  end if;
end;
$$;

alter table public.dripjobs_sales_deals
  alter column person_id set not null,
  alter column person_match_method set not null,
  alter column person_linked_at set not null;

-- The pipeline now consumes the persisted foreign key. No email/phone guess is
-- allowed in the read model, and a non-clickable deal is no longer a valid API
-- state.
create or replace function public.list_current_dripjobs_pipeline(
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with latest_success as (
    select run.captured_at, run.finished_at
    from public.dripjobs_pipeline_sync_runs run
    where run.workspace_key = p_workspace_key
      and run.status = 'succeeded'
    order by run.captured_at desc, run.finished_at desc nulls last
    limit 1
  ),
  legacy_snapshot as (
    select deal.source_document_id, max(deal.captured_at) as captured_at
    from public.dripjobs_sales_deals deal
    where deal.source_view = 'active'
    group by deal.source_document_id
    order by max(deal.captured_at) desc, deal.source_document_id desc
    limit 1
  ),
  current_deals as (
    select deal.*
    from public.dripjobs_sales_deals deal
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
    where deal.archived_at is null
      and (
        deal.last_active_snapshot_at = (select captured_at from latest_success)
        or (
          not exists (select 1 from latest_success)
          and deal.source_document_id = (select source_document_id from legacy_snapshot)
        )
      )
  ),
  sync_state as (
    select
      success.captured_at,
      success.finished_at,
      case
        when success.finished_at is null then 'missing'
        when success.finished_at < now() - interval '72 hours' then 'unhealthy'
        when success.finished_at < now() - interval '36 hours' then 'stale'
        else 'healthy'
      end as status
    from latest_success success
  )
  select jsonb_build_object(
    'count', (select count(*) from current_deals),
    'capturedAt', coalesce(
      (select captured_at from latest_success),
      (select captured_at from legacy_snapshot)
    ),
    'sync', jsonb_build_object(
      'cadence', 'daily',
      'lastSucceededAt', (select finished_at from sync_state),
      'status', coalesce((select status from sync_state), 'missing'),
      'stale', coalesce((select status in ('stale', 'unhealthy') from sync_state), true),
      'unhealthy', coalesce((select status = 'unhealthy' from sync_state), false)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', deal.deal_id,
        'dripjobsContactId', deal.dripjobs_contact_id,
        'personId', deal.person_id,
        'personMatchCount', 1,
        'personMatchMethod', deal.person_match_method,
        'customerName', deal.customer_name,
        'email', deal.email,
        'phone', deal.phone,
        'dealName', deal.deal_name,
        'stage', deal.deal_stage,
        'stageEnteredAt', deal.stage_entered_at,
        'stageObservedAt', deal.stage_observed_at,
        'status', deal.sales_status,
        'label', deal.label,
        'source', deal.raw_source,
        'amountCents', deal.deal_amount_cents,
        'lastChange', deal.last_change,
        'dealAge', deal.deal_age,
        'salesperson', deal.salesperson,
        'capturedAt', deal.captured_at,
        'latestSignalAt', activity.last_signal_at
      ) order by deal.source_row_number, deal.deal_id)
      from current_deals deal
      left join public.contact_activity_stats activity
        on activity.workspace_key = p_workspace_key
       and activity.person_id = deal.person_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_current_dripjobs_pipeline(text)
  from public, anon, authenticated;
grant execute on function public.list_current_dripjobs_pipeline(text)
  to service_role;

comment on function public.list_current_dripjobs_pipeline(text) is
  'Current DripJobs pipeline with a required persisted canonical Contact for every deal.';

create or replace function public.list_contact_deals(
  p_person_id uuid,
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'count', count(*),
    'activeCount', count(*) filter (where deal.archived_at is null),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', deal.deal_id,
      'name', deal.deal_name,
      'stage', deal.deal_stage,
      'status', deal.sales_status,
      'amountCents', deal.deal_amount_cents,
      'source', deal.raw_source,
      'salesperson', deal.salesperson,
      'active', deal.archived_at is null,
      'stageEnteredAt', deal.stage_entered_at,
      'firstSeenAt', deal.first_seen_at,
      'lastSeenAt', deal.last_seen_at
    ) order by (deal.archived_at is null) desc, deal.stage_entered_at desc nulls last, deal.deal_id), '[]'::jsonb)
  )
  from public.dripjobs_sales_deals deal
  join public.people person
    on person.id = deal.person_id
   and person.workspace_key = p_workspace_key
  where deal.person_id = p_person_id;
$$;

revoke all on function public.list_contact_deals(uuid, text)
  from public, anon, authenticated;
grant execute on function public.list_contact_deals(uuid, text)
  to service_role;

comment on function public.list_contact_deals(uuid, text) is
  'Lists every active or archived DripJobs deal owned by one canonical Contact.';
