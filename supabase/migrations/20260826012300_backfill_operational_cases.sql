do $$
declare
  v_job_id uuid;
begin
  for v_job_id in select id from public.jobs order by updated_at, id
  loop
    perform private.refresh_operational_case(v_job_id, false);
  end loop;
end;
$$;

with unique_open_job as (
  select
    job.contact_id,
    (array_agg(case_row.id order by case_row.id))[1] as case_id
  from public.operational_cases case_row
  join public.jobs job on job.id = case_row.job_id
  where case_row.status = 'open' and job.contact_id is not null
  group by job.contact_id
  having count(*) = 1
)
insert into public.case_evidence (
  workspace_key, case_id, evidence_type, activity_id, observed_at
)
select
  activity.workspace_key,
  candidate.case_id,
  'activity',
  activity.id,
  activity.occurred_at
from public.activities activity
join unique_open_job candidate on candidate.contact_id = activity.contact_id
where activity.occurred_at >= now() - interval '30 days'
on conflict (case_id, activity_id) where activity_id is not null do nothing;

update public.operational_cases case_row
set revision = revision + 1,
    evidence_updated_at = evidence.latest_evidence_at,
    updated_at = now()
from (
  select case_id, max(observed_at) as latest_evidence_at
  from public.case_evidence
  group by case_id
) evidence
where evidence.case_id = case_row.id;

insert into public.case_reconciliation_jobs (
  workspace_key, case_id, input_revision, priority, queue_source, available_at
)
select
  case_row.workspace_key,
  case_row.id,
  case_row.revision,
  case when case_row.status = 'open' then 25 else 5 end,
  'backfill',
  now()
from public.operational_cases case_row
on conflict (case_id, input_revision) do nothing;

analyze public.external_references;
analyze public.operational_cases;
analyze public.case_facts;
analyze public.case_evidence;
analyze public.work_items;
analyze public.case_reconciliation_jobs;
