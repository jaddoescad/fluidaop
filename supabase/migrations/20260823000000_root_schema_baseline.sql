-- Provenance: generated with `supabase migration new root_schema_baseline` on
-- 2026-08-30, then deliberately assigned a pre-chain version so a clean reset
-- creates the legacy roots before 20260823180310 references them.
--
-- This is a compatibility baseline, not a reconstruction of the 119 missing
-- historical migration bodies. Every statement is idempotent against the
-- connected Fluid schema observed on 2026-08-30. Existing tables, policies,
-- and private.is_manager() are left intact.

create schema if not exists private;

create table if not exists public.contacts (
  id uuid primary key,
  kind text not null,
  dripjobs_contact_id text unique,
  name text not null,
  email text,
  phone text,
  normalized_email text,
  normalized_phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_kind_check
    check (kind in ('customer', 'contractor', 'supplier', 'other'))
);

create table if not exists public.employees (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_role_check
    check (role in ('admin', 'manager', 'painter'))
);

create table if not exists public.leads (
  id uuid primary key,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  dripjobs_deal_id text unique,
  status text not null,
  pipeline_stage_raw text,
  source text,
  normalized_channel text not null default 'unknown',
  address text,
  city text,
  province text,
  postal_code text,
  estimate_scheduled_on date,
  estimate_appointment_on date,
  is_interior boolean not null default false,
  is_exterior boolean not null default false,
  is_cabinets boolean not null default false,
  created_at timestamptz not null,
  captured_at timestamptz not null,
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  dripjobs_sales_deal_id text,
  marketing_eligible boolean not null default true,
  marketing_exclusion_reason text,
  constraint leads_status_check check (status in (
    'new', 'contacted', 'estimate_scheduled', 'estimated',
    'proposal_sent', 'won', 'lost', 'cancelled'
  )),
  constraint leads_marketing_exclusion_reason_check check (
    (marketing_eligible and marketing_exclusion_reason is null)
    or (
      not marketing_eligible
      and marketing_exclusion_reason in (
        'test', 'vendor_test', 'migration_batch', 'legacy_companycam', 'manual'
      )
    )
  )
);

create table if not exists public.jobs (
  id uuid primary key,
  contact_id uuid references public.contacts(id) on delete restrict,
  lead_id uuid references public.leads(id) on delete restrict,
  accepted_quote_id uuid unique,
  name text not null,
  status text not null,
  contract_amount_cents bigint not null default 0,
  address_line_1 text,
  address_line_2 text,
  city text,
  province text,
  postal_code text,
  country text not null default 'CA',
  formatted_address text,
  latitude double precision,
  longitude double precision,
  companycam_project_ids text[] not null default '{}',
  scheduled_on date,
  started_on date,
  completed_on date,
  archived_at timestamptz,
  is_feed_visible boolean not null default true,
  source text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  production_month date,
  scheduled_end_on date,
  constraint jobs_status_check check (status in (
    'scheduled', 'active', 'completed', 'cancelled', 'archived'
  )),
  constraint jobs_production_month_first_day_check check (
    production_month is null
    or production_month = date_trunc('month', production_month::timestamptz)::date
  ),
  constraint jobs_schedule_range_check check (
    scheduled_on is null or scheduled_end_on is null or scheduled_end_on >= scheduled_on
  )
);

