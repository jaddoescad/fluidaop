-- Potential Leads: one card per contact, not per signal.
--
-- Until now lead_candidates was keyed unique (workspace_key, activity_id) —
-- one row per SIGNAL — so an unknown person who called, then texted twice,
-- minted three cards. This migration re-keys the card on the person's
-- normalized identity (already stored in contact_email/contact_phone by the
-- eligibility gate) and moves the per-signal classifier verdicts into a
-- sightings ledger. The classifier keeps judging signals; the human judges
-- each contact exactly once.
--
-- Product rules encoded here:
--   1. One card per contact (contact_key = 'email:<norm>' else 'phone:<norm>').
--   2. Undecided + new signal → the same card refreshes in place.
--   3. Dismissed + new signal attaches silently, UNLESS the classifier calls
--      the new signal a lead — then the card flips back to undecided and asks
--      again. Only new evidence reopens; not_lead verdicts never reopen.
--   4. Accepted → new signals attach silently; the card leaves for good once
--      the CRM claims the identity (existing read-model filters).
--   5. A not_lead verdict on one signal flips that sighting; the card is
--      removed only when it is undecided and no lead-verdict sightings remain.
--   7. Contact info the sender states in message CONTENT is stored as
--      claimed_* — display-only, never the identity key, never a filter.

-- ---------------------------------------------------------------------------
-- 1) the sightings ledger
-- ---------------------------------------------------------------------------

create table public.lead_candidate_signals (
  id bigserial primary key,
  workspace_key text not null default 'ottawa-painters',
  candidate_id bigint not null references public.lead_candidates(id) on delete cascade,
  activity_id bigint not null references public.activities(id) on delete cascade,
  verdict text not null,
  confidence numeric,
  summary text not null default '',
  reason text not null default '',
  agent_run_id uuid,
  input_revision integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A revision re-run replaces its own sighting rather than adding one.
  constraint lead_candidate_signals_activity_key unique (workspace_key, activity_id),
  constraint lead_candidate_signals_verdict_check check (verdict in ('lead', 'not_lead')),
  constraint lead_candidate_signals_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1))
);

comment on table public.lead_candidate_signals is
  'One classifier verdict per signal, attached to the contact-keyed Potential Lead card it supports. Model/prompt/evidence live on agent_runs via agent_run_id.';

create index lead_candidate_signals_candidate_idx
  on public.lead_candidate_signals (candidate_id);

alter table public.lead_candidate_signals enable row level security;
revoke all on table public.lead_candidate_signals from public, anon, authenticated;
grant select, insert, update, delete on table public.lead_candidate_signals to service_role;
grant usage, select on sequence public.lead_candidate_signals_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 2) contact-keyed candidates: new columns
-- ---------------------------------------------------------------------------

alter table public.lead_candidates
  add column contact_key text,
  add column decision_log jsonb not null default '[]'::jsonb,
  add column claimed_name text,
  add column claimed_email text,
  add column claimed_phone text;

comment on column public.lead_candidates.contact_key is
  'The person key: email:<normalized> else phone:<normalized>, from the eligibility gate. One card per key.';
comment on column public.lead_candidates.decision_log is
  'Every disposition change, human or classifier-reopen: [{at, by, disposition, via, activityId?}], newest last, capped at 50.';
comment on column public.lead_candidates.claimed_name is
  'Contact info the sender stated in message content. Display-only: never the identity key, never a visibility filter.';

-- ---------------------------------------------------------------------------
-- 3) backfill contact_key from the stored normalized identity
-- ---------------------------------------------------------------------------

update public.lead_candidates
set contact_key = case
  when private.fluid_normalize_email(contact_email) is not null
    then 'email:' || private.fluid_normalize_email(contact_email)
  when private.fluid_normalize_phone(contact_phone) is not null
    then 'phone:' || private.fluid_normalize_phone(contact_phone)
end;

