export type Channel = 'sms' | 'email' | 'call' | 'form';

export type PipelineStage =
  | 'cold_lead'
  | 'warm_lead'
  | 'estimate_requested'
  | 'estimate_scheduled'
  | 'in_draft'
  | 'proposal_sent'
  | 'proposal_on_hold_short'
  | 'proposal_on_hold_long'
  | 'exterior_sales'
  | 'closed_with_appointment'
  | 'closed_without_appointment'
  | 'unmapped';

/**
 * Touches after the strongest real boundary Fluid has for the current phase.
 * A real stage-change wins; otherwise lifecycle milestones and finally the
 * DripJobs lead-created date are used. Snapshot first-seen time is never used.
 */
/** 0 nothing · 1 automated · 2 we reached out · 3 they replied */
export type PipelineTouchDay = 0 | 1 | 2 | 3;

/** Squares a board column holds, and so the most days the strip can draw. */
export const TOUCH_DAY_STRIP_MAX = 16;

export interface PipelineStageTouches {
  outbound: number;
  inbound: number;
  automated: number;
  lastAt: number | null;
  lastDirection: 'inbound' | 'outbound' | null;
  phase: string;
  phaseLabel: string;
  phaseStartedAt: number | null;
  evidenceKind: PipelineEvidenceKind;
  /** One cell a day from the real phase boundary; today is last. */
  days: PipelineTouchDay[];
  /** Phase days older than the strip can show, dropped off its left edge. */
  daysBefore: number;
}

export interface PipelineDeal {
  id: string;
  /** Required canonical Contact. A deal without one is invalid CRM data. */
  personId: string;
  personMatchCount: number;
  customerName: string;
  email: string | null;
  phone: string | null;
  dealName: string;
  stage: string;
  status: string;
  label: string | null;
  source: string | null;
  amountCents: number;
  lastChange: string | null;
  dealAge: string | null;
  salesperson: string | null;
  capturedAt: number;
  /** When the lead actually arrived, from DripJobs deal age or first sight. */
  receivedAt: number | null;
  stageEnteredAt: number | null;
  stageObservedAt: number | null;
  /** Latest linked customer signal, independent of the Board's paginated Signal feed. */
  latestSignalAt: number | null;
  stageTouches: PipelineStageTouches;
  archived: boolean;
  archivedAt: number | null;
  archiveBucket: 'cold_lead' | 'estimate_scheduled' | 'proposal_sent' | 'closed_with_appointment' | 'closed_without_appointment' | null;
}

export interface PipelineSyncHealth {
  cadence: 'daily';
  lastSucceededAt: number | null;
  status: 'healthy' | 'stale' | 'unhealthy' | 'missing';
  stale: boolean;
  unhealthy: boolean;
}

export interface PipelineStageEvent {
  id: number;
  eventKind: 'baseline' | 'stage_changed' | 'archived' | 'reactivated';
  fromStage: string | null;
  toStage: string | null;
  effectiveAt: number;
  observedAt: number;
  source: 'baseline' | 'zapier' | 'snapshot' | 'api' | 'webhook' | 'report_import';
  evidenceKind: PipelineEvidenceKind;
  durationSeconds: number | null;
  baseline: boolean;
}

export type PipelineEvidenceKind = 'exact' | 'observed' | 'inferred' | 'unknown';

export interface PipelineTouchpointMetrics {
  total: number;
  outboundCallAttempts: number;
  connectedCalls: number;
  missedInboundCalls: number;
  inboundSms: number;
  outboundSms: number;
  inboundEmails: number;
  outboundEmails: number;
  milestones: number;
}

export interface PipelineTouchpoint {
  id: string;
  kind: 'activity' | 'milestone';
  activityId: number | null;
  milestoneId: number | null;
  source: string;
  eventType: string;
  channel: 'call' | 'sms' | 'email' | 'milestone' | 'other';
  direction: 'inbound' | 'outbound' | null;
  occurredAt: number;
  subject: string;
  preview: string;
  callStatus: string | null;
  durationSeconds: number | null;
  isAutomated: boolean;
  transcriptStatus: 'pending' | 'available' | 'unavailable' | 'failed' | null;
  transcriptExcerpt: string | null;
  attributionMethod: 'provider_deal_id' | 'unique_stage_window' | 'single_deal_contact' | 'deal_date_window' | 'contact_history' | 'manual';
  evidenceKind: PipelineEvidenceKind;
}

export interface PipelineStageOutcome {
  kind: 'current' | 'stage_changed' | 'archived';
  toStage: string | null;
  at: number | null;
}

export interface PipelineStageWindow {
  stageEventId: number;
  stage: string;
  enteredAt: number;
  exitedAt: number | null;
  durationSeconds: number;
  evidenceKind: PipelineEvidenceKind;
  outcome: PipelineStageOutcome;
  metrics: PipelineTouchpointMetrics;
  touchpoints: PipelineTouchpoint[];
}

export interface PipelineUnknownStage {
  label: string;
  metrics: PipelineTouchpointMetrics;
  touchpoints: PipelineTouchpoint[];
}

export interface PipelinePriorHistory {
  label: string;
  total: number;
  returnedCount: number;
  truncated: boolean;
  earliestAt: number | null;
  latestAt: number | null;
  metrics: PipelineTouchpointMetrics;
  touchpoints: PipelineTouchpoint[];
}

export interface PipelineAttributionSummary {
  attributedActivityCount: number;
  manualActivityCount: number;
  unassignedActivityCount: number;
}

export interface PipelineStageHistory {
  dealId: string;
  dealCreatedAt: number | null;
  dealCreatedEvidenceKind: PipelineEvidenceKind;
  dealCreatedLabel: string;
  dealCreatedMethod: string | null;
  dealCreatedConfidence: number | null;
  currentStage: string | null;
  stageEnteredAt: number | null;
  items: PipelineStageEvent[];
  stages: PipelineStageWindow[];
  unknownStage: PipelineUnknownStage;
  /** Contact history before this deal began; context only, never deal attribution. */
  priorHistory: PipelinePriorHistory;
  attribution: PipelineAttributionSummary;
  touchpointsTruncated: boolean;
  returnedTouchpointCount: number;
}

export interface Nba {
  id: string;
  label: string;
}

/** What this person is to the business. Sales contacts use the canonical lead role. */
export type PersonRole =
  | 'lead'
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
  latestSignalAt?: number | null;
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
  recordings: SignalRecordings | null;
  callSummary: SignalCallSummary | null;
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

export interface SignalRecordingItem {
  id: string | null;
  url: string;
  type: string | null;
  duration: number | null;
  startTime: string | null;
  status: string | null;
}

export interface SignalRecordings {
  status: string;
  items: SignalRecordingItem[];
  unavailableReason: string | null;
  updatedAt: number | null;
}

export interface SignalCallSummary {
  status: string;
  summary: string[];
  nextSteps: string[];
  jobs: unknown;
  unavailableReason: string | null;
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

export interface ActionCard {
  id: string;
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

export interface State {
  booted: boolean;
  now: number;
  focusId: string | null;
  people: Person[];
  signals: Signal[]; // ascending by `at`
  reminders: Reminder[];
  actions: ActionCard[]; // open action cards, newest first
  signalDetails?: Record<string, SignalDetail>;
  actionDetails?: Record<string, ActionDetail>;
}
