import { createHash } from 'node:crypto';

export type QuoImportKind = 'contacts' | 'messages' | 'calls';

export interface QuoPhoneNumber {
  id: string;
  e164: string;
  label: string | null;
}

export interface QuoActivityInput {
  source: 'quo';
  account_email: null;
  account_phone: string;
  external_id: string;
  external_thread_id: string | null;
  event_type: 'message.received' | 'message.sent' | 'call.completed';
  direction: 'inbound' | 'outbound';
  actor_name: string | null;
  actor_email: null;
  actor_phone: string | null;
  from_email: null;
  from_phone: string | null;
  to_emails: string[];
  to_phones: string[];
  cc_emails: string[];
  subject: string;
  preview: string;
  body_text: string | null;
  occurred_at: string;
  has_attachments: boolean;
  attachment_count: number;
  call_status: string | null;
  duration_seconds: number | null;
  source_labels: string[];
  source_metadata: Record<string, unknown>;
  updated_at: string;
}

export interface QuoContactInput {
  externalId: string | null;
  name: string;
  email: string | null;
  phone: string;
  normalizedPhone: string;
  sourceMetadata: Record<string, unknown>;
}

export interface QuoImportResult {
  activities: QuoActivityInput[];
  contacts: QuoContactInput[];
  rowsSeen: number;
  rowsSkipped: number;
  warnings: string[];
}

type CsvRow = Record<string, string>;

const MAX_ROWS = 250_000;
const MAX_COLUMNS = 200;

function headerKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseCsvRecords(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === '') {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      record.push(field);
      field = '';
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
      if (records.length > MAX_ROWS + 1) throw new Error(`CSV exceeds the ${MAX_ROWS.toLocaleString()} row limit`);
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  record.push(field);
  if (record.some((value) => value.trim() !== '')) records.push(record);
  return records;
}

function parseCsv(text: string): CsvRow[] {
  const records = parseCsvRecords(text);
  const rawHeaders = records.shift();
  if (!rawHeaders || rawHeaders.length === 0) throw new Error('CSV has no header row');
  if (rawHeaders.length > MAX_COLUMNS) throw new Error(`CSV exceeds the ${MAX_COLUMNS} column limit`);
  const headers = rawHeaders.map(headerKey);
  if (headers.some((header) => header === '')) throw new Error('CSV contains an empty column name');
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length > 0) throw new Error(`CSV contains duplicate columns: ${[...new Set(duplicates)].join(', ')}`);
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

function value(row: CsvRow, ...names: string[]): string {
  for (const name of names) {
    const found = row[headerKey(name)]?.trim();
    if (found) return found;
  }
  return '';
}

function cleanEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 320) : null;
}

