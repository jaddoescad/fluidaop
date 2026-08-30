-- A provider event is evidence, not a review decision. Every Gmail and Quo
-- Signal remains open until a person explicitly settles it. Existing explicit
-- no-action decisions and active Actions remain authoritative.

create or replace function private.enforce_human_signal_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A delayed agent completion or Activity revision must not overwrite a
  -- person's explicit decision.
  if tg_op = 'UPDATE'
    and old.status = 'settled'
    and old.resolution = 'no_action'
    and new.resolution is distinct from 'no_action'
  then
    new.status := 'settled';
    new.resolution := 'no_action';
    new.pending_recommendation_count := 0;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    return new;
  end if;

  -- Keep an accepted Action open while it is active. Once an outbound provider
  -- event completes that Action, the Signal returns to pending for a separate
  -- manual settlement decision.
  if tg_op = 'UPDATE'
    and old.status = 'action_open'
    and old.resolution = 'action_created'
    and new.resolution is distinct from 'no_action'
    and exists (
      select 1
      from public.action_instances action
      where action.source_activity_id = new.activity_id
        and action.status not in ('completed_external', 'dismissed')
    )
  then
    new.status := 'action_open';
    new.resolution := 'action_created';
    new.pending_recommendation_count := 0;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    return new;
  end if;

  -- Machine outcomes never settle a Signal. This also guards legacy functions
  -- that still propose none_required, shadow_only, or performed_external.
  if new.status = 'settled' and new.resolution is distinct from 'no_action' then
    new.status := 'pending';
    new.resolution := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  elsif new.status = 'pending' then
    new.resolution := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;

  return new;
end;
$$;

create or replace function private.ensure_signal_review_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source not in ('gmail', 'quo') then return new; end if;

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    new.workspace_key, new.id, new.recommendation_revision,
    'pending', null, 0, null, null, now()
  ) on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = 'pending',
      resolution = null,
      pending_recommendation_count = 0,
      reviewed_by = null,
      reviewed_at = null,
      updated_at = excluded.updated_at
  where public.signal_review_states.input_revision <> excluded.input_revision
    or (
      public.signal_review_states.status = 'settled'
      and public.signal_review_states.resolution is distinct from 'no_action'
    )
    or (
      public.signal_review_states.status = 'action_open'
      and not exists (
        select 1
        from public.action_instances action
        where action.source_activity_id = public.signal_review_states.activity_id
          and action.status not in ('completed_external', 'dismissed')
      )
    );
  return new;
end;
$$;

