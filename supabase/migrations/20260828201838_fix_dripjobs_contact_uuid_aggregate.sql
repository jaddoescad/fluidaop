-- PostgreSQL has no built-in min(uuid). Reinstall the importer with the
-- canonical text aggregate/cast used by clean database rebuilds.
do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.ingest_dripjobs_contact_chat_messages(text,text,text,text,jsonb)'::regprocedure
  ) into v_definition;

  v_definition := replace(
    v_definition,
    'min(deal.person_id)',
    'min(deal.person_id::text)::uuid'
  );

  execute v_definition;
end;
$$;
