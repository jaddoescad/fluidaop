create or replace function public.claim_signal_recommender_job(
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
  v_signal jsonb;
  v_contact jsonb;
  v_labels jsonb;
  v_attachments jsonb;
  v_transcript jsonb;
  v_history jsonb;
  v_cases jsonb;
  v_slack jsonb;
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
      last_error = 'Superseded by a newer recommendation revision.',
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  from public.activities activity
  where job.agent_key = 'signal-recommender'
    and job.activity_id = activity.id
    and job.status in ('pending', 'leased')
    and job.input_revision < activity.recommendation_revision;

  update public.agent_jobs
  set status = 'pending', available_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where agent_key = 'signal-recommender'
    and status = 'leased' and leased_until < v_now;

  select job.* into v_job
  from public.agent_jobs job
  join public.activities activity on activity.id = job.activity_id
  where job.agent_key = 'signal-recommender'
    and job.status = 'pending'
    and job.available_at <= v_now
    and job.input_revision = activity.recommendation_revision
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

  select jsonb_build_object(
    'id', activity.id, 'workspaceKey', activity.workspace_key,
    'source', activity.source, 'eventType', activity.event_type,
    'direction', activity.direction, 'actorName', activity.actor_name,
    'actorEmail', activity.actor_email, 'actorPhone', activity.actor_phone,
    'subject', left(activity.subject, 1000),
    'preview', left(activity.preview, 4000),
    'bodyText', left(coalesce(activity.body_text, ''), 20000),
    'occurredAt', activity.occurred_at,
    'threadId', activity.external_thread_id,
    'hasAttachments', activity.has_attachments,
    'attachmentCount', activity.attachment_count,
    'triageRevision', activity.triage_revision,
    'recommendationRevision', activity.recommendation_revision
  ) into v_signal
  from public.activities activity where activity.id = v_job.activity_id;

  select jsonb_build_object(
    'id', person.id, 'displayName', person.display_name,
    'entityType', person.entity_type, 'email', person.primary_email,
    'phone', person.primary_phone,
    'roles', coalesce((
      select jsonb_agg(distinct role.role_key order by role.role_key)
      from public.person_roles role
      where role.person_id = person.id and role.active
    ), '[]'::jsonb)
  ) into v_contact
  from public.activity_people link
  join public.people person on person.id = link.person_id and person.status = 'active'
  where link.activity_id = v_job.activity_id and link.relationship = 'counterparty'
  order by link.confidence desc, person.updated_at desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', signal_label.label_kind, 'key', label.key, 'name', label.name,
    'confidence', signal_label.confidence, 'reason', signal_label.reason
  ) order by signal_label.label_kind), '[]'::jsonb)
  into v_labels
  from public.signal_labels signal_label
  join public.labels label on label.id = signal_label.label_id
  where signal_label.activity_id = v_job.activity_id
    and signal_label.agent_key = 'signal-triage';

  select coalesce(jsonb_agg(to_jsonb(item) order by item.updated_at desc), '[]'::jsonb)
  into v_attachments
  from (
    select evidence.attachment_key as "attachmentKey", evidence.filename,
      evidence.mime_type as "mimeType", evidence.extraction_status as status,
      left(coalesce(evidence.extracted_text, ''), 20000) as "extractedText",
      evidence.updated_at
    from public.signal_attachment_evidence evidence
    where evidence.activity_id = v_job.activity_id
      and evidence.agent_key = 'signal-triage'
    order by evidence.updated_at desc
    limit 10
  ) item;

  select jsonb_build_object(
    'status', transcript.status,
    'text', left(coalesce(transcript.transcript_text, ''), 20000),
    'dialogue', case when pg_column_size(transcript.dialogue) <= 131072 then transcript.dialogue else '[]'::jsonb end,
    'updatedAt', transcript.updated_at
  ) into v_transcript
  from public.activity_call_transcripts transcript
  where transcript.activity_id = v_job.activity_id;

  select coalesce(jsonb_agg(to_jsonb(history) order by history.occurred_at), '[]'::jsonb)
  into v_history
  from (
    select activity.id, activity.source, activity.event_type as "eventType",
      activity.direction, activity.actor_name as "actorName",
      left(activity.subject, 1000) as subject,
      left(coalesce(activity.body_text, activity.preview, ''), 12000) as text,
      activity.occurred_at
    from public.activities activity
    where activity.id <> v_job.activity_id
      and activity.source in ('gmail', 'quo')
      and (
        (
          (v_signal ->> 'threadId') is not null
          and activity.external_thread_id = v_signal ->> 'threadId'
          and activity.source = v_signal ->> 'source'
        )
        or exists (
          select 1
          from public.activity_people current_link
          join public.activity_people history_link on history_link.person_id = current_link.person_id
          where current_link.activity_id = v_job.activity_id
            and current_link.relationship = 'counterparty'
            and history_link.activity_id = activity.id
            and history_link.relationship = 'counterparty'
        )
      )
    order by activity.occurred_at desc, activity.id desc
    limit 20
  ) history;

  select coalesce(jsonb_agg(to_jsonb(case_item) order by case_item.updated_at desc), '[]'::jsonb)
  into v_cases
  from (
    select distinct on (case_row.id)
      case_row.id, case_row.revision, case_row.status,
      case_row.canonical_state as "canonicalState",
      job.id as "jobId", job.name as "jobName", job.updated_at
    from public.case_evidence evidence
    join public.operational_cases case_row on case_row.id = evidence.case_id
    join public.jobs job on job.id = case_row.job_id
    where evidence.activity_id = v_job.activity_id
    order by case_row.id, job.updated_at desc
    limit 3
  ) case_item;

  select coalesce(jsonb_agg(to_jsonb(slack_item) order by slack_item.occurred_at), '[]'::jsonb)
  into v_slack
  from (
    select slack.id, left(slack.text_content, 12000) as text,
      slack.occurred_at, slack.permalink,
      coalesce(slack_user.display_name, slack_user.real_name, slack.provider_user_id) as "authorName"
    from public.case_evidence current_evidence
    join public.case_evidence slack_evidence on slack_evidence.case_id = current_evidence.case_id
      and slack_evidence.slack_message_id is not null
    join public.slack_messages slack on slack.id = slack_evidence.slack_message_id
      and slack.deleted_at is null and not slack.is_filtered
    left join public.slack_users slack_user
      on slack_user.workspace_key = slack.workspace_key
      and slack_user.team_id = slack.team_id
      and slack_user.provider_user_id = slack.provider_user_id
    where current_evidence.activity_id = v_job.activity_id
    order by slack.occurred_at desc, slack.id desc
    limit 20
  ) slack_item;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'activityId', v_job.activity_id,
      'inputRevision', v_job.input_revision, 'leaseToken', v_job.lease_token,
      'attempt', v_job.attempts, 'leasedUntil', v_job.leased_until
    ),
    'signal', v_signal,
    'contact', v_contact,
    'labels', v_labels,
    'attachments', v_attachments,
    'transcript', v_transcript,
    'history', v_history,
    'cases', v_cases,
    'slackContext', v_slack,
    'contract', jsonb_build_object(
      'maximumRecommendations', 5,
      'allowedKinds', jsonb_build_array('action', 'reminder', 'automation'),
      'locked', true,
      'slackIsContextOnly', true
    )
  );
