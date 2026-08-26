create policy person_merge_audit_service_role_read
on private.person_merge_audit
for select
to service_role
using (true);
