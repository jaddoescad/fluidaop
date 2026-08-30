-- DripJobs remains the stage authority. Fluid stores the current projection,
-- immutable stage progress, and deterministic daily reconciliation runs.

alter table public.dripjobs_sales_deals
  add column if not exists stage_entered_at timestamptz,
  add column if not exists stage_observed_at timestamptz,
  add column if not exists last_active_snapshot_at timestamptz,
  add column if not exists archived_at timestamptz;

create table if not exists public.dripjobs_pipeline_stage_events (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters'
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  deal_id text not null check (deal_id ~ '^[0-9a-f]{30,}$'),
  event_key text not null check (char_length(event_key) between 1 and 500),
  event_kind text not null
    check (event_kind in ('baseline', 'stage_changed', 'archived', 'reactivated')),
  from_stage text,
  to_stage text,
  effective_at timestamptz not null,
  observed_at timestamptz not null default now(),
  source text not null check (source in ('baseline', 'zapier', 'snapshot')),
  source_document_id uuid references public.documents(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 262144),
  created_at timestamptz not null default now(),
  unique (workspace_key, event_key),
  check (from_stage is null or char_length(btrim(from_stage)) between 1 and 300),
  check (to_stage is null or char_length(btrim(to_stage)) between 1 and 300),
  check (event_kind = 'archived' or to_stage is not null)
);

create index if not exists dripjobs_pipeline_stage_events_deal_time_idx
  on public.dripjobs_pipeline_stage_events (workspace_key, deal_id, effective_at desc, id desc);
create index if not exists dripjobs_pipeline_stage_events_document_idx
  on public.dripjobs_pipeline_stage_events (source_document_id)
  where source_document_id is not null;

alter table public.dripjobs_pipeline_stage_events enable row level security;
revoke all on table public.dripjobs_pipeline_stage_events from public, anon, authenticated;
grant select, insert on table public.dripjobs_pipeline_stage_events to service_role;
grant usage, select on sequence public.dripjobs_pipeline_stage_events_id_seq to service_role;

comment on table public.dripjobs_pipeline_stage_events is
  'Append-only DripJobs deal-stage progress. Fluid records observations but never authors a stage.';

create table if not exists public.dripjobs_pipeline_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters'
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  run_key text not null check (char_length(run_key) between 1 and 200),
  captured_at timestamptz not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  active_rows integer not null default 0 check (active_rows >= 0),
  archived_rows integer not null default 0 check (archived_rows >= 0),
  inserted_deals integer not null default 0 check (inserted_deals >= 0),
  changed_stages integer not null default 0 check (changed_stages >= 0),
  archived_deals integer not null default 0 check (archived_deals >= 0),
  reactivated_deals integer not null default 0 check (reactivated_deals >= 0),
  source_document_ids uuid[] not null default '{}'::uuid[],
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 262144),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_key, run_key)
);

create index if not exists dripjobs_pipeline_sync_runs_status_time_idx
  on public.dripjobs_pipeline_sync_runs (workspace_key, status, captured_at desc);

alter table public.dripjobs_pipeline_sync_runs enable row level security;
revoke all on table public.dripjobs_pipeline_sync_runs from public, anon, authenticated;
grant select, insert, update on table public.dripjobs_pipeline_sync_runs to service_role;

comment on table public.dripjobs_pipeline_sync_runs is
  'Durable ledger for the daily direct DripJobs Sales List reconciliation.';

-- Existing data becomes an explicitly labelled baseline. Its timestamp means
-- "tracking began here", not that Fluid knows when DripJobs entered the stage.
update public.dripjobs_sales_deals
set
  stage_entered_at = coalesce(stage_entered_at, captured_at),
  stage_observed_at = coalesce(stage_observed_at, captured_at),
  last_active_snapshot_at = case
    when source_view = 'active' then coalesce(last_active_snapshot_at, captured_at)
    else last_active_snapshot_at
  end,
  archived_at = case
    when source_view = 'archived' then coalesce(archived_at, captured_at)
    else archived_at
  end
where stage_entered_at is null
   or stage_observed_at is null
   or (source_view = 'active' and last_active_snapshot_at is null)
   or (source_view = 'archived' and archived_at is null);

