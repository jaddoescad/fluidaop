import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

type CsvRow = Record<string, string>;
type LifecycleRow = {
  sourceFile: string;
  sourceRow: number;
  externalKey: string;
  kind: 'lead_received' | 'appointment_scheduled' | 'proposal_sent' | 'deal_closed';
  email: string;
  phone: string;
  dealName: string;
  occurredAt: string;
  datePrecision: 'date' | 'datetime';
};

function parseCsv(input: string): CsvRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { record.push(field); field = ''; }
    else if (char === '\n') { record.push(field.replace(/\r$/, '')); records.push(record); record = []; field = ''; }
    else field += char;
  }
  if (field.length > 0 || record.length > 0) { record.push(field.replace(/\r$/, '')); records.push(record); }
  const [headers, ...rows] = records;
  return rows.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function localTimestamp(value: string): { value: string; precision: 'date' | 'datetime' } | null {
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})\s+(AM|PM))?$/i);
  if (!match) return null;
  const [, month, day, year, rawHour, minute, meridiem] = match;
  if (!rawHour) return { value: `${year}-${month}-${day}T12:00:00`, precision: 'date' };
  let hour = Number(rawHour) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  return { value: `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${minute}:00`, precision: 'datetime' };
}

function keyOf(file: string, row: number, kind: LifecycleRow['kind'], identity: string, at: string): string {
  const digest = createHash('sha256').update(`${file}\n${row}\n${kind}\n${identity}\n${at}`).digest('hex').slice(0, 32);
  return `dripjobs-report:${kind}:${digest}`;
}

function lifecycleRow(file: string, sourceRow: number, kind: LifecycleRow['kind'], row: CsvRow, dateColumn: string): LifecycleRow | null {
  const parsed = localTimestamp(row[dateColumn] ?? '');
  if (!parsed) return null;
  const email = normalizeEmail(row.Email ?? '');
  const phone = normalizePhone(row.Phone ?? '');
  const dealName = (row['Deal Name'] ?? `${row['First Name'] ?? ''} ${row['Last Name'] ?? ''}`).trim();
  if (!email && !phone) return null;
  return {
    sourceFile: basename(file), sourceRow, kind, email, phone, dealName,
    occurredAt: parsed.value, datePrecision: parsed.precision,
    externalKey: keyOf(basename(file), sourceRow, kind, email || phone, parsed.value),
  };
}

function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

const [leadsPath, proposalsPath, closedPath, outputPath = '/tmp/fluid-dripjobs-lifecycle.sql'] = process.argv.slice(2);
if (!leadsPath || !proposalsPath || !closedPath) {
  throw new Error('Usage: tsx scripts/importDripjobsLifecycleCsv.ts <leads.csv> <proposals.csv> <closed.csv> [output.sql]');
}

const rows: LifecycleRow[] = [];
parseCsv(readFileSync(resolve(leadsPath), 'utf8').replace(/^\uFEFF/, '')).forEach((row, index) => {
  const lead = lifecycleRow(leadsPath, index + 2, 'lead_received', row, 'Date Created');
  const appointment = lifecycleRow(leadsPath, index + 2, 'appointment_scheduled', row, 'Appt Date');
  if (lead) rows.push(lead);
  if (appointment) rows.push(appointment);
});
parseCsv(readFileSync(resolve(proposalsPath), 'utf8').replace(/^\uFEFF/, '')).forEach((row, index) => {
  const proposal = lifecycleRow(proposalsPath, index + 2, 'proposal_sent', row, 'Sent Date');
  if (proposal) rows.push(proposal);
});
parseCsv(readFileSync(resolve(closedPath), 'utf8').replace(/^\uFEFF/, '')).forEach((row, index) => {
  const closed = lifecycleRow(closedPath, index + 2, 'deal_closed', row, 'Date Accepted');
  if (closed) rows.push(closed);
});

const values = rows.map((row) => `(${[
  row.sourceFile, String(row.sourceRow), row.externalKey, row.kind, row.email, row.phone,
  row.dealName, row.occurredAt, row.datePrecision,
].map(quote).join(', ')})`).join(',\n');

