-- A parser upgrade may bump an Activity revision. Keep an explicit human
-- dismissal or accepted Action attached to that revision instead of allowing
-- the read model to lose it, while legacy machine decisions still reopen.
create or replace function private.ensure_signal_review_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_performed boolean;
begin
  if new.source not in ('gmail', 'quo') then return new; end if;
  v_performed := new.direction = 'outbound'
    or private.signal_has_later_outbound(new.id);

  insert into public.signal_review_states (
    workspace_key, activity_id, input_revision, status, resolution,
    pending_recommendation_count, reviewed_by, reviewed_at, updated_at
  ) values (
    new.workspace_key, new.id, new.recommendation_revision,
    case when v_performed then 'settled' else 'pending' end,
    case when v_performed then 'performed_external' else null end,
    0,
    case when v_performed then 'provider:outbound' else null end,
    case when v_performed then now() else null end,
    now()
  ) on conflict (activity_id) do update
  set workspace_key = excluded.workspace_key,
      input_revision = excluded.input_revision,
      status = case
        when public.signal_review_states.resolution in ('no_action', 'action_created')
          then public.signal_review_states.status
        else excluded.status
      end,
      resolution = case
        when public.signal_review_states.resolution in ('no_action', 'action_created')
          then public.signal_review_states.resolution
        else excluded.resolution
      end,
      pending_recommendation_count = case
        when public.signal_review_states.resolution in ('no_action', 'action_created')
          then public.signal_review_states.pending_recommendation_count
        else excluded.pending_recommendation_count
      end,
      reviewed_by = case
        when public.signal_review_states.resolution in ('no_action', 'action_created')
          then public.signal_review_states.reviewed_by
        else excluded.reviewed_by
      end,
      reviewed_at = case
        when public.signal_review_states.resolution in ('no_action', 'action_created')
          then public.signal_review_states.reviewed_at
        else excluded.reviewed_at
      end,
      updated_at = excluded.updated_at
  where public.signal_review_states.input_revision <> excluded.input_revision
    or (
      public.signal_review_states.status = 'settled'
      and public.signal_review_states.resolution in ('none_required', 'shadow_only')
    );
  return new;
end;
$$;

revoke all on function private.ensure_signal_review_state()
  from public, anon, authenticated;
grant execute on function private.ensure_signal_review_state()
  to service_role;
