-- Supersede obsolete case revisions when they are enqueued, not only when a
-- worker happens to claim another job. Preserve terminal audit rows and prune
-- only old superseded rows that never produced a reconciler run.

alter table public.case_reconciliation_jobs
  drop constraint case_reconciliation_jobs_status_check;

alter table public.case_reconciliation_jobs
  add constraint case_reconciliation_jobs_status_check
  check (status in ('pending', 'leased', 'succeeded', 'failed', 'superseded'));

-- Reclassify rows that the old claim path called "succeeded" even though they
-- never ran. This retains their timestamps and explanation without inflating
-- successful-work metrics.
update public.case_reconciliation_jobs
set status = 'superseded',
    finished_at = coalesce(finished_at, now()),
    lease_owner = null,
    lease_token = null,
    leased_until = null,
    updated_at = now()
where status = 'succeeded'
  and last_error = 'Superseded by a newer case revision.';

update public.case_reconciliation_jobs queue
set status = 'superseded',
    finished_at = now(),
    last_error = 'Superseded by a newer case revision.',
    lease_owner = null,
    lease_token = null,
    leased_until = null,
    updated_at = now()
from public.operational_cases case_row
where queue.case_id = case_row.id
  and queue.status in ('pending', 'leased')
  and queue.input_revision < case_row.revision;

update public.case_reconciliation_jobs
set status = 'pending',
    available_at = now(),
    finished_at = null,
    lease_owner = null,
    lease_token = null,
    leased_until = null,
    last_error = 'Lease expired; retry scheduled.',
    updated_at = now()
where status = 'leased'
  and leased_until < now()
  and attempts < 3;

update public.case_reconciliation_jobs
set status = 'failed',
    finished_at = coalesce(finished_at, now()),
    last_error = coalesce(last_error, 'Maximum attempts reached.'),
    lease_owner = null,
    lease_token = null,
    leased_until = null,
    updated_at = now()
where (status = 'pending' and attempts >= 3)
   or (status = 'leased' and leased_until < now() and attempts >= 3);

update public.case_reconciliation_jobs
set finished_at = null,
    lease_owner = null,
    lease_token = null,
    leased_until = null
where status = 'pending'
  and (
    finished_at is not null
    or lease_owner is not null
    or lease_token is not null
    or leased_until is not null
  );

update public.case_reconciliation_jobs
set finished_at = null
where status = 'leased' and finished_at is not null;

update public.case_reconciliation_jobs
set finished_at = coalesce(finished_at, now()),
    lease_owner = null,
    lease_token = null,
    leased_until = null
where status in ('succeeded', 'failed', 'superseded')
  and (
    finished_at is null
    or lease_owner is not null
    or lease_token is not null
    or leased_until is not null
  );

alter table public.case_reconciliation_jobs
  add constraint case_reconciliation_jobs_lifecycle_check
  check (
    (
      status = 'pending'
      and finished_at is null
      and lease_owner is null
      and lease_token is null
      and leased_until is null
    )
    or (
      status = 'leased'
      and finished_at is null
      and lease_owner is not null
      and lease_token is not null
      and leased_until is not null
    )
    or (
      status in ('succeeded', 'failed', 'superseded')
      and finished_at is not null
      and lease_owner is null
      and lease_token is null
      and leased_until is null
    )
  );

create unique index case_reconciliation_jobs_one_open_case_idx
  on public.case_reconciliation_jobs (case_id)
  where status in ('pending', 'leased');

create index case_reconciliation_jobs_superseded_retention_idx
  on public.case_reconciliation_jobs (finished_at, id)
  where status = 'superseded';

