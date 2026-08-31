-- Potential Leads now have an independent classifier and no longer extend the
-- historical Signal Triage completion contract.

alter table public.lead_candidates
  alter column agent_key set default 'potential-lead-classifier';

comment on column public.lead_candidates.agent_key is
  'Classifier that produced the candidate. New candidates come from potential-lead-classifier.';

alter table public.activities
  add column potential_lead_revision integer not null default 1,
  add constraint activities_potential_lead_revision_check
    check (potential_lead_revision > 0);

comment on column public.activities.potential_lead_revision is
  'Independent input revision consumed only by Potential Lead Classifier jobs.';

-- One authoritative eligibility decision is shared by enqueue, claim, complete,
-- and reconciliation. The worker can recommend a verdict, but cannot bypass
-- these database rules or invent a reachable identity.
create or replace function private.potential_lead_classifier_eligibility(
  p_workspace_key text,
  p_activity_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.lead_candidate_settings%rowtype;
  v_activity public.activities%rowtype;
  v_email text;
  v_phone text;
begin
  select * into v_settings
  from public.lead_candidate_settings
  where workspace_key = p_workspace_key;
  if not found or not v_settings.enabled then
    return jsonb_build_object('eligible', false, 'reason', 'disabled');
  end if;

  select * into v_activity
  from public.activities
  where id = p_activity_id and workspace_key = p_workspace_key;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'unknown-signal');
  end if;
  if v_activity.occurred_at < v_settings.started_at then
    return jsonb_build_object('eligible', false, 'reason', 'before-start');
  end if;
  if v_activity.source not in ('gmail', 'quo') then
    return jsonb_build_object('eligible', false, 'reason', 'unsupported-source');
  end if;
  if v_activity.direction <> 'inbound' then
    return jsonb_build_object('eligible', false, 'reason', 'not-inbound');
  end if;
  if v_activity.event_type not in ('email.received', 'message.received', 'call.completed') then
    return jsonb_build_object('eligible', false, 'reason', 'unsupported-event');
  end if;
  if lower(coalesce(v_activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes') then
    return jsonb_build_object('eligible', false, 'reason', 'automated');
  end if;

  select identity.normalized_value into v_email
  from public.activity_identities link
  join public.identities identity on identity.id = link.identity_id
  where link.activity_id = v_activity.id
    and link.relationship = 'actor'
    and identity.kind = 'email'
  order by identity.id
  limit 1;
  select identity.normalized_value into v_phone
  from public.activity_identities link
  join public.identities identity on identity.id = link.identity_id
  where link.activity_id = v_activity.id
    and link.relationship = 'actor'
    and identity.kind = 'phone'
  order by identity.id
  limit 1;
  v_email := coalesce(
    private.fluid_normalize_email(v_email),
    private.fluid_normalize_email(v_activity.actor_email),
    private.fluid_normalize_email(v_activity.from_email)
  );
  v_phone := coalesce(
    private.fluid_normalize_phone(v_phone),
    private.fluid_normalize_phone(v_activity.actor_phone),
    private.fluid_normalize_phone(v_activity.from_phone)
  );

  if (v_email is not null and private.fluid_email_is_system(v_email)) or exists (
    select 1
    from public.activity_identities link
    join public.identities identity on identity.id = link.identity_id
    where link.activity_id = v_activity.id
      and link.relationship = 'actor'
      and (identity.ignored or identity.classification = 'system')
  ) or exists (
    select 1
    from public.identities identity
    where identity.workspace_key = v_activity.workspace_key
      and (
        (identity.kind = 'email' and identity.normalized_value = v_email)
        or (identity.kind = 'phone' and identity.normalized_value = v_phone)
      )
      and (identity.ignored or identity.classification = 'system')
  ) then
    return jsonb_build_object('eligible', false, 'reason', 'system-identity');
  end if;
  if exists (
    select 1
    from public.activity_people link
    join public.people person on person.id = link.person_id
    where link.activity_id = v_activity.id
      and link.relationship = 'counterparty'
      and person.status = 'active'
  ) or exists (
    select 1
    from public.activity_identities link
    join public.person_identity_claims claim
      on claim.identity_id = link.identity_id and claim.active
    join public.people person
      on person.id = claim.person_id and person.status = 'active'
    where link.activity_id = v_activity.id
      and link.relationship = 'actor'
  ) or exists (
    select 1
    from public.identities identity
    join public.person_identity_claims claim
      on claim.identity_id = identity.id and claim.active
    join public.people person
      on person.id = claim.person_id and person.status = 'active'
    where identity.workspace_key = v_activity.workspace_key
      and (
        (identity.kind = 'email' and identity.normalized_value = v_email)
        or (identity.kind = 'phone' and identity.normalized_value = v_phone)
      )
  ) then
    return jsonb_build_object('eligible', false, 'reason', 'known-contact');
  end if;
  if v_email is null and v_phone is null then
    return jsonb_build_object('eligible', false, 'reason', 'unreachable');
  end if;

  return jsonb_build_object(
    'eligible', true,
    'reason', 'eligible',
    'name', nullif(btrim(coalesce(v_activity.actor_name, '')), ''),
    'email', v_email,
    'phone', v_phone
  );
end;
$$;

revoke all on function private.potential_lead_classifier_eligibility(text, bigint)
from public, anon, authenticated;
grant execute on function private.potential_lead_classifier_eligibility(text, bigint)
to service_role;

create or replace function public.record_lead_candidate(
  p_workspace_key text,
  p_activity_id bigint,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text,
  p_summary text,
  p_reason text,
  p_confidence numeric,
  p_agent_run_id uuid,
  p_model text,
  p_prompt_version text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_eligibility jsonb;
  v_id bigint;
  v_inserted boolean;
begin
  v_eligibility := private.potential_lead_classifier_eligibility(p_workspace_key, p_activity_id);
  if not coalesce((v_eligibility ->> 'eligible')::boolean, false) then
    return jsonb_build_object('recorded', false, 'skipped', v_eligibility ->> 'reason');
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'confidence must be between 0 and 1';
  end if;
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(p_evidence, '{}'::jsonb)) > 2097152
  then
    raise exception 'invalid evidence';
  end if;

  select * into strict v_activity
  from public.activities
  where id = p_activity_id and workspace_key = p_workspace_key;

  insert into public.lead_candidates (
    workspace_key, activity_id, person_id, contact_name, contact_email, contact_phone,
    channel, summary, reason, confidence, agent_key, agent_run_id, model,
    prompt_version, evidence
  ) values (
    p_workspace_key, p_activity_id, null,
    coalesce(
      nullif(left(btrim(coalesce(p_contact_name, '')), 300), ''),
      v_eligibility ->> 'name'
    ),
    v_eligibility ->> 'email',
    v_eligibility ->> 'phone',
    coalesce(nullif(btrim(v_activity.event_type), ''), 'unknown'),
    left(coalesce(nullif(btrim(coalesce(p_summary, '')), ''), v_activity.preview, v_activity.subject, ''), 2000),
    left(coalesce(p_reason, ''), 2000),
    p_confidence,
    'potential-lead-classifier',
    p_agent_run_id,
    left(coalesce(p_model, ''), 200),
    left(coalesce(p_prompt_version, ''), 100),
    coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (workspace_key, activity_id) do update
  set contact_name = excluded.contact_name,
      contact_email = excluded.contact_email,
      contact_phone = excluded.contact_phone,
      summary = excluded.summary,
      reason = excluded.reason,
      confidence = excluded.confidence,
      agent_key = excluded.agent_key,
      agent_run_id = excluded.agent_run_id,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      evidence = excluded.evidence,
      updated_at = now()
  returning id, (xmax = 0) into v_id, v_inserted;

  return jsonb_build_object('recorded', true, 'id', v_id, 'created', v_inserted);
end;
$$;

comment on function public.record_lead_candidate(
  text, bigint, text, text, text, text, text, numeric, uuid, text, text, jsonb
) is 'Records a Potential Lead only after the dedicated database eligibility gate accepts its signal.';

revoke all on function public.record_lead_candidate(
  text, bigint, text, text, text, text, text, numeric, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_lead_candidate(
  text, bigint, text, text, text, text, text, numeric, uuid, text, text, jsonb
) to service_role;

-- The classifier owns its revision clock; changing classifier eligibility or
-- evidence cannot collide with, or depend on, Signal Triage revisions.
create or replace function private.bump_activity_potential_lead_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(
    new.actor_name, new.actor_email, new.actor_phone, new.from_email,
    new.from_phone, new.body_text, new.preview, new.subject, new.call_status,
    new.duration_seconds, new.has_attachments, new.attachment_count,
    new.contact_id, new.direction, new.event_type, new.source_metadata
  ) is distinct from row(
    old.actor_name, old.actor_email, old.actor_phone, old.from_email,
    old.from_phone, old.body_text, old.preview, old.subject, old.call_status,
    old.duration_seconds, old.has_attachments, old.attachment_count,
    old.contact_id, old.direction, old.event_type, old.source_metadata
  ) then
    new.potential_lead_revision := old.potential_lead_revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_bump_potential_lead_revision on public.activities;
create trigger activities_bump_potential_lead_revision
before update of actor_name, actor_email, actor_phone, from_email, from_phone,
  body_text, preview, subject, call_status, duration_seconds, has_attachments,
  attachment_count, contact_id, direction, event_type, source_metadata
on public.activities
for each row execute function private.bump_activity_potential_lead_revision();

revoke all on function private.bump_activity_potential_lead_revision()
from public, anon, authenticated;
grant execute on function private.bump_activity_potential_lead_revision()
to service_role;

-- Enqueue future material activity changes on the dedicated branch.
create or replace function private.enqueue_potential_lead_classifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material_change boolean := true;
  v_eligibility jsonb;
begin
  if tg_op = 'UPDATE' then
    v_material_change := row(
      new.actor_name, new.actor_email, new.actor_phone, new.from_email,
      new.from_phone, new.body_text, new.preview, new.subject, new.call_status,
      new.duration_seconds, new.has_attachments, new.attachment_count,
      new.contact_id, new.direction, new.event_type, new.source_metadata
    ) is distinct from row(
      old.actor_name, old.actor_email, old.actor_phone, old.from_email,
      old.from_phone, old.body_text, old.preview, old.subject, old.call_status,
      old.duration_seconds, old.has_attachments, old.attachment_count,
      old.contact_id, old.direction, old.event_type, old.source_metadata
    );
  end if;
  if not v_material_change then return new; end if;

  v_eligibility := private.potential_lead_classifier_eligibility(new.workspace_key, new.id);
  if coalesce((v_eligibility ->> 'eligible')::boolean, false) then
    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    ) values (
      new.workspace_key, 'potential-lead-classifier', new.id,
      new.potential_lead_revision, 100, 'live'
    )
    on conflict (agent_key, activity_id, input_revision) do nothing;
  else
    update public.agent_jobs
    set status = 'succeeded', finished_at = now(),
        last_error = left('Skipped: ' || coalesce(v_eligibility ->> 'reason', 'ineligible'), 2000),
        lease_owner = null, lease_token = null, leased_until = null, updated_at = now()
    where agent_key = 'potential-lead-classifier'
      and activity_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists activities_enqueue_potential_lead_classifier on public.activities;
create trigger activities_enqueue_potential_lead_classifier
after insert or update of actor_name, actor_email, actor_phone, from_email, from_phone,
  body_text, preview, subject, call_status, duration_seconds, has_attachments,
  attachment_count, contact_id, direction, event_type, source_metadata
on public.activities
for each row execute function private.enqueue_potential_lead_classifier();

revoke all on function private.enqueue_potential_lead_classifier()
from public, anon, authenticated;
grant execute on function private.enqueue_potential_lead_classifier()
to service_role;

-- Quo writes summaries and transcripts after the call Activity. A late piece
-- of evidence receives its own classifier revision and job so an early verdict
-- cannot permanently miss the call's content.
create or replace function private.enqueue_potential_lead_classifier_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_eligibility jsonb;
begin
  if tg_op = 'UPDATE' and (
    to_jsonb(new) - array[
      'updated_at', 'fetched_at', 'last_attempted_at', 'attempt_count',
      'next_retry_at', 'last_http_status'
    ]::text[]
  ) is not distinct from (
    to_jsonb(old) - array[
      'updated_at', 'fetched_at', 'last_attempted_at', 'attempt_count',
      'next_retry_at', 'last_http_status'
    ]::text[]
  ) then
    return new;
  end if;

  update public.activities
  set potential_lead_revision = potential_lead_revision + 1
  where id = new.activity_id
  returning * into v_activity;
  if not found then return new; end if;

  v_eligibility := private.potential_lead_classifier_eligibility(
    v_activity.workspace_key, v_activity.id
  );
  if coalesce((v_eligibility ->> 'eligible')::boolean, false) then
    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    ) values (
      v_activity.workspace_key, 'potential-lead-classifier', v_activity.id,
      v_activity.potential_lead_revision, 100, 'live'
    )
    on conflict (agent_key, activity_id, input_revision) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists activity_call_summaries_enqueue_potential_lead_classifier
on public.activity_call_summaries;
create trigger activity_call_summaries_enqueue_potential_lead_classifier
after insert or update on public.activity_call_summaries
for each row execute function private.enqueue_potential_lead_classifier_evidence();

drop trigger if exists activity_call_transcripts_enqueue_potential_lead_classifier
on public.activity_call_transcripts;
create trigger activity_call_transcripts_enqueue_potential_lead_classifier
after insert or update on public.activity_call_transcripts
for each row execute function private.enqueue_potential_lead_classifier_evidence();

revoke all on function private.enqueue_potential_lead_classifier_evidence()
from public, anon, authenticated;
grant execute on function private.enqueue_potential_lead_classifier_evidence()
to service_role;

-- Catch up the feature window that opened in lead_candidate_settings before
-- this corrective migration. The eligibility gate still makes anything older
-- than started_at impossible to enqueue, so this is not historical backfill.
insert into public.agent_jobs (
  workspace_key, agent_key, activity_id, input_revision, priority, queue_source
)
select activity.workspace_key, 'potential-lead-classifier', activity.id,
  activity.potential_lead_revision, 100, 'reconcile'
from public.activities activity
join public.lead_candidate_settings settings
  on settings.workspace_key = activity.workspace_key and settings.enabled
where activity.occurred_at >= settings.started_at
  and coalesce((
    private.potential_lead_classifier_eligibility(activity.workspace_key, activity.id) ->> 'eligible'
  )::boolean, false)
on conflict (agent_key, activity_id, input_revision) do nothing;

create or replace function private.potential_lead_classifier_payload(p_job_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_signal jsonb;
  v_identities jsonb;
  v_attachments jsonb;
  v_summary jsonb;
  v_transcript jsonb;
  v_eligibility jsonb;
begin
  select * into v_job
  from public.agent_jobs
  where id = p_job_id and agent_key = 'potential-lead-classifier';
  if not found then raise exception 'Potential Lead classifier job was not found'; end if;

  v_eligibility := private.potential_lead_classifier_eligibility(
    v_job.workspace_key, v_job.activity_id
  );

  select jsonb_build_object(
    'id', activity.id,
    'workspaceKey', activity.workspace_key,
    'source', activity.source,
    'accountEmail', activity.account_email,
    'externalId', activity.external_id,
    'externalThreadId', activity.external_thread_id,
    'eventType', activity.event_type,
    'direction', activity.direction,
    'actorName', activity.actor_name,
    'actorEmail', activity.actor_email,
    'actorPhone', activity.actor_phone,
    'subject', left(activity.subject, 1000),
    'preview', left(activity.preview, 4000),
    'bodyText', left(coalesce(activity.body_text, ''), 20000),
    'occurredAt', activity.occurred_at,
    'hasAttachments', activity.has_attachments,
    'attachmentCount', activity.attachment_count,
    'callStatus', activity.call_status,
    'durationSeconds', activity.duration_seconds
  ) into v_signal
  from public.activities activity
  where activity.id = v_job.activity_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', identity.kind,
    'value', identity.display_value,
    'normalizedValue', identity.normalized_value,
    'displayName', identity.display_name,
    'classification', identity.classification,
    'ignored', identity.ignored,
    'activeClaimCount', (
      select count(*)::int
      from public.person_identity_claims claim
      join public.people person on person.id = claim.person_id and person.status = 'active'
      where claim.identity_id = identity.id and claim.active
    )
  ) order by identity.kind, identity.id), '[]'::jsonb)
  into v_identities
  from public.identities identity
  where identity.workspace_key = v_job.workspace_key
    and (
      exists (
        select 1 from public.activity_identities link
        where link.activity_id = v_job.activity_id
          and link.relationship = 'actor'
          and link.identity_id = identity.id
      )
      or (identity.kind = 'email' and identity.normalized_value = (v_eligibility ->> 'email'))
      or (identity.kind = 'phone' and identity.normalized_value = (v_eligibility ->> 'phone'))
    );

  select coalesce(jsonb_agg(to_jsonb(item) order by item.updated_at desc), '[]'::jsonb)
  into v_attachments
  from (
    select evidence.attachment_key as "attachmentKey",
      evidence.filename,
      evidence.mime_type as "mimeType",
      evidence.extraction_status as status,
      left(coalesce(evidence.extracted_text, ''), 20000) as "extractedText",
      evidence.updated_at
    from public.signal_attachment_evidence evidence
    where evidence.activity_id = v_job.activity_id
    order by evidence.updated_at desc, evidence.id desc
    limit 10
  ) item;

  select case when summary.status = 'available' then jsonb_build_object(
    'status', summary.status,
    'summary', (
      select coalesce(jsonb_agg(
        case
          when jsonb_typeof(item.value) = 'string'
            then to_jsonb(left(item.value #>> '{}', 4000))
          when pg_column_size(item.value) <= 4096 then item.value
          else jsonb_build_object('truncated', left(item.value::text, 4000))
        end order by item.ordinality
      ), '[]'::jsonb)
      from jsonb_array_elements(summary.summary) with ordinality item(value, ordinality)
      where item.ordinality <= 20
    ),
    'nextSteps', (
      select coalesce(jsonb_agg(
        case
          when jsonb_typeof(item.value) = 'string'
            then to_jsonb(left(item.value #>> '{}', 4000))
          when pg_column_size(item.value) <= 4096 then item.value
          else jsonb_build_object('truncated', left(item.value::text, 4000))
        end order by item.ordinality
      ), '[]'::jsonb)
      from jsonb_array_elements(summary.next_steps) with ordinality item(value, ordinality)
      where item.ordinality <= 20
    )
  ) else null end
  into v_summary
  from public.activity_call_summaries summary
  where summary.activity_id = v_job.activity_id;

  select jsonb_build_object(
    'status', transcript.status,
    'text', left(coalesce(transcript.transcript_text, ''), 20000),
    'dialogue', case when pg_column_size(transcript.dialogue) <= 131072
      then transcript.dialogue else '[]'::jsonb end
  ) into v_transcript
  from public.activity_call_transcripts transcript
  where transcript.activity_id = v_job.activity_id;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'activityId', v_job.activity_id,
      'inputRevision', v_job.input_revision,
      'leaseToken', v_job.lease_token,
      'attempt', v_job.attempts,
      'leasedUntil', v_job.leased_until
    ),
    'signal', v_signal,
    'identities', v_identities,
    'attachments', v_attachments,
    'callSummary', v_summary,
    'transcript', v_transcript,
    'eligibility', v_eligibility,
    'contract', jsonb_build_object(
      'allowedVerdicts', jsonb_build_array('lead', 'not_lead'),
      'databaseEligibilityAuthoritative', true,
      'historicalBackfill', false
    )
  );
end;
$$;

revoke all on function private.potential_lead_classifier_payload(bigint)
from public, anon, authenticated;
grant execute on function private.potential_lead_classifier_payload(bigint)
to service_role;

create or replace function public.claim_potential_lead_classifier_job(
  p_worker text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then
    raise exception 'worker must be between 1 and 100 characters';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception 'lease seconds must be between 60 and 3600';
  end if;

  update public.agent_jobs job
  set status = 'succeeded', finished_at = v_now,
      last_error = 'Superseded by a newer Potential Lead input revision.',
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  from public.activities activity
  where job.agent_key = 'potential-lead-classifier'
    and job.activity_id = activity.id
    and job.status in ('pending', 'leased')
    and job.input_revision < activity.potential_lead_revision;

  update public.agent_jobs
  set status = 'pending', available_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where agent_key = 'potential-lead-classifier'
    and status = 'leased' and leased_until < v_now;

  update public.agent_jobs job
  set status = 'succeeded', finished_at = v_now,
      last_error = left(
        'Skipped: ' || coalesce(
          private.potential_lead_classifier_eligibility(job.workspace_key, job.activity_id) ->> 'reason',
          'ineligible'
        ),
        2000
      ),
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where job.agent_key = 'potential-lead-classifier'
    and job.status = 'pending'
    and not coalesce((
      private.potential_lead_classifier_eligibility(job.workspace_key, job.activity_id) ->> 'eligible'
    )::boolean, false);

  select job.* into v_job
  from public.agent_jobs job
  join public.activities activity on activity.id = job.activity_id
  where job.agent_key = 'potential-lead-classifier'
    and job.status = 'pending'
    and job.available_at <= v_now
    and job.input_revision = activity.potential_lead_revision
    and coalesce((
      private.potential_lead_classifier_eligibility(job.workspace_key, job.activity_id) ->> 'eligible'
    )::boolean, false)
  order by job.priority desc, job.available_at, job.id
  for update of job skip locked
  limit 1;

  if not found then return jsonb_build_object('job', null); end if;

  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, claimed_at = v_now,
      lease_owner = btrim(p_worker), lease_token = gen_random_uuid(),
      leased_until = v_now + make_interval(secs => p_lease_seconds),
      last_error = null, updated_at = v_now
  where id = v_job.id
  returning * into v_job;

  return private.potential_lead_classifier_payload(v_job.id);
end;
$$;

create or replace function public.inspect_potential_lead_classifier_job(
  p_job_id bigint,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.agent_jobs job
    join public.activities activity on activity.id = job.activity_id
    where job.id = p_job_id
      and job.agent_key = 'potential-lead-classifier'
      and job.status = 'leased'
      and job.lease_token = p_lease_token
      and job.leased_until >= now()
      and job.input_revision = activity.potential_lead_revision
  ) then
    raise exception 'job lease is no longer valid';
  end if;
  return private.potential_lead_classifier_payload(p_job_id);
end;
$$;

create or replace function public.complete_potential_lead_classifier_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_verdict text,
  p_confidence numeric,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text,
  p_summary text,
  p_reason text,
  p_model text,
  p_prompt_version text,
  p_evidence jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_run_id uuid;
  v_candidate jsonb;
  v_run_evidence jsonb;
  v_eligibility jsonb;
  v_removed integer := 0;
  v_current_revision integer;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required';
  end if;
  if p_verdict not in ('lead', 'not_lead') then
    raise exception 'verdict must be lead or not_lead';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception 'confidence must be between 0 and 1';
  end if;
  if p_contact_name is not null and char_length(p_contact_name) > 300 then raise exception 'invalid contact name'; end if;
  if p_contact_email is not null and char_length(p_contact_email) > 320 then raise exception 'invalid contact email'; end if;
  if p_contact_phone is not null and char_length(p_contact_phone) > 40 then raise exception 'invalid contact phone'; end if;
  if p_summary is not null and char_length(p_summary) > 2000 then raise exception 'invalid summary'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 2000 then raise exception 'invalid reason'; end if;
  if p_model is not null and char_length(p_model) > 200 then raise exception 'invalid model'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(p_evidence, '{}'::jsonb)) > 1048576
  then raise exception 'invalid evidence'; end if;

  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'potential-lead-classifier'
    or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
    or v_job.leased_until < v_now
  then raise exception 'job lease is no longer valid'; end if;

  select potential_lead_revision into v_current_revision
  from public.activities where id = v_job.activity_id;
  if v_current_revision is distinct from v_job.input_revision then
    update public.agent_jobs
    set status = 'succeeded', finished_at = v_now,
        last_error = 'Superseded by a newer Potential Lead input revision.',
        lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
    where id = v_job.id;
    return jsonb_build_object(
      'jobId', v_job.id,
      'activityId', v_job.activity_id,
      'inputRevision', v_job.input_revision,
      'status', 'superseded'
    );
  end if;

  v_eligibility := private.potential_lead_classifier_eligibility(
    v_job.workspace_key, v_job.activity_id
  );

  v_run_evidence := jsonb_build_object(
    'verdict', p_verdict,
    'confidence', p_confidence,
    'name', nullif(btrim(coalesce(p_contact_name, '')), ''),
    'email', nullif(lower(btrim(coalesce(p_contact_email, ''))), ''),
    'phone', nullif(btrim(coalesce(p_contact_phone, '')), ''),
    'summary', nullif(btrim(coalesce(p_summary, '')), ''),
    'reason', btrim(p_reason),
    'classifierEvidence', coalesce(p_evidence, '{}'::jsonb)
  );

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model,
    prompt_version, evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision,
    'completed', nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    v_run_evidence, coalesce(v_job.claimed_at, v_now), v_now
  ) returning id into v_run_id;

  if p_verdict = 'lead' then
    v_candidate := public.record_lead_candidate(
      v_job.workspace_key,
      v_job.activity_id,
      p_contact_name,
      p_contact_email,
      p_contact_phone,
      p_summary,
      p_reason,
      p_confidence,
      v_run_id,
      p_model,
      p_prompt_version,
      v_run_evidence
    );
  else
    -- A newer classifier revision may retract its own undecided candidate, but
    -- it never erases a human decision. A CRM claim that lands during the
    -- lease also preserves the row as audit; the read model hides it instead.
    if v_eligibility ->> 'reason' is distinct from 'known-contact' then
      delete from public.lead_candidates
      where workspace_key = v_job.workspace_key
        and activity_id = v_job.activity_id
        and disposition = 'undecided';
      get diagnostics v_removed = row_count;
    end if;
    v_candidate := jsonb_build_object(
      'recorded', false,
      'verdict', 'not_lead',
      'removedUndecided', v_removed > 0,
      'skipped', case when v_eligibility ->> 'reason' = 'known-contact'
        then 'known-contact' else null end
    );
  end if;

  update public.agent_jobs
  set status = 'succeeded', lease_owner = null, lease_token = null,
      leased_until = null, last_error = null, finished_at = v_now, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id,
    'activityId', v_job.activity_id,
    'inputRevision', v_job.input_revision,
    'runId', v_run_id,
    'verdict', p_verdict,
    'leadCandidate', v_candidate
  );
