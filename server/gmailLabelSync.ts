const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MANAGED_LABEL_PREFIX = 'Fluid/';

export interface FluidTopicLabel {
  id: number;
  key: string;
  name: string;
}

export interface GmailLabelMapping {
  fluidLabelId: number;
  gmailLabelId: string;
  gmailLabelName: string;
}

export interface GmailUserLabel {
  id: string;
  name: string;
  type?: string;
}

export interface GmailLabelClient {
  listLabels(refresh?: boolean): Promise<GmailUserLabel[]>;
  createLabel(name: string): Promise<GmailUserLabel>;
  renameLabel(id: string, name: string): Promise<GmailUserLabel>;
  getMessageLabelIds(messageId: string): Promise<string[]>;
  modifyMessageLabels(messageId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
}

export type GmailLabelProjectionOutcome = 'applied' | 'already-applied' | 'message-missing';

export interface GmailLabelProjectionResult {
  outcome: GmailLabelProjectionOutcome;
  gmailLabelId: string | null;
  gmailLabelName: string | null;
}

export interface GmailSupplementalLabelPlan {
  desiredNames: string[];
  managedNames: string[];
}

export class GmailLabelApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly reason: string | null = null,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || (
      this.status === 403 && (
        this.reason === 'rateLimitExceeded' ||
        this.reason === 'userRateLimitExceeded' ||
        /rate limit|quota exceeded/i.test(this.message)
      )
    );
  }
}

export function canonicalGmailTopicLabel(name: string): string {
  const cleaned = managedLabelSuffix(name);
  if (!cleaned) throw new Error('Fluid topic label name is empty');
  return `${MANAGED_LABEL_PREFIX}${cleaned.slice(0, 225 - MANAGED_LABEL_PREFIX.length)}`;
}

export function canonicalGmailSupplementalLabel(name: string): string {
  const cleaned = managedLabelSuffix(name);
  if (!cleaned) throw new Error('Supplemental Gmail label name is empty');
  return `${MANAGED_LABEL_PREFIX}${cleaned.slice(0, 225 - MANAGED_LABEL_PREFIX.length)}`;
}

function managedLabelSuffix(name: string): string {
  const cleaned = name.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.startsWith(MANAGED_LABEL_PREFIX)
    ? cleaned.slice(MANAGED_LABEL_PREFIX.length).trim()
    : cleaned;
}

export function planManagedLabelMutation(
  currentLabelIds: string[],
  desiredLabelId: string,
  managedLabelIds: Iterable<string>,
): { addLabelIds: string[]; removeLabelIds: string[] } {
  const current = new Set(currentLabelIds);
  const managed = new Set(managedLabelIds);
  return {
    addLabelIds: current.has(desiredLabelId) ? [] : [desiredLabelId],
    removeLabelIds: [...current].filter((id) => managed.has(id) && id !== desiredLabelId),
  };
}

async function desiredGmailLabel(
  client: GmailLabelClient,
  labels: GmailUserLabel[],
  desired: FluidTopicLabel,
  mappings: GmailLabelMapping[],
): Promise<GmailUserLabel> {
  const desiredName = canonicalGmailTopicLabel(desired.name);
  const mapping = mappings.find((item) => item.fluidLabelId === desired.id);
  const mapped = mapping ? labels.find((label) => label.id === mapping.gmailLabelId) : undefined;
  const exact = labels.find((label) => label.name === desiredName);

  if (mapped?.name === desiredName) return mapped;
  if (exact) return exact;
  if (mapped) return client.renameLabel(mapped.id, desiredName);

  try {
    return await client.createLabel(desiredName);
  } catch (error) {
    // A concurrent worker may create the same canonical label. Resolve the
    // conflict by listing again and adopting that stable Gmail label ID.
    if (!(error instanceof GmailLabelApiError) || error.status !== 409) throw error;
    const refreshed = await client.listLabels(true);
    const created = refreshed.find((label) => label.name === desiredName);
    if (!created) throw error;
    return created;
  }
}

async function exactGmailLabel(
  client: GmailLabelClient,
  labels: GmailUserLabel[],
  name: string,
): Promise<GmailUserLabel> {
  const exact = labels.find((label) => label.name === name);
  if (exact) return exact;

  try {
    return await client.createLabel(name);
  } catch (error) {
    if (!(error instanceof GmailLabelApiError) || error.status !== 409) throw error;
    const refreshed = await client.listLabels(true);
    const created = refreshed.find((label) => label.name === name);
    if (!created) throw error;
    return created;
  }
}

