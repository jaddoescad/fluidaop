alter table public.activities
  add column recommendation_revision integer not null default 1;

alter table public.activities
  add constraint activities_recommendation_revision_check
  check (recommendation_revision > 0);

alter table public.work_items
  add column created_by_user_at timestamptz;

create index work_items_created_board_idx
  on public.work_items (workspace_key, status, updated_at desc, id)
  where created_by_user_at is not null;

create table public.signal_recommender_settings (
  workspace_key text primary key,
  maximum_recommendations smallint not null default 5,
  minimum_confidence numeric(5,4) not null default 0.70,
  shadow_signals_remaining integer not null default 100,
  publication_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signal_recommender_settings_workspace_check
    check (char_length(workspace_key) between 1 and 100),
  constraint signal_recommender_settings_maximum_check
    check (maximum_recommendations between 1 and 5),
  constraint signal_recommender_settings_confidence_check
    check (minimum_confidence between 0 and 1),
  constraint signal_recommender_settings_shadow_check
    check (shadow_signals_remaining >= 0)
);

insert into public.signal_recommender_settings (workspace_key)
values ('ottawa-painters')
on conflict (workspace_key) do nothing;

create table public.signal_review_states (
  workspace_key text not null,
  activity_id bigint primary key references public.activities(id) on delete cascade,
  input_revision integer not null,
  status text not null default 'settled',
  resolution text,
  pending_recommendation_count smallint not null default 0,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signal_review_states_workspace_activity_key
    unique (workspace_key, activity_id),
  constraint signal_review_states_workspace_check
    check (char_length(workspace_key) between 1 and 100),
  constraint signal_review_states_revision_check
    check (input_revision > 0),
  constraint signal_review_states_status_check
    check (status in ('pending', 'settled')),
  constraint signal_review_states_resolution_check
    check (resolution is null or resolution in ('no_action', 'none_required', 'shadow_only')),
  constraint signal_review_states_pending_count_check
    check (pending_recommendation_count between 0 and 5),
  constraint signal_review_states_reviewer_check
    check (reviewed_by is null or char_length(reviewed_by) between 1 and 200),
  constraint signal_review_states_consistency_check
    check (
      (status = 'pending' and resolution is null and pending_recommendation_count > 0 and reviewed_at is null)
      or
      (status = 'settled' and resolution is not null and pending_recommendation_count = 0)
    )
);

create index signal_review_states_attention_idx
  on public.signal_review_states (workspace_key, status, updated_at desc, activity_id desc);

create table public.signal_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_key text not null,
  activity_id bigint not null references public.activities(id) on delete cascade,
  input_revision integer not null,
  case_id uuid references public.operational_cases(id) on delete set null,
  recommendation_kind text not null,
  intent_key text not null,
  label text not null,
  reason text not null,
  confidence numeric(5,4) not null,
  evidence jsonb not null default '[]'::jsonb,
  prerequisites jsonb not null default '{}'::jsonb,
  capability_key text,
  fingerprint text not null,
  display_order smallint not null,
  status text not null default 'pending',
  is_shadow boolean not null default true,
  source_agent text not null default 'signal-recommender',
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  dismissed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signal_recommendations_workspace_check
    check (char_length(workspace_key) between 1 and 100),
  constraint signal_recommendations_revision_check
    check (input_revision > 0),
  constraint signal_recommendations_kind_check
    check (recommendation_kind in ('action', 'reminder', 'automation')),
  constraint signal_recommendations_intent_check
    check (intent_key in (
      'reply', 'follow_up', 'schedule', 'production', 'payment_collection',
      'procurement', 'colour_consult', 'documentation', 'review', 'other'
    )),
  constraint signal_recommendations_label_check
    check (char_length(btrim(label)) between 1 and 160),
  constraint signal_recommendations_reason_check
    check (char_length(btrim(reason)) between 1 and 2000),
  constraint signal_recommendations_confidence_check
    check (confidence between 0 and 1),
  constraint signal_recommendations_evidence_check
    check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 30 and pg_column_size(evidence) <= 262144),
  constraint signal_recommendations_prerequisites_check
    check (jsonb_typeof(prerequisites) = 'object' and pg_column_size(prerequisites) <= 65536),
  constraint signal_recommendations_capability_check
    check (capability_key is null or capability_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint signal_recommendations_fingerprint_check
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint signal_recommendations_order_check
    check (display_order between 1 and 5),
  constraint signal_recommendations_status_check
    check (status in ('pending', 'dismissed', 'superseded')),
  constraint signal_recommendations_source_check
    check (source_agent = 'signal-recommender'),
  constraint signal_recommendations_lifecycle_check
    check (
      (status = 'pending' and dismissed_at is null and superseded_at is null)
      or (status = 'dismissed' and dismissed_at is not null and superseded_at is null)
      or (status = 'superseded' and superseded_at is not null)
    ),
  constraint signal_recommendations_revision_fingerprint_key
    unique (workspace_key, activity_id, input_revision, fingerprint),
  constraint signal_recommendations_revision_order_key
    unique (workspace_key, activity_id, input_revision, display_order)
);

