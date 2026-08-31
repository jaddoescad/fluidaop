import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Act } from './contract';
import { apiJson as json, isRecord } from '../lib/api';
import {
  ActionCard,
  ActionDetail,
  Person,
  PersonRole,
  PipelineDeal,
  PipelineEvidenceKind,
  PipelineStageHistory,
  PipelineSyncHealth,
  PipelineTouchDay,
  PipelineTouchpointMetrics,
  Reminder,
  TOUCH_DAY_STRIP_MAX,
  Signal,
  SignalAttachment,
  SignalCallSummary,
  SignalDetail,
  SignalRecordings,
  SignalRecommendation,
  SignalTranscript,
  State,
} from '../types';

interface ApiPerson {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  entityType: 'person' | 'business';
  roles: string[];
  needsAttention: boolean;
  pendingRecommendationCount: number;
  recentSignalCount: number;
  latestActivityAt: string | null;
  urgency: string | null;
}

interface ApiPipelineDeal {
  id: string;
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
  capturedAt: string;
  receivedAt?: string | null;
  stageEnteredAt: string | null;
  stageObservedAt: string | null;
  latestSignalAt: string | null;
  stageTouches?: {
    outbound?: number;
    inbound?: number;
    automated?: number;
    reactions?: number;
    lastAt?: string | null;
    lastDirection?: 'inbound' | 'outbound' | null;
    phase?: string;
    phaseLabel?: string;
    phaseStartedAt?: string | null;
    evidenceKind?: PipelineEvidenceKind;
    days?: unknown;
    daysBefore?: unknown;
  } | null;
  archived?: boolean;
  archivedAt?: string | null;
  archiveBucket?: 'cold_lead' | 'estimate_scheduled' | 'proposal_sent' | 'closed_with_appointment' | 'closed_without_appointment' | null;
}

interface ApiArchivedPipelineResponse {
  count: number;
  monthCounts: Record<string, number>;
  bucketCounts: Record<'cold_lead' | 'estimate_scheduled' | 'proposal_sent' | 'closed_with_appointment' | 'closed_without_appointment', number>;
  items: ApiPipelineDeal[];
  nextCursor: string | null;
}

interface ApiPipelineResponse {
  count: number;
  capturedAt: string | null;
  sync: {
    cadence: 'daily';
    lastSucceededAt: string | null;
    status: PipelineSyncHealth['status'];
    stale: boolean;
    unhealthy: boolean;
  };
  items: ApiPipelineDeal[];
}

interface ApiPipelineStageHistory {
  dealId: string;
  dealCreatedAt?: string | null;
  dealCreatedEvidenceKind?: PipelineEvidenceKind;
  dealCreatedLabel?: string;
  dealCreatedMethod?: string | null;
  dealCreatedConfidence?: number | null;
  currentStage: string | null;
  stageEnteredAt: string | null;
  items: Array<{
    id: number;
    eventKind: 'baseline' | 'stage_changed' | 'archived' | 'reactivated';
    fromStage: string | null;
    toStage: string | null;
    effectiveAt: string;
    observedAt: string;
    source: 'baseline' | 'zapier' | 'snapshot' | 'api' | 'webhook' | 'report_import';
    evidenceKind?: PipelineEvidenceKind;
    durationSeconds: number | null;
    baseline: boolean;
  }>;
  stages?: Array<{
    stageEventId: number;
    stage: string;
    enteredAt: string;
    exitedAt: string | null;
    durationSeconds: number;
    evidenceKind: PipelineEvidenceKind;
    outcome: {
      kind: 'current' | 'stage_changed' | 'archived';
      toStage: string | null;
      at: string | null;
    };
    metrics: PipelineTouchpointMetrics;
    touchpoints: ApiPipelineTouchpoint[];
  }>;
  unknownStage?: {
    label: string;
    metrics: PipelineTouchpointMetrics;
    touchpoints: ApiPipelineTouchpoint[];
  };
  priorHistory?: {
    label: string;
    total: number;
    returnedCount: number;
    truncated: boolean;
    earliestAt: string | null;
    latestAt: string | null;
    metrics: PipelineTouchpointMetrics;
    touchpoints: ApiPipelineTouchpoint[];
  };
  attribution?: {
    attributedActivityCount: number;
    manualActivityCount: number;
    unassignedActivityCount: number;
  };
  touchpointsTruncated?: boolean;
  returnedTouchpointCount?: number;
}

