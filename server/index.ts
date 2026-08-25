import 'dotenv/config';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { NextFunction, Request, Response } from 'express';
import {
  fetchGmailActivityBackfill,
  fetchGmailActivityChanges,
  GmailActivityRow,
  GmailApiError,
} from './gmailActivities.js';
import {
  parseQuoExport,
  QuoActivityInput,
  QuoContactInput,
  QuoImportKind,
  QuoPhoneNumber,
} from './quoCsv.js';

type ConnectionStatus = 'connected' | 'error' | 'checking';

interface StoredConnectionBase {
  id: string;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  error: string | null;
}

interface StoredGmailConnection extends StoredConnectionBase {
  provider: 'gmail';
  email: string;
  encryptedRefreshToken: string;
}

interface StoredQuoConnection extends StoredConnectionBase {
  provider: 'quo';
  phoneNumbers: QuoPhoneNumber[];
  selectedPhoneNumberIds: string[];
  encryptedApiKey: string;
}

type StoredConnection = StoredGmailConnection | StoredQuoConnection;

interface ConnectionStore {
  version: 1;
  connections: StoredConnection[];
}

interface PublicGmailConnection extends Omit<StoredGmailConnection, 'encryptedRefreshToken'> {
  nextCheckAt: string | null;
}

interface QuoWebhookStatus {
  state: 'receiving' | 'ready' | 'pending';
  url: string;
  lastEventAt: string | null;
  signingSecretConfigured: boolean;
}

interface PublicQuoConnection extends Omit<StoredQuoConnection, 'encryptedApiKey'> {
  nextCheckAt: string | null;
  webhook: QuoWebhookStatus;
}

type PublicConnection = PublicGmailConnection | PublicQuoConnection;

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GmailProfile {
  emailAddress?: string;
  historyId?: string;
}

interface QuoPhoneNumbersResponse {
  data?: Array<{
    id?: string;
    formattedNumber?: string;
    phoneNumber?: string;
    name?: string | null;
  }>;
}

interface PendingAuthorization {
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

const app = express();
const port = readPositiveInt(process.env.API_PORT, 8787);
const healthCheckIntervalMs = readPositiveInt(
  process.env.GMAIL_HEALTH_CHECK_INTERVAL_MS,
  5 * 60_000,
);
const intendedEmail = (process.env.GMAIL_ALLOWED_EMAIL ?? 'info@paintersottawa.com')
  .trim()
  .toLowerCase();
const gmailSyncLookbackDays = readPositiveInt(process.env.GMAIL_SYNC_LOOKBACK_DAYS, 30);
const gmailSyncMaximumMessages = readPositiveInt(process.env.GMAIL_SYNC_MAX_MESSAGES, 500);
const gmailActivitySyncIntervalMs = readPositiveInt(
  process.env.GMAIL_ACTIVITY_SYNC_INTERVAL_MS,
  5 * 60_000,
);
const supabaseProjectUrl = process.env.SUPABASE_PROJECT_URL?.trim().replace(/\/$/, '') ?? '';
const hermesBaseUrl = (
  process.env.HERMES_BASE_URL ?? 'https://ottawa-painters-hermes-5745.agents.nousresearch.com'
).trim().replace(/\/$/, '');
const hermesAgentIds = new Set([
  'signal-triage',
  'email-categorizer',
  'contractor-invoices',
  'dripjobs-operations',
  'meta-ads-reporter',
]);
const storePath = resolve(process.env.CONNECTION_STORE_PATH ?? '.data/connections.json');
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const activeHealthChecks = new Map<string, Promise<PublicConnection>>();
const activeActivitySyncs = new Map<string, Promise<ActivitySyncResult>>();
const lastActivitySyncAttemptAt = new Map<string, number>();
let store: ConnectionStore = { version: 1, connections: [] };
let writeChain: Promise<void> = Promise.resolve();

interface ActivitySyncResult {
  accountEmail: string;
  imported: number;
  messagesSeen: number;
  lookbackDays: number;
  truncated: boolean;
  mode: 'full' | 'incremental';
  completedAt: string;
}

interface StoredActivitySyncState {
  connection_id: string;
  account_email: string;
  last_history_id: string | null;
  last_sync_status: 'idle' | 'running' | 'succeeded' | 'failed';
  last_sync_started_at: string | null;
  last_sync_completed_at: string | null;
  last_full_sync_at: string | null;
  messages_seen: number;
  messages_upserted: number;
  last_error: string | null;
  updated_at: string;
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function encryptionProblems(): string[] {
  const problems: string[] = [];
  if ((process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim().length ?? 0) < 32) {
    problems.push('CONNECTION_TOKEN_ENCRYPTION_KEY (at least 32 characters)');
  }
  return problems;
}

function gmailConfigurationProblems(): string[] {
  const problems = encryptionProblems();
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) problems.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) problems.push('GOOGLE_CLIENT_SECRET');
  return problems;
}

function quoConfigurationProblems(): string[] {
  return encryptionProblems();
}

function requireGmailConfigured(): void {
  const problems = gmailConfigurationProblems();
  if (problems.length > 0) {
    throw new HttpError(503, `Missing server configuration: ${problems.join(', ')}`);
  }
}

function requireDatabaseConfigured(): void {
  const problems = encryptionProblems();
  if (problems.length > 0) {
    throw new HttpError(503, `Missing server configuration: ${problems.join(', ')}`);
  }
  if (!supabaseProjectUrl) {
    throw new HttpError(503, 'Missing server configuration: SUPABASE_PROJECT_URL');
  }
}

function requireActivityConfigured(): void {
  requireGmailConfigured();
  requireDatabaseConfigured();
}

function encryptionKey(): Buffer {
  const secret = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('CONNECTION_TOKEN_ENCRYPTION_KEY is not configured');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function activityFunctionSecret(): string {
  const root = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!root || root.length < 32) throw new Error('CONNECTION_TOKEN_ENCRYPTION_KEY is not configured');
  return createHash('sha256').update('fluid-activity-sync:v1\0').update(root, 'utf8').digest('hex');
}

function hermesHistoryToken(): string {
  const explicit = process.env.HERMES_HISTORY_TOKEN?.trim();
  if (explicit) return explicit;
  const root = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!root || root.length < 32) {
    throw new HttpError(
      503,
      'Hermes history needs HERMES_HISTORY_TOKEN or CONNECTION_TOKEN_ENCRYPTION_KEY on the server.',
    );
  }
  return createHmac('sha256', root)
    .update('fluid-hermes-history-v1', 'utf8')
    .digest('base64url');
}

