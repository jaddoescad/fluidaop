import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const WORKSPACE_KEY = 'ottawa-painters';
const BATCH_SIZE = 100;
const QUO_METRICS_TIME_ZONE = 'America/Los_Angeles';

type CsvRow = Record<string, string>;

type MetricRow = {
  eventKey: string;
  rowFingerprint: string;
  sourceRowNumber: number;
  type: 'message' | 'call' | 'voicemail';
  direction: 'inbound' | 'outbound';
  status: string;
  statusDetails: string | null;
  occurredAt: string;
  updatedAt: string | null;
  answeredAt: string | null;
  deletedAt: string | null;
  durationSeconds: number | null;
  accountPhone: string;
  actorPhone: string;
  fromPhone: string;
  toPhones: string[];
  phoneNumberLabel: string | null;
  belongsTo: string | null;
  createdBy: string | null;
  answeredBy: string | null;
  userId: string | null;
};

function headerKey(value: string): string {
  return value.trim().replace(/^\uFEFF/, '');
}

function parseCsv(text: string): CsvRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field === '') quoted = true;
    else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      field = '';
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
    } else field += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  record.push(field);
  if (record.some((value) => value.trim())) records.push(record);
  const rawHeaders = records.shift();
  if (!rawHeaders) throw new Error('CSV has no header row');
  const headers = rawHeaders.map(headerKey);
  const required = [
    'answeredAtPT', 'answeredBy', 'belongsTo', 'createdAtPT', 'createdBy',
    'deletedAtPT', 'direction', 'duration', 'from', 'phoneNumberId', 'status',
    'statusDetails', 'to', 'type', 'updatedAtPT', 'userId',
  ];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) throw new Error(`Not a Quo Metrics export; missing ${missing.join(', ')}`);
  return records.map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index]?.trim() ?? '']),
  ));
}

function e164(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  return null;
}

function phoneList(value: string): string[] {
  return [...new Set(value.split(',').map(e164).filter((phone): phone is string => phone !== null))];
}

function nullable(value: string): string | null {
  const cleaned = value.trim();
  return cleaned || null;
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(date).flatMap((part) =>
    part.type === 'literal' ? [] : [[part.type, Number(part.value)]],
  ));
}

function quoPtTimestamp(value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned) return null;
  const match = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i);
  if (!match) throw new Error(`Invalid Quo PT timestamp: ${cleaned}`);
  const [, rawMonth, rawDay, rawYear, rawHour, rawMinute, rawSecond, meridiem] = match;
  let hour = Number(rawHour) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  const targetUtc = Date.UTC(
    Number(rawYear), Number(rawMonth) - 1, Number(rawDay),
    hour, Number(rawMinute), Number(rawSecond),
  );
  let candidate = targetUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedParts(new Date(candidate), QUO_METRICS_TIME_ZONE);
    const renderedUtc = Date.UTC(
      parts.year, parts.month - 1, parts.day,
      parts.hour, parts.minute, parts.second,
    );
    const adjustment = targetUtc - renderedUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(candidate).toISOString();
}

