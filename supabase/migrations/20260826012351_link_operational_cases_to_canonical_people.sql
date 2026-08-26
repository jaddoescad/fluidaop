alter table public.operational_cases
  add column person_id uuid references public.people(id) on delete set null;

create index operational_cases_person_idx
  on public.operational_cases (workspace_key, person_id, status)
  where person_id is not null and status = 'open';

create or replace function private.resolve_operational_case_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.person_id := null;
  if new.contact_id is not null then
    select source.person_id into new.person_id
    from public.person_sources source
    where source.source_system = 'ottawa-painters-admin'
      and source.source_record_type = 'contact'
      and source.source_record_id = new.contact_id::text
    limit 1;
  end if;
  return new;
end;
$$;

create trigger operational_cases_resolve_person
before insert or update of contact_id
on public.operational_cases
for each row execute function private.resolve_operational_case_person();

update public.operational_cases case_row
set person_id = source.person_id,
    updated_at = now()
from public.person_sources source
where source.source_system = 'ottawa-painters-admin'
  and source.source_record_type = 'contact'
  and source.source_record_id = case_row.contact_id::text
  and case_row.person_id is distinct from source.person_id;

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
  if tg_op = 'UPDATE' and row(
    old.contact_id, old.subject, old.body_text, old.preview, old.source_metadata,
    old.has_attachments, old.attachment_count
  ) is not distinct from row(
    new.contact_id, new.subject, new.body_text, new.preview, new.source_metadata,
    new.has_attachments, new.attachment_count
  ) then return new; end if;

  select count(*), (array_agg(case_row.id order by case_row.id))[1]
  into v_count, v_case_id
  from public.activity_people link
  join public.operational_cases case_row
    on case_row.person_id = link.person_id
   and case_row.workspace_key = new.workspace_key
   and case_row.status = 'open'
  where link.activity_id = new.id
    and link.relationship = 'counterparty';
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

create or replace function private.link_activity_person_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.activities%rowtype;
  v_case_id uuid;
  v_case_count integer;
  v_inserted integer;
begin
  if new.relationship <> 'counterparty' then return new; end if;
  if tg_op = 'UPDATE' and row(old.person_id, old.relationship, old.matched_by, old.confidence)
    is not distinct from row(new.person_id, new.relationship, new.matched_by, new.confidence)
  then return new; end if;

  select * into v_activity from public.activities where id = new.activity_id;
  if not found then return new; end if;
  select count(*), (array_agg(case_row.id order by case_row.id))[1]
  into v_case_count, v_case_id
  from public.operational_cases case_row
  where case_row.workspace_key = v_activity.workspace_key
    and case_row.person_id = new.person_id
    and case_row.status = 'open';
  if v_case_count <> 1 then return new; end if;

  insert into public.case_evidence (
    workspace_key, case_id, evidence_type, activity_id, observed_at
  ) values (v_activity.workspace_key, v_case_id, 'activity', v_activity.id, v_activity.occurred_at)
  on conflict (case_id, activity_id) where activity_id is not null do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then return new; end if;

  update public.operational_cases
  set revision = revision + 1,
      evidence_updated_at = greatest(coalesce(evidence_updated_at, '-infinity'::timestamptz), v_activity.updated_at),
      updated_at = now()
  where id = v_case_id;
  perform private.enqueue_case_reconciliation(v_case_id, 'live', 80, 60);
  return new;
end;
$$;

create trigger activity_people_link_operational_case
after insert or update of person_id, relationship, matched_by, confidence
on public.activity_people
for each row execute function private.link_activity_person_case();

create temporary table fluid_case_activity_backfill on commit drop as
with unique_activity_person as (
  select link.activity_id, (array_agg(link.person_id order by link.person_id))[1] as person_id
  from public.activity_people link
  join public.people person on person.id = link.person_id and person.status = 'active'
  where link.relationship = 'counterparty'
  group by link.activity_id
  having count(distinct link.person_id) = 1
),
unique_open_case as (
  select case_row.person_id, (array_agg(case_row.id order by case_row.id))[1] as case_id
  from public.operational_cases case_row
  where case_row.status = 'open' and case_row.person_id is not null
  group by case_row.person_id
  having count(*) = 1
)
select activity.workspace_key, candidate.case_id, activity.id as activity_id, activity.occurred_at
from public.activities activity
join unique_activity_person link on link.activity_id = activity.id
join unique_open_case candidate on candidate.person_id = link.person_id
where activity.occurred_at >= now() - interval '30 days';

insert into public.case_evidence (
  workspace_key, case_id, evidence_type, activity_id, observed_at
)
select workspace_key, case_id, 'activity', activity_id, occurred_at
from fluid_case_activity_backfill
on conflict (case_id, activity_id) where activity_id is not null do nothing;

update public.operational_cases case_row
set revision = revision + 1,
    evidence_updated_at = evidence.latest_evidence_at,
    updated_at = now()
from (
  select candidate.case_id, max(candidate.occurred_at) as latest_evidence_at
  from fluid_case_activity_backfill candidate
  group by candidate.case_id
) evidence
where evidence.case_id = case_row.id;

do $$
declare
  v_case_id uuid;
begin
  for v_case_id in select distinct case_id from fluid_case_activity_backfill
  loop
    perform private.enqueue_case_reconciliation(v_case_id, 'backfill', 30, 0);
  end loop;
end;
$$;

revoke all on function private.resolve_operational_case_person() from public, anon, authenticated;
revoke all on function private.link_activity_case() from public, anon, authenticated;
revoke all on function private.link_activity_person_case() from public, anon, authenticated;
