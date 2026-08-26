-- Gmail labels are a one-way projection of Fluid's canonical topic. Hermes
-- still writes only to Fluid; a deterministic local worker owns Gmail writes.
create table public.gmail_label_mappings (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  account_email text not null,
  fluid_label_id bigint not null references public.labels(id) on delete restrict,
  gmail_label_id text not null,
  gmail_label_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_label_mappings_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint gmail_label_mappings_email_check
    check (account_email = lower(account_email) and char_length(account_email) between 3 and 320),
  constraint gmail_label_mappings_id_check
    check (char_length(gmail_label_id) between 1 and 500),
  constraint gmail_label_mappings_name_check
    check (char_length(gmail_label_name) between 1 and 225),
  constraint gmail_label_mappings_fluid_key
    unique (workspace_key, account_email, fluid_label_id),
  constraint gmail_label_mappings_gmail_key
    unique (account_email, gmail_label_id)
);

comment on table public.gmail_label_mappings is
  'Stable Fluid-topic to Gmail-label IDs. Names are display metadata; IDs prevent duplicate Gmail labels.';

create table public.gmail_label_sync_jobs (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  activity_id bigint not null references public.activities(id) on delete cascade,
  desired_label_id bigint not null references public.labels(id) on delete restrict,
  source_revision integer not null,
  generation integer not null default 1,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  lease_owner text,
  lease_token uuid,
  leased_until timestamptz,
  applied_gmail_label_id text,
  outcome text,
  last_error text,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_label_sync_jobs_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint gmail_label_sync_jobs_revision_check check (source_revision > 0),
  constraint gmail_label_sync_jobs_generation_check check (generation > 0),
  constraint gmail_label_sync_jobs_status_check
    check (status in ('pending', 'leased', 'succeeded', 'failed')),
  constraint gmail_label_sync_jobs_attempts_check check (attempts >= 0),
  constraint gmail_label_sync_jobs_outcome_check
    check (outcome is null or outcome in ('applied', 'already-applied', 'message-missing')),
  constraint gmail_label_sync_jobs_error_check
    check (last_error is null or char_length(last_error) <= 1000),
  constraint gmail_label_sync_jobs_activity_key unique (activity_id)
);

comment on table public.gmail_label_sync_jobs is
  'Coalescing desired-state outbox for projecting one Fluid topic onto one inbound Gmail message.';

create index gmail_label_sync_jobs_ready_idx
  on public.gmail_label_sync_jobs (available_at, id)
  where status = 'pending';
create index gmail_label_sync_jobs_lease_idx
  on public.gmail_label_sync_jobs (leased_until, id)
  where status = 'leased';

create table public.gmail_label_sync_runs (
  id uuid primary key default gen_random_uuid(),
  job_id bigint not null references public.gmail_label_sync_jobs(id) on delete cascade,
  activity_id bigint not null references public.activities(id) on delete cascade,
  generation integer not null,
  status text not null,
  outcome text,
  gmail_label_id text,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint gmail_label_sync_runs_generation_check check (generation > 0),
  constraint gmail_label_sync_runs_status_check check (status in ('completed', 'failed')),
  constraint gmail_label_sync_runs_outcome_check
    check (outcome is null or outcome in ('applied', 'already-applied', 'message-missing', 'retry', 'failed')),
  constraint gmail_label_sync_runs_error_check
    check (error is null or char_length(error) <= 1000)
);

comment on table public.gmail_label_sync_runs is
  'Immutable audit of deterministic Gmail label projection attempts.';

create index gmail_label_sync_runs_job_idx on public.gmail_label_sync_runs (job_id, finished_at desc);
create index gmail_label_sync_runs_activity_idx on public.gmail_label_sync_runs (activity_id, finished_at desc);

alter table public.gmail_label_mappings enable row level security;
alter table public.gmail_label_sync_jobs enable row level security;
alter table public.gmail_label_sync_runs enable row level security;

revoke all on table public.gmail_label_mappings, public.gmail_label_sync_jobs,
  public.gmail_label_sync_runs from public, anon, authenticated;
revoke all on sequence public.gmail_label_mappings_id_seq,
  public.gmail_label_sync_jobs_id_seq from public, anon, authenticated;

grant all on table public.gmail_label_mappings, public.gmail_label_sync_jobs,
  public.gmail_label_sync_runs to service_role;
grant usage, select on sequence public.gmail_label_mappings_id_seq,
  public.gmail_label_sync_jobs_id_seq to service_role;