create index signal_recommendations_activity_idx
  on public.signal_recommendations (activity_id, input_revision desc, status, display_order);

create index signal_recommendations_pending_idx
  on public.signal_recommendations (workspace_key, is_shadow, updated_at desc, activity_id desc)
  where status = 'pending';

create index signal_recommendations_case_fk_idx
  on public.signal_recommendations (case_id)
  where case_id is not null;

create or replace function private.signal_has_later_outbound(p_activity_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.activities selected
    join public.activities later
      on later.workspace_key = selected.workspace_key
      and later.source = selected.source
      and later.direction = 'outbound'
      and (
        later.occurred_at > selected.occurred_at
        or (later.occurred_at = selected.occurred_at and later.id > selected.id)
      )
      and (
        (
          selected.external_thread_id is not null
          and later.external_thread_id = selected.external_thread_id
        )
        or (
          selected.external_thread_id is null
          and later.occurred_at <= selected.occurred_at + interval '7 days'
          and exists (
            select 1
            from public.activity_people selected_link
            join public.activity_people later_link
              on later_link.person_id = selected_link.person_id
              and later_link.relationship = 'counterparty'
            where selected_link.activity_id = selected.id
              and selected_link.relationship = 'counterparty'
              and later_link.activity_id = later.id
          )
        )
      )
    where selected.id = p_activity_id
      and selected.direction = 'inbound'
  );
$$;

revoke all on function private.signal_has_later_outbound(bigint) from public, anon, authenticated;
grant execute on function private.signal_has_later_outbound(bigint) to service_role;

