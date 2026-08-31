-- Hermes Automation Activity and Signal-Run Protocol.
-- Legacy rows remain readable; new correlated rows carry exact Hermes
-- profile/job/execution/session identity and bounded presentation data for
-- server-rendered UI.

alter table public.agent_runs
  add column runtime_provider text,
  add column runtime_profile text,
  add column runtime_job_id text,
  add column runtime_execution_id text,
  add column runtime_session_id text,
  add column result_schema_version integer,
  add column result_kind text,
  add column result_title text,
  add column result_summary text,
  add column result_payload jsonb not null default '{}'::jsonb,
  add constraint agent_runs_runtime_correlation_check check (
    (
      runtime_provider is null
      and runtime_profile is null
      and runtime_job_id is null
      and runtime_execution_id is null
      and runtime_session_id is null
    )
    or (
      runtime_provider = 'hermes'
      and runtime_profile ~ '^[A-Za-z0-9_-]{1,64}$'
      and runtime_job_id ~ '^[A-Za-z0-9_.:-]{1,128}$'
      and runtime_execution_id ~ '^[A-Za-z0-9_.:-]{1,256}$'
      and runtime_session_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    )
  ),
  add constraint agent_runs_result_schema_version_check check (
    result_schema_version is null or result_schema_version between 1 and 1000
  ),
  add constraint agent_runs_result_kind_check check (
    result_kind is null or (
      char_length(result_kind) between 1 and 80
      and result_kind ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    )
  ),
  add constraint agent_runs_result_title_check check (
    result_title is null or char_length(result_title) between 1 and 160
  ),
  add constraint agent_runs_result_summary_check check (
    result_summary is null or char_length(result_summary) between 1 and 2000
  ),
  add constraint agent_runs_result_payload_size_check check (
    jsonb_typeof(result_payload) = 'object'
    and pg_column_size(result_payload) <= 131072
  );

comment on column public.agent_runs.runtime_profile is
  'Hermes profile captured from the worker runtime. Null only for legacy uncorrelated runs.';
comment on column public.agent_runs.runtime_job_id is
  'Verified Hermes cron job identity parsed from the runtime-owned session identifier.';
comment on column public.agent_runs.runtime_execution_id is
  'Exact durable Hermes execution captured from the active profile-local execution ledger.';
comment on column public.agent_runs.runtime_session_id is
  'Exact Hermes session captured from the worker runtime; never supplied by model output.';
comment on column public.agent_runs.result_payload is
  'Bounded, presentation-safe business result. Raw prompts, tool arguments, and secrets are prohibited.';

create index agent_runs_runtime_session_idx
  on public.agent_runs (runtime_profile, runtime_session_id, finished_at desc)
  where runtime_provider = 'hermes';

create index agent_runs_runtime_execution_idx
  on public.agent_runs (runtime_profile, runtime_execution_id, finished_at desc)
  where runtime_provider = 'hermes';

