-- Resolve the populated Identity graph into existing Contacts without ever
-- guessing across a shared identifier, then seed low-priority triage work.

insert into public.person_identity_claims (
  workspace_key, person_id, identity_id, source_system, source_record_type,
  source_record_id, confidence, is_primary, active, first_seen_at, last_seen_at
)
select person.workspace_key, identifier.person_id, identity.id,
  identifier.source_system, identifier.source_record_type, identifier.source_record_id,
  1, identifier.is_primary, identifier.active, identifier.first_seen_at, identifier.last_seen_at
from public.person_identifiers identifier
join public.people person on person.id = identifier.person_id
join public.identities identity
  on identity.workspace_key = person.workspace_key
 and identity.kind = identifier.kind
 and identity.normalized_value = case
   when identifier.kind = 'email' then private.fluid_normalize_email(identifier.normalized_value)
   else private.fluid_normalize_phone(identifier.normalized_value)
 end
on conflict (person_id, identity_id, source_system, source_record_type, source_record_id)
do update set active = excluded.active, is_primary = excluded.is_primary,
  last_seen_at = excluded.last_seen_at, updated_at = now();

insert into public.person_identity_claims (
  workspace_key, person_id, identity_id, source_system, source_record_type,
  source_record_id, confidence, active, last_seen_at
)
select activity.workspace_key, source.person_id, ai.identity_id,
  'activity-contact', 'contact', activity.contact_id::text, 1, true, max(activity.occurred_at)
from public.activities activity
join public.person_sources source
  on source.source_system = 'ottawa-painters-admin'
 and source.source_record_type = 'contact'
 and source.source_record_id = activity.contact_id::text
join public.activity_identities ai on ai.activity_id = activity.id and ai.relationship = 'actor'
where activity.contact_id is not null
group by activity.workspace_key, source.person_id, ai.identity_id, activity.contact_id
on conflict (person_id, identity_id, source_system, source_record_type, source_record_id)
do update set active = true, confidence = 1,
  last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
  updated_at = now();

-- Existing links are retained only when they agree with the authoritative
-- source Contact or with one unambiguous, non-system exact Identity.
delete from public.activity_people link
using public.activities activity, public.person_sources source
where link.activity_id = activity.id
  and link.relationship = 'counterparty'
  and activity.contact_id is not null
  and source.source_system = 'ottawa-painters-admin'
  and source.source_record_type = 'contact'
  and source.source_record_id = activity.contact_id::text
  and link.person_id <> source.person_id;

with activity_claims as (
  select ai.activity_id, min(claim.person_id::text)::uuid person_id,
    count(distinct claim.person_id) person_count
  from public.activity_identities ai
  join public.identities identity on identity.id = ai.identity_id
    and not identity.ignored and identity.classification <> 'system'
  join public.person_identity_claims claim on claim.identity_id = ai.identity_id and claim.active
  join public.people person on person.id = claim.person_id and person.status = 'active'
  group by ai.activity_id
)
delete from public.activity_people link
using activity_claims claims
where link.activity_id = claims.activity_id
  and link.relationship = 'counterparty'
  and claims.person_count = 1
  and link.person_id <> claims.person_id
  and not exists (
    select 1
    from public.activities activity
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = activity.contact_id::text
    where activity.id = claims.activity_id
  );

with conflicted_activities as (
  select ai.activity_id
  from public.activity_identities ai
  join public.identities identity on identity.id = ai.identity_id
    and not identity.ignored and identity.classification <> 'system'
  join public.person_identity_claims claim on claim.identity_id = ai.identity_id and claim.active
  join public.people person on person.id = claim.person_id and person.status = 'active'
  group by ai.activity_id
  having count(distinct claim.person_id) > 1
), system_only_activities as (
  select ai.activity_id
  from public.activity_identities ai
  join public.identities identity on identity.id = ai.identity_id
  group by ai.activity_id
  having bool_and(identity.ignored or identity.classification = 'system')
)
delete from public.activity_people link
where link.relationship = 'counterparty'
  and (link.activity_id in (select activity_id from conflicted_activities)
    or link.activity_id in (select activity_id from system_only_activities))
  and not exists (
    select 1
    from public.activities activity
    join public.person_sources source
      on source.source_system = 'ottawa-painters-admin'
     and source.source_record_type = 'contact'
     and source.source_record_id = activity.contact_id::text
    where activity.id = link.activity_id
  );

insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
select activity.id, source.person_id, 'counterparty', 'contact_id', 1
from public.activities activity
join public.person_sources source
  on source.source_system = 'ottawa-painters-admin'
 and source.source_record_type = 'contact'
 and source.source_record_id = activity.contact_id::text
where activity.contact_id is not null
on conflict (activity_id, person_id, relationship) do update
set matched_by = 'contact_id', confidence = 1, updated_at = now();

with activity_claims as (
  select ai.activity_id, min(claim.person_id::text)::uuid person_id,
    count(distinct claim.person_id) person_count
  from public.activity_identities ai
  join public.identities identity on identity.id = ai.identity_id
    and not identity.ignored and identity.classification <> 'system'
  join public.person_identity_claims claim on claim.identity_id = ai.identity_id and claim.active
  join public.people person on person.id = claim.person_id and person.status = 'active'
  group by ai.activity_id
)
insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
select claims.activity_id, claims.person_id, 'counterparty', 'exact_identity', 1
from activity_claims claims
where claims.person_count = 1
  and not exists (
    select 1 from public.activity_people link
    where link.activity_id = claims.activity_id and link.matched_by = 'contact_id'
  )
on conflict (activity_id, person_id, relationship) do update
set matched_by = 'exact_identity', confidence = 1, updated_at = now();

insert into public.contact_suggestions (
  workspace_key, identity_id, suggestion_type, confidence, reason, evidence
)
select identity.workspace_key, identity.id, 'conflict', 1,
  'This exact identifier is actively claimed by more than one Contact. Fluid will not guess.',
  jsonb_build_object(
    'personIds', jsonb_agg(distinct claim.person_id order by claim.person_id),
    'claimCount', count(distinct claim.person_id)
  )
from public.identities identity
join public.person_identity_claims claim on claim.identity_id = identity.id and claim.active
where not identity.ignored and identity.classification <> 'system'
group by identity.workspace_key, identity.id
having count(distinct claim.person_id) > 1
on conflict (workspace_key, identity_id) where status = 'pending' do update
set suggestion_type = 'conflict', confidence = 1, reason = excluded.reason,
  evidence = excluded.evidence, updated_at = now();

insert into public.agent_jobs (
  workspace_key, agent_key, activity_id, input_revision, priority, queue_source
)
select activity.workspace_key, 'signal-triage', activity.id,
  activity.triage_revision, 10, 'backfill'
from public.activities activity
where activity.source in ('gmail', 'quo')
  and activity.event_type in ('email.received', 'email.sent', 'message.received', 'message.sent', 'call.completed')
  and activity.occurred_at >= now() - interval '30 days'
on conflict (agent_key, activity_id, input_revision) do nothing;
