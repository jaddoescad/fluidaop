-- Extend the existing evidence-preserving Contact merge so CRM deals move to
-- the survivor before a duplicate Contact is deleted. A trailing UI ellipsis
-- is ignored only when normalized name, email, and phone all agree.

create or replace function private.merge_duplicate_crm_contacts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  duplicate record;
  loser_snapshot jsonb;
  prepared_people integer := 0;
  moved_deals integer := 0;
  moved_for_person integer := 0;
  merge_result jsonb;
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
        first_value(eligible.display_name) over (
          partition by eligible.workspace_key, eligible.entity_type,
            eligible.normalized_name, eligible.normalized_email, eligible.normalized_phone
          order by eligible.created_at, eligible.id
        ) survivor_display_name,
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
      ranked.survivor_display_name,
      ranked.workspace_key,
      pg_catalog.concat_ws(
        '|', ranked.workspace_key, ranked.entity_type, ranked.normalized_name,
        ranked.normalized_email, ranked.normalized_phone
      ) identity_key
    from ranked
    where ranked.duplicate_rank > 1
    order by ranked.workspace_key, ranked.normalized_name, ranked.created_at, ranked.id
  loop
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

    if loser_snapshot is null then continue; end if;

    insert into private.person_merge_audit (
      loser_person_id, survivor_person_id, workspace_key, reason,
      identity_key, loser_snapshot
    ) values (
      duplicate.loser_person_id,
      duplicate.survivor_person_id,
      duplicate.workspace_key,
      'exact-customer-name-email-phone-normalized-trailing-punctuation',
      duplicate.identity_key,
      loser_snapshot
    )
    on conflict (loser_person_id) do nothing;

    -- Move stable source ownership first. The deal trigger intentionally trusts
    -- this mapping over a caller-supplied person_id.
    update public.person_sources source
    set person_id = duplicate.survivor_person_id,
        last_synced_at = now()
    where source.person_id = duplicate.loser_person_id;

    update public.dripjobs_sales_deals deal
    set person_id = duplicate.survivor_person_id,
        person_match_method = 'manual',
        person_linked_at = now()
    where deal.person_id = duplicate.loser_person_id;
    get diagnostics moved_for_person = row_count;
    moved_deals := moved_deals + moved_for_person;

    -- The original audited merge remains the single implementation that moves
    -- every other dependent record. Align only the presentation name so its
    -- exact-match guard can finish this already-proven duplicate.
    update public.people
    set display_name = duplicate.survivor_display_name,
        updated_at = now()
    where id = duplicate.loser_person_id;

    prepared_people := prepared_people + 1;
  end loop;

  merge_result := private.merge_exact_duplicate_customer_people();
  return merge_result || jsonb_build_object(
    'preparedPeople', prepared_people,
    'movedDeals', moved_deals
  );
end;
$$;

revoke all on function private.merge_duplicate_crm_contacts()
  from public, anon, authenticated;
grant execute on function private.merge_duplicate_crm_contacts()
  to service_role;

comment on function private.merge_duplicate_crm_contacts() is
  'Moves deals and merges only customer Contacts with equal canonical name, email, and phone; trailing UI ellipses are ignored.';

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

  merge_result := private.merge_duplicate_crm_contacts();
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
  'Synchronizes source Contacts, moves their deals, merges proven duplicates, and reconciles Activity identities in one locked transaction.';

select private.merge_duplicate_crm_contacts();
select private.reconcile_customer_identity_graph();
