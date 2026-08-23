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
  is_unread: boolean;
  has_attachments: boolean;
  attachment_count: number;
  needs_attention: boolean;
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

function cleanLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(1, Math.min(200, parsed));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
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
      const limit = cleanLimit(url.searchParams.get('limit'));
      const filter = url.searchParams.get('filter') ?? 'all';
      let query = supabase
        .from('activities')
        .select(
          'id,source,account_email,external_id,external_thread_id,event_type,direction,actor_name,actor_email,from_email,to_emails,cc_emails,subject,preview,occurred_at,is_unread,has_attachments,attachment_count,needs_attention,contact_id,source_labels',
        )
        .eq('account_email', accountEmail)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);

      if (filter === 'needs_reply') query = query.eq('needs_attention', true);
      if (filter === 'received') query = query.eq('direction', 'inbound');
      if (filter === 'sent') query = query.eq('direction', 'outbound');
      if (filter === 'attachments') query = query.eq('has_attachments', true);

      const countBase = () =>
        supabase.from('activities').select('id', { count: 'exact', head: true }).eq('account_email', accountEmail);
      const [activitiesResult, all, needsReply, received, sent, attachments, syncResult] = await Promise.all([
        query,
        countBase(),
        countBase().eq('needs_attention', true),
        countBase().eq('direction', 'inbound'),
        countBase().eq('direction', 'outbound'),
        countBase().eq('has_attachments', true),
        supabase.from('gmail_sync_state').select('*').eq('account_email', accountEmail).maybeSingle(),
      ]);

      const failure = [activitiesResult, all, needsReply, received, sent, attachments, syncResult]
        .map((result) => result.error)
        .find(Boolean);
      if (failure) throw failure;

      return response({
        activities: activitiesResult.data ?? [],
        counts: {
          all: all.count ?? 0,
          needsReply: needsReply.count ?? 0,
          received: received.count ?? 0,
          sent: sent.count ?? 0,
          attachments: attachments.count ?? 0,
        },
        sync: syncResult.data,
      });
    }

    if (req.method === 'GET' && action === 'detail') {
      const id = Number.parseInt(url.searchParams.get('id') ?? '', 10);
      if (!Number.isFinite(id) || !accountEmail) return response({ error: 'Valid id and accountEmail are required' }, 400);
      const { data, error } = await supabase
        .from('activities')
        .select('*')
        .eq('id', id)
        .eq('account_email', accountEmail)
        .maybeSingle();
      if (error) throw error;
      if (!data) return response({ error: 'Activity not found' }, 404);
      return response({ activity: data });
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
