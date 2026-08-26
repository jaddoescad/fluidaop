create or replace function private.safe_bigint(p_value text)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if p_value is null or p_value !~ '^-?[0-9]+$' then return null; end if;
  return p_value::bigint;
exception when numeric_value_out_of_range then
  return null;
end;
$$;

create or replace function private.work_item_fingerprint(
  p_case_id uuid,
  p_action_kind text,
  p_target_key text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to(p_case_id::text || '|' || p_action_kind || '|' || p_target_key, 'UTF8')), 'hex')
$$;

create or replace function private.record_case_fact(
  p_workspace_key text,
  p_case_id uuid,
  p_fact_key text,
  p_fact_value jsonb,
  p_authority_rank smallint,
  p_source_type text,
  p_source_ref text,
  p_effective_at timestamptz,
  p_observed_at timestamptz default now(),
  p_confidence numeric default 1,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_current_id bigint;
begin
  insert into public.case_facts (
    workspace_key, case_id, fact_key, fact_value, authority_rank,
    source_type, source_ref, confidence, effective_at, observed_at, metadata
  ) values (
    p_workspace_key, p_case_id, p_fact_key, coalesce(p_fact_value, 'null'::jsonb),
    p_authority_rank, p_source_type, p_source_ref, p_confidence,
    p_effective_at, p_observed_at, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (case_id, fact_key, source_type, source_ref, observed_at)
  do update set fact_value = excluded.fact_value
  returning id into v_id;

  select id into v_current_id
  from public.case_facts
  where case_id = p_case_id and fact_key = p_fact_key
  order by authority_rank, effective_at desc, observed_at desc, id desc
  limit 1;

  update public.case_facts
  set is_current = (id = v_current_id),
      superseded_at = case when id = v_current_id then null else coalesce(superseded_at, now()) end
  where case_id = p_case_id and fact_key = p_fact_key
    and (is_current is distinct from (id = v_current_id) or (id = v_current_id and superseded_at is not null));

  return v_id;
end;
$$;

create or replace function private.ensure_work_item(
  p_workspace_key text,
  p_case_id uuid,
  p_action_kind text,
  p_target_key text,
  p_title text,
  p_reason text,
  p_source_kind text,
  p_input_revision integer,
  p_confidence numeric default 1,
  p_prerequisites jsonb default '{}'::jsonb,
  p_is_shadow boolean default false,
  p_status text default 'open',
  p_owner text default null,
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text := private.work_item_fingerprint(p_case_id, p_action_kind, p_target_key);
  v_item public.work_items%rowtype;
begin
  select * into v_item
  from public.work_items
  where workspace_key = p_workspace_key and fingerprint = v_fingerprint
    and status in ('open', 'waiting', 'completed', 'dismissed')
  order by created_at desc
  for update
  limit 1;

  if found then
    if v_item.status in ('completed', 'dismissed') then return v_item.id; end if;
    update public.work_items
    set title = left(btrim(p_title), 200),
        reason = left(btrim(p_reason), 2000),
        status = p_status,
        owner = nullif(left(btrim(coalesce(p_owner, '')), 160), ''),
        due_at = p_due_at,
        confidence = p_confidence,
        input_revision = greatest(input_revision, p_input_revision),
        prerequisites = coalesce(p_prerequisites, '{}'::jsonb),
        is_shadow = p_is_shadow,
        published_at = case when p_is_shadow then null else coalesce(published_at, now()) end,
        updated_at = now()
    where id = v_item.id;
    return v_item.id;
  end if;

  begin
    insert into public.work_items (
      workspace_key, case_id, action_kind, target_key, fingerprint,
      title, reason, status, owner, due_at, confidence, source_kind,
      input_revision, prerequisites, is_shadow, published_at
    ) values (
      p_workspace_key, p_case_id, p_action_kind, p_target_key, v_fingerprint,
      left(btrim(p_title), 200), left(btrim(p_reason), 2000), p_status,
      nullif(left(btrim(coalesce(p_owner, '')), 160), ''), p_due_at,
      p_confidence, p_source_kind, p_input_revision,
      coalesce(p_prerequisites, '{}'::jsonb), p_is_shadow,
      case when p_is_shadow then null else now() end
    ) returning * into v_item;
  exception when unique_violation then
    select * into v_item
    from public.work_items
    where workspace_key = p_workspace_key and fingerprint = v_fingerprint
      and status in ('open', 'waiting')
    order by created_at desc
    limit 1;
  end;

  insert into public.work_item_events (
    workspace_key, work_item_id, event_type, actor_type, to_status, metadata
  ) values (
    p_workspace_key, v_item.id, 'created',
    case when p_source_kind = 'hermes' then 'hermes' else 'system' end,
    v_item.status, jsonb_build_object('inputRevision', p_input_revision, 'shadow', p_is_shadow)
  );
  return v_item.id;
end;
$$;

create or replace function private.supersede_work_item(
  p_item_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.work_items%rowtype;
begin
  select * into v_item from public.work_items where id = p_item_id for update;
  if not found or v_item.status not in ('open', 'waiting') then return; end if;
  update public.work_items
  set status = 'superseded', superseded_at = now(), reason = left(p_reason, 2000), updated_at = now()
  where id = v_item.id;
  insert into public.work_item_events (
    workspace_key, work_item_id, event_type, actor_type, from_status, to_status, note
  ) values (v_item.workspace_key, v_item.id, 'superseded', 'system', v_item.status, 'superseded', left(p_reason, 2000));
end;
$$;

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
  select * into v_case from public.operational_cases where id = p_case_id;
  if not found then raise exception 'case does not exist'; end if;
  insert into public.case_reconciliation_jobs (
    workspace_key, case_id, input_revision, priority, queue_source, available_at
  ) values (
    v_case.workspace_key, v_case.id, v_case.revision, p_priority, p_queue_source,
    now() + make_interval(secs => greatest(0, least(p_debounce_seconds, 300)))
  )
  on conflict (case_id, input_revision) do update
  set priority = greatest(public.case_reconciliation_jobs.priority, excluded.priority),
      available_at = case
        when public.case_reconciliation_jobs.status = 'pending'
          then greatest(public.case_reconciliation_jobs.available_at, excluded.available_at)
        else public.case_reconciliation_jobs.available_at
      end,
      updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.refresh_operational_case(
  p_job_id uuid,
  p_enqueue boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_case public.operational_cases%rowtype;
  v_ops jsonb;
  v_stage text;
  v_invoice_status text;
  v_proposal_id text;
  v_project_manager text;
  v_crew text;
  v_balance bigint;
  v_paid bigint;
  v_production text;
  v_financial text;
  v_terminal boolean;
  v_state jsonb;
  v_source_ref text;
  v_valid boolean;
  v_item record;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then raise exception 'job does not exist'; end if;

  v_ops := coalesce(v_job.metadata #> '{dripjobs_operational_authority}', '{}'::jsonb);
  v_stage := lower(btrim(coalesce(v_ops ->> 'deal_stage', '')));
  v_invoice_status := lower(btrim(coalesce(v_ops ->> 'invoice_status', '')));
  v_proposal_id := nullif(btrim(v_ops ->> 'proposal_id'), '');
  v_project_manager := nullif(btrim(v_ops ->> 'project_manager'), '');
  v_crew := nullif(btrim(v_ops ->> 'crew'), '');
  v_balance := private.safe_bigint(v_ops ->> 'balance_cents');
  v_paid := private.safe_bigint(v_ops ->> 'paid_cents');

  v_production := case
    when v_job.status = 'cancelled' or v_stage like '%cancel%' or v_stage like '%rejected%' then 'cancelled'
    when v_job.completed_on is not null or v_job.status = 'completed' or v_stage like '%project complete%' then 'completed'
    when v_job.status = 'archived' then 'archived'
    when v_job.started_on is not null and v_job.started_on <= current_date then 'in_progress'
    when v_job.scheduled_on is not null then 'scheduled'
    when v_stage like '%accepted%' or v_job.status in ('active', 'scheduled') then 'accepted'
    else 'unknown'
  end;
  v_terminal := v_production in ('completed', 'cancelled', 'archived');

  v_financial := case
    when v_invoice_status = 'paid' or (v_balance = 0 and v_invoice_status <> '') then 'paid'
    when v_invoice_status like '%partial%' or coalesce(v_paid, 0) > 0 then 'partially_paid'
    when coalesce(v_balance, 0) > 0 then 'unpaid'
    else 'unknown'
  end;

  v_state := jsonb_build_object(
    'jobId', v_job.id,
    'jobName', v_job.name,
    'production', jsonb_build_object(
      'status', v_production,
      'terminal', v_terminal,
      'completedOn', v_job.completed_on,
      'rawJobStatus', v_job.status,
      'rawDealStage', nullif(v_ops ->> 'deal_stage', '')
    ),
    'schedule', jsonb_build_object(
      'startOn', v_job.scheduled_on,
      'endOn', v_job.scheduled_end_on,
      'startedOn', v_job.started_on
    ),
    'assignment', jsonb_build_object(
      'projectManager', v_project_manager,
      'crew', v_crew,
      'projectManagerMissing', v_project_manager is null or lower(v_project_manager) = 'no project manager',
      'crewMissing', v_crew is null or lower(v_crew) = 'no crew'
    ),
    'financial', jsonb_build_object(
      'status', v_financial,
      'invoiceStatus', nullif(v_ops ->> 'invoice_status', ''),
      'balanceCents', v_balance,
      'paidCents', v_paid,
      'contractAmountCents', v_job.contract_amount_cents
    ),
    'external', jsonb_build_object('dripjobsProposalId', v_proposal_id),
    'asOf', v_job.updated_at
  );

  insert into public.operational_cases (
    workspace_key, job_id, contact_id, status, canonical_state, reconciled_at
  ) values (
    'ottawa-painters', v_job.id, v_job.contact_id,
    case when v_terminal then 'terminal' else 'open' end,
    v_state, now()
  )
  on conflict (workspace_key, job_id) do update
  set contact_id = excluded.contact_id,
      status = excluded.status,
      revision = case
        when public.operational_cases.canonical_state is distinct from excluded.canonical_state
          then public.operational_cases.revision + 1
        else public.operational_cases.revision
      end,
      canonical_state = excluded.canonical_state,
      reconciled_at = now(),
      updated_at = now()
  returning * into v_case;

  v_source_ref := 'job:' || v_job.id::text || ':' || extract(epoch from v_job.updated_at)::text;

  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'production.status', to_jsonb(v_production), 2, 'dripjobs', v_source_ref, v_job.updated_at, v_job.updated_at);
  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'schedule.start_on', coalesce(to_jsonb(v_job.scheduled_on), 'null'::jsonb), 2, 'dripjobs', v_source_ref, v_job.updated_at, v_job.updated_at);
  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'schedule.end_on', coalesce(to_jsonb(v_job.scheduled_end_on), 'null'::jsonb), 2, 'dripjobs', v_source_ref, v_job.updated_at, v_job.updated_at);
  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'assignment.project_manager', coalesce(to_jsonb(v_project_manager), 'null'::jsonb), 2, 'dripjobs', v_source_ref, v_job.updated_at, v_job.updated_at);
  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'assignment.crew', coalesce(to_jsonb(v_crew), 'null'::jsonb), 2, 'dripjobs', v_source_ref, v_job.updated_at, v_job.updated_at);
  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'financial.status', to_jsonb(v_financial), 2, 'structured', v_source_ref, v_job.updated_at, v_job.updated_at);
  perform private.record_case_fact(v_case.workspace_key, v_case.id, 'financial.balance_cents', coalesce(to_jsonb(v_balance), 'null'::jsonb), 2, 'structured', v_source_ref, v_job.updated_at, v_job.updated_at);

  if v_proposal_id ~ '^[0-9]{4,32}$' then
    insert into public.external_references (
      workspace_key, provider, reference_type, reference_value, entity_type, job_id, observed_at, metadata
    ) values (
      v_case.workspace_key, 'dripjobs', 'proposal_id', v_proposal_id, 'job', v_job.id,
      v_job.updated_at, jsonb_build_object('source', 'jobs.metadata.dripjobs_operational_authority.proposal_id')
    )
    on conflict (workspace_key, provider, reference_type, reference_value) do update
    set entity_type = 'job', job_id = excluded.job_id, lead_id = null, contact_id = null,
        observed_at = greatest(public.external_references.observed_at, excluded.observed_at),
        metadata = excluded.metadata, updated_at = now()
    where public.external_references.entity_type = 'job'
      and public.external_references.job_id = excluded.job_id;
  end if;

  for v_item in
    select id, action_kind from public.work_items
    where case_id = v_case.id and status in ('open', 'waiting') and source_kind = 'deterministic'
  loop
    v_valid := case v_item.action_kind
      when 'schedule_job' then v_production = 'accepted' and v_job.scheduled_on is null
      when 'assign_project_manager' then v_production in ('accepted', 'scheduled', 'in_progress') and (v_project_manager is null or lower(v_project_manager) = 'no project manager')
      when 'assign_crew' then v_production in ('scheduled', 'in_progress') and (v_crew is null or lower(v_crew) = 'no crew')
      when 'collect_balance' then v_production = 'completed' and coalesce(v_balance, 0) > 0 and v_financial <> 'paid'
      else false
    end;
    if not v_valid then perform private.supersede_work_item(v_item.id, 'Structured operational state no longer requires this work.'); end if;
  end loop;

  if v_production = 'accepted' and v_job.scheduled_on is null then
    perform private.ensure_work_item(v_case.workspace_key, v_case.id, 'schedule_job', 'unscheduled',
      'Schedule ' || v_job.name,
      'DripJobs shows an accepted project with no scheduled date.', 'deterministic', v_case.revision, 1,
      jsonb_build_object('productionStatus', 'accepted', 'scheduledOn', null), false);
  end if;
  if v_production in ('accepted', 'scheduled', 'in_progress') and (v_project_manager is null or lower(v_project_manager) = 'no project manager') then
    perform private.ensure_work_item(v_case.workspace_key, v_case.id, 'assign_project_manager', 'missing-project-manager',
      'Assign a project manager for ' || v_job.name,
      'The current DripJobs operational record has no project manager.', 'deterministic', v_case.revision, 1,
      jsonb_build_object('productionStatus', v_production, 'projectManagerMissing', true), false);
  end if;
  if v_production in ('scheduled', 'in_progress') and (v_crew is null or lower(v_crew) = 'no crew') then
    perform private.ensure_work_item(v_case.workspace_key, v_case.id, 'assign_crew', 'missing-crew',
      'Assign a crew for ' || v_job.name,
      'The project is scheduled or underway, but the current record has no crew.', 'deterministic', v_case.revision, 1,
      jsonb_build_object('productionStatus', v_production, 'crewMissing', true), false);
  end if;
  if v_production = 'completed' and coalesce(v_balance, 0) > 0 and v_financial <> 'paid' then
    perform private.ensure_work_item(v_case.workspace_key, v_case.id, 'collect_balance', 'remaining-balance',
      'Review the remaining balance for ' || v_job.name,
      'Production is complete, but the structured invoice record still has a balance.', 'deterministic', v_case.revision, 1,
      jsonb_build_object('productionStatus', 'completed', 'balanceCents', v_balance), false);
  end if;

  if p_enqueue then perform private.enqueue_case_reconciliation(v_case.id, 'live', 75, 60); end if;
  return v_case.id;
