import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_EXPORT = resolve('.data/dripjobs-chat-export-2026-08-28.json');
const CHECKPOINT_PATH = resolve('.data/dripjobs-chat-import-progress.json');
const WORKSPACE_KEY = 'ottawa-painters';
const MESSAGE_BATCH_SIZE = 10;

type CustomerIdentity = {
  name: string;
  email: string | null;
  phone: string | null;
};

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

type ExportChannel = {
  channelId: string;
  dripjobsContactId: string;
  customer: CustomerIdentity;
  messages: ImportMessage[];
};

type ChatExport = {
  exportedAt: string;
  supportUserId: string;
  channels: ExportChannel[];
};

type Checkpoint = {
  workspaceKey: string;
  exportSha256: string;
  completedChannelIds: string[];
  updatedAt: string;
};

function parseArgs(): { apply: boolean; file: string; concurrency: number } {
  const values = process.argv.slice(2);
  if (values.includes('--help')) {
    console.log([
      'Usage: npm run import:dripjobs-chat-export -- [--apply] [--file PATH] [--concurrency N]',
      '',
      'Default is a dry run. --apply transmits the exported chats to Fluid.',
      'Completed channels are checkpointed so an interrupted import can resume safely.',
    ].join('\n'));
    process.exit(0);
  }
  const fileIndex = values.indexOf('--file');
  const concurrencyIndex = values.indexOf('--concurrency');
  const file = resolve(fileIndex >= 0 ? values[fileIndex + 1] ?? '' : DEFAULT_EXPORT);
  const concurrency = concurrencyIndex >= 0
    ? Number.parseInt(values[concurrencyIndex + 1] ?? '', 10)
    : 5;
  if (!file) throw new Error('--file needs a path');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error('--concurrency must be between 1 and 20');
  }
  return { apply: values.includes('--apply'), file, concurrency };
}

function activitySecret(): string {
  const root = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY?.trim();
  if (!root || root.length < 32) {
    throw new Error('CONNECTION_TOKEN_ENCRYPTION_KEY must be configured before --apply');
  }
  return createHash('sha256').update('fluid-activity-sync:v2\0').update(root, 'utf8').digest('hex');
}

function validateExport(value: unknown): ChatExport {
  if (!value || typeof value !== 'object') throw new Error('Chat export is not an object');
  const candidate = value as Partial<ChatExport>;
  if (typeof candidate.exportedAt !== 'string' || !Number.isFinite(Date.parse(candidate.exportedAt))) {
    throw new Error('Chat export has no valid exportedAt');
  }
  if (typeof candidate.supportUserId !== 'string' || !candidate.supportUserId.trim()) {
    throw new Error('Chat export has no support user');
  }
  if (!Array.isArray(candidate.channels)) throw new Error('Chat export has no channels');
  const channelIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const channel of candidate.channels) {
    if (!channel || typeof channel !== 'object' || !channel.channelId?.trim() ||
      !channel.dripjobsContactId?.trim() || !channel.customer?.name?.trim() ||
      !Array.isArray(channel.messages) || channel.messages.length < 1) {
      throw new Error('Chat export contains an invalid channel');
    }
    if (channelIds.has(channel.channelId)) throw new Error('Chat export contains a duplicate channel');
    channelIds.add(channel.channelId);
    for (const message of channel.messages) {
      if (!message?.externalId?.trim() || messageIds.has(message.externalId) ||
        !Number.isFinite(Date.parse(message.occurredAt)) ||
        !['inbound', 'outbound'].includes(message.direction) || !message.text?.trim() ||
        !Number.isSafeInteger(message.attachmentCount) || message.attachmentCount < 0 ||
        !Array.isArray(message.attachmentTypes)) {
        throw new Error('Chat export contains an invalid or duplicate message');
      }
      messageIds.add(message.externalId);
    }
  }
  return candidate as ChatExport;
}

