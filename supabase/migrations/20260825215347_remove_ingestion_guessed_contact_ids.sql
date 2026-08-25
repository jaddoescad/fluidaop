-- Gmail and Quo ingestion historically populated activities.contact_id by
-- taking the first source Contact with a matching email or phone. That is an
-- exact-identity guess, not authoritative provider evidence. Remove those
-- guesses and rebuild links through the deterministic Identity claim model.

alter table public.activities
  disable trigger activities_bump_signal_triage_revision;
alter table public.activities
  disable trigger activities_resolve_and_enqueue_signal_triage;

update public.activities
set contact_id = null
where source in ('gmail', 'quo')
  and contact_id is not null;

alter table public.activities
  enable trigger activities_bump_signal_triage_revision;
alter table public.activities
  enable trigger activities_resolve_and_enqueue_signal_triage;

delete from public.activity_people link
using public.activities activity
where activity.id = link.activity_id
  and activity.source in ('gmail', 'quo')
  and link.relationship = 'counterparty'
  and link.matched_by = 'contact_id';

create temporary table fluid_activity_claim_resolution
on commit drop
as
select ai.activity_id,
  min(claim.person_id::text)::uuid as person_id,
  count(distinct claim.person_id) as person_count
from public.activity_identities ai
join public.activities activity on activity.id = ai.activity_id
  and activity.source in ('gmail', 'quo')
join public.identities identity on identity.id = ai.identity_id
  and not identity.ignored
  and identity.classification <> 'system'
join public.person_identity_claims claim on claim.identity_id = ai.identity_id
  and claim.active
join public.people person on person.id = claim.person_id
  and person.status = 'active'
where ai.relationship in ('actor', 'provider')
group by ai.activity_id;

delete from public.activity_people link
using fluid_activity_claim_resolution resolution
where link.activity_id = resolution.activity_id
  and link.relationship = 'counterparty'
  and link.matched_by not in ('manual', 'provider_id')
  and (
    resolution.person_count > 1
    or link.person_id <> resolution.person_id
  );

insert into public.activity_people (
  activity_id, person_id, relationship, matched_by, confidence, updated_at
)
select resolution.activity_id, resolution.person_id,
  'counterparty', 'exact_identity', 1, now()
from fluid_activity_claim_resolution resolution
where resolution.person_count = 1
  and not exists (
    select 1
    from public.activity_people authoritative
    where authoritative.activity_id = resolution.activity_id
      and authoritative.relationship = 'counterparty'
      and authoritative.matched_by in ('manual', 'provider_id')
  )
on conflict (activity_id, person_id, relationship) do update
set matched_by = 'exact_identity',
    confidence = 1,
    updated_at = now();

insert into public.contact_suggestions (
  workspace_key, identity_id, suggestion_type, confidence, reason, evidence,
  updated_at
)
select identity.workspace_key, identity.id, 'conflict', 1,
  'This exact identifier is actively claimed by more than one Contact. Fluid will not guess.',
  jsonb_build_object(
    'personIds', jsonb_agg(distinct claim.person_id order by claim.person_id),
    'claimCount', count(distinct claim.person_id)
  ),
  now()
from public.identities identity
join public.person_identity_claims claim on claim.identity_id = identity.id
  and claim.active
join public.people person on person.id = claim.person_id
  and person.status = 'active'
where not identity.ignored
  and identity.classification <> 'system'
group by identity.workspace_key, identity.id
having count(distinct claim.person_id) > 1
on conflict (workspace_key, identity_id) where status = 'pending' do update
set suggestion_type = 'conflict',
    confidence = 1,
    reason = excluded.reason,
    evidence = excluded.evidence,
    updated_at = now();
