create table public.action_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  key text not null,
  name text not null,
  description text not null,
  handler_key text not null,
  enabled boolean not null default false,
  execution_mode text not null default 'simulation',
  requires_confirmation boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  built_in boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_definitions_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint action_definitions_key_check
    check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint action_definitions_handler_check
    check (handler_key in ('draft-email-reply', 'draft-sms-reply', 'create-reminder', 'create-task')),
  constraint action_definitions_name_check
    check (char_length(btrim(name)) between 1 and 100),
  constraint action_definitions_description_check
    check (char_length(btrim(description)) between 1 and 1000),
  constraint action_definitions_mode_check
    check (execution_mode = 'simulation'),
  constraint action_definitions_configuration_check
    check (jsonb_typeof(configuration) = 'object' and pg_column_size(configuration) <= 65536),
  constraint action_definitions_version_check check (version > 0),
  constraint action_definitions_workspace_key_key unique (workspace_key, key)
);

insert into public.action_definitions (
  workspace_key, key, name, description, handler_key, enabled,
  execution_mode, requires_confirmation, configuration
) values
  (
    'ottawa-painters', 'draft-email-to-customer', 'Draft email to customer',
    'Draft a reply to a current inbound Gmail message for review. Sending remains a simulation.',
    'draft-email-reply', true, 'simulation', true,
    jsonb_build_object('tone', 'clear, warm, and concise', 'signatureMode', 'none')
  ),
  (
    'ottawa-painters', 'draft-sms-reply', 'Draft SMS reply',
    'Prepare an SMS response for review. This capability is not enabled yet.',
    'draft-sms-reply', false, 'simulation', true, '{}'::jsonb
  ),
  (
    'ottawa-painters', 'create-follow-up-reminder', 'Create follow-up reminder',
    'Create a timed follow-up from a Signal. This capability is not enabled yet.',
    'create-reminder', false, 'simulation', true, '{}'::jsonb
  ),
  (
    'ottawa-painters', 'create-internal-task', 'Create internal task',
    'Create an internal task from a Signal. This capability is not enabled yet.',
    'create-task', false, 'simulation', true, '{}'::jsonb
  )
on conflict (workspace_key, key) do update
set name = excluded.name,
    description = excluded.description,
    handler_key = excluded.handler_key,
    execution_mode = excluded.execution_mode,
    requires_confirmation = excluded.requires_confirmation,
    built_in = true,
    updated_at = now();

alter table public.signal_recommendations
  add column action_definition_id uuid references public.action_definitions(id) on delete restrict,
  add column action_definition_version integer,
  add column accepted_at timestamptz;

alter table public.signal_recommendations
  drop constraint signal_recommendations_status_check,
  drop constraint signal_recommendations_lifecycle_check;

alter table public.signal_recommendations
  add constraint signal_recommendations_status_check
    check (status in ('pending', 'accepted', 'dismissed', 'superseded')),
  add constraint signal_recommendations_definition_version_check
    check (action_definition_version is null or action_definition_version > 0),
  add constraint signal_recommendations_action_definition_check
    check (
      (recommendation_kind <> 'action' and action_definition_id is null and action_definition_version is null)
      or
      (recommendation_kind = 'action' and (
        (action_definition_id is null and action_definition_version is null)
        or (action_definition_id is not null and action_definition_version is not null)
      ))
    ),
  add constraint signal_recommendations_lifecycle_check
    check (
      (status = 'pending' and accepted_at is null and dismissed_at is null and superseded_at is null)
      or (status = 'accepted' and accepted_at is not null and dismissed_at is null and superseded_at is null)
      or (status = 'dismissed' and accepted_at is null and dismissed_at is not null and superseded_at is null)
      or (status = 'superseded' and superseded_at is not null)
    );

create index signal_recommendations_definition_fk_idx
  on public.signal_recommendations (action_definition_id)
  where action_definition_id is not null;

alter table public.signal_review_states
  drop constraint signal_review_states_status_check,
  drop constraint signal_review_states_resolution_check,
  drop constraint signal_review_states_consistency_check;

alter table public.signal_review_states
  add constraint signal_review_states_status_check
    check (status in ('pending', 'action_open', 'settled')),
  add constraint signal_review_states_resolution_check
    check (resolution is null or resolution in (
      'no_action', 'none_required', 'shadow_only', 'action_created'
    )),
  add constraint signal_review_states_consistency_check
    check (
      (status = 'pending' and resolution is null and pending_recommendation_count > 0 and reviewed_at is null)
      or
      (status = 'action_open' and resolution = 'action_created' and pending_recommendation_count = 0 and reviewed_at is not null)
      or
      (status = 'settled' and resolution is not null and pending_recommendation_count = 0)
    );

