-- A historical import or provider-name enrichment is not a live signal merely
-- because it inserted or updated an Activity today. Prioritize by the signal's
-- actual occurrence time; transcript arrivals remain high priority regardless.

create or replace function private.resolve_and_enqueue_signal_triage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material_change boolean := true;
  v_queue_source text;
  v_priority smallint;
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
    and new.occurred_at >= now() - interval '30 days'
  then
    if new.event_type = 'call.completed' and new.source_metadata ? 'transcriptId' then
      v_queue_source := 'transcript';
      v_priority := 100;
    elsif new.occurred_at >= now() - interval '1 hour' then
      v_queue_source := 'live';
      v_priority := 100;
    else
      v_queue_source := 'backfill';
      v_priority := 10;
    end if;

    insert into public.agent_jobs (
      workspace_key, agent_key, activity_id, input_revision, priority, queue_source
    ) values (
      new.workspace_key, 'signal-triage', new.id, new.triage_revision,
      v_priority, v_queue_source
    )
    on conflict (agent_key, activity_id, input_revision) do nothing;
  end if;
  return new;
end;
$$;

update public.agent_jobs job
set priority = 10,
    queue_source = 'backfill',
    updated_at = now()
from public.activities activity
where job.activity_id = activity.id
  and job.agent_key = 'signal-triage'
  and job.status = 'pending'
  and job.queue_source = 'live'
  and activity.occurred_at < now() - interval '1 hour';

revoke all on function private.resolve_and_enqueue_signal_triage()
from public, anon, authenticated;
grant execute on function private.resolve_and_enqueue_signal_triage()
to service_role;