insert into public.dripjobs_pipeline_stage_events (
  workspace_key,
  deal_id,
  event_key,
  event_kind,
  from_stage,
  to_stage,
  effective_at,
  observed_at,
  source,
  source_document_id,
  metadata
)
select
  'ottawa-painters',
  deal.deal_id,
  'baseline:' || deal.deal_id,
  'baseline',
  null,
  deal.deal_stage,
  coalesce(deal.stage_entered_at, deal.captured_at),
  coalesce(deal.stage_observed_at, deal.captured_at),
  'baseline',
  deal.source_document_id,
  jsonb_build_object('label', 'Tracking began in ' || deal.deal_stage)
from public.dripjobs_sales_deals deal
on conflict (workspace_key, event_key) do nothing;

insert into public.dripjobs_pipeline_sync_runs (
  workspace_key,
  run_key,
  captured_at,
  status,
  active_rows,
  archived_rows,
  source_document_ids,
  metadata,
  started_at,
  finished_at,
  updated_at
)
select
  'ottawa-painters',
  'migration-baseline',
  coalesce(
    max(deal.captured_at) filter (where deal.source_view = 'active'),
    max(deal.captured_at),
    now()
  ),
  'succeeded',
  count(*) filter (where deal.source_view = 'active')::integer,
  count(*) filter (where deal.source_view = 'archived')::integer,
  coalesce(array_agg(distinct deal.source_document_id), '{}'::uuid[]),
  jsonb_build_object('baseline', true, 'cadence', 'daily'),
  coalesce(
    max(deal.captured_at) filter (where deal.source_view = 'active'),
    max(deal.captured_at),
    now()
  ),
  coalesce(
    max(deal.captured_at) filter (where deal.source_view = 'active'),
    max(deal.captured_at),
    now()
  ),
  now()
from public.dripjobs_sales_deals deal
on conflict (workspace_key, run_key) do nothing;

