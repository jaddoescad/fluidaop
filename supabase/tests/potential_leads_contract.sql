begin;

-- Potential Lead Classifier contract. Every row is rolled back: this proves
-- the dedicated queue, lease lifecycle, database eligibility, human-review
-- output, Signal read state, and retirement of the former classifier surface.
do $$
declare
  v_stamp text := replace(gen_random_uuid()::text, '-', '');
  v_activity bigint;
  v_activity_two bigint;
  v_activity_first bigint;
  v_activity_second bigint;
  v_activity_third bigint;
  v_activity_not bigint;
  v_activity_call bigint;
  v_activity_missed bigint;
  v_old_activity bigint;
  v_job bigint;
  v_old_job bigint;
  v_token uuid;
  v_result jsonb;
  v_payload jsonb;
  v_list jsonb;
  v_candidate bigint;
  v_candidate_two bigint;
  v_identity uuid;
  v_person uuid;
  v_started_at timestamptz;
begin
  update public.lead_candidate_settings
  set enabled = true,
      started_at = least(started_at, now() - interval '1 minute'),
      updated_at = now()
  where workspace_key = 'ottawa-painters'
  returning started_at into v_started_at;
  if v_started_at is null then raise exception 'Potential Leads settings are missing'; end if;

  if exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'claim_signal_triage_job',
        'complete_signal_triage_job',
        'fail_signal_triage_job',
        'reconcile_signal_triage',
        'claim_signal_recommender_job',
        'complete_signal_recommender_job',
        'fail_signal_recommender_job',
        'reconcile_signal_recommender'
      )
  ) then raise exception 'a retired Signal worker still exposes runtime RPCs'; end if;
  if exists (
    select 1 from pg_trigger
    where not tgisinternal
      and tgname in (
        'activities_resolve_and_enqueue_signal_triage',
        'activities_bump_signal_triage_revision',
        'signal_triage_decisions_enqueue_recommender',
        'activities_bump_signal_recommender_revision',
        'activities_enqueue_signal_recommender',
        'operational_cases_enqueue_signal_recommender'
      )
  ) then raise exception 'a retired Signal worker still has live triggers'; end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.activities'::regclass
      and tgname = 'activities_contact_identity_resolution'
      and not tgisinternal
  ) then raise exception 'the independent identity trigger is missing'; end if;
  if exists (
    select 1 from public.agent_jobs
    where agent_key = 'signal-triage'
      and (
        status = 'pending'
        or (status = 'leased' and (leased_until is null or leased_until <= now()))
      )
  ) then raise exception 'unfinished retired Signal classifier jobs remain active'; end if;

  -- An unknown, reachable inbound signal receives its dedicated classifier
  -- job. Other signal-processing queues may coexist without sharing completion.
  insert into public.activities (
    workspace_key, source, account_email, external_id, external_thread_id,
    event_type, direction, actor_name, actor_email, from_email, subject,
    preview, body_text, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-lead-' || v_stamp, 'pl-thread-' || v_stamp, 'email.received',
    'inbound', 'Pat Prospect', 'pat-' || v_stamp || '@example.invalid',
    'pat-' || v_stamp || '@example.invalid', 'Exterior quote',
    'Can you quote our exterior?', 'Can you quote our two-storey exterior?', now()
  ) returning id into v_activity;

  select id into v_job
  from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity;
  if v_job is null then raise exception 'an eligible live signal was not queued for the dedicated classifier'; end if;
  if exists (
    select 1 from public.agent_jobs
    where agent_key = 'signal-triage' and activity_id = v_activity
  ) then raise exception 'a new job was created for the retired Signal classifier'; end if;
  if exists (
    select 1 from public.agent_jobs
    where agent_key = 'signal-recommender' and activity_id = v_activity
  ) then raise exception 'a new job was created for the retired Signal Recommender'; end if;

  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_owner = 'contract', claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_payload := public.inspect_potential_lead_classifier_job(v_job, v_token);
  if v_payload -> 'signal' ->> 'externalId' is distinct from 'pl-lead-' || v_stamp
    or v_payload -> 'signal' ->> 'accountEmail' is distinct from 'classifier-contract@fluid.invalid'
    or v_payload -> 'contract' ->> 'databaseEligibilityAuthoritative' is distinct from 'true'
    or v_payload -> 'contract' ->> 'historicalBackfill' is distinct from 'false'
    or jsonb_typeof(v_payload -> 'attachments') is distinct from 'array'
    or coalesce((v_payload -> 'identities' -> 0 ->> 'activeClaimCount')::integer, -1) <> 0
  then raise exception 'inspect payload violated the dedicated classifier contract: %', v_payload; end if;

  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'lead', 0.91, 'Pat Prospect',
    'pat-' || v_stamp || '@example.invalid', null,
    'Wants an exterior quote', 'Direct request for painting work',
    'contract-model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{"kind":"quote-request"}'::jsonb
  );
  if v_result ->> 'verdict' is distinct from 'lead'
    or v_result -> 'leadCandidate' ->> 'recorded' is distinct from 'true'
  then raise exception 'lead completion failed: %', v_result; end if;
  v_candidate := (v_result -> 'leadCandidate' ->> 'id')::bigint;
  if not exists (
    select 1 from public.lead_candidates candidate
    join public.lead_candidate_signals sighting on sighting.candidate_id = candidate.id
    join public.agent_runs run on run.id = sighting.agent_run_id
    where candidate.id = v_candidate
      and candidate.contact_key = 'email:pat-' || v_stamp || '@example.invalid'
      and candidate.contact_email = 'pat-' || v_stamp || '@example.invalid'
      and candidate.disposition = 'undecided'
      and sighting.activity_id = v_activity
      and sighting.verdict = 'lead'
      and run.agent_key = 'potential-lead-classifier'
      and run.runtime_provider = 'hermes'
      and run.runtime_profile = 'default'
      and run.runtime_job_id = 'contract-job'
      and run.runtime_execution_id = 'contract-execution'
      and run.runtime_session_id = 'contract-session'
      and run.result_schema_version = 1
      and run.result_kind = 'potential-lead-verdict'
      and run.result_title = 'Potential lead identified'
      and run.result_payload ->> 'verdict' = 'lead'
  ) then raise exception 'the candidate/run was not owned by the dedicated classifier'; end if;

  v_list := public.list_lead_candidates('ottawa-painters', 500);
  if not exists (
    select 1 from jsonb_array_elements(v_list -> 'items') item
    where (item ->> 'id')::bigint = v_candidate
  ) then raise exception 'the candidate was missing from the preserved Board API'; end if;
  -- The touch-day strip: their first message lights today's cell as "they
  -- wrote", nothing has gone out yet, and the strip starts on first contact.
  if not exists (
    select 1 from jsonb_array_elements(v_list -> 'items') item
    where (item ->> 'id')::bigint = v_candidate
      and jsonb_typeof(item -> 'touches' -> 'days') = 'array'
      and jsonb_array_length(item -> 'touches' -> 'days') = 1
      and (item -> 'touches' -> 'days' ->> 0)::int = 3
      and (item -> 'touches' ->> 'inbound')::int >= 1
      and (item -> 'touches' ->> 'outbound')::int = 0
      and item -> 'touches' ->> 'lastDirection' = 'inbound'
      and item -> 'touches' ->> 'phase' = 'first_contact'
  ) then raise exception 'the candidate touch strip does not reflect their first message: %', v_list; end if;

  -- Material Signal updates do not revive the retired Recommender.
  update public.activities
  set body_text = body_text || ' More detail.'
  where id = v_activity;
  if exists (
    select 1 from public.agent_jobs
    where agent_key = 'signal-recommender' and activity_id = v_activity
  ) then raise exception 'a material Signal update revived the retired Signal Recommender'; end if;

  -- Signal read state remains independent of classifier state.
  v_result := public.mark_signal_read('ottawa-painters', v_activity, 'contract');
  if v_result ->> 'firstRead' is distinct from 'true' then raise exception 'first read was not recorded'; end if;
  v_result := public.mark_signal_read('ottawa-painters', v_activity, 'contract');
  if v_result ->> 'firstRead' is distinct from 'false' then raise exception 'duplicate read was not idempotent'; end if;

  -- Once an active CRM Contact claims the exact identity, the audit row stays
  -- but the card leaves the Potential Leads read model.
  perform public.set_lead_candidate_disposition('ottawa-painters', v_candidate, 'lead', 'contract');
  select identity_id into v_identity
  from public.activity_identities
  where activity_id = v_activity and relationship = 'actor'
  order by identity_id limit 1;
  insert into public.people (display_name, primary_email)
  values ('Pat CRM ' || v_stamp, 'pat-' || v_stamp || '@example.invalid')
  returning id into v_person;
  insert into public.person_identity_claims (
    workspace_key, person_id, identity_id, source_system, source_record_type,
    source_record_id, active
  ) values (
    'ottawa-painters', v_person, v_identity, 'contract', 'person', v_person::text, true
  );
  v_list := public.list_lead_candidates('ottawa-painters', 500);
  if exists (
    select 1 from jsonb_array_elements(v_list -> 'items') item
    where (item ->> 'id')::bigint = v_candidate
  ) or not exists (
    select 1 from public.lead_candidates where id = v_candidate and disposition = 'lead'
  ) then raise exception 'CRM ownership did not hide the card while preserving audit'; end if;

  v_result := public.record_lead_candidate(
    'ottawa-painters', v_activity, 'Pat', 'pat-' || v_stamp || '@example.invalid',
    null, 'summary', 'reason', 0.8, null, 'model',
    'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if v_result ->> 'skipped' is distinct from 'known-contact' then
    raise exception 'the database did not refuse an active CRM identity: %', v_result;
  end if;
  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    actor_email, from_email, subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-known-fallback-' || v_stamp, 'email.received', 'inbound', null,
    'pat-' || v_stamp || '@example.invalid', 'Known fallback sender', 'Known', now()
  );
  if exists (
    select 1 from public.agent_jobs job
    join public.activities activity on activity.id = job.activity_id
    where job.agent_key = 'potential-lead-classifier'
      and activity.external_id = 'pl-known-fallback-' || v_stamp
      and job.status in ('pending', 'leased')
  ) then raise exception 'a known from_email fallback reached the classifier queue'; end if;

  -- A later not_lead revision retracts only an undecided classifier card. A
  -- human decision always wins and survives reclassification.
  insert into public.activities (
    workspace_key, source, account_email, external_id, external_thread_id,
    event_type, direction, actor_name, actor_email, from_email, subject,
    preview, body_text, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-human-' || v_stamp, 'pl-human-thread-' || v_stamp, 'email.received',
    'inbound', 'Human Review', 'human-' || v_stamp || '@example.invalid',
    'human-' || v_stamp || '@example.invalid', 'Painting inquiry', 'Need a quote',
    'Please quote this work', now()
  ) returning id into v_activity_two;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_two
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'lead', 0.85, 'Human Review', null, null,
    'Possible job', 'Painting inquiry', 'model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  v_candidate_two := (v_result -> 'leadCandidate' ->> 'id')::bigint;

  -- A CRM identity claim can land after lease acquisition without changing the
  -- Activity revision. Completion preserves the undecided audit row and the
  -- read model hides it instead of treating the stale not_lead as a deletion.
  update public.activities
  set body_text = body_text || ' before late claim'
  where id = v_activity_two;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_two
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  select identity_id into v_identity
  from public.activity_identities
  where activity_id = v_activity_two and relationship = 'actor'
  order by identity_id limit 1;
  insert into public.people (display_name, primary_email)
  values ('Late Claim ' || v_stamp, 'human-' || v_stamp || '@example.invalid')
  returning id into v_person;
  insert into public.person_identity_claims (
    workspace_key, person_id, identity_id, source_system, source_record_type,
    source_record_id, active
  ) values (
    'ottawa-painters', v_person, v_identity, 'contract', 'person', v_person::text, true
  );
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'not_lead', 0.95, null, null, null, null,
    'Claim landed during lease', 'model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  v_list := public.list_lead_candidates('ottawa-painters', 500);
  if v_result -> 'leadCandidate' ->> 'skipped' is distinct from 'known-contact'
    or not exists (
      select 1 from public.lead_candidates
      where id = v_candidate_two and disposition = 'undecided'
    )
    or exists (
      select 1 from jsonb_array_elements(v_list -> 'items') item
      where (item ->> 'id')::bigint = v_candidate_two
    )
  then raise exception 'late CRM claim did not preserve hidden audit: %', v_result; end if;
  delete from public.people where id = v_person;

  perform public.set_lead_candidate_disposition('ottawa-painters', v_candidate_two, 'lead', 'contract');

  update public.activities set body_text = body_text || ' updated' where id = v_activity_two;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_two
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  perform public.complete_potential_lead_classifier_job(
    v_job, v_token, 'not_lead', 0.95, null, null, null, null,
    'Follow-up proves it is not work', 'model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if not exists (
    select 1 from public.lead_candidates where id = v_candidate_two and disposition = 'lead'
  ) then raise exception 'classifier erased a human decision'; end if;

  perform public.set_lead_candidate_disposition('ottawa-painters', v_candidate_two, 'undecided', 'contract');
  update public.activities set preview = preview || ' revised' where id = v_activity_two;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_two
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'not_lead', 0.97, null, null, null, null,
    'Not a customer inquiry', 'model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if v_result -> 'leadCandidate' ->> 'removedUndecided' is distinct from 'true'
    or exists (select 1 from public.lead_candidates where id = v_candidate_two)
  then raise exception 'not_lead did not retract the undecided classifier card'; end if;

  -- ================= contact-keyed candidates =================
  -- One card per contact: a second signal from the same identity refreshes
  -- the same card, attaches a second sighting, and enriches with content-
  -- claimed contact details — it never mints another card.
  insert into public.activities (
    workspace_key, source, account_email, external_id, external_thread_id,
    event_type, direction, actor_name, actor_email, from_email, subject,
    preview, body_text, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-one-' || v_stamp, 'pl-one-thread-' || v_stamp, 'email.received',
    'inbound', null, 'same-' || v_stamp || '@example.invalid',
    'same-' || v_stamp || '@example.invalid', 'First touch', 'Quote?',
    'Quote please', now()
  ) returning id into v_activity_first;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_first;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'lead', 0.7, null, null, null,
    'First inquiry', 'Painting inquiry', 'model',
    'fluid-potential-lead-classifier-v2', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  v_candidate := (v_result -> 'leadCandidate' ->> 'id')::bigint;

  insert into public.activities (
    workspace_key, source, account_email, external_id, external_thread_id,
    event_type, direction, actor_name, actor_email, from_email, subject,
    preview, body_text, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-two-' || v_stamp, 'pl-two-thread-' || v_stamp, 'email.received',
    'inbound', null, 'same-' || v_stamp || '@example.invalid',
    'same-' || v_stamp || '@example.invalid', 'Second touch',
    'My name is Sam Stated', 'My name is Sam Stated, direct email sam.direct-' || v_stamp || '@example.invalid', now()
  ) returning id into v_activity_second;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_second;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'lead', 0.9, 'Sam Stated',
    'sam.direct-' || v_stamp || '@example.invalid', null,
    'Second inquiry with details', 'Painting inquiry', 'model',
    'fluid-potential-lead-classifier-v2', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if (v_result -> 'leadCandidate' ->> 'id')::bigint is distinct from v_candidate
    or v_result -> 'leadCandidate' ->> 'created' is distinct from 'false'
  then raise exception 'a second signal from the same contact minted a new card: %', v_result; end if;
  if (select count(*) from public.lead_candidate_signals where candidate_id = v_candidate) <> 2 then
    raise exception 'the sightings ledger did not attach both signals';
  end if;
  if not exists (
    select 1 from public.lead_candidates
    where id = v_candidate
      and contact_key = 'email:same-' || v_stamp || '@example.invalid'
      and claimed_name = 'Sam Stated'
      and claimed_email = 'sam.direct-' || v_stamp || '@example.invalid'
  ) then raise exception 'content-claimed contact details were not stored as claimed_* enrichment'; end if;

  v_list := public.list_lead_candidates('ottawa-painters', 500);
  if not exists (
    select 1 from jsonb_array_elements(v_list -> 'items') item
    where (item ->> 'id')::bigint = v_candidate
      and (item ->> 'signalCount')::int = 2
      and (item ->> 'activityId')::bigint = v_activity_second
      and item ->> 'summary' = 'Second inquiry with details'
      and item ->> 'claimedName' = 'Sam Stated'
  ) then raise exception 'the contact rollup is wrong: %', v_list; end if;
  if (
    select count(*) from jsonb_array_elements(v_list -> 'items') item
    where (item ->> 'id')::bigint = v_candidate
  ) <> 1 then raise exception 'the same contact appeared as more than one card'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_list -> 'items') item
    where item ? 'personId' or item ? 'channel'
  ) then raise exception 'retired wire keys are still emitted'; end if;

  -- Rule 5: flipping ONE of two supporting signals keeps the card, and the
  -- display falls back to the remaining lead-verdict signal.
  update public.activities set preview = 'Actually spam' where id = v_activity_second;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_second
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'not_lead', 0.9, null, null, null, null,
    'Second look says not work', 'model',
    'fluid-potential-lead-classifier-v2', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if v_result -> 'leadCandidate' ->> 'removedUndecided' is distinct from 'false'
    or not exists (select 1 from public.lead_candidates where id = v_candidate and disposition = 'undecided')
  then raise exception 'a single not_lead flip deleted a still-supported card: %', v_result; end if;
  v_list := public.list_lead_candidates('ottawa-painters', 500);
  if not exists (
    select 1 from jsonb_array_elements(v_list -> 'items') item
    where (item ->> 'id')::bigint = v_candidate
      and (item ->> 'activityId')::bigint = v_activity_first
      and (item ->> 'signalCount')::int = 2
  ) then raise exception 'the display did not fall back to the remaining lead signal: %', v_list; end if;

  -- Reopen rule: a dismissed contact reopens on a NEW lead-verdict signal —
  -- once, on the same card, with the flip logged — but a repeated lead verdict
  -- on evidence the human already saw stays silent.
  perform public.set_lead_candidate_disposition('ottawa-painters', v_candidate, 'not_lead', 'contract');
  insert into public.activities (
    workspace_key, source, account_email, external_id, external_thread_id,
    event_type, direction, actor_email, from_email, subject, preview, body_text, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-three-' || v_stamp, 'pl-three-thread-' || v_stamp, 'email.received',
    'inbound', 'same-' || v_stamp || '@example.invalid',
    'same-' || v_stamp || '@example.invalid', 'Third touch', 'Ready to book',
    'I want to book the job', now()
  ) returning id into v_activity_third;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_third;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'lead', 0.95, null, null, null,
    'Wants to book the job', 'Painting inquiry', 'model',
    'fluid-potential-lead-classifier-v2', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if v_result -> 'leadCandidate' ->> 'reopened' is distinct from 'true'
    or not exists (
      select 1 from public.lead_candidates
      where id = v_candidate and disposition = 'undecided'
        and decided_at is null and decided_by is null
    )
  then raise exception 'a new lead signal did not reopen the dismissed contact: %', v_result; end if;
  if (
    select jsonb_array_length(decision_log) from public.lead_candidates where id = v_candidate
  ) < 2 then raise exception 'the decision log did not record the human verdict and the reopen'; end if;

  perform public.set_lead_candidate_disposition('ottawa-painters', v_candidate, 'not_lead', 'contract');
  update public.activities set preview = preview || ' again' where id = v_activity_third;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_third
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'lead', 0.95, null, null, null,
    'Wants to book the job', 'Painting inquiry', 'model',
    'fluid-potential-lead-classifier-v2', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if v_result -> 'leadCandidate' ->> 'reopened' is distinct from 'false'
    or exists (select 1 from public.lead_candidates where id = v_candidate and disposition = 'undecided')
  then raise exception 'a repeated lead verdict on already-dismissed evidence reopened the card: %', v_result; end if;

  -- A standalone not_lead decision succeeds without ever creating a card.
  insert into public.activities (
    workspace_key, source, account_email, external_id, external_thread_id,
    event_type, direction, actor_email, from_email, subject, preview, body_text, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-not-' || v_stamp, 'pl-not-thread-' || v_stamp, 'email.received', 'inbound',
    'newsletter-' || v_stamp || '@example.invalid', 'newsletter-' || v_stamp || '@example.invalid',
    'Industry newsletter', 'News', 'This is a newsletter.', now()
  ) returning id into v_activity_not;
  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_not;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.complete_potential_lead_classifier_job(
    v_job, v_token, 'not_lead', 0.99, null, null, null, null,
    'Informational newsletter', 'model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if exists (
    select 1 from public.lead_candidate_signals where activity_id = v_activity_not
  ) or exists (
    select 1 from public.lead_candidates
    where contact_key = 'email:newsletter-' || v_stamp || '@example.invalid'
  ) then
    raise exception 'not_lead created a card';
  end if;

  -- Database eligibility prevents outbound, automated, system, unreachable,
  -- and pre-feature signals from ever reaching the classifier queue.
  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    actor_email, from_email, subject, preview, occurred_at
  ) values
    ('ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid', 'pl-out-' || v_stamp,
      'email.sent', 'outbound', 'out-' || v_stamp || '@example.invalid',
      'out-' || v_stamp || '@example.invalid', 'Outbound', 'Sent', now()),
    ('ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid', 'pl-auto-' || v_stamp,
      'email.received', 'inbound', 'auto-' || v_stamp || '@example.invalid',
      'auto-' || v_stamp || '@example.invalid', 'Automated', 'Automated', now());
  update public.activities
  set source_metadata = '{"automated":true}'::jsonb
  where external_id = 'pl-auto-' || v_stamp;
  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    actor_email, from_email, subject, preview, occurred_at
  ) values
    ('ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid', 'pl-system-' || v_stamp,
      'email.received', 'inbound', null,
      'noreply-' || v_stamp || '@example.invalid', 'System', 'System', now()),
    ('ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid', 'pl-none-' || v_stamp,
      'email.received', 'inbound', null, null, 'Unknown', 'No contact', now());
  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    actor_email, from_email, subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid', 'pl-old-' || v_stamp,
    'email.received', 'inbound', 'old-' || v_stamp || '@example.invalid',
    'old-' || v_stamp || '@example.invalid', 'Old', 'Old', v_started_at - interval '1 day'
  )
  returning id into v_old_activity;
  if exists (
    select 1 from public.agent_jobs job
    join public.activities activity on activity.id = job.activity_id
    where job.agent_key = 'potential-lead-classifier'
      and activity.external_id in (
        'pl-out-' || v_stamp, 'pl-auto-' || v_stamp, 'pl-system-' || v_stamp,
        'pl-none-' || v_stamp, 'pl-old-' || v_stamp,
        'pl-known-fallback-' || v_stamp
      )
      and job.status in ('pending', 'leased')
  ) then raise exception 'an ineligible signal reached the classifier queue'; end if;

  -- Late Quo evidence creates a fresh dedicated revision. A completion leased
  -- before the summary cannot write stale output, and the staged summary is
  -- deterministically bounded to 20 entries / 4,000 characters each.
  insert into public.activities (
    workspace_key, source, account_email, account_phone, external_id,
    external_thread_id, event_type, direction, actor_name, actor_phone,
    from_phone, subject, preview, occurred_at, call_status, duration_seconds
  ) values (
    'ottawa-painters', 'quo', null, '+16135550000',
    'pl-call-' || v_stamp, 'pl-call-thread-' || v_stamp, 'call.completed',
    'inbound', 'Caller', '+16135550123', '+16135550123', 'Inbound call',
    'Voicemail pending', now(), 'completed', 42
  ) returning id into v_activity_call;
  select id into v_old_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_call;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_old_job returning lease_token into v_token;

  insert into public.activity_call_summaries (
    activity_id, workspace_key, provider, provider_call_id, status, summary, next_steps
  ) values (
    v_activity_call, 'ottawa-painters', 'quo', 'pl-provider-call-' || v_stamp,
    'available',
    (select jsonb_agg(to_jsonb(repeat('s', 5000))) from generate_series(1, 25)),
    (select jsonb_agg(to_jsonb(repeat('n', 5000))) from generate_series(1, 25))
  );
  v_result := public.complete_potential_lead_classifier_job(
    v_old_job, v_token, 'lead', 0.8, 'Caller', null, '+16135550123',
    'Early result', 'Before summary', 'model', 'fluid-potential-lead-classifier-v1', 'default', 'contract-job', 'contract-execution', 'contract-session', '{}'::jsonb
  );
  if v_result ->> 'status' is distinct from 'superseded'
    or exists (select 1 from public.agent_runs where job_id = v_old_job)
  then raise exception 'a stale call completion was not safely superseded: %', v_result; end if;

  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_call
  order by input_revision desc limit 1;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_payload := public.inspect_potential_lead_classifier_job(v_job, v_token);
  if jsonb_array_length(v_payload -> 'callSummary' -> 'summary') <> 20
    or char_length(v_payload -> 'callSummary' -> 'summary' ->> 0) <> 4000
    or jsonb_array_length(v_payload -> 'callSummary' -> 'nextSteps') <> 20
  then raise exception 'the late call summary was not bounded in the staged payload'; end if;

  -- Reconcile repairs a missed post-cutoff live job, but never the old signal.
  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    actor_email, from_email, subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'classifier-contract@fluid.invalid',
    'pl-missed-' || v_stamp, 'email.received', 'inbound',
    'missed-' || v_stamp || '@example.invalid', 'missed-' || v_stamp || '@example.invalid',
    'Missed live inquiry', 'Quote please', now()
  ) returning id into v_activity_missed;
  delete from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_missed;
  v_result := public.reconcile_potential_lead_classifier('ottawa-painters', 500);
  if not exists (
    select 1 from public.agent_jobs
    where agent_key = 'potential-lead-classifier' and activity_id = v_activity_missed
  ) or exists (
    select 1 from public.agent_jobs
    where agent_key = 'potential-lead-classifier' and activity_id = v_old_activity
  ) then raise exception 'reconciliation crossed the feature cutoff: %', v_result; end if;

  select id into v_job from public.agent_jobs
  where agent_key = 'potential-lead-classifier' and activity_id = v_activity_missed;
  update public.agent_jobs
  set status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
      claimed_at = now(), leased_until = now() + interval '15 minutes'
  where id = v_job returning lease_token into v_token;
  v_result := public.fail_potential_lead_classifier_job(
    v_job, v_token, 'contract failure', 'model', 'fluid-potential-lead-classifier-v1',
    'default', 'contract-job', 'contract-execution', 'contract-session'
  );
  if v_result ->> 'status' is distinct from 'pending'
    or not exists (
      select 1 from public.agent_runs
      where job_id = v_job and agent_key = 'potential-lead-classifier' and status = 'failed'
    )
  then raise exception 'classifier failure did not preserve retry/audit state: %', v_result; end if;

  if not exists (
    select 1 from public.agent_job_events
    where job_id = v_job and event_kind = 'queued' and attempt = 0
  ) or not exists (
    select 1 from public.agent_job_events
    where job_id = v_job and event_kind = 'claimed' and attempt = 1
  ) or not exists (
    select 1 from public.agent_job_events
    where job_id = v_job and event_kind = 'running' and attempt = 1
  ) or not exists (
    select 1 from public.agent_job_events
    where job_id = v_job and event_kind = 'failed' and attempt = 1
  ) or not exists (
    select 1 from public.agent_job_events
    where job_id = v_job and event_kind = 'queued' and attempt = 1
  ) then raise exception 'the append-only queue lifecycle is incomplete'; end if;

  if has_function_privilege('anon', 'public.claim_potential_lead_classifier_job(text,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.complete_potential_lead_classifier_job(bigint,uuid,text,numeric,text,text,text,text,text,text,text,text,text,text,text,jsonb)', 'EXECUTE')
    or has_table_privilege('authenticated', 'public.agent_jobs', 'SELECT')
    or has_table_privilege('authenticated', 'public.agent_runs', 'SELECT')
    or has_table_privilege('authenticated', 'public.agent_job_events', 'SELECT')
  then raise exception 'classifier worker RPCs are exposed to browser roles'; end if;
end;
$$;

rollback;
