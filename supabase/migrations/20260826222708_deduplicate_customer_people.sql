-- Keep separate source records, but prevent identical customer records from
-- becoming separate canonical People. A merge is automatic only when the
-- workspace, entity type, normalized name, email, and phone all agree.

create table private.person_merge_audit (
  loser_person_id uuid primary key,
  survivor_person_id uuid not null,
  workspace_key text not null,
  reason text not null,
  identity_key text not null,
  loser_snapshot jsonb not null,
  merged_at timestamptz not null default now()
);

alter table private.person_merge_audit enable row level security;
revoke all on table private.person_merge_audit from public, anon, authenticated;
grant select on table private.person_merge_audit to service_role;

comment on table private.person_merge_audit is
  'Audit trail for deterministic canonical-Person merges. Source Contact rows are preserved.';

create or replace function private.merge_exact_duplicate_customer_people()
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
  current_group_key text;
begin
  for duplicate in
    with eligible as (
      select
        person.id,
        person.workspace_key,
        person.entity_type,
        person.created_at,
        lower(regexp_replace(btrim(person.display_name), '\s+', ' ', 'g')) normalized_name,
        lower(btrim(person.primary_email)) normalized_email,
        regexp_replace(person.primary_phone, '\D', '', 'g') normalized_phone
      from public.people person
      where person.status = 'active'
        and nullif(btrim(person.display_name), '') is not null
        and nullif(btrim(person.primary_email), '') is not null
        and nullif(regexp_replace(person.primary_phone, '\D', '', 'g'), '') is not null
        and exists (
          select 1
          from public.person_roles role
          where role.person_id = person.id
            and role.role_key = 'customer'
            and role.active
        )
    ), ranked as (
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
      concat_ws('|', ranked.workspace_key, ranked.entity_type, ranked.normalized_name,
        ranked.normalized_email, ranked.normalized_phone) identity_key
    from ranked
    where ranked.duplicate_rank > 1
    order by identity_key, ranked.created_at, ranked.id
  loop
    if current_group_key is distinct from duplicate.identity_key then
      merged_groups := merged_groups + 1;
      current_group_key := duplicate.identity_key;
    end if;

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
    where person.id = duplicate.loser_person_id
    for update;

    if loser_snapshot is null then
      continue;
    end if;

    perform 1
    from public.people person
    where person.id = duplicate.survivor_person_id
    for update;

    insert into private.person_merge_audit (
      loser_person_id, survivor_person_id, workspace_key, reason,
      identity_key, loser_snapshot
    ) values (
      duplicate.loser_person_id,
      duplicate.survivor_person_id,
      duplicate.workspace_key,
      'exact-customer-name-email-phone',
      duplicate.identity_key,
      loser_snapshot
    )
    on conflict (loser_person_id) do nothing;

    update public.person_sources
    set person_id = duplicate.survivor_person_id,
        last_synced_at = now()
    where person_id = duplicate.loser_person_id;

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
    'mergedPeople', merged_people
  );
end;
$$;

revoke all on function private.merge_exact_duplicate_customer_people()
  from public, anon, authenticated;
grant execute on function private.merge_exact_duplicate_customer_people()
  to service_role;

comment on function private.merge_exact_duplicate_customer_people() is
  'Merges only active customer People with identical workspace, type, normalized name, email, and phone.';

create or replace function private.reconcile_customer_identity_graph()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  refreshed_claims integer := 0;
  removed_links integer := 0;
  linked_activities integer := 0;
  dismissed_conflicts integer := 0;
  active_conflicts integer := 0;