function durationSeconds(value: string): number | null {
  const cleaned = value.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid Quo duration: ${cleaned}`);
  return Math.round(parsed);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rowFingerprint(row: CsvRow): string {
  return sha256(Object.keys(row).sort().map((key) => `${key}\0${row[key] ?? ''}`).join('\0'));
}

function parseMetrics(text: string): MetricRow[] {
  const rows = parseCsv(text);
  const normalized = rows.map((row, index) => {
    const type = row.type.toLowerCase();
    const rawDirection = row.direction.toLowerCase();
    const status = row.status.toLowerCase();
    if (!['message', 'call', 'voicemail'].includes(type)) {
      throw new Error(`Unsupported Quo metric type on row ${index + 2}: ${row.type}`);
    }
    if (!['incoming', 'outgoing'].includes(rawDirection)) {
      throw new Error(`Unsupported Quo direction on row ${index + 2}: ${row.direction}`);
    }
    if (!status) throw new Error(`Missing Quo status on row ${index + 2}`);
    const occurredAt = quoPtTimestamp(row.createdAtPT);
    const fromPhone = e164(row.from);
    const toPhones = phoneList(row.to);
    if (!occurredAt || !fromPhone || toPhones.length === 0) {
      throw new Error(`Missing timestamp or participant on Quo row ${index + 2}`);
    }
    return {
      row,
      index,
      type: type as MetricRow['type'],
      direction: rawDirection === 'incoming' ? 'inbound' as const : 'outbound' as const,
      status,
      occurredAt,
      fromPhone,
      toPhones,
      phoneNumberLabel: nullable(row.phoneNumberId) ?? '(unlabelled)',
    };
  });

  const lineCandidates = new Map<string, Map<string, number>>();
  for (const row of normalized) {
    const candidates = lineCandidates.get(row.phoneNumberLabel) ?? new Map<string, number>();
    if (row.direction === 'outbound') {
      candidates.set(row.fromPhone, (candidates.get(row.fromPhone) ?? 0) + 100);
    } else {
      for (const phone of row.toPhones) candidates.set(phone, (candidates.get(phone) ?? 0) + 1);
    }
    lineCandidates.set(row.phoneNumberLabel, candidates);
  }
  const accountByLabel = new Map<string, string>();
  for (const [label, candidates] of lineCandidates) {
    const selected = [...candidates.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (!selected) throw new Error(`Unable to infer the Quo phone number for ${label}`);
    accountByLabel.set(label, selected);
  }

  const occurrences = new Map<string, number>();
  return normalized.map((item) => {
    const accountPhone = accountByLabel.get(item.phoneNumberLabel) as string;
    if (item.direction === 'inbound' && !item.toPhones.includes(accountPhone)) {
      throw new Error(`Quo row ${item.index + 2} does not include its selected incoming phone line`);
    }
    if (item.direction === 'outbound' && item.fromPhone !== accountPhone) {
      throw new Error(`Quo row ${item.index + 2} does not originate from its selected phone line`);
    }
    const actorPhone = item.direction === 'inbound'
      ? item.fromPhone
      : item.toPhones.find((phone) => phone !== accountPhone) ?? item.toPhones[0];
    const identity = [
      item.type, item.direction, item.occurredAt, accountPhone,
      item.fromPhone, item.toPhones.join(','),
    ].join('\0');
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      eventKey: sha256(`quo-metrics-v1\0${identity}\0${occurrence}`),
      rowFingerprint: rowFingerprint(item.row),
      sourceRowNumber: item.index + 2,
      type: item.type,
      direction: item.direction,
      status: item.status,
      statusDetails: nullable(item.row.statusDetails),
      occurredAt: item.occurredAt,
      updatedAt: quoPtTimestamp(item.row.updatedAtPT),
      answeredAt: quoPtTimestamp(item.row.answeredAtPT),
      deletedAt: quoPtTimestamp(item.row.deletedAtPT),
      durationSeconds: durationSeconds(item.row.duration),
      accountPhone,
      actorPhone,
      fromPhone: item.fromPhone,
      toPhones: item.toPhones,
      phoneNumberLabel: nullable(item.row.phoneNumberId),
      belongsTo: nullable(item.row.belongsTo),
      createdBy: nullable(item.row.createdBy),
      answeredBy: nullable(item.row.answeredBy),
      userId: nullable(item.row.userId),
    };
  });
}

function activitySecret(): string {
  const root = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!root || root.length < 32) throw new Error('CONNECTION_TOKEN_ENCRYPTION_KEY must be configured before --apply');
  return createHash('sha256').update('fluid-activity-sync:v2\0').update(root, 'utf8').digest('hex');
}

function options(): { apply: boolean; file: string } {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run import:quo-metrics -- --file PATH [--apply]');
    process.exit(0);
  }
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : args.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('Provide the Quo Metrics CSV with --file PATH');
  return { apply: args.includes('--apply'), file: resolve(file) };
}

async function main(): Promise<void> {
  const { apply, file } = options();
  const raw = await readFile(file, 'utf8');
  const sourceFileSha256 = sha256(raw);
  const rows = parseMetrics(raw);
  const summary = {
    sourceFile: basename(file),
    sourceFileSha256,
    total: rows.length,
    messages: rows.filter((row) => row.type === 'message').length,
    calls: rows.filter((row) => row.type === 'call').length,
    voicemails: rows.filter((row) => row.type === 'voicemail').length,
    missedCalls: rows.filter((row) => row.type === 'call' && row.status === 'missed').length,
    answeredCalls: rows.filter((row) => row.type === 'call' && row.status === 'answered').length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log('Dry run complete. Add --apply to reconcile this export into Fluid.');
    return;
  }

  const projectUrl = process.env.SUPABASE_PROJECT_URL?.trim().replace(/\/$/, '');
  if (!projectUrl) throw new Error('SUPABASE_PROJECT_URL is not configured');
  const secret = activitySecret();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let processed = 0;
  let matched = 0;
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const isFinal = offset + batch.length >= rows.length;
    const url = new URL(`${projectUrl}/functions/v1/fluid-quo-events`);
    url.searchParams.set('action', 'metrics-reconcile');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-fluid-activity-secret': secret,
      },
      body: JSON.stringify({
        sourceFile: basename(file),
        sourceFileSha256,
        rows: batch,
        run: {
          id: runId,
          connection_id: 'quo-metrics-reconciliation',
          import_kind: 'metrics',
          filename: basename(file),
          status: isFinal ? 'succeeded' : 'running',
          rows_seen: rows.length,
          rows_imported: processed + batch.length,
          rows_skipped: 0,
          started_at: startedAt,
          completed_at: isFinal ? new Date().toISOString() : null,
          last_error: null,
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = await response.json().catch(() => null) as {
      reconciled?: { processed?: number; matched?: number; inserted?: number };
      error?: string;
    } | null;
    if (!response.ok) throw new Error(`Fluid returned ${response.status}: ${payload?.error ?? 'unknown error'}`);
    processed += Number(payload?.reconciled?.processed ?? 0);
    matched += Number(payload?.reconciled?.matched ?? 0);
    inserted += Number(payload?.reconciled?.inserted ?? 0);
    process.stdout.write(`\rReconciled ${processed.toLocaleString()}/${rows.length.toLocaleString()} rows…`);
  }
  process.stdout.write('\n');
  console.log(JSON.stringify({ ...summary, processed, matched, inserted }, null, 2));
  if (processed !== rows.length) throw new Error(`Expected ${rows.length} processed rows, received ${processed}`);
}

await main();
