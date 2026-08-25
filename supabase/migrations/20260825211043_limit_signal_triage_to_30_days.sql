-- AI classification intentionally covers only the rolling 30-day window and
-- future signals. Deterministic identity/contact resolution still covers all
-- history. This prevents provider name enrichment on older Activities from
-- expanding the AI queue.
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
    and new.occurred_at >= now() - interval '30 days'
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

-- These pending jobs were produced when the first selective Quo name pass
-- updated older historical rows. There are no runs, labels, or decisions to
-- preserve for pending work.
delete from public.agent_jobs job
using public.activities activity
where job.activity_id = activity.id
  and job.agent_key = 'signal-triage'
  and job.status = 'pending'
  and activity.occurred_at < now() - interval '30 days';
