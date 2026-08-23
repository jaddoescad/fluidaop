create policy gmail_sync_state_no_client_access
  on public.gmail_sync_state
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on policy gmail_sync_state_no_client_access on public.gmail_sync_state is
  'OAuth sync cursors and errors are server-only; browser roles are always denied.';