create or replace function private.enqueue_gmail_label_projection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
begin
  if new.agent_key <> 'signal-triage' or new.label_kind <> 'topic' then
    return new;
  end if;

  select * into v_activity from public.activities where id = new.activity_id;
  if not found or v_activity.source <> 'gmail' or v_activity.direction <> 'inbound' then
    return new;
  end if;

  insert into public.gmail_label_sync_jobs as job (
    workspace_key, activity_id, desired_label_id, source_revision
  ) values (
    v_activity.workspace_key, v_activity.id, new.label_id, v_activity.triage_revision
  )
  on conflict (activity_id) do update
  set desired_label_id = excluded.desired_label_id,
      source_revision = excluded.source_revision,
      generation = job.generation + 1,
      status = 'pending',
      attempts = 0,
      available_at = now(),
      claimed_at = null,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      applied_gmail_label_id = null,
      outcome = null,
      last_error = null,
      finished_at = null,
      updated_at = now()
  where job.desired_label_id is distinct from excluded.desired_label_id
     or job.source_revision is distinct from excluded.source_revision;

  return new;
end;
$$;

drop trigger if exists signal_labels_enqueue_gmail_projection on public.signal_labels;
create trigger signal_labels_enqueue_gmail_projection
after insert or update of label_id, agent_run_id, assigned_by, updated_at
on public.signal_labels
for each row execute function private.enqueue_gmail_label_projection();

revoke all on function private.enqueue_gmail_label_projection()
from public, anon, authenticated;

create or replace function public.claim_gmail_label_sync_job(
  p_worker text,
  p_account_email text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.gmail_label_sync_jobs%rowtype;
  v_activity public.activities%rowtype;
  v_label public.labels%rowtype;
  v_topics jsonb;
  v_mappings jsonb;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then
    raise exception 'worker must be between 1 and 100 characters';
  end if;
  if p_account_email is null or p_account_email <> lower(p_account_email)
    or char_length(p_account_email) not between 3 and 320 then
    raise exception 'valid account email is required';
  end if;
  if p_lease_seconds not between 60 and 1800 then
    raise exception 'lease seconds must be between 60 and 1800';
  end if;

  update public.gmail_label_sync_jobs job
  set status = 'pending', available_at = v_now, claimed_at = null,
      lease_owner = null, lease_token = null, leased_until = null,
      updated_at = v_now
  from public.activities activity
  where job.activity_id = activity.id
    and activity.account_email = p_account_email
    and job.status = 'leased' and job.leased_until < v_now;

  select job.* into v_job
  from public.gmail_label_sync_jobs job
  join public.activities activity on activity.id = job.activity_id
  where activity.account_email = p_account_email
    and job.status = 'pending' and job.available_at <= v_now
  order by job.available_at, job.id
  for update of job skip locked
  limit 1;

  if not found then return jsonb_build_object('job', null); end if;

  update public.gmail_label_sync_jobs
  set status = 'leased', attempts = attempts + 1, claimed_at = v_now,
      lease_owner = btrim(p_worker), lease_token = gen_random_uuid(),
      leased_until = v_now + make_interval(secs => p_lease_seconds),
      last_error = null, updated_at = v_now
  where id = v_job.id
  returning * into v_job;

  select * into v_activity from public.activities where id = v_job.activity_id;
  select * into v_label from public.labels where id = v_job.desired_label_id;
  if not found or v_label.kind <> 'topic' then raise exception 'desired topic label is unavailable'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', label.id, 'key', label.key, 'name', label.name
    ) order by label.sort_order, label.id), '[]'::jsonb)
  into v_topics
  from public.labels label
  where label.workspace_key = v_job.workspace_key
    and label.kind = 'topic' and label.enabled;

  select coalesce(jsonb_agg(jsonb_build_object(
      'fluidLabelId', mapping.fluid_label_id,
      'gmailLabelId', mapping.gmail_label_id,
      'gmailLabelName', mapping.gmail_label_name
    ) order by mapping.id), '[]'::jsonb)
  into v_mappings
  from public.gmail_label_mappings mapping
  where mapping.workspace_key = v_job.workspace_key
    and mapping.account_email = v_activity.account_email;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'leaseToken', v_job.lease_token,
      'generation', v_job.generation, 'attempts', v_job.attempts,
      'claimedAt', v_job.claimed_at
    ),
    'message', jsonb_build_object(
      'activityId', v_activity.id, 'accountEmail', v_activity.account_email,
      'externalId', v_activity.external_id
    ),
    'desiredLabel', jsonb_build_object(
      'id', v_label.id, 'key', v_label.key, 'name', v_label.name
    ),
    'topicLabels', v_topics,
    'mappings', v_mappings
  );
end;
$$;

create or replace function public.complete_gmail_label_sync_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_generation integer,
  p_outcome text,
  p_gmail_label_id text default null,
  p_gmail_label_name text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.gmail_label_sync_jobs%rowtype;
  v_activity public.activities%rowtype;
  v_now timestamptz := now();
