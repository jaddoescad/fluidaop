import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.95.0';
import {
  createAdminClient,
  jsonResponse as response,
  safeEqual,
  validSecret,
} from '../_shared/runtime.ts';

const encoder = new TextEncoder();
const WORKSPACE_KEY = 'ottawa-painters';

type SlackChannelInput = {
  id: string;
  name: string;
  is_archived?: boolean;
};

type SlackUserInput = {
  id: string;
  display_name?: string | null;
  real_name?: string | null;
  is_bot?: boolean;
  deleted?: boolean;
};

type SlackMessageInput = {
  channel_id: string;
  ts: string;
  thread_ts?: string | null;
  user?: string | null;
  bot_id?: string | null;
  subtype?: string | null;
  text?: string | null;
  files?: unknown[];
  edited_ts?: string | null;
  deleted?: boolean;
};

function supabase(): SupabaseClient {
  return createAdminClient();
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validSlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get('SLACK_SIGNING_SECRET')?.trim();
  const timestamp = req.headers.get('x-slack-request-timestamp')?.trim();
  const provided = req.headers.get('x-slack-signature')?.trim();
  if (!secret || !timestamp || !provided || !/^v0=[a-f0-9]{64}$/.test(provided)) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() - seconds * 1000) > 5 * 60_000) return false;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${rawBody}`));
  return safeEqual(`v0=${hex(digest)}`, provided);
}

function validInternalSecret(req: Request): boolean {
  const supplied = req.headers.get('x-fluid-activity-secret')?.trim() ?? '';
  return validSecret(supplied, [
    Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET'),
    Deno.env.get('FLUID_SLACK_SYNC_SECRET'),
  ]);
}

function cleanString(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
}

function slackTimestamp(value: unknown): string | null {
  const cleaned = cleanString(value, 40);
  return cleaned && /^[0-9]+\.[0-9]+$/.test(cleaned) ? cleaned : null;
}

function timestampIso(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) throw new Error('Slack timestamp is invalid');
  return new Date(seconds * 1000).toISOString();
}

function fileMetadata(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const file = item as Record<string, unknown>;
    const id = cleanString(file.id, 100);
    if (!id) return [];
    return [{
      id,
      name: cleanString(file.name, 255),
      mimetype: cleanString(file.mimetype, 160),
      size: typeof file.size === 'number' && file.size >= 0 ? file.size : null,
      permalink: cleanString(file.permalink, 2048),
    }];
  });
}

function filterReason(message: SlackMessageInput): string | null {
  const subtype = message.subtype ?? '';
  if ([
    'channel_join', 'channel_leave', 'channel_name', 'channel_purpose',
    'channel_topic', 'bot_add', 'bot_remove', 'tombstone',
  ].includes(subtype)) return `slack:${subtype}`;
  const text = (message.text ?? '').trim();
  if (!text) return 'empty';
  if (/\bhas joined the channel\b/i.test(text)) return 'channel-join';
  if (/^we just won a job for\b/i.test(text)) return 'channel-created';
  if (/^(good\s+)?morning[! .]*$/i.test(text) || /^end of day\b/i.test(text)) return 'attendance-chatter';
  return null;
}

function permalink(domain: string | null, providerChannelId: string, ts: string): string | null {
  if (!domain || !/^[a-z0-9-]+$/i.test(domain)) return null;
  return `https://${domain}.slack.com/archives/${providerChannelId}/p${ts.replace('.', '')}`;
}

async function workspaceRow(db: SupabaseClient, teamId: string) {
  const { data, error } = await db
    .from('slack_workspaces')
    .select('workspace_key,team_id,team_domain,status')
    .eq('workspace_key', WORKSPACE_KEY)
    .eq('team_id', teamId)
    .maybeSingle();
  if (error) throw error;
  return data as { workspace_key: string; team_id: string; team_domain: string | null; status: string } | null;
}

