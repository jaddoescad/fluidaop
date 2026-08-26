-- Signal triage is the only classification agent. Remove the obsolete
-- email-categorizer queue/API while preserving completed jobs, runs, labels,
-- and immutable migration history for auditability.
drop trigger if exists activities_enqueue_email_categorizer on public.activities;

delete from public.agent_jobs
where agent_key = 'email-categorizer'
  and status in ('pending', 'leased');

drop function if exists public.claim_email_categorizer_job(text, integer);
drop function if exists public.complete_email_categorizer_job(
  bigint, uuid, text, numeric, text, text, text, jsonb, jsonb
);
drop function if exists public.fail_email_categorizer_job(bigint, uuid, text, text, text);
drop function if exists private.enqueue_email_categorizer_job();

create or replace function public.enforce_signal_label_kind()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_kind text;
begin
  select label.kind into v_kind from public.labels label where label.id = new.label_id;
  if v_kind is null or v_kind <> new.label_kind then
    raise exception 'signal label kind must match the referenced label';
  end if;
  if new.agent_key = 'signal-triage' and v_kind not in ('topic', 'urgency') then
    raise exception 'signal triage can only assign topic or urgency labels';
  end if;
  return new;
end;
$$;

drop trigger if exists signal_labels_enforce_email_categorizer_kind on public.signal_labels;
drop trigger if exists signal_labels_enforce_kind on public.signal_labels;
create trigger signal_labels_enforce_kind
before insert or update of label_id, label_kind, agent_key
on public.signal_labels
for each row execute function public.enforce_signal_label_kind();

revoke all on function public.enforce_signal_label_kind()
from public, anon, authenticated;
grant execute on function public.enforce_signal_label_kind() to service_role;

drop function if exists public.enforce_email_categorizer_label_kind();
