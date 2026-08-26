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

create index if not exists activities_outbound_thread_resolution_idx
  on public.activities (workspace_key, source, external_thread_id, occurred_at, id)
  where direction = 'outbound';

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

with handled as (
  select activity.id
  from public.activities activity
  where activity.source in ('gmail', 'quo')
    and activity.direction = 'inbound'
    and private.signal_has_later_outbound(activity.id)
), closed_jobs as (
  update public.agent_jobs job
  set status = 'succeeded',
      finished_at = now(),
      claimed_at = null,
      lease_owner = null,
      lease_token = null,
      leased_until = null,
      last_error = 'Signal was already handled by a later outbound reply.',
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
), affected as (
  select activity_id from closed_jobs
  union
  select activity_id from superseded
)
insert into public.signal_review_states (
  workspace_key, activity_id, input_revision, status, resolution,
  pending_recommendation_count, reviewed_by, reviewed_at, updated_at
)
select activity.workspace_key, activity.id, activity.recommendation_revision,
  'settled', 'none_required', 0, null, now(), now()
from affected
join public.activities activity on activity.id = affected.activity_id
on conflict (activity_id) do update
set workspace_key = excluded.workspace_key,
    input_revision = excluded.input_revision,
    status = 'settled',
    resolution = 'none_required',
    pending_recommendation_count = 0,
    reviewed_by = null,
    reviewed_at = excluded.reviewed_at,
    updated_at = excluded.updated_at;

revoke all on function private.enqueue_signal_recommender(bigint, text) from public, anon, authenticated;
grant execute on function private.enqueue_signal_recommender(bigint, text) to service_role;
