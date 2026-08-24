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
  name: string;
  icon: string;
  description: string;
  schedule: string;
  profile: string;
  mode: string;
  steps: string[];
}

export const HERMES_AGENTS: HermesAgentDefinition[] = [
  {
    id: 'email-categorizer',
    name: 'Email Categorizer',
    icon: '✉️',
    description: 'Categorizes incoming Gmail signals in Fluid and records attachment evidence without changing Gmail.',
    schedule: 'Every 5 minutes',
    profile: 'default',
    mode: 'Agent-assisted',
    steps: [
      'Claim new Gmail signals from the durable Supabase queue',
      'Read the signal and selectively extract relevant attachment text',
      'Choose one enabled Fluid label with confidence and evidence',
      'Save the result and audit record in Supabase without writing to Gmail',
    ],
  },
  {
    id: 'contractor-invoices',
    name: 'Contractor Invoices',
    icon: '🧾',
    description: 'Processes contractor invoice evidence for the operations workflow.',
    schedule: 'Every 5 hours',
    profile: 'default',
    mode: 'Scheduled automation',
    steps: [
      'Find new contractor invoice emails and attachments',
      'Extract the contractor, job, amount, and invoice date',
      'Match the evidence to the operations workflow',
      'Flag anything uncertain for human review',
    ],
  },
  {
    id: 'dripjobs-operations',
    name: 'DripJobs Operations',
    icon: '🛠️',
    description: 'Synchronizes DripJobs sales and job data into the business workspace.',
    schedule: 'Daily at 6:00 AM',
    profile: 'default',
    mode: 'Scheduled automation',
    steps: [
      'Connect to the DripJobs workspace',
      'Collect updated leads, jobs, and sales records',
      'Normalize the records for the Fluid workspace',
      'Save the sync result and report any failures',
    ],
  },
  {
    id: 'meta-ads-reporter',
    name: 'Meta Ads Reporter',
    icon: '📈',
    description: 'Refreshes campaign data and prepares the daily leads and CPL report.',
    schedule: 'Daily + every 4 hours',
    profile: 'default',
    mode: 'Agent + scheduled sync',
    steps: [
      'Refresh the latest Meta campaign performance',
      'Calculate leads and cost per lead',
      'Compare results across active campaigns',
      'Prepare the daily performance brief',
    ],
  },
];

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

export async function loadHermesHistory(
  agentId: string,
  signal?: AbortSignal,
): Promise<HermesAgentHistory> {
  const response = await fetch(`/api/hermes/agents/${encodeURIComponent(agentId)}/runs?limit=20`, {
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