begin
  if p_outcome not in ('applied', 'already-applied', 'message-missing') then
    raise exception 'invalid completion outcome';
  end if;
  if p_outcome <> 'message-missing' and (
    p_gmail_label_id is null or char_length(p_gmail_label_id) not between 1 and 500
    or p_gmail_label_name is null or char_length(p_gmail_label_name) not between 1 and 225
  ) then raise exception 'Gmail label identity is required'; end if;

  select * into v_job from public.gmail_label_sync_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
    or v_job.generation <> p_generation then
    raise exception 'job lease is no longer valid';
  end if;
  select * into v_activity from public.activities where id = v_job.activity_id;

  if p_outcome <> 'message-missing' then
    delete from public.gmail_label_mappings mapping
    where mapping.account_email = v_activity.account_email
      and mapping.gmail_label_id = p_gmail_label_id
      and mapping.fluid_label_id <> v_job.desired_label_id;

    insert into public.gmail_label_mappings (
      workspace_key, account_email, fluid_label_id, gmail_label_id, gmail_label_name
    ) values (
      v_job.workspace_key, v_activity.account_email, v_job.desired_label_id,
      p_gmail_label_id, p_gmail_label_name
    )
    on conflict (workspace_key, account_email, fluid_label_id) do update
    set gmail_label_id = excluded.gmail_label_id,
        gmail_label_name = excluded.gmail_label_name,
        updated_at = v_now;
  end if;

  insert into public.gmail_label_sync_runs (
    job_id, activity_id, generation, status, outcome, gmail_label_id,
    started_at, finished_at
  ) values (
    v_job.id, v_job.activity_id, v_job.generation, 'completed', p_outcome,
    p_gmail_label_id, coalesce(v_job.claimed_at, v_now), v_now
  );

  update public.gmail_label_sync_jobs
  set status = 'succeeded', applied_gmail_label_id = p_gmail_label_id,
      outcome = p_outcome, last_error = null, finished_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object('jobId', v_job.id, 'status', 'succeeded', 'outcome', p_outcome);
end;
$$;

create or replace function public.fail_gmail_label_sync_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_generation integer,
  p_error text,
  p_retryable boolean default false,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.gmail_label_sync_jobs%rowtype;
  v_now timestamptz := now();
  v_retry boolean;
  v_delay integer;
begin
  if p_error is null or char_length(btrim(p_error)) not between 1 and 1000 then
    raise exception 'safe error is required';
  end if;
  if p_retry_after_seconds is not null and p_retry_after_seconds not between 1 and 86400 then
    raise exception 'invalid retry delay';
  end if;

  select * into v_job from public.gmail_label_sync_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
    or v_job.generation <> p_generation then
    raise exception 'job lease is no longer valid';
  end if;

  v_retry := p_retryable and v_job.attempts < 8;
  v_delay := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(3600, 15 * power(2, least(v_job.attempts, 8))::integer)
  );

  insert into public.gmail_label_sync_runs (
    job_id, activity_id, generation, status, outcome, error,
    started_at, finished_at
  ) values (
    v_job.id, v_job.activity_id, v_job.generation, 'failed',
    case when v_retry then 'retry' else 'failed' end,
    left(btrim(p_error), 1000), coalesce(v_job.claimed_at, v_now), v_now
  );

  update public.gmail_label_sync_jobs
  set status = case when v_retry then 'pending' else 'failed' end,
      available_at = case when v_retry then v_now + make_interval(secs => v_delay) else available_at end,
      last_error = left(btrim(p_error), 1000),
      finished_at = case when v_retry then null else v_now end,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id,
    'status', case when v_retry then 'pending' else 'failed' end,
    'retryAfterSeconds', case when v_retry then v_delay else null end
  );
end;
$$;

create or replace function public.gmail_label_sync_status(p_account_email text)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'pending', count(*) filter (where job.status = 'pending'),
    'leased', count(*) filter (where job.status = 'leased'),
    'succeeded', count(*) filter (where job.status = 'succeeded'),
    'failed', count(*) filter (where job.status = 'failed'),
    'lastSyncedAt', max(job.finished_at) filter (where job.status = 'succeeded'),
    'lastError', (
      select failed_job.last_error
      from public.gmail_label_sync_jobs failed_job
      join public.activities failed_activity on failed_activity.id = failed_job.activity_id
      where failed_activity.account_email = p_account_email
        and failed_job.status = 'failed'
      order by failed_job.finished_at desc nulls last, failed_job.id desc
      limit 1
    )
  )
  from public.gmail_label_sync_jobs job
  join public.activities activity on activity.id = job.activity_id
  where activity.account_email = p_account_email;
$$;

revoke all on function public.claim_gmail_label_sync_job(text, text, integer)
from public, anon, authenticated;
revoke all on function public.complete_gmail_label_sync_job(bigint, uuid, integer, text, text, text)
from public, anon, authenticated;
revoke all on function public.fail_gmail_label_sync_job(bigint, uuid, integer, text, boolean, integer)
from public, anon, authenticated;
revoke all on function public.gmail_label_sync_status(text)
from public, anon, authenticated;

grant execute on function public.claim_gmail_label_sync_job(text, text, integer)
to service_role;
grant execute on function public.complete_gmail_label_sync_job(bigint, uuid, integer, text, text, text)
to service_role;
grant execute on function public.fail_gmail_label_sync_job(bigint, uuid, integer, text, boolean, integer)
to service_role;
grant execute on function public.gmail_label_sync_status(text)
to service_role;
