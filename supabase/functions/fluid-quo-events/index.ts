import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';

type ActivityInput = {
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
};

type ImportRun = {
  id: string;
  connection_id: string;
  import_kind: 'contacts' | 'messages' | 'calls' | 'metrics';
  filename: string;
  status: 'running' | 'succeeded' | 'failed';
  rows_seen: number;
  rows_imported: number;
  rows_skipped: number;
  started_at: string;
  completed_at: string | null;
  last_error: string | null;
};

type QuoMetricRow = {
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

type ScopePhoneNumber = {
  id: string;
  e164: string;
  label: string | null;
};

type ActiveScope = {
  ids: Set<string>;
  phones: Set<string>;
  phoneById: Map<string, string>;
};

type TranscriptInput = {
  callId: string;
  transcriptId: string | null;
  createdAt: string | null;
  duration: number | null;
  dialogue: Array<{
    content: string;
    start: number | null;
    end: number | null;
    identifier: string | null;
    userId: string | null;
  }>;
};

type RecordingInput = {
  callId: string;
  completedAt: string | null;
  recordings: Array<{
    id: string | null;
    url: string;
    type: string | null;
    duration: number | null;
    startTime: string | null;
    status: string | null;
  }>;
};

type SummaryInput = {
  callId: string;
  summaryId: string | null;
  createdAt: string | null;
  summary: string[];
  nextSteps: string[];
  jobs: unknown;
};

type CallContentKind = 'transcript' | 'recording' | 'summary';
type RetryableStatus = 'pending' | 'unavailable' | 'failed';

type CallContentState = {
  status: RetryableStatus | 'available' | null;
  attemptCount: number;
  nextRetryAt: string | null;
};

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const encoder = new TextEncoder();
const WORKSPACE_KEY = 'ottawa-painters';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'Unexpected function error';
}

function databaseSecret(): string {
  const current = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (current) {
    const parsed = JSON.parse(current) as Record<string, unknown>;
    const preferred = parsed.default;
    if (typeof preferred === 'string' && preferred) return preferred;
    const fallback = Object.values(parsed).find((value) => typeof value === 'string' && value);
    if (typeof fallback === 'string') return fallback;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!legacy) throw new Error('Supabase database secret is unavailable');
  return legacy;
}

function safeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return different === 0;
}

function authorizedInternal(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-activity-secret') ?? '';
  if (!supplied) return false;
  const expected = [
    Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET'),
    Deno.env.get('FLUID_QUO_MAINTENANCE_SECRET'),
    Deno.env.get('FLUID_EMAIL_CATEGORIZER_SECRET'),
  ].filter((value): value is string => Boolean(value));
  return expected.some((value) => safeEqual(value, supplied));
}

function cleanString(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
}

function truncateText(value: string, maximum: number): string {
  const truncated = value.slice(0, maximum);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function e164(value: unknown): string | null {
  const raw = cleanString(value, 32);
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  return null;
}

function phoneList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value];
  return [...new Set(values.map(e164).filter((phone): phone is string => phone !== null))];
}

function normalizedPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function base64Bytes(value: string): ArrayBuffer {
  const binary = atob(value.replace(/\s/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function quoWebhookSigningSecrets(): string[] {
  const secrets = new Set<string>();
  const legacy = Deno.env.get('QUO_WEBHOOK_SIGNING_SECRET')?.trim();
  if (legacy) secrets.add(legacy);

  const configured = Deno.env.get('QUO_WEBHOOK_SIGNING_SECRETS')?.trim();
  if (!configured) return [...secrets];
  try {
    const parsed: unknown = JSON.parse(configured);
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === 'string' && value.trim()) secrets.add(value.trim());
      }
      return [...secrets];
    }
  } catch {
    // Support a comma/newline-delimited value for operators that cannot set JSON.
  }
  for (const value of configured.split(/[,\n]/)) {
    if (value.trim()) secrets.add(value.trim());
  }
  return [...secrets];
}

