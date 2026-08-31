import { createAdminClient, jsonResponse as response, validSecret } from '../_shared/runtime.ts';

type JsonRecord = Record<string, unknown>;

function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-gmail-label-sync-secret')?.trim() ?? '';
  return validSecret(supplied, [Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET')]);
}

function object(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function text(value: unknown, maximum: number, required = false): string | null {
  if (typeof value !== 'string') return required ? null : '';
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > maximum) return null;
  return cleaned;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validEmail(value: string): boolean {
  return value === value.toLowerCase() && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function bodyOf(req: Request): Promise<JsonRecord | null> {
  const length = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > 16 * 1024) return null;
  const body: unknown = await req.json().catch(() => null);
  return object(body) ? body : null;
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);

  try {
    const supabase = createAdminClient();
    const url = new URL(req.url);
    const action = url.searchParams.get('action') ?? 'status';

    if (req.method === 'GET' && action === 'status') {
      const accountEmail = (url.searchParams.get('accountEmail') ?? '').trim().toLowerCase();
      if (!validEmail(accountEmail)) return response({ error: 'Valid accountEmail is required' }, 400);
      const { data, error } = await supabase.rpc('gmail_label_sync_status', {
        p_account_email: accountEmail,
      });
      if (error) throw error;
      return response({ status: data });
    }

    if (req.method !== 'POST') return response({ error: 'Not found' }, 404);
    const body = await bodyOf(req);
    if (!body) return response({ error: 'A valid JSON body is required' }, 400);

    if (action === 'claim') {
      const worker = text(body.worker, 100, true);
      const accountEmail = text(body.accountEmail, 320, true)?.toLowerCase() ?? '';
      const leaseSeconds = integer(body.leaseSeconds ?? 300, 60, 1800);
      if (worker === null || !validEmail(accountEmail) || leaseSeconds === null) {
        return response({ error: 'Valid worker, accountEmail, and leaseSeconds are required' }, 400);
      }
      const { data, error } = await supabase.rpc('claim_gmail_label_sync_job', {
        p_worker: worker,
        p_account_email: accountEmail,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return response(data);
    }

    if (action === 'complete') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const generation = integer(body.generation, 1, Number.MAX_SAFE_INTEGER);
      const allowedOutcomes = new Set(['applied', 'already-applied', 'message-missing']);
      const outcome = text(body.outcome, 40, true);
      const gmailLabelId = body.gmailLabelId === null ? null : text(body.gmailLabelId, 500, true);
      const gmailLabelName = body.gmailLabelName === null ? null : text(body.gmailLabelName, 225, true);
      if (jobId === null || generation === null || !validUuid(body.leaseToken) ||
        outcome === null || !allowedOutcomes.has(outcome) ||
        (outcome !== 'message-missing' && (gmailLabelId === null || gmailLabelName === null))) {
        return response({ error: 'Invalid completion payload' }, 400);
      }
      const { data, error } = await supabase.rpc('complete_gmail_label_sync_job', {
        p_job_id: jobId,
        p_lease_token: body.leaseToken,
        p_generation: generation,
        p_outcome: outcome,
        p_gmail_label_id: gmailLabelId,
        p_gmail_label_name: gmailLabelName,
      });
      if (error) throw error;
      return response({ result: data });
    }

    if (action === 'fail') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const generation = integer(body.generation, 1, Number.MAX_SAFE_INTEGER);
      const errorText = text(body.error, 1000, true);
      const retryAfterSeconds = body.retryAfterSeconds === null || body.retryAfterSeconds === undefined
        ? null
        : integer(body.retryAfterSeconds, 1, 86400);
      if (jobId === null || generation === null || !validUuid(body.leaseToken) ||
        errorText === null || typeof body.retryable !== 'boolean' ||
        (body.retryAfterSeconds !== null && body.retryAfterSeconds !== undefined && retryAfterSeconds === null)) {
        return response({ error: 'Invalid failure payload' }, 400);
      }
      const { data, error } = await supabase.rpc('fail_gmail_label_sync_job', {
        p_job_id: jobId,
        p_lease_token: body.leaseToken,
        p_generation: generation,
        p_error: errorText,
        p_retryable: body.retryable,
        p_retry_after_seconds: retryAfterSeconds,
      });
      if (error) throw error;
      return response({ result: data });
    }

    return response({ error: 'Not found' }, 404);
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : 'Unexpected function error' }, 500);
  }
});