async function hermesMetadataJson(path: 'agents' | 'skills'): Promise<Record<string, unknown>> {
  const response = await fetch(`${hermesBaseUrl}/api/plugins/fluid-history/${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${hermesHistoryToken()}`,
    },
    signal: AbortSignal.timeout(8_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, 'Hermes rejected Fluid metadata authentication.');
    }
    if (response.status === 404) {
      throw new HttpError(502, 'The Fluid metadata bridge is not available in Hermes.');
    }
    throw new HttpError(502, `Hermes ${path} returned HTTP ${response.status}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(502, `Hermes returned an invalid ${path} response`);
  }
  return payload as Record<string, unknown>;
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptToken(value: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Stored connection credential is malformed');
  const [ivPart, tagPart, ciphertextPart] = parts;
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Stored connection credential is malformed');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

async function loadStore(): Promise<void> {
  try {
    const raw = await readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ConnectionStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.connections)) {
      throw new Error('unsupported data format');
    }
    store = { version: 1, connections: parsed.connections as StoredConnection[] };
    let migrated = false;
    for (const connection of store.connections) {
      if (connection.provider === 'quo' && !Array.isArray(connection.selectedPhoneNumberIds)) {
        // Older connections discovered every accessible line but did not distinguish
        // discovery from capture consent. Default safely to no active lines.
        connection.selectedPhoneNumberIds = [];
        migrated = true;
      }
    }
    if (migrated) await saveStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Could not read connection store at ${storePath}: ${errorMessage(error)}`);
  }
}

async function saveStore(): Promise<void> {
  const snapshot = `${JSON.stringify(store, null, 2)}\n`;
  writeChain = writeChain.then(async () => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, storePath);
  });
  await writeChain;
}

async function toPublicConnection(connection: StoredConnection): Promise<PublicConnection> {
  const problems = connection.provider === 'gmail'
    ? gmailConfigurationProblems()
    : quoConfigurationProblems();
  const lastChecked = connection.lastCheckedAt ? Date.parse(connection.lastCheckedAt) : Number.NaN;
  const nextAt = Number.isFinite(lastChecked) ? lastChecked + healthCheckIntervalMs : Date.now();
  const common = {
    id: connection.id,
    status: problems.length > 0 ? 'error' : connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastCheckedAt: connection.lastCheckedAt,
    lastHealthyAt: connection.lastHealthyAt,
    nextCheckAt: new Date(nextAt).toISOString(),
    error:
      problems.length > 0
        ? `Server configuration is incomplete: ${problems.join(', ')}`
        : connection.error,
  };
  if (connection.provider === 'gmail') {
    return { ...common, provider: 'gmail', email: connection.email };
  }
  let webhook: QuoWebhookStatus = {
    state: 'pending',
    url: quoWebhookUrl(),
    lastEventAt: null,
    signingSecretConfigured: false,
  };
  try {
    const status = await quoFunctionJson<{
      signingSecretConfigured?: boolean;
      lastEvent?: { received_at?: string } | null;
    }>('status');
    const lastEventAt = status.lastEvent?.received_at ?? null;
    webhook = {
      state: status.signingSecretConfigured ? (lastEventAt ? 'receiving' : 'ready') : 'pending',
      url: quoWebhookUrl(),
      lastEventAt,
      signingSecretConfigured: Boolean(status.signingSecretConfigured),
    };
  } catch {
    // The API-key connection remains usable if webhook setup is incomplete.
  }
  return {
    ...common,
    provider: 'quo',
    phoneNumbers: connection.phoneNumbers,
    selectedPhoneNumberIds: connection.selectedPhoneNumberIds,
    webhook,
  };
}

function originFor(req: Request): string {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function callbackUri(req: Request): string {
  return `${originFor(req)}/api/oauth/google/callback`;
}

function callbackRedirect(req: Request, gmail: 'connected' | 'error', message: string): string {
  const url = new URL('/connections', originFor(req));
  url.searchParams.set('gmail', gmail);
  url.searchParams.set('message', message);
  return url.toString();
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

async function fetchGoogleJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = raw;
    }
  }
  if (!response.ok) {
    const detail = googleResponseError(payload);
    throw new Error(detail ? `Google API ${response.status}: ${detail}` : `Google API ${response.status}`);
  }
  return payload as T;
}

function quoPhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  return null;
}

async function fetchQuoJson<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`https://api.openphone.com/v1${path}`, {
    headers: { Accept: 'application/json', Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = raw;
    }
  }
  if (!response.ok) {
    const detail = googleResponseError(payload);
    throw new Error(detail ? `Quo API ${response.status}: ${detail}` : `Quo API ${response.status}`);
  }
  return payload as T;
}

async function getQuoPhoneNumbers(apiKey: string): Promise<QuoPhoneNumber[]> {
  const payload = await fetchQuoJson<QuoPhoneNumbersResponse>('/phone-numbers', apiKey);
  const numbers = (payload.data ?? []).flatMap((number) => {
    const id = number.id?.trim();
    const phone = quoPhone(number.phoneNumber ?? number.formattedNumber);
    if (!id || !phone) return [];
    return [{ id, e164: phone, label: number.name?.trim() || null }];
  });
  if (numbers.length === 0) throw new Error('Quo returned no accessible phone numbers for this API key');
  return numbers;
}

function selectedQuoPhoneNumbers(connection: StoredQuoConnection): QuoPhoneNumber[] {
  const selected = new Set(connection.selectedPhoneNumberIds);
  return connection.phoneNumbers.filter((number) => selected.has(number.id));
}

async function activityFunctionJson<T>(
  action:
    | 'list'
    | 'signal'
    | 'history'
    | 'state'
    | 'labels'
    | 'label'
    | 'agent-history'
    | 'upsert'
    | 'contacts'
    | 'contact'
    | 'contact-activities'
    | 'contact-suggestions'
    | 'resolve-contact-suggestion'
    | 'contact-roles'
    | 'contact-search',
  search: Record<string, string>,
  init?: RequestInit,
): Promise<T> {
  requireDatabaseConfigured();
  const url = new URL(`${supabaseProjectUrl}/functions/v1/fluid-gmail-activities`);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'x-fluid-activity-secret': activityFunctionSecret(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = raw;
    }
  }
  if (!response.ok) {
    const detail = googleResponseError(payload) ?? `Supabase activity service returned ${response.status}`;
    throw new HttpError(response.status >= 500 ? 502 : response.status, detail);
  }
  return payload as T;
}

function quoWebhookUrl(): string {
  return supabaseProjectUrl
    ? `${supabaseProjectUrl}/functions/v1/fluid-quo-events`
    : '';
}