create table public.agent_job_events (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  agent_key text not null,
  job_id bigint not null references public.agent_jobs(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete cascade,
  activity_id bigint not null references public.activities(id) on delete cascade,
  event_kind text not null,
  attempt integer not null default 0,
  detail text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint agent_job_events_agent_key_check check (
    agent_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint agent_job_events_kind_check check (event_kind in (
    'queued', 'claimed', 'running', 'skipped', 'superseded',
    'retired', 'failed', 'completed'
  )),
  constraint agent_job_events_attempt_check check (attempt >= 0),
  constraint agent_job_events_detail_check check (
    detail is null or char_length(detail) <= 1000
  ),
  constraint agent_job_events_job_kind_attempt_key unique (job_id, event_kind, attempt)
);

comment on table public.agent_job_events is
  'Append-only Signal queue lifecycle. These are queue/run events, not global Hermes Activity executions.';

create index agent_job_events_activity_time_idx
  on public.agent_job_events (activity_id, occurred_at, id);
create index agent_job_events_run_idx
  on public.agent_job_events (agent_run_id)
  where agent_run_id is not null;

alter table public.agent_job_events enable row level security;
revoke all on table public.agent_job_events from public, anon, authenticated;
revoke all on sequence public.agent_job_events_id_seq from public, anon, authenticated;
grant all on table public.agent_job_events to service_role;
grant all on sequence public.agent_job_events_id_seq to service_role;

create function private.record_agent_job_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_detail text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then return new; end if;
    v_kind := 'queued';
  elsif new.status is not distinct from old.status then
    return new;
  elsif new.status = 'pending' then
    v_kind := 'queued';
    v_detail := case when old.status = 'leased' then 'Retry queued.' else null end;
  elsif new.status = 'leased' then
    v_kind := 'claimed';
  elsif new.status = 'retired' then
    v_kind := 'retired';
    v_detail := new.last_error;
  elsif new.status = 'succeeded' and not exists (
    select 1 from public.agent_runs run where run.job_id = new.id
  ) then
    if coalesce(new.last_error, '') ilike 'Superseded%' then
      v_kind := 'superseded';
    else
      v_kind := 'skipped';
    end if;
    v_detail := new.last_error;
  elsif new.status = 'failed' and not exists (
    select 1 from public.agent_runs run where run.job_id = new.id
  ) then
    v_kind := 'failed';
    v_detail := new.last_error;
  else
    return new;
  end if;

  insert into public.agent_job_events (
    workspace_key, agent_key, job_id, activity_id, event_kind, attempt,
    detail, occurred_at
  ) values (
    new.workspace_key, new.agent_key, new.id, new.activity_id, v_kind,
    new.attempts, left(nullif(btrim(coalesce(v_detail, '')), ''), 1000),
    coalesce(
      case v_kind
        when 'queued' then new.available_at
        when 'claimed' then new.claimed_at
        else new.finished_at
      end,
      new.updated_at,
      now()
    )
  ) on conflict (job_id, event_kind, attempt) do nothing;
  return new;
end;
$$;

create function private.record_agent_run_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.agent_jobs%rowtype;
begin
  select * into v_job from public.agent_jobs where id = new.job_id;
  if not found then return new; end if;

  insert into public.agent_job_events (
    workspace_key, agent_key, job_id, agent_run_id, activity_id,
    event_kind, attempt, occurred_at
  ) values (
    v_job.workspace_key, new.agent_key, new.job_id, new.id, new.activity_id,
    'running', v_job.attempts, coalesce(new.started_at, new.created_at, now())
  ) on conflict (job_id, event_kind, attempt) do nothing;

  insert into public.agent_job_events (
    workspace_key, agent_key, job_id, agent_run_id, activity_id,
    event_kind, attempt, detail, occurred_at
  ) values (
    v_job.workspace_key, new.agent_key, new.job_id, new.id, new.activity_id,
    case when new.status = 'completed' then 'completed' else 'failed' end,
    v_job.attempts, left(new.error, 1000), coalesce(new.finished_at, now())
  ) on conflict (job_id, event_kind, attempt) do nothing;
  return new;
end;
$$;

revoke all on function private.record_agent_job_lifecycle() from public, anon, authenticated;
revoke all on function private.record_agent_run_lifecycle() from public, anon, authenticated;

create trigger record_agent_job_lifecycle
after insert or update on public.agent_jobs
for each row execute function private.record_agent_job_lifecycle();

create trigger record_agent_run_lifecycle
after insert on public.agent_runs
for each row execute function private.record_agent_run_lifecycle();

-- Give existing queue rows a truthful legacy baseline. Existing model runs get
-- their historical running/terminal events; queue-only rows retain one current
-- state event and are labeled as legacy by the API when runtime correlation is absent.
insert into public.agent_job_events (
  workspace_key, agent_key, job_id, activity_id, event_kind, attempt, detail, occurred_at
)
select job.workspace_key, job.agent_key, job.id, job.activity_id, 'queued', 0,
  null, job.created_at
from public.agent_jobs job
on conflict (job_id, event_kind, attempt) do nothing;

insert into public.agent_job_events (
  workspace_key, agent_key, job_id, activity_id, event_kind, attempt, detail, occurred_at
)
select job.workspace_key, job.agent_key, job.id, job.activity_id,
  case
    when job.status = 'pending' then 'queued'
    when job.status = 'leased' then 'claimed'
    when job.status = 'retired' then 'retired'
    when job.status = 'succeeded' and coalesce(job.last_error, '') ilike 'Superseded%' then 'superseded'
    when job.status = 'succeeded' then 'skipped'
    else 'failed'
  end,
  job.attempts,
  left(job.last_error, 1000),
  coalesce(
    case
      when job.status = 'pending' then job.available_at
      when job.status = 'leased' then job.claimed_at
      else job.finished_at
    end,
    job.updated_at,
    job.created_at
  )
from public.agent_jobs job
where (job.status = 'pending' and job.attempts > 0)
   or job.status in ('leased', 'retired')
   or (
     job.status in ('succeeded', 'failed')
     and not exists (select 1 from public.agent_runs run where run.job_id = job.id)
   )
on conflict (job_id, event_kind, attempt) do nothing;

insert into public.agent_job_events (
  workspace_key, agent_key, job_id, agent_run_id, activity_id,
  event_kind, attempt, occurred_at
)
select job.workspace_key, run.agent_key, run.job_id, run.id, run.activity_id,
  'running', greatest(job.attempts, 1), coalesce(run.started_at, run.created_at, now())
from public.agent_runs run
join public.agent_jobs job on job.id = run.job_id
on conflict (job_id, event_kind, attempt) do nothing;

insert into public.agent_job_events (
  workspace_key, agent_key, job_id, agent_run_id, activity_id,
  event_kind, attempt, detail, occurred_at
)
select job.workspace_key, run.agent_key, run.job_id, run.id, run.activity_id,
  case when run.status = 'completed' then 'completed' else 'failed' end,
  greatest(job.attempts, 1), left(run.error, 1000), coalesce(run.finished_at, now())
from public.agent_runs run
join public.agent_jobs job on job.id = run.job_id
on conflict (job_id, event_kind, attempt) do nothing;

-- Queue and run internals are projected only through server functions. The
-- browser no longer receives direct table privileges, even for managers.
drop policy if exists agent_jobs_manager_read on public.agent_jobs;
drop policy if exists agent_runs_manager_read on public.agent_runs;
revoke all on table public.agent_jobs, public.agent_runs from anon, authenticated;
grant all on table public.agent_jobs, public.agent_runs to service_role;

-- Preserve the proven business transaction as a private implementation, then
-- wrap it with mandatory runtime correlation and result presentation.
alter function public.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text, jsonb
) set schema private;
alter function private.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text, jsonb
) rename to complete_potential_lead_classifier_job_legacy;