end;
$$;

create or replace function public.fail_potential_lead_classifier_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error text,
  p_model text,
  p_prompt_version text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_terminal boolean;
  v_now timestamptz := now();
begin
  if p_error is null or char_length(btrim(p_error)) not between 1 and 2000 then raise exception 'invalid error'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'potential-lead-classifier'
    or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
  then raise exception 'job lease is no longer valid'; end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model,
    prompt_version, error, evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision, 'failed',
    nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    left(btrim(p_error), 2000), '{}'::jsonb, coalesce(v_job.claimed_at, v_now), v_now
  );

  v_terminal := v_job.attempts >= 5;
  update public.agent_jobs
  set status = case when v_terminal then 'failed' else 'pending' end,
      available_at = case when v_terminal then available_at
        else v_now + make_interval(secs => least(3600, 30 * (2 ^ greatest(attempts - 1, 0))::integer)) end,
      lease_owner = null, lease_token = null, leased_until = null,
      last_error = left(btrim(p_error), 2000),
      finished_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id,
    'activityId', v_job.activity_id,
    'inputRevision', v_job.input_revision,
    'status', case when v_terminal then 'failed' else 'pending' end,
    'attempt', v_job.attempts
  );
end;
$$;

create or replace function public.reconcile_potential_lead_classifier(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 500
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_expired integer := 0;
  v_skipped integer := 0;
  v_enqueued integer := 0;
  v_started_at timestamptz;
  v_activity_id bigint;
begin
  if p_limit not between 1 and 5000 then raise exception 'limit must be between 1 and 5000'; end if;
  if not pg_try_advisory_xact_lock(hashtext('fluid:potential-lead-classifier:' || p_workspace_key)) then
    return jsonb_build_object('status', 'skipped', 'reason', 'already-running');
  end if;

  select started_at into v_started_at
  from public.lead_candidate_settings
  where workspace_key = p_workspace_key and enabled;
  if v_started_at is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'disabled');
  end if;

  update public.agent_jobs
  set status = 'pending', available_at = now(),
      lease_owner = null, lease_token = null, leased_until = null, updated_at = now()
  where workspace_key = p_workspace_key
    and agent_key = 'potential-lead-classifier'
    and status = 'leased' and leased_until < now();
  get diagnostics v_expired = row_count;

  update public.agent_jobs job
  set status = 'succeeded', finished_at = now(),
      last_error = left(
        'Skipped: ' || coalesce(
          private.potential_lead_classifier_eligibility(job.workspace_key, job.activity_id) ->> 'reason',
          'ineligible'
        ),
        2000
      ),
      lease_owner = null, lease_token = null, leased_until = null, updated_at = now()
  where job.workspace_key = p_workspace_key
    and job.agent_key = 'potential-lead-classifier'
    and job.status = 'pending'
    and not coalesce((
      private.potential_lead_classifier_eligibility(job.workspace_key, job.activity_id) ->> 'eligible'
    )::boolean, false);
  get diagnostics v_skipped = row_count;

  -- Reconciliation repairs only the recent live window. It never scans or
  -- classifies historical signals from before this dedicated worker existed.
  for v_activity_id in
    select activity.id
    from public.activities activity
    where activity.workspace_key = p_workspace_key
      and activity.occurred_at >= greatest(v_started_at, now() - interval '1 hour')
      and coalesce((
        private.potential_lead_classifier_eligibility(activity.workspace_key, activity.id) ->> 'eligible'
      )::boolean, false)
      and not exists (
        select 1 from public.agent_jobs job
        where job.agent_key = 'potential-lead-classifier'
          and job.activity_id = activity.id
          and job.input_revision = activity.potential_lead_revision
      )
    order by activity.occurred_at desc, activity.id desc
    limit p_limit
  loop
    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    )
    select activity.workspace_key, 'potential-lead-classifier', activity.id,
      activity.potential_lead_revision, 100, 'reconcile'
    from public.activities activity
    where activity.id = v_activity_id
    on conflict (agent_key, activity_id, input_revision) do nothing;
    if found then v_enqueued := v_enqueued + 1; end if;
  end loop;

  return jsonb_build_object(
    'status', 'succeeded',
    'expiredLeases', v_expired,
    'ineligibleJobsClosed', v_skipped,
    'jobsEnqueued', v_enqueued
  );
