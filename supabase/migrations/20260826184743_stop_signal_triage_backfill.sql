-- Signal triage is live-only. Historical imports and provider enrichment still
-- resolve deterministic identity data, but they must not create AI backfill.
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
  if new.source in ('gmail', 'quo')
    and new.event_type in (
      'email.received', 'email.sent', 'message.received', 'message.sent', 'call.completed'
    )
    and new.occurred_at >= now() - interval '1 hour'
  then
    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    ) values (
      new.workspace_key, 'signal-triage', new.id, new.triage_revision, 100,
      case when new.event_type = 'call.completed' and new.source_metadata ? 'transcriptId'
        then 'transcript' else 'live' end
    )
    on conflict (agent_key, activity_id, input_revision) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.resolve_and_enqueue_signal_triage()
from public, anon, authenticated;
grant execute on function private.resolve_and_enqueue_signal_triage()
to service_role;

-- Reconciliation may repair a missed recent signal, but it must not expand the
-- live-only window into historical categorization work.
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
      activity.triage_revision, 100, 'reconcile'
    from public.activities activity
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and activity.event_type in ('email.received', 'email.sent', 'message.received', 'message.sent', 'call.completed')
      and activity.occurred_at >= now() - interval '1 hour'
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

revoke all on function public.reconcile_signal_triage(text, integer)
from public, anon, authenticated;
grant execute on function public.reconcile_signal_triage(text, integer)
to service_role;

-- There is no cancelled state in agent_jobs. Mark stopped backfill terminal as
-- succeeded while preserving an explicit audit message.
update public.agent_jobs
set status = 'succeeded',
    finished_at = now(),
    last_error = 'Backfill stopped by operator; signal triage is live-only.',
    lease_owner = null,
    lease_token = null,
    leased_until = null,
    updated_at = now()
where agent_key = 'signal-triage'
  and queue_source = 'backfill'
  and status in ('pending', 'leased');