do $$
begin
  if exists (select 1 from public.lead_candidates where contact_key is null) then
    raise exception 'a lead candidate has no derivable contact key; aborting migration';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) materialize one lead-verdict sighting per existing candidate row
-- ---------------------------------------------------------------------------

insert into public.lead_candidate_signals (
  workspace_key, candidate_id, activity_id, verdict, confidence, summary,
  reason, agent_run_id, input_revision, created_at, updated_at
)
select
  candidate.workspace_key, candidate.id, candidate.activity_id, 'lead',
  candidate.confidence, candidate.summary, candidate.reason,
  candidate.agent_run_id, activity.potential_lead_revision,
  candidate.created_at, candidate.updated_at
from public.lead_candidates candidate
join public.activities activity on activity.id = candidate.activity_id;

-- ---------------------------------------------------------------------------
-- 5) merge duplicate cards per contact key
-- ---------------------------------------------------------------------------

-- Survivor: any human-decided row (latest decision), else the newest row.
create temporary table _plc_survivors on commit drop as
select distinct on (workspace_key, contact_key)
  id as survivor_id, workspace_key, contact_key
from public.lead_candidates
order by workspace_key, contact_key,
  (disposition <> 'undecided') desc, decided_at desc nulls last,
  created_at desc, id desc;

update public.lead_candidate_signals sighting
set candidate_id = survivor.survivor_id
from public.lead_candidates loser
join _plc_survivors survivor
  on survivor.workspace_key = loser.workspace_key
 and survivor.contact_key = loser.contact_key
where sighting.candidate_id = loser.id
  and loser.id <> survivor.survivor_id;

-- The survivor takes the group's first-seen creation time and the newest
-- non-null contact fields, before the losers disappear.
update public.lead_candidates candidate
set created_at = grouped.first_created,
    contact_name = coalesce(candidate.contact_name, grouped.newest_name),
    contact_email = coalesce(candidate.contact_email, grouped.newest_email),
    contact_phone = coalesce(candidate.contact_phone, grouped.newest_phone),
    updated_at = now()
from _plc_survivors survivor,
lateral (
  select
    min(peer.created_at) as first_created,
    (array_agg(peer.contact_name order by peer.created_at desc)
      filter (where peer.contact_name is not null))[1] as newest_name,
    (array_agg(peer.contact_email order by peer.created_at desc)
      filter (where peer.contact_email is not null))[1] as newest_email,
    (array_agg(peer.contact_phone order by peer.created_at desc)
      filter (where peer.contact_phone is not null))[1] as newest_phone
  from public.lead_candidates peer
  where peer.workspace_key = survivor.workspace_key
    and peer.contact_key = survivor.contact_key
) grouped
where candidate.id = survivor.survivor_id;

delete from public.lead_candidates candidate
using _plc_survivors survivor
where candidate.workspace_key = survivor.workspace_key
  and candidate.contact_key = survivor.contact_key
  and candidate.id <> survivor.survivor_id;

-- ---------------------------------------------------------------------------
-- 6) the person key becomes the law
-- ---------------------------------------------------------------------------

alter table public.lead_candidates
  alter column contact_key set not null,
  add constraint lead_candidates_contact_key_check
    check (contact_key ~ '^(email|phone):.+'),
  add constraint lead_candidates_contact_key unique (workspace_key, contact_key);

-- ---------------------------------------------------------------------------
-- 7) drop what moved to the ledger or was dead
--    (activity_id drop cascades the old per-signal unique + index;
--     person_id has been hardcoded null since 20260831005520)
-- ---------------------------------------------------------------------------

alter table public.lead_candidates
  drop column activity_id,
  drop column person_id,
  drop column channel,
  drop column summary,
  drop column reason,
  drop column confidence,
  drop column agent_key,
  drop column agent_run_id,
  drop column model,
  drop column prompt_version,
  drop column evidence;

