-- Provider-neutral signal identity, deterministic Contact resolution, and
-- the durable Hermes signal-triage queue. This migration is additive: the
-- existing People records and email-categorizer audit history are preserved.

alter table public.activities
  add column workspace_key text not null default 'ottawa-painters',
  add column triage_revision integer not null default 1;

alter table public.activities
  add constraint activities_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  add constraint activities_triage_revision_check
    check (triage_revision > 0);

alter table public.people
  add column workspace_key text not null default 'ottawa-painters',
  add column entity_type text not null default 'person';

alter table public.people
  add constraint people_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  add constraint people_entity_type_check
    check (entity_type in ('person', 'business'));

create index activities_workspace_occurred_id_idx
  on public.activities (workspace_key, occurred_at desc, id desc);
create index people_workspace_status_created_idx
  on public.people (workspace_key, status, created_at desc, id desc);

alter table public.labels add column workspace_key text not null default 'ottawa-painters';
alter table public.labels alter column account_email drop not null;
alter table public.labels drop constraint labels_kind_check;
alter table public.labels drop constraint labels_account_key_key;
drop index public.labels_account_name_key;

update public.labels set kind = 'topic' where kind = 'email';

alter table public.labels
  add constraint labels_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  add constraint labels_kind_check check (kind in ('urgency', 'topic')),
  add constraint labels_workspace_kind_key_key unique (workspace_key, kind, key);

create unique index labels_workspace_kind_name_key
  on public.labels (workspace_key, kind, lower(name));
create index labels_workspace_kind_enabled_sort_idx
  on public.labels (workspace_key, kind, enabled, sort_order, id);

alter table public.agent_jobs
  add column workspace_key text not null default 'ottawa-painters',
  add column input_revision integer not null default 1,
  add column priority smallint not null default 50,
  add column queue_source text not null default 'live';

alter table public.agent_jobs drop constraint agent_jobs_agent_activity_key;
alter table public.agent_jobs
  add constraint agent_jobs_workspace_key_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  add constraint agent_jobs_input_revision_check check (input_revision > 0),
  add constraint agent_jobs_priority_check check (priority between 0 and 100),
  add constraint agent_jobs_queue_source_check check (queue_source in ('live', 'backfill', 'reconcile', 'transcript')),
  add constraint agent_jobs_agent_activity_revision_key unique (agent_key, activity_id, input_revision);

drop index public.agent_jobs_ready_idx;
create index agent_jobs_ready_idx
  on public.agent_jobs (agent_key, priority desc, available_at, id)
  where status = 'pending';

alter table public.agent_runs add column input_revision integer not null default 1;
alter table public.agent_runs
  add constraint agent_runs_input_revision_check check (input_revision > 0);

alter table public.signal_labels add column label_kind text;
update public.signal_labels signal_label
set label_kind = label.kind
from public.labels label
where label.id = signal_label.label_id;
alter table public.signal_labels alter column label_kind set not null;
alter table public.signal_labels
  drop constraint signal_labels_activity_agent_key,
  add constraint signal_labels_label_kind_check check (label_kind in ('topic', 'urgency')),
  add constraint signal_labels_activity_agent_kind_key unique (activity_id, agent_key, label_kind);

create table public.contact_role_definitions (
  workspace_key text not null,
  key text not null,
  name text not null,
  description text not null default '',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_key, key),
  constraint contact_role_definitions_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint contact_role_definitions_key_check
    check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint contact_role_definitions_name_check
    check (char_length(btrim(name)) between 1 and 80),
  constraint contact_role_definitions_description_check
    check (char_length(description) <= 500)
);

insert into public.contact_role_definitions (workspace_key, key, name, description, sort_order)
values
  ('ottawa-painters', 'lead', 'Lead', 'A prospective customer or opportunity.', 10),
  ('ottawa-painters', 'customer', 'Customer', 'A current or past customer.', 20),
  ('ottawa-painters', 'applicant', 'Applicant', 'A job applicant or candidate.', 30),
  ('ottawa-painters', 'contractor', 'Contractor', 'A subcontractor or independent trade partner.', 40),
  ('ottawa-painters', 'supplier', 'Supplier', 'A vendor or material supplier.', 50),
  ('ottawa-painters', 'employee', 'Employee', 'A member of the internal team.', 60),
  ('ottawa-painters', 'painter', 'Painter', 'A painter in the workforce directory.', 70),
  ('ottawa-painters', 'other', 'Other', 'A legitimate business contact that does not fit another role.', 100)
on conflict (workspace_key, key) do update
set name = excluded.name,
    description = excluded.description,
    sort_order = excluded.sort_order,
    updated_at = now();