end;
$$;

create or replace function private.refresh_operational_case_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_operational_case(new.id, true);
  return new;
end;
$$;

create trigger jobs_refresh_operational_case
after insert or update of contact_id, status, scheduled_on, scheduled_end_on, started_on, completed_on, archived_at, metadata, updated_at
on public.jobs
for each row execute function private.refresh_operational_case_trigger();

create or replace function private.resolve_slack_channel_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match text[];
begin
  new.name := lower(btrim(new.name));
  new.job_id := null;
  new.proposal_id := null;
  new.channel_kind := 'other';
  new.selected := false;

  if new.name = 'sales' then
    new.channel_kind := 'sales';
    new.selected := true;
    return new;
  end if;
  if new.name = 'all-ottawa-painters' then return new; end if;

  v_match := regexp_match(new.name, '^job-.+-([0-9]{4,32})$');
  if v_match is null then return new; end if;
  new.channel_kind := 'job';
  new.proposal_id := v_match[1];
  select reference.job_id into new.job_id
  from public.external_references reference
  where reference.workspace_key = new.workspace_key
    and reference.provider = 'dripjobs'
    and reference.reference_type = 'proposal_id'
    and reference.reference_value = new.proposal_id
    and reference.entity_type = 'job';
  new.selected := new.job_id is not null;
  return new;
