-- Make person and Signal identity resolution independent of ingestion order.
-- `identities` is the canonical normalized identifier table;
-- `person_identity_claims` is the only person ownership evidence consumed by
-- both the Signal and DripJobs read models.

create or replace function private.canonical_person_identifier_value(
  p_kind text,
  p_value text
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case p_kind
    when 'email' then private.fluid_normalize_email(p_value)
    when 'phone' then private.fluid_normalize_phone(p_value)
    else null
  end;
$$;

create index if not exists person_identifiers_canonical_active_idx
  on public.person_identifiers (
    kind,
    (private.canonical_person_identifier_value(kind, normalized_value)),
    person_id
  )
  where active;

create or replace function private.ensure_person_identifier_identities(
  p_workspace_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upserted integer := 0;
begin
  insert into public.identities (
    workspace_key,
    kind,
    normalized_value,
    display_value,
    display_name,
    classification,
    first_seen_at,
    last_seen_at,
    updated_at
  )
  select
    person.workspace_key,
    identifier.kind,
    private.canonical_person_identifier_value(
      identifier.kind,
      identifier.normalized_value
    ),
    min(identifier.value),
    case when count(distinct person.display_name) = 1
      then min(person.display_name)
      else null
    end,
    'unknown',
    min(identifier.first_seen_at),
    max(identifier.last_seen_at),
    now()
  from public.person_identifiers identifier
  join public.people person
    on person.id = identifier.person_id
   and person.status = 'active'
  where identifier.active
    and (p_workspace_key is null or person.workspace_key = p_workspace_key)
    and private.canonical_person_identifier_value(
      identifier.kind,
      identifier.normalized_value
    ) is not null
  group by
    person.workspace_key,
    identifier.kind,
    private.canonical_person_identifier_value(
      identifier.kind,
      identifier.normalized_value
    )
  on conflict (workspace_key, kind, normalized_value) do update
  set display_value = coalesce(public.identities.display_value, excluded.display_value),
      display_name = coalesce(public.identities.display_name, excluded.display_name),
      first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
      updated_at = now()
  where (
    public.identities.display_value,
    public.identities.display_name,
    public.identities.first_seen_at,
    public.identities.last_seen_at
  ) is distinct from (
    coalesce(public.identities.display_value, excluded.display_value),
    coalesce(public.identities.display_name, excluded.display_name),
    least(public.identities.first_seen_at, excluded.first_seen_at),
    greatest(public.identities.last_seen_at, excluded.last_seen_at)
  );
  get diagnostics v_upserted = row_count;

  return jsonb_build_object('upsertedIdentities', v_upserted);
end;
$$;

create or replace function private.refresh_identity_claims(
  p_identity_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refreshed integer := 0;
begin
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
    first_seen_at,
    last_seen_at,
    updated_at
  )
  select
    person.workspace_key,
    identifier.person_id,
    identity.id,
    identifier.source_system,
    identifier.source_record_type,
    identifier.source_record_id,
    1,
    identifier.is_primary,
    true,
    identifier.first_seen_at,
    identifier.last_seen_at,
    now()
  from public.identities identity
  join public.people person
    on person.workspace_key = identity.workspace_key
   and person.status = 'active'
  join public.person_identifiers identifier
    on identifier.person_id = person.id
   and identifier.active
   and identifier.kind = identity.kind
   and private.canonical_person_identifier_value(
     identifier.kind,
     identifier.normalized_value
   ) = identity.normalized_value
  where identity.id = p_identity_id
  on conflict (
    person_id,
    identity_id,
    source_system,
    source_record_type,
    source_record_id
  ) do update
  set active = true,
      confidence = 1,
      is_primary = excluded.is_primary,
      first_seen_at = least(
        public.person_identity_claims.first_seen_at,
        excluded.first_seen_at
      ),
      last_seen_at = greatest(
        public.person_identity_claims.last_seen_at,
        excluded.last_seen_at
      ),
      updated_at = now()
  where (
    public.person_identity_claims.active,
    public.person_identity_claims.confidence,
    public.person_identity_claims.is_primary,
    public.person_identity_claims.first_seen_at,
    public.person_identity_claims.last_seen_at
  ) is distinct from (
    true,
    1::numeric,
    excluded.is_primary,
    least(public.person_identity_claims.first_seen_at, excluded.first_seen_at),
    greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at)
  );
  get diagnostics v_refreshed = row_count;

  return v_refreshed;
end;
$$;

revoke all on function private.canonical_person_identifier_value(text, text)
  from public, anon, authenticated;
revoke all on function private.ensure_person_identifier_identities(text)
  from public, anon, authenticated;
revoke all on function private.refresh_identity_claims(uuid)
  from public, anon, authenticated;

grant execute on function private.canonical_person_identifier_value(text, text)
  to service_role;
grant execute on function private.ensure_person_identifier_identities(text)
  to service_role;
grant execute on function private.refresh_identity_claims(uuid)
  to service_role;

create or replace function private.resolve_activity_identity(p_activity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_identity_id uuid;
  v_direct_person_id uuid;
  v_resolved_person_id uuid;
  v_claimed_people integer := 0;
  v_identity_count integer := 0;
  v_conflict_identity uuid;
begin
  select * into v_activity
  from public.activities
  where id = p_activity_id
  for update;

  if not found then
    return jsonb_build_object('activityId', p_activity_id, 'status', 'missing');
  end if;

  delete from public.activity_identities ai
  where ai.activity_id = v_activity.id
    and ai.relationship = 'actor'
    and not (
      exists (
        select 1
        from public.identities identity
        where identity.id = ai.identity_id
          and identity.workspace_key = v_activity.workspace_key
          and identity.kind = 'email'
          and identity.normalized_value = private.fluid_normalize_email(v_activity.actor_email)
      )
      or exists (
        select 1
        from public.identities identity
        where identity.id = ai.identity_id
          and identity.workspace_key = v_activity.workspace_key
          and identity.kind = 'phone'
          and identity.normalized_value = private.fluid_normalize_phone(v_activity.actor_phone)
      )
    );

  if private.fluid_normalize_email(v_activity.actor_email) is not null then
    perform private.upsert_activity_identity(
      v_activity.id,
      v_activity.workspace_key,
      'email',
      v_activity.actor_email,
      v_activity.actor_name,
      v_activity.occurred_at
    );
  end if;

  if private.fluid_normalize_phone(v_activity.actor_phone) is not null then
    perform private.upsert_activity_identity(
      v_activity.id,
      v_activity.workspace_key,
      'phone',
      v_activity.actor_phone,
      v_activity.actor_name,
      v_activity.occurred_at
    );
  end if;

  -- The activity may be the first event that creates this canonical identity.
  -- Refresh claims now so an earlier Contact import resolves in this same
  -- transaction instead of waiting for the next directory sync.
  for v_identity_id in
    select ai.identity_id
    from public.activity_identities ai
    where ai.activity_id = v_activity.id
      and ai.relationship = 'actor'
  loop
    perform private.refresh_identity_claims(v_identity_id);
  end loop;

  select source.person_id into v_direct_person_id
  from public.person_sources source
  where source.source_system = 'ottawa-painters-admin'
    and source.source_record_type = 'contact'
    and source.source_record_id = v_activity.contact_id::text
  limit 1;

  if v_direct_person_id is not null then
    delete from public.activity_people
    where activity_id = v_activity.id
      and relationship = 'counterparty'
      and person_id <> v_direct_person_id;

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
    )
    select
      v_activity.workspace_key,
      v_direct_person_id,
      ai.identity_id,
      'activity-contact',
      'contact',
      v_activity.contact_id::text,
      1,
      false,
      true,
      v_activity.occurred_at,
      now()
    from public.activity_identities ai
    where ai.activity_id = v_activity.id
      and ai.relationship = 'actor'
    on conflict (
      person_id,
      identity_id,
      source_system,
      source_record_type,
      source_record_id
    ) do update
    set active = true,
        confidence = 1,
        last_seen_at = greatest(
          public.person_identity_claims.last_seen_at,
          excluded.last_seen_at
        ),
        updated_at = now();

    insert into public.activity_people (
      activity_id,
      person_id,
      relationship,
      matched_by,
      confidence,
      updated_at
    )
    values (
      v_activity.id,
      v_direct_person_id,
      'counterparty',
      'contact_id',
      1,
      now()
    )
    on conflict (activity_id, person_id, relationship) do update
    set matched_by = 'contact_id',
        confidence = 1,
        updated_at = now();

    update public.contact_suggestions suggestion
    set status = 'dismissed',
        resolved_person_id = v_direct_person_id,
        resolved_at = now(),
        updated_at = now()
    where suggestion.status = 'pending'
      and suggestion.identity_id in (
        select ai.identity_id
        from public.activity_identities ai
        where ai.activity_id = v_activity.id
          and ai.relationship = 'actor'
      );

    return jsonb_build_object(
      'activityId', v_activity.id,
      'status', 'resolved',
      'personId', v_direct_person_id,
      'matchedBy', 'contact_id'
    );
  end if;

  with claimed as (
    select distinct claim.person_id
    from public.activity_identities activity_identity
    join public.identities identity
      on identity.id = activity_identity.identity_id
    join public.person_identity_claims claim
      on claim.identity_id = activity_identity.identity_id
     and claim.active
    join public.people person
      on person.id = claim.person_id
     and person.status = 'active'
    where activity_identity.activity_id = v_activity.id
      and activity_identity.relationship in ('actor', 'provider')
      and not identity.ignored
      and identity.classification <> 'system'
  )
  select count(*), min(person_id::text)::uuid
  into v_claimed_people, v_resolved_person_id
  from claimed;

  select count(*) into v_identity_count
  from public.activity_identities
  where activity_id = v_activity.id
    and relationship = 'actor';

  if v_claimed_people = 1 then
    delete from public.activity_people
    where activity_id = v_activity.id
      and relationship = 'counterparty'
      and person_id <> v_resolved_person_id;

    insert into public.activity_people (
      activity_id,
      person_id,
      relationship,
      matched_by,
      confidence,
      updated_at
    )
    values (
      v_activity.id,
      v_resolved_person_id,
      'counterparty',
      'exact_identity',
      1,
      now()
    )
    on conflict (activity_id, person_id, relationship) do update
    set matched_by = 'exact_identity',
        confidence = 1,
        updated_at = now();

    update public.contact_suggestions suggestion
    set status = 'dismissed',
        resolved_person_id = v_resolved_person_id,
        resolved_at = now(),
        updated_at = now()
    where suggestion.status = 'pending'
      and suggestion.identity_id in (
        select ai.identity_id
        from public.activity_identities ai
        where ai.activity_id = v_activity.id
          and ai.relationship = 'actor'
      );

    return jsonb_build_object(
      'activityId', v_activity.id,
      'status', 'resolved',
      'personId', v_resolved_person_id,
      'matchedBy', 'exact_identity'
    );
  end if;

  if v_claimed_people > 1 then
    delete from public.activity_people
    where activity_id = v_activity.id
      and relationship = 'counterparty';

    for v_conflict_identity in
      select ai.identity_id
      from public.activity_identities ai
      where ai.activity_id = v_activity.id
        and ai.relationship = 'actor'
    loop
      insert into public.contact_suggestions (
        workspace_key,
        identity_id,
        activity_id,
        suggestion_type,
        confidence,
        reason,
        evidence,
        source_revision,
        updated_at
      ) values (
        v_activity.workspace_key,
        v_conflict_identity,
        v_activity.id,
        'conflict',
        1,
        'This exact identifier is actively claimed by more than one Contact. Fluid will not guess.',
        jsonb_build_object(
          'activityId', v_activity.id,
          'claimedPeople', v_claimed_people
        ),
        v_activity.triage_revision,
        now()
      )
      on conflict (workspace_key, identity_id) where status = 'pending'
      do update set
        suggestion_type = 'conflict',
        activity_id = excluded.activity_id,
        confidence = 1,
        reason = excluded.reason,
        evidence = excluded.evidence,
        source_revision = greatest(
          public.contact_suggestions.source_revision,
          excluded.source_revision
        ),
        updated_at = now();
    end loop;

    return jsonb_build_object(
      'activityId', v_activity.id,
      'status', 'conflict',
      'claimedPeople', v_claimed_people
    );
  end if;

  -- An exact-identity projection cannot outlive its supporting claim.
  delete from public.activity_people
  where activity_id = v_activity.id
    and relationship = 'counterparty'
    and matched_by = 'exact_identity';

  return jsonb_build_object(
    'activityId', v_activity.id,
    'status', case when v_identity_count > 0 then 'unmatched' else 'no-identity' end
  );
end;
$$;

revoke all on function private.resolve_activity_identity(bigint)
  from public, anon, authenticated;
grant execute on function private.resolve_activity_identity(bigint)
  to service_role;

create or replace function private.activity_identity_resolution(
  p_activity_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with eligible_identities as (
    select
      identity.id,
      identity.kind,
      identity.display_name,
      identity.display_value,
      identity.normalized_value
    from public.activity_identities activity_identity
    join public.identities identity
      on identity.id = activity_identity.identity_id
    where activity_identity.activity_id = p_activity_id
      and activity_identity.relationship = 'actor'
      and not identity.ignored
      and identity.classification <> 'system'
  ),
  claims as (
    select distinct claim.person_id
    from eligible_identities identity
    join public.person_identity_claims claim
      on claim.identity_id = identity.id
     and claim.active
    join public.people person
      on person.id = claim.person_id
     and person.status = 'active'
  ),
  summary as (
    select
      (select count(*) from eligible_identities)::integer as identity_count,
      (select count(*) from claims)::integer as person_count,
      (
        select identity.display_name
        from eligible_identities identity
        order by
          (identity.display_name is null),
          case identity.kind when 'phone' then 0 else 1 end,
          identity.id
        limit 1
      ) as display_name,
      (
        select coalesce(identity.display_value, identity.normalized_value)
        from eligible_identities identity
        order by
          case identity.kind when 'phone' then 0 else 1 end,
          identity.id
        limit 1
      ) as display_value
  )
  select case
    when exists (
      select 1
      from public.activity_people link
      join public.people person
        on person.id = link.person_id
       and person.status = 'active'
      where link.activity_id = p_activity_id
        and link.relationship in ('counterparty', 'customer')
    ) then null
    when summary.identity_count = 0 then null
    else jsonb_build_object(
      'status', case when summary.person_count > 1 then 'conflict' else 'unresolved' end,
      'displayName', summary.display_name,
      'displayValue', summary.display_value,
      'reason', case
        when summary.person_count > 1
          then 'This exact identifier is actively claimed by more than one Contact. Fluid will not guess.'
        when summary.person_count = 1
          then 'A unique Contact claim exists, but this Signal has not been projected to it yet.'
        else 'No active Contact claims this exact identifier.'
      end
    )
  end
  from summary;
$$;

create or replace function private.read_identity_resolution_health(
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active_identifiers as (
    select
      identifier.id,
      identifier.person_id,
      person.workspace_key,
      identifier.kind,
      private.canonical_person_identifier_value(
        identifier.kind,
        identifier.normalized_value
      ) as normalized_value
    from public.person_identifiers identifier
    join public.people person
      on person.id = identifier.person_id
     and person.status = 'active'
    where identifier.active
      and person.workspace_key = p_workspace_key
  ),
  identifier_state as (
    select
      identifier.*,
      identity.id as identity_id,
      exists (
        select 1
        from public.person_identity_claims claim
        where claim.person_id = identifier.person_id
          and claim.identity_id = identity.id
          and claim.active
      ) as claimed
    from active_identifiers identifier
    left join public.identities identity
      on identity.workspace_key = identifier.workspace_key
     and identity.kind = identifier.kind
     and identity.normalized_value = identifier.normalized_value
  ),
  activity_claims as (
    select
      activity_identity.activity_id,
      min(claim.person_id::text)::uuid as person_id,
      count(distinct claim.person_id)::integer as person_count
    from public.activity_identities activity_identity
    join public.activities activity
      on activity.id = activity_identity.activity_id
     and activity.workspace_key = p_workspace_key
    join public.identities identity
      on identity.id = activity_identity.identity_id
     and not identity.ignored
     and identity.classification <> 'system'
    join public.person_identity_claims claim
      on claim.identity_id = activity_identity.identity_id
     and claim.active
    join public.people person
      on person.id = claim.person_id
     and person.status = 'active'
    where activity_identity.relationship = 'actor'
    group by activity_identity.activity_id
  ),
  counts as (
    select
      (select count(*) from identifier_state where identity_id is null)::integer
        as missing_identities,
      (select count(*) from identifier_state where identity_id is not null and not claimed)::integer
        as missing_claims,
      (
        select count(*)
        from activity_claims claim
        where claim.person_count = 1
          and not exists (
            select 1
            from public.activity_people link
            where link.activity_id = claim.activity_id
              and link.person_id = claim.person_id
              and link.relationship in ('counterparty', 'customer')
          )
      )::integer as resolvable_unlinked_activities,
      (
        select count(*)
        from activity_claims claim
        where claim.person_count > 1
          and exists (
            select 1
            from public.activity_people link
            where link.activity_id = claim.activity_id
              and link.relationship = 'counterparty'
              and link.matched_by <> 'contact_id'
          )
      )::integer as conflicted_linked_activities,
      (
        select count(*)
        from public.activity_people link
        join public.activities activity
          on activity.id = link.activity_id
         and activity.workspace_key = p_workspace_key
        left join activity_claims claim
          on claim.activity_id = link.activity_id
        where link.relationship = 'counterparty'
          and link.matched_by = 'exact_identity'
          and (
            claim.activity_id is null
            or claim.person_count <> 1
            or claim.person_id <> link.person_id
          )
      )::integer as stale_exact_identity_links
  )
  select jsonb_build_object(
    'missingIdentities', counts.missing_identities,
    'missingClaims', counts.missing_claims,
    'resolvableUnlinkedActivities', counts.resolvable_unlinked_activities,
    'conflictedLinkedActivities', counts.conflicted_linked_activities,
    'staleExactIdentityLinks', counts.stale_exact_identity_links,
    'driftCount',
      counts.missing_identities
      + counts.missing_claims
      + counts.resolvable_unlinked_activities
      + counts.conflicted_linked_activities
      + counts.stale_exact_identity_links
  )
  from counts;
$$;

revoke all on function private.activity_identity_resolution(bigint)
  from public, anon, authenticated;
revoke all on function private.read_identity_resolution_health(text)
  from public, anon, authenticated;
grant execute on function private.activity_identity_resolution(bigint)
  to service_role;
grant execute on function private.read_identity_resolution_health(text)
  to service_role;

create or replace function public.sync_ottawa_painters_customers()
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
begin
  sync_result := private.sync_ottawa_painters_customers_without_identity_dedupe();

  if sync_result->>'status' <> 'succeeded' then
    return sync_result;
  end if;

  merge_result := private.merge_exact_duplicate_customer_people();
  identity_seed_result := private.ensure_person_identifier_identities('ottawa-painters');
  reconciliation_result := private.reconcile_customer_identity_graph();

  return sync_result || jsonb_build_object(
    'identityDeduplication', merge_result,
    'identitySeeding', identity_seed_result,
    'identityReconciliation', reconciliation_result
  );
end;
$$;

revoke all on function public.sync_ottawa_painters_customers()
  from public, anon, authenticated;
grant execute on function public.sync_ottawa_painters_customers()
  to service_role;

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
  identity_health jsonb;
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
    'identityHealth', identity_health,
    'needsSync',
      pending_customers > 0
      or stale_customer_roles > 0
      or coalesce((identity_health->>'driftCount')::integer, 0) > 0,
    'lastRun', last_run,
    'checkedAt', now()
  );
end;
$$;

revoke all on function public.read_customer_sync_status()
  from public, anon, authenticated;
grant execute on function public.read_customer_sync_status()
  to service_role;

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
      private.activity_identity_resolution(activity.id) as identity_resolution,
      coalesce(labels.value, '[]'::jsonb) as labels,
      coalesce(review.status, 'settled') as review_status,
      review.resolution as review_resolution,
      review.updated_at as review_updated_at,
      coalesce(review.pending_recommendation_count, 0) as pending_recommendation_count,
      coalesce(review.status = 'action_open', false) as action_open,
      case when review.status = 'action_open'
        then coalesce(review.updated_at, activity.occurred_at)
        else activity.occurred_at
      end as board_sort_at
    from public.activities activity
    left join public.signal_review_states review
      on review.activity_id = activity.id
     and review.input_revision = activity.recommendation_revision
    left join lateral (
      select jsonb_build_object(
        'id', person.id,
        'displayName', person.display_name,
        'primaryEmail', person.primary_email,
        'primaryPhone', person.primary_phone
      ) as value
      from public.activity_people link
      join public.people person
        on person.id = link.person_id
       and person.status = 'active'
      where link.activity_id = activity.id
      order by
        case link.relationship when 'counterparty' then 0 when 'customer' then 1 else 2 end,
        link.confidence desc,
        person.updated_at desc
      limit 1
    ) contact on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'kind', assignment.label_kind,
        'key', label.key,
        'name', label.name,
        'color', label.color,
        'confidence', assignment.confidence
      ) order by assignment.label_kind) as value
      from public.signal_labels assignment
      join public.labels label on label.id = assignment.label_id
      where assignment.activity_id = activity.id
        and assignment.agent_key = 'signal-triage'
    ) labels on true
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and (
        p_contact_id is null
        or exists (
          select 1
          from public.activity_people selected_link
          where selected_link.activity_id = activity.id
            and selected_link.person_id = p_contact_id
        )
      )
  ),
  candidates as (
    select *
    from enriched
    where (
      p_view = 'all'
      or (p_view = 'needs_you' and (action_open or review_status = 'pending'))
    )
      and (
        p_cursor_at is null
        or (case when action_open then 1 else 0 end)
          < (case when coalesce(p_cursor_action_open, false) then 1 else 0 end)
        or (
          action_open = coalesce(p_cursor_action_open, false)
          and board_sort_at < p_cursor_at
        )
        or (
          action_open = coalesce(p_cursor_action_open, false)
          and board_sort_at = p_cursor_at
          and id < p_cursor_id
        )
      )
    order by action_open desc, board_sort_at desc, id desc
    limit least(greatest(p_limit, 1), 100) + 1
  ),
  visible as (
    select *
    from candidates
    order by action_open desc, board_sort_at desc, id desc
    limit least(greatest(p_limit, 1), 100)
  ),
  last_row as (
    select *
    from visible
    order by action_open, board_sort_at, id
    limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'source', item.source,
        'eventType', item.event_type,
        'direction', item.direction,
        'actorName', item.actor_name,
        'actorEmail', item.actor_email,
        'actorPhone', item.actor_phone,
        'identityResolution', item.identity_resolution,
        'subject', item.subject,
        'preview', item.preview,
        'occurredAt', item.occurred_at,
        'threadId', item.external_thread_id,
        'hasAttachments', item.has_attachments,
        'attachmentCount', item.attachment_count,
        'isAutomated', lower(coalesce(item.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes'),
        'contact', item.contact,
        'labels', item.labels,
        'actionOpen', item.action_open,
        'boardSortAt', item.board_sort_at,
        'review', jsonb_build_object(
          'status', item.review_status,
          'resolution', item.review_resolution,
          'pendingRecommendationCount', item.pending_recommendation_count,
          'updatedAt', item.review_updated_at
        )
      ) order by item.action_open desc, item.board_sort_at desc, item.id desc)
      from visible item
    ), '[]'::jsonb),
    'nextCursor', case
      when (select count(*) from candidates) > least(greatest(p_limit, 1), 100)
      then (
        select jsonb_build_object(
          'actionOpen', action_open,
          'at', board_sort_at,
          'id', id
        )
        from last_row
      )
      else null
    end
  );
