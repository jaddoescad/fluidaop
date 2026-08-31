import 'dotenv/config';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Request } from 'playwright';

const CHAT_URL = 'https://app.dripjobs.com/chat';
const STREAM_ORIGIN = 'https://chat.stream-io-api.com';
const CHANNEL_PAGE_SIZE = 30;
const MESSAGE_PAGE_SIZE = 300;
const IMPORT_BATCH_SIZE = 50;
const PROFILE_DIR = resolve('.data/dripjobs-chat-profile');

type StreamSession = {
  apiKey: string;
  userId: string;
  connectionId: string | null;
  authorization: string;
  authType: string;
  clientHeader: string;
};

type StreamUser = { id?: string; name?: string; email?: string; phone?: string };
type StreamMember = { user_id?: string; user?: StreamUser };
type StreamMessage = {
  id?: string;
  text?: string;
  type?: string;
  created_at?: string;
  user?: StreamUser;
  attachments?: Array<{ type?: string }>;
};
type StreamChannelState = {
  channel?: { id?: string; type?: string; last_message_at?: string };
  members?: StreamMember[];
  messages?: StreamMessage[];
};
type ChannelResponse = { channels?: StreamChannelState[] };
type ChannelQueryResponse = { messages?: StreamMessage[] };

type ImportMessage = {
  externalId: string;
  occurredAt: string;
  direction: 'inbound' | 'outbound';
  actorName: string | null;
  text: string;
  attachmentCount: number;
  attachmentTypes: string[];
  automated: boolean;
};

type CustomerIdentity = {
  name: string;
  email: string | null;
  phone: string | null;
};

type Args = {
  apply: boolean;
  headless: boolean;
  maxChannels: number | null;
  since: string | null;
};

function args(): Args {
  const values = process.argv.slice(2);
  if (values.includes('--help')) {
    console.log([
      'Usage: npm run sync:dripjobs-chat -- [--apply] [--headless] [--max-channels N] [--since YYYY-MM-DD]',
      '',
      'Default is a dry run. --apply sends the collected chats to Fluid.',
      'The first run opens Chrome so you can sign in to DripJobs; the isolated profile is reused.',
    ].join('\n'));
    process.exit(0);
  }
  const maxIndex = values.indexOf('--max-channels');
  const sinceIndex = values.indexOf('--since');
  const maxChannels = maxIndex >= 0 ? Number.parseInt(values[maxIndex + 1] ?? '', 10) : null;
  const since = sinceIndex >= 0 ? values[sinceIndex + 1] ?? null : null;
  if (maxChannels !== null && (!Number.isSafeInteger(maxChannels) || maxChannels < 1)) {
    throw new Error('--max-channels must be a positive integer');
  }
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  return { apply: values.includes('--apply'), headless: values.includes('--headless'), maxChannels, since };
}

function activitySecret(): string {
  const root = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!root || root.length < 32) {
    throw new Error('CONNECTION_TOKEN_ENCRYPTION_KEY must be configured before --apply');
  }
  return createHash('sha256').update('fluid-activity-sync:v2\0').update(root, 'utf8').digest('hex');
}

async function requestSession(request: Request): Promise<StreamSession | null> {
  const url = new URL(request.url());
  if (url.origin !== STREAM_ORIGIN || url.pathname !== '/channels' || request.method() !== 'POST') return null;
  const headers = await request.allHeaders();
  const authorization = headers.authorization;
  const apiKey = url.searchParams.get('api_key');
  const userId = url.searchParams.get('user_id');
  if (!authorization || !apiKey || !userId) return null;
  return {
    apiKey,
    userId,
    connectionId: url.searchParams.get('connection_id'),
    authorization,
    authType: headers['stream-auth-type'] ?? 'jwt',
    clientHeader: headers['x-stream-client'] ?? 'fluid-dripjobs-chat-sync',
  };
}

async function waitForStreamSession(page: Page): Promise<StreamSession> {
  return await new Promise<StreamSession>((resolveSession, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      'Timed out waiting for DripJobs Chat. Sign in, open Chat, then rerun the command.',
    )), 5 * 60_000);
    const inspect = (request: Request) => {
      void requestSession(request).then((session) => {
        if (!session) return;
        clearTimeout(timeout);
        page.off('request', inspect);
        resolveSession(session);
      }).catch(reject);
    };
    page.on('request', inspect);
  });
}

