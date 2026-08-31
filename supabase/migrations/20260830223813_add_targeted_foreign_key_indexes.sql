-- Postgres does not index the referencing side of a foreign key automatically.
-- These are the three live FK paths reported by the database advisor and used
-- by joins or parent-row maintenance. Names are stable and creation is safe to
-- repeat on a restored schema.

create index if not exists jobs_contact_id_idx
  on public.jobs (contact_id);

create index if not exists dripjobs_sales_deals_source_document_id_idx
  on public.dripjobs_sales_deals (source_document_id);

create index if not exists signal_recommendations_agent_run_id_idx
  on public.signal_recommendations (agent_run_id);