$$;

revoke all on function public.list_real_board_signals(
  text, uuid, text, integer, timestamptz, bigint, boolean
) from public, anon, authenticated;
grant execute on function public.list_real_board_signals(
  text, uuid, text, integer, timestamptz, bigint, boolean
) to service_role;

create or replace function public.get_real_board_signal(
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
  with selected as (
    select
      activity.*,
      contact.value as contact,
      private.activity_identity_resolution(activity.id) as identity_resolution,
      coalesce(labels.value, '[]'::jsonb) as labels,
      jsonb_build_object(
        'status', coalesce(review.status, 'settled'),
        'resolution', review.resolution,
        'pendingRecommendationCount', coalesce(review.pending_recommendation_count, 0),
        'reviewedBy', review.reviewed_by,
        'reviewedAt', review.reviewed_at
      ) as review
    from public.activities activity
    left join public.signal_review_states review
      on review.activity_id = activity.id
     and review.input_revision = activity.recommendation_revision
    left join lateral (
      select jsonb_build_object(
        'id', person.id,
        'displayName', person.display_name,
        'primaryEmail', person.primary_email,
        'primaryPhone', person.primary_phone
      ) as value
      from public.activity_people link
      join public.people person
        on person.id = link.person_id
       and person.status = 'active'
      where link.activity_id = activity.id
      order by
        case link.relationship when 'counterparty' then 0 when 'customer' then 1 else 2 end,
        link.confidence desc,
        person.updated_at desc
      limit 1
    ) contact on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'kind', assignment.label_kind,
        'key', label.key,
        'name', label.name,
        'color', label.color,
        'confidence', assignment.confidence,
        'reason', assignment.reason
      ) order by assignment.label_kind) as value
      from public.signal_labels assignment
      join public.labels label on label.id = assignment.label_id
      where assignment.activity_id = activity.id
        and assignment.agent_key = 'signal-triage'
    ) labels on true
    where activity.workspace_key = p_workspace_key
      and activity.id = p_activity_id
      and activity.source in ('gmail', 'quo')
  ),
  history_candidates as (
    select history.*
    from selected current
    join public.activities history
      on history.workspace_key = current.workspace_key
     and history.source in ('gmail', 'quo')
     and history.id <> current.id
     and (
       (
         current.external_thread_id is not null
         and history.source = current.source
         and history.account_key = current.account_key
         and history.external_thread_id = current.external_thread_id
       )
       or exists (
         select 1
         from public.activity_people current_link
         join public.activity_people history_link
           on history_link.person_id = current_link.person_id
         where current_link.activity_id = current.id
           and history_link.activity_id = history.id
       )
     )
    where p_history_cursor_at is null
      or history.occurred_at < p_history_cursor_at
      or (
        history.occurred_at = p_history_cursor_at
        and history.id < p_history_cursor_id
      )
    order by history.occurred_at desc, history.id desc
    limit least(greatest(p_history_limit, 1), 100) + 1
  ),
  history_visible as (
    select *
    from history_candidates
    order by occurred_at desc, id desc
    limit least(greatest(p_history_limit, 1), 100)
  ),
  history_last as (
    select *
    from history_visible
    order by occurred_at, id
    limit 1
  )
  select case
    when not exists (select 1 from selected) then null
    else jsonb_build_object(
      'signal', (
        select jsonb_build_object(
          'id', signal.id,
          'source', signal.source,
          'eventType', signal.event_type,
          'direction', signal.direction,
          'actorName', signal.actor_name,
          'actorEmail', signal.actor_email,
          'actorPhone', signal.actor_phone,
          'identityResolution', signal.identity_resolution,
          'subject', signal.subject,
          'preview', signal.preview,
          'bodyText', signal.body_text,
          'occurredAt', signal.occurred_at,
          'threadId', signal.external_thread_id,
          'hasAttachments', signal.has_attachments,
          'attachmentCount', signal.attachment_count,
          'callStatus', signal.call_status,
          'durationSeconds', signal.duration_seconds,
          'isAutomated', lower(coalesce(signal.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes'),
          'contact', signal.contact,
          'labels', signal.labels,
          'review', signal.review
        )
        from selected signal
      ),
      'recommendations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', recommendation.id,
          'kind', recommendation.recommendation_kind,
          'label', recommendation.label,
          'reason', recommendation.reason,
          'confidence', recommendation.confidence,
          'capabilityKey', recommendation.capability_key,
          'evidence', recommendation.evidence,
          'prerequisites', recommendation.prerequisites,
          'locked', true
        ) order by recommendation.display_order)
        from public.signal_recommendations recommendation
        join selected signal
          on signal.id = recommendation.activity_id
        where recommendation.input_revision = signal.recommendation_revision
          and recommendation.status = 'pending'
          and not recommendation.is_shadow
      ), '[]'::jsonb),
      'attachments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'attachmentKey', attachment.attachment_key,
          'filename', attachment.filename,
          'mimeType', attachment.mime_type,
          'status', attachment.extraction_status,
          'extractedText', attachment.extracted_text
        ) order by attachment.updated_at desc)
        from public.signal_attachment_evidence attachment
        join selected signal
          on signal.id = attachment.activity_id
        where attachment.agent_key = 'signal-triage'
      ), '[]'::jsonb),
      'transcript', (
        select jsonb_build_object(
          'status', transcript.status,
          'text', transcript.transcript_text,
          'dialogue', transcript.dialogue,
          'updatedAt', transcript.updated_at
        )
        from public.activity_call_transcripts transcript
        join selected signal
          on signal.id = transcript.activity_id
      ),
      'history', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', history.id,
          'source', history.source,
          'eventType', history.event_type,
          'direction', history.direction,
          'actorName', history.actor_name,
          'actorEmail', history.actor_email,
          'actorPhone', history.actor_phone,
          'identityResolution', private.activity_identity_resolution(history.id),
          'subject', history.subject,
          'preview', history.preview,
          'occurredAt', history.occurred_at,
          'hasAttachments', history.has_attachments,
          'attachmentCount', history.attachment_count
        ) order by history.occurred_at desc, history.id desc)
        from history_visible history
      ), '[]'::jsonb),
      'historyNextCursor', case
        when (select count(*) from history_candidates) > least(greatest(p_history_limit, 1), 100)
        then (
          select jsonb_build_object('at', occurred_at, 'id', id)
          from history_last
        )
        else null
      end
    )
  end;