async function readCheckpoint(exportSha256: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(CHECKPOINT_PATH, 'utf8')) as Partial<Checkpoint>;
    if (parsed.workspaceKey !== WORKSPACE_KEY || parsed.exportSha256 !== exportSha256 ||
      !Array.isArray(parsed.completedChannelIds)) return new Set();
    return new Set(parsed.completedChannelIds.filter((value): value is string => typeof value === 'string'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

async function persistCheckpoint(exportSha256: string, completed: Set<string>): Promise<void> {
  const body: Checkpoint = {
    workspaceKey: WORKSPACE_KEY,
    exportSha256,
    completedChannelIds: [...completed].sort(),
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${CHECKPOINT_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, CHECKPOINT_PATH);
}

async function importChannel(
  projectUrl: string,
  secret: string,
  supportUserId: string,
  channel: ExportChannel,
): Promise<{ inserted: number; existing: number; linked: number; unassigned: number }> {
  let inserted = 0;
  let existing = 0;
  let linked = 0;
  let unassigned = 0;
  const url = new URL(`${projectUrl}/functions/v1/fluid-real-board`);
  url.searchParams.set('action', 'ingest-dripjobs-chat');
  for (let offset = 0; offset < channel.messages.length; offset += MESSAGE_BATCH_SIZE) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-fluid-activity-secret': secret,
      },
      body: JSON.stringify({
        contactId: channel.dripjobsContactId,
        channelId: channel.channelId,
        supportUserId,
        customer: channel.customer,
        messages: channel.messages.slice(offset, offset + MESSAGE_BATCH_SIZE),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = await response.json().catch(() => null) as {
      imported?: { inserted?: number; existing?: number; linkRows?: number; unassigned?: number };
    } | null;
    if (!response.ok) {
      throw new Error(`Fluid returned ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    inserted += Number(payload?.imported?.inserted ?? 0);
    existing += Number(payload?.imported?.existing ?? 0);
    linked += Number(payload?.imported?.linkRows ?? 0);
    unassigned += Number(payload?.imported?.unassigned ?? 0);
  }
  return { inserted, existing, linked, unassigned };
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await work(items[index]);
    }
  }));
}

async function main(): Promise<void> {
  const options = parseArgs();
  const raw = await readFile(options.file, 'utf8');
  const exportSha256 = createHash('sha256').update(raw).digest('hex');
  const chatExport = validateExport(JSON.parse(raw));
  const messageCount = chatExport.channels.reduce((sum, channel) => sum + channel.messages.length, 0);
  const uniqueContacts = new Set(chatExport.channels.map((channel) => channel.dripjobsContactId)).size;
  console.log(JSON.stringify({
    exportSha256,
    channels: chatExport.channels.length,
    uniqueContacts,
    messages: messageCount,
  }, null, 2));

  if (!options.apply) {
    console.log('Dry run complete. Add --apply to import this verified export into Fluid.');
    return;
  }

  const projectUrl = process.env.SUPABASE_PROJECT_URL?.trim().replace(/\/$/, '');
  if (!projectUrl) throw new Error('SUPABASE_PROJECT_URL is not configured');
  const secret = activitySecret();
  const completed = await readCheckpoint(exportSha256);
  const pending = chatExport.channels.filter((channel) => !completed.has(channel.channelId));
  let inserted = 0;
  let existing = 0;
  let linked = 0;
  let unassigned = 0;
  const failures: Array<{ channelId: string; reason: string }> = [];
  let checkpointWrites = Promise.resolve();

  await runPool(pending, options.concurrency, async (channel) => {
    try {
      const result = await importChannel(projectUrl, secret, chatExport.supportUserId, channel);
      inserted += result.inserted;
      existing += result.existing;
      linked += result.linked;
      unassigned += result.unassigned;
      completed.add(channel.channelId);
      checkpointWrites = checkpointWrites.then(() => persistCheckpoint(exportSha256, completed));
      await checkpointWrites;
    } catch (error) {
      failures.push({
        channelId: channel.channelId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    process.stdout.write(`\rCompleted ${completed.size.toLocaleString()}/${chatExport.channels.length.toLocaleString()} channels…`);
  });
  process.stdout.write('\n');
  await checkpointWrites;
  console.log(JSON.stringify({
    channels: chatExport.channels.length,
    completedChannels: completed.size,
    inserted,
    existing,
    linked,
    unassigned,
    failures,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

await main();
