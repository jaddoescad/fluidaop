-- A provider-specific Contact ID may resolve an individual Activity even when
-- the Activity's email or phone is shared by multiple Contacts. Keep those two
-- facts separate: the Activity link is authoritative, while the shared
-- Identity still requires an explicit conflict decision.

create or replace function private.preserve_shared_identity_conflict()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.suggestion_type = 'conflict'
    and new.status = 'dismissed'
    and (
      select count(distinct claim.person_id)
      from public.person_identity_claims claim
      join public.people person on person.id = claim.person_id
      where claim.identity_id = new.identity_id
        and claim.active
        and person.status = 'active'
    ) > 1
  then
    new.status := 'pending';
    new.resolved_action := null;
    new.resolved_person_id := null;
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists contact_suggestions_preserve_shared_conflict
  on public.contact_suggestions;
create trigger contact_suggestions_preserve_shared_conflict
before update of status on public.contact_suggestions
for each row execute function private.preserve_shared_identity_conflict();

update public.contact_suggestions suggestion
set status = 'pending',
    resolved_action = null,
    resolved_person_id = null,
    resolved_at = null,
    updated_at = now()
where suggestion.suggestion_type = 'conflict'
  and suggestion.status = 'dismissed'
  and (
    select count(distinct claim.person_id)
    from public.person_identity_claims claim
    join public.people person on person.id = claim.person_id
    where claim.identity_id = suggestion.identity_id
      and claim.active
      and person.status = 'active'
  ) > 1
  and not exists (
    select 1
    from public.contact_suggestions pending
    where pending.workspace_key = suggestion.workspace_key
      and pending.identity_id = suggestion.identity_id
      and pending.status = 'pending'
      and pending.id <> suggestion.id
  );

revoke all on function private.preserve_shared_identity_conflict()
from public, anon, authenticated;
grant execute on function private.preserve_shared_identity_conflict()
to service_role;

comment on function private.preserve_shared_identity_conflict() is
  'Prevents authoritative per-Activity source links from hiding an unresolved shared-Identity conflict.';
