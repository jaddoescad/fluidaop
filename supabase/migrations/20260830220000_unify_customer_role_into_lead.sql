-- DripJobs calls these people leads; ottawa-painters-admin calls the same people
-- customers. Nobody reconciled the vocabulary, so every imported contact was
-- tagged twice and "Customer" became a strict subset of "Lead" — 1,233 people
-- held both and not one was customer-only.
--
-- Repoint the sync to assign 'lead' so the second word is not reinvented on the
-- next run, then remove the rows and the role definition. Only role_key literals
-- are rewritten; contact.kind = 'customer' is the source-side filter and stays.
do $unify$
declare
  src text;
  updated text;
begin
  select p.prosrc into strict src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'sync_ottawa_painters_customers_without_identity_dedupe';

  updated := regexp_replace(src, 'role_key(\s*)=(\s*)''customer''', 'role_key\1=\2''lead''', 'g');
  updated := regexp_replace(updated, '''customer'',(\s*)''ottawa-painters-admin''', '''lead'',\1''ottawa-painters-admin''');

  if updated = src then
    raise exception 'customer role literals not found; refusing to recreate unchanged';
  end if;
  if updated ~ 'role_key\s*=\s*''customer''' then
    raise exception 'a role_key = customer comparison survived the rewrite';
  end if;
  if updated ~ '''customer'',\s*''ottawa-painters-admin''' then
    raise exception 'the customer role insert survived the rewrite';
  end if;
  if (select count(*) from regexp_matches(updated, 'kind\s*=\s*''customer''', 'g'))
     <> (select count(*) from regexp_matches(src, 'kind\s*=\s*''customer''', 'g')) then
    raise exception 'contact.kind = customer filters were altered';
  end if;

  execute format(
    'create or replace function private.sync_ottawa_painters_customers_without_identity_dedupe() '
    'returns jsonb language plpgsql security definer set search_path = pg_catalog, public as %L',
    updated
  );
end
$unify$;

delete from public.person_roles where role_key = 'customer';

delete from public.contact_role_definitions
where workspace_key = 'ottawa-painters' and key = 'customer';