-- Apply one signed Zapier stage observation. The event may arrive before the
-- daily snapshot has created the exact deal row; history is still retained.
create or replace function public.record_dripjobs_pipeline_stage_event(
  p_workspace_key text,
  p_event_key text,
  p_deal_id text,
  p_stage text,
  p_changed_at timestamptz,
  p_observed_at timestamptz default now(),
  p_previous_stage text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current_stage text;
  v_stage_entered_at timestamptz;
  v_event_id bigint;
  v_found boolean := false;
  v_stale boolean := false;
begin
  if coalesce(p_workspace_key, '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Invalid workspace key';
  end if;
  if coalesce(p_event_key, '') = '' or char_length(p_event_key) > 500 then
    raise exception 'Invalid DripJobs stage event key';
  end if;
  if coalesce(p_deal_id, '') !~ '^[0-9a-f]{30,}$' then
    raise exception 'An exact DripJobs Sales List deal ID is required';
  end if;
  if btrim(coalesce(p_stage, '')) = '' or char_length(btrim(p_stage)) > 300 then
    raise exception 'Invalid DripJobs deal stage';
  end if;
  if p_changed_at is null or p_observed_at is null then
    raise exception 'DripJobs stage timestamps are required';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
     or pg_column_size(coalesce(p_metadata, '{}'::jsonb)) > 262144 then
    raise exception 'Invalid DripJobs stage metadata';
  end if;

  select deal.deal_stage, deal.stage_entered_at
  into v_current_stage, v_stage_entered_at
  from public.dripjobs_sales_deals deal
  where deal.deal_id = p_deal_id
  for update;
  v_found := found;
  v_stale := v_found and v_stage_entered_at is not null and p_changed_at < v_stage_entered_at;

  -- A same-stage notification without a previous stage is only a confirmation.
  if v_found and v_current_stage = btrim(p_stage)
     and nullif(btrim(coalesce(p_previous_stage, '')), '') is null then
    return jsonb_build_object(
      'status', 'unchanged',
      'dealId', p_deal_id,
      'stage', v_current_stage
    );
  end if;

  insert into public.dripjobs_pipeline_stage_events (
    workspace_key,
    deal_id,
    event_key,
    event_kind,
    from_stage,
    to_stage,
    effective_at,
    observed_at,
    source,
    metadata
  ) values (
    p_workspace_key,
    p_deal_id,
    p_event_key,
    'stage_changed',
    coalesce(nullif(btrim(coalesce(p_previous_stage, '')), ''), case when v_stale then null else v_current_stage end),
    btrim(p_stage),
    p_changed_at,
    p_observed_at,
    'zapier',
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (workspace_key, event_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'duplicate', 'dealId', p_deal_id);
  end if;

  if not v_found then
    return jsonb_build_object(
      'status', 'retained_pending_snapshot',
      'dealId', p_deal_id,
      'eventId', v_event_id
    );
  end if;

  if v_stale then
    return jsonb_build_object(
      'status', 'recorded_stale',
      'dealId', p_deal_id,
      'eventId', v_event_id,
      'currentStage', v_current_stage
    );
  end if;

  update public.dripjobs_sales_deals
  set
    deal_stage = btrim(p_stage),
    stage_entered_at = p_changed_at,
    stage_observed_at = p_observed_at,
    archived_at = null,
    updated_at = now()
  where deal_id = p_deal_id;

  return jsonb_build_object(
    'status', 'applied',
    'dealId', p_deal_id,
    'eventId', v_event_id,
    'previousStage', v_current_stage,
    'stage', btrim(p_stage)
  );
end;
$$;

revoke all on function public.record_dripjobs_pipeline_stage_event(
  text, text, text, text, timestamptz, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_dripjobs_pipeline_stage_event(
  text, text, text, text, timestamptz, timestamptz, text, jsonb
) to service_role;

-- Atomically reconcile one complete active/archived Sales List capture. This
-- is called once daily; Zapier handles near-immediate stage changes.
create or replace function public.reconcile_dripjobs_pipeline(
  p_active_rows jsonb,
  p_archived_rows jsonb default '[]'::jsonb,
  p_captured_at timestamptz default now(),
  p_run_key text default null,
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_run_id uuid;
  v_active_document_id uuid := gen_random_uuid();
  v_archived_document_id uuid := gen_random_uuid();
  v_snapshot_sha256 text;
  v_active_count integer;
  v_archived_count integer;
  v_inserted integer := 0;
  v_changed integer := 0;
  v_archived integer := 0;
  v_reactivated integer := 0;
  v_row_number integer;
  v_item jsonb;
  v_view text;
  v_deal_id text;
  v_stage text;
  v_existing_stage text;
  v_existing_entered_at timestamptz;
  v_existing_observed_at timestamptz;
  v_existing_archived_at timestamptz;
  v_stage_entered_at timestamptz;
  v_existing boolean;
  v_document_id uuid;
  v_effective_run_key text;
  v_existing_run_status text;
begin
  if jsonb_typeof(p_active_rows) <> 'array' or jsonb_typeof(p_archived_rows) <> 'array' then
    raise exception 'DripJobs activeRows and archivedRows must be arrays';
  end if;
  if p_captured_at is null then
    raise exception 'DripJobs capturedAt is required';
  end if;
  if coalesce(p_workspace_key, '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'Invalid workspace key';
  end if;

  select count(*) into v_active_count from jsonb_array_elements(p_active_rows);
  select count(*) into v_archived_count from jsonb_array_elements(p_archived_rows);
  if v_active_count = 0 or v_active_count > 10000 or v_archived_count > 10000 then
    raise exception 'DripJobs snapshot contains an invalid row count';
  end if;

  if (select count(distinct item->>'dealId') from jsonb_array_elements(p_active_rows) item) <> v_active_count
     or (select count(distinct item->>'dealId') from jsonb_array_elements(p_archived_rows) item) <> v_archived_count then
    raise exception 'DripJobs snapshot contains duplicate deal IDs';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_active_rows) active
    join jsonb_array_elements(p_archived_rows) archived
      on active->>'dealId' = archived->>'dealId'
  ) then
    raise exception 'A DripJobs deal cannot be active and archived in the same snapshot';
  end if;
  if exists (
    select 1
    from (
      select value as item from jsonb_array_elements(p_active_rows)
      union all
      select value as item from jsonb_array_elements(p_archived_rows)
    ) rows
    where coalesce(item->>'dealId', '') !~ '^[0-9a-f]{30,}$'
       or btrim(coalesce(item->>'salesStatus', '')) = ''
       or btrim(coalesce(item->>'customerName', '')) = ''
       or btrim(coalesce(item->>'dealName', '')) = ''
       or btrim(coalesce(item->>'dealStage', '')) = ''
       or char_length(btrim(item->>'dealStage')) > 300
       or (item ? 'dealAmountCents' and jsonb_typeof(item->'dealAmountCents') <> 'number')
       or coalesce((item->>'dealAmountCents')::numeric, 0) < 0
  ) then
    raise exception 'DripJobs snapshot contains an invalid deal row';
  end if;

  v_snapshot_sha256 := encode(digest(
    jsonb_build_object('active', p_active_rows, 'archived', p_archived_rows)::text,
    'sha256'
  ), 'hex');
  v_effective_run_key := coalesce(
    nullif(btrim(coalesce(p_run_key, '')), ''),
    'snapshot:' || to_char(p_captured_at at time zone 'UTC', 'YYYYMMDDTHH24MISSMS') || ':' || left(v_snapshot_sha256, 16)
  );
  if char_length(v_effective_run_key) > 200 then
    raise exception 'DripJobs runKey is too long';
  end if;

  insert into public.dripjobs_pipeline_sync_runs (
    workspace_key, run_key, captured_at, status, active_rows, archived_rows, metadata
  ) values (
    p_workspace_key,
    v_effective_run_key,
    p_captured_at,
    'running',
    v_active_count,
    v_archived_count,
    jsonb_build_object('cadence', 'daily', 'snapshotSha256', v_snapshot_sha256)
  )
  on conflict (workspace_key, run_key) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id, status into v_run_id, v_existing_run_status
    from public.dripjobs_pipeline_sync_runs
    where workspace_key = p_workspace_key and run_key = v_effective_run_key;
    if v_existing_run_status not in ('failed', 'skipped') then
      return jsonb_build_object(
        'status', 'duplicate',
        'runKey', v_effective_run_key,
        'existingStatus', v_existing_run_status
      );
    end if;
    update public.dripjobs_pipeline_sync_runs
    set
      captured_at = p_captured_at,
      status = 'running',
      active_rows = v_active_count,
      archived_rows = v_archived_count,
      inserted_deals = 0,
      changed_stages = 0,
      archived_deals = 0,
      reactivated_deals = 0,
      source_document_ids = '{}'::uuid[],
      last_error = null,
      metadata = jsonb_build_object('cadence', 'daily', 'snapshotSha256', v_snapshot_sha256, 'retry', true),
      started_at = now(),
      finished_at = null,
      updated_at = now()
    where id = v_run_id;
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('dripjobs-pipeline:' || p_workspace_key, 0)) then
    update public.dripjobs_pipeline_sync_runs
    set status = 'skipped', finished_at = now(), updated_at = now(), last_error = 'Another reconciliation is running'
    where id = v_run_id;
    return jsonb_build_object('status', 'skipped', 'runKey', v_effective_run_key);
  end if;

  begin
    insert into public.documents (
      id, kind, original_filename, mime_type, size_bytes, content_sha256,
      source_url, captured_at, metadata
    ) values
    (
      v_active_document_id,
      'dripjobs_sales_list_snapshot',
      'Sales_List_active.json',
      'application/json',
      octet_length(p_active_rows::text),
      encode(digest(p_active_rows::text, 'sha256'), 'hex'),
      'https://app.dripjobs.com/saleslist',
      p_captured_at,
      jsonb_build_object(
        'source_type', 'fluid_live_dripjobs_saleslist_sync_v2',
        'view', 'active',
        'scope', 'changed_delta',
        'cadence', 'daily',
        'row_count', v_active_count,
        'combined_source_sha256', v_snapshot_sha256
      )
    ),
    (
      v_archived_document_id,
      'dripjobs_sales_list_snapshot',
      'Sales_List_archived.json',
      'application/json',
      octet_length(p_archived_rows::text),
      encode(digest(p_archived_rows::text, 'sha256'), 'hex'),
      'https://app.dripjobs.com/saleslist',
      p_captured_at,
      jsonb_build_object(
        'source_type', 'fluid_live_dripjobs_saleslist_sync_v2',
        'view', 'archived',
        'scope', 'changed_delta',
        'cadence', 'daily',
        'row_count', v_archived_count,
        'combined_source_sha256', v_snapshot_sha256
      )
    );

    for v_view, v_item, v_row_number in
      select 'active', value, ordinality::integer
      from jsonb_array_elements(p_active_rows) with ordinality
      union all
      select 'archived', value, ordinality::integer
      from jsonb_array_elements(p_archived_rows) with ordinality
    loop
      v_deal_id := v_item->>'dealId';
      v_stage := btrim(v_item->>'dealStage');
      v_document_id := case when v_view = 'active' then v_active_document_id else v_archived_document_id end;

      select deal_stage, stage_entered_at, stage_observed_at, archived_at
      into v_existing_stage, v_existing_entered_at, v_existing_observed_at, v_existing_archived_at
      from public.dripjobs_sales_deals
      where deal_id = v_deal_id
      for update;
      v_existing := found;

      if not v_existing then
        v_inserted := v_inserted + 1;
        select max(event.effective_at)
        into v_stage_entered_at
        from public.dripjobs_pipeline_stage_events event
        where event.workspace_key = p_workspace_key
          and event.deal_id = v_deal_id
          and event.to_stage = v_stage;
        v_stage_entered_at := coalesce(v_stage_entered_at, p_captured_at);

        if not exists (
          select 1 from public.dripjobs_pipeline_stage_events event
          where event.workspace_key = p_workspace_key and event.deal_id = v_deal_id
        ) then
          insert into public.dripjobs_pipeline_stage_events (
            workspace_key, deal_id, event_key, event_kind, to_stage,
            effective_at, observed_at, source, source_document_id, metadata
          ) values (
            p_workspace_key,
            v_deal_id,
            'snapshot:' || v_effective_run_key || ':baseline:' || v_deal_id,
            'baseline',
            v_stage,
            p_captured_at,
            p_captured_at,
            'snapshot',
            v_document_id,
            jsonb_build_object('label', 'Tracking began in ' || v_stage)
          ) on conflict (workspace_key, event_key) do nothing;
        end if;
      else
        v_stage_entered_at := coalesce(v_existing_entered_at, p_captured_at);
        if v_existing_stage is distinct from v_stage then
          insert into public.dripjobs_pipeline_stage_events (
            workspace_key, deal_id, event_key, event_kind, from_stage, to_stage,
            effective_at, observed_at, source, source_document_id, metadata
          ) values (
            p_workspace_key,
            v_deal_id,
            'snapshot:' || v_effective_run_key || ':stage:' || v_deal_id,
            'stage_changed',
            v_existing_stage,
            v_stage,
            p_captured_at,
            p_captured_at,
            'snapshot',
            v_document_id,
            jsonb_build_object('repairedMissedEvent', true)
          ) on conflict (workspace_key, event_key) do nothing;
          v_changed := v_changed + 1;
          v_stage_entered_at := p_captured_at;
        end if;
      end if;

      if v_view = 'active' and v_existing and v_existing_archived_at is not null then
        insert into public.dripjobs_pipeline_stage_events (
          workspace_key, deal_id, event_key, event_kind, from_stage, to_stage,
          effective_at, observed_at, source, source_document_id
        ) values (
          p_workspace_key,
          v_deal_id,
          'snapshot:' || v_effective_run_key || ':reactivated:' || v_deal_id,
          'reactivated',
          v_existing_stage,
          v_stage,
          p_captured_at,
          p_captured_at,
          'snapshot',
          v_document_id
        ) on conflict (workspace_key, event_key) do nothing;
        v_reactivated := v_reactivated + 1;
        v_stage_entered_at := p_captured_at;
      end if;

      if v_view = 'archived' and (not v_existing or v_existing_archived_at is null) then
        insert into public.dripjobs_pipeline_stage_events (
          workspace_key, deal_id, event_key, event_kind, from_stage, to_stage,
          effective_at, observed_at, source, source_document_id
        ) values (
          p_workspace_key,
          v_deal_id,
          'snapshot:' || v_effective_run_key || ':archived:' || v_deal_id,
          'archived',
          coalesce(v_existing_stage, v_stage),
          null,
          p_captured_at,
          p_captured_at,
          'snapshot',
          v_document_id
        ) on conflict (workspace_key, event_key) do nothing;
        v_archived := v_archived + 1;
      end if;

      insert into public.dripjobs_sales_deals (
        deal_id,
        dripjobs_contact_id,
        source_document_id,
        source_view,
        sales_status,
        label,
        customer_name,
        email,
        phone,
        normalized_email,
        normalized_phone,
        raw_source,
        normalized_channel,
        deal_name,
        deal_stage,
        deal_amount_cents,
        last_change,
        deal_age,
        salesperson,
        captured_at,
        source_sha256,
        combined_source_sha256,
        source_row_number,
        first_seen_at,
        last_seen_at,
        stage_entered_at,
        stage_observed_at,
        last_active_snapshot_at,
        archived_at,
        metadata
      ) values (
        v_deal_id,
        nullif(v_item->>'dripjobsContactId', ''),
        v_document_id,
        v_view,
        btrim(v_item->>'salesStatus'),
        nullif(btrim(coalesce(v_item->>'label', '')), ''),
        btrim(v_item->>'customerName'),
        nullif(btrim(coalesce(v_item->>'email', '')), ''),
        nullif(btrim(coalesce(v_item->>'phone', '')), ''),
        nullif(lower(btrim(coalesce(v_item->>'email', ''))), ''),
        nullif(regexp_replace(coalesce(v_item->>'phone', ''), '[^0-9]', '', 'g'), ''),
        nullif(btrim(coalesce(v_item->>'source', '')), ''),
        case
          when lower(coalesce(v_item->>'source', '')) like 'meta%' then 'paid_social'
          when lower(coalesce(v_item->>'source', '')) = 'facebook' then 'organic_social'
          when lower(coalesce(v_item->>'source', '')) in ('word of mouth', 'referral') then 'referral'
          when lower(coalesce(v_item->>'source', '')) like '%phone%' then 'phone'
          when lower(coalesce(v_item->>'source', '')) = 'google' then 'organic_search'
          when coalesce(v_item->>'source', '') like '/%'
            or lower(coalesce(v_item->>'source', '')) = 'website' then 'website'
          else 'unknown'
        end,
        btrim(v_item->>'dealName'),
        v_stage,
        coalesce((v_item->>'dealAmountCents')::bigint, 0),
        nullif(btrim(coalesce(v_item->>'lastChange', '')), ''),
        nullif(btrim(coalesce(v_item->>'dealAge', '')), ''),
        nullif(btrim(coalesce(v_item->>'salesperson', '')), ''),
        p_captured_at,
        encode(digest(v_item::text, 'sha256'), 'hex'),
        v_snapshot_sha256,
        v_row_number,
        p_captured_at,
        p_captured_at,
        v_stage_entered_at,
        p_captured_at,
        case when v_view = 'active' then p_captured_at else null end,
        case when v_view = 'archived' then p_captured_at else null end,
        jsonb_build_object(
          'source_type', 'fluid_live_dripjobs_saleslist_sync_v2',
          'source_row_number', v_row_number,
          'cadence', 'daily'
        )
      )
      on conflict (deal_id) do update set
        dripjobs_contact_id = excluded.dripjobs_contact_id,
        source_document_id = excluded.source_document_id,
        source_view = excluded.source_view,
        sales_status = excluded.sales_status,
        label = excluded.label,
        customer_name = excluded.customer_name,
        email = excluded.email,
        phone = excluded.phone,
        normalized_email = excluded.normalized_email,
        normalized_phone = excluded.normalized_phone,
        raw_source = excluded.raw_source,
        normalized_channel = excluded.normalized_channel,
        deal_name = excluded.deal_name,
        deal_stage = excluded.deal_stage,
        deal_amount_cents = excluded.deal_amount_cents,
        last_change = excluded.last_change,
        deal_age = excluded.deal_age,
        salesperson = excluded.salesperson,
        captured_at = excluded.captured_at,
        source_sha256 = excluded.source_sha256,
        combined_source_sha256 = excluded.combined_source_sha256,
        source_row_number = excluded.source_row_number,
        first_seen_at = least(public.dripjobs_sales_deals.first_seen_at, excluded.first_seen_at),
        last_seen_at = excluded.last_seen_at,
        stage_entered_at = excluded.stage_entered_at,
        stage_observed_at = excluded.stage_observed_at,
        last_active_snapshot_at = case
          when excluded.source_view = 'active' then excluded.last_active_snapshot_at
          else public.dripjobs_sales_deals.last_active_snapshot_at
        end,
        archived_at = excluded.archived_at,
        metadata = public.dripjobs_sales_deals.metadata || excluded.metadata,
        updated_at = now();
    end loop;

    update public.dripjobs_pipeline_sync_runs
    set
      status = 'succeeded',
      inserted_deals = v_inserted,
      changed_stages = v_changed,
      archived_deals = v_archived,
      reactivated_deals = v_reactivated,
      source_document_ids = array[v_active_document_id, v_archived_document_id],
      finished_at = now(),
      updated_at = now()
    where id = v_run_id;

    return jsonb_build_object(
      'status', 'succeeded',
      'runId', v_run_id,
      'runKey', v_effective_run_key,
      'capturedAt', p_captured_at,
      'activeRows', v_active_count,
      'archivedRows', v_archived_count,
      'insertedDeals', v_inserted,
      'changedStages', v_changed,
      'archivedDeals', v_archived,
      'reactivatedDeals', v_reactivated,
      'sourceDocumentIds', jsonb_build_array(v_active_document_id, v_archived_document_id),
      'snapshotSha256', v_snapshot_sha256
    );
  exception when others then
    update public.dripjobs_pipeline_sync_runs
    set
      status = 'failed',
      last_error = left(sqlerrm, 2000),
      finished_at = now(),
      updated_at = now()
    where id = v_run_id;
    return jsonb_build_object(
      'status', 'failed',
      'runId', v_run_id,
      'runKey', v_effective_run_key,
      'errorCode', sqlstate
    );
  end;
end;
$$;

revoke all on function public.reconcile_dripjobs_pipeline(jsonb, jsonb, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_dripjobs_pipeline(jsonb, jsonb, timestamptz, text, text)
  to service_role;

comment on function public.reconcile_dripjobs_pipeline(jsonb, jsonb, timestamptz, text, text) is
  'Validates and atomically reconciles one daily active/archived DripJobs Sales List capture.';

-- Preserve the current single-view RPC as a compatibility wrapper.
create or replace function public.ingest_current_dripjobs_pipeline(
  p_rows jsonb,
  p_captured_at timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  return public.reconcile_dripjobs_pipeline(
    p_rows,
    '[]'::jsonb,
    p_captured_at,
    'legacy-active:' || to_char(p_captured_at at time zone 'UTC', 'YYYYMMDDTHH24MISSMS') || ':' ||
      left(encode(digest(p_rows::text, 'sha256'), 'hex'), 16),
    'ottawa-painters'
  );
end;
$$;

revoke all on function public.ingest_current_dripjobs_pipeline(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_current_dripjobs_pipeline(jsonb, timestamptz)
  to service_role;

create or replace function public.list_current_dripjobs_pipeline(
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with latest_success as (
    select run.captured_at, run.finished_at
    from public.dripjobs_pipeline_sync_runs run
    where run.workspace_key = p_workspace_key
      and run.status = 'succeeded'
    order by run.captured_at desc, run.finished_at desc nulls last
    limit 1
  ),
  legacy_snapshot as (
    select deal.source_document_id, max(deal.captured_at) as captured_at
    from public.dripjobs_sales_deals deal
    where deal.source_view = 'active'
    group by deal.source_document_id
    order by max(deal.captured_at) desc, deal.source_document_id desc
    limit 1
  ),
  current_deals as (
    select deal.*
    from public.dripjobs_sales_deals deal
    where deal.archived_at is null
      and (
        deal.last_active_snapshot_at = (select captured_at from latest_success)
        or (
          not exists (select 1 from latest_success)
          and deal.source_document_id = (select source_document_id from legacy_snapshot)
        )
      )
  ),
  person_matches as (
    select distinct deal.deal_id, person.id as person_id
    from current_deals deal
    join public.people person
      on person.workspace_key = p_workspace_key
     and person.status = 'active'
     and (
       (
         deal.normalized_email is not null
         and deal.normalized_email <> ''
         and lower(btrim(coalesce(person.primary_email, ''))) = deal.normalized_email
       )
       or (
         deal.normalized_phone is not null
         and deal.normalized_phone <> ''
         and regexp_replace(coalesce(person.primary_phone, ''), '[^0-9]', '', 'g') = deal.normalized_phone
       )
       or exists (
         select 1
         from public.person_identifiers identifier
         where identifier.person_id = person.id
           and identifier.active
           and (
             (identifier.kind = 'email' and identifier.normalized_value = deal.normalized_email)
             or (
               identifier.kind = 'phone'
               and regexp_replace(identifier.normalized_value, '[^0-9]', '', 'g') = deal.normalized_phone
             )
           )
       )
     )
  ),
  resolved_people as (
    select
      match.deal_id,
      case when count(*) = 1 then (array_agg(match.person_id))[1] end as person_id,
      count(*)::integer as match_count
    from person_matches match
    group by match.deal_id
  ),
  sync_state as (
    select
      success.captured_at,
      success.finished_at,
      case
        when success.finished_at is null then 'missing'
        when success.finished_at < now() - interval '72 hours' then 'unhealthy'
        when success.finished_at < now() - interval '36 hours' then 'stale'
        else 'healthy'
      end as status
    from latest_success success
  )
  select jsonb_build_object(
    'count', (select count(*) from current_deals),
    'capturedAt', coalesce(
      (select captured_at from latest_success),
      (select captured_at from legacy_snapshot)
    ),
    'sync', jsonb_build_object(
      'cadence', 'daily',
      'lastSucceededAt', (select finished_at from sync_state),
      'status', coalesce((select status from sync_state), 'missing'),
      'stale', coalesce((select status in ('stale', 'unhealthy') from sync_state), true),
      'unhealthy', coalesce((select status = 'unhealthy' from sync_state), false)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', deal.deal_id,
        'dripjobsContactId', deal.dripjobs_contact_id,
        'personId', resolved.person_id,
        'personMatchCount', coalesce(resolved.match_count, 0),
        'customerName', deal.customer_name,
        'email', deal.email,
        'phone', deal.phone,
        'dealName', deal.deal_name,
        'stage', deal.deal_stage,
        'stageEnteredAt', deal.stage_entered_at,
        'stageObservedAt', deal.stage_observed_at,
        'status', deal.sales_status,
        'label', deal.label,
        'source', deal.raw_source,
        'amountCents', deal.deal_amount_cents,
        'lastChange', deal.last_change,
        'dealAge', deal.deal_age,
        'salesperson', deal.salesperson,
        'capturedAt', deal.captured_at
      ) order by deal.source_row_number, deal.deal_id)
      from current_deals deal
      left join resolved_people resolved using (deal_id)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_current_dripjobs_pipeline(text)
  from public, anon, authenticated;
grant execute on function public.list_current_dripjobs_pipeline(text)
  to service_role;

create or replace function public.list_dripjobs_pipeline_history(
  p_workspace_key text,
  p_deal_id text,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with recent as (
    select event.*
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key
      and event.deal_id = p_deal_id
    order by event.effective_at desc, event.id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ),
  ordered as (
    select
      recent.*,
      lead(recent.effective_at) over (order by recent.effective_at, recent.id) as next_effective_at
    from recent
  )
  select jsonb_build_object(
    'dealId', p_deal_id,
    'currentStage', (select deal_stage from public.dripjobs_sales_deals where deal_id = p_deal_id),
    'stageEnteredAt', (select stage_entered_at from public.dripjobs_sales_deals where deal_id = p_deal_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', event.id,
        'eventKind', event.event_kind,
        'fromStage', event.from_stage,
        'toStage', event.to_stage,
        'effectiveAt', event.effective_at,
        'observedAt', event.observed_at,
        'source', event.source,
        'durationSeconds', case
          when event.to_stage is null then null
          else extract(epoch from (coalesce(event.next_effective_at, now()) - event.effective_at))::bigint
        end,
        'baseline', event.event_kind = 'baseline'
      ) order by event.effective_at, event.id)
      from ordered event
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_dripjobs_pipeline_history(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_dripjobs_pipeline_history(text, text, integer)
  to service_role;

comment on function public.list_dripjobs_pipeline_history(text, text, integer) is
  'Returns append-only DripJobs stage progress for one exact deal ID.';
