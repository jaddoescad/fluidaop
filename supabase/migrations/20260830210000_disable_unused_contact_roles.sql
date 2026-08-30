-- Applicant, Contractor, Supplier, Painter and Other have no people in this
-- workspace, so they only widen the Contacts filter bar. contact-roles already
-- filters on enabled, so disabling is enough — and is reversible the moment
-- someone is actually given one of these roles.
--
-- Customer is deliberately left enabled: it covers 1,233 active contacts.
update public.contact_role_definitions
set enabled = false, updated_at = now()
where workspace_key = 'ottawa-painters'
  and key in ('applicant', 'contractor', 'supplier', 'painter', 'other')
  and not exists (
    select 1 from public.person_roles pr
    join public.people p on p.id = pr.person_id and p.status = 'active'
    where pr.role_key = contact_role_definitions.key
  );