create or replace function private.enqueue_case_reconciliation(
  p_case_id uuid,
  p_queue_source text default 'live',
  p_priority smallint default 75,
  p_debounce_seconds integer default 60
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.operational_cases%rowtype;
  v_id bigint;
begin
  select * into v_case
  from public.operational_cases
  where id = p_case_id
  for update;

  if not found then
    raise exception 'case does not exist';
  end if;

  update public.case_reconciliation_jobs
  set status = 'superseded',
      finished_at = now(),
      last_error = 'Superseded by a newer case revision.',
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = now()
  where case_id = v_case.id
    and input_revision < v_case.revision
    and status in ('pending', 'leased');

  insert into public.case_reconciliation_jobs (
    workspace_key,
    case_id,
    input_revision,
    priority,
    queue_source,
    available_at
  ) values (
    v_case.workspace_key,
    v_case.id,
    v_case.revision,
    p_priority,
    p_queue_source,
    now() + make_interval(secs => greatest(0, least(p_debounce_seconds, 300)))
  )
  on conflict (case_id, input_revision) do update
  set priority = greatest(public.case_reconciliation_jobs.priority, excluded.priority),
      queue_source = excluded.queue_source,
      status = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then 'pending'
        else public.case_reconciliation_jobs.status
      end,
      attempts = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then 0
        else public.case_reconciliation_jobs.attempts
      end,
      available_at = case
        when public.case_reconciliation_jobs.status = 'pending'
          then greatest(public.case_reconciliation_jobs.available_at, excluded.available_at)
        when public.case_reconciliation_jobs.status = 'leased'
          then public.case_reconciliation_jobs.available_at
        else excluded.available_at
      end,
      claimed_at = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then null
        else public.case_reconciliation_jobs.claimed_at
      end,
      finished_at = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then null
        else public.case_reconciliation_jobs.finished_at
      end,
      last_error = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then null
        else public.case_reconciliation_jobs.last_error
      end,
      lease_owner = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then null
        else public.case_reconciliation_jobs.lease_owner
      end,
      lease_token = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then null
        else public.case_reconciliation_jobs.lease_token
      end,
      leased_until = case
        when public.case_reconciliation_jobs.status in ('succeeded', 'failed', 'superseded')
          then null
        else public.case_reconciliation_jobs.leased_until
      end,
      updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.claim_case_reconciliation_job(
  p_worker text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.case_reconciliation_jobs%rowtype;
  v_case public.operational_cases%rowtype;
  v_job_row public.jobs%rowtype;
  v_contact jsonb;
  v_work_items jsonb;
  v_evidence jsonb;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then
    raise exception 'invalid worker';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception 'invalid lease duration';
  end if;

  update public.case_reconciliation_jobs queue
  set status = 'superseded',
      finished_at = v_now,
      last_error = 'Superseded by a newer case revision.',
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = v_now
  from public.operational_cases case_row
  where queue.case_id = case_row.id
    and queue.status in ('pending', 'leased')
    and queue.input_revision < case_row.revision;

  update public.case_reconciliation_jobs
  set status = 'pending',
      available_at = v_now,
      finished_at = null,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      last_error = 'Lease expired; retry scheduled.',
      updated_at = v_now
  where status = 'leased'
    and leased_until < v_now
    and attempts < 3;

  update public.case_reconciliation_jobs
  set status = 'failed',
      finished_at = v_now,
      last_error = 'Lease expired after maximum attempts.',
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = v_now
  where status = 'leased'
    and leased_until < v_now
    and attempts >= 3;

  select * into v_job
  from public.case_reconciliation_jobs
  where status = 'pending'
    and available_at <= v_now
    and attempts < 3
  order by priority desc, available_at, id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('job', null);
  end if;

  update public.case_reconciliation_jobs
  set status = 'leased',
      attempts = attempts + 1,
      claimed_at = v_now,
      lease_owner = btrim(p_worker),
      lease_token = gen_random_uuid(),
      leased_until = v_now + make_interval(secs => p_lease_seconds),
      last_error = null,
      updated_at = v_now
  where id = v_job.id
  returning * into v_job;

  select * into v_case
  from public.operational_cases
  where id = v_job.case_id;

  select * into v_job_row
  from public.jobs
  where id = v_case.job_id;

  select case when contact.id is null then null else jsonb_build_object(
    'id', contact.id,
    'name', contact.name,
    'email', contact.email,
    'phone', contact.phone
  ) end
  into v_contact
  from (select 1) seed
  left join public.contacts contact on contact.id = v_case.contact_id;

  select coalesce(jsonb_agg(to_jsonb(item) order by item.updated_at desc), '[]'::jsonb)
  into v_work_items
  from (
    select id, action_kind, target_key, title, reason, status, owner, due_at,
      confidence, source_kind, input_revision, prerequisites, is_shadow, updated_at
    from public.work_items
    where case_id = v_case.id
    order by updated_at desc
    limit 30
  ) item;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', evidence.id,
    'type', evidence.evidence_type,
    'relevance', evidence.relevance,
    'occurredAt', evidence.observed_at,
    'source', case when evidence.evidence_type = 'slack_message' then 'slack' else activity.source end,
    'text', case when evidence.evidence_type = 'slack_message'
      then left(slack.text_content, 12000)
      else left(coalesce(activity.body_text, activity.preview, ''), 12000) end,
    'subject', activity.subject,
    'sourceLink', slack.permalink
  ) order by evidence.observed_at desc, evidence.id desc), '[]'::jsonb)
  into v_evidence
  from (
    select *
    from public.case_evidence
    where case_id = v_case.id
    order by observed_at desc, id desc
    limit 40
  ) evidence
  left join public.slack_messages slack on slack.id = evidence.slack_message_id
  left join public.activities activity on activity.id = evidence.activity_id;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'caseId', v_case.id,
      'inputRevision', v_job.input_revision,
      'leaseToken', v_job.lease_token,
      'attempt', v_job.attempts,
      'leasedUntil', v_job.leased_until
    ),
    'case', jsonb_build_object(
      'id', v_case.id,
      'revision', v_case.revision,
      'status', v_case.status,
      'canonicalState', v_case.canonical_state
    ),
    'businessJob', jsonb_build_object(
      'id', v_job_row.id,
      'name', v_job_row.name,
      'status', v_job_row.status,
      'scheduledOn', v_job_row.scheduled_on,
      'startedOn', v_job_row.started_on,
      'completedOn', v_job_row.completed_on
    ),
    'contact', v_contact,
    'workItems', v_work_items,
    'evidence', v_evidence
  );
