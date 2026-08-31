begin;

do $$
declare
  call_activity_id bigint;
begin
  insert into public.activities (
    workspace_key, source, account_phone, external_id, event_type, direction,
    subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'quo', '+16135550992', 'AC_quo_content_fixture',
    'call.completed', 'outbound', 'Outbound call', 'completed', now()
  ) returning id into call_activity_id;

  insert into public.activity_call_recordings (
    activity_id, workspace_key, provider_call_id, status, recordings,
    attempt_count, last_attempted_at, last_http_status
  ) values (
    call_activity_id, 'ottawa-painters', 'AC_quo_content_fixture', 'available',
    '[{"id":"CR_fixture","url":"https://media.quo.com/fixture.mp3","duration":12}]'::jsonb,
    1, now(), 200
  );

  insert into public.activity_call_summaries (
    activity_id, workspace_key, provider_call_id, status, summary, next_steps,
    attempt_count, last_attempted_at, last_http_status
  ) values (
    call_activity_id, 'ottawa-painters', 'AC_quo_content_fixture', 'available',
    '["Customer requested an estimate."]'::jsonb,
    '["Send the estimate."]'::jsonb,
    1, now(), 200
  );

  if not exists (
    select 1 from public.activity_call_recordings
    where activity_id = call_activity_id and jsonb_array_length(recordings) = 1
  ) then
    raise exception 'Quo recording fixture was not stored';
  end if;

  if not exists (
    select 1 from public.activity_call_summaries
    where activity_id = call_activity_id
      and summary ->> 0 = 'Customer requested an estimate.'
      and next_steps ->> 0 = 'Send the estimate.'
  ) then
    raise exception 'Quo summary fixture was not stored';
  end if;

  if has_table_privilege('anon', 'public.activity_call_recordings', 'select')
     or has_table_privilege('authenticated', 'public.activity_call_recordings', 'select')
     or has_table_privilege('anon', 'public.activity_call_summaries', 'select')
     or has_table_privilege('authenticated', 'public.activity_call_summaries', 'select') then
    raise exception 'Private Quo call content is browser-readable';
  end if;
end;
$$;

rollback;
