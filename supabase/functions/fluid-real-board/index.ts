import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';
import { createAdminClient, jsonResponse as response, validSecret } from '../_shared/runtime.ts';

const WORKSPACE_KEY = 'ottawa-painters';

function db(): SupabaseClient {
  return createAdminClient();
}

function authorized(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-activity-secret')?.trim() ?? '';
  return validSecret(supplied, [
    Deno.env.get('FLUID_REAL_BOARD_SECRET'),
    Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET'),
  ]);
}

function positiveInt(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function integerId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function dripJobsDealId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{30,}$/.test(value);
}

function boundedText(value: unknown, maximum: number, required = false): string | null {
  if (typeof value !== 'string') return required ? null : '';
  const cleaned = value.trim();
  if ((required && cleaned.length === 0) || cleaned.length > maximum) return null;
  return cleaned;
}

export function safeDiagnostic(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/https?:\/\/\S+/gi, '[url redacted]')
    .replace(/\b(secret|token|password|api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ').slice(0, 1000);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

function actionDefinitionPayload(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    key: item.key,
    name: item.name,
    description: item.description,
    handler: item.handler_key,
    enabled: item.enabled,
    executionMode: item.execution_mode,
    requiresConfirmation: item.requires_confirmation,
    configuration: item.configuration,
    version: item.version,
    builtIn: item.built_in,
    executable: item.handler_key === 'draft-email-reply',
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

type Cursor = { at: string; id: string | number; attention?: boolean; actionOpen?: boolean };

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    if (typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at))) return null;
    if (typeof decoded.id !== 'string' && typeof decoded.id !== 'number') return null;
    if (decoded.attention !== undefined && typeof decoded.attention !== 'boolean') return null;
    if (decoded.actionOpen !== undefined && typeof decoded.actionOpen !== 'boolean') return null;
    return decoded as Cursor;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: unknown): string | null {
  if (!cursor || typeof cursor !== 'object') return null;
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

function automatedSource(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const value = String((metadata as Record<string, unknown>).automated ?? '').toLowerCase();
  return ['true', '1', 'yes'].includes(value);
}

async function addAutomatedFlags(
  client: SupabaseClient,
  items: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = items.map((item) => item.id).filter((id): id is string | number => (
    typeof id === 'string' || typeof id === 'number'
  ));
  if (ids.length === 0) return items;
  const { data, error } = await client.from('activities')
    .select('id,source_metadata')
    .eq('workspace_key', WORKSPACE_KEY)
    .in('id', ids);
  if (error) throw error;
  const flags = new Map((data ?? []).map((item) => [String(item.id), automatedSource(item.source_metadata)]));
  return items.map((item) => ({ ...item, isAutomated: flags.get(String(item.id)) ?? false }));
}

/** When a person opened each Signal. Absence is unread — see signal_reads. */
async function addReadFlags(
  client: SupabaseClient,
  items: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = items.map((item) => item.id).filter((id): id is string | number => (
    typeof id === 'string' || typeof id === 'number'
  ));
  if (ids.length === 0) return items;
  const { data, error } = await client.from('signal_reads')
    .select('activity_id,read_at')
    .eq('workspace_key', WORKSPACE_KEY)
    .in('activity_id', ids);
  if (error) throw error;
  const readAt = new Map((data ?? []).map((row) => [String(row.activity_id), row.read_at as string]));
  return items.map((item) => ({ ...item, readAt: readAt.get(String(item.id)) ?? null }));
}

async function unreadSignalCount(client: SupabaseClient): Promise<number> {
  const count = Number(await rpc(client, 'count_unread_real_board_signals', { p_workspace_key: WORKSPACE_KEY }));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

async function addIdentityResolutions(
  client: SupabaseClient,
  items: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  // Current read models emit an authoritative resolution directly. Keep the
  // suggestion lookup only as a compatibility fallback during rolling deploys.
  const unresolvedItems = items.filter((item) => !item.contact && !item.identityResolution);
  const activityIds = unresolvedItems
    .map((item) => Number(item.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (activityIds.length === 0) return items;

  const { data: activityIdentities, error: identityError } = await client
    .from('activity_identities')
    .select('activity_id,identity_id')
    .in('activity_id', activityIds);
  if (identityError) throw identityError;

  const identityIds = [...new Set((activityIdentities ?? []).map((item) => item.identity_id))];
  if (identityIds.length === 0) return items;

  const { data: suggestions, error: suggestionError } = await client
    .from('contact_suggestions')
    .select('identity_id,suggestion_type,proposed_display_name,reason,identity:identities!contact_suggestions_identity_id_fkey(display_name,display_value)')
    .eq('workspace_key', WORKSPACE_KEY)
    .eq('status', 'pending')
    .in('identity_id', identityIds);
  if (suggestionError) throw suggestionError;

  const suggestionByIdentity = new Map<string, Record<string, unknown>>();
  for (const suggestion of suggestions ?? []) {
    const identity = Array.isArray(suggestion.identity) ? suggestion.identity[0] : suggestion.identity;
    suggestionByIdentity.set(String(suggestion.identity_id), {
      status: suggestion.suggestion_type === 'conflict' ? 'conflict' : 'unresolved',
      displayName: suggestion.proposed_display_name ?? identity?.display_name ?? null,
      displayValue: identity?.display_value ?? null,
      reason: suggestion.reason,
    });
  }

  const resolutionByActivity = new Map<number, Record<string, unknown>>();
  for (const link of activityIdentities ?? []) {
    const suggestion = suggestionByIdentity.get(String(link.identity_id));
    if (!suggestion) continue;
    const current = resolutionByActivity.get(Number(link.activity_id));
    if (!current || (current.status !== 'conflict' && suggestion.status === 'conflict')) {
      resolutionByActivity.set(Number(link.activity_id), suggestion);
    }
  }

  return items.map((item) => ({
    ...item,
    identityResolution: item.identityResolution ?? resolutionByActivity.get(Number(item.id)) ?? null,
  }));
}

async function summary(client: SupabaseClient): Promise<Response> {
  return response(await rpc(client, 'get_real_board_summary', { p_workspace_key: WORKSPACE_KEY }));
}

async function people(client: SupabaseClient, url: URL): Promise<Response> {
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && (!cursor || typeof cursor.attention !== 'boolean' || !uuid(cursor.id))) {
    return response({ error: 'Invalid People cursor' }, 400);
  }
  const result = await rpc(client, 'list_real_board_people', {
    p_workspace_key: WORKSPACE_KEY,
    p_limit: positiveInt(url.searchParams.get('limit'), 30, 100),
    p_cursor_attention: cursor?.attention ?? null,
    p_cursor_at: cursor?.at ?? null,
    p_cursor_id: cursor?.id ?? null,
  }) as { count?: unknown; items?: unknown[]; nextCursor?: unknown };
  return response({
    count: Number.isSafeInteger(Number(result?.count)) ? Number(result?.count) : 0,
    items: result?.items ?? [],
    nextCursor: encodeCursor(result?.nextCursor),
  });
}

async function pipeline(client: SupabaseClient, url: URL): Promise<Response> {
  if (url.searchParams.get('archived') === 'true') {
    const receivedMonth = url.searchParams.get('receivedMonth');
    if (receivedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(receivedMonth)) {
      return response({ error: 'Invalid received month' }, 400);
    }
    const rawCursor = url.searchParams.get('cursor');
    const cursor = decodeCursor(rawCursor);
    if (rawCursor && (!cursor || typeof cursor.at !== 'string' || typeof cursor.id !== 'string')) {
      return response({ error: 'Invalid archived pipeline cursor' }, 400);
    }
    const result = await rpc(client, 'list_archived_dripjobs_pipeline', {
      p_workspace_key: WORKSPACE_KEY,
      p_limit: positiveInt(url.searchParams.get('limit'), 60, 100),
      p_cursor_archived_at: cursor?.at ?? null,
      p_cursor_deal_id: cursor?.id ?? null,
      p_received_month: receivedMonth ? `${receivedMonth}-01` : null,
    }) as { count?: unknown; bucketCounts?: unknown; monthCounts?: unknown; items?: unknown[]; nextCursor?: unknown };
    return response({
      count: Number.isSafeInteger(Number(result?.count)) ? Number(result?.count) : 0,
      bucketCounts: result?.bucketCounts ?? {},
      monthCounts: result?.monthCounts ?? {},
      items: result?.items ?? [],
      nextCursor: encodeCursor(result?.nextCursor),
    });
  }
  return response(await rpc(client, 'list_current_dripjobs_pipeline', {
    p_workspace_key: WORKSPACE_KEY,
  }));
}

async function pipelineHistory(client: SupabaseClient, url: URL): Promise<Response> {
  const dealId = url.searchParams.get('dealId');
  if (!dripJobsDealId(dealId)) return response({ error: 'Invalid DripJobs deal id' }, 400);
  return response(await rpc(client, 'list_dripjobs_deal_journey', {
    p_workspace_key: WORKSPACE_KEY,
    p_deal_id: dealId,
    p_limit: positiveInt(url.searchParams.get('limit'), 100, 500),
  }));
}

async function signals(client: SupabaseClient, url: URL): Promise<Response> {
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && (
    !cursor ||
    !integerId(String(cursor.id)) ||
    typeof cursor.actionOpen !== 'boolean'
  )) return response({ error: 'Invalid Signals cursor' }, 400);
  const contactId = url.searchParams.get('contactId');
  if (contactId && !uuid(contactId)) return response({ error: 'Invalid Contact id' }, 400);
  const view = url.searchParams.get('view') ?? 'all';
  if (!['all', 'needs_you'].includes(view)) return response({ error: 'Invalid Signals view' }, 400);
  const result = await rpc(client, 'list_real_board_signals', {
    p_workspace_key: WORKSPACE_KEY,
    p_contact_id: contactId || null,
    p_view: view,
    p_limit: positiveInt(url.searchParams.get('limit'), 30, 100),
    p_cursor_at: cursor?.at ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_cursor_action_open: cursor?.actionOpen ?? null,
  }) as { items?: unknown[]; nextCursor?: unknown };
  const items = (result?.items ?? []).filter((item): item is Record<string, unknown> => (
    Boolean(item) && typeof item === 'object'
  ));
  const flagged = await addAutomatedFlags(client, items);
  // The unread total is for the whole column, not the page or the Contact
  // filter, so the badge means the same thing however the list is scoped.
  const [decorated, unreadCount] = await Promise.all([
    addReadFlags(client, flagged).then((read) => addIdentityResolutions(client, read)),
    unreadSignalCount(client),
  ]);
  return response({
    items: decorated,
    unreadCount,
    nextCursor: encodeCursor(result?.nextCursor),
  });
}

async function potentialLeads(client: SupabaseClient, url: URL): Promise<Response> {
  const result = await rpc(client, 'list_lead_candidates', {
    p_workspace_key: WORKSPACE_KEY,
    p_limit: positiveInt(url.searchParams.get('limit'), 100, 500),
  }) as { undecidedCount?: unknown; items?: unknown } | null;
  const undecidedCount = Number(result?.undecidedCount);
  return response({
    undecidedCount: Number.isSafeInteger(undecidedCount) && undecidedCount >= 0 ? undecidedCount : 0,
    items: Array.isArray(result?.items) ? result.items : [],
  });
}

/** Which agents interacted with a Signal: real runs from agent_runs, plus
 *  queue-only outcomes (skips, retirements, waiting work) from agent_jobs. */
function signalAgentActivity(
  runs: Array<Record<string, unknown>>,
  jobs: Array<Record<string, unknown>>,
  decisions: Array<Record<string, unknown>>,
  lifecycle: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  const asNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string' && value !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  const asText = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null;
  const decisionByRun = new Map(decisions.map((item) => [String(item.agent_run_id), item]));
  const runById = new Map(runs.map((item) => [String(item.id), item]));
  const jobById = new Map(jobs.map((item) => [String(item.id), item]));
  if (lifecycle.length > 0) {
    return lifecycle.map((event) => {
      const run = event.agent_run_id ? runById.get(String(event.agent_run_id)) : undefined;
      const job = jobById.get(String(event.job_id));
      const evidence = run?.evidence && typeof run.evidence === 'object' && !Array.isArray(run.evidence)
        ? run.evidence as Record<string, unknown>
        : {};
      return {
        id: `event:${event.id}`,
        runId: run ? String(run.id) : null,
        jobId: String(event.job_id),
        agentKey: event.agent_key,
        status: event.event_kind,
        at: event.occurred_at,
        finishedAt: ['completed', 'failed', 'skipped', 'superseded', 'retired'].includes(String(event.event_kind))
          ? event.occurred_at
          : null,
        model: asText(run?.model),
        error: event.event_kind === 'failed'
          ? safeDiagnostic(event.detail) ?? safeDiagnostic(run?.error)
          : null,
        skipReason: ['skipped', 'superseded', 'retired'].includes(String(event.event_kind))
          ? asText(event.detail) ?? String(event.event_kind)
          : null,
        verdict: asText(evidence.verdict),
        confidence: asNumber(evidence.confidence),
        summary: asText(evidence.summary),
        recommendationCount: asNumber(evidence.recommendationCount),
        runtime: run?.runtime_execution_id ? {
          provider: run.runtime_provider,
          profile: run.runtime_profile,
          jobId: run.runtime_job_id,
          executionId: run.runtime_execution_id,
          sessionId: run.runtime_session_id,
        } : null,
        result: run?.result_schema_version ? {
          schemaVersion: run.result_schema_version,
          kind: run.result_kind,
          title: run.result_title,
          summary: run.result_summary,
          payload: run.result_payload,
        } : null,
        queue: {
          status: job?.status ?? null,
          attempt: asNumber(event.attempt) ?? 0,
          availableAt: job?.available_at ?? null,
          claimedAt: job?.claimed_at ?? null,
          finishedAt: job?.finished_at ?? null,
        },
        legacy: Boolean(run && !run.runtime_execution_id),
        triage: null,
      };
    }).sort((left, right) => String(left.at).localeCompare(String(right.at)));
  }
  const jobIdsWithRuns = new Set(runs.map((run) => String(run.job_id)));
  const events: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    const evidence = run.evidence && typeof run.evidence === 'object' && !Array.isArray(run.evidence)
      ? run.evidence as Record<string, unknown>
      : {};
    const decision = decisionByRun.get(String(run.id));
    events.push({
      id: String(run.id),
      agentKey: run.agent_key,
      status: run.status === 'completed' ? 'completed' : 'failed',
      at: run.started_at ?? run.created_at,
      finishedAt: run.finished_at ?? null,
      model: asText(run.model),
      error: safeDiagnostic(run.error),
      skipReason: null,
      verdict: asText(evidence.verdict),
      confidence: asNumber(evidence.confidence),
      summary: asText(evidence.summary),
      recommendationCount: asNumber(evidence.recommendationCount),
      triage: decision ? {
        outcome: asText(decision.outcome),
        proposedDisplayName: asText(decision.proposed_display_name),
        confidence: asNumber(decision.confidence),
        reason: asText(decision.reason),
      } : null,
    });
  }
  for (const job of jobs) {
    if (jobIdsWithRuns.has(String(job.id))) continue;
    const lastError = typeof job.last_error === 'string' ? job.last_error : '';
    let status: string;
    let skipReason: string | null = null;
    let error: string | null = null;
    if (job.status === 'pending') {
      status = 'queued';
    } else if (job.status === 'leased') {
      status = 'claimed';
    } else if (job.status === 'retired') {
      status = 'retired';
    } else if (job.status === 'failed') {
      status = 'failed';
      error = lastError || null;
    } else if (job.status === 'succeeded') {
      // A job closed without a run was refused by the eligibility gate (or
      // settled as moot); the reason only survives inside last_error.
      status = 'skipped';
      skipReason = lastError.startsWith('Skipped: ')
        ? lastError.slice('Skipped: '.length)
        : lastError.startsWith('Superseded')
          ? 'superseded'
          : 'closed without a model run';
    } else {
      continue;
    }
    events.push({
      id: `job:${job.id}`,
      agentKey: job.agent_key,
      status,
      at: job.created_at,
      finishedAt: job.finished_at ?? null,
      model: null,
      error,
      skipReason,
      verdict: null,
      confidence: null,
      summary: null,
      recommendationCount: null,
      triage: null,
    });
  }
  // Same PostgREST timestamp format throughout, so string order is time order.
  return events.sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

async function signal(client: SupabaseClient, url: URL): Promise<Response> {
  const activityId = url.searchParams.get('activityId');
  if (!integerId(activityId)) return response({ error: 'Invalid Signal id' }, 400);
  const rawCursor = url.searchParams.get('historyCursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && (!cursor || !integerId(String(cursor.id)))) return response({ error: 'Invalid history cursor' }, 400);
  const result = await rpc(client, 'get_real_board_signal', {
    p_workspace_key: WORKSPACE_KEY,
    p_activity_id: activityId,
    p_history_limit: positiveInt(url.searchParams.get('historyLimit'), 30, 100),
    p_history_cursor_at: cursor?.at ?? null,
    p_history_cursor_id: cursor?.id ?? null,
  }) as Record<string, unknown> | null;
  if (!result) return response({ error: 'Signal not found' }, 404);
  const selectedWithFlags = result.signal && typeof result.signal === 'object'
    ? await addReadFlags(client, await addAutomatedFlags(client, [result.signal as Record<string, unknown>]))
    : [];
  const selected = await addIdentityResolutions(client, selectedWithFlags);
  const [contentResult, recordingResult, summaryResult, agentRunsResult, agentJobsResult, agentEventsResult, triageDecisionsResult] = await Promise.all([
    client.from('activities')
      .select('source,account_key,external_thread_id,raw_body_text,quoted_text,signature_text,has_quoted_content,content_parser_version,content_parse_method,content_parse_confidence,content_parsed_at')
      .eq('workspace_key', WORKSPACE_KEY).eq('id', activityId).maybeSingle(),
    client.from('activity_call_recordings')
      .select('status,recordings,unavailable_reason,updated_at')
      .eq('workspace_key', WORKSPACE_KEY).eq('activity_id', activityId).maybeSingle(),
    client.from('activity_call_summaries')
      .select('status,summary,next_steps,jobs,unavailable_reason,updated_at')
      .eq('workspace_key', WORKSPACE_KEY).eq('activity_id', activityId).maybeSingle(),
    client.from('agent_runs')
      .select('id,agent_key,job_id,status,model,error,evidence,started_at,finished_at,created_at,runtime_provider,runtime_profile,runtime_job_id,runtime_execution_id,runtime_session_id,result_schema_version,result_kind,result_title,result_summary,result_payload')
      .eq('activity_id', activityId)
      .order('started_at', { ascending: true })
      .limit(50),
    client.from('agent_jobs')
      .select('id,agent_key,status,attempts,available_at,claimed_at,leased_until,last_error,created_at,finished_at')
      .eq('workspace_key', WORKSPACE_KEY).eq('activity_id', activityId)
      .order('created_at', { ascending: true })
      .limit(50),
    client.from('agent_job_events')
      .select('id,agent_key,job_id,agent_run_id,event_kind,attempt,detail,occurred_at')
      .eq('workspace_key', WORKSPACE_KEY).eq('activity_id', activityId)
      .order('occurred_at', { ascending: true })
      .limit(200),
    client.from('signal_triage_decisions')
      .select('agent_run_id,proposed_display_name,confidence,reason,outcome')
      .eq('workspace_key', WORKSPACE_KEY).eq('activity_id', activityId)
      .limit(20),
  ]);
  if (contentResult.error) throw contentResult.error;
  if (recordingResult.error) throw recordingResult.error;
  if (summaryResult.error) throw summaryResult.error;
  if (agentRunsResult.error) throw agentRunsResult.error;
  if (agentJobsResult.error) throw agentJobsResult.error;
  if (agentEventsResult.error) throw agentEventsResult.error;
  if (triageDecisionsResult.error) throw triageDecisionsResult.error;
  const content = contentResult.data;
  let threadMessageCount = 1;
  if (content?.external_thread_id) {
    const { count, error } = await client.from('activities').select('id', { count: 'exact', head: true })
      .eq('workspace_key', WORKSPACE_KEY).eq('source', content.source)
      .eq('account_key', content.account_key).eq('external_thread_id', content.external_thread_id);
    if (error) throw error;
    threadMessageCount = count ?? 1;
  }
  const recommendations = Array.isArray(result.recommendations)
    ? result.recommendations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
  return response({
    ...result,
    signal: {
      ...(selected[0] ?? result.signal as Record<string, unknown>),
      rawBodyText: content?.raw_body_text ?? null,
      quotedText: content?.quoted_text ?? null,
      signatureText: content?.signature_text ?? null,
      hasQuotedContent: content?.has_quoted_content ?? false,
      contentParserVersion: content?.content_parser_version ?? null,
      contentParseMethod: content?.content_parse_method ?? null,
      contentParseConfidence: content?.content_parse_confidence ?? null,
      contentParsedAt: content?.content_parsed_at ?? null,
      threadMessageCount,
    },
    // The RPC owns Action availability because it evaluates the stored
    // recommendation version and current definition in one database snapshot.
    // Keep its reason/version fields intact and fail closed on older payloads.
    recommendations: recommendations.map((item) => ({
      ...item,
      available: item.available === true,
      locked: item.available !== true,
    })),
    recordings: recordingResult.data ? {
      status: recordingResult.data.status,
      items: Array.isArray(recordingResult.data.recordings) ? recordingResult.data.recordings : [],
      unavailableReason: recordingResult.data.unavailable_reason,
      updatedAt: recordingResult.data.updated_at,
    } : null,
    callSummary: summaryResult.data ? {
      status: summaryResult.data.status,
      summary: Array.isArray(summaryResult.data.summary) ? summaryResult.data.summary : [],
      nextSteps: Array.isArray(summaryResult.data.next_steps) ? summaryResult.data.next_steps : [],
      jobs: summaryResult.data.jobs,
      unavailableReason: summaryResult.data.unavailable_reason,
      updatedAt: summaryResult.data.updated_at,
    } : null,
    agentActivity: signalAgentActivity(
      agentRunsResult.data ?? [],
      agentJobsResult.data ?? [],
      triageDecisionsResult.data ?? [],
      agentEventsResult.data ?? [],
    ),
    historyNextCursor: encodeCursor(result.historyNextCursor),
  });
}

async function automationRunResults(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const valid = cleanExecutionReferences(body.executions);
  if (!valid) {
    return response({ error: 'Provide 1–100 Hermes execution references' }, 400);
  }
  const executionIds = [...new Set(valid.map((item) => item.executionId))];
  const allowed = new Set(valid.map((item) => `${item.profile}\u0000${item.executionId}`));
  const { data, error } = await client.from('agent_runs')
    .select('id,agent_key,job_id,activity_id,status,model,prompt_version,error,started_at,finished_at,runtime_profile,runtime_job_id,runtime_execution_id,runtime_session_id,result_schema_version,result_kind,result_title,result_summary,result_payload')
    .eq('runtime_provider', 'hermes')
    .in('runtime_execution_id', executionIds)
    .order('finished_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  const runs = (data ?? []).filter((item) => allowed.has(`${item.runtime_profile}\u0000${item.runtime_execution_id}`));
  const activityIds = [...new Set(runs.map((item) => item.activity_id))];
  const activities = new Map<string, Record<string, unknown>>();
  if (activityIds.length > 0) {
    const result = await client.from('activities')
      .select('id,subject,preview,event_type,direction,actor_name,occurred_at')
      .eq('workspace_key', WORKSPACE_KEY)
      .in('id', activityIds);
    if (result.error) throw result.error;
    for (const item of result.data ?? []) activities.set(String(item.id), item);
  }
  return response({
    runs: runs.map((run) => ({
      id: run.id,
      automationKey: run.agent_key,
      jobId: run.job_id,
      subject: { type: 'signal', id: String(run.activity_id) },
      signal: activities.get(String(run.activity_id)) ?? null,
      status: run.status,
      model: run.model,
      promptVersion: run.prompt_version,
      error: safeDiagnostic(run.error),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      runtime: {
        profile: run.runtime_profile,
        jobId: run.runtime_job_id,
        executionId: run.runtime_execution_id,
        sessionId: run.runtime_session_id,
      },
      result: run.result_schema_version ? {
        schemaVersion: run.result_schema_version,
        kind: run.result_kind,
        title: run.result_title,
        summary: run.result_summary,
        payload: run.result_payload,
      } : null,
      legacy: false,
    })),
  });
}

export function cleanExecutionReferences(
  value: unknown,
): Array<{ profile: string; executionId: string }> | null {
  const raw = Array.isArray(value) ? value : null;
  if (!raw || raw.length < 1 || raw.length > 100) return null;
  const executions = raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const profile = boundedText(record.profile, 64, true);
    const executionId = boundedText(record.executionId, 256, true);
    if (!profile || !executionId || !/^[A-Za-z0-9_-]+$/.test(profile) ||
      !/^[A-Za-z0-9._:-]+$/.test(executionId)) return null;
    return { profile, executionId };
  });
  return executions.some((item) => item === null)
    ? null
    : executions as Array<{ profile: string; executionId: string }>;
}

async function actionDefinitions(client: SupabaseClient): Promise<Response> {
  const { data, error } = await client.from('action_definitions')
    .select('id,key,name,description,handler_key,enabled,execution_mode,requires_confirmation,configuration,version,built_in,created_at,updated_at')
    .eq('workspace_key', WORKSPACE_KEY)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return response({
    definitions: (data ?? []).map(actionDefinitionPayload),
  });
}

async function updateActionDefinition(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!uuid(body.definitionId)) return response({ error: 'Invalid Action definition id' }, 400);
  const { data: current, error: readError } = await client.from('action_definitions')
    .select('*').eq('workspace_key', WORKSPACE_KEY).eq('id', body.definitionId).single();
  if (readError || !current) return response({ error: 'Action definition not found' }, 404);
  const expectedVersion = Number(body.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version) {
    return response({ error: 'Action definition changed; refresh before saving' }, 409);
  }
  const name = body.name === undefined ? current.name : boundedText(body.name, 100, true);
  const description = body.description === undefined
    ? current.description
    : boundedText(body.description, 1000, true);
  if (!name || !description) return response({ error: 'Invalid Action definition text' }, 400);
  const configuration = body.configuration === undefined ? current.configuration : body.configuration;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
    new TextEncoder().encode(JSON.stringify(configuration)).length > 65_536) {
    return response({ error: 'Invalid Action configuration' }, 400);
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : current.enabled;
  if (enabled && current.handler_key !== 'draft-email-reply') {
    return response({ error: 'This built-in Action is a placeholder and cannot be enabled yet' }, 409);
  }
  if (
    name === current.name &&
    description === current.description &&
    enabled === current.enabled &&
    jsonValuesEqual(configuration, current.configuration)
  ) {
    return response({ definition: actionDefinitionPayload(current) });
  }
  const { data, error } = await client.from('action_definitions').update({
    name,
    description,
    enabled,
    configuration,
    version: current.version + 1,
    updated_at: new Date().toISOString(),
  }).eq('workspace_key', WORKSPACE_KEY).eq('id', current.id).eq('version', current.version).select().single();
  if (error || !data) return response({ error: 'Action definition changed; refresh before saving' }, 409);
  return response({ definition: actionDefinitionPayload(data) });
}

interface ActionRow {
  id: string;
  action_definition_id: string;
  recommendation_id: string;
  source_activity_id: number;
  person_id: string | null;
  case_id: string | null;
  status: string;
  execution_mode: string;
  title: string;
  reason: string;
  recipient_email: string;
  subject: string;
  draft_body: string | null;
  draft_revision: number;
  last_error: string | null;
  simulated_at: string | null;
  completed_external_at: string | null;
  created_at: string;
  updated_at: string;
}

async function hydrateActions(client: SupabaseClient, rows: ActionRow[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const personIds = [...new Set(rows.map((item) => item.person_id).filter((id): id is string => Boolean(id)))];
  const definitionIds = [...new Set(rows.map((item) => item.action_definition_id))];
  const activityIds = [...new Set(rows.map((item) => item.source_activity_id))];
  const [peopleResult, definitionsResult, activitiesResult] = await Promise.all([
    personIds.length > 0
      ? client.from('people').select('id,display_name,primary_email,primary_phone').in('id', personIds)
      : Promise.resolve({ data: [], error: null }),
    client.from('action_definitions').select('id,key,name,handler_key').in('id', definitionIds),
    client.from('activities').select('id,source,account_key,subject,preview,body_text,raw_body_text,quoted_text,signature_text,has_quoted_content,content_parser_version,content_parse_method,content_parse_confidence,content_parsed_at,occurred_at,actor_name,actor_email,external_thread_id').in('id', activityIds),
  ]);
  if (peopleResult.error) throw peopleResult.error;
  if (definitionsResult.error) throw definitionsResult.error;
  if (activitiesResult.error) throw activitiesResult.error;
  const people = new Map((peopleResult.data ?? []).map((item) => [String(item.id), item]));
  const definitions = new Map((definitionsResult.data ?? []).map((item) => [String(item.id), item]));
  const activities = new Map((activitiesResult.data ?? []).map((item) => [Number(item.id), item]));
  const threadIds = [...new Set((activitiesResult.data ?? [])
    .map((item) => item.external_thread_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const threadCounts = new Map<string, number>();
  if (threadIds.length > 0) {
    const { data: threadRows, error: threadError } = await client.from('activities')
      .select('source,account_key,external_thread_id')
      .eq('workspace_key', WORKSPACE_KEY).in('external_thread_id', threadIds);
    if (threadError) throw threadError;
    for (const row of threadRows ?? []) {
      const key = `${row.source}:${row.account_key}:${row.external_thread_id}`;
      threadCounts.set(key, (threadCounts.get(key) ?? 0) + 1);
    }
  }
  return rows.map((item) => {
    const person = item.person_id ? people.get(item.person_id) : null;
    const definition = definitions.get(item.action_definition_id);
    const activity = activities.get(Number(item.source_activity_id));
    return {
      id: item.id,
      actionDefinitionKey: definition?.key ?? null,
      actionDefinitionName: definition?.name ?? 'Action',
      handler: definition?.handler_key ?? null,
      recommendationId: item.recommendation_id,
      sourceSignalId: String(item.source_activity_id),
      personId: item.person_id,
      contact: person ? {
        id: person.id,
        displayName: person.display_name,
        primaryEmail: person.primary_email,
        primaryPhone: person.primary_phone,
      } : null,
      caseId: item.case_id,
      status: item.status,
      executionMode: item.execution_mode,
      title: item.title,
      reason: item.reason,
      recipient: item.recipient_email,
      subject: item.subject,
      draftBody: item.draft_body,
      draftRevision: item.draft_revision,
      lastError: item.last_error,
      simulatedAt: item.simulated_at,
      completedExternalAt: item.completed_external_at,
      sourceSignal: activity ? {
        id: String(activity.id), source: activity.source,
        subject: activity.subject, preview: activity.preview,
        bodyText: activity.body_text,
        rawBodyText: activity.raw_body_text ?? (activity.content_parser_version ? null : activity.body_text),
        currentMessageText: activity.content_parser_version ? activity.body_text : null,
        quotedText: activity.quoted_text,
        signatureText: activity.signature_text,
        hasQuotedContent: activity.has_quoted_content,
        contentParserVersion: activity.content_parser_version,
        contentParseMethod: activity.content_parse_method,
        contentParseConfidence: activity.content_parse_confidence,
        contentParsedAt: activity.content_parsed_at,
        occurredAt: activity.occurred_at,
        actorName: activity.actor_name, actorEmail: activity.actor_email,
        threadId: activity.external_thread_id,
        threadMessageCount: activity.external_thread_id
          ? threadCounts.get(`${activity.source}:${activity.account_key}:${activity.external_thread_id}`) ?? 1
          : 1,
      } : null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  });
}

async function boardActions(client: SupabaseClient, url: URL): Promise<Response> {
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && (!cursor || !uuid(cursor.id))) return response({ error: 'Invalid Action cursor' }, 400);
  const limit = positiveInt(url.searchParams.get('limit'), 30, 100);
  let query = client.from('action_instances')
    .select('id,action_definition_id,recommendation_id,source_activity_id,person_id,case_id,status,execution_mode,title,reason,recipient_email,subject,draft_body,draft_revision,last_error,simulated_at,completed_external_at,created_at,updated_at')
    .eq('workspace_key', WORKSPACE_KEY)
    .not('status', 'in', '(completed_external,dismissed)')
    .order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`updated_at.lt.${cursor.at},and(updated_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw error;
  const page = (data ?? []) as ActionRow[];
  const rows = page.slice(0, limit);
  const last = rows.at(-1);
  return response({
    items: await hydrateActions(client, rows),
    nextCursor: page.length > limit && last ? encodeCursor({ at: last.updated_at, id: last.id }) : null,
  });
}

async function actionDetail(client: SupabaseClient, url: URL): Promise<Response> {
  const actionId = url.searchParams.get('actionId');
  if (!uuid(actionId)) return response({ error: 'Invalid Action id' }, 400);
  const { data, error } = await client.from('action_instances')
    .select('id,action_definition_id,recommendation_id,source_activity_id,person_id,case_id,status,execution_mode,title,reason,recipient_email,subject,draft_body,draft_revision,last_error,simulated_at,completed_external_at,created_at,updated_at')
    .eq('workspace_key', WORKSPACE_KEY).eq('id', actionId).single();
  if (error || !data) return response({ error: 'Action not found' }, 404);
  const { data: events, error: eventsError } = await client.from('action_events')
    .select('id,event_type,actor_type,actor_id,metadata,created_at')
    .eq('action_instance_id', actionId).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(100);
  if (eventsError) throw eventsError;
  const [action] = await hydrateActions(client, [data as ActionRow]);
  return response({ action, events: events ?? [] });
}

async function createdWork(client: SupabaseClient, url: URL, kind: 'action' | 'reminder'): Promise<Response> {
  const rawCursor = url.searchParams.get('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && (!cursor || !uuid(cursor.id))) return response({ error: 'Invalid work cursor' }, 400);
  const limit = positiveInt(url.searchParams.get('limit'), 30, 100);
  let query = client.from('work_items')
    .select('id,case_id,action_kind,title,reason,status,owner,due_at,created_at,updated_at')
    .eq('workspace_key', WORKSPACE_KEY)
    .not('created_by_user_at', 'is', null)
    .in('status', ['open', 'waiting'])
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  query = kind === 'action' ? query.is('due_at', null) : query.not('due_at', 'is', null);
  if (cursor) query = query.or(`updated_at.lt.${cursor.at},and(updated_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) throw error;
  const items = (data ?? []).slice(0, limit);
  const caseIds = [...new Set(items.map((item) => item.case_id).filter(Boolean))];
  const cases = new Map<string, { contact_id: string | null; job_name: string }>();
  if (caseIds.length > 0) {
    const { data: caseRows, error: caseError } = await client.from('operational_cases')
      .select('id,contact_id,job_name')
      .in('id', caseIds);
    if (caseError) throw caseError;
    for (const item of caseRows ?? []) cases.set(item.id, item);
  }
  const last = items.at(-1);
  return response({
    items: items.map((item) => {
      const linkedCase = cases.get(item.case_id);
      return {
        id: item.id,
        caseId: item.case_id,
        contactId: linkedCase?.contact_id ?? null,
        jobName: linkedCase?.job_name ?? 'Unlinked job',
        actionKind: item.action_kind,
        title: item.title,
        reason: item.reason,
        status: item.status,
        owner: item.owner,
        dueAt: item.due_at,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      };
    }),
    nextCursor: (data ?? []).length > limit && last
      ? encodeCursor({ at: last.updated_at, id: last.id })
      : null,
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  try {
    if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);
    const url = new URL(req.url);
    const action = url.searchParams.get('action') ?? 'summary';
    const client = db();
    if (req.method === 'GET' && action === 'summary') return await summary(client);
    if (req.method === 'GET' && action === 'people') return await people(client, url);
    if (req.method === 'GET' && action === 'pipeline') return await pipeline(client, url);
    if (req.method === 'GET' && action === 'pipeline-history') return await pipelineHistory(client, url);
    if (req.method === 'GET' && action === 'signals') return await signals(client, url);
    if (req.method === 'GET' && action === 'signal') return await signal(client, url);
    if (req.method === 'GET' && action === 'action-definitions') return await actionDefinitions(client);
    if (req.method === 'GET' && action === 'actions') return await boardActions(client, url);
    if (req.method === 'GET' && action === 'action-detail') return await actionDetail(client, url);
    if (req.method === 'GET' && action === 'reminders') return await createdWork(client, url, 'reminder');
    if (req.method === 'GET' && action === 'automations') return response({ items: [], nextCursor: null });
    if (req.method === 'GET' && action === 'potential-leads') return await potentialLeads(client, url);
    if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (action === 'agent-run-results') return await automationRunResults(client, body);
    if (action === 'ingest-dripjobs-chat') {
      const contactId = boundedText(body.contactId, 200, true);
      const channelId = boundedText(body.channelId, 500, true);
      const supportUserId = boundedText(body.supportUserId, 500, true);
      const customer = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer)
        ? body.customer as Record<string, unknown>
        : null;
      const customerName = boundedText(customer?.name, 500, true);
      const customerEmail = boundedText(customer?.email, 1000);
      const customerPhone = boundedText(customer?.phone, 200);
      const messages = Array.isArray(body.messages) ? body.messages : null;
      const firstSeenAt = messages?.reduce<string | null>((earliest, item) => {
        if (!item || typeof item !== 'object') return earliest;
        const value = (item as Record<string, unknown>).occurredAt;
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return earliest;
        return earliest === null || Date.parse(value) < Date.parse(earliest) ? value : earliest;
      }, null) ?? null;
      if (!contactId || !channelId || !supportUserId || !customerName ||
        customerEmail === null || customerPhone === null || !messages || !firstSeenAt ||
        messages.length < 1 || messages.length > 500 ||
        JSON.stringify(messages).length > 5_000_000) {
        return response({ error: 'Invalid DripJobs chat import' }, 400);
      }
      const personId = await rpc(client, 'ensure_dripjobs_chat_contact', {
        p_workspace_key: WORKSPACE_KEY,
        p_dripjobs_contact_id: contactId,
        p_customer_name: customerName,
        p_customer_email: customerEmail || null,
        p_customer_phone: customerPhone || null,
        p_first_seen_at: firstSeenAt,
      });
      const imported = await rpc(client, 'ingest_dripjobs_contact_chat_messages', {
        p_workspace_key: WORKSPACE_KEY,
        p_dripjobs_contact_id: contactId,
        p_channel_key: channelId,
        p_support_user_id: supportUserId,
        p_messages: messages,
      });
      return response({ personId, imported });
    }
    if (action === 'update-action-definition') return await updateActionDefinition(client, body);
    if (action === 'mark-signal-read') {
      if (!integerId(String(body.activityId))) return response({ error: 'Invalid Signal id' }, 400);
      try {
        return response(await rpc(client, 'mark_signal_read', {
          p_workspace_key: WORKSPACE_KEY,
          p_activity_id: body.activityId,
          p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
        }));
      } catch (error) {
        // The only way to violate the foreign key is to name a Signal that
        // does not exist; that is the caller's mistake, not an outage.
        if ((error as { code?: unknown })?.code === '23503') return response({ error: 'Signal not found' }, 404);
        throw error;
      }
    }
    if (action === 'decide-potential-lead') {
      const disposition = typeof body.disposition === 'string' ? body.disposition : '';
      if (!integerId(String(body.candidateId)) || !['undecided', 'lead', 'not_lead'].includes(disposition)) {
        return response({ error: 'Invalid Potential Lead decision' }, 400);
      }
      return response(await rpc(client, 'set_lead_candidate_disposition', {
        p_workspace_key: WORKSPACE_KEY,
        p_candidate_id: body.candidateId,
        p_disposition: disposition,
        p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
      }));
    }
    if (action === 'accept-recommendation') {
      if (!integerId(String(body.activityId)) || !uuid(body.recommendationId)) {
        return response({ error: 'Invalid recommendation acceptance' }, 400);
      }
      return response(await rpc(client, 'accept_signal_action_recommendation', {
        p_workspace_key: WORKSPACE_KEY,
        p_activity_id: body.activityId,
        p_recommendation_id: body.recommendationId,
        p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
      }));
    }
    if (action === 'update-action-draft') {
      if (!uuid(body.actionId) || !Number.isInteger(body.expectedRevision) ||
        boundedText(body.draftBody, 50_000, true) === null) {
        return response({ error: 'Invalid Action draft update' }, 400);
      }
      return response(await rpc(client, 'update_action_draft', {
        p_workspace_key: WORKSPACE_KEY, p_action_id: body.actionId,
        p_expected_revision: body.expectedRevision, p_draft_body: body.draftBody,
        p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
      }));
    }
    if (action === 'simulate-action-send') {
      if (!uuid(body.actionId) || !Number.isInteger(body.expectedRevision)) {
        return response({ error: 'Invalid simulated send' }, 400);
      }
      return response(await rpc(client, 'simulate_action_send', {
        p_workspace_key: WORKSPACE_KEY, p_action_id: body.actionId,
        p_expected_revision: body.expectedRevision,
        p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
      }));
    }
    if (action === 'retry-action') {
      if (!uuid(body.actionId)) return response({ error: 'Invalid Action id' }, 400);
      return response(await rpc(client, 'retry_action_draft', {
        p_workspace_key: WORKSPACE_KEY, p_action_id: body.actionId,
        p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
      }));
    }
    if (action === 'dismiss-action') {
      if (!uuid(body.actionId)) return response({ error: 'Invalid Action id' }, 400);
      return response(await rpc(client, 'dismiss_action_instance', {
        p_workspace_key: WORKSPACE_KEY, p_action_id: body.actionId,
        p_actor: typeof body.actor === 'string' ? body.actor : 'manager',
      }));
    }
    return response({ error: 'Unknown Board action' }, 404);
  } catch (error) {
    console.error('fluid-real-board', error);
    return response({ error: error instanceof Error ? error.message : 'Real Board request failed' }, 500);
  }
}

if (import.meta.main) Deno.serve((req: Request) => handleRequest(req));