alter function public.fail_potential_lead_classifier_job(
  bigint, uuid, text, text, text
) set schema private;
alter function private.fail_potential_lead_classifier_job(
  bigint, uuid, text, text, text
) rename to fail_potential_lead_classifier_job_legacy;

revoke all on function private.complete_potential_lead_classifier_job_legacy(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.fail_potential_lead_classifier_job_legacy(
  bigint, uuid, text, text, text
) from public, anon, authenticated, service_role;

create function public.complete_potential_lead_classifier_job(
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
  p_runtime_profile text,
  p_runtime_job_id text,
  p_runtime_execution_id text,
  p_runtime_session_id text,
  p_evidence jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_run_id uuid;
  v_title text;
  v_summary text;
  v_payload jsonb;
begin
  if p_runtime_profile is null
    or p_runtime_profile !~ '^[A-Za-z0-9_-]{1,64}$'
    or p_runtime_job_id is null
    or p_runtime_job_id !~ '^[A-Za-z0-9_.:-]{1,128}$'
    or p_runtime_execution_id is null
    or p_runtime_execution_id !~ '^[A-Za-z0-9_.:-]{1,256}$'
    or p_runtime_session_id is null
    or p_runtime_session_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  then
    raise exception 'valid Hermes runtime correlation is required';
  end if;

  v_result := private.complete_potential_lead_classifier_job_legacy(
    p_job_id, p_lease_token, p_verdict, p_confidence,
    p_contact_name, p_contact_email, p_contact_phone, p_summary, p_reason,
    p_model, p_prompt_version, p_evidence
  );

  if v_result ->> 'runId' is null then
    return v_result;
  end if;
  v_run_id := (v_result ->> 'runId')::uuid;
  v_title := case when p_verdict = 'lead'
    then 'Potential lead identified'
    else 'Not a potential lead'
  end;
  v_summary := left(coalesce(nullif(btrim(coalesce(p_summary, '')), ''), btrim(p_reason)), 2000);
  v_payload := jsonb_build_object(
    'verdict', p_verdict,
    'confidence', p_confidence,
    'leadCandidate', coalesce(v_result -> 'leadCandidate', 'null'::jsonb)
  );

  update public.agent_runs
  set runtime_provider = 'hermes',
      runtime_profile = p_runtime_profile,
      runtime_job_id = p_runtime_job_id,
      runtime_execution_id = p_runtime_execution_id,
      runtime_session_id = p_runtime_session_id,
      result_schema_version = 1,
      result_kind = 'potential-lead-verdict',
      result_title = v_title,
      result_summary = v_summary,
      result_payload = v_payload
  where id = v_run_id
    and agent_key = 'potential-lead-classifier'
    and job_id = p_job_id;

  if not found then
    raise exception 'classifier run was not stored';
  end if;
  return v_result;
end;
$$;

create function public.fail_potential_lead_classifier_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error text,
  p_model text,
  p_prompt_version text,
  p_runtime_profile text,
  p_runtime_job_id text,
  p_runtime_execution_id text,
  p_runtime_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_run_id uuid;
begin
  if p_runtime_profile is null
    or p_runtime_profile !~ '^[A-Za-z0-9_-]{1,64}$'
    or p_runtime_job_id is null
    or p_runtime_job_id !~ '^[A-Za-z0-9_.:-]{1,128}$'
    or p_runtime_execution_id is null
    or p_runtime_execution_id !~ '^[A-Za-z0-9_.:-]{1,256}$'
    or p_runtime_session_id is null
    or p_runtime_session_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  then
    raise exception 'valid Hermes runtime correlation is required';
  end if;

  v_result := private.fail_potential_lead_classifier_job_legacy(
    p_job_id, p_lease_token, p_error, p_model, p_prompt_version
  );

  select id into v_run_id
  from public.agent_runs
  where agent_key = 'potential-lead-classifier'
    and job_id = p_job_id
    and status = 'failed'
    and runtime_session_id is null
  order by created_at desc, id desc
  limit 1
  for update;

  if v_run_id is null then
    raise exception 'classifier failure run was not stored';
  end if;

  update public.agent_runs
  set runtime_provider = 'hermes',
      runtime_profile = p_runtime_profile,
      runtime_job_id = p_runtime_job_id,
      runtime_execution_id = p_runtime_execution_id,
      runtime_session_id = p_runtime_session_id,
      result_schema_version = 1,
      result_kind = 'potential-lead-failure',
      result_title = 'Potential Lead Classifier failed',
      result_summary = left(btrim(p_error), 2000),
      result_payload = jsonb_build_object(
        'terminal', v_result ->> 'status' = 'failed',
        'attempt', v_result -> 'attempt'
      )
  where id = v_run_id;

  return v_result || jsonb_build_object('runId', v_run_id);
end;
$$;

revoke all on function public.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text,
  text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_potential_lead_classifier_job(
  bigint, uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text,
  text, text, text, text, jsonb
) to service_role;
grant execute on function public.fail_potential_lead_classifier_job(
  bigint, uuid, text, text, text, text, text, text, text
) to service_role;

comment on function public.complete_potential_lead_classifier_job(
  bigint, uuid, text, numeric, text, text, text, text, text, text, text,
  text, text, text, text, jsonb
) is 'Atomically stores the Potential Lead result, Signal run, exact Hermes runtime correlation, and terminal queue state.';
