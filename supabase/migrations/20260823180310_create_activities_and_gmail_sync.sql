create table public.activities (
  id bigint generated always as identity primary key,
  source text not null,
  account_email text not null,
  external_id text not null,
  external_thread_id text,
  event_type text not null,
  direction text not null,
  actor_name text,
  actor_email text,
  from_email text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  subject text not null default '(no subject)',
  preview text not null default '',
  body_text text,
  occurred_at timestamptz not null,
  is_unread boolean not null default false,
  has_attachments boolean not null default false,
  attachment_count integer not null default 0,
  needs_attention boolean not null default false,
  contact_id uuid references public.contacts(id) on delete set null,
  source_labels text[] not null default '{}',
  source_metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activities_source_check check (source in ('gmail')),
  constraint activities_account_email_lowercase_check check (account_email = lower(account_email)),
  constraint activities_event_type_check check (event_type in ('email.received', 'email.sent')),
  constraint activities_direction_check check (direction in ('inbound', 'outbound')),
  constraint activities_attachment_count_check check (attachment_count >= 0),
  constraint activities_external_identity_key unique (source, account_email, external_id)
);

comment on table public.activities is
  'Normalized external-service events shown in Fluid Activity. Gmail message bodies are plain text only; remote HTML is never rendered.';
comment on column public.activities.external_id is
  'The immutable provider message identifier used to make imports idempotent.';
comment on column public.activities.needs_attention is
  'True only when this is the latest inbound message in its imported Gmail thread.';

create index activities_account_occurred_idx
  on public.activities (account_email, occurred_at desc, id desc);

create index activities_account_direction_occurred_idx
  on public.activities (account_email, direction, occurred_at desc, id desc);

create index activities_contact_occurred_idx
  on public.activities (contact_id, occurred_at desc, id desc)
  where contact_id is not null;

create index activities_needs_attention_idx
  on public.activities (account_email, occurred_at desc, id desc)
  where needs_attention = true;

create table public.gmail_sync_state (
  connection_id text primary key,
  account_email text not null unique,
  last_history_id text,
  last_sync_status text not null default 'idle',
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_full_sync_at timestamptz,
  messages_seen integer not null default 0,
  messages_upserted integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint gmail_sync_state_email_lowercase_check check (account_email = lower(account_email)),
  constraint gmail_sync_state_status_check check (last_sync_status in ('idle', 'running', 'succeeded', 'failed')),
  constraint gmail_sync_state_messages_seen_check check (messages_seen >= 0),
  constraint gmail_sync_state_messages_upserted_check check (messages_upserted >= 0)
);

comment on table public.gmail_sync_state is
  'Server-only Gmail cursor and import telemetry. OAuth refresh tokens are not stored here.';

alter table public.activities enable row level security;
alter table public.gmail_sync_state enable row level security;

create policy activities_manager_read
  on public.activities
  for select
  to authenticated
  using ((select private.is_manager()));

revoke all on table public.activities from anon, authenticated;
revoke all on table public.gmail_sync_state from anon, authenticated;
revoke all on sequence public.activities_id_seq from anon, authenticated;

grant select on table public.activities to authenticated;
grant all on table public.activities to service_role;
grant all on table public.gmail_sync_state to service_role;
grant usage, select on sequence public.activities_id_seq to service_role;