end;
$$;

revoke all on function public.claim_potential_lead_classifier_job(text, integer)
from public, anon, authenticated;
revoke all on function public.inspect_potential_lead_classifier_job(bigint, uuid)
from public, anon, authenticated;
revoke all on function public.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_potential_lead_classifier_job(bigint, uuid, text, text, text)
from public, anon, authenticated;
revoke all on function public.reconcile_potential_lead_classifier(text, integer)
from public, anon, authenticated;

grant execute on function public.claim_potential_lead_classifier_job(text, integer)
to service_role;
grant execute on function public.inspect_potential_lead_classifier_job(bigint, uuid)
to service_role;
grant execute on function public.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text, jsonb
) to service_role;
grant execute on function public.fail_potential_lead_classifier_job(bigint, uuid, text, text, text)
to service_role;
grant execute on function public.reconcile_potential_lead_classifier(text, integer)
to service_role;

-- Restore Signal Triage's exact pre-feature completion API. The live migration
-- added a defaulted fifteenth argument, so both the overload and its grant must
-- be removed before recreating the original fourteen-argument function.
drop function if exists public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric, text, text, text,
  jsonb, jsonb, jsonb
);

create function public.complete_signal_triage_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_topic_label_key text,
  p_urgency_label_key text,
  p_contact_disposition text,
  p_entity_type text,
  p_role_key text,
  p_display_name text,
  p_confidence numeric,
  p_reason text,
  p_model text,
  p_prompt_version text,
  p_evidence jsonb default '{}'::jsonb,
  p_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_topic_label public.labels%rowtype;
  v_urgency_label public.labels%rowtype;
  v_run_id uuid;
  v_contact_result jsonb;
  v_attachment jsonb;
  v_attachment_key text;
  v_text text;
  v_status text;
  v_size bigint;
  v_ordinal bigint;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_lease_token is null then raise exception 'job id and lease token are required'; end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then raise exception 'confidence must be between 0 and 1'; end if;
  if p_contact_disposition not in ('existing', 'create', 'suggest', 'ignore', 'conflict') then raise exception 'invalid contact disposition'; end if;
  if p_entity_type is not null and p_entity_type not in ('person', 'business') then raise exception 'invalid entity type'; end if;
  if p_role_key is not null and not exists (
    select 1 from public.contact_role_definitions role
    where role.workspace_key = (select workspace_key from public.agent_jobs where id = p_job_id)
      and role.key = p_role_key and role.enabled
  ) then raise exception 'role is not enabled'; end if;
  if p_reason is null or char_length(p_reason) > 2000 then raise exception 'reason must be at most 2000 characters'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object' or pg_column_size(coalesce(p_evidence, '{}'::jsonb)) > 2097152 then raise exception 'invalid evidence'; end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 20 then raise exception 'invalid attachments'; end if;

  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'signal-triage' or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token then
    raise exception 'job lease is no longer valid';
  end if;

  select * into v_topic_label from public.labels
  where workspace_key = v_job.workspace_key and kind = 'topic' and key = p_topic_label_key and enabled;
  if not found then raise exception 'topic label is not enabled'; end if;
  select * into v_urgency_label from public.labels
  where workspace_key = v_job.workspace_key and kind = 'urgency' and key = p_urgency_label_key and enabled;
  if not found then raise exception 'urgency label is not enabled'; end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model, prompt_version,
    evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision, 'completed',
    nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    p_evidence, coalesce(v_job.claimed_at, v_now), v_now
  ) returning id into v_run_id;

  insert into public.signal_labels (
    activity_id, label_id, label_kind, agent_key, agent_run_id, assigned_by,
    confidence, reason, evidence, updated_at
  ) values
    (v_job.activity_id, v_topic_label.id, 'topic', v_job.agent_key, v_run_id, 'agent', p_confidence, p_reason, p_evidence, v_now),
    (v_job.activity_id, v_urgency_label.id, 'urgency', v_job.agent_key, v_run_id, 'agent', p_confidence, p_reason, p_evidence, v_now)
  on conflict (activity_id, agent_key, label_kind) do update
  set label_id = excluded.label_id, agent_run_id = excluded.agent_run_id,
      assigned_by = excluded.assigned_by, confidence = excluded.confidence,
      reason = excluded.reason, evidence = excluded.evidence, updated_at = excluded.updated_at;

  v_contact_result := private.apply_signal_triage_contact_decision(
    v_job.activity_id, v_run_id, v_job.input_revision, p_contact_disposition,
    p_entity_type, p_role_key, p_display_name, p_confidence, p_reason, p_evidence
  );

  insert into public.signal_triage_decisions (
    workspace_key, activity_id, input_revision, agent_run_id, contact_disposition,
    proposed_entity_type, proposed_role_key, proposed_display_name, confidence,
    reason, evidence, outcome, person_id
  ) values (
    v_job.workspace_key, v_job.activity_id, v_job.input_revision, v_run_id,
    p_contact_disposition, p_entity_type, p_role_key,
    nullif(left(btrim(coalesce(p_display_name, '')), 300), ''), p_confidence,
    p_reason, p_evidence, v_contact_result ->> 'outcome',
    nullif(v_contact_result ->> 'personId', '')::uuid
  )
  on conflict (activity_id, input_revision) do update
  set agent_run_id = excluded.agent_run_id,
      contact_disposition = excluded.contact_disposition,
      proposed_entity_type = excluded.proposed_entity_type,
      proposed_role_key = excluded.proposed_role_key,
      proposed_display_name = excluded.proposed_display_name,
      confidence = excluded.confidence,
      reason = excluded.reason,
      evidence = excluded.evidence,
      outcome = excluded.outcome,
      person_id = excluded.person_id;

  for v_attachment, v_ordinal in
    select item.value, item.ordinality
    from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb))
      with ordinality item(value, ordinality)
  loop
    if jsonb_typeof(v_attachment) <> 'object' then continue; end if;
    v_attachment_key := left(coalesce(
      nullif(btrim(v_attachment ->> 'attachmentKey'), ''),
      nullif(btrim(v_attachment ->> 'partId'), ''),
      nullif(btrim(v_attachment ->> 'filename'), ''), v_ordinal::text
    ), 500);
    v_text := nullif(left(coalesce(v_attachment ->> 'extractedText', ''), 100000), '');
    v_status := coalesce(
      nullif(v_attachment ->> 'status', ''),
      case when v_text is null then 'metadata' else 'extracted' end
    );
    if v_status not in ('metadata', 'extracted', 'no_text', 'unsupported', 'failed') then
      v_status := case when v_text is null then 'metadata' else 'extracted' end;
    end if;
    v_size := case when coalesce(v_attachment ->> 'sizeBytes', '') ~ '^[0-9]{1,18}$'
      then (v_attachment ->> 'sizeBytes')::bigint else null end;

    insert into public.signal_attachment_evidence (
      activity_id, agent_key, agent_run_id, attachment_key, filename, mime_type,
      size_bytes, extraction_status, extraction_method, extracted_text, metadata, updated_at
    ) values (
      v_job.activity_id, v_job.agent_key, v_run_id, v_attachment_key,
      nullif(left(coalesce(v_attachment ->> 'filename', ''), 500), ''),
      nullif(left(coalesce(v_attachment ->> 'mimeType', ''), 200), ''),
      v_size, v_status,
      nullif(left(coalesce(v_attachment ->> 'extractionMethod', ''), 100), ''),
      v_text,
      case when jsonb_typeof(v_attachment -> 'metadata') = 'object'
        and pg_column_size(v_attachment -> 'metadata') <= 524288
        then v_attachment -> 'metadata' else '{}'::jsonb end,
      v_now
    ) on conflict (activity_id, agent_key, attachment_key) do update
    set agent_run_id = excluded.agent_run_id,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        extraction_status = excluded.extraction_status,
        extraction_method = excluded.extraction_method,
        extracted_text = excluded.extracted_text,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at;
  end loop;

  update public.agent_jobs
  set status = 'succeeded', lease_owner = null, lease_token = null,
      leased_until = null, last_error = null, finished_at = v_now, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id,
    'activityId', v_job.activity_id,
    'inputRevision', v_job.input_revision,
    'runId', v_run_id,
    'topic', jsonb_build_object('key', v_topic_label.key, 'name', v_topic_label.name),
    'urgency', jsonb_build_object('key', v_urgency_label.key, 'name', v_urgency_label.name),
    'contact', v_contact_result
  );