create table if not exists public.documents (
  id uuid primary key,
  kind text not null,
  original_filename text not null,
  mime_type text,
  size_bytes bigint,
  content_sha256 text,
  storage_bucket text,
  storage_path text,
  source_url text,
  captured_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- This is the pre-local-chain shape. Stage and canonical-person columns are
-- intentionally omitted because later checked-in migrations add them.
create table if not exists public.dripjobs_sales_deals (
  deal_id text primary key,
  dripjobs_contact_id text,
  lead_id uuid references public.leads(id) on delete set null,
  source_document_id uuid not null references public.documents(id) on delete restrict,
  source_view text not null,
  sales_status text not null,
  label text,
  customer_name text not null,
  email text,
  phone text,
  normalized_email text,
  normalized_phone text,
  raw_source text,
  normalized_channel text not null default 'unknown',
  deal_name text not null,
  deal_stage text not null,
  deal_amount_cents bigint not null default 0,
  last_change text,
  deal_age text,
  salesperson text,
  estimated_created_at timestamptz,
  created_at_method text,
  created_at_confidence numeric(4, 3),
  captured_at timestamptz not null,
  source_sha256 text not null,
  combined_source_sha256 text not null,
  source_row_number integer not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dripjobs_sales_deals_source_view_check
    check (source_view in ('active', 'archived')),
  constraint dripjobs_sales_deals_deal_amount_cents_check
    check (deal_amount_cents >= 0),
  constraint dripjobs_sales_deals_created_at_confidence_check
    check (created_at_confidence is null or created_at_confidence between 0 and 1),
  constraint dripjobs_sales_deals_source_sha256_check
    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint dripjobs_sales_deals_combined_source_sha256_check
    check (combined_source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint dripjobs_sales_deals_source_row_number_check
    check (source_row_number > 0)
);

create index if not exists contacts_normalized_identity_idx
  on public.contacts (normalized_email, normalized_phone)
  where normalized_email is not null and normalized_phone is not null;
create index if not exists leads_contact_idx on public.leads (contact_id);
create unique index if not exists leads_dripjobs_sales_deal_id_uidx
  on public.leads (dripjobs_sales_deal_id)
  where dripjobs_sales_deal_id is not null;
create index if not exists leads_marketing_eligible_created_idx
  on public.leads (created_at desc) where marketing_eligible;
create index if not exists leads_search_idx
  on public.leads using gin (
    to_tsvector('simple', coalesce(address, '') || ' ' || coalesce(postal_code, ''))
  );
create index if not exists leads_stage_idx
  on public.leads (status, captured_at desc);
create index if not exists jobs_companycam_ids_idx
  on public.jobs using gin (companycam_project_ids);
create index if not exists jobs_lead_idx on public.jobs (lead_id);
create index if not exists jobs_production_month_idx on public.jobs (production_month);
create index if not exists jobs_search_idx
  on public.jobs using gin (
    to_tsvector(
      'simple',
      coalesce(name, '') || ' ' || coalesce(formatted_address, '') || ' '
        || coalesce(city, '') || ' ' || coalesce(postal_code, '')
    )
  );
create index if not exists jobs_status_idx
  on public.jobs (status, updated_at desc);
create unique index if not exists documents_gmail_contractor_invoice_sha256_uidx
  on public.documents (content_sha256)
  where content_sha256 is not null
    and metadata ->> 'source' = 'gmail_contractor_invoice';
create index if not exists dripjobs_sales_deals_channel_created_idx
  on public.dripjobs_sales_deals (normalized_channel, estimated_created_at desc);
create index if not exists dripjobs_sales_deals_contact_idx
  on public.dripjobs_sales_deals (dripjobs_contact_id)
  where dripjobs_contact_id is not null;
create index if not exists dripjobs_sales_deals_lead_idx
  on public.dripjobs_sales_deals (lead_id)
  where lead_id is not null;
create index if not exists dripjobs_sales_deals_view_stage_idx
  on public.dripjobs_sales_deals (source_view, deal_stage);

alter table public.contacts enable row level security;
alter table public.employees enable row level security;
alter table public.leads enable row level security;
alter table public.jobs enable row level security;
alter table public.documents enable row level security;
alter table public.dripjobs_sales_deals enable row level security;

do $baseline_manager$
begin
  if to_regprocedure('private.is_manager()') is null then
    execute $definition$
      create function private.is_manager()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select exists (
          select 1
          from public.employees employee
          where employee.id = auth.uid()
            and employee.is_active
            and employee.role in ('admin', 'manager')
        )
      $body$
    $definition$;
  end if;
end
$baseline_manager$;

do $baseline_policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.contacts'::regclass and polname = 'authenticated_read'
  ) then
    create policy authenticated_read on public.contacts
      for select to authenticated using (auth.uid() is not null);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.employees'::regclass and polname = 'authenticated_read'
  ) then
    create policy authenticated_read on public.employees
      for select to authenticated using (auth.uid() is not null);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.leads'::regclass and polname = 'authenticated_read'
  ) then
    create policy authenticated_read on public.leads
      for select to authenticated using (auth.uid() is not null);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.jobs'::regclass and polname = 'authenticated_read'
  ) then
    create policy authenticated_read on public.jobs
      for select to authenticated using (auth.uid() is not null);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.documents'::regclass and polname = 'manager_read'
  ) then
    create policy manager_read on public.documents
      for select to authenticated using (private.is_manager());
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.dripjobs_sales_deals'::regclass
      and polname = 'authenticated_read'
  ) then
    create policy authenticated_read on public.dripjobs_sales_deals
      for select to authenticated using ((select auth.uid()) is not null);
  end if;
end
$baseline_policies$;

revoke all on table public.contacts, public.employees, public.leads,
  public.jobs, public.documents from anon, authenticated;
grant select on table public.contacts, public.employees, public.leads,
  public.jobs, public.documents to authenticated;
grant all on table public.contacts, public.employees, public.leads,
  public.jobs, public.documents to service_role;

-- These broad grants reproduce the observed legacy Data API contract. Their
-- behavior is unchanged here; authorization policy hardening is out of scope.
grant all on table public.dripjobs_sales_deals to anon, authenticated, service_role;

grant usage on schema private to authenticated, service_role;
revoke all on function private.is_manager() from public, anon;
grant execute on function private.is_manager() to authenticated, service_role;

comment on table public.contacts is
  'Fluid-owned local mirror of business contacts. This table is independent from the Ottawa Painters Supabase project.';
comment on table public.employees is
  'Fluid-owned authorization mirror for manager access. This table is independent from the Ottawa Painters Supabase project.';
comment on table public.leads is
  'Fluid-owned local mirror of lead records. This table is independent from the Ottawa Painters Supabase project.';
comment on table public.jobs is
  'Fluid-owned local mirror of operational jobs. This table is independent from the Ottawa Painters Supabase project.';
comment on table public.documents is
  'Fluid-owned evidence and snapshot records. This table is independent from the Ottawa Painters Supabase project.';
comment on table public.dripjobs_sales_deals is
  'Fluid-owned DripJobs pipeline mirror. This table is independent from the Ottawa Painters Supabase project.';
