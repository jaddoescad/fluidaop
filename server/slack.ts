export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

export interface SlackOAuthResponse {
  ok?: boolean;
  error?: string;
  scope?: string;
  team?: { id?: string; name?: string };
  enterprise?: { id?: string; name?: string } | null;
  authed_user?: {
    id?: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
}

export interface SlackAuthTestResponse {
  ok?: boolean;
  error?: string;
  url?: string;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_archived: boolean;
}

export interface SlackUser {
  id: string;
  display_name: string | null;
  real_name: string | null;
  is_bot: boolean;
  deleted: boolean;
}

export interface SlackMessage {
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user: string | null;
  bot_id: string | null;
  subtype: string | null;
  text: string;
  files: unknown[];
  edited_ts: string | null;
  reply_count: number;
}

type SlackEnvelope = {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
};

async function slackRequest<T extends SlackEnvelope>(
  method: string,
  token: string,
  params: URLSearchParams = new URLSearchParams(),
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(20_000),
  });
  const retryAfterRaw = response.headers.get('retry-after');
  const retryAfter = retryAfterRaw === null ? null : Number.parseInt(retryAfterRaw, 10);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SlackApiError(
      `Slack ${method} returned an invalid response`,
      null,
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  const envelope = payload as SlackEnvelope;
  if (!response.ok || envelope.ok !== true) {
    const code = typeof envelope.error === 'string' ? envelope.error : null;
    throw new SlackApiError(
      code ? `Slack ${method}: ${code}` : `Slack ${method} returned HTTP ${response.status}`,
      code,
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  return payload as T;
}

export async function exchangeSlackCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<SlackOAuthResponse> {
  const params = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return await slackRequest<SlackOAuthResponse & SlackEnvelope>('oauth.v2.access', '', params);
}

export async function slackAuthTest(token: string): Promise<SlackAuthTestResponse> {
  return await slackRequest<SlackAuthTestResponse & SlackEnvelope>('auth.test', token);
}

export async function revokeSlackToken(token: string): Promise<void> {
  await slackRequest<SlackEnvelope>('auth.revoke', token);
}

export async function listSlackChannels(
  token: string,
  maximum = 500,
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({
      types: 'public_channel',
      exclude_archived: 'false',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const payload = await slackRequest<SlackEnvelope & { channels?: unknown[] }>('conversations.list', token, params);
    for (const raw of payload.channels ?? []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const channel = raw as Record<string, unknown>;
      if (typeof channel.id !== 'string' || typeof channel.name !== 'string') continue;
      channels.push({
        id: channel.id,
        name: channel.name,
        is_archived: channel.is_archived === true,
      });
      if (channels.length >= maximum) return channels;
    }
    cursor = payload.response_metadata?.next_cursor?.trim() ?? '';
  } while (cursor);
  return channels;
}

export async function listSlackUsers(token: string, maximum = 500): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const payload = await slackRequest<SlackEnvelope & { members?: unknown[] }>('users.list', token, params);
    for (const raw of payload.members ?? []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const member = raw as Record<string, unknown>;
      const profile = member.profile && typeof member.profile === 'object' && !Array.isArray(member.profile)
        ? member.profile as Record<string, unknown>
        : {};
      if (typeof member.id !== 'string') continue;
      users.push({
        id: member.id,
        display_name: typeof profile.display_name === 'string' ? profile.display_name : null,
        real_name: typeof profile.real_name === 'string'
          ? profile.real_name
          : typeof member.real_name === 'string' ? member.real_name : null,
        is_bot: member.is_bot === true,
        deleted: member.deleted === true,
      });
      if (users.length >= maximum) return users;
    }
    cursor = payload.response_metadata?.next_cursor?.trim() ?? '';
  } while (cursor);
  return users;
}

function normalizeMessages(channelId: string, values: unknown[]): SlackMessage[] {
  return values.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    if (typeof message.ts !== 'string') return [];
    const edited = message.edited && typeof message.edited === 'object' && !Array.isArray(message.edited)
      ? message.edited as Record<string, unknown>
      : null;
    return [{
      channel_id: channelId,
      ts: message.ts,
      thread_ts: typeof message.thread_ts === 'string' ? message.thread_ts : null,
      user: typeof message.user === 'string' ? message.user : null,
      bot_id: typeof message.bot_id === 'string' ? message.bot_id : null,
      subtype: typeof message.subtype === 'string' ? message.subtype : null,
      text: typeof message.text === 'string' ? message.text : '',
      files: Array.isArray(message.files) ? message.files : [],
      edited_ts: typeof edited?.ts === 'string' ? edited.ts : null,
      reply_count: typeof message.reply_count === 'number' && message.reply_count > 0 ? message.reply_count : 0,
    }];
  });
}

export async function readSlackChannel(
  token: string,
  channelId: string,
  limit = 15,
): Promise<{ messages: SlackMessage[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ channel: channelId, limit: String(Math.min(15, Math.max(1, limit))) });
  const payload = await slackRequest<SlackEnvelope & { messages?: unknown[] }>('conversations.history', token, params);
  return {
    messages: normalizeMessages(channelId, payload.messages ?? []),
    nextCursor: payload.response_metadata?.next_cursor?.trim() || null,
  };
}

export async function readSlackThread(
  token: string,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: '15' });
  const payload = await slackRequest<SlackEnvelope & { messages?: unknown[] }>('conversations.replies', token, params);
  return normalizeMessages(channelId, payload.messages ?? []);
}
