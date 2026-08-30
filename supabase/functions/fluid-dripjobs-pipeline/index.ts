import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();
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

function db(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('SUPABASE_URL is unavailable');
  return createClient(url, databaseSecret(), { auth: { persistSession: false } });
}

function safeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let different = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return different === 0;
}

function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-agent-secret')?.trim() ?? '';
  const expected = [
    Deno.env.get('FLUID_DRIPJOBS_PIPELINE_SECRET'),
    Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET'),
    Deno.env.get('FLUID_EMAIL_CATEGORIZER_SECRET'),
  ].filter((value): value is string => Boolean(value));
  return supplied.length > 0 && expected.some((secret) => safeEqual(secret, supplied));
}

export async function handleRequest(req: Request): Promise<Response> {
  if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);
  const action = new URL(req.url).searchParams.get('action') ?? 'status';

  try {
    if (req.method === 'GET' && action === 'status') return await status(db());
    if (req.method === 'POST' && action === 'reconcile') return await reconcile(req);
    return response({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('DripJobs pipeline endpoint failed', {
      action,
      message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
    });
    return response({ error: 'DripJobs pipeline service failed' }, 500);
  }
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));

async function status(client: SupabaseClient): Promise<Response> {
  const { data, error } = await client
    .from('dripjobs_pipeline_sync_runs')
    .select('id,run_key,captured_at,status,active_rows,archived_rows,inserted_deals,changed_stages,archived_deals,reactivated_deals,last_error,started_at,finished_at')
    .eq('workspace_key', 'ottawa-painters')
    .order('captured_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const latest = data?.[0] ?? null;
  const latestSuccess = data?.find((run) => run.status === 'succeeded') ?? null;
  const lastSucceededAt = latestSuccess?.finished_at ? Date.parse(latestSuccess.finished_at) : Number.NaN;
  const ageMs = Number.isFinite(lastSucceededAt) ? Date.now() - lastSucceededAt : Number.POSITIVE_INFINITY;
  return response({
    cadence: 'daily',
    schedule: '10:05 America/Toronto',
    needsSync: ageMs > 36 * 60 * 60 * 1000,
    unhealthy: ageMs > 72 * 60 * 60 * 1000,
    latest,
    latestSuccess,
    runs: data ?? [],
  });
}

async function reconcile(req: Request): Promise<Response> {
  const contentLength = Number(req.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return response({ error: 'Request body is too large' }, 413);
  }
  const raw = await req.text();
  if (encoder.encode(raw).length > MAX_BODY_BYTES) {
    return response({ error: 'Request body is too large' }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return response({ error: 'Request body must be valid JSON' }, 400);
  }
  if (!Array.isArray(body.activeRows) || !Array.isArray(body.archivedRows)) {
    return response({ error: 'activeRows and archivedRows must be arrays' }, 400);
  }
  if (body.activeRows.length === 0 || body.activeRows.length > 10000 || body.archivedRows.length > 10000) {
    return response({ error: 'Snapshot row count is invalid' }, 400);
  }
  const capturedAt = new Date(String(body.capturedAt ?? ''));
  if (!Number.isFinite(capturedAt.getTime())) return response({ error: 'capturedAt is invalid' }, 400);
  const runKey = String(body.runKey ?? '').trim();
  if (!runKey || runKey.length > 200) return response({ error: 'runKey is invalid' }, 400);

  const client = db();
  const { data, error } = await client.rpc('reconcile_dripjobs_pipeline', {
    p_active_rows: body.activeRows,
    p_archived_rows: body.archivedRows,
    p_captured_at: capturedAt.toISOString(),
    p_run_key: runKey,
    p_workspace_key: 'ottawa-painters',
  });
  if (error) throw error;
  const failed = data?.status === 'failed';
  return response(data, failed ? 500 : 200);
}