comment on table public.lead_candidates is
  'One prospective CONTACT the classifier flagged, keyed by normalized identity. Signals attach as lead_candidate_signals sightings; Fluid never creates the DripJobs contact.';

-- ---------------------------------------------------------------------------
-- 8) helpers
-- ---------------------------------------------------------------------------

create or replace function private.lead_candidate_log_append(
  p_log jsonb,
  p_entry jsonb
)
returns jsonb
language sql
immutable
as $$
  select coalesce((
    select jsonb_agg(tail.entry order by tail.position)
    from (
      select entry, position
      from jsonb_array_elements(coalesce(p_log, '[]'::jsonb) || jsonb_build_array(p_entry))
        with ordinality as appended(entry, position)
      order by position desc
      limit 50
    ) tail
  ), '[]'::jsonb);
$$;

comment on function private.lead_candidate_log_append(jsonb, jsonb) is
  'Appends one decision-log entry, keeping only the newest 50.';

revoke all on function private.lead_candidate_log_append(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function private.lead_candidate_log_append(jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9) write path: record a lead-verdict signal against its contact's card
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
  v_activity public.activities%rowtype;
  v_eligibility jsonb;
  v_contact_key text;
  v_claimed_name text;
  v_claimed_email text;
  v_claimed_phone text;
  v_candidate_id bigint;
  v_disposition text;
  v_inserted boolean;
  v_previous_candidate bigint;
  v_previous_verdict text;
  v_sighting_id bigint;
  v_reopened boolean := false;
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

  v_contact_key := case
    when v_eligibility ->> 'email' is not null then 'email:' || (v_eligibility ->> 'email')
    else 'phone:' || (v_eligibility ->> 'phone')
  end;

  -- Contact info the classifier extracted from message CONTENT. It enriches
  -- the card but never keys it; values that merely repeat the provider
  -- identity are noise and dropped.
  v_claimed_name := nullif(left(btrim(coalesce(p_contact_name, '')), 300), '');
  v_claimed_email := private.fluid_normalize_email(p_contact_email);
  v_claimed_phone := private.fluid_normalize_phone(p_contact_phone);
  if v_claimed_name is not distinct from (v_eligibility ->> 'name') then v_claimed_name := null; end if;
  if v_claimed_email is not distinct from (v_eligibility ->> 'email') then v_claimed_email := null; end if;
  if v_claimed_phone is not distinct from (v_eligibility ->> 'phone') then v_claimed_phone := null; end if;

  -- One card per contact. The conflict update takes the row lock; disposition
  -- is untouched here, so RETURNING disposition reads the pre-existing verdict.
  insert into public.lead_candidates (
    workspace_key, contact_key, contact_name, contact_email, contact_phone,
    claimed_name, claimed_email, claimed_phone
  ) values (
    p_workspace_key, v_contact_key,
    coalesce(v_eligibility ->> 'name', v_claimed_name),
    v_eligibility ->> 'email',
    v_eligibility ->> 'phone',
    v_claimed_name, v_claimed_email, v_claimed_phone
  )
  on conflict (workspace_key, contact_key) do update
  set contact_name = coalesce(lead_candidates.contact_name, excluded.contact_name),
      contact_email = coalesce(lead_candidates.contact_email, excluded.contact_email),
      contact_phone = coalesce(lead_candidates.contact_phone, excluded.contact_phone),
      claimed_name = coalesce(excluded.claimed_name, lead_candidates.claimed_name),
      claimed_email = coalesce(excluded.claimed_email, lead_candidates.claimed_email),
      claimed_phone = coalesce(excluded.claimed_phone, lead_candidates.claimed_phone),
      updated_at = now()
  returning id, disposition, (xmax = 0) into v_candidate_id, v_disposition, v_inserted;

  select candidate_id, verdict into v_previous_candidate, v_previous_verdict
  from public.lead_candidate_signals
  where workspace_key = p_workspace_key and activity_id = p_activity_id;

  insert into public.lead_candidate_signals (
    workspace_key, candidate_id, activity_id, verdict, confidence,
    summary, reason, agent_run_id, input_revision
  ) values (
    p_workspace_key, v_candidate_id, p_activity_id, 'lead', p_confidence,
    left(coalesce(nullif(btrim(coalesce(p_summary, '')), ''), v_activity.preview, v_activity.subject, ''), 2000),
    left(coalesce(p_reason, ''), 2000),
    p_agent_run_id, v_activity.potential_lead_revision
  )
  on conflict (workspace_key, activity_id) do update
  set candidate_id = excluded.candidate_id,
      verdict = excluded.verdict,
      confidence = excluded.confidence,
      summary = excluded.summary,
      reason = excluded.reason,
      agent_run_id = excluded.agent_run_id,
      input_revision = excluded.input_revision,
      updated_at = now()
  returning id into v_sighting_id;

  -- Rule 3: only NEW evidence reopens a dismissed contact — a new signal, or
  -- a signal whose verdict flipped to lead. A re-run repeating the verdict the
  -- human already dismissed stays silent. Accepted/undecided are never touched.
  if v_disposition = 'not_lead'
    and (v_previous_verdict is distinct from 'lead'
      or v_previous_candidate is distinct from v_candidate_id)
  then
    update public.lead_candidates
    set disposition = 'undecided',
        decided_by = null,
        decided_at = null,
        decision_log = private.lead_candidate_log_append(decision_log, jsonb_build_object(
          'at', now(), 'by', 'potential-lead-classifier',
          'disposition', 'undecided', 'via', 'classifier-reopen',
          'activityId', p_activity_id
        )),
        updated_at = now()
    where id = v_candidate_id;
    v_reopened := true;
  end if;

  -- A re-run whose derived identity changed moved the sighting between cards;
  -- the abandoned card only stands if lead-verdict sightings still support it.
  if v_previous_candidate is not null and v_previous_candidate is distinct from v_candidate_id then
    delete from public.lead_candidates candidate
    where candidate.id = v_previous_candidate
      and candidate.disposition = 'undecided'
      and not exists (
        select 1 from public.lead_candidate_signals sighting
        where sighting.candidate_id = candidate.id and sighting.verdict = 'lead'
      );
  end if;

  return jsonb_build_object(
    'recorded', true,
    'id', v_candidate_id,
    'created', v_inserted,
    'reopened', v_reopened,
    'sightingId', v_sighting_id
  );
end;
$$;

comment on function public.record_lead_candidate(
  text, bigint, text, text, text, text, text, numeric, uuid, text, text, jsonb
) is 'Attaches a lead-verdict signal to its contact-keyed Potential Lead card, creating or reopening the card per the eligibility gate and the reopen rule.';

-- ---------------------------------------------------------------------------
-- 10) write path: completion — not_lead becomes a recorded flip, never a
--     blind delete
-- ---------------------------------------------------------------------------

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
  v_candidate_id bigint;
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
  elsif v_eligibility ->> 'reason' = 'known-contact' then
    -- A CRM claim that lands during the lease preserves the card as audit;
    -- the read model hides it instead of treating the not_lead as a retraction.
    v_candidate := jsonb_build_object(
      'recorded', false, 'verdict', 'not_lead',
      'removedUndecided', false, 'skipped', 'known-contact'
    );
  else
    -- The card this signal belongs to: by identity while the signal is still
    -- eligible, else by whichever card its earlier sighting already sits on.
    if coalesce((v_eligibility ->> 'eligible')::boolean, false) then
      select id into v_candidate_id from public.lead_candidates
      where workspace_key = v_job.workspace_key
        and contact_key = case
          when v_eligibility ->> 'email' is not null then 'email:' || (v_eligibility ->> 'email')
          else 'phone:' || (v_eligibility ->> 'phone')
        end
      for update;
    end if;
    if v_candidate_id is null then
      select candidate_id into v_candidate_id
      from public.lead_candidate_signals
      where workspace_key = v_job.workspace_key and activity_id = v_job.activity_id;
    end if;

    if v_candidate_id is not null then
      -- Rule 5: the not_lead is a recorded verdict flip on this signal —
      -- sightings are only ever deleted with their card.
      insert into public.lead_candidate_signals (
        workspace_key, candidate_id, activity_id, verdict, confidence,
        summary, reason, agent_run_id, input_revision
      ) values (
        v_job.workspace_key, v_candidate_id, v_job.activity_id, 'not_lead',
        p_confidence, left(coalesce(nullif(btrim(coalesce(p_summary, '')), ''), ''), 2000),
        left(btrim(p_reason), 2000), v_run_id, v_job.input_revision
      )
      on conflict (workspace_key, activity_id) do update
      set candidate_id = excluded.candidate_id,
          verdict = excluded.verdict,
          confidence = excluded.confidence,
          summary = excluded.summary,
          reason = excluded.reason,
          agent_run_id = excluded.agent_run_id,
          input_revision = excluded.input_revision,
          updated_at = v_now;

      -- Rule 7: even a not-a-lead message can say who the sender is.
      update public.lead_candidates candidate
      set claimed_name = coalesce(
            case when nullif(left(btrim(coalesce(p_contact_name, '')), 300), '')
              is distinct from candidate.contact_name
              then nullif(left(btrim(coalesce(p_contact_name, '')), 300), '') end,
            candidate.claimed_name),
          claimed_email = coalesce(
            case when private.fluid_normalize_email(p_contact_email)
              is distinct from private.fluid_normalize_email(candidate.contact_email)
              then private.fluid_normalize_email(p_contact_email) end,
            candidate.claimed_email),
          claimed_phone = coalesce(
            case when private.fluid_normalize_phone(p_contact_phone)
              is distinct from private.fluid_normalize_phone(candidate.contact_phone)
              then private.fluid_normalize_phone(p_contact_phone) end,
            candidate.claimed_phone),
          contact_name = coalesce(candidate.contact_name,
            nullif(left(btrim(coalesce(p_contact_name, '')), 300), '')),
          updated_at = v_now
      where candidate.id = v_candidate_id
        and (p_contact_name is not null or p_contact_email is not null or p_contact_phone is not null);

      -- The card goes only when it is undecided and nothing supports it.
      delete from public.lead_candidates candidate
      where candidate.id = v_candidate_id
        and candidate.disposition = 'undecided'
        and not exists (
          select 1 from public.lead_candidate_signals sighting
          where sighting.candidate_id = candidate.id and sighting.verdict = 'lead'
        );
      get diagnostics v_removed = row_count;
    end if;

    v_candidate := jsonb_build_object(
      'recorded', false, 'verdict', 'not_lead',
      'removedUndecided', v_removed > 0, 'skipped', null
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

-- ---------------------------------------------------------------------------
-- 11) write path: the human verdict, now with a memory
-- ---------------------------------------------------------------------------

