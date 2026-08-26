create or replace function private.link_activity_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case_id uuid;
  v_count integer;
begin
  if new.contact_id is null then return new; end if;
  if tg_op = 'UPDATE' and row(
    old.contact_id, old.subject, old.body_text, old.preview, old.source_metadata,
    old.has_attachments, old.attachment_count
  ) is not distinct from row(
    new.contact_id, new.subject, new.body_text, new.preview, new.source_metadata,
    new.has_attachments, new.attachment_count
  ) then return new; end if;

  select count(*), (array_agg(case_row.id order by case_row.id))[1]
  into v_count, v_case_id
  from public.operational_cases case_row
  join public.jobs job on job.id = case_row.job_id
  where case_row.workspace_key = new.workspace_key
    and case_row.status = 'open'
    and job.contact_id = new.contact_id;
  if v_count <> 1 then return new; end if;

  insert into public.case_evidence (
    workspace_key, case_id, evidence_type, activity_id, observed_at
  ) values (new.workspace_key, v_case_id, 'activity', new.id, new.occurred_at)
  on conflict (case_id, activity_id) where activity_id is not null
  do update set observed_at = excluded.observed_at;

  update public.operational_cases
  set revision = revision + 1,
      evidence_updated_at = greatest(coalesce(evidence_updated_at, '-infinity'::timestamptz), new.updated_at),
      updated_at = now()
  where id = v_case_id;
  perform private.enqueue_case_reconciliation(v_case_id, 'live', 80, 60);
  return new;
end;
$$;

revoke all on function private.link_activity_case() from public, anon, authenticated;
