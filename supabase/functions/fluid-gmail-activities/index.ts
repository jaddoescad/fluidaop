import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

type ActivityRow = {
  source: 'gmail';
  account_email: string;
  external_id: string;
  external_thread_id: string | null;
  event_type: 'email.received' | 'email.sent';
  direction: 'inbound' | 'outbound';
  actor_name: string | null;
  actor_email: string | null;
  from_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  preview: string;
  body_text: string | null;
  occurred_at: string;
  has_attachments: boolean;
  attachment_count: number;
  source_labels: string[];
  source_metadata: Record<string, unknown>;
  updated_at: string;
  contact_id?: string | null;
};

type SyncState = {
  connection_id: string;
  account_email: string;
  last_history_id: string | null;
  last_sync_status: 'running' | 'succeeded' | 'failed';
  last_sync_started_at: string;
  last_sync_completed_at: string | null;
  last_full_sync_at: string | null;
  messages_seen: number;
  messages_upserted: number;
  last_error: string | null;
  updated_at: string;
};

type UpsertPayload = {
  activities: ActivityRow[];
  syncState: SyncState;
};

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

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
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return different === 0;
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET');
  const supplied = req.headers.get('x-fluid-activity-secret') ?? '';
  return Boolean(expected && supplied && safeEqual(expected, supplied));
}

function cleanLimit(raw: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, parsed));
}

function positiveId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cursorFrom(url: URL): { occurredAt: string; id: number } | null | false {
  const rawOccurredAt = url.searchParams.get('cursorAt');
  const rawId = url.searchParams.get('cursorId');
  if (rawOccurredAt === null && rawId === null) return null;
  const id = positiveId(rawId);
  const timestamp = rawOccurredAt === null ? Number.NaN : Date.parse(rawOccurredAt);
  if (id === null || !Number.isFinite(timestamp)) return false;
  return { occurredAt: new Date(timestamp).toISOString(), id };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= maximum ? cleaned : null;
}

function labelKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function validPayload(value: unknown): value is UpsertPayload {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<UpsertPayload>;
  if (!Array.isArray(body.activities) || !body.syncState || typeof body.syncState !== 'object') {
    return false;
  }
  if (body.activities.length > 1000) return false;
  return body.activities.every((activity) =>
    activity !== null &&
    typeof activity === 'object' &&
    activity.source === 'gmail' &&
    typeof activity.external_id === 'string' &&
    typeof activity.account_email === 'string'
  );
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Supabase URL is unavailable');
    const supabase = createClient(supabaseUrl, databaseSecret(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const url = new URL(req.url);
    const action = url.searchParams.get('action') ?? 'list';
    const accountEmail = (url.searchParams.get('accountEmail') ?? '').trim().toLowerCase();

    if (req.method === 'GET' && action === 'list') {
      if (!accountEmail) return response({ error: 'accountEmail is required' }, 400);
      const limit = cleanLimit(url.searchParams.get('limit'), 30, 50);
      const cursor = cursorFrom(url);
      if (cursor === false) return response({ error: 'Invalid activity cursor' }, 400);

      let signalsQuery = supabase
        .from('activities')
        .select(
          'id,source,account_email,external_id,external_thread_id,direction,actor_name,actor_email,from_email,to_emails,cc_emails,subject,preview,occurred_at,has_attachments,attachment_count,contact_id',
        )
        .eq('account_email', accountEmail)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        signalsQuery = signalsQuery.or(
          `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`,
        );
      }

      const [signalsResult, countResult, syncResult] = await Promise.all([
        signalsQuery,
        supabase
          .from('activities')
          .select('id', { count: 'exact', head: true })
          .eq('account_email', accountEmail),
        supabase.from('gmail_sync_state').select('*').eq('account_email', accountEmail).maybeSingle(),
      ]);

      const failure = [signalsResult, countResult, syncResult]
        .map((result) => result.error)
        .find(Boolean);
      if (failure) throw failure;

      const fetched = signalsResult.data ?? [];
      const hasMore = fetched.length > limit;
      const rawSignals = fetched.slice(0, limit);
      const signalIds = rawSignals.map((signal) => signal.id);
      const classificationResult = signalIds.length === 0
        ? { data: [], error: null }
        : await supabase
          .from('signal_labels')
          .select('activity_id,confidence,reason,updated_at,label:labels!signal_labels_label_id_fkey(key,name,color)')
          .eq('agent_key', 'email-categorizer')
          .in('activity_id', signalIds);
      if (classificationResult.error) throw classificationResult.error;
      const classificationBySignal = new Map(
        (classificationResult.data ?? []).map((classification) => [classification.activity_id, classification]),
      );
      const signals = rawSignals.map((signal) => ({
        ...signal,
        classification: classificationBySignal.get(signal.id) ?? null,
      }));
      const last = signals[signals.length - 1];
      return response({
        signals,
        count: countResult.count ?? 0,
        nextCursor: hasMore && last
          ? { occurredAt: last.occurred_at, id: last.id }
          : null,
        sync: syncResult.data,
      });
    }

    if (req.method === 'GET' && action === 'signal') {
      const signalId = positiveId(url.searchParams.get('signalId'));
      if (!accountEmail || signalId === null) {
        return response({ error: 'Valid signalId and accountEmail are required' }, 400);
      }
      const { data, error } = await supabase
        .from('activities')
        .select(
          'id,source,account_email,external_id,external_thread_id,direction,actor_name,actor_email,from_email,to_emails,cc_emails,subject,preview,body_text,occurred_at,has_attachments,attachment_count,contact_id',
        )
        .eq('account_email', accountEmail)
        .eq('id', signalId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return response({ error: 'Signal not found' }, 404);

      const [classificationResult, attachmentsResult] = await Promise.all([
        supabase
          .from('signal_labels')
          .select('confidence,reason,updated_at,label:labels!signal_labels_label_id_fkey(key,name,color)')
          .eq('activity_id', signalId)
          .eq('agent_key', 'email-categorizer')
          .maybeSingle(),
        supabase
          .from('signal_attachment_evidence')
          .select('attachment_key,filename,mime_type,size_bytes,extraction_status,extraction_method,updated_at')
          .eq('activity_id', signalId)
          .eq('agent_key', 'email-categorizer')
          .order('id', { ascending: true }),
      ]);
      if (classificationResult.error) throw classificationResult.error;
      if (attachmentsResult.error) throw attachmentsResult.error;

      let historyCount = 0;
      if (data.external_thread_id) {
        const historyResult = await supabase
          .from('activities')
          .select('id', { count: 'exact', head: true })
          .eq('account_email', accountEmail)
          .eq('external_thread_id', data.external_thread_id)
          .neq('id', signalId);
        if (historyResult.error) throw historyResult.error;
        historyCount = historyResult.count ?? 0;
      }
      return response({
        signal: {
          ...data,
          classification: classificationResult.data,
          attachmentEvidence: attachmentsResult.data ?? [],
        },
        historyCount,
      });
    }

    if (req.method === 'GET' && action === 'history') {
      const signalId = positiveId(url.searchParams.get('signalId'));
      const limit = cleanLimit(url.searchParams.get('limit'), 5, 20);
      const cursor = cursorFrom(url);
      if (!accountEmail || signalId === null || cursor === false) {
        return response({ error: 'Valid signalId, accountEmail, and cursor are required' }, 400);
      }

      const selectedResult = await supabase
        .from('activities')
        .select('external_thread_id')
        .eq('account_email', accountEmail)
        .eq('id', signalId)
        .maybeSingle();
      if (selectedResult.error) throw selectedResult.error;
      if (!selectedResult.data) return response({ error: 'Signal not found' }, 404);
      const threadId = selectedResult.data.external_thread_id;
      if (!threadId) return response({ messages: [], count: 0, nextCursor: null });

      let messagesQuery = supabase
        .from('activities')
        .select(
          'id,source,account_email,external_id,external_thread_id,direction,actor_name,actor_email,from_email,to_emails,cc_emails,subject,preview,body_text,occurred_at,has_attachments,attachment_count,contact_id',
        )
        .eq('account_email', accountEmail)
        .eq('external_thread_id', threadId)
        .neq('id', signalId)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        messagesQuery = messagesQuery.or(
          `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`,
        );
      }

      const [messagesResult, countResult] = await Promise.all([
        messagesQuery,
        supabase
          .from('activities')
          .select('id', { count: 'exact', head: true })
          .eq('account_email', accountEmail)
          .eq('external_thread_id', threadId)
          .neq('id', signalId),
      ]);
      if (messagesResult.error) throw messagesResult.error;
      if (countResult.error) throw countResult.error;

      const fetched = messagesResult.data ?? [];
      const hasMore = fetched.length > limit;
      const messages = fetched.slice(0, limit);
      const last = messages[messages.length - 1];
      return response({
        messages,
        count: countResult.count ?? 0,
        nextCursor: hasMore && last
          ? { occurredAt: last.occurred_at, id: last.id }
          : null,
      });
    }

    if (req.method === 'GET' && action === 'state') {
      if (!accountEmail) return response({ error: 'accountEmail is required' }, 400);
      const { data, error } = await supabase
        .from('gmail_sync_state')
        .select('*')
        .eq('account_email', accountEmail)
        .maybeSingle();
      if (error) throw error;
      return response({ sync: data });
    }

    if (req.method === 'GET' && action === 'labels') {
      if (!accountEmail) return response({ error: 'accountEmail is required' }, 400);
      const { data, error } = await supabase
        .from('labels')
        .select('id,kind,key,name,description,color,enabled,sort_order,created_at,updated_at')
        .eq('account_email', accountEmail)
        .order('kind', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });
      if (error) throw error;
      return response({ labels: data ?? [] });
    }

    if (req.method === 'GET' && action === 'agent-history') {
      const limit = cleanLimit(url.searchParams.get('limit'), 20, 50);
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id,status,model,error,started_at,finished_at')
        .eq('agent_key', 'email-categorizer')
        .order('finished_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return response({
        agentId: 'email-categorizer',
        jobs: [{
          id: 'email-categorizer',
          name: 'Fluid Email Categorizer — database only — every 5 minutes',
          profile: 'default',
        }],
        runs: (data ?? []).map((run) => ({
          id: run.id,
          jobId: 'email-categorizer',
          jobName: 'Fluid Email Categorizer — database only — every 5 minutes',
          profile: 'default',
          status: run.status,
          source: 'supabase-agent-audit',
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          error: run.error,
          sessionId: null,
          model: run.model,
          messageCount: null,
          toolCallCount: null,
        })),
        fetchedAt: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && action === 'label') {
      if (!accountEmail) return response({ error: 'accountEmail is required' }, 400);
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return response({ error: 'A valid label body is required' }, 400);
      }
      const input = body as Record<string, unknown>;
      const id = input.id === undefined ? null : positiveId(String(input.id));
      const kind = input.kind === 'urgency' || input.kind === 'email' ? input.kind : null;
      const name = cleanText(input.name, 80);
      const description = typeof input.description === 'string' && input.description.length <= 500
        ? input.description.trim()
        : null;
      const color = typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
        ? input.color.toLowerCase()
        : null;
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : null;
      if (kind === null || name === null || description === null || color === null || enabled === null) {
        return response({ error: 'Valid kind, name, description, color, and enabled fields are required' }, 400);
      }

      if (id === null) {
        const key = labelKey(name);
        if (!key) return response({ error: 'Label name must contain a letter or number' }, 400);
        const { data, error } = await supabase
          .from('labels')
          .insert({ account_email: accountEmail, kind, key, name, description, color, enabled, sort_order: 900 })
          .select('id,kind,key,name,description,color,enabled,sort_order,created_at,updated_at')
          .single();
        if (error) {
          if (error.code === '23505') return response({ error: 'A label with that name already exists' }, 409);
          throw error;
        }
        return response({ label: data }, 201);
      }

      const { data, error } = await supabase
        .from('labels')
        .update({ kind, name, description, color, enabled, updated_at: new Date().toISOString() })
        .eq('account_email', accountEmail)
        .eq('id', id)
        .select('id,kind,key,name,description,color,enabled,sort_order,created_at,updated_at')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') return response({ error: 'A label with that name already exists' }, 409);
        throw error;
      }
      if (!data) return response({ error: 'Label not found' }, 404);
      return response({ label: data });
    }

    if (req.method === 'POST' && action === 'upsert') {
      const body: unknown = await req.json();
      if (!validPayload(body)) return response({ error: 'Invalid activity payload' }, 400);

      const emails = [...new Set(body.activities.map((item) => item.actor_email).filter((email): email is string => Boolean(email)))];
      const contactByEmail = new Map<string, string>();
      for (const emailBatch of chunks(emails, 100)) {
        const { data, error } = await supabase
          .from('contacts')
          .select('id,normalized_email')
          .in('normalized_email', emailBatch);
        if (error) throw error;
        for (const contact of data ?? []) {
          if (contact.normalized_email) contactByEmail.set(contact.normalized_email, contact.id);
        }
      }

      const rows = body.activities.map((activity) => ({
        ...activity,
        contact_id: activity.actor_email ? contactByEmail.get(activity.actor_email) ?? null : null,
      }));
      for (const rowBatch of chunks(rows, 200)) {
        const { error } = await supabase
          .from('activities')
          .upsert(rowBatch, { onConflict: 'source,account_email,external_id' });
        if (error) throw error;
      }

      const { error: syncError } = await supabase
        .from('gmail_sync_state')
        .upsert(body.syncState, { onConflict: 'connection_id' });
      if (syncError) throw syncError;

      return response({ upserted: rows.length });
    }

    return response({ error: 'Not found' }, 404);
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : 'Unexpected function error' }, 500);
  }
});