create or replace function public.set_lead_candidate_disposition(
  p_workspace_key text,
  p_candidate_id bigint,
  p_disposition text,
  p_actor text default 'manager'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lead_candidates%rowtype;
begin
  if p_disposition not in ('undecided', 'lead', 'not_lead') then
    raise exception 'Unknown lead candidate disposition: %', p_disposition;
  end if;

  update public.lead_candidates
  set disposition = p_disposition,
      -- Reverting to undecided clears the decision rather than leaving a stale
      -- author on a card nobody has judged.
      decided_by = case when p_disposition = 'undecided' then null
                        else coalesce(nullif(btrim(p_actor), ''), 'manager') end,
      decided_at = case when p_disposition = 'undecided' then null else now() end,
      decision_log = private.lead_candidate_log_append(decision_log, jsonb_build_object(
        'at', now(),
        'by', coalesce(nullif(btrim(p_actor), ''), 'manager'),
        'disposition', p_disposition,
        'via', 'human'
      )),
      updated_at = now()
  where workspace_key = p_workspace_key and id = p_candidate_id
  returning * into v_row;

  if not found then
    raise exception 'Lead candidate % was not found', p_candidate_id;
  end if;
  return jsonb_build_object(
    'id', v_row.id,
    'disposition', v_row.disposition,
    'decidedAt', v_row.decided_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 12) read path: touches anchor on the first sighting
-- ---------------------------------------------------------------------------

create or replace function private.lead_candidate_touches(
  p_workspace_key text,
  p_candidate_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with candidate as (
    select
      lead.id,
      lead.workspace_key,
      coalesce((
        select min(activity.occurred_at)
        from public.lead_candidate_signals sighting
        join public.activities activity on activity.id = sighting.activity_id
        where sighting.candidate_id = lead.id
      ), lead.created_at) as first_contact_at,
      private.fluid_normalize_email(lead.contact_email) as email_value,
      private.fluid_normalize_phone(lead.contact_phone) as phone_value
    from public.lead_candidates lead
    where lead.workspace_key = p_workspace_key
      and lead.id = p_candidate_id
  ),
  boundary as (
    select least(pg_catalog.now(), candidate.first_contact_at) as phase_started_at
    from candidate
  ),
  their_identity as (
    select identity.id
    from candidate
    join public.identities identity
      on identity.workspace_key = candidate.workspace_key
     and (
       (identity.kind = 'email' and candidate.email_value is not null
         and identity.normalized_value = candidate.email_value)
       or (identity.kind = 'phone' and candidate.phone_value is not null
         and identity.normalized_value = candidate.phone_value)
     )
  ),
  touch as (
    select distinct
      activity.id as activity_id,
      activity.direction,
      activity.occurred_at,
      lower(coalesce(activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
        as is_automated
    from their_identity
    join public.activity_identities link
      on link.identity_id = their_identity.id
     and link.relationship = 'actor'
    join public.activities activity on activity.id = link.activity_id
    cross join boundary
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and activity.occurred_at >= boundary.phase_started_at
  ),
  bounds as (
    select
      (pg_catalog.now() at time zone 'America/Toronto')::date as today,
      (boundary.phase_started_at at time zone 'America/Toronto')::date as entered_on
    from boundary
  ),
  strip_day as (
    select generated::date as on_date
    from bounds
    cross join generate_series(
      greatest(bounds.entered_on, bounds.today - 15)::timestamp,
      bounds.today::timestamp,
      interval '1 day'
    ) as generated
  ),
  day_level as (
    select
      strip_day.on_date,
      case
        when count(touch.activity_id) filter (
          where touch.direction = 'inbound' and not touch.is_automated
        ) > 0 then 3
        when count(touch.activity_id) filter (
          where touch.direction = 'outbound' and not touch.is_automated
        ) > 0 then 2
        when count(touch.activity_id) filter (where touch.is_automated) > 0 then 1
        else 0
      end as level
    from strip_day
    left join touch
      on (touch.occurred_at at time zone 'America/Toronto')::date = strip_day.on_date
    group by strip_day.on_date
  )
  select jsonb_build_object(
    'outbound', count(touch.activity_id) filter (
      where touch.direction = 'outbound' and not touch.is_automated
    ),
    'inbound', count(touch.activity_id) filter (
      where touch.direction = 'inbound' and not touch.is_automated
    ),
    'automated', count(touch.activity_id) filter (where touch.is_automated),
    'lastAt', max(touch.occurred_at) filter (where not touch.is_automated),
    'lastDirection', (
      array_agg(touch.direction order by touch.occurred_at desc, touch.activity_id desc)
        filter (where not touch.is_automated)
    )[1],
    'phase', 'first_contact',
    'phaseLabel', 'First contact',
    'phaseStartedAt', (select boundary.phase_started_at from boundary),
    'evidenceKind', 'exact',
    'days', (
      select coalesce(jsonb_agg(day_level.level order by day_level.on_date), '[]'::jsonb)
      from day_level
    ),
    'daysBefore', (
      select coalesce(greatest(0, (bounds.today - bounds.entered_on) - 15), 0)
      from bounds
    )
  )
  from touch;
$$;

-- ---------------------------------------------------------------------------
-- 13) read path: the Board list — contacts, with derived rollups
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
      display.activity_id as display_activity_id,
      display.summary as display_summary,
      display.reason as display_reason,
      display.confidence as display_confidence,
      stats.signal_count,
      stats.first_seen_at,
      stats.last_seen_at,
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
    -- The card displays its newest lead-verdict sighting (fallback: newest of
    -- any verdict). Deriving this keeps retractions self-healing, and the
    -- inner lateral naturally hides a zero-sighting orphan.
    cross join lateral (
      select sighting.activity_id, sighting.summary, sighting.reason, sighting.confidence
      from public.lead_candidate_signals sighting
      join public.activities sighted on sighted.id = sighting.activity_id
      where sighting.candidate_id = candidate.id
      order by (sighting.verdict = 'lead') desc, sighted.occurred_at desc, sighting.activity_id desc
      limit 1
    ) display
    cross join lateral (
      select
        count(*)::int as signal_count,
        min(sighted.occurred_at) as first_seen_at,
        max(sighted.occurred_at) as last_seen_at
      from public.lead_candidate_signals sighting
      join public.activities sighted on sighted.id = sighting.activity_id
      where sighting.candidate_id = candidate.id
    ) stats
    join public.activities activity on activity.id = display.activity_id
    left join public.activity_call_summaries call_summary
      on call_summary.activity_id = display.activity_id
     and call_summary.workspace_key = candidate.workspace_key
    left join public.activity_call_transcripts transcript
      on transcript.activity_id = display.activity_id
    where candidate.workspace_key = p_workspace_key
      and not exists (
        select 1
        from public.lead_candidate_signals sighting
        join public.activity_people link
          on link.activity_id = sighting.activity_id
         and link.relationship = 'counterparty'
        join public.people person on person.id = link.person_id
        where sighting.candidate_id = candidate.id
          and person.status = 'active'
      )
      and not exists (
        select 1
        from public.lead_candidate_signals sighting
        join public.activity_identities link
          on link.activity_id = sighting.activity_id
         and link.relationship = 'actor'
        join public.person_identity_claims claim
          on claim.identity_id = link.identity_id and claim.active
        join public.people person
          on person.id = claim.person_id and person.status = 'active'
        where sighting.candidate_id = candidate.id
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
  )
  select jsonb_build_object(
    'undecidedCount', (
      select count(*)::int from visible where visible.disposition = 'undecided'
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'activityId', item.display_activity_id,
        'name', item.contact_name,
        'email', item.contact_email,
        'phone', item.contact_phone,
        'claimedName', item.claimed_name,
        'claimedEmail', item.claimed_email,
        'claimedPhone', item.claimed_phone,
        'summary', item.display_summary,
        'reason', item.display_reason,
        'confidence', item.display_confidence,
        'disposition', item.disposition,
        'decidedBy', item.decided_by,
        'decidedAt', item.decided_at,
        'createdAt', item.created_at,
        'signalCount', item.signal_count,
        'firstSeenAt', item.first_seen_at,
        'lastSeenAt', item.last_seen_at,
        'touches', private.lead_candidate_touches(item.workspace_key, item.id),
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
        coalesce(item.decided_at, item.last_seen_at) desc,
        item.id desc)
      from (
        select * from visible
        order by (visible.disposition = 'undecided') desc,
          coalesce(visible.decided_at, visible.last_seen_at) desc,
          visible.id desc
        limit least(greatest(p_limit, 1), 500)
      ) item
    ), '[]'::jsonb)
  );
$$;
