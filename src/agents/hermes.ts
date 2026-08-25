export interface HermesStatus {
  connected: boolean;
  version: string | null;
  gatewayState: string;
  activeAgents: number;
  profiles: string[];
  checkedAt: string;
}

export interface HermesAgentDefinition {
  id: string;
  runtimeName: string;
  name: string;
  icon: string;
  description: string;
  schedule: string;
  profile: string;
  mode: string;
  steps: string[];
  enabled: boolean;
  state: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  historyAgentId: string | null;
}

interface HermesAgentRecord {
  id: string;
  name: string;
  profile: string;
  schedule: string;
  enabled: boolean;
  state: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  mode: 'agent' | 'script';
}

interface HermesAgentsPayload {
  agents: HermesAgentRecord[];
  fetchedAt: string;
}

interface AgentPresentation {
  match: RegExp;
  name: string;
  icon: string;
  description: string;
  mode: string;
  steps: string[];
  historyAgentId: string | null;
}

const AGENT_PRESENTATIONS: AgentPresentation[] = [
  {
    match: /fluid email categorizer/i,
    name: 'Email Categorizer',
    icon: '✉️',
    description: 'Categorizes incoming Gmail signals in Fluid and records attachment evidence without changing Gmail.',
    mode: 'Agent-assisted',
    historyAgentId: 'email-categorizer',
    steps: [
      'Claim new Gmail signals from the durable Supabase queue',
      'Read the signal and selectively extract relevant attachment text',
      'Choose one enabled Fluid label with confidence and evidence',
      'Save the result and audit record in Supabase without writing to Gmail',
    ],
  },
  {
    match: /fluid customer sync/i,
    name: 'Customer Sync',
    icon: '👥',
    description: 'Syncs Ottawa Painters customers into canonical Fluid people and connects exact matching signals without merging customers.',
    mode: 'Scheduled sync',
    historyAgentId: null,
    steps: [
      'Read customer records changed in Ottawa Painters Admin',
      'Create or refresh one canonical person for each source customer',
      'Preserve shared emails and phone numbers without automatically merging people',
      'Connect signals by source contact or an unambiguous exact email match',
    ],
  },
  {
    match: /contractor invoice sync/i,
    name: 'Contractor Invoices',
    icon: '🧾',
    description: 'Processes contractor invoice evidence for the operations workflow.',
    mode: 'Scheduled automation',
    historyAgentId: 'contractor-invoices',
    steps: [
      'Find new contractor invoice emails and attachments',
      'Extract the contractor, job, amount, and invoice date',
      'Match the evidence to the operations workflow',
      'Flag anything uncertain for human review',
    ],
  },
  {
    match: /daily dripjobs/i,
    name: 'DripJobs Operations',
    icon: '🛠️',
    description: 'Synchronizes DripJobs sales and job data into the business workspace.',
    mode: 'Scheduled automation',
    historyAgentId: 'dripjobs-operations',
    steps: [
      'Connect to the DripJobs workspace',
      'Collect updated leads, jobs, and sales records',
      'Normalize the records for the Fluid workspace',
      'Save the sync result and report any failures',
    ],
  },
  {
    match: /daily meta ads/i,
    name: 'Meta Ads Reporter',
    icon: '📈',
    description: 'Refreshes campaign data and prepares the daily leads and CPL report.',
    mode: 'Agent + scheduled sync',
    historyAgentId: 'meta-ads-reporter',
    steps: [
      'Refresh the latest Meta campaign performance',
      'Calculate leads and cost per lead',
      'Compare results across active campaigns',
      'Prepare the daily performance brief',
    ],
  },
];

export function presentHermesAgent(agent: HermesAgentRecord): HermesAgentDefinition {
  const presentation = AGENT_PRESENTATIONS.find((candidate) => candidate.match.test(agent.name));
  return {
    ...agent,
    runtimeName: agent.name,
    name: presentation?.name ?? agent.name,
    icon: presentation?.icon ?? (agent.mode === 'script' ? '⚙️' : '🤖'),
    description: presentation?.description ?? `Hermes automation running in the ${agent.profile} profile.`,
    mode: presentation?.mode ?? (agent.mode === 'script' ? 'Script-only automation' : 'Hermes agent'),
    steps: presentation?.steps ?? [
      'Wake on its Hermes schedule',
      'Load the skills and tools assigned to this job',
      'Complete the configured workflow',
      'Record the run result in Hermes',
    ],
    historyAgentId: presentation?.historyAgentId ?? null,
  };
}

export interface HermesSkill {
  id: string;
  name: string;
  description: string;
  source: 'bundled' | 'hub' | 'custom' | string;
  version: string | null;
  enabled: boolean;
  profiles: string[];
  usage: number;
  usedBy: string[];
}

interface HermesSkillsPayload {
  skills: HermesSkill[];
  fetchedAt: string;
}

export type HermesRunStatus =
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'recorded';

export interface HermesRun {
  id: string;
  jobId: string;
  jobName: string;
  profile: string;
  status: HermesRunStatus;
  source: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sessionId: string | null;
  model: string | null;
  messageCount: number | null;
  toolCallCount: number | null;
}

export interface HermesHistoryJob {
  id: string;
  name: string;
  profile: string;
}

export interface HermesAgentHistory {
  agentId: string;
  jobs: HermesHistoryJob[];
  runs: HermesRun[];
  fetchedAt: string;
}

export async function loadHermesStatus(): Promise<HermesStatus> {
  const response = await fetch('/api/hermes/status', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Hermes status returned HTTP ${response.status}`);
  return (await response.json()) as HermesStatus;
}

export async function loadHermesAgents(): Promise<HermesAgentDefinition[]> {
  const response = await fetch('/api/hermes/agents', { headers: { Accept: 'application/json' } });
  const payload = (await response.json().catch(() => null)) as HermesAgentsPayload | { error?: unknown } | null;
  if (!response.ok) {
    const detail = payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Hermes agents returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (payload === null || !('agents' in payload) || !Array.isArray(payload.agents)) {
    throw new Error('Hermes returned an invalid agent roster');
  }
  return payload.agents.map(presentHermesAgent);
}

export async function loadHermesSkills(): Promise<HermesSkill[]> {
  const response = await fetch('/api/hermes/skills', { headers: { Accept: 'application/json' } });
  const payload = (await response.json().catch(() => null)) as HermesSkillsPayload | { error?: unknown } | null;
  if (!response.ok) {
    const detail = payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Hermes skills returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (payload === null || !('skills' in payload) || !Array.isArray(payload.skills)) {
    throw new Error('Hermes returned an invalid skill roster');
  }
  return payload.skills;
}

export async function loadHermesHistory(
  agentId: string,
  signal?: AbortSignal,
  jobId?: string,
): Promise<HermesAgentHistory> {
  const query = new URLSearchParams({ limit: '20' });
  if (jobId !== undefined) query.set('jobId', jobId);
  const response = await fetch(`/api/hermes/agents/${encodeURIComponent(agentId)}/runs?${query}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const detail = typeof payload?.error === 'string'
      ? payload.error
      : `Hermes history returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as unknown as HermesAgentHistory;
}
