-- A sender whose identity is actively claimed by a Contact is already known to
-- the CRM, even when no counterparty link could be chosen for the signal.
--
-- record_lead_candidate refused known contacts by looking only at
-- activity_people counterparty links. Identity resolution deliberately leaves
-- no such link when an identity is claimed by two active people (it files a
-- conflict suggestion instead), so a duplicated DripJobs contact could reach
-- Potential Leads as "not in the CRM yet" while a conflict said the opposite.
-- Check the claims themselves.

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
  -- Someone the CRM already knows belongs on the pipeline, not here: either a
  -- resolved counterparty link, or an identity any active Contact claims —
  -- one, or several in conflict, which resolution leaves unlinked on purpose.
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
      on claim.identity_id = link.identity_id
     and claim.active
    join public.people person
      on person.id = claim.person_id
     and person.status = 'active'
    where link.activity_id = v_activity.id
      and link.relationship = 'actor'
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
