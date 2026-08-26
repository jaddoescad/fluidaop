create table public.external_references (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  provider text not null,
  reference_type text not null,
  reference_value text not null,
  entity_type text not null,
  job_id uuid references public.jobs(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_references_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint external_references_provider_check
    check (provider ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint external_references_type_check
    check (reference_type ~ '^[a-z0-9]+(?:[_-][a-z0-9]+)*$'),
  constraint external_references_value_check
    check (btrim(reference_value) <> '' and char_length(reference_value) <= 255),
  constraint external_references_entity_check
    check (
      (entity_type = 'job' and job_id is not null and lead_id is null and contact_id is null) or
      (entity_type = 'lead' and job_id is null and lead_id is not null and contact_id is null) or
      (entity_type = 'contact' and job_id is null and lead_id is null and contact_id is not null)
    ),
  constraint external_references_provider_value_key
    unique (workspace_key, provider, reference_type, reference_value)
);

create index external_references_job_idx
  on public.external_references (workspace_key, job_id, provider, reference_type)
  where job_id is not null;
create index external_references_lead_idx
  on public.external_references (workspace_key, lead_id, provider, reference_type)
  where lead_id is not null;
create index external_references_contact_idx
  on public.external_references (workspace_key, contact_id, provider, reference_type)
  where contact_id is not null;

create table public.slack_workspaces (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  connection_id text not null unique,
  team_id text not null,
  team_name text not null,
  team_domain text,
  bot_user_id text,
  granted_scopes text[] not null default '{}',
  status text not null default 'connected',
  last_event_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slack_workspaces_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint slack_workspaces_team_id_check
    check (team_id ~ '^[TE][A-Z0-9]+$'),
  constraint slack_workspaces_name_check
    check (btrim(team_name) <> '' and char_length(team_name) <= 160),
  constraint slack_workspaces_status_check
    check (status in ('connected', 'checking', 'error', 'disconnected')),
  constraint slack_workspaces_error_check
    check (last_error is null or char_length(last_error) <= 2000),
  constraint slack_workspaces_workspace_team_key unique (workspace_key, team_id)
);

create table public.slack_users (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  team_id text not null,
  provider_user_id text not null,
  display_name text,
  real_name text,
  is_bot boolean not null default false,
  is_deleted boolean not null default false,
  raw_metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slack_users_team_fkey foreign key (workspace_key, team_id)
    references public.slack_workspaces(workspace_key, team_id) on delete cascade,
  constraint slack_users_provider_id_check
    check (provider_user_id ~ '^[UWBA][A-Z0-9-]+$'),
  constraint slack_users_names_check
    check (
      (display_name is null or char_length(display_name) <= 160) and
      (real_name is null or char_length(real_name) <= 160)
    ),
  constraint slack_users_workspace_user_key unique (workspace_key, team_id, provider_user_id)
);

create table public.slack_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  team_id text not null,
  provider_channel_id text not null,
  name text not null,
  channel_kind text not null default 'other',
  selected boolean not null default false,
  job_id uuid references public.jobs(id) on delete set null,
  proposal_id text,
  is_archived boolean not null default false,
  last_message_ts text,
  sync_cursor text,
  sync_status text not null default 'idle',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slack_channels_team_fkey foreign key (workspace_key, team_id)
    references public.slack_workspaces(workspace_key, team_id) on delete cascade,
  constraint slack_channels_provider_id_check
    check (provider_channel_id ~ '^[CGD][A-Z0-9]+$'),
  constraint slack_channels_name_check
    check (btrim(name) <> '' and char_length(name) <= 160),
  constraint slack_channels_kind_check
    check (channel_kind in ('job', 'sales', 'other')),
  constraint slack_channels_proposal_id_check
    check (proposal_id is null or proposal_id ~ '^[0-9]{4,32}$'),
  constraint slack_channels_message_ts_check
    check (last_message_ts is null or last_message_ts ~ '^[0-9]+\\.[0-9]+$'),
  constraint slack_channels_sync_status_check
    check (sync_status in ('idle', 'running', 'succeeded', 'failed', 'rate_limited')),
  constraint slack_channels_error_check
    check (last_error is null or char_length(last_error) <= 2000),
  constraint slack_channels_workspace_channel_key
    unique (workspace_key, team_id, provider_channel_id)
);

create index slack_channels_selected_idx
  on public.slack_channels (workspace_key, channel_kind, updated_at desc)
  where selected and not is_archived;
create index slack_channels_job_idx
  on public.slack_channels (workspace_key, job_id)
  where job_id is not null;
create index slack_channels_sync_idx
  on public.slack_channels (workspace_key, sync_status, last_synced_at)
  where selected and not is_archived;

create table public.slack_events (
  event_id text primary key,
  workspace_key text not null default 'ottawa-painters',
  team_id text not null,
  event_type text not null,
  event_time timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',
  last_error text,
  constraint slack_events_team_fkey foreign key (workspace_key, team_id)
    references public.slack_workspaces(workspace_key, team_id) on delete cascade,
  constraint slack_events_event_id_check
    check (btrim(event_id) <> '' and char_length(event_id) <= 255),
  constraint slack_events_type_check
    check (btrim(event_type) <> '' and char_length(event_type) <= 80),
  constraint slack_events_status_check
    check (status in ('received', 'processed', 'ignored', 'failed')),
  constraint slack_events_error_check
    check (last_error is null or char_length(last_error) <= 2000)
);

create index slack_events_received_idx
  on public.slack_events (workspace_key, received_at desc);

create table public.slack_messages (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  team_id text not null,
  channel_id uuid not null references public.slack_channels(id) on delete cascade,
  provider_message_ts text not null,
  thread_ts text,
  provider_user_id text,
  subtype text,
  text_content text not null default '',
  permalink text,
  file_metadata jsonb not null default '[]',
  raw_metadata jsonb not null default '{}',
  source_event_id text,
  occurred_at timestamptz not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  is_filtered boolean not null default false,
  filter_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slack_messages_team_fkey foreign key (workspace_key, team_id)
    references public.slack_workspaces(workspace_key, team_id) on delete cascade,
  constraint slack_messages_ts_check
    check (
      provider_message_ts ~ '^[0-9]+\\.[0-9]+$' and
      (thread_ts is null or thread_ts ~ '^[0-9]+\\.[0-9]+$')
    ),
  constraint slack_messages_text_check
    check (char_length(text_content) <= 100000),
  constraint slack_messages_permalink_check
    check (permalink is null or char_length(permalink) <= 2048),
  constraint slack_messages_files_check
    check (jsonb_typeof(file_metadata) = 'array' and pg_column_size(file_metadata) <= 1048576),
  constraint slack_messages_metadata_check
    check (jsonb_typeof(raw_metadata) = 'object' and pg_column_size(raw_metadata) <= 1048576),
  constraint slack_messages_filter_reason_check
    check (filter_reason is null or char_length(filter_reason) <= 255),
  constraint slack_messages_workspace_message_key
    unique (workspace_key, team_id, channel_id, provider_message_ts)
);

create index slack_messages_channel_time_idx
  on public.slack_messages (channel_id, occurred_at desc, id desc)
  where deleted_at is null;
create index slack_messages_thread_idx
  on public.slack_messages (channel_id, thread_ts, occurred_at, id)
  where thread_ts is not null and deleted_at is null;
create index slack_messages_unfiltered_idx
  on public.slack_messages (workspace_key, occurred_at desc, id desc)
  where not is_filtered and deleted_at is null;

create table public.slack_sync_state (
  connection_id text primary key,
  workspace_key text not null default 'ottawa-painters',
  team_id text not null,
  status text not null default 'idle',
  channels_seen integer not null default 0,
  channels_selected integer not null default 0,
  messages_seen integer not null default 0,
  messages_upserted integer not null default 0,
  retry_after_seconds integer,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint slack_sync_state_team_fkey foreign key (workspace_key, team_id)
    references public.slack_workspaces(workspace_key, team_id) on delete cascade,
  constraint slack_sync_state_status_check
    check (status in ('idle', 'running', 'succeeded', 'failed', 'rate_limited')),
  constraint slack_sync_state_counts_check
    check (channels_seen >= 0 and channels_selected >= 0 and messages_seen >= 0 and messages_upserted >= 0),
  constraint slack_sync_state_retry_check
    check (retry_after_seconds is null or retry_after_seconds between 1 and 86400),
  constraint slack_sync_state_error_check
    check (last_error is null or char_length(last_error) <= 2000)
);

create table public.operational_cases (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  case_type text not null default 'job',
  job_id uuid not null references public.jobs(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'open',
  revision integer not null default 1,
  canonical_state jsonb not null default '{}',
  evidence_updated_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operational_cases_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint operational_cases_type_check check (case_type = 'job'),
  constraint operational_cases_status_check check (status in ('open', 'terminal', 'archived')),
  constraint operational_cases_revision_check check (revision > 0),
  constraint operational_cases_state_check
    check (jsonb_typeof(canonical_state) = 'object' and pg_column_size(canonical_state) <= 1048576),
  constraint operational_cases_workspace_job_key unique (workspace_key, job_id)
);

create index operational_cases_status_idx
  on public.operational_cases (workspace_key, status, updated_at desc, id)
  where status <> 'archived';
create index operational_cases_contact_idx
  on public.operational_cases (workspace_key, contact_id, status)
  where contact_id is not null and status = 'open';

create table public.case_facts (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  fact_key text not null,
  fact_value jsonb not null,
  authority_rank smallint not null,
  source_type text not null,
  source_ref text not null,
  confidence numeric(5,4) not null default 1,
  effective_at timestamptz not null,
  observed_at timestamptz not null default now(),
  is_current boolean not null default true,
  superseded_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint case_facts_key_check
    check (fact_key ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  constraint case_facts_authority_check check (authority_rank between 1 and 5),
  constraint case_facts_source_check
    check (source_type in ('manual', 'dripjobs', 'structured', 'gmail', 'quo', 'slack', 'hermes')),
  constraint case_facts_source_ref_check
    check (btrim(source_ref) <> '' and char_length(source_ref) <= 512),
  constraint case_facts_confidence_check check (confidence between 0 and 1),
  constraint case_facts_metadata_check
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 524288),
  constraint case_facts_source_observation_key
    unique (case_id, fact_key, source_type, source_ref, observed_at)
);

create index case_facts_current_idx
  on public.case_facts (case_id, fact_key, authority_rank, effective_at desc, observed_at desc, id desc)
  where is_current;
create index case_facts_source_idx
  on public.case_facts (workspace_key, source_type, source_ref);

create table public.case_evidence (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  evidence_type text not null,
  activity_id bigint references public.activities(id) on delete cascade,
  slack_message_id bigint references public.slack_messages(id) on delete cascade,
  relevance text not null default 'context',
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint case_evidence_type_check check (evidence_type in ('activity', 'slack_message')),
  constraint case_evidence_source_check
    check (
      (evidence_type = 'activity' and activity_id is not null and slack_message_id is null) or
      (evidence_type = 'slack_message' and activity_id is null and slack_message_id is not null)
    ),
  constraint case_evidence_relevance_check
    check (relevance in ('context', 'request', 'decision', 'blocker', 'schedule_change', 'scope_change', 'completion_claim'))
);

create unique index case_evidence_activity_key
  on public.case_evidence (case_id, activity_id)
  where activity_id is not null;
create unique index case_evidence_slack_key
  on public.case_evidence (case_id, slack_message_id)
  where slack_message_id is not null;
create index case_evidence_case_time_idx
  on public.case_evidence (case_id, observed_at desc, id desc);

create table public.case_assertions (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  case_revision integer not null,
  assertion_kind text not null,
  summary text not null,
  confidence numeric(5,4) not null,
  source_agent text not null default 'case-reconciler',
  evidence jsonb not null default '[]',
  created_at timestamptz not null default now(),
  constraint case_assertions_revision_check check (case_revision > 0),
  constraint case_assertions_kind_check
    check (assertion_kind in ('request', 'decision', 'commitment', 'blocker', 'schedule_change', 'scope_change', 'completion_claim')),
  constraint case_assertions_summary_check
    check (btrim(summary) <> '' and char_length(summary) <= 1000),
  constraint case_assertions_confidence_check check (confidence between 0 and 1),
  constraint case_assertions_evidence_check
    check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 20),
  constraint case_assertions_agent_check
    check (source_agent ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create index case_assertions_case_idx
  on public.case_assertions (case_id, case_revision desc, created_at desc, id desc);

create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  action_kind text not null,
  target_key text not null,
  fingerprint text not null,
  title text not null,
  reason text not null,
  status text not null default 'open',
  owner text,
  due_at timestamptz,
  confidence numeric(5,4) not null default 1,
  source_kind text not null,
  input_revision integer not null,
  prerequisites jsonb not null default '{}',
  is_shadow boolean not null default false,
  published_at timestamptz,
  completed_at timestamptz,
  dismissed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_items_action_kind_check
    check (action_kind in ('schedule_job', 'assign_project_manager', 'assign_crew', 'follow_up', 'review_scope_change', 'resolve_blocker', 'confirm_decision', 'collect_balance')),
  constraint work_items_target_key_check
    check (btrim(target_key) <> '' and char_length(target_key) <= 255),
  constraint work_items_fingerprint_check
    check (fingerprint ~ '^[a-f0-9]{64}$'),
  constraint work_items_title_check
    check (btrim(title) <> '' and char_length(title) <= 200),
  constraint work_items_reason_check
    check (btrim(reason) <> '' and char_length(reason) <= 2000),
  constraint work_items_status_check
    check (status in ('open', 'waiting', 'completed', 'dismissed', 'superseded')),
  constraint work_items_owner_check
    check (owner is null or char_length(owner) <= 160),
  constraint work_items_confidence_check check (confidence between 0 and 1),
  constraint work_items_source_check check (source_kind in ('deterministic', 'hermes', 'manual')),
  constraint work_items_revision_check check (input_revision > 0),
  constraint work_items_prerequisites_check
    check (jsonb_typeof(prerequisites) = 'object' and pg_column_size(prerequisites) <= 524288)
);

create unique index work_items_active_fingerprint_key
  on public.work_items (workspace_key, fingerprint)
  where status in ('open', 'waiting');
create index work_items_board_idx
  on public.work_items (workspace_key, status, is_shadow, updated_at desc, id)
  where status in ('open', 'waiting', 'completed');
create index work_items_case_idx
  on public.work_items (case_id, created_at desc, id desc);

create table public.work_item_evidence (
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  case_evidence_id bigint not null references public.case_evidence(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_item_id, case_evidence_id)
);
create index work_item_evidence_evidence_idx
  on public.work_item_evidence (case_evidence_id, work_item_id);

create table public.work_item_events (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  event_type text not null,
  actor_type text not null,
  actor_id text,
  note text,
  from_status text,
  to_status text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint work_item_events_type_check
    check (event_type in ('created', 'updated', 'completed', 'dismissed', 'reopened', 'superseded', 'published')),
  constraint work_item_events_actor_check
    check (actor_type in ('system', 'hermes', 'user')),
  constraint work_item_events_note_check
    check (note is null or char_length(note) <= 2000),
  constraint work_item_events_status_check
    check (
      (from_status is null or from_status in ('open', 'waiting', 'completed', 'dismissed', 'superseded')) and
      (to_status is null or to_status in ('open', 'waiting', 'completed', 'dismissed', 'superseded'))
    )
);
create index work_item_events_item_idx
  on public.work_item_events (work_item_id, created_at desc, id desc);

create table public.case_reconciliation_jobs (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  input_revision integer not null,
  status text not null default 'pending',
  priority smallint not null default 50,
  queue_source text not null default 'live',
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
  constraint case_reconciliation_jobs_revision_check check (input_revision > 0),
  constraint case_reconciliation_jobs_status_check
    check (status in ('pending', 'leased', 'succeeded', 'failed')),
  constraint case_reconciliation_jobs_priority_check check (priority between 0 and 100),
  constraint case_reconciliation_jobs_source_check
    check (queue_source in ('live', 'backfill', 'reconcile', 'manual')),
  constraint case_reconciliation_jobs_attempts_check check (attempts >= 0),
  constraint case_reconciliation_jobs_error_check
    check (last_error is null or char_length(last_error) <= 2000),
  constraint case_reconciliation_jobs_case_revision_key unique (case_id, input_revision)
);

create index case_reconciliation_jobs_claim_idx
  on public.case_reconciliation_jobs (priority desc, available_at, id)
  where status = 'pending';
create index case_reconciliation_jobs_lease_idx
  on public.case_reconciliation_jobs (leased_until, id)
  where status = 'leased';

create table public.case_reconciler_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  job_id bigint not null references public.case_reconciliation_jobs(id) on delete cascade,
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  input_revision integer not null,
  status text not null,
  model text,
  prompt_version text not null,
  error text,
  output jsonb not null default '{}',
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint case_reconciler_runs_revision_check check (input_revision > 0),
  constraint case_reconciler_runs_status_check check (status in ('completed', 'failed')),
  constraint case_reconciler_runs_error_check check (error is null or char_length(error) <= 2000),
  constraint case_reconciler_runs_output_check
    check (jsonb_typeof(output) = 'object' and pg_column_size(output) <= 2097152),
  constraint case_reconciler_runs_job_revision_key unique (job_id, input_revision)
);

create index case_reconciler_runs_case_idx
  on public.case_reconciler_runs (case_id, created_at desc);

create table public.case_reconciler_settings (
  workspace_key text primary key,
  shadow_decisions_remaining integer not null default 50,
  publication_enabled boolean not null default false,
  terminal_false_positive_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint case_reconciler_settings_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint case_reconciler_settings_counts_check
    check (shadow_decisions_remaining >= 0 and terminal_false_positive_count >= 0)
);

insert into public.case_reconciler_settings (workspace_key)
values ('ottawa-painters')
on conflict (workspace_key) do nothing;

alter table public.external_references enable row level security;
alter table public.slack_workspaces enable row level security;
alter table public.slack_users enable row level security;
alter table public.slack_channels enable row level security;
alter table public.slack_events enable row level security;
alter table public.slack_messages enable row level security;
alter table public.slack_sync_state enable row level security;
alter table public.operational_cases enable row level security;
alter table public.case_facts enable row level security;
alter table public.case_evidence enable row level security;
alter table public.case_assertions enable row level security;
alter table public.work_items enable row level security;
alter table public.work_item_evidence enable row level security;
alter table public.work_item_events enable row level security;
alter table public.case_reconciliation_jobs enable row level security;
alter table public.case_reconciler_runs enable row level security;
alter table public.case_reconciler_settings enable row level security;

create policy operational_cases_manager_read on public.operational_cases
  for select to authenticated using ((select private.is_manager()));
create policy case_facts_manager_read on public.case_facts
  for select to authenticated using ((select private.is_manager()));
create policy case_evidence_manager_read on public.case_evidence
  for select to authenticated using ((select private.is_manager()));
create policy case_assertions_manager_read on public.case_assertions
  for select to authenticated using ((select private.is_manager()));
create policy work_items_manager_read on public.work_items
  for select to authenticated using ((select private.is_manager()));
create policy work_item_evidence_manager_read on public.work_item_evidence
  for select to authenticated using ((select private.is_manager()));
create policy work_item_events_manager_read on public.work_item_events
  for select to authenticated using ((select private.is_manager()));

revoke all on table
  public.external_references, public.slack_workspaces, public.slack_users,
  public.slack_channels, public.slack_events, public.slack_messages,
  public.slack_sync_state, public.operational_cases, public.case_facts,
  public.case_evidence, public.case_assertions, public.work_items,
  public.work_item_evidence, public.work_item_events,
  public.case_reconciliation_jobs, public.case_reconciler_runs,
  public.case_reconciler_settings
from anon, authenticated;

grant select on table
  public.operational_cases, public.case_facts, public.case_evidence,
  public.case_assertions, public.work_items, public.work_item_evidence,
  public.work_item_events
to authenticated;

grant all on table
  public.external_references, public.slack_workspaces, public.slack_users,
  public.slack_channels, public.slack_events, public.slack_messages,
  public.slack_sync_state, public.operational_cases, public.case_facts,
  public.case_evidence, public.case_assertions, public.work_items,
  public.work_item_evidence, public.work_item_events,
  public.case_reconciliation_jobs, public.case_reconciler_runs,
  public.case_reconciler_settings
to service_role;

revoke all on sequence
  public.external_references_id_seq, public.slack_messages_id_seq,
  public.case_facts_id_seq, public.case_evidence_id_seq,
  public.case_assertions_id_seq, public.work_item_events_id_seq,
  public.case_reconciliation_jobs_id_seq
from anon, authenticated;

grant usage, select on sequence
  public.external_references_id_seq, public.slack_messages_id_seq,
  public.case_facts_id_seq, public.case_evidence_id_seq,
  public.case_assertions_id_seq, public.work_item_events_id_seq,
  public.case_reconciliation_jobs_id_seq
to service_role;

comment on table public.slack_messages is
  'Server-only Slack context. Internal Slack messages are linked to Jobs and are never placed in the global external Activity feed.';
comment on table public.operational_cases is
  'One canonical operational context per Job, with source-backed production, schedule, assignment, and financial state.';
comment on table public.work_items is
  'Persistent, deduplicated operational actions. Terminal structured state supersedes incompatible open work.';
