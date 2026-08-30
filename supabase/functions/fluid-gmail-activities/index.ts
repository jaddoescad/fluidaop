import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';

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
  raw_body_text: string | null;
  quoted_text: string | null;
  signature_text: string | null;
  has_quoted_content: boolean;
  content_parser_version: string;
  content_parse_method: string;
  content_parse_confidence: number;
  content_parsed_at: string;
  occurred_at: string;
  has_attachments: boolean;
  attachment_count: number;
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

type EmailContentPatch = {
  id: number;
  currentMessageText: string;
  rawBodyText: string;
  quotedText: string | null;
  signatureText: string | null;
  hasQuotedContent: boolean;
  parserVersion: string;
  parseMethod: string;
  parseConfidence: number;
  parsedAt: string;
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

function cleanLimit(raw: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, parsed));
}

function positiveId(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function uuidCursorFrom(url: URL): { createdAt: string; id: string } | null | false {
  const rawCreatedAt = url.searchParams.get('cursorAt');
  const rawId = url.searchParams.get('cursorId');
  if (rawCreatedAt === null && rawId === null) return null;
  const timestamp = rawCreatedAt === null ? Number.NaN : Date.parse(rawCreatedAt);
  if (!validUuid(rawId) || !Number.isFinite(timestamp)) return false;
  return { createdAt: new Date(timestamp).toISOString(), id: rawId };
}

function contactSummary(person: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!person || !validUuid(person.id)) return null;
  return {
    id: person.id,
    displayName: typeof person.display_name === 'string' ? person.display_name : 'Contact',
    primaryEmail: typeof person.primary_email === 'string' ? person.primary_email : null,
    primaryPhone: typeof person.primary_phone === 'string' ? person.primary_phone : null,
    entityType: person.entity_type === 'business' ? 'business' : 'person',
  };
}

async function activityEnrichment(
  supabase: SupabaseClient,
  activityIds: number[],
): Promise<{
  labelsByActivity: Map<number, unknown[]>;
  contactByActivity: Map<number, Record<string, unknown>>;
}> {
  if (activityIds.length === 0) {
    return { labelsByActivity: new Map(), contactByActivity: new Map() };
  }
  const [labelsResult, contactsResult] = await Promise.all([
    supabase
      .from('signal_labels')
      .select('activity_id,label_kind,confidence,reason,updated_at,label:labels!signal_labels_label_id_fkey(key,name,color,kind)')
      .eq('agent_key', 'signal-triage')
      .in('activity_id', activityIds),
    supabase
      .from('activity_people')
      .select('activity_id,matched_by,confidence,person:people!activity_people_person_id_fkey(id,display_name,primary_email,primary_phone,entity_type,status)')
      .eq('relationship', 'counterparty')
      .in('activity_id', activityIds),
  ]);
  if (labelsResult.error) throw labelsResult.error;
  if (contactsResult.error) throw contactsResult.error;
  const labelsByActivity = new Map<number, unknown[]>();
  for (const label of (labelsResult.data ?? []) as Array<Record<string, any>>) {
    const current = labelsByActivity.get(label.activity_id) ?? [];
    current.push(label);
    labelsByActivity.set(label.activity_id, current);
  }
  const contactByActivity = new Map<number, Record<string, unknown>>();
  for (const link of (contactsResult.data ?? []) as Array<Record<string, any>>) {
    const rawPerson = Array.isArray(link.person) ? link.person[0] : link.person;
    if (!rawPerson || rawPerson.status !== 'active' || contactByActivity.has(link.activity_id)) continue;
    const summary = contactSummary(rawPerson as Record<string, unknown>);
    if (summary) contactByActivity.set(link.activity_id, summary);
  }
  return { labelsByActivity, contactByActivity };
}

function cursorFrom(url: URL): { occurredAt: string; id: number } | null | false {
  const rawOccurredAt = url.searchParams.get('cursorAt');
  const rawId = url.searchParams.get('cursorId');
  if (rawOccurredAt === null && rawId === null) return null;
  const id = positiveId(rawId);
  const timestamp = rawOccurredAt === null ? Number.NaN : Date.parse(rawOccurredAt);
  if (id === null || !Number.isFinite(timestamp)) return false;
  return { occurredAt: new Date(timestamp).toISOString(), id };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= maximum ? cleaned : null;
}

function labelKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
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

function validContentPatches(value: unknown): value is { patches: EmailContentPatch[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const patches = (value as { patches?: unknown }).patches;
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 200) return false;
  return patches.every((patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const item = patch as Partial<EmailContentPatch>;
    return Number.isSafeInteger(item.id) && Number(item.id) > 0 &&
      typeof item.currentMessageText === 'string' && item.currentMessageText.length <= 100_000 &&
      typeof item.rawBodyText === 'string' && item.rawBodyText.length <= 100_000 &&
      (item.quotedText === null || (typeof item.quotedText === 'string' && item.quotedText.length <= 100_000)) &&
      (item.signatureText === null || (typeof item.signatureText === 'string' && item.signatureText.length <= 20_000)) &&
      typeof item.hasQuotedContent === 'boolean' &&
      typeof item.parserVersion === 'string' && item.parserVersion.length > 0 && item.parserVersion.length <= 100 &&
      typeof item.parseMethod === 'string' && item.parseMethod.length > 0 && item.parseMethod.length <= 100 &&
      typeof item.parseConfidence === 'number' && item.parseConfidence >= 0 && item.parseConfidence <= 1 &&
      typeof item.parsedAt === 'string' && Number.isFinite(Date.parse(item.parsedAt));
  });
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

    if (req.method === 'GET' && action === 'email-content-source') {
      const limit = cleanLimit(url.searchParams.get('limit'), 100, 200);
      const cursorId = url.searchParams.get('cursorId') === null
        ? null
        : positiveId(url.searchParams.get('cursorId'));
      if (url.searchParams.get('cursorId') !== null && cursorId === null) {
        return response({ error: 'Valid cursorId is required' }, 400);
      }
      let query = supabase.from('activities')
        .select('id,body_text,raw_body_text,content_parser_version')
        .eq('workspace_key', 'ottawa-painters')
        .eq('source', 'gmail')
        .order('id', { ascending: true })
        .limit(limit);
      if (cursorId !== null) query = query.gt('id', cursorId);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data ?? [];
      return response({
        rows,
        nextCursor: rows.length === limit ? rows.at(-1)?.id ?? null : null,
      });
    }

    if (req.method === 'POST' && action === 'email-content-patches') {
      const body: unknown = await req.json().catch(() => null);
      if (!validContentPatches(body)) return response({ error: 'Invalid email content patches' }, 400);
      // Updating body_text runs identity/triage/review triggers. Apply parser
      // patches sequentially so messages in one thread cannot deadlock while
      // those trigger paths reconcile shared state.
      for (const patch of body.patches) {
        const { error } = await supabase.from('activities').update({
          body_text: patch.currentMessageText || null,
          raw_body_text: patch.rawBodyText || null,
          quoted_text: patch.quotedText,
          signature_text: patch.signatureText,
          has_quoted_content: patch.hasQuotedContent,
          content_parser_version: patch.parserVersion,
          content_parse_method: patch.parseMethod,
          content_parse_confidence: patch.parseConfidence,
          content_parsed_at: patch.parsedAt,
        }).eq('workspace_key', 'ottawa-painters').eq('source', 'gmail').eq('id', patch.id);
        if (error) throw new Error(`Activity ${patch.id}: ${error.message}`);
      }
      return response({ updated: body.patches.length });
    }

    if (req.method === 'GET' && action === 'list') {
      const limit = cleanLimit(url.searchParams.get('limit'), 30, 50);
      const cursor = cursorFrom(url);
      if (cursor === false) return response({ error: 'Invalid activity cursor' }, 400);

      let signalsQuery = supabase
        .from('activities')
        .select(
          'id,source,account_email,account_phone,external_id,external_thread_id,event_type,direction,actor_name,actor_email,actor_phone,from_email,from_phone,to_emails,to_phones,cc_emails,subject,preview,occurred_at,has_attachments,attachment_count,call_status,duration_seconds,contact_id',
        )
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        signalsQuery = signalsQuery.or(
          `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`,
        );
      }

      const [signalsResult, countResult, syncResult] = await Promise.all([
        signalsQuery,
        supabase
          .from('activities')
          .select('id', { count: 'exact', head: true }),
        accountEmail
          ? supabase.from('gmail_sync_state').select('*').eq('account_email', accountEmail).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      const failure = [signalsResult, countResult, syncResult]
        .map((result) => result.error)
        .find(Boolean);
      if (failure) throw failure;

      const fetched = signalsResult.data ?? [];
      const hasMore = fetched.length > limit;
      const rawSignals = fetched.slice(0, limit);
      const signalIds = rawSignals.map((signal) => signal.id);
      const enrichment = await activityEnrichment(supabase, signalIds);
      const signals = rawSignals.map((signal) => ({
        ...signal,
        classifications: enrichment.labelsByActivity.get(signal.id) ?? [],
        contact: enrichment.contactByActivity.get(signal.id) ?? null,
      }));
      const last = signals[signals.length - 1];
      return response({
        signals,
        count: countResult.count ?? 0,
        nextCursor: hasMore && last
          ? { occurredAt: last.occurred_at, id: last.id }
          : null,
        sync: syncResult.data,
      });
    }

    if (req.method === 'GET' && action === 'signal') {
      const signalId = positiveId(url.searchParams.get('signalId'));
      if (signalId === null) {
        return response({ error: 'Valid signalId is required' }, 400);
      }
      const { data, error } = await supabase
        .from('activities')
        .select(
          'id,source,account_email,account_phone,external_id,external_thread_id,event_type,direction,actor_name,actor_email,actor_phone,from_email,from_phone,to_emails,to_phones,cc_emails,subject,preview,body_text,raw_body_text,quoted_text,signature_text,has_quoted_content,content_parser_version,content_parse_method,content_parse_confidence,content_parsed_at,occurred_at,has_attachments,attachment_count,call_status,duration_seconds,contact_id,source_metadata',
        )
        .eq('id', signalId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return response({ error: 'Signal not found' }, 404);

      const [enrichment, attachmentsResult, transcriptResult] = await Promise.all([
        activityEnrichment(supabase, [signalId]),
        supabase
          .from('signal_attachment_evidence')
          .select('attachment_key,filename,mime_type,size_bytes,extraction_status,extraction_method,updated_at')
          .eq('activity_id', signalId)
          .eq('agent_key', 'signal-triage')
          .order('id', { ascending: true }),
        supabase
          .from('activity_call_transcripts')
          .select('status,dialogue,transcript_text,unavailable_reason,transcript_created_at,updated_at')
          .eq('activity_id', signalId)
          .maybeSingle(),
      ]);
      if (attachmentsResult.error) throw attachmentsResult.error;
      if (transcriptResult.error) throw transcriptResult.error;

      let historyCount = 0;
      if (data.external_thread_id) {
        const historyResult = await supabase
          .from('activities')
          .select('id', { count: 'exact', head: true })
          .eq('source', data.source)
          .eq('account_key', data.account_email ?? data.account_phone)
          .eq('external_thread_id', data.external_thread_id)
          .neq('id', signalId);
        if (historyResult.error) throw historyResult.error;
        historyCount = historyResult.count ?? 0;
      }
      return response({
        signal: {
          ...data,
          classifications: enrichment.labelsByActivity.get(signalId) ?? [],
          contact: enrichment.contactByActivity.get(signalId) ?? null,
          attachmentEvidence: attachmentsResult.data ?? [],
          transcript: transcriptResult.data,
        },
        historyCount,
      });
    }

    if (req.method === 'GET' && action === 'history') {
      const signalId = positiveId(url.searchParams.get('signalId'));
      const limit = cleanLimit(url.searchParams.get('limit'), 5, 20);
      const cursor = cursorFrom(url);
      if (signalId === null || cursor === false) {
        return response({ error: 'Valid signalId and cursor are required' }, 400);
      }

      const selectedResult = await supabase
        .from('activities')
        .select('source,account_key,external_thread_id')
        .eq('id', signalId)
        .maybeSingle();
      if (selectedResult.error) throw selectedResult.error;
      if (!selectedResult.data) return response({ error: 'Signal not found' }, 404);
      const threadId = selectedResult.data.external_thread_id;
      if (!threadId) return response({ messages: [], count: 0, nextCursor: null });

      let messagesQuery = supabase
        .from('activities')
        .select(
          'id,source,account_email,account_phone,external_id,external_thread_id,event_type,direction,actor_name,actor_email,actor_phone,from_email,from_phone,to_emails,to_phones,cc_emails,subject,preview,body_text,raw_body_text,quoted_text,signature_text,has_quoted_content,content_parser_version,content_parse_method,content_parse_confidence,content_parsed_at,occurred_at,has_attachments,attachment_count,call_status,duration_seconds,contact_id,source_metadata',
        )
        .eq('source', selectedResult.data.source)
        .eq('account_key', selectedResult.data.account_key)
        .eq('external_thread_id', threadId)
        .neq('id', signalId)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        messagesQuery = messagesQuery.or(
          `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`,
        );
      }

      const [messagesResult, countResult] = await Promise.all([
        messagesQuery,
        supabase
          .from('activities')
          .select('id', { count: 'exact', head: true })
          .eq('source', selectedResult.data.source)
          .eq('account_key', selectedResult.data.account_key)
          .eq('external_thread_id', threadId)
          .neq('id', signalId),
      ]);
      if (messagesResult.error) throw messagesResult.error;
      if (countResult.error) throw countResult.error;

      const fetched = messagesResult.data ?? [];
      const hasMore = fetched.length > limit;
      const rawMessages = fetched.slice(0, limit);
      const enrichment = await activityEnrichment(supabase, rawMessages.map((message) => message.id));
      const messages = rawMessages.map((message) => ({
        ...message,
        classifications: enrichment.labelsByActivity.get(message.id) ?? [],
        contact: enrichment.contactByActivity.get(message.id) ?? null,
      }));
      const last = messages[messages.length - 1];
      return response({
        messages,
        count: countResult.count ?? 0,
        nextCursor: hasMore && last
          ? { occurredAt: last.occurred_at, id: last.id }
          : null,
      });
    }

    if (req.method === 'GET' && action === 'state') {
      if (!accountEmail) return response({ error: 'accountEmail is required' }, 400);
      const { data, error } = await supabase
        .from('gmail_sync_state')
        .select('*')
        .eq('account_email', accountEmail)
        .maybeSingle();
      if (error) throw error;
      return response({ sync: data });
    }

    if (req.method === 'GET' && action === 'labels') {
      const { data, error } = await supabase
        .from('labels')
        .select('id,kind,key,name,description,color,enabled,sort_order,created_at,updated_at')
        .eq('workspace_key', 'ottawa-painters')
        .order('kind', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });
      if (error) throw error;
      return response({ labels: data ?? [] });
    }

    if (req.method === 'GET' && action === 'contact-roles') {
      const { data, error } = await supabase
        .from('contact_role_definitions')
        .select('key,name,description,enabled,sort_order')
        .eq('workspace_key', 'ottawa-painters')
        .eq('enabled', true)
        .order('sort_order')
        .order('key');
      if (error) throw error;
      return response({ roles: data ?? [] });
    }

    if (req.method === 'GET' && action === 'contact-search') {
      const rawQuery = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
      const queryText = rawQuery.replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim();
      const fields = ['display_name', 'primary_email', 'primary_phone'] as const;
      const baseSelect = 'id,display_name,primary_email,primary_phone,entity_type';
      const results = queryText
        ? await Promise.all(fields.map((field) => supabase
          .from('people')
          .select(baseSelect)
          .eq('workspace_key', 'ottawa-painters')
          .eq('status', 'active')
          .ilike(field, `%${queryText}%`)
          .order('display_name')
          .limit(20)))
        : [await supabase
          .from('people')
          .select(baseSelect)
          .eq('workspace_key', 'ottawa-painters')
          .eq('status', 'active')
          .order('updated_at', { ascending: false })
          .limit(20)];
      const failure = results.map((result) => result.error).find(Boolean);
      if (failure) throw failure;
      const unique = new Map<string, Record<string, unknown>>();
      for (const result of results) {
        for (const person of result.data ?? []) unique.set(person.id, person);
      }
      const contacts = [...unique.values()]
        .sort((left, right) => String(left.display_name).localeCompare(String(right.display_name)))
        .slice(0, 20)
        .map((person) => contactSummary(person));
      return response({ contacts });
    }

    if (req.method === 'GET' && action === 'contacts') {
      const limit = cleanLimit(url.searchParams.get('limit'), 30, 100);
      const cursor = uuidCursorFrom(url);
      if (cursor === false) return response({ error: 'Invalid Contact cursor' }, 400);
      const role = cleanText(url.searchParams.get('role'), 100);
      const rawQuery = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
      const queryText = rawQuery.replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim();
      const status = url.searchParams.get('status') === 'archived' ? 'archived' : 'active';
      if (role && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) {
        return response({ error: 'Invalid Contact role' }, 400);
      }

      const select = role
        ? 'id,display_name,primary_email,primary_phone,status,entity_type,created_at,updated_at,roles:person_roles!inner(role_key,active)'
        : 'id,display_name,primary_email,primary_phone,status,entity_type,created_at,updated_at,roles:person_roles(role_key,active)';
      let query = supabase
        .from('people')
        .select(select, { count: 'exact' })
        .eq('workspace_key', 'ottawa-painters')
        .eq('status', status)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (role) {
        query = query.eq('person_roles.role_key', role).eq('person_roles.active', true);
      }
      if (queryText) {
        query = query.or([
          `display_name.ilike.%${queryText}%`,
          `primary_email.ilike.%${queryText}%`,
          `primary_phone.ilike.%${queryText}%`,
        ].join(','));
      }
      if (cursor) {
        query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
      }
      const { data, error, count } = await query;
      if (error) throw error;
      const fetched = data ?? [];
      const hasMore = fetched.length > limit;
      const rawContacts = fetched.slice(0, limit);
      const personIds = rawContacts.map((contact) => contact.id);
      const [activityResult, dealResult] = personIds.length === 0
        ? [{ data: [], error: null }, { data: [], error: null }]
        : await Promise.all([
          supabase
            .from('contact_activity_stats')
            .select('person_id,linked_signal_count,last_signal_at')
            .eq('workspace_key', 'ottawa-painters')
            .in('person_id', personIds),
          supabase
            .from('dripjobs_sales_deals')
            .select('person_id,deal_id,archived_at')
            .in('person_id', personIds),
        ]);
      if (activityResult.error) throw activityResult.error;
      if (dealResult.error) throw dealResult.error;
      const stats = new Map<string, { count: number; lastSignalAt: string | null }>();
      for (const row of activityResult.data ?? []) {
        stats.set(row.person_id, {
          count: Number(row.linked_signal_count ?? 0),
          lastSignalAt: row.last_signal_at ?? null,
        });
      }
      const dealStats = new Map<string, { count: number; activeCount: number }>();
      for (const deal of dealResult.data ?? []) {
        const current = dealStats.get(deal.person_id) ?? { count: 0, activeCount: 0 };
        current.count += 1;
        if (deal.archived_at === null) current.activeCount += 1;
        dealStats.set(deal.person_id, current);
      }
      const contacts = rawContacts.map((contact) => ({
        id: contact.id,
        displayName: contact.display_name,
        primaryEmail: contact.primary_email,
        primaryPhone: contact.primary_phone,
        status: contact.status,
        entityType: contact.entity_type,
        roles: [...new Set((Array.isArray(contact.roles) ? contact.roles : [])
          .filter((entry) => entry.active)
          .map((entry) => entry.role_key))],
        linkedSignalCount: stats.get(contact.id)?.count ?? 0,
        lastSignalAt: stats.get(contact.id)?.lastSignalAt ?? null,
        dealCount: dealStats.get(contact.id)?.count ?? 0,
        activeDealCount: dealStats.get(contact.id)?.activeCount ?? 0,
        createdAt: contact.created_at,
        updatedAt: contact.updated_at,
      }));
      const last = contacts[contacts.length - 1];
      return response({
        contacts,
        count: count ?? 0,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      });
    }

    if (req.method === 'GET' && action === 'contact') {
      const contactId = url.searchParams.get('contactId');
      if (!validUuid(contactId)) return response({ error: 'Valid contactId is required' }, 400);
      const [personResult, rolesResult, claimsResult, sourcesResult, dealsResult] = await Promise.all([
        supabase
          .from('people')
          .select('id,display_name,primary_email,primary_phone,status,entity_type,created_at,updated_at')
          .eq('workspace_key', 'ottawa-painters')
          .eq('id', contactId)
          .maybeSingle(),
        supabase
          .from('person_roles')
          .select('role_key,source_system,source_record_type,source_record_id,active,first_seen_at,last_seen_at')
          .eq('person_id', contactId)
          .eq('active', true)
          .order('role_key'),
        supabase
          .from('person_identity_claims')
          .select('id,identity_id,source_system,source_record_type,source_record_id,confidence,is_primary,active,first_seen_at,last_seen_at')
          .eq('person_id', contactId)
          .eq('active', true)
          .order('is_primary', { ascending: false })
          .order('id'),
        supabase
          .from('person_sources')
          .select('source_system,source_record_type,source_record_id,source_created_at,source_updated_at,first_synced_at,last_synced_at')
          .eq('person_id', contactId)
          .order('last_synced_at', { ascending: false }),
        supabase.rpc('list_contact_deals', {
          p_person_id: contactId,
          p_workspace_key: 'ottawa-painters',
        }),
      ]);
      const failure = [personResult, rolesResult, claimsResult, sourcesResult, dealsResult]
        .map((result) => result.error).find(Boolean);
      if (failure) throw failure;
      if (!personResult.data) return response({ error: 'Contact not found' }, 404);
      const identityIds = [...new Set((claimsResult.data ?? []).map((claim) => claim.identity_id))];
      const identityResult = identityIds.length === 0
        ? { data: [], error: null }
        : await supabase
          .from('identities')
          .select('id,kind,display_value,display_name,classification,first_seen_at,last_seen_at')
          .in('id', identityIds);
      if (identityResult.error) throw identityResult.error;
      const identityById = new Map((identityResult.data ?? []).map((identity) => [identity.id, identity]));
      const person = personResult.data;
      const roles = [...new Set((rolesResult.data ?? []).map((role) => role.role_key))].map((roleKey) => {
        const evidence = (rolesResult.data ?? []).filter((role) => role.role_key === roleKey);
        const latest = evidence.slice().sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0];
        return { ...latest, role_key: roleKey, sourceCount: evidence.length };
      });
      const identifiers = identityIds.flatMap((identityId) => {
        const identity = identityById.get(identityId);
        if (!identity) return [];
        const claims = (claimsResult.data ?? []).filter((claim) => claim.identity_id === identityId);
        const primaryClaim = claims.find((claim) => claim.is_primary) ?? claims[0];
        if (!primaryClaim) return [];
        return [{
          id: identity.id,
          kind: identity.kind,
          value: identity.display_value,
          displayName: identity.display_name,
          classification: identity.classification,
          confidence: Math.max(...claims.map((claim) => Number(claim.confidence))),
          primary: claims.some((claim) => claim.is_primary),
          sourceCount: claims.length,
          source: {
            system: primaryClaim.source_system,
            recordType: primaryClaim.source_record_type,
            recordId: primaryClaim.source_record_id,
          },
          firstSeenAt: claims.map((claim) => claim.first_seen_at).sort()[0],
          lastSeenAt: claims.map((claim) => claim.last_seen_at).sort().at(-1),
        }];
      });
      return response({
        contact: {
          id: person.id,
          displayName: person.display_name,
          primaryEmail: person.primary_email,
          primaryPhone: person.primary_phone,
          status: person.status,
          entityType: person.entity_type,
          createdAt: person.created_at,
          updatedAt: person.updated_at,
        },
        roles,
        identifiers,
        sources: sourcesResult.data ?? [],
        deals: dealsResult.data ?? { count: 0, activeCount: 0, items: [] },
      });
    }

    if (req.method === 'GET' && action === 'contact-activities') {
      const contactId = url.searchParams.get('contactId');
      const limit = cleanLimit(url.searchParams.get('limit'), 30, 50);
      const cursor = cursorFrom(url);
      if (!validUuid(contactId) || cursor === false) {
        return response({ error: 'Valid contactId and cursor are required' }, 400);
      }
      let query = supabase
        .from('activities')
        .select('id,source,account_email,account_phone,external_id,external_thread_id,event_type,direction,actor_name,actor_email,actor_phone,subject,preview,occurred_at,has_attachments,attachment_count,call_status,duration_seconds,links:activity_people!inner(person_id,relationship)')
        .eq('activity_people.person_id', contactId)
        .eq('activity_people.relationship', 'counterparty')
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        query = query.or(`occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error) throw error;
      const fetched = data ?? [];
      const hasMore = fetched.length > limit;
      const rawSignals = fetched.slice(0, limit).map(({ links: _links, ...signal }) => signal);
      const enrichment = await activityEnrichment(supabase, rawSignals.map((signal) => signal.id));
      const signals = rawSignals.map((signal) => ({
        ...signal,
        classifications: enrichment.labelsByActivity.get(signal.id) ?? [],
        contact: enrichment.contactByActivity.get(signal.id) ?? null,
      }));
      const last = signals[signals.length - 1];
      return response({
        signals,
        nextCursor: hasMore && last ? { occurredAt: last.occurred_at, id: last.id } : null,
      });
    }

    if (req.method === 'GET' && action === 'contact-suggestions') {
      const limit = cleanLimit(url.searchParams.get('limit'), 30, 100);
      const cursor = uuidCursorFrom(url);
      if (cursor === false) return response({ error: 'Invalid suggestion cursor' }, 400);
      let query = supabase
        .from('contact_suggestions')
        .select('id,identity_id,activity_id,suggestion_type,status,proposed_entity_type,proposed_role_key,proposed_display_name,confidence,reason,evidence,source_revision,created_at,updated_at,identity:identities!contact_suggestions_identity_id_fkey(id,kind,display_value,display_name,classification),activity:activities!contact_suggestions_activity_id_fkey(id,source,event_type,direction,subject,preview,occurred_at)', { count: 'exact' })
        .eq('workspace_key', 'ottawa-painters')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
      }
      const { data, error, count } = await query;
      if (error) throw error;
      const fetched = data ?? [];
      const hasMore = fetched.length > limit;
      const rawSuggestions = fetched.slice(0, limit);
      const identityIds = [...new Set(rawSuggestions.map((suggestion) => suggestion.identity_id))];
      const claimsResult = identityIds.length === 0
        ? { data: [], error: null }
        : await supabase
          .from('person_identity_claims')
          .select('identity_id,person_id,confidence,source_system,person:people!person_identity_claims_person_id_fkey(id,display_name,primary_email,primary_phone,status)')
          .eq('active', true)
          .in('identity_id', identityIds);
      if (claimsResult.error) throw claimsResult.error;
      const candidatesByIdentity = new Map<string, unknown[]>();
      const candidateKeys = new Set<string>();
      for (const claim of claimsResult.data ?? []) {
        const candidate = Array.isArray(claim.person) ? claim.person[0] : claim.person;
        if (!candidate || candidate.status !== 'active') continue;
        const candidateKey = `${claim.identity_id}:${candidate.id}`;
        if (candidateKeys.has(candidateKey)) continue;
        candidateKeys.add(candidateKey);
        const current = candidatesByIdentity.get(claim.identity_id) ?? [];
        current.push({
          contact: contactSummary(candidate as Record<string, unknown>),
          confidence: claim.confidence,
          sourceSystem: claim.source_system,
        });
        candidatesByIdentity.set(claim.identity_id, current);
      }
      const suggestions = rawSuggestions.map((suggestion) => ({
        ...suggestion,
        candidates: candidatesByIdentity.get(suggestion.identity_id) ?? [],
      }));
      const last = suggestions[suggestions.length - 1];
      return response({
        suggestions,
        count: count ?? 0,
        nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
      });
    }

    if (req.method === 'POST' && action === 'resolve-contact-suggestion') {
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return response({ error: 'A valid resolution body is required' }, 400);
      }
      const input = body as Record<string, unknown>;
      const suggestionId = input.suggestionId;
      const resolution = input.action;
      const contactId = input.contactId;
      if (!validUuid(suggestionId) || !['create', 'link', 'ignore'].includes(String(resolution)) ||
        (resolution === 'link' && !validUuid(contactId)) ||
        (resolution !== 'link' && contactId !== undefined && contactId !== null)) {
        return response({ error: 'Invalid suggestion resolution' }, 400);
      }
      const { data, error } = await supabase.rpc('resolve_contact_suggestion', {
        p_suggestion_id: suggestionId,
        p_action: resolution,
        p_contact_id: resolution === 'link' ? contactId : null,
      });
      if (error) {
        if (error.message.includes('no longer pending')) return response({ error: 'Suggestion is no longer pending' }, 409);
        if (error.message.includes('already belongs')) return response({ error: error.message }, 409);
        throw error;
      }
      return response({ result: data });
    }

    if (req.method === 'GET' && action === 'agent-history') {
      const limit = cleanLimit(url.searchParams.get('limit'), 20, 50);
      const requestedAgent = 'signal-triage';
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id,status,model,error,started_at,finished_at,input_revision')
        .eq('agent_key', requestedAgent)
        .order('finished_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return response({
        agentId: requestedAgent,
        jobs: [{
          id: requestedAgent,
          name: 'Fluid Signal Triage — database only — every minute',
          profile: 'default',
        }],
        runs: (data ?? []).map((run) => ({
          id: run.id,
          jobId: requestedAgent,
          jobName: 'Fluid Signal Triage — database only — every minute',
          profile: 'default',
          status: run.status,
          source: 'supabase-agent-audit',
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          error: run.error,
          sessionId: null,
          model: run.model,
          messageCount: null,
          toolCallCount: null,
        })),
        fetchedAt: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && action === 'label') {
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return response({ error: 'A valid label body is required' }, 400);
      }
      const input = body as Record<string, unknown>;
      const id = input.id === undefined ? null : positiveId(String(input.id));
      const kind = input.kind === 'urgency' || input.kind === 'topic' ? input.kind : null;
      const name = cleanText(input.name, 80);
      const description = typeof input.description === 'string' && input.description.length <= 500
        ? input.description.trim()
        : null;
      const color = typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
        ? input.color.toLowerCase()
        : null;
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : null;
      if (kind === null || name === null || description === null || color === null || enabled === null) {
        return response({ error: 'Valid kind, name, description, color, and enabled fields are required' }, 400);
      }

      if (id === null) {
        const key = labelKey(name);
        if (!key) return response({ error: 'Label name must contain a letter or number' }, 400);
        const { data, error } = await supabase
          .from('labels')
          .insert({
            workspace_key: 'ottawa-painters',
            account_email: accountEmail || null,
            kind,
            key,
            name,
            description,
            color,
            enabled,
            sort_order: 900,
          })
          .select('id,kind,key,name,description,color,enabled,sort_order,created_at,updated_at')
          .single();
        if (error) {
          if (error.code === '23505') return response({ error: 'A label with that name already exists' }, 409);
          throw error;
        }
        return response({ label: data }, 201);
      }

      const { data, error } = await supabase
        .from('labels')
        .update({ kind, name, description, color, enabled, updated_at: new Date().toISOString() })
        .eq('workspace_key', 'ottawa-painters')
        .eq('id', id)
        .select('id,kind,key,name,description,color,enabled,sort_order,created_at,updated_at')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') return response({ error: 'A label with that name already exists' }, 409);
        throw error;
      }
      if (!data) return response({ error: 'Label not found' }, 404);
      return response({ label: data });
    }

    if (req.method === 'POST' && action === 'upsert') {
      const body: unknown = await req.json();
      if (!validPayload(body)) return response({ error: 'Invalid activity payload' }, 400);

      // Exact identity resolution belongs to the database resolver. Ingestion
      // must never pick the first source Contact that happens to share an
      // email, because shared identifiers are explicit review conflicts.
      const rows = body.activities.map((activity) => {
        const row = { ...activity };
        delete row.contact_id;
        return row;
      });
      for (const rowBatch of chunks(rows, 200)) {
        const { error } = await supabase
          .from('activities')
          .upsert(rowBatch, { onConflict: 'source,account_key,external_id' });
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
