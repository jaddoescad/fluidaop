-- Retire the former Signal classifier without rewriting its immutable history.
-- The independent Potential Lead Classifier owns its own revision, queue, and trigger.

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.activities'::regclass
      and tgname = 'activities_enqueue_potential_lead_classifier'
      and not tgisinternal
  ) then
    raise exception 'Potential Lead Classifier trigger must exist before retiring the former Signal classifier';
  end if;
end;
$$;

-- Stop new classifier jobs, revision churn, and the downstream hook that required
-- a classifier decision before creating a recommendation job.
drop trigger if exists activities_resolve_and_enqueue_signal_triage
on public.activities;
drop trigger if exists activities_bump_signal_triage_revision
on public.activities;
drop trigger if exists signal_triage_decisions_enqueue_recommender
on public.signal_triage_decisions;

-- Identity matching is deterministic shared infrastructure. Keep it alive as
-- its own purpose-named trigger instead of hiding it inside either classifier.
-- PostgreSQL runs same-kind triggers by name, so this intentionally sorts
-- before the Potential Lead and recommendation enqueue triggers.
create or replace function private.resolve_activity_contact_identity_on_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and row(
    new.workspace_key, new.actor_name, new.actor_email, new.actor_phone,
    new.contact_id, new.occurred_at
  ) is not distinct from row(
    old.workspace_key, old.actor_name, old.actor_email, old.actor_phone,
    old.contact_id, old.occurred_at
  ) then
    return new;
  end if;

  perform private.resolve_activity_identity(new.id);
  return new;
end;
$$;

drop trigger if exists activities_contact_identity_resolution
on public.activities;
create trigger activities_contact_identity_resolution
after insert or update of workspace_key, actor_name, actor_email, actor_phone,
  contact_id, occurred_at
on public.activities
for each row execute function private.resolve_activity_contact_identity_on_change();

revoke all on function private.resolve_activity_contact_identity_on_change()
from public, anon, authenticated;
grant execute on function private.resolve_activity_contact_identity_on_change()
to service_role;

-- Signal recommendations remain a separate feature. Their queue now follows
-- the Activity directly and no longer waits for a former classifier decision.
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

create or replace function private.bump_signal_recommender_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(
    new.workspace_key, new.source, new.event_type, new.direction,
    new.actor_name, new.actor_email, new.from_email, new.actor_phone,
    new.subject, new.preview, new.body_text, new.occurred_at,
    new.external_thread_id, new.call_status, new.duration_seconds,
    new.has_attachments, new.attachment_count, new.contact_id,
    lower(coalesce(new.source_metadata ->> 'automated', 'false'))
  ) is distinct from row(
    old.workspace_key, old.source, old.event_type, old.direction,
    old.actor_name, old.actor_email, old.from_email, old.actor_phone,
    old.subject, old.preview, old.body_text, old.occurred_at,
    old.external_thread_id, old.call_status, old.duration_seconds,
    old.has_attachments, old.attachment_count, old.contact_id,
    lower(coalesce(old.source_metadata ->> 'automated', 'false'))
  ) and exists (
    select 1
    from public.agent_jobs job
    where job.agent_key = 'signal-recommender'
      and job.activity_id = old.id
  ) then
    new.recommendation_revision := old.recommendation_revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists activities_bump_signal_recommender_revision
on public.activities;
create trigger activities_bump_signal_recommender_revision
before update of workspace_key, source, event_type, direction,
  actor_name, actor_email, from_email, actor_phone,
  subject, preview, body_text, occurred_at, external_thread_id,
  call_status, duration_seconds, has_attachments, attachment_count,
  contact_id, source_metadata
on public.activities
for each row execute function private.bump_signal_recommender_revision();

create or replace function private.enqueue_signal_recommender_after_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and row(
    new.workspace_key, new.source, new.event_type, new.direction,
    new.actor_name, new.actor_email, new.from_email, new.actor_phone,
    new.subject, new.preview, new.body_text, new.occurred_at,
    new.external_thread_id, new.call_status, new.duration_seconds,
    new.has_attachments, new.attachment_count, new.contact_id,
    lower(coalesce(new.source_metadata ->> 'automated', 'false'))
  ) is not distinct from row(
    old.workspace_key, old.source, old.event_type, old.direction,
    old.actor_name, old.actor_email, old.from_email, old.actor_phone,
    old.subject, old.preview, old.body_text, old.occurred_at,
    old.external_thread_id, old.call_status, old.duration_seconds,
    old.has_attachments, old.attachment_count, old.contact_id,
    lower(coalesce(old.source_metadata ->> 'automated', 'false'))
  ) then
    return new;
  end if;

  perform private.enqueue_signal_recommender(
    new.id,
    case
      when new.event_type = 'call.completed'
        and new.source_metadata ->> 'transcriptStatus' = 'available'
      then 'transcript'
      else 'live'
    end
  );
  return new;
end;
$$;

drop trigger if exists activities_enqueue_signal_recommender
on public.activities;
create trigger activities_enqueue_signal_recommender
after insert or update of workspace_key, source, event_type, direction,
  actor_name, actor_email, from_email, actor_phone,
  subject, preview, body_text, occurred_at, external_thread_id,
  call_status, duration_seconds, has_attachments, attachment_count,
  contact_id, source_metadata
on public.activities
for each row execute function private.enqueue_signal_recommender_after_activity();

-- A BEFORE trigger owns the revision bump, while this broader AFTER trigger
-- refreshes the review projection for the same material Activity changes.
drop trigger if exists activities_ensure_signal_review_state
on public.activities;
create trigger activities_ensure_signal_review_state
after insert or update of recommendation_revision, workspace_key, source,
  event_type, direction, actor_name, actor_email, from_email, actor_phone,
  subject, preview, body_text, occurred_at, external_thread_id,
  call_status, duration_seconds, has_attachments, attachment_count,
  contact_id, source_metadata
