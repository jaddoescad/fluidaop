begin;

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'public.contacts',
    'public.employees',
    'public.leads',
    'public.jobs',
    'public.documents',
    'public.dripjobs_sales_deals'
  ]
  loop
    if to_regclass(relation_name) is null then
      raise exception 'clean replay root is missing: %', relation_name;
    end if;
  end loop;

  if to_regnamespace('private') is null then
    raise exception 'private schema is missing';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'Supabase local-stack dependency auth.users is missing';
  end if;
  if to_regprocedure('extensions.digest(text,text)') is null then
    raise exception 'Supabase local-stack dependency extensions.digest(text,text) is missing';
  end if;
  if to_regprocedure('private.is_manager()') is null then
    raise exception 'private.is_manager() is missing';
  end if;

  if to_regprocedure('public.sync_ottawa_painters_leads()') is null
     or to_regprocedure('public.read_lead_sync_status()') is null
     or to_regprocedure('public.read_case_reconciliation_queue_health()') is null
     or to_regprocedure('public.prune_case_reconciliation_jobs(integer,integer)') is null then
    raise exception 'a canonical database contract function is missing';
  end if;
end;
$$;

rollback;
