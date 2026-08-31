-- Potential Leads: inbound communication from someone who is not in the CRM yet.
--
-- A missed call, an inquiry email, a form fill — anything arriving that might be
-- work. Hermes decides; a voicemail that turns out to be a store promo simply
-- never becomes a row here. Fluid never authors a DripJobs contact, so a
-- candidate stays in this column until a human creates the contact in DripJobs.
--
-- Also: read/unread for Signals, which the column list previously had no notion
-- of, so every card looked identical whether or not anyone had opened it.

-- ---------------------------------------------------------------------------
-- read state
-- ---------------------------------------------------------------------------

-- Deliberately not revision-scoped, unlike signal_review_states: re-parsing a
-- message body does not make it unread again.
create table public.signal_reads (
  workspace_key text not null,
  activity_id bigint not null references public.activities(id) on delete cascade,
  read_at timestamptz not null default now(),
  read_by text not null default 'manager',
  primary key (workspace_key, activity_id)
);

comment on table public.signal_reads is
  'Which Signals a human has opened. Absence means unread; the row is never deleted on re-parse.';

create index signal_reads_read_at_idx on public.signal_reads (workspace_key, read_at desc);

-- Everything that already exists counts as read: unread starts meaning "arrived
-- after Fluid learned to track it", not "is older than this migration".
insert into public.signal_reads (workspace_key, activity_id, read_by, read_at)
select workspace_key, id, 'backfill', now()
from public.activities
on conflict (workspace_key, activity_id) do nothing;

-- ---------------------------------------------------------------------------
-- potential leads
-- ---------------------------------------------------------------------------

create table public.lead_candidate_settings (
  workspace_key text primary key,
  -- No backfill. Signals older than this are never considered, so turning the
  -- feature on does not retroactively invent a column full of history.
  started_at timestamptz not null default now(),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.lead_candidate_settings is
  'When Potential Leads began. Signals before started_at are never evaluated.';

insert into public.lead_candidate_settings (workspace_key) values ('ottawa-painters');

create table public.lead_candidates (
  id bigserial primary key,
  workspace_key text not null default 'ottawa-painters',
  activity_id bigint not null references public.activities(id) on delete cascade,
  -- Set only once the person exists in Fluid. A candidate is by definition
  -- someone the CRM does not know yet, so this is usually null.
  person_id uuid references public.people(id) on delete set null,
  contact_name text,
  contact_email text,
  contact_phone text,
  channel text not null,
  summary text not null,
  reason text not null default '',
  confidence numeric,
  agent_key text not null default 'signal-triage',
  agent_run_id uuid,
  model text not null default '',
  prompt_version text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  -- The human verdict. A decided candidate is never removed from the column; it
  -- dims and sinks, so the decision stays auditable and reversible.
  disposition text not null default 'undecided',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_candidates_activity_key unique (workspace_key, activity_id),
  constraint lead_candidates_disposition_check
    check (disposition in ('undecided', 'lead', 'not_lead')),
  -- A lead you cannot contact is not a lead. At least one of email or phone
  -- must be present, enforced here so an unreachable candidate cannot exist.
  constraint lead_candidates_reachable_check check (
    nullif(btrim(coalesce(contact_email, '')), '') is not null
    or nullif(btrim(coalesce(contact_phone, '')), '') is not null
  ),
  constraint lead_candidates_decision_check check (
    (disposition = 'undecided' and decided_at is null and decided_by is null)
    or (disposition <> 'undecided' and decided_at is not null)
  ),
  constraint lead_candidates_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1))
);

comment on table public.lead_candidates is
  'Inbound communication Hermes judged to be possible work from someone not in the CRM. Fluid never creates the DripJobs contact.';

-- Undecided first, newest first: the column's reading order is its query order.
create index lead_candidates_board_idx
  on public.lead_candidates (workspace_key, (disposition = 'undecided') desc, created_at desc);
create index lead_candidates_activity_idx on public.lead_candidates (activity_id);
create index lead_candidates_person_idx on public.lead_candidates (person_id)
  where person_id is not null;

-- ---------------------------------------------------------------------------
-- write paths
-- ---------------------------------------------------------------------------

create or replace function public.mark_signal_read(
  p_workspace_key text,
  p_activity_id bigint,
  p_actor text default 'manager'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  insert into public.signal_reads (workspace_key, activity_id, read_by)
  values (p_workspace_key, p_activity_id, coalesce(nullif(btrim(p_actor), ''), 'manager'))
  on conflict (workspace_key, activity_id) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('activityId', p_activity_id, 'firstRead', v_inserted > 0);
end;
$$;

/** Records one candidate, or explains why it was not recorded.
 *
 * Refuses signals from before the feature started and signals with no way to
 * reach the sender, so those rules cannot be bypassed by a caller that forgets
 * them. Re-running triage on the same signal updates the agent's fields but
 * never overwrites a decision a human already made. */
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
begin
  select * into v_settings from public.lead_candidate_settings
  where workspace_key = p_workspace_key;
  if not found or not v_settings.enabled then
    return jsonb_build_object('recorded', false, 'skipped', 'disabled');
  end if;

  select * into v_activity from public.activities where id = p_activity_id;
  if not found then
    return jsonb_build_object('recorded', false, 'skipped', 'unknown-signal');
  end if;
  if v_activity.occurred_at < v_settings.started_at then
    return jsonb_build_object('recorded', false, 'skipped', 'before-start');
  end if;
  if v_email is null and v_phone is null then
    return jsonb_build_object('recorded', false, 'skipped', 'unreachable');
  end if;

  insert into public.lead_candidates (
    workspace_key, activity_id, person_id, contact_name, contact_email, contact_phone,
    channel, summary, reason, confidence, agent_run_id, model, prompt_version, evidence
  )
  values (
    p_workspace_key, p_activity_id, v_activity.contact_id,
    nullif(btrim(coalesce(p_contact_name, '')), ''), v_email, v_phone,
    coalesce(nullif(btrim(coalesce(v_activity.event_type, '')), ''), 'unknown'),
    left(coalesce(p_summary, ''), 2000), left(coalesce(p_reason, ''), 2000),
    p_confidence, p_agent_run_id, coalesce(p_model, ''), coalesce(p_prompt_version, ''),
    coalesce(p_evidence, '{}'::jsonb)
  )
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
  returning id into v_id;

  return jsonb_build_object('recorded', true, 'id', v_id);
end;
$$;

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
-- access
-- ---------------------------------------------------------------------------

alter table public.signal_reads enable row level security;
alter table public.lead_candidates enable row level security;
alter table public.lead_candidate_settings enable row level security;

revoke all on table public.signal_reads, public.lead_candidates,
  public.lead_candidate_settings from public, anon, authenticated;
revoke all on sequence public.lead_candidates_id_seq from public, anon, authenticated;

grant all on table public.signal_reads, public.lead_candidates,
  public.lead_candidate_settings to service_role;
grant usage, select on sequence public.lead_candidates_id_seq to service_role;

revoke all on function public.mark_signal_read(text, bigint, text) from public, anon, authenticated;
revoke all on function public.record_lead_candidate(
  text, bigint, text, text, text, text, text, numeric, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.set_lead_candidate_disposition(text, bigint, text, text)
  from public, anon, authenticated;

grant execute on function public.mark_signal_read(text, bigint, text) to service_role;
grant execute on function public.record_lead_candidate(
  text, bigint, text, text, text, text, text, numeric, uuid, text, text, jsonb
) to service_role;
grant execute on function public.set_lead_candidate_disposition(text, bigint, text, text)
  to service_role;