on public.activities
for each row execute function private.ensure_signal_review_state();

revoke all on function private.enqueue_signal_recommender(bigint, text)
from public, anon, authenticated;
revoke all on function private.bump_signal_recommender_revision()
from public, anon, authenticated;
revoke all on function private.enqueue_signal_recommender_after_activity()
from public, anon, authenticated;
grant execute on function private.enqueue_signal_recommender(bigint, text)
to service_role;
grant execute on function private.bump_signal_recommender_revision()
to service_role;
grant execute on function private.enqueue_signal_recommender_after_activity()
to service_role;

create or replace function public.reconcile_signal_recommender(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 1000
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_activity_id bigint;
  v_enqueued integer := 0;
  v_released integer := 0;
  v_reviewed integer := 0;
  v_shadow_remaining integer;
  v_now timestamptz := now();
begin
  if p_limit not between 1 and 5000 then
    raise exception 'limit must be between 1 and 5000';
  end if;

  update public.agent_jobs
  set status = 'pending', available_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where workspace_key = p_workspace_key
    and agent_key = 'signal-recommender'
    and status = 'leased'
    and leased_until < v_now;
  get diagnostics v_released = row_count;

  for v_activity_id in
    select activity.id
    from public.activities activity
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and activity.direction = 'inbound'
      and lower(coalesce(activity.source_metadata ->> 'automated', 'false')) not in ('true', '1', 'yes')
      and not private.signal_has_later_outbound(activity.id)
      and activity.event_type in ('email.received', 'message.received', 'call.completed')
      and activity.occurred_at >= v_now - interval '30 days'
      and not exists (
        select 1
        from public.agent_jobs job
        where job.agent_key = 'signal-recommender'
          and job.activity_id = activity.id
          and job.input_revision = activity.recommendation_revision
      )
    order by activity.occurred_at desc, activity.id desc
    limit p_limit
  loop
    perform private.resolve_activity_identity(v_activity_id);
    perform private.enqueue_signal_recommender(v_activity_id, 'backfill');
    if exists (
      select 1
      from public.agent_jobs job
      join public.activities activity on activity.id = job.activity_id
      where job.agent_key = 'signal-recommender'
        and job.activity_id = v_activity_id
        and job.input_revision = activity.recommendation_revision
    ) then
      v_enqueued := v_enqueued + 1;
    end if;
  end loop;

  select count(distinct job.activity_id)::integer into v_reviewed
  from public.agent_jobs job
  join public.activities activity on activity.id = job.activity_id
  where job.workspace_key = p_workspace_key
    and job.agent_key = 'signal-recommender'
    and job.input_revision = activity.recommendation_revision
    and job.status = 'succeeded'
    and job.attempts > 0
    and lower(coalesce(activity.source_metadata ->> 'automated', 'false')) not in ('true', '1', 'yes')
    and not private.signal_has_later_outbound(activity.id);

  update public.signal_recommender_settings settings
  set shadow_signals_remaining = greatest(
        settings.shadow_signals_remaining,
        greatest(0, 100 - v_reviewed)
      ),
      updated_at = v_now
  where settings.workspace_key = p_workspace_key
    and not settings.publication_enabled
  returning settings.shadow_signals_remaining into v_shadow_remaining;

  return jsonb_build_object(
    'released', v_released,
    'enqueued', v_enqueued,
    'eligibleShadowReviewed', v_reviewed,
    'shadowSignalsRemaining', v_shadow_remaining,
    'checkedAt', v_now
  );
end;
$$;

revoke all on function public.reconcile_signal_recommender(text, integer)
from public, anon, authenticated;
grant execute on function public.reconcile_signal_recommender(text, integer)
to service_role;

-- Keep a truthful terminal state instead of deleting unfinished queue history or
-- reporting an intentional retirement as a runtime failure.
alter table public.agent_jobs
  drop constraint if exists agent_jobs_status_check;
alter table public.agent_jobs
  add constraint agent_jobs_status_check
  check (status in ('pending', 'leased', 'succeeded', 'failed', 'retired'));

do $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if exists (
    select 1
    from public.agent_jobs
    where agent_key = 'signal-triage'
      and status = 'leased'
      and leased_until > v_now
  ) then
    raise exception 'Cannot retire former Signal classifier while an active lease remains';
  end if;

  update public.agent_jobs
  set status = 'retired',
      finished_at = v_now,
      last_error = 'Retired: former Signal classification worker was removed.',
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      updated_at = v_now
  where agent_key = 'signal-triage'
    and (
      status = 'pending'
      or (status = 'leased' and (leased_until is null or leased_until <= v_now))
    );
end;
$$;

-- Remove the server-facing runtime surface. Historical decisions, labels, runs,
-- attachment evidence, contact suggestions, and completed/failed jobs remain.
drop function if exists public.claim_signal_triage_job(text, integer);
drop function if exists public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric,
  text, text, text, jsonb, jsonb
);
drop function if exists public.complete_signal_triage_job(
  bigint, uuid, text, text, text, text, text, text, numeric,
  text, text, text, jsonb, jsonb, jsonb
);
drop function if exists public.fail_signal_triage_job(
  bigint, uuid, text, text, text
);
drop function if exists public.reconcile_signal_triage(text, integer);

-- These trigger helpers are unreachable after the live entry points above are gone.
drop function if exists private.resolve_and_enqueue_signal_triage();
drop function if exists private.bump_activity_triage_revision();
drop function if exists private.enqueue_signal_recommender_after_triage();