$$;

revoke all on function public.get_real_board_signal(
  text, bigint, integer, timestamptz, bigint
) from public, anon, authenticated;
grant execute on function public.get_real_board_signal(
  text, bigint, integer, timestamptz, bigint
) to service_role;

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
    where deal.archived_at is null
      and (
        deal.last_active_snapshot_at = (select captured_at from latest_success)
        or (
          not exists (select 1 from latest_success)
          and deal.source_document_id = (select source_document_id from legacy_snapshot)
        )
      )
  ),
  person_identifier_matches as (
    select distinct
      deal.deal_id,
      claim.person_id,
      identity.kind as identifier_kind
    from current_deals deal
    join public.identities identity
      on identity.workspace_key = p_workspace_key
     and not identity.ignored
     and identity.classification <> 'system'
     and (
       (
         identity.kind = 'email'
         and deal.normalized_email is not null
         and deal.normalized_email <> ''
         and identity.normalized_value = private.fluid_normalize_email(deal.normalized_email)
       )
       or (
         identity.kind = 'phone'
         and deal.normalized_phone is not null
         and deal.normalized_phone <> ''
         and identity.normalized_value = private.fluid_normalize_phone(deal.normalized_phone)
       )
     )
    join public.person_identity_claims claim
      on claim.identity_id = identity.id
     and claim.active
    join public.people person
      on person.id = claim.person_id
     and person.workspace_key = p_workspace_key
     and person.status = 'active'
  ),
  person_match_strengths as (
    select
      match.deal_id,
      match.person_id,
      count(distinct match.identifier_kind)::integer as match_strength,
      case when
        regexp_replace(lower(btrim(person.display_name)), '[[:space:].…]+$', '', 'g')
          = regexp_replace(lower(btrim(deal.customer_name)), '[[:space:].…]+$', '', 'g')
        then 1
        else 0
      end as name_match_strength,
      regexp_replace(lower(btrim(person.display_name)), '[[:space:].…]+$', '', 'g')
        as person_name_key,
      person.created_at as person_created_at
    from person_identifier_matches match
    join current_deals deal using (deal_id)
    join public.people person on person.id = match.person_id
    group by
      match.deal_id,
      match.person_id,
      person.display_name,
      person.created_at,
      deal.customer_name
  ),
  identifier_ranked_person_matches as (
    select
      match.*,
      max(match.match_strength) over (partition by match.deal_id)
        as best_match_strength
    from person_match_strengths match
  ),
  strongest_identifier_matches as (
    select match.*
    from identifier_ranked_person_matches match
    where match.match_strength = match.best_match_strength
  ),
  name_ranked_person_matches as (
    select
      match.*,
      max(match.name_match_strength) over (partition by match.deal_id)
        as best_name_match_strength
    from strongest_identifier_matches match
  ),
  best_person_matches as (
    select match.*
    from name_ranked_person_matches match
    where match.name_match_strength = match.best_name_match_strength
  ),
  deduplicated_person_matches as (
    select
      match.*,
      row_number() over (
        partition by
          match.deal_id,
          case
            when match.match_strength = 2 then match.person_name_key
            else match.person_id::text
          end
        order by match.person_created_at, match.person_id
      ) as duplicate_rank
    from best_person_matches match
  ),
  resolved_people as (
    select
      match.deal_id,
      case when count(*) = 1 then (array_agg(match.person_id))[1] end as person_id,
      count(*)::integer as match_count
    from deduplicated_person_matches match
    where match.duplicate_rank = 1
    group by match.deal_id
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
        'personId', resolved.person_id,
        'personMatchCount', coalesce(resolved.match_count, 0),
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
      left join resolved_people resolved using (deal_id)
      left join public.contact_activity_stats activity
        on activity.workspace_key = p_workspace_key
       and activity.person_id = resolved.person_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_current_dripjobs_pipeline(text)
  from public, anon, authenticated;
grant execute on function public.list_current_dripjobs_pipeline(text)
  to service_role;

comment on function public.list_current_dripjobs_pipeline(text) is
  'Returns the current DripJobs pipeline through the same canonical Identity claims and Activity links used by Signals.';

-- Repair historical ordering gaps in one bounded, idempotent pass. New
-- activities self-resolve in resolve_activity_identity; later Contact imports
-- replay through the customer-sync wrapper above.
select private.ensure_person_identifier_identities('ottawa-painters');
select private.reconcile_customer_identity_graph();