end;
$$;

create trigger slack_channels_resolve_job
before insert or update of name, workspace_key
on public.slack_channels
for each row execute function private.resolve_slack_channel_job();

create or replace function private.link_slack_message_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case_id uuid;
  v_evidence_id bigint;
begin
  if tg_op = 'UPDATE' and row(
    old.text_content, old.edited_at, old.deleted_at, old.is_filtered,
    old.permalink, old.file_metadata, old.thread_ts
  ) is not distinct from row(
    new.text_content, new.edited_at, new.deleted_at, new.is_filtered,
    new.permalink, new.file_metadata, new.thread_ts
  ) then return new; end if;
  select case_row.id into v_case_id
  from public.slack_channels channel
  join public.operational_cases case_row on case_row.job_id = channel.job_id and case_row.workspace_key = channel.workspace_key
  where channel.id = new.channel_id and channel.job_id is not null;
  if v_case_id is null then return new; end if;

  if new.is_filtered then
    delete from public.case_evidence
    where case_id = v_case_id and slack_message_id = new.id;
    if found then
      update public.operational_cases
      set revision = revision + 1,
          evidence_updated_at = greatest(coalesce(evidence_updated_at, '-infinity'::timestamptz), new.updated_at),
          updated_at = now()
      where id = v_case_id;
      perform private.enqueue_case_reconciliation(v_case_id, 'live', 90, 60);
    end if;
    return new;
  end if;

  insert into public.case_evidence (
    workspace_key, case_id, evidence_type, slack_message_id, observed_at
  ) values (new.workspace_key, v_case_id, 'slack_message', new.id, new.occurred_at)
  on conflict (case_id, slack_message_id) where slack_message_id is not null
  do update set observed_at = excluded.observed_at
  returning id into v_evidence_id;

  update public.operational_cases
  set revision = revision + 1, evidence_updated_at = greatest(coalesce(evidence_updated_at, '-infinity'::timestamptz), new.updated_at), updated_at = now()
  where id = v_case_id;
  perform private.enqueue_case_reconciliation(v_case_id, 'live', 90, 60);
  return new;
