export type Channel = 'sms' | 'email' | 'call' | 'form';

export interface Nba {
  id: string;
  label: string;
}

/** What this person IS to the business — not everyone is a lead. */
export type PersonRole =
  | 'lead'
  | 'customer'
  | 'applicant'
  | 'contractor'
  | 'supplier'
  | 'employee'
  | 'painter'
  | 'other'
  | 'client'
  | 'vendor';

export interface Person {
  id: string;
  name: string;
  company?: string;
  role: PersonRole;
  kind: 'residential' | 'commercial';
  note: string;
  tags: string[];
  suggestedTags: string[];
  nbas: Nba[];
  /** Live Board ordering and canonical review state. */
  boardVisible?: boolean;
  boardOrder?: number;
  needsAttention?: boolean;
  urgency?: string | null;
  urgencyColor?: string | null;
  recentSignalCount?: number;
}

export interface SignalRecommendation {
  id: string;
  kind: 'action' | 'reminder' | 'automation';
  label: string;
  reason: string;
  confidence: number;
  capabilityKey: string | null;
  actionDefinitionKey: string | null;
  actionDefinitionVersion: number | null;
  available: boolean;
  locked: boolean;
}

export interface SignalDetail {
  signal: Signal | null;
  recommendations: SignalRecommendation[];
  history: Signal[];
  historyNextCursor: string | null;
  attachments: SignalAttachment[];
  transcript: SignalTranscript | null;
  loading: boolean;
  error: string | null;
}

export interface SignalAttachment {
  attachmentKey: string;
  filename: string;
  mimeType: string | null;
  status: string;
  extractedText: string | null;
}

export interface SignalTranscript {
  status: string;
  text: string | null;
  dialogue: unknown;
  updatedAt: number | null;
}

export interface Signal {
  id: string;
  personId: string;
  channel: Channel;
  at: number;
  text: string;
  /** Immutable provider body retained for audit and parser upgrades. */
  rawText?: string | null;
  /** Reply history separated by the versioned ingestion parser. */
  quotedText?: string | null;
  signatureText?: string | null;
  hasQuotedContent?: boolean;
  threadMessageCount?: number;
  requiresReply: boolean;
  title?: string;
  source?: 'gmail' | 'quo';
  eventType?: string;
  direction?: 'inbound' | 'outbound';
  actorEmail?: string | null;
  actorPhone?: string | null;
  identityResolution?: {
    status: 'conflict' | 'unresolved';
    displayName: string | null;
    displayValue: string | null;
    reason: string;
  } | null;
  topic?: string | null;
  topicColor?: string | null;
  urgency?: string | null;
  urgencyColor?: string | null;
  reviewStatus?: 'pending' | 'action_open' | 'settled';
  reviewResolution?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: number | null;
  isAutomated?: boolean;
  attachmentCount?: number;
}

export interface Reminder {
  id: string;
  personId: string;
  note: string;
  createdAt: number;
  dueAt: number;
  sourceSignalId: string | null;
  /** short label of where it came from, e.g. "SMS · Quo" */
  sourceLabel: string;
  doneAt: number | null;
  snoozedUntil: number;
  bornLive: boolean;
}

export type ActionKind = 'reply' | 'reminder' | 'nudge' | 'task';

/** One agent execution of an action: dispatched → running → ok/fail/review. */
export interface AgentRun {
  agent: string;
  status: 'running' | 'ok' | 'fail' | 'review';
  startedAt: number;
  resolveAt: number;
  /** decided at dispatch, applied when resolveAt passes */
  outcome: 'ok' | 'fail' | 'review';
  /** outcome detail once resolved ('' while running) */
  note: string;
  /** follow-up the agent recommends after success */
  rec: string | null;
  recTaken: boolean;
}

export interface ActionCard {
  id: string;
  kind: ActionKind;
  personId: string;
  sourceSignalId: string | null;
  reminderId: string | null;
  title: string;
  createdAt: number;
  snoozedUntil: number;
  status?: ActionInstanceStatus;
  reason?: string;
  recipient?: string;
  subject?: string;
  draftBody?: string | null;
  draftRevision?: number;
  lastError?: string | null;
  simulatedAt?: number | null;
  actionDefinitionKey?: string | null;
}

export type ActionInstanceStatus =
  | 'drafting'
  | 'awaiting_approval'
  | 'simulated'
  | 'failed'
  | 'completed_external'
  | 'dismissed';

export interface ActionEvent {
  id: number;
  event_type: string;
  actor_type: 'system' | 'hermes' | 'user';
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ActionDetail {
  action: ActionCard | null;
  sourceSignal: Signal | null;
  events: ActionEvent[];
  loading: boolean;
  error: string | null;
}

export interface LogEntry {
  id: string;
  at: number;
  personId: string | null;
  text: string;
}

export type AutoRule = 'reply' | 'reminder' | 'stale' | 'capture';

export interface AutoEvent {
  id: string;
  at: number;
  rule: AutoRule;
  text: string;
  personId: string | null;
}

export type StepKind = 'email' | 'sms' | 'call' | 'task';

export interface SeqStep {
  day: number; // days after enrollment
  kind: StepKind;
  label: string;
}

/** An account-level playbook: a trigger enrolls a person, then steps fire over days. */
export interface Sequence {
  id: string;
  name: string;
  trigger: string;
  steps: SeqStep[];
  enabled: boolean;
}

export interface SeqInstance {
  id: string;
  seqId: string;
  personId: string;
  startedAt: number;
  stepIdx: number; // next step to execute; === steps.length when finished
  nextAt: number;
  doneAt: number | null;
  lastStep: { label: string; at: number } | null;
  triggerText: string;
}

export interface ScriptedEvent {
  at: number;
  signal: Signal;
  reminder?: { note: string; dueInMs: number };
  fired: boolean;
}

export interface State {
  booted: boolean;
  now: number;
  startedAt: number;
  paused: boolean;
  focusId: string | null;
  people: Person[];
  signals: Signal[]; // ascending by `at`
  reminders: Reminder[];
  actions: ActionCard[]; // open action cards, newest first
  runs: Record<string, AgentRun>; // action id -> its agent run
  completed: Record<string, number>; // action id -> completedAt (prevents resurrection)
  handled: { a: ActionCard; at: number }[]; // completed actions stay visible, newest first
  log: LogEntry[];
  script: ScriptedEvent[];
  nextRandomAt: number;
  autoEnabled: Record<AutoRule, boolean>;
  autoRuns: Record<AutoRule, number>;
  autoTrace: AutoEvent[];
  sequences: Sequence[];
  seqInstances: SeqInstance[];
  boardSummary?: { signalsToday: number; openActions: number; remindersDue: number };
  signalDetails?: Record<string, SignalDetail>;
  actionDetails?: Record<string, ActionDetail>;
}