async function quoFunctionJson<T>(
  action: 'status' | 'backfill' | 'scope' | 'transcript' | 'transcript-candidates' | 'enrich-contacts',
  init?: RequestInit,
): Promise<T> {
  requireDatabaseConfigured();
  const url = new URL(quoWebhookUrl());
  url.searchParams.set('action', action);
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'x-fluid-activity-secret': activityFunctionSecret(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = raw;
    }
  }
  if (!response.ok) {
    const detail = googleResponseError(payload) ?? `Supabase Quo service returned ${response.status}`;
    throw new HttpError(response.status >= 500 ? 502 : response.status, detail);
  }
  return payload as T;
}

async function syncQuoScope(connection: StoredQuoConnection, phoneNumbers: QuoPhoneNumber[]): Promise<void> {
  await quoFunctionJson('scope', {
    method: 'POST',
    body: JSON.stringify({ connectionId: connection.id, phoneNumbers }),
  });
}

function connectedQuo(): StoredQuoConnection {
  const connection = store.connections.find(
    (item): item is StoredQuoConnection => item.provider === 'quo',
  );
  if (!connection) throw new HttpError(409, 'Connect Quo before running maintenance');
  if (selectedQuoPhoneNumbers(connection).length === 0) {
    throw new HttpError(409, 'Choose at least one Quo phone line before running maintenance');
  }
  return connection;
}

async function runQuoContactEnrichment(): Promise<Record<string, number>> {
  const connection = connectedQuo();
  const apiKey = decryptToken(connection.encryptedApiKey);
  let pageToken: string | null = null;
  let pages = 0;
  let seen = 0;
  let matched = 0;
  let evidence = 0;
  let namesUpdated = 0;
  do {
    const search = new URLSearchParams({ maxResults: '50' });
    if (pageToken) search.set('pageToken', pageToken);
    const payload = await fetchQuoJson<{
      data?: unknown[];
      nextPageToken?: string | null;
    }>(`/contacts?${search.toString()}`, apiKey);
    const contacts = Array.isArray(payload.data) ? payload.data : [];
    const result = await quoFunctionJson<{
      seen?: number;
      matched?: number;
      evidence?: number;
      namesUpdated?: number;
    }>('enrich-contacts', {
      method: 'POST',
      body: JSON.stringify({ contacts }),
      signal: AbortSignal.timeout(60_000),
    });
    seen += result.seen ?? contacts.length;
    matched += result.matched ?? 0;
    evidence += result.evidence ?? 0;
    namesUpdated += result.namesUpdated ?? 0;
    pageToken = typeof payload.nextPageToken === 'string' && payload.nextPageToken.trim()
      ? payload.nextPageToken
      : null;
    pages += 1;
  } while (pageToken && pages < 500);
  if (pageToken) throw new Error('Quo contact pagination exceeded the bounded 500-page limit');
  return { pages, seen, matched, evidence, namesUpdated };
}

async function runQuoTranscriptBackfill(): Promise<Record<string, number>> {
  const connection = connectedQuo();
  const apiKey = decryptToken(connection.encryptedApiKey);
  let checked = 0;
  let available = 0;
  let unavailable = 0;
  for (let batch = 0; batch < 20; batch += 1) {
    const candidates = await quoFunctionJson<{
      calls?: Array<{ id?: number; external_id?: string }>;
    }>('transcript-candidates');
    const calls = (candidates.calls ?? []).filter((call) =>
      typeof call.id === 'number' && typeof call.external_id === 'string' && /^AC[A-Za-z0-9_-]+$/.test(call.external_id)
    );
    if (calls.length === 0) break;
    for (const call of calls) {
      const callId = call.external_id as string;
      checked += 1;
      try {
        const transcript = await fetchQuoJson<{ data?: Record<string, unknown> }>(
          `/call-transcripts/${encodeURIComponent(callId)}`,
          apiKey,
        );
        if (!transcript.data) throw new Error('Quo returned an empty transcript response');
        await quoFunctionJson('transcript', {
          method: 'POST',
          body: JSON.stringify({ callId, data: transcript.data }),
          signal: AbortSignal.timeout(60_000),
        });
        available += 1;
      } catch (error) {
        const message = errorMessage(error);
        if (!/Quo API (400|403|404)/.test(message)) throw error;
        await quoFunctionJson('transcript', {
          method: 'POST',
          body: JSON.stringify({
            callId,
            status: 'unavailable',
            reason: 'Quo has no retrievable transcript for this call. Older calls may predate transcription.',
          }),
        });
        unavailable += 1;
      }
    }
    if (calls.length < 100) break;
  }
  return { checked, available, unavailable };
}

function authorizedHermesAutomation(req: Request): boolean {
  const supplied = req.headers['x-fluid-agent-secret'];
  return typeof supplied === 'string' && supplied.length >= 43 &&
    safeEqual(activityFunctionSecret(), supplied);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function customerFunctionJson<T>(
  action: 'status' | 'people',
  search: Record<string, string> = {},
): Promise<T> {
  requireActivityConfigured();
  const url = new URL(`${supabaseProjectUrl}/functions/v1/fluid-customer-sync`);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'x-fluid-activity-secret': activityFunctionSecret(),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = raw;
    }
  }
  if (!response.ok) {
    const detail = googleResponseError(payload) ?? `Supabase people service returned ${response.status}`;
    throw new HttpError(response.status >= 500 ? 502 : response.status, detail);
  }
  return payload as T;
}

function googleResponseError(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.slice(0, 240);
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.error_description === 'string') return body.error_description;
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') {
    const nested = body.error as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }
  return null;
}

function publicGoogleError(error: unknown): string {
  const message = errorMessage(error);
  if (/invalid_grant/i.test(message)) {
    return 'Google authorization expired or was revoked. Disconnect and reconnect Gmail.';
  }
  if (/insufficient|permission|forbidden|403/i.test(message)) {
    return 'Google no longer grants the required Gmail read access. Reconnect Gmail.';
  }
  if (/fetch failed|network|timed?\s*out/i.test(message)) {
    return 'Google could not be reached. The next health check will retry automatically.';
  }
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

function publicQuoError(error: unknown): string {
  const message = errorMessage(error);
  if (/401|403|unauthor|forbidden|api.?key/i.test(message)) {
    return 'Quo rejected this API key. Create a new key in Quo and reconnect.';
  }
  if (/fetch failed|network|timed?\s*out/i.test(message)) {
    return 'Quo could not be reached. The next health check will retry automatically.';
  }
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

async function exchangeAuthorizationCode(
  code: string,
  pending: PendingAuthorization,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirect_uri: pending.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: pending.codeVerifier,
  });
  return fetchGoogleJson<GoogleTokenResponse>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const tokens = await fetchGoogleJson<GoogleTokenResponse>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokens.access_token) throw new Error('Google did not return an access token');
  return tokens.access_token;
}