end;
$$;

create trigger slack_messages_link_case
after insert or update of text_content, edited_at, deleted_at, is_filtered, permalink, file_metadata, thread_ts
on public.slack_messages
for each row execute function private.link_slack_message_case();

create or replace function private.link_activity_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case_id uuid;
  v_count integer;
begin
  if new.contact_id is null then return new; end if;
  if tg_op = 'UPDATE' and row(
    old.contact_id, old.subject, old.body_text, old.preview, old.source_metadata,
    old.has_attachments, old.attachment_count
  ) is not distinct from row(
    new.contact_id, new.subject, new.body_text, new.preview, new.source_metadata,
    new.has_attachments, new.attachment_count
  ) then return new; end if;
  select count(*), min(case_row.id) into v_count, v_case_id
  from public.operational_cases case_row
  join public.jobs job on job.id = case_row.job_id
  where case_row.workspace_key = new.workspace_key
    and case_row.status = 'open'
    and job.contact_id = new.contact_id;
  if v_count <> 1 then return new; end if;

  insert into public.case_evidence (
    workspace_key, case_id, evidence_type, activity_id, observed_at
  ) values (new.workspace_key, v_case_id, 'activity', new.id, new.occurred_at)
  on conflict (case_id, activity_id) where activity_id is not null
  do update set observed_at = excluded.observed_at;

  update public.operational_cases
  set revision = revision + 1, evidence_updated_at = greatest(coalesce(evidence_updated_at, '-infinity'::timestamptz), new.updated_at), updated_at = now()
  where id = v_case_id;
  perform private.enqueue_case_reconciliation(v_case_id, 'live', 80, 60);
  return new;