async function verifyQuoSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secrets = quoWebhookSigningSecrets();
  if (secrets.length === 0 || !header) return false;
  const compactBody = JSON.stringify(JSON.parse(rawBody) as unknown);
  const signatures = header.split(',').map((item) => item.trim()).filter(Boolean);
  for (const secret of secrets) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        base64Bytes(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      for (const signature of signatures) {
        const [scheme, version, rawTimestamp, provided] = signature.split(';');
        if (scheme !== 'hmac' || version !== '1' || !rawTimestamp || !provided) continue;
        const timestamp = Number(rawTimestamp);
        const timestampMs = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
        if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) continue;
        const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${rawTimestamp}.${compactBody}`));
        if (safeEqual(base64(digest), provided.replace(/\s/g, ''))) return true;
      }
    } catch {
      // A malformed operator-supplied key must not disable otherwise valid keys.
    }
  }
  return false;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function upsertActivities(supabase: SupabaseClient, activities: ActivityInput[]): Promise<number> {
  if (activities.length === 0) return 0;
  // Contact matching is database-owned. A phone match is not an authoritative
  // provider Contact ID and may be shared by several Contacts.
  for (const batch of chunks(activities, 200)) {
    const { error } = await supabase
      .from('activities')
      .upsert(batch, { onConflict: 'source,account_key,external_id' });
    if (error) throw error;
  }
  return activities.length;
}

function validImportBody(value: unknown): value is {
  run: ImportRun;
  activities: ActivityInput[];
  contacts: unknown[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!body.run || typeof body.run !== 'object') return false;
  if (!Array.isArray(body.activities) || !Array.isArray(body.contacts)) return false;
  if (body.activities.length > 500 || body.contacts.length > 500) return false;
  return true;
}

function validMetricImportBody(value: unknown): value is {
  run: ImportRun;
  sourceFile: string;
  sourceFileSha256: string;
  rows: QuoMetricRow[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!body.run || typeof body.run !== 'object' || Array.isArray(body.run)) return false;
  const run = body.run as Record<string, unknown>;
  if (run.import_kind !== 'metrics') return false;
  if (!cleanString(body.sourceFile, 240) || !/^[a-f0-9]{64}$/.test(String(body.sourceFileSha256 ?? ''))) return false;
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 200) return false;
  return body.rows.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return /^[a-f0-9]{64}$/.test(String(row.eventKey ?? '')) &&
      /^[a-f0-9]{64}$/.test(String(row.rowFingerprint ?? '')) &&
      Number.isSafeInteger(row.sourceRowNumber) && Number(row.sourceRowNumber) > 1 &&
      ['message', 'call', 'voicemail'].includes(String(row.type ?? '')) &&
      ['inbound', 'outbound'].includes(String(row.direction ?? '')) &&
      Boolean(cleanString(row.status, 100)) &&
      Boolean(cleanString(row.occurredAt, 80) && Number.isFinite(Date.parse(String(row.occurredAt)))) &&
      Boolean(e164(row.accountPhone) && e164(row.actorPhone) && e164(row.fromPhone)) &&
      Array.isArray(row.toPhones) && row.toPhones.length > 0 && row.toPhones.length <= 50 &&
      row.toPhones.every((phone) => Boolean(e164(phone))) &&
      (row.durationSeconds === null || row.durationSeconds === undefined ||
        (Number.isSafeInteger(row.durationSeconds) && Number(row.durationSeconds) >= 0));
  });
}

function validScopeBody(value: unknown): value is {
  connectionId: string;
  phoneNumbers: ScopePhoneNumber[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!cleanString(body.connectionId, 200) || !Array.isArray(body.phoneNumbers) || body.phoneNumbers.length > 100) return false;
  return body.phoneNumbers.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const number = item as Record<string, unknown>;
    return Boolean(cleanString(number.id, 200) && e164(number.e164));
  });
}

async function activeScope(supabase: SupabaseClient): Promise<ActiveScope> {
  const { data, error } = await supabase
    .from('quo_phone_scopes')
    .select('phone_number_id,phone_number_e164')
    .eq('active', true);
  if (error) throw error;
  return {
    ids: new Set((data ?? []).map((row) => row.phone_number_id)),
    phones: new Set((data ?? []).map((row) => row.phone_number_e164)),
    phoneById: new Map((data ?? []).map((row) => [row.phone_number_id, row.phone_number_e164])),
  };
}

function activityIsInScope(
  activity: ActivityInput,
  scope: ActiveScope,
): boolean {
  const rawPhoneNumberId = activity.source_metadata.phoneNumberId;
  const phoneNumberId = typeof rawPhoneNumberId === 'string' ? rawPhoneNumberId : null;
  return Boolean(
    (phoneNumberId && scope.ids.has(phoneNumberId)) ||
    scope.phones.has(activity.account_phone),
  );
}

function finiteNumber(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

export function transcriptInput(payload: Record<string, unknown>): TranscriptInput | null {
  const type = cleanString(payload.type, 80);
  if (type !== 'call.transcript.completed' && type !== 'callTranscript') return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rawObject = (data as Record<string, unknown>).object;
  if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) return null;
  const object = rawObject as Record<string, unknown>;
  const callId = cleanString(object.callId, 200);
  if (!callId || !/^AC[A-Za-z0-9_-]+$/.test(callId)) return null;
  const rawDialogue = Array.isArray(object.dialogue) ? object.dialogue.slice(0, 500) : [];
  const dialogue = rawDialogue.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const content = cleanString(row.content, 10_000);
    if (!content) return [];
    return [{
      content,
      start: finiteNumber(row.start, 0, 1_000_000),
      end: finiteNumber(row.end, 0, 1_000_000),
      identifier: e164(row.identifier),
      userId: cleanString(row.userId, 200),
    }];
  });
  return {
    callId,
    transcriptId: cleanString(object.id, 200) ?? cleanString(payload.id, 200),
    createdAt: cleanString(object.createdAt, 80),
    duration: finiteNumber(object.duration, 0, 1_000_000),
    dialogue,
  };
}

function stringList(value: unknown, maximumItems = 100, maximumLength = 10_000): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.slice(0, maximumItems).flatMap((entry) => {
    const raw = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).content ?? (entry as Record<string, unknown>).text
        : null;
    const cleaned = cleanString(raw, maximumLength);
    return cleaned ? [cleaned] : [];
  });
}

function boundedJson(value: unknown, maximumBytes: number, fallback: unknown): unknown {
  try {
    const encoded = JSON.stringify(value ?? fallback);
    if (new TextEncoder().encode(encoded).length > maximumBytes) return fallback;
    return JSON.parse(encoded) as unknown;
  } catch {
    return fallback;
  }
}

function httpsUrl(value: unknown): string | null {
  const raw = cleanString(value, 4_000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function recordingInput(payload: Record<string, unknown>): RecordingInput | null {
  if (cleanString(payload.type, 80) !== 'call.recording.completed') return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rawObject = (data as Record<string, unknown>).object;
  if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) return null;
  const object = rawObject as Record<string, unknown>;
  const callId = cleanString(object.callId, 200) ?? cleanString(object.id, 200);
  if (!callId || !/^AC[A-Za-z0-9_-]+$/.test(callId)) return null;
  const rawRecordings = Array.isArray(object.media)
    ? object.media
    : Array.isArray(object.recordings)
      ? object.recordings
      : [];
  const recordings = rawRecordings.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const url = httpsUrl(row.url);
    if (!url) return [];
    return [{
      id: cleanString(row.id, 200),
      url,
      type: cleanString(row.type, 100),
      duration: finiteNumber(row.duration, 0, 1_000_000),
      startTime: cleanString(row.startTime, 80),
      status: cleanString(row.status, 100),
    }];
  });
  if (recordings.length === 0) return null;
  return {
    callId,
    completedAt: cleanString(object.completedAt, 80) ?? cleanString(object.createdAt, 80),
    recordings,
  };
}

export function summaryInput(payload: Record<string, unknown>): SummaryInput | null {
  if (cleanString(payload.type, 80) !== 'call.summary.completed') return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rawObject = (data as Record<string, unknown>).object;
  if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) return null;
  const object = rawObject as Record<string, unknown>;
  const callId = cleanString(object.callId, 200) ?? cleanString(object.id, 200);
  if (!callId || !/^AC[A-Za-z0-9_-]+$/.test(callId)) return null;
  return {
    callId,
    summaryId: cleanString(object.summaryId, 200) ?? cleanString(object.id, 200),
    createdAt: cleanString(object.createdAt, 80) ?? cleanString(object.completedAt, 80),
    summary: stringList(object.summary),
    nextSteps: stringList(object.nextSteps),
    jobs: boundedJson(object.jobs, 900_000, []),
  };
}

function transcriptText(transcript: TranscriptInput): string {
  return truncateText(
    transcript.dialogue.map((line) => `${line.identifier ?? 'Speaker'}: ${line.content}`).join('\n'),
    200_000,
  );
}

async function storeTranscript(
  supabase: SupabaseClient,
  activityId: number,
  transcript: TranscriptInput,
): Promise<void> {
  const text = transcriptText(transcript);
  const now = new Date().toISOString();
  const attemptCount = await nextAttemptCount(supabase, 'activity_call_transcripts', activityId);
  const { error: transcriptError } = await supabase
    .from('activity_call_transcripts')
    .upsert({
      activity_id: activityId,
      workspace_key: WORKSPACE_KEY,
      provider: 'quo',
      provider_call_id: transcript.callId,
      provider_transcript_id: transcript.transcriptId,
      status: 'available',
      dialogue: transcript.dialogue,
      transcript_text: text || null,
      unavailable_reason: null,
      transcript_created_at: transcript.createdAt,
      fetched_at: now,
      attempt_count: attemptCount,
      last_attempted_at: now,
      next_retry_at: null,
      last_http_status: 200,
      updated_at: now,
    }, { onConflict: 'activity_id' });
  if (transcriptError) throw transcriptError;

  const { data: activity, error: activityError } = await supabase
    .from('activities')
    .select('source_metadata,preview')
    .eq('id', activityId)
    .single();
  if (activityError) throw activityError;
  const metadata = activity.source_metadata && typeof activity.source_metadata === 'object'
    ? activity.source_metadata as Record<string, unknown>
    : {};
  const { error: updateError } = await supabase
    .from('activities')
    .update({
      body_text: text || null,
      preview: text ? truncateText(text, 240) : activity.preview,
      source_metadata: {
        ...metadata,
        transcriptId: transcript.transcriptId,
        transcriptStatus: 'available',
        transcriptCreatedAt: transcript.createdAt,
      },
      updated_at: now,
    })
    .eq('id', activityId);
  if (updateError) throw updateError;
}

async function nextAttemptCount(
  supabase: SupabaseClient,
  table: 'activity_call_transcripts' | 'activity_call_recordings' | 'activity_call_summaries',
  activityId: number,
): Promise<number> {
  const { data, error } = await supabase
    .from(table)
    .select('attempt_count')
    .eq('activity_id', activityId)
    .maybeSingle();
  if (error) throw error;
  return Math.min(1000, Math.max(0, Number(data?.attempt_count ?? 0)) + 1);
}

async function storeRecording(
  supabase: SupabaseClient,
  activityId: number,
  recording: RecordingInput,
): Promise<void> {
  const now = new Date().toISOString();
  const attemptCount = await nextAttemptCount(supabase, 'activity_call_recordings', activityId);
  const { error } = await supabase.from('activity_call_recordings').upsert({
    activity_id: activityId,
    workspace_key: WORKSPACE_KEY,
    provider: 'quo',
    provider_call_id: recording.callId,
    status: 'available',
    recordings: recording.recordings,
    unavailable_reason: null,
    recording_completed_at: recording.completedAt,
    fetched_at: now,
    attempt_count: attemptCount,
    last_attempted_at: now,
    next_retry_at: null,
    last_http_status: 200,
    updated_at: now,
  }, { onConflict: 'activity_id' });
  if (error) throw error;
}

async function storeSummary(
  supabase: SupabaseClient,
  activityId: number,
  summary: SummaryInput,
): Promise<void> {
  const now = new Date().toISOString();
  const attemptCount = await nextAttemptCount(supabase, 'activity_call_summaries', activityId);
  const { error } = await supabase.from('activity_call_summaries').upsert({
    activity_id: activityId,
    workspace_key: WORKSPACE_KEY,
    provider: 'quo',
    provider_call_id: summary.callId,
    provider_summary_id: summary.summaryId,
    status: 'available',
    summary: summary.summary,
    next_steps: summary.nextSteps,
    jobs: summary.jobs,
    unavailable_reason: null,
    summary_created_at: summary.createdAt,
    fetched_at: now,
    attempt_count: attemptCount,
    last_attempted_at: now,
    next_retry_at: null,
    last_http_status: 200,
    updated_at: now,
  }, { onConflict: 'activity_id' });
  if (error) throw error;
}

function contentTable(kind: CallContentKind):
  'activity_call_transcripts' | 'activity_call_recordings' | 'activity_call_summaries' {
  if (kind === 'transcript') return 'activity_call_transcripts';
  if (kind === 'recording') return 'activity_call_recordings';
  return 'activity_call_summaries';
}

async function storeContentStatus(
  supabase: SupabaseClient,
  activityId: number,
  callId: string,
  kind: CallContentKind,
  status: RetryableStatus,
  reason: string,
  httpStatus: number | null,
  nextRetryAt: string | null,
): Promise<'available' | RetryableStatus> {
  const table = contentTable(kind);
  const { data: existing, error: existingError } = await supabase
    .from(table)
    .select('status,attempt_count')
    .eq('activity_id', activityId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.status === 'available') return 'available';
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    activity_id: activityId,
    workspace_key: WORKSPACE_KEY,
    provider: 'quo',
    provider_call_id: callId,
    status,
    unavailable_reason: reason,
    attempt_count: Math.min(1000, Math.max(0, Number(existing?.attempt_count ?? 0)) + 1),
    last_attempted_at: now,
    next_retry_at: status === 'unavailable' ? null : nextRetryAt,
    last_http_status: httpStatus,
    updated_at: now,
  };
  if (kind === 'transcript') {
    Object.assign(row, { provider_transcript_id: null, dialogue: [], transcript_text: null, fetched_at: null });
  } else if (kind === 'recording') {
    Object.assign(row, { recordings: [], fetched_at: null });
  } else {
    Object.assign(row, { provider_summary_id: null, summary: [], next_steps: [], jobs: [], fetched_at: null });
  }
  const { error } = await supabase.from(table).upsert(row, { onConflict: 'activity_id' });
  if (error) throw error;
  if (kind === 'transcript') {
    const { data: activity, error: activityError } = await supabase
      .from('activities')
      .select('source_metadata')
      .eq('id', activityId)
      .single();
    if (activityError) throw activityError;
    const metadata = activity.source_metadata && typeof activity.source_metadata === 'object'
      ? activity.source_metadata as Record<string, unknown>
      : {};
    const { error: updateError } = await supabase.from('activities').update({
      source_metadata: { ...metadata, transcriptStatus: status },
      updated_at: now,
    }).eq('id', activityId);
    if (updateError) throw updateError;
  }
  return status;
}

async function findScopedCallActivity(
  supabase: SupabaseClient,
  scope: ActiveScope,
  callId: string,
): Promise<{ id: number; account_phone: string; source_metadata: Record<string, unknown> } | null> {
  const { data, error } = await supabase
    .from('activities')
    .select('id,account_phone,source_metadata')
    .eq('source', 'quo')
    .eq('external_id', callId)
    .eq('event_type', 'call.completed')
    .maybeSingle();
  if (error) throw error;
  if (!data || !scope.phones.has(data.account_phone)) return null;
  return {
    id: data.id,
    account_phone: data.account_phone,
    source_metadata: data.source_metadata && typeof data.source_metadata === 'object'
      ? data.source_metadata as Record<string, unknown>
      : {},
  };
}

async function replaceScope(
  supabase: SupabaseClient,
  connectionId: string,
  phoneNumbers: ScopePhoneNumber[],
): Promise<void> {
  const { data: existing, error: existingError } = await supabase
    .from('quo_phone_scopes')
    .select('phone_number_id')
    .eq('connection_id', connectionId);
  if (existingError) throw existingError;

  if (phoneNumbers.length > 0) {
    const rows = phoneNumbers.map((number) => ({
      connection_id: connectionId,
      phone_number_id: number.id,
      phone_number_e164: number.e164,
      label: number.label,
      active: true,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('quo_phone_scopes')
      .upsert(rows, { onConflict: 'connection_id,phone_number_id' });
    if (error) throw error;
  }

  const selectedIds = new Set(phoneNumbers.map((number) => number.id));
  const removeIds = (existing ?? [])
    .map((row) => row.phone_number_id)
    .filter((id) => !selectedIds.has(id));
  if (removeIds.length > 0) {
    const { error } = await supabase
      .from('quo_phone_scopes')
      .delete()
      .eq('connection_id', connectionId)
      .in('phone_number_id', removeIds);
    if (error) throw error;
  }
}

function contactDisplayName(contact: Record<string, unknown>): string | null {
  const rawFields = contact.defaultFields;
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return null;
  const fields = rawFields as Record<string, unknown>;
  const company = cleanString(fields.company, 300);
  const firstName = cleanString(fields.firstName, 150);
  const lastName = cleanString(fields.lastName, 150);
  return company ?? cleanString([firstName, lastName].filter(Boolean).join(' '), 300);
}

function contactPhones(contact: Record<string, unknown>): string[] {
  const rawFields = contact.defaultFields;
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return [];
  const phoneNumbers = (rawFields as Record<string, unknown>).phoneNumbers;
  if (!Array.isArray(phoneNumbers)) return [];
  return [...new Set(phoneNumbers.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const phone = e164((item as Record<string, unknown>).value);
    return phone ? [phone] : [];
  }))];
}

async function enrichQuoContacts(
  supabase: SupabaseClient,
  contacts: unknown[],
  scope: ActiveScope,
): Promise<{ seen: number; matched: number; evidence: number; namesUpdated: number }> {
  const candidates = contacts.slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const contact = raw as Record<string, unknown>;
    const providerId = cleanString(contact.id, 200);
    if (!providerId) return [];
    return contactPhones(contact).map((phone) => ({
      providerId,
      phone,
      displayName: contactDisplayName(contact),
      source: cleanString(contact.source, 100),
      updatedAt: cleanString(contact.updatedAt, 80),
    }));
  });
  if (candidates.length === 0) return { seen: contacts.length, matched: 0, evidence: 0, namesUpdated: 0 };

  const candidatePhones = [...new Set(candidates.map((candidate) => candidate.phone))];
  const observedPhones = new Set<string>();
  for (const phoneBatch of chunks(candidatePhones, 100)) {
    const { data, error } = await supabase
      .from('activities')
      .select('actor_phone,account_phone')
      .eq('source', 'quo')
      .in('account_phone', [...scope.phones])
      .in('actor_phone', phoneBatch);
    if (error) throw error;
    for (const row of data ?? []) {
      const phone = e164(row.actor_phone);
      if (phone) observedPhones.add(phone);
    }
  }
  const matched = candidates.filter((candidate) => observedPhones.has(candidate.phone));
  if (matched.length === 0) return { seen: contacts.length, matched: 0, evidence: 0, namesUpdated: 0 };

  const { data: identities, error: identityError } = await supabase
    .from('identities')
    .select('id,normalized_value,display_name')
    .eq('workspace_key', WORKSPACE_KEY)
    .eq('kind', 'phone')
    .in('normalized_value', [...new Set(matched.map((candidate) => candidate.phone))]);
  if (identityError) throw identityError;
  const identityByPhone = new Map((identities ?? []).map((identity) => [identity.normalized_value, identity]));
  const evidenceRows = matched.flatMap((candidate) => {
    const identity = identityByPhone.get(candidate.phone);
    if (!identity) return [];
    return [{
      workspace_key: WORKSPACE_KEY,
      identity_id: identity.id,
      provider: 'quo',
      provider_id: candidate.providerId,
      display_name: candidate.displayName,
      metadata: { source: candidate.source, providerUpdatedAt: candidate.updatedAt },
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }];
  });
  if (evidenceRows.length > 0) {
    const { error } = await supabase
      .from('identity_provider_evidence')
      .upsert(evidenceRows, { onConflict: 'workspace_key,provider,provider_id,identity_id' });
    if (error) throw error;
  }

  let namesUpdated = 0;
  for (const candidate of matched) {
    if (!candidate.displayName) continue;
    const identity = identityByPhone.get(candidate.phone);
    if (!identity || identity.display_name === candidate.displayName) continue;
    const { error: identityUpdateError } = await supabase
      .from('identities')
      .update({ display_name: candidate.displayName, updated_at: new Date().toISOString() })
      .eq('id', identity.id);
    if (identityUpdateError) throw identityUpdateError;
    const { error: activityUpdateError } = await supabase
      .from('activities')
      .update({ actor_name: candidate.displayName, updated_at: new Date().toISOString() })
      .eq('source', 'quo')
      .in('account_phone', [...scope.phones])
      .eq('actor_phone', candidate.phone)
      .is('actor_name', null);
    if (activityUpdateError) throw activityUpdateError;
    namesUpdated += 1;
  }

  return {
    seen: contacts.length,
    matched: new Set(matched.map((candidate) => candidate.providerId)).size,
    evidence: evidenceRows.length,
    namesUpdated,
  };
}

function callContentState(row: Record<string, unknown> | undefined): CallContentState {
  const rawStatus = row?.status;
  const status = rawStatus === 'pending' || rawStatus === 'available' ||
      rawStatus === 'unavailable' || rawStatus === 'failed'
    ? rawStatus
    : null;
  const nextRetryAt = typeof row?.next_retry_at === 'string' ? row.next_retry_at : null;
  return {
    status,
    attemptCount: Math.max(0, Number(row?.attempt_count ?? 0)),
    nextRetryAt,
  };
}

function contentIsDue(state: CallContentState, now: number): boolean {
  if (state.status === 'available' || state.status === 'unavailable') return false;
  if (!state.nextRetryAt) return true;
  const retryAt = Date.parse(state.nextRetryAt);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

async function callContentCandidates(
  supabase: SupabaseClient,
  url: URL,
): Promise<{ calls: Array<Record<string, unknown>>; nextOffset: number | null }> {
  const scope = await activeScope(supabase);
  if (scope.phones.size === 0) return { calls: [], nextOffset: null };
  const requestedCallId = cleanString(url.searchParams.get('callId'), 200);
  if (requestedCallId && !/^AC[A-Za-z0-9_-]+$/.test(requestedCallId)) {
    return { calls: [], nextOffset: null };
  }
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 100;
  const requestedOffset = Number.parseInt(url.searchParams.get('offset') ?? '', 10);
  const offset = !requestedCallId && Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
    ? Math.min(requestedOffset, 1_000_000)
    : 0;
  const scanLimit = requestedCallId ? 1 : 500;
  const rawKind = url.searchParams.get('kind');
  const requestedKind: CallContentKind | null = rawKind === 'transcript' || rawKind === 'recording' || rawKind === 'summary'
    ? rawKind
    : null;
  let query = supabase
    .from('activities')
    .select('id,external_id,account_phone,occurred_at')
    .eq('source', 'quo')
    .eq('event_type', 'call.completed')
    .in('account_phone', [...scope.phones])
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + scanLimit - 1);
  if (requestedCallId) query = query.eq('external_id', requestedCallId);
  const callsResult = await query;
  if (callsResult.error) throw callsResult.error;
  const calls = callsResult.data ?? [];
  const activityIds = calls.map((call) => call.id);
  if (activityIds.length === 0) return { calls: [], nextOffset: null };
  const [transcriptsResult, recordingsResult, summariesResult] = await Promise.all([
    supabase.from('activity_call_transcripts')
      .select('activity_id,status,attempt_count,next_retry_at')
      .eq('workspace_key', WORKSPACE_KEY).in('activity_id', activityIds),
    supabase.from('activity_call_recordings')
      .select('activity_id,status,attempt_count,next_retry_at')
      .eq('workspace_key', WORKSPACE_KEY).in('activity_id', activityIds),
    supabase.from('activity_call_summaries')
      .select('activity_id,status,attempt_count,next_retry_at')
      .eq('workspace_key', WORKSPACE_KEY).in('activity_id', activityIds),
  ]);
  if (transcriptsResult.error) throw transcriptsResult.error;
  if (recordingsResult.error) throw recordingsResult.error;
  if (summariesResult.error) throw summariesResult.error;
  const asMap = (rows: Array<Record<string, unknown>>) => new Map(
    rows.map((row) => [Number(row.activity_id), row]),
  );
  const transcripts = asMap(transcriptsResult.data ?? []);
  const recordings = asMap(recordingsResult.data ?? []);
  const summaries = asMap(summariesResult.data ?? []);
  const now = Date.now();
  const dueCalls = calls.flatMap((call) => {
    const artifacts = {
      transcript: callContentState(transcripts.get(Number(call.id))),
      recording: callContentState(recordings.get(Number(call.id))),
      summary: callContentState(summaries.get(Number(call.id))),
    };
    const needed = (Object.entries(artifacts) as Array<[CallContentKind, CallContentState]>)
      .filter(([, state]) => contentIsDue(state, now))
      .map(([kind]) => kind);
    const selectedNeeded = requestedKind ? needed.filter((kind) => kind === requestedKind) : needed;
    return selectedNeeded.length > 0 ? [{ ...call, artifacts, needed: selectedNeeded }] : [];
  }).slice(0, limit);
  return {
    calls: dueCalls,
    nextOffset: !requestedCallId && calls.length === scanLimit ? offset + scanLimit : null,
  };
}

function retryStatus(value: unknown): RetryableStatus | null {
  return value === 'pending' || value === 'unavailable' || value === 'failed' ? value : null;
}

async function storeInternalCallContent(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  forcedKind?: CallContentKind,
): Promise<Response> {
  const kind = forcedKind ?? body.kind;
  if (kind !== 'transcript' && kind !== 'recording' && kind !== 'summary') {
    return response({ error: 'A valid call-content kind is required' }, 400);
  }
  const callId = cleanString(body.callId, 200);
  if (!callId || !/^AC[A-Za-z0-9_-]+$/.test(callId)) {
    return response({ error: 'A valid call id is required' }, 400);
  }
  const scope = await activeScope(supabase);
  const activity = await findScopedCallActivity(supabase, scope, callId);
  if (!activity) return response({ ignored: true, reason: 'call-out-of-scope' });

  const status = retryStatus(body.status);
  if (status) {
    const reason = cleanString(body.reason, 1000) ?? `Quo ${kind} is not available yet.`;
    const rawHttpStatus = Number(body.httpStatus);
    const httpStatus = Number.isInteger(rawHttpStatus) && rawHttpStatus >= 100 && rawHttpStatus <= 599
      ? rawHttpStatus
      : null;
    const rawNextRetryAt = cleanString(body.nextRetryAt, 80);
    const nextRetryAt = rawNextRetryAt && Number.isFinite(Date.parse(rawNextRetryAt))
      ? rawNextRetryAt
      : new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const storedStatus = await storeContentStatus(
      supabase, activity.id, callId, kind, status, reason, httpStatus, nextRetryAt,
    );
    return response({ stored: true, status: storedStatus, activityId: activity.id });
  }

  if (kind === 'transcript') {
    const transcript = transcriptInput({
      id: body.transcriptId ?? `internal-${callId}`,
      type: 'call.transcript.completed',
      data: { object: body.data },
    });
    if (!transcript) return response({ error: 'Invalid transcript data' }, 400);
    await storeTranscript(supabase, activity.id, transcript);
  } else if (kind === 'recording') {
    const raw = body.data;
    const data = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const recording = recordingInput({
      type: 'call.recording.completed',
      data: { object: {
        ...data,
        id: callId,
        media: Array.isArray(raw)
          ? raw
          : Array.isArray(data.media)
            ? data.media
            : Array.isArray(data.recordings)
              ? data.recordings
              : [],
      } },
    });
    if (!recording) return response({ error: 'Invalid recording data' }, 400);
    await storeRecording(supabase, activity.id, recording);
  } else {
    const raw = body.data;
    const data = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const summary = summaryInput({
      type: 'call.summary.completed',
      data: { object: { ...data, callId } },
    });
    if (!summary) return response({ error: 'Invalid summary data' }, 400);
    await storeSummary(supabase, activity.id, summary);
  }
  return response({ stored: true, status: 'available', activityId: activity.id });
}

async function handleInternal(req: Request, supabase: SupabaseClient, action: string): Promise<Response> {
  if (!authorizedInternal(req)) return response({ error: 'Unauthorized' }, 401);
  if (req.method === 'GET' && action === 'status') {
    const [eventResult, importResult, scopeResult] = await Promise.all([
      supabase
        .from('quo_webhook_events')
        .select('event_type,processing_status,received_at,processed_at,last_error')
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('quo_import_runs')
        .select('id,import_kind,filename,status,rows_seen,rows_imported,rows_skipped,started_at,completed_at,last_error')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('quo_phone_scopes')
        .select('phone_number_id,phone_number_e164,label')
        .eq('active', true)
        .order('phone_number_e164'),
    ]);
    if (eventResult.error) throw eventResult.error;
    if (importResult.error) throw importResult.error;
    if (scopeResult.error) throw scopeResult.error;
    return response({
      signingSecretConfigured: quoWebhookSigningSecrets().length > 0,
      lastEvent: eventResult.data,
      lastImport: importResult.data,
      selectedPhoneNumbers: scopeResult.data ?? [],
    });
  }

/** Rows the Quo Metrics export could stand up as events but not fill in.
 *
 * The export carries delivery records — who, when, status — and no message
 * body, so a webhook outage recovered through it leaves the text missing.
 * These rows are addressable by counterparty and timestamp, which is what the
 * Quo messages API needs. */
const QUO_MESSAGE_PLACEHOLDER = 'Message content unavailable from Quo Metrics export';

async function quoMessageContentCandidates(supabase: SupabaseClient, url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '100'), 1), 200);
  const { data, error } = await supabase
    .from('activities')
    .select('id,external_id,direction,from_phone,to_phones,occurred_at,source_metadata')
    .eq('source', 'quo')
    .eq('preview', QUO_MESSAGE_PLACEHOLDER)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => {
    // Which line the message belongs to is recorded by Quo; inferring it from
    // the phone fields picks up the customer's number on inbound rows.
    const metrics = (row.source_metadata ?? {}) as Record<string, unknown>;
    const quoMetrics = (metrics.quoMetrics ?? {}) as Record<string, unknown>;
    const lineLabel = typeof quoMetrics.phoneNumberLabel === 'string' ? quoMetrics.phoneNumberLabel : null;
    return {
      id: row.id,
      externalId: row.external_id,
      direction: row.direction,
      // Every end of the thread, not just one: a group text needs all of its
      // participants to be addressable, and asking for one returns that
      // person's private thread instead.
      participants: [
        row.from_phone,
        ...(Array.isArray(row.to_phones) ? row.to_phones : []),
      ].filter((value): value is string => typeof value === 'string' && value.trim() !== ''),
      lineLabel,
      occurredAt: row.occurred_at,
    };
  }).filter((row) => row.participants.length > 0 && row.lineLabel);
}

/** Write a recovered body back over its placeholder. */
async function storeQuoMessageContent(supabase: SupabaseClient, body: Record<string, unknown>) {
  const id = Number(body.id);
  const text = typeof body.text === 'string' ? body.text : '';
  if (!Number.isSafeInteger(id) || id <= 0 || text.trim() === '') {
    return response({ error: 'Invalid Quo message content payload' }, 400);
  }
  const { error } = await supabase
    .from('activities')
    .update({ preview: text, body_text: text })
    .eq('id', id)
    .eq('preview', QUO_MESSAGE_PLACEHOLDER);
  if (error) throw error;
  return response({ ok: true, id });
}

  if (req.method === 'GET' && action === 'message-content-candidates') {
    return response({ messages: await quoMessageContentCandidates(supabase, new URL(req.url)) });
  }

  if (req.method === 'POST' && action === 'message-content') {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response({ error: 'Invalid Quo message content payload' }, 400);
    }
    return await storeQuoMessageContent(supabase, body as Record<string, unknown>);
  }

  if (req.method === 'GET' && (action === 'transcript-candidates' || action === 'call-content-candidates')) {
    const candidates = await callContentCandidates(supabase, new URL(req.url));
    return response({
      calls: action === 'transcript-candidates'
        ? candidates.calls.filter((call) => Array.isArray(call.needed) && call.needed.includes('transcript'))
        : candidates.calls,
      nextOffset: candidates.nextOffset,
    });
  }

  if (req.method === 'POST' && action === 'scope') {
    const body: unknown = await req.json().catch(() => null);
    if (!validScopeBody(body)) return response({ error: 'Invalid Quo phone-line scope' }, 400);
    await replaceScope(supabase, body.connectionId, body.phoneNumbers);
    return response({ selected: body.phoneNumbers.length });
  }

  if (req.method === 'POST' && action === 'backfill') {
    const body: unknown = await req.json().catch(() => null);
    if (!validImportBody(body)) return response({ error: 'Invalid Quo import batch' }, 400);
    if (body.contacts.length > 0) {
      return response({ error: 'Workspace-wide Quo contact imports are disabled' }, 409);
    }
    const scope = await activeScope(supabase);
    const scopedActivities = body.activities.filter((activity) => activityIsInScope(activity, scope));
    const importedActivities = await upsertActivities(supabase, scopedActivities);
    const { error } = await supabase.from('quo_import_runs').upsert(body.run, { onConflict: 'id' });
    if (error) throw error;
    return response({ imported: importedActivities });
  }

  if (req.method === 'POST' && action === 'metrics-reconcile') {
    const body: unknown = await req.json().catch(() => null);
    if (!validMetricImportBody(body)) return response({ error: 'Invalid Quo Metrics batch' }, 400);
    const scope = await activeScope(supabase);
    const outsideScope = body.rows.find((row) => !scope.phones.has(row.accountPhone));
    if (outsideScope) {
      return response({ error: `Metrics row ${outsideScope.sourceRowNumber} is outside the selected Quo phone line` }, 409);
    }
    const { data, error } = await supabase.rpc('ingest_quo_metric_activity_rows', {
      p_workspace_key: WORKSPACE_KEY,
      p_source_file: body.sourceFile,
      p_source_file_sha256: body.sourceFileSha256,
      p_rows: body.rows,
    });
    if (error) throw error;
    const { error: runError } = await supabase.from('quo_import_runs').upsert(body.run, { onConflict: 'id' });
    if (runError) throw runError;
    return response({ reconciled: data });
  }

  if (req.method === 'POST' && (action === 'transcript' || action === 'call-content')) {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response({ error: 'Invalid Quo call-content payload' }, 400);
    }
    return await storeInternalCallContent(
      supabase,
      body as Record<string, unknown>,
      action === 'transcript' ? 'transcript' : undefined,
    );
  }

  if (req.method === 'POST' && action === 'enrich-contacts') {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Array.isArray((body as Record<string, unknown>).contacts) ||
      ((body as Record<string, unknown>).contacts as unknown[]).length > 500) {
      return response({ error: 'Invalid Quo contact enrichment payload' }, 400);
    }
    const scope = await activeScope(supabase);
    return response(await enrichQuoContacts(
      supabase,
      (body as Record<string, unknown>).contacts as unknown[],
      scope,
    ));
  }

  return response({ error: 'Not found' }, 404);
}

function webhookActivity(payload: Record<string, unknown>, scope: ActiveScope): ActivityInput | null {
  const type = cleanString(payload.type, 80);
  if (type !== 'message.received' && type !== 'message.delivered' && type !== 'call.completed') return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const object = (data as Record<string, unknown>).object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const item = object as Record<string, unknown>;
  const externalId = cleanString(item.id, 200);
  const direction = item.direction === 'outgoing' || type === 'message.delivered' ? 'outbound' : 'inbound';
  const phoneNumberId = cleanString(item.phoneNumberId, 200);
  const isCall = type === 'call.completed';
  const from = isCall ? null : e164(item.from);
  const to = isCall ? [] : phoneList(item.to);
  const participants = isCall ? phoneList(item.participants) : [];
  const accountPhone = isCall
    ? phoneNumberId ? scope.phoneById.get(phoneNumberId) ?? null : null
    : direction === 'inbound' ? to[0] ?? null : from;
  const externalParticipants = isCall
    ? participants.filter((phone) => phone !== accountPhone && !scope.phones.has(phone))
    : [];
  const actorPhone = isCall
    ? externalParticipants[0] ?? participants.find((phone) => phone !== accountPhone) ?? null
    : direction === 'inbound' ? from : to[0] ?? null;
  const occurredAt = cleanString(
    isCall ? item.completedAt ?? item.updatedAt ?? item.createdAt : item.createdAt,
    80,
  ) ?? cleanString(payload.createdAt, 80);
  if (!externalId || !accountPhone || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const text = isCall ? '' : cleanString(item.text ?? item.body, 100_000) ?? '';
  const media = !isCall && Array.isArray(item.media) ? item.media.slice(0, 50) : [];
  const rawCallStatus = isCall ? cleanString(item.status, 80) : null;
  const callStatus = isCall
    ? direction === 'inbound' && cleanString(item.answeredAt, 80)
      ? 'answered'
      : ['no-answer', 'no_answer', 'unanswered', 'missed'].includes((rawCallStatus ?? '').toLowerCase())
        ? 'missed'
        : rawCallStatus
    : null;
  const durationSeconds = isCall ? finiteNumber(item.duration, 0, 1_000_000) : null;
  const threadId = actorPhone
    ? `quo:${phoneNumberId ?? accountPhone}:${normalizedPhone(actorPhone)}`
    : null;
  return {
    source: 'quo',
    account_email: null,
    account_phone: accountPhone,
    external_id: externalId,
    external_thread_id: threadId,
    event_type: isCall ? 'call.completed' : direction === 'inbound' ? 'message.received' : 'message.sent',
    direction,
    actor_name: null,
    actor_email: null,
    actor_phone: actorPhone,
    from_email: null,
    from_phone: isCall ? direction === 'inbound' ? actorPhone : accountPhone : from,
    to_emails: [],
    to_phones: isCall ? direction === 'inbound' ? [accountPhone] : externalParticipants : to,
    cc_emails: [],
    subject: isCall ? `${direction === 'inbound' ? 'Incoming' : 'Outgoing'} call` : 'Text message',
    preview: isCall
      ? `${callStatus ?? 'completed'}${durationSeconds === null ? '' : ` · ${Math.round(durationSeconds)} seconds`}`
      : truncateText(text, 240),
    body_text: isCall ? null : text || null,
    occurred_at: new Date(occurredAt).toISOString(),
    has_attachments: media.length > 0,
    attachment_count: media.length,
    call_status: callStatus,
    duration_seconds: durationSeconds === null ? null : Math.round(durationSeconds),
    source_labels: [],
    source_metadata: {
      quoEventId: payload.id,
      phoneNumberId,
      quoType: isCall ? 'call' : 'message',
      rawCallStatus,
      deliveryStatus: isCall ? null : item.status ?? null,
      statusDetails: item.statusDetails ?? null,
      contactIds: Array.isArray(item.contactIds) ? item.contactIds.slice(0, 50) : [],
      media,
      participants,
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? null,
      answeredAt: isCall ? item.answeredAt ?? null : null,
      answeredBy: isCall ? item.answeredBy ?? null : null,
      initiatedBy: isCall ? item.initiatedBy ?? null : null,
      completedAt: isCall ? item.completedAt ?? null : null,
      callRoute: isCall ? item.callRoute ?? null : null,
      forwardedFrom: isCall ? item.forwardedFrom ?? null : null,
      forwardedTo: isCall ? item.forwardedTo ?? null : null,
      aiHandled: isCall ? item.aiHandled ?? null : null,
      userId: isCall ? item.userId ?? null : null,
    },
    updated_at: new Date().toISOString(),
  };
}

export async function handleRequest(req: Request): Promise<Response> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Supabase URL is unavailable');
    const supabase = createClient(supabaseUrl, databaseSecret(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    if (action) return await handleInternal(req, supabase, action);
    if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405);

    const rawBody = await req.text();
    if (!rawBody || rawBody.length > 1_000_000) return response({ error: 'Invalid webhook body' }, 400);
    const signature = req.headers.get('openphone-signature') ?? req.headers.get('quo-signature');
    if (!(await verifyQuoSignature(rawBody, signature))) {
      return response({ error: 'Invalid webhook signature' }, 401);
    }
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const eventId = cleanString(payload.id, 200);
    const eventType = cleanString(payload.type, 80);
    if (!eventId || !/^EV[A-Za-z0-9_-]+$/.test(eventId) || !eventType) {
      return response({ error: 'Invalid webhook event' }, 400);
    }

    const scope = await activeScope(supabase);
    const transcript = transcriptInput(payload);
    const recording = transcript === null ? recordingInput(payload) : null;
    const summary = transcript === null && recording === null ? summaryInput(payload) : null;
    const callContent: { kind: CallContentKind; value: TranscriptInput | RecordingInput | SummaryInput } | null = transcript
      ? { kind: 'transcript', value: transcript }
      : recording
        ? { kind: 'recording', value: recording }
        : summary
          ? { kind: 'summary', value: summary }
          : null;
    const activity = callContent === null ? webhookActivity(payload, scope) : null;
    const callContentActivity = callContent === null
      ? null
      : await findScopedCallActivity(supabase, scope, callContent.value.callId);
    if (
      (callContent !== null && callContentActivity === null) ||
      (callContent === null && (activity === null || !activityIsInScope(activity, scope)))
    ) {
      // Do not retain payloads for phone lines the workspace did not select.
      return response({ ok: true, ignored: true });
    }

    const existingResult = await supabase
      .from('quo_webhook_events')
      .select('processing_status,attempts')
      .eq('event_id', eventId)
      .maybeSingle();
    if (existingResult.error) throw existingResult.error;
    if (existingResult.data?.processing_status === 'processed' || existingResult.data?.processing_status === 'ignored') {
      await supabase
        .from('quo_webhook_events')
        .update({ attempts: (existingResult.data.attempts ?? 1) + 1, received_at: new Date().toISOString() })
        .eq('event_id', eventId);
      return response({ ok: true, duplicate: true });
    }

    const received = {
      event_id: eventId,
      event_type: eventType,
      api_version: cleanString(payload.apiVersion, 40),
      payload,
      processing_status: 'received',
      attempts: (existingResult.data?.attempts ?? 0) + 1,
      received_at: new Date().toISOString(),
      processed_at: null,
      last_error: null,
    };
    const { error: eventError } = await supabase
      .from('quo_webhook_events')
      .upsert(received, { onConflict: 'event_id' });
    if (eventError) throw eventError;

    try {
      if (callContent?.kind === 'transcript' && callContentActivity !== null) {
        await storeTranscript(supabase, callContentActivity.id, callContent.value as TranscriptInput);
      } else if (callContent?.kind === 'recording' && callContentActivity !== null) {
        await storeRecording(supabase, callContentActivity.id, callContent.value as RecordingInput);
      } else if (callContent?.kind === 'summary' && callContentActivity !== null) {
        await storeSummary(supabase, callContentActivity.id, callContent.value as SummaryInput);
      } else if (activity !== null) {
        await upsertActivities(supabase, [activity]);
      }
      const { error } = await supabase
        .from('quo_webhook_events')
        .update({ processing_status: 'processed', processed_at: new Date().toISOString(), last_error: null })
        .eq('event_id', eventId);
      if (error) throw error;
      return response({ ok: true });
    } catch (error) {
      await supabase
        .from('quo_webhook_events')
        .update({
          processing_status: 'failed',
          processed_at: new Date().toISOString(),
          last_error: error instanceof Error ? error.message.slice(0, 500) : 'Unexpected webhook failure',
        })
        .eq('event_id', eventId);
      throw error;
    }
  } catch (error) {
    console.error(error);
    return response({ error: authorizedInternal(req) ? errorMessage(error) : 'Unexpected function error' }, 500);
  }
}

if (import.meta.main) Deno.serve((req: Request) => handleRequest(req));
