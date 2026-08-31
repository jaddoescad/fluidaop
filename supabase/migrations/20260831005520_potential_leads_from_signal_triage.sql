-- Potential Leads, part two: the verdict comes from the Signal-triage agent.
--
-- The tables and read models already exist (20260831004143 and 20260831004257).
-- This migration wires them to the one agent that already reads every new
-- Gmail and Quo signal, and tightens what may ever become a candidate:
--
--   1. complete_signal_triage_job accepts an optional potential-lead verdict.
--      Old workers that do not send one keep working unchanged.
--   2. record_lead_candidate refuses what can never be a candidate — outbound
--      mail, automated sends, system identities, and anyone the CRM already
--      knows — so those rules hold even if a caller forgets them.
--   3. list_lead_candidates carries the Quo call summary, so a voicemail card
--      can say what the caller wanted, and orders decided cards by decision.

-- ---------------------------------------------------------------------------
-- 1. record_lead_candidate: only unknown, reachable, inbound humans
-- ---------------------------------------------------------------------------

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
  v_settings public.lead_candidate_settings%rowtype;
  v_activity public.activities%rowtype;
  v_email text := nullif(btrim(coalesce(p_contact_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_id bigint;
  v_inserted boolean;
begin
  select * into v_settings from public.lead_candidate_settings
  where workspace_key = p_workspace_key;
  if not found or not v_settings.enabled then
    return jsonb_build_object('recorded', false, 'skipped', 'disabled');
  end if;

  select * into v_activity from public.activities
  where id = p_activity_id and workspace_key = p_workspace_key;
  if not found then
    return jsonb_build_object('recorded', false, 'skipped', 'unknown-signal');
  end if;
  -- No backfill: the column starts when the feature did.
  if v_activity.occurred_at < v_settings.started_at then
    return jsonb_build_object('recorded', false, 'skipped', 'before-start');
  end if;
  -- Only customer-facing channels, and only what came *to* us.
  if v_activity.source not in ('gmail', 'quo') then
    return jsonb_build_object('recorded', false, 'skipped', 'unsupported-source');
  end if;
  if v_activity.direction <> 'inbound' then
    return jsonb_build_object('recorded', false, 'skipped', 'not-inbound');
  end if;
  if lower(coalesce(v_activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes') then
    return jsonb_build_object('recorded', false, 'skipped', 'automated');
  end if;
  -- A system or ignored sender identity is never a person to call back.
  if exists (
    select 1
    from public.activity_identities link
    join public.identities identity on identity.id = link.identity_id
    where link.activity_id = v_activity.id
      and link.relationship = 'actor'
      and (identity.ignored or identity.classification = 'system')
  ) then
    return jsonb_build_object('recorded', false, 'skipped', 'system-identity');
  end if;
  -- Someone the CRM already knows belongs on the pipeline, not here.
  if exists (
    select 1
    from public.activity_people link
    join public.people person on person.id = link.person_id
    where link.activity_id = v_activity.id
      and link.relationship = 'counterparty'
      and person.status = 'active'
  ) then
    return jsonb_build_object('recorded', false, 'skipped', 'known-contact');
  end if;
  -- A lead you cannot reach is not a lead.
  if v_email is null and v_phone is null then
    return jsonb_build_object('recorded', false, 'skipped', 'unreachable');
  end if;

  insert into public.lead_candidates (
    workspace_key, activity_id, person_id, contact_name, contact_email, contact_phone,
    channel, summary, reason, confidence, agent_run_id, model, prompt_version, evidence
  )
  values (
    p_workspace_key, p_activity_id, null,
    nullif(left(btrim(coalesce(p_contact_name, '')), 300), ''), left(v_email, 320), left(v_phone, 40),
    coalesce(nullif(btrim(coalesce(v_activity.event_type, '')), ''), 'unknown'),
    left(coalesce(p_summary, ''), 2000), left(coalesce(p_reason, ''), 2000),
    p_confidence, p_agent_run_id, left(coalesce(p_model, ''), 200), left(coalesce(p_prompt_version, ''), 100),
    case when jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) = 'object'
      then p_evidence else '{}'::jsonb end
  )
  -- Re-running triage refreshes what the agent said, never what a human decided.
  on conflict (workspace_key, activity_id) do update
  set contact_name = excluded.contact_name,
      contact_email = excluded.contact_email,
      contact_phone = excluded.contact_phone,
      summary = excluded.summary,
      reason = excluded.reason,
      confidence = excluded.confidence,
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
) is 'Records one Potential Lead from a triaged signal, or explains why it was not recorded. Never raises for a refused signal.';

-- ---------------------------------------------------------------------------
-- 2. complete_signal_triage_job: carry the verdict
-- ---------------------------------------------------------------------------

-- A new defaulted parameter would otherwise leave two overloads behind, and
-- PostgREST cannot pick between them by name.
drop function if exists public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric, text, text, text, jsonb, jsonb
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
  p_attachments jsonb default '[]'::jsonb,
  p_lead_candidate jsonb default null
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
  v_lead_result jsonb := null;
  v_lead_verdict text;
  v_lead_confidence numeric;
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
  -- The verdict is validated up front so a malformed one fails the whole call
  -- loudly, rather than silently completing triage without it.
  if p_lead_candidate is not null then
    if jsonb_typeof(p_lead_candidate) <> 'object' or pg_column_size(p_lead_candidate) > 65536 then
      raise exception 'invalid lead candidate';
    end if;
    v_lead_verdict := p_lead_candidate ->> 'verdict';
    if v_lead_verdict is null or v_lead_verdict not in ('lead', 'not_lead') then
      raise exception 'lead candidate verdict must be lead or not_lead';
    end if;
    if p_lead_candidate ? 'confidence' and jsonb_typeof(p_lead_candidate -> 'confidence') <> 'null' then
      if jsonb_typeof(p_lead_candidate -> 'confidence') <> 'number' then
        raise exception 'lead candidate confidence must be a number';
      end if;
      v_lead_confidence := (p_lead_candidate ->> 'confidence')::numeric;
      if v_lead_confidence < 0 or v_lead_confidence > 1 then
        raise exception 'lead candidate confidence must be between 0 and 1';
      end if;
    end if;
  end if;

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
    from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) with ordinality item(value, ordinality)
  loop
    if jsonb_typeof(v_attachment) <> 'object' then continue; end if;
    v_attachment_key := left(coalesce(
      nullif(btrim(v_attachment ->> 'attachmentKey'), ''),
      nullif(btrim(v_attachment ->> 'partId'), ''),
      nullif(btrim(v_attachment ->> 'filename'), ''), v_ordinal::text
    ), 500);
    v_text := nullif(left(coalesce(v_attachment ->> 'extractedText', ''), 100000), '');
    v_status := coalesce(nullif(v_attachment ->> 'status', ''), case when v_text is null then 'metadata' else 'extracted' end);
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
      case when jsonb_typeof(v_attachment -> 'metadata') = 'object' and pg_column_size(v_attachment -> 'metadata') <= 524288
        then v_attachment -> 'metadata' else '{}'::jsonb end,
      v_now
    ) on conflict (activity_id, agent_key, attachment_key) do update
    set agent_run_id = excluded.agent_run_id, filename = excluded.filename,
      mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
      extraction_status = excluded.extraction_status,
      extraction_method = excluded.extraction_method,
      extracted_text = excluded.extracted_text, metadata = excluded.metadata,
      updated_at = excluded.updated_at;
  end loop;

  -- The Potential Leads verdict. A "not a lead" leaves no trace beyond the
  -- run's evidence: a store promo simply never appears in the column. The
  -- database still decides whether a "lead" may be recorded at all.
  if v_lead_verdict = 'lead' then
    v_lead_result := public.record_lead_candidate(
      v_job.workspace_key,
      v_job.activity_id,
      p_lead_candidate ->> 'name',
      p_lead_candidate ->> 'email',
      p_lead_candidate ->> 'phone',
      coalesce(p_lead_candidate ->> 'summary', ''),
      coalesce(p_lead_candidate ->> 'reason', ''),
      v_lead_confidence,
      v_run_id,
      p_model,
      p_prompt_version,
      jsonb_build_object('verdict', v_lead_verdict, 'runEvidence', p_evidence)
        || coalesce(p_lead_candidate -> 'evidence', '{}'::jsonb)
    );
  elsif v_lead_verdict = 'not_lead' then
    v_lead_result := jsonb_build_object('recorded', false, 'verdict', 'not_lead');
  end if;

  update public.agent_jobs
  set status = 'succeeded', lease_owner = null, lease_token = null,
      leased_until = null, last_error = null, finished_at = v_now, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id, 'activityId', v_job.activity_id, 'inputRevision', v_job.input_revision,
    'runId', v_run_id,
    'topic', jsonb_build_object('key', v_topic_label.key, 'name', v_topic_label.name),
    'urgency', jsonb_build_object('key', v_urgency_label.key, 'name', v_urgency_label.name),
    'contact', v_contact_result,
    'leadCandidate', v_lead_result
  );
end;
$$;

revoke all on function public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric, text, text, text, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric, text, text, text, jsonb, jsonb, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. list_lead_candidates: the call summary, and decided cards by decision
-- ---------------------------------------------------------------------------

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
    -- Undecided first, newest first. A decision then re-files the card by
    -- when it was made, so the bottom of the column reads as a recent log.
    order by (candidate.disposition = 'undecided') desc,
      coalesce(candidate.decided_at, candidate.created_at) desc,
      candidate.id desc
    limit least(greatest(p_limit, 1), 500)
  )
  select jsonb_build_object(
    'undecidedCount', (
      select count(*)::int from public.lead_candidates
      where workspace_key = p_workspace_key and disposition = 'undecided'
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
