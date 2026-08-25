-- Populate the provider-neutral identity graph after its schema, resolver,
-- and access controls are live. Every statement is safe to retry.

-- These expression indexes make the one-time backfill and future
-- reconciliation resolve each normalized actor with an indexed lookup.
create index activities_workspace_actor_email_identity_idx
  on public.activities (workspace_key, (private.fluid_normalize_email(actor_email)), id)
  where private.fluid_normalize_email(actor_email) is not null;

create index activities_workspace_actor_phone_identity_idx
  on public.activities (workspace_key, (private.fluid_normalize_phone(actor_phone)), id)
  where private.fluid_normalize_phone(actor_phone) is not null;

-- Backfill exact identities and claims using set-based, idempotent operations.
insert into public.identities (
  workspace_key, kind, normalized_value, display_value, display_name,
  classification, first_seen_at, last_seen_at
)
select activity.workspace_key, 'email', private.fluid_normalize_email(activity.actor_email),
  min(activity.actor_email), min(nullif(btrim(activity.actor_name), '')),
  case when private.fluid_email_is_system(private.fluid_normalize_email(activity.actor_email)) then 'system' else 'unknown' end,
  min(activity.occurred_at), max(activity.occurred_at)
from public.activities activity
where private.fluid_normalize_email(activity.actor_email) is not null
group by activity.workspace_key, private.fluid_normalize_email(activity.actor_email)
on conflict (workspace_key, kind, normalized_value) do update
set first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
    display_name = coalesce(public.identities.display_name, excluded.display_name),
    updated_at = now();

insert into public.identities (
  workspace_key, kind, normalized_value, display_value, display_name,
  first_seen_at, last_seen_at
)
select activity.workspace_key, 'phone', private.fluid_normalize_phone(activity.actor_phone),
  min(activity.actor_phone), min(nullif(btrim(activity.actor_name), '')),
  min(activity.occurred_at), max(activity.occurred_at)
from public.activities activity
where private.fluid_normalize_phone(activity.actor_phone) is not null
group by activity.workspace_key, private.fluid_normalize_phone(activity.actor_phone)
on conflict (workspace_key, kind, normalized_value) do update
set first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
    display_name = coalesce(public.identities.display_name, excluded.display_name),
    updated_at = now();

insert into public.activity_identities (activity_id, identity_id, relationship, source_system)
select activity.id, identity.id, 'actor', activity.source
from public.activities activity
join public.identities identity
  on identity.workspace_key = activity.workspace_key
 and identity.kind = 'email'
 and identity.normalized_value = private.fluid_normalize_email(activity.actor_email)
on conflict (activity_id, identity_id, relationship) do nothing;

insert into public.activity_identities (activity_id, identity_id, relationship, source_system)
select activity.id, identity.id, 'actor', activity.source
from public.activities activity
join public.identities identity
  on identity.workspace_key = activity.workspace_key
 and identity.kind = 'phone'
 and identity.normalized_value = private.fluid_normalize_phone(activity.actor_phone)
on conflict (activity_id, identity_id, relationship) do nothing;

insert into public.identities (
  workspace_key, kind, normalized_value, display_value, first_seen_at, last_seen_at
)
select person.workspace_key, identifier.kind,
  case when identifier.kind = 'email' then private.fluid_normalize_email(identifier.normalized_value)
       else private.fluid_normalize_phone(identifier.normalized_value) end,
  min(identifier.value), min(identifier.first_seen_at), max(identifier.last_seen_at)
from public.person_identifiers identifier
join public.people person on person.id = identifier.person_id
where identifier.active
  and case when identifier.kind = 'email' then private.fluid_normalize_email(identifier.normalized_value)
           else private.fluid_normalize_phone(identifier.normalized_value) end is not null
group by person.workspace_key, identifier.kind,
  case when identifier.kind = 'email' then private.fluid_normalize_email(identifier.normalized_value)
       else private.fluid_normalize_phone(identifier.normalized_value) end
on conflict (workspace_key, kind, normalized_value) do update
set first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
    updated_at = now();

-- Contact claims, historical Activity links, conflicts, and triage jobs are
-- populated in the following bounded migration.