end;
$$;

create trigger activities_link_operational_case
after insert or update of contact_id, subject, body_text, preview, source_metadata, has_attachments, attachment_count
on public.activities
for each row execute function private.link_activity_case();

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
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then raise exception 'invalid worker'; end if;
  if p_lease_seconds not between 60 and 3600 then raise exception 'invalid lease duration'; end if;

  update public.case_reconciliation_jobs queue
  set status = 'succeeded', finished_at = v_now,
      last_error = 'Superseded by a newer case revision.',
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  from public.operational_cases case_row
  where queue.case_id = case_row.id and queue.status in ('pending', 'leased')
    and queue.input_revision < case_row.revision;

  update public.case_reconciliation_jobs
  set status = 'pending', available_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where status = 'leased' and leased_until < v_now and attempts < 3;

  update public.case_reconciliation_jobs
  set status = 'failed', finished_at = v_now, last_error = 'Lease expired after maximum attempts.', updated_at = v_now
  where status = 'leased' and leased_until < v_now and attempts >= 3;

  select * into v_job
  from public.case_reconciliation_jobs
  where status = 'pending' and available_at <= v_now and attempts < 3
  order by priority desc, available_at, id
  for update skip locked
  limit 1;
  if not found then return jsonb_build_object('job', null); end if;

  update public.case_reconciliation_jobs
  set status = 'leased', attempts = attempts + 1, claimed_at = v_now,
      lease_owner = btrim(p_worker), lease_token = gen_random_uuid(),
      leased_until = v_now + make_interval(secs => p_lease_seconds), last_error = null, updated_at = v_now
  where id = v_job.id returning * into v_job;

  select * into v_case from public.operational_cases where id = v_job.case_id;
  select * into v_job_row from public.jobs where id = v_case.job_id;
  select case when contact.id is null then null else jsonb_build_object(
    'id', contact.id, 'name', contact.name, 'email', contact.email, 'phone', contact.phone
  ) end into v_contact
  from (select 1) seed left join public.contacts contact on contact.id = v_case.contact_id;

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
    select * from public.case_evidence where case_id = v_case.id
    order by observed_at desc, id desc limit 40
  ) evidence
  left join public.slack_messages slack on slack.id = evidence.slack_message_id
  left join public.activities activity on activity.id = evidence.activity_id;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'caseId', v_case.id, 'inputRevision', v_job.input_revision,
      'leaseToken', v_job.lease_token, 'attempt', v_job.attempts, 'leasedUntil', v_job.leased_until
    ),
    'case', jsonb_build_object(
      'id', v_case.id, 'revision', v_case.revision, 'status', v_case.status,
      'canonicalState', v_case.canonical_state
    ),
    'businessJob', jsonb_build_object(
      'id', v_job_row.id, 'name', v_job_row.name, 'status', v_job_row.status,
      'scheduledOn', v_job_row.scheduled_on, 'startedOn', v_job_row.started_on,
      'completedOn', v_job_row.completed_on
    ),
    'contact', v_contact,
    'workItems', v_work_items,
    'evidence', v_evidence
  );