create table public.action_instances (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null default 'ottawa-painters',
  action_definition_id uuid not null references public.action_definitions(id) on delete restrict,
  action_definition_version integer not null,
  recommendation_id uuid not null references public.signal_recommendations(id) on delete restrict,
  source_activity_id bigint not null references public.activities(id) on delete restrict,
  person_id uuid references public.people(id) on delete set null,
  case_id uuid references public.operational_cases(id) on delete set null,
  source_revision integer not null,
  execution_revision integer not null default 1,
  status text not null default 'drafting',
  execution_mode text not null default 'simulation',
  title text not null,
  reason text not null,
  recipient_email text not null,
  subject text not null,
  draft_body text,
  draft_revision integer not null default 0,
  last_error text,
  simulated_at timestamptz,
  completed_external_at timestamptz,
  dismissed_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_instances_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint action_instances_definition_version_check check (action_definition_version > 0),
  constraint action_instances_source_revision_check check (source_revision > 0),
  constraint action_instances_execution_revision_check check (execution_revision > 0),
  constraint action_instances_status_check check (status in (
    'drafting', 'awaiting_approval', 'simulated', 'failed', 'completed_external', 'dismissed'
  )),
  constraint action_instances_mode_check check (execution_mode = 'simulation'),
  constraint action_instances_title_check check (char_length(btrim(title)) between 1 and 160),
  constraint action_instances_reason_check check (char_length(btrim(reason)) between 1 and 2000),
  constraint action_instances_recipient_check
    check (recipient_email = lower(recipient_email) and char_length(recipient_email) between 3 and 320 and recipient_email like '%@%'),
  constraint action_instances_subject_check check (char_length(btrim(subject)) between 1 and 1000),
  constraint action_instances_draft_check check (draft_body is null or char_length(draft_body) <= 50000),
  constraint action_instances_draft_revision_check check (draft_revision >= 0),
  constraint action_instances_error_check check (last_error is null or char_length(last_error) <= 2000),
  constraint action_instances_creator_check check (char_length(btrim(created_by)) between 1 and 200),
  constraint action_instances_recommendation_key unique (recommendation_id)
);

create index action_instances_board_idx
  on public.action_instances (workspace_key, updated_at desc, id desc)
  where status not in ('completed_external', 'dismissed');
create index action_instances_source_idx
  on public.action_instances (workspace_key, source_activity_id, status, updated_at desc);
create index action_instances_person_idx
  on public.action_instances (workspace_key, person_id, updated_at desc)
  where person_id is not null;
create index action_instances_definition_fk_idx
  on public.action_instances (action_definition_id);
create index action_instances_case_fk_idx
  on public.action_instances (case_id) where case_id is not null;

create table public.action_events (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  action_instance_id uuid not null references public.action_instances(id) on delete cascade,
  event_type text not null,
  actor_type text not null,
  actor_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint action_events_type_check check (event_type in (
    'created', 'draft_started', 'draft_ready', 'draft_edited', 'simulated_sent',
    'failed', 'retried', 'dismissed', 'completed_external'
  )),
  constraint action_events_actor_type_check check (actor_type in ('system', 'hermes', 'user')),
  constraint action_events_actor_id_check check (actor_id is null or char_length(actor_id) <= 200),
  constraint action_events_metadata_check
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 262144)
);

create index action_events_instance_idx
  on public.action_events (action_instance_id, created_at desc, id desc);

create table public.action_execution_jobs (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters',
  action_instance_id uuid not null references public.action_instances(id) on delete cascade,
  input_revision integer not null,
  status text not null default 'pending',
  priority smallint not null default 100,
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
  constraint action_execution_jobs_revision_check check (input_revision > 0),
  constraint action_execution_jobs_status_check check (status in ('pending', 'leased', 'succeeded', 'failed')),
  constraint action_execution_jobs_priority_check check (priority between 0 and 1000),
  constraint action_execution_jobs_attempts_check check (attempts >= 0),
  constraint action_execution_jobs_owner_check check (lease_owner is null or char_length(lease_owner) <= 100),
  constraint action_execution_jobs_error_check check (last_error is null or char_length(last_error) <= 2000),
  constraint action_execution_jobs_instance_revision_key unique (action_instance_id, input_revision)
);

create index action_execution_jobs_ready_idx
  on public.action_execution_jobs (priority desc, available_at, id)
  where status = 'pending';
create index action_execution_jobs_lease_idx
  on public.action_execution_jobs (leased_until, id)
  where status = 'leased';

-- Generic v1 proposals are audit data only. They must never become executable Actions.
update public.signal_recommendations
set status = 'superseded', superseded_at = now(), updated_at = now()
where status = 'pending';

update public.signal_review_states
set status = 'settled', resolution = 'shadow_only', pending_recommendation_count = 0,
    reviewed_by = null, reviewed_at = coalesce(reviewed_at, now()), updated_at = now()
where status = 'pending';

update public.signal_recommender_settings
set maximum_recommendations = 1,
    shadow_signals_remaining = 25,
    publication_enabled = false,
    updated_at = now()
where workspace_key = 'ottawa-painters';

create or replace function public.complete_signal_recommender_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_model text,
  p_prompt_version text,
  p_recommendations jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, extensions, public
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_activity public.activities%rowtype;
  v_settings public.signal_recommender_settings%rowtype;
  v_definition public.action_definitions%rowtype;
  v_run_id uuid;
  v_item jsonb;
  v_label text;
  v_reason text;
  v_definition_key text;
  v_case_id uuid;
  v_confidence numeric;
  v_evidence jsonb;
  v_prerequisites jsonb;
  v_fingerprint text;
  v_recipient text;
  v_shadow boolean;
  v_inserted integer := 0;
  v_public integer := 0;
  v_now timestamptz := now();
