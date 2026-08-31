import { createAdminClient, jsonResponse as response, validSecret } from '../_shared/runtime.ts';

const AGENT_KEY = 'action-runner';
const encoder = new TextEncoder();
type JsonRecord = Record<string, unknown>;

function object(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum: number, required = false): string | null {
  if (typeof value !== 'string') return required ? null : '';
  const cleaned = value.trim();
  if ((required && cleaned.length === 0) || cleaned.length > maximum) return null;
  return cleaned;
}
function integer(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-agent-secret')?.trim() ?? '';
  return validSecret(supplied, [
    Deno.env.get('FLUID_ACTION_RUNNER_SECRET'),
  ]);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : object(error) && typeof error.message === 'string' ? error.message : 'Unexpected function error';
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);
  try {
    const client = createAdminClient();
    const action = new URL(req.url).searchParams.get('action') ?? 'status';
    if (req.method === 'GET' && action === 'status') {
      const statuses = ['pending', 'leased', 'succeeded', 'failed'] as const;
      const counts = await Promise.all(statuses.map(async (status) => {
        const { count, error } = await client.from('action_execution_jobs').select('id', { count: 'exact', head: true }).eq('status', status);
        if (error) throw error;
        return [status, count ?? 0] as const;
      }));
      return response({ agentKey: AGENT_KEY, counts: Object.fromEntries(counts), checkedAt: new Date().toISOString() });
    }
    if (req.method !== 'POST') return response({ error: 'Not found' }, 404);
    const body = await req.json().catch(() => null) as unknown;
    if (!object(body) || encoder.encode(JSON.stringify(body)).length > 2 * 1024 * 1024) return response({ error: 'Valid bounded JSON is required' }, 400);
    if (action === 'claim') {
      const worker = text(body.worker, 100, true);
      const limit = integer(body.limit ?? 1, 1, 10);
      const leaseSeconds = integer(body.leaseSeconds ?? 900, 60, 3600);
      if (!worker || limit === null || leaseSeconds === null) return response({ error: 'Invalid claim request' }, 400);
      const jobs: unknown[] = [];
      for (let index = 0; index < limit; index += 1) {
        const { data, error } = await client.rpc('claim_action_execution_job', { p_worker: worker, p_lease_seconds: leaseSeconds });
        if (error) throw error;
        if (!object(data) || data.job === null) break;
        jobs.push(data);
      }
      return response({ agentKey: AGENT_KEY, jobs });
    }
    if (action === 'complete') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const draftBody = text(body.draftBody, 50_000, true);
      const promptVersion = text(body.promptVersion, 100, true);
      if (jobId === null || !uuid(body.leaseToken) || !draftBody || !promptVersion) return response({ error: 'Invalid completion' }, 400);
      const { data, error } = await client.rpc('complete_action_execution_job', {
        p_job_id: jobId, p_lease_token: body.leaseToken, p_draft_body: draftBody,
        p_model: text(body.model, 200) ?? '', p_prompt_version: promptVersion,
      });
      if (error) throw error;
      return response({ result: data });
    }
    if (action === 'fail') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const failure = text(body.error, 2000, true);
      if (jobId === null || !uuid(body.leaseToken) || !failure) return response({ error: 'Invalid failure' }, 400);
      const { data, error } = await client.rpc('fail_action_execution_job', {
        p_job_id: jobId, p_lease_token: body.leaseToken, p_error: failure,
      });
      if (error) throw error;
      return response({ result: data });
    }
    return response({ error: 'Unknown action' }, 404);
  } catch (error) {
    console.error('fluid-action-runner', error);
    return response({ error: errorMessage(error) }, 500);
  }
});
