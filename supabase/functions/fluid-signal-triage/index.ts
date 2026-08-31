import { createAdminClient, jsonResponse as response, validSecret } from '../_shared/runtime.ts';

const AGENT_KEY = 'signal-triage';
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_METADATA_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (object(error) && typeof error.message === 'string') return error.message;
  return 'Unexpected function error';
}

function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-agent-secret')?.trim() ?? '';
  return validSecret(supplied, [
    Deno.env.get('FLUID_SIGNAL_TRIAGE_SECRET'),
  ]);
}

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
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function slug(value: unknown, maximum = 100): string | null {
  const cleaned = text(value, maximum, true);
  return cleaned !== null && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned) ? cleaned : null;
}

function optionalEnum(value: unknown, allowed: Set<string>): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = text(value, 100, true);
  return cleaned !== null && allowed.has(cleaned) ? cleaned : undefined;
}

function cleanAttachment(value: unknown): JsonRecord | null {
  if (!object(value)) return null;
  const attachmentKey = text(value.attachmentKey, 500, true);
  if (attachmentKey === null) return null;
  const filename = text(value.filename, 500);
  const mimeType = text(value.mimeType, 200);
  const extractionMethod = text(value.extractionMethod, 100);
  const extracted = typeof value.extractedText === 'string' ? value.extractedText.slice(0, 100_000) : '';
  const allowedStatuses = new Set(['metadata', 'extracted', 'no_text', 'unsupported', 'failed']);
  const requestedStatus = text(value.status, 40);
  const status = requestedStatus && allowedStatuses.has(requestedStatus)
    ? requestedStatus
    : extracted.length > 0 ? 'extracted' : 'metadata';
  const sizeBytes = value.sizeBytes === null || value.sizeBytes === undefined
    ? null
    : integer(value.sizeBytes, 0, Number.MAX_SAFE_INTEGER);
  const metadata = object(value.metadata) && jsonSize(value.metadata) <= MAX_ATTACHMENT_METADATA_BYTES
    ? value.metadata
    : {};
  return {
    attachmentKey,
    filename: filename || null,
    mimeType: mimeType || null,
    sizeBytes,
    status,
    extractionMethod: extractionMethod || null,
    extractedText: extracted || null,
    metadata,
  };
}

async function bodyOf(req: Request): Promise<JsonRecord | null> {
  const length = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > 3 * 1024 * 1024) return null;
  const body: unknown = await req.json().catch(() => null);
  return object(body) ? body : null;
}