function streamUrl(session: StreamSession, path: string): URL {
  const url = new URL(path, STREAM_ORIGIN);
  url.searchParams.set('user_id', session.userId);
  url.searchParams.set('api_key', session.apiKey);
  if (session.connectionId) url.searchParams.set('connection_id', session.connectionId);
  return url;
}

async function streamPost<T>(session: StreamSession, path: string, body: unknown): Promise<T> {
  const response = await fetch(streamUrl(session, path), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: session.authorization,
      'Content-Type': 'application/json',
      'Stream-Auth-Type': session.authType,
      'X-Stream-Client': session.clientHeader,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Stream Chat returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload as T;
}

async function listChannels(session: StreamSession, options: Args): Promise<StreamChannelState[]> {
  const collected = new Map<string, StreamChannelState>();
  let offset = 0;
  let through: string | null = null;
  for (;;) {
    const filter: Record<string, unknown> = {
      members: { $in: [session.userId] },
      type: 'messaging',
    };
    if (options.since) filter.last_message_at = { $gte: `${options.since}T00:00:00Z` };
    if (through) {
      filter.last_message_at = {
        ...(typeof filter.last_message_at === 'object' ? filter.last_message_at : {}),
        $lte: through,
      };
    }
    const payload = await streamPost<ChannelResponse>(session, '/channels', {
      filter_conditions: filter,
      sort: [{ field: 'last_message_at', direction: -1 }],
      state: true,
      watch: false,
      presence: false,
      limit: CHANNEL_PAGE_SIZE,
      message_limit: MESSAGE_PAGE_SIZE,
      offset,
    });
    const page = payload.channels ?? [];
    for (const channel of page) {
      const id = channel.channel?.id;
      if (id) collected.set(id, channel);
      if (options.maxChannels !== null && collected.size >= options.maxChannels) {
        return [...collected.values()].slice(0, options.maxChannels);
      }
    }
    process.stdout.write(`\rCollected ${collected.size.toLocaleString()} channels…`);
    if (page.length < CHANNEL_PAGE_SIZE) break;
    offset += CHANNEL_PAGE_SIZE;
    // Stream caps offset pagination at 1,000. Continue older cohorts by time.
    if (offset >= 990) {
      const oldest = page.at(-1)?.channel?.last_message_at;
      if (!oldest) break;
      through = through === oldest
        ? new Date(Date.parse(oldest) - 1).toISOString()
        : oldest;
      offset = 0;
    }
  }
  process.stdout.write('\n');
  return [...collected.values()];
}

async function allMessages(session: StreamSession, state: StreamChannelState): Promise<StreamMessage[]> {
  const id = state.channel?.id;
  if (!id) return [];
  const messages = new Map<string, StreamMessage>();
  let page = state.messages ?? [];
  for (const message of page) if (message.id) messages.set(message.id, message);
  while (page.length === MESSAGE_PAGE_SIZE) {
    const oldestId = page[0]?.id;
    if (!oldestId) break;
    const payload = await streamPost<ChannelQueryResponse>(
      session,
      `/channels/messaging/${encodeURIComponent(id)}/query`,
      { data: {}, state: true, watch: false, messages: { id_lt: oldestId, limit: MESSAGE_PAGE_SIZE } },
    );
    page = payload.messages ?? [];
    let added = 0;
    for (const message of page) {
      if (message.id && !messages.has(message.id)) added += 1;
      if (message.id) messages.set(message.id, message);
    }
    if (added === 0) break;
  }
  return [...messages.values()].sort((left, right) =>
    Date.parse(left.created_at ?? '') - Date.parse(right.created_at ?? ''));
}

function importMessages(messages: StreamMessage[], supportUserId: string): ImportMessage[] {
  return messages.flatMap((message): ImportMessage[] => {
    const externalId = message.id?.trim();
    const occurredAt = message.created_at?.trim();
    const userId = message.user?.id?.trim();
    const attachments = message.attachments ?? [];
    const text = message.text?.trim() || (attachments.length > 0 ? '[Attachment]' : '');
    if (!externalId || !occurredAt || !userId || !text || message.type === 'deleted') return [];
    return [{
      externalId,
      occurredAt,
      direction: userId === supportUserId ? 'outbound' : 'inbound',
      actorName: message.user?.name?.trim() || null,
      text,
      attachmentCount: attachments.length,
      attachmentTypes: attachments.map((attachment) => attachment.type?.trim()).filter((value): value is string => Boolean(value)),
      automated: userId === supportUserId && /reply stop to unsubscribe|we've scheduled your|friendly reminder/i.test(text),
    }];
  });
}

function contactId(state: StreamChannelState, supportUserId: string): string | null {
  const ids = [...new Set((state.members ?? [])
    .map((member) => member.user_id ?? member.user?.id)
    .filter((id): id is string => Boolean(id) && id !== supportUserId))];
  return ids.length === 1 ? ids[0] : null;
}

function customerIdentity(state: StreamChannelState, supportUserId: string): CustomerIdentity | null {
  const providerContactId = contactId(state, supportUserId);
  if (!providerContactId) return null;
  const member = (state.members ?? []).find((item) =>
    (item.user_id ?? item.user?.id) === providerContactId);
  const name = member?.user?.name?.trim();
  if (!name) return null;
  return {
    name,
    email: member?.user?.email?.trim() || null,
    phone: member?.user?.phone?.trim() || null,
  };
}

async function importChannel(
  projectUrl: string,
  secret: string,
  supportUserId: string,
  state: StreamChannelState,
  messages: ImportMessage[],
): Promise<void> {
  const channelId = state.channel?.id;
  const providerContactId = contactId(state, supportUserId);
  const customer = customerIdentity(state, supportUserId);
  if (!channelId || !providerContactId || !customer) {
    throw new Error('Channel does not contain one named customer Contact');
  }
  const url = new URL(`${projectUrl}/functions/v1/fluid-real-board`);
  url.searchParams.set('action', 'ingest-dripjobs-chat');
  for (let offset = 0; offset < messages.length; offset += IMPORT_BATCH_SIZE) {
    const batch = messages.slice(offset, offset + IMPORT_BATCH_SIZE);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-fluid-activity-secret': secret,
      },
      body: JSON.stringify({ contactId: providerContactId, channelId, supportUserId, customer, messages: batch }),
      signal: AbortSignal.timeout(90_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Fluid returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
    }
  }
}

