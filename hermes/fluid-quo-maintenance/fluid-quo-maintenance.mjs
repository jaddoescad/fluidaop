#!/usr/bin/env node

const DEFAULT_EDGE_URL =
  'https://fskrxkiujtfuxntcrjam.supabase.co/functions/v1/fluid-quo-events';
const EDGE_URL = (process.env.FLUID_QUO_EVENTS_URL || DEFAULT_EDGE_URL).replace(/\/$/, '');
const FLUID_API_URL = (process.env.FLUID_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SECRET = (
  process.env.FLUID_QUO_MAINTENANCE_SECRET ||
  ''
).trim();
const QUO_API_KEY = (process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY || '').trim();
const QUO_API = 'https://api.quo.com/v1';

function requireConfiguration({ quo = false } = {}) {
  if (!/^https:\/\//.test(EDGE_URL)) throw new Error('FLUID_QUO_EVENTS_URL must be HTTPS');
  if (SECRET.length < 43) throw new Error('Fluid maintenance authorization is not configured');
  if (quo && QUO_API_KEY.length < 20) throw new Error('QUO_API_KEY is not configured');
}

async function edge(action, { method = 'GET', body, timeout = 60_000 } = {}) {
  requireConfiguration();
  const url = new URL(EDGE_URL);
  url.searchParams.set('action', action);
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-fluid-activity-secret': SECRET,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Fluid Quo service: ${detail}`);
  }
  return payload;
}

async function fluidApi(path, { body, timeout = 15 * 60_000 } = {}) {
  requireConfiguration();
  if (!/^https?:\/\//.test(FLUID_API_URL)) throw new Error('FLUID_API_URL must be HTTP(S)');
  const response = await fetch(`${FLUID_API_URL}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-fluid-agent-secret': SECRET,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Fluid API: ${detail}`);
  }
  return payload?.result || {};
}

async function quo(path) {
  requireConfiguration({ quo: true });
  const response = await fetch(`${QUO_API}${path}`, {
    headers: { Accept: 'application/json', Authorization: QUO_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const nested = payload && typeof payload.error === 'object' ? payload.error : null;
    const detail = nested && typeof nested.message === 'string'
      ? nested.message
      : payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`;
    const error = new Error(`Quo API ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function enrichContacts() {
  let pageToken = null;
  let pages = 0;
  const totals = { pages: 0, seen: 0, matched: 0, evidence: 0, namesUpdated: 0 };
  do {
    const search = new URLSearchParams({ maxResults: '50' });
    if (pageToken) search.set('pageToken', pageToken);
    const payload = await quo(`/contacts?${search.toString()}`);
    const contacts = Array.isArray(payload?.data) ? payload.data : [];
    const result = await edge('enrich-contacts', {
      method: 'POST',
      body: { contacts },
    });
    totals.seen += Number(result?.seen || contacts.length);
    totals.matched += Number(result?.matched || 0);
    totals.evidence += Number(result?.evidence || 0);
    totals.namesUpdated += Number(result?.namesUpdated || 0);
    pageToken = typeof payload?.nextPageToken === 'string' && payload.nextPageToken.trim()
      ? payload.nextPageToken
      : null;
    pages += 1;
  } while (pageToken && pages < 500);
  if (pageToken) throw new Error('Quo contact pagination exceeded the bounded 500-page limit');
  totals.pages = pages;
  return totals;
}

async function backfillTranscripts() {
  const totals = { checked: 0, available: 0, unavailable: 0 };
  for (let batch = 0; batch < 20; batch += 1) {
    const payload = await edge('transcript-candidates');
    const calls = (Array.isArray(payload?.calls) ? payload.calls : []).filter((call) =>
      call && typeof call.external_id === 'string' && /^AC[A-Za-z0-9_-]+$/.test(call.external_id)
    );
    if (calls.length === 0) break;
    for (const call of calls) {
      const callId = call.external_id;
      totals.checked += 1;
      try {
        const transcript = await quo(`/call-transcripts/${encodeURIComponent(callId)}`);
        if (!transcript?.data) throw new Error('Quo returned an empty transcript response');
        await edge('transcript', {
          method: 'POST',
          body: { callId, data: transcript.data },
        });
        totals.available += 1;
      } catch (error) {
        if (![400, 403, 404].includes(Number(error?.status))) throw error;
        await edge('transcript', {
          method: 'POST',
          body: {
            callId,
            status: 'unavailable',
            reason: 'Quo has no retrievable transcript for this call. Older calls may predate transcription.',
          },
        });
        totals.unavailable += 1;
      }
    }
    if (calls.length < 100) break;
  }
  return totals;
}

const command = process.argv[2] || '';
let result;
if (command === 'enrich-contacts') result = await enrichContacts();
else if (command === 'backfill-call-content') result = await fluidApi('/api/internal/quo/call-content-backfill');
else if (command === 'backfill-recordings') result = await fluidApi('/api/internal/quo/call-content-backfill', {
  body: { kind: 'recording' },
});
else if (command === 'backfill-transcripts') result = await fluidApi('/api/internal/quo/transcript-backfill');
else throw new Error('usage: fluid-quo-maintenance.mjs enrich-contacts|backfill-call-content|backfill-recordings|backfill-transcripts');
console.log(JSON.stringify({ ok: true, command, ...result }));
