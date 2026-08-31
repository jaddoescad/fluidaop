import { createAdminClient, jsonResponse as response, validSecret } from '../_shared/runtime.ts';

const AGENT_KEY = 'signal-recommender';

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
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-agent-secret')?.trim() ?? '';
  return validSecret(supplied, [
    Deno.env.get('FLUID_SIGNAL_RECOMMENDER_SECRET'),
  ]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (object(error) && typeof error.message === 'string') return error.message;
  return 'Unexpected function error';
}

async function bodyOf(req: Request): Promise<JsonRecord | null> {
  const length = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > 2 * 1024 * 1024) return null;
  const body: unknown = await req.json().catch(() => null);
  return object(body) ? body : null;
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);
  try {
    const client = createAdminClient();
    const action = new URL(req.url).searchParams.get('action') ?? 'status';
    if (req.method === 'GET' && action === 'status') {
      const statuses = ['pending', 'leased', 'succeeded', 'failed'] as const;
      const [counts, recent, settings] = await Promise.all([
        Promise.all(statuses.map(async (status) => {
          const { count, error } = await client.from('agent_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('agent_key', AGENT_KEY).eq('status', status);
          if (error) throw error;
          return [status, count ?? 0] as const;
        })),
        client.from('agent_runs')
          .select('id,status,model,prompt_version,error,finished_at,activity_id,input_revision')
          .eq('agent_key', AGENT_KEY).order('finished_at', { ascending: false }).limit(10),
        client.from('signal_recommender_settings').select('*')
          .eq('workspace_key', 'ottawa-painters').single(),
      ]);
      if (recent.error) throw recent.error;
      if (settings.error) throw settings.error;
      return response({
        agentKey: AGENT_KEY,
        counts: Object.fromEntries(counts),
        recentRuns: recent.data ?? [],
        settings: settings.data,
        checkedAt: new Date().toISOString(),
      });
    }
    if (req.method !== 'POST') return response({ error: 'Not found' }, 404);
    const body = await bodyOf(req);
    if (!body) return response({ error: 'A valid JSON body under 2 MB is required' }, 400);
    if (action === 'claim') {
      const worker = text(body.worker, 100, true);
      const limit = integer(body.limit ?? 1, 1, 10);
      const leaseSeconds = integer(body.leaseSeconds ?? 900, 60, 3600);
      if (!worker || limit === null || leaseSeconds === null) return response({ error: 'Invalid claim request' }, 400);
      const jobs: unknown[] = [];
      const { data: definitions, error: definitionsError } = await client.from('action_definitions')
        .select('id,key,name,description,handler_key,configuration,version')
        .eq('workspace_key', 'ottawa-painters').eq('enabled', true)
        .eq('handler_key', 'draft-email-reply');
      if (definitionsError) throw definitionsError;
      for (let index = 0; index < limit; index += 1) {
        const { data, error } = await client.rpc('claim_signal_recommender_job', {
          p_worker: worker,
          p_lease_seconds: leaseSeconds,
        });
        if (error) throw error;
        if (!object(data) || data.job === null) break;
        jobs.push({
          ...data,
          actionDefinitions: (definitions ?? []).map((definition) => ({
            id: definition.id, key: definition.key, name: definition.name,
            description: definition.description, handler: definition.handler_key,
            configuration: definition.configuration, version: definition.version,
          })),
          contract: {
            ...(object(data.contract) ? data.contract : {}),
            maximumExecutableRecommendations: 1,
            enabledDefinitionsOnly: true,
          },
        });
      }
      return response({ agentKey: AGENT_KEY, jobs });
    }
    if (action === 'complete') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const promptVersion = text(body.promptVersion, 100, true);
      const model = text(body.model, 200) ?? '';
      const recommendations = Array.isArray(body.recommendations) ? body.recommendations : null;
      if (jobId === null || !uuid(body.leaseToken) || !promptVersion || !recommendations || recommendations.length > 1) {
        return response({ error: 'Invalid completion payload' }, 400);
      }
      const bytes = new TextEncoder().encode(JSON.stringify(recommendations)).length;
      if (bytes > 1024 * 1024 || recommendations.some((item) => !object(item))) {
        return response({ error: 'Invalid recommendations' }, 400);
      }
      const { data, error } = await client.rpc('complete_signal_recommender_job', {
        p_job_id: jobId,
        p_lease_token: body.leaseToken,
        p_model: model,
        p_prompt_version: promptVersion,
        p_recommendations: recommendations,
      });
      if (error) throw error;
      return response({ result: data });
    }
    if (action === 'fail') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const failure = text(body.error, 2000, true);
      const promptVersion = text(body.promptVersion, 100, true);
      if (jobId === null || !uuid(body.leaseToken) || !failure || !promptVersion) {
        return response({ error: 'Invalid failure payload' }, 400);
      }
      const { data, error } = await client.rpc('fail_signal_recommender_job', {
        p_job_id: jobId,
        p_lease_token: body.leaseToken,
        p_error: failure,
        p_model: text(body.model, 200) ?? '',
        p_prompt_version: promptVersion,
      });
      if (error) throw error;
      return response({ result: data });
    }
    if (action === 'reconcile') {
      const limit = integer(body.limit ?? 500, 1, 5000);
      if (limit === null) return response({ error: 'Invalid reconciliation limit' }, 400);
      const { data, error } = await client.rpc('reconcile_signal_recommender', {
        p_workspace_key: 'ottawa-painters',
        p_limit: limit,
      });
      if (error) throw error;
      return response({ result: data });
    }
    return response({ error: 'Not found' }, 404);
  } catch (error) {
    console.error(error);
    return response({ error: errorMessage(error) }, 500);
  }
});