async function runPool<T>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await work(items[index], index);
    }
  }));
}

async function main(): Promise<void> {
  const options = args();
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: options.headless,
      viewport: { width: 1440, height: 900 },
    });
    const page = context.pages()[0] ?? await context.newPage();
    const sessionPromise = waitForStreamSession(page);
    console.log('Opening DripJobs Chat. Sign in in the Chrome window if asked.');
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const session = await sessionPromise;
    console.log('Connected to the DripJobs chat feed. The temporary chat token will not be printed or saved.');

    const channels = await listChannels(session, options);
    const prepared: Array<{ state: StreamChannelState; messages: ImportMessage[] }> = [];
    let messageCount = 0;
    for (let index = 0; index < channels.length; index += 1) {
      const state = channels[index];
      const messages = importMessages(await allMessages(session, state), session.userId);
      if (messages.length > 0) prepared.push({ state, messages });
      messageCount += messages.length;
      process.stdout.write(`\rPrepared ${index + 1}/${channels.length} channels · ${messageCount.toLocaleString()} messages…`);
    }
    process.stdout.write('\n');

    if (!options.apply) {
      console.log(`Dry run complete: ${prepared.length.toLocaleString()} channels and ${messageCount.toLocaleString()} messages.`);
      console.log('Run again with --apply to import them into Fluid.');
      return;
    }

    const projectUrl = process.env.SUPABASE_PROJECT_URL?.trim().replace(/\/$/, '');
    if (!projectUrl) throw new Error('SUPABASE_PROJECT_URL is not configured');
    const secret = activitySecret();
    let imported = 0;
    let skipped = 0;
    const failures: Array<{ channelId: string; reason: string }> = [];
    await runPool(prepared, 5, async ({ state, messages }) => {
      try {
        await importChannel(projectUrl, secret, session.userId, state, messages);
        imported += messages.length;
      } catch (error) {
        skipped += messages.length;
        failures.push({
          channelId: state.channel?.id ?? 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      process.stdout.write(`\rImported ${imported.toLocaleString()} messages · ${skipped.toLocaleString()} skipped…`);
    });
    process.stdout.write('\n');
    console.log(JSON.stringify({ channels: prepared.length, messages: messageCount, imported, skipped, failures }, null, 2));
  } finally {
    await context?.close();
  }
}

await main();
