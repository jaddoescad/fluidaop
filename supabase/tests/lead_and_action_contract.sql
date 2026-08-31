begin;

do $$
declare
  status_payload jsonb;
  old_wrapper_definition text;
  lead_definition text;
  public_sync_definition text;
begin
  if exists (
    select 1
    from public.person_roles
    where role_key = 'customer'
  ) then
    raise exception 'legacy customer role rows survived lead-role consolidation';
  end if;

  if exists (
    select 1
    from public.contact_role_definitions
    where workspace_key = 'ottawa-painters'
      and key = 'customer'
  ) then
    raise exception 'legacy customer role definition survived lead-role consolidation';
  end if;

  if exists (
    select 1
    from public.contacts contact
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = contact.id::text
    left join public.person_roles role
      on role.person_id = source.person_id
     and role.role_key = 'lead'
     and role.source_system = 'ottawa-painters-admin'
     and role.source_record_type = 'contact'
     and role.source_record_id = contact.id::text
     and role.active
    where contact.kind = 'customer'
      and role.person_id is null
  ) then
    raise exception 'a mapped source lead is missing its canonical lead role';
  end if;

  select pg_get_functiondef(to_regprocedure(
    'private.sync_ottawa_painters_leads_without_identity_dedupe()'
  )) into lead_definition;

  if lead_definition is null
     or lead_definition !~ 'role_key[[:space:]]*=[[:space:]]*''lead'''
     or lead_definition ~ 'role_key[[:space:]]*=[[:space:]]*''customer''' then
    raise exception 'canonical lead sync does not assign only the lead role';
  end if;

  select pg_get_functiondef(to_regprocedure(
    'private.sync_ottawa_painters_customers_without_identity_dedupe()'
  )) into old_wrapper_definition;

  if old_wrapper_definition is null
     or old_wrapper_definition !~ 'sync_ottawa_painters_leads_without_identity_dedupe'
     or old_wrapper_definition ~ 'regexp_replace' then
    raise exception 'legacy sync entry point is not a simple canonical lead wrapper';
  end if;

  select pg_get_functiondef(to_regprocedure(
    'public.sync_ottawa_painters_leads()'
  )) into public_sync_definition;

  if public_sync_definition is null
     or public_sync_definition !~ 'read_lead_sync_counts'
     or public_sync_definition !~ '''syncedLeads'''
     or public_sync_definition !~ '''pendingLeads'''
     or public_sync_definition !~ '''staleLeadRoles''' then
    raise exception 'successful lead sync does not return canonical post-run counts';
  end if;

  status_payload := public.read_lead_sync_status();
  if not status_payload ?& array[
    'agentKey',
    'sourceLeads',
    'syncedLeads',
    'pendingLeads',
    'staleLeadRoles'
  ] then
    raise exception 'lead status is missing canonical keys: %', status_payload;
  end if;
  if status_payload->>'agentKey' <> 'lead-sync'
     or status_payload ?| array[
       'sourceCustomers',
       'syncedCustomers',
       'pendingCustomers',
       'staleCustomerRoles'
     ] then
    raise exception 'lead status leaked retired customer vocabulary: %', status_payload;
  end if;

  if (
    select count(*)
    from public.action_definitions
    where workspace_key = 'ottawa-painters'
      and built_in
      and enabled
  ) <> 1 then
    raise exception 'expected exactly one enabled built-in Action definition';
  end if;

  if not exists (
    select 1
    from public.action_definitions
    where workspace_key = 'ottawa-painters'
      and key = 'draft-email-to-customer'
      and handler_key = 'draft-email-reply'
      and enabled
      and built_in
      and execution_mode = 'simulation'
      and requires_confirmation
  ) then
    raise exception 'supported draft-email Action definition is missing or misconfigured';
  end if;

  if exists (
    select 1
    from public.action_definitions
    where workspace_key = 'ottawa-painters'
      and key in ('draft-sms-reply', 'create-follow-up-reminder', 'create-internal-task')
  ) then
    raise exception 'retired placeholder Action definitions were resurrected';
  end if;

  if exists (
    select 1
    from public.action_instances instance
    join public.action_definitions definition
      on definition.id = instance.action_definition_id
    where definition.workspace_key = 'ottawa-painters'
      and definition.key = 'draft-email-to-customer'
  ) or exists (
    select 1
    from public.signal_recommendations recommendation
    join public.action_definitions definition
      on definition.id = recommendation.action_definition_id
    where definition.workspace_key = 'ottawa-painters'
      and definition.key = 'draft-email-to-customer'
  ) then
    raise exception 'Action seed recreated historical instances or recommendations';
  end if;
end;
$$;

rollback;
