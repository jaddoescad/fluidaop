-- Conflict suggestions are snapshots, not live queries, so merging the duplicate
-- people did not clear the rows reporting them. Dismissed the 200 whose
-- identifier is now claimed by at most one person; 25 real conflicts remain.
update public.contact_suggestions cs
set status = 'dismissed', resolved_action = 'link', resolved_at = now(), updated_at = now()
where cs.status = 'pending' and cs.suggestion_type = 'conflict'
  and (select count(distinct pc.person_id) from public.person_identity_claims pc
       where pc.identity_id = cs.identity_id and pc.active) <= 1;
