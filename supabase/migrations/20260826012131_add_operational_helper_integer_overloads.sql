-- PL/pgSQL integer literals resolve as integer, while these helpers persist
-- bounded smallint columns. Keep the strict storage types and expose explicit
-- internal overloads so calls remain unambiguous on every supported Postgres.
create or replace function private.record_case_fact(
  p_workspace_key text,
  p_case_id uuid,
  p_fact_key text,
  p_fact_value jsonb,
  p_authority_rank integer,
  p_source_type text,
  p_source_ref text,
  p_effective_at timestamptz,
  p_observed_at timestamptz
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select private.record_case_fact(
    p_workspace_key,
    p_case_id,
    p_fact_key,
    p_fact_value,
    p_authority_rank::smallint,
    p_source_type,
    p_source_ref,
    p_effective_at,
    p_observed_at,
    1::numeric,
    '{}'::jsonb
  )
$$;

create or replace function private.enqueue_case_reconciliation(
  p_case_id uuid,
  p_queue_source text,
  p_priority integer,
  p_debounce_seconds integer
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select private.enqueue_case_reconciliation(
    p_case_id,
    p_queue_source,
    p_priority::smallint,
    p_debounce_seconds
  )
$$;

revoke all on function private.record_case_fact(text, uuid, text, jsonb, integer, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function private.enqueue_case_reconciliation(uuid, text, integer, integer)
  from public, anon, authenticated;