alter table public.person_roles drop constraint person_roles_role_key_check;
alter table public.person_roles
  add constraint person_roles_role_key_check
    check (role_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

alter table public.activity_people drop constraint activity_people_matched_by_check;
alter table public.activity_people
  add constraint activity_people_matched_by_check
    check (matched_by in ('contact_id', 'exact_email', 'exact_phone', 'exact_identity', 'provider_id', 'manual'));

create table public.identities (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  kind text not null,
  normalized_value text not null,
  display_value text not null,
  display_name text,
  classification text not null default 'unknown',
  ignored boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint identities_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint identities_kind_check check (kind in ('email', 'phone', 'provider')),
  constraint identities_value_check check (char_length(normalized_value) between 3 and 500),
  constraint identities_display_value_check check (char_length(display_value) between 1 and 500),
  constraint identities_display_name_check check (display_name is null or char_length(display_name) <= 300),
  constraint identities_classification_check check (classification in ('unknown', 'person', 'business', 'system')),
  constraint identities_workspace_kind_value_key unique (workspace_key, kind, normalized_value)
);

comment on table public.identities is
  'Hidden, workspace-scoped exact identifiers. Names are display evidence and never matching keys.';

create index identities_workspace_last_seen_idx
  on public.identities (workspace_key, last_seen_at desc, id desc);
create index identities_unresolved_idx
  on public.identities (workspace_key, last_seen_at desc, id desc)
  where not ignored;

create table public.activity_identities (
  activity_id bigint not null references public.activities(id) on delete cascade,
  identity_id uuid not null references public.identities(id) on delete cascade,
  relationship text not null default 'actor',
  source_system text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (activity_id, identity_id, relationship),
  constraint activity_identities_relationship_check check (relationship in ('actor', 'provider'))
);

create index activity_identities_identity_activity_idx
  on public.activity_identities (identity_id, activity_id desc);

create table public.person_identity_claims (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  person_id uuid not null references public.people(id) on delete cascade,
  identity_id uuid not null references public.identities(id) on delete cascade,
  source_system text not null,
  source_record_type text not null,
  source_record_id text not null,
  confidence numeric(5,4) not null default 1,
  is_primary boolean not null default false,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint person_identity_claims_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint person_identity_claims_confidence_check check (confidence between 0 and 1),
  constraint person_identity_claims_evidence_key unique (
    person_id, identity_id, source_system, source_record_type, source_record_id
  )
);

comment on table public.person_identity_claims is
  'Evidence-backed claims from exact identities to canonical Contacts. Shared claims remain conflicts.';

create index person_identity_claims_identity_active_idx
  on public.person_identity_claims (identity_id, person_id)
  where active;
create index person_identity_claims_person_active_idx
  on public.person_identity_claims (person_id, identity_id)
  where active;

create table public.identity_provider_evidence (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  identity_id uuid not null references public.identities(id) on delete cascade,
  provider text not null,
  provider_id text not null,
  display_name text,
  metadata jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint identity_provider_evidence_name_check check (display_name is null or char_length(display_name) <= 300),
  constraint identity_provider_evidence_metadata_check check (pg_column_size(metadata) <= 524288),
  constraint identity_provider_evidence_provider_key unique (workspace_key, provider, provider_id, identity_id)
);

create index identity_provider_evidence_identity_idx
  on public.identity_provider_evidence (identity_id, provider);

create table public.contact_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  identity_id uuid not null references public.identities(id) on delete cascade,
  activity_id bigint references public.activities(id) on delete set null,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  suggestion_type text not null,
  status text not null default 'pending',
  proposed_entity_type text,
  proposed_role_key text,
  proposed_display_name text,
  confidence numeric(5,4),
  reason text not null default '',
  evidence jsonb not null default '{}',
  source_revision integer not null default 1,
  resolved_action text,
  resolved_person_id uuid references public.people(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_suggestions_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint contact_suggestions_type_check check (suggestion_type in ('create', 'link', 'ignore', 'conflict')),
  constraint contact_suggestions_status_check check (status in ('pending', 'resolved', 'dismissed')),
  constraint contact_suggestions_entity_type_check
    check (proposed_entity_type is null or proposed_entity_type in ('person', 'business')),
  constraint contact_suggestions_role_key_check
    check (proposed_role_key is null or proposed_role_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint contact_suggestions_name_check
    check (proposed_display_name is null or char_length(proposed_display_name) <= 300),
  constraint contact_suggestions_confidence_check check (confidence is null or confidence between 0 and 1),
  constraint contact_suggestions_reason_check check (char_length(reason) <= 2000),
  constraint contact_suggestions_evidence_check check (pg_column_size(evidence) <= 2097152),
  constraint contact_suggestions_source_revision_check check (source_revision > 0),
  constraint contact_suggestions_resolved_action_check
    check (resolved_action is null or resolved_action in ('create', 'link', 'ignore'))
);

create unique index contact_suggestions_one_pending_identity_idx
  on public.contact_suggestions (workspace_key, identity_id)
  where status = 'pending';
create index contact_suggestions_pending_cursor_idx
  on public.contact_suggestions (workspace_key, created_at desc, id desc)
  where status = 'pending';
create index contact_suggestions_activity_idx
  on public.contact_suggestions (activity_id)
  where activity_id is not null;
create index contact_suggestions_agent_run_idx
  on public.contact_suggestions (agent_run_id)
  where agent_run_id is not null;
create index contact_suggestions_resolved_person_idx
  on public.contact_suggestions (resolved_person_id)
  where resolved_person_id is not null;

create table public.activity_call_transcripts (
  activity_id bigint primary key references public.activities(id) on delete cascade,
  workspace_key text not null,
  provider text not null default 'quo',
  provider_call_id text not null,
  provider_transcript_id text,
  status text not null,
  dialogue jsonb not null default '[]',
  transcript_text text,
  unavailable_reason text,
  transcript_created_at timestamptz,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_call_transcripts_status_check
    check (status in ('pending', 'available', 'unavailable', 'failed')),
  constraint activity_call_transcripts_dialogue_check
    check (jsonb_typeof(dialogue) = 'array' and jsonb_array_length(dialogue) <= 500 and pg_column_size(dialogue) <= 2097152),
  constraint activity_call_transcripts_text_check
    check (transcript_text is null or char_length(transcript_text) <= 200000),
  constraint activity_call_transcripts_reason_check
    check (unavailable_reason is null or char_length(unavailable_reason) <= 1000),
  constraint activity_call_transcripts_provider_key unique (workspace_key, provider, provider_call_id)
);

create index activity_call_transcripts_status_idx
  on public.activity_call_transcripts (workspace_key, status, updated_at, activity_id);

create table public.signal_triage_settings (
  workspace_key text primary key,
  auto_create_enabled boolean not null default false,
  auto_create_threshold numeric(5,4) not null default 0.95,
  suggestion_threshold numeric(5,4) not null default 0.70,
  shadow_decision_limit integer not null default 100,
  decisions_seen integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signal_triage_settings_thresholds_check check (
    suggestion_threshold between 0 and 1
    and auto_create_threshold between suggestion_threshold and 1
  ),
  constraint signal_triage_settings_shadow_check check (shadow_decision_limit >= 0 and decisions_seen >= 0)
);

insert into public.signal_triage_settings (workspace_key)
values ('ottawa-painters')
on conflict (workspace_key) do nothing;

create table public.signal_triage_decisions (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  activity_id bigint not null references public.activities(id) on delete cascade,
  input_revision integer not null,
  agent_run_id uuid not null references public.agent_runs(id) on delete cascade,
  contact_disposition text not null,
  proposed_entity_type text,
  proposed_role_key text,
  proposed_display_name text,
  confidence numeric(5,4) not null,
  reason text not null,
  evidence jsonb not null default '{}',
  outcome text not null,
  person_id uuid references public.people(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint signal_triage_decisions_revision_check check (input_revision > 0),
  constraint signal_triage_decisions_disposition_check
    check (contact_disposition in ('existing', 'create', 'suggest', 'ignore', 'conflict')),
  constraint signal_triage_decisions_entity_type_check
    check (proposed_entity_type is null or proposed_entity_type in ('person', 'business')),
  constraint signal_triage_decisions_role_key_check
    check (proposed_role_key is null or proposed_role_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint signal_triage_decisions_confidence_check check (confidence between 0 and 1),
  constraint signal_triage_decisions_reason_check check (char_length(reason) <= 2000),
  constraint signal_triage_decisions_evidence_check check (pg_column_size(evidence) <= 2097152),
  constraint signal_triage_decisions_outcome_check
    check (outcome in ('existing', 'created', 'suggested', 'ignored', 'conflict', 'below-threshold')),
  constraint signal_triage_decisions_activity_revision_key unique (activity_id, input_revision)
);

create index signal_triage_decisions_person_idx
  on public.signal_triage_decisions (person_id, created_at desc)
  where person_id is not null;
create index signal_triage_decisions_run_idx
  on public.signal_triage_decisions (agent_run_id);

create table public.signal_reconciliation_runs (
  id bigint generated always as identity primary key,
  workspace_key text not null,
  status text not null,
  counts jsonb not null default '{}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint signal_reconciliation_runs_status_check check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint signal_reconciliation_runs_error_check check (error is null or char_length(error) <= 2000)
);

create index signal_reconciliation_runs_recent_idx
  on public.signal_reconciliation_runs (workspace_key, started_at desc, id desc);

create view public.contact_activity_stats
with (security_invoker = true)
as
select person.workspace_key, link.person_id,
  count(*)::bigint as linked_signal_count,
  max(activity.occurred_at) as last_signal_at
from public.activity_people link
join public.people person on person.id = link.person_id
join public.activities activity on activity.id = link.activity_id
where link.relationship = 'counterparty'
group by person.workspace_key, link.person_id;

create or replace function private.fluid_normalize_email(value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when lower(btrim(value)) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      then lower(btrim(value))
    else null
  end;
$$;

create or replace function private.fluid_normalize_phone(value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  digits text := regexp_replace(value, '[^0-9]', '', 'g');
begin
  if char_length(digits) = 10 then
    return '+1' || digits;
  end if;
  if char_length(digits) = 11 and left(digits, 1) = '1' then
    return '+' || digits;
  end if;
  if char_length(digits) between 8 and 15 then
    return '+' || digits;
  end if;
  return null;
end;
$$;

create or replace function private.fluid_email_is_system(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(lower(value) ~ '(^|[._+-])(no-?reply|donotreply|mailer-daemon|notifications?|alerts?|automated)([._+@-]|$)', false);
$$;

create or replace function private.upsert_activity_identity(
  p_activity_id bigint,
  p_workspace_key text,
  p_kind text,
  p_value text,
  p_display_name text,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_normalized text;
  v_identity_id uuid;
begin
  v_normalized := case p_kind
    when 'email' then private.fluid_normalize_email(p_value)
    when 'phone' then private.fluid_normalize_phone(p_value)
    else nullif(btrim(p_value), '')
  end;
  if v_normalized is null then return null; end if;

  insert into public.identities (
    workspace_key, kind, normalized_value, display_value, display_name,
    classification, first_seen_at, last_seen_at, updated_at
  ) values (
    p_workspace_key, p_kind, v_normalized, left(btrim(p_value), 500),
    nullif(left(btrim(coalesce(p_display_name, '')), 300), ''),
    case when p_kind = 'email' and private.fluid_email_is_system(v_normalized) then 'system' else 'unknown' end,
    p_occurred_at, p_occurred_at, now()
  )
  on conflict (workspace_key, kind, normalized_value) do update
  set display_value = excluded.display_value,
      display_name = coalesce(public.identities.display_name, excluded.display_name),
      classification = case
        when public.identities.classification = 'unknown' and excluded.classification = 'system' then 'system'
        else public.identities.classification
      end,
      first_seen_at = least(public.identities.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.identities.last_seen_at, excluded.last_seen_at),
      updated_at = now()
  returning id into v_identity_id;

  insert into public.activity_identities (activity_id, identity_id, relationship, source_system, updated_at)
  values (p_activity_id, v_identity_id, 'actor', 'activity', now())
  on conflict (activity_id, identity_id, relationship) do update
  set updated_at = excluded.updated_at;

  return v_identity_id;
end;
$$;

create or replace function private.resolve_activity_identity(p_activity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_identity_id uuid;
  v_direct_person_id uuid;
  v_resolved_person_id uuid;
  v_claimed_people integer := 0;
  v_identity_count integer := 0;
  v_conflict_identity uuid;
begin
  select * into v_activity from public.activities where id = p_activity_id for update;
  if not found then return jsonb_build_object('activityId', p_activity_id, 'status', 'missing'); end if;

  delete from public.activity_identities ai
  where ai.activity_id = v_activity.id
    and ai.relationship = 'actor'
    and not (
      (exists (select 1 where ai.identity_id = (
        select i.id from public.identities i
        where i.workspace_key = v_activity.workspace_key and i.kind = 'email'
          and i.normalized_value = private.fluid_normalize_email(v_activity.actor_email)
      )))
      or
      (exists (select 1 where ai.identity_id = (
        select i.id from public.identities i
        where i.workspace_key = v_activity.workspace_key and i.kind = 'phone'
          and i.normalized_value = private.fluid_normalize_phone(v_activity.actor_phone)
      )))
    );

  if private.fluid_normalize_email(v_activity.actor_email) is not null then
    v_identity_id := private.upsert_activity_identity(
      v_activity.id, v_activity.workspace_key, 'email', v_activity.actor_email,
      v_activity.actor_name, v_activity.occurred_at
    );
  end if;
  if private.fluid_normalize_phone(v_activity.actor_phone) is not null then
    v_identity_id := private.upsert_activity_identity(
      v_activity.id, v_activity.workspace_key, 'phone', v_activity.actor_phone,
      v_activity.actor_name, v_activity.occurred_at
    );
  end if;

  select source.person_id into v_direct_person_id
  from public.person_sources source
  where source.source_system = 'ottawa-painters-admin'
    and source.source_record_type = 'contact'
    and source.source_record_id = v_activity.contact_id::text
  limit 1;

  if v_direct_person_id is not null then
    delete from public.activity_people
    where activity_id = v_activity.id
      and relationship = 'counterparty'
      and person_id <> v_direct_person_id;

    insert into public.person_identity_claims (
      workspace_key, person_id, identity_id, source_system, source_record_type,
      source_record_id, confidence, is_primary, active, last_seen_at, updated_at
    )
    select v_activity.workspace_key, v_direct_person_id, ai.identity_id,
      'activity-contact', 'contact', v_activity.contact_id::text, 1, false, true,
      v_activity.occurred_at, now()
    from public.activity_identities ai
    where ai.activity_id = v_activity.id and ai.relationship = 'actor'
    on conflict (person_id, identity_id, source_system, source_record_type, source_record_id)
    do update set active = true, confidence = 1,
      last_seen_at = greatest(public.person_identity_claims.last_seen_at, excluded.last_seen_at),
      updated_at = now();

    insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence, updated_at)
    values (v_activity.id, v_direct_person_id, 'counterparty', 'contact_id', 1, now())
    on conflict (activity_id, person_id, relationship) do update
    set matched_by = 'contact_id', confidence = 1, updated_at = now();

    update public.contact_suggestions suggestion
    set status = 'dismissed', resolved_person_id = v_direct_person_id,
        resolved_at = now(), updated_at = now()
    where suggestion.status = 'pending'
      and suggestion.identity_id in (
        select ai.identity_id from public.activity_identities ai
        where ai.activity_id = v_activity.id and ai.relationship = 'actor'
      );

    return jsonb_build_object('activityId', v_activity.id, 'status', 'resolved', 'personId', v_direct_person_id, 'matchedBy', 'contact_id');
  end if;

  with claimed as (
    select distinct claim.person_id
    from public.activity_identities ai
    join public.identities identity on identity.id = ai.identity_id
    join public.person_identity_claims claim on claim.identity_id = ai.identity_id and claim.active
    join public.people person on person.id = claim.person_id and person.status = 'active'
    where ai.activity_id = v_activity.id and ai.relationship in ('actor', 'provider')
      and not identity.ignored and identity.classification <> 'system'
  )
  select count(*), min(person_id::text)::uuid
  into v_claimed_people, v_resolved_person_id
  from claimed;

  select count(*) into v_identity_count
  from public.activity_identities
  where activity_id = v_activity.id and relationship = 'actor';

  if v_claimed_people = 1 then
    delete from public.activity_people
    where activity_id = v_activity.id and relationship = 'counterparty' and person_id <> v_resolved_person_id;

    insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence, updated_at)
    values (v_activity.id, v_resolved_person_id, 'counterparty', 'exact_identity', 1, now())
    on conflict (activity_id, person_id, relationship) do update
    set matched_by = 'exact_identity', confidence = 1, updated_at = now();

    update public.contact_suggestions suggestion
    set status = 'dismissed', resolved_person_id = v_resolved_person_id,
        resolved_at = now(), updated_at = now()
    where suggestion.status = 'pending'
      and suggestion.identity_id in (
        select ai.identity_id from public.activity_identities ai
        where ai.activity_id = v_activity.id and ai.relationship = 'actor'
      );

    return jsonb_build_object('activityId', v_activity.id, 'status', 'resolved', 'personId', v_resolved_person_id, 'matchedBy', 'exact_identity');
  end if;

  if v_claimed_people > 1 then
    delete from public.activity_people where activity_id = v_activity.id and relationship = 'counterparty';
    for v_conflict_identity in
      select ai.identity_id from public.activity_identities ai
      where ai.activity_id = v_activity.id and ai.relationship = 'actor'
    loop
      insert into public.contact_suggestions (
        workspace_key, identity_id, activity_id, suggestion_type, confidence,
        reason, evidence, source_revision, updated_at
      ) values (
        v_activity.workspace_key, v_conflict_identity, v_activity.id, 'conflict', 1,
        'This exact identifier is actively claimed by more than one Contact. Fluid will not guess.',
        jsonb_build_object('activityId', v_activity.id, 'claimedPeople', v_claimed_people),
        v_activity.triage_revision, now()
      )
      on conflict (workspace_key, identity_id) where status = 'pending'
      do update set
        suggestion_type = 'conflict',
        activity_id = excluded.activity_id,
        confidence = 1,
        reason = excluded.reason,
        evidence = excluded.evidence,
        source_revision = greatest(public.contact_suggestions.source_revision, excluded.source_revision),
        updated_at = now();
    end loop;
    return jsonb_build_object('activityId', v_activity.id, 'status', 'conflict', 'claimedPeople', v_claimed_people);
  end if;

  return jsonb_build_object('activityId', v_activity.id, 'status', case when v_identity_count > 0 then 'unmatched' else 'no-identity' end);
end;
$$;

create or replace function private.bump_activity_triage_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(
    new.actor_name, new.actor_email, new.actor_phone, new.body_text, new.preview,
    new.subject, new.call_status, new.duration_seconds, new.has_attachments,
    new.attachment_count, new.contact_id, new.source_metadata
  ) is distinct from row(
    old.actor_name, old.actor_email, old.actor_phone, old.body_text, old.preview,
    old.subject, old.call_status, old.duration_seconds, old.has_attachments,
    old.attachment_count, old.contact_id, old.source_metadata
  ) then
    new.triage_revision := old.triage_revision + 1;
  end if;
  return new;
end;
$$;

create or replace function private.resolve_and_enqueue_signal_triage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material_change boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_material_change := row(
      new.actor_name, new.actor_email, new.actor_phone, new.body_text, new.preview,
      new.subject, new.call_status, new.duration_seconds, new.has_attachments,
      new.attachment_count, new.contact_id, new.source_metadata
    ) is distinct from row(
      old.actor_name, old.actor_email, old.actor_phone, old.body_text, old.preview,
      old.subject, old.call_status, old.duration_seconds, old.has_attachments,
      old.attachment_count, old.contact_id, old.source_metadata
    );
  end if;
  if not v_material_change then return new; end if;

  perform private.resolve_activity_identity(new.id);
  if new.source in ('gmail', 'quo') and new.event_type in (
    'email.received', 'email.sent', 'message.received', 'message.sent', 'call.completed'
  ) then
    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    ) values (
      new.workspace_key, 'signal-triage', new.id, new.triage_revision, 100,
      case when new.event_type = 'call.completed' and new.source_metadata ? 'transcriptId' then 'transcript' else 'live' end
    )
    on conflict (agent_key, activity_id, input_revision) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_enqueue_email_categorizer on public.activities;
drop trigger if exists activities_bump_signal_triage_revision on public.activities;
create trigger activities_bump_signal_triage_revision
before update of actor_name, actor_email, actor_phone, body_text, preview, subject,
  call_status, duration_seconds, has_attachments, attachment_count, contact_id, source_metadata
on public.activities
for each row execute function private.bump_activity_triage_revision();

drop trigger if exists activities_resolve_and_enqueue_signal_triage on public.activities;
create trigger activities_resolve_and_enqueue_signal_triage
after insert or update of actor_name, actor_email, actor_phone, body_text, preview, subject,
  call_status, duration_seconds, has_attachments, attachment_count, contact_id, source_metadata
on public.activities
for each row execute function private.resolve_and_enqueue_signal_triage();

create or replace function public.enforce_email_categorizer_label_kind()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_kind text;
begin
  select label.kind into v_kind from public.labels label where label.id = new.label_id;
  if v_kind is null or v_kind <> new.label_kind then
    raise exception 'signal label kind must match the referenced label';
  end if;
  if new.agent_key in ('email-categorizer', 'signal-triage') and v_kind not in ('topic', 'urgency') then
    raise exception 'signal classification agents can only assign topic or urgency labels';
  end if;
  return new;
end;
$$;

-- The historical identity/contact backfill is intentionally applied in the
-- following migration so the additive schema rollout stays bounded.
-- Server-only access. Browser clients use validated application APIs.
alter table public.contact_role_definitions enable row level security;
alter table public.identities enable row level security;
alter table public.activity_identities enable row level security;
alter table public.person_identity_claims enable row level security;
alter table public.identity_provider_evidence enable row level security;
alter table public.contact_suggestions enable row level security;
alter table public.activity_call_transcripts enable row level security;
alter table public.signal_triage_settings enable row level security;
alter table public.signal_triage_decisions enable row level security;
alter table public.signal_reconciliation_runs enable row level security;

revoke all on table public.contact_role_definitions, public.identities,
  public.activity_identities, public.person_identity_claims,
  public.identity_provider_evidence, public.contact_suggestions,
  public.activity_call_transcripts, public.signal_triage_settings,
  public.signal_triage_decisions, public.signal_reconciliation_runs
from public, anon, authenticated;

revoke all on table public.contact_activity_stats from public, anon, authenticated;

grant all on table public.contact_role_definitions, public.identities,
  public.activity_identities, public.person_identity_claims,
  public.identity_provider_evidence, public.contact_suggestions,
  public.activity_call_transcripts, public.signal_triage_settings,
  public.signal_triage_decisions, public.signal_reconciliation_runs
to service_role;

grant select on table public.contact_activity_stats to service_role;

grant usage, select on sequence public.person_identity_claims_id_seq,
  public.identity_provider_evidence_id_seq, public.signal_triage_decisions_id_seq,
  public.signal_reconciliation_runs_id_seq to service_role;

revoke all on function private.fluid_normalize_email(text) from public, anon, authenticated;
revoke all on function private.fluid_normalize_phone(text) from public, anon, authenticated;
revoke all on function private.fluid_email_is_system(text) from public, anon, authenticated;
revoke all on function private.upsert_activity_identity(bigint, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.resolve_activity_identity(bigint) from public, anon, authenticated;
revoke all on function private.bump_activity_triage_revision() from public, anon, authenticated;
revoke all on function private.resolve_and_enqueue_signal_triage() from public, anon, authenticated;

grant execute on function private.fluid_normalize_email(text) to service_role;
grant execute on function private.fluid_normalize_phone(text) to service_role;
grant execute on function private.resolve_activity_identity(bigint) to service_role;

create or replace function public.claim_signal_triage_job(
  p_worker text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_signal jsonb;
  v_topic_labels jsonb;
  v_urgency_labels jsonb;
  v_roles jsonb;
  v_identities jsonb;
  v_contact jsonb;
  v_transcript jsonb;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then
    raise exception 'worker must be between 1 and 100 characters';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception 'lease seconds must be between 60 and 3600';
  end if;

  update public.agent_jobs job
  set status = 'succeeded',
      finished_at = v_now,
      last_error = 'Superseded by a newer signal revision.',
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = v_now
  from public.activities activity
  where job.agent_key = 'signal-triage'
    and job.activity_id = activity.id
    and job.status in ('pending', 'leased')
    and job.input_revision < activity.triage_revision;

  update public.agent_jobs
  set status = 'pending',
      available_at = v_now,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = v_now
  where agent_key = 'signal-triage'
    and status = 'leased'
    and leased_until < v_now;

  select job.* into v_job
  from public.agent_jobs job
  where job.agent_key = 'signal-triage'
    and job.status = 'pending'
    and job.available_at <= v_now
  order by job.priority desc, job.available_at, job.id
  for update skip locked
  limit 1;

  if not found then return jsonb_build_object('job', null); end if;

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
  from public.activities activity
  where activity.id = v_job.activity_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', label.key, 'name', label.name, 'description', label.description,
      'color', label.color
    ) order by label.sort_order, label.id), '[]'::jsonb)
  into v_topic_labels
  from public.labels label
  where label.workspace_key = v_job.workspace_key and label.kind = 'topic' and label.enabled;

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', label.key, 'name', label.name, 'description', label.description,
      'color', label.color
    ) order by label.sort_order, label.id), '[]'::jsonb)
  into v_urgency_labels
  from public.labels label
  where label.workspace_key = v_job.workspace_key and label.kind = 'urgency' and label.enabled;

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', role.key, 'name', role.name, 'description', role.description
    ) order by role.sort_order, role.key), '[]'::jsonb)
  into v_roles
  from public.contact_role_definitions role
  where role.workspace_key = v_job.workspace_key and role.enabled;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', identity.id,
      'kind', identity.kind,
      'value', identity.display_value,
      'normalizedValue', identity.normalized_value,
      'displayName', identity.display_name,
      'classification', identity.classification,
      'ignored', identity.ignored,
      'activeClaimCount', (
        select count(distinct claim.person_id)
        from public.person_identity_claims claim
        where claim.identity_id = identity.id and claim.active
      )
    ) order by case identity.kind when 'email' then 1 when 'phone' then 2 else 3 end), '[]'::jsonb)
  into v_identities
  from public.activity_identities ai
  join public.identities identity on identity.id = ai.identity_id
  where ai.activity_id = v_job.activity_id and ai.relationship in ('actor', 'provider');

  select jsonb_build_object(
      'id', person.id,
      'displayName', person.display_name,
      'primaryEmail', person.primary_email,
      'primaryPhone', person.primary_phone,
      'entityType', person.entity_type,
      'matchedBy', link.matched_by
    )
  into v_contact
  from public.activity_people link
  join public.people person on person.id = link.person_id
  where link.activity_id = v_job.activity_id
    and link.relationship = 'counterparty'
    and person.status = 'active'
  order by case link.matched_by when 'contact_id' then 1 when 'provider_id' then 2 when 'manual' then 3 else 4 end,
    link.confidence desc
  limit 1;

  select jsonb_build_object(
      'status', transcript.status,
      'dialogue', transcript.dialogue,
      'text', transcript.transcript_text,
      'unavailableReason', transcript.unavailable_reason
    )
  into v_transcript
  from public.activity_call_transcripts transcript
  where transcript.activity_id = v_job.activity_id;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'agentKey', v_job.agent_key,
      'activityId', v_job.activity_id,
      'inputRevision', v_job.input_revision,
      'priority', v_job.priority,
      'attempt', v_job.attempts,
      'leaseToken', v_job.lease_token,
      'leasedUntil', v_job.leased_until
    ),
    'signal', v_signal,
    'topicLabels', v_topic_labels,
    'urgencyLabels', v_urgency_labels,
    'roleDefinitions', v_roles,
    'identities', v_identities,
    'contact', v_contact,
    'transcript', v_transcript
  );
