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
}

const AGENT_PRESENTATIONS: AgentPresentation[] = [
  {
    match: /fluid email categorizer/i,
    name: 'Email Categorizer',
    icon: '✉️',
    description: 'Categorizes incoming Gmail signals in Fluid and records attachment evidence without changing Gmail.',
    mode: 'Agent-assisted',
  },
  {
    match: /fluid customer sync/i,
    name: 'Customer Sync',
    icon: '👥',
    description: 'Syncs customers from Ottawa Painters Admin to Fluid.',
    mode: 'Scheduled sync',
  },
  {
    match: /contractor invoice sync/i,
    name: 'Contractor Invoices',
    icon: '🧾',
    description: 'Imports explicit contractor invoice details or defers the invoice for manual review without changing Gmail.',
    mode: 'Scheduled automation',
  },
  {
    match: /daily dripjobs/i,
    name: 'DripJobs Job Sync',
    icon: '🛠️',
    description: 'Exports active and archived DripJobs jobs, then updates exact-matched amounts and production months.',
    mode: 'Script-only automation',
  },
  {
    match: /daily meta ads leads and cpl/i,
    name: 'Meta Ads Daily Report',
    icon: '📈',
    description: 'Analyzes Meta Ads results and sends a brief executive Slack update without modifying ads.',
    mode: 'Scheduled report',
  },
  {
    match: /daily meta ads backend sync/i,
    name: 'Meta Ads Backend Sync',
    icon: '↻',
    description: 'Refreshes the rolling Meta Ads campaign window in the Ottawa Painters backend.',
    mode: 'Script-only automation',
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
    steps: [],
    historyAgentId: null,
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
