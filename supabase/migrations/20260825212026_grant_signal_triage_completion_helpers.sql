-- The public completion RPC runs as service_role and delegates its validated
-- contact decision to these private helpers. Keep browser roles revoked while
-- allowing the server-only completion transaction to execute end to end.
grant execute on function private.upsert_contact_suggestion(
  text,
  uuid,
  bigint,
  uuid,
  text,
  text,
  text,
  text,
  numeric,
  text,
  jsonb,
  integer
) to service_role;

grant execute on function private.apply_signal_triage_contact_decision(
  bigint,
  uuid,
  integer,
  text,
  text,
  text,
  text,
  numeric,
  text,
  jsonb
) to service_role;