async function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  return fetchGoogleJson<GmailProfile>('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function revokeGoogleToken(token: string): Promise<void> {
  const url = new URL('https://oauth2.googleapis.com/revoke');
  url.searchParams.set('token', token);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!response.ok) throw new Error(`Google token revocation returned ${response.status}`);
}

async function performHealthCheck(connectionId: string): Promise<PublicConnection> {
  const connection = store.connections.find((item) => item.id === connectionId);
  if (!connection) throw new HttpError(404, 'Connection not found');
  if (connection.provider === 'gmail') requireGmailConfigured();
  else if (quoConfigurationProblems().length > 0) {
    throw new HttpError(503, `Missing server configuration: ${quoConfigurationProblems().join(', ')}`);
  }

  connection.status = 'checking';
  connection.updatedAt = new Date().toISOString();
  await saveStore();

  try {
    if (connection.provider === 'gmail') {
      const refreshToken = decryptToken(connection.encryptedRefreshToken);
      const accessToken = await refreshAccessToken(refreshToken);
      const profile = await getGmailProfile(accessToken);
      const actualEmail = profile.emailAddress?.trim().toLowerCase();
      if (actualEmail !== connection.email.toLowerCase()) {
        throw new Error(`Google returned a different mailbox (${actualEmail ?? 'unknown'})`);
      }
    } else {
      const phoneNumbers = await getQuoPhoneNumbers(decryptToken(connection.encryptedApiKey));
      const availableIds = new Set(phoneNumbers.map((number) => number.id));
      connection.selectedPhoneNumberIds = connection.selectedPhoneNumberIds.filter((id) => availableIds.has(id));
      connection.phoneNumbers = phoneNumbers;
      await syncQuoScope(connection, selectedQuoPhoneNumbers(connection));
    }
    const checkedAt = new Date().toISOString();
    connection.status = 'connected';
    connection.lastCheckedAt = checkedAt;
    connection.lastHealthyAt = checkedAt;
    connection.updatedAt = checkedAt;
    connection.error = null;
  } catch (error) {
    const checkedAt = new Date().toISOString();
    connection.status = 'error';
    connection.lastCheckedAt = checkedAt;
    connection.updatedAt = checkedAt;
    connection.error = connection.provider === 'gmail' ? publicGoogleError(error) : publicQuoError(error);
  }
  await saveStore();
  return await toPublicConnection(connection);
}

function checkConnection(connectionId: string): Promise<PublicConnection> {
  const running = activeHealthChecks.get(connectionId);
  if (running) return running;
  const check = performHealthCheck(connectionId).finally(() => {
    activeHealthChecks.delete(connectionId);
  });
  activeHealthChecks.set(connectionId, check);
  return check;
}

async function performActivitySync(connection: StoredGmailConnection): Promise<ActivitySyncResult> {
  requireActivityConfigured();
  const startedAt = new Date().toISOString();
  let previousState: StoredActivitySyncState | null = null;
  let stateLoaded = false;
  try {
    const refreshToken = decryptToken(connection.encryptedRefreshToken);
    const accessToken = await refreshAccessToken(refreshToken);
    const profile = await getGmailProfile(accessToken);
    const accountEmail = profile.emailAddress?.trim().toLowerCase();
    if (!accountEmail || accountEmail !== connection.email.toLowerCase()) {
      throw new Error(`Google returned a different mailbox (${accountEmail ?? 'unknown'})`);
    }

    const statePayload = await activityFunctionJson<{ sync: StoredActivitySyncState | null }>(
      'state',
      { accountEmail },
    );
    previousState = statePayload.sync;
    stateLoaded = true;

    let mode: ActivitySyncResult['mode'] = 'incremental';
    let nextHistoryId = profile.historyId ?? previousState?.last_history_id ?? null;
    let imported;
    try {
      imported = previousState?.last_history_id
        ? await fetchGmailActivityChanges(
          accessToken,
          accountEmail,
          previousState.last_history_id,
          gmailSyncMaximumMessages,
        )
        : null;
    } catch (error) {
      // Gmail history cursors normally last at least a week. If Google has
      // expired one, rebuild the recent cache and establish a fresh cursor.
      if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
      imported = null;
    }

    if (imported === null) {
      mode = 'full';
      imported = await fetchGmailActivityBackfill(
        accessToken,
        accountEmail,
        gmailSyncLookbackDays,
        gmailSyncMaximumMessages,
      );
      nextHistoryId = profile.historyId ?? nextHistoryId;
    } else {
      nextHistoryId = imported.historyId;
    }

    const completedAt = new Date().toISOString();
    const syncStateBase = {
      connection_id: connection.id,
      account_email: accountEmail,
      // Do not advance the cursor until every activity batch is durable.
      last_history_id: previousState?.last_history_id ?? null,
      last_sync_started_at: startedAt,
      messages_seen: imported.messagesSeen,
      last_error: null,
    };
    let upserted = 0;
    for (let index = 0; index < imported.activities.length; index += 200) {
      const activities = imported.activities.slice(index, index + 200);
      upserted += activities.length;
      await activityFunctionJson<{ upserted: number }>('upsert', {}, {
        method: 'POST',
        body: JSON.stringify({
          activities,
          syncState: {
            ...syncStateBase,
            last_sync_status: 'running',
            last_sync_completed_at: null,
            last_full_sync_at: previousState?.last_full_sync_at ?? null,
            messages_upserted: upserted,
            updated_at: new Date().toISOString(),
          },
        }),
      });
    }
    await activityFunctionJson<{ upserted: number }>('upsert', {}, {
      method: 'POST',
      body: JSON.stringify({
        activities: [],
        syncState: {
          ...syncStateBase,
          last_history_id: nextHistoryId,
          connection_id: connection.id,
          account_email: accountEmail,
          last_sync_status: 'succeeded',
          last_sync_completed_at: completedAt,
          last_full_sync_at: mode === 'full' ? completedAt : previousState?.last_full_sync_at ?? null,
          messages_upserted: imported.activities.length,
          updated_at: completedAt,
        },
      } satisfies { activities: GmailActivityRow[]; syncState: Record<string, unknown> }),
    });

    connection.status = 'connected';
    connection.lastCheckedAt = completedAt;
    connection.lastHealthyAt = completedAt;
    connection.updatedAt = completedAt;
    connection.error = null;
    await saveStore();

    return {
      accountEmail,
      imported: imported.activities.length,
      messagesSeen: imported.messagesSeen,
      lookbackDays: gmailSyncLookbackDays,
      truncated: imported.truncated,
      mode,
      completedAt,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = publicGoogleError(error);
    // If the state read itself failed, do not overwrite a cursor we never saw.
    // A later retry can safely resume from the durable value already in Supabase.
    if (stateLoaded) {
      await activityFunctionJson<{ upserted: number }>('upsert', {}, {
        method: 'POST',
        body: JSON.stringify({
          activities: [],
          syncState: {
            connection_id: connection.id,
            account_email: connection.email.toLowerCase(),
            last_history_id: previousState?.last_history_id ?? null,
            last_sync_status: 'failed',
            last_sync_started_at: startedAt,
            last_sync_completed_at: completedAt,
            last_full_sync_at: previousState?.last_full_sync_at ?? null,
            messages_seen: 0,
            messages_upserted: 0,
            last_error: message,
            updated_at: completedAt,
          },
        }),
      }).catch(() => undefined);
    }
    throw error;
  }
}

function syncActivities(connection: StoredGmailConnection): Promise<ActivitySyncResult> {
  const running = activeActivitySyncs.get(connection.id);
  if (running) return running;
  lastActivitySyncAttemptAt.set(connection.id, Date.now());
  const sync = performActivitySync(connection).finally(() => {
    activeActivitySyncs.delete(connection.id);
  });
  activeActivitySyncs.set(connection.id, sync);
  return sync;
}

async function syncDueActivities(): Promise<void> {
  if (gmailConfigurationProblems().length > 0 || !supabaseProjectUrl) return;
  const now = Date.now();
  const due = store.connections.filter((connection): connection is StoredGmailConnection => {
    if (connection.provider !== 'gmail') return false;
    const lastAttempt = lastActivitySyncAttemptAt.get(connection.id) ?? 0;
    return now - lastAttempt >= gmailActivitySyncIntervalMs;
  });
  const results = await Promise.allSettled(due.map((connection) => syncActivities(connection)));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.imported > 0) {
        console.log(
          `Gmail activity auto-sync imported ${result.value.imported} update(s) for ${result.value.accountEmail}.`,
        );
      }
    } else {
      console.warn(`Gmail activity auto-sync failed: ${publicGoogleError(result.reason)}`);
    }
  }
}