async function upsertUser(db: SupabaseClient, teamId: string, user: SlackUserInput): Promise<void> {
  if (!/^[UWBA][A-Z0-9-]+$/.test(user.id)) return;
  const { error } = await db.from('slack_users').upsert({
    workspace_key: WORKSPACE_KEY,
    team_id: teamId,
    provider_user_id: user.id,
    display_name: cleanString(user.display_name, 160),
    real_name: cleanString(user.real_name, 160),
    is_bot: Boolean(user.is_bot),
    is_deleted: Boolean(user.deleted),
    raw_metadata: {},
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_key,team_id,provider_user_id' });
  if (error) throw error;
}

async function upsertMessage(
  db: SupabaseClient,
  teamId: string,
  domain: string | null,
  input: SlackMessageInput,
  sourceEventId: string | null,
): Promise<{ imported: boolean; ignored: string | null }> {
  const providerChannelId = cleanString(input.channel_id, 100);
  const ts = slackTimestamp(input.ts);
  if (!providerChannelId || !ts) throw new Error('Slack message identity is invalid');
  const { data: channel, error: channelError } = await db
    .from('slack_channels')
    .select('id,selected')
    .eq('workspace_key', WORKSPACE_KEY)
    .eq('team_id', teamId)
    .eq('provider_channel_id', providerChannelId)
    .maybeSingle();
  if (channelError) throw channelError;
  if (!channel || !channel.selected) return { imported: false, ignored: 'channel-not-selected' };

  const reason = filterReason(input);
  const userId = cleanString(input.user ?? input.bot_id, 100);
  if (userId) await upsertUser(db, teamId, { id: userId, is_bot: Boolean(input.bot_id) });
  const now = new Date().toISOString();
  const deletedAt = input.deleted ? now : null;
  const { error } = await db.from('slack_messages').upsert({
    workspace_key: WORKSPACE_KEY,
    team_id: teamId,
    channel_id: channel.id,
    provider_message_ts: ts,
    thread_ts: slackTimestamp(input.thread_ts),
    provider_user_id: userId,
    subtype: cleanString(input.subtype, 80),
    text_content: (input.text ?? '').slice(0, 100000),
    permalink: permalink(domain, providerChannelId, ts),
    file_metadata: fileMetadata(input.files),
    raw_metadata: { providerChannelId },
    source_event_id: sourceEventId,
    occurred_at: timestampIso(ts),
    edited_at: input.edited_ts ? timestampIso(input.edited_ts) : null,
    deleted_at: deletedAt,
    is_filtered: reason !== null,
    filter_reason: reason,
    updated_at: now,
  }, { onConflict: 'workspace_key,team_id,channel_id,provider_message_ts' });
  if (error) throw error;
  const { error: updateError } = await db.from('slack_channels').update({
    last_message_ts: ts,
    updated_at: now,
  }).eq('id', channel.id);
  if (updateError) throw updateError;
  return { imported: true, ignored: reason };
}

async function handleInternal(req: Request, action: string): Promise<Response> {
  if (!validInternalSecret(req)) return response({ error: 'Unauthorized' }, 401);
  const db = supabase();
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (action === 'workspace') {
    const connectionId = cleanString(body.connectionId, 255);
    const teamId = cleanString(body.teamId, 100);
    const teamName = cleanString(body.teamName, 160);
    if (!connectionId || !teamId || !teamName) return response({ error: 'Invalid Slack workspace' }, 400);
    const { error } = await db.from('slack_workspaces').upsert({
      workspace_key: WORKSPACE_KEY,
      connection_id: connectionId,
      team_id: teamId,
      team_name: teamName,
      team_domain: cleanString(body.teamDomain, 160)?.toLowerCase() ?? null,
      bot_user_id: cleanString(body.botUserId, 100),
      granted_scopes: Array.isArray(body.scopes)
        ? body.scopes.filter((scope): scope is string => typeof scope === 'string').slice(0, 25)
        : [],
      status: body.disconnected ? 'disconnected' : 'connected',
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'connection_id' });
    if (error) throw error;
    return response({ ok: true });
  }
  if (action === 'channels') {
    const teamId = cleanString(body.teamId, 100);
    const channels = Array.isArray(body.channels) ? body.channels as SlackChannelInput[] : [];
    if (!teamId || channels.length > 500) return response({ error: 'Invalid Slack channels' }, 400);
    const rows = channels.flatMap((channel) => {
      const id = cleanString(channel.id, 100);
      const name = cleanString(channel.name, 160)?.toLowerCase();
      return id && name ? [{
        workspace_key: WORKSPACE_KEY,
        team_id: teamId,
        provider_channel_id: id,
        name,
        is_archived: Boolean(channel.is_archived),
        updated_at: new Date().toISOString(),
      }] : [];
    });
    if (rows.length > 0) {
      const { error } = await db.from('slack_channels').upsert(rows, {
        onConflict: 'workspace_key,team_id,provider_channel_id',
      });
      if (error) throw error;
    }
    const { data, error } = await db.from('slack_channels')
      .select('id,provider_channel_id,name,channel_kind,selected,job_id,proposal_id,is_archived,sync_status,last_message_ts')
      .eq('workspace_key', WORKSPACE_KEY).eq('team_id', teamId).eq('selected', true);
    if (error) throw error;
    const jobIds = [...new Set((data ?? []).map((channel) => channel.job_id as string | null).filter(Boolean))] as string[];
    const { data: cases, error: casesError } = jobIds.length === 0
      ? { data: [], error: null }
      : await db.from('operational_cases').select('job_id,status').in('job_id', jobIds);
    if (casesError) throw casesError;
    const statusByJob = new Map((cases ?? []).map((caseRow) => [caseRow.job_id as string, caseRow.status as string]));
    return response({
      channels: (data ?? []).map((channel) => ({
        ...channel,
        case_status: channel.job_id ? statusByJob.get(channel.job_id as string) ?? null : null,
      })),
    });
  }
  if (action === 'users') {
    const teamId = cleanString(body.teamId, 100);
    const users = Array.isArray(body.users) ? body.users as SlackUserInput[] : [];
    if (!teamId || users.length > 500) return response({ error: 'Invalid Slack users' }, 400);
    for (const user of users) await upsertUser(db, teamId, user);
    return response({ imported: users.length });
  }
  if (action === 'messages') {
    const teamId = cleanString(body.teamId, 100);
    const messages = Array.isArray(body.messages) ? body.messages as SlackMessageInput[] : [];
    const workspace = teamId ? await workspaceRow(db, teamId) : null;
    if (!teamId || !workspace || messages.length > 200) return response({ error: 'Invalid Slack message batch' }, 400);
    let imported = 0;
    let filtered = 0;
    for (const message of messages) {
      const result = await upsertMessage(db, teamId, workspace.team_domain, message, null);
      if (result.imported) imported += 1;
      if (result.ignored && result.imported) filtered += 1;
    }
    return response({ imported, filtered });
  }
  if (action === 'sync-state') {
    const teamId = cleanString(body.teamId, 100);
    const connectionId = cleanString(body.connectionId, 255);
    if (!teamId || !connectionId) return response({ error: 'Invalid sync state' }, 400);
    const now = new Date().toISOString();
    const { error } = await db.from('slack_sync_state').upsert({
      connection_id: connectionId,
      workspace_key: WORKSPACE_KEY,
      team_id: teamId,
      status: cleanString(body.status, 40) ?? 'idle',
      channels_seen: Number(body.channelsSeen ?? 0),
      channels_selected: Number(body.channelsSelected ?? 0),
      messages_seen: Number(body.messagesSeen ?? 0),
      messages_upserted: Number(body.messagesUpserted ?? 0),
      retry_after_seconds: typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : null,
      last_sync_started_at: cleanString(body.startedAt, 80),
      last_sync_completed_at: body.status === 'succeeded' ? now : null,
      last_error: cleanString(body.error, 2000),
      updated_at: now,
    }, { onConflict: 'connection_id' });
    if (error) throw error;
    if (body.status === 'succeeded') {
      await db.from('slack_workspaces').update({ last_synced_at: now, updated_at: now })
        .eq('workspace_key', WORKSPACE_KEY).eq('team_id', teamId);
    }
    return response({ ok: true });
  }
  if (action === 'channel-sync-state') {
    const teamId = cleanString(body.teamId, 100);
    const providerChannelId = cleanString(body.channelId, 100);
    const status = cleanString(body.status, 40);
    if (!teamId || !providerChannelId || !status || !['idle', 'running', 'succeeded', 'failed', 'rate_limited'].includes(status)) {
      return response({ error: 'Invalid channel sync state' }, 400);
    }
    const { error } = await db.from('slack_channels').update({
      sync_status: status,
      sync_cursor: cleanString(body.cursor, 2048),
      last_synced_at: status === 'succeeded' ? new Date().toISOString() : null,
      last_error: cleanString(body.error, 2000),
      updated_at: new Date().toISOString(),
    }).eq('workspace_key', WORKSPACE_KEY).eq('team_id', teamId).eq('provider_channel_id', providerChannelId);
    if (error) throw error;
    return response({ ok: true });
  }
  if (action === 'status') {
    const { data: workspaces, error } = await db.from('slack_workspaces')
      .select('connection_id,team_id,team_name,team_domain,status,last_event_at,last_synced_at,last_error,updated_at')
      .eq('workspace_key', WORKSPACE_KEY);
    if (error) throw error;
    const { data: channels, error: channelError } = await db.from('slack_channels')
      .select('team_id,channel_kind,selected,job_id,is_archived')
      .eq('workspace_key', WORKSPACE_KEY).eq('selected', true);
    if (channelError) throw channelError;
    return response({
      signingSecretConfigured: Boolean(Deno.env.get('SLACK_SIGNING_SECRET')?.trim()),
      workspaces: workspaces ?? [],
      selectedChannels: channels ?? [],
    });
  }
  return response({ error: 'Unknown action' }, 404);
}

async function handleSlackEvent(req: Request, rawBody: string): Promise<Response> {
  if (!await validSlackSignature(req, rawBody)) return response({ error: 'Invalid Slack signature' }, 401);
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  if (payload.type === 'url_verification') {
    const challenge = cleanString(payload.challenge, 255);
    return challenge ? response({ challenge }) : response({ error: 'Invalid challenge' }, 400);
  }
  if (payload.type !== 'event_callback') return response({ ok: true, ignored: 'unsupported-envelope' });
  const teamId = cleanString(payload.team_id, 100);
  const eventId = cleanString(payload.event_id, 255);
  const event = payload.event;
  if (!teamId || !eventId || !event || typeof event !== 'object' || Array.isArray(event)) {
    return response({ error: 'Invalid Slack event envelope' }, 400);
  }
  const db = supabase();
  const workspace = await workspaceRow(db, teamId);
  if (!workspace || workspace.status === 'disconnected') return response({ ok: true, ignored: 'workspace-not-connected' });
  const eventObject = event as Record<string, unknown>;
  const eventType = cleanString(eventObject.type, 80) ?? 'unknown';
  const { error: eventError } = await db.from('slack_events').insert({
    event_id: eventId,
    workspace_key: WORKSPACE_KEY,
    team_id: teamId,
    event_type: eventType,
    event_time: typeof payload.event_time === 'number' ? new Date(payload.event_time * 1000).toISOString() : null,
  });
  if (eventError?.code === '23505') return response({ ok: true, duplicate: true });
  if (eventError) throw eventError;

  try {
    if (eventType !== 'message') {
      await db.from('slack_events').update({ status: 'ignored', processed_at: new Date().toISOString() }).eq('event_id', eventId);
      return response({ ok: true, ignored: eventType });
    }
    const outerChannel = cleanString(eventObject.channel, 100) ?? '';
    const subtype = cleanString(eventObject.subtype, 80);
    let message: SlackMessageInput;
    if (subtype === 'message_changed' && eventObject.message && typeof eventObject.message === 'object') {
      const changed = eventObject.message as Record<string, unknown>;
      const edited = changed.edited && typeof changed.edited === 'object' ? changed.edited as Record<string, unknown> : null;
      message = {
        channel_id: outerChannel,
        ts: String(changed.ts ?? ''),
        thread_ts: typeof changed.thread_ts === 'string' ? changed.thread_ts : null,
        user: typeof changed.user === 'string' ? changed.user : null,
        bot_id: typeof changed.bot_id === 'string' ? changed.bot_id : null,
        subtype: typeof changed.subtype === 'string' ? changed.subtype : null,
        text: typeof changed.text === 'string' ? changed.text : '',
        files: Array.isArray(changed.files) ? changed.files : [],
        edited_ts: typeof edited?.ts === 'string' ? edited.ts : null,
      };
    } else if (subtype === 'message_deleted') {
      const previous = eventObject.previous_message && typeof eventObject.previous_message === 'object'
        ? eventObject.previous_message as Record<string, unknown> : {};
      message = {
        channel_id: outerChannel,
        ts: String(eventObject.deleted_ts ?? previous.ts ?? ''),
        thread_ts: typeof previous.thread_ts === 'string' ? previous.thread_ts : null,
        user: typeof previous.user === 'string' ? previous.user : null,
        subtype,
        text: typeof previous.text === 'string' ? previous.text : '',
        deleted: true,
      };
    } else {
      message = {
        channel_id: outerChannel,
        ts: String(eventObject.ts ?? ''),
        thread_ts: typeof eventObject.thread_ts === 'string' ? eventObject.thread_ts : null,
        user: typeof eventObject.user === 'string' ? eventObject.user : null,
        bot_id: typeof eventObject.bot_id === 'string' ? eventObject.bot_id : null,
        subtype,
        text: typeof eventObject.text === 'string' ? eventObject.text : '',
        files: Array.isArray(eventObject.files) ? eventObject.files : [],
      };
    }
    const result = await upsertMessage(db, teamId, workspace.team_domain, message, eventId);
    const now = new Date().toISOString();
    await db.from('slack_events').update({
      status: result.imported ? 'processed' : 'ignored',
      processed_at: now,
    }).eq('event_id', eventId);
    await db.from('slack_workspaces').update({ last_event_at: now, updated_at: now })
      .eq('workspace_key', WORKSPACE_KEY).eq('team_id', teamId);
    return response({ ok: true, imported: result.imported, filtered: result.ignored });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Slack event processing failed';
    await db.from('slack_events').update({ status: 'failed', last_error: message.slice(0, 2000) }).eq('event_id', eventId);
    throw error;
  }
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'GET') {
      const action = new URL(req.url).searchParams.get('action') ?? 'status';
      return await handleInternal(req, action);
    }
    if (req.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
    const action = new URL(req.url).searchParams.get('action');
    if (action) return await handleInternal(req, action);
    const rawBody = await req.text();
    return await handleSlackEvent(req, rawBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected Slack integration failure';
    console.error(message);
    return response({ error: message }, 500);
  }
});
