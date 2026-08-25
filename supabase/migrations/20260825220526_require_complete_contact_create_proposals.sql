-- A high-confidence create proposal is only eligible when the entity details
-- are complete. The Hermes worker rejects incomplete proposals before the RPC;
-- this constraint is the transactional database backstop.

alter table public.signal_triage_decisions
  add constraint signal_triage_decisions_complete_create_check
  check (
    contact_disposition <> 'create'
    or (
      proposed_entity_type is not null
      and proposed_role_key is not null
      and nullif(btrim(proposed_display_name), '') is not null
    )
  );
