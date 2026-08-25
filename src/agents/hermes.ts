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
  contractStatus: string;
}

interface HermesAgentContract {
  schemaVersion: number;
  displayName: string;
  summary: string;
  steps: string[];
  icon: string | null;
  definitionHash: string;
  createdAt: string | null;
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
  contract: HermesAgentContract | null;
  contractStatus: string;
}

interface HermesAgentsPayload {
  agents: HermesAgentRecord[];
  fetchedAt: string;
}

export function presentHermesAgent(agent: HermesAgentRecord): HermesAgentDefinition {
  const contract = agent.contractStatus === 'verified' ? agent.contract : null;
  const unavailableDescription = agent.contractStatus === 'stale'
    ? 'The live Hermes definition changed. Its presentation contract needs regeneration.'
    : 'Live Hermes job. Verified presentation details are not available yet.';
  return {
    ...agent,
    runtimeName: agent.name,
    name: contract?.displayName ?? agent.name,
    icon: contract?.icon ?? (agent.mode === 'script' ? '⚙️' : '🤖'),
    description: contract?.summary ?? unavailableDescription,
    mode: agent.mode === 'script' ? 'Script-only automation' : 'Hermes agent',
    steps: contract?.steps ?? [],
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