end;
$$;

create or replace function private.upsert_contact_suggestion(
  p_workspace_key text,
  p_identity_id uuid,
  p_activity_id bigint,
  p_agent_run_id uuid,
  p_suggestion_type text,
  p_entity_type text,
  p_role_key text,
  p_display_name text,
  p_confidence numeric,
  p_reason text,
  p_evidence jsonb,
  p_source_revision integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.contact_suggestions (
    workspace_key, identity_id, activity_id, agent_run_id, suggestion_type,
    proposed_entity_type, proposed_role_key, proposed_display_name, confidence,
    reason, evidence, source_revision, updated_at
  ) values (
    p_workspace_key, p_identity_id, p_activity_id, p_agent_run_id, p_suggestion_type,
    p_entity_type, p_role_key, nullif(left(btrim(coalesce(p_display_name, '')), 300), ''),
    p_confidence, left(coalesce(p_reason, ''), 2000), coalesce(p_evidence, '{}'::jsonb),
    p_source_revision, now()
  )
  on conflict (workspace_key, identity_id) where status = 'pending'
  do update set
    activity_id = excluded.activity_id,
    agent_run_id = excluded.agent_run_id,
    suggestion_type = case
      when public.contact_suggestions.suggestion_type = 'conflict' then 'conflict'
      else excluded.suggestion_type
    end,
    proposed_entity_type = excluded.proposed_entity_type,
    proposed_role_key = excluded.proposed_role_key,
    proposed_display_name = excluded.proposed_display_name,
    confidence = excluded.confidence,
    reason = case
      when public.contact_suggestions.suggestion_type = 'conflict' then public.contact_suggestions.reason
      else excluded.reason
    end,
    evidence = case
      when public.contact_suggestions.suggestion_type = 'conflict' then public.contact_suggestions.evidence
      else excluded.evidence
    end,
    source_revision = greatest(public.contact_suggestions.source_revision, excluded.source_revision),
    updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.apply_signal_triage_contact_decision(
  p_activity_id bigint,
  p_agent_run_id uuid,
  p_input_revision integer,
  p_contact_disposition text,
  p_entity_type text,
  p_role_key text,
  p_display_name text,
  p_confidence numeric,
  p_reason text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_settings public.signal_triage_settings%rowtype;
  v_identity_id uuid;
  v_identity_ids uuid[];
  v_claimed_people integer := 0;
  v_person_id uuid;
  v_existing_person_id uuid;
  v_any_system boolean := false;
  v_suggestion_id uuid;
  v_outcome text := 'below-threshold';
  v_name text;
begin
  select * into v_activity from public.activities where id = p_activity_id for update;
  if not found then raise exception 'activity does not exist'; end if;

  select coalesce(array_agg(identity.id order by case identity.kind when 'email' then 1 else 2 end), array[]::uuid[]),
    bool_or(identity.classification = 'system' or identity.ignored)
  into v_identity_ids, v_any_system
  from public.activity_identities ai
  join public.identities identity on identity.id = ai.identity_id
  where ai.activity_id = p_activity_id and ai.relationship = 'actor'
    and identity.kind in ('email', 'phone');
  v_any_system := coalesce(v_any_system, false);
  v_identity_id := v_identity_ids[1];

  select link.person_id into v_existing_person_id
  from public.activity_people link
  join public.people person on person.id = link.person_id and person.status = 'active'
  where link.activity_id = p_activity_id and link.relationship = 'counterparty'
  order by link.confidence desc limit 1;

  insert into public.signal_triage_settings (workspace_key)
  values (v_activity.workspace_key)
  on conflict (workspace_key) do nothing;
  select * into v_settings
  from public.signal_triage_settings
  where workspace_key = v_activity.workspace_key
  for update;

  if v_existing_person_id is not null then
    return jsonb_build_object('outcome', 'existing', 'personId', v_existing_person_id);
  end if;

  if v_identity_id is null then
    return jsonb_build_object('outcome', 'below-threshold', 'reason', 'No stable email or phone identity was available.');
  end if;

  if v_any_system then
    update public.identities
    set classification = 'system', updated_at = now()
    where id = any(v_identity_ids) and classification = 'system';
    return jsonb_build_object('outcome', 'ignored', 'reason', 'Automated sender identities remain hidden.');
  end if;

  perform pg_advisory_xact_lock(hashtext('fluid:identity:' || v_identity_id::text));

  select count(*), min(claim.person_id::text)::uuid
  into v_claimed_people, v_person_id
  from (
    select distinct claim.person_id
    from public.person_identity_claims claim
    join public.identities identity on identity.id = claim.identity_id
      and not identity.ignored and identity.classification <> 'system'
    join public.people person on person.id = claim.person_id and person.status = 'active'
    where claim.identity_id = any(v_identity_ids) and claim.active
  ) claim;

  if v_claimed_people = 1 then
    insert into public.person_identity_claims (
      workspace_key, person_id, identity_id, source_system, source_record_type,
      source_record_id, confidence, active, last_seen_at
    )
    select v_activity.workspace_key, v_person_id, identity_id,
      'signal-triage', 'activity', p_activity_id::text, 1, true, v_activity.occurred_at
    from unnest(v_identity_ids) identity_id
    on conflict (person_id, identity_id, source_system, source_record_type, source_record_id)
    do update set active = true, confidence = 1, last_seen_at = excluded.last_seen_at, updated_at = now();

    perform private.resolve_activity_identity(p_activity_id);
    return jsonb_build_object('outcome', 'existing', 'personId', v_person_id);
  end if;

  if v_claimed_people > 1 or p_contact_disposition = 'conflict' then
    v_suggestion_id := private.upsert_contact_suggestion(
      v_activity.workspace_key, v_identity_id, p_activity_id, p_agent_run_id,
      'conflict', p_entity_type, p_role_key, p_display_name, p_confidence,
      case when v_claimed_people > 1
        then 'The exact identity is claimed by multiple Contacts. Fluid did not guess.'
        else p_reason end,
      coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('claimedPeople', v_claimed_people), p_input_revision
    );
    return jsonb_build_object('outcome', 'conflict', 'suggestionId', v_suggestion_id);
  end if;

  if p_contact_disposition = 'create' and p_confidence >= v_settings.auto_create_threshold then
    update public.signal_triage_settings
    set decisions_seen = decisions_seen + 1, updated_at = now()
    where workspace_key = v_activity.workspace_key
    returning decisions_seen into v_settings.decisions_seen;
  end if;

  if p_contact_disposition = 'create'
     and p_confidence >= v_settings.auto_create_threshold
     and v_settings.auto_create_enabled
     and v_settings.decisions_seen >= v_settings.shadow_decision_limit
     and not v_any_system then
    v_name := nullif(left(btrim(coalesce(p_display_name, '')), 300), '');
    if v_name is null then
      select coalesce(identity.display_name,
        case when identity.kind = 'email' then split_part(identity.display_value, '@', 1) else identity.display_value end)
      into v_name
      from public.identities identity where identity.id = v_identity_id;
    end if;

    insert into public.people (
      workspace_key, display_name, entity_type, primary_email, primary_phone, status
    )
    select v_activity.workspace_key, coalesce(nullif(v_name, ''), 'New contact'),
      coalesce(p_entity_type, 'person'),
      max(identity.display_value) filter (where identity.kind = 'email'),
      max(identity.display_value) filter (where identity.kind = 'phone'),
      'active'
    from public.identities identity
    where identity.id = any(v_identity_ids)
    returning id into v_person_id;

    insert into public.person_identity_claims (
      workspace_key, person_id, identity_id, source_system, source_record_type,
      source_record_id, confidence, is_primary, active, last_seen_at
    )
    select v_activity.workspace_key, v_person_id, identity.id,
      'signal-triage', 'activity', p_activity_id::text, p_confidence, true, true,
      v_activity.occurred_at
    from public.identities identity where identity.id = any(v_identity_ids)
    on conflict (person_id, identity_id, source_system, source_record_type, source_record_id)
    do update set active = true, confidence = excluded.confidence, updated_at = now();

    if p_role_key is not null then
      insert into public.person_roles (
        person_id, role_key, source_system, source_record_type, source_record_id, active, last_seen_at
      ) values (
        v_person_id, p_role_key, 'signal-triage', 'activity', p_activity_id::text, true, now()
      ) on conflict (person_id, role_key, source_system, source_record_type, source_record_id)
      do update set active = true, last_seen_at = now();
    end if;

    insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
    select distinct ai.activity_id, v_person_id, 'counterparty', 'exact_identity', 1
    from public.activity_identities ai
    where ai.identity_id = any(v_identity_ids)
    on conflict (activity_id, person_id, relationship) do update
    set matched_by = 'exact_identity', confidence = 1, updated_at = now();

    update public.identities set classification = coalesce(p_entity_type, 'person'), updated_at = now()
    where id = any(v_identity_ids) and classification = 'unknown';

    return jsonb_build_object('outcome', 'created', 'personId', v_person_id);
  end if;

  if p_confidence >= v_settings.suggestion_threshold then
    v_suggestion_id := private.upsert_contact_suggestion(
      v_activity.workspace_key, v_identity_id, p_activity_id, p_agent_run_id,
      case p_contact_disposition when 'ignore' then 'ignore' when 'existing' then 'link' else 'create' end,
      p_entity_type, p_role_key, p_display_name, p_confidence, p_reason,
      coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object(
        'shadowMode', not v_settings.auto_create_enabled or v_settings.decisions_seen < v_settings.shadow_decision_limit,
        'requestedDisposition', p_contact_disposition
      ), p_input_revision
    );
    v_outcome := case when p_contact_disposition = 'ignore' then 'ignored' else 'suggested' end;
    return jsonb_build_object('outcome', v_outcome, 'suggestionId', v_suggestion_id);
  end if;

  return jsonb_build_object('outcome', 'below-threshold');
end;
$$;

create or replace function public.complete_signal_triage_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_topic_label_key text,
  p_urgency_label_key text,
  p_contact_disposition text,
  p_entity_type text,
  p_role_key text,
  p_display_name text,
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
  v_topic_label public.labels%rowtype;
  v_urgency_label public.labels%rowtype;
  v_run_id uuid;
  v_contact_result jsonb;
  v_attachment jsonb;
  v_attachment_key text;
  v_text text;
  v_status text;
  v_size bigint;
  v_ordinal bigint;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_lease_token is null then raise exception 'job id and lease token are required'; end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then raise exception 'confidence must be between 0 and 1'; end if;
  if p_contact_disposition not in ('existing', 'create', 'suggest', 'ignore', 'conflict') then raise exception 'invalid contact disposition'; end if;
  if p_entity_type is not null and p_entity_type not in ('person', 'business') then raise exception 'invalid entity type'; end if;
  if p_role_key is not null and not exists (
    select 1 from public.contact_role_definitions role
    where role.workspace_key = (select workspace_key from public.agent_jobs where id = p_job_id)
      and role.key = p_role_key and role.enabled
  ) then raise exception 'role is not enabled'; end if;
  if p_reason is null or char_length(p_reason) > 2000 then raise exception 'reason must be at most 2000 characters'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object' or pg_column_size(coalesce(p_evidence, '{}'::jsonb)) > 2097152 then raise exception 'invalid evidence'; end if;
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 20 then raise exception 'invalid attachments'; end if;

  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'signal-triage' or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token then
    raise exception 'job lease is no longer valid';
  end if;

  select * into v_topic_label from public.labels
  where workspace_key = v_job.workspace_key and kind = 'topic' and key = p_topic_label_key and enabled;
  if not found then raise exception 'topic label is not enabled'; end if;
  select * into v_urgency_label from public.labels
  where workspace_key = v_job.workspace_key and kind = 'urgency' and key = p_urgency_label_key and enabled;
  if not found then raise exception 'urgency label is not enabled'; end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model, prompt_version,
    evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision, 'completed',
    nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    p_evidence, coalesce(v_job.claimed_at, v_now), v_now
  ) returning id into v_run_id;

  insert into public.signal_labels (
    activity_id, label_id, label_kind, agent_key, agent_run_id, assigned_by,
    confidence, reason, evidence, updated_at
  ) values
    (v_job.activity_id, v_topic_label.id, 'topic', v_job.agent_key, v_run_id, 'agent', p_confidence, p_reason, p_evidence, v_now),
    (v_job.activity_id, v_urgency_label.id, 'urgency', v_job.agent_key, v_run_id, 'agent', p_confidence, p_reason, p_evidence, v_now)
  on conflict (activity_id, agent_key, label_kind) do update
  set label_id = excluded.label_id, agent_run_id = excluded.agent_run_id,
      assigned_by = excluded.assigned_by, confidence = excluded.confidence,
      reason = excluded.reason, evidence = excluded.evidence, updated_at = excluded.updated_at;

  v_contact_result := private.apply_signal_triage_contact_decision(
    v_job.activity_id, v_run_id, v_job.input_revision, p_contact_disposition,
    p_entity_type, p_role_key, p_display_name, p_confidence, p_reason, p_evidence
  );

  insert into public.signal_triage_decisions (
    workspace_key, activity_id, input_revision, agent_run_id, contact_disposition,
    proposed_entity_type, proposed_role_key, proposed_display_name, confidence,
    reason, evidence, outcome, person_id
  ) values (
    v_job.workspace_key, v_job.activity_id, v_job.input_revision, v_run_id,
    p_contact_disposition, p_entity_type, p_role_key,
    nullif(left(btrim(coalesce(p_display_name, '')), 300), ''), p_confidence,
    p_reason, p_evidence, v_contact_result ->> 'outcome',
    nullif(v_contact_result ->> 'personId', '')::uuid
  )
  on conflict (activity_id, input_revision) do update
  set agent_run_id = excluded.agent_run_id,
      contact_disposition = excluded.contact_disposition,
      proposed_entity_type = excluded.proposed_entity_type,
      proposed_role_key = excluded.proposed_role_key,
      proposed_display_name = excluded.proposed_display_name,
      confidence = excluded.confidence,
      reason = excluded.reason,
      evidence = excluded.evidence,
      outcome = excluded.outcome,
      person_id = excluded.person_id;

  for v_attachment, v_ordinal in
    select item.value, item.ordinality
    from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) with ordinality item(value, ordinality)
  loop
    if jsonb_typeof(v_attachment) <> 'object' then continue; end if;
    v_attachment_key := left(coalesce(
      nullif(btrim(v_attachment ->> 'attachmentKey'), ''),
      nullif(btrim(v_attachment ->> 'partId'), ''),
      nullif(btrim(v_attachment ->> 'filename'), ''), v_ordinal::text
    ), 500);
    v_text := nullif(left(coalesce(v_attachment ->> 'extractedText', ''), 100000), '');
    v_status := coalesce(nullif(v_attachment ->> 'status', ''), case when v_text is null then 'metadata' else 'extracted' end);
    if v_status not in ('metadata', 'extracted', 'no_text', 'unsupported', 'failed') then
      v_status := case when v_text is null then 'metadata' else 'extracted' end;
    end if;
    v_size := case when coalesce(v_attachment ->> 'sizeBytes', '') ~ '^[0-9]{1,18}$'
      then (v_attachment ->> 'sizeBytes')::bigint else null end;

    insert into public.signal_attachment_evidence (
      activity_id, agent_key, agent_run_id, attachment_key, filename, mime_type,
      size_bytes, extraction_status, extraction_method, extracted_text, metadata, updated_at
    ) values (
      v_job.activity_id, v_job.agent_key, v_run_id, v_attachment_key,
      nullif(left(coalesce(v_attachment ->> 'filename', ''), 500), ''),
      nullif(left(coalesce(v_attachment ->> 'mimeType', ''), 200), ''),
      v_size, v_status,
      nullif(left(coalesce(v_attachment ->> 'extractionMethod', ''), 100), ''),
      v_text,
      case when jsonb_typeof(v_attachment -> 'metadata') = 'object' and pg_column_size(v_attachment -> 'metadata') <= 524288
        then v_attachment -> 'metadata' else '{}'::jsonb end,
      v_now
    ) on conflict (activity_id, agent_key, attachment_key) do update
    set agent_run_id = excluded.agent_run_id, filename = excluded.filename,
      mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
      extraction_status = excluded.extraction_status,
      extraction_method = excluded.extraction_method,
      extracted_text = excluded.extracted_text, metadata = excluded.metadata,
      updated_at = excluded.updated_at;
  end loop;

  update public.agent_jobs
  set status = 'succeeded', lease_owner = null, lease_token = null,
      leased_until = null, last_error = null, finished_at = v_now, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id, 'activityId', v_job.activity_id, 'inputRevision', v_job.input_revision,
    'runId', v_run_id,
    'topic', jsonb_build_object('key', v_topic_label.key, 'name', v_topic_label.name),
    'urgency', jsonb_build_object('key', v_urgency_label.key, 'name', v_urgency_label.name),
    'contact', v_contact_result
  );
