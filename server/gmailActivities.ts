import { parseEmailContent } from './emailContent.js';
import { fetchWithTimeoutAndRetry } from './httpClient.js';

export interface GmailActivityRow {
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
}

export interface GmailBackfillResult {
  activities: GmailActivityRow[];
  messagesSeen: number;
  truncated: boolean;
}

export interface GmailIncrementalResult extends GmailBackfillResult {
  historyId: string;
}

interface GmailMessageListResponse {
  messages?: { id?: string; threadId?: string }[];
  nextPageToken?: string;
}

interface GmailHistoryListResponse {
  history?: {
    id?: string;
    messagesAdded?: { message?: { id?: string; threadId?: string } }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    attachmentId?: string;
    data?: string;
    size?: number;
  };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

interface ParsedAddress {
  name: string | null;
  email: string;
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function gmailJson<T>(url: URL, accessToken: string): Promise<T> {
  const response = await fetchWithTimeoutAndRetry(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
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
    let detail = `Gmail API returned ${response.status}`;
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const nested = (payload as { error?: unknown }).error;
      if (nested && typeof nested === 'object' && 'message' in nested) {
        const message = (nested as { message?: unknown }).message;
        if (typeof message === 'string') detail = message;
      }
    }
    throw new GmailApiError(response.status, detail);
  }
  return payload as T;
}

function headerMap(headers: GmailHeader[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const header of headers ?? []) {
    if (header.name && header.value) result.set(header.name.toLowerCase(), header.value);
  }
  return result;
}

function cleanName(value: string): string | null {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function parseAddresses(raw: string | undefined): ParsedAddress[] {
  if (!raw) return [];
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .flatMap((piece) => {
      const emails = piece.match(emailPattern) ?? [];
      return emails.map((email) => {
        const bracketAt = piece.indexOf('<');
        const rawName = bracketAt >= 0 ? piece.slice(0, bracketAt) : '';
        return { name: cleanName(rawName), email: email.toLowerCase() };
      });
    });
}

function decodeBase64Url(data: string | undefined): string {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

function normalizeBody(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, 20_000);
}

function findBody(part: GmailPart | undefined, mimeType: 'text/plain' | 'text/html'): string {
  if (!part) return '';
  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType);
    if (found) return found;
  }
  return '';
}

function attachmentCount(part: GmailPart | undefined): number {
  if (!part) return 0;
  const isAttachment = Boolean(part.filename?.trim() || part.body?.attachmentId);
  return (isAttachment ? 1 : 0) + (part.parts ?? []).reduce((sum, child) => sum + attachmentCount(child), 0);
}

function messageDate(message: GmailMessage, headers: Map<string, string>): string {
  const internal = Number.parseInt(message.internalDate ?? '', 10);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const headerDate = Date.parse(headers.get('date') ?? '');
  return new Date(Number.isFinite(headerDate) ? headerDate : Date.now()).toISOString();
}

function isAutomatedMessage(labels: string[], headers: Map<string, string>, fromEmail: string | null): boolean {
  const localPart = fromEmail?.split('@')[0] ?? '';
  const autoSubmitted = headers.get('auto-submitted')?.toLowerCase();
  const precedence = headers.get('precedence')?.toLowerCase();
  return (
    labels.some((label) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES'].includes(label)) ||
    /^(no-?reply|do-?not-?reply|notify|notifications?|mailer-daemon|postmaster)/i.test(localPart) ||
    Boolean(autoSubmitted && autoSubmitted !== 'no') ||
    ['bulk', 'list', 'junk'].includes(precedence ?? '') ||
    headers.has('list-id') ||
    headers.has('list-unsubscribe') ||
    headers.has('feedback-id')
  );
}

function toActivity(message: GmailMessage, accountEmail: string, syncedAt: string): GmailActivityRow {
  if (!message.id) throw new Error('Gmail returned a message without an id');
  const labels = message.labelIds ?? [];
  const headers = headerMap(message.payload?.headers);
  const from = parseAddresses(headers.get('from'));
  const to = parseAddresses(headers.get('to'));
  const cc = parseAddresses(headers.get('cc'));
  const outbound = labels.includes('SENT');
  const actor = outbound
    ? [...to, ...cc].find((address) => address.email !== accountEmail) ?? to[0] ?? null
    : from.find((address) => address.email !== accountEmail) ?? from[0] ?? null;
  const plain = findBody(message.payload, 'text/plain');
  const html = plain ? '' : findBody(message.payload, 'text/html');
  const body = normalizeBody(plain || htmlToText(html));
  const parsedContent = parseEmailContent(body);
  const attachments = attachmentCount(message.payload);
  const subject = (headers.get('subject') ?? '(no subject)').replace(/\s+/g, ' ').trim() || '(no subject)';
  const preview = normalizeBody(decodeHtmlEntities(message.snippet ?? body)).replace(/\s+/g, ' ').slice(0, 260);
  const fromEmail = from[0]?.email ?? null;
  const automated = isAutomatedMessage(labels, headers, fromEmail);

  return {
    source: 'gmail',
    account_email: accountEmail,
    external_id: message.id,
    external_thread_id: message.threadId ?? null,
    event_type: outbound ? 'email.sent' : 'email.received',
    direction: outbound ? 'outbound' : 'inbound',
    actor_name: actor?.name ?? null,
    actor_email: actor?.email ?? null,
    from_email: fromEmail,
    to_emails: to.map((address) => address.email),
    cc_emails: cc.map((address) => address.email),
    subject,
    preview,
    // body_text is the canonical current message used by Fluid and Hermes.
    // raw_body_text preserves Gmail's flattened body for audit/reprocessing.
    body_text: parsedContent.currentMessageText || null,
    raw_body_text: body || null,
    quoted_text: parsedContent.quotedText,
    signature_text: parsedContent.signatureText,
    has_quoted_content: parsedContent.hasQuotedContent,
    content_parser_version: parsedContent.parserVersion,
    content_parse_method: parsedContent.parseMethod,
    content_parse_confidence: parsedContent.parseConfidence,
    content_parsed_at: syncedAt,
    occurred_at: messageDate(message, headers),
    has_attachments: attachments > 0,
    attachment_count: attachments,
    source_labels: labels.filter((label) => label !== 'UNREAD'),
    source_metadata: {
      rfc_message_id: headers.get('message-id') ?? null,
      size_estimate: message.sizeEstimate ?? null,
      automated,
    },
    updated_at: syncedAt,
  };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      result[index] = await task(item);
    }
  });
  await Promise.all(workers);
  return result;
}

