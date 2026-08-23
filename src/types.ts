export type Channel = 'sms' | 'email' | 'call' | 'form';

export interface Nba {
  id: string;
  label: string;
}

/** What this person IS to the business — not everyone is a lead. */
export type PersonRole = 'lead' | 'client' | 'vendor';

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
}

export interface Signal {
  id: string;
  personId: string;
  channel: Channel;
  at: number;
  text: string;
  requiresReply: boolean;
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
}
