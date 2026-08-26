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
        last_error = 'Signal was handled by a later outbound reply.',
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
end;
$$;

revoke all on function private.settle_handled_signal_recommendations(bigint)
  from public, anon, authenticated;
grant execute on function private.settle_handled_signal_recommendations(bigint)
  to service_role;

create or replace function private.settle_signal_recommendations_after_outbound()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.settle_handled_signal_recommendations(new.id);
  return new;
end;
$$;

drop trigger if exists activities_settle_signal_recommendations_after_outbound
  on public.activities;
create trigger activities_settle_signal_recommendations_after_outbound
after insert or update of direction, source, workspace_key, external_thread_id, occurred_at
on public.activities
for each row
when (new.direction = 'outbound' and new.source in ('gmail', 'quo'))
execute function private.settle_signal_recommendations_after_outbound();
