import 'dotenv/config';
import { createHash } from 'node:crypto';
import { EMAIL_CONTENT_PARSER_VERSION, parseEmailContent } from '../server/emailContent.js';

interface ContentSourceRow {
  id: number;
  body_text: string | null;
  raw_body_text: string | null;
  content_parser_version: string | null;
}

interface SourcePage {
  rows: ContentSourceRow[];
  nextCursor: number | null;
}

const projectUrl = process.env.SUPABASE_PROJECT_URL?.trim().replace(/\/$/, '');
const encryptionRoot = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
if (!projectUrl || !encryptionRoot || encryptionRoot.length < 32) {
  throw new Error('SUPABASE_PROJECT_URL and CONNECTION_TOKEN_ENCRYPTION_KEY are required');
}

const activitySecret = createHash('sha256')
  .update('fluid-activity-sync:v1\0')
  .update(encryptionRoot, 'utf8')
  .digest('hex');
const endpoint = `${projectUrl}/functions/v1/fluid-gmail-activities`;

async function request<T>(action: string, search: Record<string, string>, init?: RequestInit): Promise<T> {
  const url = new URL(endpoint);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'x-fluid-activity-secret': activitySecret,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(`Email content backfill failed: ${detail}`);
  }
  return payload as T;
}

let cursor: number | null = null;
let scanned = 0;
let updated = 0;

do {
  const page = await request<SourcePage>('email-content-source', {
    limit: '100',
    ...(cursor === null ? {} : { cursorId: String(cursor) }),
  });
  scanned += page.rows.length;
  const parsedAt = new Date().toISOString();
  const patches = page.rows.flatMap((row) => {
    if (row.content_parser_version === EMAIL_CONTENT_PARSER_VERSION) return [];
    const rawBody = row.raw_body_text ?? row.body_text ?? '';
    const parsed = parseEmailContent(rawBody);
    return [{
      id: row.id,
      currentMessageText: parsed.currentMessageText,
      rawBodyText: rawBody,
      quotedText: parsed.quotedText,
      signatureText: parsed.signatureText,
      hasQuotedContent: parsed.hasQuotedContent,
      parserVersion: parsed.parserVersion,
      parseMethod: parsed.parseMethod,
      parseConfidence: parsed.parseConfidence,
      parsedAt,
    }];
  });
  if (patches.length > 0) {
    const result = await request<{ updated: number }>('email-content-patches', {}, {
      method: 'POST',
      body: JSON.stringify({ patches }),
    });
    updated += result.updated;
  }
  cursor = page.nextCursor;
  process.stdout.write(`\rScanned ${scanned} Gmail signals · updated ${updated}`);
} while (cursor !== null);

process.stdout.write(`\nEmail content backfill complete (${EMAIL_CONTENT_PARSER_VERSION}).\n`);
