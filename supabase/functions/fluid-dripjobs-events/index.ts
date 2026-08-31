import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';
import { createAdminClient, jsonResponse as response, safeEqual } from '../_shared/runtime.ts';

const MAX_BODY_BYTES = 128 * 1024;
const encoder = new TextEncoder();

type EventBody = Record<string, unknown>;

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405);

  const webhookSecret = Deno.env.get('FLUID_DRIPJOBS_EVENTS_SECRET')?.trim() ?? '';
  const supplied = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!webhookSecret || !supplied || !safeEqual(webhookSecret, supplied)) {
    return response({ error: 'Unauthorized' }, 401);
  }

  const contentLength = Number(req.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return response({ error: 'Request body is too large' }, 413);
  }

  let rawBody = '';
  let normalized: ReturnType<typeof normalizeStageEvent>;
  try {
    rawBody = await req.text();
    if (encoder.encode(rawBody).length > MAX_BODY_BYTES) {
      return response({ error: 'Request body is too large' }, 413);
    }
    normalized = normalizeStageEvent(JSON.parse(rawBody) as EventBody);
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : 'Invalid request' }, 400);
  }

  let supabase: SupabaseClient;
  try {
    supabase = createAdminClient();
  } catch {
    return response({ error: 'DripJobs ingestion is not configured' }, 500);
  }
  const payloadSha256 = await sha256(rawBody);
  const eventKey = normalized.providerEventId
    ? `zapier:stage:${normalized.providerEventId}`
    : `zapier:stage:${await sha256([
      normalized.dealId,
      normalized.stage,
      normalized.changedAt,
    ].join('\u0000'))}`;

  const { data, error } = await supabase.rpc('record_dripjobs_pipeline_stage_event', {
    p_workspace_key: 'ottawa-painters',
    p_event_key: eventKey,
    p_deal_id: normalized.dealId,
    p_stage: normalized.stage,
    p_changed_at: normalized.changedAt,
    p_observed_at: new Date().toISOString(),
    p_previous_stage: normalized.previousStage,
    p_metadata: {
      provider: 'zapier',
      providerEventId: normalized.providerEventId,
      payloadSha256,
    },
  });
  if (error) {
    console.error('DripJobs stage processing failed', { code: error.code ?? 'unknown' });
    return response({ error: 'DripJobs stage processing failed' }, 500);
  }
  return response(data ?? { status: 'processed' });
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));

export function normalizeStageEvent(body: EventBody) {
  const version = Number(body.version ?? 1);
  if (version !== 1) throw new Error('Unsupported event version');
  if (requiredText(body.event_type, 'event_type', 80) !== 'deal.stage_changed') {
    throw new Error('Unsupported event_type');
  }
  const dealId = requiredText(body.deal_id, 'deal_id', 200);
  if (!/^[0-9a-f]{30,}$/.test(dealId)) {
    throw new Error('deal_id must be the exact DripJobs Sales List deal ID');
  }
  return {
    dealId,
    changedAt: isoTimestamp(body.changed_at ?? body.occurred_at, 'changed_at'),
    providerEventId: optionalText(body.event_id, 200),
    stage: requiredText(body.deal_stage, 'deal_stage', 300),
    previousStage: optionalText(body.previous_stage, 300),
  };
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`Missing ${field}`);
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

function optionalText(value: unknown, maximum: number): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > maximum) throw new Error('A text field is too long');
  return text;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = requiredText(value, field, 100);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${field}`);
  return date.toISOString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