create or replace function private.enqueue_signal_recommender(
  p_activity_id bigint,
  p_queue_source text default 'live'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_source text;
  v_priority smallint;
begin
  select * into v_activity
  from public.activities
  where id = p_activity_id;

  if not found
    or v_activity.source not in ('gmail', 'quo')
    or v_activity.direction <> 'inbound'
    or lower(coalesce(v_activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
    or private.signal_has_later_outbound(v_activity.id)
    or v_activity.event_type not in ('email.received', 'message.received', 'call.completed')
    or v_activity.occurred_at < now() - interval '30 days'
    or not exists (
      select 1
      from public.signal_triage_decisions decision
      where decision.activity_id = v_activity.id
        and decision.input_revision = v_activity.triage_revision
    )
  then
    return;
  end if;

  v_source := case
    when p_queue_source = 'case-revision' then 'reconcile'
    when p_queue_source in ('live', 'backfill', 'transcript', 'reconcile') then p_queue_source
    else 'live'
  end;
  v_priority := case
    when v_source in ('transcript', 'reconcile') then 100
    when v_activity.occurred_at >= now() - interval '1 hour' then 100
    else 10
  end;
  if v_priority = 10 then v_source := 'backfill'; end if;

  insert into public.agent_jobs (
    workspace_key, agent_key, activity_id, input_revision, priority, queue_source
  ) values (
    v_activity.workspace_key, 'signal-recommender', v_activity.id,
    v_activity.recommendation_revision, v_priority, v_source
  )
  on conflict (agent_key, activity_id, input_revision) do nothing;
end;
$$;

create or replace function private.enqueue_signal_recommender_after_triage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity_id bigint := new.activity_id;
begin
  if tg_op = 'UPDATE' and row(
    new.input_revision, new.contact_disposition, new.proposed_entity_type,
    new.proposed_role_key, new.confidence, new.outcome, new.person_id, new.evidence
  ) is not distinct from row(
    old.input_revision, old.contact_disposition, old.proposed_entity_type,
    old.proposed_role_key, old.confidence, old.outcome, old.person_id, old.evidence
  ) then
    return new;
  end if;

  update public.activities activity
  set recommendation_revision = case
        when exists (
          select 1 from public.agent_jobs job
          where job.agent_key = 'signal-recommender' and job.activity_id = activity.id
        ) then activity.recommendation_revision + 1
        else activity.recommendation_revision
      end
  where activity.id = v_activity_id;

  perform private.enqueue_signal_recommender(v_activity_id, 'live');
  return new;
end;
$$;

drop trigger if exists signal_triage_decisions_enqueue_recommender
on public.signal_triage_decisions;
create trigger signal_triage_decisions_enqueue_recommender
after insert or update
on public.signal_triage_decisions
for each row execute function private.enqueue_signal_recommender_after_triage();

create or replace function private.enqueue_signal_recommender_after_case_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity_id bigint;
begin
  if new.revision = old.revision then return new; end if;

  for v_activity_id in
    select distinct evidence.activity_id
    from public.case_evidence evidence
    join public.activities activity on activity.id = evidence.activity_id
    where evidence.case_id = new.id
      and evidence.activity_id is not null
      and activity.direction = 'inbound'
      and activity.occurred_at >= now() - interval '30 days'
  loop
    update public.activities
    set recommendation_revision = recommendation_revision + 1
    where id = v_activity_id;
    perform private.enqueue_signal_recommender(v_activity_id, 'case-revision');
  end loop;
  return new;
end;
$$;

drop trigger if exists operational_cases_enqueue_signal_recommender
on public.operational_cases;
create trigger operational_cases_enqueue_signal_recommender
after update of revision
on public.operational_cases
for each row execute function private.enqueue_signal_recommender_after_case_revision();

insert into public.agent_jobs (
  workspace_key, agent_key, activity_id, input_revision, priority, queue_source
)
select activity.workspace_key, 'signal-recommender', activity.id,
  activity.recommendation_revision, 10, 'backfill'
from public.activities activity
where activity.source in ('gmail', 'quo')
  and activity.direction = 'inbound'
  and activity.event_type in ('email.received', 'message.received', 'call.completed')
  and activity.occurred_at >= now() - interval '30 days'
  and exists (
    select 1 from public.signal_triage_decisions decision
    where decision.activity_id = activity.id
      and decision.input_revision = activity.triage_revision
  )
on conflict (agent_key, activity_id, input_revision) do nothing;

alter table public.signal_recommender_settings enable row level security;
alter table public.signal_review_states enable row level security;
alter table public.signal_recommendations enable row level security;

revoke all on table public.signal_recommender_settings,
  public.signal_review_states, public.signal_recommendations
from public, anon, authenticated;

grant all on table public.signal_recommender_settings,
  public.signal_review_states, public.signal_recommendations
to service_role;

revoke all on function private.enqueue_signal_recommender(bigint, text)
from public, anon, authenticated;
revoke all on function private.enqueue_signal_recommender_after_triage()
from public, anon, authenticated;
revoke all on function private.enqueue_signal_recommender_after_case_revision()
from public, anon, authenticated;

grant execute on function private.enqueue_signal_recommender(bigint, text)
to service_role;

comment on table public.signal_recommendations is
  'Locked Hermes recommendations attached to one inbound Signal. These never create work or execute provider actions.';

comment on table public.signal_review_states is
  'The user-visible decision state for one Signal. Only an explicit no-action resolution may settle a Signal with pending recommendations in v1.';

comment on column public.work_items.created_by_user_at is
  'Null for deterministic and Hermes proposals. Only rows explicitly created by a user may appear in the Board Actions column.';
