-- Quo call content is server-only evidence attached to an existing call
-- Activity. Keep retry state separate from the content so temporary Quo API
-- misses never become permanent data loss.

alter table public.activity_call_transcripts
  add column attempt_count integer not null default 0,
  add column last_attempted_at timestamptz,
  add column next_retry_at timestamptz,
  add column last_http_status integer,
  add constraint activity_call_transcripts_attempt_count_check
    check (attempt_count between 0 and 1000),
  add constraint activity_call_transcripts_http_status_check
    check (last_http_status is null or last_http_status between 100 and 599);

drop index if exists public.activity_call_transcripts_status_idx;
create index activity_call_transcripts_retry_idx
  on public.activity_call_transcripts
    (workspace_key, provider, status, next_retry_at, activity_id)
  where status in ('pending', 'failed');

-- The earlier importer treated every 400/403/404 response as final. None of
-- those rows contains content, so make them eligible for the new bounded retry
-- policy without discarding any available transcript.
update public.activity_call_transcripts
set status = 'pending',
    unavailable_reason = null,
    attempt_count = 0,
    last_attempted_at = null,
    next_retry_at = now(),
    last_http_status = null,
    updated_at = now()
where provider = 'quo'
  and status = 'unavailable'
  and transcript_text is null;

create table public.activity_call_recordings (
  activity_id bigint primary key references public.activities(id) on delete cascade,
  workspace_key text not null,
  provider text not null default 'quo',
  provider_call_id text not null,
  status text not null default 'pending',
  recordings jsonb not null default '[]'::jsonb,
  unavailable_reason text,
  recording_completed_at timestamptz,
  fetched_at timestamptz,
  attempt_count integer not null default 0,
  last_attempted_at timestamptz,
  next_retry_at timestamptz,
  last_http_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_call_recordings_status_check
    check (status in ('pending', 'available', 'unavailable', 'failed')),
  constraint activity_call_recordings_payload_check
    check (
      jsonb_typeof(recordings) = 'array'
      and jsonb_array_length(recordings) <= 100
      and pg_column_size(recordings) <= 2097152
    ),
  constraint activity_call_recordings_reason_check
    check (unavailable_reason is null or char_length(unavailable_reason) <= 1000),
  constraint activity_call_recordings_attempt_count_check
    check (attempt_count between 0 and 1000),
  constraint activity_call_recordings_http_status_check
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint activity_call_recordings_provider_key
    unique (workspace_key, provider, provider_call_id)
);

create index activity_call_recordings_retry_idx
  on public.activity_call_recordings
    (workspace_key, provider, status, next_retry_at, activity_id)
  where status in ('pending', 'failed');

create table public.activity_call_summaries (
  activity_id bigint primary key references public.activities(id) on delete cascade,
  workspace_key text not null,
  provider text not null default 'quo',
  provider_call_id text not null,
  provider_summary_id text,
  status text not null default 'pending',
  summary jsonb not null default '[]'::jsonb,
  next_steps jsonb not null default '[]'::jsonb,
  jobs jsonb not null default '[]'::jsonb,
  unavailable_reason text,
  summary_created_at timestamptz,
  fetched_at timestamptz,
  attempt_count integer not null default 0,
  last_attempted_at timestamptz,
  next_retry_at timestamptz,
  last_http_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_call_summaries_status_check
    check (status in ('pending', 'available', 'unavailable', 'failed')),
  constraint activity_call_summaries_summary_check
    check (
      jsonb_typeof(summary) = 'array'
      and jsonb_array_length(summary) <= 100
      and pg_column_size(summary) <= 1048576
    ),
  constraint activity_call_summaries_next_steps_check
    check (
      jsonb_typeof(next_steps) = 'array'
      and jsonb_array_length(next_steps) <= 100
      and pg_column_size(next_steps) <= 1048576
    ),
  constraint activity_call_summaries_jobs_check
    check (pg_column_size(jobs) <= 1048576),
  constraint activity_call_summaries_reason_check
    check (unavailable_reason is null or char_length(unavailable_reason) <= 1000),
  constraint activity_call_summaries_attempt_count_check
    check (attempt_count between 0 and 1000),
  constraint activity_call_summaries_http_status_check
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint activity_call_summaries_provider_key
    unique (workspace_key, provider, provider_call_id)
);

create index activity_call_summaries_retry_idx
  on public.activity_call_summaries
    (workspace_key, provider, status, next_retry_at, activity_id)
  where status in ('pending', 'failed');

-- These tables may contain private call audio and AI-generated content. They
-- are never browser-readable; the authenticated Fluid API returns only the
-- content attached to a validated Signal.
alter table public.activity_call_recordings enable row level security;
alter table public.activity_call_summaries enable row level security;

revoke all on table public.activity_call_recordings,
  public.activity_call_summaries
from public, anon, authenticated;

grant all on table public.activity_call_recordings,
  public.activity_call_summaries
to service_role;