-- Keep the existing provider-response reconciliation for recommendations and
-- Actions, but return affected Signals to pending instead of settling them.
create or replace function private.settle_handled_signal_recommendations(
  p_outbound_activity_id bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbound public.activities%rowtype;
begin
  select * into v_outbound
  from public.activities
  where id = p_outbound_activity_id;

  if not found
    or v_outbound.source not in ('gmail', 'quo')
    or v_outbound.direction <> 'outbound'
  then
    return;
  end if;

  with handled as (
    select inbound.id
    from public.activities inbound
    where inbound.workspace_key = v_outbound.workspace_key
      and inbound.source = v_outbound.source
      and inbound.direction = 'inbound'
      and (
        inbound.occurred_at < v_outbound.occurred_at
        or (inbound.occurred_at = v_outbound.occurred_at and inbound.id < v_outbound.id)
      )
      and (
        (
          v_outbound.external_thread_id is not null
          and inbound.external_thread_id = v_outbound.external_thread_id
        )
        or (
          v_outbound.external_thread_id is null
          and inbound.occurred_at >= v_outbound.occurred_at - interval '7 days'
          and exists (
            select 1
            from public.activity_people outbound_link
            join public.activity_people inbound_link
              on inbound_link.person_id = outbound_link.person_id
              and inbound_link.relationship = 'counterparty'
            where outbound_link.activity_id = v_outbound.id
              and outbound_link.relationship = 'counterparty'
              and inbound_link.activity_id = inbound.id
          )
        )
      )
  ), closed_jobs as (
    update public.agent_jobs job
    set status = 'succeeded',
        finished_at = now(),
        claimed_at = null,
        lease_owner = null,
        lease_token = null,
        leased_until = null,
        last_error = 'A later outbound reply removed the need for an automated recommendation; manual Signal settlement is still required.',
        updated_at = now()
    from handled
    where job.agent_key = 'signal-recommender'
      and job.activity_id = handled.id
      and job.status in ('pending', 'leased')
    returning job.activity_id
  ), superseded as (
    update public.signal_recommendations recommendation
    set status = 'superseded',
        superseded_at = now(),
        updated_at = now()
    from handled
    where recommendation.activity_id = handled.id
      and recommendation.status = 'pending'
    returning recommendation.activity_id
  ), completed_actions as (
    update public.action_instances action
    set status = 'completed_external',
        completed_external_at = now(),
        updated_at = now()
    from handled
    where action.source_activity_id = handled.id
      and action.status in ('drafting', 'awaiting_approval', 'simulated', 'failed')
    returning action.id, action.workspace_key, action.source_activity_id
  ), closed_action_jobs as (
    update public.action_execution_jobs job
    set status = 'succeeded',
        finished_at = now(),
        lease_owner = null,
        lease_token = null,
        leased_until = null,
        last_error = 'A real outbound Gmail reply completed the Action.',
        updated_at = now()
    from completed_actions action
    where job.action_instance_id = action.id
      and job.status in ('pending', 'leased')
    returning action.source_activity_id
  ), action_audit as (
    insert into public.action_events (
      workspace_key, action_instance_id, event_type, actor_type, metadata
    )
    select action.workspace_key, action.id, 'completed_external', 'system',
      jsonb_build_object('outboundActivityId', v_outbound.id)
    from completed_actions action
    returning action_instance_id
  ), affected as (
    select activity_id from closed_jobs
    union select activity_id from superseded
    union select source_activity_id from completed_actions
    union select source_activity_id from closed_action_jobs
  )
  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  )
  select activity.workspace_key, activity.id, activity.recommendation_revision,
    'pending', null, 0, null, null, now()
  from affected
  join public.activities activity on activity.id = affected.activity_id
  on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = 'pending',
      resolution = null,
      pending_recommendation_count = 0,
      reviewed_by = null,
      reviewed_at = null,
      updated_at = excluded.updated_at;
end;
$$;

-- Dismissing an Action always returns its source Signal to manual review, even
-- when a later provider reply exists.
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
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then
    raise exception 'invalid actor';
  end if;

  select * into v_action
  from public.action_instances
  where id = p_action_id and workspace_key = p_workspace_key
  for update;
  if not found then raise exception 'Action was not found'; end if;
  if v_action.status = 'dismissed' then
    return jsonb_build_object('action', to_jsonb(v_action), 'idempotent', true);
  end if;
  if v_action.status = 'completed_external' then
    raise exception 'A completed Action cannot be dismissed';
  end if;

  select * into v_activity
  from public.activities
  where id = v_action.source_activity_id
  for update;

  update public.action_instances
  set status = 'dismissed', dismissed_at = v_now, updated_at = v_now
  where id = v_action.id
  returning * into v_action;

  update public.action_execution_jobs
  set status = 'succeeded',
      finished_at = v_now,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      last_error = 'Action was dismissed by the user.',
      updated_at = v_now
  where action_instance_id = v_action.id
    and status in ('pending', 'leased');

  insert into public.action_events (
    workspace_key, action_instance_id, event_type, actor_type, actor_id
  ) values (
    p_workspace_key, v_action.id, 'dismissed', 'user', left(btrim(p_actor), 200)
  );

  if v_activity.recommendation_revision = v_action.source_revision then
    update public.signal_recommendations
    set status = 'pending',
        accepted_at = null,
        dismissed_at = null,
        superseded_at = null,
        updated_at = v_now
    where id = v_action.recommendation_id;

    insert into public.signal_review_states (
      workspace_key, activity_id, input_revision, status, resolution,
      pending_recommendation_count, reviewed_by, reviewed_at, updated_at
    ) values (
      p_workspace_key, v_activity.id, v_activity.recommendation_revision,
      'pending', null, 1, null, null, v_now
    ) on conflict (activity_id) do update
    set input_revision = excluded.input_revision,
        status = 'pending',
        resolution = null,
        pending_recommendation_count = 1,
        reviewed_by = null,
        reviewed_at = null,
        updated_at = excluded.updated_at;
  end if;

  return jsonb_build_object('action', to_jsonb(v_action), 'idempotent', false);