async function fetchMessages(accessToken: string, ids: string[]): Promise<GmailMessage[]> {
  const messages = await mapConcurrent(ids, 6, async (id) => {
    const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set('format', 'full');
    try {
      return await gmailJson<GmailMessage>(url, accessToken);
    } catch (error) {
      // A message can be deleted between history.list and messages.get. It should
      // not make the rest of a mailbox sync fail.
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
  });
  return messages.filter((message): message is GmailMessage => message !== null);
}

function activitiesFromMessages(
  messages: GmailMessage[],
  accountEmail: string,
): GmailActivityRow[] {
  const syncedAt = new Date().toISOString();
  const activities = messages
    .filter((message) => {
      const labels = message.labelIds ?? [];
      return !labels.some((label) => ['SPAM', 'TRASH', 'DRAFT'].includes(label));
    })
    .map((message) => toActivity(message, accountEmail, syncedAt))
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));

  return activities;
}

export async function fetchGmailActivityBackfill(
  accessToken: string,
  rawAccountEmail: string,
  lookbackDays = 30,
  maximumMessages = 500,
): Promise<GmailBackfillResult> {
  const accountEmail = rawAccountEmail.trim().toLowerCase();
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set('maxResults', String(Math.min(500, maximumMessages - ids.length)));
    url.searchParams.set('q', `newer_than:${lookbackDays}d -in:spam -in:trash -in:drafts`);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await gmailJson<GmailMessageListResponse>(url, accessToken);
    for (const message of page.messages ?? []) {
      if (message.id && !seen.has(message.id)) {
        seen.add(message.id);
        ids.push(message.id);
      }
      if (ids.length >= maximumMessages) break;
    }
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < maximumMessages);

  const messages = await fetchMessages(accessToken, ids);
  const activities = activitiesFromMessages(messages, accountEmail);

  return {
    activities,
    messagesSeen: ids.length,
    truncated: Boolean(pageToken),
  };
}

export async function fetchGmailActivityChanges(
  accessToken: string,
  rawAccountEmail: string,
  startHistoryId: string,
  maximumMessages = 2_000,
): Promise<GmailIncrementalResult> {
  const accountEmail = rawAccountEmail.trim().toLowerCase();
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let currentHistoryId = startHistoryId;
  let lastProcessedHistoryId = startHistoryId;
  let truncated = false;

  do {
    const url = new URL(`${GMAIL_API}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await gmailJson<GmailHistoryListResponse>(url, accessToken);
    currentHistoryId = page.historyId ?? currentHistoryId;
    const records = page.history ?? [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      for (const added of record.messagesAdded ?? []) {
        const id = added.message?.id;
        if (id) ids.add(id);
      }
      lastProcessedHistoryId = record.id ?? lastProcessedHistoryId;
      if (ids.size >= maximumMessages) {
        truncated = index < records.length - 1 || Boolean(page.nextPageToken);
        break;
      }
    }

    if (truncated) break;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const messageIds = [...ids];
  const messages = await fetchMessages(accessToken, messageIds);
  return {
    activities: activitiesFromMessages(messages, accountEmail),
    messagesSeen: messageIds.length,
    truncated,
    // Only advance through records that were actually processed. This prevents
    // skipping mail if an unusually large history window is split over runs.
    historyId: truncated ? lastProcessedHistoryId : currentHistoryId,
  };
}
