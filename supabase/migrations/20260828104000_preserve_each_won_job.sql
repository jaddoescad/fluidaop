-- A DripJobs Jobs Won report row is a won job, even when multiple rows were
-- previously collapsed onto one Sales List deal. Preserve each report row as a
-- separate historical deal card so the Closed funnel reconciles to the report.
with ranked_closures as (
  select
    milestone.*,
    row_number() over (partition by milestone.deal_id order by milestone.occurred_at, milestone.id) as deal_rank
  from public.deal_milestone_events milestone
  where milestone.source = 'report_import'
    and milestone.milestone_type = 'deal_closed'
),
duplicates as (
  select
    closure.*,
    md5(closure.external_key) as historical_deal_id
  from ranked_closures closure
  where closure.deal_rank > 1
),
created_deals as (
  insert into public.dripjobs_sales_deals (
    deal_id, dripjobs_contact_id, lead_id, source_document_id, source_view,
    sales_status, label, customer_name, email, phone, normalized_email,
    normalized_phone, raw_source, normalized_channel, deal_name, deal_stage,
    deal_amount_cents, last_change, deal_age, salesperson,
    estimated_created_at, created_at_method, created_at_confidence, captured_at,
    source_sha256, combined_source_sha256, source_row_number, first_seen_at,
    last_seen_at, metadata, stage_entered_at, stage_observed_at,
    last_active_snapshot_at, archived_at, person_id, person_match_method,
    person_linked_at
  )
  select
    duplicate.historical_deal_id, source.dripjobs_contact_id, source.lead_id,
    source.source_document_id, 'archived', 'Archived', source.label,
    source.customer_name, source.email, source.phone, source.normalized_email,
    source.normalized_phone, source.raw_source, source.normalized_channel,
    coalesce(nullif(duplicate.metadata->>'dealName', ''), source.deal_name),
    'Proposal(s) Sent', source.deal_amount_cents, source.last_change,
    source.deal_age, source.salesperson,
    least(coalesce(source.estimated_created_at, duplicate.occurred_at), duplicate.occurred_at),
    'report_import_won_job', 0.9, duplicate.occurred_at,
    repeat(md5(duplicate.external_key), 2), repeat(md5(duplicate.external_key), 2),
    coalesce((duplicate.metadata->>'sourceRow')::integer, source.source_row_number),
    least(source.first_seen_at, duplicate.occurred_at), duplicate.occurred_at,
    source.metadata || jsonb_build_object(
      'historicalReportOnly', true,
      'wonJobExternalKey', duplicate.external_key,
      'splitFromDealId', source.deal_id
    ),
    source.stage_entered_at, source.stage_observed_at, null, duplicate.occurred_at,
    source.person_id, source.person_match_method, now()
  from duplicates duplicate
  join public.dripjobs_sales_deals source on source.deal_id = duplicate.deal_id
  on conflict (deal_id) do nothing
  returning deal_id
)
update public.deal_milestone_events milestone
set deal_id = duplicate.historical_deal_id,
    updated_at = now()
from duplicates duplicate
where milestone.id = duplicate.id;

-- Copy appointment evidence to split won-job cards when the original matched
-- deal had one. This preserves the with/without-appointment conversion split.
insert into public.deal_milestone_events (
  workspace_key, deal_id, external_key, milestone_type, occurred_at,
  source, evidence_kind, metadata
)
select
  closing.workspace_key,
  closing.deal_id,
  'split:' || closing.deal_id || ':' || appointment.external_key,
  'appointment_scheduled', appointment.occurred_at,
  appointment.source, appointment.evidence_kind,
  appointment.metadata || jsonb_build_object('copiedForWonJobSplit', true)
from public.deal_milestone_events closing
join public.dripjobs_sales_deals split_deal
  on split_deal.deal_id = closing.deal_id
 and split_deal.created_at_method = 'report_import_won_job'
join public.deal_milestone_events appointment
  on appointment.deal_id = split_deal.metadata->>'splitFromDealId'
 and appointment.milestone_type = 'appointment_scheduled'
where closing.milestone_type = 'deal_closed'
on conflict (workspace_key, external_key) do nothing;
