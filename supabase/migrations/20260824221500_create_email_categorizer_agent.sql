create table public.labels (
  id bigint generated always as identity primary key,
  account_email text not null,
  kind text not null,
  key text not null,
  name text not null,
  description text not null default '',
  color text not null default '#8a8a96',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint labels_account_email_lowercase_check check (account_email = lower(account_email)),
  constraint labels_kind_check check (kind in ('urgency', 'email')),
  constraint labels_key_check check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint labels_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint labels_description_check check (char_length(description) <= 500),
  constraint labels_color_check check (color ~ '^#[0-9a-fA-F]{6}$'),
  constraint labels_account_key_key unique (account_email, key)
);

comment on table public.labels is
  'Business-configurable signal categories. These labels belong to Fluid, not Gmail.';

create unique index labels_account_name_key
  on public.labels (account_email, lower(name));

create index labels_account_kind_enabled_sort_idx
  on public.labels (account_email, kind, enabled, sort_order, id);

create table public.agent_jobs (
  id bigint generated always as identity primary key,
  agent_key text not null,
  activity_id bigint not null references public.activities(id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  lease_owner text,
  lease_token uuid,
  leased_until timestamptz,
  last_error text,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_jobs_agent_key_check check (agent_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint agent_jobs_status_check check (status in ('pending', 'leased', 'succeeded', 'failed')),
  constraint agent_jobs_attempts_check check (attempts >= 0),
  constraint agent_jobs_last_error_check check (last_error is null or char_length(last_error) <= 2000),
  constraint agent_jobs_agent_activity_key unique (agent_key, activity_id)
);

comment on table public.agent_jobs is
  'Durable per-signal work queue for Hermes agents. A lease prevents duplicate concurrent processing.';

create index agent_jobs_activity_id_idx on public.agent_jobs (activity_id);

create index agent_jobs_ready_idx
  on public.agent_jobs (agent_key, available_at, id)
  where status = 'pending';

create index agent_jobs_lease_expiry_idx
  on public.agent_jobs (agent_key, leased_until, id)
  where status = 'leased';

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null,
  job_id bigint not null references public.agent_jobs(id) on delete cascade,
  activity_id bigint not null references public.activities(id) on delete cascade,
  status text not null,
  model text,
  prompt_version text not null,
  error text,
  evidence jsonb not null default '{}',
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint agent_runs_agent_key_check check (agent_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint agent_runs_status_check check (status in ('completed', 'failed')),
  constraint agent_runs_error_check check (error is null or char_length(error) <= 2000),
  constraint agent_runs_evidence_size_check check (pg_column_size(evidence) <= 2097152)
);

comment on table public.agent_runs is
  'Immutable audit records for completed or failed Hermes signal-classification attempts.';

create index agent_runs_job_id_idx on public.agent_runs (job_id);
create index agent_runs_activity_id_idx on public.agent_runs (activity_id);
create index agent_runs_agent_finished_idx on public.agent_runs (agent_key, finished_at desc);

create table public.signal_labels (
  id bigint generated always as identity primary key,
  activity_id bigint not null references public.activities(id) on delete cascade,
  label_id bigint not null references public.labels(id) on delete restrict,
  agent_key text not null,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  assigned_by text not null default 'agent',
  confidence numeric(5,4),
  reason text not null default '',
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signal_labels_agent_key_check check (agent_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint signal_labels_assigned_by_check check (assigned_by in ('agent', 'manual')),
  constraint signal_labels_confidence_check check (confidence is null or confidence between 0 and 1),
  constraint signal_labels_reason_check check (char_length(reason) <= 1000),
  constraint signal_labels_evidence_size_check check (pg_column_size(evidence) <= 2097152),
  constraint signal_labels_activity_agent_key unique (activity_id, agent_key)
);

comment on table public.signal_labels is
  'The current Fluid classification attached to one individual activity signal; Gmail thread history is context only.';

create index signal_labels_label_id_idx on public.signal_labels (label_id);
create index signal_labels_agent_run_id_idx on public.signal_labels (agent_run_id);

create table public.signal_attachment_evidence (
  id bigint generated always as identity primary key,
  activity_id bigint not null references public.activities(id) on delete cascade,
  agent_key text not null,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  attachment_key text not null,
  filename text,
  mime_type text,
  size_bytes bigint,
  extraction_status text not null,
  extraction_method text,
  extracted_text text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signal_attachment_evidence_agent_key_check check (agent_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint signal_attachment_evidence_key_check check (char_length(attachment_key) between 1 and 500),
  constraint signal_attachment_evidence_filename_check check (filename is null or char_length(filename) <= 500),
  constraint signal_attachment_evidence_mime_check check (mime_type is null or char_length(mime_type) <= 200),
  constraint signal_attachment_evidence_size_check check (size_bytes is null or size_bytes >= 0),
  constraint signal_attachment_evidence_status_check check (
    extraction_status in ('metadata', 'extracted', 'no_text', 'unsupported', 'failed')
  ),
  constraint signal_attachment_evidence_method_check check (
    extraction_method is null or char_length(extraction_method) <= 100
  ),
  constraint signal_attachment_evidence_text_size_check check (
    extracted_text is null or char_length(extracted_text) <= 100000
  ),
  constraint signal_attachment_evidence_metadata_size_check check (pg_column_size(metadata) <= 524288),
  constraint signal_attachment_evidence_activity_agent_key unique (activity_id, agent_key, attachment_key)
);

comment on table public.signal_attachment_evidence is
  'Selective text/OCR evidence extracted from signal attachments. The original file remains in Gmail.';

create index signal_attachment_evidence_activity_id_idx
  on public.signal_attachment_evidence (activity_id);

create index signal_attachment_evidence_agent_run_id_idx
  on public.signal_attachment_evidence (agent_run_id)
  where agent_run_id is not null;

alter table public.labels enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.agent_runs enable row level security;
alter table public.signal_labels enable row level security;
alter table public.signal_attachment_evidence enable row level security;

create policy labels_manager_read
  on public.labels for select to authenticated
  using ((select private.is_manager()));

create policy agent_jobs_manager_read
  on public.agent_jobs for select to authenticated
  using ((select private.is_manager()));

create policy agent_runs_manager_read
  on public.agent_runs for select to authenticated
  using ((select private.is_manager()));

create policy signal_labels_manager_read
  on public.signal_labels for select to authenticated
  using ((select private.is_manager()));

create policy signal_attachment_evidence_manager_read
  on public.signal_attachment_evidence for select to authenticated
  using ((select private.is_manager()));

revoke all on table public.labels, public.agent_jobs, public.agent_runs,
  public.signal_labels, public.signal_attachment_evidence from anon, authenticated;
revoke all on sequence public.labels_id_seq, public.agent_jobs_id_seq,
  public.signal_labels_id_seq, public.signal_attachment_evidence_id_seq from anon, authenticated;

grant select on table public.labels, public.agent_jobs, public.agent_runs,
  public.signal_labels, public.signal_attachment_evidence to authenticated;
grant all on table public.labels, public.agent_jobs, public.agent_runs,
  public.signal_labels, public.signal_attachment_evidence to service_role;
grant usage, select on sequence public.labels_id_seq, public.agent_jobs_id_seq,
  public.signal_labels_id_seq, public.signal_attachment_evidence_id_seq to service_role;

insert into public.labels (account_email, kind, key, name, description, color, sort_order)
values
  ('info@paintersottawa.com', 'urgency', 'urgent', 'Urgent', 'Someone is blocked, upset, or needs same-day action.', '#f4587a', 10),
  ('info@paintersottawa.com', 'urgency', 'follow-up', 'Follow up', 'Nothing is due now, but the team should reconnect at a set time.', '#9d97f5', 20),
  ('info@paintersottawa.com', 'urgency', 'waiting-on-them', 'Waiting on them', 'The team has acted and the next move belongs to the other person.', '#4cc4b8', 30),
  ('info@paintersottawa.com', 'urgency', 'needs-review', 'Needs review', 'Fluid cannot confidently decide what action should happen next.', '#e07bb4', 40),
  ('info@paintersottawa.com', 'urgency', 'no-action', 'No action', 'Informational, promotional, automated, or already resolved.', '#8a8a96', 50),
  ('info@paintersottawa.com', 'email', 'commercial-inquiries', 'Commercial Inquiries', 'Commercial painting opportunities, bid invitations, and estimate requests.', '#43c78f', 10),
  ('info@paintersottawa.com', 'email', 'client-communication', 'Client Communication', 'Direct customer questions, scheduling, updates, and job conversations.', '#4cc4b8', 20),
  ('info@paintersottawa.com', 'email', 'people-hiring', 'People/Hiring', 'Applications, interviews, candidates, and recruiting correspondence.', '#43c78f', 30),
  ('info@paintersottawa.com', 'email', 'production-paint-orders', 'Production/Paint orders', 'Paint orders, colour details, pickup notices, and supplier confirmations.', '#9d97f5', 40),
  ('info@paintersottawa.com', 'email', 'finance-material-receipts', 'Finance/Material receipts', 'Receipts for paint, supplies, equipment, and job materials.', '#d3a24b', 50),
  ('info@paintersottawa.com', 'email', 'finance-contractor-invoices', 'Finance/Contractor invoices', 'Invoices and supporting documents submitted by subcontractors.', '#d3a24b', 60),
  ('info@paintersottawa.com', 'email', 'finance-customer-payments', 'Finance/Customer payments', 'Customer deposits, balance payments, remittances, and payment confirmations.', '#d3a24b', 70),
  ('info@paintersottawa.com', 'email', 'finance-banking-statements', 'Finance/Banking & statements', 'Bank notices, statements, card activity, and other banking correspondence.', '#d3a24b', 80),
  ('info@paintersottawa.com', 'email', 'finance-general-receipts', 'Finance/General receipts', 'Receipts for general business expenses and purchases.', '#d3a24b', 90),
  ('info@paintersottawa.com', 'email', 'finance-compliance-insurance', 'Insurance, tax, compliance, certificates, and related financial records.', '#d3a24b', 100),
  ('info@paintersottawa.com', 'email', 'systems-dripjobs', 'Systems/DripJobs', 'DripJobs notifications, workflow updates, and automated system messages.', '#4cc4b8', 110),
  ('info@paintersottawa.com', 'email', 'systems-technical-alerts', 'Systems/Technical alerts', 'Errors, security notices, outages, and other technical alerts.', '#4cc4b8', 120),
  ('info@paintersottawa.com', 'email', 'marketing-reviews', 'Marketing/Reviews', 'Customer reviews, review requests, and reputation-management notices.', '#e07bb4', 130),
  ('info@paintersottawa.com', 'email', 'low-priority-newsletters', 'Low priority/Newsletters', 'Promotions, newsletters, digests, and other bulk mail.', '#8a8a96', 140),
  ('info@paintersottawa.com', 'email', 'general', 'General', 'Use only when none of the enabled business categories accurately describe the signal.', '#8a8a96', 1000)
on conflict (account_email, key) do nothing;

create or replace function private.enqueue_email_categorizer_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.source = 'gmail' and new.direction = 'inbound' then
    insert into public.agent_jobs (agent_key, activity_id)
    values ('email-categorizer', new.id)
    on conflict (agent_key, activity_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.enqueue_email_categorizer_job() from public, anon, authenticated;

create trigger activities_enqueue_email_categorizer
after insert on public.activities
for each row execute function private.enqueue_email_categorizer_job();

insert into public.agent_jobs (agent_key, activity_id)
select 'email-categorizer', activity.id
from public.activities as activity
where activity.source = 'gmail'
  and activity.direction = 'inbound'
  and activity.occurred_at >= now() - interval '48 hours'
on conflict (agent_key, activity_id) do nothing;

create or replace function public.claim_email_categorizer_job(
  p_worker text,
  p_lease_seconds integer default 1800
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_signal jsonb;
  v_labels jsonb;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then
    raise exception 'worker must be between 1 and 100 characters';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception 'lease seconds must be between 60 and 3600';
  end if;

  update public.agent_jobs
  set status = 'pending',
      available_at = v_now,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = v_now
  where agent_key = 'email-categorizer'
    and status = 'leased'
    and leased_until < v_now;

  select job.*
  into v_job
  from public.agent_jobs as job
  where job.agent_key = 'email-categorizer'
    and job.status = 'pending'
    and job.available_at <= v_now
  order by job.available_at, job.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('job', null);
  end if;

  update public.agent_jobs
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

  select to_jsonb(activity) - 'source_labels'
  into v_signal
  from public.activities as activity
  where activity.id = v_job.activity_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', label.key,
        'name', label.name,
        'description', label.description,
        'color', label.color
      ) order by label.sort_order, label.id
    ),
    '[]'::jsonb
  )
  into v_labels
  from public.labels as label
  where label.account_email = v_signal ->> 'account_email'
    and label.kind = 'email'
    and label.enabled = true;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'agentKey', v_job.agent_key,
      'activityId', v_job.activity_id,
      'attempt', v_job.attempts,
      'leaseToken', v_job.lease_token,
      'leasedUntil', v_job.leased_until
    ),
    'signal', v_signal,
    'labels', v_labels
  );
end;
$$;

create or replace function public.complete_email_categorizer_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_label_key text,
  p_confidence numeric,
  p_reason text,
  p_model text,
  p_prompt_version text,
  p_evidence jsonb default '{}'::jsonb,
  p_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_label public.labels%rowtype;
  v_run_id uuid;
  v_account_email text;
  v_attachment jsonb;
  v_attachment_key text;
  v_text text;
  v_status text;
  v_size bigint;
  v_ordinal bigint;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job id and lease token are required';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception 'confidence must be between 0 and 1';
  end if;
  if p_reason is null or char_length(p_reason) > 1000 then
    raise exception 'reason must be at most 1000 characters';
  end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then
    raise exception 'prompt version must be between 1 and 100 characters';
  end if;
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
     or pg_column_size(coalesce(p_evidence, '{}'::jsonb)) > 2097152 then
    raise exception 'evidence must be a JSON object no larger than 2 MB';
  end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 20 then
    raise exception 'attachments must be a JSON array with at most 20 items';
  end if;

  select job.*
  into v_job
  from public.agent_jobs as job
  where job.id = p_job_id
  for update;

  if not found or v_job.agent_key <> 'email-categorizer'
     or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token then
    raise exception 'job lease is no longer valid';
  end if;

  select activity.account_email
  into v_account_email
  from public.activities as activity
  where activity.id = v_job.activity_id;

  select label.*
  into v_label
  from public.labels as label
  where label.account_email = v_account_email
    and label.key = p_label_key
    and label.kind = 'email'
    and label.enabled = true;

  if not found then
    raise exception 'label is not enabled for this account';
  end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, status, model, prompt_version,
    evidence, started_at, finished_at
  )
  values (
    v_job.agent_key, v_job.id, v_job.activity_id, 'completed',
    nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    coalesce(p_evidence, '{}'::jsonb), coalesce(v_job.claimed_at, v_now), v_now
  )
  returning id into v_run_id;

  insert into public.signal_labels (
    activity_id, label_id, agent_key, agent_run_id, assigned_by,
    confidence, reason, evidence, updated_at
  )
  values (
    v_job.activity_id, v_label.id, v_job.agent_key, v_run_id, 'agent',
    p_confidence, p_reason, coalesce(p_evidence, '{}'::jsonb), v_now
  )
  on conflict (activity_id, agent_key) do update
  set label_id = excluded.label_id,
      agent_run_id = excluded.agent_run_id,
      assigned_by = excluded.assigned_by,
      confidence = excluded.confidence,
      reason = excluded.reason,
      evidence = excluded.evidence,
      updated_at = excluded.updated_at;

  for v_attachment, v_ordinal in
    select item.value, item.ordinality
    from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb))
      with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(v_attachment) <> 'object' then
      continue;
    end if;
    v_attachment_key := left(coalesce(
      nullif(btrim(v_attachment ->> 'attachmentKey'), ''),
      nullif(btrim(v_attachment ->> 'partId'), ''),
      nullif(btrim(v_attachment ->> 'filename'), ''),
      v_ordinal::text
    ), 500);
    v_text := nullif(left(coalesce(v_attachment ->> 'extractedText', ''), 100000), '');
    v_status := coalesce(nullif(v_attachment ->> 'status', ''),
      case when v_text is null then 'metadata' else 'extracted' end);
    if v_status not in ('metadata', 'extracted', 'no_text', 'unsupported', 'failed') then
      v_status := case when v_text is null then 'metadata' else 'extracted' end;
    end if;
    v_size := case
      when coalesce(v_attachment ->> 'sizeBytes', '') ~ '^[0-9]{1,18}$'
        then (v_attachment ->> 'sizeBytes')::bigint
      else null
    end;

    insert into public.signal_attachment_evidence (
      activity_id, agent_key, agent_run_id, attachment_key, filename,
      mime_type, size_bytes, extraction_status, extraction_method,
      extracted_text, metadata, updated_at
    )
    values (
      v_job.activity_id, v_job.agent_key, v_run_id, v_attachment_key,
      nullif(left(coalesce(v_attachment ->> 'filename', ''), 500), ''),
      nullif(left(coalesce(v_attachment ->> 'mimeType', ''), 200), ''),
      v_size, v_status,
      nullif(left(coalesce(v_attachment ->> 'extractionMethod', ''), 100), ''),
      v_text,
      case
        when jsonb_typeof(v_attachment -> 'metadata') = 'object'
          and pg_column_size(v_attachment -> 'metadata') <= 524288
          then v_attachment -> 'metadata'
        else '{}'::jsonb
      end,
      v_now
    )
    on conflict (activity_id, agent_key, attachment_key) do update
    set agent_run_id = excluded.agent_run_id,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        extraction_status = excluded.extraction_status,
        extraction_method = excluded.extraction_method,
        extracted_text = excluded.extracted_text,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at;
  end loop;

  update public.agent_jobs
  set status = 'succeeded',
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      last_error = null,
      finished_at = v_now,
      updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id,
    'activityId', v_job.activity_id,
    'runId', v_run_id,
    'label', jsonb_build_object('key', v_label.key, 'name', v_label.name)
  );
