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
  import_kind: 'contacts' | 'messages' | 'calls';
  filename: string;
  status: 'running' | 'succeeded' | 'failed';
  rows_seen: number;
  rows_imported: number;
  rows_skipped: number;
  started_at: string;
  completed_at: string | null;
  last_error: string | null;
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

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const encoder = new TextEncoder();

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

function transcriptInput(payload: Record<string, unknown>): TranscriptInput | null {
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
  const { error: transcriptError } = await supabase
    .from('activity_call_transcripts')
    .upsert({
      activity_id: activityId,
      workspace_key: 'ottawa-painters',
      provider: 'quo',
      provider_call_id: transcript.callId,
      provider_transcript_id: transcript.transcriptId,
      status: 'available',
      dialogue: transcript.dialogue,
      transcript_text: text || null,
      unavailable_reason: null,
      transcript_created_at: transcript.createdAt,
      fetched_at: now,
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
    .eq('workspace_key', 'ottawa-painters')
    .eq('kind', 'phone')
    .in('normalized_value', [...new Set(matched.map((candidate) => candidate.phone))]);
  if (identityError) throw identityError;
  const identityByPhone = new Map((identities ?? []).map((identity) => [identity.normalized_value, identity]));
  const evidenceRows = matched.flatMap((candidate) => {
    const identity = identityByPhone.get(candidate.phone);
    if (!identity) return [];
    return [{
      workspace_key: 'ottawa-painters',
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

  if (req.method === 'GET' && action === 'transcript-candidates') {
    const scope = await activeScope(supabase);
    if (scope.phones.size === 0) return response({ calls: [] });
    const [callsResult, transcriptsResult] = await Promise.all([
      supabase
        .from('activities')
        .select('id,external_id,account_phone,occurred_at')
        .eq('source', 'quo')
        .eq('event_type', 'call.completed')
        .in('account_phone', [...scope.phones])
        .gte('occurred_at', new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
        .order('occurred_at', { ascending: false })
        .limit(1000),
      supabase
        .from('activity_call_transcripts')
        .select('activity_id')
        .eq('workspace_key', 'ottawa-painters'),
    ]);
    if (callsResult.error) throw callsResult.error;
    if (transcriptsResult.error) throw transcriptsResult.error;
    const completed = new Set((transcriptsResult.data ?? []).map((row) => row.activity_id));
    return response({
      calls: (callsResult.data ?? [])
        .filter((call) => !completed.has(call.id))
        .slice(0, 100),
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

  if (req.method === 'POST' && action === 'transcript') {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response({ error: 'Invalid Quo transcript payload' }, 400);
    }
    const object = body as Record<string, unknown>;
    const callId = cleanString(object.callId, 200);
    if (!callId) return response({ error: 'A call id is required' }, 400);
    const scope = await activeScope(supabase);
    const activity = await findScopedCallActivity(supabase, scope, callId);
    if (!activity) return response({ ignored: true, reason: 'call-out-of-scope' });
    if (object.status === 'unavailable') {
      const reason = cleanString(object.reason, 1000) ?? 'Quo did not provide a transcript for this call.';
      const now = new Date().toISOString();
      const { error } = await supabase.from('activity_call_transcripts').upsert({
        activity_id: activity.id,
        workspace_key: 'ottawa-painters',
        provider: 'quo',
        provider_call_id: callId,
        provider_transcript_id: null,
        status: 'unavailable',
        dialogue: [],
        transcript_text: null,
        unavailable_reason: reason,
        fetched_at: now,
        updated_at: now,
      }, { onConflict: 'activity_id' });
      if (error) throw error;
      return response({ stored: true, status: 'unavailable', activityId: activity.id });
    }
    const transcript = transcriptInput({
      id: object.transcriptId ?? `internal-${callId}`,
      type: 'call.transcript.completed',
      data: { object: object.data },
    });
    if (!transcript) return response({ error: 'Invalid transcript data' }, 400);
    await storeTranscript(supabase, activity.id, transcript);
    return response({ stored: true, status: 'available', activityId: activity.id });
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
  const actorPhone = isCall ? participants[0] ?? null : direction === 'inbound' ? from : to[0] ?? null;
  const occurredAt = cleanString(
    isCall ? item.completedAt ?? item.updatedAt ?? item.createdAt : item.createdAt,
    80,
  ) ?? cleanString(payload.createdAt, 80);
  if (!externalId || !accountPhone || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const text = isCall ? '' : cleanString(item.text ?? item.body, 100_000) ?? '';
  const media = !isCall && Array.isArray(item.media) ? item.media.slice(0, 50) : [];
  const callStatus = isCall ? cleanString(item.status, 80) : null;
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
    to_phones: isCall ? direction === 'inbound' ? [accountPhone] : participants : to,
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
      deliveryStatus: isCall ? null : item.status ?? null,
      contactIds: Array.isArray(item.contactIds) ? item.contactIds.slice(0, 50) : [],
      media,
      participants,
      answeredAt: isCall ? item.answeredAt ?? null : null,
      completedAt: isCall ? item.completedAt ?? null : null,
      userId: isCall ? item.userId ?? null : null,
    },
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (req: Request) => {
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
    if (!(await verifyQuoSignature(rawBody, req.headers.get('openphone-signature')))) {
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
    const activity = transcript === null ? webhookActivity(payload, scope) : null;
    const transcriptActivity = transcript === null
      ? null
      : await findScopedCallActivity(supabase, scope, transcript.callId);
    if (
      (transcript !== null && transcriptActivity === null) ||
      (transcript === null && (activity === null || !activityIsInScope(activity, scope)))
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
      if (transcript !== null && transcriptActivity !== null) {
        await storeTranscript(supabase, transcriptActivity.id, transcript);
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
});
