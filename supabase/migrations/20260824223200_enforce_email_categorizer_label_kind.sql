create or replace function public.enforce_email_categorizer_label_kind()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.agent_key = 'email-categorizer'
     and not exists (
       select 1
       from public.labels as label
       where label.id = new.label_id
         and label.kind = 'email'
     ) then
    raise exception 'email-categorizer can only assign email labels';
  end if;

  return new;
end;
$$;

drop trigger if exists signal_labels_enforce_email_categorizer_kind
on public.signal_labels;

create trigger signal_labels_enforce_email_categorizer_kind
before insert or update of label_id, agent_key
on public.signal_labels
for each row
execute function public.enforce_email_categorizer_label_kind();

revoke all on function public.enforce_email_categorizer_label_kind() from public;
grant execute on function public.enforce_email_categorizer_label_kind() to service_role;
