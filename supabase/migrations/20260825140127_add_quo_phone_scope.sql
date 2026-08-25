create table public.quo_phone_scopes (
  connection_id text not null,
  phone_number_id text not null,
  phone_number_e164 text not null,
  label text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (connection_id, phone_number_id),
  constraint quo_phone_scopes_e164_check check (phone_number_e164 ~ '^\+[1-9][0-9]{6,14}$')
);

alter table public.quo_phone_scopes enable row level security;

revoke all on table public.quo_phone_scopes from anon, authenticated;
grant select, insert, update, delete on table public.quo_phone_scopes to service_role;

create index quo_phone_scopes_active_number_idx
  on public.quo_phone_scopes (phone_number_e164)
  where active;