async function checkAllConnections(): Promise<void> {
  await Promise.allSettled(store.connections.map((connection) => checkConnection(connection.id)));
}

async function checkDueConnections(): Promise<void> {
  const now = Date.now();
  const due = store.connections.filter((connection) => {
    if (!connection.lastCheckedAt) return true;
    const lastCheckedAt = Date.parse(connection.lastCheckedAt);
    return !Number.isFinite(lastCheckedAt) || now - lastCheckedAt >= healthCheckIntervalMs;
  });
  await Promise.allSettled(due.map((connection) => checkConnection(connection.id)));
}

app.get('/api/connections', async (_req, res, next) => {
  try {
    const gmailProblems = gmailConfigurationProblems();
    const quoProblems = quoConfigurationProblems();
    res.json({
      connections: await Promise.all(store.connections.map(toPublicConnection)),
      healthCheckIntervalMs,
      configured: gmailProblems.length === 0,
      gmail: {
        configured: gmailProblems.length === 0,
        ...(gmailProblems.length > 0
          ? { configurationError: `Add ${gmailProblems.join(', ')} to the server environment.` }
          : {}),
      },
      quo: {
        configured: quoProblems.length === 0,
        ...(quoProblems.length > 0
          ? { configurationError: `Add ${quoProblems.join(', ')} to the server environment.` }
          : {}),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/connections/gmail/authorize', (req, res, next) => {
  try {
    requireGmailConfigured();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const redirectUri = callbackUri(req);
    pendingAuthorizations.set(state, {
      codeVerifier,
      redirectUri,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      login_hint: intendedEmail,
      state,
      code_challenge: base64UrlSha256(codeVerifier),
      code_challenge_method: 'S256',
    }).toString();
    res.json({ authorizationUrl: authorizationUrl.toString() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/oauth/google/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const pending = state ? pendingAuthorizations.get(state) : undefined;
  if (state) pendingAuthorizations.delete(state);

  const oauthError = typeof req.query.error === 'string' ? req.query.error : null;
  if (oauthError) {
    res.redirect(callbackRedirect(req, 'error', 'Google authorization was cancelled or denied.'));
    return;
  }
  if (!pending || pending.expiresAt < Date.now()) {
    res.redirect(callbackRedirect(req, 'error', 'The sign-in request expired. Please try connecting again.'));
    return;
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.redirect(callbackRedirect(req, 'error', 'Google did not return an authorization code.'));
    return;
  }

  try {
    requireGmailConfigured();
    const tokens = await exchangeAuthorizationCode(code, pending);
    if (!tokens.access_token) throw new Error('Google did not return an access token');
    const profile = await getGmailProfile(tokens.access_token);
    const email = profile.emailAddress?.trim().toLowerCase();
    if (!email) throw new Error('Google did not identify the connected Gmail account');
    if (email !== intendedEmail) {
      const tokenToRevoke = tokens.refresh_token ?? tokens.access_token;
      await revokeGoogleToken(tokenToRevoke).catch(() => undefined);
      throw new Error(`Please sign in as ${intendedEmail}; Google returned ${email}`);
    }

    const existing = store.connections.find(
      (connection): connection is StoredGmailConnection => connection.provider === 'gmail' && connection.email.toLowerCase() === email,
    );
    const refreshToken = tokens.refresh_token ??
      (existing ? decryptToken(existing.encryptedRefreshToken) : null);
    if (!refreshToken) {
      throw new Error('Google did not issue offline access. Remove Fluid from Google account access and try again.');
    }
    const now = new Date().toISOString();
    const connection: StoredGmailConnection = {
      id: `gmail:${email}`,
      provider: 'gmail',
      email,
      status: 'connected',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: now,
      lastHealthyAt: now,
      error: null,
      encryptedRefreshToken: encryptToken(refreshToken),
    };
    if (existing) Object.assign(existing, connection);
    else store.connections.push(connection);
    await saveStore();
    res.redirect(callbackRedirect(req, 'connected', `${email} passed its first health check.`));
  } catch (error) {
    res.redirect(callbackRedirect(req, 'error', publicGoogleError(error)));
  }
});

app.post('/api/connections/quo/connect', async (req, res, next) => {
  try {
    const problems = quoConfigurationProblems();
    if (problems.length > 0) {
      throw new HttpError(503, `Missing server configuration: ${problems.join(', ')}`);
    }
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey || apiKey.length > 2_048) throw new HttpError(400, 'Paste a valid Quo API key');
    const phoneNumbers = await getQuoPhoneNumbers(apiKey).catch((error: unknown) => {
      throw new HttpError(400, publicQuoError(error));
    });
    const existing = store.connections.find((item): item is StoredQuoConnection => item.provider === 'quo');
    const now = new Date().toISOString();
    const connection: StoredQuoConnection = {
      id: existing?.id ?? 'quo:workspace',
      provider: 'quo',
      phoneNumbers,
      selectedPhoneNumberIds: (existing?.selectedPhoneNumberIds ?? [])
        .filter((id) => phoneNumbers.some((number) => number.id === id)),
      status: 'connected',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: now,
      lastHealthyAt: now,
      error: null,
      encryptedApiKey: encryptToken(apiKey),
    };
    await syncQuoScope(connection, selectedQuoPhoneNumbers(connection));
    if (existing) Object.assign(existing, connection);
    else store.connections.push(connection);
    await saveStore();
    res.status(existing ? 200 : 201).json({ connection: await toPublicConnection(connection) });
  } catch (error) {
    next(error);
  }
});

app.put('/api/connections/quo/:id/scope', async (req, res, next) => {
  try {
    const connection = store.connections.find(
      (item): item is StoredQuoConnection => item.provider === 'quo' && item.id === req.params.id,
    );
    if (!connection) throw new HttpError(404, 'Quo connection not found');
    const rawIds = req.body?.phoneNumberIds;
    if (!Array.isArray(rawIds) || rawIds.length > connection.phoneNumbers.length) {
      throw new HttpError(400, 'Choose valid Quo phone lines');
    }
    const selectedIds = [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))];
    const availableIds = new Set(connection.phoneNumbers.map((number) => number.id));
    if (selectedIds.some((id) => !availableIds.has(id))) {
      throw new HttpError(400, 'One or more selected Quo phone lines are unavailable');
    }
    const selectedNumbers = connection.phoneNumbers.filter((number) => selectedIds.includes(number.id));
    await syncQuoScope(connection, selectedNumbers);
    connection.selectedPhoneNumberIds = selectedIds;
    connection.updatedAt = new Date().toISOString();
    await saveStore();
    res.json({ connection: await toPublicConnection(connection) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/internal/quo/contact-enrichment', async (req, res, next) => {
  try {
    if (!authorizedHermesAutomation(req)) throw new HttpError(401, 'Unauthorized');
    res.json({ result: await runQuoContactEnrichment() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/internal/quo/transcript-backfill', async (req, res, next) => {
  try {
    if (!authorizedHermesAutomation(req)) throw new HttpError(401, 'Unauthorized');
    res.json({ result: await runQuoTranscriptBackfill() });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/connections/quo/:id/import',
  express.text({ type: ['text/csv', 'application/csv', 'text/plain'], limit: '50mb' }),
  async (req, res, next) => {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    let connection: StoredQuoConnection | undefined;
    let kind: QuoImportKind | null = null;
    let filename = 'quo-export.csv';
    try {
      connection = store.connections.find(
        (item): item is StoredQuoConnection => item.provider === 'quo' && item.id === req.params.id,
      );
      if (!connection) throw new HttpError(404, 'Quo connection not found');
      const rawKind = typeof req.query.kind === 'string' ? req.query.kind : '';
      kind = rawKind === 'contacts' || rawKind === 'messages' || rawKind === 'calls' ? rawKind : null;
      if (!kind) throw new HttpError(400, 'Import kind must be contacts, messages, or calls');
      if (kind === 'contacts') {
        throw new HttpError(409, 'Quo contact exports are workspace-wide. Import message or call history after choosing a phone line instead.');
      }
      filename = typeof req.headers['x-fluid-filename'] === 'string'
        ? decodeURIComponent(req.headers['x-fluid-filename']).replace(/[\r\n]/g, '').slice(0, 240)
        : filename;
      if (typeof req.body !== 'string') throw new HttpError(400, 'Upload a CSV file');
      const selectedNumbers = selectedQuoPhoneNumbers(connection);
      if (selectedNumbers.length === 0) throw new HttpError(409, 'Choose at least one Quo phone line before importing history');
      const parsed = parseQuoExport(kind, req.body, selectedNumbers);
      let rowsImported = 0;
      const batches = Math.max(1, Math.ceil(Math.max(parsed.activities.length, parsed.contacts.length) / 400));
      for (let index = 0; index < batches; index += 1) {
        const activities: QuoActivityInput[] = parsed.activities.slice(index * 400, (index + 1) * 400);
        const contacts: QuoContactInput[] = parsed.contacts.slice(index * 400, (index + 1) * 400);
        const result = await quoFunctionJson<{ imported: number }>('backfill', {
          method: 'POST',
          body: JSON.stringify({
            run: {
              id: runId,
              connection_id: connection.id,
              import_kind: kind,
              filename,
              status: 'running',
              rows_seen: parsed.rowsSeen,
              rows_imported: rowsImported,
              rows_skipped: parsed.rowsSkipped,
              started_at: startedAt,
              completed_at: null,
              last_error: null,
            },
            activities,
            contacts,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        rowsImported += result.imported;
      }
      const completedAt = new Date().toISOString();
      await quoFunctionJson('backfill', {
        method: 'POST',
        body: JSON.stringify({
          run: {
            id: runId,
            connection_id: connection.id,
            import_kind: kind,
            filename,
            status: 'succeeded',
            rows_seen: parsed.rowsSeen,
            rows_imported: rowsImported,
            rows_skipped: parsed.rowsSkipped,
            started_at: startedAt,
            completed_at: completedAt,
            last_error: null,
          },
          activities: [],
          contacts: [],
        }),
      });
      res.json({
        imported: rowsImported,
        skipped: parsed.rowsSkipped,
        rowsSeen: parsed.rowsSeen,
        warnings: parsed.warnings,
        completedAt,
      });
    } catch (error) {
      if (connection && kind) {
        await quoFunctionJson('backfill', {
          method: 'POST',
          body: JSON.stringify({
            run: {
              id: runId,
              connection_id: connection.id,
              import_kind: kind,
              filename,
              status: 'failed',
              rows_seen: 0,
              rows_imported: 0,
              rows_skipped: 0,
              started_at: startedAt,
              completed_at: new Date().toISOString(),
              last_error: errorMessage(error).slice(0, 500),
            },
            activities: [],
            contacts: [],
          }),
        }).catch(() => undefined);
      }
      next(error);
    }
  },
);

app.post('/api/connections/:id/check', async (req, res, next) => {
  try {
    const connection = await checkConnection(req.params.id);
    res.json({ connection });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/connections/:id', async (req, res, next) => {
  try {
    const index = store.connections.findIndex((connection) => connection.id === req.params.id);
    if (index === -1) throw new HttpError(404, 'Connection not found');
    const connection = store.connections[index];
    if (!connection) throw new HttpError(404, 'Connection not found');
    if (connection.provider === 'gmail') {
      try {
        requireGmailConfigured();
        await revokeGoogleToken(decryptToken(connection.encryptedRefreshToken));
      } catch (error) {
        console.warn(`Gmail grant could not be revoked remotely: ${publicGoogleError(error)}`);
      }
    } else {
      await syncQuoScope(connection, []).catch((error) => {
        console.warn(`Quo capture scope could not be cleared remotely: ${publicQuoError(error)}`);
      });
    }
    store.connections.splice(index, 1);
    await saveStore();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get('/api/activities', async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(50, readPositiveInt(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      30,
    )));
    const cursorAt = typeof req.query.cursorAt === 'string' ? req.query.cursorAt : undefined;
    const cursorId = typeof req.query.cursorId === 'string' ? req.query.cursorId : undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined)) {
      throw new HttpError(400, 'Activity cursor is incomplete');
    }
    if (cursorAt !== undefined && (!Number.isFinite(Date.parse(cursorAt)) || !/^\d+$/.test(cursorId ?? ''))) {
      throw new HttpError(400, 'Activity cursor is invalid');
    }
    const payload = await activityFunctionJson<unknown>('list', {
      accountEmail: intendedEmail,
      limit: String(limit),
      ...(cursorAt !== undefined && cursorId !== undefined ? { cursorAt, cursorId } : {}),
    });
    res.json({
      ...(payload && typeof payload === 'object' ? payload : {}),
      automaticSyncIntervalMs: gmailActivitySyncIntervalMs,
    });
  } catch (error) {
    next(error);
  }
});

async function contactsPayload(req: Request): Promise<unknown> {
  const limit = Math.max(1, Math.min(100, readPositiveInt(
    typeof req.query.limit === 'string' ? req.query.limit : undefined,
    30,
  )));
  const role = typeof req.query.role === 'string' ? req.query.role.trim().toLowerCase() : '';
  if (role && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) {
    throw new HttpError(400, 'Invalid Contact role');
  }
  const status = req.query.status === 'archived' ? 'archived' : 'active';
  const cursorAt = typeof req.query.cursorAt === 'string' ? req.query.cursorAt : undefined;
  const cursorId = typeof req.query.cursorId === 'string' ? req.query.cursorId : undefined;
  if ((cursorAt === undefined) !== (cursorId === undefined)) {
    throw new HttpError(400, 'Contact cursor is incomplete');
  }
  if (cursorAt !== undefined && (!Number.isFinite(Date.parse(cursorAt)) || !isUuid(cursorId))) {
    throw new HttpError(400, 'Contact cursor is invalid');
  }
  return activityFunctionJson<unknown>('contacts', {
    limit: String(limit),
    status,
    ...(role ? { role } : {}),
    ...(cursorAt !== undefined && cursorId !== undefined ? { cursorAt, cursorId } : {}),
  });
}

app.get('/api/contacts', async (req, res, next) => {
  try {
    res.json(await contactsPayload(req));
  } catch (error) {
    next(error);
  }
});

// Compatibility alias while every existing client migrates from People to Contacts.
app.get('/api/people', async (req, res, next) => {
  try {
    const payload = await contactsPayload(req);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      res.json({ ...record, people: record.contacts });
      return;
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/contacts/roles', async (_req, res, next) => {
  try {
    res.json(await activityFunctionJson<unknown>('contact-roles', {}));
  } catch (error) {
    next(error);
  }
});

app.get('/api/contacts/search', async (req, res, next) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    res.json(await activityFunctionJson<unknown>('contact-search', { q: query }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/contacts/:id/activities', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(400, 'Invalid Contact id');
    const limit = Math.max(1, Math.min(50, readPositiveInt(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      30,
    )));
    const cursorAt = typeof req.query.cursorAt === 'string' ? req.query.cursorAt : undefined;
    const cursorId = typeof req.query.cursorId === 'string' ? req.query.cursorId : undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined)) {
      throw new HttpError(400, 'Contact Activity cursor is incomplete');
    }
    if (cursorAt !== undefined && (!Number.isFinite(Date.parse(cursorAt)) || !/^\d+$/.test(cursorId ?? ''))) {
      throw new HttpError(400, 'Contact Activity cursor is invalid');
    }
    res.json(await activityFunctionJson<unknown>('contact-activities', {
      contactId: req.params.id,
      limit: String(limit),
      ...(cursorAt !== undefined && cursorId !== undefined ? { cursorAt, cursorId } : {}),
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/contacts/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(400, 'Invalid Contact id');
    res.json(await activityFunctionJson<unknown>('contact', { contactId: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/contact-suggestions', async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, readPositiveInt(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      30,
    )));
    const cursorAt = typeof req.query.cursorAt === 'string' ? req.query.cursorAt : undefined;
    const cursorId = typeof req.query.cursorId === 'string' ? req.query.cursorId : undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined)) {
      throw new HttpError(400, 'Suggestion cursor is incomplete');
    }
    if (cursorAt !== undefined && (!Number.isFinite(Date.parse(cursorAt)) || !isUuid(cursorId))) {
      throw new HttpError(400, 'Suggestion cursor is invalid');
    }
    res.json(await activityFunctionJson<unknown>('contact-suggestions', {
      limit: String(limit),
      ...(cursorAt !== undefined && cursorId !== undefined ? { cursorAt, cursorId } : {}),
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/contact-suggestions/:id/resolve', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(400, 'Invalid suggestion id');
    const action = req.body?.action;
    const contactId = req.body?.contactId;
    if (!['create', 'link', 'ignore'].includes(action) ||
      (action === 'link' && !isUuid(contactId)) ||
      (action !== 'link' && contactId !== undefined)) {
      throw new HttpError(400, 'Invalid suggestion resolution');
    }
    res.json(await activityFunctionJson<unknown>('resolve-contact-suggestion', {}, {
      method: 'POST',
      body: JSON.stringify({
        suggestionId: req.params.id,
        action,
        ...(action === 'link' ? { contactId } : {}),
      }),
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/people/sync-status', async (_req, res, next) => {
  try {
    res.json(await customerFunctionJson<unknown>('status'));
  } catch (error) {
    next(error);
  }
});

app.get('/api/activities/signals/:signalId', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.signalId)) {
      throw new HttpError(400, 'Invalid signal id');
    }
    const payload = await activityFunctionJson<unknown>('signal', {
      accountEmail: intendedEmail,
      signalId: req.params.signalId,
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/activities/signals/:signalId/history', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.signalId)) {
      throw new HttpError(400, 'Invalid signal id');
    }
    const limit = Math.max(1, Math.min(20, readPositiveInt(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      5,
    )));
    const cursorAt = typeof req.query.cursorAt === 'string' ? req.query.cursorAt : undefined;
    const cursorId = typeof req.query.cursorId === 'string' ? req.query.cursorId : undefined;
    if ((cursorAt === undefined) !== (cursorId === undefined)) {
      throw new HttpError(400, 'History cursor is incomplete');
    }
    if (cursorAt !== undefined && (!Number.isFinite(Date.parse(cursorAt)) || !/^\d+$/.test(cursorId ?? ''))) {
      throw new HttpError(400, 'History cursor is invalid');
    }
    const payload = await activityFunctionJson<unknown>('history', {
      accountEmail: intendedEmail,
      signalId: req.params.signalId,
      limit: String(limit),
      ...(cursorAt !== undefined && cursorId !== undefined ? { cursorAt, cursorId } : {}),
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/activities/sync', async (_req, res, next) => {
  try {
    const connection = store.connections.find(
      (item): item is StoredGmailConnection => item.provider === 'gmail' && item.email.toLowerCase() === intendedEmail,
    );
    if (!connection) throw new HttpError(409, `Connect ${intendedEmail} before syncing Gmail activity.`);
    const result = await syncActivities(connection);
    res.json({ sync: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/labels', async (_req, res, next) => {
  try {
    const payload = await activityFunctionJson<unknown>('labels', { accountEmail: intendedEmail });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/labels', async (req, res, next) => {
  try {
    const payload = await activityFunctionJson<unknown>('label', { accountEmail: intendedEmail }, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(201).json(payload);
  } catch (error) {
    next(error);
  }
});

app.put('/api/labels/:labelId', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.labelId)) throw new HttpError(400, 'Invalid label id');
    const payload = await activityFunctionJson<unknown>('label', { accountEmail: intendedEmail }, {
      method: 'POST',
      body: JSON.stringify({ ...req.body, id: req.params.labelId }),
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/hermes/status', async (_req, res, next) => {
  try {
    const response = await fetch(`${hermesBaseUrl}/api/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new HttpError(502, `Hermes status check returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object') {
      throw new HttpError(502, 'Hermes returned an invalid status response');
    }
    const status = payload as Record<string, unknown>;
    const profiles = Array.isArray(status.profiles)
      ? status.profiles.filter((profile): profile is string => typeof profile === 'string')
      : [];
    res.json({
      connected: status.overall === 'ok' && status.gateway_running === true,
      version: typeof status.version === 'string' ? status.version : null,
      gatewayState: typeof status.gateway_state === 'string' ? status.gateway_state : 'unknown',
      activeAgents: typeof status.active_agents === 'number' ? status.active_agents : 0,
      profiles,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, `Could not reach Hermes: ${errorMessage(error)}`));
  }
});

app.get('/api/hermes/agents', async (_req, res, next) => {
  try {
    res.json(await hermesMetadataJson('agents'));
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, `Could not read Hermes agents: ${errorMessage(error)}`));
  }
});

app.get('/api/hermes/schedules', async (_req, res, next) => {
  try {
    res.json(await hermesMetadataJson('agents'));
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, `Could not read Hermes schedules: ${errorMessage(error)}`));
  }
});

app.get('/api/hermes/skills', async (_req, res, next) => {
  try {
    res.json(await hermesMetadataJson('skills'));
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, `Could not read Hermes skills: ${errorMessage(error)}`));
  }
});

app.get('/api/hermes/agents/:agentId/runs', async (req, res, next) => {
  try {
    const agentId = req.params.agentId;
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    if (jobId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
      throw new HttpError(400, 'Invalid Hermes job id');
    }
    if (jobId === undefined && !hermesAgentIds.has(agentId)) {
      throw new HttpError(404, 'Hermes agent not found');
    }
    const limit = Math.max(1, Math.min(50, readPositiveInt(
      typeof req.query.limit === 'string' ? req.query.limit : undefined,
      20,
    )));
    if ((agentId === 'email-categorizer' || agentId === 'signal-triage') && jobId === undefined) {
      const payload = await activityFunctionJson<unknown>('agent-history', {
        accountEmail: intendedEmail,
        agentKey: agentId,
        limit: String(limit),
      });
      res.json(payload);
      return;
    }
    const url = new URL(`${hermesBaseUrl}/api/plugins/fluid-history/runs`);
    if (jobId !== undefined) url.searchParams.set('job', jobId);
    else url.searchParams.set('agent', agentId);
    url.searchParams.set('limit', String(limit));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${hermesHistoryToken()}`,
      },
      signal: AbortSignal.timeout(8_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(502, 'Hermes rejected Fluid history authentication.');
      }
      if (response.status === 404) {
        throw new HttpError(502, 'The Fluid history bridge is not available in Hermes.');
      }
      throw new HttpError(502, `Hermes history returned HTTP ${response.status}`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HttpError(502, 'Hermes returned an invalid history response');
    }
    res.json(payload);
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(502, `Could not read Hermes history: ${errorMessage(error)}`));
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'fluid-connections' });
});

const currentDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(currentDir, '../dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(resolve(distDir, 'index.html'));
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Unexpected server error';
  if (status >= 500 && !(error instanceof HttpError)) console.error(error);
  res.status(status).json({ error: message });
});

await loadStore();

const startupCheck = setTimeout(() => {
  void checkAllConnections();
}, 5_000);
startupCheck.unref();

const startupActivitySync = setTimeout(() => {
  void syncDueActivities();
}, 10_000);
startupActivitySync.unref();

const healthTimer = setInterval(
  () => {
    void checkDueConnections();
  },
  Math.min(healthCheckIntervalMs, 30_000),
);
healthTimer.unref();

const activitySyncTimer = setInterval(
  () => {
    void syncDueActivities();
  },
  Math.min(gmailActivitySyncIntervalMs, 30_000),
);
activitySyncTimer.unref();

const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [state, pending] of pendingAuthorizations) {
    if (pending.expiresAt < now) pendingAuthorizations.delete(state);
  }
}, 60_000);
pendingCleanupTimer.unref();

app.listen(port, () => {
  console.log(`Fluid connections API listening on http://localhost:${port}`);
  if (gmailConfigurationProblems().length > 0) {
    console.log('Gmail connection is disabled until the values in .env.example are configured.');
  }
  if (quoConfigurationProblems().length > 0) {
    console.log('Quo connection is disabled until token encryption is configured.');
  }
});
