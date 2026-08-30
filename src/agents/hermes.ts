// Everything here is served by the fluid-history plugin running inside Hermes.
// Fluid cannot call Hermes' native API (it needs an interactive Nous login), so
// a field missing from the UI usually means the plugin does not return it yet.
// See hermes/fluid-history/DEPLOY.md before changing this contract.

export interface HermesStatus {
  connected: boolean;
  version: string | null;
  gatewayState: string;
  activeAgents: number;
  profiles: string[];
  checkedAt: string;
}

export interface HermesAgentSource {
  prompt: string | null;
  promptTruncated: boolean;
  skills: string[];
  script: string | null;
  workdir: string | null;
  model: string | null;
  timeoutSeconds: number | null;
  definitionHash: string | null;
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
  runtimeMode: 'agent' | 'script';
  steps: string[];
  enabled: boolean;
  state: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  historyAgentId: string | null;
  contractStatus: string;
  source: 'hermes' | 'fluid';
  historyAvailable: boolean;
  /** Null when the deployed Hermes plugin predates definition passthrough. */
  definition: HermesAgentSource | null;
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
  definition: unknown;
}

function presentAgentSource(value: unknown): HermesAgentSource | null {
  if (value === null || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  return {
    prompt: typeof source.prompt === 'string' && source.prompt.trim() !== '' ? source.prompt : null,
    promptTruncated: source.promptTruncated === true,
    skills: Array.isArray(source.skills)
      ? source.skills.filter((skill): skill is string => typeof skill === 'string')
      : [],
    script: typeof source.script === 'string' ? source.script : null,
    workdir: typeof source.workdir === 'string' ? source.workdir : null,
    model: typeof source.model === 'string' ? source.model : null,
    timeoutSeconds: typeof source.timeoutSeconds === 'number' ? source.timeoutSeconds : null,
    definitionHash: typeof source.definitionHash === 'string' ? source.definitionHash : null,
  };
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
    runtimeMode: agent.mode,
    steps: contract?.steps ?? [],
    historyAgentId: null,
    source: 'hermes',
    historyAvailable: true,
    definition: presentAgentSource(agent.definition),
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
  /** SKILL.md body. Null when the deployed plugin predates instruction passthrough. */
  instructions: string | null;
  instructionsPath: string | null;
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

export async function loadHermesSchedules(): Promise<HermesAgentDefinition[]> {
  const response = await fetch('/api/hermes/schedules', { headers: { Accept: 'application/json' } });
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

export async function loadHermesAgents(): Promise<HermesAgentDefinition[]> {
  const schedules = await loadHermesSchedules();
  return schedules.filter((schedule) => schedule.runtimeMode === 'agent');
}

export async function changeHermesAgent(
  agent: Pick<HermesAgentDefinition, 'id' | 'profile'>,
  action: 'pause' | 'resume' | 'delete',
): Promise<void> {
  const endpoint = action === 'delete'
    ? `/api/hermes/agents/${encodeURIComponent(agent.id)}?profile=${encodeURIComponent(agent.profile)}`
    : `/api/hermes/agents/${encodeURIComponent(agent.id)}/${action}`;
  const response = await fetch(endpoint, {
    method: action === 'delete' ? 'DELETE' : 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: action === 'delete' ? undefined : JSON.stringify({ profile: agent.profile }),
  });
  const payload = (await response.json().catch(() => null)) as { detail?: unknown; error?: unknown } | null;
  if (!response.ok) {
    const detail = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error
        : `Hermes ${action} returned HTTP ${response.status}`;
    throw new Error(detail);
  }
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
  return payload.skills.map((skill) => ({
    ...skill,
    instructions: typeof skill.instructions === 'string' && skill.instructions.trim() !== ''
      ? skill.instructions
      : null,
    instructionsPath: typeof skill.instructionsPath === 'string' ? skill.instructionsPath : null,
  }));
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
