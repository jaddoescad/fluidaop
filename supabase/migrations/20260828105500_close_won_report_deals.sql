-- The accepted/Jobs Won report is authoritative over a stale active Sales List
-- snapshot. A won deal belongs in the closed funnel as of its accepted date.
with won as (
  select deal_id, max(occurred_at) as closed_at
  from public.deal_milestone_events
  where source = 'report_import'
    and milestone_type = 'deal_closed'
  group by deal_id
)
update public.dripjobs_sales_deals deal
set archived_at = coalesce(deal.archived_at, won.closed_at),
    updated_at = now(),
    metadata = deal.metadata || jsonb_build_object('archivedByWonReport', true)
from won
where deal.deal_id = won.deal_id
  and deal.archived_at is null;