end;
$$;

-- Route the reconciliation sweep through the same enqueue invariant instead
-- of bypassing it with a bulk insert that can collide with a stale open row.
create or replace function public.reconcile_operational_cases(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 500
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job_id uuid;
  v_case_id uuid;
  v_seen integer := 0;
  v_enqueued integer := 0;
begin
  if p_limit not between 1 and 5000 then
    raise exception 'invalid limit';
  end if;

  for v_job_id in
    select job.id
    from public.jobs job
    order by job.updated_at desc, job.id
    limit p_limit
  loop
    perform private.refresh_operational_case(v_job_id, false);
    v_seen := v_seen + 1;
  end loop;

  for v_case_id in
    select case_row.id
    from public.operational_cases case_row
    where case_row.workspace_key = p_workspace_key
      and not exists (
        select 1
        from public.case_reconciliation_jobs queue
        where queue.case_id = case_row.id
          and queue.input_revision = case_row.revision
      )
    order by case_row.updated_at, case_row.id
  loop
    perform private.enqueue_case_reconciliation(v_case_id, 'reconcile', 20, 0);
    v_enqueued := v_enqueued + 1;
  end loop;

  return jsonb_build_object(
    'jobsRefreshed', v_seen,
    'casesEnqueued', v_enqueued
  );
end;
$$;

create or replace function public.read_case_reconciliation_queue_health()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with metrics as (
    select
      count(*) filter (where queue.status = 'pending')::integer as pending,
      count(*) filter (where queue.status = 'leased')::integer as leased,
      count(*) filter (
        where queue.status in ('pending', 'leased')
          and queue.input_revision < case_row.revision
      )::integer as stale_open_revisions,
      count(*) filter (
        where queue.status = 'leased'
          and queue.leased_until < now()
      )::integer as expired_leases,
      count(*) filter (
        where queue.status = 'pending'
          and queue.attempts >= 3
      )::integer as exhausted_pending,
      count(*) filter (
        where queue.status = 'superseded'
          and queue.finished_at < now() - interval '30 days'
          and not exists (
            select 1
            from public.case_reconciler_runs run
            where run.job_id = queue.id
          )
      )::integer as prune_eligible_superseded
    from public.case_reconciliation_jobs queue
    join public.operational_cases case_row on case_row.id = queue.case_id
  ), duplicate_open as (
    select count(*)::integer as duplicate_open_cases
    from (
      select queue.case_id
      from public.case_reconciliation_jobs queue
      where queue.status in ('pending', 'leased')
      group by queue.case_id
      having count(*) > 1
    ) duplicate
  )
  select jsonb_build_object(
    'healthy',
      metrics.stale_open_revisions = 0
      and metrics.expired_leases = 0
      and metrics.exhausted_pending = 0
      and duplicate_open.duplicate_open_cases = 0,
    'pending', metrics.pending,
    'leased', metrics.leased,
    'staleOpenRevisions', metrics.stale_open_revisions,
    'expiredLeases', metrics.expired_leases,
    'exhaustedPending', metrics.exhausted_pending,
    'duplicateOpenCases', duplicate_open.duplicate_open_cases,
    'pruneEligibleSuperseded', metrics.prune_eligible_superseded,
    'checkedAt', now()
  )
  from metrics
  cross join duplicate_open
$$;

create or replace function public.prune_case_reconciliation_jobs(
  p_retention_days integer default 30,
  p_max_rows integer default 1000
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
begin
  if p_retention_days not between 7 and 3650 then
    raise exception 'retention days must be between 7 and 3650';
  end if;
  if p_max_rows not between 1 and 10000 then
    raise exception 'max rows must be between 1 and 10000';
  end if;

  with candidates as (
    select queue.id
    from public.case_reconciliation_jobs queue
    where queue.status = 'superseded'
      and queue.finished_at < now() - make_interval(days => p_retention_days)
      and not exists (
        select 1
        from public.case_reconciler_runs run
        where run.job_id = queue.id
      )
    order by queue.finished_at, queue.id
    for update skip locked
    limit p_max_rows
  )
  delete from public.case_reconciliation_jobs queue
  using candidates
  where queue.id = candidates.id;

  get diagnostics v_deleted = row_count;
  return jsonb_build_object(
    'deleted', v_deleted,
    'retentionDays', p_retention_days,
    'maxRows', p_max_rows
  );
end;
$$;

comment on function private.enqueue_case_reconciliation(uuid, text, smallint, integer) is
  'Enqueues only the current case revision and promptly supersedes any stale open revision.';
comment on function public.claim_case_reconciliation_job(text, integer) is
  'Claims one current case reconciliation job with SKIP LOCKED and repairs expired leases.';
comment on function public.reconcile_operational_cases(text, integer) is
  'Refreshes operational cases and routes missing current revisions through the canonical enqueue invariant.';
comment on function public.read_case_reconciliation_queue_health() is
  'Reports case queue lifecycle and revision invariants without mutating queue state.';
comment on function public.prune_case_reconciliation_jobs(integer, integer) is
  'Deletes a bounded batch of old superseded queue rows only when no reconciler run references them.';

revoke all on function private.enqueue_case_reconciliation(uuid, text, smallint, integer)
  from public, anon, authenticated;
revoke all on function public.claim_case_reconciliation_job(text, integer)
  from public, anon, authenticated;
revoke all on function public.reconcile_operational_cases(text, integer)
  from public, anon, authenticated;
revoke all on function public.read_case_reconciliation_queue_health()
  from public, anon, authenticated;
revoke all on function public.prune_case_reconciliation_jobs(integer, integer)
  from public, anon, authenticated;

grant execute on function public.claim_case_reconciliation_job(text, integer)
  to service_role;
grant execute on function public.reconcile_operational_cases(text, integer)
  to service_role;
grant execute on function public.read_case_reconciliation_queue_health()
  to service_role;
grant execute on function public.prune_case_reconciliation_jobs(integer, integer)
  to service_role;
