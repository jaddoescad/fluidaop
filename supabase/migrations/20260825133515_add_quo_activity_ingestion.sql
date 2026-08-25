alter table public.activities
  drop constraint activities_external_identity_key,
  drop constraint activities_source_check,
  drop constraint activities_event_type_check,
  drop constraint activities_account_email_lowercase_check;

alter table public.activities
  alter column account_email drop not null,
  add column account_phone text,
  add column account_key text generated always as (coalesce(account_email, account_phone)) stored,
  add column actor_phone text,
  add column from_phone text,
  add column to_phones text[] not null default '{}',
  add column call_status text,
  add column duration_seconds integer;

alter table public.activities
  add constraint activities_source_check
    check (source in ('gmail', 'quo')),
  add constraint activities_event_type_check
    check (event_type in (
      'email.received',
      'email.sent',
      'message.received',
      'message.sent',
      'call.completed'
    )),
  add constraint activities_account_identity_check
    check (
      (source = 'gmail' and account_email is not null and account_phone is null)
      or
      (source = 'quo' and account_phone is not null and account_email is null)
    ),
  add constraint activities_account_email_lowercase_check
    check (account_email is null or account_email = lower(account_email)),
  add constraint activities_account_phone_check
    check (account_phone is null or account_phone ~ '^\+[1-9][0-9]{6,14}$'),
  add constraint activities_duration_seconds_check
    check (duration_seconds is null or duration_seconds >= 0),
  add constraint activities_external_identity_key
    unique (source, account_key, external_id);

create index activities_source_account_occurred_idx
  on public.activities (source, account_key, occurred_at desc, id desc);

create index activities_source_conversation_occurred_idx
  on public.activities (source, account_key, external_thread_id, occurred_at desc, id desc)
  where external_thread_id is not null;

comment on column public.activities.account_key is
  'Generated provider account identity: Gmail address or Quo E.164 business number.';
comment on column public.activities.account_phone is
  'The connected Quo business number in E.164 format; null for email sources.';
comment on column public.activities.actor_phone is
  'The external participant phone number used to match a Fluid contact.';
comment on column public.activities.duration_seconds is
  'Completed call duration reported by Quo; null for non-call events.';

create table public.quo_webhook_events (
  event_id text primary key,
  event_type text not null,
  api_version text,
  payload jsonb not null,
  processing_status text not null default 'received',
  attempts integer not null default 1,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  constraint quo_webhook_events_event_id_check check (event_id ~ '^EV[A-Za-z0-9_-]+$'),
  constraint quo_webhook_events_status_check
    check (processing_status in ('received', 'processed', 'ignored', 'failed')),
  constraint quo_webhook_events_attempts_check check (attempts > 0)
);

comment on table public.quo_webhook_events is
  'Server-only idempotency and audit log for signed Quo webhook deliveries.';

create index quo_webhook_events_received_idx
  on public.quo_webhook_events (received_at desc);

create table public.quo_import_runs (
  id uuid primary key,
  connection_id text not null,
  import_kind text not null,
  filename text not null,
  status text not null default 'running',
  rows_seen integer not null default 0,
  rows_imported integer not null default 0,
  rows_skipped integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  constraint quo_import_runs_kind_check
    check (import_kind in ('contacts', 'messages', 'calls')),
  constraint quo_import_runs_status_check
    check (status in ('running', 'succeeded', 'failed')),
  constraint quo_import_runs_count_check
    check (rows_seen >= 0 and rows_imported >= 0 and rows_skipped >= 0)
);

comment on table public.quo_import_runs is
  'Server-only results for owner-requested Quo CSV backfills. CSV contents are not retained here.';

create index quo_import_runs_started_idx
  on public.quo_import_runs (started_at desc);

alter table public.quo_webhook_events enable row level security;
alter table public.quo_import_runs enable row level security;

revoke all on table public.quo_webhook_events from public, anon, authenticated;
revoke all on table public.quo_import_runs from public, anon, authenticated;

grant all on table public.quo_webhook_events to service_role;
grant all on table public.quo_import_runs to service_role;
