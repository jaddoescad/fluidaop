begin;

do $$
declare
  v_contact_id constant uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
  v_job_id constant uuid := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
  v_case_id uuid;
  old_queue_id bigint;
  current_queue_id bigint;
  reopened_queue_id bigint;
  reopened_queue_state jsonb;
  health jsonb;
begin
  insert into public.contacts (
    id, kind, name, metadata
  ) values (
    v_contact_id, 'customer', 'Queue Contract Lead', '{}'::jsonb
  );

  insert into public.jobs (
    id, contact_id, name, status, source, metadata
  ) values (
    v_job_id,
    v_contact_id,
    'Queue Contract Job',
    'scheduled',
    'sql-contract-test',
    '{}'::jsonb
  );

  select case_row.id into strict v_case_id
  from public.operational_cases case_row
  where case_row.job_id = v_job_id;

  select queue.id into strict old_queue_id
  from public.case_reconciliation_jobs queue
  where queue.case_id = v_case_id
    and queue.input_revision = 1;

  update public.operational_cases
  set revision = 2,
      updated_at = now()
  where id = v_case_id;

  current_queue_id := private.enqueue_case_reconciliation(
    v_case_id, 'manual', 100, 0
  );

  if not exists (
    select 1
    from public.case_reconciliation_jobs
    where id = old_queue_id
      and status = 'superseded'
      and finished_at is not null
      and lease_owner is null
      and lease_token is null
      and leased_until is null
  ) then
    raise exception 'stale case revision was not promptly superseded';
  end if;

  if (
    select count(*)
    from public.case_reconciliation_jobs
    where case_id = v_case_id
      and status in ('pending', 'leased')
  ) <> 1 then
    raise exception 'queue permits more than one open revision per case';
  end if;

  if private.enqueue_case_reconciliation(v_case_id, 'manual', 80, 0) <> current_queue_id then
    raise exception 'same-revision enqueue is not idempotent';
  end if;

  update public.case_reconciliation_jobs
  set status = 'failed',
      attempts = 3,
      finished_at = now(),
      lease_owner = null,
      lease_token = null,
      leased_until = null
  where id = current_queue_id;

  -- Invoke the mutating function in its own statement. A sibling subquery in
  -- the same SQL expression can run under the caller statement's earlier
  -- command snapshot and observe the pre-reopen row.
  reopened_queue_id := private.enqueue_case_reconciliation(
    v_case_id, 'manual', 100, 0
  );

  select to_jsonb(queue)
  into strict reopened_queue_state
  from public.case_reconciliation_jobs queue
  where queue.id = current_queue_id;

  if reopened_queue_id is distinct from current_queue_id
     or reopened_queue_state->>'status' <> 'pending'
     or (reopened_queue_state->>'attempts')::integer <> 0
     or reopened_queue_state->>'claimed_at' is not null
     or reopened_queue_state->>'finished_at' is not null
     or reopened_queue_state->>'last_error' is not null
     or reopened_queue_state->>'lease_owner' is not null
     or reopened_queue_state->>'lease_token' is not null
     or reopened_queue_state->>'leased_until' is not null then
    raise exception
      'explicit enqueue did not safely reopen terminal revision; returned %, expected %, state %',
      reopened_queue_id, current_queue_id, reopened_queue_state;
  end if;

  update public.case_reconciliation_jobs
  set finished_at = '2000-01-01 00:00:00+00'
  where id = old_queue_id;

  perform public.prune_case_reconciliation_jobs(7, 10000);

  if exists (
    select 1
    from public.case_reconciliation_jobs
    where id = old_queue_id
  ) then
    raise exception 'bounded retention did not prune an unreferenced superseded row';
  end if;

  health := public.read_case_reconciliation_queue_health();
  if not health ?& array[
    'healthy',
    'staleOpenRevisions',
    'expiredLeases',
    'exhaustedPending',
    'duplicateOpenCases',
    'pruneEligibleSuperseded'
  ] then
    raise exception 'queue health payload is missing lifecycle metrics: %', health;
  end if;
end;
$$;

rollback;