end;
$$;

-- Reopen every historical machine-settled Signal. Explicit no-action choices
-- and genuinely active Actions are preserved.
with current_recommendations as (
  select activity.id as activity_id,
    count(recommendation.id) filter (
      where recommendation.status = 'pending' and not recommendation.is_shadow
    )::smallint as pending_count
  from public.activities activity
  left join public.signal_recommendations recommendation
    on recommendation.activity_id = activity.id
    and recommendation.input_revision = activity.recommendation_revision
  group by activity.id
)
update public.signal_review_states review
set status = 'pending',
    resolution = null,
    pending_recommendation_count = recommendations.pending_count,
    reviewed_by = null,
    reviewed_at = null,
    updated_at = now()
from current_recommendations recommendations
where review.activity_id = recommendations.activity_id
  and review.resolution is distinct from 'no_action'
  and not (
    review.status = 'action_open'
    and review.resolution = 'action_created'
    and exists (
      select 1
      from public.action_instances action
      where action.source_activity_id = review.activity_id
        and action.status not in ('completed_external', 'dismissed')
    )
  );

insert into public.signal_review_states (
  workspace_key, activity_id, input_revision, status, resolution,
  pending_recommendation_count, reviewed_by, reviewed_at, updated_at
)
select activity.workspace_key, activity.id, activity.recommendation_revision,
  'pending', null,
  count(recommendation.id) filter (
    where recommendation.status = 'pending' and not recommendation.is_shadow
  )::smallint,
  null, null, now()
from public.activities activity
left join public.signal_recommendations recommendation
  on recommendation.activity_id = activity.id
  and recommendation.input_revision = activity.recommendation_revision
where activity.source in ('gmail', 'quo')
  and not exists (
    select 1
    from public.signal_review_states review
    where review.activity_id = activity.id
  )
group by activity.workspace_key, activity.id, activity.recommendation_revision;

alter table public.signal_review_states
  drop constraint signal_review_states_resolution_check,
  drop constraint signal_review_states_consistency_check;

alter table public.signal_review_states
  add constraint signal_review_states_resolution_check
    check (resolution is null or resolution in ('no_action', 'action_created')),
  add constraint signal_review_states_consistency_check
    check (
      (status = 'pending' and resolution is null and reviewed_at is null)
      or
      (status = 'action_open' and resolution = 'action_created'
        and pending_recommendation_count = 0 and reviewed_at is not null)
      or
      (status = 'settled' and resolution = 'no_action'
        and pending_recommendation_count = 0 and reviewed_at is not null)
    );

comment on table public.signal_review_states is
  'Manual review state for Signals. Provider activity may reconcile recommendations or Actions, but only an explicit no_action decision settles a Signal.';

revoke all on function private.enforce_human_signal_review()
  from public, anon, authenticated;
revoke all on function private.ensure_signal_review_state()
  from public, anon, authenticated;
revoke all on function private.settle_handled_signal_recommendations(bigint)
  from public, anon, authenticated;
grant execute on function private.enforce_human_signal_review(),
  private.ensure_signal_review_state(),
  private.settle_handled_signal_recommendations(bigint)
  to service_role;

revoke all on function public.dismiss_action_instance(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.dismiss_action_instance(text, uuid, text)
  to service_role;