end;
$$;

create or replace function public.complete_case_reconciliation_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_model text,
  p_prompt_version text,
  p_assertions jsonb,
  p_proposals jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.case_reconciliation_jobs%rowtype;
  v_case public.operational_cases%rowtype;
  v_settings public.case_reconciler_settings%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_assertion jsonb;
  v_proposal jsonb;
  v_evidence_id jsonb;
  v_kind text;
  v_target text;
  v_title text;
  v_reason text;
  v_confidence numeric;
  v_status text;
  v_item_id uuid;
  v_shadow boolean;
  v_created integer := 0;
  v_production text;
  v_financial text;
begin
  if jsonb_typeof(p_assertions) <> 'array' or jsonb_array_length(p_assertions) > 20 then raise exception 'invalid assertions'; end if;
  if jsonb_typeof(p_proposals) <> 'array' or jsonb_array_length(p_proposals) > 8 then raise exception 'invalid proposals'; end if;
  if char_length(coalesce(p_prompt_version, '')) not between 1 and 100 then raise exception 'invalid prompt version'; end if;

  select * into v_job from public.case_reconciliation_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'leased' or v_job.lease_token is distinct from p_lease_token or v_job.leased_until < now() then
    raise exception 'job lease is invalid';
  end if;
  select * into v_case from public.operational_cases where id = v_job.case_id for update;
  if v_case.revision <> v_job.input_revision then raise exception 'case revision changed'; end if;
  v_production := v_case.canonical_state #>> '{production,status}';
  v_financial := v_case.canonical_state #>> '{financial,status}';
  select * into v_settings from public.case_reconciler_settings where workspace_key = v_case.workspace_key for update;

  for v_assertion in select value from jsonb_array_elements(p_assertions)
  loop
    v_kind := v_assertion ->> 'kind';
    if v_kind not in ('request', 'decision', 'commitment', 'blocker', 'schedule_change', 'scope_change', 'completion_claim') then raise exception 'invalid assertion kind'; end if;
    if char_length(btrim(coalesce(v_assertion ->> 'summary', ''))) not between 1 and 1000 then raise exception 'invalid assertion summary'; end if;
    insert into public.case_assertions (
      workspace_key, case_id, case_revision, assertion_kind, summary, confidence, evidence
    ) values (
      v_case.workspace_key, v_case.id, v_case.revision, v_kind,
      btrim(v_assertion ->> 'summary'),
      greatest(0, least(1, coalesce((v_assertion ->> 'confidence')::numeric, 0))),
      coalesce(v_assertion -> 'evidenceIds', '[]'::jsonb)
    );
  end loop;

  for v_proposal in select value from jsonb_array_elements(p_proposals)
  loop
    v_kind := v_proposal ->> 'actionKind';
    v_target := btrim(coalesce(v_proposal ->> 'targetKey', ''));
    v_title := btrim(coalesce(v_proposal ->> 'title', ''));
    v_reason := btrim(coalesce(v_proposal ->> 'reason', ''));
    v_confidence := coalesce((v_proposal ->> 'confidence')::numeric, 0);
    v_status := case when coalesce((v_proposal ->> 'waiting')::boolean, false) then 'waiting' else 'open' end;
    if v_kind not in ('schedule_job', 'assign_project_manager', 'assign_crew', 'follow_up', 'review_scope_change', 'resolve_blocker', 'confirm_decision', 'collect_balance') then raise exception 'invalid action kind'; end if;
    if char_length(v_target) not between 1 and 255 or char_length(v_title) not between 1 and 200 or char_length(v_reason) not between 1 and 2000 then raise exception 'invalid proposal text'; end if;
    if v_confidence < 0 or v_confidence > 1 then raise exception 'invalid proposal confidence'; end if;
    if v_production in ('completed', 'cancelled', 'archived') and v_kind in ('schedule_job', 'assign_project_manager', 'assign_crew', 'review_scope_change') then
      continue;
    end if;
    if v_financial = 'paid' and v_kind = 'collect_balance' then continue; end if;

    v_shadow := v_settings.shadow_decisions_remaining > 0 or not v_settings.publication_enabled;
    if v_settings.shadow_decisions_remaining > 0 then
      update public.case_reconciler_settings
      set shadow_decisions_remaining = shadow_decisions_remaining - 1, updated_at = now()
      where workspace_key = v_case.workspace_key
      returning * into v_settings;
    end if;

    v_item_id := private.ensure_work_item(
      v_case.workspace_key, v_case.id, v_kind, v_target, v_title, v_reason,
      'hermes', v_case.revision, v_confidence,
      coalesce(v_proposal -> 'prerequisites', '{}'::jsonb), v_shadow, v_status,
      v_proposal ->> 'owner',
      case when nullif(v_proposal ->> 'dueAt', '') is null then null else (v_proposal ->> 'dueAt')::timestamptz end
    );
    for v_evidence_id in select value from jsonb_array_elements(coalesce(v_proposal -> 'evidenceIds', '[]'::jsonb))
    loop
      if jsonb_typeof(v_evidence_id) <> 'number' then raise exception 'invalid evidence id'; end if;
      insert into public.work_item_evidence (work_item_id, case_evidence_id)
      select v_item_id, evidence.id from public.case_evidence evidence
      where evidence.id = (v_evidence_id #>> '{}')::bigint and evidence.case_id = v_case.id
      on conflict do nothing;
    end loop;
    v_created := v_created + 1;
  end loop;

  insert into public.case_reconciler_runs (
    id, workspace_key, job_id, case_id, input_revision, status,
    model, prompt_version, output, started_at
  ) values (
    v_run_id, v_case.workspace_key, v_job.id, v_case.id, v_job.input_revision,
    'completed', nullif(left(btrim(coalesce(p_model, '')), 200), ''),
    left(p_prompt_version, 100),
    jsonb_build_object('assertions', p_assertions, 'proposals', p_proposals, 'workItemsProcessed', v_created),
    coalesce(v_job.claimed_at, now())
  );
  update public.case_reconciliation_jobs
  set status = 'succeeded', finished_at = now(), lease_owner = null,
      lease_token = null, leased_until = null, updated_at = now()
  where id = v_job.id;
  update public.operational_cases set reconciled_at = now(), updated_at = now() where id = v_case.id;
  return jsonb_build_object('jobId', v_job.id, 'runId', v_run_id, 'workItemsProcessed', v_created);
end;
$$;

create or replace function public.fail_case_reconciliation_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error text,
  p_model text default null,
  p_prompt_version text default 'case-reconciler-v1'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.case_reconciliation_jobs%rowtype;
begin
  select * into v_job from public.case_reconciliation_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'leased' or v_job.lease_token is distinct from p_lease_token then raise exception 'job lease is invalid'; end if;
  insert into public.case_reconciler_runs (
    workspace_key, job_id, case_id, input_revision, status, model,
    prompt_version, error, started_at
  ) values (
    v_job.workspace_key, v_job.id, v_job.case_id, v_job.input_revision, 'failed',
    nullif(left(btrim(coalesce(p_model, '')), 200), ''), left(p_prompt_version, 100),
    left(coalesce(p_error, 'Unknown case reconciliation failure'), 2000), coalesce(v_job.claimed_at, now())
  ) on conflict (job_id, input_revision) do update
    set status = 'failed', error = excluded.error, finished_at = now();
  update public.case_reconciliation_jobs
  set status = case when attempts >= 3 then 'failed' else 'pending' end,
      available_at = now() + make_interval(mins => least(30, power(2, greatest(attempts, 1))::integer)),
      last_error = left(coalesce(p_error, 'Unknown failure'), 2000),
      finished_at = case when attempts >= 3 then now() else null end,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = now()
  where id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'status', case when v_job.attempts >= 3 then 'failed' else 'pending' end);