export async function projectTopicToGmail(
  client: GmailLabelClient,
  messageId: string,
  desired: FluidTopicLabel,
  topics: FluidTopicLabel[],
  mappings: GmailLabelMapping[],
  supplemental: GmailSupplementalLabelPlan = { desiredNames: [], managedNames: [] },
): Promise<GmailLabelProjectionResult> {
  let labels = await client.listLabels();
  const gmailLabel = await desiredGmailLabel(client, labels, desired, mappings);
  if (!labels.some((label) => label.id === gmailLabel.id)) labels = [...labels, gmailLabel];

  const desiredSupplementalNames = new Set(
    supplemental.desiredNames.map(canonicalGmailSupplementalLabel),
  );
  const managedSupplementalNames = new Set([
    ...supplemental.managedNames.map(canonicalGmailSupplementalLabel),
    ...desiredSupplementalNames,
  ]);
  const desiredSupplementalIds = new Set<string>();
  for (const name of desiredSupplementalNames) {
    const label = await exactGmailLabel(client, labels, name);
    desiredSupplementalIds.add(label.id);
    if (!labels.some((candidate) => candidate.id === label.id)) labels = [...labels, label];
  }

  const expectedNames = new Set(topics.map((topic) => canonicalGmailTopicLabel(topic.name)));
  const managedTopicIds = new Set<string>([
    gmailLabel.id,
    ...mappings.map((mapping) => mapping.gmailLabelId),
    ...labels.filter((label) => expectedNames.has(label.name)).map((label) => label.id),
  ]);
  const managedSupplementalIds = new Set(
    labels.filter((label) => managedSupplementalNames.has(label.name)).map((label) => label.id),
  );

  let currentLabelIds: string[];
  try {
    currentLabelIds = await client.getMessageLabelIds(messageId);
  } catch (error) {
    if (error instanceof GmailLabelApiError && error.status === 404) {
      return { outcome: 'message-missing', gmailLabelId: null, gmailLabelName: null };
    }
    throw error;
  }

  const topicMutation = planManagedLabelMutation(currentLabelIds, gmailLabel.id, managedTopicIds);
  const current = new Set(currentLabelIds);
  const mutation = {
    addLabelIds: [...new Set([
      ...topicMutation.addLabelIds,
      ...[...desiredSupplementalIds].filter((id) => !current.has(id)),
    ])],
    removeLabelIds: [...new Set([
      ...topicMutation.removeLabelIds,
      ...currentLabelIds.filter((id) => managedSupplementalIds.has(id) && !desiredSupplementalIds.has(id)),
    ])],
  };
  if (mutation.addLabelIds.length === 0 && mutation.removeLabelIds.length === 0) {
    return {
      outcome: 'already-applied',
      gmailLabelId: gmailLabel.id,
      gmailLabelName: gmailLabel.name,
    };
  }

  await client.modifyMessageLabels(messageId, mutation.addLabelIds, mutation.removeLabelIds);
  return { outcome: 'applied', gmailLabelId: gmailLabel.id, gmailLabelName: gmailLabel.name };
}

function responseError(
  payload: unknown,
  fallback: string,
): { message: string; reason: string | null } {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const details = error as { message?: unknown; errors?: unknown };
      const message = typeof details.message === 'string' && details.message.trim()
        ? details.message.trim().slice(0, 500)
        : fallback;
      const first = Array.isArray(details.errors) ? details.errors[0] : null;
      const reason = first && typeof first === 'object' && 'reason' in first &&
          typeof (first as { reason?: unknown }).reason === 'string'
        ? (first as { reason: string }).reason
        : null;
      return { message, reason };
    }
  }
  return { message: fallback, reason: null };
}

export class GmailRestLabelClient implements GmailLabelClient {
  private labels: GmailUserLabel[] | null = null;

  constructor(
    private readonly accessToken: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`${GMAIL_API}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
        signal: init?.signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      // fetch only rejects before an HTTP response exists (for example DNS,
      // socket, or timeout failures). Those are transient transport failures,
      // not deterministic label-plan errors, so the leased job must retry.
      throw new GmailLabelApiError(
        503,
        'Gmail label API request failed before receiving a response',
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const detail = responseError(payload, `Gmail label API returned HTTP ${response.status}`);
      throw new GmailLabelApiError(
        response.status,
        detail.message,
        Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
        detail.reason,
      );
    }
    return payload as T;
  }

  async listLabels(refresh = false): Promise<GmailUserLabel[]> {
    if (this.labels && !refresh) return this.labels;
    const payload = await this.json<{ labels?: GmailUserLabel[] }>('/labels');
    this.labels = (payload.labels ?? []).filter((label) => Boolean(label.id && label.name));
    return this.labels;
  }

  async createLabel(name: string): Promise<GmailUserLabel> {
    const label = await this.json<GmailUserLabel>('/labels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    });
    this.labels = [...(this.labels ?? []), label];
    return label;
  }

  async renameLabel(id: string, name: string): Promise<GmailUserLabel> {
    const label = await this.json<GmailUserLabel>(`/labels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    this.labels = (this.labels ?? []).map((candidate) => candidate.id === id ? label : candidate);
    return label;
  }

  async getMessageLabelIds(messageId: string): Promise<string[]> {
    const path = `/messages/${encodeURIComponent(messageId)}?format=minimal&fields=id%2ClabelIds`;
    const message = await this.json<{ labelIds?: string[] }>(path);
    return message.labelIds ?? [];
  }

  async modifyMessageLabels(
    messageId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    await this.json(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }
}