end;
$$;

revoke all on function public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric, text, text, text,
  jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric, text, text, text,
  jsonb, jsonb
) to service_role;

-- Keep the candidate row as audit evidence, but remove it from the Board once
-- DripJobs (or another canonical CRM source) claims its exact identity.
create or replace function public.list_lead_candidates(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 100
)
returns jsonb
language sql
stable
set search_path = 'pg_catalog', 'public'
as $$
  with visible as (
    select
      candidate.*,
      activity.subject as signal_subject,
      activity.preview as signal_preview,
      activity.occurred_at as signal_at,
      activity.direction as signal_direction,
      activity.source as signal_source,
      activity.event_type as signal_event_type,
      activity.actor_name as signal_actor_name,
      activity.call_status as signal_call_status,
      activity.duration_seconds as signal_duration_seconds,
      case when call_summary.status = 'available' and jsonb_typeof(call_summary.summary) = 'array'
        then call_summary.summary else null end as signal_call_summary,
      transcript.status as signal_transcript_status
    from public.lead_candidates candidate
    join public.activities activity on activity.id = candidate.activity_id
    left join public.activity_call_summaries call_summary
      on call_summary.activity_id = candidate.activity_id
     and call_summary.workspace_key = candidate.workspace_key
    left join public.activity_call_transcripts transcript
      on transcript.activity_id = candidate.activity_id
    where candidate.workspace_key = p_workspace_key
      and not exists (
        select 1
        from public.activity_people link
        join public.people person on person.id = link.person_id
        where link.activity_id = candidate.activity_id
          and link.relationship = 'counterparty'
          and person.status = 'active'
      )
      and not exists (
        select 1
        from public.activity_identities link
        join public.person_identity_claims claim
          on claim.identity_id = link.identity_id and claim.active
        join public.people person
          on person.id = claim.person_id and person.status = 'active'
        where link.activity_id = candidate.activity_id
          and link.relationship = 'actor'
      )
      and not exists (
        select 1
        from public.identities identity
        join public.person_identity_claims claim
          on claim.identity_id = identity.id and claim.active
        join public.people person
          on person.id = claim.person_id and person.status = 'active'
        where identity.workspace_key = candidate.workspace_key
          and (
            (identity.kind = 'email' and identity.normalized_value = private.fluid_normalize_email(candidate.contact_email))
            or (identity.kind = 'phone' and identity.normalized_value = private.fluid_normalize_phone(candidate.contact_phone))
          )
      )
    order by (candidate.disposition = 'undecided') desc,
      coalesce(candidate.decided_at, candidate.created_at) desc,
      candidate.id desc
    limit least(greatest(p_limit, 1), 500)
  )
  select jsonb_build_object(
    'undecidedCount', (
      select count(*)::int
      from public.lead_candidates candidate
      where candidate.workspace_key = p_workspace_key
        and candidate.disposition = 'undecided'
        and not exists (
          select 1
          from public.activity_people link
          join public.people person on person.id = link.person_id
          where link.activity_id = candidate.activity_id
            and link.relationship = 'counterparty'
            and person.status = 'active'
        )
        and not exists (
          select 1
          from public.activity_identities link
          join public.person_identity_claims claim
            on claim.identity_id = link.identity_id and claim.active
          join public.people person
            on person.id = claim.person_id and person.status = 'active'
          where link.activity_id = candidate.activity_id
            and link.relationship = 'actor'
        )
        and not exists (
          select 1
          from public.identities identity
          join public.person_identity_claims claim
            on claim.identity_id = identity.id and claim.active
          join public.people person
            on person.id = claim.person_id and person.status = 'active'
          where identity.workspace_key = candidate.workspace_key
            and (
              (identity.kind = 'email' and identity.normalized_value = private.fluid_normalize_email(candidate.contact_email))
              or (identity.kind = 'phone' and identity.normalized_value = private.fluid_normalize_phone(candidate.contact_phone))
            )
        )
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'activityId', item.activity_id,
        'personId', item.person_id,
        'name', item.contact_name,
        'email', item.contact_email,
        'phone', item.contact_phone,
        'channel', item.channel,
        'summary', item.summary,
        'reason', item.reason,
        'confidence', item.confidence,
        'disposition', item.disposition,
        'decidedBy', item.decided_by,
        'decidedAt', item.decided_at,
        'createdAt', item.created_at,
        'signal', jsonb_build_object(
          'subject', item.signal_subject,
          'preview', item.signal_preview,
          'occurredAt', item.signal_at,
          'direction', item.signal_direction,
          'source', item.signal_source,
          'eventType', item.signal_event_type,
          'actorName', item.signal_actor_name,
          'callStatus', item.signal_call_status,
          'durationSeconds', item.signal_duration_seconds,
          'callSummary', item.signal_call_summary,
          'transcriptStatus', item.signal_transcript_status
        )
      ) order by (item.disposition = 'undecided') desc,
        coalesce(item.decided_at, item.created_at) desc,
        item.id desc)
      from visible item
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_lead_candidates(text, integer)
from public, anon, authenticated;
grant execute on function public.list_lead_candidates(text, integer)
to service_role;