end;
$$;

create or replace function public.resolve_operational_work_item(
  p_work_item_id uuid,
  p_action text,
  p_note text default null,
  p_actor_id text default 'manager'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_item public.work_items%rowtype;
  v_from_status text;
  v_to_status text;
  v_event_type text;
begin
  if p_action not in ('complete', 'dismiss', 'reopen') then raise exception 'invalid resolution action'; end if;
  if p_note is not null and char_length(p_note) > 2000 then raise exception 'note is too long'; end if;
  select * into v_item from public.work_items where id = p_work_item_id for update;
  if not found then raise exception 'work item does not exist'; end if;
  if p_action = 'reopen' and v_item.status not in ('completed', 'dismissed') then raise exception 'only completed or dismissed work can be reopened'; end if;
  if p_action <> 'reopen' and v_item.status not in ('open', 'waiting') then return to_jsonb(v_item); end if;
  v_from_status := v_item.status;
  v_to_status := case p_action when 'complete' then 'completed' when 'dismiss' then 'dismissed' else 'open' end;
  v_event_type := case p_action when 'complete' then 'completed' when 'dismiss' then 'dismissed' else 'reopened' end;
  update public.work_items
  set status = v_to_status,
      completed_at = case when p_action = 'complete' then now() else null end,
      dismissed_at = case when p_action = 'dismiss' then now() else null end,
      superseded_at = null,
      is_shadow = case when p_action = 'reopen' then false else is_shadow end,
      published_at = case when p_action = 'reopen' then coalesce(published_at, now()) else published_at end,
      updated_at = now()
  where id = v_item.id returning * into v_item;
  insert into public.work_item_events (
    workspace_key, work_item_id, event_type, actor_type, actor_id, note, from_status, to_status
  ) values (
    v_item.workspace_key, v_item.id, v_event_type, 'user', left(p_actor_id, 160),
    nullif(btrim(coalesce(p_note, '')), ''),
    v_from_status,
    v_to_status
  );
  update public.operational_cases set revision = revision + 1, updated_at = now() where id = v_item.case_id;
  perform private.enqueue_case_reconciliation(v_item.case_id, 'manual', 100, 0);
  return to_jsonb(v_item);
end;
$$;

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
  v_seen integer := 0;
  v_enqueued integer := 0;
begin
  if p_limit not between 1 and 5000 then raise exception 'invalid limit'; end if;
  for v_job_id in
    select job.id from public.jobs job
    order by job.updated_at desc, job.id
    limit p_limit
  loop
    perform private.refresh_operational_case(v_job_id, false);
    v_seen := v_seen + 1;
  end loop;
  insert into public.case_reconciliation_jobs (workspace_key, case_id, input_revision, priority, queue_source, available_at)
  select case_row.workspace_key, case_row.id, case_row.revision, 20, 'reconcile', now()
  from public.operational_cases case_row
  left join public.case_reconciliation_jobs queue
    on queue.case_id = case_row.id and queue.input_revision = case_row.revision
  where case_row.workspace_key = p_workspace_key and queue.id is null
  on conflict do nothing;
  get diagnostics v_enqueued = row_count;
  return jsonb_build_object('jobsRefreshed', v_seen, 'casesEnqueued', v_enqueued);
end;
$$;

revoke all on function private.safe_bigint(text) from public, anon, authenticated;
revoke all on function private.work_item_fingerprint(uuid, text, text) from public, anon, authenticated;
revoke all on function private.record_case_fact(text, uuid, text, jsonb, smallint, text, text, timestamptz, timestamptz, numeric, jsonb) from public, anon, authenticated;
revoke all on function private.ensure_work_item(text, uuid, text, text, text, text, text, integer, numeric, jsonb, boolean, text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.supersede_work_item(uuid, text) from public, anon, authenticated;
revoke all on function private.enqueue_case_reconciliation(uuid, text, smallint, integer) from public, anon, authenticated;
revoke all on function private.refresh_operational_case(uuid, boolean) from public, anon, authenticated;
revoke all on function public.claim_case_reconciliation_job(text, integer) from public, anon, authenticated;
revoke all on function public.complete_case_reconciliation_job(bigint, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_case_reconciliation_job(bigint, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.resolve_operational_work_item(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.reconcile_operational_cases(text, integer) from public, anon, authenticated;

grant execute on function public.claim_case_reconciliation_job(text, integer) to service_role;
grant execute on function public.complete_case_reconciliation_job(bigint, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_case_reconciliation_job(bigint, uuid, text, text, text) to service_role;
grant execute on function public.resolve_operational_work_item(uuid, text, text, text) to service_role;
grant execute on function public.reconcile_operational_cases(text, integer) to service_role;