end;
$$;

create or replace function public.fail_signal_triage_job(
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
  if p_error is null or char_length(btrim(p_error)) not between 1 and 2000 then raise exception 'invalid error'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'signal-triage' or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token then
    raise exception 'job lease is no longer valid';
  end if;

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model, prompt_version,
    error, evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision, 'failed',
    nullif(btrim(coalesce(p_model, '')), ''), btrim(p_prompt_version),
    left(btrim(p_error), 2000), '{}'::jsonb, coalesce(v_job.claimed_at, v_now), v_now
  );

  v_terminal := v_job.attempts >= 5;
  update public.agent_jobs
  set status = case when v_terminal then 'failed' else 'pending' end,
      available_at = case when v_terminal then available_at
        else v_now + make_interval(secs => least(3600, 30 * (2 ^ greatest(attempts - 1, 0))::integer)) end,
      lease_owner = null, lease_token = null, leased_until = null,
      last_error = left(btrim(p_error), 2000),
      finished_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object('jobId', v_job.id, 'activityId', v_job.activity_id,
    'inputRevision', v_job.input_revision,
    'status', case when v_terminal then 'failed' else 'pending' end,
    'attempt', v_job.attempts);
end;
$$;

create or replace function public.resolve_contact_suggestion(
  p_suggestion_id uuid,
  p_action text,
  p_contact_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_suggestion public.contact_suggestions%rowtype;
  v_identity public.identities%rowtype;
  v_person_id uuid;
  v_name text;
  v_linked integer := 0;
begin
  if p_action not in ('create', 'link', 'ignore') then raise exception 'invalid action'; end if;
  select * into v_suggestion from public.contact_suggestions
  where id = p_suggestion_id for update;
  if not found or v_suggestion.status <> 'pending' then raise exception 'suggestion is no longer pending'; end if;
  select * into v_identity from public.identities where id = v_suggestion.identity_id for update;

  if p_action = 'ignore' then
    update public.identities
    set ignored = true,
        classification = case when classification = 'unknown' then 'system' else classification end,
        updated_at = now()
    where id = v_identity.id;
    update public.contact_suggestions
    set status = 'resolved', resolved_action = 'ignore', resolved_at = now(), updated_at = now()
    where id = v_suggestion.id;
    return jsonb_build_object('suggestionId', v_suggestion.id, 'action', 'ignore', 'linkedActivities', 0);
  end if;

  if p_action = 'link' then
    if p_contact_id is null then raise exception 'contact id is required'; end if;
    select id into v_person_id from public.people
    where id = p_contact_id and workspace_key = v_suggestion.workspace_key and status = 'active'
    for update;
    if not found then raise exception 'contact was not found'; end if;
  else
    if exists (
      select 1 from public.person_identity_claims
      where identity_id = v_identity.id and active
    ) then
      raise exception 'identity already belongs to a Contact; link or resolve the conflict instead';
    end if;
    v_name := coalesce(
      nullif(btrim(v_suggestion.proposed_display_name), ''),
      nullif(btrim(v_identity.display_name), ''),
      case when v_identity.kind = 'email' then split_part(v_identity.display_value, '@', 1) else v_identity.display_value end
    );
    insert into public.people (
      workspace_key, display_name, entity_type, primary_email, primary_phone, status
    ) values (
      v_suggestion.workspace_key, coalesce(v_name, 'New contact'),
      coalesce(v_suggestion.proposed_entity_type, 'person'),
      case when v_identity.kind = 'email' then v_identity.display_value end,
      case when v_identity.kind = 'phone' then v_identity.display_value end,
      'active'
    ) returning id into v_person_id;
  end if;

  -- A manual conflict resolution makes the selected Contact authoritative for
  -- this exact identity while preserving the old claims as inactive evidence.
  update public.person_identity_claims
  set active = false, updated_at = now()
  where identity_id = v_identity.id and active and person_id <> v_person_id;

  insert into public.person_identity_claims (
    workspace_key, person_id, identity_id, source_system, source_record_type,
    source_record_id, confidence, is_primary, active, last_seen_at
  ) values (
    v_suggestion.workspace_key, v_person_id, v_identity.id, 'manual-review',
    'contact-suggestion', v_suggestion.id::text, 1, true, true, now()
  ) on conflict (person_id, identity_id, source_system, source_record_type, source_record_id)
  do update set active = true, confidence = 1, last_seen_at = now(), updated_at = now();

  if v_suggestion.proposed_role_key is not null then
    insert into public.person_roles (
      person_id, role_key, source_system, source_record_type, source_record_id, active, last_seen_at
    ) values (
      v_person_id, v_suggestion.proposed_role_key, 'manual-review',
      'contact-suggestion', v_suggestion.id::text, true, now()
    ) on conflict (person_id, role_key, source_system, source_record_type, source_record_id)
    do update set active = true, last_seen_at = now();
  end if;

  update public.people
  set primary_email = coalesce(primary_email, case when v_identity.kind = 'email' then v_identity.display_value end),
      primary_phone = coalesce(primary_phone, case when v_identity.kind = 'phone' then v_identity.display_value end),
      updated_at = now()
  where id = v_person_id;

  delete from public.activity_people link
  where link.relationship = 'counterparty'
    and link.person_id <> v_person_id
    and exists (
      select 1 from public.activity_identities ai
      where ai.activity_id = link.activity_id and ai.identity_id = v_identity.id
    );

  insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
  select ai.activity_id, v_person_id, 'counterparty', 'manual', 1
  from public.activity_identities ai where ai.identity_id = v_identity.id
  on conflict (activity_id, person_id, relationship) do update
  set matched_by = 'manual', confidence = 1, updated_at = now();
  get diagnostics v_linked = row_count;

  update public.identities set ignored = false,
    classification = coalesce(v_suggestion.proposed_entity_type, classification), updated_at = now()
  where id = v_identity.id;
  update public.contact_suggestions
  set status = 'resolved', resolved_action = p_action, resolved_person_id = v_person_id,
      resolved_at = now(), updated_at = now()
  where id = v_suggestion.id;

  return jsonb_build_object('suggestionId', v_suggestion.id, 'action', p_action,
    'contactId', v_person_id, 'linkedActivities', v_linked);
end;
$$;

create or replace function public.reconcile_signal_triage(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 500
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_run_id bigint;
  v_activity_id bigint;
  v_resolved integer := 0;
  v_requeued integer := 0;
  v_expired integer := 0;
  v_error text;
begin
  if p_limit not between 1 and 5000 then raise exception 'limit must be between 1 and 5000'; end if;
  insert into public.signal_reconciliation_runs (workspace_key, status)
  values (p_workspace_key, 'running') returning id into v_run_id;

  if not pg_try_advisory_xact_lock(hashtext('fluid:signal-reconcile:' || p_workspace_key)) then
    update public.signal_reconciliation_runs set status = 'skipped', finished_at = now()
    where id = v_run_id;
    return jsonb_build_object('status', 'skipped', 'runId', v_run_id);
  end if;

  begin
    update public.agent_jobs
    set status = 'pending', available_at = now(), lease_owner = null,
      lease_token = null, leased_until = null, updated_at = now()
    where workspace_key = p_workspace_key and agent_key = 'signal-triage'
      and status = 'leased' and leased_until < now();
    get diagnostics v_expired = row_count;

    for v_activity_id in
      select activity.id
      from public.activities activity
      left join public.activity_identities ai on ai.activity_id = activity.id and ai.relationship = 'actor'
      where activity.workspace_key = p_workspace_key
        and (private.fluid_normalize_email(activity.actor_email) is not null
          or private.fluid_normalize_phone(activity.actor_phone) is not null)
      group by activity.id
      having count(ai.identity_id) = 0
      order by activity.occurred_at desc, activity.id desc
      limit p_limit
    loop
      perform private.resolve_activity_identity(v_activity_id);
      v_resolved := v_resolved + 1;
    end loop;

    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    )
    select activity.workspace_key, 'signal-triage', activity.id,
      activity.triage_revision, 25, 'reconcile'
    from public.activities activity
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and activity.event_type in ('email.received', 'email.sent', 'message.received', 'message.sent', 'call.completed')
      and activity.occurred_at >= now() - interval '30 days'
      and not exists (
        select 1 from public.agent_jobs job
        where job.agent_key = 'signal-triage' and job.activity_id = activity.id
          and job.input_revision = activity.triage_revision
      )
    order by activity.occurred_at desc
    limit p_limit
    on conflict (agent_key, activity_id, input_revision) do nothing;
    get diagnostics v_requeued = row_count;

    update public.signal_reconciliation_runs
    set status = 'succeeded', counts = jsonb_build_object(
      'expiredLeases', v_expired, 'identitiesResolved', v_resolved, 'jobsEnqueued', v_requeued
    ), finished_at = now()
    where id = v_run_id;
    return jsonb_build_object('status', 'succeeded', 'runId', v_run_id,
      'expiredLeases', v_expired, 'identitiesResolved', v_resolved, 'jobsEnqueued', v_requeued);
  exception when others then
    get stacked diagnostics v_error = message_text;
    update public.signal_reconciliation_runs
    set status = 'failed', error = left(v_error, 2000), finished_at = now()
    where id = v_run_id;
    return jsonb_build_object('status', 'failed', 'runId', v_run_id, 'error', left(v_error, 2000));
  end;
end;
$$;

revoke all on function public.claim_signal_triage_job(text, integer) from public, anon, authenticated;
revoke all on function public.complete_signal_triage_job(bigint, uuid, text, text, text, text, text, text, numeric, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_signal_triage_job(bigint, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.resolve_contact_suggestion(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.reconcile_signal_triage(text, integer) from public, anon, authenticated;
revoke all on function private.upsert_contact_suggestion(text, uuid, bigint, uuid, text, text, text, text, numeric, text, jsonb, integer) from public, anon, authenticated;
revoke all on function private.apply_signal_triage_contact_decision(bigint, uuid, integer, text, text, text, text, numeric, text, jsonb) from public, anon, authenticated;

grant execute on function public.claim_signal_triage_job(text, integer) to service_role;
grant execute on function public.complete_signal_triage_job(bigint, uuid, text, text, text, text, text, text, numeric, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_signal_triage_job(bigint, uuid, text, text, text) to service_role;
grant execute on function public.resolve_contact_suggestion(uuid, text, uuid) to service_role;
grant execute on function public.reconcile_signal_triage(text, integer) to service_role;

comment on function public.resolve_contact_suggestion(uuid, text, uuid) is
  'Validated server-only transaction for creating, linking, or ignoring a Contact suggestion and attaching all identity history.';