function e164(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  return null;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function phoneList(raw: string): string[] {
  const matches = raw.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  return [...new Set(matches.map(e164).filter((phone): phone is string => phone !== null))];
}

function timestamp(raw: string): string | null {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function truncateText(value: string, maximum: number): string {
  const truncated = value.slice(0, maximum);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function stableId(prefix: string, row: CsvRow): string {
  const canonical = Object.keys(row).sort().map((key) => `${key}\0${row[key] ?? ''}`).join('\0');
  return `${prefix}:csv:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

function directionOf(raw: string, from: string | null, businessPhones: Set<string>): 'inbound' | 'outbound' | null {
  const direction = raw.trim().toLowerCase();
  if (/^(incoming|inbound|received)$/.test(direction)) return 'inbound';
  if (/^(outgoing|outbound|sent)$/.test(direction)) return 'outbound';
  if (from && businessPhones.has(from)) return 'outbound';
  return from ? 'inbound' : null;
}

function resolveParticipants(
  row: CsvRow,
  connectedNumbers: QuoPhoneNumber[],
): { direction: 'inbound' | 'outbound'; account: QuoPhoneNumber; actor: string | null; from: string | null; to: string[] } | null {
  const businessPhones = new Set(connectedNumbers.map((number) => number.e164));
  const from = e164(value(row, 'from', 'from number', 'sender', 'source'));
  const to = phoneList(value(row, 'to', 'to number', 'recipient', 'recipients', 'destination'));
  const explicitAccount = e164(value(row, 'phone number', 'business number', 'company number', 'workspace number', 'line'));
  const account = connectedNumbers.find((number) =>
    number.e164 === explicitAccount || number.e164 === from || to.includes(number.e164)
  );
  if (!account) return null;
  const direction = directionOf(value(row, 'direction', 'type'), from, businessPhones);
  if (!direction) return null;
  const actor = direction === 'inbound' ? from : to.find((phone) => phone !== account.e164) ?? null;
  return { direction, account, actor, from, to };
}

function durationSeconds(raw: string): number | null {
  const compact = raw.trim();
  if (!compact) return null;
  if (/^\d+(?:\.\d+)?$/.test(compact)) return Math.max(0, Math.round(Number(compact)));
  const parts = compact.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return Math.max(0, Math.round((parts[0] ?? 0) * 60 + (parts[1] ?? 0)));
  if (parts.length === 3) return Math.max(0, Math.round((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)));
  return null;
}

function callStatus(raw: string): string {
  const status = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (/missed/.test(status)) return 'missed';
  if (/voicemail/.test(status)) return 'voicemail';
  if (/no_answer|unanswered/.test(status)) return 'no_answer';
  if (/fail|cancel|declin|busy/.test(status)) return 'failed';
  return 'completed';
}

function conversationId(account: QuoPhoneNumber, actor: string | null): string | null {
  return actor ? `quo:${account.id}:${normalizePhone(actor)}` : null;
}

function parseContact(row: CsvRow): QuoContactInput | null {
  const phone = e164(value(row, 'phone', 'phone number', 'primary phone', 'number', 'mobile'));
  if (!phone) return null;
  const first = value(row, 'first name', 'firstname');
  const last = value(row, 'last name', 'lastname');
  const full = value(row, 'name', 'full name', 'contact name') || [first, last].filter(Boolean).join(' ');
  return {
    externalId: value(row, 'id', 'contact id', 'contactid') || null,
    name: (full || phone).slice(0, 200),
    email: cleanEmail(value(row, 'email', 'email address')),
    phone,
    normalizedPhone: normalizePhone(phone),
    sourceMetadata: { importedFrom: 'quo_csv' },
  };
}

function parseMessage(row: CsvRow, numbers: QuoPhoneNumber[], now: string): QuoActivityInput | null {
  const participants = resolveParticipants(row, numbers);
  const occurredAt = timestamp(value(row, 'created at', 'created', 'date', 'timestamp', 'sent at', 'received at'));
  if (!participants || !occurredAt) return null;
  const body = value(row, 'text', 'message', 'body', 'content');
  const externalId = value(row, 'id', 'message id', 'messageid') || stableId('quo-message', row);
  const media = value(row, 'media', 'attachments', 'attachment urls', 'media urls');
  const mediaCount = media ? Math.max(1, media.split(/[|;\n]/).filter(Boolean).length) : 0;
  return {
    source: 'quo',
    account_email: null,
    account_phone: participants.account.e164,
    external_id: truncateText(externalId, 240),
    external_thread_id: conversationId(participants.account, participants.actor),
    event_type: participants.direction === 'inbound' ? 'message.received' : 'message.sent',
    direction: participants.direction,
    actor_name: null,
    actor_email: null,
    actor_phone: participants.actor,
    from_email: null,
    from_phone: participants.from,
    to_emails: [],
    to_phones: participants.to,
    cc_emails: [],
    subject: 'Text message',
    preview: truncateText(body, 240),
    body_text: body ? truncateText(body, 100_000) : null,
    occurred_at: occurredAt,
    has_attachments: mediaCount > 0,
    attachment_count: mediaCount,
    call_status: null,
    duration_seconds: null,
    source_labels: [],
    source_metadata: { importedFrom: 'quo_csv', phoneNumberId: participants.account.id },
    updated_at: now,
  };
}

function parseCall(row: CsvRow, numbers: QuoPhoneNumber[], now: string): QuoActivityInput | null {
  const participants = resolveParticipants(row, numbers);
  const occurredAt = timestamp(value(row, 'created at', 'created', 'date', 'timestamp', 'started at', 'start time'));
  if (!participants || !occurredAt) return null;
  const status = callStatus(value(row, 'status', 'result', 'call status', 'disposition'));
  const seconds = durationSeconds(value(row, 'duration', 'duration seconds', 'talk time'));
  const externalId = value(row, 'id', 'call id', 'callid') || stableId('quo-call', row);
  const subject = participants.direction === 'inbound' ? 'Incoming call' : 'Outgoing call';
  return {
    source: 'quo',
    account_email: null,
    account_phone: participants.account.e164,
    external_id: truncateText(externalId, 240),
    external_thread_id: conversationId(participants.account, participants.actor),
    event_type: 'call.completed',
    direction: participants.direction,
    actor_name: null,
    actor_email: null,
    actor_phone: participants.actor,
    from_email: null,
    from_phone: participants.from,
    to_emails: [],
    to_phones: participants.to,
    cc_emails: [],
    subject,
    preview: status === 'completed' ? '' : status.replace(/_/g, ' '),
    body_text: null,
    occurred_at: occurredAt,
    has_attachments: false,
    attachment_count: 0,
    call_status: status,
    duration_seconds: seconds,
    source_labels: [],
    source_metadata: { importedFrom: 'quo_csv', phoneNumberId: participants.account.id },
    updated_at: now,
  };
}

export function parseQuoExport(
  kind: QuoImportKind,
  text: string,
  connectedNumbers: QuoPhoneNumber[],
): QuoImportResult {
  if (text.trim() === '') throw new Error('CSV is empty');
  const rows = parseCsv(text);
  const now = new Date().toISOString();
  const activities: QuoActivityInput[] = [];
  const contacts: QuoContactInput[] = [];
  let rowsSkipped = 0;

  for (const row of rows) {
    const parsed = kind === 'contacts'
      ? parseContact(row)
      : kind === 'messages'
        ? parseMessage(row, connectedNumbers, now)
        : parseCall(row, connectedNumbers, now);
    if (!parsed) {
      rowsSkipped += 1;
    } else if (kind === 'contacts') {
      contacts.push(parsed as QuoContactInput);
    } else {
      activities.push(parsed as QuoActivityInput);
    }
  }

  const warnings: string[] = [];
  if (rowsSkipped > 0) {
    warnings.push(`${rowsSkipped} row${rowsSkipped === 1 ? '' : 's'} were outside the selected phone lines or lacked a usable direction or timestamp.`);
  }
  return { activities, contacts, rowsSeen: rows.length, rowsSkipped, warnings };
}