begin
  if p_job_id is null or p_lease_token is null then raise exception 'job id and lease token are required'; end if;
  if p_prompt_version is null or p_prompt_version !~ '^signal-recommender-v2(?:[.][0-9]+)?$' then
    raise exception 'signal-recommender-v2 prompt version is required';
  end if;
  if jsonb_typeof(coalesce(p_recommendations, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_recommendations, '[]'::jsonb)) > 1
    or pg_column_size(coalesce(p_recommendations, '[]'::jsonb)) > 524288
  then raise exception 'recommendations must be an array of at most one item'; end if;

  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found or v_job.agent_key <> 'signal-recommender'
    or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token
    or v_job.leased_until < v_now
  then raise exception 'job lease is no longer valid'; end if;

  select * into v_activity from public.activities where id = v_job.activity_id for update;
  if v_activity.recommendation_revision <> v_job.input_revision then raise exception 'signal recommendation revision changed'; end if;

  if exists (
    select 1 from public.action_instances action
    where action.source_activity_id = v_activity.id
      and action.status not in ('completed_external', 'dismissed')
  ) then
    update public.agent_jobs
    set status = 'succeeded', finished_at = v_now,
        last_error = 'Signal already has an open Action.',
        lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
    where id = v_job.id;
    return jsonb_build_object(
      'jobId', v_job.id, 'activityId', v_job.activity_id,
      'recommendationsStored', 0, 'publicRecommendations', 0,
      'skipped', 'action-open'
    );
  end if;

  select * into v_settings from public.signal_recommender_settings
  where workspace_key = v_job.workspace_key for update;
  if not found then raise exception 'signal recommender settings are missing'; end if;
  v_shadow := v_settings.shadow_signals_remaining > 0 or not v_settings.publication_enabled;
  v_recipient := lower(btrim(coalesce(v_activity.actor_email, v_activity.from_email, '')));

  insert into public.agent_runs (
    agent_key, job_id, activity_id, input_revision, status, model,
    prompt_version, evidence, started_at, finished_at
  ) values (
    v_job.agent_key, v_job.id, v_job.activity_id, v_job.input_revision,
    'completed', nullif(left(btrim(coalesce(p_model, '')), 200), ''),
    btrim(p_prompt_version),
    jsonb_build_object(
      'recommendationCount', jsonb_array_length(coalesce(p_recommendations, '[]'::jsonb)),
      'maximumExecutableRecommendations', 1,
      'enabledDefinitionsOnly', true
    ),
    coalesce(v_job.claimed_at, v_now), v_now
  ) returning id into v_run_id;

  update public.signal_recommendations
  set status = 'superseded', superseded_at = v_now, updated_at = v_now
  where workspace_key = v_job.workspace_key
    and activity_id = v_job.activity_id and status = 'pending';

  for v_item in select value from jsonb_array_elements(coalesce(p_recommendations, '[]'::jsonb))
  loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'recommendation must be an object'; end if;
    v_definition_key := btrim(coalesce(v_item ->> 'actionDefinitionKey', ''));
    v_label := btrim(coalesce(v_item ->> 'buttonText', ''));
    v_reason := btrim(coalesce(v_item ->> 'reason', ''));
    v_confidence := coalesce((v_item ->> 'confidence')::numeric, -1);
    v_evidence := coalesce(v_item -> 'evidence', '[]'::jsonb);
    v_prerequisites := coalesce(v_item -> 'prerequisites', '{}'::jsonb);
    v_case_id := case
      when coalesce(v_item ->> 'caseId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (v_item ->> 'caseId')::uuid
      else null
    end;

    if char_length(v_label) not between 1 and 160 or char_length(v_reason) not between 1 and 2000 then raise exception 'invalid recommendation text'; end if;
    if v_confidence < 0 or v_confidence > 1 then raise exception 'invalid recommendation confidence'; end if;
    if jsonb_typeof(v_evidence) <> 'array' or jsonb_array_length(v_evidence) > 30 or pg_column_size(v_evidence) > 262144 then raise exception 'invalid recommendation evidence'; end if;
    if jsonb_typeof(v_prerequisites) <> 'object' or pg_column_size(v_prerequisites) > 65536 then raise exception 'invalid recommendation prerequisites'; end if;

    select * into v_definition from public.action_definitions
    where workspace_key = v_job.workspace_key and key = v_definition_key;
    if not found or not v_definition.enabled or v_definition.handler_key <> 'draft-email-reply' then
      raise exception 'recommendation references an unavailable Action definition';
    end if;

    -- Deterministic eligibility outranks Hermes. Invalid proposals become no recommendation.
    if v_activity.source <> 'gmail'
      or v_activity.event_type <> 'email.received'
      or v_activity.direction <> 'inbound'
      or v_activity.occurred_at < v_now - interval '30 days'
      or v_activity.external_thread_id is null
      or v_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      or v_recipient ~* '(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon)([._+-]|@)'
      or lower(coalesce(v_activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
      or private.signal_has_later_outbound(v_activity.id)
      or v_confidence < v_settings.minimum_confidence
    then continue; end if;

    if v_case_id is not null and not exists (
      select 1 from public.case_evidence evidence
      where evidence.case_id = v_case_id and evidence.activity_id = v_activity.id
    ) then raise exception 'recommendation case is not linked to this Signal'; end if;

    v_fingerprint := encode(digest(concat_ws('|',
      v_job.workspace_key, v_activity.id::text, v_activity.recommendation_revision::text,
      v_definition.key, coalesce(v_case_id::text, '')
    ), 'sha256'), 'hex');

    insert into public.signal_recommendations (
      workspace_key, activity_id, input_revision, case_id,
      recommendation_kind, intent_key, label, reason, confidence,
      evidence, prerequisites, capability_key, fingerprint,
      display_order, is_shadow, agent_run_id,
      action_definition_id, action_definition_version
    ) values (
      v_job.workspace_key, v_activity.id, v_job.input_revision, v_case_id,
      'action', 'reply', v_label, v_reason, v_confidence,
      v_evidence, v_prerequisites, v_definition.key, v_fingerprint,
      1, v_shadow, v_run_id, v_definition.id, v_definition.version
    );
    v_inserted := 1;
    if not v_shadow then v_public := 1; end if;
  end loop;

  if v_settings.shadow_signals_remaining > 0 then
    update public.signal_recommender_settings
    set shadow_signals_remaining = greatest(0, shadow_signals_remaining - 1), updated_at = v_now
    where workspace_key = v_settings.workspace_key;
  end if;

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    v_job.workspace_key, v_activity.id, v_job.input_revision,
    case when v_public > 0 then 'pending' else 'settled' end,
    case when v_public > 0 then null when v_inserted > 0 then 'shadow_only' else 'none_required' end,
    v_public, null, case when v_public > 0 then null else v_now end, v_now
  ) on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key, input_revision = excluded.input_revision,
      status = excluded.status, resolution = excluded.resolution,
      pending_recommendation_count = excluded.pending_recommendation_count,
      reviewed_by = null, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at;

  update public.agent_jobs
  set status = 'succeeded', finished_at = v_now, last_error = null,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where id = v_job.id;

  return jsonb_build_object(
    'jobId', v_job.id, 'activityId', v_activity.id,
    'inputRevision', v_job.input_revision, 'runId', v_run_id,
    'recommendationsStored', v_inserted, 'publicRecommendations', v_public,
    'shadow', v_shadow, 'maximumExecutableRecommendations', 1
  );
end;
$$;

-- Stage exactly 25 recent, deterministic Gmail candidates for the v2 shadow gate.
with candidates as (
  select activity.id
  from public.activities activity
  where activity.workspace_key = 'ottawa-painters'
    and activity.source = 'gmail' and activity.event_type = 'email.received'
    and activity.direction = 'inbound'
    and activity.external_thread_id is not null
    and activity.occurred_at >= now() - interval '30 days'
    and lower(coalesce(activity.source_metadata ->> 'automated', 'false')) not in ('true', '1', 'yes')
    and lower(coalesce(activity.actor_email, activity.from_email, '')) !~ '(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon)([._+-]|@)'
    and not private.signal_has_later_outbound(activity.id)
    and exists (
      select 1 from public.signal_triage_decisions decision
      where decision.activity_id = activity.id and decision.input_revision = activity.triage_revision
    )
  order by activity.occurred_at desc, activity.id desc
  limit 25
), revised as (
  update public.activities activity
  set recommendation_revision = recommendation_revision + 1
  from candidates where activity.id = candidates.id
  returning activity.workspace_key, activity.id, activity.recommendation_revision
)
insert into public.agent_jobs (
  workspace_key, agent_key, activity_id, input_revision, priority, queue_source
)
select workspace_key, 'signal-recommender', id, recommendation_revision, 10, 'backfill'
from revised
on conflict (agent_key, activity_id, input_revision) do nothing;

create or replace function public.accept_signal_action_recommendation(
  p_workspace_key text,
  p_activity_id bigint,
  p_recommendation_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_activity public.activities%rowtype;
  v_recommendation public.signal_recommendations%rowtype;
  v_definition public.action_definitions%rowtype;
  v_instance public.action_instances%rowtype;
  v_person_id uuid;
  v_recipient text;
  v_subject text;
  v_existing boolean := false;
  v_now timestamptz := now();
begin
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then
    raise exception 'invalid actor';
  end if;

  select * into v_activity
  from public.activities
  where id = p_activity_id and workspace_key = p_workspace_key
  for update;
  if not found then raise exception 'signal was not found'; end if;

  select * into v_recommendation
  from public.signal_recommendations
  where id = p_recommendation_id
    and activity_id = p_activity_id
    and workspace_key = p_workspace_key
  for update;
  if not found then raise exception 'recommendation was not found'; end if;

  select * into v_instance
  from public.action_instances
  where recommendation_id = v_recommendation.id
  for update;
  v_existing := found;
  if found and v_instance.status <> 'dismissed' then
    return jsonb_build_object('action', to_jsonb(v_instance), 'idempotent', true);
  end if;

  if v_recommendation.status <> 'pending'
    or v_recommendation.is_shadow
    or v_recommendation.input_revision <> v_activity.recommendation_revision
    or v_recommendation.recommendation_kind <> 'action'
    or v_recommendation.action_definition_id is null
  then raise exception 'recommendation is no longer actionable'; end if;

  select * into v_definition
  from public.action_definitions
  where id = v_recommendation.action_definition_id
    and workspace_key = p_workspace_key
  for update;
  if not found or not v_definition.enabled
    or v_definition.version <> v_recommendation.action_definition_version
    or v_definition.handler_key <> 'draft-email-reply'
  then raise exception 'action definition is unavailable or changed'; end if;

  v_recipient := lower(btrim(coalesce(v_activity.actor_email, v_activity.from_email, '')));
  if v_activity.source <> 'gmail'
    or v_activity.event_type <> 'email.received'
    or v_activity.direction <> 'inbound'
    or v_activity.occurred_at < v_now - interval '30 days'
    or v_activity.external_thread_id is null
    or v_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or v_recipient ~* '(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon)([._+-]|@)'
    or lower(coalesce(v_activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
    or private.signal_has_later_outbound(v_activity.id)
  then raise exception 'signal is not eligible for a draft email action'; end if;

  select link.person_id into v_person_id
  from public.activity_people link
  join public.people person on person.id = link.person_id and person.status = 'active'
  where link.activity_id = v_activity.id
  order by case link.relationship when 'counterparty' then 0 when 'customer' then 1 else 2 end,
    link.confidence desc
  limit 1;

  v_subject := btrim(regexp_replace(coalesce(v_activity.subject, '(no subject)'),
    '^(?:(?:re|fwd?):[[:space:]]*)+', '', 'i'));
  if v_subject = '' then v_subject := '(no subject)'; end if;
  v_subject := left('Re: ' || v_subject, 1000);

  if v_existing then
    update public.action_instances
    set status = 'drafting', execution_revision = execution_revision + 1,
        draft_body = null, draft_revision = 0, last_error = null,
        dismissed_at = null, updated_at = v_now, created_by = left(btrim(p_actor), 200)
    where id = v_instance.id
    returning * into v_instance;

    insert into public.action_execution_jobs (
      workspace_key, action_instance_id, input_revision, priority
    ) values (
      p_workspace_key, v_instance.id, v_instance.execution_revision, 100
    ) on conflict (action_instance_id, input_revision) do nothing;
    insert into public.action_events (
      workspace_key, action_instance_id, event_type, actor_type, actor_id
    ) values (p_workspace_key, v_instance.id, 'retried', 'user', left(btrim(p_actor), 200));
  else
    insert into public.action_instances (
      workspace_key, action_definition_id, action_definition_version,
      recommendation_id, source_activity_id, person_id, case_id, source_revision,
      status, execution_mode, title, reason, recipient_email, subject, created_by
    ) values (
      p_workspace_key, v_definition.id, v_definition.version,
      v_recommendation.id, v_activity.id, v_person_id, v_recommendation.case_id,
      v_activity.recommendation_revision, 'drafting', v_definition.execution_mode,
      left(v_recommendation.label, 160), v_recommendation.reason,
      v_recipient, v_subject, left(btrim(p_actor), 200)
    ) returning * into v_instance;

    insert into public.action_execution_jobs (
      workspace_key, action_instance_id, input_revision, priority
    ) values (p_workspace_key, v_instance.id, v_instance.execution_revision, 100);
    insert into public.action_events (
      workspace_key, action_instance_id, event_type, actor_type, actor_id,
      metadata
    ) values (
      p_workspace_key, v_instance.id, 'created', 'user', left(btrim(p_actor), 200),
      jsonb_build_object('recommendationId', v_recommendation.id, 'sourceActivityId', v_activity.id)
    );
  end if;

  update public.signal_recommendations
  set status = 'superseded', superseded_at = v_now, updated_at = v_now
  where workspace_key = p_workspace_key and activity_id = p_activity_id
    and input_revision = v_activity.recommendation_revision
    and status = 'pending' and id <> v_recommendation.id;

  update public.signal_recommendations
  set status = 'accepted', accepted_at = v_now, dismissed_at = null,
      superseded_at = null, updated_at = v_now
  where id = v_recommendation.id;

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    p_workspace_key, p_activity_id, v_activity.recommendation_revision,
    'action_open', 'action_created', 0, left(btrim(p_actor), 200), v_now, v_now
  ) on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = 'action_open', resolution = 'action_created',
      pending_recommendation_count = 0,
      reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at;

  return jsonb_build_object('action', to_jsonb(v_instance), 'idempotent', false);
end;
$$;

create or replace function public.claim_action_execution_job(
  p_worker text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.action_execution_jobs%rowtype;
  v_action public.action_instances%rowtype;
  v_activity public.activities%rowtype;
  v_definition public.action_definitions%rowtype;
  v_history jsonb;
  v_contact jsonb;
  v_case jsonb;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then raise exception 'invalid worker'; end if;
  if p_lease_seconds not between 60 and 3600 then raise exception 'invalid lease seconds'; end if;

  update public.action_execution_jobs job
  set status = 'succeeded', finished_at = v_now,
      last_error = 'Superseded by a newer Action execution revision.',
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  from public.action_instances action
  where job.action_instance_id = action.id
    and job.status in ('pending', 'leased')
    and job.input_revision < action.execution_revision;

  update public.action_execution_jobs
  set status = 'pending', available_at = v_now, lease_owner = null,
      lease_token = null, leased_until = null, updated_at = v_now
  where status = 'leased' and leased_until < v_now;

  select job.* into v_job
  from public.action_execution_jobs job
  join public.action_instances action on action.id = job.action_instance_id
  where job.status = 'pending' and job.available_at <= v_now
    and job.input_revision = action.execution_revision
    and action.status = 'drafting'
  order by job.priority desc, job.available_at, job.id
  for update of job skip locked
  limit 1;
  if not found then return jsonb_build_object('job', null); end if;

  update public.action_execution_jobs
  set status = 'leased', attempts = attempts + 1, claimed_at = v_now,
      lease_owner = btrim(p_worker), lease_token = gen_random_uuid(),
      leased_until = v_now + make_interval(secs => p_lease_seconds),
      last_error = null, updated_at = v_now
  where id = v_job.id returning * into v_job;

  select * into v_action from public.action_instances where id = v_job.action_instance_id;
  select * into v_activity from public.activities where id = v_action.source_activity_id;
  select * into v_definition from public.action_definitions where id = v_action.action_definition_id;

  select coalesce(jsonb_agg(to_jsonb(item) order by item.occurred_at), '[]'::jsonb)
  into v_history
  from (
    select history.id, history.direction, history.actor_name as "actorName",
      left(history.subject, 1000) as subject,
      left(coalesce(history.body_text, history.preview, ''), 12000) as text,
      history.occurred_at
    from public.activities history
    where history.id <> v_activity.id
      and history.workspace_key = v_activity.workspace_key
      and history.source = 'gmail'
      and history.account_key = v_activity.account_key
      and history.external_thread_id = v_activity.external_thread_id
    order by history.occurred_at desc, history.id desc
    limit 20
  ) item;

  select jsonb_build_object(
    'id', person.id, 'displayName', person.display_name,
    'email', person.primary_email, 'phone', person.primary_phone
  ) into v_contact
  from public.people person where person.id = v_action.person_id;

  select jsonb_build_object(
    'id', case_row.id, 'revision', case_row.revision, 'status', case_row.status,
    'canonicalState', case_row.canonical_state,
    'jobName', job.name
  ) into v_case
  from public.operational_cases case_row
  join public.jobs job on job.id = case_row.job_id
  where case_row.id = v_action.case_id;

  insert into public.action_events (
    workspace_key, action_instance_id, event_type, actor_type,
    metadata
  ) values (
    v_action.workspace_key, v_action.id, 'draft_started', 'hermes',
    jsonb_build_object('jobId', v_job.id, 'inputRevision', v_job.input_revision)
  );

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'actionId', v_action.id,
      'inputRevision', v_job.input_revision, 'leaseToken', v_job.lease_token,
      'attempt', v_job.attempts, 'leasedUntil', v_job.leased_until
    ),
    'action', jsonb_build_object(
      'id', v_action.id, 'definitionKey', v_definition.key,
      'definitionVersion', v_action.action_definition_version,
      'recipient', v_action.recipient_email, 'subject', v_action.subject,
      'reason', v_action.reason, 'executionMode', v_action.execution_mode,
      'configuration', v_definition.configuration
    ),
    'signal', jsonb_build_object(
      'id', v_activity.id, 'actorName', v_activity.actor_name,
      'subject', left(v_activity.subject, 1000),
      'bodyText', left(coalesce(v_activity.body_text, ''), 20000),
      'occurredAt', v_activity.occurred_at,
      'attachmentCount', v_activity.attachment_count
    ),
    'contact', v_contact,
    'case', v_case,
    'history', v_history,
    'contract', jsonb_build_object(
      'output', 'draftBodyOnly', 'maximumCharacters', 50000,
      'recipientAndSubjectAreServerControlled', true,
      'providerWritebackAllowed', false
    )
  );
end;
$$;

create or replace function public.complete_action_execution_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_draft_body text,
  p_model text default 'hermes',
  p_prompt_version text default 'action-runner-v1'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.action_execution_jobs%rowtype;
  v_action public.action_instances%rowtype;
  v_now timestamptz := now();
begin
  if p_draft_body is null or char_length(btrim(p_draft_body)) not between 1 and 50000 then raise exception 'invalid draft body'; end if;
  if p_prompt_version is null or char_length(btrim(p_prompt_version)) not between 1 and 100 then raise exception 'invalid prompt version'; end if;

  select * into v_job from public.action_execution_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token or v_job.leased_until < v_now then
    raise exception 'job lease is no longer valid';
  end if;
  select * into v_action from public.action_instances where id = v_job.action_instance_id for update;
  if v_action.status <> 'drafting' or v_action.execution_revision <> v_job.input_revision or v_action.draft_revision <> 0 then
    raise exception 'Action changed while Hermes was drafting';
  end if;

  update public.action_instances
  set draft_body = btrim(p_draft_body), draft_revision = 1,
      status = 'awaiting_approval', last_error = null, updated_at = v_now
  where id = v_action.id returning * into v_action;
  update public.action_execution_jobs
  set status = 'succeeded', finished_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null,
      last_error = null, updated_at = v_now
  where id = v_job.id;
  insert into public.action_events (
    workspace_key, action_instance_id, event_type, actor_type, metadata
  ) values (
    v_action.workspace_key, v_action.id, 'draft_ready', 'hermes',
    jsonb_build_object('model', left(coalesce(p_model, ''), 200), 'promptVersion', p_prompt_version,
      'jobId', v_job.id, 'draftRevision', v_action.draft_revision)
  );
  return jsonb_build_object('action', to_jsonb(v_action));
end;
$$;

create or replace function public.fail_action_execution_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.action_execution_jobs%rowtype;
  v_action public.action_instances%rowtype;
  v_terminal boolean;
  v_now timestamptz := now();
begin
  if p_error is null or char_length(btrim(p_error)) not between 1 and 2000 then raise exception 'invalid error'; end if;
  select * into v_job from public.action_execution_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'leased' or v_job.lease_token <> p_lease_token then raise exception 'job lease is no longer valid'; end if;
  select * into v_action from public.action_instances where id = v_job.action_instance_id for update;
  v_terminal := v_job.attempts >= 5;
  update public.action_execution_jobs
  set status = case when v_terminal then 'failed' else 'pending' end,
      available_at = case when v_terminal then available_at else v_now + make_interval(secs => least(3600, 30 * (2 ^ greatest(attempts - 1, 0))::integer)) end,
      lease_owner = null, lease_token = null, leased_until = null,
      last_error = left(btrim(p_error), 2000), finished_at = case when v_terminal then v_now else null end,
      updated_at = v_now
  where id = v_job.id;
  if v_terminal then
    update public.action_instances set status = 'failed', last_error = left(btrim(p_error), 2000), updated_at = v_now
    where id = v_action.id returning * into v_action;
    insert into public.action_events (workspace_key, action_instance_id, event_type, actor_type, metadata)
    values (v_action.workspace_key, v_action.id, 'failed', 'hermes', jsonb_build_object('jobId', v_job.id, 'error', left(btrim(p_error), 2000)));
  end if;
  return jsonb_build_object('actionId', v_action.id, 'status', case when v_terminal then 'failed' else 'drafting' end, 'terminal', v_terminal);
end;
$$;

create or replace function public.update_action_draft(
  p_workspace_key text,
  p_action_id uuid,
  p_expected_revision integer,
  p_draft_body text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare v_action public.action_instances%rowtype; v_now timestamptz := now();
begin
  if p_draft_body is null or char_length(btrim(p_draft_body)) not between 1 and 50000 then raise exception 'invalid draft body'; end if;
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then raise exception 'invalid actor'; end if;
  select * into v_action from public.action_instances
  where id = p_action_id and workspace_key = p_workspace_key for update;
  if not found then raise exception 'Action was not found'; end if;
  if v_action.status not in ('awaiting_approval', 'simulated') then raise exception 'Action draft is not editable'; end if;
  if v_action.draft_revision <> p_expected_revision then raise exception 'Action draft changed; refresh before saving'; end if;
  update public.action_instances
  set draft_body = btrim(p_draft_body), draft_revision = draft_revision + 1, updated_at = v_now
  where id = v_action.id returning * into v_action;
  insert into public.action_events (workspace_key, action_instance_id, event_type, actor_type, actor_id, metadata)
  values (p_workspace_key, v_action.id, 'draft_edited', 'user', left(btrim(p_actor), 200), jsonb_build_object('draftRevision', v_action.draft_revision));
  return jsonb_build_object('action', to_jsonb(v_action));
end;
$$;

create or replace function public.simulate_action_send(
  p_workspace_key text,
  p_action_id uuid,
  p_expected_revision integer,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare v_action public.action_instances%rowtype; v_now timestamptz := now();
begin
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then raise exception 'invalid actor'; end if;
  select * into v_action from public.action_instances
  where id = p_action_id and workspace_key = p_workspace_key for update;
  if not found then raise exception 'Action was not found'; end if;
  if v_action.status = 'simulated' then return jsonb_build_object('action', to_jsonb(v_action), 'idempotent', true, 'providerRequests', 0); end if;
  if v_action.status <> 'awaiting_approval' or v_action.draft_revision <> p_expected_revision or v_action.draft_body is null then
    raise exception 'Action draft is not ready or has changed';
  end if;
  update public.action_instances set status = 'simulated', simulated_at = v_now, updated_at = v_now
  where id = v_action.id returning * into v_action;
  insert into public.action_events (workspace_key, action_instance_id, event_type, actor_type, actor_id,
    metadata)
  values (p_workspace_key, v_action.id, 'simulated_sent', 'user', left(btrim(p_actor), 200),
    jsonb_build_object('providerRequests', 0, 'outboundActivityCreated', false, 'sourceSignalSettled', false));
  return jsonb_build_object('action', to_jsonb(v_action), 'idempotent', false, 'providerRequests', 0);
end;
$$;

create or replace function public.retry_action_draft(
  p_workspace_key text,
  p_action_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare v_action public.action_instances%rowtype; v_now timestamptz := now();
begin
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then raise exception 'invalid actor'; end if;
  select * into v_action from public.action_instances
  where id = p_action_id and workspace_key = p_workspace_key for update;
  if not found then raise exception 'Action was not found'; end if;
  if v_action.status <> 'failed' then raise exception 'Only a failed Action can be retried'; end if;
  update public.action_instances
  set status = 'drafting', execution_revision = execution_revision + 1,
      draft_body = null, draft_revision = 0, last_error = null, updated_at = v_now
  where id = v_action.id returning * into v_action;
  insert into public.action_execution_jobs (workspace_key, action_instance_id, input_revision, priority)
  values (p_workspace_key, v_action.id, v_action.execution_revision, 100)
  on conflict (action_instance_id, input_revision) do nothing;
  insert into public.action_events (workspace_key, action_instance_id, event_type, actor_type, actor_id)
  values (p_workspace_key, v_action.id, 'retried', 'user', left(btrim(p_actor), 200));
  return jsonb_build_object('action', to_jsonb(v_action));
end;
$$;

create or replace function public.dismiss_action_instance(
  p_workspace_key text,
  p_action_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_action public.action_instances%rowtype;
  v_activity public.activities%rowtype;
  v_now timestamptz := now();
begin
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then raise exception 'invalid actor'; end if;
  select * into v_action from public.action_instances
  where id = p_action_id and workspace_key = p_workspace_key for update;
  if not found then raise exception 'Action was not found'; end if;
  if v_action.status = 'dismissed' then return jsonb_build_object('action', to_jsonb(v_action), 'idempotent', true); end if;
  if v_action.status = 'completed_external' then raise exception 'A completed Action cannot be dismissed'; end if;
  select * into v_activity from public.activities where id = v_action.source_activity_id for update;

  update public.action_instances set status = 'dismissed', dismissed_at = v_now, updated_at = v_now
  where id = v_action.id returning * into v_action;
  update public.action_execution_jobs
  set status = 'succeeded', finished_at = v_now, lease_owner = null, lease_token = null,
      leased_until = null, last_error = 'Action was dismissed by the user.', updated_at = v_now
  where action_instance_id = v_action.id and status in ('pending', 'leased');
  insert into public.action_events (workspace_key, action_instance_id, event_type, actor_type, actor_id)
  values (p_workspace_key, v_action.id, 'dismissed', 'user', left(btrim(p_actor), 200));

  if v_activity.recommendation_revision = v_action.source_revision
    and not private.signal_has_later_outbound(v_activity.id)
  then
    update public.signal_recommendations
    set status = 'pending', accepted_at = null, dismissed_at = null,
        superseded_at = null, updated_at = v_now
    where id = v_action.recommendation_id;
    insert into public.signal_review_states (
      workspace_key, activity_id, input_revision, status, resolution,
      pending_recommendation_count, reviewed_by, reviewed_at, updated_at
    ) values (
      p_workspace_key, v_activity.id, v_activity.recommendation_revision,
      'pending', null, 1, null, null, v_now
    ) on conflict (activity_id) do update
    set input_revision = excluded.input_revision, status = 'pending', resolution = null,
        pending_recommendation_count = 1, reviewed_by = null, reviewed_at = null,
        updated_at = excluded.updated_at;
  end if;
  return jsonb_build_object('action', to_jsonb(v_action), 'idempotent', false);
end;
$$;

create or replace function public.get_real_board_summary(
  p_workspace_key text default 'ottawa-painters'
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'signalsToday', (
      select count(*) from public.activities activity
      where activity.workspace_key = p_workspace_key
        and activity.source in ('gmail', 'quo')
        and (activity.occurred_at at time zone 'America/Toronto')::date =
          (now() at time zone 'America/Toronto')::date
    ),
    'actionsOpen', (
      select count(*) from public.action_instances action
      where action.workspace_key = p_workspace_key
        and action.status not in ('completed_external', 'dismissed')
    ),
    'remindersDue', (
      select count(*) from public.work_items item
      where item.workspace_key = p_workspace_key and item.created_by_user_at is not null
        and item.status in ('open', 'waiting') and item.due_at is not null and item.due_at <= now()
    )
  );
$$;

create or replace function private.settle_handled_signal_recommendations(
  p_outbound_activity_id bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_outbound public.activities%rowtype;
begin
  select * into v_outbound from public.activities where id = p_outbound_activity_id;
  if not found or v_outbound.source not in ('gmail', 'quo') or v_outbound.direction <> 'outbound' then return; end if;

  with handled as (
    select inbound.id
    from public.activities inbound
    where inbound.workspace_key = v_outbound.workspace_key
      and inbound.source = v_outbound.source and inbound.direction = 'inbound'
      and (inbound.occurred_at < v_outbound.occurred_at or (inbound.occurred_at = v_outbound.occurred_at and inbound.id < v_outbound.id))
      and (
        (v_outbound.external_thread_id is not null and inbound.external_thread_id = v_outbound.external_thread_id)
        or (v_outbound.external_thread_id is null and inbound.occurred_at >= v_outbound.occurred_at - interval '7 days'
          and exists (
            select 1 from public.activity_people outbound_link
            join public.activity_people inbound_link on inbound_link.person_id = outbound_link.person_id
              and inbound_link.relationship = 'counterparty'
            where outbound_link.activity_id = v_outbound.id and outbound_link.relationship = 'counterparty'
              and inbound_link.activity_id = inbound.id
          ))
      )
  ), closed_jobs as (
    update public.agent_jobs job
    set status = 'succeeded', finished_at = now(), claimed_at = null, lease_owner = null,
        lease_token = null, leased_until = null,
        last_error = 'Signal was handled by a later outbound reply.', updated_at = now()
    from handled where job.agent_key = 'signal-recommender' and job.activity_id = handled.id
      and job.status in ('pending', 'leased') returning job.activity_id
  ), superseded as (
    update public.signal_recommendations recommendation
    set status = 'superseded', superseded_at = now(), updated_at = now()
    from handled where recommendation.activity_id = handled.id
      and recommendation.status = 'pending' returning recommendation.activity_id
  ), completed_actions as (
    update public.action_instances action
    set status = 'completed_external', completed_external_at = now(), updated_at = now()
    from handled
    where action.source_activity_id = handled.id
      and action.status in ('drafting', 'awaiting_approval', 'simulated', 'failed')
    returning action.id, action.workspace_key, action.source_activity_id
  ), closed_action_jobs as (
    update public.action_execution_jobs job
    set status = 'succeeded', finished_at = now(), lease_owner = null, lease_token = null,
        leased_until = null, last_error = 'A real outbound Gmail reply completed the Action.', updated_at = now()
    from completed_actions action where job.action_instance_id = action.id
      and job.status in ('pending', 'leased') returning action.source_activity_id
  ), action_audit as (
    insert into public.action_events (workspace_key, action_instance_id, event_type, actor_type, metadata)
    select action.workspace_key, action.id, 'completed_external', 'system',
      jsonb_build_object('outboundActivityId', v_outbound.id)
    from completed_actions action returning action_instance_id
  ), affected as (
    select activity_id from closed_jobs union select activity_id from superseded
    union select source_activity_id from completed_actions union select source_activity_id from closed_action_jobs
  )
  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  )
  select activity.workspace_key, activity.id, activity.recommendation_revision,
    'settled', 'none_required', 0, null, now(), now()
  from affected join public.activities activity on activity.id = affected.activity_id
  on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key, input_revision = excluded.input_revision,
      status = 'settled', resolution = 'none_required', pending_recommendation_count = 0,
      reviewed_by = null, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at;
end;
$$;

alter table public.action_definitions enable row level security;
alter table public.action_instances enable row level security;
alter table public.action_events enable row level security;
alter table public.action_execution_jobs enable row level security;

revoke all on table public.action_definitions, public.action_instances,
  public.action_events, public.action_execution_jobs
from public, anon, authenticated;
revoke all on sequence public.action_events_id_seq, public.action_execution_jobs_id_seq
from public, anon, authenticated;

grant all on table public.action_definitions, public.action_instances,
  public.action_events, public.action_execution_jobs to service_role;
grant usage, select on sequence public.action_events_id_seq, public.action_execution_jobs_id_seq
to service_role;

revoke all on function public.accept_signal_action_recommendation(text, bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_action_execution_job(text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_action_execution_job(bigint, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.fail_action_execution_job(bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.update_action_draft(text, uuid, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.simulate_action_send(text, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.retry_action_draft(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.dismiss_action_instance(text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.accept_signal_action_recommendation(text, bigint, uuid, text) to service_role;
grant execute on function public.claim_action_execution_job(text, integer) to service_role;
grant execute on function public.complete_action_execution_job(bigint, uuid, text, text, text) to service_role;
grant execute on function public.fail_action_execution_job(bigint, uuid, text) to service_role;
grant execute on function public.update_action_draft(text, uuid, integer, text, text) to service_role;
grant execute on function public.simulate_action_send(text, uuid, integer, text) to service_role;
grant execute on function public.retry_action_draft(text, uuid, text) to service_role;
grant execute on function public.dismiss_action_instance(text, uuid, text) to service_role;

comment on table public.action_definitions is
  'Server-only built-in capabilities Hermes may recommend. Configuration never contains executable user code.';
comment on table public.action_instances is
  'User-accepted Action instances. Simulation is explicit and never records provider delivery.';
comment on table public.action_events is
  'Append-only lifecycle audit for Action instances.';
comment on function public.simulate_action_send(text, uuid, integer, text) is
  'Records Sent (simulation) only. It performs no provider request, creates no Activity, and does not settle the source Signal.';