interface ApiPipelineTouchpoint {
  id: string;
  kind: 'activity' | 'milestone';
  activityId: number | null;
  milestoneId: number | null;
  source: string;
  eventType: string;
  channel: 'call' | 'sms' | 'email' | 'milestone' | 'other';
  direction: 'inbound' | 'outbound' | null;
  occurredAt: string;
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

interface ApiContact {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
}

interface ApiLabel {
  kind: 'topic' | 'urgency';
  name: string;
  color?: string | null;
}

interface ApiCatalogLabel {
  kind: 'topic' | 'urgency';
  name: string;
  color: string;
  enabled: boolean;
}

interface ApiSignal {
  id: number;
  source: 'gmail' | 'quo';
  eventType: string;
  direction: 'inbound' | 'outbound';
  actorName: string | null;
  actorEmail: string | null;
  actorPhone: string | null;
  identityResolution?: {
    status: 'conflict' | 'unresolved';
    displayName: string | null;
    displayValue: string | null;
    reason: string;
  } | null;
  subject: string;
  preview: string;
  bodyText?: string | null;
  currentMessageText?: string | null;
  rawBodyText?: string | null;
  quotedText?: string | null;
  signatureText?: string | null;
  hasQuotedContent?: boolean;
  contentParserVersion?: string | null;
  contentParseMethod?: string | null;
  contentParseConfidence?: number | null;
  threadMessageCount?: number;
  occurredAt: string;
  actionOpen?: boolean;
  boardSortAt?: string;
  contact: ApiContact | null;
  labels?: ApiLabel[];
  attachmentCount?: number;
  isAutomated?: boolean;
  review?: {
    status: 'pending' | 'action_open' | 'settled';
    resolution: string | null;
    pendingRecommendationCount: number;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
  };
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  count?: number;
}

function isCursorPage(value: unknown): value is CursorPage<unknown> {
  return isRecord(value)
    && Array.isArray(value.items)
    && (value.nextCursor === null || typeof value.nextCursor === 'string')
    && (value.count === undefined || typeof value.count === 'number');
}

async function loadAllCursorItems<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const search = new URLSearchParams({ limit: '100' });
    if (cursor) search.set('cursor', cursor);
    const page = await json<CursorPage<T>>(`${path}?${search}`, undefined, isCursorPage as (value: unknown) => value is CursorPage<T>);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error('the server returned a repeated pagination cursor');
    if (cursor) seenCursors.add(cursor);
  } while (cursor !== null);
  return items;
}

interface ApiSignalDetail {
  signal: ApiSignal;
  recommendations: SignalRecommendation[];
  history: ApiSignal[];
  historyNextCursor: string | null;
  attachments?: SignalAttachment[];
  transcript?: Omit<SignalTranscript, 'updatedAt'> & { updatedAt?: string | null } | null;
  recordings?: Omit<SignalRecordings, 'updatedAt'> & { updatedAt?: string | null } | null;
  callSummary?: Omit<SignalCallSummary, 'updatedAt'> & { updatedAt?: string | null } | null;
}

