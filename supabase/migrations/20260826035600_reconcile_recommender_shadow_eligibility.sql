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
  if p_limit not between 1 and 5000 then raise exception 'limit must be between 1 and 5000'; end if;

  update public.agent_jobs
  set status = 'pending', available_at = v_now,
      lease_owner = null, lease_token = null, leased_until = null, updated_at = v_now
  where workspace_key = p_workspace_key and agent_key = 'signal-recommender'
    and status = 'leased' and leased_until < v_now;
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
      and exists (
        select 1 from public.signal_triage_decisions decision
        where decision.activity_id = activity.id
          and decision.input_revision = activity.triage_revision
      )
      and not exists (
        select 1 from public.agent_jobs job
        where job.agent_key = 'signal-recommender'
          and job.activity_id = activity.id
          and job.input_revision = activity.recommendation_revision
      )
    order by activity.occurred_at desc, activity.id desc
    limit p_limit
  loop
    perform private.enqueue_signal_recommender(v_activity_id, 'backfill');
    if exists (
      select 1 from public.agent_jobs job
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