const sql = `begin;
create temporary table lifecycle_import (
  source_file text not null, source_row integer not null, external_key text not null,
  lifecycle_kind text not null, normalized_email text, normalized_phone text,
  deal_name text, occurred_local timestamp not null, date_precision text not null
) on commit drop;
insert into lifecycle_import values
${values};

create temporary table lifecycle_resolved on commit drop as
select imported.*, candidate.deal_id
from lifecycle_import imported
left join lateral (
  select deal.deal_id
  from public.dripjobs_sales_deals deal
  where (imported.normalized_email <> '' and deal.normalized_email = imported.normalized_email)
     or (imported.normalized_phone <> '' and deal.normalized_phone = imported.normalized_phone)
  order by
    (imported.normalized_email <> '' and deal.normalized_email = imported.normalized_email
      and imported.normalized_phone <> '' and deal.normalized_phone = imported.normalized_phone) desc,
    (left(lower(regexp_replace(coalesce(deal.deal_name, ''), '[^a-z0-9]+', '', 'g')), 16)
      = left(lower(regexp_replace(imported.deal_name, '[^a-z0-9]+', '', 'g')), 16)) desc,
    case imported.lifecycle_kind
      when 'appointment_scheduled' then deal.deal_stage in ('Estimate Scheduled', 'Exterior Sales')
      when 'proposal_sent' then deal.deal_stage = 'Proposal(s) Sent'
      when 'deal_closed' then deal.archived_at is not null
      else deal.archived_at is null
    end desc,
    (deal.archived_at is null) desc,
    deal.last_seen_at desc,
    deal.deal_id
  limit 1
) candidate on true;

-- Preserve report-only leads as first-class historical deals instead of
-- silently dropping them. The deterministic id makes reruns idempotent.
insert into public.dripjobs_sales_deals (
  deal_id, source_document_id, source_view, sales_status, customer_name,
  email, phone, normalized_email, normalized_phone, deal_name, deal_stage,
  captured_at, source_sha256, combined_source_sha256, source_row_number,
  estimated_created_at, created_at_method, created_at_confidence,
  first_seen_at, last_seen_at, archived_at, metadata
)
select
  md5(resolved.external_key),
  (select source_document_id from public.dripjobs_sales_deals order by captured_at desc limit 1),
  'archived', 'Archived', resolved.deal_name,
  nullif(resolved.normalized_email, ''), nullif(resolved.normalized_phone, ''),
  nullif(resolved.normalized_email, ''), nullif(resolved.normalized_phone, ''),
  resolved.deal_name, 'Cold Leads',
  resolved.occurred_local at time zone 'America/Toronto',
  repeat(md5(resolved.external_key), 2), repeat(md5(resolved.external_key), 2),
  resolved.source_row,
  resolved.occurred_local at time zone 'America/Toronto',
  'report_import_created_date', 0.9,
  resolved.occurred_local at time zone 'America/Toronto',
  resolved.occurred_local at time zone 'America/Toronto', now(),
  jsonb_build_object('historicalReportOnly', true, 'sourceFile', resolved.source_file)
from lifecycle_resolved resolved
where resolved.lifecycle_kind = 'lead_received' and resolved.deal_id is null
on conflict (deal_id) do nothing;

-- Re-resolve every unmatched milestone after report-only leads exist. Date
-- boundaries keep repeat customers attached to the appropriate historical deal.
with matches as (
  select resolved.external_key, (
    select deal.deal_id
    from public.dripjobs_sales_deals deal
    where ((resolved.normalized_email <> '' and deal.normalized_email = resolved.normalized_email)
        or (resolved.normalized_phone <> '' and deal.normalized_phone = resolved.normalized_phone))
      and coalesce(deal.estimated_created_at, deal.first_seen_at)
        <= resolved.occurred_local at time zone 'America/Toronto' + interval '1 day'
    order by
      (resolved.normalized_email <> '' and deal.normalized_email = resolved.normalized_email
        and resolved.normalized_phone <> '' and deal.normalized_phone = resolved.normalized_phone) desc,
      (left(lower(regexp_replace(coalesce(deal.deal_name, ''), '[^a-z0-9]+', '', 'g')), 20)
        = left(lower(regexp_replace(resolved.deal_name, '[^a-z0-9]+', '', 'g')), 20)) desc,
      coalesce(deal.estimated_created_at, deal.first_seen_at) desc,
      deal.deal_id
    limit 1
  ) as deal_id
  from lifecycle_resolved resolved
  where resolved.deal_id is null
)
update lifecycle_resolved resolved
set deal_id = matches.deal_id
from matches
where matches.external_key = resolved.external_key and matches.deal_id is not null;

-- A legitimate report event can predate the available Sales List archive. Keep
-- it as a deterministic historical deal rather than losing the funnel event.
insert into public.dripjobs_sales_deals (
  deal_id, source_document_id, source_view, sales_status, customer_name,
  email, phone, normalized_email, normalized_phone, deal_name, deal_stage,
  captured_at, source_sha256, combined_source_sha256, source_row_number,
  estimated_created_at, created_at_method, created_at_confidence,
  first_seen_at, last_seen_at, archived_at, metadata
)
select
  md5(resolved.external_key),
  (select source_document_id from public.dripjobs_sales_deals order by captured_at desc limit 1),
  'archived', 'Archived', resolved.deal_name,
  nullif(resolved.normalized_email, ''), nullif(resolved.normalized_phone, ''),
  nullif(resolved.normalized_email, ''), nullif(resolved.normalized_phone, ''),
  resolved.deal_name,
  case resolved.lifecycle_kind
    when 'appointment_scheduled' then 'Estimate Scheduled'
    when 'proposal_sent' then 'Proposal(s) Sent'
    when 'deal_closed' then 'Proposal(s) Sent'
    else 'Cold Leads'
  end,
  resolved.occurred_local at time zone 'America/Toronto',
  repeat(md5(resolved.external_key), 2), repeat(md5(resolved.external_key), 2),
  resolved.source_row,
  resolved.occurred_local at time zone 'America/Toronto',
  'report_import_first_known_event', 0.7,
  resolved.occurred_local at time zone 'America/Toronto',
  resolved.occurred_local at time zone 'America/Toronto', now(),
  jsonb_build_object('historicalReportOnly', true, 'sourceFile', resolved.source_file)
from lifecycle_resolved resolved
where resolved.deal_id is null
on conflict (deal_id) do nothing;

update lifecycle_resolved resolved
set deal_id = md5(resolved.external_key)
where resolved.deal_id is null;

with lead_dates as (
  select deal_id, min(occurred_local at time zone 'America/Toronto') as occurred_at
  from lifecycle_resolved where lifecycle_kind = 'lead_received' and deal_id is not null
  group by deal_id
)
update public.dripjobs_sales_deals deal set
  estimated_created_at = lead.occurred_at,
  created_at_method = 'report_import_created_date',
  created_at_confidence = 0.9,
  updated_at = now()
from lead_dates lead where lead.deal_id = deal.deal_id;

insert into public.deal_milestone_events (
  workspace_key, deal_id, external_key, milestone_type, occurred_at,
  source, evidence_kind, metadata
)
select
  'ottawa-painters', resolved.deal_id, resolved.external_key,
  case resolved.lifecycle_kind
    when 'appointment_scheduled' then 'appointment_scheduled'
    when 'proposal_sent' then 'proposal_sent'
    when 'deal_closed' then 'deal_closed'
  end,
  resolved.occurred_local at time zone 'America/Toronto',
  'report_import', 'inferred',
  jsonb_build_object(
    'sourceFile', resolved.source_file, 'sourceRow', resolved.source_row,
    'datePrecision', resolved.date_precision, 'dealName', resolved.deal_name
  )
from lifecycle_resolved resolved
where resolved.lifecycle_kind <> 'lead_received' and resolved.deal_id is not null
on conflict (workspace_key, external_key) do update set
  deal_id = excluded.deal_id, milestone_type = excluded.milestone_type,
  occurred_at = excluded.occurred_at, source = excluded.source,
  evidence_kind = excluded.evidence_kind, metadata = excluded.metadata, updated_at = now();

select lifecycle_kind, count(*) as imported,
  count(*) filter (where deal_id is not null) as matched,
  count(*) filter (where deal_id is null) as unmatched
from lifecycle_resolved group by lifecycle_kind order by lifecycle_kind;
commit;
`;

writeFileSync(resolve(outputPath), sql);
console.log(JSON.stringify({
  output: resolve(outputPath),
  rows: rows.length,
  byKind: Object.fromEntries(
    (['lead_received', 'appointment_scheduled', 'proposal_sent', 'deal_closed'] as const)
      .map((kind) => [kind, rows.filter((row) => row.kind === kind).length]),
  ),
}));
