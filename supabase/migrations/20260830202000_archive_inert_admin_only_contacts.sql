-- Contacts the 2026-08-02 ottawa-painters-admin import created that DripJobs has
-- never heard of, carrying no activity and no deals. Archived rather than
-- deleted: inert is not the same as wrong, and archiving is reversible.
update public.people p
set status = 'archived', updated_at = now()
where p.status = 'active'
  and not exists (select 1 from public.person_sources ps
    where ps.person_id = p.id and ps.source_system in ('dripjobs','manual-employee-reconciliation'))
  and not exists (select 1 from public.activity_people ap where ap.person_id = p.id)
  and not exists (select 1 from public.dripjobs_sales_deals d where d.person_id = p.id);
