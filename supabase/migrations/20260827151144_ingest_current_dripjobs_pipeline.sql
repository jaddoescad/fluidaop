-- Ingest a complete active Sales List capture as one atomic snapshot. This is
-- intentionally service-only because the rows contain customer contact data.
create or replace function public.ingest_current_dripjobs_pipeline(
  p_rows jsonb,
  p_captured_at timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_document_id uuid := gen_random_uuid();
  v_row_count integer;
  v_distinct_deal_count integer;
  v_snapshot_sha256 text;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'DripJobs pipeline rows must be a JSON array';
  end if;

  select count(*), count(distinct item->>'dealId')
  into v_row_count, v_distinct_deal_count
  from jsonb_array_elements(p_rows) item;

  if v_row_count = 0 or v_row_count > 10000 then
    raise exception 'DripJobs pipeline snapshot contains an invalid row count: %', v_row_count;
  end if;

  if v_distinct_deal_count <> v_row_count then
    raise exception 'DripJobs pipeline snapshot contains duplicate deal IDs';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    where coalesce(item->>'dealId', '') !~ '^[0-9a-f]{30,}$'
       or btrim(coalesce(item->>'salesStatus', '')) = ''
       or btrim(coalesce(item->>'customerName', '')) = ''
       or btrim(coalesce(item->>'dealName', '')) = ''
       or btrim(coalesce(item->>'dealStage', '')) = ''
       or (
         item ? 'dealAmountCents'
         and jsonb_typeof(item->'dealAmountCents') <> 'number'
       )
       or coalesce((item->>'dealAmountCents')::numeric, 0) < 0
  ) then
    raise exception 'DripJobs pipeline snapshot contains an invalid deal row';
  end if;

  v_snapshot_sha256 := encode(digest(p_rows::text, 'sha256'), 'hex');

  insert into public.documents (
    id,
    kind,
    original_filename,
    mime_type,
    size_bytes,
    content_sha256,
    source_url,
    captured_at,
    metadata
  ) values (
    v_document_id,
    'dripjobs_sales_list_snapshot',
    'Sales_List_active.json',
    'application/json',
    octet_length(p_rows::text),
    v_snapshot_sha256,
    'https://app.dripjobs.com/saleslist',
    p_captured_at,
    jsonb_build_object(
      'source_type', 'fluid_live_dripjobs_saleslist_sync_v1',
      'source_view', 'active',
      'created_date_filter', 'last_90_days',
      'row_count', v_row_count
    )
  );

  insert into public.dripjobs_sales_deals (
    deal_id,
    dripjobs_contact_id,
    source_document_id,
    source_view,
    sales_status,
    label,
    customer_name,
    email,
    phone,
    normalized_email,
    normalized_phone,
    raw_source,
    normalized_channel,
    deal_name,
    deal_stage,
    deal_amount_cents,
    last_change,
    deal_age,
    salesperson,
    captured_at,
    source_sha256,
    combined_source_sha256,
    source_row_number,
    first_seen_at,
    last_seen_at,
    metadata
  )
  select
    item->>'dealId',
    nullif(item->>'dripjobsContactId', ''),
    v_document_id,
    'active',
    btrim(item->>'salesStatus'),
    nullif(btrim(coalesce(item->>'label', '')), ''),
    btrim(item->>'customerName'),
    nullif(btrim(coalesce(item->>'email', '')), ''),
    nullif(btrim(coalesce(item->>'phone', '')), ''),
    nullif(lower(btrim(coalesce(item->>'email', ''))), ''),
    nullif(regexp_replace(coalesce(item->>'phone', ''), '[^0-9]', '', 'g'), ''),
    nullif(btrim(coalesce(item->>'source', '')), ''),
    case
      when lower(coalesce(item->>'source', '')) like 'meta%' then 'paid_social'
      when lower(coalesce(item->>'source', '')) = 'facebook' then 'organic_social'
      when lower(coalesce(item->>'source', '')) in ('word of mouth', 'referral') then 'referral'
      when lower(coalesce(item->>'source', '')) like '%phone%' then 'phone'
      when lower(coalesce(item->>'source', '')) = 'google' then 'organic_search'
      when coalesce(item->>'source', '') like '/%' or lower(coalesce(item->>'source', '')) = 'website' then 'website'
      else 'unknown'
    end,
    btrim(item->>'dealName'),
    btrim(item->>'dealStage'),
    coalesce((item->>'dealAmountCents')::bigint, 0),
    nullif(btrim(coalesce(item->>'lastChange', '')), ''),
    nullif(btrim(coalesce(item->>'dealAge', '')), ''),
    nullif(btrim(coalesce(item->>'salesperson', '')), ''),
    p_captured_at,
    encode(digest(item::text, 'sha256'), 'hex'),
    v_snapshot_sha256,
    ordinal::integer,
    p_captured_at,
    p_captured_at,
    jsonb_build_object(
      'source_type', 'fluid_live_dripjobs_saleslist_sync_v1',
      'source_row_number', ordinal
    )
  from jsonb_array_elements(p_rows) with ordinality rows(item, ordinal)
  on conflict (deal_id) do update set
    dripjobs_contact_id = excluded.dripjobs_contact_id,
    source_document_id = excluded.source_document_id,
    source_view = excluded.source_view,
    sales_status = excluded.sales_status,
    label = excluded.label,
    customer_name = excluded.customer_name,
    email = excluded.email,
    phone = excluded.phone,
    normalized_email = excluded.normalized_email,
    normalized_phone = excluded.normalized_phone,
    raw_source = excluded.raw_source,
    normalized_channel = excluded.normalized_channel,
    deal_name = excluded.deal_name,
    deal_stage = excluded.deal_stage,
    deal_amount_cents = excluded.deal_amount_cents,
    last_change = excluded.last_change,
    deal_age = excluded.deal_age,
    salesperson = excluded.salesperson,
    captured_at = excluded.captured_at,
    source_sha256 = excluded.source_sha256,
    combined_source_sha256 = excluded.combined_source_sha256,
    source_row_number = excluded.source_row_number,
    first_seen_at = least(public.dripjobs_sales_deals.first_seen_at, excluded.first_seen_at),
    last_seen_at = excluded.last_seen_at,
    metadata = public.dripjobs_sales_deals.metadata || excluded.metadata,
    updated_at = now();

  return jsonb_build_object(
    'count', v_row_count,
    'capturedAt', p_captured_at,
    'sourceDocumentId', v_document_id,
    'snapshotSha256', v_snapshot_sha256
  );
end;
$$;

revoke all on function public.ingest_current_dripjobs_pipeline(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_current_dripjobs_pipeline(jsonb, timestamptz)
  to service_role;

comment on function public.ingest_current_dripjobs_pipeline(jsonb, timestamptz) is
  'Validates and atomically ingests one complete active DripJobs Sales List snapshot. Service role only.';
