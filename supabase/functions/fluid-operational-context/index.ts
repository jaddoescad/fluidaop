import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const encoder = new TextEncoder();
const WORKSPACE_KEY = 'ottawa-painters';

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
  const supplied = req.headers.get('x-fluid-activity-secret')?.trim() ?? '';
  if (!supplied) return false;
  const expected = [
    Deno.env.get('FLUID_OPERATIONAL_CONTEXT_SECRET'),
    Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET'),
    Deno.env.get('FLUID_SLACK_SYNC_SECRET'),
    Deno.env.get('FLUID_EMAIL_CATEGORIZER_SECRET'),
  ].filter((value): value is string => Boolean(value));
  return expected.some((value) => safeEqual(value, supplied));
}

function positiveInt(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function dateCursor(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  // Keep PostgreSQL's microseconds intact. Re-serializing through Date would
  // truncate the cursor to milliseconds and skip rows sharing a batch timestamp.
  return Number.isFinite(parsed) ? value : null;
}

async function board(client: SupabaseClient, url: URL): Promise<Response> {
  const limit = positiveInt(url.searchParams.get('limit'), 30, 100);
  const status = url.searchParams.get('status') ?? 'open';
  const includeShadow = url.searchParams.get('includeShadow') === 'true';
  const cursorAt = dateCursor(url.searchParams.get('cursorAt'));
  const cursorId = url.searchParams.get('cursorId');
  if (!['open', 'waiting', 'completed'].includes(status)) return response({ error: 'Invalid board status' }, 400);
  if ((cursorAt === null) !== !cursorId || (cursorId && !uuid(cursorId))) return response({ error: 'Invalid board cursor' }, 400);

  let query = client.from('work_items')
    .select('id,case_id,action_kind,target_key,title,reason,status,owner,due_at,confidence,source_kind,input_revision,prerequisites,is_shadow,published_at,completed_at,created_at,updated_at')
    .eq('workspace_key', WORKSPACE_KEY)
    .eq('status', status)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (!includeShadow) query = query.eq('is_shadow', false);
  if (status === 'completed') query = query.gte('completed_at', new Date(Date.now() - 14 * 86_400_000).toISOString());
  if (cursorAt && cursorId) {
    query = query.or(`updated_at.lt.${cursorAt},and(updated_at.eq.${cursorAt},id.lt.${cursorId})`);
  }
  const { data: items, error } = await query;
  if (error) throw error;
  const page = (items ?? []).slice(0, limit);
  const caseIds = [...new Set(page.map((item) => item.case_id as string))];
  const { data: cases, error: casesError } = caseIds.length === 0
    ? { data: [], error: null }
    : await client.from('operational_cases')
      .select('id,job_id,contact_id,person_id,status,revision,canonical_state,updated_at')
      .in('id', caseIds);
  if (casesError) throw casesError;
  const jobIds = [...new Set((cases ?? []).map((item) => item.job_id as string))];
  const personIds = [...new Set((cases ?? []).map((item) => item.person_id as string | null).filter(Boolean))] as string[];
  const [{ data: jobs, error: jobsError }, { data: contacts, error: contactsError }] = await Promise.all([
    jobIds.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from('jobs')
      .select('id,name,status,scheduled_on,scheduled_end_on,started_on,completed_on,contract_amount_cents,formatted_address,updated_at')
      .in('id', jobIds),
    personIds.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from('people')
      .select('id,display_name,primary_email,primary_phone').in('id', personIds),
  ]);
  if (jobsError) throw jobsError;
  if (contactsError) throw contactsError;

  const evidenceByItem = new Map<string, unknown>();
  const itemIds = page.map((item) => item.id as string);
  if (itemIds.length > 0) {
    const { data: links, error: linksError } = await client.from('work_item_evidence')
      .select('work_item_id,case_evidence_id').in('work_item_id', itemIds);
    if (linksError) throw linksError;
    const evidenceIds = [...new Set((links ?? []).map((link) => link.case_evidence_id as number))];
    if (evidenceIds.length > 0) {
      const { data: evidenceRows, error: evidenceError } = await client.from('case_evidence')
        .select('id,evidence_type,activity_id,slack_message_id,relevance,observed_at').in('id', evidenceIds);
      if (evidenceError) throw evidenceError;
      const slackIds = (evidenceRows ?? []).map((row) => row.slack_message_id as number | null).filter(Boolean) as number[];
      const activityIds = (evidenceRows ?? []).map((row) => row.activity_id as number | null).filter(Boolean) as number[];
      const [{ data: slack, error: slackError }, { data: activities, error: activitiesError }] = await Promise.all([
        slackIds.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from('slack_messages')
          .select('id,text_content,permalink,occurred_at').in('id', slackIds),
        activityIds.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from('activities')
          .select('id,source,subject,preview,occurred_at').in('id', activityIds),
      ]);
      if (slackError) throw slackError;
      if (activitiesError) throw activitiesError;
      for (const link of links ?? []) {
        if (evidenceByItem.has(link.work_item_id as string)) continue;
        const evidence = (evidenceRows ?? []).find((row) => row.id === link.case_evidence_id);
        const slackRow = evidence?.slack_message_id ? (slack ?? []).find((row) => row.id === evidence.slack_message_id) : null;
        const activity = evidence?.activity_id ? (activities ?? []).find((row) => row.id === evidence.activity_id) : null;
        evidenceByItem.set(link.work_item_id as string, evidence ? {
          id: evidence.id,
          source: slackRow ? 'slack' : activity?.source ?? evidence.evidence_type,
          text: slackRow?.text_content ?? activity?.preview ?? '',
          occurredAt: slackRow?.occurred_at ?? activity?.occurred_at ?? evidence.observed_at,
          sourceLink: slackRow?.permalink ?? null,
        } : null);
      }
    }
  }

  const caseMap = new Map((cases ?? []).map((item) => [item.id as string, item]));
  const jobMap = new Map((jobs ?? []).map((item) => [item.id as string, item]));
  const contactMap = new Map((contacts ?? []).map((item) => [item.id as string, {
    id: item.id,
    name: item.display_name,
    email: item.primary_email,
    phone: item.primary_phone,
  }]));
  const result = page.map((item) => {
    const caseRow = caseMap.get(item.case_id as string);
    return {
      ...item,
      case: caseRow ? {
        id: caseRow.id,
        status: caseRow.status,
        revision: caseRow.revision,
        canonicalState: caseRow.canonical_state,
      } : null,
      job: caseRow ? jobMap.get(caseRow.job_id as string) ?? null : null,
      contact: caseRow?.person_id ? contactMap.get(caseRow.person_id as string) ?? null : null,
      latestEvidence: evidenceByItem.get(item.id as string) ?? null,
    };
  });
  const last = result.at(-1);
  return response({
    items: result,
    nextCursor: (items ?? []).length > limit && last
      ? { updatedAt: last.updated_at, id: last.id }
      : null,
  });
}

async function jobContext(client: SupabaseClient, url: URL): Promise<Response> {
  const jobId = url.searchParams.get('jobId');
  if (!uuid(jobId)) return response({ error: 'Invalid Job id' }, 400);
  const limit = positiveInt(url.searchParams.get('limit'), 30, 100);
  const cursorAt = dateCursor(url.searchParams.get('cursorAt'));
  const cursorId = url.searchParams.get('cursorId');
  if ((cursorAt === null) !== !cursorId || (cursorId && !/^\d+$/.test(cursorId))) return response({ error: 'Invalid context cursor' }, 400);
  const { data: job, error: jobError } = await client.from('jobs')
    .select('*').eq('id', jobId).maybeSingle();
  if (jobError) throw jobError;
  if (!job) return response({ error: 'Job not found' }, 404);
  const { data: caseRow, error: caseError } = await client.from('operational_cases')
    .select('*').eq('workspace_key', WORKSPACE_KEY).eq('job_id', jobId).maybeSingle();
  if (caseError) throw caseError;
  if (!caseRow) return response({ job, case: null, evidence: [], workItems: [] });
  const [{ data: contact, error: contactError }, { data: facts, error: factsError }, { data: assertions, error: assertionsError }, { data: workItems, error: itemsError }] = await Promise.all([
    caseRow.person_id ? client.from('people').select('id,display_name,primary_email,primary_phone').eq('id', caseRow.person_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    client.from('case_facts').select('id,fact_key,fact_value,authority_rank,source_type,source_ref,confidence,effective_at,observed_at')
      .eq('case_id', caseRow.id).eq('is_current', true).order('fact_key'),
    client.from('case_assertions').select('id,case_revision,assertion_kind,summary,confidence,evidence,created_at')
      .eq('case_id', caseRow.id).order('created_at', { ascending: false }).limit(50),
    client.from('work_items').select('*').eq('case_id', caseRow.id).order('updated_at', { ascending: false }).limit(100),
  ]);
  if (contactError) throw contactError;
  if (factsError) throw factsError;
  if (assertionsError) throw assertionsError;
  if (itemsError) throw itemsError;
  let evidenceQuery = client.from('case_evidence')
    .select('id,evidence_type,activity_id,slack_message_id,relevance,observed_at')
    .eq('case_id', caseRow.id)
    .order('observed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (cursorAt && cursorId) evidenceQuery = evidenceQuery.or(`observed_at.lt.${cursorAt},and(observed_at.eq.${cursorAt},id.lt.${cursorId})`);
  const { data: evidenceRows, error: evidenceError } = await evidenceQuery;
  if (evidenceError) throw evidenceError;
  const page = (evidenceRows ?? []).slice(0, limit);
  const slackIds = page.map((row) => row.slack_message_id as number | null).filter(Boolean) as number[];
  const activityIds = page.map((row) => row.activity_id as number | null).filter(Boolean) as number[];
  const [{ data: slack, error: slackError }, { data: activities, error: activitiesError }] = await Promise.all([
    slackIds.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from('slack_messages')
      .select('id,team_id,provider_message_ts,thread_ts,provider_user_id,text_content,permalink,file_metadata,occurred_at,edited_at,deleted_at')
      .in('id', slackIds),
    activityIds.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from('activities')
      .select('id,source,event_type,direction,actor_name,actor_email,actor_phone,subject,preview,occurred_at,has_attachments,attachment_count')
      .in('id', activityIds),
  ]);
  if (slackError) throw slackError;
  if (activitiesError) throw activitiesError;
  const slackUserIds = [...new Set((slack ?? [])
    .map((item) => item.provider_user_id as string | null)
    .filter(Boolean))] as string[];
  const { data: slackUsers, error: slackUsersError } = slackUserIds.length === 0
    ? { data: [], error: null }
    : await client.from('slack_users')
      .select('team_id,provider_user_id,display_name,real_name,is_bot')
      .eq('workspace_key', WORKSPACE_KEY)
      .in('provider_user_id', slackUserIds);
  if (slackUsersError) throw slackUsersError;
  const slackUserMap = new Map((slackUsers ?? []).map((item) => [
    `${item.team_id}:${item.provider_user_id}`,
    {
      id: item.provider_user_id,
      displayName: item.display_name || item.real_name || item.provider_user_id,
      isBot: item.is_bot,
    },
  ]));
  const evidence = page.map((row) => ({
    ...row,
    slack: row.slack_message_id ? (() => {
      const item = (slack ?? []).find((candidate) => candidate.id === row.slack_message_id);
      return item ? {
        ...item,
        author: item.provider_user_id
          ? slackUserMap.get(`${item.team_id}:${item.provider_user_id}`) ?? null
          : null,
      } : null;
    })() : null,
    activity: row.activity_id ? (activities ?? []).find((item) => item.id === row.activity_id) ?? null : null,
  }));
  const last = evidence.at(-1);
  return response({
    job,
    contact: contact ? {
      id: contact.id,
      name: contact.display_name,
      email: contact.primary_email,
      phone: contact.primary_phone,
    } : null,
    case: caseRow,
    facts: facts ?? [],
    assertions: assertions ?? [],
    workItems: workItems ?? [],
    evidence,
    nextCursor: (evidenceRows ?? []).length > limit && last
      ? { observedAt: last.observed_at, id: last.id }
      : null,
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (!authorized(req)) return response({ error: 'Unauthorized' }, 401);
    const url = new URL(req.url);
    const action = url.searchParams.get('action') ?? 'board';
    const client = db();
    if (req.method === 'GET' && action === 'board') return await board(client, url);
    if (req.method === 'GET' && action === 'job-context') return await jobContext(client, url);
    if (req.method === 'GET' && action === 'shadow-status') {
      const { data, error } = await client.from('case_reconciler_settings').select('*').eq('workspace_key', WORKSPACE_KEY).single();
      if (error) throw error;
      return response({ settings: data });
    }
    if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (action === 'resolve-work-item') {
      if (!uuid(body.workItemId) || !['complete', 'dismiss', 'reopen'].includes(String(body.resolution))) {
        return response({ error: 'Invalid work-item resolution' }, 400);
      }
      const { data, error } = await client.rpc('resolve_operational_work_item', {
        p_work_item_id: body.workItemId,
        p_action: body.resolution,
        p_note: typeof body.note === 'string' ? body.note : null,
        p_actor_id: typeof body.actorId === 'string' ? body.actorId : 'manager',
      });
      if (error) throw error;
      return response({ workItem: data });
    }
    if (action === 'claim') {
      const { data, error } = await client.rpc('claim_case_reconciliation_job', {
        p_worker: typeof body.worker === 'string' ? body.worker : 'case-reconciler',
        p_lease_seconds: typeof body.leaseSeconds === 'number' ? body.leaseSeconds : 900,
      });
      if (error) throw error;
      if (data?.case?.id) {
        const { data: casePerson, error: casePersonError } = await client.from('operational_cases')
          .select('person_id').eq('id', data.case.id).single();
        if (casePersonError) throw casePersonError;
        if (casePerson?.person_id) {
          const { data: person, error: personError } = await client.from('people')
            .select('id,display_name,primary_email,primary_phone')
            .eq('id', casePerson.person_id).single();
          if (personError) throw personError;
          data.contact = {
            id: person.id,
            name: person.display_name,
            email: person.primary_email,
            phone: person.primary_phone,
          };
        }
      }
      return response(data);
    }
    if (action === 'complete') {
      const { data, error } = await client.rpc('complete_case_reconciliation_job', {
        p_job_id: body.jobId,
        p_lease_token: body.leaseToken,
        p_model: body.model ?? null,
        p_prompt_version: body.promptVersion ?? 'case-reconciler-v1',
        p_assertions: body.assertions ?? [],
        p_proposals: body.proposals ?? [],
      });
      if (error) throw error;
      return response(data);
    }
    if (action === 'fail') {
      const { data, error } = await client.rpc('fail_case_reconciliation_job', {
        p_job_id: body.jobId,
        p_lease_token: body.leaseToken,
        p_error: body.error ?? 'Unknown reconciliation failure',
        p_model: body.model ?? null,
        p_prompt_version: body.promptVersion ?? 'case-reconciler-v1',
      });
      if (error) throw error;
      return response(data);
    }
    if (action === 'reconcile') {
      const { data, error } = await client.rpc('reconcile_operational_cases', {
        p_workspace_key: WORKSPACE_KEY,
        p_limit: typeof body.limit === 'number' ? body.limit : 500,
      });
      if (error) throw error;
      return response(data);
    }
    return response({ error: 'Unknown action' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected operational-context failure';
    console.error(message);
    return response({ error: message }, 500);
  }
});