end;
$$;

create or replace function public.fail_email_categorizer_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error text,
  p_model text,
  p_prompt_version text
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
  if p_error is null or char_length(btrim(p_error)) not between 1 and 2000 then
    raise exception 'error must be between 1 and 2000 characters';
  end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then
    raise exception 'prompt version must be between 1 and 100 characters';
  end if;

  select job.*
  into v_job
  from public.agent_jobs as job
  where job.id = p_job_id
  for update;

  if not found or v_job.agent_key <> 'email-categorizer'
     or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token then
    raise exception 'job lease is no longer valid';
  end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, status, model, prompt_version,
    error, evidence, started_at, finished_at
  )
  values (
    v_job.agent_key, v_job.id, v_job.activity_id, 'failed',
    nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    left(btrim(p_error), 2000), '{}'::jsonb, coalesce(v_job.claimed_at, v_now), v_now
  );

  v_terminal := v_job.attempts >= 5;
  update public.agent_jobs
  set status = case when v_terminal then 'failed' else 'pending' end,
      available_at = case
        when v_terminal then available_at
        else v_now + make_interval(secs => least(3600, 30 * (2 ^ greatest(attempts - 1, 0))::integer))
      end,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      last_error = left(btrim(p_error), 2000),
      finished_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id,
    'activityId', v_job.activity_id,
    'status', case when v_terminal then 'failed' else 'pending' end,
    'attempt', v_job.attempts
  );
end;
$$;

revoke all on function public.claim_email_categorizer_job(text, integer) from public, anon, authenticated;
revoke all on function public.complete_email_categorizer_job(bigint, uuid, text, numeric, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_email_categorizer_job(bigint, uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.claim_email_categorizer_job(text, integer) to service_role;
grant execute on function public.complete_email_categorizer_job(bigint, uuid, text, numeric, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_email_categorizer_job(bigint, uuid, text, text, text) to service_role;