end;
$$;

create or replace function public.complete_signal_recommender_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_model text,
  p_prompt_version text,
  p_recommendations jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, extensions, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_activity public.activities%rowtype;
  v_settings public.signal_recommender_settings%rowtype;
  v_run_id uuid;
  v_item jsonb;
  v_kind text;
  v_intent text;
  v_label text;
  v_reason text;
  v_capability text;
  v_case_id uuid;
  v_confidence numeric;
  v_evidence jsonb;
  v_prerequisites jsonb;
  v_fingerprint text;
  v_shadow boolean;
  v_inserted integer := 0;
  v_public integer := 0;
  v_order integer := 0;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_lease_token is null then raise exception 'job id and lease token are required'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;
  if jsonb_typeof(coalesce(p_recommendations, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_recommendations, '[]'::jsonb)) > 5
    or pg_column_size(coalesce(p_recommendations, '[]'::jsonb)) > 1048576
  then raise exception 'recommendations must be an array of at most five items'; end if;

  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'signal-recommender'
    or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
    or v_job.leased_until < v_now
  then raise exception 'job lease is no longer valid'; end if;

  select * into v_activity from public.activities where id = v_job.activity_id for update;
  if v_activity.recommendation_revision <> v_job.input_revision then
    raise exception 'signal recommendation revision changed';
  end if;
  if v_activity.direction <> 'inbound' then raise exception 'only inbound signals may receive recommendations'; end if;

  select * into v_settings
  from public.signal_recommender_settings
  where workspace_key = v_job.workspace_key
  for update;
  if not found then raise exception 'signal recommender settings are missing'; end if;
  v_shadow := v_settings.shadow_signals_remaining > 0 or not v_settings.publication_enabled;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model,
    prompt_version, evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision,
    'completed', nullif(left(btrim(coalesce(p_model, '')), 200), ''),
    btrim(p_prompt_version),
    jsonb_build_object(
      'recommendationCount', jsonb_array_length(coalesce(p_recommendations, '[]'::jsonb)),
      'locked', true
    ),
    coalesce(v_job.claimed_at, v_now), v_now
  ) returning id into v_run_id;

  update public.signal_recommendations
  set status = 'superseded', superseded_at = v_now, updated_at = v_now
  where workspace_key = v_job.workspace_key
    and activity_id = v_job.activity_id
    and status = 'pending';

  for v_item in select value from jsonb_array_elements(coalesce(p_recommendations, '[]'::jsonb))
  loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'each recommendation must be an object'; end if;
    v_kind := btrim(coalesce(v_item ->> 'kind', ''));
    v_intent := btrim(coalesce(v_item ->> 'intentKey', ''));
    v_label := btrim(coalesce(v_item ->> 'label', ''));
    v_reason := btrim(coalesce(v_item ->> 'reason', ''));
    v_capability := nullif(btrim(coalesce(v_item ->> 'capabilityKey', '')), '');
    v_confidence := coalesce((v_item ->> 'confidence')::numeric, -1);
    v_evidence := coalesce(v_item -> 'evidence', '[]'::jsonb);
    v_prerequisites := coalesce(v_item -> 'prerequisites', '{}'::jsonb);
    v_case_id := case
      when coalesce(v_item ->> 'caseId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (v_item ->> 'caseId')::uuid
      else null
    end;

    if v_kind not in ('action', 'reminder', 'automation') then raise exception 'invalid recommendation kind'; end if;
    if v_intent not in (
      'reply', 'follow_up', 'schedule', 'production', 'payment_collection',
      'procurement', 'colour_consult', 'documentation', 'review', 'other'
    ) then raise exception 'invalid recommendation intent'; end if;
    if char_length(v_label) not between 1 and 160 or char_length(v_reason) not between 1 and 2000 then
      raise exception 'invalid recommendation text';
    end if;
    if v_confidence < 0 or v_confidence > 1 then raise exception 'invalid recommendation confidence'; end if;
    if jsonb_typeof(v_evidence) <> 'array' or jsonb_array_length(v_evidence) > 30 or pg_column_size(v_evidence) > 262144 then
      raise exception 'invalid recommendation evidence';
    end if;
    if jsonb_typeof(v_prerequisites) <> 'object' or pg_column_size(v_prerequisites) > 65536 then
      raise exception 'invalid recommendation prerequisites';
    end if;
    if v_capability is not null and v_capability !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
      raise exception 'invalid capability key';
    end if;
    if v_case_id is not null and not exists (
      select 1 from public.case_evidence evidence
      where evidence.case_id = v_case_id and evidence.activity_id = v_job.activity_id
    ) then raise exception 'recommendation case is not linked to this signal'; end if;

    if v_case_id is not null and v_intent in ('schedule', 'production') and exists (
      select 1 from public.operational_cases case_row
      where case_row.id = v_case_id
        and (
          case_row.status in ('terminal', 'archived')
          or coalesce((case_row.canonical_state #>> '{production,terminal}')::boolean, false)
          or coalesce((case_row.canonical_state #>> '{production,cancelled}')::boolean, false)
          or case_row.canonical_state #>> '{production,status}' in ('completed', 'cancelled', 'archived')
        )
    ) then continue; end if;
    if v_case_id is not null and v_intent = 'payment_collection' and exists (
      select 1 from public.operational_cases case_row
      where case_row.id = v_case_id
        and (
          case_row.canonical_state #>> '{financial,status}' = 'paid'
          or coalesce((case_row.canonical_state #>> '{financial,balanceCents}')::numeric, 0) <= 0
        )
    ) then continue; end if;
    if v_confidence < v_settings.minimum_confidence then continue; end if;

    v_order := v_order + 1;
    v_fingerprint := encode(digest(concat_ws('|',
      v_job.workspace_key, v_job.activity_id::text, v_kind, v_intent,
      lower(v_label), coalesce(v_capability, ''), coalesce(v_case_id::text, '')
    ), 'sha256'), 'hex');

    insert into public.signal_recommendations (
      workspace_key, activity_id, input_revision, case_id,
      recommendation_kind, intent_key, label, reason, confidence,
      evidence, prerequisites, capability_key, fingerprint,
      display_order, is_shadow, agent_run_id
    ) values (
      v_job.workspace_key, v_job.activity_id, v_job.input_revision, v_case_id,
      v_kind, v_intent, v_label, v_reason, v_confidence,
      v_evidence, v_prerequisites, v_capability, v_fingerprint,
      v_order, v_shadow, v_run_id
    );
    v_inserted := v_inserted + 1;
    if not v_shadow then v_public := v_public + 1; end if;
  end loop;

  if v_settings.shadow_signals_remaining > 0 then
    update public.signal_recommender_settings
    set shadow_signals_remaining = greatest(0, shadow_signals_remaining - 1),
        updated_at = v_now
    where workspace_key = v_settings.workspace_key;
  end if;

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    v_job.workspace_key, v_job.activity_id, v_job.input_revision,
    case when v_public > 0 then 'pending' else 'settled' end,
    case when v_public > 0 then null when v_inserted > 0 then 'shadow_only' else 'none_required' end,
    v_public, null, case when v_public > 0 then null else v_now end, v_now
  )
  on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = excluded.status,
      resolution = excluded.resolution,
      pending_recommendation_count = excluded.pending_recommendation_count,
      reviewed_by = null,
      reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at;

  update public.agent_jobs
  set status = 'succeeded', finished_at = v_now, last_error = null,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id, 'activityId', v_job.activity_id,
    'inputRevision', v_job.input_revision, 'runId', v_run_id,
    'recommendationsStored', v_inserted,
    'publicRecommendations', v_public, 'shadow', v_shadow, 'locked', true
  );
end;
$$;

create or replace function public.fail_signal_recommender_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error text,
  p_model text default null,
  p_prompt_version text default 'signal-recommender-v1'
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
  if not found or v_job.agent_key <> 'signal-recommender'
    or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
  then raise exception 'job lease is no longer valid'; end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model,
    prompt_version, error, evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision,
    'failed', nullif(left(btrim(coalesce(p_model, '')), 200), ''),
    btrim(p_prompt_version), left(btrim(p_error), 2000), '{}'::jsonb,
    coalesce(v_job.claimed_at, v_now), v_now
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
    'jobId', v_job.id, 'activityId', v_job.activity_id,
    'status', case when v_terminal then 'failed' else 'pending' end,
    'attempt', v_job.attempts
  );
end;
$$;

create or replace function public.settle_signal_recommendations(
  p_workspace_key text,
  p_activity_id bigint,
  p_resolution text,
  p_reviewer text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_activity public.activities%rowtype;
  v_state public.signal_review_states%rowtype;
  v_dismissed integer := 0;
  v_now timestamptz := now();
begin
  if p_resolution <> 'no_action' then raise exception 'invalid signal resolution'; end if;
  if p_reviewer is null or char_length(btrim(p_reviewer)) not between 1 and 200 then raise exception 'invalid reviewer'; end if;

  select * into v_activity
  from public.activities
  where id = p_activity_id and workspace_key = p_workspace_key
  for update;
  if not found then raise exception 'signal was not found'; end if;

  select * into v_state
  from public.signal_review_states
  where activity_id = p_activity_id
  for update;

  if found and v_state.status = 'settled' and v_state.resolution = 'no_action'
    and v_state.input_revision = v_activity.recommendation_revision
  then
    return jsonb_build_object(
      'activityId', p_activity_id, 'status', 'settled',
      'resolution', 'no_action', 'dismissed', 0, 'idempotent', true
    );
  end if;

  update public.signal_recommendations
  set status = 'dismissed', dismissed_at = v_now, updated_at = v_now
  where workspace_key = p_workspace_key
    and activity_id = p_activity_id
    and input_revision = v_activity.recommendation_revision
    and status = 'pending' and not is_shadow;
  get diagnostics v_dismissed = row_count;

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    p_workspace_key, p_activity_id, v_activity.recommendation_revision,
    'settled', 'no_action', 0, left(btrim(p_reviewer), 200), v_now, v_now
  )
  on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = 'settled', resolution = 'no_action',
      pending_recommendation_count = 0,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'activityId', p_activity_id, 'status', 'settled',
    'resolution', 'no_action', 'dismissed', v_dismissed, 'idempotent', false
  );
end;
$$;

create or replace function public.reconcile_signal_recommender(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 1000
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_activity_id bigint;
  v_enqueued integer := 0;
  v_released integer := 0;
  v_now timestamptz := now();
begin
  if p_limit not between 1 and 5000 then raise exception 'limit must be between 1 and 5000'; end if;

  update public.agent_jobs
  set status = 'pending', available_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where workspace_key = p_workspace_key and agent_key = 'signal-recommender'
    and status = 'leased' and leased_until < v_now;
  get diagnostics v_released = row_count;

  for v_activity_id in
    select activity.id
    from public.activities activity
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and activity.direction = 'inbound'
      and activity.event_type in ('email.received', 'message.received', 'call.completed')
      and activity.occurred_at >= v_now - interval '30 days'
      and exists (
        select 1 from public.signal_triage_decisions decision
        where decision.activity_id = activity.id
          and decision.input_revision = activity.triage_revision
      )
      and not exists (
        select 1 from public.agent_jobs job
        where job.agent_key = 'signal-recommender'
          and job.activity_id = activity.id
          and job.input_revision = activity.recommendation_revision
      )
    order by activity.occurred_at desc, activity.id desc
    limit p_limit
  loop
    perform private.enqueue_signal_recommender(v_activity_id, 'backfill');
    v_enqueued := v_enqueued + 1;
  end loop;

  return jsonb_build_object('released', v_released, 'enqueued', v_enqueued, 'checkedAt', v_now);
end;
$$;

revoke all on function public.claim_signal_recommender_job(text, integer)
from public, anon, authenticated;
revoke all on function public.complete_signal_recommender_job(bigint, uuid, text, text, jsonb)
from public, anon, authenticated;
revoke all on function public.fail_signal_recommender_job(bigint, uuid, text, text, text)
from public, anon, authenticated;
revoke all on function public.settle_signal_recommendations(text, bigint, text, text)
from public, anon, authenticated;
revoke all on function public.reconcile_signal_recommender(text, integer)
from public, anon, authenticated;

grant execute on function public.claim_signal_recommender_job(text, integer)
to service_role;
grant execute on function public.complete_signal_recommender_job(bigint, uuid, text, text, jsonb)
to service_role;
grant execute on function public.fail_signal_recommender_job(bigint, uuid, text, text, text)
to service_role;
grant execute on function public.settle_signal_recommendations(text, bigint, text, text)
to service_role;
grant execute on function public.reconcile_signal_recommender(text, integer)
to service_role;