Deno.serve(async (req: Request) => {
  if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);

  try {
    const supabase = createAdminClient();
    const action = new URL(req.url).searchParams.get('action') ?? 'status';

    if (req.method === 'GET' && action === 'status') {
      const statuses = ['pending', 'leased', 'succeeded', 'failed'] as const;
      const [counts, recentResult, settingsResult] = await Promise.all([
        Promise.all(statuses.map(async (status) => {
          const { count, error } = await supabase
            .from('agent_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('agent_key', AGENT_KEY)
            .eq('status', status);
          if (error) throw error;
          return [status, count ?? 0] as const;
        })),
        supabase
          .from('agent_runs')
          .select('id,status,model,prompt_version,error,started_at,finished_at,activity_id,input_revision')
          .eq('agent_key', AGENT_KEY)
          .order('finished_at', { ascending: false })
          .limit(10),
        supabase
          .from('signal_triage_settings')
          .select('workspace_key,auto_create_enabled,auto_create_threshold,suggestion_threshold,shadow_decision_limit,decisions_seen')
          .eq('workspace_key', 'ottawa-painters')
          .maybeSingle(),
      ]);
      if (recentResult.error) throw recentResult.error;
      if (settingsResult.error) throw settingsResult.error;
      return response({
        agentKey: AGENT_KEY,
        counts: Object.fromEntries(counts),
        recentRuns: recentResult.data ?? [],
        settings: settingsResult.data,
        checkedAt: new Date().toISOString(),
      });
    }

    if (req.method !== 'POST') return response({ error: 'Not found' }, 404);
    const body = await bodyOf(req);
    if (body === null) return response({ error: 'A valid JSON body under 3 MB is required' }, 400);

    if (action === 'claim') {
      const worker = text(body.worker, 100, true);
      const limit = integer(body.limit ?? 1, 1, 10);
      const leaseSeconds = integer(body.leaseSeconds ?? 900, 60, 3600);
      if (worker === null || limit === null || leaseSeconds === null) {
        return response({ error: 'Valid worker, limit, and leaseSeconds are required' }, 400);
      }
      const claimed: unknown[] = [];
      for (let index = 0; index < limit; index += 1) {
        const { data, error } = await supabase.rpc('claim_signal_triage_job', {
          p_worker: worker,
          p_lease_seconds: leaseSeconds,
        });
        if (error) throw error;
        if (!object(data) || data.job === null) break;
        claimed.push(data);
      }
      return response({ agentKey: AGENT_KEY, jobs: claimed });
    }

    if (action === 'complete') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const topicLabelKey = slug(body.topicLabelKey);
      const urgencyLabelKey = slug(body.urgencyLabelKey);
      const contactDisposition = optionalEnum(
        body.contactDisposition,
        new Set(['existing', 'create', 'suggest', 'ignore', 'conflict']),
      );
      const entityType = optionalEnum(body.entityType, new Set(['person', 'business']));
      const roleKey = body.roleKey === null || body.roleKey === undefined || body.roleKey === ''
        ? null
        : slug(body.roleKey);
      const displayName = text(body.displayName, 300) ?? '';
      const confidence = typeof body.confidence === 'number' ? body.confidence : Number.NaN;
      const reason = text(body.reason, 2000, true);
      const model = text(body.model, 200) ?? '';
      const promptVersion = text(body.promptVersion, 100, true);
      const evidence = object(body.evidence) ? body.evidence : null;
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
      const attachments = rawAttachments.map(cleanAttachment).filter((item): item is JsonRecord => item !== null);
      if (
        jobId === null || !validUuid(body.leaseToken) || topicLabelKey === null ||
        urgencyLabelKey === null || contactDisposition === undefined || contactDisposition === null ||
        entityType === undefined || (body.roleKey !== null && body.roleKey !== undefined && body.roleKey !== '' && roleKey === null) ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
        reason === null || promptVersion === null || evidence === null ||
        jsonSize(evidence) > MAX_EVIDENCE_BYTES || rawAttachments.length > 20 ||
        attachments.length !== rawAttachments.length
      ) {
        return response({ error: 'Invalid completion payload' }, 400);
      }
      const { data, error } = await supabase.rpc('complete_signal_triage_job', {
        p_job_id: jobId,
        p_lease_token: body.leaseToken,
        p_topic_label_key: topicLabelKey,
        p_urgency_label_key: urgencyLabelKey,
        p_contact_disposition: contactDisposition,
        p_entity_type: entityType,
        p_role_key: roleKey,
        p_display_name: displayName,
        p_confidence: confidence,
        p_reason: reason,
        p_model: model,
        p_prompt_version: promptVersion,
        p_evidence: evidence,
        p_attachments: attachments,
      });
      if (error) throw error;
      return response({ result: data });
    }

    if (action === 'fail') {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const errorText = text(body.error, 2000, true);
      const model = text(body.model, 200) ?? '';
      const promptVersion = text(body.promptVersion, 100, true);
      if (jobId === null || !validUuid(body.leaseToken) || errorText === null || promptVersion === null) {
        return response({ error: 'Invalid failure payload' }, 400);
      }
      const { data, error } = await supabase.rpc('fail_signal_triage_job', {
        p_job_id: jobId,
        p_lease_token: body.leaseToken,
        p_error: errorText,
        p_model: model,
        p_prompt_version: promptVersion,
      });
      if (error) throw error;
      return response({ result: data });
    }

    if (action === 'reconcile') {
      const limit = integer(body.limit ?? 500, 1, 5000);
      if (limit === null) return response({ error: 'Invalid reconciliation limit' }, 400);
      const { data, error } = await supabase.rpc('reconcile_signal_triage', {
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
