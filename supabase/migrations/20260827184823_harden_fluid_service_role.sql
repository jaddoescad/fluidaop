-- The operational-context Edge Function is the only external caller of this
-- private SECURITY DEFINER routine. Keep it unavailable to public API roles.
revoke all on function private.refresh_operational_case(uuid, boolean) from public;
revoke all on function private.refresh_operational_case(uuid, boolean) from anon;
revoke all on function private.refresh_operational_case(uuid, boolean) from authenticated;

grant usage on schema private to service_role;
grant execute on function private.refresh_operational_case(uuid, boolean) to service_role;