begin
  insert into public.person_identity_claims (
    workspace_key, person_id, identity_id, source_system, source_record_type,
    source_record_id, confidence, is_primary, active, first_seen_at, last_seen_at
  )
  select
    person.workspace_key, identifier.person_id, identity.id,
    identifier.source_system, identifier.source_record_type,
    identifier.source_record_id, 1, identifier.is_primary, identifier.active,
    identifier.first_seen_at, identifier.last_seen_at
  from public.person_identifiers identifier
  join public.people person on person.id = identifier.person_id
  join public.identities identity
    on identity.workspace_key = person.workspace_key
   and identity.kind = identifier.kind
   and identity.normalized_value = case
     when identifier.kind = 'email'
       then private.fluid_normalize_email(identifier.normalized_value)
     else private.fluid_normalize_phone(identifier.normalized_value)
   end
  on conflict (
    person_id, identity_id, source_system, source_record_type, source_record_id
  ) do update set
    active = excluded.active,
    is_primary = excluded.is_primary,
    confidence = 1,
    first_seen_at = least(public.person_identity_claims.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
    updated_at = now()
  where (
    public.person_identity_claims.active,
    public.person_identity_claims.is_primary,
    public.person_identity_claims.confidence,
    public.person_identity_claims.first_seen_at,
    public.person_identity_claims.last_seen_at
  ) is distinct from (
    excluded.active,
    excluded.is_primary,
    1::numeric,
    least(public.person_identity_claims.first_seen_at, excluded.first_seen_at),
    greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at)
  );
  get diagnostics refreshed_claims = row_count;

  with activity_claims as (
    select
      activity_identity.activity_id,
      min(claim.person_id::text)::uuid person_id,
      count(distinct claim.person_id) person_count
    from public.activity_identities activity_identity
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
    group by activity_identity.activity_id
  )
  delete from public.activity_people link
  using activity_claims claims
  where link.activity_id = claims.activity_id
    and link.relationship = 'counterparty'
    and (
      claims.person_count > 1
      or (claims.person_count = 1 and link.person_id <> claims.person_id)
    )
    and not exists (
      select 1
      from public.activities activity
      join public.person_sources source
        on source.source_system = 'ottawa-painters-admin'
       and source.source_record_type = 'contact'
       and source.source_record_id = activity.contact_id::text
      where activity.id = claims.activity_id
    );
  get diagnostics removed_links = row_count;

  with activity_claims as (
    select
      activity_identity.activity_id,
      min(claim.person_id::text)::uuid person_id,
      count(distinct claim.person_id) person_count
    from public.activity_identities activity_identity
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
    group by activity_identity.activity_id
  )
  insert into public.activity_people (
    activity_id, person_id, relationship, matched_by, confidence, updated_at
  )
  select
    claims.activity_id, claims.person_id, 'counterparty',
    'exact_identity', 1, now()
  from activity_claims claims
  where claims.person_count = 1
    and not exists (
      select 1
      from public.activities activity
      join public.person_sources source
        on source.source_system = 'ottawa-painters-admin'
       and source.source_record_type = 'contact'
       and source.source_record_id = activity.contact_id::text
      where activity.id = claims.activity_id
    )
  on conflict (activity_id, person_id, relationship) do nothing;
  get diagnostics linked_activities = row_count;

  with unique_claims as (
    select
      claim.identity_id,
      min(claim.person_id::text)::uuid person_id
    from public.person_identity_claims claim
    join public.people person
      on person.id = claim.person_id
     and person.status = 'active'
    where claim.active
    group by claim.identity_id
    having count(distinct claim.person_id) = 1
  )
  update public.contact_suggestions suggestion
  set status = 'dismissed',
      resolved_person_id = unique_claims.person_id,
      resolved_at = now(),
      updated_at = now()
  from unique_claims
  where suggestion.identity_id = unique_claims.identity_id
    and suggestion.status = 'pending'
    and suggestion.suggestion_type = 'conflict';
  get diagnostics dismissed_conflicts = row_count;

  insert into public.contact_suggestions (
    workspace_key, identity_id, suggestion_type, confidence, reason, evidence
  )
  select
    identity.workspace_key, identity.id, 'conflict', 1,
    'This exact identifier is actively claimed by more than one Contact. Fluid will not guess.',
    jsonb_build_object(
      'personIds', jsonb_agg(distinct claim.person_id order by claim.person_id),
      'claimCount', count(distinct claim.person_id)
    )
  from public.identities identity
  join public.person_identity_claims claim
    on claim.identity_id = identity.id
   and claim.active
  join public.people person
    on person.id = claim.person_id
   and person.status = 'active'
  where not identity.ignored
    and identity.classification <> 'system'
  group by identity.workspace_key, identity.id
  having count(distinct claim.person_id) > 1
  on conflict (workspace_key, identity_id) where status = 'pending'
  do update set
    suggestion_type = 'conflict',
    confidence = 1,
    reason = excluded.reason,
    evidence = excluded.evidence,
    updated_at = now()
  where (
    public.contact_suggestions.suggestion_type,
    public.contact_suggestions.confidence,
    public.contact_suggestions.reason,
    public.contact_suggestions.evidence
  ) is distinct from (
    excluded.suggestion_type,
    excluded.confidence,
    excluded.reason,
    excluded.evidence
  );
  get diagnostics active_conflicts = row_count;

  return jsonb_build_object(
    'refreshedClaims', refreshed_claims,
    'removedLinks', removed_links,
    'linkedActivities', linked_activities,
    'dismissedConflicts', dismissed_conflicts,
    'activeConflicts', active_conflicts
  );
end;
$$;

revoke all on function private.reconcile_customer_identity_graph()
  from public, anon, authenticated;
grant execute on function private.reconcile_customer_identity_graph()
  to service_role;

comment on function private.reconcile_customer_identity_graph() is
  'Refreshes exact Contact identity claims, resolves unique Activities, and preserves genuine shared-identity conflicts.';

-- Preserve the existing deterministic source sync as the ingestion phase.
alter function public.sync_ottawa_painters_customers()
  rename to sync_ottawa_painters_customers_without_identity_dedupe;
alter function public.sync_ottawa_painters_customers_without_identity_dedupe()
  set schema private;

revoke all on function private.sync_ottawa_painters_customers_without_identity_dedupe()
  from public, anon, authenticated;
grant execute on function private.sync_ottawa_painters_customers_without_identity_dedupe()
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
  reconciliation_result jsonb;
begin
  sync_result := private.sync_ottawa_painters_customers_without_identity_dedupe();

  if sync_result->>'status' <> 'succeeded' then
    return sync_result;
  end if;

  merge_result := private.merge_exact_duplicate_customer_people();
  reconciliation_result := private.reconcile_customer_identity_graph();

  return sync_result || jsonb_build_object(
    'identityDeduplication', merge_result,
    'identityReconciliation', reconciliation_result
  );
end;
$$;

revoke all on function public.sync_ottawa_painters_customers()
  from public, anon, authenticated;
grant execute on function public.sync_ottawa_painters_customers()
  to service_role;

comment on function public.sync_ottawa_painters_customers() is
  'Synchronizes source Contacts, merges only exact canonical duplicates, and reconciles Activity identities in one locked transaction.';

-- Clean the existing exact duplicates and replay their identity links now.
select public.sync_ottawa_painters_customers();
