import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';
import { createAdminClient, jsonResponse as response, safeEqual } from '../_shared/runtime.ts';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

function db(): SupabaseClient {
  return createAdminClient();
}

function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-agent-secret')?.trim() ?? '';
  const expected = [
    Deno.env.get('FLUID_DRIPJOBS_PIPELINE_SECRET'),
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return supplied.length > 0 && expected.some((value) => safeEqual(value, supplied));
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