interface ApiWorkItem {
  id: string;
  caseId: string;
  contactId: string | null;
  jobName: string;
  actionKind: string;
  title: string;
  reason: string;
  status: 'open' | 'waiting';
  owner: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ApiAction {
  id: string;
  actionDefinitionKey: string | null;
  actionDefinitionName: string;
  recommendationId: string;
  sourceSignalId: string;
  personId: string | null;
  contact: ApiContact | null;
  caseId: string | null;
  status: 'drafting' | 'awaiting_approval' | 'simulated' | 'failed' | 'completed_external' | 'dismissed';
  executionMode: 'simulation';
  title: string;
  reason: string;
  recipient: string;
  subject: string;
  draftBody: string | null;
  draftRevision: number;
  lastError: string | null;
  simulatedAt: string | null;
  completedExternalAt: string | null;
  sourceSignal: {
    id: string;
    subject: string;
    preview: string;
    bodyText: string | null;
    currentMessageText?: string | null;
    rawBodyText?: string | null;
    quotedText?: string | null;
    signatureText?: string | null;
    hasQuotedContent?: boolean;
    contentParserVersion?: string | null;
    contentParseMethod?: string | null;
    contentParseConfidence?: number | null;
    threadMessageCount?: number;
    occurredAt: string;
    actorName: string | null;
    actorEmail: string | null;
    threadId: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface ApiActionDetail { action: ApiAction; events: ActionDetail['events'] }

function roleOf(roles: string[]): PersonRole {
  const normalized = new Set(roles.map((role) => role === 'customer' ? 'lead' : role));
  const order: PersonRole[] = ['lead', 'applicant', 'contractor', 'supplier', 'employee', 'painter', 'client', 'vendor', 'other'];
  return order.find((role) => normalized.has(role)) ?? 'other';
}

function safeLabelColor(color: string | null | undefined): string | null {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

function apiPersonToPerson(
  person: ApiPerson,
  order: number,
  urgencyLabelByName: ReadonlyMap<string, { name: string; color: string }>,
): Person {
  const urgency = person.urgency
    ? urgencyLabelByName.get(person.urgency.trim().toLowerCase()) ?? null
    : null;
  const latestSignalAt = person.latestActivityAt ? Date.parse(person.latestActivityAt) : Number.NaN;
  return {
    id: person.id,
    name: person.displayName,
    company: person.entityType === 'business' ? person.displayName : undefined,
    role: roleOf(person.roles),
    kind: person.entityType === 'business' ? 'commercial' : 'residential',
    note: person.primaryEmail ?? person.primaryPhone ?? `${person.recentSignalCount} recent signals`,
    tags: [],
    suggestedTags: [],
    nbas: [],
    boardVisible: true,
    boardOrder: order,
    needsAttention: person.needsAttention,
    urgency: urgency?.name ?? null,
    urgencyColor: urgency?.color ?? null,
    recentSignalCount: person.recentSignalCount,
    latestSignalAt: Number.isFinite(latestSignalAt) ? latestSignalAt : null,
  };
}

/**
 * The strip is as long as the deal has sat in this stage, so a short array is
 * a young deal, not missing data — nothing is padded. Over-long strips keep
 * their tail: today has to stay the last cell.
 */
function touchDayStrip(days: unknown): PipelineTouchDay[] {
  if (!Array.isArray(days)) return [];
  return days.slice(-TOUCH_DAY_STRIP_MAX).map((value): PipelineTouchDay => {
    const level = Number(value);
    return level === 1 || level === 2 || level === 3 ? level : 0;
  });
}

function apiPipelineDealToDeal(deal: ApiPipelineDeal): PipelineDeal {
  if (!deal.personId) {
    throw new Error(`Pipeline deal ${deal.id} is missing its canonical Contact`);
  }
  const latestSignalAt = deal.latestSignalAt ? Date.parse(deal.latestSignalAt) : Number.NaN;
  const archivedAt = deal.archivedAt ? Date.parse(deal.archivedAt) : Number.NaN;
  const receivedAt = deal.receivedAt ? Date.parse(deal.receivedAt) : Number.NaN;
  const touchLastAt = deal.stageTouches?.lastAt ? Date.parse(deal.stageTouches.lastAt) : Number.NaN;
  const phaseStartedAt = deal.stageTouches?.phaseStartedAt
    ? Date.parse(deal.stageTouches.phaseStartedAt)
    : Number.NaN;
  return {
    ...deal,
    amountCents: Number.isSafeInteger(deal.amountCents) ? deal.amountCents : 0,
    capturedAt: Date.parse(deal.capturedAt),
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : null,
    stageEnteredAt: deal.stageEnteredAt ? Date.parse(deal.stageEnteredAt) : null,
    stageObservedAt: deal.stageObservedAt ? Date.parse(deal.stageObservedAt) : null,
    latestSignalAt: Number.isFinite(latestSignalAt) ? latestSignalAt : null,
    stageTouches: {
      outbound: Number(deal.stageTouches?.outbound ?? 0),
      // Provider tapbacks are ordinary customer replies in the CRM UI, not a
      // separate category the salesperson has to interpret.
      inbound: Number(deal.stageTouches?.inbound ?? 0) + Number(deal.stageTouches?.reactions ?? 0),
      automated: Number(deal.stageTouches?.automated ?? 0),
      lastAt: Number.isFinite(touchLastAt) ? touchLastAt : null,
      lastDirection: deal.stageTouches?.lastDirection ?? null,
      phase: deal.stageTouches?.phase ?? 'lead_received',
      phaseLabel: deal.stageTouches?.phaseLabel?.trim() || 'Lead received',
      phaseStartedAt: Number.isFinite(phaseStartedAt)
        ? phaseStartedAt
        : Number.isFinite(receivedAt) ? receivedAt : null,
      evidenceKind: deal.stageTouches?.evidenceKind ?? 'inferred',
      days: touchDayStrip(deal.stageTouches?.days),
      daysBefore: Math.max(0, Math.trunc(Number(deal.stageTouches?.daysBefore ?? 0)) || 0),
    },
    archived: deal.archived === true,
    archivedAt: Number.isFinite(archivedAt) ? archivedAt : null,
    archiveBucket: deal.archiveBucket ?? null,
  };
}

function apiPipelineHistoryToHistory(history: ApiPipelineStageHistory): PipelineStageHistory {
  const zeroMetrics: PipelineTouchpointMetrics = {
    total: 0,
    outboundCallAttempts: 0,
    connectedCalls: 0,
    missedInboundCalls: 0,
    inboundSms: 0,
    outboundSms: 0,
    inboundEmails: 0,
    outboundEmails: 0,
    milestones: 0,
  };
  const metrics = (value: PipelineTouchpointMetrics | undefined): PipelineTouchpointMetrics => ({
    total: Number(value?.total ?? 0),
    outboundCallAttempts: Number(value?.outboundCallAttempts ?? 0),
    connectedCalls: Number(value?.connectedCalls ?? 0),
    missedInboundCalls: Number(value?.missedInboundCalls ?? 0),
    inboundSms: Number(value?.inboundSms ?? 0),
    outboundSms: Number(value?.outboundSms ?? 0),
    inboundEmails: Number(value?.inboundEmails ?? 0),
    outboundEmails: Number(value?.outboundEmails ?? 0),
    milestones: Number(value?.milestones ?? 0),
  });
  const touchpoints = (items: ApiPipelineTouchpoint[] | undefined) => (items ?? []).map((item) => ({
    ...item,
    activityId: item.activityId === null ? null : Number(item.activityId),
    milestoneId: item.milestoneId === null ? null : Number(item.milestoneId),
    occurredAt: Date.parse(item.occurredAt),
    durationSeconds: item.durationSeconds === null ? null : Number(item.durationSeconds),
  }));
  return {
    dealId: history.dealId,
    dealCreatedAt: history.dealCreatedAt ? Date.parse(history.dealCreatedAt) : null,
    dealCreatedEvidenceKind: history.dealCreatedEvidenceKind ?? 'unknown',
    dealCreatedLabel: history.dealCreatedLabel ?? 'Creation date unavailable',
    dealCreatedMethod: history.dealCreatedMethod ?? null,
    dealCreatedConfidence: history.dealCreatedConfidence === null || history.dealCreatedConfidence === undefined
      ? null
      : Number(history.dealCreatedConfidence),
    currentStage: history.currentStage,
    stageEnteredAt: history.stageEnteredAt ? Date.parse(history.stageEnteredAt) : null,
    items: (history.items ?? []).map((event) => ({
      ...event,
      effectiveAt: Date.parse(event.effectiveAt),
      observedAt: Date.parse(event.observedAt),
      evidenceKind: event.evidenceKind ?? (event.source === 'zapier' || event.source === 'api' || event.source === 'webhook'
        ? 'exact'
        : event.source === 'report_import' ? 'inferred' : 'observed'),
    })),
    stages: (history.stages ?? []).map((stage) => ({
      ...stage,
      enteredAt: Date.parse(stage.enteredAt),
      exitedAt: stage.exitedAt ? Date.parse(stage.exitedAt) : null,
      durationSeconds: Number(stage.durationSeconds),
      outcome: {
        ...stage.outcome,
        at: stage.outcome.at ? Date.parse(stage.outcome.at) : null,
      },
      metrics: metrics(stage.metrics),
      touchpoints: touchpoints(stage.touchpoints),
    })),
    unknownStage: {
      label: history.unknownStage?.label ?? 'Before tracking / stage unknown',
      metrics: history.unknownStage ? metrics(history.unknownStage.metrics) : zeroMetrics,
      touchpoints: touchpoints(history.unknownStage?.touchpoints),
    },
    priorHistory: {
      label: history.priorHistory?.label ?? 'Before this deal',
      total: Number(history.priorHistory?.total ?? 0),
      returnedCount: Number(history.priorHistory?.returnedCount ?? 0),
      truncated: history.priorHistory?.truncated ?? false,
      earliestAt: history.priorHistory?.earliestAt ? Date.parse(history.priorHistory.earliestAt) : null,
      latestAt: history.priorHistory?.latestAt ? Date.parse(history.priorHistory.latestAt) : null,
      metrics: history.priorHistory ? metrics(history.priorHistory.metrics) : zeroMetrics,
      touchpoints: touchpoints(history.priorHistory?.touchpoints),
    },
    attribution: {
      attributedActivityCount: Number(history.attribution?.attributedActivityCount ?? 0),
      manualActivityCount: Number(history.attribution?.manualActivityCount ?? 0),
      unassignedActivityCount: Number(history.attribution?.unassignedActivityCount ?? 0),
    },
    touchpointsTruncated: history.touchpointsTruncated ?? false,
    returnedTouchpointCount: Number(history.returnedTouchpointCount ?? 0),
  };
}

function actorName(signal: ApiSignal): string {
  return signal.contact?.displayName ?? signal.identityResolution?.displayName ??
    signal.actorName ?? signal.actorEmail ?? signal.actorPhone ?? 'Unknown';
}

function apiSignalToSignal(signal: ApiSignal, personId?: string): Signal {
  const topic = signal.labels?.find((label) => label.kind === 'topic');
  const urgency = signal.labels?.find((label) => label.kind === 'urgency');
  return {
    id: String(signal.id),
    personId: personId ?? signal.contact?.id ?? `signal:${signal.id}`,
    channel: signal.eventType === 'call.completed' ? 'call' : signal.source === 'gmail' ? 'email' : 'sms',
    at: Date.parse(signal.occurredAt),
    text: signal.currentMessageText?.trim() || signal.bodyText?.trim() || signal.preview || signal.subject || '(no message text)',
    rawText: signal.rawBodyText ?? signal.bodyText ?? null,
    quotedText: signal.quotedText ?? null,
    signatureText: signal.signatureText ?? null,
    hasQuotedContent: signal.hasQuotedContent ?? Boolean(signal.quotedText),
    threadMessageCount: signal.threadMessageCount,
    requiresReply: signal.review?.status === 'pending',
    title: signal.subject,
    source: signal.source,
    eventType: signal.eventType,
    direction: signal.direction,
    actorEmail: signal.contact?.primaryEmail ?? signal.actorEmail,
    actorPhone: signal.contact?.primaryPhone ?? signal.actorPhone,
    identityResolution: signal.identityResolution ?? null,
    topic: topic?.name ?? null,
    topicColor: safeLabelColor(topic?.color),
    urgency: urgency?.name ?? null,
    urgencyColor: safeLabelColor(urgency?.color),
    reviewStatus: signal.review?.status ?? 'settled',
    reviewResolution: signal.review?.resolution ?? null,
    reviewedBy: signal.review?.reviewedBy ?? null,
    reviewedAt: signal.review?.reviewedAt ? Date.parse(signal.review.reviewedAt) : null,
    isAutomated: signal.isAutomated ?? false,
    attachmentCount: signal.attachmentCount ?? 0,
  };
}

function hiddenActor(signal: ApiSignal): Person {
  return {
    id: signal.contact?.id ?? `signal:${signal.id}`,
    name: actorName(signal),
    role: 'other',
    kind: 'residential',
    note: signal.actorEmail ?? signal.actorPhone ?? '',
    tags: [],
    suggestedTags: [],
    nbas: [],
    boardVisible: false,
  };
}

function workPerson(work: ApiWorkItem): Person {
  return {
    id: work.contactId ?? `case:${work.caseId}`,
    name: work.jobName,
    role: 'other',
    kind: 'residential',
    note: work.reason,
    tags: [],
    suggestedTags: [],
    nbas: [],
    boardVisible: false,
  };
}

function actionPerson(action: ApiAction): Person {
  return {
    id: action.personId ?? `signal:${action.sourceSignalId}`,
    name: action.contact?.displayName ?? action.recipient,
    role: 'lead',
    kind: 'residential',
    note: action.recipient,
    tags: [],
    suggestedTags: [],
    nbas: [],
    boardVisible: false,
  };
}

function apiActionToAction(action: ApiAction): ActionCard {
  return {
    id: action.id,
    personId: action.personId ?? `signal:${action.sourceSignalId}`,
    sourceSignalId: action.sourceSignalId,
    reminderId: null,
    title: action.title,
    createdAt: Date.parse(action.createdAt),
    snoozedUntil: 0,
    status: action.status,
    reason: action.reason,
    recipient: action.recipient,
    subject: action.subject,
    draftBody: action.draftBody,
    draftRevision: action.draftRevision,
    lastError: action.lastError,
    simulatedAt: action.simulatedAt ? Date.parse(action.simulatedAt) : null,
    actionDefinitionKey: action.actionDefinitionKey,
  };
}

function apiWorkToReminder(work: ApiWorkItem): Reminder {
  return {
    id: work.id,
    personId: work.contactId ?? `case:${work.caseId}`,
    note: work.title,
    createdAt: Date.parse(work.createdAt),
    dueAt: work.dueAt ? Date.parse(work.dueAt) : Number.MAX_SAFE_INTEGER,
    sourceSignalId: null,
    sourceLabel: 'User-created',
    doneAt: null,
    snoozedUntil: 0,
    bornLive: false,
  };
}

export interface LiveBoardController {
  s: State;
  act: Act;
  error: string | null;
  peopleHasMore: boolean;
  peopleCount: number;
  signalsHasMore: boolean;
  peopleLoading: boolean;
  signalsLoading: boolean;
  pipelineDeals: PipelineDeal[];
  pipelineCapturedAt: number | null;
  pipelineSync: PipelineSyncHealth | null;
  pipelineLoading: boolean;
  archivedPipelineCount: number;
  archivedPipelineMonthCounts: Record<string, number>;
  archivedPipelineBucketCounts: Record<'cold_lead' | 'estimate_scheduled' | 'proposal_sent' | 'closed_with_appointment' | 'closed_without_appointment', number>;
  archivedPipelineHasMore: boolean;
  archivedPipelineLoading: boolean;
  pipelineHistories: Record<string, PipelineStageHistory>;
  pipelineHistoryLoadingId: string | null;
  loadMorePeople: () => Promise<void>;
  loadMoreSignals: () => Promise<void>;
  loadMoreArchivedPipeline: () => Promise<void>;
  filterArchivedPipeline: (receivedMonth: string | null) => Promise<void>;
  openSignal: (id: string, personIdHint?: string) => Promise<void>;
  openAction: (id: string) => Promise<void>;
  openPipelineHistory: (dealId: string) => Promise<void>;
  loadMoreHistory: (id: string) => Promise<void>;
  retry: () => Promise<void>;
}

export function useLiveBoard(): LiveBoardController {
  const [booted, setBooted] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [apiPeople, setApiPeople] = useState<ApiPerson[]>([]);
  const [peopleCount, setPeopleCount] = useState(0);
  const [apiSignals, setApiSignals] = useState<ApiSignal[]>([]);
  const [apiPipelineDeals, setApiPipelineDeals] = useState<ApiPipelineDeal[]>([]);
  const [apiArchivedPipelineDeals, setApiArchivedPipelineDeals] = useState<ApiPipelineDeal[]>([]);
  const [archivedPipelineCount, setArchivedPipelineCount] = useState(0);
  const [archivedPipelineMonthCounts, setArchivedPipelineMonthCounts] = useState<Record<string, number>>({});
  const [archivedPipelineBucketCounts, setArchivedPipelineBucketCounts] = useState({
    cold_lead: 0,
    estimate_scheduled: 0,
    proposal_sent: 0,
    closed_with_appointment: 0,
    closed_without_appointment: 0,
  });
  const [archivedPipelineCursor, setArchivedPipelineCursor] = useState<string | null>(null);
  const [archivedPipelineLoading, setArchivedPipelineLoading] = useState(false);
  const archivedPipelineCursorRef = useRef<string | null>(null);
  const archivedPipelineMonthRef = useRef<string | null>(null);
  const archivedPipelineRequestRef = useRef<string | null>(null);
  const archivedPipelineRevisionRef = useRef(0);
  const [pipelineCapturedAt, setPipelineCapturedAt] = useState<number | null>(null);
  const [pipelineSync, setPipelineSync] = useState<PipelineSyncHealth | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineHistories, setPipelineHistories] = useState<Record<string, PipelineStageHistory>>({});
  const [pipelineHistoryLoadingId, setPipelineHistoryLoadingId] = useState<string | null>(null);
  const [apiLabels, setApiLabels] = useState<ApiCatalogLabel[]>([]);
  const [apiActions, setApiActions] = useState<ApiAction[]>([]);
  const [apiReminders, setApiReminders] = useState<ApiWorkItem[]>([]);
  const [peopleCursor, setPeopleCursor] = useState<string | null>(null);
  const [signalsCursor, setSignalsCursor] = useState<string | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [details, setDetails] = useState<Record<string, SignalDetail>>({});
  const [actionDetails, setActionDetails] = useState<Record<string, ActionDetail>>({});
  const [error, setError] = useState<string | null>(null);
  const requestRevision = useRef(0);

  const loadLabels = useCallback(async () => {
    const payload = await json<{ labels: ApiCatalogLabel[] }>('/api/labels');
    setApiLabels(payload.labels);
  }, []);

  const loadCreatedWork = useCallback(async () => {
    const [actions, reminders] = await Promise.all([
      loadAllCursorItems<ApiAction>('/api/board/actions'),
      loadAllCursorItems<ApiWorkItem>('/api/board/reminders'),
    ]);
    setApiActions(actions);
    setApiReminders(reminders);
  }, []);

  const loadPipeline = useCallback(async () => {
    setPipelineLoading(true);
    try {
      const payload = await json<ApiPipelineResponse>('/api/board/pipeline');
      setApiPipelineDeals(payload.items);
      setPipelineCapturedAt(payload.capturedAt ? Date.parse(payload.capturedAt) : null);
      setPipelineSync({
        ...payload.sync,
        lastSucceededAt: payload.sync.lastSucceededAt ? Date.parse(payload.sync.lastSucceededAt) : null,
      });
    } finally {
      setPipelineLoading(false);
    }
  }, []);

  const loadArchivedPipeline = useCallback(async (append: boolean) => {
    const cursor = append ? archivedPipelineCursorRef.current : null;
    if (append && !cursor) return;
    const month = archivedPipelineMonthRef.current;
    const revision = archivedPipelineRevisionRef.current;
    const requestKey = `${revision}:${cursor ?? 'first'}`;
    if (archivedPipelineRequestRef.current === requestKey) return;
    archivedPipelineRequestRef.current = requestKey;
    setArchivedPipelineLoading(true);
    try {
      const payload = await json<ApiArchivedPipelineResponse>(
        `/api/board/pipeline?archived=true&limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${month ? `&receivedMonth=${encodeURIComponent(month)}` : ''}`,
      );
      if (revision !== archivedPipelineRevisionRef.current) return;
      setApiArchivedPipelineDeals((current) => append
        ? [...current, ...payload.items.filter((item) => !current.some((existing) => existing.id === item.id))]
        : payload.items);
      setArchivedPipelineCount(payload.count);
      setArchivedPipelineMonthCounts(payload.monthCounts ?? {});
      setArchivedPipelineBucketCounts(payload.bucketCounts);
      setArchivedPipelineCursor(payload.nextCursor);
      archivedPipelineCursorRef.current = payload.nextCursor;
    } finally {
      if (archivedPipelineRequestRef.current === requestKey) {
        archivedPipelineRequestRef.current = null;
        setArchivedPipelineLoading(false);
      }
    }
  }, []);

  const filterArchivedPipeline = useCallback(async (receivedMonth: string | null) => {
    if (receivedMonth === archivedPipelineMonthRef.current) return;
    archivedPipelineMonthRef.current = receivedMonth;
    archivedPipelineRevisionRef.current += 1;
    archivedPipelineCursorRef.current = null;
    setArchivedPipelineCursor(null);
    setApiArchivedPipelineDeals([]);
    await loadArchivedPipeline(false);
  }, [loadArchivedPipeline]);

  const openPipelineHistory = useCallback(async (dealId: string) => {
    setPipelineHistoryLoadingId(dealId);
    try {
      const payload = await json<ApiPipelineStageHistory>(
        `/api/board/pipeline/${encodeURIComponent(dealId)}/history?limit=100`,
      );
      const history = apiPipelineHistoryToHistory(payload);
      setPipelineHistories((current) => ({ ...current, [dealId]: history }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load DripJobs stage history');
    } finally {
      setPipelineHistoryLoadingId((current) => current === dealId ? null : current);
    }
  }, []);

  const loadPeople = useCallback(async (append: boolean) => {
    if (peopleLoading) return;
    setPeopleLoading(true);
    try {
      const cursor = append ? peopleCursor : null;
      const page = await json<CursorPage<ApiPerson>>(`/api/board/people?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setApiPeople((current) => append ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))] : page.items);
      if (typeof page.count === 'number' && Number.isSafeInteger(page.count)) setPeopleCount(page.count);
      setPeopleCursor(page.nextCursor);
    } finally {
      setPeopleLoading(false);
    }
  }, [peopleCursor, peopleLoading]);

  const loadSignals = useCallback(async (append: boolean) => {
    if (append && signalsLoading) return;
    const revision = requestRevision.current;
    setSignalsLoading(true);
    try {
      const cursor = append ? signalsCursor : null;
      const search = new URLSearchParams({ limit: '30', view: 'all' });
      if (focusId) search.set('contactId', focusId);
      if (cursor) search.set('cursor', cursor);
      const page = await json<CursorPage<ApiSignal>>(`/api/board/signals?${search}`);
      if (revision !== requestRevision.current) return;
      setApiSignals((current) => append ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))] : page.items);
      setSignalsCursor(page.nextCursor);
    } finally {
      if (revision === requestRevision.current) setSignalsLoading(false);
    }
  }, [focusId, signalsCursor, signalsLoading]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      loadCreatedWork(),
      loadPeople(false),
      loadSignals(false),
      loadLabels(),
      loadPipeline(),
      loadArchivedPipeline(false),
    ]).then((results) => {
      if (!active) return;
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        setError(failure.reason instanceof Error ? failure.reason.message : 'Could not load the Board');
      }
      // Do not start focus-refresh or polling effects until every initial
      // loader has either completed or reported its own failure.
      setBooted(true);
    });
    return () => { active = false; };
    // Initial request only; focus and view have their own bounded effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!booted) return;
    requestRevision.current += 1;
    setApiSignals([]);
    setSignalsCursor(null);
    setSignalsLoading(false);
    void loadSignals(false).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load Signals'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  useEffect(() => {
    if (!booted) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadCreatedWork(), loadPeople(false), loadSignals(false), loadLabels(), loadPipeline()])
        .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not refresh the Board'));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [booted, loadCreatedWork, loadLabels, loadPeople, loadPipeline, loadSignals]);

  const openSignal = useCallback(async (id: string, personIdHint?: string) => {
    setDetails((current) => ({
      ...current,
      [id]: current[id] ?? {
        signal: null,
        recommendations: [],
        history: [],
        historyNextCursor: null,
        attachments: [],
        transcript: null,
        recordings: null,
        callSummary: null,
        loading: true,
        error: null,
      },
    }));
    try {
      const payload = await json<ApiSignalDetail>(`/api/board/signals/${id}?historyLimit=30`);
      const selected = apiSignals.find((signal) => String(signal.id) === id);
      const personId = selected?.contact?.id ?? personIdHint ?? `signal:${id}`;
      setDetails((current) => ({
        ...current,
        [id]: {
          signal: apiSignalToSignal(payload.signal, personId),
          recommendations: payload.recommendations ?? [],
          history: (payload.history ?? []).map((signal) => apiSignalToSignal(signal, personId)),
          historyNextCursor: payload.historyNextCursor,
          attachments: payload.attachments ?? [],
          transcript: payload.transcript ? {
            ...payload.transcript,
            updatedAt: payload.transcript.updatedAt ? Date.parse(payload.transcript.updatedAt) : null,
          } : null,
          recordings: payload.recordings ? {
            ...payload.recordings,
            updatedAt: payload.recordings.updatedAt ? Date.parse(payload.recordings.updatedAt) : null,
          } : null,
          callSummary: payload.callSummary ? {
            ...payload.callSummary,
            updatedAt: payload.callSummary.updatedAt ? Date.parse(payload.callSummary.updatedAt) : null,
          } : null,
          loading: false,
          error: null,
        },
      }));
    } catch (cause) {
      setDetails((current) => ({
        ...current,
        [id]: {
          signal: null,
          recommendations: [],
          history: [],
          historyNextCursor: null,
          attachments: [],
          transcript: null,
          recordings: null,
          callSummary: null,
          loading: false,
          error: cause instanceof Error ? cause.message : 'Could not load Signal context',
        },
      }));
    }
  }, [apiSignals]);

  const loadMoreHistory = useCallback(async (id: string) => {
    const current = details[id];
    if (!current?.historyNextCursor || current.loading) return;
    setDetails((all) => ({ ...all, [id]: { ...current, loading: true } }));
    try {
      const payload = await json<ApiSignalDetail>(`/api/board/signals/${id}?historyLimit=30&historyCursor=${encodeURIComponent(current.historyNextCursor)}`);
      const selected = apiSignals.find((signal) => String(signal.id) === id);
      const personId = selected?.contact?.id ?? `signal:${id}`;
      setDetails((all) => ({
        ...all,
        [id]: {
          ...current,
          history: [...current.history, ...(payload.history ?? []).map((signal) => apiSignalToSignal(signal, personId))],
          historyNextCursor: payload.historyNextCursor,
          loading: false,
        },
      }));
    } catch (cause) {
      setDetails((all) => ({
        ...all,
        [id]: { ...current, loading: false, error: cause instanceof Error ? cause.message : 'Could not load more history' },
      }));
    }
  }, [apiSignals, details]);


  const openAction = useCallback(async (id: string) => {
    setActionDetails((current) => ({
      ...current,
      [id]: current[id] ?? { action: null, sourceSignal: null, events: [], loading: true, error: null },
    }));
    try {
      const payload = await json<ApiActionDetail>(`/api/board/actions/${id}`);
      const action = apiActionToAction(payload.action);
      const source = payload.action.sourceSignal;
      setActionDetails((current) => ({
        ...current,
        [id]: {
          action,
          sourceSignal: source ? {
            id: source.id,
            personId: action.personId,
            channel: 'email',
            at: Date.parse(source.occurredAt),
            text: source.currentMessageText?.trim() || source.bodyText?.trim() || source.preview || source.subject,
            rawText: source.rawBodyText ?? source.bodyText ?? null,
            quotedText: source.quotedText ?? null,
            signatureText: source.signatureText ?? null,
            hasQuotedContent: source.hasQuotedContent ?? Boolean(source.quotedText),
            threadMessageCount: source.threadMessageCount,
            requiresReply: true,
            title: source.subject,
            source: 'gmail',
            eventType: 'email.received',
            direction: 'inbound',
          } : null,
          events: payload.events ?? [],
          loading: false,
          error: null,
        },
      }));
    } catch (cause) {
      setActionDetails((current) => ({
        ...current,
        [id]: { action: null, sourceSignal: null, events: [], loading: false,
          error: cause instanceof Error ? cause.message : 'Could not load Action' },
      }));
    }
  }, []);

  const acceptRecommendation = useCallback(async (signalId: string, recommendationId: string) => {
    const result = await json<{ action: { id: string } }>(
      `/api/board/signals/${signalId}/recommendations/${recommendationId}/accept`,
      { method: 'POST', body: '{}' },
    );
    setDetails((current) => current[signalId] ? {
      ...current,
      [signalId]: {
        ...current[signalId],
        signal: current[signalId].signal ? {
          ...current[signalId].signal,
          reviewStatus: 'action_open',
          reviewResolution: 'action_created',
          reviewedBy: 'manager',
          reviewedAt: Date.now(),
        } : null,
        recommendations: [],
      },
    } : current);
    setApiSignals((current) => current.map((signal) => String(signal.id) === signalId
      ? { ...signal, review: { status: 'action_open', resolution: 'action_created', pendingRecommendationCount: 0 } }
      : signal));
    await Promise.all([loadCreatedWork(), loadPeople(false), loadSignals(false)]);
    return result.action.id;
  }, [loadCreatedWork, loadPeople, loadSignals]);


  const updateActionDraft = useCallback(async (actionId: string, revision: number, draftBody: string) => {
    await json(`/api/board/actions/${actionId}/draft`, {
      method: 'PATCH', body: JSON.stringify({ revision, draftBody }),
    });
    await Promise.all([openAction(actionId), loadCreatedWork()]);
  }, [loadCreatedWork, openAction]);

  const simulateActionSend = useCallback(async (actionId: string, revision: number) => {
    await json(`/api/board/actions/${actionId}/simulate-send`, {
      method: 'POST', body: JSON.stringify({ revision }),
    });
    await Promise.all([openAction(actionId), loadCreatedWork()]);
  }, [loadCreatedWork, openAction]);

  const retryAction = useCallback(async (actionId: string) => {
    await json(`/api/board/actions/${actionId}/retry`, { method: 'POST', body: '{}' });
    await Promise.all([openAction(actionId), loadCreatedWork()]);
  }, [loadCreatedWork, openAction]);

  const dismissAction = useCallback(async (actionId: string) => {
    await json(`/api/board/actions/${actionId}/dismiss`, { method: 'POST', body: '{}' });
    setActionDetails((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    await Promise.all([loadCreatedWork(), loadPeople(false), loadSignals(false)]);
  }, [loadCreatedWork, loadPeople, loadSignals]);

  const retry = useCallback(async () => {
    setError(null);
    const results = await Promise.allSettled([
      loadCreatedWork(),
      loadPeople(false),
      loadSignals(false),
      loadLabels(),
      loadPipeline(),
      loadArchivedPipeline(false),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      const message = failure.reason instanceof Error ? failure.reason.message : 'Could not refresh the Board';
      setError(message);
      throw new Error(message);
    }
  }, [loadArchivedPipeline, loadCreatedWork, loadLabels, loadPeople, loadPipeline, loadSignals]);

  const urgencyLabelByName = useMemo(() => new Map(
    apiLabels
      .filter((label) => label.kind === 'urgency')
      .flatMap((label) => {
        const color = safeLabelColor(label.color);
        return color
          ? [[label.name.trim().toLowerCase(), { name: label.name, color }] as const]
          : [];
      }),
  ), [apiLabels]);
  const people = useMemo(
    () => apiPeople.map((person, order) => apiPersonToPerson(person, order, urgencyLabelByName)),
    [apiPeople, urgencyLabelByName],
  );
  const signals = useMemo(
    // The API owns the ranked order (action-open first, then newest). State is
    // stored oldest-first because the fixed Board's derive() reverses it.
    () => apiSignals.slice().reverse().map((signal) => apiSignalToSignal(signal)),
    [apiSignals],
  );
  const allPeople = useMemo(() => {
    const map = new Map(people.map((person) => [person.id, person]));
    for (const signal of apiSignals) {
      const id = signal.contact?.id ?? `signal:${signal.id}`;
      if (!map.has(id)) map.set(id, hiddenActor(signal));
    }
    for (const action of apiActions) {
      const id = action.personId ?? `signal:${action.sourceSignalId}`;
      if (!map.has(id)) map.set(id, actionPerson(action));
    }
    for (const work of apiReminders) {
      const id = work.contactId ?? `case:${work.caseId}`;
      if (!map.has(id)) map.set(id, workPerson(work));
    }
    return [...map.values()];
  }, [apiActions, apiPeople, apiReminders, apiSignals, people]);

  const actions = useMemo(() => apiActions.map(apiActionToAction), [apiActions]);
  const reminders = useMemo(() => apiReminders.map(apiWorkToReminder), [apiReminders]);
  const pipelineDeals = useMemo(
    () => [...apiPipelineDeals, ...apiArchivedPipelineDeals].map(apiPipelineDealToDeal),
    [apiArchivedPipelineDeals, apiPipelineDeals],
  );

  const s = useMemo<State>(() => ({
    booted,
    now,
    focusId,
    people: allPeople,
    signals,
    reminders,
    actions,
    signalDetails: details,
    actionDetails,
  }), [actionDetails, actions, allPeople, booted, details, focusId, now, reminders, signals]);

  const act = useMemo<Act>(() => ({
    focus: setFocusId,
    acceptRecommendation,
    updateActionDraft,
    simulateActionSend,
    retryAction,
    dismissAction,
  }), [acceptRecommendation, dismissAction, retryAction, simulateActionSend, updateActionDraft]);

  return {
    s,
    act,
    error,
    peopleHasMore: peopleCursor !== null,
    peopleCount,
    signalsHasMore: signalsCursor !== null,
    peopleLoading,
    signalsLoading,
    pipelineDeals,
    pipelineCapturedAt,
    pipelineSync,
    pipelineLoading,
    archivedPipelineCount,
    archivedPipelineMonthCounts,
    archivedPipelineBucketCounts,
    archivedPipelineHasMore: archivedPipelineCursor !== null,
    archivedPipelineLoading,
    pipelineHistories,
    pipelineHistoryLoadingId,
    loadMorePeople: () => loadPeople(true),
    loadMoreSignals: () => loadSignals(true),
    loadMoreArchivedPipeline: () => loadArchivedPipeline(true),
    filterArchivedPipeline,
    openSignal,
    openAction,
    openPipelineHistory,
    loadMoreHistory,
    retry,
  };
}
