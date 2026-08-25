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

type ContactInput = {
  externalId: string | null;
  name: string;
  email: string | null;
  phone: string;
  normalizedPhone: string;
  sourceMetadata: Record<string, unknown>;
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

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const encoder = new TextEncoder();

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
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
  const expected = Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET');
  const supplied = req.headers.get('x-fluid-activity-secret') ?? '';
  return Boolean(expected && supplied && safeEqual(expected, supplied));
}

function cleanString(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
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

async function verifyQuoSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get('QUO_WEBHOOK_SIGNING_SECRET')?.trim();
  if (!secret || !header) return false;
  const compactBody = JSON.stringify(JSON.parse(rawBody) as unknown);
  const signatures = header.split(',').map((item) => item.trim()).filter(Boolean);
  for (const signature of signatures) {
    const [scheme, version, rawTimestamp, provided] = signature.split(';');
    if (scheme !== 'hmac' || version !== '1' || !rawTimestamp || !provided) continue;
    const timestamp = Number(rawTimestamp);
    const timestampMs = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) continue;
    const key = await crypto.subtle.importKey(
      'raw',
      base64Bytes(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${rawTimestamp}.${compactBody}`));
    if (safeEqual(base64(digest), provided.replace(/\s/g, ''))) return true;
  }
  return false;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function contactsByPhone(
  supabase: SupabaseClient,
  phones: Array<string | null>,
): Promise<Map<string, string>> {
  const normalized = [...new Set(phones.filter((phone): phone is string => Boolean(phone)).map(normalizedPhone))];
  const result = new Map<string, string>();
  for (const batch of chunks(normalized, 100)) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id,normalized_phone')
      .in('normalized_phone', batch);
    if (error) throw error;
    for (const contact of data ?? []) {
      if (contact.normalized_phone && !result.has(contact.normalized_phone)) {
        result.set(contact.normalized_phone, contact.id);
      }
    }
  }
  return result;
}

async function upsertActivities(supabase: SupabaseClient, activities: ActivityInput[]): Promise<number> {
  if (activities.length === 0) return 0;
  const contactIds = await contactsByPhone(supabase, activities.map((item) => item.actor_phone));
  const rows = activities.map((activity) => ({
    ...activity,
    contact_id: activity.actor_phone
      ? contactIds.get(normalizedPhone(activity.actor_phone)) ?? null
      : null,
  }));
  for (const batch of chunks(rows, 200)) {
    const { error } = await supabase
      .from('activities')
      .upsert(batch, { onConflict: 'source,account_key,external_id' });
    if (error) throw error;
  }
  return rows.length;
}

async function upsertContacts(supabase: SupabaseClient, contacts: ContactInput[]): Promise<number> {
  let imported = 0;
  for (const contact of contacts) {
    const { data: existing, error: findError } = await supabase
      .from('contacts')
      .select('id,metadata')
      .eq('normalized_phone', contact.normalizedPhone)
      .limit(1)
      .maybeSingle();
    if (findError) throw findError;
    const quoMetadata = {
      ...(contact.sourceMetadata ?? {}),
      ...(contact.externalId ? { contactId: contact.externalId } : {}),
    };
    if (existing) {
      const metadata = existing.metadata && typeof existing.metadata === 'object'
        ? existing.metadata as Record<string, unknown>
        : {};
      const { error } = await supabase
        .from('contacts')
        .update({ metadata: { ...metadata, quo: quoMetadata }, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('contacts').insert({
        id: crypto.randomUUID(),
        kind: 'other',
        name: contact.name || contact.phone,
        email: contact.email,
        phone: contact.phone,
        normalized_email: contact.email?.trim().toLowerCase() ?? null,
        normalized_phone: contact.normalizedPhone,
        metadata: { quo: quoMetadata },
      });
      if (error) throw error;
    }
    imported += 1;
  }
  return imported;
}

function validImportBody(value: unknown): value is {
  run: ImportRun;
  activities: ActivityInput[];
  contacts: ContactInput[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!body.run || typeof body.run !== 'object') return false;
  if (!Array.isArray(body.activities) || !Array.isArray(body.contacts)) return false;
  if (body.activities.length > 500 || body.contacts.length > 500) return false;
  return true;
}

async function handleInternal(req: Request, supabase: SupabaseClient, action: string): Promise<Response> {
  if (!authorizedInternal(req)) return response({ error: 'Unauthorized' }, 401);
  if (req.method === 'GET' && action === 'status') {
    const [eventResult, importResult] = await Promise.all([
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
    ]);
    if (eventResult.error) throw eventResult.error;
    if (importResult.error) throw importResult.error;
    return response({
      signingSecretConfigured: Boolean(Deno.env.get('QUO_WEBHOOK_SIGNING_SECRET')?.trim()),
      lastEvent: eventResult.data,
      lastImport: importResult.data,
    });
  }

  if (req.method === 'POST' && action === 'backfill') {
    const body: unknown = await req.json().catch(() => null);
    if (!validImportBody(body)) return response({ error: 'Invalid Quo import batch' }, 400);
    const importedContacts = await upsertContacts(supabase, body.contacts);
    const importedActivities = await upsertActivities(supabase, body.activities);
    const { error } = await supabase.from('quo_import_runs').upsert(body.run, { onConflict: 'id' });
    if (error) throw error;
    return response({ imported: importedContacts + importedActivities });
  }

  return response({ error: 'Not found' }, 404);
}

function webhookActivity(payload: Record<string, unknown>): ActivityInput | null {
  const type = cleanString(payload.type, 80);
  if (type !== 'message.received' && type !== 'message.delivered') return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const object = (data as Record<string, unknown>).object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const message = object as Record<string, unknown>;
  const externalId = cleanString(message.id, 200);
  const direction = message.direction === 'outgoing' || type === 'message.delivered' ? 'outbound' : 'inbound';
  const from = e164(message.from);
  const to = Array.isArray(message.to) ? message.to.map(e164).filter((phone): phone is string => phone !== null) : [];
  const accountPhone = direction === 'inbound' ? to[0] ?? null : from;
  const actorPhone = direction === 'inbound' ? from : to[0] ?? null;
  const occurredAt = cleanString(message.createdAt, 80) ?? cleanString(payload.createdAt, 80);
  if (!externalId || !accountPhone || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const text = cleanString(message.text ?? message.body, 100_000) ?? '';
  const media = Array.isArray(message.media) ? message.media.slice(0, 50) : [];
  const phoneNumberId = cleanString(message.phoneNumberId, 200);
  const threadId = actorPhone
    ? `quo:${phoneNumberId ?? accountPhone}:${normalizedPhone(actorPhone)}`
    : null;
  return {
    source: 'quo',
    account_email: null,
    account_phone: accountPhone,
    external_id: externalId,
    external_thread_id: threadId,
    event_type: direction === 'inbound' ? 'message.received' : 'message.sent',
    direction,
    actor_name: null,
    actor_email: null,
    actor_phone: actorPhone,
    from_email: null,
    from_phone: from,
    to_emails: [],
    to_phones: to,
    cc_emails: [],
    subject: 'Text message',
    preview: text.slice(0, 240),
    body_text: text || null,
    occurred_at: new Date(occurredAt).toISOString(),
    has_attachments: media.length > 0,
    attachment_count: media.length,
    call_status: null,
    duration_seconds: null,
    source_labels: [],
    source_metadata: {
      quoEventId: payload.id,
      phoneNumberId,
      deliveryStatus: message.status ?? null,
      contactIds: Array.isArray(message.contactIds) ? message.contactIds : [],
      media,
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
      const activity = webhookActivity(payload);
      const status = activity === null ? 'ignored' : 'processed';
      if (activity !== null) await upsertActivities(supabase, [activity]);
      const { error } = await supabase
        .from('quo_webhook_events')
        .update({ processing_status: status, processed_at: new Date().toISOString(), last_error: null })
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
    return response({ error: error instanceof Error ? error.message : 'Unexpected function error' }, 500);
  }
});
