-- Split threaded and identity-linked resolution into separate planner paths.
-- The former OR-heavy query made a single Quo lookup scan most Activities.
create or replace function private.signal_has_later_outbound(p_activity_id bigint)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_selected public.activities%rowtype;
begin
  select * into v_selected
  from public.activities
  where id = p_activity_id;

  if not found or v_selected.direction <> 'inbound' then
    return false;
  end if;

  if v_selected.external_thread_id is not null then
    return exists (
      select 1
      from public.activities later
      where later.workspace_key = v_selected.workspace_key
        and later.source = v_selected.source
        and later.account_key = v_selected.account_key
        and later.external_thread_id = v_selected.external_thread_id
        and later.direction = 'outbound'
        and (
          later.occurred_at > v_selected.occurred_at
          or (later.occurred_at = v_selected.occurred_at and later.id > v_selected.id)
        )
      limit 1
    );
  end if;

  return exists (
    select 1
    from public.activity_people selected_link
    join public.activity_people later_link
      on later_link.person_id = selected_link.person_id
      and later_link.relationship = 'counterparty'
    join public.activities later on later.id = later_link.activity_id
    where selected_link.activity_id = v_selected.id
      and selected_link.relationship = 'counterparty'
      and later.workspace_key = v_selected.workspace_key
      and later.source = v_selected.source
      and later.account_key = v_selected.account_key
      and later.direction = 'outbound'
      and later.occurred_at <= v_selected.occurred_at + interval '7 days'
      and (
        later.occurred_at > v_selected.occurred_at
        or (later.occurred_at = v_selected.occurred_at and later.id > v_selected.id)
      )
    limit 1
  );
end;
$$;

revoke all on function private.signal_has_later_outbound(bigint)
  from public, anon, authenticated;
grant execute on function private.signal_has_later_outbound(bigint)
  to service_role;
