import 'dotenv/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { NextFunction, Request, Response } from 'express';

type ConnectionStatus = 'connected' | 'error' | 'checking';

interface StoredConnection {
  id: string;
  provider: 'gmail';
  email: string;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  error: string | null;
  encryptedRefreshToken: string;
}

interface ConnectionStore {
  version: 1;
  connections: StoredConnection[];
}

interface PublicConnection extends Omit<StoredConnection, 'encryptedRefreshToken'> {
  nextCheckAt: string | null;
}

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
const storePath = resolve(process.env.CONNECTION_STORE_PATH ?? '.data/connections.json');
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const activeHealthChecks = new Map<string, Promise<PublicConnection>>();
let store: ConnectionStore = { version: 1, connections: [] };
let writeChain: Promise<void> = Promise.resolve();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configurationProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) problems.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) problems.push('GOOGLE_CLIENT_SECRET');
  if ((process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim().length ?? 0) < 32) {
    problems.push('CONNECTION_TOKEN_ENCRYPTION_KEY (at least 32 characters)');
  }
  return problems;
}

function requireConfigured(): void {
  const problems = configurationProblems();
  if (problems.length > 0) {
    throw new HttpError(503, `Missing server configuration: ${problems.join(', ')}`);
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('CONNECTION_TOKEN_ENCRYPTION_KEY is not configured');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
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
  if (parts.length !== 3) throw new Error('Stored Gmail credential is malformed');
  const [ivPart, tagPart, ciphertextPart] = parts;
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Stored Gmail credential is malformed');
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

function toPublicConnection(connection: StoredConnection): PublicConnection {
  const problems = configurationProblems();
  const lastChecked = connection.lastCheckedAt ? Date.parse(connection.lastCheckedAt) : Number.NaN;
  const nextAt = Number.isFinite(lastChecked) ? lastChecked + healthCheckIntervalMs : Date.now();
  return {
    id: connection.id,
    provider: connection.provider,
    email: connection.email,
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
  requireConfigured();
  const connection = store.connections.find((item) => item.id === connectionId);
  if (!connection) throw new HttpError(404, 'Connection not found');

  connection.status = 'checking';
  connection.updatedAt = new Date().toISOString();
  await saveStore();

  try {
    const refreshToken = decryptToken(connection.encryptedRefreshToken);
    const accessToken = await refreshAccessToken(refreshToken);
    const profile = await getGmailProfile(accessToken);
    const actualEmail = profile.emailAddress?.trim().toLowerCase();
    if (actualEmail !== connection.email.toLowerCase()) {
      throw new Error(`Google returned a different mailbox (${actualEmail ?? 'unknown'})`);
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
    connection.error = publicGoogleError(error);
  }
  await saveStore();
  return toPublicConnection(connection);
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

async function checkAllConnections(): Promise<void> {
  if (configurationProblems().length > 0) return;
  await Promise.allSettled(store.connections.map((connection) => checkConnection(connection.id)));
}

async function checkDueConnections(): Promise<void> {
  if (configurationProblems().length > 0) return;
  const now = Date.now();
  const due = store.connections.filter((connection) => {
    if (!connection.lastCheckedAt) return true;
    const lastCheckedAt = Date.parse(connection.lastCheckedAt);
    return !Number.isFinite(lastCheckedAt) || now - lastCheckedAt >= healthCheckIntervalMs;
  });
  await Promise.allSettled(due.map((connection) => checkConnection(connection.id)));
}

app.get('/api/connections', (_req, res) => {
  const problems = configurationProblems();
  res.json({
    connections: store.connections.map(toPublicConnection),
    healthCheckIntervalMs,
    configured: problems.length === 0,
    ...(problems.length > 0
      ? { configurationError: `Add ${problems.join(', ')} to the server environment.` }
      : {}),
  });
});

app.post('/api/connections/gmail/authorize', (req, res, next) => {
  try {
    requireConfigured();
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
    requireConfigured();
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
      (connection) => connection.provider === 'gmail' && connection.email.toLowerCase() === email,
    );
    const refreshToken = tokens.refresh_token ??
      (existing ? decryptToken(existing.encryptedRefreshToken) : null);
    if (!refreshToken) {
      throw new Error('Google did not issue offline access. Remove Fluid from Google account access and try again.');
    }
    const now = new Date().toISOString();
    const connection: StoredConnection = {
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
    try {
      requireConfigured();
      await revokeGoogleToken(decryptToken(connection.encryptedRefreshToken));
    } catch (error) {
      console.warn(`Gmail grant could not be revoked remotely: ${publicGoogleError(error)}`);
    }
    store.connections.splice(index, 1);
    await saveStore();
    res.status(204).end();
  } catch (error) {
    next(error);
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

const healthTimer = setInterval(
  () => {
    void checkDueConnections();
  },
  Math.min(healthCheckIntervalMs, 30_000),
);
healthTimer.unref();

const pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [state, pending] of pendingAuthorizations) {
    if (pending.expiresAt < now) pendingAuthorizations.delete(state);
  }
}, 60_000);
pendingCleanupTimer.unref();

app.listen(port, () => {
  console.log(`Fluid connections API listening on http://localhost:${port}`);
  if (configurationProblems().length > 0) {
    console.log('Gmail connection is disabled until the values in .env.example are configured.');
  }
});
